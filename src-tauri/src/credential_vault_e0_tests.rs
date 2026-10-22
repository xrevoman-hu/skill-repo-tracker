//! E0 engine experiments only: no AppState, application data, or system keychain.
//! These tests prove library/file behavior with synthetic data, not the vault UI,
//! access-control implementation, Windows compatibility, or secret-memory erasure.

use rusqlite::{
    backup::{Backup, StepResult},
    params, Connection, OpenFlags,
};
use std::{fs, path::Path, time::Instant};
use tempfile::TempDir;

const MASTER: &str = "  E0-only master ' 密码 \\ with spaces  ";
const REPLACEMENT_MASTER: &str = "  E0-only replacement ' 新密码 \\ unchanged spaces  ";
const SECRET: &str = "  E0_SYNTHETIC_VALUE_ONLY\r\nsecond line\t秘密  ";
const ASSET: &[u8] = b"E0_SYNTHETIC_ASSET_ONLY\r\n\0\xff\x80\nfinal  ";
const KINDS: [&str; 8] = [
    "website",
    "ssh",
    "tls",
    "database_instance",
    "database_user",
    "email",
    "api_token",
    "generic",
];

fn keyed(path: &Path, password: &str) -> Connection {
    let connection = Connection::open(path).expect("open isolated E0 database");
    connection
        .pragma_update(None, "key", password)
        .expect("set key without SQL interpolation");
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .expect("keep SQL temporary tables in memory");
    connection
}

fn readonly(path: &Path, password: Option<&str>) -> Connection {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open existing isolated database read-only");
    if let Some(password) = password {
        connection
            .pragma_update(None, "key", password)
            .expect("set candidate key");
    }
    connection
}

fn schema(connection: &Connection) {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE e0_records (
               id INTEGER PRIMARY KEY,
               kind TEXT NOT NULL,
               name TEXT NOT NULL,
               secret TEXT NOT NULL
             );
             CREATE TABLE e0_assets (
               record_id INTEGER PRIMARY KEY REFERENCES e0_records(id),
               version INTEGER NOT NULL,
               bytes BLOB NOT NULL CHECK (length(bytes) > 0)
             );",
        )
        .expect("create synthetic schema");
}

fn seed(connection: &mut Connection) {
    schema(connection);
    let transaction = connection.transaction().expect("begin fixture transaction");
    for (index, kind) in KINDS.iter().enumerate() {
        let id = index as i64 + 1;
        transaction
            .execute(
                "INSERT INTO e0_records (id, kind, name, secret) VALUES (?1, ?2, ?3, ?4)",
                params![id, kind, format!("E0 fixture {id}"), SECRET],
            )
            .expect("insert synthetic record");
        transaction
            .execute(
                "INSERT INTO e0_assets (record_id, version, bytes) VALUES (?1, 1, ?2)",
                params![id, ASSET],
            )
            .expect("insert synthetic asset");
    }
    transaction
        .commit()
        .expect("commit synthetic records and assets");
}

fn count(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row("SELECT count(*) FROM e0_records", [], |row| row.get(0))
}

