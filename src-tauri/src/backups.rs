use crate::{
    backup_fs::{
        entry_exists_at, identity_at, identity_from_metadata, identity_from_path, mkdir_at,
        open_directory_at, open_directory_path, open_new_file_at, rename_at, unlink_at,
        DirectoryIdentity,
    },
    insert_retryable_task, load_ui_tasks, path_string,
    temp_artifacts::{unique_operation_id, FilesystemMutationLock},
    utc_now, AppError, BackupRepositoriesRequest, TaskWrite, UiTask, RETRY_BACKUP_REPOSITORIES,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub(super) async fn run_exclusive<T, F>(
    lock: &FilesystemMutationLock,
    operation: F,
) -> Result<T, AppError>
where
    F: Future<Output = T> + Send,
{
    let _guard = lock
        .try_acquire()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::new("filesystem_busy", "另一项文件操作正在进行，请稍后重试。"))?;
    Ok(operation.await)
}

pub(super) fn safe_zip_name(repo_name: &str, ref_name: &str, sha: &str) -> String {
    const MAX_COMPONENT_BYTES: usize = 255;
    const PARTIAL_SUFFIX_BYTES: usize = ".partial".len();
    let sanitize = |value: &str| {
        value
            .chars()
            .map(|character| {
                if character.is_control() || matches!(character, '/' | '\\' | ':') {
                    '_'
                } else {
                    character
                }
            })
            .collect::<String>()
    };
    let mut digest = Sha256::new();
    digest.update(repo_name.as_bytes());
    digest.update([0]);
    digest.update(ref_name.as_bytes());
    digest.update([0]);
    digest.update(sha.as_bytes());
    let suffix = format!("__{}.zip", hex::encode(digest.finalize()));
    let prefix = format!("{}__{}", sanitize(repo_name), sanitize(ref_name));
    let max_prefix = MAX_COMPONENT_BYTES - PARTIAL_SUFFIX_BYTES - suffix.len();
    let mut end = prefix.len().min(max_prefix);
    while !prefix.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &prefix[..end])
}

pub(super) struct BackupDirectory {
    id: String,
    path: PathBuf,
    canonical_parent: PathBuf,
    parent_identity: DirectoryIdentity,
    identity: DirectoryIdentity,
    parent_directory: File,
    directory: File,
    created_files: Vec<String>,
    armed: bool,
    #[cfg(test)]
    before_relative_io: Option<Box<dyn FnOnce() + Send>>,
    #[cfg(test)]
    fail_relative_file: Option<String>,
    #[cfg(test)]
    fail_unlink_file: Option<String>,
}

