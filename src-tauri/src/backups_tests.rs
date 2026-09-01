use std::{sync::mpsc, time::Duration};

use crate::temp_artifacts::FilesystemMutationLock;
use rusqlite::{params, Connection};

fn initialize_backup_database(connection: &Connection) {
    crate::migrate(connection).unwrap();
    connection
        .execute(
            "INSERT INTO repositories
                 (id, name, owner, repo, ref_name, repo_type, remote_sha, check_status,
                  url, branch, created_at, updated_at)
                 VALUES ('repo-1', 'Fictional Repository', 'example', 'fictional', 'main',
                         'generic repo', 'old-sha', 'success',
                         'https://github.com/example/fictional', 'main', ?1, ?1)",
            params![crate::utc_now()],
        )
        .unwrap();
}

fn backup_database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    initialize_backup_database(&connection);
    connection
}

#[test]
fn rapid_backup_directories_are_unique_and_never_reuse_existing_content() {
    let root = tempfile::tempdir().unwrap();

    let mut first = super::create_backup_directory(root.path()).unwrap();
    first.write_zip("sentinel.zip", b"first backup").unwrap();
    let second = super::create_backup_directory(root.path()).unwrap();

    assert_ne!(first.id(), second.id());
    assert_ne!(first.path(), second.path());
    assert_eq!(
        std::fs::read(first.path().join("sentinel.zip")).unwrap(),
        b"first backup"
    );
}

#[test]
fn duplicate_zip_name_never_deletes_the_first_published_file() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();

    directory
        .write_zip("same-name.zip", b"first published bytes")
        .unwrap();
    let error = directory
        .write_zip("same-name.zip", b"second conflicting bytes")
        .unwrap_err();

    assert_eq!(error.code, "backup_zip_path_exists");
    assert_eq!(
        std::fs::read(directory.path().join("same-name.zip")).unwrap(),
        b"first published bytes"
    );
    assert!(!directory.path().join("same-name.zip.partial").exists());
}

#[test]
fn zip_names_are_collision_resistant_and_fit_macos_component_limits() {
    let slash = super::safe_zip_name(
        "example/repository",
        "feature/a",
        "0123456789abcdef0123456789abcdef01234567",
    );
    let underscore = super::safe_zip_name(
        "example/repository",
        "feature_a",
        "0123456789abcdef0123456789abcdef01234567",
    );
    let long = super::safe_zip_name(
        &"虚构仓库".repeat(100),
        &"功能分支".repeat(100),
        "fedcba9876543210fedcba9876543210fedcba98",
    );

    assert_ne!(slash, underscore);
    assert!(slash.ends_with(".zip"));
    assert!(format!("{long}.partial").len() <= 255);
    assert!(long.is_char_boundary(long.len()));
    assert_eq!(std::path::Path::new(&long).components().count(), 1);
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    directory.write_zip(&long, b"long name zip").unwrap();
    assert_eq!(
        std::fs::read(directory.path().join(long)).unwrap(),
        b"long name zip"
    );
}

#[test]
fn zip_name_truncation_never_splits_a_multibyte_character() {
    let name = super::safe_zip_name(
        &"🦀".repeat(100),
        &"分支".repeat(100),
        "0123456789abcdef0123456789abcdef01234567",
    );

    assert!(format!("{name}.partial").len() <= 255);
    assert!(name.starts_with('🦀'));
    assert!(name.ends_with(".zip"));

    let sanitized = super::safe_zip_name(
        "repository\nname",
        "feature:branch",
        "0123456789abcdef0123456789abcdef01234567",
    );
    assert!(!sanitized.contains(['\n', ':']));
}

#[test]
fn zip_writer_rejects_every_non_file_component_before_creating_artifacts() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();

    for invalid in ["../escape.zip", "nested/archive.zip", "/absolute.zip"] {
        let error = directory
            .write_zip(invalid, b"must not be written")
            .unwrap_err();
        assert_eq!(error.code, "backup_zip_path_invalid", "name={invalid}");
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn zip_writer_never_reuses_an_existing_partial_file() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let partial = directory.path().join("archive.zip.partial");
    std::fs::write(&partial, b"pre-existing partial sentinel").unwrap();

    let error = directory
        .write_zip("archive.zip", b"new archive bytes")
        .unwrap_err();

    assert_eq!(error.code, "backup_zip_write_failed");
    assert_eq!(
        std::fs::read(&partial).unwrap(),
        b"pre-existing partial sentinel"
    );
    assert!(!directory.path().join("archive.zip").exists());
    std::fs::remove_file(partial).unwrap();
}