fn assert_fixture(connection: &Connection) {
    assert_eq!(count(connection).expect("read record count"), 8);
    for (index, kind) in KINDS.iter().enumerate() {
        let (stored_kind, value, version, bytes): (String, String, i64, Vec<u8>) = connection
            .query_row(
                "SELECT r.kind, r.secret, a.version, a.bytes
                 FROM e0_records r JOIN e0_assets a ON a.record_id = r.id
                 WHERE r.id = ?1",
                [index as i64 + 1],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read synthetic record and attachment");
        assert_eq!(stored_kind, *kind);
        assert!(value == SECRET, "stored text must be byte-exact");
        assert_eq!(version, 1);
        assert!(bytes == ASSET, "stored attachment must be byte-exact");
    }
}

fn assert_no_fixture_plaintext(path: &Path) {
    let bytes = fs::read(path).expect("read only an E0-created file");
    for marker in [SECRET.as_bytes(), ASSET, b"E0 fixture 1".as_slice()] {
        assert!(
            !bytes.windows(marker.len()).any(|window| window == marker),
            "known synthetic plaintext must not occur in the tested file"
        );
    }
}

#[test]
fn e0_sqlcipher_reports_actual_algorithms_without_weakening_defaults() {
    let directory = TempDir::new().expect("isolated test directory");
    let started = Instant::now();
    let mut connection = keyed(&directory.path().join("vault.db"), MASTER);
    seed(&mut connection);
    let query = |name: &str| -> String {
        connection
            .pragma_query_value(None, name, |row| row.get(0))
            .expect("SQLCipher pragma must return a value")
    };
    let cipher_version = query("cipher_version");
    let kdf = query("cipher_kdf_algorithm");
    let hmac = query("cipher_hmac_algorithm");
    let iterations: u32 = query("kdf_iter").parse().expect("numeric KDF iterations");
    let page_size: u32 = query("cipher_page_size")
        .parse()
        .expect("numeric page size");
    let use_hmac = query("cipher_use_hmac");
    assert!(cipher_version.starts_with("4.5.7 "));
    assert!(cipher_version.contains("community"));
    assert_eq!(rusqlite::version(), "3.45.3");
    assert_eq!(kdf, "PBKDF2_HMAC_SHA512");
    assert_eq!(hmac, "HMAC_SHA512");
    assert_eq!(iterations, 256_000);
    assert_eq!(page_size, 4096);
    assert_eq!(use_hmac, "1");
    let temp_store: i64 = connection
        .pragma_query_value(None, "temp_store", |row| row.get(0))
        .expect("read temporary-store setting");
    assert_eq!(temp_store, 2);
    eprintln!(
        "E0 engine: SQLCipher={cipher_version}, SQLite={}, KDF={kdf}/{iterations}, \
         HMAC={hmac}, page_size={page_size}, first_write_ms={}",
        rusqlite::version(),
        started.elapsed().as_millis()
    );
}

#[test]
fn e0_eight_record_kinds_and_binary_attachments_survive_reopen() {
    let directory = TempDir::new().expect("isolated test directory");
    let path = directory.path().join("vault.db");
    let mut connection = keyed(&path, MASTER);
    seed(&mut connection);
    connection.close().expect("close encrypted database");
    assert_no_fixture_plaintext(&path);
    let bytes = fs::read(&path).expect("read encrypted fixture");
    assert!(!bytes.starts_with(b"SQLite format 3\0"));
    assert_fixture(&readonly(&path, Some(MASTER)));
}

#[test]
fn e0_missing_wrong_and_trimmed_keys_reject_without_changing_ciphertext() {
    let directory = TempDir::new().expect("isolated test directory");
    let path = directory.path().join("vault.db");
    let mut connection = keyed(&path, MASTER);
    seed(&mut connection);
    connection.close().expect("close encrypted database");
    let original = fs::read(&path).expect("read initial ciphertext");
    for candidate in [
        None,
        Some("E0 deliberately wrong value"),
        Some(MASTER.trim()),
    ] {
        let rejected = readonly(&path, candidate);
        assert!(
            count(&rejected).is_err(),
            "invalid key must not disclose records"
        );
        drop(rejected);
        assert!(fs::read(&path).expect("read unchanged file") == original);
    }
    assert_fixture(&readonly(&path, Some(MASTER)));
}

#[test]
fn e0_rekey_reopens_only_with_the_exact_new_password_and_preserves_all_records() {
    let directory = TempDir::new().expect("isolated test directory");
    let path = directory.path().join("vault.db");
    let mut connection = keyed(&path, MASTER);
    seed(&mut connection);
    connection.close().expect("close original keyed fixture");
    let original = fs::read(&path).expect("read original ciphertext");
    let connection = keyed(&path, MASTER);
    assert_fixture(&connection);
    connection
        .pragma_update(None, "rekey", REPLACEMENT_MASTER)
        .expect("request engine password change");
    connection.close().expect("close after rekey");
    assert!(fs::read(&path).expect("read rekeyed ciphertext") != original);
    assert_no_fixture_plaintext(&path);
    for rejected_key in [MASTER, REPLACEMENT_MASTER.trim()] {
        assert!(count(&readonly(&path, Some(rejected_key))).is_err());
    }
    // A successful pragma alone is not acceptance: independently reopen the file.
    assert_fixture(&readonly(&path, Some(REPLACEMENT_MASTER)));
}

#[test]
fn e0_readonly_rekey_attempt_leaves_original_ciphertext_and_password_intact() {
    let directory = TempDir::new().expect("isolated test directory");
    let path = directory.path().join("vault.db");
    let mut connection = keyed(&path, MASTER);
    seed(&mut connection);
    connection.close().expect("close original keyed fixture");
    let original = fs::read(&path).expect("read original ciphertext");
    let read_only = readonly(&path, Some(MASTER));
    assert_fixture(&read_only);
    let reported_success = read_only
        .pragma_update(None, "rekey", REPLACEMENT_MASTER)
        .is_ok();
    eprintln!("E0 read-only rekey: pragma_reported_success={reported_success}");
    read_only.close().expect("close read-only rekey attempt");
    assert!(fs::read(&path).expect("read unchanged ciphertext") == original);
    assert_fixture(&readonly(&path, Some(MASTER)));
    assert!(count(&readonly(&path, Some(REPLACEMENT_MASTER))).is_err());
    // SQLCipher 4.5.7 can report SQLITE_OK after a failed write transaction.
    // Observe actual persisted state; do not require a misleading API error result.
}

#[test]
fn e0_ciphertext_tampering_rejects_and_does_not_damage_the_original() {
    let directory = TempDir::new().expect("isolated test directory");
    let original_path = directory.path().join("original.db");
    let corrupt_path = directory.path().join("corrupt.db");
    let mut connection = keyed(&original_path, MASTER);
    seed(&mut connection);
    connection.close().expect("close original fixture");
    let mut bytes = fs::read(&original_path).expect("read test fixture");
    assert!(bytes.len() >= 4096);
    bytes[128] ^= 0x80;
    fs::write(&corrupt_path, bytes).expect("write corrupted test copy");
    assert!(count(&readonly(&corrupt_path, Some(MASTER))).is_err());
    assert_fixture(&readonly(&original_path, Some(MASTER)));
}

#[test]
fn e0_failed_record_and_attachment_transaction_preserves_both_old_values() {
    let directory = TempDir::new().expect("isolated test directory");
    let path = directory.path().join("vault.db");
    let mut connection = keyed(&path, MASTER);
    seed(&mut connection);
    {
        let transaction = connection.transaction().expect("begin replacement");
        transaction
            .execute(
                "UPDATE e0_records SET secret = ?1 WHERE id = 2",
                ["E0 replacement that must roll back"],
            )
            .expect("stage changed record");
        assert!(transaction
            .execute(
                "UPDATE e0_assets SET version = 2, bytes = ?1 WHERE record_id = 2",
                [Vec::<u8>::new()],
            )
            .is_err());
        // No commit after the failed attachment write; Drop rolls back both changes.
    }
    assert_fixture(&connection);
    connection.close().expect("close rolled-back fixture");
    assert_fixture(&readonly(&path, Some(MASTER)));
}

#[test]
fn e0_unkeyed_database_remains_plaintext_and_supports_fts5_and_wal() {
    let directory = TempDir::new().expect("isolated test directory");
    let path = directory.path().join("ordinary.db");
    let connection = Connection::open(&path).expect("ordinary isolated database");
    let mode: String = connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .expect("ordinary WAL support");
    assert_eq!(mode, "wal");
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE ordinary_search USING fts5(body);
             INSERT INTO ordinary_search(body) VALUES ('ordinary fixture alpha');",
        )
        .expect("ordinary FTS5 support");
    let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("separate ordinary reader");
    let matches: i64 = reader
        .query_row(
            "SELECT count(*) FROM ordinary_search WHERE ordinary_search MATCH 'alpha'",
            [],
            |row| row.get(0),
        )
        .expect("FTS from a separate WAL reader");
    assert_eq!(matches, 1);
    drop(reader);
    connection
        .close()
        .expect("checkpoint and close ordinary fixture");
    assert!(fs::read(&path)
        .expect("read ordinary fixture")
        .starts_with(b"SQLite format 3\0"));
    // This proves basic engine coexistence; existing migration tests remain required.
}

