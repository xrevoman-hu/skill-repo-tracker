use super::*;
use crate::adapters::{
    CredentialStore, GithubHttpAdapter, GithubHttpFuture, GithubHttpResponse, SystemFilesystem,
};
use crate::{
    build_migration_package, merge_migration_package, migrate, parse_migration_package,
    save_repository_with_account, set_setting, AppAdapters, RemoteInfo,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct EmptyCredentials;

impl CredentialStore for EmptyCredentials {
    fn get(&self, _: &str, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct BackupGithub {
    requests: Mutex<Vec<String>>,
    disable_on_archive: Mutex<Option<PathBuf>>,
}

impl GithubHttpAdapter for BackupGithub {
    fn execute(&self, request: reqwest::Request) -> GithubHttpFuture<'_> {
        let path = request.url().path().to_string();
        self.requests.lock().unwrap().push(path.clone());
        let body = if path.contains("/zipball/") {
            if let Some(database_path) = self.disable_on_archive.lock().unwrap().take() {
                let connection = Connection::open(database_path).unwrap();
                connection
                    .execute("UPDATE repositories SET backup_enabled = 0", [])
                    .unwrap();
            }
            b"PK\x03\x04fictional repository archive".to_vec()
        } else if path.contains("/commits/") {
            br#"{"sha":"new-sha"}"#.to_vec()
        } else {
            let full_name = path.strip_prefix("/repos/").unwrap();
            serde_json::to_vec(&serde_json::json!({
                "full_name": full_name, "default_branch": "main"
            }))
            .unwrap()
        };
        Box::pin(async move {
            Ok(GithubHttpResponse {
                status: 200,
                headers: reqwest::header::HeaderMap::new(),
                body: Ok(body),
            })
        })
    }
}

fn remote(name: &str) -> RemoteInfo {
    RemoteInfo {
        owner: "example".into(),
        repo: name.into(),
        full_name: format!("example/{name}"),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "old-sha".into(),
    }
}

fn save_repo(conn: &Connection, name: &str, enabled: bool) -> String {
    let id = save_repository_with_account(conn, &remote(name), &[], None, "").unwrap();
    set_repository_backup_enabled(
        conn,
        &UpdateRepositoryBackupEnabledRequest {
            repo_id: id.clone(),
            backup_enabled: enabled,
        },
    )
    .unwrap();
    id
}

fn state_for_backup(root: &std::path::Path, github: Arc<BackupGithub>) -> AppState {
    let state = AppState::new_with_adapters(
        root.join("data"),
        AppAdapters {
            credentials: Arc::new(EmptyCredentials),
            github,
            filesystem: Arc::new(SystemFilesystem),
        },
    )
    .unwrap();
    set_setting(
        &state.db.lock().unwrap(),
        "backup_root",
        path_string(&root.join("backups")),
    )
    .unwrap();
    state
}

#[test]
fn preference_defaults_true_and_survives_retracking_and_check_refresh() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let mut source = remote("preference");
    let id = save_repository_with_account(&conn, &source, &[], None, "").unwrap();
    assert!(load_repository(&conn, &id).unwrap().unwrap().backup_enabled);
    save_repo(&conn, "preference", false);
    source.sha = "changed-sha".into();
    save_repository_with_account(&conn, &source, &[], None, "updated readme").unwrap();
    let record = load_repository(&conn, &id).unwrap().unwrap();
    assert!(!record.backup_enabled);
    assert_eq!(record.remote_sha, "changed-sha");
    let repo = set_repository_backup_enabled(
        &conn,
        &UpdateRepositoryBackupEnabledRequest {
            repo_id: id,
            backup_enabled: true,
        },
    )
    .unwrap();
    assert!(repo.backup_enabled);
    assert_eq!(repo.backup_status, "updated-not-backed-up");
    assert!(serde_json::to_value(repo).unwrap()["backupEnabled"]
        .as_bool()
        .unwrap());
}

#[test]
fn preference_rejects_unknown_and_local_repositories() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let id = save_repo(&conn, "local-fixture", true);
    conn.execute(
        "UPDATE repositories SET source_type = 'local' WHERE id = ?1",
        params![id],
    )
    .unwrap();
    for repo_id in ["missing".to_string(), id.clone()] {
        let error = set_repository_backup_enabled(
            &conn,
            &UpdateRepositoryBackupEnabledRequest {
                repo_id,
                backup_enabled: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "repository_backup_preference_unavailable");
    }
    assert!(load_repository(&conn, &id).unwrap().unwrap().backup_enabled);
}

#[test]
fn migration_packages_preserve_preferences_and_default_only_new_legacy_rows() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let id = save_repo(&source, "migration", false);
    let package = build_migration_package(&source).unwrap();
    let json = serde_json::to_string(&package).unwrap();
    let target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    merge_migration_package(&target, &parse_migration_package(&json).unwrap()).unwrap();
    assert!(
        !load_repository(&target, &id)
            .unwrap()
            .unwrap()
            .backup_enabled
    );
    let mut legacy = serde_json::to_value(package).unwrap();
    legacy["repositories"][0]
        .as_object_mut()
        .unwrap()
        .remove("backupEnabled");
    let package = parse_migration_package(&legacy.to_string()).unwrap();
    assert_eq!(package.repositories[0].backup_enabled, None);
    merge_migration_package(&target, &package).unwrap();
    assert!(
        !load_repository(&target, &id)
            .unwrap()
            .unwrap()
            .backup_enabled
    );
    let fresh_target = Connection::open_in_memory().unwrap();
    migrate(&fresh_target).unwrap();
    merge_migration_package(&fresh_target, &package).unwrap();
    assert!(
        load_repository(&fresh_target, &id)
            .unwrap()
            .unwrap()
            .backup_enabled
    );
}