#[cfg(unix)]
fn different_identity(identity: &super::DirectoryIdentity) -> super::DirectoryIdentity {
    match identity {
        super::DirectoryIdentity::Unix { device, inode } => super::DirectoryIdentity::Unix {
            device: *device,
            inode: inode.wrapping_add(1),
        },
    }
}

#[cfg(unix)]
#[test]
fn held_directory_identity_mismatch_stops_before_creating_a_partial() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();

    let parent_identity = directory.parent_identity.clone();
    directory.parent_identity = different_identity(&parent_identity);
    let parent_error = directory
        .write_zip("parent-drift.zip", b"must not be written")
        .unwrap_err();
    assert_eq!(parent_error.code, "backup_ownership_changed");
    directory.parent_identity = parent_identity;

    let identity = directory.identity.clone();
    directory.identity = different_identity(&identity);
    let child_error = directory
        .write_zip("child-drift.zip", b"must not be written")
        .unwrap_err();
    assert_eq!(child_error.code, "backup_ownership_changed");
    directory.identity = identity;

    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn cleanup_forgets_a_tracked_file_that_is_already_missing() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    let published = directory
        .write_zip("published.zip", b"fictional archive")
        .unwrap();
    std::fs::remove_file(published).unwrap();

    directory.cleanup().unwrap();

    assert!(!directory_path.exists());
}

#[test]
fn cleanup_failure_retains_tracking_and_succeeds_on_retry() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    directory
        .write_zip("published.zip", b"fictional archive")
        .unwrap();
    directory.fail_unlink_file("published.zip");

    let error = directory.cleanup().unwrap_err();

    assert_eq!(error.code, "backup_cleanup_failed");
    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("file=published.zip"));
    assert!(directory_path.join("published.zip").is_file());

    directory.cleanup().unwrap();
    assert!(!directory_path.exists());
}

#[test]
fn cleanup_is_a_noop_after_the_directory_is_disarmed() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    directory.disarm();

    directory.cleanup().unwrap();

    assert!(directory_path.is_dir());
    std::fs::remove_dir(directory_path).unwrap();
}

#[test]
fn backup_root_that_is_an_existing_file_is_rejected_without_mutation() {
    let sandbox = tempfile::tempdir().unwrap();
    let root_file = sandbox.path().join("not-a-directory");
    std::fs::write(&root_file, b"root sentinel").unwrap();

    let error = match super::create_backup_directory(&root_file) {
        Ok(_) => panic!("file path unexpectedly accepted as a backup root"),
        Err(error) => error,
    };

    assert_eq!(error.code, "backup_root_unwritable");
    assert_eq!(std::fs::read(&root_file).unwrap(), b"root sentinel");
}

#[test]
fn zip_cleanup_failure_keeps_tracking_and_returns_a_recovery_path() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    directory
        .write_zip("same-name.zip", b"first published bytes")
        .unwrap();
    directory.fail_unlink_file("same-name.zip.partial");

    let error = directory
        .write_zip("same-name.zip", b"second conflicting bytes")
        .unwrap_err();

    assert_eq!(error.code, "backup_cleanup_failed");
    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("recovery_path="));
    assert_eq!(
        std::fs::read(directory_path.join("same-name.zip")).unwrap(),
        b"first published bytes"
    );
    assert!(directory_path.join("same-name.zip.partial").is_file());
    drop(directory);
    assert!(!directory_path.exists());
}

#[test]
fn dropping_an_uncommitted_backup_directory_removes_its_new_tree() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let path = directory.path().to_path_buf();
    directory
        .write_zip("unfinished.zip", b"unfinished backup")
        .unwrap();

    drop(directory);

    assert!(!path.exists());
}

