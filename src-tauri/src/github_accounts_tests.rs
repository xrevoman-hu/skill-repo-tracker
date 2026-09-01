use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;

use super::*;
use crate::{
    get_setting, github_account_by_id, github_account_token_key, load_ui_github_accounts, migrate,
    set_setting, upsert_github_account, TOKEN_SERVICE,
};

struct FailingCredentialStore;

impl CredentialStore for FailingCredentialStore {
    fn get(&self, _service: &str, _key: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn set(&self, _service: &str, _key: &str, _secret: &str) -> Result<(), String> {
        Err("fictional keychain unavailable".into())
    }

    fn delete(&self, _service: &str, _key: &str) -> Result<(), String> {
        Ok(())
    }
}

struct MemoryCredentialStore {
    secret: Mutex<Option<String>>,
    set_calls: AtomicUsize,
    fail_set_on_call: Option<usize>,
    fail_delete: bool,
}

impl MemoryCredentialStore {
    fn with_secret(secret: Option<&str>) -> Self {
        Self {
            secret: Mutex::new(secret.map(str::to_string)),
            set_calls: AtomicUsize::new(0),
            fail_set_on_call: None,
            fail_delete: false,
        }
    }

    fn secret(&self) -> Option<String> {
        self.secret.lock().unwrap().clone()
    }

    fn failing_set_on_call(mut self, call: usize) -> Self {
        self.fail_set_on_call = Some(call);
        self
    }

    fn failing_delete(mut self) -> Self {
        self.fail_delete = true;
        self
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn get(&self, _service: &str, _key: &str) -> Result<Option<String>, String> {
        Ok(self.secret())
    }

    fn set(&self, _service: &str, _key: &str, secret: &str) -> Result<(), String> {
        let call = self.set_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_set_on_call == Some(call) {
            return Err(format!("fictional set failure #{call}"));
        }
        *self.secret.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }

    fn delete(&self, _service: &str, _key: &str) -> Result<(), String> {
        if self.fail_delete {
            return Err("fictional delete failure".into());
        }
        *self.secret.lock().unwrap() = None;
        Ok(())
    }
}

struct InterleavingCredentialStore {
    secret: Mutex<Option<String>>,
    first_set_entered: mpsc::Sender<()>,
    release_first_set: Mutex<mpsc::Receiver<()>>,
    second_set_entered: mpsc::Sender<()>,
}

impl CredentialStore for InterleavingCredentialStore {
    fn get(&self, _service: &str, _key: &str) -> Result<Option<String>, String> {
        Ok(self.secret.lock().unwrap().clone())
    }

    fn set(&self, _service: &str, _key: &str, secret: &str) -> Result<(), String> {
        *self.secret.lock().unwrap() = Some(secret.to_string());
        if secret == "writer-a-secret" {
            self.first_set_entered.send(()).unwrap();
            self.release_first_set.lock().unwrap().recv().unwrap();
        } else if secret == "writer-b-secret" {
            self.second_set_entered.send(()).unwrap();
        }
        Ok(())
    }

    fn delete(&self, _service: &str, _key: &str) -> Result<(), String> {
        *self.secret.lock().unwrap() = None;
        Ok(())
    }
}

struct BlockingDeleteCredentialStore {
    secret: Mutex<Option<String>>,
    delete_entered: mpsc::Sender<()>,
    release_delete: Mutex<mpsc::Receiver<()>>,
}

impl CredentialStore for BlockingDeleteCredentialStore {
    fn get(&self, _service: &str, _key: &str) -> Result<Option<String>, String> {
        Ok(self.secret.lock().unwrap().clone())
    }

    fn set(&self, _service: &str, _key: &str, secret: &str) -> Result<(), String> {
        *self.secret.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }

