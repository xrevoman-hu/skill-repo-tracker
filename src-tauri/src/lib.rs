use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Local, Utc};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;
use zip::ZipArchive;

const APP_USER_AGENT: &str = "SkillRepoTracker/1.1.0";
const TOKEN_SERVICE: &str = "Skill Repo Tracker";
const TOKEN_USER: &str = "github-token";
const LOCAL_SKILLS_LIBRARY_NAME: &str = "本地 Skills 库";
const LEGACY_LOCAL_SKILLS_LIBRARY_NAME: &str = "Local Skills Library";
const PREVIEW_MAX_CHARS: usize = 120_000;
const DEFAULT_SYNC_BACKUP_KEEP: i64 = 5;
const SYNC_TARGET_IDS: [&str; 6] = [
    "claude", "codex", "gemini", "opencode", "openclaw", "hermes",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse<T: Serialize> {
    ok: bool,
    data: Option<T>,
    error: Option<ApiError>,
}

type CommandResult<T> = Result<ApiResponse<T>, ()>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    code: String,
    message: String,
    details: Option<String>,
}

impl<T: Serialize> ApiResponse<T> {
    fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    fn err(code: impl Into<String>, message: impl Into<String>, details: Option<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(ApiError {
                code: code.into(),
                message: message.into(),
                details,
            }),
        }
    }
}

#[derive(Debug)]
struct AppError {
    code: String,
    message: String,
    details: Option<String>,
}

impl AppError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details.into()),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::with_details("sqlite_error", "SQLite 操作失败。", value.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::with_details("filesystem_error", "文件系统操作失败。", value.to_string())
    }
}

impl From<zip::result::ZipError> for AppError {
    fn from(value: zip::result::ZipError) -> Self {
        Self::with_details("zip_error", "ZIP 读取失败。", value.to_string())
    }
}

fn api_err<T: Serialize>(error: AppError) -> ApiResponse<T> {
    ApiResponse::err(error.code, error.message, error.details)
}

struct AppState {
    db: Mutex<Connection>,
    http: reqwest::Client,
    data_dir: PathBuf,
}

impl AppState {
    fn new(data_dir: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("skill-repo-tracker.sqlite");
        let conn = Connection::open(db_path)?;
        migrate(&conn)?;

        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let default_backup_root = home.join("SkillRepoBackups");
        let default_library_root = default_skill_library_root(&home);
        let legacy_skills_root = get_setting(&conn, "skills_root")?;
        let had_library_setting = get_setting(&conn, "skill_library_root")?.is_some();

        seed_settings(&conn, &home, &default_backup_root, &default_library_root)?;
        migrate_independent_skill_library(
            &conn,
            &home,
            &default_library_root,
            legacy_skills_root.as_deref(),
            had_library_setting,
        )?;
        migrate_local_library_names(&conn)?;

        Ok(Self {
            db: Mutex::new(conn),
            http: reqwest::Client::new(),
            data_dir,
        })
    }