impl BackupDirectory {
    pub(super) fn id(&self) -> &str {
        &self.id
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    fn ownership_changed(&self, reason: impl std::fmt::Display) -> AppError {
        AppError::with_details(
            "backup_ownership_changed",
            "备份目录所有权发生变化，已停止写入或清理。",
            format!(
                "recovery_path={}; canonical_parent={}; reason={reason}",
                path_string(&self.path),
                path_string(&self.canonical_parent)
            ),
        )
    }

    fn validate_identity(&self) -> Result<(), AppError> {
        let held_parent = identity_from_metadata(
            &self
                .parent_directory
                .metadata()
                .map_err(|error| self.ownership_changed(error))?,
        )
        .map_err(|error| self.ownership_changed(error))?;
        if held_parent != self.parent_identity {
            return Err(self.ownership_changed("open parent directory identity changed"));
        }
        let current_parent = identity_from_path(&self.canonical_parent)
            .map_err(|error| self.ownership_changed(error))?;
        if current_parent != self.parent_identity {
            return Err(self.ownership_changed("parent directory device/inode changed"));
        }
        let owned = identity_from_metadata(
            &self
                .directory
                .metadata()
                .map_err(|error| self.ownership_changed(error))?,
        )
        .map_err(|error| self.ownership_changed(error))?;
        if owned != self.identity {
            return Err(self.ownership_changed("open directory identity changed"));
        }
        #[cfg(unix)]
        let current = identity_at(&self.parent_directory, &self.id)
            .map_err(|error| self.ownership_changed(error))?;
        #[cfg(not(unix))]
        let current = return Err(self.ownership_changed("Unix directory descriptors required"));
        if current != self.identity {
            return Err(self.ownership_changed("directory device/inode changed"));
        }
        Ok(())
    }

    #[cfg(test)]
    fn set_before_relative_io_hook(&mut self, hook: impl FnOnce() + Send + 'static) {
        self.before_relative_io = Some(Box::new(hook));
    }

    fn run_before_relative_io_hook(&mut self) {
        #[cfg(test)]
        if let Some(hook) = self.before_relative_io.take() {
            hook();
        }
    }

    #[cfg(test)]
    fn fail_relative_file(&mut self, file_name: &str) {
        self.fail_relative_file = Some(file_name.to_string());
    }

    #[cfg(test)]
    fn fail_unlink_file(&mut self, file_name: &str) {
        self.fail_unlink_file = Some(file_name.to_string());
    }

    #[cfg(unix)]
    fn unlink_created_file(&mut self, file_name: &str) -> io::Result<()> {
        #[cfg(test)]
        if self.fail_unlink_file.as_deref() == Some(file_name) {
            self.fail_unlink_file = None;
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected unlink failure",
            ));
        }
        unlink_at(&self.directory, file_name, 0)
    }

    fn write_new_file(
        &mut self,
        file_name: &str,
        bytes: &[u8],
        message: &'static str,
    ) -> Result<PathBuf, AppError> {
        self.validate_identity()?;
        self.run_before_relative_io_hook();
        #[cfg(test)]
        if self.fail_relative_file.as_deref() == Some(file_name) {
            self.fail_relative_file = None;
            return Err(AppError::with_details(
                "manifest_write_failed",
                message,
                "injected relative file write failure",
            ));
        }
        #[cfg(unix)]
        let mut file = open_new_file_at(&self.directory, file_name).map_err(|error| {
            AppError::with_details("manifest_write_failed", message, error.to_string())
        })?;
        #[cfg(not(unix))]
        let mut file = return Err(AppError::new(
            "filesystem_unsupported",
            "备份文件写入需要 Unix 目录描述符。",
        ));
        self.created_files.push(file_name.to_string());
        file.write_all(bytes).map_err(|error| {
            AppError::with_details("manifest_write_failed", message, error.to_string())
        })?;
        file.sync_all().map_err(|error| {
            AppError::with_details("manifest_write_failed", message, error.to_string())
        })?;
        self.validate_identity()?;
        Ok(self.path.join(file_name))
    }

    pub(super) fn write_zip(&mut self, file_name: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
        let mut components = Path::new(file_name).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            return Err(AppError::new(
                "backup_zip_path_invalid",
                "备份 ZIP 文件名无效。",
            ));
        }
        self.validate_identity()?;
        self.run_before_relative_io_hook();
        let final_path = self.path.join(file_name);
        let partial_name = format!("{file_name}.partial");
        let mut tracking_index = None;
        let mut published = false;
        let write_result = (|| -> Result<(), AppError> {
            #[cfg(unix)]
            let mut file = open_new_file_at(&self.directory, &partial_name).map_err(|error| {
                AppError::with_details(
                    "backup_zip_write_failed",
                    "源码 ZIP 写入失败。",
                    error.to_string(),
                )
            })?;
            #[cfg(not(unix))]
            let mut file = return Err(AppError::new(
                "filesystem_unsupported",
                "备份文件写入需要 Unix 目录描述符。",
            ));
            tracking_index = Some(self.created_files.len());
            self.created_files.push(partial_name.clone());
            file.write_all(bytes).map_err(|error| {
                AppError::with_details(
                    "backup_zip_write_failed",
                    "源码 ZIP 写入失败。",
                    error.to_string(),
                )
            })?;
            file.sync_all().map_err(|error| {
                AppError::with_details(
                    "backup_zip_write_failed",
                    "源码 ZIP 写入失败。",
                    error.to_string(),
                )
            })?;
            #[cfg(unix)]
            if entry_exists_at(&self.directory, file_name)? {
                return Err(AppError::new(
                    "backup_zip_path_exists",
                    "备份 ZIP 目标已存在，已停止覆盖。",
                ));
            }
            #[cfg(unix)]
            rename_at(&self.directory, &partial_name, file_name).map_err(|error| {
                AppError::with_details(
                    "backup_zip_write_failed",
                    "源码 ZIP 写入失败。",
                    error.to_string(),
                )
            })?;
            published = true;
            self.created_files[tracking_index.expect("tracked partial must exist")] =
                file_name.to_string();
            self.validate_identity()?;
            Ok(())
        })();
        if let Err(error) = write_result {
            #[cfg(unix)]
            if let Some(index) = tracking_index {
                let tracked_name = if published {
                    file_name
                } else {
                    partial_name.as_str()
                };
                match self.unlink_created_file(tracked_name) {
                    Ok(()) => {
                        self.created_files.remove(index);
                    }
                    Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => {
                        self.created_files.remove(index);
                    }
                    Err(cleanup_error) => {
                        return Err(AppError::with_details(
                            "backup_cleanup_failed",
                            "备份写入失败，且临时文件清理未完成。",
                            format!(
                                "recovery_path={}; file={tracked_name}; original_code={}; cleanup={cleanup_error}",
                                path_string(&self.path), error.code
                            ),
                        ));
                    }
                }
            }
            return Err(error);
        }
        Ok(final_path)
    }

    fn cleanup(&mut self) -> Result<(), AppError> {
        if !self.armed {
            return Ok(());
        }
        let mut cleanup_errors = Vec::new();
        #[cfg(unix)]
        {
            let tracked_files = self.created_files.clone();
            let mut retained = Vec::new();
            for file_name in tracked_files.iter().rev() {
                if let Err(error) = self.unlink_created_file(file_name) {
                    if error.kind() != io::ErrorKind::NotFound {
                        cleanup_errors.push(format!("file={file_name}; error={error}"));
                        retained.push(file_name.clone());
                    }
                }
            }
            retained.reverse();
            self.created_files = retained;
        }
        if !cleanup_errors.is_empty() {
            return Err(AppError::with_details(
                "backup_cleanup_failed",
                "备份失败后的目录清理未完成，已保留恢复位置。",
                format!(
                    "recovery_path={}; errors={}",
                    path_string(&self.path),
                    cleanup_errors.join(" | ")
                ),
            ));
        }
        self.validate_identity()?;
        #[cfg(unix)]
        unlink_at(&self.parent_directory, &self.id, libc::AT_REMOVEDIR).map_err(|error| {
            AppError::with_details(
                "backup_cleanup_failed",
                "备份失败后的目录清理未完成，已保留恢复位置。",
                format!("recovery_path={}; error={error}", path_string(&self.path)),
            )
        })?;
        #[cfg(not(unix))]
        return Err(AppError::new(
            "filesystem_unsupported",
            "备份目录清理需要 Unix 目录描述符。",
        ));
        self.armed = false;
        Ok(())
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

fn creation_failure(
    parent_directory: &File,
    id: &str,
    path: &Path,
    mut error: AppError,
) -> AppError {
    #[cfg(unix)]
    if let Err(cleanup_error) = unlink_at(parent_directory, id, libc::AT_REMOVEDIR) {
        let details = error.details.take().unwrap_or_default();
        error.details = Some(format!(
            "{details}; cleanup_failed={cleanup_error}; recovery_path={}",
            path_string(path)
        ));
    }
    error
}

pub(super) fn create_backup_directory(root: &Path) -> Result<BackupDirectory, AppError> {
    fs::create_dir_all(root).map_err(|error| {
        AppError::with_details(
            "backup_root_unwritable",
            "备份目录不可写，请选择其他目录。",
            error.to_string(),
        )
    })?;
    let canonical_parent = root.canonicalize().map_err(|error| {
        AppError::with_details(
            "backup_root_unwritable",
            "备份目录不可写，请选择其他目录。",
            error.to_string(),
        )
    })?;
    let id = unique_operation_id("backup");
    let path = canonical_parent.join(&id);
    #[cfg(unix)]
    let parent_directory = open_directory_path(&canonical_parent).map_err(|error| {
        AppError::with_details(
            "backup_root_unwritable",
            "备份目录不可写，请选择其他目录。",
            error.to_string(),
        )
    })?;
    #[cfg(not(unix))]
    return Err(AppError::new(
        "filesystem_unsupported",
        "创建备份目录需要 Unix 目录描述符。",
    ));
    let parent_identity =
        identity_from_metadata(&parent_directory.metadata().map_err(|error| {
            AppError::with_details(
                "backup_root_unwritable",
                "备份目录不可写，请选择其他目录。",
                error.to_string(),
            )
        })?)
        .map_err(AppError::from)?;
    if identity_from_path(&canonical_parent).map_err(AppError::from)? != parent_identity {
        return Err(AppError::with_details(
            "backup_ownership_changed",
            "备份根目录所有权发生变化，已停止创建。",
            format!("recovery_path={}", path_string(&canonical_parent)),
        ));
    }
    #[cfg(unix)]
    mkdir_at(&parent_directory, &id).map_err(|error| {
        AppError::with_details(
            "backup_root_unwritable",
            "无法创建备份目录。",
            error.to_string(),
        )
    })?;
    #[cfg(unix)]
    let directory = open_directory_at(&parent_directory, &id)
        .map_err(|error| creation_failure(&parent_directory, &id, &path, AppError::from(error)))?;
    #[cfg(unix)]
    let identity = directory
        .metadata()
        .map_err(AppError::from)
        .and_then(|metadata| identity_from_metadata(&metadata).map_err(AppError::from))
        .map_err(|error| creation_failure(&parent_directory, &id, &path, error))?;
    #[cfg(unix)]
    if identity_at(&parent_directory, &id)
        .map_err(AppError::from)
        .map_err(|error| creation_failure(&parent_directory, &id, &path, error))?
        != identity
    {
        return Err(creation_failure(
            &parent_directory,
            &id,
            &path,
            AppError::with_details(
                "backup_ownership_changed",
                "备份目录所有权发生变化，已停止写入或清理。",
                format!("recovery_path={}", path_string(&path)),
            ),
        ));
    }
    Ok(BackupDirectory {
        id,
        path,
        canonical_parent,
        parent_identity,
        identity,
        parent_directory,
        directory,
        created_files: Vec::new(),
        armed: true,
        #[cfg(test)]
        before_relative_io: None,
        #[cfg(test)]
        fail_relative_file: None,
        #[cfg(test)]
        fail_unlink_file: None,
    })
}

impl Drop for BackupDirectory {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Err(error) = self.cleanup() {
            self.disarm();
            eprintln!(
                "backup directory cleanup failed; recovery_path={}; code={}; details={}",
                path_string(&self.path),
                error.code,
                error.details.unwrap_or_default()
            );
        }
    }
}