    fn delete(&self, _service: &str, _key: &str) -> Result<(), String> {
        *self.secret.lock().unwrap() = None;
        self.delete_entered.send(()).unwrap();
        self.release_delete.lock().unwrap().recv().unwrap();
        Ok(())
    }
}

fn account(display_name: &str) -> GithubAccountRecord {
    GithubAccountRecord {
        id: "github:fictional-octopus".into(),
        login: "fictional-octopus".into(),
        display_name: display_name.into(),
        avatar_url: None,
        token_key: github_account_token_key("github:fictional-octopus"),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some("2026-09-01T00:00:00Z".into()),
        is_default: false,
    }
}

fn seed_linked_account(conn: &Connection) {
    upsert_github_account(conn, &account("Old Fictional Octopus")).unwrap();
    conn.execute(
        "INSERT INTO repositories
         (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
          url, branch, source_type, github_account_id, created_at, updated_at)
         VALUES ('repo:fictional', 'Fictional Repository', 'example-org', 'fictional',
          'main', 'generic', 0, 'fictional-sha', 'https://example.invalid/repository',
          'main', 'github', 'github:fictional-octopus', '2026-09-01', '2026-09-01')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO github_repo_catalog
         (account_id, full_name, owner, repo, html_url, last_refreshed)
         VALUES ('github:fictional-octopus', 'example-org/fictional', 'example-org',
          'fictional', 'https://example.invalid/repository', '2026-09-01')",
        [],
    )
    .unwrap();
}

fn linked_account_counts(conn: &Connection) -> (i64, i64, i64) {
    (
        conn.query_row("SELECT COUNT(*) FROM github_accounts", [], |row| row.get(0))
            .unwrap(),
        conn.query_row(
            "SELECT COUNT(*) FROM repositories WHERE github_account_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap(),
        conn.query_row("SELECT COUNT(*) FROM github_repo_catalog", [], |row| {
            row.get(0)
        })
        .unwrap(),
    )
}

fn credential_lock() -> (tempfile::TempDir, CredentialMutationLock) {
    let directory = tempfile::tempdir().unwrap();
    let lock = CredentialMutationLock::new(directory.path()).unwrap();
    (directory, lock)
}

#[test]
fn credential_store_failure_leaves_account_database_unchanged() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let account = GithubAccountRecord {
        id: "github:fictional-octopus".into(),
        login: "fictional-octopus".into(),
        display_name: "Fictional Octopus".into(),
        avatar_url: None,
        token_key: github_account_token_key("github:fictional-octopus"),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some("2026-09-01T00:00:00Z".into()),
        is_default: false,
    };
    let database_changes_before = conn.total_changes();
    let (_lock_dir, lock) = credential_lock();

    let error = save_validated_account(
        &conn,
        &lock,
        &FailingCredentialStore,
        TOKEN_SERVICE,
        "fictional-secret-never-persisted",
        account,
    )
    .unwrap_err();

    assert_eq!(error.code, "token_store_failed");
    assert_eq!(conn.total_changes(), database_changes_before);
    assert!(load_ui_github_accounts(&conn).unwrap().is_empty());
}

#[test]
fn save_database_late_failure_restores_the_previous_secret_and_database() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    upsert_github_account(&conn, &account("Old Fictional Octopus")).unwrap();
    for (key, value) in [
        ("github_token_configured", "old-configured"),
        ("github_token_status", "old-status"),
        ("github_token_last_verified", "old-verified"),
    ] {
        set_setting(&conn, key, value).unwrap();
    }
    conn.execute_batch(
        "CREATE TRIGGER reject_late_account_save
         BEFORE UPDATE ON settings
         WHEN NEW.key = 'github_token_status'
         BEGIN SELECT RAISE(ABORT, 'fictional late account failure'); END;",
    )
    .unwrap();
    let credentials = MemoryCredentialStore::with_secret(Some("old-fictional-secret"));
    let (_lock_dir, lock) = credential_lock();

    let error = save_validated_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "new-fictional-secret",
        account("New Fictional Octopus"),
    )
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    assert_eq!(
        credentials.secret().as_deref(),
        Some("old-fictional-secret")
    );
    assert_eq!(
        github_account_by_id(&conn, "github:fictional-octopus")
            .unwrap()
            .unwrap()
            .display_name,
        "Old Fictional Octopus"
    );
    assert_eq!(
        get_setting(&conn, "github_token_configured")
            .unwrap()
            .as_deref(),
        Some("old-configured")
    );
}

#[test]
fn save_database_late_failure_removes_a_new_secret() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    set_setting(&conn, "github_token_status", "old-status").unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_new_account_save
         BEFORE UPDATE ON settings
         WHEN NEW.key = 'github_token_status'
         BEGIN SELECT RAISE(ABORT, 'fictional late account failure'); END;",
    )
    .unwrap();
    let credentials = MemoryCredentialStore::with_secret(None);
    let (_lock_dir, lock) = credential_lock();

    let error = save_validated_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "new-fictional-secret",
        account("New Fictional Octopus"),
    )
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    assert_eq!(credentials.secret(), None);
    assert!(github_account_by_id(&conn, "github:fictional-octopus")
        .unwrap()
        .is_none());
}

