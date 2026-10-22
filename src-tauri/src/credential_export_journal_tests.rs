use super::*;
use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};

fn roots() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().canonicalize().unwrap();
    let root = parent.join("managed");
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    (directory, root, parent)
}

// Close the descriptor while deliberately bypassing normal Drop, like a process
// termination. No live FD or child process is leaked by this synthetic crash.
fn crash(mut pending: PendingExport) -> PathBuf {
    let path = pending.entry.path.clone();
    drop(pending.file.take());
    std::mem::forget(pending);
    path
}

#[test]
fn journal_is_durable_private_and_contains_no_secret_before_write() {
    let (_directory, root, parent) = roots();
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    assert_eq!(fs::metadata(&pending.entry.path).unwrap().len(), 0);
    let record = fs::read(root.join(JOURNAL)).unwrap();
    assert!(String::from_utf8(record).unwrap().contains(".srt-export-"));
    assert_eq!(
        fs::metadata(root.join(JOURNAL)).unwrap().mode() & 0o777,
        0o600
    );
    pending.write(b"synthetic-private-bytes").unwrap();
    assert!(!String::from_utf8(fs::read(root.join(JOURNAL)).unwrap())
        .unwrap()
        .contains("synthetic-private-bytes"));
    drop(pending);
    assert!(!root.join(JOURNAL).exists());
}

#[test]
fn next_startup_removes_only_the_registered_lost_drop_staging() {
    let (_directory, root, parent) = roots();
    let unrelated = parent.join("unrelated-user-file");
    fs::write(&unrelated, "preserve").unwrap();
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    pending.write(b"synthetic-private-bytes").unwrap();
    let path = crash(pending);
    assert!(path.exists());
    cleanup(&root).unwrap();
    assert!(!path.exists());
    assert!(!root.join(JOURNAL).exists());
    assert_eq!(fs::read_to_string(unrelated).unwrap(), "preserve");
    cleanup(&root).unwrap();
}

#[test]
fn replacement_file_and_symlink_are_never_deleted_and_can_be_retried() {
    let (_directory, root, parent) = roots();
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    pending.write(b"synthetic-private-bytes").unwrap();
    let path = crash(pending);
    let displaced = parent.join("displaced-original");
    fs::rename(&path, &displaced).unwrap();
    fs::write(&path, "user replacement").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(cleanup(&root), Err("export_cleanup_failed"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "user replacement");
    assert!(root.join(JOURNAL).exists());
    fs::remove_file(&path).unwrap();
    symlink(&displaced, &path).unwrap();
    assert_eq!(cleanup(&root), Err("export_cleanup_failed"));
    assert!(fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
    fs::remove_file(&path).unwrap();
    fs::rename(displaced, &path).unwrap();
    cleanup(&root).unwrap();
    assert!(!path.exists());
}

#[test]
fn changed_parent_identity_keeps_the_journal_and_does_not_follow_replacements() {
    let (_directory, root, parent) = roots();
    let destination = parent.join("destination");
    fs::create_dir(&destination).unwrap();
    let pending = PendingExport::create(&root, &destination).unwrap();
    let path = crash(pending);
    let moved = parent.join("moved");
    fs::rename(&destination, &moved).unwrap();
    fs::create_dir(&destination).unwrap();
    let replacement = destination.join(path.file_name().unwrap());
    fs::write(&replacement, "preserve").unwrap();
    assert_eq!(cleanup(&root), Err("export_cleanup_failed"));
    assert_eq!(fs::read_to_string(&replacement).unwrap(), "preserve");
    assert!(root.join(JOURNAL).exists());
}

#[test]
fn ordinary_cancel_and_published_exports_remove_the_journal_but_keep_final_files() {
    let (_directory, root, parent) = roots();
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    pending.write(b"cancelled").unwrap();
    let path = pending.entry.path.clone();
    drop(pending);
    assert!(!path.exists());
    assert!(!root.join(JOURNAL).exists());
    let final_path = parent.join("explicit-export");
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    pending.write(b"original\0bytes\r\n").unwrap();
    pending.publish(&final_path, false).unwrap();
    drop(pending);
    cleanup(&root).unwrap();
    assert_eq!(fs::read(&final_path).unwrap(), b"original\0bytes\r\n");
    assert_eq!(fs::metadata(&final_path).unwrap().mode() & 0o777, 0o600);
    assert!(!root.join(JOURNAL).exists());
}

#[test]
fn crash_after_rename_clears_only_the_old_staging_record() {
    let (_directory, root, parent) = roots();
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    pending.write(b"retained-export").unwrap();
    let final_path = parent.join("explicit-export");
    fs::rename(&pending.entry.path, &final_path).unwrap();
    crash(pending);
    cleanup(&root).unwrap();
    assert_eq!(fs::read(&final_path).unwrap(), b"retained-export");
    assert!(!root.join(JOURNAL).exists());
}

#[test]
fn crash_after_link_before_unlink_removes_only_the_staging_link() {
    let (_directory, root, parent) = roots();
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    pending.write(b"retained-export").unwrap();
    let final_path = parent.join("explicit-export");
    fs::hard_link(&pending.entry.path, &final_path).unwrap();
    let path = crash(pending);
    cleanup(&root).unwrap();
    assert!(!path.exists());
    assert_eq!(fs::read(final_path).unwrap(), b"retained-export");
}

#[test]
fn removed_or_unreadable_journal_prevents_secret_writes() {
    let (_directory, root, parent) = roots();
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    fs::remove_file(root.join(JOURNAL)).unwrap();
    assert_eq!(
        pending.write(b"must-not-write"),
        Err("export_cleanup_failed")
    );
    assert_eq!(fs::metadata(&pending.entry.path).unwrap().len(), 0);
    drop(pending);
    let mut pending = PendingExport::create(&root, &parent).unwrap();
    fs::set_permissions(root.join(JOURNAL), fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        pending.write(b"must-not-write"),
        Err("export_cleanup_failed")
    );
    assert_eq!(fs::metadata(&pending.entry.path).unwrap().len(), 0);
}

#[test]
fn nonprivate_staging_keeps_a_retryable_journal() {
    let (_directory, root, parent) = roots();
    let pending = PendingExport::create(&root, &parent).unwrap();
    let path = crash(pending);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(cleanup(&root), Err("export_cleanup_failed"));
    assert!(path.exists());
    assert!(root.join(JOURNAL).exists());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    cleanup(&root).unwrap();
}
