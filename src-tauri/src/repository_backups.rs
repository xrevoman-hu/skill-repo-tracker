use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::State;

use crate::{
    api_err, backups, download_zip, expand_tilde, fetch_remote_info, format_error_for_log,
    github_auth_configured, insert_failed_task, load_repositories, load_repository, path_string,
    settings_from_db, sha256_hex, ui_repository, utc_now, ApiResponse, AppError, AppState,
    BackupRepositoriesRequest, CommandResult, UiRepository, UiTask,
};

pub(super) fn default_backup_enabled() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRepositoryBackupEnabledRequest {
    repo_id: String,
    backup_enabled: bool,
}

pub(super) fn set_repository_backup_enabled(
    conn: &Connection,
    request: &UpdateRepositoryBackupEnabledRequest,
) -> Result<UiRepository, AppError> {
    let transaction = conn.unchecked_transaction()?;
    let changed = transaction.execute(
        "UPDATE repositories SET backup_enabled = ?2, updated_at = ?3
         WHERE id = ?1 AND source_type = 'github'",
        params![request.repo_id, request.backup_enabled, utc_now()],
    )?;
    if changed != 1 {
        return Err(AppError::new(
            "repository_backup_preference_unavailable",
            "仓库不存在或不支持远程仓库备份。",
        ));
    }
    let repo = load_repository(&transaction, &request.repo_id)?
        .ok_or_else(|| AppError::new("repository_not_found", "仓库不存在或已被移除。"))?;
    let result = ui_repository(&transaction, repo)?;
    transaction.commit()?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn update_repository_backup_enabled(
    request: UpdateRepositoryBackupEnabledRequest,
    state: State<'_, AppState>,
) -> ApiResponse<UiRepository> {
    let db = state.db.lock().expect("db mutex poisoned");
    match set_repository_backup_enabled(&db, &request) {
        Ok(repo) => ApiResponse::ok(repo),
        Err(error) => api_err(error),
    }
}

fn backup_still_enabled(state: &AppState, repo_id: &str) -> Result<bool, AppError> {
    let db = state.db.lock().expect("db mutex poisoned");
    Ok(load_repository(&db, repo_id)?
        .is_some_and(|repo| repo.source_type == "github" && repo.backup_enabled))
}

#[tauri::command]
pub(super) async fn backup_repositories(
    request: BackupRepositoriesRequest,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiTask>> {
    let app_state: &AppState = &state;
    match backups::run_exclusive(
        &app_state.filesystem_lock,
        backup_repositories_inner(request, app_state),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => Ok(api_err(error)),
    }
}

pub(super) async fn backup_repositories_inner(
    request: BackupRepositoriesRequest,
    state: &AppState,
) -> CommandResult<Vec<UiTask>> {
    let (repos, settings) = {
        let db = state.db.lock().expect("db mutex poisoned");
        let settings = match settings_from_db(&db, github_auth_configured(&db)) {
            Ok(settings) => settings,
            Err(error) => return Ok(api_err(error)),
        };
        let repos = match load_repositories(&db) {
            Ok(items) => items,
            Err(error) => return Ok(api_err(error)),
        };
        let selected = repos
            .into_iter()
            .filter(|repo| repo.source_type == "github" && repo.backup_enabled)
            .filter(|repo| match request.mode.as_str() {
                "selected" => request
                    .repo_ids
                    .as_ref()
                    .map(|ids| ids.contains(&repo.id))
                    .unwrap_or(false),
                "all" => repo.check_status != "failed",
                _ => {
                    repo.check_status != "failed"
                        && repo.last_backup_sha.as_deref() != Some(repo.remote_sha.as_str())
                }
            })
            .collect::<Vec<_>>();
        (selected, settings)
    };

    if repos.is_empty() {
        return Ok(ApiResponse::ok(Vec::new()));
    }

    let backup_root = expand_tilde(&settings.backup_root);
    let mut backup_directory = match backups::create_backup_directory(&backup_root) {
        Ok(directory) => directory,
        Err(error) => return Ok(api_err(error)),
    };
    let backup_id = backup_directory.id().to_string();
    let backup_dir = backup_directory.path().to_path_buf();

    let mut manifest_items = Vec::new();
    let mut manifest_failures = Vec::new();
    let mut log = vec![format!("create {}", path_string(&backup_dir))];
    let mut successful_repo_updates = Vec::new();

    for repo in &repos {
        match backup_still_enabled(state, &repo.id) {
            Ok(true) => {}
            Ok(false) => {
                log.push(format!("skip {}: backup disabled", repo.name));
                continue;
            }
            Err(error) => return Ok(api_err(error)),
        }
        let auth = state.github_auth_for_repo(repo);
        if let Err(error) = auth.usable() {
            manifest_failures.push(serde_json::json!({
                "repo_id": repo.id,
                "repo": repo.name,
                "error": error.message
            }));
            log.push(format_error_for_log(&repo.name, &error));
            continue;
        }
        match fetch_remote_info(
            state.adapters.github.as_ref(),
            &repo.owner,
            &repo.repo,
            &repo.ref_name,
            auth.token(),
            auth.label(),
        )
        .await
        {
            Ok(remote) => match download_zip(
                state.adapters.github.as_ref(),
                &remote.owner,
                &remote.repo,
                &remote.sha,
                auth.token(),
                auth.label(),
            )
            .await
            {
                Ok(bytes) => {
                    // The preference can change while a GitHub request is in flight.
                    match backup_still_enabled(state, &repo.id) {
                        Ok(true) => {}
                        Ok(false) => {
                            log.push(format!("skip {}: backup disabled", repo.name));
                            continue;
                        }
                        Err(error) => return Ok(api_err(error)),
                    }
                    let sha256 = sha256_hex(&bytes);
                    let file_name = backups::safe_zip_name(
                        &remote.full_name,
                        &remote.resolved_ref,
                        &remote.sha,
                    );
                    match backup_directory.write_zip(&file_name, &bytes) {
                        Ok(final_path) => {
                            log.push(format!("download {}", path_string(&final_path)));
                            log.push(format!("compute sha256: {sha256}"));
                            manifest_items.push(serde_json::json!({
                                "repo_id": repo.id,
                                "repo": remote.full_name,
                                "ref": remote.resolved_ref,
                                "resolved_sha": remote.sha,
                                "zip_path": path_string(&final_path),
                                "size_bytes": bytes.len(),
                                "sha256": sha256
                            }));
                            successful_repo_updates.push(backups::SuccessfulBackupUpdate {
                                repo_id: repo.id.clone(),
                                expected_remote_sha: repo.remote_sha.clone(),
                                sha: remote.sha,
                                path: path_string(&final_path),
                            });
                        }
                        Err(error)
                            if matches!(
                                error.code.as_str(),
                                "backup_ownership_changed" | "backup_cleanup_failed"
                            ) =>
                        {
                            return Ok(api_err(error));
                        }
                        Err(error) => {
                            manifest_failures.push(serde_json::json!({
                                "repo_id": repo.id,
                                "repo": repo.name,
                                "error": error.message.clone()
                            }));
                            log.push(format_error_for_log(&repo.name, &error));
                        }
                    }
                }
                Err(error) => {
                    manifest_failures.push(serde_json::json!({
                        "repo_id": repo.id,
                        "repo": repo.name,
                        "error": error.message
                    }));
                    log.push(format!("{} download failed", repo.name));
                }
            },
            Err(error) => {
                manifest_failures.push(serde_json::json!({
                    "repo_id": repo.id,
                    "repo": repo.name,
                    "error": error.message
                }));
                log.push(format!("{} refresh failed", repo.name));
            }
        }
    }

    if successful_repo_updates.is_empty() && manifest_failures.is_empty() {
        return Ok(match backup_directory.discard() {
            Ok(()) => ApiResponse::ok(Vec::new()),
            Err(error) => api_err(error),
        });
    }

    let manifest = serde_json::json!({
        "version": "1.0.0",
        "backup_id": backup_id,
        "created_at": utc_now(),
        "mode": request.mode,
        "backup_root": path_string(&backup_root),
        "items": manifest_items,
        "failures": manifest_failures
    });
    let mut db = state.db.lock().expect("db mutex poisoned");
    let result = backups::finalize_backup(
        &mut db,
        backup_directory,
        backups::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &successful_repo_updates,
            failure_count: manifest_failures.len(),
            total_count: successful_repo_updates.len() + manifest_failures.len(),
            log: &log,
        },
    );

    Ok(match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => {
            insert_failed_task(
                &db,
                "backup",
                "Backup repositories",
                "Updated repositories",
                &error,
                log,
            );
            api_err(error)
        }
    })
}

#[cfg(test)]
#[path = "repository_backups_tests.rs"]
mod tests;