#[test]
fn preference_update_rolls_back_when_response_construction_fails() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let id = save_repo(&conn, "failed-read", true);
    conn.execute_batch("DROP TABLE user_notes").unwrap();
    let error = set_repository_backup_enabled(
        &conn,
        &UpdateRepositoryBackupEnabledRequest {
            repo_id: id.clone(),
            backup_enabled: false,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "sqlite_error");
    assert!(load_repository(&conn, &id).unwrap().unwrap().backup_enabled);
}

#[test]
fn every_backup_mode_skips_disabled_repositories_without_network_files_or_tasks() {
    for mode in ["selected", "all", "updated"] {
        let root = tempfile::tempdir().unwrap();
        let github = Arc::new(BackupGithub::default());
        let state = state_for_backup(root.path(), github.clone());
        let id = save_repo(&state.db.lock().unwrap(), "watch-only", false);
        let response = tauri::async_runtime::block_on(backup_repositories_inner(
            BackupRepositoriesRequest {
                mode: mode.into(),
                repo_ids: Some(vec![id]),
            },
            &state,
        ))
        .unwrap();
        assert!(response.ok, "mode={mode}");
        assert!(response.data.unwrap().is_empty());
        assert!(github.requests.lock().unwrap().is_empty());
        assert!(!root.path().join("backups").exists());
        let db = state.db.lock().unwrap();
        let tasks: i64 = db
            .query_row("SELECT COUNT(*) FROM backup_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tasks, 0, "mode={mode}");
    }
}

#[test]
fn mixed_selected_backup_only_persists_enabled_repository() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("backups")).unwrap();
    let github = Arc::new(BackupGithub::default());
    let state = state_for_backup(root.path(), github.clone());
    let (allowed, excluded) = {
        let db = state.db.lock().unwrap();
        (
            save_repo(&db, "allowed", true),
            save_repo(&db, "excluded", false),
        )
    };
    let response = tauri::async_runtime::block_on(backup_repositories_inner(
        BackupRepositoriesRequest {
            mode: "selected".into(),
            repo_ids: Some(vec![excluded.clone(), allowed.clone()]),
        },
        &state,
    ))
    .unwrap();
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.data.unwrap()[0].status, "success");
    let requests = github.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests.iter().all(|path| path.contains("/allowed")));
    let db = state.db.lock().unwrap();
    assert_eq!(
        load_repository(&db, &allowed)
            .unwrap()
            .unwrap()
            .last_backup_sha
            .as_deref(),
        Some("new-sha")
    );
    assert!(load_repository(&db, &excluded)
        .unwrap()
        .unwrap()
        .last_backup_sha
        .is_none());
    let manifest_path: String = db
        .query_row("SELECT manifest_path FROM backup_manifests", [], |row| {
            row.get(0)
        })
        .unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["items"].as_array().unwrap().len(), 1);
    assert_eq!(manifest["items"][0]["repo_id"], allowed);
}