#[test]
fn save_reports_database_and_compensation_failures_together() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    set_setting(&conn, "github_token_status", "old-status").unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_compensated_account_save
         BEFORE UPDATE ON settings
         WHEN NEW.key = 'github_token_status'
         BEGIN SELECT RAISE(ABORT, 'fictional late account failure'); END;",
    )
    .unwrap();
    let credentials =
        MemoryCredentialStore::with_secret(Some("old-fictional-secret")).failing_set_on_call(2);
    let (_lock_dir, lock) = credential_lock();

    let error = save_validated_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "new-fictional-secret",
        account("New Fictional Octopus"),
    )
    .unwrap_err();

    assert_eq!(error.code, "token_store_compensation_failed");
    let details = error.details.unwrap();
    assert!(details.contains("fictional late account failure"));
    assert!(details.contains("fictional set failure #2"));
    assert!(!details.contains("old-fictional-secret"));
    assert!(!details.contains("new-fictional-secret"));
}

#[test]
fn save_commit_failure_restores_secret_account_and_legacy_settings() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    upsert_github_account(&conn, &account("Old Fictional Octopus")).unwrap();
    for (key, value) in [
        ("github_token_configured", "old-configured"),
        ("github_token_status", "old-status"),
        ("github_token_last_verified", "old-verified"),
    ] {
        set_setting(&conn, key, value).unwrap();
    }
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE fictional_save_parent (id TEXT PRIMARY KEY);
         CREATE TABLE fictional_save_child (
           parent_id TEXT REFERENCES fictional_save_parent(id)
             DEFERRABLE INITIALLY DEFERRED
         );
         CREATE TRIGGER reject_account_save_commit
         AFTER UPDATE ON github_accounts
         WHEN NEW.display_name = 'New Fictional Octopus'
         BEGIN INSERT INTO fictional_save_child(parent_id) VALUES ('missing'); END;",
    )
    .unwrap();
    let credentials = MemoryCredentialStore::with_secret(Some("old-fictional-secret"));
    let (_lock_dir, lock) = credential_lock();

    let error = save_validated_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "new-fictional-secret",
        account("New Fictional Octopus"),
    )
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    assert!(conn.is_autocommit());
    assert_eq!(
        credentials.secret().as_deref(),
        Some("old-fictional-secret")
    );
    assert_eq!(
        github_account_by_id(&conn, "github:fictional-octopus")
            .unwrap()
            .unwrap()
            .display_name,
        "Old Fictional Octopus"
    );
    assert_eq!(
        get_setting(&conn, "github_token_status")
            .unwrap()
            .as_deref(),
        Some("old-status")
    );
    let child_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM fictional_save_child", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(child_count, 0);
}

#[test]
fn delete_credential_failure_leaves_all_database_links_unchanged() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    seed_linked_account(&conn);
    let credentials =
        MemoryCredentialStore::with_secret(Some("old-fictional-secret")).failing_delete();
    let (_lock_dir, lock) = credential_lock();

    let error = delete_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "github:fictional-octopus",
    )
    .unwrap_err();

    assert_eq!(error.code, "token_delete_failed");
    assert_eq!(
        credentials.secret().as_deref(),
        Some("old-fictional-secret")
    );
    assert_eq!(linked_account_counts(&conn), (1, 1, 1));
}

#[test]
fn delete_database_late_failure_restores_secret_and_all_links() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    seed_linked_account(&conn);
    conn.execute_batch(
        "CREATE TRIGGER reject_late_account_delete
         BEFORE DELETE ON github_accounts
         BEGIN SELECT RAISE(ABORT, 'fictional late delete failure'); END;",
    )
    .unwrap();
    let credentials = MemoryCredentialStore::with_secret(Some("old-fictional-secret"));
    let (_lock_dir, lock) = credential_lock();

    let error = delete_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "github:fictional-octopus",
    )
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    assert_eq!(
        credentials.secret().as_deref(),
        Some("old-fictional-secret")
    );
    assert_eq!(linked_account_counts(&conn), (1, 1, 1));
}

