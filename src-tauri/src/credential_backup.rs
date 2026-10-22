//! Standalone SQLCipher snapshots and journaled vault replacement.
//! Device authorization is deliberately outside every exported snapshot.

use crate::{credential_auth, credential_ipc, credential_records::VaultStore, credential_store};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt},
    },
    path::Path,
};

pub(crate) const MAX_BACKUP: u64 = 256 * 1024 * 1024;
const STAGING: &str = "restore.pending.db";

/// The identity-independent lock covers recovery, including the interval where
/// vault.json and the socket's identity may belong to different generations.
pub(crate) fn lock_root(root: &Path) -> Result<File, &'static str> {
    if !root.is_absolute() {
        return Err("invalid_vault_root");
    }
    if !root.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(root)
            .map_err(fail)?;
    }
    if root.canonicalize().map_err(fail)? != root {
        return Err("invalid_vault_root");
    }
    credential_ipc::private_path(root, true)?;
    let path = root.join(".host.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(&path)
        .map_err(fail)?;
    credential_ipc::private_path(&path, false)?;
    if !file.metadata().map_err(fail)?.is_file() {
        return Err("invalid_vault_root");
    }
    // SAFETY: the descriptor is owned by this live File; flock takes no pointers.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("credential_host_already_running");
    }
    Ok(file)
}

pub(crate) struct PreparedRestore {
    pub(crate) token: String,
    pub(crate) vault_id: String,
    digest: String,
    pub(crate) summary: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Recovery {
    schema: u32,
    vault_id: String,
    had_database: bool,
    sharing: bool,
    access_reset: bool,
}

fn fail(_: impl std::fmt::Debug) -> &'static str {
    "vault_backup_io_failed"
}

fn sync_directory(root: &Path) -> Result<(), &'static str> {
    File::open(root)
        .and_then(|file| file.sync_all())
        .map_err(fail)
}

fn remove_private(path: &Path) -> Result<(), &'static str> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            credential_ipc::private_path(path, false)?;
            std::fs::remove_file(path).map_err(fail)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(fail(error)),
    }
}

fn write_private(root: &Path, name: &str, value: &Value) -> Result<(), &'static str> {
    credential_ipc::private_path(root, true)?;
    let destination = root.join(name);
    if destination.exists() {
        credential_ipc::private_path(&destination, false)?;
    }
    let pending = root.join(format!("{name}.new"));
    remove_private(&pending)?;
    let mut file = credential_ipc::create_private(&pending)?;
    file.write_all(&serde_json::to_vec(value).map_err(fail)?)
        .and_then(|()| file.sync_all())
        .map_err(fail)?;
    drop(file);
    std::fs::rename(pending, destination).map_err(fail)?;
    sync_directory(root)
}

pub(crate) fn bool_setting(root: &Path, name: &str) -> Result<bool, &'static str> {
    let path = root.join(name);
    if !path.exists() {
        return Ok(false);
    }
    serde_json::from_slice(&credential_ipc::read_private(&path, 8)?).map_err(fail)
}

pub(crate) fn clear_access_reset(root: &Path) -> Result<(), &'static str> {
    write_private(root, "access-reset.json", &json!(false))
}

pub(crate) fn last_backup(root: &Path) -> Option<String> {
    let bytes = credential_ipc::read_private(&root.join("backup.json"), 256).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let marker: Value =
        serde_json::from_slice(&credential_ipc::read_private(&root.join("vault.json"), 512).ok()?)
            .ok()?;
    if value.get("vaultId") != marker.get("vaultId") {
        return None;
    }
    value.get("createdAt")?.as_str().map(str::to_owned)
}

/// The GUI supplies only a path returned by its native picker. Source handles
/// are no-follow ordinary files; neither extensions nor frontend MIME are trusted.
fn copy_file(source: &Path, destination: &Path) -> Result<(), &'static str> {
    if !source.is_absolute() || !destination.is_absolute() {
        return Err("backup_path_invalid");
    }
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(source)
        .map_err(fail)?;
    let metadata = input.metadata().map_err(fail)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BACKUP {
        return Err("backup_size_or_type_invalid");
    }
    let mut output = credential_ipc::create_private(destination)?;
    let outcome = (|| {
        let copied =
            std::io::copy(&mut (&mut input).take(MAX_BACKUP + 1), &mut output).map_err(fail)?;
        if copied != metadata.len() || copied > MAX_BACKUP {
            return Err("backup_source_changed");
        }
        output.sync_all().map_err(fail)
    })();
    drop(output);
    if outcome.is_err() {
        remove_private(destination)?;
    }
    outcome
}