#[test]
fn disabling_during_download_discards_new_content_and_preserves_old_backup() {
    let root = tempfile::tempdir().unwrap();
    let backup_root = root.path().join("backups");
    std::fs::create_dir(&backup_root).unwrap();
    let old_path = backup_root.join("previous.zip");
    std::fs::write(&old_path, b"previous backup").unwrap();
    let github = Arc::new(BackupGithub::default());
    let state = state_for_backup(root.path(), github.clone());
    *github.disable_on_archive.lock().unwrap() = Some(state.db_path.clone());
    let id = {
        let db = state.db.lock().unwrap();
        let id = save_repo(&db, "cancel-download", true);
        db.execute(
            "UPDATE repositories SET last_backup_sha = 'previous-sha', backup_path = ?2 WHERE id = ?1",
            params![id, path_string(&old_path)],
        )
        .unwrap();
        id
    };
    let response = tauri::async_runtime::block_on(backup_repositories_inner(
        BackupRepositoriesRequest {
            mode: "selected".into(),
            repo_ids: Some(vec![id.clone()]),
        },
        &state,
    ))
    .unwrap();
    assert!(response.ok);
    assert!(response.data.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&backup_root).unwrap().count(), 1);
    assert_eq!(std::fs::read(&old_path).unwrap(), b"previous backup");
    let db = state.db.lock().unwrap();
    let repo = load_repository(&db, &id).unwrap().unwrap();
    assert!(!repo.backup_enabled);
    assert_eq!(repo.last_backup_sha.as_deref(), Some("previous-sha"));
    let tasks: i64 = db
        .query_row("SELECT COUNT(*) FROM backup_jobs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tasks, 0);
}

#[test]
fn historical_retry_payload_reevaluates_current_backup_preference() {
    let root = tempfile::tempdir().unwrap();
    let github = Arc::new(BackupGithub::default());
    let state = state_for_backup(root.path(), github.clone());
    let retry_request = {
        let db = state.db.lock().unwrap();
        let id = save_repo(&db, "retry-preference", true);
        crate::insert_retryable_task(
            &db,
            crate::TaskWrite {
                id: "historical-backup",
                kind: "Backup repositories",
                target: "Fixture",
                progress: "0 / 1",
                status: "failed",
                summary: "fictional network error",
                backup_dir: None,
                log: &[],
            },
            crate::RETRY_BACKUP_REPOSITORIES,
            &BackupRepositoriesRequest {
                mode: "selected".into(),
                repo_ids: Some(vec![id.clone()]),
            },
        )
        .unwrap();
        set_repository_backup_enabled(
            &db,
            &UpdateRepositoryBackupEnabledRequest {
                repo_id: id,
                backup_enabled: false,
            },
        )
        .unwrap();
        let metadata = crate::load_task_retry_metadata(&db, "historical-backup").unwrap();
        assert_eq!(metadata.action, crate::RETRY_BACKUP_REPOSITORIES);
        crate::parse_retry_payload::<BackupRepositoriesRequest>(&metadata.payload).unwrap()
    };
    let response =
        tauri::async_runtime::block_on(backup_repositories_inner(retry_request, &state)).unwrap();
    assert!(response.ok);
    assert!(github.requests.lock().unwrap().is_empty());
    assert!(!root.path().join("backups").exists());
    let count: i64 = state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM backup_jobs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1, "only the historical task remains");
}
