use super::*;
use base64::Engine;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};

const PASSWORD: &str = "synthetic-backup-password-only";
const NEW_PASSWORD: &str = "synthetic-new-password-only";
const ID: &str = "synthetic-backup-vault";

fn root(parent: &Path, name: &str, id: &str) -> std::path::PathBuf {
    let root = parent.join(name);
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let root = root.canonicalize().unwrap();
    write_identity(&root, id).unwrap();
    root
}

fn populate(root: &Path, id: &str) -> (VaultStore, String, Vec<u8>) {
    let store = VaultStore::create(&root.join("vault.db"), PASSWORD, id).unwrap();
    let bytes = vec![0, 13, 10, 255, 42, 0, 19];
    let record = store.save(&json!({"type":"generic","name":"Synthetic archive record",
        "metadata":{"purpose":"roundtrip"},"note":"nonsecret metadata", "secrets":{"value":" exact value\n "},
        "files":[{"field":"attachment","name":"original.bin","bytesBase64":base64::engine::general_purpose::STANDARD.encode(&bytes)}]})).unwrap();
    (
        store,
        record["recordId"].as_str().unwrap().to_owned(),
        bytes,
    )
}

#[test]
fn standalone_backup_roundtrip_restores_original_bytes_and_identity_without_device_state() {
    let parent = tempfile::tempdir().unwrap();
    let source = root(parent.path(), "source", ID);
    let (store, record, bytes) = populate(&source, ID);
    write_private(&source, "sharing.json", &json!(true)).unwrap();
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("portable.srtvault");
    let result = create(&source, &store, PASSWORD, &archive).unwrap();
    assert_eq!(result["created"], true);
    assert!(last_backup(&source).is_some());
    let encrypted = fs::read(&archive).unwrap();
    assert!(!encrypted.starts_with(b"SQLite format 3"));
    assert!(!encrypted
        .windows(b"exact value".len())
        .any(|chunk| chunk == b"exact value"));
    let destination = root(parent.path(), "destination", "empty-local-identity");
    let prepared = preview(&destination, &archive, PASSWORD, "empty-local-identity").unwrap();
    assert_eq!(prepared.summary["recordCount"], 1);
    assert_eq!(prepared.summary["fileCount"], 1);
    assert_eq!(prepared.summary["replacesExisting"], false);
    assert_eq!(
        commit(&destination, prepared, "empty-local-identity").unwrap(),
        (ID.to_owned(), false)
    );
    assert!(!bool_setting(&destination, "sharing.json").unwrap());
    assert!(bool_setting(&destination, "access-reset.json").unwrap());
    let restored = VaultStore::unlock(&destination.join("vault.db"), PASSWORD, ID).unwrap();
    assert_eq!(
        restored.asset_named(&record, Some("attachment")).unwrap().3,
        bytes
    );
    assert_eq!(
        restored
            .read_fields(&json!({"recordId":record,"fields":["value"]}))
            .unwrap()["fields"]["value"],
        " exact value\n "
    );
    assert_eq!(
        fs::metadata(&archive).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn wrong_password_corruption_future_format_and_cancel_do_not_change_current_vault() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, record, bytes) = populate(&current, ID);
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("portable.srtvault");
    create(&current, &store, PASSWORD, &archive).unwrap();
    let before = digest(&current.join("vault.db")).unwrap();
    assert!(preview(&current, &archive, NEW_PASSWORD, ID).is_err());
    assert!(!current.join(STAGING).exists());
    let prepared = preview(&current, &archive, PASSWORD, ID).unwrap();
    assert_eq!(prepared.summary["sameVault"], true);
    cancel(&current).unwrap();
    assert_eq!(digest(&current.join("vault.db")).unwrap(), before);
    let connection = credential_store::keyed(&archive, PASSWORD).unwrap();
    connection
        .execute("UPDATE vault_meta SET format=999", [])
        .unwrap();
    drop(connection);
    assert_eq!(
        preview(&current, &archive, PASSWORD, ID).err().unwrap(),
        "backup_format_unsupported"
    );
    let mut file = OpenOptions::new().write(true).open(&archive).unwrap();
    file.write_all(&[0u8; 128]).unwrap();
    drop(file);
    assert!(preview(&current, &archive, PASSWORD, ID).is_err());
    assert_eq!(digest(&current.join("vault.db")).unwrap(), before);
    assert_eq!(store.asset_named(&record, None).unwrap().3, bytes);
}