fn digest(path: &Path) -> Result<String, &'static str> {
    credential_ipc::private_path(path, false)?;
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(fail)?;
    if input.metadata().map_err(fail)?.len() > MAX_BACKUP {
        return Err("backup_size_or_type_invalid");
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(fail)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn integrity(connection: &Connection) -> Result<(), &'static str> {
    let mut statement = connection
        .prepare("PRAGMA cipher_integrity_check")
        .map_err(fail)?;
    if statement
        .query([])
        .map_err(fail)?
        .next()
        .map_err(fail)?
        .is_some()
    {
        return Err("backup_integrity_failed");
    }
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| "backup_integrity_failed")?;
    if result != "ok" {
        return Err("backup_integrity_failed");
    }
    Ok(())
}

fn inspect(path: &Path, password: &str) -> Result<(String, Value), &'static str> {
    let connection = credential_store::keyed(path, password)?;
    // SQLCipher authenticates every page, then SQLite checks structural integrity.
    let (vault_id, format): (String, i64) = connection
        .query_row("SELECT id,format FROM vault_meta", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|_| "password_or_backup_invalid")?;
    if format != 2 || !credential_auth::valid_id(&vault_id) {
        return Err("backup_format_unsupported");
    }
    integrity(&connection)?;
    let identities: u64 = connection
        .query_row("SELECT COUNT(*) FROM vault_meta", [], |row| row.get(0))
        .map_err(fail)?;
    let records: u64 = connection
        .query_row("SELECT COUNT(*) FROM credential_records", [], |row| {
            row.get(0)
        })
        .map_err(fail)?;
    let files: u64 = connection
        .query_row("SELECT COUNT(*) FROM credential_files", [], |row| {
            row.get(0)
        })
        .map_err(fail)?;
    let orphaned: u64 = connection.query_row("SELECT COUNT(*) FROM credential_files WHERE record_id NOT IN (SELECT id FROM credential_records)", [], |row| row.get(0)).map_err(fail)?;
    if identities != 1 || records > 1000 || files > 3000 || orphaned != 0 {
        return Err("backup_data_invalid");
    }
    let store = VaultStore::unlock(path, password, &vault_id)?;
    store.validate_backup_contents()?;
    Ok((
        vault_id.clone(),
        json!({"vaultId":vault_id,"recordCount":records,"fileCount":files,"format":2}),
    ))
}

/// Holding a read transaction prevents another connection from committing
/// while copying. Product vaults use rollback journals, never WAL snapshots.
pub(crate) fn snapshot(
    store: &VaultStore,
    source: &Path,
    destination: &Path,
) -> Result<(), &'static str> {
    let mode: String = store
        .connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(fail)?;
    if mode.to_lowercase() != "delete" {
        return Err("backup_journal_mode_unsupported");
    }
    let transaction = store.connection.unchecked_transaction().map_err(fail)?;
    transaction
        .execute_batch("SELECT id FROM vault_meta")
        .map_err(fail)?;
    let outcome = copy_file(source, destination);
    transaction.rollback().map_err(fail)?;
    outcome
}

pub(crate) fn create(
    root: &Path,
    store: &VaultStore,
    password: &str,
    destination: &Path,
) -> Result<Value, &'static str> {
    create_with_completion(root, store, password, destination, |_| Ok(()))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CompletionStep {
    Sync,
    Metadata,
    DeliveryCleanup,
    PendingCleanup,
}