#[test]
fn delete_commit_failure_restores_secret_and_all_links() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    seed_linked_account(&conn);
    conn.execute_batch(
        "CREATE TABLE fictional_deferred_account_guard (
           account_id TEXT NOT NULL,
           FOREIGN KEY(account_id) REFERENCES github_accounts(id)
             DEFERRABLE INITIALLY DEFERRED
         );
         INSERT INTO fictional_deferred_account_guard(account_id)
         VALUES ('github:fictional-octopus');",
    )
    .unwrap();
    let credentials = MemoryCredentialStore::with_secret(Some("old-fictional-secret"));
    let (_lock_dir, lock) = credential_lock();

    let error = delete_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "github:fictional-octopus",
    )
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    assert_eq!(
        credentials.secret().as_deref(),
        Some("old-fictional-secret")
    );
    assert_eq!(linked_account_counts(&conn), (1, 1, 1));
}

#[test]
fn delete_success_removes_secret_account_catalog_and_repository_link() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    seed_linked_account(&conn);
    let credentials = MemoryCredentialStore::with_secret(Some("old-fictional-secret"));
    let (_lock_dir, lock) = credential_lock();

    let accounts = delete_account(
        &conn,
        &lock,
        &credentials,
        TOKEN_SERVICE,
        "github:fictional-octopus",
    )
    .unwrap();

    assert!(accounts.is_empty());
    assert_eq!(credentials.secret(), None);
    assert_eq!(linked_account_counts(&conn), (0, 0, 0));
}

#[test]
fn validated_account_refresh_after_concurrent_delete_does_not_recreate_account() {
    let root = tempfile::tempdir().unwrap();
    let db_path = root.path().join("accounts.sqlite");
    let setup = Connection::open(&db_path).unwrap();
    migrate(&setup).unwrap();
    upsert_github_account(&setup, &account("Old Fictional Octopus")).unwrap();
    drop(setup);

    let validation_conn = Connection::open(&db_path).unwrap();
    assert!(
        github_account_by_id(&validation_conn, "github:fictional-octopus")
            .unwrap()
            .is_some()
    );

    let credentials = MemoryCredentialStore::with_secret(Some("old-fictional-secret"));
    let delete_conn = Connection::open(&db_path).unwrap();
    let delete_lock = CredentialMutationLock::new(root.path()).unwrap();
    delete_account(
        &delete_conn,
        &delete_lock,
        &credentials,
        TOKEN_SERVICE,
        "github:fictional-octopus",
    )
    .unwrap();

    let validation_lock = CredentialMutationLock::new(root.path()).unwrap();
    let error = refresh_validated_account(
        &validation_conn,
        &validation_lock,
        "github:fictional-octopus",
        account("Late Validation Result"),
    )
    .unwrap_err();

    assert_eq!(error.code, "github_account_missing");
    assert!(
        github_account_by_id(&validation_conn, "github:fictional-octopus")
            .unwrap()
            .is_none()
    );
    assert_eq!(credentials.secret(), None);
}

#[test]
fn validated_account_refresh_fails_while_concurrent_delete_holds_credential_lock() {
    let root = tempfile::tempdir().unwrap();
    let db_path = root.path().join("accounts.sqlite");
    let setup = Connection::open(&db_path).unwrap();
    migrate(&setup).unwrap();
    upsert_github_account(&setup, &account("Old Fictional Octopus")).unwrap();
    drop(setup);

    let (delete_entered_tx, delete_entered_rx) = mpsc::channel();
    let (release_delete_tx, release_delete_rx) = mpsc::channel();
    let credentials = Arc::new(BlockingDeleteCredentialStore {
        secret: Mutex::new(Some("old-fictional-secret".into())),
        delete_entered: delete_entered_tx,
        release_delete: Mutex::new(release_delete_rx),
    });
    let delete_path = db_path.clone();
    let delete_lock = CredentialMutationLock::new(root.path()).unwrap();
    let delete_credentials = Arc::clone(&credentials);
    let deleter = std::thread::spawn(move || {
        let conn = Connection::open(delete_path).unwrap();
        delete_account(
            &conn,
            &delete_lock,
            delete_credentials.as_ref(),
            TOKEN_SERVICE,
            "github:fictional-octopus",
        )
    });
    delete_entered_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();

    let validation_conn = Connection::open(&db_path).unwrap();
    let validation_lock = CredentialMutationLock::new(root.path()).unwrap();
    let error = refresh_validated_account(
        &validation_conn,
        &validation_lock,
        "github:fictional-octopus",
        account("Late Validation Result"),
    )
    .unwrap_err();

    assert_eq!(error.code, "credential_busy");
    assert_eq!(
        github_account_by_id(&validation_conn, "github:fictional-octopus")
            .unwrap()
            .unwrap()
            .display_name,
        "Old Fictional Octopus"
    );
    release_delete_tx.send(()).unwrap();
    deleter.join().unwrap().unwrap();

    let verify = Connection::open(&db_path).unwrap();
    assert!(github_account_by_id(&verify, "github:fictional-octopus")
        .unwrap()
        .is_none());
    assert_eq!(credentials.secret.lock().unwrap().as_deref(), None);
}