#[test]
fn same_identity_restore_preserves_local_authorization_and_retains_recoverable_old_copy() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, record, _) = populate(&current, ID);
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("portable.srtvault");
    create(&current, &store, PASSWORD, &archive).unwrap();
    store
        .delete(&json!({"recordId":record,"expectedVersion":1}))
        .unwrap();
    drop(store);
    write_private(&current, "sharing.json", &json!(true)).unwrap();
    let prepared = preview(&current, &archive, PASSWORD, ID).unwrap();
    commit(&current, prepared, ID).unwrap();
    assert!(bool_setting(&current, "sharing.json").unwrap());
    assert!(!bool_setting(&current, "access-reset.json").unwrap());
    assert!(VaultStore::unlock(&current.join("vault.db"), PASSWORD, ID)
        .unwrap()
        .detail(&record)
        .is_ok());
    assert!(
        VaultStore::unlock(&current.join("recovery.srtvault"), PASSWORD, ID)
            .unwrap()
            .detail(&record)
            .is_err()
    );
}

#[test]
fn rekey_is_staged_atomic_without_creating_old_password_recovery_or_resetting_device() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, record, bytes) = populate(&current, ID);
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("old-password.srtvault");
    create(&current, &store, PASSWORD, &archive).unwrap();
    write_private(&current, "sharing.json", &json!(true)).unwrap();
    let before = digest(&current.join("vault.db")).unwrap();
    assert!(change_password(&current, &store, ID, PASSWORD, "short").is_err());
    assert_eq!(digest(&current.join("vault.db")).unwrap(), before);
    let prepared = change_password(&current, &store, ID, PASSWORD, NEW_PASSWORD).unwrap();
    assert!(VaultStore::unlock(&current.join("vault.db"), PASSWORD, ID).is_ok());
    drop(store);
    commit_password(&current, prepared, ID).unwrap();
    assert!(VaultStore::unlock(&current.join("vault.db"), PASSWORD, ID).is_err());
    assert_eq!(
        VaultStore::unlock(&current.join("vault.db"), NEW_PASSWORD, ID)
            .unwrap()
            .asset_named(&record, None)
            .unwrap()
            .3,
        bytes
    );
    assert!(!current.join("recovery.srtvault").exists());
    assert!(VaultStore::unlock(&archive, PASSWORD, ID).is_ok());
    assert!(bool_setting(&current, "sharing.json").unwrap());
}

#[test]
fn startup_recovers_interrupted_switch_including_metadata_and_sharing() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, record, _) = populate(&current, ID);
    drop(store);
    copy_file(
        &current.join("vault.db"),
        &current.join("recovery.srtvault"),
    )
    .unwrap();
    let recovery = Recovery {
        schema: 1,
        vault_id: ID.to_owned(),
        had_database: true,
        sharing: true,
        access_reset: false,
    };
    write_private(
        &current,
        "recovery.json",
        &serde_json::to_value(recovery).unwrap(),
    )
    .unwrap();
    remove_private(&current.join("vault.db")).unwrap();
    write_identity(&current, "interrupted-other-vault").unwrap();
    write_private(&current, "sharing.json", &json!(false)).unwrap();
    write_private(&current, "access-reset.json", &json!(true)).unwrap();
    recover(&current).unwrap();
    assert!(VaultStore::unlock(&current.join("vault.db"), PASSWORD, ID)
        .unwrap()
        .detail(&record)
        .is_ok());
    assert!(bool_setting(&current, "sharing.json").unwrap());
    assert!(!bool_setting(&current, "access-reset.json").unwrap());
    assert!(!current.join("recovery.json").exists());
    assert!(current.join("recovery.srtvault").exists());
}