fn create_with_completion(
    root: &Path,
    store: &VaultStore,
    password: &str,
    destination: &Path,
    mut before: impl FnMut(CompletionStep) -> Result<(), &'static str>,
) -> Result<Value, &'static str> {
    let parent = destination.parent().ok_or("backup_path_invalid")?;
    if !destination.is_absolute() || parent.canonicalize().map_err(fail)? != parent {
        return Err("backup_path_invalid");
    }
    if destination.starts_with(root) {
        return Err("backup_destination_inside_vault");
    }
    if destination.exists() {
        return Err("backup_destination_exists");
    }
    let pending = root.join("backup.pending.db");
    let delivery = parent.join(format!(
        ".srt-backup-{}.pending",
        credential_auth::random_id()?
    ));
    remove_private(&pending)?;
    let outcome = (|| {
        snapshot(store, &root.join("vault.db"), &pending)?;
        let (vault_id, _) = inspect(&pending, password)?;
        copy_file(&pending, &delivery)?;
        // Validate the bytes that were actually written before recording success.
        if digest(&pending)? != digest(&delivery)? {
            return Err("backup_integrity_failed");
        }
        // Install without clobbering an existing target, even if it appeared
        // after the initial check. An interrupted copy has only a .pending name.
        std::fs::hard_link(&delivery, destination).map_err(fail)?;
        Ok(vault_id)
    })();
    let mut warnings = Vec::new();
    let mut created_at = None;
    if let Ok(vault_id) = &outcome {
        // hard_link above is the publication point. Later failures cannot undo
        // the user's complete copy or be reported as if it had never existed.
        if before(CompletionStep::Sync)
            .and_then(|()| sync_directory(parent))
            .is_err()
        {
            warnings.push("backup_sync_unconfirmed");
        }
        let timestamp = chrono::Utc::now().to_rfc3339();
        if before(CompletionStep::Metadata)
            .and_then(|()| {
                write_private(
                    root,
                    "backup.json",
                    &json!({"createdAt":timestamp,"vaultId":vault_id}),
                )
            })
            .is_err()
        {
            warnings.push("backup_metadata_failed");
        } else {
            created_at = Some(timestamp);
        }
    }
    let delivery_cleanup =
        before(CompletionStep::DeliveryCleanup).and_then(|()| remove_private(&delivery));
    let pending_cleanup =
        before(CompletionStep::PendingCleanup).and_then(|()| remove_private(&pending));
    if delivery_cleanup.is_err() || pending_cleanup.is_err() {
        warnings.push("backup_cleanup_failed");
    }
    outcome?;
    Ok(
        json!({"created":true,"createdAt":created_at,"warning":warnings.first(),"warnings":warnings}),
    )
}

pub(crate) fn cancel(root: &Path) -> Result<(), &'static str> {
    remove_private(&root.join(STAGING))
}

pub(crate) fn preview(
    root: &Path,
    source: &Path,
    password: &str,
    current_id: &str,
) -> Result<PreparedRestore, &'static str> {
    if source.starts_with(root) && source != root.join("recovery.srtvault") {
        return Err("backup_source_inside_vault");
    }
    cancel(root)?;
    let pending = root.join(STAGING);
    let outcome = (|| {
        copy_file(source, &pending)?;
        let (vault_id, mut summary) = inspect(&pending, password)?;
        let token = credential_auth::random_id()?;
        summary["restoreId"] = json!(token);
        summary["sameVault"] = json!(vault_id == current_id);
        summary["replacesExisting"] = json!(root.join("vault.db").exists());
        Ok(PreparedRestore {
            token,
            vault_id,
            digest: digest(&pending)?,
            summary,
        })
    })();
    if outcome.is_err() {
        cancel(root)?;
    }
    outcome
}

fn write_identity(root: &Path, vault_id: &str) -> Result<(), &'static str> {
    write_private(
        root,
        "vault.json",
        &json!({"schema":"srt-credential-v1","vaultId":vault_id}),
    )
}

/// A durable recovery descriptor is written before the first rename. If any
/// subsequent step fails or the process dies, startup restores the old vault.
pub(crate) fn commit(
    root: &Path,
    prepared: PreparedRestore,
    current_id: &str,
) -> Result<String, &'static str> {
    let pending = root.join(STAGING);
    if digest(&pending)? != prepared.digest {
        return Err("backup_preview_changed");
    }
    let recovery = Recovery {
        schema: 1,
        vault_id: current_id.to_owned(),
        had_database: root.join("vault.db").exists(),
        sharing: bool_setting(root, "sharing.json")?,
        access_reset: bool_setting(root, "access-reset.json")?,
    };
    let previous = root.join("recovery.srtvault");
    remove_private(&previous)?;
    if recovery.had_database {
        credential_ipc::private_path(&root.join("vault.db"), false)?;
        copy_file(&root.join("vault.db"), &previous)?;
    }
    write_private(
        root,
        "recovery.json",
        &serde_json::to_value(&recovery).map_err(fail)?,
    )?;
    let outcome = (|| {
        std::fs::rename(&pending, root.join("vault.db")).map_err(fail)?;
        sync_directory(root)?;
        write_identity(root, &prepared.vault_id)?;
        if prepared.vault_id != current_id {
            write_private(root, "sharing.json", &json!(false))?;
            write_private(root, "access-reset.json", &json!(true))?;
        }
        remove_private(&root.join("recovery.json"))?;
        sync_directory(root)?;
        Ok(prepared.vault_id)
    })();
    if outcome.is_err() {
        recover(root)?;
    }
    outcome
}