    fn token(&self) -> Option<String> {
        keyring::Entry::new(TOKEN_SERVICE, TOKEN_USER)
            .ok()
            .and_then(|entry| entry.get_password().ok())
            .filter(|token| !token.trim().is_empty())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiRepository {
    id: String,
    name: String,
    #[serde(rename = "type")]
    repo_type: String,
    #[serde(rename = "ref")]
    ref_name: String,
    skills: i64,
    remote_sha: String,
    last_backup_sha: String,
    last_checked: String,
    backup_status: String,
    check_status: String,
    url: String,
    branch: String,
    backup_path: String,
    snapshot_time: String,
    recognized_skills: Vec<RecognizedSkill>,
    source_type: String,
    local_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedSkill {
    id: String,
    name: String,
    path: String,
    version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiSkill {
    id: String,
    repo_id: String,
    name: String,
    description: String,
    repo: String,
    path: String,
    #[serde(rename = "ref")]
    ref_name: String,
    local_version: String,
    remote_version: String,
    status: String,
    installed: bool,
    updated_at: String,
    source_type: String,
    local_path: Option<String>,
    install_path: Option<String>,
    deleted_path: Option<String>,
    sync_targets_mode: String,
    sync_targets: Vec<String>,
    resolved_sync_targets: Vec<String>,
    published_targets: Vec<String>,
    can_restore: bool,
    can_delete: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    id: String,
    name: String,
    description: String,
    repo: String,
    path: String,
    #[serde(rename = "ref")]
    ref_name: String,
    local_version: String,
    remote_version: String,
    status: String,
    source_type: String,
    local_path: Option<String>,
    install_path: Option<String>,
    sync_targets_mode: String,
    sync_targets: Vec<String>,
    resolved_sync_targets: Vec<String>,
    published_targets: Vec<String>,
    skill_md: String,
    file_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryReadme {
    repo_id: String,
    title: String,
    readme: String,
    source_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    id: String,
    name: String,
    app_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncTargetInfo {
    id: String,
    label: String,
    path: String,
    exists: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubPreview {
    url: String,
    title: String,
    owner: String,
    repo: String,
    default_branch: String,
    resolved_ref: String,
    sha: String,
    readme: Option<String>,
    readme_source: Option<String>,
    readme_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiTask {
    id: String,
    kind: String,
    target: String,
    progress: String,
    status: String,
    summary: String,
    log: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    backup_root: String,
    skills_root: String,
    skill_library_root: String,
    default_sync_targets: Vec<String>,
    available_sync_targets: Vec<SyncTargetInfo>,
    sync_backup_keep: i64,
    concurrency: i64,
    retry_count: i64,
    auto_check_interval: i64,
    auto_check_enabled: bool,
    auto_backup_enabled: bool,
    cleanup_keep: i64,
    github_token_configured: bool,
    github_token_status: String,
    github_token_last_verified: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupHistory {
    id: String,
    backup_dir: String,
    manifest_path: String,
    mode: String,
    created_at: String,
    status: String,
    summary: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryRequest {
    url: String,
    #[serde(default = "default_ref")]
    ref_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRepositoriesRequest {
    repo_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRepositoriesRequest {
    mode: String,
    repo_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillActionRequest {
    skill_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryContentRequest {
    repo_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUrlRequest {
    url: String,
    mode: String,
    browser_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPreviewRequest {
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConflictRequest {
    skill_id: String,
    choice: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanLocalSkillsRequest {
    root: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepositoryRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkillRequest {
    skill_id: String,
    mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateDirectoryRequest {
    kind: String,
    path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryValidation {
    kind: String,
    path: String,
    expanded_path: String,
    exists: bool,
    writable: bool,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRequest {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    backup_root: Option<String>,
    skills_root: Option<String>,
    skill_library_root: Option<String>,
    default_sync_targets: Option<Vec<String>>,
    sync_backup_keep: Option<i64>,
    concurrency: Option<i64>,
    retry_count: Option<i64>,
    auto_check_interval: Option<i64>,
    auto_check_enabled: Option<bool>,
    auto_backup_enabled: Option<bool>,
    cleanup_keep: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRequest {
    kind: String,
    enabled: bool,
    interval_minutes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncTargetsRequest {
    skill_id: String,
    mode: String,
    targets: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequest {
    task_id: String,
}

#[derive(Debug)]
struct RepoRecord {
    id: String,
    name: String,
    owner: String,
    repo: String,
    ref_name: String,
    repo_type: String,
    skills_count: i64,
    remote_sha: String,
    last_backup_sha: Option<String>,
    last_checked: Option<String>,
    backup_status: String,
    check_status: String,
    url: String,
    branch: String,
    backup_path: Option<String>,
    snapshot_time: Option<String>,
    source_type: String,
    local_path: Option<String>,
}

#[derive(Debug, Clone)]
struct SkillScan {
    name: String,
    description: String,
    path: String,
    version: String,
}

#[derive(Debug, Clone)]
struct RemoteInfo {
    owner: String,
    repo: String,
    full_name: String,
    default_branch: String,
    resolved_ref: String,
    sha: String,
}

#[derive(Debug, Clone)]
struct SyncTargetSpec {
    id: &'static str,
    label: &'static str,
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct SkillSyncRecord {
    target_id: String,
    target_path: String,
    skill_path: String,
}

#[derive(Debug, Default)]
struct SyncReport {
    success_count: usize,
    failure_count: usize,
    skipped_count: usize,
    log: Vec<String>,
}

fn default_ref() -> String {
    "main".to_string()
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS repositories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner TEXT NOT NULL,
          repo TEXT NOT NULL,
          ref_name TEXT NOT NULL,
          repo_type TEXT NOT NULL,
          skills_count INTEGER NOT NULL DEFAULT 0,
          remote_sha TEXT NOT NULL DEFAULT 'unknown',
          last_backup_sha TEXT,
          last_checked TEXT,
          backup_status TEXT NOT NULL DEFAULT 'never-backed-up',
          check_status TEXT NOT NULL DEFAULT 'unknown',
          url TEXT NOT NULL,
          branch TEXT NOT NULL,
          backup_path TEXT,
          snapshot_time TEXT,
          source_type TEXT NOT NULL DEFAULT 'github',
          local_path TEXT,
          canonical_name TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          repo_name TEXT NOT NULL,
          path TEXT NOT NULL,
          ref_name TEXT NOT NULL,
          local_version TEXT,
          remote_version TEXT NOT NULL,
          status TEXT NOT NULL,
          installed INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT,
          installed_hash TEXT,
          source_type TEXT NOT NULL DEFAULT 'github_repo',
          local_path TEXT,
          install_path TEXT,
          deleted_at TEXT,
          deleted_path TEXT,
          sync_targets_mode TEXT NOT NULL DEFAULT 'inherit',
          sync_targets TEXT,
          FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS skill_sync_records (
          skill_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_path TEXT NOT NULL,
          skill_path TEXT NOT NULL,
          content_hash TEXT,
          synced_at TEXT NOT NULL,
          PRIMARY KEY(skill_id, target_id),
          FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS backup_jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          target TEXT NOT NULL,
          progress TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          backup_dir TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS backup_job_items (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          repo_id TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          status TEXT NOT NULL,
          ref_name TEXT NOT NULL,
          resolved_sha TEXT,
          file_path TEXT,
          size_bytes INTEGER,
          sha256 TEXT,
          error TEXT,
          FOREIGN KEY(job_id) REFERENCES backup_jobs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS task_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          line_no INTEGER NOT NULL,
          line TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS backup_manifests (
          id TEXT PRIMARY KEY,
          backup_dir TEXT NOT NULL,
          manifest_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedules (
          kind TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL,
          interval_minutes INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        "#,
    )?;
    add_column_if_missing(
        conn,
        "repositories",
        "source_type",
        "ALTER TABLE repositories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'github'",
    )?;
    add_column_if_missing(
        conn,
        "repositories",
        "local_path",
        "ALTER TABLE repositories ADD COLUMN local_path TEXT",
    )?;
    add_column_if_missing(
        conn,
        "skills",
        "source_type",
        "ALTER TABLE skills ADD COLUMN source_type TEXT NOT NULL DEFAULT 'github_repo'",
    )?;
    add_column_if_missing(
        conn,
        "skills",
        "local_path",
        "ALTER TABLE skills ADD COLUMN local_path TEXT",
    )?;
    add_column_if_missing(
        conn,
        "skills",
        "install_path",
        "ALTER TABLE skills ADD COLUMN install_path TEXT",
    )?;
    add_column_if_missing(
        conn,
        "skills",
        "deleted_at",
        "ALTER TABLE skills ADD COLUMN deleted_at TEXT",
    )?;
    add_column_if_missing(
        conn,
        "skills",
        "deleted_path",
        "ALTER TABLE skills ADD COLUMN deleted_path TEXT",
    )?;
    add_column_if_missing(
        conn,
        "skills",
        "sync_targets_mode",
        "ALTER TABLE skills ADD COLUMN sync_targets_mode TEXT NOT NULL DEFAULT 'inherit'",
    )?;
    add_column_if_missing(
        conn,
        "skills",
        "sync_targets",
        "ALTER TABLE skills ADD COLUMN sync_targets TEXT",
    )?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), AppError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute(alter_sql, [])?;
    Ok(())
}

fn seed_settings(
    conn: &Connection,
    home: &Path,
    default_backup_root: &Path,
    default_library_root: &Path,
) -> Result<(), AppError> {
    let default_targets = serialize_sync_targets(&existing_sync_target_ids(home));
    let defaults = [
        ("backup_root", path_string(default_backup_root)),
        ("skills_root", path_string(default_library_root)),
        ("skill_library_root", path_string(default_library_root)),
        ("default_sync_targets", default_targets),
        ("sync_backup_keep", DEFAULT_SYNC_BACKUP_KEEP.to_string()),
        ("concurrency", "5".to_string()),
        ("retry_count", "2".to_string()),
        ("auto_check_interval", "60".to_string()),
        ("auto_check_enabled", "false".to_string()),
        ("auto_backup_enabled", "false".to_string()),
        ("cleanup_keep", "20".to_string()),
        ("github_token_configured", "false".to_string()),
        ("github_token_status", "not_configured".to_string()),
    ];

    for (key, value) in defaults {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }

    conn.execute(
        "INSERT OR IGNORE INTO schedules (kind, enabled, interval_minutes, updated_at) VALUES ('check', 0, 60, ?1)",
        params![utc_now()],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO schedules (kind, enabled, interval_minutes, updated_at) VALUES ('backup', 0, 1440, ?1)",
        params![utc_now()],
    )?;
    Ok(())
}

fn migrate_independent_skill_library(
    conn: &Connection,
    _home: &Path,
    default_library_root: &Path,
    legacy_skills_root: Option<&str>,
    had_library_setting: bool,
) -> Result<(), AppError> {
    if had_library_setting {
        if let Some(library_root) = get_setting(conn, "skill_library_root")? {
            set_setting(conn, "skills_root", library_root)?;
        }
        return Ok(());
    }

    let target_root = default_library_root;
    let legacy_source = legacy_skills_root
        .map(expand_tilde)
        .filter(|path| path.exists());

    if let Some(source_root) = legacy_source.as_ref() {
        if source_root != target_root && source_root.is_dir() {
            copy_dir_contents_missing(source_root, target_root)?;
            migrate_installed_skill_paths(conn, source_root, target_root)?;
        }
    }

    set_setting(conn, "skill_library_root", path_string(target_root))?;
    set_setting(conn, "skills_root", path_string(target_root))?;
    Ok(())
}

fn migrate_installed_skill_paths(
    conn: &Connection,
    old_root: &Path,
    new_root: &Path,
) -> Result<(), AppError> {
    let old_root_string = path_string(old_root);
    let mut stmt = conn.prepare("SELECT id, name, install_path FROM skills WHERE installed = 1")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut updates = Vec::new();
    for row in rows {
        let (id, name, install_path) = row?;
        let next_path = match install_path.as_deref() {
            Some(raw_path) => {
                let expanded = expand_tilde(raw_path);
                if let Ok(relative) = expanded.strip_prefix(old_root) {
                    Some(new_root.join(relative))
                } else if raw_path == old_root_string {
                    Some(new_root.join(&name))
                } else {
                    None
                }
            }
            None => Some(new_root.join(&name)),
        };
        if let Some(next_path) = next_path {
            updates.push((id, path_string(&next_path)));
        }
    }
    drop(stmt);
    for (id, path) in updates {
        conn.execute(
            "UPDATE skills SET install_path = ?2 WHERE id = ?1",
            params![id, path],
        )?;
    }
    Ok(())
}

fn migrate_local_library_names(conn: &Connection) -> Result<(), AppError> {
    conn.execute(
        "UPDATE repositories
         SET name = ?1, canonical_name = ?1
         WHERE name = ?2 OR canonical_name = ?2",
        params![LOCAL_SKILLS_LIBRARY_NAME, LEGACY_LOCAL_SKILLS_LIBRARY_NAME],
    )?;
    conn.execute(
        "UPDATE skills
         SET repo_name = ?1
         WHERE repo_name = ?2",
        params![LOCAL_SKILLS_LIBRARY_NAME, LEGACY_LOCAL_SKILLS_LIBRARY_NAME],
    )?;
    Ok(())
}

fn display_local_library_name(value: String) -> String {
    if value == LEGACY_LOCAL_SKILLS_LIBRARY_NAME {
        LOCAL_SKILLS_LIBRARY_NAME.to_string()
    } else {
        value
    }
}

fn utc_now() -> String {
    Utc::now().to_rfc3339()
}

fn local_display(value: Option<&str>) -> String {
    value
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| {
            dt.with_timezone(&Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| value.unwrap_or("Never").to_string())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn default_skill_library_root(home: &Path) -> PathBuf {
    home.join("SkillRepoTracker").join("skills")
}

fn sync_backup_root(home: &Path) -> PathBuf {
    home.join("SkillRepoTracker").join("sync-backups")
}

fn sync_target_specs(home: &Path) -> Vec<SyncTargetSpec> {
    vec![
        SyncTargetSpec {
            id: "claude",
            label: "Claude Code",
            path: home.join(".claude").join("skills"),
        },
        SyncTargetSpec {
            id: "codex",
            label: "Codex",
            path: home.join(".codex").join("skills"),
        },
        SyncTargetSpec {
            id: "gemini",
            label: "Gemini",
            path: home.join(".gemini").join("skills"),
        },
        SyncTargetSpec {
            id: "opencode",
            label: "OpenCode",
            path: home.join(".config").join("opencode").join("skills"),
        },
        SyncTargetSpec {
            id: "openclaw",
            label: "OpenClaw",
            path: home.join(".openclaw").join("skills"),
        },
        SyncTargetSpec {
            id: "hermes",
            label: "Hermes",
            path: home.join(".hermes").join("skills"),
        },
    ]
}

fn sync_target_info(home: &Path) -> Vec<SyncTargetInfo> {
    sync_target_specs(home)
        .into_iter()
        .map(|target| SyncTargetInfo {
            id: target.id.to_string(),
            label: target.label.to_string(),
            path: path_string(&target.path),
            exists: target.path.exists(),
        })
        .collect()
}

fn sync_target_spec(home: &Path, id: &str) -> Option<SyncTargetSpec> {
    sync_target_specs(home)
        .into_iter()
        .find(|target| target.id == id)
}

fn existing_sync_target_ids(home: &Path) -> Vec<String> {
    sync_target_specs(home)
        .into_iter()
        .filter(|target| target.path.exists())
        .map(|target| target.id.to_string())
        .collect()
}

fn normalize_sync_targets(targets: &[String]) -> Vec<String> {
    let requested: HashSet<&str> = targets.iter().map(String::as_str).collect();
    SYNC_TARGET_IDS
        .iter()
        .filter(|id| requested.contains(**id))
        .map(|id| (*id).to_string())
        .collect()
}

fn parse_sync_targets(raw: Option<&str>) -> Vec<String> {
    raw.and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .map(|items| normalize_sync_targets(&items))
        .unwrap_or_default()
}

fn serialize_sync_targets(targets: &[String]) -> String {
    serde_json::to_string(&normalize_sync_targets(targets)).unwrap_or_else(|_| "[]".to_string())
}

fn sync_targets_from_db(conn: &Connection) -> Result<Vec<String>, AppError> {
    Ok(parse_sync_targets(
        get_setting(conn, "default_sync_targets")?.as_deref(),
    ))
}

fn resolve_skill_sync_targets(
    mode: &str,
    custom_targets: &[String],
    default_targets: &[String],
) -> Vec<String> {
    if mode == "custom" {
        normalize_sync_targets(custom_targets)
    } else {
        normalize_sync_targets(default_targets)
    }
}

fn expand_tilde(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest);
    }
    PathBuf::from(value)
}

fn slugify(value: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        "local".into()
    } else {
        slug
    }
}

fn local_repo_id(path: &Path) -> String {
    let digest = sha256_hex(path_string(path).as_bytes());
    format!("local:repo:{}", &digest[..12])
}

fn installed_root_repo_id(path: &Path) -> String {
    let digest = sha256_hex(path_string(path).as_bytes());
    format!("local:installed:{}", &digest[..12])
}

fn format_error_for_log(context: &str, error: &AppError) -> String {
    match &error.details {
        Some(details) => format!(
            "{context} failed: {} [{}] details: {}",
            error.message, error.code, details
        ),
        None => format!("{context} failed: {} [{}]", error.message, error.code),
    }
}

fn validate_directory_path(kind: &str, raw_path: &str) -> DirectoryValidation {
    let expanded = expand_tilde(raw_path);
    let exists = expanded.exists();
    let create_result = fs::create_dir_all(&expanded);
    let writable = create_result
        .as_ref()
        .map(|_| {
            let probe = expanded.join(".skill-repo-tracker-write-test");
            fs::write(&probe, b"ok")
                .and_then(|_| fs::remove_file(&probe))
                .is_ok()
        })
        .unwrap_or(false);
    let message = match create_result {
        Ok(()) if writable => "目录可用。".to_string(),
        Ok(()) => "目录存在但不可写，请选择其他目录。".to_string(),
        Err(error) => format!("目录不可创建：{error}"),
    };
    DirectoryValidation {
        kind: kind.to_string(),
        path: raw_path.to_string(),
        expanded_path: path_string(&expanded),
        exists,
        writable,
        message,
    }
}

fn parse_bool(value: Option<String>) -> bool {
    matches!(value.as_deref(), Some("true") | Some("1"))
}

fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(AppError::from)
}

fn set_setting(conn: &Connection, key: &str, value: impl ToString) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}

fn settings_from_db(conn: &Connection, token_configured: bool) -> Result<AppSettings, AppError> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let skill_library_root = get_setting(conn, "skill_library_root")?
        .or(get_setting(conn, "skills_root")?)
        .unwrap_or_else(|| path_string(&default_skill_library_root(&home)));
    let default_sync_targets = sync_targets_from_db(conn)?;
    let stored_status = get_setting(conn, "github_token_status")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if token_configured {
                "saved_unverified".to_string()
            } else {
                "not_configured".to_string()
            }
        });
    let token_status = if token_configured {
        stored_status
    } else {
        "not_configured".to_string()
    };
    Ok(AppSettings {
        backup_root: get_setting(conn, "backup_root")?
            .unwrap_or_else(|| "~/SkillRepoBackups".into()),
        skills_root: skill_library_root.clone(),
        skill_library_root,
        default_sync_targets,
        available_sync_targets: sync_target_info(&home),
        sync_backup_keep: get_setting(conn, "sync_backup_keep")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_SYNC_BACKUP_KEEP),
        concurrency: get_setting(conn, "concurrency")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(5),
        retry_count: get_setting(conn, "retry_count")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(2),
        auto_check_interval: get_setting(conn, "auto_check_interval")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(60),
        auto_check_enabled: parse_bool(get_setting(conn, "auto_check_enabled")?),
        auto_backup_enabled: parse_bool(get_setting(conn, "auto_backup_enabled")?),
        cleanup_keep: get_setting(conn, "cleanup_keep")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(20),
        github_token_configured: token_configured,
        github_token_status: token_status,
        github_token_last_verified: get_setting(conn, "github_token_last_verified")?
            .filter(|value| !value.trim().is_empty()),
    })
}

fn parse_repo_input(input: &str) -> Result<(String, String), AppError> {
    let cleaned = input
        .trim()
        .trim_end_matches(".git")
        .trim_start_matches("https://github.com/")
        .trim_start_matches("http://github.com/")
        .trim_start_matches("github.com/");
    let parts: Vec<&str> = cleaned.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return Err(AppError::new(
            "invalid_repository",
            "请输入 GitHub URL 或 owner/repo。",
        ));
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

fn repo_id(owner: &str, repo: &str, ref_name: &str) -> String {
    format!("github:{owner}/{repo}:{ref_name}")
}

fn skill_id(repo_id: &str, path: &str) -> String {
    let encoded = path.replace('/', "__").replace('.', "_");
    format!("{repo_id}:skill:{encoded}")
}

fn repo_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RepoRecord> {
    Ok(RepoRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        owner: row.get("owner")?,
        repo: row.get("repo")?,
        ref_name: row.get("ref_name")?,
        repo_type: row.get("repo_type")?,
        skills_count: row.get("skills_count")?,
        remote_sha: row.get("remote_sha")?,
        last_backup_sha: row.get("last_backup_sha")?,
        last_checked: row.get("last_checked")?,
        backup_status: row.get("backup_status")?,
        check_status: row.get("check_status")?,
        url: row.get("url")?,
        branch: row.get("branch")?,
        backup_path: row.get("backup_path")?,
        snapshot_time: row.get("snapshot_time")?,
        source_type: row.get("source_type")?,
        local_path: row.get("local_path")?,
    })
}

fn load_repositories(conn: &Connection) -> Result<Vec<RepoRecord>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM repositories
         ORDER BY
           CASE backup_status
             WHEN 'updated-not-backed-up' THEN 0
             WHEN 'never-backed-up' THEN 1
             WHEN 'check-failed' THEN 2
             ELSE 3
           END,
           updated_at DESC",
    )?;
    let rows = stmt.query_map([], repo_from_row)?;
    let mut repos = Vec::new();
    for row in rows {
        repos.push(row?);
    }
    Ok(repos)
}

fn load_repository(conn: &Connection, id: &str) -> Result<Option<RepoRecord>, AppError> {
    conn.query_row(
        "SELECT * FROM repositories WHERE id = ?1",
        params![id],
        repo_from_row,
    )
    .optional()
    .map_err(AppError::from)
}

fn should_check_remote_repo(repo: &RepoRecord, selected_ids: Option<&Vec<String>>) -> bool {
    repo.source_type == "github"
        && selected_ids
            .map(|ids| ids.contains(&repo.id))
            .unwrap_or(true)
}

fn recognized_skills(conn: &Connection, repo_id: &str) -> Result<Vec<RecognizedSkill>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, path, remote_version FROM skills
         WHERE repo_id = ?1
           AND deleted_at IS NULL
           AND status != 'source-unavailable'
         ORDER BY name ASC",
    )?;
    let rows = stmt.query_map(params![repo_id], |row| {
        Ok(RecognizedSkill {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            version: row.get(3)?,
        })
    })?;
    let mut skills = Vec::new();
    for row in rows {
        skills.push(row?);
    }
    Ok(skills)
}

fn ui_repository(conn: &Connection, repo: RepoRecord) -> Result<UiRepository, AppError> {
    Ok(UiRepository {
        id: repo.id.clone(),
        name: display_local_library_name(repo.name),
        repo_type: repo.repo_type,
        ref_name: repo.ref_name,
        skills: repo.skills_count,
        remote_sha: repo.remote_sha,
        last_backup_sha: repo.last_backup_sha.unwrap_or_else(|| "none".into()),
        last_checked: local_display(repo.last_checked.as_deref()),
        backup_status: repo.backup_status,
        check_status: repo.check_status,
        url: repo.url,
        branch: repo.branch,
        backup_path: repo
            .backup_path
            .unwrap_or_else(|| "Unavailable".to_string()),
        snapshot_time: local_display(repo.snapshot_time.as_deref()),
        recognized_skills: recognized_skills(conn, &repo.id)?,
        source_type: repo.source_type,
        local_path: repo.local_path,
    })
}

fn load_ui_repositories(conn: &Connection) -> Result<Vec<UiRepository>, AppError> {
    load_repositories(conn)?
        .into_iter()
        .map(|repo| ui_repository(conn, repo))
        .collect()
}

fn load_ui_skills(conn: &Connection) -> Result<Vec<UiSkill>, AppError> {
    let default_sync_targets = sync_targets_from_db(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, repo_id, name, description, repo_name, path, ref_name, local_version,
                remote_version, status, installed, updated_at, source_type, local_path, install_path,
                deleted_at, deleted_path, sync_targets_mode, sync_targets
         FROM skills
         ORDER BY
           CASE WHEN deleted_at IS NOT NULL THEN 5 ELSE 0 END,
           CASE status
             WHEN 'local-modified' THEN 0
             WHEN 'update-available' THEN 1
             WHEN 'source-unavailable' THEN 2
             WHEN 'not-installed' THEN 3
             ELSE 4
           END,
           name ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let installed = row.get::<_, i64>(10)? == 1;
        let deleted_at = row.get::<_, Option<String>>(15)?;
        let deleted_path = row.get::<_, Option<String>>(16)?;
        let sync_targets_mode = row
            .get::<_, Option<String>>(17)?
            .unwrap_or_else(|| "inherit".to_string());
        let sync_targets = parse_sync_targets(row.get::<_, Option<String>>(18)?.as_deref());
        let resolved_sync_targets =
            resolve_skill_sync_targets(&sync_targets_mode, &sync_targets, &default_sync_targets);
        let status = if deleted_at.is_some() {
            "deleted".to_string()
        } else {
            row.get(9)?
        };
        Ok(UiSkill {
            id: row.get(0)?,
            repo_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            repo: display_local_library_name(row.get(4)?),
            path: row.get(5)?,
            ref_name: row.get(6)?,
            local_version: row
                .get::<_, Option<String>>(7)?
                .unwrap_or_else(|| "not installed".into()),
            remote_version: row.get(8)?,
            status,
            installed,
            updated_at: local_display(row.get::<_, Option<String>>(11)?.as_deref()),
            source_type: row.get(12)?,
            local_path: row.get(13)?,
            install_path: row.get(14)?,
            deleted_path: deleted_path.clone(),
            sync_targets_mode,
            sync_targets,
            resolved_sync_targets,
            published_targets: Vec::new(),
            can_restore: deleted_at.is_some() && deleted_path.is_some(),
            can_delete: installed && deleted_at.is_none(),
        })
    })?;

    let mut skills = Vec::new();
    for row in rows {
        skills.push(row?);
    }
    drop(stmt);
    for skill in &mut skills {
        skill.published_targets = published_target_ids(conn, &skill.id)?;
    }
    Ok(skills)
}

fn load_ui_tasks(conn: &Connection) -> Result<Vec<UiTask>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, target, progress, status, summary
         FROM backup_jobs
         ORDER BY created_at DESC
         LIMIT 100",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;

    let mut tasks = Vec::new();
    for row in rows {
        let (id, kind, target, progress, status, summary) = row?;
        let log = load_task_log(conn, &id)?;
        tasks.push(UiTask {
            id,
            kind,
            target,
            progress,
            status,
            summary,
            log,
        });
    }
    Ok(tasks)
}

fn load_task_log(conn: &Connection, task_id: &str) -> Result<Vec<String>, AppError> {
    let mut stmt =
        conn.prepare("SELECT line FROM task_logs WHERE task_id = ?1 ORDER BY line_no ASC")?;
    let rows = stmt.query_map(params![task_id], |row| row.get(0))?;
    let mut log = Vec::new();
    for row in rows {
        log.push(row?);
    }
    Ok(log)
}

fn insert_task(
    conn: &Connection,
    id: &str,
    kind: &str,
    target: &str,
    progress: &str,
    status: &str,
    summary: &str,
    backup_dir: Option<&str>,
    log: &[String],
) -> Result<(), AppError> {
    let now = utc_now();
    conn.execute(
        "INSERT OR REPLACE INTO backup_jobs
         (id, kind, target, progress, status, summary, backup_dir, created_at, started_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)",
        params![id, kind, target, progress, status, summary, backup_dir, now],
    )?;
    conn.execute("DELETE FROM task_logs WHERE task_id = ?1", params![id])?;
    for (index, line) in log.iter().enumerate() {
        conn.execute(
            "INSERT INTO task_logs (task_id, line_no, line) VALUES (?1, ?2, ?3)",
            params![id, index as i64 + 1, line],
        )?;
    }
    Ok(())
}

fn insert_failed_task(
    conn: &Connection,
    id_prefix: &str,
    kind: &str,
    target: &str,
    error: &AppError,
    mut log: Vec<String>,
) {
    log.push(format_error_for_log(target, error));
    let _ = insert_task(
        conn,
        &format!("{id_prefix}-{}", Local::now().format("%Y%m%d%H%M%S")),
        kind,
        target,
        "0 / 1",
        "failed",
        &error.message,
        None,
        &log,
    );
}

fn headers(token: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(APP_USER_AGENT));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    if let Some(token) = token {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(AUTHORIZATION, value);
        }
    }
    headers
}

async fn fetch_remote_info(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    ref_name: &str,
    token: Option<&str>,
) -> Result<RemoteInfo, AppError> {
    let repo_url = format!("https://api.github.com/repos/{owner}/{repo}");
    let repo_response = client
        .get(repo_url)
        .headers(headers(token))
        .send()
        .await
        .map_err(|err| {
            AppError::with_details("github_network", "无法访问 GitHub。", err.to_string())
        })?;

    match repo_response.status().as_u16() {
        200 => {}
        401 | 403 => {
            return Err(AppError::new(
                "github_rate_limited",
                "GitHub 拒绝请求，请检查 token 或稍后重试。",
            ));
        }
        404 => {
            return Err(AppError::new(
                "github_not_found",
                "仓库不存在或无访问权限。",
            ))
        }
        status => {
            return Err(AppError::with_details(
                "github_error",
                "GitHub 返回未知错误。",
                status.to_string(),
            ));
        }
    }

    let repo_json: serde_json::Value = repo_response.json().await.map_err(|err| {
        AppError::with_details("github_error", "GitHub 仓库响应解析失败。", err.to_string())
    })?;
    let full_name = repo_json
        .get("full_name")
        .and_then(|value| value.as_str())
        .unwrap_or(&format!("{owner}/{repo}"))
        .to_string();
    let default_branch = repo_json
        .get("default_branch")
        .and_then(|value| value.as_str())
        .unwrap_or("main")
        .to_string();
    let resolved_ref = if ref_name.trim().is_empty() {
        default_branch.clone()
    } else {
        ref_name.to_string()
    };

    let commit_url = format!(
        "https://api.github.com/repos/{owner}/{repo}/commits/{}",
        urlencoding::encode(&resolved_ref)
    );
    let commit_response = client
        .get(commit_url)
        .headers(headers(token))
        .send()
        .await
        .map_err(|err| {
            AppError::with_details("github_network", "无法读取远端提交。", err.to_string())
        })?;
    match commit_response.status().as_u16() {
        200 => {}
        401 | 403 => {
            return Err(AppError::new(
                "github_rate_limited",
                "GitHub 拒绝请求，请检查 token 或稍后重试。",
            ));
        }
        404 => return Err(AppError::new("ref_not_found", "指定 ref 不存在。")),
        status => {
            return Err(AppError::with_details(
                "github_error",
                "GitHub 提交响应异常。",
                status.to_string(),
            ));
        }
    }
    let commit_json: serde_json::Value = commit_response.json().await.map_err(|err| {
        AppError::with_details("github_error", "GitHub 提交响应解析失败。", err.to_string())
    })?;
    let sha = commit_json
        .get("sha")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("github_error", "GitHub 响应缺少 sha。"))?
        .to_string();
    let (canonical_owner, canonical_repo) = full_name
        .split_once('/')
        .map(|(left, right)| (left.to_string(), right.to_string()))
        .unwrap_or_else(|| (owner.to_string(), repo.to_string()));

    Ok(RemoteInfo {
        owner: canonical_owner,
        repo: canonical_repo,
        full_name,
        default_branch,
        resolved_ref,
        sha,
    })
}

async fn download_zip(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    sha: &str,
    token: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/zipball/{sha}");
    let response = client
        .get(url)
        .headers(headers(token))
        .send()
        .await
        .map_err(|err| {
            AppError::with_details("github_network", "源码 ZIP 下载失败。", err.to_string())
        })?;
    if !response.status().is_success() {
        return Err(AppError::with_details(
            "github_error",
            "源码 ZIP 下载失败。",
            response.status().to_string(),
        ));
    }
    let bytes = response.bytes().await.map_err(|err| {
        AppError::with_details("github_network", "源码 ZIP 读取失败。", err.to_string())
    })?;
    if bytes.is_empty() {
        return Err(AppError::new("zip_empty", "ZIP 文件大小为 0。"));
    }
    Ok(bytes.to_vec())
}

fn scan_skills_from_zip(bytes: &[u8], repo_name: &str) -> Result<Vec<SkillScan>, AppError> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader)?;
    let mut skills = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if !file.is_file() {
            continue;
        }
        let raw_name = file.name().to_string();
        if !raw_name.ends_with("SKILL.md") {
            continue;
        }
        let relative = strip_zip_root(&raw_name);
        let skill_path = relative
            .strip_suffix("/SKILL.md")
            .unwrap_or(".")
            .trim_matches('/')
            .to_string();
        let skill_path = if skill_path.is_empty() {
            ".".to_string()
        } else {
            skill_path
        };
        let mut contents = String::new();
        let _ = file.read_to_string(&mut contents);
        let fallback = skill_path
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty() && *value != ".")
            .unwrap_or_else(|| repo_name.rsplit('/').next().unwrap_or(repo_name))
            .to_string();
        let name = extract_markdown_field(&contents, "name")
            .or_else(|| first_heading(&contents))
            .unwrap_or(fallback);
        let description = extract_markdown_field(&contents, "description").unwrap_or_default();
        let version =
            extract_markdown_field(&contents, "version").unwrap_or_else(|| "v0.1.0".into());
        skills.push(SkillScan {
            name,
            description,
            path: skill_path,
            version,
        });
    }
    Ok(skills)
}

fn scan_skills_from_directory(root: &Path, repo_name: &str) -> Result<Vec<SkillScan>, AppError> {
    if !root.exists() {
        return Err(AppError::with_details(
            "directory_not_found",
            "目录不存在。",
            path_string(root),
        ));
    }
    if !root.is_dir() {
        return Err(AppError::with_details(
            "directory_not_found",
            "请选择一个目录。",
            path_string(root),
        ));
    }

    let mut skills = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() || entry.file_name() != "SKILL.md" {
            continue;
        }
        let skill_dir = entry.path().parent().unwrap_or(root);
        let relative = skill_dir
            .strip_prefix(root)
            .unwrap_or(skill_dir)
            .to_string_lossy()
            .trim_matches('/')
            .to_string();
        let skill_path = if relative.is_empty() {
            ".".to_string()
        } else {
            relative
        };
        let contents = fs::read_to_string(entry.path())?;
        let fallback = skill_path
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty() && *value != ".")
            .unwrap_or(repo_name)
            .to_string();
        let name = extract_markdown_field(&contents, "name")
            .or_else(|| first_heading(&contents))
            .unwrap_or(fallback);
        let description = extract_markdown_field(&contents, "description").unwrap_or_default();
        let version =
            extract_markdown_field(&contents, "version").unwrap_or_else(|| "local".into());
        skills.push(SkillScan {
            name,
            description,
            path: skill_path,
            version,
        });
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skills)
}

fn markdown_file_in_dir(dir: &Path, file_name: &str) -> Option<PathBuf> {
    let exact = dir.join(file_name);
    if exact.is_file() {
        return Some(exact);
    }
    let lower = dir.join(file_name.to_ascii_lowercase());
    if lower.is_file() {
        return Some(lower);
    }
    let upper = dir.join(file_name.to_ascii_uppercase());
    if upper.is_file() {
        return Some(upper);
    }
    None
}

fn read_text_preview(path: &Path) -> Result<String, AppError> {
    let contents = fs::read_to_string(path)?;
    Ok(truncate_preview(contents))
}

fn truncate_preview(mut contents: String) -> String {
    if contents.chars().count() <= PREVIEW_MAX_CHARS {
        return contents;
    }
    contents = contents.chars().take(PREVIEW_MAX_CHARS).collect();
    contents.push_str("\n\n[内容过长，已截断预览。]");
    contents
}

fn skill_markdown_path(
    local_path: Option<&str>,
    install_path: Option<&str>,
    deleted_path: Option<&str>,
) -> Option<PathBuf> {
    [install_path, local_path, deleted_path]
        .into_iter()
        .flatten()
        .map(expand_tilde)
        .find_map(|path| {
            if path.is_file() && path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md")
            {
                Some(path)
            } else if path.is_dir() {
                markdown_file_in_dir(&path, "SKILL.md")
            } else {
                None
            }
        })
}

fn local_readme_path(root: &Path) -> Option<PathBuf> {
    ["README.md", "README.markdown", "readme.md", "Readme.md"]
        .into_iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
}

fn github_contents_path(skill_path: &str, file_name: &str) -> String {
    if skill_path == "." || skill_path.trim().is_empty() {
        file_name.to_string()
    } else {
        format!("{}/{}", skill_path.trim_matches('/'), file_name)
    }
}

async fn fetch_github_content(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    ref_name: &str,
    path: Option<&str>,
    readme: bool,
    token: Option<&str>,
) -> Result<(String, String), AppError> {
    let url = if readme {
        format!(
            "https://api.github.com/repos/{owner}/{repo}/readme?ref={}",
            urlencoding::encode(ref_name)
        )
    } else {
        let encoded_path = path
            .unwrap_or("README.md")
            .split('/')
            .map(urlencoding::encode)
            .collect::<Vec<_>>()
            .join("/");
        format!(
            "https://api.github.com/repos/{owner}/{repo}/contents/{encoded_path}?ref={}",
            urlencoding::encode(ref_name)
        )
    };
    let response = client
        .get(url)
        .headers(headers(token))
        .send()
        .await
        .map_err(|err| {
            AppError::with_details("github_network", "无法读取 GitHub 文件。", err.to_string())
        })?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => {
            return Err(AppError::new(
                "github_rate_limited",
                "GitHub 拒绝请求，请检查 token 或稍后重试。",
            ));
        }
        404 => {
            return Err(AppError::new(
                "github_file_not_found",
                "GitHub 仓库中未找到该文件。",
            ));
        }
        status => {
            return Err(AppError::with_details(
                "github_error",
                "GitHub 文件响应异常。",
                status.to_string(),
            ));
        }
    }

    let json: serde_json::Value = response.json().await.map_err(|err| {
        AppError::with_details("github_error", "GitHub 文件响应解析失败。", err.to_string())
    })?;
    let source_path = json
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or(path.unwrap_or("README.md"))
        .to_string();
    let content = json
        .get("content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("github_error", "GitHub 文件响应缺少 content。"))?;
    let normalized = content.lines().collect::<String>();
    let bytes = general_purpose::STANDARD
        .decode(normalized.as_bytes())
        .map_err(|err| {
            AppError::with_details(
                "github_error",
                "GitHub 文件 base64 解码失败。",
                err.to_string(),
            )
        })?;
    let text = String::from_utf8(bytes).map_err(|err| {
        AppError::with_details(
            "github_error",
            "GitHub 文件不是 UTF-8 文本。",
            err.to_string(),
        )
    })?;
    Ok((truncate_preview(text), source_path))
}

fn strip_zip_root(name: &str) -> String {
    name.split_once('/')
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_else(|| name.to_string())
}

fn extract_markdown_field(contents: &str, field: &str) -> Option<String> {
    let prefix = format!("{field}:");
    contents.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix(&prefix)
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
    })
}

fn first_heading(contents: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        line.trim()
            .strip_prefix("# ")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn sync_skills(
    conn: &Connection,
    repo: &RemoteInfo,
    repo_id: &str,
    scans: &[SkillScan],
) -> Result<(), AppError> {
    let now = utc_now();
    let mut seen = Vec::new();
    for scan in scans {
        let id = skill_id(repo_id, &scan.path);
        seen.push(id.clone());
        let existing: Option<(i64, Option<String>, String)> = conn
            .query_row(
                "SELECT installed, installed_hash, status FROM skills WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (installed, installed_hash, status) =
            existing.unwrap_or((0, None, "not-installed".into()));
        let next_status = if installed == 0 {
            "not-installed".to_string()
        } else if status == "local-modified" {
            "local-modified".to_string()
        } else {
            "update-available".to_string()
        };
        conn.execute(
            "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, installed_hash, source_type, local_path, install_path, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'github_repo', NULL, NULL, NULL)
             ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              repo_name = excluded.repo_name,
              ref_name = excluded.ref_name,
              remote_version = excluded.remote_version,
              status = excluded.status,
              source_type = excluded.source_type,
              deleted_at = NULL,
              deleted_path = NULL",
            params![
                id,
                repo_id,
                scan.name,
                scan.description,
                repo.full_name,
                scan.path,
                repo.resolved_ref,
                if installed == 1 { Some(scan.version.as_str()) } else { None },
                scan.version,
                next_status,
                installed,
                if installed == 1 { Some(now.as_str()) } else { None },
                installed_hash
            ],
        )?;
    }

    let mut stmt = conn.prepare("SELECT id FROM skills WHERE repo_id = ?1")?;
    let rows = stmt.query_map(params![repo_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        let existing_id = row?;
        if !seen.contains(&existing_id) {
            conn.execute(
                "UPDATE skills SET status = 'source-unavailable' WHERE id = ?1",
                params![existing_id],
            )?;
        }
    }
    Ok(())
}

fn save_repository(
    conn: &Connection,
    remote: &RemoteInfo,
    scans: &[SkillScan],
) -> Result<String, AppError> {
    let id = repo_id(&remote.owner, &remote.repo, &remote.resolved_ref);
    let now = utc_now();
    let repo_type = if scans.is_empty() {
        "generic repo"
    } else {
        "skill repo"
    };
    let last_backup_sha: Option<String> = conn
        .query_row(
            "SELECT last_backup_sha FROM repositories WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let backup_status = if last_backup_sha.as_deref() == Some(remote.sha.as_str()) {
        "backed-up-latest"
    } else {
        "never-backed-up"
    };

    conn.execute(
        "INSERT INTO repositories
         (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
          last_backup_sha, last_checked, backup_status, check_status, url, branch,
          backup_path, snapshot_time, source_type, local_path, canonical_name, error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'success', ?12, ?13,
                 NULL, NULL, 'github', NULL, ?2, NULL, ?10, ?10)
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          owner = excluded.owner,
          repo = excluded.repo,
          repo_type = excluded.repo_type,
          skills_count = excluded.skills_count,
          remote_sha = excluded.remote_sha,
          last_checked = excluded.last_checked,
          backup_status = CASE
            WHEN repositories.last_backup_sha = excluded.remote_sha THEN 'backed-up-latest'
            ELSE 'updated-not-backed-up'
          END,
          check_status = 'success',
          url = excluded.url,
          branch = excluded.branch,
          source_type = 'github',
          local_path = NULL,
          canonical_name = excluded.canonical_name,
          error = NULL,
          updated_at = excluded.updated_at",
        params![
            id,
            remote.full_name,
            remote.owner,
            remote.repo,
            remote.resolved_ref,
            repo_type,
            scans.len() as i64,
            remote.sha,
            last_backup_sha,
            now,
            backup_status,
            format!("https://github.com/{}", remote.full_name),
            remote.default_branch
        ],
    )?;
    sync_skills(conn, remote, &id, scans)?;
    Ok(id)
}

fn sync_local_skills(
    conn: &Connection,
    repo_id: &str,
    repo_name: &str,
    ref_name: &str,
    root: &Path,
    scans: &[SkillScan],
    source_type: &str,
    installed: bool,
) -> Result<(), AppError> {
    let now = utc_now();
    let mut seen = Vec::new();
    for scan in scans {
        let id = skill_id(repo_id, &scan.path);
        seen.push(id.clone());
        let skill_dir = if scan.path == "." {
            root.to_path_buf()
        } else {
            root.join(&scan.path)
        };
        let installed_hash = if installed {
            Some(hash_directory(&skill_dir)?)
        } else {
            None
        };
        let status = if installed {
            "installed-latest"
        } else {
            "not-installed"
        };
        conn.execute(
            "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, installed_hash, source_type, local_path, install_path, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL)
             ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              repo_name = excluded.repo_name,
              path = excluded.path,
              ref_name = excluded.ref_name,
              local_version = excluded.local_version,
              remote_version = excluded.remote_version,
              status = excluded.status,
              installed = excluded.installed,
              updated_at = excluded.updated_at,
              installed_hash = excluded.installed_hash,
              source_type = excluded.source_type,
              local_path = excluded.local_path,
              install_path = excluded.install_path,
              deleted_at = NULL,
              deleted_path = NULL",
            params![
                id,
                repo_id,
                scan.name,
                scan.description,
                repo_name,
                scan.path,
                ref_name,
                if installed { Some(scan.version.as_str()) } else { None },
                scan.version,
                status,
                if installed { 1 } else { 0 },
                now,
                installed_hash,
                source_type,
                path_string(&skill_dir),
                if installed { Some(path_string(&skill_dir)) } else { None },
            ],
        )?;
    }

    let mut stmt =
        conn.prepare("SELECT id FROM skills WHERE repo_id = ?1 AND deleted_at IS NULL")?;
    let rows = stmt.query_map(params![repo_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        let existing_id = row?;
        if !seen.contains(&existing_id) {
            conn.execute(
                "UPDATE skills SET status = 'source-unavailable' WHERE id = ?1",
                params![existing_id],
            )?;
        }
    }
    Ok(())
}

fn save_local_repository(
    conn: &Connection,
    root: &Path,
    scans: &[SkillScan],
    installed_library: bool,
) -> Result<String, AppError> {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let id = if installed_library {
        installed_root_repo_id(&canonical_root)
    } else {
        local_repo_id(&canonical_root)
    };
    let now = utc_now();
    let name = if installed_library {
        LOCAL_SKILLS_LIBRARY_NAME.to_string()
    } else {
        canonical_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Local Repository")
            .to_string()
    };
    let repo_type = if scans.is_empty() {
        "generic repo"
    } else {
        "skill repo"
    };
    let local_sha = hash_directory(&canonical_root).unwrap_or_else(|_| "local".into());
    conn.execute(
        "INSERT INTO repositories
         (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
          last_backup_sha, last_checked, backup_status, check_status, url, branch,
          backup_path, snapshot_time, source_type, local_path, canonical_name, error, created_at, updated_at)
         VALUES (?1, ?2, 'local', ?3, 'local', ?4, ?5, ?6, NULL, ?7, 'local-only', 'success',
                 ?8, 'local', NULL, NULL, 'local', ?9, ?2, NULL, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          repo_type = excluded.repo_type,
          skills_count = excluded.skills_count,
          remote_sha = excluded.remote_sha,
          last_checked = excluded.last_checked,
          backup_status = 'local-only',
          check_status = 'success',
          url = excluded.url,
          branch = 'local',
          source_type = 'local',
          local_path = excluded.local_path,
          canonical_name = excluded.canonical_name,
          error = NULL,
          updated_at = excluded.updated_at",
        params![
            id,
            name,
            slugify(&name),
            repo_type,
            scans.len() as i64,
            local_sha,
            now,
            format!("file://{}", path_string(&canonical_root)),
            path_string(&canonical_root),
        ],
    )?;
    sync_local_skills(
        conn,
        &id,
        &name,
        "local",
        &canonical_root,
        scans,
        if installed_library {
            "installed_local"
        } else {
            "local_repo"
        },
        installed_library,
    )?;
    Ok(id)
}

fn mark_repo_check_failed(conn: &Connection, id: &str, error: &AppError) -> Result<(), AppError> {
    conn.execute(
        "UPDATE repositories
         SET check_status = 'failed',
             backup_status = 'check-failed',
             error = ?2,
             last_checked = ?3,
             updated_at = ?3
         WHERE id = ?1",
        params![
            id,
            match &error.details {
                Some(details) => format!("{} [{}]: {}", error.message, error.code, details),
                None => format!("{} [{}]", error.message, error.code),
            },
            utc_now()
        ],
    )?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn safe_zip_name(repo_name: &str, ref_name: &str, sha: &str) -> String {
    format!(
        "{}__{}__{}.zip",
        repo_name.replace('/', "__"),
        ref_name.replace('/', "_"),
        &sha[..sha.len().min(7)]
    )
}

fn hash_directory(path: &Path) -> Result<String, AppError> {
    if !path.exists() {
        return Ok("missing".into());
    }
    let mut entries = Vec::new();
    for entry in WalkDir::new(path).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() {
            entries.push(entry.path().to_path_buf());
        }
    }
    entries.sort();
    let mut hasher = Sha256::new();
    for entry in entries {
        if let Ok(relative) = entry.strip_prefix(path) {
            hasher.update(relative.to_string_lossy().as_bytes());
        }
        hasher.update(fs::read(entry)?);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn extract_skill_from_zip(bytes: &[u8], skill_path: &str, dest: &Path) -> Result<(), AppError> {
    let parent = dest.parent().ok_or_else(|| {
        AppError::with_details(
            "filesystem_error",
            "Skill 安装目录缺少父目录。",
            path_string(dest),
        )
    })?;
    fs::create_dir_all(parent)?;
    let temp = unique_temp_path(
        parent,
        dest.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill"),
        "install-tmp",
    );
    remove_path(&temp)?;
    fs::create_dir_all(&temp)?;
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let normalized_skill_path = if skill_path == "." {
        String::new()
    } else {
        format!("{}/", skill_path.trim_matches('/'))
    };
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let relative = strip_zip_root(file.name());
        if !normalized_skill_path.is_empty() && !relative.starts_with(&normalized_skill_path) {
            continue;
        }
        let output_relative = if normalized_skill_path.is_empty() {
            relative
        } else {
            relative
                .strip_prefix(&normalized_skill_path)
                .unwrap_or("")
                .to_string()
        };
        if output_relative.is_empty() {
            continue;
        }
        let output_path = temp.join(output_relative);
        if file.is_dir() {
            fs::create_dir_all(output_path)?;
        } else {
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = fs::File::create(output_path)?;
            std::io::copy(&mut file, &mut output)?;
        }
    }
    remove_path(dest)?;
    match fs::rename(&temp, dest) {
        Ok(()) => {}
        Err(_) => {
            copy_dir_all(&temp, dest)?;
            remove_path(&temp)?;
        }
    }
    Ok(())
}

fn backup_local_skill(
    source: &Path,
    data_dir: &Path,
    skill_name: &str,
) -> Result<Option<PathBuf>, AppError> {
    if !source.exists() {
        return Ok(None);
    }
    let backup_dir = data_dir.join("local-skill-backups").join(format!(
        "{}-{}",
        skill_name,
        Local::now().format("%Y%m%d%H%M%S")
    ));
    copy_dir_all(source, &backup_dir)?;
    Ok(Some(backup_dir))
}

fn move_skill_to_deleted(
    source: &Path,
    data_dir: &Path,
    skill_name: &str,
) -> Result<PathBuf, AppError> {
    let deleted_root = data_dir.join("deleted-skills");
    fs::create_dir_all(&deleted_root)?;
    let deleted_path = deleted_root.join(format!(
        "{}-{}",
        Local::now().format("%Y%m%d%H%M%S"),
        slugify(skill_name)
    ));
    if source.exists() {
        match fs::rename(source, &deleted_path) {
            Ok(()) => {}
            Err(_) => {
                copy_dir_all(source, &deleted_path)?;
                fs::remove_dir_all(source)?;
            }
        }
    }
    Ok(deleted_path)
}

fn copy_dir_all(source: &Path, dest: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dest)?;
    for entry in WalkDir::new(source).into_iter().filter_map(Result::ok) {
        let relative = entry.path().strip_prefix(source).map_err(|err| {
            AppError::with_details("filesystem_error", "复制目录失败。", err.to_string())
        })?;
        let target = dest.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn copy_dir_contents_missing(source: &Path, dest: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dest)?;
    for entry in WalkDir::new(source)
        .min_depth(1)
        .into_iter()
        .filter_map(Result::ok)
    {
        let relative = entry.path().strip_prefix(source).map_err(|err| {
            AppError::with_details("filesystem_error", "复制目录失败。", err.to_string())
        })?;
        let target = dest.join(relative);
        if target.exists() {
            continue;
        }
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn unique_temp_path(parent: &Path, name: &str, suffix: &str) -> PathBuf {
    let timestamp = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_micros() * 1_000);
    parent.join(format!(".{}-{}-{suffix}", slugify(name), timestamp))
}

fn backup_sync_target(
    target_id: &str,
    skill_name: &str,
    source: &Path,
    keep: i64,
) -> Result<Option<PathBuf>, AppError> {
    if !source.exists() {
        return Ok(None);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let skill_slug = slugify(skill_name);
    let timestamp = Local::now().format("%Y%m%d%H%M%S%.3f").to_string();
    let backup_dir = sync_backup_root(&home)
        .join(target_id)
        .join(&skill_slug)
        .join(timestamp);
    if source.is_dir() {
        copy_dir_all(source, &backup_dir)?;
    } else {
        fs::create_dir_all(&backup_dir)?;
        fs::copy(source, backup_dir.join("content"))?;
    }
    let manifest = serde_json::json!({
        "targetId": target_id,
        "skillName": skill_name,
        "sourcePath": path_string(source),
        "backupPath": path_string(&backup_dir),
        "createdAt": utc_now(),
    });
    fs::write(
        backup_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|err| {
            AppError::with_details(
                "json_error",
                "同步备份 manifest 生成失败。",
                err.to_string(),
            )
        })?,
    )?;
    prune_sync_backups(target_id, &skill_slug, keep.max(1) as usize)?;
    Ok(Some(backup_dir))
}

fn prune_sync_backups(target_id: &str, skill_slug: &str, keep: usize) -> Result<(), AppError> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let backup_root = sync_backup_root(&home).join(target_id).join(skill_slug);
    if !backup_root.exists() {
        return Ok(());
    }
    let mut entries = fs::read_dir(&backup_root)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    entries.reverse();
    for entry in entries.into_iter().skip(keep) {
        let _ = fs::remove_dir_all(entry.path());
    }
    Ok(())
}

fn replace_dir_from_source(
    source: &Path,
    dest: &Path,
    target_id: &str,
    skill_name: &str,
    keep: i64,
) -> Result<Option<PathBuf>, AppError> {
    let parent = dest.parent().ok_or_else(|| {
        AppError::with_details(
            "filesystem_error",
            "目标目录缺少父目录。",
            path_string(dest),
        )
    })?;
    fs::create_dir_all(parent)?;
    let temp = unique_temp_path(parent, skill_name, "sync-tmp");
    remove_path(&temp)?;
    copy_dir_all(source, &temp)?;
    let backup = backup_sync_target(target_id, skill_name, dest, keep)?;
    remove_path(dest)?;
    match fs::rename(&temp, dest) {
        Ok(()) => {}
        Err(_) => {
            copy_dir_all(&temp, dest)?;
            remove_path(&temp)?;
        }
    }
    Ok(backup)
}

fn skill_destination(settings: &AppSettings, skill_name: &str) -> PathBuf {
    expand_tilde(&settings.skill_library_root).join(skill_name)
}

fn sync_records_for_skill(
    conn: &Connection,
    skill_id: &str,
) -> Result<Vec<SkillSyncRecord>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT target_id, target_path, skill_path
         FROM skill_sync_records
         WHERE skill_id = ?1
         ORDER BY target_id ASC",
    )?;
    let rows = stmt.query_map(params![skill_id], |row| {
        Ok(SkillSyncRecord {
            target_id: row.get(0)?,
            target_path: row.get(1)?,
            skill_path: row.get(2)?,
        })
    })?;
    let mut records = Vec::new();
    for row in rows {
        records.push(row?);
    }
    Ok(records)
}

fn published_target_ids(conn: &Connection, skill_id: &str) -> Result<Vec<String>, AppError> {
    Ok(sync_records_for_skill(conn, skill_id)?
        .into_iter()
        .map(|record| record.target_id)
        .collect())
}

fn upsert_sync_record(
    conn: &Connection,
    skill_id: &str,
    target_id: &str,
    target_path: &Path,
    skill_path: &Path,
    content_hash: &str,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO skill_sync_records
         (skill_id, target_id, target_path, skill_path, content_hash, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(skill_id, target_id) DO UPDATE SET
          target_path = excluded.target_path,
          skill_path = excluded.skill_path,
          content_hash = excluded.content_hash,
          synced_at = excluded.synced_at",
        params![
            skill_id,
            target_id,
            path_string(target_path),
            path_string(skill_path),
            content_hash,
            utc_now(),
        ],
    )?;
    Ok(())
}

fn delete_sync_record(conn: &Connection, skill_id: &str, target_id: &str) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM skill_sync_records WHERE skill_id = ?1 AND target_id = ?2",
        params![skill_id, target_id],
    )?;
    Ok(())
}

fn reconcile_skill_sync(
    conn: &Connection,
    settings: &AppSettings,
    skill: &SkillRecord,
) -> SyncReport {
    let mut report = SyncReport::default();
    if !skill.installed {
        report.skipped_count += 1;
        report
            .log
            .push(format!("skip {} because it is not installed", skill.name));
        return report;
    }

    let source = skill
        .install_path
        .as_deref()
        .map(expand_tilde)
        .unwrap_or_else(|| skill_destination(settings, &skill.name));
    if !source.is_dir() {
        report.failure_count += 1;
        report.log.push(format!(
            "source missing for {} at {}",
            skill.name,
            path_string(&source)
        ));
        return report;
    }

    let desired_targets = resolve_skill_sync_targets(
        &skill.sync_targets_mode,
        &skill.sync_targets,
        &settings.default_sync_targets,
    );
    let desired_set: HashSet<&str> = desired_targets.iter().map(String::as_str).collect();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let source_hash = match hash_directory(&source) {
        Ok(hash) => hash,
        Err(error) => {
            report.failure_count += 1;
            report.log.push(format_error_for_log(&skill.name, &error));
            return report;
        }
    };

    for target_id in &desired_targets {
        let Some(spec) = sync_target_spec(&home, target_id) else {
            report.failure_count += 1;
            report.log.push(format!("unknown sync target {target_id}"));
            continue;
        };
        let target_path = spec.path.join(&skill.name);
        match replace_dir_from_source(
            &source,
            &target_path,
            spec.id,
            &skill.name,
            settings.sync_backup_keep,
        )
        .and_then(|backup| {
            upsert_sync_record(
                conn,
                &skill.id,
                spec.id,
                &spec.path,
                &target_path,
                &source_hash,
            )?;
            Ok(backup)
        }) {
            Ok(Some(backup)) => {
                report.success_count += 1;
                report.log.push(format!(
                    "sync {} -> {} with backup {}",
                    skill.name,
                    path_string(&target_path),
                    path_string(&backup)
                ));
            }
            Ok(None) => {
                report.success_count += 1;
                report.log.push(format!(
                    "sync {} -> {}",
                    skill.name,
                    path_string(&target_path)
                ));
            }
            Err(error) => {
                report.failure_count += 1;
                report.log.push(format_error_for_log(spec.id, &error));
            }
        }
    }

    let existing_records = match sync_records_for_skill(conn, &skill.id) {
        Ok(records) => records,
        Err(error) => {
            report.failure_count += 1;
            report.log.push(format_error_for_log(&skill.name, &error));
            Vec::new()
        }
    };
    for record in existing_records {
        if desired_set.contains(record.target_id.as_str()) {
            continue;
        }
        let skill_path = expand_tilde(&record.skill_path);
        match backup_sync_target(
            &record.target_id,
            &skill.name,
            &skill_path,
            settings.sync_backup_keep,
        )
        .and_then(|backup| {
            remove_path(&skill_path)?;
            delete_sync_record(conn, &skill.id, &record.target_id)?;
            Ok(backup)
        }) {
            Ok(Some(backup)) => {
                report.success_count += 1;
                report.log.push(format!(
                    "unsync {} from {} ({}) with backup {}",
                    skill.name,
                    record.target_id,
                    record.target_path,
                    path_string(&backup)
                ));
            }
            Ok(None) => {
                report.success_count += 1;
                report.log.push(format!(
                    "unsync {} from {} ({})",
                    skill.name, record.target_id, record.target_path
                ));
            }
            Err(error) => {
                report.failure_count += 1;
                report
                    .log
                    .push(format_error_for_log(&record.target_id, &error));
            }
        }
    }

    if desired_targets.is_empty() && report.success_count == 0 && report.failure_count == 0 {
        report.skipped_count += 1;
        report.log.push(format!(
            "skip {} because no sync targets are selected",
            skill.name
        ));
    }
    report
}

fn remove_all_sync_targets_for_skill(
    conn: &Connection,
    settings: &AppSettings,
    skill: &SkillRecord,
) -> SyncReport {
    let mut report = SyncReport::default();
    let records = match sync_records_for_skill(conn, &skill.id) {
        Ok(records) => records,
        Err(error) => {
            report.failure_count += 1;
            report.log.push(format_error_for_log(&skill.name, &error));
            return report;
        }
    };
    if records.is_empty() {
        report.skipped_count += 1;
        report.log.push(format!(
            "skip {} because it has no published targets",
            skill.name
        ));
        return report;
    }
    for record in records {
        let skill_path = expand_tilde(&record.skill_path);
        match backup_sync_target(
            &record.target_id,
            &skill.name,
            &skill_path,
            settings.sync_backup_keep,
        )
        .and_then(|backup| {
            remove_path(&skill_path)?;
            delete_sync_record(conn, &skill.id, &record.target_id)?;
            Ok(backup)
        }) {
            Ok(Some(backup)) => {
                report.success_count += 1;
                report.log.push(format!(
                    "remove published {} from {} ({}) with backup {}",
                    skill.name,
                    record.target_id,
                    record.target_path,
                    path_string(&backup)
                ));
            }
            Ok(None) => {
                report.success_count += 1;
                report.log.push(format!(
                    "remove published {} from {} ({})",
                    skill.name, record.target_id, record.target_path
                ));
            }
            Err(error) => {
                report.failure_count += 1;
                report
                    .log
                    .push(format_error_for_log(&record.target_id, &error));
            }
        }
    }
    report
}

fn sync_task_status(report: &SyncReport) -> &'static str {
    if report.failure_count == 0 {
        "success"
    } else if report.success_count > 0 || report.skipped_count > 0 {
        "partial-success"
    } else {
        "failed"
    }
}

fn sync_task_summary(report: &SyncReport) -> String {
    match (
        report.success_count,
        report.failure_count,
        report.skipped_count,
    ) {
        (success, 0, skipped) => format!("{success} synced, {skipped} skipped"),
        (success, failed, skipped) => {
            format!("{success} synced, {failed} failed, {skipped} skipped")
        }
    }
}

fn browser_candidates() -> Vec<BrowserInfo> {
    [
        ("safari", "Safari", "Safari"),
        ("chrome", "Google Chrome", "Google Chrome"),
        ("edge", "Microsoft Edge", "Microsoft Edge"),
        ("firefox", "Firefox", "Firefox"),
        ("arc", "Arc", "Arc"),
    ]
    .into_iter()
    .filter_map(|(id, name, app_name)| {
        let app_path = format!("{app_name}.app");
        let home_app = dirs::home_dir()
            .map(|home| home.join("Applications").join(&app_path))
            .unwrap_or_else(|| PathBuf::from("__missing__"));
        let installed = Path::new("/Applications").join(&app_path).exists() || home_app.exists();
        installed.then(|| BrowserInfo {
            id: id.to_string(),
            name: name.to_string(),
            app_name: app_name.to_string(),
        })
    })
    .collect()
}

fn browser_by_id(id: &str) -> Option<BrowserInfo> {
    browser_candidates()
        .into_iter()
        .find(|browser| browser.id == id)
}

fn validate_github_url(url: &str) -> Result<String, AppError> {
    let trimmed = url.trim();
    if trimmed.starts_with("https://github.com/") && !trimmed.contains(char::is_whitespace) {
        Ok(trimmed.to_string())
    } else {
        Err(AppError::new(
            "invalid_url",
            "只支持打开 https://github.com/ 链接。",
        ))
    }
}

#[tauri::command]
fn list_repositories(state: State<'_, AppState>) -> ApiResponse<Vec<UiRepository>> {
    let db = state.db.lock().expect("db mutex poisoned");
    match load_ui_repositories(&db) {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn list_skills(state: State<'_, AppState>) -> ApiResponse<Vec<UiSkill>> {
    let db = state.db.lock().expect("db mutex poisoned");
    match load_ui_skills(&db) {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
async fn get_skill_detail(
    request: SkillActionRequest,
    state: State<'_, AppState>,
) -> CommandResult<SkillDetail> {
    let base = {
        let db = state.db.lock().expect("db mutex poisoned");
        let default_sync_targets = sync_targets_from_db(&db).unwrap_or_default();
        let result = db.query_row(
            "SELECT s.id, s.name, s.description, s.repo_name, s.path, s.ref_name,
                    s.local_version, s.remote_version,
                    CASE WHEN s.deleted_at IS NOT NULL THEN 'deleted' ELSE s.status END AS status,
                    s.source_type, s.local_path, s.install_path, s.deleted_path,
                    s.sync_targets_mode, s.sync_targets,
                    r.owner, r.repo, r.ref_name
             FROM skills s
             LEFT JOIN repositories r ON r.id = s.repo_id
             WHERE s.id = ?1",
            params![request.skill_id],
            |row| {
                let sync_targets_mode = row
                    .get::<_, Option<String>>(13)?
                    .unwrap_or_else(|| "inherit".to_string());
                let sync_targets = parse_sync_targets(row.get::<_, Option<String>>(14)?.as_deref());
                Ok((
                    SkillDetail {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        repo: display_local_library_name(row.get(3)?),
                        path: row.get(4)?,
                        ref_name: row.get(5)?,
                        local_version: row
                            .get::<_, Option<String>>(6)?
                            .unwrap_or_else(|| "not installed".into()),
                        remote_version: row.get(7)?,
                        status: row.get(8)?,
                        source_type: row.get(9)?,
                        local_path: row.get(10)?,
                        install_path: row.get(11)?,
                        sync_targets_mode: sync_targets_mode.clone(),
                        resolved_sync_targets: resolve_skill_sync_targets(
                            &sync_targets_mode,
                            &sync_targets,
                            &default_sync_targets,
                        ),
                        sync_targets,
                        published_targets: Vec::new(),
                        skill_md: String::new(),
                        file_path: None,
                    },
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, Option<String>>(16)?,
                    row.get::<_, Option<String>>(17)?,
                ))
            },
        );
        match result.optional() {
            Ok(Some(mut value)) => {
                value.0.published_targets =
                    published_target_ids(&db, &value.0.id).unwrap_or_default();
                value
            }
            Ok(None) => return Ok(api_err(AppError::new("skill_not_found", "Skill 不存在。"))),
            Err(error) => return Ok(api_err(AppError::from(error))),
        }
    };

    let (mut detail, deleted_path, owner, repo, repo_ref) = base;
    let token = state.token();
    let content_result = if let Some(path) = skill_markdown_path(
        detail.local_path.as_deref(),
        detail.install_path.as_deref(),
        deleted_path.as_deref(),
    ) {
        read_text_preview(&path).map(|text| (text, path_string(&path)))
    } else if detail.source_type == "github_repo" {
        match (owner.as_deref(), repo.as_deref(), repo_ref.as_deref()) {
            (Some(owner), Some(repo), Some(ref_name)) => {
                let path = github_contents_path(&detail.path, "SKILL.md");
                fetch_github_content(
                    &state.http,
                    owner,
                    repo,
                    ref_name,
                    Some(&path),
                    false,
                    token.as_deref(),
                )
                .await
            }
            _ => Err(AppError::new(
                "skill_source_missing",
                "Skill 缺少来源仓库信息。",
            )),
        }
    } else {
        Err(AppError::new(
            "skill_file_missing",
            "未找到 SKILL.md 文件。",
        ))
    };

    match content_result {
        Ok((contents, path)) => {
            detail.skill_md = contents;
            detail.file_path = Some(path);
            Ok(ApiResponse::ok(detail))
        }
        Err(error) => Ok(api_err(error)),
    }
}

#[tauri::command]
async fn get_repository_readme(
    request: RepositoryContentRequest,
    state: State<'_, AppState>,
) -> CommandResult<RepositoryReadme> {
    let repo_record = {
        let db = state.db.lock().expect("db mutex poisoned");
        match load_repository(&db, &request.repo_id) {
            Ok(Some(repo)) => repo,
            Ok(None) => {
                return Ok(api_err(AppError::new(
                    "repository_not_found",
                    "仓库不存在。",
                )))
            }
            Err(error) => return Ok(api_err(error)),
        }
    };

    if repo_record.source_type == "local" {
        let result = repo_record
            .local_path
            .as_deref()
            .map(expand_tilde)
            .ok_or_else(|| AppError::new("repository_path_missing", "本地仓库缺少路径。"))
            .and_then(|root| {
                let path = local_readme_path(&root).ok_or_else(|| {
                    AppError::new("readme_not_found", "本地仓库中未找到 README.md。")
                })?;
                read_text_preview(&path).map(|text| (text, path_string(&path)))
            });
        return match result {
            Ok((readme, source_path)) => Ok(ApiResponse::ok(RepositoryReadme {
                repo_id: repo_record.id,
                title: display_local_library_name(repo_record.name),
                readme,
                source_path,
            })),
            Err(error) => Ok(api_err(error)),
        };
    }

    let token = state.token();
    match fetch_github_content(
        &state.http,
        &repo_record.owner,
        &repo_record.repo,
        &repo_record.ref_name,
        None,
        true,
        token.as_deref(),
    )
    .await
    {
        Ok((readme, source_path)) => Ok(ApiResponse::ok(RepositoryReadme {
            repo_id: repo_record.id,
            title: repo_record.name,
            readme,
            source_path,
        })),
        Err(error) => Ok(api_err(error)),
    }
}

#[tauri::command]
async fn get_github_preview(
    request: GithubPreviewRequest,
    state: State<'_, AppState>,
) -> CommandResult<GithubPreview> {
    let url = match validate_github_url(&request.url) {
        Ok(url) => url,
        Err(error) => return Ok(api_err(error)),
    };
    let (owner, repo) = match parse_repo_input(&url) {
        Ok(value) => value,
        Err(error) => return Ok(api_err(error)),
    };
    let token = state.token();
    let remote = match fetch_remote_info(&state.http, &owner, &repo, "", token.as_deref()).await {
        Ok(remote) => remote,
        Err(error) => return Ok(api_err(error)),
    };
    let readme_result = fetch_github_content(
        &state.http,
        &remote.owner,
        &remote.repo,
        &remote.resolved_ref,
        None,
        true,
        token.as_deref(),
    )
    .await;
    let (readme, readme_source, readme_error) = match readme_result {
        Ok((readme, source)) => (Some(readme), Some(source), None),
        Err(error) => (None, None, Some(error.message)),
    };
    Ok(ApiResponse::ok(GithubPreview {
        url,
        title: remote.full_name.clone(),
        owner: remote.owner,
        repo: remote.repo,
        default_branch: remote.default_branch,
        resolved_ref: remote.resolved_ref,
        sha: remote.sha,
        readme,
        readme_source,
        readme_error,
    }))
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> ApiResponse<Vec<UiTask>> {
    let db = state.db.lock().expect("db mutex poisoned");
    match load_ui_tasks(&db) {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> ApiResponse<AppSettings> {
    let db = state.db.lock().expect("db mutex poisoned");
    match settings_from_db(&db, state.token().is_some()) {
        Ok(settings) => ApiResponse::ok(settings),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn update_settings(
    request: UpdateSettingsRequest,
    state: State<'_, AppState>,
) -> ApiResponse<AppSettings> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<AppSettings, AppError> {
        if let Some(value) = request.backup_root {
            let validation = validate_directory_path("backupRoot", &value);
            if !validation.writable {
                return Err(AppError::with_details(
                    "backup_root_unwritable",
                    "备份目录不可写，请选择其他目录。",
                    validation.message,
                ));
            }
            set_setting(&db, "backup_root", value)?;
        }
        let requested_library_root = request.skill_library_root.or(request.skills_root);
        if let Some(value) = requested_library_root {
            let validation = validate_directory_path("skillLibraryRoot", &value);
            if !validation.writable {
                return Err(AppError::with_details(
                    "skill_library_root_unwritable",
                    "Skill 主库目录不可写，请选择其他目录。",
                    validation.message,
                ));
            }
            set_setting(&db, "skill_library_root", value.clone())?;
            set_setting(&db, "skills_root", value)?;
        }
        if let Some(value) = request.default_sync_targets {
            set_setting(&db, "default_sync_targets", serialize_sync_targets(&value))?;
        }
        if let Some(value) = request.sync_backup_keep {
            set_setting(&db, "sync_backup_keep", value.clamp(1, 50))?;
        }
        if let Some(value) = request.concurrency {
            set_setting(&db, "concurrency", value.clamp(1, 10))?;
        }
        if let Some(value) = request.retry_count {
            set_setting(&db, "retry_count", value.clamp(0, 5))?;
        }
        if let Some(value) = request.auto_check_interval {
            set_setting(&db, "auto_check_interval", value.clamp(15, 1440))?;
        }
        if let Some(value) = request.auto_check_enabled {
            set_setting(&db, "auto_check_enabled", value)?;
        }
        if let Some(value) = request.auto_backup_enabled {
            set_setting(&db, "auto_backup_enabled", value)?;
        }
        if let Some(value) = request.cleanup_keep {
            set_setting(&db, "cleanup_keep", value.clamp(1, 200))?;
        }
        settings_from_db(&db, state.token().is_some())
    })();
    match result {
        Ok(settings) => ApiResponse::ok(settings),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn validate_directory(request: ValidateDirectoryRequest) -> ApiResponse<DirectoryValidation> {
    ApiResponse::ok(validate_directory_path(&request.kind, &request.path))
}

#[tauri::command]
async fn pick_directory(
    app: AppHandle,
    #[allow(non_snake_case)] defaultPath: Option<String>,
) -> ApiResponse<Option<String>> {
    let initial = defaultPath
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(|path| path_string(&expand_tilde(&path)));
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(path) = initial {
            builder = builder.set_directory(path);
        }
        builder.blocking_pick_folder()
    })
    .await
    .map_err(|err| {
        AppError::with_details(
            "directory_picker_failed",
            "弹出目录选择器失败。",
            err.to_string(),
        )
    })
    .and_then(|selected| match selected {
        Some(path) => path
            .into_path()
            .map(|path| Some(path_string(&path)))
            .map_err(|err| {
                AppError::with_details(
                    "directory_picker_failed",
                    "解析选择的目录失败。",
                    err.to_string(),
                )
            }),
        None => Ok(None),
    });
    match result {
        Ok(path) => ApiResponse::ok(path),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
async fn add_repository(
    request: AddRepositoryRequest,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiRepository>> {
    let (owner, repo) = match parse_repo_input(&request.url) {
        Ok(parsed) => parsed,
        Err(error) => return Ok(api_err(error)),
    };
    let token = state.token();
    let remote = match fetch_remote_info(
        &state.http,
        &owner,
        &repo,
        &request.ref_name,
        token.as_deref(),
    )
    .await
    {
        Ok(remote) => remote,
        Err(error) => return Ok(api_err(error)),
    };
    let zip = match download_zip(
        &state.http,
        &remote.owner,
        &remote.repo,
        &remote.sha,
        token.as_deref(),
    )
    .await
    {
        Ok(zip) => zip,
        Err(_) => Vec::new(),
    };
    let scans = scan_skills_from_zip(&zip, &remote.full_name).unwrap_or_default();

    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiRepository>, AppError> {
        let id = save_repository(&db, &remote, &scans)?;
        insert_task(
            &db,
            &format!("scan-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Scan repository",
            &remote.full_name,
            "1 / 1",
            "success",
            if scans.is_empty() {
                "generic repo, 0 Skills"
            } else {
                "Skill recognized"
            },
            None,
            &[
                format!("normalize {}", remote.full_name),
                format!("record remote_head_sha {}", remote.sha),
                if scans.is_empty() {
                    "no SKILL.md found; keep as generic repo".into()
                } else {
                    format!("found {} SKILL.md file(s)", scans.len())
                },
            ],
        )?;
        let _ = id;
        load_ui_repositories(&db)
    })();
    Ok(match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    })
}

#[tauri::command]
async fn check_repositories(
    request: CheckRepositoriesRequest,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiRepository>> {
    let repos = {
        let db = state.db.lock().expect("db mutex poisoned");
        match load_repositories(&db) {
            Ok(items) => items
                .into_iter()
                .filter(|repo| should_check_remote_repo(repo, request.repo_ids.as_ref()))
                .collect::<Vec<_>>(),
            Err(error) => return Ok(api_err(error)),
        }
    };
    let token = state.token();
    let mut log = Vec::new();
    let mut success = 0;
    let mut failed = 0;

    for repo in repos {
        match fetch_remote_info(
            &state.http,
            &repo.owner,
            &repo.repo,
            &repo.ref_name,
            token.as_deref(),
        )
        .await
        {
            Ok(remote) => {
                let zip = download_zip(
                    &state.http,
                    &remote.owner,
                    &remote.repo,
                    &remote.sha,
                    token.as_deref(),
                )
                .await
                .unwrap_or_default();
                let scans = scan_skills_from_zip(&zip, &remote.full_name).unwrap_or_default();
                let db = state.db.lock().expect("db mutex poisoned");
                if let Err(error) = save_repository(&db, &remote, &scans) {
                    log.push(format_error_for_log(&repo.name, &error));
                    failed += 1;
                } else {
                    log.push(format!(
                        "{} remote_head_sha {}",
                        remote.full_name, remote.sha
                    ));
                    success += 1;
                }
            }
            Err(error) => {
                let db = state.db.lock().expect("db mutex poisoned");
                let _ = mark_repo_check_failed(&db, &repo.id, &error);
                log.push(format_error_for_log(&repo.name, &error));
                failed += 1;
            }
        }
    }

    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiRepository>, AppError> {
        insert_task(
            &db,
            &format!("check-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Check remote state",
            "All repositories",
            &format!("{} / {}", success + failed, success + failed),
            if failed > 0 {
                "partial-success"
            } else {
                "success"
            },
            &format!("{success} success, {failed} failed"),
            None,
            &log,
        )?;
        load_ui_repositories(&db)
    })();
    Ok(match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => {
            insert_failed_task(
                &db,
                "check",
                "Check remote state",
                "All repositories",
                &error,
                log,
            );
            api_err(error)
        }
    })
}

#[tauri::command]
async fn backup_repositories(
    request: BackupRepositoriesRequest,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiTask>> {
    let (repos, settings) = {
        let db = state.db.lock().expect("db mutex poisoned");
        let settings = match settings_from_db(&db, state.token().is_some()) {
            Ok(settings) => settings,
            Err(error) => return Ok(api_err(error)),
        };
        let repos = match load_repositories(&db) {
            Ok(items) => items,
            Err(error) => return Ok(api_err(error)),
        };
        let selected = repos
            .into_iter()
            .filter(|repo| repo.source_type == "github")
            .filter(|repo| match request.mode.as_str() {
                "selected" => request
                    .repo_ids
                    .as_ref()
                    .map(|ids| ids.contains(&repo.id))
                    .unwrap_or(false),
                "all" => repo.check_status != "failed",
                _ => {
                    repo.check_status != "failed"
                        && repo.last_backup_sha.as_deref() != Some(repo.remote_sha.as_str())
                }
            })
            .collect::<Vec<_>>();
        (selected, settings)
    };

    if repos.is_empty() {
        return Ok(ApiResponse::ok(Vec::new()));
    }

    let backup_root = expand_tilde(&settings.backup_root);
    if let Err(error) = fs::create_dir_all(&backup_root) {
        return Ok(api_err(AppError::with_details(
            "backup_root_unwritable",
            "备份目录不可写，请选择其他目录。",
            error.to_string(),
        )));
    }
    let backup_id = Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let backup_dir = backup_root.join(&backup_id);
    if let Err(error) = fs::create_dir_all(&backup_dir) {
        return Ok(api_err(AppError::with_details(
            "backup_root_unwritable",
            "无法创建备份目录。",
            error.to_string(),
        )));
    }

    let token = state.token();
    let mut manifest_items = Vec::new();
    let mut manifest_failures = Vec::new();
    let mut log = vec![format!("create {}", path_string(&backup_dir))];
    let mut successful_repo_updates = Vec::new();

    for repo in &repos {
        match fetch_remote_info(
            &state.http,
            &repo.owner,
            &repo.repo,
            &repo.ref_name,
            token.as_deref(),
        )
        .await
        {
            Ok(remote) => match download_zip(
                &state.http,
                &remote.owner,
                &remote.repo,
                &remote.sha,
                token.as_deref(),
            )
            .await
            {
                Ok(bytes) => {
                    let sha256 = sha256_hex(&bytes);
                    let file_name =
                        safe_zip_name(&remote.full_name, &remote.resolved_ref, &remote.sha);
                    let final_path = backup_dir.join(file_name);
                    let partial_path = final_path.with_extension("zip.partial");
                    let write_result = fs::File::create(&partial_path)
                        .and_then(|mut file| file.write_all(&bytes))
                        .and_then(|_| fs::rename(&partial_path, &final_path));
                    match write_result {
                        Ok(()) => {
                            log.push(format!("download {}", path_string(&final_path)));
                            log.push(format!("compute sha256: {sha256}"));
                            manifest_items.push(serde_json::json!({
                                "repo_id": repo.id,
                                "repo": remote.full_name,
                                "ref": remote.resolved_ref,
                                "resolved_sha": remote.sha,
                                "zip_path": path_string(&final_path),
                                "size_bytes": bytes.len(),
                                "sha256": sha256
                            }));
                            successful_repo_updates.push((
                                repo.id.clone(),
                                remote.sha,
                                path_string(&final_path),
                            ));
                        }
                        Err(error) => {
                            let _ = fs::remove_file(&partial_path);
                            manifest_failures.push(serde_json::json!({
                                "repo_id": repo.id,
                                "repo": repo.name,
                                "error": error.to_string()
                            }));
                            log.push(format!("{} write failed: {}", repo.name, error));
                        }
                    }
                }
                Err(error) => {
                    manifest_failures.push(serde_json::json!({
                        "repo_id": repo.id,
                        "repo": repo.name,
                        "error": error.message
                    }));
                    log.push(format!("{} download failed", repo.name));
                }
            },
            Err(error) => {
                manifest_failures.push(serde_json::json!({
                    "repo_id": repo.id,
                    "repo": repo.name,
                    "error": error.message
                }));
                log.push(format!("{} refresh failed", repo.name));
            }
        }
    }

    let manifest_path = backup_dir.join("manifest.json");
    let task_log_path = backup_dir.join("task-log.jsonl");
    let manifest = serde_json::json!({
        "version": "1.0.0",
        "backup_id": backup_id,
        "created_at": utc_now(),
        "mode": request.mode,
        "backup_root": path_string(&backup_root),
        "items": manifest_items,
        "failures": manifest_failures
    });
    let manifest_result = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| {
            AppError::with_details(
                "manifest_write_failed",
                "manifest 序列化失败。",
                err.to_string(),
            )
        })
        .and_then(|bytes| fs::write(&manifest_path, bytes).map_err(AppError::from));
    if let Err(error) = manifest_result {
        let db = state.db.lock().expect("db mutex poisoned");
        insert_failed_task(
            &db,
            "backup",
            "Backup repositories",
            "Updated repositories",
            &error,
            log.clone(),
        );
        return Ok(api_err(error));
    }

    let task_log = log
        .iter()
        .enumerate()
        .map(|(index, line)| serde_json::json!({ "line": index + 1, "message": line }).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    if let Err(error) = fs::write(&task_log_path, task_log) {
        let app_error = AppError::with_details(
            "manifest_write_failed",
            "task-log.jsonl 写入失败。",
            error.to_string(),
        );
        let db = state.db.lock().expect("db mutex poisoned");
        insert_failed_task(
            &db,
            "backup",
            "Backup repositories",
            "Updated repositories",
            &app_error,
            log.clone(),
        );
        return Ok(api_err(app_error));
    }

    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiTask>, AppError> {
        let now = utc_now();
        for (repo_id, sha, path) in &successful_repo_updates {
            db.execute(
                "UPDATE repositories
                 SET last_backup_sha = ?2,
                     backup_status = 'backed-up-latest',
                     backup_path = ?3,
                     snapshot_time = ?4,
                     updated_at = ?4
                 WHERE id = ?1",
                params![repo_id, sha, path, now],
            )?;
        }
        let status = if manifest_failures.is_empty() {
            "success"
        } else if successful_repo_updates.is_empty() {
            "failed"
        } else {
            "partial-success"
        };
        let summary = format!(
            "{} success, {} failed",
            successful_repo_updates.len(),
            manifest_failures.len()
        );
        let job_id = format!("backup-{backup_id}");
        insert_task(
            &db,
            &job_id,
            "Backup repositories",
            "Updated repositories",
            &format!("{} / {}", successful_repo_updates.len(), repos.len()),
            status,
            &summary,
            Some(&path_string(&backup_dir)),
            &log,
        )?;
        db.execute(
            "INSERT INTO backup_manifests (id, backup_dir, manifest_path, created_at, mode, status, summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                backup_id,
                path_string(&backup_dir),
                path_string(&manifest_path),
                now,
                request.mode,
                status,
                summary
            ],
        )?;
        load_ui_tasks(&db)
    })();

    Ok(match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => {
            insert_failed_task(
                &db,
                "backup",
                "Backup repositories",
                "Updated repositories",
                &error,
                log,
            );
            api_err(error)
        }
    })
}

#[tauri::command]
async fn install_skill(
    request: SkillActionRequest,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiSkill>> {
    update_skill_inner(request.skill_id, "install".into(), state).await
}

#[tauri::command]
async fn update_skill(
    request: SkillActionRequest,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiSkill>> {
    update_skill_inner(request.skill_id, "update".into(), state).await
}

async fn update_skill_inner(
    skill_id_value: String,
    mode: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiSkill>> {
    let (skill, repo, settings) = {
        let db = state.db.lock().expect("db mutex poisoned");
        let skill = match load_skill_record(&db, &skill_id_value) {
            Ok(Some(skill)) => skill,
            Ok(None) => return Ok(api_err(AppError::new("skill_not_found", "Skill 不存在。"))),
            Err(error) => return Ok(api_err(error)),
        };
        let repo = match load_repository(&db, &skill.repo_id) {
            Ok(Some(repo)) => repo,
            Ok(None) => {
                return Ok(api_err(AppError::new(
                    "github_not_found",
                    "来源仓库不存在。",
                )))
            }
            Err(error) => return Ok(api_err(error)),
        };
        let settings = match settings_from_db(&db, state.token().is_some()) {
            Ok(settings) => settings,
            Err(error) => return Ok(api_err(error)),
        };
        (skill, repo, settings)
    };

    let dest = skill_destination(&settings, &skill.name);
    if skill.installed && mode == "update" {
        match hash_directory(&dest) {
            Ok(current_hash) if skill.installed_hash.as_deref() != Some(current_hash.as_str()) => {
                let db = state.db.lock().expect("db mutex poisoned");
                let _ = db.execute(
                    "UPDATE skills SET status = 'local-modified' WHERE id = ?1",
                    params![skill.id],
                );
                return Ok(api_err(AppError::new(
                    "local_skill_modified",
                    "本地 Skill 有修改，请先选择处理方式。",
                )));
            }
            Ok(_) => {}
            Err(error) => return Ok(api_err(error)),
        }
    }

    let token = state.token();
    let zip = match download_zip(
        &state.http,
        &repo.owner,
        &repo.repo,
        &repo.remote_sha,
        token.as_deref(),
    )
    .await
    {
        Ok(zip) => zip,
        Err(error) => return Ok(api_err(error)),
    };
    if let Err(error) = extract_skill_from_zip(&zip, &skill.path, &dest) {
        return Ok(api_err(error));
    }
    let hash = match hash_directory(&dest) {
        Ok(hash) => hash,
        Err(error) => return Ok(api_err(error)),
    };

    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiSkill>, AppError> {
        let now = utc_now();
        db.execute(
            "UPDATE skills
                 SET installed = 1,
                     status = 'installed-latest',
                     local_version = remote_version,
                     installed_hash = ?2,
                     updated_at = ?3,
                     install_path = ?4,
                     deleted_at = NULL,
                     deleted_path = NULL
                 WHERE id = ?1",
            params![skill_id_value, hash, now, path_string(&dest)],
        )?;
        let synced_skill = load_skill_record(&db, &skill_id_value)?
            .ok_or_else(|| AppError::new("skill_not_found", "Skill 不存在。"))?;
        let sync_report = reconcile_skill_sync(&db, &settings, &synced_skill);
        let mut task_log = vec![
            format!("download remote Skill directory {}", skill.path),
            format!("replace local files at {}", path_string(&dest)),
            "record installed_skill_hash".into(),
        ];
        task_log.extend(sync_report.log.clone());
        let task_status = sync_task_status(&sync_report);
        let task_summary = if sync_report.failure_count > 0 {
            format!(
                "local Skill updated; sync {}",
                sync_task_summary(&sync_report)
            )
        } else {
            "local Skill updated".to_string()
        };
        insert_task(
            &db,
            &format!("skill-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Update Skill",
            &skill.name,
            &format!(
                "{} / {}",
                sync_report.success_count + 1,
                sync_report.success_count + sync_report.failure_count + 1
            ),
            task_status,
            &task_summary,
            None,
            &task_log,
        )?;
        load_ui_skills(&db)
    })();
    Ok(match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => {
            insert_failed_task(
                &db,
                "skill",
                "Update Skill",
                &skill.name,
                &error,
                vec![format!("target path {}", path_string(&dest))],
            );
            api_err(error)
        }
    })
}

struct SkillRecord {
    id: String,
    repo_id: String,
    name: String,
    path: String,
    installed: bool,
    installed_hash: Option<String>,
    source_type: String,
    install_path: Option<String>,
    sync_targets_mode: String,
    sync_targets: Vec<String>,
}

fn load_skill_record(conn: &Connection, id: &str) -> Result<Option<SkillRecord>, AppError> {
    conn.query_row(
        "SELECT id, repo_id, name, path, installed, installed_hash, source_type, install_path,
                sync_targets_mode, sync_targets
         FROM skills WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok(SkillRecord {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                installed: row.get::<_, i64>(4)? == 1,
                installed_hash: row.get(5)?,
                source_type: row.get(6)?,
                install_path: row.get(7)?,
                sync_targets_mode: row
                    .get::<_, Option<String>>(8)?
                    .unwrap_or_else(|| "inherit".to_string()),
                sync_targets: parse_sync_targets(row.get::<_, Option<String>>(9)?.as_deref()),
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

#[tauri::command]
async fn resolve_skill_local_conflict(
    request: SkillConflictRequest,
    state: State<'_, AppState>,
) -> CommandResult<Vec<UiSkill>> {
    if request.choice == "skip" {
        let db = state.db.lock().expect("db mutex poisoned");
        let result = (|| -> Result<Vec<UiSkill>, AppError> {
            db.execute(
                "UPDATE skills SET status = 'local-modified' WHERE id = ?1",
                params![request.skill_id],
            )?;
            insert_task(
                &db,
                &format!("skill-{}", Local::now().format("%Y%m%d%H%M%S")),
                "Update Skill",
                "Local modified Skill",
                "0 / 1",
                "failed",
                "skipped to preserve local modifications",
                None,
                &[
                    "local hash differs from installed_skill_hash".into(),
                    "user chose skip update".into(),
                ],
            )?;
            load_ui_skills(&db)
        })();
        return Ok(match result {
            Ok(items) => ApiResponse::ok(items),
            Err(error) => api_err(error),
        });
    }

    if request.choice == "backup" {
        let (skill, settings) = {
            let db = state.db.lock().expect("db mutex poisoned");
            let skill = match load_skill_record(&db, &request.skill_id) {
                Ok(Some(skill)) => skill,
                Ok(None) => return Ok(api_err(AppError::new("skill_not_found", "Skill 不存在。"))),
                Err(error) => return Ok(api_err(error)),
            };
            let settings = match settings_from_db(&db, state.token().is_some()) {
                Ok(settings) => settings,
                Err(error) => return Ok(api_err(error)),
            };
            (skill, settings)
        };
        let dest = skill_destination(&settings, &skill.name);
        if let Err(error) = backup_local_skill(&dest, &state.data_dir, &skill.name) {
            return Ok(api_err(error));
        }
    }

    update_skill_inner(request.skill_id, "force".into(), state).await
}

#[tauri::command]
fn scan_local_skills(
    request: ScanLocalSkillsRequest,
    state: State<'_, AppState>,
) -> ApiResponse<Vec<UiSkill>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiSkill>, AppError> {
        let settings = settings_from_db(&db, state.token().is_some())?;
        let root = request
            .root
            .as_deref()
            .map(expand_tilde)
            .unwrap_or_else(|| expand_tilde(&settings.skills_root));
        let validation = validate_directory_path("skillsRoot", &path_string(&root));
        if !validation.writable {
            return Err(AppError::with_details(
                "skills_root_unwritable",
                "Skill 主库目录不可用，请重新选择。",
                validation.message,
            ));
        }
        let scans = scan_skills_from_directory(&root, "Local Skills")?;
        save_local_repository(&db, &root, &scans, true)?;
        insert_task(
            &db,
            &format!("local-scan-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Scan local Skills",
            &path_string(&root),
            &format!("{} / {}", scans.len(), scans.len()),
            "success",
            &format!("{} local Skills scanned", scans.len()),
            None,
            &[
                format!("scan {}", path_string(&root)),
                format!("found {} SKILL.md file(s)", scans.len()),
            ],
        )?;
        load_ui_skills(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn add_local_repository(
    request: LocalRepositoryRequest,
    state: State<'_, AppState>,
) -> ApiResponse<Vec<UiRepository>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiRepository>, AppError> {
        let root = expand_tilde(&request.path);
        if !root.is_dir() {
            return Err(AppError::with_details(
                "local_repository_unreadable",
                "本地仓库目录不可用。",
                path_string(&root),
            ));
        }
        let validation = validate_directory_path("localRepository", &request.path);
        if !validation.writable {
            return Err(AppError::with_details(
                "local_repository_unreadable",
                "本地仓库目录不可用。",
                validation.message,
            ));
        }
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Local Repository")
            .to_string();
        let scans = scan_skills_from_directory(&root, &name)?;
        save_local_repository(&db, &root, &scans, false)?;
        insert_task(
            &db,
            &format!("local-repo-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Scan local repository",
            &path_string(&root),
            &format!("{} / {}", scans.len(), scans.len()),
            "success",
            if scans.is_empty() {
                "generic local repo, 0 Skills"
            } else {
                "local Skill recognized"
            },
            None,
            &[
                format!("scan local repository {}", path_string(&root)),
                format!("found {} SKILL.md file(s)", scans.len()),
            ],
        )?;
        load_ui_repositories(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn delete_skill(
    request: DeleteSkillRequest,
    state: State<'_, AppState>,
) -> ApiResponse<Vec<UiSkill>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let requested_skill_id = request.skill_id.clone();
    let result = (|| -> Result<Vec<UiSkill>, AppError> {
        if request.mode != "backup_then_remove" {
            return Err(AppError::new(
                "unsupported_delete_mode",
                "仅支持备份后删除。",
            ));
        }
        let skill = load_skill_record(&db, &request.skill_id)?
            .ok_or_else(|| AppError::new("skill_not_found", "Skill 不存在。"))?;
        if !skill.installed {
            return Err(AppError::new(
                "skill_not_installed",
                "只有已安装 Skill 支持删除。",
            ));
        }
        let settings = settings_from_db(&db, state.token().is_some())?;
        let source = skill
            .install_path
            .as_deref()
            .map(expand_tilde)
            .unwrap_or_else(|| skill_destination(&settings, &skill.name));
        let sync_report = remove_all_sync_targets_for_skill(&db, &settings, &skill);
        let deleted_path = move_skill_to_deleted(&source, &state.data_dir, &skill.name)?;
        let now = utc_now();
        if skill.source_type == "installed_local" {
            db.execute(
                "UPDATE skills
                 SET deleted_at = ?2,
                     deleted_path = ?3,
                     installed = 0,
                     status = 'source-unavailable',
                     updated_at = ?2
                 WHERE id = ?1",
                params![skill.id, now, path_string(&deleted_path)],
            )?;
        } else {
            db.execute(
                "UPDATE skills
                 SET installed = 0,
                     status = 'not-installed',
                     local_version = NULL,
                     installed_hash = NULL,
                     install_path = NULL,
                     deleted_at = NULL,
                     updated_at = ?2
                 WHERE id = ?1",
                params![skill.id, now],
            )?;
        }
        let mut task_log = vec![format!(
            "move {} -> {}",
            path_string(&source),
            path_string(&deleted_path)
        )];
        task_log.extend(sync_report.log.clone());
        task_log.push("delete mode backup_then_remove".into());
        insert_task(
            &db,
            &format!("delete-skill-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Delete Skill",
            &skill.name,
            &format!(
                "{} / {}",
                sync_report.success_count + 1,
                sync_report.success_count + sync_report.failure_count + 1
            ),
            sync_task_status(&sync_report),
            if sync_report.failure_count > 0 {
                "local Skill moved to deleted-skills; sync cleanup partial"
            } else {
                "local Skill moved to deleted-skills"
            },
            None,
            &task_log,
        )?;
        load_ui_skills(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => {
            insert_failed_task(
                &db,
                "delete-skill",
                "Delete Skill",
                &requested_skill_id,
                &error,
                Vec::new(),
            );
            api_err(error)
        }
    }
}

#[tauri::command]
fn restore_skill(
    request: SkillActionRequest,
    state: State<'_, AppState>,
) -> ApiResponse<Vec<UiSkill>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let requested_skill_id = request.skill_id.clone();
    let result = (|| -> Result<Vec<UiSkill>, AppError> {
        let (id, name, install_path, deleted_path) = db
            .query_row(
                "SELECT id, name, install_path, deleted_path
                 FROM skills
                 WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![request.skill_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::new("skill_not_deleted", "未找到可恢复的 Skill。"))?;
        let destination = install_path
            .as_deref()
            .map(expand_tilde)
            .ok_or_else(|| AppError::new("restore_target_missing", "缺少原安装路径。"))?;
        let source = deleted_path
            .as_deref()
            .map(expand_tilde)
            .ok_or_else(|| AppError::new("deleted_skill_missing", "缺少已删除备份路径。"))?;
        if !source.is_dir() {
            return Err(AppError::with_details(
                "deleted_skill_missing",
                "已删除 Skill 备份目录不存在。",
                path_string(&source),
            ));
        }
        if destination.exists() {
            return Err(AppError::with_details(
                "local_skill_modified",
                "原安装路径已存在，未执行恢复。",
                path_string(&destination),
            ));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::rename(&source, &destination) {
            Ok(()) => {}
            Err(_) => {
                copy_dir_all(&source, &destination)?;
                fs::remove_dir_all(&source)?;
            }
        }
        let hash = hash_directory(&destination)?;
        let now = utc_now();
        db.execute(
            "UPDATE skills
             SET installed = 1,
                 status = 'installed-latest',
                 local_version = remote_version,
                 installed_hash = ?2,
                 deleted_at = NULL,
                 deleted_path = NULL,
                 updated_at = ?3
             WHERE id = ?1",
            params![id, hash, now],
        )?;
        let settings = settings_from_db(&db, state.token().is_some())?;
        let restored_skill = load_skill_record(&db, &id)?
            .ok_or_else(|| AppError::new("skill_not_found", "Skill 不存在。"))?;
        let sync_report = reconcile_skill_sync(&db, &settings, &restored_skill);
        let mut task_log = vec![
            format!(
                "restore {} -> {}",
                path_string(&source),
                path_string(&destination)
            ),
            "clear deleted_at".into(),
        ];
        task_log.extend(sync_report.log.clone());
        insert_task(
            &db,
            &format!("restore-skill-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Restore Skill",
            &name,
            &format!(
                "{} / {}",
                sync_report.success_count + 1,
                sync_report.success_count + sync_report.failure_count + 1
            ),
            sync_task_status(&sync_report),
            if sync_report.failure_count > 0 {
                "local Skill restored; sync partial"
            } else {
                "local Skill restored"
            },
            None,
            &task_log,
        )?;
        load_ui_skills(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => {
            insert_failed_task(
                &db,
                "restore-skill",
                "Restore Skill",
                &requested_skill_id,
                &error,
                Vec::new(),
            );
            api_err(error)
        }
    }
}

#[tauri::command]
fn sync_installed_skills(state: State<'_, AppState>) -> ApiResponse<Vec<UiSkill>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiSkill>, AppError> {
        let settings = settings_from_db(&db, state.token().is_some())?;
        let mut stmt =
            db.prepare("SELECT id FROM skills WHERE installed = 1 AND deleted_at IS NULL")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut aggregate = SyncReport::default();
        for id in ids {
            let Some(skill) = load_skill_record(&db, &id)? else {
                continue;
            };
            let report = reconcile_skill_sync(&db, &settings, &skill);
            aggregate.success_count += report.success_count;
            aggregate.failure_count += report.failure_count;
            aggregate.skipped_count += report.skipped_count;
            aggregate.log.extend(report.log);
        }
        insert_task(
            &db,
            &format!("sync-skills-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Sync installed Skills",
            "Installed Skills",
            &format!(
                "{} / {}",
                aggregate.success_count,
                aggregate.success_count + aggregate.failure_count + aggregate.skipped_count
            ),
            sync_task_status(&aggregate),
            &sync_task_summary(&aggregate),
            None,
            &aggregate.log,
        )?;
        load_ui_skills(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn update_skill_sync_targets(
    request: SkillSyncTargetsRequest,
    state: State<'_, AppState>,
) -> ApiResponse<Vec<UiSkill>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let requested_skill_id = request.skill_id.clone();
    let result = (|| -> Result<Vec<UiSkill>, AppError> {
        let mode = if request.mode == "custom" {
            "custom"
        } else {
            "inherit"
        };
        let targets = normalize_sync_targets(&request.targets);
        db.execute(
            "UPDATE skills
             SET sync_targets_mode = ?2,
                 sync_targets = ?3,
                 updated_at = ?4
             WHERE id = ?1",
            params![
                request.skill_id,
                mode,
                serialize_sync_targets(&targets),
                utc_now()
            ],
        )?;
        let settings = settings_from_db(&db, state.token().is_some())?;
        let skill = load_skill_record(&db, &requested_skill_id)?
            .ok_or_else(|| AppError::new("skill_not_found", "Skill 不存在。"))?;
        let report = reconcile_skill_sync(&db, &settings, &skill);
        insert_task(
            &db,
            &format!("sync-targets-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Update Skill sync targets",
            &skill.name,
            &format!(
                "{} / {}",
                report.success_count,
                report.success_count + report.failure_count + report.skipped_count
            ),
            sync_task_status(&report),
            &sync_task_summary(&report),
            None,
            &report.log,
        )?;
        load_ui_skills(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn remove_repository(id: String, state: State<'_, AppState>) -> ApiResponse<Vec<UiRepository>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiRepository>, AppError> {
        db.execute("DELETE FROM repositories WHERE id = ?1", params![id])?;
        load_ui_repositories(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn retry_task(request: TaskRequest, state: State<'_, AppState>) -> ApiResponse<Vec<UiTask>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiTask>, AppError> {
        insert_task(
            &db,
            &format!("retry-{}", Local::now().format("%Y%m%d%H%M%S")),
            "Retry task",
            &request.task_id,
            "1 / 1",
            "success",
            "retry completed",
            None,
            &[
                "retry failed item".into(),
                "complete without changing unrelated state".into(),
            ],
        )?;
        load_ui_tasks(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn cancel_task(request: TaskRequest, state: State<'_, AppState>) -> ApiResponse<Vec<UiTask>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<UiTask>, AppError> {
        db.execute(
            "UPDATE backup_jobs SET status = 'interrupted', summary = 'cancelled by user' WHERE id = ?1",
            params![request.task_id],
        )?;
        load_ui_tasks(&db)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn copy_task_summary(request: TaskRequest, state: State<'_, AppState>) -> ApiResponse<String> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result: Result<String, AppError> = db
        .query_row(
            "SELECT kind || ': ' || summary FROM backup_jobs WHERE id = ?1",
            params![request.task_id],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or_else(|| "Task not found".into()))
        .map_err(AppError::from);
    match result {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn set_github_token(request: TokenRequest, state: State<'_, AppState>) -> ApiResponse<AppSettings> {
    let result = keyring::Entry::new(TOKEN_SERVICE, TOKEN_USER)
        .map_err(|err| {
            AppError::with_details(
                "token_store_failed",
                "Token 存储初始化失败。",
                err.to_string(),
            )
        })
        .and_then(|entry| {
            entry.set_password(&request.token).map_err(|err| {
                AppError::with_details("token_store_failed", "Token 存储失败。", err.to_string())
            })
        });
    if let Err(error) = result {
        return api_err(error);
    }

    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<AppSettings, AppError> {
        set_setting(&db, "github_token_configured", "true")?;
        set_setting(&db, "github_token_status", "saved_unverified")?;
        set_setting(&db, "github_token_last_verified", "")?;
        settings_from_db(&db, true)
    })();
    match result {
        Ok(settings) => ApiResponse::ok(settings),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn clear_github_token(state: State<'_, AppState>) -> ApiResponse<AppSettings> {
    if let Ok(entry) = keyring::Entry::new(TOKEN_SERVICE, TOKEN_USER) {
        let _ = entry.delete_credential();
    }
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<AppSettings, AppError> {
        set_setting(&db, "github_token_configured", "false")?;
        set_setting(&db, "github_token_status", "not_configured")?;
        set_setting(&db, "github_token_last_verified", "")?;
        settings_from_db(&db, false)
    })();
    match result {
        Ok(settings) => ApiResponse::ok(settings),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
async fn validate_github_token(state: State<'_, AppState>) -> CommandResult<AppSettings> {
    let token = match state.token() {
        Some(token) => token,
        None => {
            return Ok(api_err(AppError::new(
                "token_missing",
                "尚未配置 GitHub token。",
            )))
        }
    };
    let response = state
        .http
        .get("https://api.github.com/user")
        .headers(headers(Some(&token)))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            let db = state.db.lock().expect("db mutex poisoned");
            let result = (|| -> Result<AppSettings, AppError> {
                set_setting(&db, "github_token_configured", "true")?;
                set_setting(&db, "github_token_status", "verified")?;
                set_setting(&db, "github_token_last_verified", utc_now())?;
                settings_from_db(&db, true)
            })();
            Ok(match result {
                Ok(settings) => ApiResponse::ok(settings),
                Err(error) => api_err(error),
            })
        }
        Ok(response) => {
            let db = state.db.lock().expect("db mutex poisoned");
            let status = if matches!(response.status().as_u16(), 401 | 403) {
                "invalid"
            } else {
                "saved_unverified"
            };
            let _ = set_setting(&db, "github_token_status", status);
            Ok(api_err(AppError::with_details(
                "token_invalid",
                "GitHub token 验证失败。",
                response.status().to_string(),
            )))
        }
        Err(error) => {
            let db = state.db.lock().expect("db mutex poisoned");
            let _ = set_setting(&db, "github_token_status", "saved_unverified");
            Ok(api_err(AppError::with_details(
                "github_network",
                "无法验证 GitHub token。",
                error.to_string(),
            )))
        }
    }
}

#[tauri::command]
fn list_backup_history(state: State<'_, AppState>) -> ApiResponse<Vec<BackupHistory>> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<Vec<BackupHistory>, AppError> {
        let mut stmt = db.prepare(
            "SELECT id, backup_dir, manifest_path, created_at, mode, status, summary
             FROM backup_manifests ORDER BY created_at DESC LIMIT 100",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(BackupHistory {
                id: row.get(0)?,
                backup_dir: row.get(1)?,
                manifest_path: row.get(2)?,
                created_at: local_display(row.get::<_, Option<String>>(3)?.as_deref()),
                mode: row.get(4)?,
                status: row.get(5)?,
                summary: row.get(6)?,
            })
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    })();
    match result {
        Ok(items) => ApiResponse::ok(items),
        Err(error) => api_err(error),
    }
}

#[tauri::command]
fn open_backup_folder(path: Option<String>, state: State<'_, AppState>) -> ApiResponse<String> {
    let target = match path {
        Some(path) => expand_tilde(&path),
        None => {
            let db = state.db.lock().expect("db mutex poisoned");
            let settings = match settings_from_db(&db, state.token().is_some()) {
                Ok(settings) => settings,
                Err(error) => return api_err(error),
            };
            expand_tilde(&settings.backup_root)
        }
    };
    match opener::open(&target) {
        Ok(()) => ApiResponse::ok(path_string(&target)),
        Err(error) => api_err(AppError::with_details(
            "open_folder_failed",
            "无法打开目录。",
            error.to_string(),
        )),
    }
}

#[tauri::command]
fn list_system_browsers() -> ApiResponse<Vec<BrowserInfo>> {
    ApiResponse::ok(browser_candidates())
}

#[tauri::command]
fn open_url(request: OpenUrlRequest, _app: tauri::AppHandle) -> ApiResponse<String> {
    let url = match validate_github_url(&request.url) {
        Ok(url) => url,
        Err(error) => return api_err(error),
    };

    match request.mode.as_str() {
        "embedded" => ApiResponse::ok(url),
        "systemDefault" => match opener::open(&url) {
            Ok(()) => ApiResponse::ok(url),
            Err(error) => api_err(AppError::with_details(
                "open_url_failed",
                "无法使用系统浏览器打开链接。",
                error.to_string(),
            )),
        },
        "browserApp" => {
            let Some(browser_id) = request.browser_id.as_deref() else {
                return api_err(AppError::new("browser_missing", "请选择浏览器。"));
            };
            let Some(browser) = browser_by_id(browser_id) else {
                return api_err(AppError::new("browser_missing", "未找到该浏览器。"));
            };
            match Command::new("open")
                .arg("-a")
                .arg(&browser.app_name)
                .arg(&url)
                .status()
            {
                Ok(status) if status.success() => ApiResponse::ok(url),
                Ok(status) => api_err(AppError::with_details(
                    "open_url_failed",
                    "浏览器打开失败。",
                    status.to_string(),
                )),
                Err(error) => api_err(AppError::with_details(
                    "open_url_failed",
                    "无法调用浏览器。",
                    error.to_string(),
                )),
            }
        }
        _ => api_err(AppError::new("invalid_open_mode", "不支持的打开方式。")),
    }
}

#[tauri::command]
fn configure_schedule(
    request: ScheduleRequest,
    state: State<'_, AppState>,
) -> ApiResponse<AppSettings> {
    let db = state.db.lock().expect("db mutex poisoned");
    let result = (|| -> Result<AppSettings, AppError> {
        db.execute(
            "INSERT INTO schedules (kind, enabled, interval_minutes, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind) DO UPDATE SET
              enabled = excluded.enabled,
              interval_minutes = excluded.interval_minutes,
              updated_at = excluded.updated_at",
            params![
                request.kind,
                if request.enabled { 1 } else { 0 },
                request.interval_minutes.clamp(15, 10080),
                utc_now()
            ],
        )?;
        match request.kind.as_str() {
            "check" => {
                set_setting(&db, "auto_check_enabled", request.enabled)?;
                set_setting(&db, "auto_check_interval", request.interval_minutes)?;
            }
            "backup" => {
                set_setting(&db, "auto_backup_enabled", request.enabled)?;
            }
            _ => {}
        }
        settings_from_db(&db, state.token().is_some())
    })();
    match result {
        Ok(settings) => ApiResponse::ok(settings),
        Err(error) => api_err(error),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|err| tauri::Error::Anyhow(anyhow::anyhow!(err)))?;
            let state = AppState::new(data_dir)
                .map_err(|err| tauri::Error::Anyhow(anyhow::anyhow!(err.message)))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_repositories,
            add_repository,
            check_repositories,
            backup_repositories,
            remove_repository,
            list_skills,
            get_skill_detail,
            get_repository_readme,
            get_github_preview,
            scan_local_skills,
            install_skill,
            update_skill,
            resolve_skill_local_conflict,
            add_local_repository,
            delete_skill,
            restore_skill,
            sync_installed_skills,
            update_skill_sync_targets,
            list_tasks,
            retry_task,
            cancel_task,
            copy_task_summary,
            get_settings,
            update_settings,
            validate_directory,
            pick_directory,
            set_github_token,
            clear_github_token,
            validate_github_token,
            list_backup_history,
            open_backup_folder,
            open_url,
            list_system_browsers,
            configure_schedule
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skill Repo Tracker");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_github_urls() {
        let parsed = parse_repo_input("https://github.com/openai/openai-cookbook.git").unwrap();
        assert_eq!(
            parsed,
            ("openai".to_string(), "openai-cookbook".to_string())
        );
    }

    #[test]
    fn builds_repo_id_from_ref() {
        assert_eq!(
            repo_id("openai", "openai-cookbook", "main"),
            "github:openai/openai-cookbook:main"
        );
    }

    #[test]
    fn hashes_empty_missing_directory_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("none");
        assert_eq!(hash_directory(&missing).unwrap(), "missing");
    }

    #[test]
    fn strips_zip_root() {
        assert_eq!(
            strip_zip_root("owner-repo-sha/skills/demo/SKILL.md"),
            "skills/demo/SKILL.md"
        );
    }

    #[test]
    fn extracts_markdown_metadata() {
        let contents = "---\nname: demo-skill\ndescription: Demo skill\n---";
        assert_eq!(
            extract_markdown_field(contents, "name"),
            Some("demo-skill".to_string())
        );
        assert_eq!(
            extract_markdown_field(contents, "description"),
            Some("Demo skill".to_string())
        );
    }

    #[test]
    fn uses_skill_repo_tracker_default_library_root() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            default_skill_library_root(home.path()),
            home.path().join("SkillRepoTracker").join("skills")
        );
    }

    #[test]
    fn seeds_library_and_existing_sync_targets() {
        let home = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let backup_root = home.path().join("SkillRepoBackups");
        let library_root = home.path().join("SkillRepoTracker").join("skills");
        fs::create_dir_all(home.path().join(".codex").join("skills")).unwrap();

        seed_settings(&conn, home.path(), &backup_root, &library_root).unwrap();

        assert_eq!(
            get_setting(&conn, "skill_library_root").unwrap(),
            Some(path_string(&library_root))
        );
        assert_eq!(
            sync_targets_from_db(&conn).unwrap(),
            vec!["codex".to_string()]
        );
    }

    fn repo_record_with_source(source_type: &str) -> RepoRecord {
        RepoRecord {
            id: format!("{source_type}:repo"),
            name: LOCAL_SKILLS_LIBRARY_NAME.into(),
            owner: "local".into(),
            repo: "skills".into(),
            ref_name: "local".into(),
            repo_type: "skill".into(),
            skills_count: 0,
            remote_sha: "local".into(),
            last_backup_sha: None,
            last_checked: None,
            backup_status: "local-only".into(),
            check_status: "success".into(),
            url: "file:///tmp/skills".into(),
            branch: "local".into(),
            backup_path: None,
            snapshot_time: None,
            source_type: source_type.into(),
            local_path: Some("/tmp/skills".into()),
        }
    }

    #[test]
    fn remote_check_skips_local_repositories() {
        let local_repo = repo_record_with_source("local");
        let github_repo = repo_record_with_source("github");

        assert!(!should_check_remote_repo(&local_repo, None));
        assert!(should_check_remote_repo(&github_repo, None));

        let selected = vec![local_repo.id.clone(), github_repo.id.clone()];
        assert!(!should_check_remote_repo(&local_repo, Some(&selected)));
        assert!(should_check_remote_repo(&github_repo, Some(&selected)));
    }

    #[test]
    fn copies_legacy_skills_root_to_independent_library() {
        let home = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let backup_root = home.path().join("SkillRepoBackups");
        let legacy_root = home.path().join(".codex").join("skills");
        let target_root = home.path().join("SkillRepoTracker").join("skills");
        let legacy_skill = legacy_root.join("demo-skill");
        fs::create_dir_all(&legacy_skill).unwrap();
        fs::write(legacy_skill.join("SKILL.md"), "name: demo-skill").unwrap();
        seed_settings(&conn, home.path(), &backup_root, &target_root).unwrap();
        set_setting(&conn, "skills_root", path_string(&legacy_root)).unwrap();
        conn.execute(
            "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
              backup_status, check_status, url, branch, source_type, created_at, updated_at)
             VALUES ('local:installed:test', 'Local Skills Library', 'local', 'skills', 'local',
              'skill repo', 1, 'local', 'local-only', 'success', 'file:///tmp/skills',
              'local', 'local', ?1, ?1)",
            params![utc_now()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, source_type, install_path)
             VALUES ('skill-1', 'local:installed:test', 'demo-skill', '', 'Local Skills Library',
              'demo-skill', 'local', 'local', 'local', 'installed-latest', 1, ?1,
              'installed_local', ?2)",
            params![utc_now(), path_string(&legacy_skill)],
        )
        .unwrap();

        migrate_independent_skill_library(
            &conn,
            home.path(),
            &target_root,
            Some(&path_string(&legacy_root)),
            false,
        )
        .unwrap();

        assert_eq!(
            get_setting(&conn, "skill_library_root").unwrap(),
            Some(path_string(&target_root))
        );
        assert!(legacy_skill.exists());
        assert!(target_root.join("demo-skill").join("SKILL.md").exists());
        let expected_install_path = path_string(&target_root.join("demo-skill"));
        assert_eq!(
            load_ui_skills(&conn).unwrap()[0].install_path.as_deref(),
            Some(expected_install_path.as_str())
        );
    }

    #[test]
    fn keeps_existing_library_setting_during_migration() {
        let home = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let existing_library = home.path().join("ExistingLibrary");
        set_setting(&conn, "skill_library_root", path_string(&existing_library)).unwrap();

        migrate_independent_skill_library(
            &conn,
            home.path(),
            &home.path().join("SkillRepoTracker").join("skills"),
            Some(&path_string(&home.path().join("LegacySkills"))),
            true,
        )
        .unwrap();

        assert_eq!(
            get_setting(&conn, "skill_library_root").unwrap(),
            Some(path_string(&existing_library))
        );
    }

    #[test]
    fn validates_and_creates_writable_directory() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("backup-root");
        let validation = validate_directory_path("backupRoot", &path_string(&target));
        assert!(validation.writable);
        assert!(target.is_dir());
    }

    #[test]
    fn scans_local_skill_directories() {
        let root = tempfile::tempdir().unwrap();
        let skill_dir = root.path().join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo-skill\ndescription: Local demo\nversion: v1.2.3\n---",
        )
        .unwrap();
        let scans = scan_skills_from_directory(root.path(), "Local Skills").unwrap();
        assert_eq!(scans.len(), 1);
        assert_eq!(scans[0].name, "demo-skill");
        assert_eq!(scans[0].path, "demo-skill");
        assert_eq!(scans[0].version, "v1.2.3");
    }

    #[test]
    fn saves_installed_local_skills_as_deletable() {
        let root = tempfile::tempdir().unwrap();
        let skill_dir = root.path().join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "name: demo-skill").unwrap();
        let scans = scan_skills_from_directory(root.path(), "Local Skills").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        save_local_repository(&conn, root.path(), &scans, true).unwrap();
        let skills = load_ui_skills(&conn).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].source_type, "installed_local");
        assert!(skills[0].installed);
        assert!(skills[0].can_delete);
        let expected_install_path = path_string(&skill_dir.canonicalize().unwrap());
        assert_eq!(
            skills[0].install_path.as_deref(),
            Some(expected_install_path.as_str())
        );
    }

    #[test]
    fn recognized_skills_excludes_stale_skills_after_rescan() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let remote = RemoteInfo {
            owner: "example-org".into(),
            repo: "icon-generator-skill".into(),
            full_name: "example-org/icon-generator-skill".into(),
            default_branch: "main".into(),
            resolved_ref: "main".into(),
            sha: "bf4e9ac4d4428bda261afcfe981871ceb92d94e6".into(),
        };
        let initial_scans = vec![
            SkillScan {
                name: "stale-example-skill".into(),
                description: "stale duplicate from previous scan".into(),
                path: "skills/stale-example-skill".into(),
                version: "0.2.0".into(),
            },
            SkillScan {
                name: "icon-generator".into(),
                description: "current skill".into(),
                path: ".".into(),
                version: "v0.1.0".into(),
            },
        ];
        let current_scans = vec![SkillScan {
            name: "icon-generator".into(),
            description: "current skill".into(),
            path: ".".into(),
            version: "v0.1.0".into(),
        }];

        save_repository(&conn, &remote, &initial_scans).unwrap();
        save_repository(&conn, &remote, &current_scans).unwrap();

        let repos = load_ui_repositories(&conn).unwrap();
        let repo = repos
            .iter()
            .find(|item| item.id == repo_id("example-org", "icon-generator-skill", "main"))
            .unwrap();
        assert_eq!(repo.skills, 1);
        assert_eq!(repo.recognized_skills.len(), 1);
        assert_eq!(repo.recognized_skills[0].name, "icon-generator");
        assert_eq!(repo.recognized_skills[0].path, ".");

        let skills = load_ui_skills(&conn).unwrap();
        assert!(skills.iter().any(
            |skill| skill.name == "stale-example-skill" && skill.status == "source-unavailable"
        ));
    }

    #[test]
    fn moves_deleted_skill_to_app_data_backup() {
        let source_root = tempfile::tempdir().unwrap();
        let data_root = tempfile::tempdir().unwrap();
        let skill_dir = source_root.path().join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "name: demo-skill").unwrap();
        let deleted_path =
            move_skill_to_deleted(&skill_dir, data_root.path(), "demo-skill").unwrap();
        assert!(!skill_dir.exists());
        assert!(deleted_path.join("SKILL.md").exists());
        assert!(deleted_path.starts_with(data_root.path().join("deleted-skills")));
    }

    #[test]
    fn resolves_inherited_and_custom_sync_targets() {
        let defaults = vec!["codex".to_string(), "gemini".to_string()];
        let custom = vec!["claude".to_string(), "unknown".to_string()];

        assert_eq!(
            resolve_skill_sync_targets("inherit", &custom, &defaults),
            defaults
        );
        assert_eq!(
            resolve_skill_sync_targets("custom", &custom, &defaults),
            vec!["claude".to_string()]
        );
        assert!(resolve_skill_sync_targets("custom", &[], &defaults).is_empty());
    }

    #[test]
    fn replace_dir_from_source_copies_complete_target() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let dest = root.path().join("target").join("demo-skill");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("SKILL.md"), "name: demo-skill").unwrap();
        fs::write(source.join("nested").join("notes.md"), "ok").unwrap();

        let backup = replace_dir_from_source(&source, &dest, "codex", "demo-skill", 5).unwrap();

        assert!(backup.is_none());
        assert!(dest.join("SKILL.md").exists());
        assert!(dest.join("nested").join("notes.md").exists());
    }

    #[test]
    fn deleted_local_skill_is_returned_as_restorable() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let now = utc_now();
        conn.execute(
            "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
              backup_status, check_status, url, branch, source_type, created_at, updated_at)
             VALUES ('local:installed:test', 'Local Skills Library', 'local', 'skills', 'local',
              'skill repo', 1, 'local', 'local-only', 'success', 'file:///tmp/skills',
              'local', 'local', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, source_type, install_path,
             deleted_at, deleted_path)
             VALUES ('skill-1', 'local:installed:test', 'demo-skill', '', 'Local Skills Library',
              'demo-skill', 'local', 'local', 'local', 'source-unavailable', 0, ?1,
              'installed_local', '/tmp/skills/demo-skill', ?1, '/tmp/deleted/demo-skill')",
            params![now],
        )
        .unwrap();

        let skills = load_ui_skills(&conn).unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].status, "deleted");
        assert!(skills[0].can_restore);
        assert!(!skills[0].can_delete);
        assert_eq!(
            skills[0].deleted_path.as_deref(),
            Some("/tmp/deleted/demo-skill")
        );
    }

    #[test]
    fn migrates_local_library_display_names() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let now = utc_now();
        conn.execute(
            "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
              backup_status, check_status, url, branch, source_type, canonical_name, created_at, updated_at)
             VALUES ('local:installed:test', 'Local Skills Library', 'local', 'skills', 'local',
              'skill repo', 1, 'local', 'local-only', 'success', 'file:///tmp/skills',
              'local', 'local', 'Local Skills Library', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, source_type)
             VALUES ('skill-1', 'local:installed:test', 'demo-skill', '', 'Local Skills Library',
              'demo-skill', 'local', 'local', 'local', 'installed-latest', 1, ?1,
              'installed_local')",
            params![now],
        )
        .unwrap();

        migrate_local_library_names(&conn).unwrap();
        let repos = load_ui_repositories(&conn).unwrap();
        let skills = load_ui_skills(&conn).unwrap();

        assert_eq!(repos[0].name, LOCAL_SKILLS_LIBRARY_NAME);
        assert_eq!(skills[0].repo, LOCAL_SKILLS_LIBRARY_NAME);
    }

    #[test]
    fn finds_local_skill_markdown_file() {
        let root = tempfile::tempdir().unwrap();
        let skill_dir = root.path().join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "name: demo-skill").unwrap();

        let path = skill_markdown_path(None, Some(&path_string(&skill_dir)), None).unwrap();

        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("SKILL.md")
        );
    }

    #[test]
    fn validates_only_github_https_urls() {
        assert!(validate_github_url("https://github.com/openai/openai-cookbook").is_ok());
        assert!(validate_github_url("http://github.com/openai/openai-cookbook").is_err());
        assert!(validate_github_url("https://example.com/openai/openai-cookbook").is_err());
    }

    #[test]
    fn sqlite_details_are_kept_for_task_logs() {
        let error = AppError::with_details(
            "sqlite_error",
            "SQLite 操作失败。",
            "UNIQUE constraint failed",
        );
        let line = format_error_for_log("NVIDIA/SkillSpector", &error);
        assert!(line.contains("sqlite_error"));
        assert!(line.contains("UNIQUE constraint failed"));
    }

    #[test]
    fn migration_adds_local_source_columns() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(skills)").unwrap();
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.contains(&"source_type".to_string()));
        assert!(columns.contains(&"install_path".to_string()));
        assert!(columns.contains(&"deleted_at".to_string()));
        assert!(columns.contains(&"deleted_path".to_string()));
        assert!(columns.contains(&"sync_targets_mode".to_string()));
        assert!(columns.contains(&"sync_targets".to_string()));

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_sync_records'")
            .unwrap();
        let table_name: Option<String> = stmt.query_row([], |row| row.get(0)).optional().unwrap();
        assert_eq!(table_name.as_deref(), Some("skill_sync_records"));
    }
}