#[test]
fn backup_single_flight_holds_the_filesystem_lock_across_await() {
    let root = tempfile::tempdir().unwrap();
    let primary = FilesystemMutationLock::new(root.path()).unwrap();
    let contender = FilesystemMutationLock::new(root.path()).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();

    let active = tauri::async_runtime::spawn(async move {
        super::run_exclusive(&primary, async move {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            "completed"
        })
        .await
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

    let error =
        tauri::async_runtime::block_on(super::run_exclusive(&contender, async { "must not run" }))
            .unwrap_err();
    assert_eq!(error.code, "filesystem_busy");

    release_tx.send(()).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(active).unwrap().unwrap(),
        "completed"
    );
}

#[test]
fn database_late_failure_rolls_back_every_backup_row_and_removes_new_directory() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let backup_path = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap();
    let mut connection = backup_database();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_backup_manifest
                 BEFORE INSERT ON backup_manifests
                 BEGIN
                   SELECT RAISE(ABORT, 'fictional manifest late failure');
                 END;",
        )
        .unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "all".into(),
        repo_ids: None,
    };
    let successful = [super::SuccessfulBackupUpdate {
        repo_id: "repo-1".into(),
        expected_remote_sha: "old-sha".into(),
        sha: "new-sha".into(),
        path: backup_path.to_string_lossy().into_owned(),
    }];
    let manifest = serde_json::json!({"version":"1.0.0","items":[{"repo_id":"repo-1"}]});
    let log = vec!["download fictional.zip".to_string()];
    let directory_path = directory.path().to_path_buf();

    let error = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &successful,
            failure_count: 0,
            total_count: 1,
            log: &log,
        },
    )
    .unwrap_err();

    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("fictional manifest late failure"));
    assert!(!directory_path.exists());
    let repository: (Option<String>, String, Option<String>) = connection
            .query_row(
                "SELECT last_backup_sha, backup_status, backup_path FROM repositories WHERE id = 'repo-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
    assert_eq!(repository, (None, "never-backed-up".into(), None));
    for table in ["backup_jobs", "task_logs", "backup_manifests"] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "table={table}");
    }
}

#[test]
fn ownership_drift_never_writes_to_or_deletes_a_replacement_directory() {
    let root = tempfile::tempdir().unwrap();
    let directory = super::create_backup_directory(root.path()).unwrap();
    let original_path = directory.path().to_path_buf();
    let moved_original = root.path().join("moved-original");
    std::fs::rename(&original_path, &moved_original).unwrap();
    std::fs::create_dir(&original_path).unwrap();
    std::fs::write(
        original_path.join("sentinel.txt"),
        "replacement owned elsewhere",
    )
    .unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "all".into(),
        repo_ids: None,
    };
    let manifest = serde_json::json!({"version":"1.0.0","items":[]});
    let log = vec!["fictional backup".to_string()];
    let mut connection = backup_database();

    let error = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &[],
            failure_count: 1,
            total_count: 1,
            log: &log,
        },
    )
    .unwrap_err();

    assert_eq!(error.code, "backup_ownership_changed");
    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("recovery_path="));
    assert_eq!(
        std::fs::read_to_string(original_path.join("sentinel.txt")).unwrap(),
        "replacement owned elsewhere"
    );
    assert!(!original_path.join("manifest.json").exists());
    assert!(moved_original.exists());
}

#[test]
fn zip_write_revalidates_directory_identity_after_network_waits() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let original_path = directory.path().to_path_buf();
    let moved_original = root.path().join("moved-before-zip-write");
    std::fs::rename(&original_path, &moved_original).unwrap();
    std::fs::create_dir(&original_path).unwrap();
    std::fs::write(original_path.join("sentinel.txt"), "do not replace").unwrap();

    let error = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap_err();

    assert_eq!(error.code, "backup_ownership_changed");
    assert_eq!(
        std::fs::read_to_string(original_path.join("sentinel.txt")).unwrap(),
        "do not replace"
    );
    assert!(!original_path.join("fictional.zip").exists());
    assert!(moved_original.exists());
}

