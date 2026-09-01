use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::{adapters::FilesystemAdapter, expand_tilde, get_setting, AppError};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OpenBackupFolderRequest {
    pub(super) repository_id: Option<String>,
}

/// Resolves an open-folder request from trusted database state. The UI can
/// select either the configured root or a stable repository ID, never a path.
pub(super) fn resolve_backup_folder(
    conn: &Connection,
    repository_id: Option<&str>,
    filesystem: &dyn FilesystemAdapter,
) -> Result<PathBuf, AppError> {
    let configured_root = get_setting(conn, "backup_root")?
        .ok_or_else(|| AppError::new("backup_root_not_configured", "尚未配置备份根目录。"))?;
    let canonical_root = filesystem
        .canonicalize(&expand_tilde(&configured_root))
        .map_err(|error| {
            AppError::with_details(
                "backup_root_unavailable",
                "备份根目录不存在或不可访问。",
                error.to_string(),
            )
        })?;
    if !filesystem.is_dir(&canonical_root) {
        return Err(AppError::new(
            "backup_root_unavailable",
            "备份根目录不存在或不可访问。",
        ));
    }
    let Some(repository_id) = repository_id else {
        return Ok(canonical_root);
    };
    let stored_path = conn
        .query_row(
            "SELECT backup_path FROM repositories WHERE id = ?1",
            params![repository_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .ok_or_else(|| {
            AppError::new(
                "backup_repository_not_found",
                "未找到对应仓库，无法打开备份目录。",
            )
        })?
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| AppError::new("backup_not_available", "该仓库还没有可用备份。"))?;
    let canonical_target = filesystem
        .canonicalize(&expand_tilde(&stored_path))
        .map_err(|error| {
            AppError::with_details(
                "backup_path_unavailable",
                "仓库备份不存在或不可访问。",
                error.to_string(),
            )
        })?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(AppError::new(
            "backup_path_outside_root",
            "仓库备份不在已配置的备份根目录内。",
        ));
    }
    if filesystem.is_dir(&canonical_target) {
        Ok(canonical_target)
    } else {
        canonical_target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::new("backup_path_unavailable", "无法解析仓库备份所在目录。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{adapters::SystemFilesystem, migrate, path_string, set_setting, utc_now};
    use std::fs;

    fn add_repository(conn: &Connection, id: &str, backup_path: &Path) {
        let now = utc_now();
        conn.execute(
            "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
              backup_status, check_status, url, branch, backup_path, source_type, created_at, updated_at)
             VALUES (?1, 'owner/repo', 'owner', 'repo', 'main', 'skill repo', 0, 'sha',
              'success', 'success', 'https://github.com/owner/repo', 'main', ?2, 'github', ?3, ?3)",
            params![id, path_string(backup_path), now],
        )
        .unwrap();
    }

    #[test]
    fn wire_contract_accepts_only_a_stable_repository_id() {
        let request: OpenBackupFolderRequest =
            serde_json::from_value(serde_json::json!({ "repositoryId": "repo-1" })).unwrap();
        assert_eq!(request.repository_id.as_deref(), Some("repo-1"));
        assert!(serde_json::from_value::<OpenBackupFolderRequest>(
            serde_json::json!({ "path": "/tmp/arbitrary" })
        )
        .is_err());
    }

    #[test]
    fn resolves_root_and_repository_folder_only_from_database_ids() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("backups");
        let repository_folder = root.join("owner-repo");
        let repository_archive = repository_folder.join("snapshot.zip");
        fs::create_dir_all(&repository_folder).unwrap();
        fs::write(&repository_archive, b"fictional archive").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        set_setting(&conn, "backup_root", path_string(&root)).unwrap();
        add_repository(&conn, "repo-1", &repository_folder);
        add_repository(&conn, "repo-archive", &repository_archive);

        assert_eq!(
            resolve_backup_folder(&conn, None, &SystemFilesystem).unwrap(),
            root.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_backup_folder(&conn, Some("repo-1"), &SystemFilesystem).unwrap(),
            repository_folder.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_backup_folder(&conn, Some("repo-archive"), &SystemFilesystem).unwrap(),
            repository_folder.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_backup_folder(&conn, Some("missing"), &SystemFilesystem)
                .unwrap_err()
                .code,
            "backup_repository_not_found"
        );
    }

    #[test]
    fn rejects_paths_outside_the_configured_root() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("backups");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        set_setting(&conn, "backup_root", path_string(&root)).unwrap();
        add_repository(&conn, "repo-outside", &outside);

        assert_eq!(
            resolve_backup_folder(&conn, Some("repo-outside"), &SystemFilesystem)
                .unwrap_err()
                .code,
            "backup_path_outside_root"
        );
    }

    #[test]
    fn rejects_a_configured_backup_root_that_is_not_a_directory() {
        let sandbox = tempfile::tempdir().unwrap();
        let root_file = sandbox.path().join("not-a-directory");
        fs::write(&root_file, b"fictional root file").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        set_setting(&conn, "backup_root", path_string(&root_file)).unwrap();

        assert_eq!(
            resolve_backup_folder(&conn, None, &SystemFilesystem)
                .unwrap_err()
                .code,
            "backup_root_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_configured_root() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("backups");
        let outside = sandbox.path().join("outside");
        let link = root.join("escaped-repo");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &link).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        set_setting(&conn, "backup_root", path_string(&root)).unwrap();
        add_repository(&conn, "repo-link", &link);

        assert_eq!(
            resolve_backup_folder(&conn, Some("repo-link"), &SystemFilesystem)
                .unwrap_err()
                .code,
            "backup_path_outside_root"
        );
    }

    #[test]
    fn reports_unavailable_configured_root_without_exposing_a_path() {
        let sandbox = tempfile::tempdir().unwrap();
        let missing_root = sandbox.path().join("missing-backup-root");
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        set_setting(&conn, "backup_root", path_string(&missing_root)).unwrap();

        let error = resolve_backup_folder(&conn, None, &SystemFilesystem).unwrap_err();

        assert_eq!(error.code, "backup_root_unavailable");
        assert_eq!(error.message, "备份根目录不存在或不可访问。");
        assert!(error.details.is_some());
    }

    #[test]
    fn reports_a_missing_recorded_backup_after_validating_the_root() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("backups");
        let missing_backup = root.join("repository").join("snapshot.zip");
        fs::create_dir_all(&root).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        set_setting(&conn, "backup_root", path_string(&root)).unwrap();
        add_repository(&conn, "repo-missing-backup", &missing_backup);

        let error = resolve_backup_folder(&conn, Some("repo-missing-backup"), &SystemFilesystem)
            .unwrap_err();

        assert_eq!(error.code, "backup_path_unavailable");
        assert_eq!(error.message, "仓库备份不存在或不可访问。");
        assert!(error.details.is_some());
    }
}
