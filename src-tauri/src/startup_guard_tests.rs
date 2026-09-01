use super::*;

use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use adapters::{
    CredentialStore, GithubHttpAdapter, GithubHttpFuture, GithubHttpResponse, SystemFilesystem,
};

#[derive(Default)]
struct MemoryCredentials {
    values: Mutex<HashMap<String, String>>,
    deleted: Mutex<Vec<String>>,
}

impl MemoryCredentials {
    fn insert(&self, key: &str, value: &str) {
        self.values
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
    }
}

impl CredentialStore for MemoryCredentials {
    fn get(&self, _service: &str, key: &str) -> Result<Option<String>, String> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }

    fn set(&self, _service: &str, key: &str, secret: &str) -> Result<(), String> {
        self.values
            .lock()
            .unwrap()
            .insert(key.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, _service: &str, key: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(key);
        self.deleted.lock().unwrap().push(key.to_string());
        Ok(())
    }
}

struct ScriptedGithub {
    responses: Mutex<VecDeque<GithubHttpResponse>>,
    requests: Mutex<Vec<String>>,
}

impl ScriptedGithub {
    fn new(responses: impl IntoIterator<Item = GithubHttpResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl GithubHttpAdapter for ScriptedGithub {
    fn execute(&self, request: reqwest::Request) -> GithubHttpFuture<'_> {
        self.requests
            .lock()
            .unwrap()
            .push(request.url().to_string());
        let response = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("fixture response queue exhausted");
        Box::pin(async move { Ok(response) })
    }
}

fn github_response(status: u16, body: impl Into<Vec<u8>>) -> GithubHttpResponse {
    GithubHttpResponse {
        status,
        headers: HeaderMap::new(),
        body: Ok(body.into()),
    }
}

#[test]
fn successful_startup_uses_injected_credentials_and_initializes_all_resources() {
    let data_dir = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    credentials.insert(TOKEN_USER, "legacy-token-must-be-removed");
    credentials.insert("fixture-account-token", "  fixture-token  ");
    credentials.insert("blank-token", "   ");
    let github = Arc::new(ScriptedGithub::new([]));
    let state = AppState::new_with_adapters(
        data_dir.path().to_path_buf(),
        AppAdapters {
            credentials: credentials.clone(),
            github,
            filesystem: Arc::new(SystemFilesystem),
        },
    )
    .unwrap();

    assert!(state.db_path.is_file());
    assert_eq!(
        state
            .db
            .lock()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(
        credentials.deleted.lock().unwrap().as_slice(),
        &[TOKEN_USER.to_string()]
    );
    assert_eq!(
        state.token_for_key("fixture-account-token").as_deref(),
        Some("  fixture-token  ")
    );
    assert_eq!(state.token_for_key("blank-token"), None);
    assert_eq!(state.token_for_key("missing-token"), None);
}

#[test]
fn successful_backup_runs_through_adapters_and_commits_manifest_and_repo_state() {
    let data_dir = tempfile::tempdir().unwrap();
    let backup_root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    credentials.insert("fixture-account-token", "fixture-token");
    let github = Arc::new(ScriptedGithub::new([
        github_response(
            200,
            br#"{"full_name":"example/fixture","default_branch":"main"}"#.to_vec(),
        ),
        github_response(200, br#"{"sha":"new-fixture-sha"}"#.to_vec()),
        github_response(200, b"PK\x03\x04fictional-backup-bytes".to_vec()),
    ]));
    let state = AppState::new_with_adapters(
        data_dir.path().to_path_buf(),
        AppAdapters {
            credentials,
            github: github.clone(),
            filesystem: Arc::new(SystemFilesystem),
        },
    )
    .unwrap();
    let account = GithubAccountRecord {
        id: "github:fixture".into(),
        login: "fixture".into(),
        display_name: "Fixture".into(),
        avatar_url: None,
        token_key: "fixture-account-token".into(),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some("2026-09-01T00:00:00Z".into()),
        is_default: true,
    };
    let remote = RemoteInfo {
        owner: "example".into(),
        repo: "fixture".into(),
        full_name: "example/fixture".into(),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "old-fixture-sha".into(),
    };
    let repository_id = {
        let db = state.db.lock().unwrap();
        upsert_github_account(&db, &account).unwrap();
        set_setting(&db, "backup_root", path_string(backup_root.path())).unwrap();
        save_repository_with_account(&db, &remote, &[], Some(&account.id), "").unwrap()
    };

    let response = tauri::async_runtime::block_on(backup_repositories_inner(
        BackupRepositoriesRequest {
            mode: "selected".into(),
            repo_ids: Some(vec![repository_id.clone()]),
        },
        &state,
    ))
    .unwrap();

    assert!(response.ok, "backup failed: {:?}", response.error);
    let tasks = response.data.unwrap();
    assert_eq!(
        tasks.first().map(|task| task.status.as_str()),
        Some("success")
    );
    let db = state.db.lock().unwrap();
    let (last_backup_sha, backup_path): (Option<String>, Option<String>) = db
        .query_row(
            "SELECT last_backup_sha, backup_path FROM repositories WHERE id = ?1",
            params![repository_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(last_backup_sha.as_deref(), Some("new-fixture-sha"));
    let backup_path = PathBuf::from(backup_path.unwrap());
    assert!(backup_path.is_file());
    assert!(backup_path.starts_with(backup_root.path().canonicalize().unwrap()));
    let manifest_path: String = db
        .query_row(
            "SELECT manifest_path FROM backup_manifests ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["items"][0]["resolved_sha"], "new-fixture-sha");
    assert_eq!(manifest["failures"], serde_json::json!([]));
    assert_eq!(github.requests.lock().unwrap().len(), 3);
}

#[test]
fn successful_cleanup_and_failed_task_audits_take_both_task_write_paths() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    let successful_cleanup = CleanupReport {
        found: 1,
        removed: 1,
        log: vec!["removed fictional stale temp artifact".into()],
        ..Default::default()
    };
    assert!(record_temp_cleanup_task(&conn, &successful_cleanup).unwrap());

    let error = AppError::with_details(
        "fixture_failure",
        "Fictional operation failed.",
        "non-sensitive fixture detail",
    );
    insert_failed_task(
        &conn,
        "fixture",
        "Fixture task",
        "Fixture target",
        &error,
        vec!["fixture started".into()],
    );
    insert_skill_sync_result_task(
        &conn,
        "fixture-sync-success",
        "Sync Skill",
        "Fixture Skill",
        "1 / 1",
        "success",
        "1 synced, 0 skipped",
        &["published fictional fixture".into()],
        "fixture-skill",
        false,
    )
    .unwrap();

    let rows = conn
        .prepare("SELECT kind, status, retryable FROM backup_jobs ORDER BY rowid")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            ("Temp artifact cleanup".into(), "success".into(), 0),
            ("Fixture task".into(), "failed".into(), 0),
            ("Sync Skill".into(), "success".into(), 0),
        ]
    );
}

#[test]
fn non_filesystem_settings_update_is_clamped_without_taking_the_filesystem_lock() {
    let data_dir = tempfile::tempdir().unwrap();
    let filesystem_lock = FilesystemMutationLock::new(data_dir.path()).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let database = Mutex::new(conn);

    let settings = update_settings_with_resources(
        UpdateSettingsRequest {
            backup_root: None,
            skills_root: None,
            skill_library_root: None,
            default_sync_targets: Some(vec!["codex".into(), "claude".into()]),
            sync_backup_keep: Some(500),
            auto_check_interval: Some(1),
            auto_check_enabled: Some(true),
            auto_backup_enabled: Some(true),
        },
        &database,
        &filesystem_lock,
    )
    .unwrap();

    assert_eq!(settings.default_sync_targets, vec!["claude", "codex"]);
    assert_eq!(settings.sync_backup_keep, 50);
    assert_eq!(settings.auto_check_interval, 15);
    assert!(settings.auto_check_enabled);
    assert!(settings.auto_backup_enabled);
}

#[test]
fn settings_update_rolls_back_all_database_fields_when_a_late_write_fails() {
    let data_dir = tempfile::tempdir().unwrap();
    let filesystem_lock = FilesystemMutationLock::new(data_dir.path()).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    set_setting(&conn, "sync_backup_keep", 3).unwrap();
    set_setting(&conn, "auto_check_enabled", false).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_auto_check_enabled
         BEFORE UPDATE OF value ON settings
         WHEN NEW.key = 'auto_check_enabled'
         BEGIN
           SELECT RAISE(ABORT, 'injected late settings failure');
         END;",
    )
    .unwrap();
    let database = Mutex::new(conn);

    let error = update_settings_with_resources(
        UpdateSettingsRequest {
            backup_root: None,
            skills_root: None,
            skill_library_root: None,
            default_sync_targets: None,
            sync_backup_keep: Some(49),
            auto_check_interval: None,
            auto_check_enabled: Some(true),
            auto_backup_enabled: None,
        },
        &database,
        &filesystem_lock,
    )
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    let db = database.lock().unwrap();
    assert_eq!(
        get_setting(&db, "sync_backup_keep").unwrap().as_deref(),
        Some("3")
    );
    assert_eq!(
        get_setting(&db, "auto_check_enabled").unwrap().as_deref(),
        Some("false")
    );
}

#[test]
fn settings_update_cleans_new_roots_and_keeps_database_unchanged_when_later_validation_fails() {
    let data_dir = tempfile::tempdir().unwrap();
    let filesystem_lock = FilesystemMutationLock::new(data_dir.path()).unwrap();
    let new_backup_root = data_dir.path().join("new").join("backup");
    let blocking_file = data_dir.path().join("not-a-directory");
    fs::write(&blocking_file, b"fixture").unwrap();
    let invalid_library_root = blocking_file.join("child");
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    set_setting(&conn, "backup_root", "/tmp/fictional-original-backup").unwrap();
    let database = Mutex::new(conn);

    let error = update_settings_with_resources(
        UpdateSettingsRequest {
            backup_root: Some(path_string(&new_backup_root)),
            skills_root: None,
            skill_library_root: Some(path_string(&invalid_library_root)),
            default_sync_targets: None,
            sync_backup_keep: None,
            auto_check_interval: None,
            auto_check_enabled: None,
            auto_backup_enabled: None,
        },
        &database,
        &filesystem_lock,
    )
    .unwrap_err();

    assert_eq!(error.code, "skill_library_root_unwritable");
    assert_eq!(
        get_setting(&database.lock().unwrap(), "backup_root")
            .unwrap()
            .as_deref(),
        Some("/tmp/fictional-original-backup")
    );
    assert!(!new_backup_root.exists());
    assert!(!data_dir.path().join("new").exists());
}

#[test]
fn settings_directory_creation_records_only_directories_created_by_this_process() {
    let directory = tempfile::tempdir().unwrap();
    let preexisting_parent = directory.path().join("preexisting");
    fs::create_dir(&preexisting_parent).unwrap();
    let created_leaf = preexisting_parent.join("owned-leaf");
    let mut created_directories = Vec::new();

    create_settings_directory_tree(&created_leaf, &mut created_directories).unwrap();

    assert_eq!(created_directories.len(), 1);
    assert_eq!(created_directories[0].path(), created_leaf);
    let error = settings_error_with_directory_cleanup(
        AppError::new("fixture_error", "fixture settings failure"),
        &created_directories,
    );
    assert_eq!(error.code, "fixture_error");
    assert!(preexisting_parent.is_dir());
    assert!(!created_leaf.exists());
}

#[test]
fn settings_directory_cleanup_preserves_a_replaced_directory_identity() {
    let directory = tempfile::tempdir().unwrap();
    let created_leaf = directory.path().join("owned-leaf");
    let replacement = directory.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    let mut created_directories = Vec::new();
    create_settings_directory_tree(&created_leaf, &mut created_directories).unwrap();
    fs::remove_dir(&created_leaf).unwrap();
    fs::rename(&replacement, &created_leaf).unwrap();

    let error = settings_error_with_directory_cleanup(
        AppError::new("fixture_error", "fixture settings failure"),
        &created_directories,
    );

    assert!(created_leaf.is_dir());
    assert!(
        error
            .details
            .as_deref()
            .is_some_and(|details| details.contains("identity changed; preserved directory")),
        "unexpected cleanup details: {:?}",
        error.details
    );
}

#[test]
fn directory_validation_never_overwrites_or_removes_a_preexisting_probe_named_file() {
    let directory = tempfile::tempdir().unwrap();
    let sentinel = directory.path().join(".skill-repo-tracker-write-test");
    fs::write(&sentinel, b"sentinel-owned-by-user").unwrap();

    let validation = validate_directory_path("backupRoot", &path_string(directory.path()));

    assert!(
        validation.writable,
        "validation failed: {}",
        validation.message
    );
    assert_eq!(fs::read(&sentinel).unwrap(), b"sentinel-owned-by-user");
}

#[test]
fn github_readme_search_adapter_returns_trimmed_text_or_empty_on_failure() {
    let success = ScriptedGithub::new([github_response(
        200,
        br#"{"path":"README.md","content":"ICBGaWN0aW9uYWwgUkVBRE1FICAKIA=="}"#.to_vec(),
    )]);
    let text = tauri::async_runtime::block_on(fetch_github_readme_search(
        &success,
        "example",
        "fixture",
        "main",
        Some("fixture-token"),
        "repo_account",
    ));
    assert_eq!(text, "Fictional README");

    let missing = ScriptedGithub::new([github_response(404, b"{}".to_vec())]);
    let text = tauri::async_runtime::block_on(fetch_github_readme_search(
        &missing, "example", "missing", "main", None, "none",
    ));
    assert!(text.is_empty());
}

#[test]
fn backup_records_refresh_and_download_failures_without_publishing_repo_updates() {
    let data_dir = tempfile::tempdir().unwrap();
    let backup_root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    credentials.insert("fixture-account-token", "fixture-token");
    let github = Arc::new(ScriptedGithub::new([
        github_response(503, b"{}".to_vec()),
        github_response(
            200,
            br#"{"full_name":"example/b-download","default_branch":"main"}"#.to_vec(),
        ),
        github_response(200, br#"{"sha":"new-download-sha"}"#.to_vec()),
        github_response(503, b"{}".to_vec()),
    ]));
    let state = AppState::new_with_adapters(
        data_dir.path().to_path_buf(),
        AppAdapters {
            credentials,
            github: github.clone(),
            filesystem: Arc::new(SystemFilesystem),
        },
    )
    .unwrap();
    let account = GithubAccountRecord {
        id: "github:fixture".into(),
        login: "fixture".into(),
        display_name: "Fixture".into(),
        avatar_url: None,
        token_key: "fixture-account-token".into(),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some("2026-09-01T00:00:00Z".into()),
        is_default: false,
    };
    let repository_ids = {
        let db = state.db.lock().unwrap();
        upsert_github_account(&db, &account).unwrap();
        set_setting(&db, "backup_root", path_string(backup_root.path())).unwrap();
        [
            ("a-refresh", "old-refresh-sha"),
            ("b-download", "old-download-sha"),
        ]
        .into_iter()
        .map(|(repo, sha)| {
            save_repository_with_account(
                &db,
                &RemoteInfo {
                    owner: "example".into(),
                    repo: repo.into(),
                    full_name: format!("example/{repo}"),
                    default_branch: "main".into(),
                    resolved_ref: "main".into(),
                    sha: sha.into(),
                },
                &[],
                Some(&account.id),
                "",
            )
            .unwrap()
        })
        .collect::<Vec<_>>()
    };

    let response = tauri::async_runtime::block_on(backup_repositories_inner(
        BackupRepositoriesRequest {
            mode: "selected".into(),
            repo_ids: Some(repository_ids.clone()),
        },
        &state,
    ))
    .unwrap();

    assert!(response.ok, "backup audit failed: {:?}", response.error);
    assert_eq!(
        response
            .data
            .unwrap()
            .first()
            .map(|task| task.status.as_str()),
        Some("failed")
    );
    let db = state.db.lock().unwrap();
    for repository_id in repository_ids {
        let last_backup_sha: Option<String> = db
            .query_row(
                "SELECT last_backup_sha FROM repositories WHERE id = ?1",
                params![repository_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_backup_sha, None);
    }
    let manifest_path: String = db
        .query_row(
            "SELECT manifest_path FROM backup_manifests ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["items"], serde_json::json!([]));
    assert_eq!(manifest["failures"].as_array().unwrap().len(), 2);
    assert_eq!(github.requests.lock().unwrap().len(), 4);
}

#[test]
fn filesystem_root_settings_are_unchanged_while_a_backup_lock_is_held() {
    let data_dir = tempfile::tempdir().unwrap();
    let primary = FilesystemMutationLock::new(data_dir.path()).unwrap();
    let contender = FilesystemMutationLock::new(data_dir.path()).unwrap();
    let _active_backup = primary.acquire().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    set_setting(&conn, "backup_root", "/tmp/fictional-old-root").unwrap();
    let database = Mutex::new(conn);

    let error = update_settings_with_resources(
        UpdateSettingsRequest {
            backup_root: Some("/tmp/fictional-new-root".into()),
            skills_root: None,
            skill_library_root: None,
            default_sync_targets: None,
            sync_backup_keep: None,
            auto_check_interval: None,
            auto_check_enabled: None,
            auto_backup_enabled: None,
        },
        &database,
        &contender,
    )
    .unwrap_err();

    assert_eq!(error.code, "filesystem_busy");
    assert_eq!(
        get_setting(&database.lock().unwrap(), "backup_root")
            .unwrap()
            .as_deref(),
        Some("/tmp/fictional-old-root")
    );
}

#[test]
fn future_schema_rejection_leaves_database_mode_and_contents_unchanged() {
    let data_dir = tempfile::tempdir().unwrap();
    let db_path = data_dir.path().join("skill-repo-tracker.sqlite");
    let conn = Connection::open(&db_path).unwrap();
    let initial_journal_mode: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
        .unwrap();
    assert_eq!(initial_journal_mode, "delete");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
           version INTEGER PRIMARY KEY,
           name TEXT NOT NULL UNIQUE,
           applied_at TEXT NOT NULL
         );
         INSERT INTO schema_migrations(version, name, applied_at) VALUES
           (1, 'legacy-v1.2.2-baseline', '2026-01-01T00:00:00Z'),
           (2, 'future-schema-owned-by-a-newer-app', '2026-09-02T00:00:00Z');",
    )
    .unwrap();
    drop(conn);

    let error = AppState::new(data_dir.path().to_path_buf())
        .err()
        .expect("a newer core schema must reject startup");
    assert_eq!(error.code, "schema_migration_history_conflict");

    let conn = Connection::open(&db_path).unwrap();
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal_mode, "delete");
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(tables, vec!["schema_migrations"]);
    let mut ledger_rows = conn
        .prepare(
            "SELECT version, name, applied_at
             FROM schema_migrations ORDER BY version",
        )
        .unwrap();
    let ledger_rows = ledger_rows
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        ledger_rows,
        vec![
            (
                1,
                "legacy-v1.2.2-baseline".into(),
                "2026-01-01T00:00:00Z".into()
            ),
            (
                2,
                "future-schema-owned-by-a-newer-app".into(),
                "2026-09-02T00:00:00Z".into()
            )
        ]
    );
}

#[test]
fn future_prompt_schema_is_rejected_before_core_startup_mutates_the_database() {
    let data_dir = tempfile::tempdir().unwrap();
    let db_path = data_dir.path().join("skill-repo-tracker.sqlite");
    let conn = Connection::open(&db_path).unwrap();
    let initial_journal_mode: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
        .unwrap();
    assert_eq!(initial_journal_mode, "delete");
    conn.execute_batch(
        "CREATE TABLE future_prompt_sentinel (
           id INTEGER PRIMARY KEY,
           value TEXT NOT NULL
         );
         INSERT INTO future_prompt_sentinel(id, value)
         VALUES (1, 'must remain unchanged');
         PRAGMA user_version = 4;",
    )
    .unwrap();
    drop(conn);

    let error = AppState::new(data_dir.path().to_path_buf())
        .err()
        .expect("a newer prompt schema must reject startup");
    assert_eq!(error.code, "prompt_schema_incompatible");

    let conn = Connection::open(&db_path).unwrap();
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal_mode, "delete");
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(user_version, 4);
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(tables, vec!["future_prompt_sentinel"]);
    let sentinel: String = conn
        .query_row(
            "SELECT value FROM future_prompt_sentinel WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(sentinel, "must remain unchanged");
    let ledger_exists: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master
               WHERE type = 'table' AND name = 'schema_migrations'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!ledger_exists);
}