#[test]
fn zip_write_uses_the_owned_directory_fd_when_path_changes_after_validation() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let original_path = directory.path().to_path_buf();
    let moved_original = root.path().join("moved-during-zip-write");
    let hook_path = original_path.clone();
    let hook_moved = moved_original.clone();
    directory.set_before_relative_io_hook(move || {
        std::fs::rename(&hook_path, &hook_moved).unwrap();
        std::fs::create_dir(&hook_path).unwrap();
        std::fs::write(hook_path.join("sentinel.txt"), "replacement").unwrap();
    });

    let error = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap_err();

    assert_eq!(error.code, "backup_ownership_changed");
    assert_eq!(
        std::fs::read_to_string(original_path.join("sentinel.txt")).unwrap(),
        "replacement"
    );
    assert!(!original_path.join("fictional.zip").exists());
    assert!(!moved_original.join("fictional.zip").exists());
}

#[test]
fn successful_finalization_disarms_cleanup_and_keeps_complete_backup() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    let backup_path = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "all".into(),
        repo_ids: None,
    };
    let successful = [super::SuccessfulBackupUpdate {
        repo_id: "repo-1".into(),
        expected_remote_sha: "old-sha".into(),
        sha: "new-sha".into(),
        path: backup_path.to_string_lossy().into_owned(),
    }];
    let manifest = serde_json::json!({"version":"1.0.0","items":[{"repo_id":"repo-1"}]});
    let log = vec!["download fictional.zip".to_string()];
    let mut connection = backup_database();

    let tasks = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &successful,
            failure_count: 0,
            total_count: 1,
            log: &log,
        },
    )
    .unwrap();

    assert_eq!(tasks[0].status, "success");
    assert!(directory_path.join("manifest.json").is_file());
    assert!(directory_path.join("task-log.jsonl").is_file());
    assert!(directory_path.join("fictional.zip").is_file());
    let repository: (String, Option<String>, String) = connection
        .query_row(
            "SELECT remote_sha, last_backup_sha, backup_status
                 FROM repositories WHERE id = 'repo-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        repository,
        (
            "new-sha".into(),
            Some("new-sha".into()),
            "backed-up-latest".into()
        )
    );
}

#[test]
fn mixed_backup_result_is_recorded_as_partial_success() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let backup_path = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "selected".into(),
        repo_ids: Some(vec!["repo-1".into(), "repo-failed".into()]),
    };
    let successful = [super::SuccessfulBackupUpdate {
        repo_id: "repo-1".into(),
        expected_remote_sha: "old-sha".into(),
        sha: "new-sha".into(),
        path: backup_path.to_string_lossy().into_owned(),
    }];
    let manifest = serde_json::json!({"version":"1.0.0","items":[{"repo_id":"repo-1"}]});
    let log = vec![
        "repo-1 succeeded".to_string(),
        "repo-failed failed".to_string(),
    ];
    let mut connection = backup_database();

    let tasks = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &successful,
            failure_count: 1,
            total_count: 2,
            log: &log,
        },
    )
    .unwrap();

    assert_eq!(tasks[0].status, "partial-success");
    assert_eq!(tasks[0].progress, "1 / 2");
    let manifest_status: String = connection
        .query_row(
            "SELECT status FROM backup_manifests ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(manifest_status, "partial-success");
}

#[test]
fn repository_deleted_during_download_cannot_commit_a_ghost_backup() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    let backup_path = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap();
    let mut connection = backup_database();
    connection
        .execute("DELETE FROM repositories WHERE id = 'repo-1'", [])
        .unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "all".into(),
        repo_ids: None,
    };
    let successful = [super::SuccessfulBackupUpdate {
        repo_id: "repo-1".into(),
        expected_remote_sha: "old-sha".into(),
        sha: "new-sha".into(),
        path: backup_path.to_string_lossy().into_owned(),
    }];
    let manifest = serde_json::json!({"version":"1.0.0","items":[{"repo_id":"repo-1"}]});
    let log = vec!["download fictional.zip".to_string()];

    let error = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &successful,
            failure_count: 0,
            total_count: 1,
            log: &log,
        },
    )
    .unwrap_err();

    assert_eq!(error.code, "backup_repository_changed");
    assert!(!directory_path.exists());
    let manifest_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM backup_manifests", [], |row| {
            row.get(0)
        })
        .unwrap();
    let job_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM backup_jobs", [], |row| row.get(0))
        .unwrap();
    assert_eq!((manifest_count, job_count), (0, 0));
}