#[test]
fn credential_mutation_lock_serializes_compensation_across_connections() {
    let root = tempfile::tempdir().unwrap();
    let db_path = root.path().join("accounts.sqlite");
    let setup = Connection::open(&db_path).unwrap();
    migrate(&setup).unwrap();
    upsert_github_account(&setup, &account("Old Fictional Octopus")).unwrap();
    setup
        .execute_batch(
            "CREATE TRIGGER reject_first_account_writer
             BEFORE UPDATE ON github_accounts
             WHEN NEW.display_name = 'Failing Writer A'
             BEGIN SELECT RAISE(ABORT, 'fictional writer A failure'); END;",
        )
        .unwrap();
    drop(setup);

    let (first_set_tx, first_set_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (second_set_tx, second_set_rx) = mpsc::channel();
    let credentials = Arc::new(InterleavingCredentialStore {
        secret: Mutex::new(Some("old-fictional-secret".into())),
        first_set_entered: first_set_tx,
        release_first_set: Mutex::new(release_rx),
        second_set_entered: second_set_tx,
    });
    let lock_a = super::CredentialMutationLock::new(root.path()).unwrap();
    let lock_b = super::CredentialMutationLock::new(root.path()).unwrap();
    let path_a = db_path.clone();
    let credentials_a = Arc::clone(&credentials);
    let writer_a = std::thread::spawn(move || {
        let conn = Connection::open(path_a).unwrap();
        super::save_validated_account(
            &conn,
            &lock_a,
            credentials_a.as_ref(),
            TOKEN_SERVICE,
            "writer-a-secret",
            account("Failing Writer A"),
        )
    });
    first_set_rx.recv_timeout(Duration::from_secs(2)).unwrap();

    let path_b = db_path.clone();
    let credentials_b = Arc::clone(&credentials);
    let writer_b = std::thread::spawn(move || {
        let conn = Connection::open(path_b).unwrap();
        super::save_validated_account(
            &conn,
            &lock_b,
            credentials_b.as_ref(),
            TOKEN_SERVICE,
            "writer-b-secret",
            account("Committed Writer B"),
        )
    });

    assert_eq!(
        writer_b.join().unwrap().unwrap_err().code,
        "credential_busy"
    );
    assert!(matches!(
        second_set_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert_eq!(
        credentials.secret.lock().unwrap().as_deref(),
        Some("writer-a-secret")
    );
    release_tx.send(()).unwrap();
    assert_eq!(writer_a.join().unwrap().unwrap_err().code, "sqlite_error");

    let retry_lock = super::CredentialMutationLock::new(root.path()).unwrap();
    let retry_conn = Connection::open(&db_path).unwrap();
    super::save_validated_account(
        &retry_conn,
        &retry_lock,
        credentials.as_ref(),
        TOKEN_SERVICE,
        "writer-b-secret",
        account("Committed Writer B"),
    )
    .unwrap();
    second_set_rx.recv_timeout(Duration::from_secs(2)).unwrap();

    assert_eq!(
        credentials.secret.lock().unwrap().as_deref(),
        Some("writer-b-secret")
    );
    let verify = Connection::open(db_path).unwrap();
    assert_eq!(
        github_account_by_id(&verify, "github:fictional-octopus")
            .unwrap()
            .unwrap()
            .display_name,
        "Committed Writer B"
    );
}