pub(crate) fn change_password(
    root: &Path,
    store: &VaultStore,
    current_id: &str,
    old_password: &str,
    new_password: &str,
) -> Result<PreparedRestore, &'static str> {
    if new_password.len() > credential_store::MAX_PASSWORD || new_password.chars().count() < 12 {
        return Err("password_length_invalid");
    }
    cancel(root)?;
    let pending = root.join(STAGING);
    let outcome = (|| {
        snapshot(store, &root.join("vault.db"), &pending)?;
        let connection = credential_store::keyed(&pending, old_password)?;
        integrity(&connection)?;
        connection
            .pragma_update(None, "rekey", new_password)
            .map_err(|_| "password_change_failed")?;
        connection.close().map_err(|_| "password_change_failed")?;
        let (vault_id, summary) = inspect(&pending, new_password)?;
        if vault_id != current_id {
            return Err("vault_identity_or_format_mismatch");
        }
        Ok(PreparedRestore {
            token: credential_auth::random_id()?,
            vault_id,
            digest: digest(&pending)?,
            summary,
        })
    })();
    if outcome.is_err() {
        cancel(root)?;
    }
    outcome
}

/// Password changes only replace one file: identity and device access stay put.
/// Every fallible preparation precedes rename, so a rejected rename leaves the
/// original password valid. Existing historical backups are never rewritten.
pub(crate) fn commit_password(
    root: &Path,
    prepared: PreparedRestore,
    current_id: &str,
) -> Result<(), &'static str> {
    let pending = root.join(STAGING);
    if prepared.vault_id != current_id || digest(&pending)? != prepared.digest {
        return Err("backup_preview_changed");
    }
    credential_ipc::private_path(&root.join("vault.db"), false)?;
    File::open(&pending)
        .and_then(|file| file.sync_all())
        .map_err(fail)?;
    sync_directory(root)?;
    std::fs::rename(pending, root.join("vault.db")).map_err(fail)?;
    // The rename is the commit point. A directory-sync error afterwards must
    // not misreport a failed password change and tell users to reuse the old key.
    let _ = sync_directory(root);
    Ok(())
}

pub(crate) fn recover(root: &Path) -> Result<(), &'static str> {
    let journal = root.join("recovery.json");
    if journal.exists() {
        let recovery: Recovery =
            serde_json::from_slice(&credential_ipc::read_private(&journal, 1024)?)
                .map_err(|_| "vault_recovery_invalid")?;
        if recovery.schema != 1 || !credential_auth::valid_id(&recovery.vault_id) {
            return Err("vault_recovery_invalid");
        }
        let current = root.join("vault.db");
        if recovery.had_database {
            let pending = root.join("recovery.pending.db");
            remove_private(&pending)?;
            credential_ipc::private_path(&root.join("recovery.srtvault"), false)?;
            copy_file(&root.join("recovery.srtvault"), &pending)?;
            if current.exists() {
                credential_ipc::private_path(&current, false)?;
            }
            std::fs::rename(pending, current).map_err(fail)?;
        } else {
            remove_private(&current)?;
        }
        write_identity(root, &recovery.vault_id)?;
        write_private(root, "sharing.json", &json!(recovery.sharing))?;
        write_private(root, "access-reset.json", &json!(recovery.access_reset))?;
        remove_private(&journal)?;
        sync_directory(root)?;
    }
    for name in [
        STAGING,
        "restore.pending.db-journal",
        "backup.pending.db",
        "recovery.pending.db",
    ] {
        remove_private(&root.join(name))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "credential_backup_tests.rs"]
mod tests;