#[test]
fn repository_remote_sha_change_during_download_rejects_stale_finalization() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    let backup_path = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap();
    let database_dir = tempfile::tempdir().unwrap();
    let database_path = database_dir.path().join("backup.sqlite");
    let mut connection = Connection::open(&database_path).unwrap();
    initialize_backup_database(&connection);
    let concurrent = Connection::open(&database_path).unwrap();
    concurrent
        .execute(
            "UPDATE repositories SET remote_sha = 'concurrent-sha'
                 WHERE id = 'repo-1'",
            [],
        )
        .unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "all".into(),
        repo_ids: None,
    };
    let successful = [super::SuccessfulBackupUpdate {
        repo_id: "repo-1".into(),
        expected_remote_sha: "old-sha".into(),
        sha: "downloaded-sha".into(),
        path: backup_path.to_string_lossy().into_owned(),
    }];
    let manifest = serde_json::json!({"version":"1.0.0","items":[{"repo_id":"repo-1"}]});
    let log = vec!["download fictional.zip".to_string()];

    let error = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &successful,
            failure_count: 0,
            total_count: 1,
            log: &log,
        },
    )
    .expect_err("a concurrent repository refresh must reject stale backup metadata");

    assert_eq!(error.code, "backup_repository_changed");
    assert!(!directory_path.exists());
    let repository: (String, Option<String>, String) = connection
        .query_row(
            "SELECT remote_sha, last_backup_sha, backup_status
                 FROM repositories WHERE id = 'repo-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        repository,
        ("concurrent-sha".into(), None, "never-backed-up".into())
    );
    for table in ["backup_jobs", "task_logs", "backup_manifests"] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "table={table}");
    }
}

#[test]
fn parent_path_replacement_is_detected_before_relative_io() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("backups");
    std::fs::create_dir(&root).unwrap();
    let mut directory = super::create_backup_directory(&root).unwrap();
    let moved_root = outer.path().join("moved-backups");
    std::fs::rename(&root, &moved_root).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("sentinel.txt"), "replacement parent").unwrap();

    let error = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap_err();

    assert_eq!(error.code, "backup_ownership_changed");
    assert_eq!(
        std::fs::read_to_string(root.join("sentinel.txt")).unwrap(),
        "replacement parent"
    );
    assert!(!root.join("fictional.zip").exists());
    assert!(moved_root.join(directory.id()).is_dir());
}

#[test]
fn parent_directory_open_rejects_a_symlink() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let link = root.path().join("link");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let error = crate::backup_fs::open_directory_path(&link).unwrap_err();

    assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn creation_failure_removes_only_an_empty_directory() {
    let root = tempfile::tempdir().unwrap();
    let parent = crate::backup_fs::open_directory_path(root.path()).unwrap();
    std::fs::create_dir(root.path().join("empty-owned")).unwrap();
    let original = crate::AppError::new("injected_open_failure", "injected");

    let error = super::creation_failure(
        &parent,
        "empty-owned",
        &root.path().join("empty-owned"),
        original,
    );

    assert_eq!(error.code, "injected_open_failure");
    assert!(!root.path().join("empty-owned").exists());

    let nonempty = root.path().join("nonempty-replacement");
    std::fs::create_dir(&nonempty).unwrap();
    std::fs::write(nonempty.join("sentinel.txt"), "must survive").unwrap();
    let error = super::creation_failure(
        &parent,
        "nonempty-replacement",
        &nonempty,
        crate::AppError::new("injected_identity_failure", "injected"),
    );
    assert_eq!(error.code, "injected_identity_failure");
    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("cleanup_failed="));
    assert_eq!(
        std::fs::read_to_string(nonempty.join("sentinel.txt")).unwrap(),
        "must survive"
    );
}

#[test]
fn manifest_symlink_is_never_followed_or_deleted_recursively() {
    let root = tempfile::tempdir().unwrap();
    let external = root.path().join("external.txt");
    std::fs::write(&external, "external sentinel").unwrap();
    let directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    std::os::unix::fs::symlink(&external, directory_path.join("manifest.json")).unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "all".into(),
        repo_ids: None,
    };
    let manifest = serde_json::json!({"version":"1.0.0","items":[]});
    let log = vec!["fictional backup".to_string()];
    let mut connection = backup_database();

    let error = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &[],
            failure_count: 1,
            total_count: 1,
            log: &log,
        },
    )
    .unwrap_err();

    assert_eq!(error.code, "manifest_write_failed");
    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("recovery_path="));
    assert_eq!(
        std::fs::read_to_string(&external).unwrap(),
        "external sentinel"
    );
    assert!(directory_path.join("manifest.json").is_symlink());
}