#[test]
fn preview_change_and_existing_destination_are_rejected_without_overwrite() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, _, _) = populate(&current, ID);
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("portable.srtvault");
    create(&current, &store, PASSWORD, &archive).unwrap();
    let archive_before = digest(&archive).unwrap();
    assert_eq!(
        create(&current, &store, PASSWORD, &archive).unwrap_err(),
        "backup_destination_exists"
    );
    assert_eq!(digest(&archive).unwrap(), archive_before);
    let before = digest(&current.join("vault.db")).unwrap();
    let prepared = preview(&current, &archive, PASSWORD, ID).unwrap();
    let mut file = OpenOptions::new()
        .append(true)
        .open(current.join(STAGING))
        .unwrap();
    file.write_all(b"unexpected").unwrap();
    drop(file);
    assert_eq!(
        commit(&current, prepared, ID).unwrap_err(),
        "backup_preview_changed"
    );
    assert_eq!(digest(&current.join("vault.db")).unwrap(), before);
}

#[test]
fn symlinks_and_oversized_input_are_rejected_and_root_lock_is_exclusive() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, _, _) = populate(&current, ID);
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("portable.srtvault");
    create(&current, &store, PASSWORD, &archive).unwrap();
    let linked = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("linked.srtvault");
    symlink(&archive, &linked).unwrap();
    assert!(preview(&current, &linked, PASSWORD, ID).is_err());
    let oversized = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("oversized.srtvault");
    let file = credential_ipc::create_private(&oversized).unwrap();
    file.set_len(MAX_BACKUP + 1).unwrap();
    drop(file);
    assert_eq!(
        preview(&current, &oversized, PASSWORD, ID).err().unwrap(),
        "backup_size_or_type_invalid"
    );
    let lock = lock_root(&current).unwrap();
    assert_eq!(
        lock_root(&current).err().unwrap(),
        "credential_host_already_running"
    );
    drop(lock);
    assert!(lock_root(&current).is_ok());
}

#[test]
fn committed_backup_reports_completion_failures_without_removing_user_copy() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, _, _) = populate(&current, ID);
    let destination = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("committed.srtvault");
    let mut observed = Vec::new();
    let result = create_with_completion(&current, &store, PASSWORD, &destination, |step| {
        observed.push(step);
        Err("synthetic_completion_failure")
    })
    .unwrap();
    assert_eq!(result["created"], true);
    assert!(result["createdAt"].is_null());
    assert_eq!(
        result["warnings"],
        json!([
            "backup_sync_unconfirmed",
            "backup_metadata_failed",
            "backup_cleanup_failed"
        ])
    );
    assert!(observed.contains(&CompletionStep::DeliveryCleanup));
    assert!(observed.contains(&CompletionStep::PendingCleanup));
    assert!(last_backup(&current).is_none());
    assert!(VaultStore::unlock(&destination, PASSWORD, ID).is_ok());
    assert!(current.join("backup.pending.db").exists());
}

#[test]
fn backup_failure_before_publication_attempts_both_cleanups_and_preserves_timestamp() {
    let parent = tempfile::tempdir().unwrap();
    let current = root(parent.path(), "current", ID);
    let (store, _, _) = populate(&current, ID);
    let parent = parent.path().canonicalize().unwrap();
    create(
        &current,
        &store,
        PASSWORD,
        &parent.join("previous.srtvault"),
    )
    .unwrap();
    let timestamp = last_backup(&current);
    let destination = parent.join("rejected.srtvault");
    let mut observed = Vec::new();
    let result = create_with_completion(&current, &store, NEW_PASSWORD, &destination, |step| {
        observed.push(step);
        Ok(())
    });
    assert!(result.is_err());
    assert!(!destination.exists());
    assert_eq!(last_backup(&current), timestamp);
    assert!(!observed.contains(&CompletionStep::Metadata));
    assert!(observed.contains(&CompletionStep::DeliveryCleanup));
    assert!(observed.contains(&CompletionStep::PendingCleanup));
    assert!(!current.join("backup.pending.db").exists());
}

