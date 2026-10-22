use super::*;
use crate::{get_setting, migrate, LEGACY_GITHUB_ACCOUNT_ID, TOKEN_SERVICE, TOKEN_USER};
use std::sync::Mutex;

struct RejectCredentialAccess;

impl CredentialStore for RejectCredentialAccess {
    fn get(&self, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("startup must not read an unregistered credential")
    }
    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        panic!("startup must not write an unregistered credential")
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        panic!("startup must not delete an unregistered credential")
    }
}

#[derive(Default)]
struct RecordingCredentials(Mutex<Vec<&'static str>>);

impl CredentialStore for RecordingCredentials {
    fn get(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        assert_eq!((service, key), (TOKEN_SERVICE, TOKEN_USER));
        self.0.lock().unwrap().push("get");
        Ok(None)
    }
    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        panic!("successful cleanup does not need compensation")
    }
    fn delete(&self, service: &str, key: &str) -> Result<(), String> {
        assert_eq!((service, key), (TOKEN_SERVICE, TOKEN_USER));
        self.0.lock().unwrap().push("delete");
        Ok(())
    }
}

fn fixture() -> (Connection, tempfile::TempDir, CredentialMutationLock) {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let lock = CredentialMutationLock::new(directory.path()).unwrap();
    (conn, directory, lock)
}

fn seed_account(conn: &Connection, id: &str, token_key: &str) {
    upsert_github_account(
        conn,
        &GithubAccountRecord {
            id: id.into(),
            login: "synthetic-account".into(),
            display_name: "Synthetic account".into(),
            avatar_url: None,
            token_key: token_key.into(),
            status: "verified".into(),
            scopes: "repo".into(),
            last_verified: Some("2026-10-22T00:00:00Z".into()),
            is_default: true,
        },
    )
    .unwrap();
}

#[test]
fn empty_database_startup_never_accesses_system_credentials() {
    let (conn, _directory, lock) = fixture();
    migrate_legacy_account_if_registered(
        &conn,
        &lock,
        &RejectCredentialAccess,
        TOKEN_SERVICE,
        TOKEN_USER,
    )
    .unwrap();
    assert!(load_ui_github_accounts(&conn).unwrap().is_empty());
    assert_eq!(get_setting(&conn, "github_token_configured").unwrap(), None);
}

#[test]
fn modern_accounts_and_shared_status_flags_do_not_authorize_legacy_cleanup() {
    let (conn, _directory, lock) = fixture();
    seed_account(
        &conn,
        "github:synthetic",
        "github-account-token:github:synthetic",
    );
    set_setting(&conn, "github_token_configured", "true").unwrap();
    set_setting(&conn, "github_token_status", "verified").unwrap();
    migrate_legacy_account_if_registered(
        &conn,
        &lock,
        &RejectCredentialAccess,
        TOKEN_SERVICE,
        TOKEN_USER,
    )
    .unwrap();
    assert!(github_account_by_id(&conn, "github:synthetic")
        .unwrap()
        .is_some());
    assert_eq!(
        get_setting(&conn, "github_token_configured")
            .unwrap()
            .as_deref(),
        Some("true")
    );
    assert_eq!(
        get_setting(&conn, "github_token_status")
            .unwrap()
            .as_deref(),
        Some("verified")
    );
}

#[test]
fn legacy_token_registration_is_detected_even_under_a_different_account_id() {
    let (conn, _directory, lock) = fixture();
    seed_account(&conn, "github:synthetic-old-id", TOKEN_USER);
    let credentials = RecordingCredentials::default();
    migrate_legacy_account_if_registered(&conn, &lock, &credentials, TOKEN_SERVICE, TOKEN_USER)
        .unwrap();
    assert!(load_ui_github_accounts(&conn).unwrap().is_empty());
    assert_eq!(*credentials.0.lock().unwrap(), vec!["get", "delete"]);
    assert_eq!(
        get_setting(&conn, "github_token_configured")
            .unwrap()
            .as_deref(),
        Some("false")
    );
}

#[test]
fn orphan_legacy_repository_reference_still_gets_migrated() {
    let (conn, _directory, lock) = fixture();
    conn.execute(
        "INSERT INTO repositories
         (id, name, owner, repo, ref_name, repo_type, url, branch, github_account_id, created_at, updated_at)
         VALUES ('synthetic-repo', 'Synthetic', 'example', 'synthetic', 'main', 'generic',
          'https://example.test/repository', 'main', ?1, '2026-10-22', '2026-10-22')",
        params![LEGACY_GITHUB_ACCOUNT_ID],
    )
    .unwrap();
    let credentials = RecordingCredentials::default();
    migrate_legacy_account_if_registered(&conn, &lock, &credentials, TOKEN_SERVICE, TOKEN_USER)
        .unwrap();
    let account: Option<String> = conn
        .query_row(
            "SELECT github_account_id FROM repositories WHERE id = 'synthetic-repo'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(account, None);
    assert_eq!(*credentials.0.lock().unwrap(), vec!["get", "delete"]);
}

#[test]
fn orphan_legacy_catalog_reference_still_gets_migrated() {
    let (conn, _directory, lock) = fixture();
    // Represents an old/corrupt catalog created before foreign-key enforcement.
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    conn.execute(
        "INSERT INTO github_repo_catalog (account_id, full_name, owner, repo, html_url, last_refreshed)
         VALUES (?1, 'example/synthetic', 'example', 'synthetic', 'https://example.test/repository', '2026-10-22')",
        params![LEGACY_GITHUB_ACCOUNT_ID],
    ).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    let credentials = RecordingCredentials::default();
    migrate_legacy_account_if_registered(&conn, &lock, &credentials, TOKEN_SERVICE, TOKEN_USER)
        .unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM github_repo_catalog", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(*credentials.0.lock().unwrap(), vec!["get", "delete"]);
}

#[test]
fn explicit_legacy_clear_keeps_its_previous_unregistered_cleanup_behavior() {
    let (conn, _directory, lock) = fixture();
    let credentials = RecordingCredentials::default();
    delete_legacy_account(&conn, &lock, &credentials, TOKEN_SERVICE, TOKEN_USER).unwrap();
    assert_eq!(*credentials.0.lock().unwrap(), vec!["get", "delete"]);
}

#[test]
fn startup_registration_check_uses_the_existing_mutation_lock_without_relocking() {
    let (conn, directory, lock) = fixture();
    seed_account(&conn, LEGACY_GITHUB_ACCOUNT_ID, TOKEN_USER);
    let held = lock.acquire().unwrap();
    let second = CredentialMutationLock::new(directory.path()).unwrap();
    let error = migrate_legacy_account_if_registered(
        &conn,
        &second,
        &RejectCredentialAccess,
        TOKEN_SERVICE,
        TOKEN_USER,
    )
    .unwrap_err();
    assert_eq!(error.code, "credential_busy");
    drop(held);
    let credentials = RecordingCredentials::default();
    migrate_legacy_account_if_registered(&conn, &second, &credentials, TOKEN_SERVICE, TOKEN_USER)
        .unwrap();
    assert_eq!(*credentials.0.lock().unwrap(), vec!["get", "delete"]);
}