#[test]
fn manifest_and_task_log_failures_leave_db_unchanged_and_remove_new_directory() {
    for failed_file in ["manifest.json", "task-log.jsonl"] {
        let root = tempfile::tempdir().unwrap();
        let mut directory = super::create_backup_directory(root.path()).unwrap();
        let directory_path = directory.path().to_path_buf();
        let backup_path = directory
            .write_zip("fictional.zip", b"fictional zip bytes")
            .unwrap();
        directory.fail_relative_file(failed_file);
        let request = crate::BackupRepositoriesRequest {
            mode: "all".into(),
            repo_ids: None,
        };
        let successful = [super::SuccessfulBackupUpdate {
            repo_id: "repo-1".into(),
            expected_remote_sha: "old-sha".into(),
            sha: "new-sha".into(),
            path: backup_path.to_string_lossy().into_owned(),
        }];
        let manifest = serde_json::json!({"version":"1.0.0","items":[]});
        let log = vec!["fictional backup".to_string()];
        let mut connection = backup_database();

        let error = super::finalize_backup(
            &mut connection,
            directory,
            super::BackupFinalization {
                request: &request,
                manifest: &manifest,
                successful: &successful,
                failure_count: 0,
                total_count: 1,
                log: &log,
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "manifest_write_failed", "file={failed_file}");
        assert!(!directory_path.exists(), "file={failed_file}");
        let repository: (Option<String>, String) = connection
            .query_row(
                "SELECT last_backup_sha, backup_status FROM repositories WHERE id = 'repo-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(repository, (None, "never-backed-up".into()));
        for table in ["backup_jobs", "task_logs", "backup_manifests"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "file={failed_file}; table={table}");
        }
    }
}

#[test]
fn commit_failure_rolls_back_all_rows_and_cleans_files() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = super::create_backup_directory(root.path()).unwrap();
    let directory_path = directory.path().to_path_buf();
    let backup_path = directory
        .write_zip("fictional.zip", b"fictional zip bytes")
        .unwrap();
    let mut connection = backup_database();
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
                 CREATE TABLE fictional_parent (id INTEGER PRIMARY KEY);
                 CREATE TABLE fictional_child (
                   parent_id INTEGER REFERENCES fictional_parent(id)
                     DEFERRABLE INITIALLY DEFERRED
                 );
                 CREATE TRIGGER fail_backup_commit
                 AFTER INSERT ON backup_manifests
                 BEGIN
                   INSERT INTO fictional_child(parent_id) VALUES (404);
                 END;",
        )
        .unwrap();
    let request = crate::BackupRepositoriesRequest {
        mode: "all".into(),
        repo_ids: None,
    };
    let successful = [super::SuccessfulBackupUpdate {
        repo_id: "repo-1".into(),
        expected_remote_sha: "old-sha".into(),
        sha: "new-sha".into(),
        path: backup_path.to_string_lossy().into_owned(),
    }];
    let manifest = serde_json::json!({"version":"1.0.0","items":[]});
    let log = vec!["fictional backup".to_string()];

    let error = super::finalize_backup(
        &mut connection,
        directory,
        super::BackupFinalization {
            request: &request,
            manifest: &manifest,
            successful: &successful,
            failure_count: 0,
            total_count: 1,
            log: &log,
        },
    )
    .unwrap_err();

    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("FOREIGN KEY constraint failed"));
    assert!(connection.is_autocommit());
    assert!(!directory_path.exists());
    let repository: (Option<String>, String) = connection
        .query_row(
            "SELECT last_backup_sha, backup_status FROM repositories WHERE id = 'repo-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(repository, (None, "never-backed-up".into()));
    for table in [
        "backup_jobs",
        "task_logs",
        "backup_manifests",
        "fictional_child",
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "table={table}");
    }
}