pub(super) struct SuccessfulBackupUpdate {
    pub(super) repo_id: String,
    pub(super) expected_remote_sha: String,
    pub(super) sha: String,
    pub(super) path: String,
}

pub(super) struct BackupFinalization<'a> {
    pub(super) request: &'a BackupRepositoriesRequest,
    pub(super) manifest: &'a serde_json::Value,
    pub(super) successful: &'a [SuccessfulBackupUpdate],
    pub(super) failure_count: usize,
    pub(super) total_count: usize,
    pub(super) log: &'a [String],
}

pub(super) fn finalize_backup(
    connection: &mut Connection,
    mut directory: BackupDirectory,
    finalization: BackupFinalization<'_>,
) -> Result<Vec<UiTask>, AppError> {
    let result = finalize_backup_inner(connection, &mut directory, finalization);
    match result {
        Ok(tasks) => {
            directory.disarm();
            Ok(tasks)
        }
        Err(error) => Err(cleanup_after_failure(&mut directory, error)),
    }
}

fn finalize_backup_inner(
    connection: &mut Connection,
    directory: &mut BackupDirectory,
    finalization: BackupFinalization<'_>,
) -> Result<Vec<UiTask>, AppError> {
    let manifest_path = directory.path.join("manifest.json");
    let manifest_bytes = serde_json::to_vec_pretty(finalization.manifest).map_err(|error| {
        AppError::with_details(
            "manifest_write_failed",
            "manifest 序列化失败。",
            error.to_string(),
        )
    })?;
    directory.write_new_file("manifest.json", &manifest_bytes, "manifest.json 写入失败。")?;
    let task_log = finalization
        .log
        .iter()
        .enumerate()
        .map(|(index, line)| serde_json::json!({ "line": index + 1, "message": line }).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    directory.write_new_file(
        "task-log.jsonl",
        task_log.as_bytes(),
        "task-log.jsonl 写入失败。",
    )?;

    let transaction = connection.transaction()?;
    let now = utc_now();
    for update in finalization.successful {
        let changed = transaction.execute(
            "UPDATE repositories
             SET remote_sha = ?2,
                 last_backup_sha = ?2,
                 backup_status = 'backed-up-latest',
                 backup_path = ?3,
                 snapshot_time = ?4,
                 updated_at = ?4
             WHERE id = ?1
               AND remote_sha IN (?2, ?5)",
            params![
                update.repo_id,
                update.sha,
                update.path,
                now,
                update.expected_remote_sha
            ],
        )?;
        if changed != 1 {
            return Err(AppError::with_details(
                "backup_repository_changed",
                "仓库在备份期间发生变化，已取消提交。",
                format!(
                    "repo_id={}; expected_remote_sha={}; downloaded_sha={}; affected_rows={changed}",
                    update.repo_id, update.expected_remote_sha, update.sha
                ),
            ));
        }
    }
    let status = if finalization.failure_count == 0 {
        "success"
    } else if finalization.successful.is_empty() {
        "failed"
    } else {
        "partial-success"
    };
    let summary = format!(
        "{} success, {} failed",
        finalization.successful.len(),
        finalization.failure_count
    );
    let progress = format!(
        "{} / {}",
        finalization.successful.len(),
        finalization.total_count
    );
    let job_id = unique_operation_id("backup");
    let backup_dir = path_string(&directory.path);
    insert_retryable_task(
        &transaction,
        TaskWrite {
            id: &job_id,
            kind: "Backup repositories",
            target: "Updated repositories",
            progress: &progress,
            status,
            summary: &summary,
            backup_dir: Some(&backup_dir),
            log: finalization.log,
        },
        RETRY_BACKUP_REPOSITORIES,
        finalization.request,
    )?;
    transaction.execute(
        "INSERT INTO backup_manifests
         (id, backup_dir, manifest_path, created_at, mode, status, summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            directory.id,
            backup_dir,
            path_string(&manifest_path),
            now,
            finalization.request.mode,
            status,
            summary
        ],
    )?;
    let tasks = load_ui_tasks(&transaction)?;
    directory.validate_identity()?;
    transaction.commit()?;
    Ok(tasks)
}

fn cleanup_after_failure(directory: &mut BackupDirectory, mut error: AppError) -> AppError {
    match directory.cleanup() {
        Ok(()) => error,
        Err(cleanup_error) => {
            let original_details = error.details.take().unwrap_or_default();
            let cleanup_details = cleanup_error.details.unwrap_or_default();
            if cleanup_error.code == "backup_ownership_changed" {
                AppError::with_details(
                    cleanup_error.code,
                    cleanup_error.message,
                    format!(
                        "{cleanup_details}; original_code={}; original_details={original_details}",
                        error.code
                    ),
                )
            } else {
                error.details = Some(format!(
                    "{original_details}; cleanup_code={}; {cleanup_details}",
                    cleanup_error.code
                ));
                error
            }
        }
    }
}

#[cfg(test)]
#[path = "backups_tests.rs"]
mod tests;
