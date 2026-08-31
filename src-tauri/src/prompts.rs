use chrono::{DateTime, Local, SecondsFormat, Utc};
use rusqlite::{
    params, params_from_iter, types::Value, Connection, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use unicode_normalization::UnicodeNormalization;

use crate::{temp_artifacts::unique_operation_id, AppError};

pub const PROMPT_CONTENT_MAX_BYTES: usize = 5_242_880;
pub const PROMPT_TITLE_MAX_CHARS: usize = 200;
pub const PROMPT_TAG_MAX_CHARS: usize = 50;
pub const PROMPT_MAX_TAGS: usize = 20;
pub const PROMPT_SCHEMA_USER_VERSION: i64 = 3;

const DEFAULT_PAGE_SIZE: u32 = 30;
const ALLOWED_PAGE_SIZES: [u32; 3] = [30, 50, 100];
const EXCERPT_MAX_CHARS: usize = 720;
const MANUAL_ORDER_STRIDE: i64 = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptTag {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub prompt_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptSummary {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub tags: Vec<PromptTag>,
    pub pinned: bool,
    pub content_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptDetail {
    #[serde(flatten)]
    pub summary: PromptSummary,
    pub content: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PromptTagMode {
    All,
    #[default]
    Any,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PromptSort {
    #[default]
    Manual,
    UpdatedDesc,
}

fn default_page() -> u32 {
    1
}

fn default_page_size() -> u32 {
    DEFAULT_PAGE_SIZE
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptListRequest {
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub tag_mode: PromptTagMode,
    #[serde(default)]
    pub sort: PromptSort,
}

impl Default for PromptListRequest {
    fn default() -> Self {
        Self {
            page: 1,
            page_size: DEFAULT_PAGE_SIZE,
            query: String::new(),
            tag_ids: Vec::new(),
            tag_mode: PromptTagMode::Any,
            sort: PromptSort::Manual,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptPage {
    pub items: Vec<PromptSummary>,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
    pub total_pages: u32,
    pub library_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptCreateInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptUpdateInput {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptReorderInput {
    pub id: String,
    #[serde(default)]
    pub previous_id: Option<String>,
    #[serde(default)]
    pub next_id: Option<String>,
    #[serde(default)]
    pub boundary: Option<PromptReorderBoundary>,
    pub expected_revision: i64,
    pub expected_library_revision: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PromptReorderBoundary {
    First,
    Last,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptReorderResult {
    pub library_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptFilter {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub tag_mode: PromptTagMode,
    #[serde(default)]
    pub sort: PromptSort,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PromptSelection {
    Explicit {
        ids: Vec<String>,
    },
    Filter {
        filter: PromptFilter,
        #[serde(default)]
        excluded_ids: Vec<String>,
        expected_library_revision: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptExportArtifact {
    pub path: String,
    pub file_name: String,
    pub item_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalizedTagName {
    pub display: String,
    pub key: String,
}

pub(crate) fn normalize_tag_name(value: &str) -> Result<NormalizedTagName, AppError> {
    let display = value.trim().nfc().collect::<String>();
    if display.is_empty() {
        return Err(AppError::new(
            "prompt_tag_name_required",
            "标签名称不能为空。",
        ));
    }
    if display.chars().count() > PROMPT_TAG_MAX_CHARS {
        return Err(AppError::new(
            "prompt_tag_name_too_long",
            "标签名称不能超过 50 个字符。",
        ));
    }
    let key = display.to_lowercase().nfc().collect::<String>();
    Ok(NormalizedTagName { display, key })
}

pub(crate) fn validate_prompt_title(value: &str) -> Result<String, AppError> {
    let title = value.trim().nfc().collect::<String>();
    if title.is_empty() {
        return Err(AppError::new(
            "prompt_title_required",
            "提示词标题不能为空。",
        ));
    }
    if title.chars().count() > PROMPT_TITLE_MAX_CHARS {
        return Err(AppError::new(
            "prompt_title_too_long",
            "提示词标题不能超过 200 个字符。",
        ));
    }
    Ok(title)
}

pub(crate) fn validate_prompt_content(value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::new(
            "prompt_content_required",
            "提示词正文不能为空。",
        ));
    }
    if value.len() > PROMPT_CONTENT_MAX_BYTES {
        return Err(AppError::new(
            "prompt_content_too_large",
            "提示词正文不能超过 5 MiB（5,242,880 UTF-8 bytes）。",
        ));
    }
    Ok(())
}

fn validate_public_id(value: &str) -> Result<(), AppError> {
    let valid = !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(AppError::new(
            "prompt_id_invalid",
            "提示词 ID 只能包含英文字母、数字、连字符和下划线。",
        ))
    }
}

fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn make_public_id(prefix: &str) -> String {
    unique_operation_id(prefix).replace('_', "-")
}

fn sqlite_integrity_error(message: impl Into<String>) -> AppError {
    AppError::new("prompt_schema_integrity_failed", message)
}

/// Installs the prompt schema, indexes, FTS table, triggers and first rebuild as one transaction.
/// This intentionally uses `unchecked_transaction` so the caller can keep the established shared
/// `&Connection` contract while still receiving all-or-nothing migration behavior.
pub(crate) fn migrate_prompt_library(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    )?;
    let previous_user_version =
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    let fts_existed = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM sqlite_master WHERE name = 'prompt_fts' AND type = 'table'
         )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    let needs_first_rebuild = previous_user_version < PROMPT_SCHEMA_USER_VERSION || !fts_existed;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS prompts (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
          manual_order INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (length(title) BETWEEN 1 AND 200),
          CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 5242880)
        );

        CREATE TABLE IF NOT EXISTS prompt_tags (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (length(name) BETWEEN 1 AND 50)
        );

        CREATE TABLE IF NOT EXISTS prompt_tag_links (
          prompt_row_id INTEGER NOT NULL,
          tag_row_id INTEGER NOT NULL,
          PRIMARY KEY (prompt_row_id, tag_row_id),
          FOREIGN KEY (prompt_row_id) REFERENCES prompts(row_id) ON DELETE CASCADE,
          FOREIGN KEY (tag_row_id) REFERENCES prompt_tags(row_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS prompt_library_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          library_revision INTEGER NOT NULL DEFAULT 0 CHECK (library_revision >= 0)
        );

        INSERT OR IGNORE INTO prompt_library_meta(id, library_revision) VALUES(1, 0);

        CREATE INDEX IF NOT EXISTS prompts_sort_idx
          ON prompts(pinned DESC, updated_at DESC, id ASC);
        CREATE INDEX IF NOT EXISTS prompt_tag_links_tag_idx
          ON prompt_tag_links(tag_row_id, prompt_row_id);
        CREATE INDEX IF NOT EXISTS prompt_tag_links_prompt_idx
          ON prompt_tag_links(prompt_row_id, tag_row_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS prompt_fts USING fts5(
          title,
          content,
          content='prompts',
          content_rowid='row_id',
          tokenize='trigram'
        );

        CREATE TRIGGER IF NOT EXISTS prompts_fts_ai AFTER INSERT ON prompts BEGIN
          INSERT INTO prompt_fts(rowid, title, content)
          VALUES (new.row_id, new.title, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS prompts_fts_ad AFTER DELETE ON prompts BEGIN
          INSERT INTO prompt_fts(prompt_fts, rowid, title, content)
          VALUES ('delete', old.row_id, old.title, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS prompts_fts_au AFTER UPDATE OF title, content ON prompts BEGIN
          INSERT INTO prompt_fts(prompt_fts, rowid, title, content)
          VALUES ('delete', old.row_id, old.title, old.content);
          INSERT INTO prompt_fts(rowid, title, content)
          VALUES (new.row_id, new.title, new.content);
        END;
        "#,
    )?;
    let has_manual_order = {
        let mut statement = tx.prepare("PRAGMA table_info(prompts)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<HashSet<_>, _>>()?
            .contains("manual_order")
    };
    if !has_manual_order {
        tx.execute_batch(
            "ALTER TABLE prompts ADD COLUMN manual_order INTEGER NOT NULL DEFAULT 0;",
        )?;
        tx.execute(
            "WITH ranked AS (
               SELECT row_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY pinned ORDER BY updated_at DESC, id ASC
                      ) AS position
               FROM prompts
             )
             UPDATE prompts
             SET manual_order = (
               SELECT position * ?1 FROM ranked WHERE ranked.row_id = prompts.row_id
             )",
            [MANUAL_ORDER_STRIDE],
        )?;
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS prompts_manual_sort_idx
           ON prompts(pinned DESC, manual_order ASC, id ASC);",
    )?;
    if needs_first_rebuild {
        tx.execute("INSERT INTO prompt_fts(prompt_fts) VALUES('rebuild')", [])?;
    }
    let target_user_version = previous_user_version.max(PROMPT_SCHEMA_USER_VERSION);
    tx.execute_batch(&format!("PRAGMA user_version = {target_user_version};"))?;
    validate_prompt_schema_tx(&tx)?;
    prompt_fts_integrity_check_tx(&tx)?;
    tx.commit()?;
    Ok(())
}

fn validate_prompt_schema_tx(tx: &Transaction<'_>) -> Result<(), AppError> {
    let expected = [
        (
            "prompts",
            &[
                "row_id",
                "id",
                "title",
                "content",
                "excerpt",
                "pinned",
                "manual_order",
                "revision",
                "created_at",
                "updated_at",
            ][..],
        ),
        (
            "prompt_tags",
            &[
                "row_id",
                "id",
                "name",
                "normalized_name",
                "created_at",
                "updated_at",
            ][..],
        ),
        ("prompt_tag_links", &["prompt_row_id", "tag_row_id"][..]),
        ("prompt_library_meta", &["id", "library_revision"][..]),
    ];
    for (table, required_columns) in expected {
        let sql = format!("PRAGMA table_info({table})");
        let columns = {
            let mut statement = tx.prepare(&sql)?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            rows.collect::<Result<HashSet<_>, _>>()?
        };
        for required in required_columns {
            if !columns.contains(*required) {
                return Err(AppError::with_details(
                    "prompt_schema_incompatible",
                    "现有数据库中的提示词表结构不兼容，迁移已回滚。",
                    format!("table={table}, missing_column={required}"),
                ));
            }
        }
    }
    Ok(())
}

fn prompt_fts_integrity_check_tx(tx: &Transaction<'_>) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO prompt_fts(prompt_fts) VALUES('integrity-check')",
        [],
    )
    .map(|_| ())
    .map_err(|error| {
        AppError::with_details(
            "prompt_fts_integrity_failed",
            "提示词全文索引完整性检查失败。",
            error.to_string(),
        )
    })
}

#[cfg(test)]
pub(crate) fn prompt_fts_integrity_check(conn: &Connection) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO prompt_fts(prompt_fts) VALUES('integrity-check')",
        [],
    )
    .map(|_| ())
    .map_err(|error| {
        AppError::with_details(
            "prompt_fts_integrity_failed",
            "提示词全文索引完整性检查失败。",
            error.to_string(),
        )
    })
}

/// Opens a WAL-friendly read-only connection. Callers may keep its interrupt handle and invoke it
/// when a newer debounced search supersedes a running query.
pub(crate) fn open_prompt_read_connection(path: &Path) -> Result<Connection, AppError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(1))?;
    conn.execute_batch("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

pub(crate) fn library_revision(conn: &Connection) -> Result<i64, AppError> {
    conn.query_row(
        "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .map_err(AppError::from)
}

pub(crate) fn bump_library_revision(tx: &Transaction<'_>) -> Result<i64, AppError> {
    let changed = tx.execute(
        "UPDATE prompt_library_meta SET library_revision = library_revision + 1 WHERE id = 1",
        [],
    )?;
    if changed != 1 {
        return Err(sqlite_integrity_error(
            "prompt_library_meta 缺少唯一元数据行。",
        ));
    }
    tx.query_row(
        "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .map_err(AppError::from)
}

fn validate_tag_ids(conn: &Connection, tag_ids: &[String]) -> Result<Vec<String>, AppError> {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for id in tag_ids {
        if seen.insert(id.clone()) {
            unique.push(id.clone());
        }
    }
    if unique.len() > PROMPT_MAX_TAGS {
        return Err(AppError::new(
            "prompt_too_many_tags",
            "每篇提示词最多关联 20 个标签。",
        ));
    }
    for id in &unique {
        let exists = conn
            .query_row("SELECT 1 FROM prompt_tags WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(AppError::with_details(
                "prompt_tag_not_found",
                "所选标签不存在或已被删除。",
                id.clone(),
            ));
        }
    }
    Ok(unique)
}

pub(crate) fn plain_text_excerpt(content: &str) -> String {
    let mut output = String::with_capacity(content.len().min(EXCERPT_MAX_CHARS * 2));
    let mut in_code_fence = false;
    let mut last_was_space = true;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        for ch in line.chars() {
            if output.chars().count() >= EXCERPT_MAX_CHARS {
                break;
            }
            let markup = matches!(
                ch,
                '#' | '*' | '_' | '~' | '`' | '>' | '[' | ']' | '(' | ')'
            );
            if !in_code_fence && markup {
                continue;
            }
            if ch.is_whitespace() {
                if !last_was_space {
                    output.push(' ');
                    last_was_space = true;
                }
            } else {
                output.push(ch);
                last_was_space = false;
            }
        }
        if !last_was_space && output.chars().count() < EXCERPT_MAX_CHARS {
            output.push(' ');
            last_was_space = true;
        }
        if output.chars().count() >= EXCERPT_MAX_CHARS {
            break;
        }
    }
    output.trim().to_string()
}

fn replace_prompt_links(
    tx: &Transaction<'_>,
    prompt_row_id: i64,
    tag_ids: &[String],
) -> Result<(), AppError> {
    tx.execute(
        "DELETE FROM prompt_tag_links WHERE prompt_row_id = ?1",
        [prompt_row_id],
    )?;
    for tag_id in tag_ids {
        let changed = tx.execute(
            "INSERT INTO prompt_tag_links(prompt_row_id, tag_row_id)
             SELECT ?1, row_id FROM prompt_tags WHERE id = ?2",
            params![prompt_row_id, tag_id],
        )?;
        if changed != 1 {
            return Err(AppError::with_details(
                "prompt_tag_not_found",
                "所选标签不存在或已被删除。",
                tag_id.clone(),
            ));
        }
    }
    Ok(())
}

fn calculate_manual_orders_for_front(first: i64, count: usize) -> Option<Vec<i64>> {
    if count == 0 {
        return Some(Vec::new());
    }
    let count = i64::try_from(count).ok()?;
    let block_width = count.checked_mul(MANUAL_ORDER_STRIDE)?;
    let first_order = first.checked_sub(block_width)?;
    (0..count)
        .map(|offset| {
            offset
                .checked_mul(MANUAL_ORDER_STRIDE)
                .and_then(|delta| first_order.checked_add(delta))
        })
        .collect()
}

/// Reserves a contiguous rank block before the current pinned/normal group.
///
/// Callers must insert every returned rank through the same transaction/connection before any
/// competing writer can mutate the group. The vector order is the visible order: the first
/// incoming prompt receives the first rank. If the integer range is exhausted, the existing
/// group is normalized in-place and the allocation is retried without changing content metadata.
pub(crate) fn manual_orders_for_front(
    conn: &Connection,
    pinned: bool,
    count: usize,
) -> Result<Vec<i64>, AppError> {
    let read_first = |connection: &Connection| -> Result<Option<i64>, AppError> {
        connection
            .query_row(
                "SELECT MIN(manual_order) FROM prompts WHERE pinned = ?1",
                [pinned],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(AppError::from)
    };
    let first = read_first(conn)?.unwrap_or(MANUAL_ORDER_STRIDE);
    if let Some(orders) = calculate_manual_orders_for_front(first, count) {
        return Ok(orders);
    }
    normalize_manual_order_group(conn, pinned)?;
    calculate_manual_orders_for_front(read_first(conn)?.unwrap_or(MANUAL_ORDER_STRIDE), count)
        .ok_or_else(|| sqlite_integrity_error("提示词手动排序归一化后仍超出可用范围。"))
}

fn manual_order_for_front(conn: &Connection, pinned: bool) -> Result<i64, AppError> {
    manual_orders_for_front(conn, pinned, 1)?
        .into_iter()
        .next()
        .ok_or_else(|| sqlite_integrity_error("提示词手动排序未能分配位置。"))
}

pub(crate) fn create_prompt(
    conn: &Connection,
    input: &PromptCreateInput,
) -> Result<PromptDetail, AppError> {
    let title = validate_prompt_title(&input.title)?;
    validate_prompt_content(&input.content)?;
    let tag_ids = validate_tag_ids(conn, &input.tag_ids)?;
    let id = input.id.clone().unwrap_or_else(|| make_public_id("prompt"));
    validate_public_id(&id)?;
    let now = now_utc();
    let excerpt = plain_text_excerpt(&input.content);
    let tx = conn.unchecked_transaction()?;
    let manual_order = manual_order_for_front(&tx, input.pinned)?;
    let insert = tx.execute(
        "INSERT INTO prompts
         (id, title, content, excerpt, pinned, manual_order, revision, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
        params![
            id,
            title,
            input.content,
            excerpt,
            input.pinned,
            manual_order,
            now
        ],
    );
    if let Err(error) = insert {
        if matches!(error, rusqlite::Error::SqliteFailure(_, Some(ref message)) if message.contains("prompts.id"))
        {
            return Err(AppError::new("prompt_id_conflict", "提示词 ID 已存在。"));
        }
        return Err(error.into());
    }
    let row_id = tx.last_insert_rowid();
    replace_prompt_links(&tx, row_id, &tag_ids)?;
    bump_library_revision(&tx)?;
    tx.commit()?;
    get_prompt_detail(conn, &id)?
        .ok_or_else(|| sqlite_integrity_error("提示词已写入，但无法重新读取。"))
}

pub(crate) fn update_prompt(
    conn: &Connection,
    input: &PromptUpdateInput,
) -> Result<PromptDetail, AppError> {
    let title = validate_prompt_title(&input.title)?;
    validate_prompt_content(&input.content)?;
    let tag_ids = validate_tag_ids(conn, &input.tag_ids)?;
    let excerpt = plain_text_excerpt(&input.content);
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let record = tx
        .query_row(
            "SELECT row_id, pinned, manual_order
             FROM prompts WHERE id = ?1 AND revision = ?2",
            params![input.id, input.expected_revision],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((row_id, current_pinned, current_manual_order)) = record else {
        return revision_or_missing_error(&tx, &input.id, input.expected_revision);
    };
    let target_pinned = input.pinned.unwrap_or(current_pinned);
    let manual_order = if target_pinned == current_pinned {
        current_manual_order
    } else {
        manual_order_for_front(&tx, target_pinned)?
    };
    tx.execute(
        "UPDATE prompts
         SET title = ?1,
             content = ?2,
             excerpt = ?3,
             pinned = COALESCE(?4, pinned),
             manual_order = ?5,
             revision = revision + 1,
             updated_at = ?6
         WHERE row_id = ?7",
        params![
            title,
            input.content,
            excerpt,
            input.pinned,
            manual_order,
            now,
            row_id
        ],
    )?;
    replace_prompt_links(&tx, row_id, &tag_ids)?;
    bump_library_revision(&tx)?;
    tx.commit()?;
    get_prompt_detail(conn, &input.id)?
        .ok_or_else(|| sqlite_integrity_error("提示词已更新，但无法重新读取。"))
}

fn revision_or_missing_error<T>(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
) -> Result<T, AppError> {
    let actual = conn
        .query_row("SELECT revision FROM prompts WHERE id = ?1", [id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?;
    match actual {
        Some(revision) => Err(AppError::with_details(
            "prompt_revision_conflict",
            "提示词已被其他操作修改，请重新加载后再试。",
            format!("expected={expected_revision}, actual={revision}"),
        )),
        None => Err(AppError::new(
            "prompt_not_found",
            "提示词不存在或已被删除。",
        )),
    }
}

pub(crate) fn set_prompt_pinned(
    conn: &Connection,
    id: &str,
    pinned: bool,
    expected_revision: i64,
) -> Result<PromptSummary, AppError> {
    let tx = conn.unchecked_transaction()?;
    let current = tx
        .query_row(
            "SELECT pinned, manual_order FROM prompts
             WHERE id = ?1 AND revision = ?2",
            params![id, expected_revision],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((current_pinned, current_manual_order)) = current else {
        return revision_or_missing_error(&tx, id, expected_revision);
    };
    let manual_order = if current_pinned == pinned {
        current_manual_order
    } else {
        manual_order_for_front(&tx, pinned)?
    };
    let changed = tx.execute(
        "UPDATE prompts
         SET pinned = ?1, manual_order = ?2, revision = revision + 1
         WHERE id = ?3 AND revision = ?4",
        params![pinned, manual_order, id, expected_revision],
    )?;
    if changed != 1 {
        return revision_or_missing_error(&tx, id, expected_revision);
    }
    bump_library_revision(&tx)?;
    tx.commit()?;
    get_prompt_detail(conn, id)?
        .map(|detail| detail.summary)
        .ok_or_else(|| sqlite_integrity_error("置顶更新后无法读取提示词。"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReorderAnchor {
    id: String,
    manual_order: i64,
}

fn reorder_anchor(
    conn: &Connection,
    id: &str,
    active_id: &str,
    pinned: bool,
) -> Result<ReorderAnchor, AppError> {
    if id == active_id {
        return Err(AppError::new(
            "prompt_reorder_invalid_neighbors",
            "排序落点不能引用正在移动的提示词。",
        ));
    }
    let anchor = conn
        .query_row(
            "SELECT pinned, manual_order FROM prompts WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            AppError::with_details(
                "prompt_reorder_neighbor_not_found",
                "排序落点中的相邻提示词不存在。",
                id.to_string(),
            )
        })?;
    if anchor.0 != pinned {
        return Err(AppError::new(
            "prompt_reorder_pinned_boundary",
            "置顶提示词和普通提示词不能通过拖动跨组排序。",
        ));
    }
    Ok(ReorderAnchor {
        id: id.to_string(),
        manual_order: anchor.1,
    })
}

fn order_between(previous: Option<i64>, next: Option<i64>) -> Option<i64> {
    match (previous, next) {
        (Some(previous), Some(next)) if previous < next => {
            let distance = i128::from(next) - i128::from(previous);
            if distance <= 1 {
                None
            } else {
                Some((i128::from(previous) + distance / 2) as i64)
            }
        }
        (Some(previous), None) => previous.checked_add(MANUAL_ORDER_STRIDE),
        (None, Some(next)) => next.checked_sub(MANUAL_ORDER_STRIDE),
        (None, None) => Some(0),
        _ => None,
    }
}

fn normalize_manual_order_group(conn: &Connection, pinned: bool) -> Result<(), AppError> {
    let row_ids = {
        let mut statement = conn.prepare(
            "SELECT row_id FROM prompts
             WHERE pinned = ?1
             ORDER BY manual_order ASC, id ASC",
        )?;
        let rows = statement.query_map([pinned], |row| row.get::<_, i64>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut update = conn.prepare("UPDATE prompts SET manual_order = ?1 WHERE row_id = ?2")?;
    for (index, row_id) in row_ids.into_iter().enumerate() {
        let position = i64::try_from(index + 1)
            .ok()
            .and_then(|value| value.checked_mul(MANUAL_ORDER_STRIDE))
            .ok_or_else(|| sqlite_integrity_error("提示词数量超出手动排序可用范围。"))?;
        update.execute(params![position, row_id])?;
    }
    Ok(())
}

fn reorder_anchor_after(
    conn: &Connection,
    active_id: &str,
    pinned: bool,
    previous: &ReorderAnchor,
) -> Result<Option<ReorderAnchor>, AppError> {
    conn.query_row(
        "SELECT id, manual_order FROM prompts
         WHERE pinned = ?1 AND id <> ?2
           AND (manual_order > ?3 OR (manual_order = ?3 AND id > ?4))
         ORDER BY manual_order ASC, id ASC
         LIMIT 1",
        params![pinned, active_id, previous.manual_order, previous.id],
        |row| {
            Ok(ReorderAnchor {
                id: row.get(0)?,
                manual_order: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

fn reorder_anchor_before(
    conn: &Connection,
    active_id: &str,
    pinned: bool,
    next: &ReorderAnchor,
) -> Result<Option<ReorderAnchor>, AppError> {
    conn.query_row(
        "SELECT id, manual_order FROM prompts
         WHERE pinned = ?1 AND id <> ?2
           AND (manual_order < ?3 OR (manual_order = ?3 AND id < ?4))
         ORDER BY manual_order DESC, id DESC
         LIMIT 1",
        params![pinned, active_id, next.manual_order, next.id],
        |row| {
            Ok(ReorderAnchor {
                id: row.get(0)?,
                manual_order: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

fn reorder_group_edge(
    conn: &Connection,
    active_id: Option<&str>,
    pinned: bool,
    boundary: PromptReorderBoundary,
) -> Result<Option<ReorderAnchor>, AppError> {
    let sql = match boundary {
        PromptReorderBoundary::First => {
            "SELECT id, manual_order FROM prompts
             WHERE pinned = ?1 AND (?2 IS NULL OR id <> ?2)
             ORDER BY manual_order ASC, id ASC LIMIT 1"
        }
        PromptReorderBoundary::Last => {
            "SELECT id, manual_order FROM prompts
             WHERE pinned = ?1 AND (?2 IS NULL OR id <> ?2)
             ORDER BY manual_order DESC, id DESC LIMIT 1"
        }
    };
    conn.query_row(sql, params![pinned, active_id], |row| {
        Ok(ReorderAnchor {
            id: row.get(0)?,
            manual_order: row.get(1)?,
        })
    })
    .optional()
    .map_err(AppError::from)
}

fn validate_reorder_input_shape(input: &PromptReorderInput) -> Result<(), AppError> {
    let has_anchor = input.previous_id.is_some() || input.next_id.is_some();
    match (input.boundary, has_anchor) {
        (Some(_), false) | (None, true) => Ok(()),
        _ => Err(AppError::new(
            "prompt_reorder_invalid_request",
            "排序请求必须提供相邻提示词，或单独指定全局首尾边界。",
        )),
    }
}

fn resolve_reorder_gap(
    conn: &Connection,
    input: &PromptReorderInput,
    pinned: bool,
) -> Result<(Option<ReorderAnchor>, Option<ReorderAnchor>), AppError> {
    if let Some(boundary) = input.boundary {
        let edge = reorder_group_edge(conn, Some(&input.id), pinned, boundary)?;
        return Ok(match boundary {
            PromptReorderBoundary::First => (None, edge),
            PromptReorderBoundary::Last => (edge, None),
        });
    }

    let previous = input
        .previous_id
        .as_deref()
        .map(|id| reorder_anchor(conn, id, &input.id, pinned))
        .transpose()?;
    let next = input
        .next_id
        .as_deref()
        .map(|id| reorder_anchor(conn, id, &input.id, pinned))
        .transpose()?;
    match (previous, next) {
        (Some(previous), Some(next)) => {
            let actual_next = reorder_anchor_after(conn, &input.id, pinned, &previous)?;
            if actual_next.as_ref().map(|anchor| anchor.id.as_str()) != Some(next.id.as_str()) {
                return Err(AppError::new(
                    "prompt_reorder_invalid_neighbors",
                    "排序落点的相邻提示词已发生变化，请重新拖动。",
                ));
            }
            Ok((Some(previous), Some(next)))
        }
        (Some(previous), None) => {
            let next = reorder_anchor_after(conn, &input.id, pinned, &previous)?;
            Ok((Some(previous), next))
        }
        (None, Some(next)) => {
            let previous = reorder_anchor_before(conn, &input.id, pinned, &next)?;
            Ok((previous, Some(next)))
        }
        (None, None) => Err(AppError::new(
            "prompt_reorder_invalid_request",
            "排序请求缺少落点。",
        )),
    }
}

pub(crate) fn reorder_prompt(
    conn: &Connection,
    input: &PromptReorderInput,
) -> Result<PromptReorderResult, AppError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let actual_library_revision = library_revision(&tx)?;
    if actual_library_revision != input.expected_library_revision {
        return Err(AppError::with_details(
            "prompt_reorder_drift",
            "提示词库在拖动期间已发生变化，请重新排序。",
            format!(
                "expected={}, actual={actual_library_revision}",
                input.expected_library_revision
            ),
        ));
    }
    let active = tx
        .query_row(
            "SELECT row_id, pinned, revision FROM prompts WHERE id = ?1",
            [&input.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((row_id, pinned, revision)) = active else {
        return Err(AppError::new(
            "prompt_not_found",
            "提示词不存在或已被删除。",
        ));
    };
    if revision != input.expected_revision {
        return revision_or_missing_error(&tx, &input.id, input.expected_revision);
    }
    validate_reorder_input_shape(input)?;
    if let Some(boundary) = input.boundary {
        let active_is_at_boundary = reorder_group_edge(&tx, None, pinned, boundary)?
            .is_some_and(|edge| edge.id == input.id);
        if active_is_at_boundary {
            return Ok(PromptReorderResult {
                library_revision: actual_library_revision,
            });
        }
    }

    let (mut previous, mut next) = resolve_reorder_gap(&tx, input, pinned)?;
    let manual_order = match order_between(
        previous.as_ref().map(|anchor| anchor.manual_order),
        next.as_ref().map(|anchor| anchor.manual_order),
    ) {
        Some(value) => value,
        None => {
            normalize_manual_order_group(&tx, pinned)?;
            (previous, next) = resolve_reorder_gap(&tx, input, pinned)?;
            order_between(
                previous.as_ref().map(|anchor| anchor.manual_order),
                next.as_ref().map(|anchor| anchor.manual_order),
            )
            .ok_or_else(|| sqlite_integrity_error("提示词手动排序归一化后仍无法生成落点。"))?
        }
    };
    tx.execute(
        "UPDATE prompts SET manual_order = ?1 WHERE row_id = ?2",
        params![manual_order, row_id],
    )?;
    let library_revision = bump_library_revision(&tx)?;
    tx.commit()?;
    Ok(PromptReorderResult { library_revision })
}

pub(crate) fn delete_prompt(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
) -> Result<(), AppError> {
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "DELETE FROM prompts WHERE id = ?1 AND revision = ?2",
        params![id, expected_revision],
    )?;
    if changed != 1 {
        return revision_or_missing_error(&tx, id, expected_revision);
    }
    bump_library_revision(&tx)?;
    tx.commit()?;
    Ok(())
}

fn prompt_tags(conn: &Connection, prompt_row_id: i64) -> Result<Vec<PromptTag>, AppError> {
    let mut statement = conn.prepare(
        "SELECT t.id, t.name, t.created_at, t.updated_at,
                (SELECT COUNT(*) FROM prompt_tag_links usage WHERE usage.tag_row_id = t.row_id)
         FROM prompt_tags t
         INNER JOIN prompt_tag_links l ON l.tag_row_id = t.row_id
         WHERE l.prompt_row_id = ?1
         ORDER BY t.normalized_name ASC, t.id ASC",
    )?;
    let rows = statement.query_map([prompt_row_id], |row| {
        Ok(PromptTag {
            id: row.get(0)?,
            name: row.get(1)?,
            prompt_count: row.get(4)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn read_prompt_detail_parts(
    conn: &Connection,
    id: &str,
    after_record_read: impl FnOnce(),
) -> Result<Option<PromptDetail>, AppError> {
    let record = conn
        .query_row(
            "SELECT row_id, id, title, excerpt, pinned,
                    length(CAST(content AS BLOB)), created_at, updated_at, revision, content
             FROM prompts WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, u64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()?;
    let Some((
        row_id,
        id,
        title,
        excerpt,
        pinned,
        content_bytes,
        created_at,
        updated_at,
        revision,
        content,
    )) = record
    else {
        return Ok(None);
    };
    after_record_read();
    Ok(Some(PromptDetail {
        summary: PromptSummary {
            id,
            title,
            excerpt,
            tags: prompt_tags(conn, row_id)?,
            pinned,
            content_bytes,
            created_at,
            updated_at,
            revision,
        },
        content,
    }))
}

fn get_prompt_detail_in_read_transaction(
    conn: &Connection,
    id: &str,
    after_record_read: impl FnOnce(),
) -> Result<Option<PromptDetail>, AppError> {
    let snapshot = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let detail = read_prompt_detail_parts(&snapshot, id, after_record_read)?;
    snapshot.commit()?;
    Ok(detail)
}

pub(crate) fn get_prompt_detail(
    conn: &Connection,
    id: &str,
) -> Result<Option<PromptDetail>, AppError> {
    get_prompt_detail_in_read_transaction(conn, id, || {})
}

fn escaped_like(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('%');
    for ch in value.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped.push('%');
    escaped
}

fn literal_fts_query(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn unique_filter_tag_ids(tag_ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    tag_ids
        .iter()
        .filter(|id| seen.insert((*id).clone()))
        .cloned()
        .collect()
}

fn build_filter_clause(
    query: &str,
    tag_ids: &[String],
    tag_mode: PromptTagMode,
) -> (String, Vec<Value>) {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    let normalized_query = query.trim().nfc().collect::<String>();
    if !normalized_query.is_empty() {
        let normalized_tag_query = normalized_query.to_lowercase().nfc().collect::<String>();
        if normalized_query.chars().count() >= 3 {
            clauses.push(
                "(p.row_id IN (SELECT rowid FROM prompt_fts WHERE prompt_fts MATCH ?)
                  OR EXISTS (
                    SELECT 1 FROM prompt_tag_links ql
                    INNER JOIN prompt_tags qt ON qt.row_id = ql.tag_row_id
                    WHERE ql.prompt_row_id = p.row_id
                      AND qt.normalized_name LIKE ? ESCAPE '\\'
                  ))"
                .to_string(),
            );
            values.push(Value::Text(literal_fts_query(&normalized_query)));
            values.push(Value::Text(escaped_like(&normalized_tag_query)));
        } else {
            clauses.push(
                "(p.title LIKE ? ESCAPE '\\'
                  OR p.content LIKE ? ESCAPE '\\'
                  OR EXISTS (
                    SELECT 1 FROM prompt_tag_links ql
                    INNER JOIN prompt_tags qt ON qt.row_id = ql.tag_row_id
                    WHERE ql.prompt_row_id = p.row_id
                      AND qt.normalized_name LIKE ? ESCAPE '\\'
                  ))"
                .to_string(),
            );
            let like = escaped_like(&normalized_query);
            values.push(Value::Text(like.clone()));
            values.push(Value::Text(like));
            values.push(Value::Text(escaped_like(&normalized_tag_query)));
        }
    }

    let tag_ids = unique_filter_tag_ids(tag_ids);
    if !tag_ids.is_empty() {
        let placeholders = std::iter::repeat("?")
            .take(tag_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        match tag_mode {
            PromptTagMode::Any => clauses.push(format!(
                "EXISTS (
                   SELECT 1 FROM prompt_tag_links fl
                   INNER JOIN prompt_tags ft ON ft.row_id = fl.tag_row_id
                   WHERE fl.prompt_row_id = p.row_id AND ft.id IN ({placeholders})
                 )"
            )),
            PromptTagMode::All => clauses.push(format!(
                "(SELECT COUNT(DISTINCT ft.id)
                  FROM prompt_tag_links fl
                  INNER JOIN prompt_tags ft ON ft.row_id = fl.tag_row_id
                  WHERE fl.prompt_row_id = p.row_id AND ft.id IN ({placeholders})
                 ) = {}",
                tag_ids.len()
            )),
        }
        values.extend(tag_ids.into_iter().map(Value::Text));
    }
    if clauses.is_empty() {
        (String::new(), values)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), values)
    }
}

fn validate_list_request(request: &PromptListRequest) -> Result<(), AppError> {
    if request.page == 0 {
        return Err(AppError::new("prompt_page_invalid", "页码必须从 1 开始。"));
    }
    if !ALLOWED_PAGE_SIZES.contains(&request.page_size) {
        return Err(AppError::new(
            "prompt_page_size_invalid",
            "每页数量只能是 30、50 或 100。",
        ));
    }
    Ok(())
}

fn prompt_order_clause(sort: PromptSort) -> &'static str {
    match sort {
        PromptSort::Manual => "p.pinned DESC, p.manual_order ASC, p.id ASC",
        PromptSort::UpdatedDesc => "p.pinned DESC, p.updated_at DESC, p.id ASC",
    }
}

fn rows_to_summaries(
    conn: &Connection,
    records: Vec<(i64, String, String, String, bool, u64, String, String, i64)>,
) -> Result<Vec<PromptSummary>, AppError> {
    records
        .into_iter()
        .map(
            |(
                row_id,
                id,
                title,
                excerpt,
                pinned,
                content_bytes,
                created_at,
                updated_at,
                revision,
            )| {
                Ok(PromptSummary {
                    id,
                    title,
                    excerpt,
                    tags: prompt_tags(conn, row_id)?,
                    pinned,
                    content_bytes,
                    created_at,
                    updated_at,
                    revision,
                })
            },
        )
        .collect()
}

fn list_prompts_in_snapshot(
    conn: &Connection,
    request: &PromptListRequest,
    after_count: impl FnOnce(),
) -> Result<PromptPage, AppError> {
    validate_list_request(request)?;
    let snapshot = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let (where_clause, values) =
        build_filter_clause(&request.query, &request.tag_ids, request.tag_mode);
    let count_sql = format!("SELECT COUNT(*) FROM prompts p{where_clause}");
    let total = snapshot.query_row(&count_sql, params_from_iter(values.iter()), |row| {
        row.get::<_, u64>(0)
    })?;
    after_count();
    // Mutations can remove the final item on the current page between frontend refreshes.
    // Keep the response self-consistent by returning the last valid page instead of an empty
    // out-of-range page such as `page=2, totalPages=1`.
    let total_pages = if total == 0 {
        1
    } else {
        total.div_ceil(u64::from(request.page_size)) as u32
    };
    let effective_page = request.page.min(total_pages);
    let offset = u64::from(effective_page - 1) * u64::from(request.page_size);
    let order_clause = prompt_order_clause(request.sort);
    let data_sql = format!(
        "SELECT p.row_id, p.id, p.title, p.excerpt, p.pinned,
                length(CAST(p.content AS BLOB)), p.created_at, p.updated_at, p.revision
         FROM prompts p{where_clause}
         ORDER BY {order_clause}
         LIMIT ? OFFSET ?"
    );
    let mut data_values = values;
    data_values.push(Value::Integer(i64::from(request.page_size)));
    data_values.push(Value::Integer(offset.min(i64::MAX as u64) as i64));
    let records = {
        let mut statement = snapshot.prepare(&data_sql)?;
        let mapped = statement.query_map(params_from_iter(data_values.iter()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };
    let items = rows_to_summaries(&snapshot, records)?;
    let snapshot_revision = library_revision(&snapshot)?;
    snapshot.commit()?;
    Ok(PromptPage {
        items,
        page: effective_page,
        page_size: request.page_size,
        total,
        total_pages,
        library_revision: snapshot_revision,
    })
}

pub(crate) fn list_prompts(
    conn: &Connection,
    request: &PromptListRequest,
) -> Result<PromptPage, AppError> {
    list_prompts_in_snapshot(conn, request, || {})
}

pub(crate) fn list_prompt_tags(conn: &Connection) -> Result<Vec<PromptTag>, AppError> {
    let mut statement = conn.prepare(
        "SELECT t.id, t.name, t.created_at, t.updated_at, COUNT(l.prompt_row_id)
         FROM prompt_tags t
         LEFT JOIN prompt_tag_links l ON l.tag_row_id = t.row_id
         GROUP BY t.row_id
         ORDER BY t.normalized_name ASC, t.id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(PromptTag {
            id: row.get(0)?,
            name: row.get(1)?,
            prompt_count: row.get(4)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub(crate) fn create_prompt_tag(conn: &Connection, name: &str) -> Result<PromptTag, AppError> {
    let normalized = normalize_tag_name(name)?;
    if let Some(existing) = find_tag_by_normalized_name(conn, &normalized.key)? {
        return Err(AppError::with_details(
            "prompt_tag_already_exists",
            "同名标签已存在。",
            existing.id,
        ));
    }
    let id = make_public_id("tag");
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO prompt_tags(id, name, normalized_name, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?4)",
        params![id, normalized.display, normalized.key, now],
    )?;
    bump_library_revision(&tx)?;
    tx.commit()?;
    find_tag_by_id(conn, &id)?.ok_or_else(|| sqlite_integrity_error("标签写入后无法读取。"))
}

fn find_tag_by_id(conn: &Connection, id: &str) -> Result<Option<PromptTag>, AppError> {
    conn.query_row(
        "SELECT id, name, created_at, updated_at,
                (SELECT COUNT(*) FROM prompt_tag_links WHERE tag_row_id = prompt_tags.row_id)
         FROM prompt_tags WHERE id = ?1",
        [id],
        |row| {
            Ok(PromptTag {
                id: row.get(0)?,
                name: row.get(1)?,
                prompt_count: row.get(4)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

fn find_tag_by_normalized_name(
    conn: &Connection,
    key: &str,
) -> Result<Option<PromptTag>, AppError> {
    conn.query_row(
        "SELECT id, name, created_at, updated_at,
                (SELECT COUNT(*) FROM prompt_tag_links WHERE tag_row_id = prompt_tags.row_id)
         FROM prompt_tags WHERE normalized_name = ?1",
        [key],
        |row| {
            Ok(PromptTag {
                id: row.get(0)?,
                name: row.get(1)?,
                prompt_count: row.get(4)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

pub(crate) fn rename_prompt_tag(
    conn: &Connection,
    id: &str,
    name: &str,
) -> Result<PromptTag, AppError> {
    let normalized = normalize_tag_name(name)?;
    let current = find_tag_by_id(conn, id)?
        .ok_or_else(|| AppError::new("prompt_tag_not_found", "标签不存在或已被删除。"))?;
    if let Some(existing) = find_tag_by_normalized_name(conn, &normalized.key)? {
        if existing.id != id {
            let details = serde_json::json!({
                "sourceTagId": id,
                "targetTagId": existing.id,
                "targetTagName": existing.name,
            })
            .to_string();
            return Err(AppError::with_details(
                "prompt_tag_merge_required",
                "目标名称已存在，请明确选择是否合并标签。",
                details,
            ));
        }
    }
    if current.name == normalized.display {
        return Ok(current);
    }
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE prompt_tags SET name = ?1, normalized_name = ?2, updated_at = ?3 WHERE id = ?4",
        params![normalized.display, normalized.key, now, id],
    )?;
    bump_library_revision(&tx)?;
    tx.commit()?;
    find_tag_by_id(conn, id)?.ok_or_else(|| sqlite_integrity_error("标签更新后无法读取。"))
}

pub(crate) fn merge_prompt_tags(
    conn: &Connection,
    source_id: &str,
    target_id: &str,
) -> Result<PromptTag, AppError> {
    if source_id == target_id {
        return Err(AppError::new(
            "prompt_tag_merge_same",
            "不能将标签合并到自身。",
        ));
    }
    find_tag_by_id(conn, target_id)?
        .ok_or_else(|| AppError::new("prompt_tag_not_found", "目标标签不存在或已被删除。"))?;
    if find_tag_by_id(conn, source_id)?.is_none() {
        return Err(AppError::new(
            "prompt_tag_not_found",
            "来源标签不存在或已被删除。",
        ));
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO prompt_tag_links(prompt_row_id, tag_row_id)
         SELECT l.prompt_row_id, target.row_id
         FROM prompt_tag_links l
         INNER JOIN prompt_tags source ON source.row_id = l.tag_row_id
         INNER JOIN prompt_tags target ON target.id = ?2
         WHERE source.id = ?1",
        params![source_id, target_id],
    )?;
    tx.execute("DELETE FROM prompt_tags WHERE id = ?1", [source_id])?;
    bump_library_revision(&tx)?;
    tx.commit()?;
    find_tag_by_id(conn, target_id)?
        .ok_or_else(|| sqlite_integrity_error("标签合并后无法读取目标标签。"))
}

pub(crate) fn delete_prompt_tag(conn: &Connection, id: &str) -> Result<(), AppError> {
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute("DELETE FROM prompt_tags WHERE id = ?1", [id])?;
    if changed != 1 {
        return Err(AppError::new(
            "prompt_tag_not_found",
            "标签不存在或已被删除。",
        ));
    }
    bump_library_revision(&tx)?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn resolve_prompt_selection_ids(
    conn: &Connection,
    selection: &PromptSelection,
) -> Result<Vec<String>, AppError> {
    match selection {
        PromptSelection::Explicit { ids } => {
            let mut seen = HashSet::new();
            let mut resolved = Vec::with_capacity(ids.len());
            for id in ids {
                if !seen.insert(id.clone()) {
                    continue;
                }
                let exists = conn
                    .query_row("SELECT 1 FROM prompts WHERE id = ?1", [id], |_| Ok(()))
                    .optional()?
                    .is_some();
                if !exists {
                    return Err(AppError::with_details(
                        "prompt_not_found",
                        "所选提示词不存在或已被删除。",
                        id.clone(),
                    ));
                }
                resolved.push(id.clone());
            }
            Ok(resolved)
        }
        PromptSelection::Filter {
            filter,
            excluded_ids,
            expected_library_revision,
        } => {
            let actual_revision = library_revision(conn)?;
            if actual_revision != *expected_library_revision {
                return Err(AppError::with_details(
                    "prompt_selection_drift",
                    "提示词库在全选后已发生变化，请重新确认选择范围。",
                    format!("expected={expected_library_revision}, actual={actual_revision}"),
                ));
            }
            let (where_clause, values) =
                build_filter_clause(&filter.query, &filter.tag_ids, filter.tag_mode);
            let order_clause = prompt_order_clause(filter.sort);
            let sql = format!(
                "SELECT p.id FROM prompts p{where_clause}
                 ORDER BY {order_clause}"
            );
            let excluded = excluded_ids.iter().collect::<HashSet<_>>();
            let ids = {
                let mut statement = conn.prepare(&sql)?;
                let rows = statement.query_map(params_from_iter(values.iter()), |row| {
                    row.get::<_, String>(0)
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .filter(|id| !excluded.contains(id))
                    .collect::<Vec<_>>()
            };
            let final_revision = library_revision(conn)?;
            if final_revision != actual_revision {
                return Err(AppError::with_details(
                    "prompt_selection_drift",
                    "提示词库在生成选择范围时发生变化，请重试。",
                    format!("before={actual_revision}, after={final_revision}"),
                ));
            }
            Ok(ids)
        }
    }
}

fn unique_suffix() -> String {
    let input = unique_operation_id("export");
    let digest = Sha256::digest(input.as_bytes());
    hex::encode(&digest[..5])
}

pub(crate) fn suggested_prompt_export_file_name(extension: &str, now: DateTime<Local>) -> String {
    let safe_extension = match extension {
        "md" => "md",
        "zip" => "zip",
        _ => "bin",
    };
    format!(
        "Skill-repo-tracker提示词导出_{}_{}.{}",
        now.format("%Y%m%d%H%M%S"),
        unique_suffix(),
        safe_extension
    )
}

fn yaml_string(value: &str) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|error| {
        AppError::with_details(
            "prompt_export_yaml_failed",
            "提示词导出元数据编码失败。",
            error.to_string(),
        )
    })
}

pub(crate) fn render_prompt_markdown(
    detail: &PromptDetail,
    exported_at: DateTime<Local>,
) -> Result<Vec<u8>, AppError> {
    let tags = detail
        .summary
        .tags
        .iter()
        .map(|tag| yaml_string(&tag.name))
        .collect::<Result<Vec<_>, _>>()?
        .join(", ");
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("id: {}\n", yaml_string(&detail.summary.id)?));
    output.push_str(&format!("title: {}\n", yaml_string(&detail.summary.title)?));
    output.push_str(&format!("tags: [{tags}]\n"));
    output.push_str(&format!("pinned: {}\n", detail.summary.pinned));
    output.push_str(&format!(
        "created_at: {}\n",
        yaml_string(&detail.summary.created_at)?
    ));
    output.push_str(&format!(
        "updated_at: {}\n",
        yaml_string(&detail.summary.updated_at)?
    ));
    output.push_str(&format!(
        "exported_at: {}\n",
        yaml_string(&exported_at.to_rfc3339_opts(SecondsFormat::Secs, false))?
    ));
    output.push_str("---\n");
    output.push_str(&detail.content);
    Ok(output.into_bytes())
}

fn validate_export_destination(destination: &Path) -> Result<&Path, AppError> {
    let parent = destination.parent().ok_or_else(|| {
        AppError::new(
            "prompt_export_destination_invalid",
            "导出路径必须包含父目录。",
        )
    })?;
    if destination.file_name().is_none() || !parent.is_dir() {
        return Err(AppError::new(
            "prompt_export_destination_invalid",
            "导出目录不存在或目标文件名无效。",
        ));
    }
    Ok(parent)
}

fn atomic_temp_path(destination: &Path) -> Result<PathBuf, AppError> {
    let parent = validate_export_destination(destination)?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            AppError::new(
                "prompt_export_destination_invalid",
                "导出文件名必须是有效的 UTF-8 文本。",
            )
        })?;
    Ok(parent.join(format!(".{file_name}.{}.tmp", unique_suffix())))
}

fn sync_parent_directory(parent: &Path) -> Result<(), AppError> {
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn finish_atomic_replace(temp_path: &Path, destination: &Path) -> Result<(), AppError> {
    fs::rename(temp_path, destination)?;
    sync_parent_directory(validate_export_destination(destination)?)?;
    Ok(())
}

pub(crate) fn write_bytes_atomic(destination: &Path, bytes: &[u8]) -> Result<u64, AppError> {
    let temp_path = atomic_temp_path(destination)?;
    let result = (|| -> Result<u64, AppError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        finish_atomic_replace(&temp_path, destination)?;
        Ok(bytes.len() as u64)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn export_prompt_markdown_to_path_after_record_read(
    conn: &Connection,
    id: &str,
    destination: &Path,
    exported_at: DateTime<Local>,
    after_record_read: impl FnOnce(),
) -> Result<PromptExportArtifact, AppError> {
    let detail = get_prompt_detail_in_read_transaction(conn, id, after_record_read)?
        .ok_or_else(|| AppError::new("prompt_not_found", "提示词不存在或已被删除。"))?;
    let bytes = render_prompt_markdown(&detail, exported_at)?;
    let size_bytes = write_bytes_atomic(destination, &bytes)?;
    Ok(PromptExportArtifact {
        path: destination.to_string_lossy().into_owned(),
        file_name: destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        item_count: 1,
        size_bytes,
    })
}

pub(crate) fn export_prompt_markdown_to_path(
    conn: &Connection,
    id: &str,
    destination: &Path,
    exported_at: DateTime<Local>,
) -> Result<PromptExportArtifact, AppError> {
    export_prompt_markdown_to_path_after_record_read(conn, id, destination, exported_at, || {})
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    let mut output = String::new();
    for ch in value.chars() {
        if output.len() + ch.len_utf8() > max_bytes {
            break;
        }
        output.push(ch);
    }
    output
}

pub(crate) fn safe_prompt_zip_title(title: &str) -> String {
    let mut output = String::new();
    let mut previous_separator = false;
    for ch in title.trim().nfc() {
        let safe = if ch.is_control()
            || matches!(
                ch,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'
            ) {
            '_'
        } else if ch.is_whitespace() {
            '_'
        } else {
            ch
        };
        if safe == '_' {
            if previous_separator {
                continue;
            }
            previous_separator = true;
        } else {
            previous_separator = false;
        }
        output.push(safe);
    }
    let cleaned = output.trim_matches(|ch| matches!(ch, '.' | '_' | ' '));
    let cleaned = truncate_utf8_bytes(cleaned, 96);
    let cleaned = cleaned.trim_end_matches('.').replace("..", "_");
    if cleaned.is_empty() {
        "提示词".to_string()
    } else {
        cleaned
    }
}

#[cfg(any(debug_assertions, test))]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugPromptFixtureReport {
    pub prompt_count: usize,
    pub tag_count: usize,
    pub content_bytes: u64,
    pub library_revision: i64,
}

/// Seeds deterministic, fictional data without deleting or replacing any existing row.
/// The command layer must additionally restrict this debug-only function to a fresh temporary DB.
#[cfg(any(debug_assertions, test))]
pub(crate) fn seed_debug_prompt_fixture(
    conn: &Connection,
    count: usize,
    target_content_bytes: u64,
    tag_count: usize,
) -> Result<DebugPromptFixtureReport, AppError> {
    const DEMO_TAGS: &[&str] = &[
        "研究",
        "方法论",
        "分析",
        "文献",
        "总结",
        "写作",
        "学术",
        "结构",
        "数据",
        "实验",
        "设计",
        "方案",
        "可视化",
        "图表",
        "展示",
        "假设",
        "验证",
        "访谈",
        "调研",
        "提纲",
        "计划",
        "时间管理",
        "进度",
        "变量",
        "定义",
        "理论",
        "框架",
        "模型",
        "图像",
        "角色",
    ];
    const DEMO_PROMPTS: &[(&str, &str)] = &[
        (
            "深度研究问题拆解",
            "将复杂研究问题拆解为可执行的子问题，明确研究边界、关键维度与优先级。",
        ),
        (
            "文献综述结构化提炼",
            "从大量文献中提炼核心观点、研究方法与结论，并按主题和时间线整理。",
        ),
        (
            "论文写作大纲生成",
            "根据研究主题生成论文大纲，包含各章节要点、逻辑关系与论证顺序。",
        ),
        (
            "数据分析思路规划",
            "根据研究目标规划数据分析流程，明确数据需求、处理步骤与分析方法。",
        ),
        (
            "实验设计方案生成",
            "基于研究假设生成实验设计方案，包含变量定义、对照设置与样本量估算。",
        ),
        (
            "结果可视化建议",
            "根据数据特点推荐合适的可视化方式，提供图表类型选择与展示建议。",
        ),
        (
            "假设生成与验证路径",
            "基于研究问题生成可检验的假设，并规划验证路径、证据与判定标准。",
        ),
        (
            "研究缺口识别",
            "分析研究领域现状，识别已有研究的不足与空白，为研究选题提供依据。",
        ),
        (
            "访谈提纲生成",
            "根据研究目标生成半结构化访谈提纲，设计开放式问题与追问方向。",
        ),
        (
            "研究计划时间线",
            "将研究任务分解为阶段性目标，生成时间线、里程碑与交付检查点。",
        ),
        (
            "变量操作化定义",
            "将抽象概念转化为可测量的操作化定义，明确指标、量表与评分标准。",
        ),
        (
            "理论框架构建",
            "梳理相关理论并构建研究的理论框架，明确核心概念、关系与适用边界。",
        ),
        (
            "图像生成指令优化",
            "把创意意图整理为结构清晰的图像提示词，补足构图、材质与光线要求。",
        ),
        (
            "角色设定一致性审校",
            "检查角色背景、动机、语言和行为是否一致，标出冲突并给出修订建议。",
        ),
        (
            "调研资料摘要",
            "将调研记录提炼为可追溯摘要，区分事实、受访者观点与分析判断。",
        ),
    ];
    if count == 0 || tag_count == 0 {
        return Err(AppError::new(
            "prompt_fixture_invalid",
            "性能语料的提示词数量和标签数量必须大于 0。",
        ));
    }
    let base_bytes = target_content_bytes / count as u64;
    if base_bytes == 0 || base_bytes > PROMPT_CONTENT_MAX_BYTES as u64 {
        return Err(AppError::new(
            "prompt_fixture_size_invalid",
            "性能语料的单篇正文目标大小必须介于 1 byte 与 5 MiB 之间。",
        ));
    }
    let run_id = unique_suffix();
    let now = now_utc();
    let human_readable_demo = count <= 100 && tag_count <= 100;
    let tx = conn.unchecked_transaction()?;
    for index in 0..tag_count {
        let id = format!("debug-tag-{run_id}-{index:04}");
        let name = if human_readable_demo {
            DEMO_TAGS
                .get(index)
                .map(|value| (*value).to_string())
                .unwrap_or_else(|| format!("演示分类 {:02}", index + 1))
        } else {
            format!("虚构标签 {run_id} {index:04}")
        };
        let normalized = normalize_tag_name(&name)?;
        tx.execute(
            "INSERT INTO prompt_tags(id, name, normalized_name, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?4)",
            params![id, normalized.display, normalized.key, now],
        )?;
    }
    let mut actual_total = 0u64;
    for index in 0..count {
        let target = base_bytes + u64::from((index as u64) < target_content_bytes % count as u64);
        let (demo_title, demo_description) = DEMO_PROMPTS[index % DEMO_PROMPTS.len()];
        let title = if human_readable_demo {
            if index < DEMO_PROMPTS.len() {
                demo_title.to_string()
            } else {
                format!("{demo_title} · 演示 {:02}", index + 1)
            }
        } else {
            format!("虚构提示词 {index:05}")
        };
        let header = if human_readable_demo {
            format!(
                "{demo_description}\n\n## 工作步骤\n\n1. 明确目标与输入边界。\n2. 按结构完成分析，并标注关键假设。\n3. 输出可复核的结果与下一步建议。\n\n> 拆解的目标不是追求更多问题，而是让每个问题都能被证据回答。\n\n## 关键变量示例\n\n```yaml\ncore_question: 核心研究问题\ndimensions: [维度一, 维度二, 维度三]\npriority: 高 | 中 | 低\n```\n\n## 输出建议\n\n- 子问题清单（含重要描述）\n- 优先级排序（高 / 中 / 低）\n- 研究路径图（逻辑关系说明）\n\n"
            )
        } else {
            format!("# 虚构提示词 {index:05}\n\n研究 图像 角色 示例。\n\n")
        };
        let target = target.max(header.len() as u64);
        let mut content = header;
        if human_readable_demo {
            const EXTENSION: &str = "\n### 补充检查\n\n- 核对事实、解释与结论是否清晰分离。\n- 记录证据缺口、限制条件和待确认事项。\n- 保留可追溯的输入、判断与输出。\n";
            while content.len() < target as usize {
                content.push_str(EXTENSION);
            }
            while content.len() > target as usize {
                content.pop();
            }
            content.push_str(&" ".repeat((target as usize).saturating_sub(content.len())));
        } else {
            content.push_str(&"x".repeat((target as usize).saturating_sub(content.len())));
        }
        actual_total += content.len() as u64;
        let id = format!("debug-prompt-{run_id}-{index:05}");
        let excerpt = plain_text_excerpt(&content);
        let pinned = index < 3;
        let group_position = if pinned { index + 1 } else { index - 2 };
        let manual_order = i64::try_from(group_position)
            .ok()
            .and_then(|position| position.checked_mul(MANUAL_ORDER_STRIDE))
            .ok_or_else(|| {
                AppError::new(
                    "prompt_fixture_order_overflow",
                    "性能语料数量超出手动排序可用范围。",
                )
            })?;
        tx.execute(
            "INSERT INTO prompts
             (id, title, content, excerpt, pinned, manual_order, revision, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
            params![id, title, content, excerpt, pinned, manual_order, now],
        )?;
        let prompt_row_id = tx.last_insert_rowid();
        for offset in 0..3.min(tag_count) {
            let tag_index = (index + offset) % tag_count;
            let tag_id = format!("debug-tag-{run_id}-{tag_index:04}");
            tx.execute(
                "INSERT INTO prompt_tag_links(prompt_row_id, tag_row_id)
                 SELECT ?1, row_id FROM prompt_tags WHERE id = ?2",
                params![prompt_row_id, tag_id],
            )?;
        }
    }
    let revision = bump_library_revision(&tx)?;
    prompt_fts_integrity_check_tx(&tx)?;
    tx.commit()?;
    Ok(DebugPromptFixtureReport {
        prompt_count: count,
        tag_count,
        content_bytes: actual_total,
        library_revision: revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::time::Instant;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_prompt_library(&conn).unwrap();
        conn
    }

    fn create_tag(conn: &Connection, name: &str) -> PromptTag {
        create_prompt_tag(conn, name).unwrap()
    }

    fn create_named_prompt(
        conn: &Connection,
        id: &str,
        title: &str,
        content: &str,
        tag_ids: Vec<String>,
        pinned: bool,
    ) -> PromptDetail {
        create_prompt(
            conn,
            &PromptCreateInput {
                id: Some(id.to_string()),
                title: title.to_string(),
                content: content.to_string(),
                tag_ids,
                pinned,
            },
        )
        .unwrap()
    }

    fn request(query: &str) -> PromptListRequest {
        PromptListRequest {
            query: query.to_string(),
            ..PromptListRequest::default()
        }
    }

    #[test]
    fn migration_is_atomic_idempotent_and_integrity_checked() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_prompt_library(&conn).unwrap();
        migrate_prompt_library(&conn).unwrap();
        prompt_fts_integrity_check(&conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, PROMPT_SCHEMA_USER_VERSION);
        assert_eq!(library_revision(&conn).unwrap(), 0);

        let broken = Connection::open_in_memory().unwrap();
        broken
            .execute_batch("CREATE TABLE prompt_tags(id TEXT PRIMARY KEY);")
            .unwrap();
        let error = migrate_prompt_library(&broken).unwrap_err();
        assert_eq!(error.code, "prompt_schema_incompatible");
        let prompts_created: bool = broken
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'prompts')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !prompts_created,
            "failed migration must roll back new tables"
        );
    }

    #[test]
    fn v2_schema_migrates_to_manual_order_without_changing_visible_order() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA user_version = 2;
            CREATE TABLE prompts (
              row_id INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              excerpt TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
              revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              CHECK (length(title) BETWEEN 1 AND 200),
              CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 5242880)
            );
            INSERT INTO prompts
              (id, title, content, excerpt, pinned, revision, created_at, updated_at)
            VALUES
              ('normal-older', '普通旧', '正文', '正文', 0, 1, '2026-01-01', '2026-01-01'),
              ('normal-newer', '普通新', '正文', '正文', 0, 1, '2026-01-01', '2026-01-02'),
              ('pinned-older', '置顶旧', '正文', '正文', 1, 1, '2026-01-01', '2026-01-01'),
              ('pinned-newer', '置顶新', '正文', '正文', 1, 1, '2026-01-01', '2026-01-02');
            "#,
        )
        .unwrap();

        migrate_prompt_library(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        let manual_order_column_exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM pragma_table_info('prompts') WHERE name = 'manual_order'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(manual_order_column_exists);
        let manual_index_exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM sqlite_master
                   WHERE type = 'index' AND name = 'prompts_manual_sort_idx'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(manual_index_exists);

        let ids = list_prompts(&conn, &PromptListRequest::default())
            .unwrap()
            .items
            .into_iter()
            .map(|prompt| prompt.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "pinned-newer",
                "pinned-older",
                "normal-newer",
                "normal-older",
            ]
        );
    }

    #[test]
    fn persistent_database_uses_wal_and_independent_read_connection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("prompt.sqlite");
        let conn = Connection::open(&path).unwrap();
        migrate_prompt_library(&conn).unwrap();
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        create_named_prompt(&conn, "wal-read", "读取", "正文", vec![], false);
        let read = open_prompt_read_connection(&path).unwrap();
        assert_eq!(
            list_prompts(&read, &PromptListRequest::default())
                .unwrap()
                .total,
            1
        );
        assert!(read.execute("DELETE FROM prompts", []).is_err());
    }

    #[test]
    fn list_page_fields_share_one_snapshot_across_a_concurrent_wal_commit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("prompt-list-snapshot.sqlite");
        let writer = Connection::open(&path).unwrap();
        migrate_prompt_library(&writer).unwrap();
        let tag = create_tag(&writer, "快照标签");
        create_named_prompt(
            &writer,
            "snapshot-before",
            "快照前提示词",
            "快照正文",
            vec![tag.id.clone()],
            false,
        );
        let before_revision = library_revision(&writer).unwrap();
        let reader = open_prompt_read_connection(&path).unwrap();

        let page = list_prompts_in_snapshot(&reader, &PromptListRequest::default(), || {
            rename_prompt_tag(&writer, &tag.id, "提交后标签").unwrap();
            create_named_prompt(
                &writer,
                "snapshot-after",
                "并发提交提示词",
                "并发提交正文",
                vec![],
                false,
            );
        })
        .unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "snapshot-before");
        assert_eq!(page.items[0].tags[0].name, "快照标签");
        assert_eq!(page.library_revision, before_revision);

        let latest = list_prompts(&reader, &PromptListRequest::default()).unwrap();
        assert_eq!(latest.total, 2);
        assert_eq!(latest.library_revision, before_revision + 2);
        let original = latest
            .items
            .iter()
            .find(|item| item.id == "snapshot-before")
            .unwrap();
        assert_eq!(original.tags[0].name, "提交后标签");
    }

    #[test]
    fn prompt_detail_keeps_body_revision_and_tags_in_one_wal_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("prompt-detail-snapshot.sqlite");
        let writer = Connection::open(&path).unwrap();
        migrate_prompt_library(&writer).unwrap();
        let first_tag = create_tag(&writer, "第一版标签");
        let second_tag = create_tag(&writer, "第二版标签");
        let created = create_named_prompt(
            &writer,
            "detail-snapshot",
            "详情快照 v1",
            "详情正文 v1",
            vec![first_tag.id.clone()],
            false,
        );
        let reader = open_prompt_read_connection(&path).unwrap();

        let detail = get_prompt_detail_in_read_transaction(&reader, &created.summary.id, || {
            update_prompt(
                &writer,
                &PromptUpdateInput {
                    id: created.summary.id.clone(),
                    title: "详情快照 v2".into(),
                    content: "详情正文 v2".into(),
                    tag_ids: vec![second_tag.id.clone()],
                    pinned: None,
                    expected_revision: created.summary.revision,
                },
            )
            .unwrap();
        })
        .unwrap()
        .unwrap();

        assert_eq!(detail.summary.title, "详情快照 v1");
        assert_eq!(detail.content, "详情正文 v1");
        assert_eq!(detail.summary.revision, 1);
        assert_eq!(detail.summary.tags.len(), 1);
        assert_eq!(detail.summary.tags[0].id, first_tag.id);

        let latest = get_prompt_detail(&reader, &created.summary.id)
            .unwrap()
            .unwrap();
        assert_eq!(latest.summary.title, "详情快照 v2");
        assert_eq!(latest.content, "详情正文 v2");
        assert_eq!(latest.summary.revision, 2);
        assert_eq!(latest.summary.tags[0].id, second_tag.id);
    }

    #[test]
    fn single_markdown_export_keeps_body_and_tags_in_one_wal_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("prompt-single-export-snapshot.sqlite");
        let writer = Connection::open(&path).unwrap();
        migrate_prompt_library(&writer).unwrap();
        let first_tag = create_tag(&writer, "导出第一版标签");
        let second_tag = create_tag(&writer, "导出第二版标签");
        let created = create_named_prompt(
            &writer,
            "single-export-snapshot",
            "单篇导出 v1",
            "单篇正文 v1",
            vec![first_tag.id.clone()],
            false,
        );
        let reader = open_prompt_read_connection(&path).unwrap();
        let destination = directory.path().join("single-snapshot.md");
        let exported_at = Local
            .with_ymd_and_hms(2026, 8, 30, 12, 34, 56)
            .single()
            .unwrap();

        export_prompt_markdown_to_path_after_record_read(
            &reader,
            &created.summary.id,
            &destination,
            exported_at,
            || {
                update_prompt(
                    &writer,
                    &PromptUpdateInput {
                        id: created.summary.id.clone(),
                        title: "单篇导出 v2".into(),
                        content: "单篇正文 v2".into(),
                        tag_ids: vec![second_tag.id.clone()],
                        pinned: None,
                        expected_revision: created.summary.revision,
                    },
                )
                .unwrap();
            },
        )
        .unwrap();

        let markdown = fs::read_to_string(&destination).unwrap();
        assert!(markdown.contains("title: \"单篇导出 v1\""));
        assert!(markdown.contains("tags: [\"导出第一版标签\"]"));
        assert!(!markdown.contains("导出第二版标签"));
        assert!(markdown.ends_with("单篇正文 v1"));

        let latest = get_prompt_detail(&reader, &created.summary.id)
            .unwrap()
            .unwrap();
        assert_eq!(latest.summary.title, "单篇导出 v2");
        assert_eq!(latest.content, "单篇正文 v2");
        assert_eq!(latest.summary.revision, 2);
        assert_eq!(latest.summary.tags[0].id, second_tag.id);
    }

    #[test]
    fn public_wire_uses_total_pages_prompt_count_and_selection_mode() {
        let conn = database();
        let tag = create_tag(&conn, "角色");
        create_named_prompt(&conn, "wire", "Wire", "正文", vec![tag.id], false);
        let page = list_prompts(&conn, &PromptListRequest::default()).unwrap();
        let json = serde_json::to_value(&page).unwrap();
        assert!(json.get("totalPages").is_some());
        assert!(json["items"][0]["tags"][0].get("promptCount").is_some());
        let selection = serde_json::json!({
            "mode": "filter",
            "filter": {
                "query": "",
                "tagIds": [],
                "tagMode": "any",
                "sort": "updatedDesc"
            },
            "excludedIds": ["wire"],
            "expectedLibraryRevision": page.library_revision
        });
        let decoded: PromptSelection = serde_json::from_value(selection).unwrap();
        assert!(matches!(decoded, PromptSelection::Filter { .. }));
    }

    #[test]
    fn manual_sort_is_default_and_updated_sort_remains_available() {
        let conn = database();
        let first = create_named_prompt(&conn, "first", "第一篇", "第一版", vec![], false);
        create_named_prompt(&conn, "second", "第二篇", "正文", vec![], false);

        let manual_ids = list_prompts(&conn, &PromptListRequest::default())
            .unwrap()
            .items
            .into_iter()
            .map(|prompt| prompt.id)
            .collect::<Vec<_>>();
        assert_eq!(manual_ids, ["second", "first"]);

        update_prompt(
            &conn,
            &PromptUpdateInput {
                id: first.summary.id.clone(),
                title: first.summary.title,
                content: "第二版".into(),
                tag_ids: vec![],
                pinned: None,
                expected_revision: first.summary.revision,
            },
        )
        .unwrap();

        let manual_after_edit = list_prompts(&conn, &PromptListRequest::default())
            .unwrap()
            .items
            .into_iter()
            .map(|prompt| prompt.id)
            .collect::<Vec<_>>();
        assert_eq!(manual_after_edit, ["second", "first"]);
        let updated_ids = list_prompts(
            &conn,
            &PromptListRequest {
                sort: PromptSort::UpdatedDesc,
                ..PromptListRequest::default()
            },
        )
        .unwrap()
        .items
        .into_iter()
        .map(|prompt| prompt.id)
        .collect::<Vec<_>>();
        assert_eq!(updated_ids, ["first", "second"]);

        let default_wire: PromptListRequest = serde_json::from_value(serde_json::json!({}))
            .expect("missing sort must use the manual default");
        assert_eq!(default_wire.sort, PromptSort::Manual);
    }

    #[test]
    fn reorder_moves_between_adjacent_neighbors_without_touching_content_revision() {
        let conn = database();
        let first = create_named_prompt(&conn, "first", "第一篇", "正文", vec![], false);
        create_named_prompt(&conn, "second", "第二篇", "正文", vec![], false);
        create_named_prompt(&conn, "third", "第三篇", "正文", vec![], false);
        let before = get_prompt_detail(&conn, &first.summary.id)
            .unwrap()
            .unwrap();
        let expected_library_revision = library_revision(&conn).unwrap();

        let reordered = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: first.summary.id.clone(),
                previous_id: Some("third".into()),
                next_id: Some("second".into()),
                boundary: None,
                expected_revision: before.summary.revision,
                expected_library_revision,
            },
        )
        .unwrap();

        assert_eq!(reordered.library_revision, expected_library_revision + 1);
        let ids = list_prompts(&conn, &PromptListRequest::default())
            .unwrap()
            .items
            .into_iter()
            .map(|prompt| prompt.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["third", "first", "second"]);
        let after = get_prompt_detail(&conn, &first.summary.id)
            .unwrap()
            .unwrap();
        assert_eq!(after.summary.revision, before.summary.revision);
        assert_eq!(after.summary.updated_at, before.summary.updated_at);
    }

    #[test]
    fn reorder_rejects_neighbors_that_do_not_describe_one_visible_gap() {
        let conn = database();
        let first = create_named_prompt(&conn, "first", "第一篇", "正文", vec![], false);
        create_named_prompt(&conn, "second", "第二篇", "正文", vec![], false);
        create_named_prompt(&conn, "third", "第三篇", "正文", vec![], false);
        create_named_prompt(&conn, "fourth", "第四篇", "正文", vec![], false);
        let before_revision = library_revision(&conn).unwrap();

        let error = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: first.summary.id,
                previous_id: Some("fourth".into()),
                next_id: Some("second".into()),
                boundary: None,
                expected_revision: first.summary.revision,
                expected_library_revision: before_revision,
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "prompt_reorder_invalid_neighbors");
        assert_eq!(library_revision(&conn).unwrap(), before_revision);
        let ids = list_prompts(&conn, &PromptListRequest::default())
            .unwrap()
            .items
            .into_iter()
            .map(|prompt| prompt.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["fourth", "third", "second", "first"]);
    }

    #[test]
    fn one_sided_anchors_resolve_the_hidden_neighbor_at_page_edges() {
        let conn = database();
        for index in 0..35 {
            create_named_prompt(
                &conn,
                &format!("page-{index:02}"),
                &format!("分页 {index:02}"),
                "正文",
                vec![],
                false,
            );
        }
        let first_page = list_prompts(&conn, &PromptListRequest::default()).unwrap();
        assert_eq!(first_page.items.first().unwrap().id, "page-34");
        assert_eq!(first_page.items.last().unwrap().id, "page-05");
        let second_page = list_prompts(
            &conn,
            &PromptListRequest {
                page: 2,
                ..PromptListRequest::default()
            },
        )
        .unwrap();
        assert_eq!(second_page.items.first().unwrap().id, "page-04");

        let moved_to_page_start = get_prompt_detail(&conn, "page-34").unwrap().unwrap();
        let first_revision = library_revision(&conn).unwrap();
        reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "page-34".into(),
                previous_id: None,
                next_id: Some("page-04".into()),
                boundary: None,
                expected_revision: moved_to_page_start.summary.revision,
                expected_library_revision: first_revision,
            },
        )
        .unwrap();

        let moved_to_page_end = get_prompt_detail(&conn, "page-00").unwrap().unwrap();
        let second_revision = library_revision(&conn).unwrap();
        reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "page-00".into(),
                previous_id: Some("page-05".into()),
                next_id: None,
                boundary: None,
                expected_revision: moved_to_page_end.summary.revision,
                expected_library_revision: second_revision,
            },
        )
        .unwrap();

        let ids = list_prompts(
            &conn,
            &PromptListRequest {
                page_size: 50,
                ..PromptListRequest::default()
            },
        )
        .unwrap()
        .items
        .into_iter()
        .map(|prompt| prompt.id)
        .collect::<Vec<_>>();
        let page_boundary = ids
            .windows(4)
            .find(|window| window[0] == "page-05")
            .unwrap();
        assert_eq!(page_boundary, ["page-05", "page-00", "page-34", "page-04"]);
        for before in [moved_to_page_start, moved_to_page_end] {
            let after = get_prompt_detail(&conn, &before.summary.id)
                .unwrap()
                .unwrap();
            assert_eq!(after.summary.revision, before.summary.revision);
            assert_eq!(after.summary.updated_at, before.summary.updated_at);
        }
    }

    #[test]
    fn global_boundaries_validate_revisions_normalize_ranks_and_noop_at_the_edge() {
        let conn = database();
        create_named_prompt(&conn, "normal", "普通", "正文", vec![], false);
        let pinned_first =
            create_named_prompt(&conn, "pinned-first", "置顶一", "正文", vec![], true);
        create_named_prompt(&conn, "pinned-second", "置顶二", "正文", vec![], true);
        conn.execute(
            "UPDATE prompts SET manual_order = ?1 WHERE id = 'pinned-second'",
            [i64::MIN],
        )
        .unwrap();
        let original = get_prompt_detail(&conn, "pinned-first").unwrap().unwrap();
        let revision = library_revision(&conn).unwrap();

        let drift = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "pinned-first".into(),
                previous_id: None,
                next_id: None,
                boundary: Some(PromptReorderBoundary::First),
                expected_revision: pinned_first.summary.revision,
                expected_library_revision: revision - 1,
            },
        )
        .unwrap_err();
        assert_eq!(drift.code, "prompt_reorder_drift");
        let stale = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "pinned-first".into(),
                previous_id: None,
                next_id: None,
                boundary: Some(PromptReorderBoundary::First),
                expected_revision: pinned_first.summary.revision + 1,
                expected_library_revision: revision,
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "prompt_revision_conflict");

        let moved_first = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "pinned-first".into(),
                previous_id: None,
                next_id: None,
                boundary: Some(PromptReorderBoundary::First),
                expected_revision: pinned_first.summary.revision,
                expected_library_revision: revision,
            },
        )
        .unwrap();
        assert_eq!(moved_first.library_revision, revision + 1);
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            ["pinned-first", "pinned-second", "normal"]
        );

        let noop_first = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "pinned-first".into(),
                previous_id: None,
                next_id: None,
                boundary: Some(PromptReorderBoundary::First),
                expected_revision: pinned_first.summary.revision,
                expected_library_revision: moved_first.library_revision,
            },
        )
        .unwrap();
        assert_eq!(noop_first.library_revision, moved_first.library_revision);

        conn.execute(
            "UPDATE prompts SET manual_order = ?1 WHERE id = 'pinned-second'",
            [i64::MAX],
        )
        .unwrap();
        let moved_last = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "pinned-first".into(),
                previous_id: None,
                next_id: None,
                boundary: Some(PromptReorderBoundary::Last),
                expected_revision: pinned_first.summary.revision,
                expected_library_revision: moved_first.library_revision,
            },
        )
        .unwrap();
        assert_eq!(
            moved_last.library_revision,
            moved_first.library_revision + 1
        );
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            ["pinned-second", "pinned-first", "normal"]
        );
        let noop_last = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: "pinned-first".into(),
                previous_id: None,
                next_id: None,
                boundary: Some(PromptReorderBoundary::Last),
                expected_revision: pinned_first.summary.revision,
                expected_library_revision: moved_last.library_revision,
            },
        )
        .unwrap();
        assert_eq!(noop_last.library_revision, moved_last.library_revision);
        let after = get_prompt_detail(&conn, "pinned-first").unwrap().unwrap();
        assert_eq!(after.summary.revision, original.summary.revision);
        assert_eq!(after.summary.updated_at, original.summary.updated_at);
    }

    #[test]
    fn reorder_rejects_boundary_anchor_combinations_and_missing_destinations() {
        let conn = database();
        let first = create_named_prompt(&conn, "first", "第一篇", "正文", vec![], false);
        create_named_prompt(&conn, "second", "第二篇", "正文", vec![], false);
        let revision = library_revision(&conn).unwrap();
        for input in [
            PromptReorderInput {
                id: first.summary.id.clone(),
                previous_id: None,
                next_id: Some("second".into()),
                boundary: Some(PromptReorderBoundary::First),
                expected_revision: first.summary.revision,
                expected_library_revision: revision,
            },
            PromptReorderInput {
                id: first.summary.id.clone(),
                previous_id: None,
                next_id: None,
                boundary: None,
                expected_revision: first.summary.revision,
                expected_library_revision: revision,
            },
        ] {
            let error = reorder_prompt(&conn, &input).unwrap_err();
            assert_eq!(error.code, "prompt_reorder_invalid_request");
        }
        assert_eq!(library_revision(&conn).unwrap(), revision);

        let decoded: PromptReorderInput = serde_json::from_value(serde_json::json!({
            "id": "first",
            "previousId": null,
            "nextId": null,
            "boundary": "last",
            "expectedRevision": 1,
            "expectedLibraryRevision": revision
        }))
        .unwrap();
        assert_eq!(decoded.boundary, Some(PromptReorderBoundary::Last));
    }

    #[test]
    fn reorder_rejects_stale_revisions_and_cross_pinned_group_anchors_atomically() {
        let conn = database();
        let active = create_named_prompt(&conn, "active", "移动项", "正文", vec![], false);
        create_named_prompt(&conn, "normal", "普通锚点", "正文", vec![], false);
        create_named_prompt(&conn, "pinned", "置顶锚点", "正文", vec![], true);
        let current_library_revision = library_revision(&conn).unwrap();

        let drift = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: active.summary.id.clone(),
                previous_id: None,
                next_id: Some("normal".into()),
                boundary: None,
                expected_revision: active.summary.revision,
                expected_library_revision: current_library_revision - 1,
            },
        )
        .unwrap_err();
        assert_eq!(drift.code, "prompt_reorder_drift");

        let stale_prompt = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: active.summary.id.clone(),
                previous_id: None,
                next_id: Some("normal".into()),
                boundary: None,
                expected_revision: active.summary.revision + 1,
                expected_library_revision: current_library_revision,
            },
        )
        .unwrap_err();
        assert_eq!(stale_prompt.code, "prompt_revision_conflict");

        let pinned_boundary = reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: active.summary.id,
                previous_id: Some("pinned".into()),
                next_id: None,
                boundary: None,
                expected_revision: active.summary.revision,
                expected_library_revision: current_library_revision,
            },
        )
        .unwrap_err();
        assert_eq!(pinned_boundary.code, "prompt_reorder_pinned_boundary");
        assert_eq!(library_revision(&conn).unwrap(), current_library_revision);
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            ["pinned", "normal", "active"]
        );
    }

    #[test]
    fn reorder_normalizes_only_when_adjacent_ranks_have_no_gap() {
        let conn = database();
        let first = create_named_prompt(&conn, "first", "第一篇", "正文", vec![], false);
        create_named_prompt(&conn, "second", "第二篇", "正文", vec![], false);
        create_named_prompt(&conn, "third", "第三篇", "正文", vec![], false);
        conn.execute(
            "UPDATE prompts
             SET manual_order = CASE id
               WHEN 'third' THEN 10
               WHEN 'second' THEN 11
               ELSE 20
             END",
            [],
        )
        .unwrap();
        let before_revision = library_revision(&conn).unwrap();

        reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: first.summary.id,
                previous_id: Some("third".into()),
                next_id: Some("second".into()),
                boundary: None,
                expected_revision: first.summary.revision,
                expected_library_revision: before_revision,
            },
        )
        .unwrap();

        let ids = list_prompts(&conn, &PromptListRequest::default())
            .unwrap()
            .items
            .into_iter()
            .map(|prompt| prompt.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["third", "first", "second"]);
        let ranks = conn
            .prepare(
                "SELECT manual_order FROM prompts
                 WHERE pinned = 0 ORDER BY manual_order ASC, id ASC",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(ranks.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(library_revision(&conn).unwrap(), before_revision + 1);
    }

    #[test]
    fn pinning_from_both_public_mutations_moves_only_cross_group_items_to_the_front() {
        let conn = database();
        let normal_first =
            create_named_prompt(&conn, "normal-first", "普通一", "正文", vec![], false);
        let normal_second =
            create_named_prompt(&conn, "normal-second", "普通二", "正文", vec![], false);
        let pinned_first =
            create_named_prompt(&conn, "pinned-first", "置顶一", "正文", vec![], true);
        create_named_prompt(&conn, "pinned-second", "置顶二", "正文", vec![], true);

        let pinned = set_prompt_pinned(
            &conn,
            &normal_first.summary.id,
            true,
            normal_first.summary.revision,
        )
        .unwrap();
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            [
                "normal-first",
                "pinned-second",
                "pinned-first",
                "normal-second",
            ]
        );

        let edited = update_prompt(
            &conn,
            &PromptUpdateInput {
                id: normal_second.summary.id,
                title: normal_second.summary.title,
                content: normal_second.content,
                tag_ids: vec![],
                pinned: Some(true),
                expected_revision: normal_second.summary.revision,
            },
        )
        .unwrap();
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            [
                "normal-second",
                "normal-first",
                "pinned-second",
                "pinned-first",
            ]
        );

        update_prompt(
            &conn,
            &PromptUpdateInput {
                id: pinned_first.summary.id,
                title: pinned_first.summary.title,
                content: pinned_first.content,
                tag_ids: vec![],
                pinned: Some(true),
                expected_revision: pinned_first.summary.revision,
            },
        )
        .unwrap();
        set_prompt_pinned(&conn, &pinned.id, true, pinned.revision).unwrap();
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            [
                "normal-second",
                "normal-first",
                "pinned-second",
                "pinned-first",
            ]
        );
        assert_eq!(edited.summary.revision, normal_second.summary.revision + 1);
    }

    #[test]
    fn front_insert_and_tail_reorder_recover_from_integer_boundaries() {
        let conn = database();
        create_named_prompt(&conn, "first", "第一篇", "正文", vec![], false);
        create_named_prompt(&conn, "second", "第二篇", "正文", vec![], false);
        conn.execute(
            "UPDATE prompts SET manual_order = ?1 WHERE id = 'second'",
            [i64::MIN],
        )
        .unwrap();

        let third = create_named_prompt(&conn, "third", "第三篇", "正文", vec![], false);
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            ["third", "second", "first"]
        );

        conn.execute(
            "UPDATE prompts SET manual_order = ?1 WHERE id = 'first'",
            [i64::MAX],
        )
        .unwrap();
        let revision = library_revision(&conn).unwrap();
        reorder_prompt(
            &conn,
            &PromptReorderInput {
                id: third.summary.id,
                previous_id: Some("first".into()),
                next_id: None,
                boundary: None,
                expected_revision: third.summary.revision,
                expected_library_revision: revision,
            },
        )
        .unwrap();
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .items
                .into_iter()
                .map(|prompt| prompt.id)
                .collect::<Vec<_>>(),
            ["second", "first", "third"]
        );
    }

    #[test]
    fn crud_enforces_revision_and_pinning_does_not_touch_content_timestamp() {
        let conn = database();
        let tag = create_tag(&conn, "研究");
        let created = create_named_prompt(
            &conn,
            "prompt-one",
            "研究助手",
            "第一版正文",
            vec![tag.id.clone()],
            false,
        );
        assert_eq!(created.summary.revision, 1);
        assert_eq!(created.summary.tags[0].prompt_count, 1);
        let original_updated_at = created.summary.updated_at.clone();

        let pinned = set_prompt_pinned(&conn, "prompt-one", true, 1).unwrap();
        assert!(pinned.pinned);
        assert_eq!(pinned.revision, 2);
        assert_eq!(pinned.updated_at, original_updated_at);

        let stale = update_prompt(
            &conn,
            &PromptUpdateInput {
                id: "prompt-one".into(),
                title: "陈旧编辑".into(),
                content: "不会保存".into(),
                tag_ids: vec![],
                pinned: None,
                expected_revision: 1,
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "prompt_revision_conflict");

        let updated = update_prompt(
            &conn,
            &PromptUpdateInput {
                id: "prompt-one".into(),
                title: "研究助手 v2".into(),
                content: "第二版正文".into(),
                tag_ids: vec![tag.id],
                pinned: None,
                expected_revision: 2,
            },
        )
        .unwrap();
        assert_eq!(updated.summary.revision, 3);
        assert_eq!(updated.content, "第二版正文");
        let stale_delete = delete_prompt(&conn, "prompt-one", 2).unwrap_err();
        assert_eq!(stale_delete.code, "prompt_revision_conflict");
        delete_prompt(&conn, "prompt-one", 3).unwrap();
        assert!(get_prompt_detail(&conn, "prompt-one").unwrap().is_none());
    }

    #[test]
    fn editor_save_updates_content_tags_and_pinned_in_one_transaction() {
        let conn = database();
        let tag = create_tag(&conn, "原子标签");
        let created = create_named_prompt(&conn, "atomic-save", "旧标题", "旧正文", vec![], false);
        conn.execute_batch(
            "CREATE TRIGGER reject_atomic_link
             BEFORE INSERT ON prompt_tag_links BEGIN
               SELECT RAISE(ABORT, 'fixture link failure');
             END;",
        )
        .unwrap();
        let error = update_prompt(
            &conn,
            &PromptUpdateInput {
                id: created.summary.id.clone(),
                title: "新标题".into(),
                content: "新正文".into(),
                tag_ids: vec![tag.id.clone()],
                pinned: Some(true),
                expected_revision: created.summary.revision,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "sqlite_error");
        let unchanged = get_prompt_detail(&conn, &created.summary.id)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.summary.title, "旧标题");
        assert_eq!(unchanged.content, "旧正文");
        assert!(!unchanged.summary.pinned);
        assert!(unchanged.summary.tags.is_empty());
        assert_eq!(unchanged.summary.revision, 1);

        conn.execute_batch("DROP TRIGGER reject_atomic_link;")
            .unwrap();
        let saved = update_prompt(
            &conn,
            &PromptUpdateInput {
                id: created.summary.id,
                title: "新标题".into(),
                content: "新正文".into(),
                tag_ids: vec![tag.id],
                pinned: Some(true),
                expected_revision: 1,
            },
        )
        .unwrap();
        assert_eq!(saved.summary.title, "新标题");
        assert_eq!(saved.content, "新正文");
        assert!(saved.summary.pinned);
        assert_eq!(saved.summary.tags.len(), 1);
        assert_eq!(saved.summary.revision, 2);
    }

    #[test]
    fn content_utf8_byte_boundary_is_exact() {
        let conn = database();
        let exact = "界".repeat(PROMPT_CONTENT_MAX_BYTES / 3);
        let exact = format!("{}xx", exact);
        assert_eq!(exact.len(), PROMPT_CONTENT_MAX_BYTES);
        let created = create_named_prompt(&conn, "exact-size", "边界", &exact, vec![], false);
        assert_eq!(
            created.summary.content_bytes,
            PROMPT_CONTENT_MAX_BYTES as u64
        );

        let oversized = format!("{exact}x");
        let error = create_prompt(
            &conn,
            &PromptCreateInput {
                id: Some("too-large".into()),
                title: "太大".into(),
                content: oversized,
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "prompt_content_too_large");
    }

    #[test]
    fn bundled_sqlite_length_limit_has_documented_product_headroom() {
        let conn = database();
        let option: String = conn
            .query_row(
                "SELECT compile_options FROM pragma_compile_options
                 WHERE compile_options LIKE 'MAX_LENGTH=%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let compiled_limit = option
            .strip_prefix("MAX_LENGTH=")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap();
        assert_eq!(compiled_limit, 1_000_000_000);
        assert!(PROMPT_CONTENT_MAX_BYTES as u64 <= compiled_limit);
    }

    #[test]
    fn tags_use_trim_nfc_casefold_collision_and_explicit_merge() {
        let conn = database();
        let composed = create_tag(&conn, "  Café  ");
        let collision = create_prompt_tag(&conn, "CAFE\u{301}").unwrap_err();
        assert_eq!(collision.code, "prompt_tag_already_exists");
        let target = create_tag(&conn, "研究");
        let prompt = create_named_prompt(
            &conn,
            "tagged",
            "标签测试",
            "正文",
            vec![composed.id.clone(), target.id.clone()],
            false,
        );
        let merge_required = rename_prompt_tag(&conn, &composed.id, "研究").unwrap_err();
        assert_eq!(merge_required.code, "prompt_tag_merge_required");
        merge_prompt_tags(&conn, &composed.id, &target.id).unwrap();
        let detail = get_prompt_detail(&conn, &prompt.summary.id)
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.tags.len(), 1);
        assert_eq!(detail.summary.tags[0].id, target.id);
        delete_prompt_tag(&conn, &target.id).unwrap();
        assert!(get_prompt_detail(&conn, &prompt.summary.id)
            .unwrap()
            .unwrap()
            .summary
            .tags
            .is_empty());
    }

    #[test]
    fn merge_prompt_tags_returns_the_committed_usage_count() {
        let conn = database();
        let source = create_tag(&conn, "来源");
        let target = create_tag(&conn, "目标");
        create_named_prompt(
            &conn,
            "source-prompt",
            "来源提示词",
            "正文",
            vec![source.id.clone()],
            false,
        );
        create_named_prompt(
            &conn,
            "target-prompt",
            "目标提示词",
            "正文",
            vec![target.id.clone()],
            false,
        );

        let merged = merge_prompt_tags(&conn, &source.id, &target.id).unwrap();

        assert_eq!(merged.id, target.id);
        assert_eq!(merged.prompt_count, 2);
        assert_eq!(
            list_prompt_tags(&conn)
                .unwrap()
                .into_iter()
                .find(|tag| tag.id == target.id)
                .unwrap()
                .prompt_count,
            2
        );
    }

    #[test]
    fn search_handles_chinese_fts_short_queries_tags_and_literal_wildcards() {
        let conn = database();
        let image = create_tag(&conn, "图像");
        create_named_prompt(
            &conn,
            "research",
            "角色研究者",
            "这是完整正文，包含稀有关键字银河渡口。",
            vec![],
            false,
        );
        create_named_prompt(&conn, "image", "构图 100%", "光影", vec![image.id], false);
        assert_eq!(list_prompts(&conn, &request("银河渡口")).unwrap().total, 1);
        assert_eq!(list_prompts(&conn, &request("角色")).unwrap().total, 1);
        assert_eq!(list_prompts(&conn, &request("图像")).unwrap().total, 1);
        assert_eq!(list_prompts(&conn, &request("%")).unwrap().total, 1);
        assert_eq!(list_prompts(&conn, &request("不存在")).unwrap().total, 0);

        let detail = get_prompt_detail(&conn, "research").unwrap().unwrap();
        update_prompt(
            &conn,
            &PromptUpdateInput {
                id: "research".into(),
                title: detail.summary.title,
                content: "更新后只含新关键字珊瑚灯塔".into(),
                tag_ids: vec![],
                pinned: None,
                expected_revision: detail.summary.revision,
            },
        )
        .unwrap();
        assert_eq!(list_prompts(&conn, &request("银河渡口")).unwrap().total, 0);
        assert_eq!(list_prompts(&conn, &request("珊瑚灯塔")).unwrap().total, 1);
        prompt_fts_integrity_check(&conn).unwrap();
    }

    #[test]
    fn pagination_tag_modes_sort_and_selection_drift_are_deterministic() {
        let conn = database();
        let role = create_tag(&conn, "角色");
        let research = create_tag(&conn, "研究");
        for index in 0..31 {
            let tags = if index == 0 {
                vec![role.id.clone(), research.id.clone()]
            } else if index % 2 == 0 {
                vec![role.id.clone()]
            } else {
                vec![research.id.clone()]
            };
            create_named_prompt(
                &conn,
                &format!("p-{index:02}"),
                &format!("提示词 {index:02}"),
                "正文",
                tags,
                index == 30,
            );
        }
        let first = list_prompts(&conn, &PromptListRequest::default()).unwrap();
        assert_eq!(first.total, 31);
        assert_eq!(first.total_pages, 2);
        assert_eq!(first.items.len(), 30);
        assert_eq!(first.items[0].id, "p-30");
        let all_tags = list_prompts(
            &conn,
            &PromptListRequest {
                tag_ids: vec![role.id.clone(), research.id.clone()],
                tag_mode: PromptTagMode::All,
                ..PromptListRequest::default()
            },
        )
        .unwrap();
        assert_eq!(all_tags.total, 1);

        let revision = first.library_revision;
        let selection = PromptSelection::Filter {
            filter: PromptFilter {
                query: String::new(),
                tag_ids: vec![role.id],
                tag_mode: PromptTagMode::Any,
                sort: PromptSort::UpdatedDesc,
            },
            excluded_ids: vec!["p-00".into()],
            expected_library_revision: revision,
        };
        let selected = resolve_prompt_selection_ids(&conn, &selection).unwrap();
        assert!(!selected.contains(&"p-00".to_string()));
        create_named_prompt(&conn, "drift", "漂移", "正文", vec![], false);
        let error = resolve_prompt_selection_ids(&conn, &selection).unwrap_err();
        assert_eq!(error.code, "prompt_selection_drift");
    }

    #[test]
    fn filtered_selection_respects_manual_and_updated_sort_modes() {
        let conn = database();
        let first = create_named_prompt(&conn, "first", "第一篇", "第一版", vec![], false);
        create_named_prompt(&conn, "second", "第二篇", "正文", vec![], false);
        update_prompt(
            &conn,
            &PromptUpdateInput {
                id: first.summary.id,
                title: first.summary.title,
                content: "第二版".into(),
                tag_ids: vec![],
                pinned: None,
                expected_revision: first.summary.revision,
            },
        )
        .unwrap();
        let expected_library_revision = library_revision(&conn).unwrap();
        let selection = |sort| PromptSelection::Filter {
            filter: PromptFilter {
                query: String::new(),
                tag_ids: vec![],
                tag_mode: PromptTagMode::Any,
                sort,
            },
            excluded_ids: vec![],
            expected_library_revision,
        };

        assert_eq!(
            resolve_prompt_selection_ids(&conn, &selection(PromptSort::Manual)).unwrap(),
            ["second", "first"]
        );
        assert_eq!(
            resolve_prompt_selection_ids(&conn, &selection(PromptSort::UpdatedDesc)).unwrap(),
            ["first", "second"]
        );
    }

    #[test]
    fn pagination_clamps_to_the_last_valid_page_after_deletion() {
        let conn = database();
        for index in 0..31 {
            create_named_prompt(
                &conn,
                &format!("page-{index:02}"),
                &format!("分页提示词 {index:02}"),
                "正文",
                vec![],
                false,
            );
        }
        let second_page_request = PromptListRequest {
            page: 2,
            ..PromptListRequest::default()
        };
        let second_page = list_prompts(&conn, &second_page_request).unwrap();
        assert_eq!(second_page.items.len(), 1);
        let final_item = &second_page.items[0];
        delete_prompt(&conn, &final_item.id, final_item.revision).unwrap();

        let clamped = list_prompts(&conn, &second_page_request).unwrap();
        assert_eq!(clamped.page, 1);
        assert_eq!(clamped.total_pages, 1);
        assert_eq!(clamped.total, 30);
        assert_eq!(clamped.items.len(), 30);

        let empty = database();
        let empty_page = list_prompts(
            &empty,
            &PromptListRequest {
                page: 99,
                ..PromptListRequest::default()
            },
        )
        .unwrap();
        assert_eq!(empty_page.page, 1);
        assert_eq!(empty_page.total_pages, 1);
        assert!(empty_page.items.is_empty());
    }

    #[test]
    fn markdown_export_is_bomless_exact_and_atomic() {
        let conn = database();
        let tag = create_tag(&conn, "研究");
        let body = "# 原始正文\n\n保留  空格\n<script>alert(1)</script>";
        let detail = create_named_prompt(
            &conn,
            "export-one",
            "../危险/标题:*?",
            body,
            vec![tag.id],
            true,
        );
        let exported_at = Local
            .with_ymd_and_hms(2026, 8, 30, 12, 34, 56)
            .single()
            .unwrap();
        let markdown = render_prompt_markdown(&detail, exported_at).unwrap();
        assert!(!markdown.starts_with(&[0xEF, 0xBB, 0xBF]));
        let markdown = String::from_utf8(markdown).unwrap();
        assert!(markdown.contains("exported_at:"));
        assert!(markdown.ends_with(body));

        let directory = tempfile::tempdir().unwrap();
        let md_path = directory.path().join("single.md");
        export_prompt_markdown_to_path(&conn, "export-one", &md_path, exported_at).unwrap();
        assert!(fs::read_to_string(&md_path).unwrap().ends_with(body));
    }

    #[test]
    fn export_filename_and_path_cleaning_match_contract() {
        let now = Local
            .with_ymd_and_hms(2026, 8, 30, 1, 2, 3)
            .single()
            .unwrap();
        let md = suggested_prompt_export_file_name("md", now);
        assert!(md.starts_with("Skill-repo-tracker提示词导出_20260830010203_"));
        assert!(md.ends_with(".md"));
        for unsafe_title in ["../../etc/passwd", "a\\b/c:d*e?f", "...", "\0"] {
            let cleaned = safe_prompt_zip_title(unsafe_title);
            assert!(!cleaned.contains('/'));
            assert!(!cleaned.contains('\\'));
            assert!(!cleaned.contains(".."));
            assert!(!cleaned.is_empty());
            assert!(cleaned.len() <= 96);
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_fixture_seeder_uses_fictional_data_and_requested_scale() {
        let conn = database();
        let report = seed_debug_prompt_fixture(&conn, 20, 20_000, 7).unwrap();
        assert_eq!(report.prompt_count, 20);
        assert_eq!(report.tag_count, 7);
        assert_eq!(report.content_bytes, 20_000);
        assert_eq!(
            list_prompts(&conn, &PromptListRequest::default())
                .unwrap()
                .total,
            20
        );
        assert_eq!(list_prompt_tags(&conn).unwrap().len(), 7);
        prompt_fts_integrity_check(&conn).unwrap();
    }

    /// Release-only, opt-in performance gate for the fixed public acceptance corpus.
    ///
    /// Run with:
    /// `cargo test --release prompt_library_release_performance_gate -- --ignored --nocapture --test-threads=1`
    #[test]
    #[ignore = "release performance gate: seeds a 10,000-prompt / 100 MiB corpus"]
    fn prompt_library_release_performance_gate() {
        const PROMPT_COUNT: usize = 10_000;
        const CORPUS_BYTES: u64 = 100 * 1024 * 1024;
        // The fixture distributes bytes evenly. Replacing its first 9,963-byte body with the
        // 5 MiB boundary sample below leaves the measured corpus at exactly 100 MiB.
        const SEED_BYTES: u64 = 99_624_683;
        const TAG_COUNT: usize = 500;

        fn p95(mut samples: Vec<Duration>) -> Duration {
            assert!(!samples.is_empty());
            samples.sort_unstable();
            let rank = (samples.len() * 95).div_ceil(100);
            samples[rank.saturating_sub(1)]
        }

        fn sample_p95(count: usize, mut operation: impl FnMut()) -> Duration {
            let mut samples = Vec::with_capacity(count);
            for _ in 0..count {
                let started = Instant::now();
                operation();
                samples.push(started.elapsed());
            }
            p95(samples)
        }

        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("prompt-performance.sqlite");
        let writer = Connection::open(&database_path).unwrap();
        migrate_prompt_library(&writer).unwrap();

        let seed_started = Instant::now();
        let report =
            seed_debug_prompt_fixture(&writer, PROMPT_COUNT, SEED_BYTES, TAG_COUNT).unwrap();
        let seed_elapsed = seed_started.elapsed();
        assert_eq!(report.prompt_count, PROMPT_COUNT);
        assert_eq!(report.content_bytes, SEED_BYTES);
        assert_eq!(report.tag_count, TAG_COUNT);

        let initial_page = list_prompts(&writer, &PromptListRequest::default()).unwrap();
        assert_eq!(initial_page.total, PROMPT_COUNT as u64);
        let large_id = initial_page
            .items
            .first()
            .expect("fixture must contain a prompt")
            .id
            .clone();
        let before_large_save = get_prompt_detail(&writer, &large_id)
            .unwrap()
            .expect("fixture prompt must exist");
        let mut large_content = String::from("# 5 MiB 性能样本\n\n研究 图像 角色 示例。\n\n");
        large_content.push_str(&"y".repeat(PROMPT_CONTENT_MAX_BYTES - large_content.len()));
        assert_eq!(large_content.len(), PROMPT_CONTENT_MAX_BYTES);
        let large_tag_ids = before_large_save
            .summary
            .tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect();
        let save_started = Instant::now();
        let saved = update_prompt(
            &writer,
            &PromptUpdateInput {
                id: large_id.clone(),
                title: before_large_save.summary.title,
                content: large_content,
                tag_ids: large_tag_ids,
                pinned: Some(before_large_save.summary.pinned),
                expected_revision: before_large_save.summary.revision,
            },
        )
        .unwrap();
        let save_elapsed = save_started.elapsed();
        assert_eq!(saved.summary.content_bytes, PROMPT_CONTENT_MAX_BYTES as u64);
        let measured_corpus_bytes: u64 = writer
            .query_row(
                "SELECT SUM(length(CAST(content AS BLOB))) FROM prompts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(measured_corpus_bytes, CORPUS_BYTES);
        prompt_fts_integrity_check(&writer).unwrap();

        let reader = open_prompt_read_connection(&database_path).unwrap();
        for _ in 0..5 {
            let page = list_prompts(&reader, &PromptListRequest::default()).unwrap();
            std::hint::black_box(page.items.len());
        }
        let pagination_p95 = sample_p95(40, || {
            let page = list_prompts(&reader, &PromptListRequest::default()).unwrap();
            std::hint::black_box(page.items.len());
        });

        let three_character_request = request("虚构提");
        for _ in 0..3 {
            let page = list_prompts(&reader, &three_character_request).unwrap();
            assert_eq!(page.total, PROMPT_COUNT as u64);
        }
        let three_character_search_p95 = sample_p95(20, || {
            let page = list_prompts(&reader, &three_character_request).unwrap();
            std::hint::black_box(page.total);
        });

        let short_query_request = request("角色");
        let short_query_p95 = sample_p95(8, || {
            let page = list_prompts(&reader, &short_query_request).unwrap();
            assert_eq!(page.total, PROMPT_COUNT as u64);
        });

        let detail_p95 = sample_p95(8, || {
            let detail = get_prompt_detail(&reader, &large_id)
                .unwrap()
                .expect("5 MiB fixture prompt must exist");
            assert_eq!(
                detail.summary.content_bytes,
                PROMPT_CONTENT_MAX_BYTES as u64
            );
            std::hint::black_box(detail.content.len());
        });

        eprintln!(
            "prompt performance gate: seed={seed_elapsed:?}, pagination_p95={pagination_p95:?}, three_character_search_p95={three_character_search_p95:?}, short_query_p95={short_query_p95:?}, detail_5mib_p95={detail_p95:?}, save_5mib={save_elapsed:?}"
        );

        assert!(
            pagination_p95 <= Duration::from_millis(100),
            "warm pagination p95 {pagination_p95:?} exceeded 100ms"
        );
        assert!(
            three_character_search_p95 <= Duration::from_millis(200),
            "three-character search p95 {three_character_search_p95:?} exceeded 200ms"
        );
        assert!(
            short_query_p95 <= Duration::from_secs(1),
            "one-to-two-character query p95 {short_query_p95:?} exceeded 1s"
        );
        assert!(
            detail_p95 <= Duration::from_millis(500),
            "5 MiB detail load p95 {detail_p95:?} exceeded 500ms"
        );
        assert!(
            save_elapsed <= Duration::from_secs(2),
            "5 MiB save and FTS update {save_elapsed:?} exceeded 2s"
        );
    }
}