#[test]
fn e0_encrypted_wal_does_not_contain_known_synthetic_plaintext() {
    let directory = TempDir::new().expect("isolated test directory");
    let path = directory.path().join("vault.db");
    let mut connection = keyed(&path, MASTER);
    let mode: String = connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .expect("encrypted WAL mode");
    assert_eq!(mode, "wal");
    connection
        .pragma_update(None, "wal_autocheckpoint", 0)
        .expect("retain committed WAL for observation");
    seed(&mut connection);
    let wal_path = directory.path().join("vault.db-wal");
    assert!(fs::metadata(&wal_path).expect("WAL exists").len() > 32);
    assert_no_fixture_plaintext(&path);
    assert_no_fixture_plaintext(&wal_path);
    assert_fixture(&readonly(&path, Some(MASTER)));
    connection
        .close()
        .expect("checkpoint encrypted WAL fixture");
    assert_fixture(&readonly(&path, Some(MASTER)));
    // Marker absence is a bounded disk observation, not a memory/OS-snapshot claim.
}

#[test]
fn e0_keyed_backup_captures_wal_and_restores_without_source_or_keychain() {
    let source_directory = TempDir::new().expect("isolated source directory");
    let restore_directory = TempDir::new().expect("independent restore directory");
    let source_path = source_directory.path().join("vault.db");
    let backup_path = source_directory.path().join("backup.db");
    let restored_path = restore_directory.path().join("restored.db");
    let mut source = keyed(&source_path, MASTER);
    source
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
        .expect("source WAL mode");
    source
        .pragma_update(None, "wal_autocheckpoint", 0)
        .expect("leave committed rows in WAL");
    seed(&mut source);
    let mut destination = keyed(&backup_path, MASTER);
    {
        let backup = Backup::new(&source, &mut destination).expect("keyed online backup init");
        assert_eq!(
            backup.step(-1).expect("keyed online backup step"),
            StepResult::Done
        );
    }
    assert_fixture(&destination);
    destination
        .close()
        .expect("close complete encrypted backup");
    assert_no_fixture_plaintext(&backup_path);
    assert!(count(&readonly(&backup_path, None)).is_err());
    fs::copy(&backup_path, &restored_path).expect("move only the closed backup artifact");
    source.close().expect("close source before disposal");
    source_directory
        .close()
        .expect("remove original and backup test directory");
    assert_fixture(&readonly(&restored_path, Some(MASTER)));
    assert!(count(&readonly(&restored_path, Some("E0 wrong restore key"))).is_err());
    // Same-host independence only. This is explicitly not Windows migration evidence.
}