#[test]
fn restore_sync_failure_before_commit_restores_previous_database_identity_and_device_state() {
    let parent = tempfile::tempdir().unwrap();
    let source = root(
        parent.path(),
        "source-sync-failure",
        "synthetic-source-vault",
    );
    let (source_store, _, _) = populate(&source, "synthetic-source-vault");
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("sync-failure.srtvault");
    create(&source, &source_store, PASSWORD, &archive).unwrap();
    let current = root(parent.path(), "current-sync-failure", ID);
    let (current_store, old_record, old_bytes) = populate(&current, ID);
    drop(current_store);
    write_private(&current, "sharing.json", &json!(true)).unwrap();
    let before = digest(&current.join("vault.db")).unwrap();
    let prepared = preview(&current, &archive, PASSWORD, ID).unwrap();
    let outcome = commit_with_sync(&current, prepared, ID, |root| {
        assert!(root.join("recovery.json").exists());
        Err("vault_backup_io_failed")
    });
    assert_eq!(outcome, Err("vault_backup_io_failed"));
    assert_eq!(digest(&current.join("vault.db")).unwrap(), before);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(current.join("vault.json")).unwrap()).unwrap()
            ["vaultId"],
        ID
    );
    assert!(bool_setting(&current, "sharing.json").unwrap());
    assert!(!bool_setting(&current, "access-reset.json").unwrap());
    assert_eq!(
        VaultStore::unlock(&current.join("vault.db"), PASSWORD, ID)
            .unwrap()
            .asset_named(&old_record, None)
            .unwrap()
            .3,
        old_bytes
    );
}

#[test]
fn restore_sync_failure_after_commit_is_warning_and_keeps_the_restored_identity() {
    let parent = tempfile::tempdir().unwrap();
    let new_id = "synthetic-restored-vault";
    let source = root(parent.path(), "source-committed", new_id);
    let (source_store, new_record, new_bytes) = populate(&source, new_id);
    let archive = parent
        .path()
        .canonicalize()
        .unwrap()
        .join("committed.srtvault");
    create(&source, &source_store, PASSWORD, &archive).unwrap();
    let current = root(parent.path(), "current-committed", ID);
    let (current_store, _, _) = populate(&current, ID);
    drop(current_store);
    write_private(&current, "sharing.json", &json!(true)).unwrap();
    let prepared = preview(&current, &archive, PASSWORD, ID).unwrap();
    let mut sync_calls = 0;
    let outcome = commit_with_sync(&current, prepared, ID, |root| {
        sync_calls += 1;
        if sync_calls == 1 {
            assert!(root.join("recovery.json").exists());
            sync_directory(root)
        } else {
            assert!(!root.join("recovery.json").exists());
            Err("vault_backup_io_failed")
        }
    });
    assert_eq!(sync_calls, 2);
    assert!(!current.join("recovery.json").exists());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(current.join("vault.json")).unwrap()).unwrap()
            ["vaultId"],
        new_id
    );
    assert!(!bool_setting(&current, "sharing.json").unwrap());
    assert!(bool_setting(&current, "access-reset.json").unwrap());
    assert!(VaultStore::unlock(&current.join("vault.db"), PASSWORD, ID).is_err());
    assert_eq!(
        VaultStore::unlock(&current.join("vault.db"), PASSWORD, new_id)
            .unwrap()
            .asset_named(&new_record, None)
            .unwrap()
            .3,
        new_bytes
    );
    assert_eq!(outcome, Ok((new_id.to_owned(), true)));
}
