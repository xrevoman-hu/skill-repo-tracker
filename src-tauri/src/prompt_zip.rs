//! Shareable prompt-library ZIP transport.
//!
//! This module is intentionally separate from the whole-app `.srtmigration`
//! transport. A share ZIP contains one human-readable Markdown file per prompt
//! plus a strict manifest; it never contains settings, tokens, task logs, or
//! source archives.

use chrono::{DateTime, Local, SecondsFormat};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tempfile::NamedTempFile;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{prompts, temp_artifacts::unique_operation_id, AppError};

const PACKAGE_FORMAT: &str = "skill-repo-tracker-prompt-library";
const SCHEMA_VERSION: u32 = 1;
const MANIFEST_PATH: &str = "manifest.json";
const MAX_PACKAGE_FILE_BYTES: u64 = 1_342_177_280;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES: u64 = 1_207_959_552;
const MAX_TOTAL_CONTENT_BYTES: u64 = 1_073_741_824;
const MAX_MANIFEST_BYTES: u64 = 67_108_864;
const MAX_PROMPT_FILE_BYTES: u64 = prompts::PROMPT_CONTENT_MAX_BYTES as u64 + 131_072;
const MAX_PROMPTS: usize = 100_000;
const MAX_UNIQUE_TAGS: usize = 100_000;
const MAX_RETAINED_METADATA_BYTES: u64 = MAX_ARCHIVE_UNCOMPRESSED_BYTES - MAX_TOTAL_CONTENT_BYTES;
const MAX_ZIP_COMMENT_BYTES: u64 = u16::MAX as u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PromptZipMetadataLimits {
    max_unique_tags: usize,
    max_metadata_bytes: u64,
}

impl Default for PromptZipMetadataLimits {
    fn default() -> Self {
        Self {
            max_unique_tags: MAX_UNIQUE_TAGS,
            max_metadata_bytes: MAX_RETAINED_METADATA_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetainedMetadataBudget {
    used: u64,
    limit: u64,
}

impl RetainedMetadataBudget {
    fn new(limit: u64) -> Self {
        Self { used: 0, limit }
    }

    fn charge(&mut self, bytes: u64, field: &str) -> Result<(), AppError> {
        let next = self.used.checked_add(bytes).ok_or_else(|| {
            AppError::with_details(
                "prompt_zip_metadata_too_large",
                "提示词分享 ZIP 的元数据大小溢出。",
                field.to_string(),
            )
        })?;
        if next > self.limit {
            return Err(AppError::with_details(
                "prompt_zip_metadata_too_large",
                "提示词分享 ZIP 的元数据超过允许上限。",
                format!(
                    "field={field}, used={}, added={bytes}, limit={}",
                    self.used, self.limit
                ),
            ));
        }
        self.used = next;
        Ok(())
    }

    fn charge_str(&mut self, value: &str, field: &str) -> Result<(), AppError> {
        self.charge(value.len() as u64, field)
    }

    fn charge_type<T>(&mut self, field: &str) -> Result<(), AppError> {
        self.charge(std::mem::size_of::<T>() as u64, field)
    }

    fn used(&self) -> u64 {
        self.used
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptZipManifestEntry {
    id: String,
    path: String,
    file_bytes: u64,
    file_sha256: String,
    content_bytes: u64,
    content_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptZipManifest {
    format: String,
    schema_version: u32,
    app_version: String,
    exported_at: String,
    prompt_count: u64,
    total_content_bytes: u64,
    entries: Vec<PromptZipManifestEntry>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn zip_error(code: &'static str, message: &'static str, details: impl Into<String>) -> AppError {
    AppError::with_details(code, message, details)
}

struct PromptZipSnapshot {
    temp: NamedTempFile,
    sha256: String,
    size_bytes: u64,
}

fn snapshot_package(path: &Path) -> Result<PromptZipSnapshot, AppError> {
    let mut source = File::open(path).map_err(|error| {
        zip_error(
            "prompt_zip_io_failed",
            "读取提示词分享 ZIP 失败。",
            error.to_string(),
        )
    })?;
    if source.metadata()?.len() > MAX_PACKAGE_FILE_BYTES {
        return Err(AppError::new(
            "prompt_zip_size_limit_exceeded",
            "提示词分享 ZIP 超过允许的文件大小。",
        ));
    }
    let mut temp = NamedTempFile::new().map_err(|error| {
        zip_error(
            "prompt_zip_io_failed",
            "创建提示词分享 ZIP 临时快照失败。",
            error.to_string(),
        )
    })?;
    let mut hasher = Sha256::new();
    let mut size_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).map_err(|error| {
            zip_error(
                "prompt_zip_io_failed",
                "读取提示词分享 ZIP 失败。",
                error.to_string(),
            )
        })?;
        if count == 0 {
            break;
        }
        size_bytes = size_bytes.checked_add(count as u64).ok_or_else(|| {
            AppError::new(
                "prompt_zip_size_limit_exceeded",
                "提示词分享 ZIP 文件大小溢出。",
            )
        })?;
        if size_bytes > MAX_PACKAGE_FILE_BYTES {
            return Err(AppError::new(
                "prompt_zip_size_limit_exceeded",
                "提示词分享 ZIP 超过允许的文件大小。",
            ));
        }
        hasher.update(&buffer[..count]);
        temp.write_all(&buffer[..count]).map_err(|error| {
            zip_error(
                "prompt_zip_io_failed",
                "写入提示词分享 ZIP 临时快照失败。",
                error.to_string(),
            )
        })?;
    }
    temp.flush()?;
    temp.as_file().sync_all()?;
    temp.as_file_mut().seek(SeekFrom::Start(0))?;
    Ok(PromptZipSnapshot {
        temp,
        sha256: hex::encode(hasher.finalize()),
        size_bytes,
    })
}

fn safe_prompt_entry_path(value: &str) -> bool {
    if value.contains('\\') || value.starts_with('/') || value.contains("//") {
        return false;
    }
    let path = Path::new(value);
    let components = path.components().collect::<Vec<_>>();
    components.len() == 2
        && components
            .iter()
            .all(|component| matches!(component, Component::Normal(_)))
        && components[0].as_os_str() == "prompts"
        && path.extension().and_then(|extension| extension.to_str()) == Some("md")
}

fn zip_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset + 2)
        .and_then(|slice| slice.try_into().ok())
        .map(u16::from_le_bytes)
}

fn zip_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(u32::from_le_bytes)
}

fn zip_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    bytes
        .get(offset..offset + 8)
        .and_then(|slice| slice.try_into().ok())
        .map(u64::from_le_bytes)
}

fn raw_zip_entry_count(file: &mut File) -> Result<u64, AppError> {
    const EOCD_SIZE: u64 = 22;
    const ZIP64_LOCATOR_SIZE: u64 = 20;
    const ZIP64_EOCD_MIN_SIZE: usize = 56;
    let file_size = file
        .metadata()
        .map_err(|error| {
            zip_error(
                "prompt_zip_io_failed",
                "读取提示词分享 ZIP 元数据失败。",
                error.to_string(),
            )
        })?
        .len();
    let tail_size = file_size.min(EOCD_SIZE + MAX_ZIP_COMMENT_BYTES);
    file.seek(SeekFrom::End(-(tail_size as i64)))
        .map_err(|error| {
            zip_error(
                "prompt_zip_io_failed",
                "定位提示词分享 ZIP 目录失败。",
                error.to_string(),
            )
        })?;
    let mut tail = vec![0_u8; tail_size as usize];
    file.read_exact(&mut tail).map_err(|error| {
        zip_error(
            "prompt_zip_io_failed",
            "读取提示词分享 ZIP 目录失败。",
            error.to_string(),
        )
    })?;
    let eocd_tail_offset = (0..=tail.len().saturating_sub(EOCD_SIZE as usize))
        .rev()
        .find(|offset| {
            tail.get(*offset..*offset + 4) == Some(&0x0605_4b50_u32.to_le_bytes())
                && zip_u16(&tail, *offset + 20).is_some_and(|comment_size| {
                    *offset + EOCD_SIZE as usize + comment_size as usize == tail.len()
                })
        })
        .ok_or_else(|| {
            AppError::new(
                "prompt_zip_manifest_invalid",
                "提示词分享 ZIP 缺少有效的中央目录结束记录。",
            )
        })?;
    let disk = zip_u16(&tail, eocd_tail_offset + 4).unwrap_or(u16::MAX);
    let central_disk = zip_u16(&tail, eocd_tail_offset + 6).unwrap_or(u16::MAX);
    let entries_on_disk = zip_u16(&tail, eocd_tail_offset + 8).unwrap_or(u16::MAX);
    let total_entries = zip_u16(&tail, eocd_tail_offset + 10).unwrap_or(u16::MAX);
    if disk != 0 || central_disk != 0 || entries_on_disk != total_entries {
        return Err(AppError::new(
            "prompt_zip_manifest_invalid",
            "不支持跨卷提示词分享 ZIP。",
        ));
    }
    if total_entries != u16::MAX {
        return Ok(total_entries as u64);
    }

    let eocd_file_offset = file_size - tail_size + eocd_tail_offset as u64;
    if eocd_file_offset < ZIP64_LOCATOR_SIZE {
        return Ok(u16::MAX as u64);
    }
    file.seek(SeekFrom::Start(eocd_file_offset - ZIP64_LOCATOR_SIZE))
        .map_err(|error| {
            zip_error(
                "prompt_zip_io_failed",
                "定位 ZIP64 目录失败。",
                error.to_string(),
            )
        })?;
    let mut locator = [0_u8; ZIP64_LOCATOR_SIZE as usize];
    file.read_exact(&mut locator).map_err(|error| {
        zip_error(
            "prompt_zip_io_failed",
            "读取 ZIP64 目录定位器失败。",
            error.to_string(),
        )
    })?;
    if zip_u32(&locator, 0) != Some(0x0706_4b50) {
        return Ok(u16::MAX as u64);
    }
    if zip_u32(&locator, 4) != Some(0) || zip_u32(&locator, 16) != Some(1) {
        return Err(AppError::new(
            "prompt_zip_manifest_invalid",
            "不支持跨卷 ZIP64 提示词分享包。",
        ));
    }
    let zip64_offset = zip_u64(&locator, 8).ok_or_else(|| {
        AppError::new("prompt_zip_manifest_invalid", "ZIP64 中央目录定位器无效。")
    })?;
    file.seek(SeekFrom::Start(zip64_offset)).map_err(|error| {
        zip_error(
            "prompt_zip_io_failed",
            "定位 ZIP64 中央目录失败。",
            error.to_string(),
        )
    })?;
    let mut zip64 = [0_u8; ZIP64_EOCD_MIN_SIZE];
    file.read_exact(&mut zip64).map_err(|error| {
        zip_error(
            "prompt_zip_io_failed",
            "读取 ZIP64 中央目录失败。",
            error.to_string(),
        )
    })?;
    if zip_u32(&zip64, 0) != Some(0x0606_4b50)
        || !matches!(zip_u64(&zip64, 4), Some(size) if size >= 44)
        || zip_u32(&zip64, 16) != Some(0)
        || zip_u32(&zip64, 20) != Some(0)
    {
        return Err(AppError::new(
            "prompt_zip_manifest_invalid",
            "ZIP64 中央目录记录无效。",
        ));
    }
    let entries_on_disk = zip_u64(&zip64, 24).unwrap_or(u64::MAX);
    let total_entries = zip_u64(&zip64, 32).unwrap_or(u64::MAX);
    if entries_on_disk != total_entries {
        return Err(AppError::new(
            "prompt_zip_manifest_invalid",
            "不支持跨卷 ZIP64 提示词分享包。",
        ));
    }
    Ok(total_entries)
}

fn validate_archive_layout(
    archive: &mut ZipArchive<File>,
) -> Result<HashMap<String, (u64, u64)>, AppError> {
    let mut entries = HashMap::new();
    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| {
            zip_error(
                "prompt_zip_manifest_invalid",
                "提示词分享 ZIP 目录损坏。",
                error.to_string(),
            )
        })?;
        let name = std::str::from_utf8(file.name_raw())
            .map_err(|error| {
                zip_error(
                    "prompt_zip_utf8_invalid",
                    "提示词分享 ZIP 条目路径不是有效的 UTF-8 文本。",
                    error.to_string(),
                )
            })?
            .to_string();
        let safe_name = name == MANIFEST_PATH || safe_prompt_entry_path(&name);
        let symlink = file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000);
        if !safe_name || file.is_dir() || symlink || file.enclosed_name().is_none() {
            return Err(zip_error(
                "prompt_zip_path_unsafe",
                "提示词分享 ZIP 包含不安全的条目路径。",
                name,
            ));
        }
        if entries
            .insert(name.clone(), (file.size(), file.compressed_size()))
            .is_some()
        {
            return Err(zip_error(
                "prompt_zip_duplicate_entry",
                "提示词分享 ZIP 包含重复条目。",
                name,
            ));
        }
        total_uncompressed = total_uncompressed.checked_add(file.size()).ok_or_else(|| {
            AppError::new(
                "prompt_zip_size_limit_exceeded",
                "提示词分享 ZIP 解压大小溢出。",
            )
        })?;
        if total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err(AppError::new(
                "prompt_zip_size_limit_exceeded",
                "提示词分享 ZIP 解压后的总大小超过允许上限。",
            ));
        }
    }
    if !entries.contains_key(MANIFEST_PATH) {
        return Err(AppError::new(
            "prompt_zip_legacy_unsupported",
            "该 ZIP 没有 manifest.json，属于不支持回导的旧版提示词导出格式。",
        ));
    }
    Ok(entries)
}

fn read_exact_bounded(
    reader: impl Read,
    declared_size: u64,
    limit: u64,
    path: &str,
) -> Result<Vec<u8>, AppError> {
    if declared_size > limit {
        return Err(zip_error(
            "prompt_zip_size_limit_exceeded",
            "提示词分享 ZIP 条目超过允许大小。",
            path.to_string(),
        ));
    }
    let capacity = declared_size.min(limit).min(usize::MAX as u64) as usize;
    let mut bytes = Vec::with_capacity(capacity);
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| {
            zip_error(
                "prompt_zip_io_failed",
                "读取提示词分享 ZIP 条目失败。",
                format!("{path}: {error}"),
            )
        })?;
    if bytes.len() as u64 > limit {
        return Err(zip_error(
            "prompt_zip_size_limit_exceeded",
            "提示词分享 ZIP 条目实际解压大小超过允许上限。",
            path.to_string(),
        ));
    }
    if bytes.len() as u64 != declared_size {
        return Err(zip_error(
            "prompt_zip_manifest_invalid",
            "提示词分享 ZIP 条目实际大小与 ZIP 目录不一致。",
            path.to_string(),
        ));
    }
    Ok(bytes)
}

fn read_bounded_entry(
    archive: &mut ZipArchive<File>,
    path: &str,
    limit: u64,
) -> Result<Vec<u8>, AppError> {
    let mut entry = archive.by_name(path).map_err(|error| {
        zip_error(
            "prompt_zip_manifest_invalid",
            "提示词分享 ZIP 缺少清单声明的条目。",
            format!("{path}: {error}"),
        )
    })?;
    let declared_size = entry.size();
    read_exact_bounded(&mut entry, declared_size, limit, path)
}

fn reject_bom(bytes: &[u8], path: &str) -> Result<(), AppError> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(zip_error(
            "prompt_zip_bom_forbidden",
            "提示词分享 ZIP 只接受 UTF-8 无 BOM 文本。",
            path.to_string(),
        ));
    }
    Ok(())
}

fn read_manifest(archive: &mut ZipArchive<File>) -> Result<PromptZipManifest, AppError> {
    let bytes = read_bounded_entry(archive, MANIFEST_PATH, MAX_MANIFEST_BYTES)?;
    reject_bom(&bytes, MANIFEST_PATH)?;
    let text = std::str::from_utf8(&bytes).map_err(|error| {
        zip_error(
            "prompt_zip_utf8_invalid",
            "提示词分享 ZIP 的 manifest.json 不是有效的 UTF-8 文本。",
            error.to_string(),
        )
    })?;
    serde_json::from_str(text).map_err(|error| {
        zip_error(
            "prompt_zip_manifest_invalid",
            "提示词分享 ZIP 的 manifest.json 无效。",
            error.to_string(),
        )
    })
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
        Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词分享 ZIP 中的提示词 ID 无效。",
            value.to_string(),
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IncomingTag {
    display: String,
    key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IncomingPromptMeta {
    id: String,
    title: String,
    content_sha256: String,
    tags: Vec<IncomingTag>,
}

#[derive(Debug)]
struct IncomingPromptRecord {
    meta: IncomingPromptMeta,
    content: String,
}

fn charge_manifest_metadata(
    budget: &mut RetainedMetadataBudget,
    manifest: &PromptZipManifest,
) -> Result<(), AppError> {
    budget.charge_type::<PromptZipManifest>("manifest")?;
    budget.charge_str(&manifest.format, "manifest.format")?;
    budget.charge_str(&manifest.app_version, "manifest.appVersion")?;
    budget.charge_str(&manifest.exported_at, "manifest.exportedAt")?;
    for entry in &manifest.entries {
        budget.charge_type::<PromptZipManifestEntry>("manifest.entries[]")?;
        budget.charge_str(&entry.id, "manifest.entries[].id")?;
        budget.charge_str(&entry.path, "manifest.entries[].path")?;
        budget.charge_str(&entry.file_sha256, "manifest.entries[].fileSha256")?;
        budget.charge_str(&entry.content_sha256, "manifest.entries[].contentSha256")?;
    }
    Ok(())
}

fn charge_incoming_prompt_metadata(
    budget: &mut RetainedMetadataBudget,
    prompt: &IncomingPromptMeta,
) -> Result<(), AppError> {
    budget.charge_type::<IncomingPromptMeta>("prompts[]")?;
    budget.charge_str(&prompt.id, "prompts[].id")?;
    budget.charge_str(&prompt.title, "prompts[].title")?;
    budget.charge_str(&prompt.content_sha256, "prompts[].contentSha256")?;
    for tag in &prompt.tags {
        budget.charge_type::<IncomingTag>("prompts[].tags[]")?;
        budget.charge_str(&tag.display, "prompts[].tags[].display")?;
        budget.charge_str(&tag.key, "prompts[].tags[].key")?;
    }
    Ok(())
}

fn insert_package_tag(
    package_tags: &mut HashMap<String, String>,
    tag: &IncomingTag,
    max_unique_tags: usize,
    budget: &mut RetainedMetadataBudget,
) -> Result<(), AppError> {
    if package_tags.contains_key(&tag.key) {
        return Ok(());
    }
    if package_tags.len() >= max_unique_tags {
        return Err(AppError::new(
            "prompt_zip_too_many_tags",
            "提示词分享 ZIP 中的唯一标签数量超过 100,000 个上限。",
        ));
    }
    budget.charge_type::<(String, String)>("packageTags[]")?;
    budget.charge_str(&tag.key, "packageTags[].key")?;
    budget.charge_str(&tag.display, "packageTags[].display")?;
    package_tags.insert(tag.key.clone(), tag.display.clone());
    Ok(())
}

#[derive(Debug)]
struct ParsedFrontMatter {
    id: String,
    title: String,
    tags: Vec<String>,
    pinned: bool,
    created_at: String,
    updated_at: String,
    exported_at: String,
}

fn normalize_incoming_tags(values: Vec<String>, path: &str) -> Result<Vec<IncomingTag>, AppError> {
    if values.len() > prompts::PROMPT_MAX_TAGS {
        return Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "单篇提示词最多包含 20 个标签。",
            path.to_string(),
        ));
    }
    let mut seen = HashSet::new();
    let mut tags = Vec::with_capacity(values.len());
    for value in values {
        let normalized = prompts::normalize_tag_name(&value).map_err(|error| {
            zip_error(
                "prompt_zip_frontmatter_invalid",
                "提示词 Markdown 包含无效的标签名称。",
                format!("{path}: {}", error.message),
            )
        })?;
        if seen.insert(normalized.key.clone()) {
            tags.push(IncomingTag {
                display: normalized.display,
                key: normalized.key,
            });
        }
    }
    Ok(tags)
}

fn parse_json_field<T: for<'de> Deserialize<'de>>(
    fields: &HashMap<&str, &str>,
    field: &'static str,
    path: &str,
) -> Result<T, AppError> {
    let value = fields.get(field).ok_or_else(|| {
        zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown front matter 缺少必填字段。",
            format!("{path}: {field}"),
        )
    })?;
    serde_json::from_str(value).map_err(|error| {
        zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown front matter 字段格式无效。",
            format!("{path}: {field}: {error}"),
        )
    })
}

fn parse_markdown<'a>(
    bytes: &'a [u8],
    path: &str,
) -> Result<(ParsedFrontMatter, &'a str), AppError> {
    reject_bom(bytes, path)?;
    let text = std::str::from_utf8(bytes).map_err(|error| {
        zip_error(
            "prompt_zip_utf8_invalid",
            "提示词 Markdown 不是有效的 UTF-8 文本。",
            format!("{path}: {error}"),
        )
    })?;
    if !text.starts_with("---\n") {
        return Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown front matter 起始标记无效。",
            path.to_string(),
        ));
    }
    let rest = &text[4..];
    let delimiter = rest.find("\n---\n").ok_or_else(|| {
        zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown front matter 缺少结束标记。",
            path.to_string(),
        )
    })?;
    let header = &rest[..delimiter];
    let content = &rest[delimiter + 5..];
    if header.contains('\r') {
        return Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown front matter 必须使用 LF 换行。",
            path.to_string(),
        ));
    }
    let allowed = [
        "id",
        "title",
        "tags",
        "pinned",
        "created_at",
        "updated_at",
        "exported_at",
    ];
    let mut fields = HashMap::new();
    for line in header.lines() {
        let Some((key, value)) = line.split_once(": ") else {
            return Err(zip_error(
                "prompt_zip_frontmatter_invalid",
                "提示词 Markdown front matter 行格式无效。",
                format!("{path}: {line}"),
            ));
        };
        if !allowed.contains(&key) {
            return Err(zip_error(
                "prompt_zip_frontmatter_invalid",
                "提示词 Markdown front matter 包含未知字段。",
                format!("{path}: {key}"),
            ));
        }
        if fields.insert(key, value).is_some() {
            return Err(zip_error(
                "prompt_zip_frontmatter_invalid",
                "提示词 Markdown front matter 包含重复字段。",
                format!("{path}: {key}"),
            ));
        }
    }
    if fields.len() != allowed.len() {
        return Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown front matter 字段不完整。",
            path.to_string(),
        ));
    }
    let parsed = ParsedFrontMatter {
        id: parse_json_field(&fields, "id", path)?,
        title: parse_json_field(&fields, "title", path)?,
        tags: parse_json_field(&fields, "tags", path)?,
        pinned: parse_json_field(&fields, "pinned", path)?,
        created_at: parse_json_field(&fields, "created_at", path)?,
        updated_at: parse_json_field(&fields, "updated_at", path)?,
        exported_at: parse_json_field(&fields, "exported_at", path)?,
    };
    Ok((parsed, content))
}

fn validate_manifest(
    manifest: &PromptZipManifest,
    archive_entries: &HashMap<String, (u64, u64)>,
) -> Result<(), AppError> {
    if manifest.format != PACKAGE_FORMAT || manifest.schema_version != SCHEMA_VERSION {
        return Err(AppError::new(
            "prompt_zip_schema_unsupported",
            "该提示词分享 ZIP 的格式或版本不受支持。",
        ));
    }
    DateTime::parse_from_rfc3339(&manifest.exported_at).map_err(|error| {
        zip_error(
            "prompt_zip_manifest_invalid",
            "manifest.json 的导出时间无效。",
            error.to_string(),
        )
    })?;
    if manifest.entries.is_empty()
        || manifest.entries.len() > MAX_PROMPTS
        || manifest.prompt_count != manifest.entries.len() as u64
    {
        return Err(AppError::new(
            "prompt_zip_manifest_invalid",
            "manifest.json 的提示词数量无效。",
        ));
    }
    if archive_entries.len() != manifest.entries.len() + 1 {
        return Err(AppError::new(
            "prompt_zip_extra_entry",
            "提示词分享 ZIP 包含 manifest.json 未声明的额外文件。",
        ));
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    let mut total_content_bytes = 0_u64;
    for entry in &manifest.entries {
        validate_public_id(&entry.id)?;
        if !ids.insert(entry.id.as_str()) {
            return Err(zip_error(
                "prompt_zip_duplicate_prompt",
                "manifest.json 包含重复的提示词 ID。",
                entry.id.clone(),
            ));
        }
        if !safe_prompt_entry_path(&entry.path) {
            return Err(zip_error(
                "prompt_zip_path_unsafe",
                "manifest.json 包含不安全的提示词路径。",
                entry.path.clone(),
            ));
        }
        if !paths.insert(entry.path.as_str()) {
            return Err(zip_error(
                "prompt_zip_duplicate_entry",
                "manifest.json 包含重复的提示词路径。",
                entry.path.clone(),
            ));
        }
        let Some((archive_bytes, _)) = archive_entries.get(&entry.path) else {
            return Err(zip_error(
                "prompt_zip_manifest_invalid",
                "manifest.json 引用了 ZIP 中不存在的提示词文件。",
                entry.path.clone(),
            ));
        };
        if *archive_bytes != entry.file_bytes
            || entry.file_bytes > MAX_PROMPT_FILE_BYTES
            || entry.content_bytes > prompts::PROMPT_CONTENT_MAX_BYTES as u64
        {
            return Err(zip_error(
                "prompt_zip_size_limit_exceeded",
                "manifest.json 中的提示词大小无效。",
                entry.path.clone(),
            ));
        }
        if !valid_sha256(&entry.file_sha256) || !valid_sha256(&entry.content_sha256) {
            return Err(zip_error(
                "prompt_zip_manifest_invalid",
                "manifest.json 中的 SHA-256 无效。",
                entry.path.clone(),
            ));
        }
        total_content_bytes = total_content_bytes
            .checked_add(entry.content_bytes)
            .ok_or_else(|| {
                AppError::new("prompt_zip_size_limit_exceeded", "提示词正文总大小溢出。")
            })?;
        if total_content_bytes > MAX_TOTAL_CONTENT_BYTES {
            return Err(AppError::new(
                "prompt_zip_size_limit_exceeded",
                "提示词正文总大小超过允许上限。",
            ));
        }
    }
    if total_content_bytes != manifest.total_content_bytes {
        return Err(AppError::new(
            "prompt_zip_manifest_invalid",
            "manifest.json 的正文总大小与条目汇总不一致。",
        ));
    }
    Ok(())
}

fn read_incoming_prompt(
    archive: &mut ZipArchive<File>,
    manifest: &PromptZipManifest,
    entry: &PromptZipManifestEntry,
) -> Result<IncomingPromptRecord, AppError> {
    let bytes = read_bounded_entry(archive, &entry.path, MAX_PROMPT_FILE_BYTES)?;
    if bytes.len() as u64 != entry.file_bytes
        || !entry.file_sha256.eq_ignore_ascii_case(&sha256_hex(&bytes))
    {
        return Err(zip_error(
            "prompt_zip_entry_hash_mismatch",
            "提示词 Markdown 文件摘要或大小与 manifest.json 不一致。",
            entry.path.clone(),
        ));
    }
    let (frontmatter, content) = parse_markdown(&bytes, &entry.path)?;
    let _ = frontmatter.pinned;
    if frontmatter.id != entry.id {
        return Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown ID 与 manifest.json 不一致。",
            entry.path.clone(),
        ));
    }
    let title = prompts::validate_prompt_title(&frontmatter.title).map_err(|error| {
        zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown 标题无效。",
            format!("{}: {}", entry.path, error.message),
        )
    })?;
    if title != frontmatter.title {
        return Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown 标题不是规范化文本。",
            entry.path.clone(),
        ));
    }
    if content.len() > prompts::PROMPT_CONTENT_MAX_BYTES {
        return Err(zip_error(
            "prompt_zip_size_limit_exceeded",
            "提示词 Markdown 正文超过 5 MiB 上限。",
            entry.path.clone(),
        ));
    }
    prompts::validate_prompt_content(content).map_err(|error| {
        zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown 正文无效。",
            format!("{}: {}", entry.path, error.message),
        )
    })?;
    if content.len() as u64 != entry.content_bytes
        || !entry
            .content_sha256
            .eq_ignore_ascii_case(&sha256_hex(content.as_bytes()))
    {
        return Err(zip_error(
            "prompt_zip_entry_hash_mismatch",
            "提示词正文摘要或大小与 manifest.json 不一致。",
            entry.path.clone(),
        ));
    }
    for (name, value) in [
        ("created_at", &frontmatter.created_at),
        ("updated_at", &frontmatter.updated_at),
        ("exported_at", &frontmatter.exported_at),
    ] {
        DateTime::parse_from_rfc3339(value).map_err(|error| {
            zip_error(
                "prompt_zip_frontmatter_invalid",
                "提示词 Markdown 时间字段无效。",
                format!("{}: {name}: {error}", entry.path),
            )
        })?;
    }
    if frontmatter.exported_at != manifest.exported_at {
        return Err(zip_error(
            "prompt_zip_frontmatter_invalid",
            "提示词 Markdown 导出时间与 manifest.json 不一致。",
            entry.path.clone(),
        ));
    }
    let tags = normalize_incoming_tags(frontmatter.tags, &entry.path)?;
    Ok(IncomingPromptRecord {
        meta: IncomingPromptMeta {
            id: entry.id.clone(),
            title,
            content_sha256: entry.content_sha256.to_lowercase(),
            tags,
        },
        content: content.to_string(),
    })
}

struct ParsedPromptZip {
    manifest: PromptZipManifest,
    incoming: Vec<IncomingPromptMeta>,
    package_tags: HashMap<String, String>,
    metadata_bytes: u64,
}

pub(crate) struct PreparedPromptZipImport {
    source_path: PathBuf,
    snapshot: PromptZipSnapshot,
    parsed: ParsedPromptZip,
}

fn inspect_snapshot_with_limits(
    snapshot: &PromptZipSnapshot,
    limits: PromptZipMetadataLimits,
) -> Result<ParsedPromptZip, AppError> {
    let mut file = snapshot.temp.reopen()?;
    let raw_entry_count = raw_zip_entry_count(&mut file)?;
    file.seek(SeekFrom::Start(0))?;
    let mut archive = ZipArchive::new(file).map_err(|error| {
        zip_error(
            "prompt_zip_manifest_invalid",
            "所选文件不是有效的提示词分享 ZIP。",
            error.to_string(),
        )
    })?;
    if raw_entry_count != archive.len() as u64 {
        return Err(AppError::new(
            "prompt_zip_duplicate_entry",
            "提示词分享 ZIP 包含重复条目。",
        ));
    }
    let layout = validate_archive_layout(&mut archive)?;
    let manifest = read_manifest(&mut archive)?;
    validate_manifest(&manifest, &layout)?;
    let mut budget = RetainedMetadataBudget::new(limits.max_metadata_bytes);
    charge_manifest_metadata(&mut budget, &manifest)?;
    budget.charge_type::<Vec<IncomingPromptMeta>>("prompts")?;
    budget.charge_type::<HashMap<String, String>>("packageTags")?;
    let mut incoming = Vec::with_capacity(manifest.entries.len());
    let mut package_tags = HashMap::new();
    for entry in &manifest.entries {
        let prompt = read_incoming_prompt(&mut archive, &manifest, entry)?.meta;
        charge_incoming_prompt_metadata(&mut budget, &prompt)?;
        for tag in &prompt.tags {
            insert_package_tag(&mut package_tags, tag, limits.max_unique_tags, &mut budget)?;
        }
        incoming.push(prompt);
    }
    Ok(ParsedPromptZip {
        manifest,
        incoming,
        package_tags,
        metadata_bytes: budget.used(),
    })
}

fn prepare_prompt_zip_path_with_limits(
    path: &Path,
    limits: PromptZipMetadataLimits,
) -> Result<PreparedPromptZipImport, AppError> {
    let snapshot = snapshot_package(path)?;
    let parsed = inspect_snapshot_with_limits(&snapshot, limits)?;
    Ok(PreparedPromptZipImport {
        source_path: path.to_path_buf(),
        snapshot,
        parsed,
    })
}

fn prepare_prompt_zip_path(path: &Path) -> Result<PreparedPromptZipImport, AppError> {
    prepare_prompt_zip_path_with_limits(path, PromptZipMetadataLimits::default())
}

fn prompt_id_short_code(id: &str) -> String {
    let code = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    if code.is_empty() {
        hex::encode(&Sha256::digest(id.as_bytes())[..4])
    } else {
        code
    }
}

fn unique_zip_entry_name(
    index: usize,
    detail: &prompts::PromptDetail,
    used: &mut HashSet<String>,
) -> String {
    let title = prompts::safe_prompt_zip_title(&detail.summary.title);
    let short_code = prompt_id_short_code(&detail.summary.id);
    let base = format!("prompts/{:04}_{title}_{short_code}", index + 1);
    let mut candidate = format!("{base}.md");
    let mut duplicate = 2usize;
    while !used.insert(candidate.clone()) {
        candidate = format!("{base}_{duplicate}.md");
        duplicate += 1;
    }
    candidate
}

fn read_prompt_tags(
    conn: &Connection,
    prompt_row_id: i64,
) -> Result<Vec<prompts::PromptTag>, AppError> {
    let mut statement = conn.prepare(
        "SELECT t.id, t.name, t.created_at, t.updated_at,
                (SELECT COUNT(*) FROM prompt_tag_links usage WHERE usage.tag_row_id = t.row_id)
         FROM prompt_tags t
         INNER JOIN prompt_tag_links l ON l.tag_row_id = t.row_id
         WHERE l.prompt_row_id = ?1
         ORDER BY t.normalized_name ASC, t.id ASC",
    )?;
    let rows = statement.query_map([prompt_row_id], |row| {
        Ok(prompts::PromptTag {
            id: row.get(0)?,
            name: row.get(1)?,
            prompt_count: row.get(4)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn read_prompt_detail(
    conn: &Connection,
    id: &str,
) -> Result<Option<prompts::PromptDetail>, AppError> {
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
    Ok(Some(prompts::PromptDetail {
        summary: prompts::PromptSummary {
            id,
            title,
            excerpt,
            tags: read_prompt_tags(conn, row_id)?,
            pinned,
            content_bytes,
            created_at,
            updated_at,
            revision,
        },
        content,
    }))
}

fn validate_export_package_limits(
    prompt_count: usize,
    total_content_bytes: u64,
    prompt_files_bytes: u64,
    manifest_bytes: u64,
    package_file_bytes: u64,
) -> Result<(), AppError> {
    if prompt_count > MAX_PROMPTS
        || total_content_bytes > MAX_TOTAL_CONTENT_BYTES
        || manifest_bytes > MAX_MANIFEST_BYTES
        || package_file_bytes > MAX_PACKAGE_FILE_BYTES
    {
        return Err(AppError::new(
            "prompt_zip_size_limit_exceeded",
            "提示词分享 ZIP 超过允许的数量或大小上限。",
        ));
    }
    let archive_uncompressed_bytes =
        prompt_files_bytes
            .checked_add(manifest_bytes)
            .ok_or_else(|| {
                AppError::new(
                    "prompt_zip_size_limit_exceeded",
                    "提示词分享 ZIP 解压大小溢出。",
                )
            })?;
    if archive_uncompressed_bytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
        return Err(AppError::new(
            "prompt_zip_size_limit_exceeded",
            "提示词分享 ZIP 解压后的总大小超过允许上限。",
        ));
    }
    Ok(())
}

fn validate_destination(destination: &Path) -> Result<&Path, AppError> {
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

fn persist_temp_file(temp: NamedTempFile, destination: &Path) -> Result<(), AppError> {
    temp.persist(destination)
        .map_err(|error| AppError::from(error.error))?;
    File::open(validate_destination(destination)?)?.sync_all()?;
    Ok(())
}

fn persist_export_with_revision_guard(
    conn: &Connection,
    temp: NamedTempFile,
    destination: &Path,
    selection: &prompts::PromptSelection,
) -> Result<(), AppError> {
    let prompts::PromptSelection::Filter {
        expected_library_revision,
        ..
    } = selection
    else {
        return persist_temp_file(temp, destination);
    };
    let verify = |connection: &Connection| -> Result<(), AppError> {
        let actual = prompts::library_revision(connection)?;
        if actual != *expected_library_revision {
            return Err(AppError::with_details(
                "prompt_selection_drift",
                "提示词库在批量导出期间发生变化，请重新确认选择范围。",
                format!("expected={expected_library_revision}, actual={actual}"),
            ));
        }
        Ok(())
    };
    if let Some(database_path) = conn.path().filter(|path| !path.is_empty()) {
        let guard_conn = Connection::open_with_flags(
            Path::new(database_path),
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        guard_conn.busy_timeout(Duration::from_secs(5))?;
        let guard = Transaction::new_unchecked(&guard_conn, TransactionBehavior::Immediate)?;
        verify(&guard)?;
        persist_temp_file(temp, destination)?;
        guard.commit()?;
        return Ok(());
    }
    verify(conn)?;
    persist_temp_file(temp, destination)
}

fn export_prompts_zip_in_snapshot_with_limits(
    conn: &Connection,
    selection: &prompts::PromptSelection,
    destination: &Path,
    exported_at: DateTime<Local>,
    app_version: &str,
    metadata_limits: PromptZipMetadataLimits,
    before_snapshot_release: impl FnOnce(),
) -> Result<prompts::PromptExportArtifact, AppError> {
    let snapshot = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let ids = prompts::resolve_prompt_selection_ids(&snapshot, selection)?;
    if ids.is_empty() {
        return Err(AppError::new(
            "prompt_export_empty_selection",
            "请至少选择一篇提示词再导出。",
        ));
    }
    validate_export_package_limits(ids.len(), 0, 0, 0, 0)?;
    let parent = validate_destination(destination)?;
    let mut temp = NamedTempFile::new_in(parent)?;
    let mut entries = Vec::with_capacity(ids.len());
    let mut total_content_bytes = 0_u64;
    let mut prompt_files_bytes = 0_u64;
    let manifest_bytes;
    let mut used_names = HashSet::new();
    let mut package_tags = HashMap::new();
    let mut metadata_budget = RetainedMetadataBudget::new(metadata_limits.max_metadata_bytes);
    metadata_budget.charge_type::<Vec<IncomingPromptMeta>>("prompts")?;
    metadata_budget.charge_type::<HashMap<String, String>>("packageTags")?;
    {
        let mut archive = ZipWriter::new(temp.as_file_mut());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (index, id) in ids.iter().enumerate() {
            let detail = read_prompt_detail(&snapshot, id)?.ok_or_else(|| {
                AppError::with_details(
                    "prompt_not_found",
                    "导出期间提示词不存在或已被删除。",
                    id.clone(),
                )
            })?;
            let path = unique_zip_entry_name(index, &detail, &mut used_names);
            let markdown = prompts::render_prompt_markdown(&detail, exported_at)?;
            if markdown.len() as u64 > MAX_PROMPT_FILE_BYTES {
                return Err(zip_error(
                    "prompt_zip_size_limit_exceeded",
                    "导出的提示词 Markdown 超过允许大小。",
                    detail.summary.id,
                ));
            }
            let content_bytes = detail.content.len() as u64;
            total_content_bytes =
                total_content_bytes
                    .checked_add(content_bytes)
                    .ok_or_else(|| {
                        AppError::new("prompt_zip_size_limit_exceeded", "提示词正文总大小溢出。")
                    })?;
            prompt_files_bytes = prompt_files_bytes
                .checked_add(markdown.len() as u64)
                .ok_or_else(|| {
                    AppError::new(
                        "prompt_zip_size_limit_exceeded",
                        "提示词 Markdown 总大小溢出。",
                    )
                })?;
            validate_export_package_limits(
                ids.len(),
                total_content_bytes,
                prompt_files_bytes,
                0,
                0,
            )?;
            let content_sha256 = sha256_hex(detail.content.as_bytes());
            let incoming_tags = detail
                .summary
                .tags
                .iter()
                .map(|tag| {
                    let normalized = prompts::normalize_tag_name(&tag.name)?;
                    Ok(IncomingTag {
                        display: normalized.display,
                        key: normalized.key,
                    })
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            let incoming_meta = IncomingPromptMeta {
                id: detail.summary.id.clone(),
                title: detail.summary.title.clone(),
                content_sha256: content_sha256.clone(),
                tags: incoming_tags,
            };
            charge_incoming_prompt_metadata(&mut metadata_budget, &incoming_meta)?;
            for tag in &incoming_meta.tags {
                insert_package_tag(
                    &mut package_tags,
                    tag,
                    metadata_limits.max_unique_tags,
                    &mut metadata_budget,
                )?;
            }
            archive.start_file(&path, options)?;
            archive.write_all(&markdown)?;
            entries.push(PromptZipManifestEntry {
                id: detail.summary.id,
                path,
                file_bytes: markdown.len() as u64,
                file_sha256: sha256_hex(&markdown),
                content_bytes,
                content_sha256,
            });
        }
        let manifest = PromptZipManifest {
            format: PACKAGE_FORMAT.to_string(),
            schema_version: SCHEMA_VERSION,
            app_version: app_version.to_string(),
            exported_at: exported_at.to_rfc3339_opts(SecondsFormat::Secs, false),
            prompt_count: entries.len() as u64,
            total_content_bytes,
            entries,
        };
        charge_manifest_metadata(&mut metadata_budget, &manifest)?;
        manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
            AppError::with_details(
                "prompt_zip_manifest_invalid",
                "生成提示词分享清单失败。",
                error.to_string(),
            )
        })?;
        validate_export_package_limits(
            ids.len(),
            total_content_bytes,
            prompt_files_bytes,
            manifest_bytes.len() as u64,
            0,
        )?;
        archive.start_file(MANIFEST_PATH, options)?;
        archive.write_all(&manifest_bytes)?;
        archive.finish()?.flush()?;
    }
    temp.as_file().sync_all()?;
    let package_file_bytes = fs::metadata(temp.path())?.len();
    validate_export_package_limits(
        ids.len(),
        total_content_bytes,
        prompt_files_bytes,
        manifest_bytes.len() as u64,
        package_file_bytes,
    )?;
    before_snapshot_release();
    snapshot.commit()?;
    persist_export_with_revision_guard(conn, temp, destination, selection)?;
    let size_bytes = fs::metadata(destination)?.len();
    Ok(prompts::PromptExportArtifact {
        path: destination.to_string_lossy().into_owned(),
        file_name: destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        item_count: ids.len(),
        size_bytes,
    })
}

fn export_prompts_zip_in_snapshot(
    conn: &Connection,
    selection: &prompts::PromptSelection,
    destination: &Path,
    exported_at: DateTime<Local>,
    app_version: &str,
    before_snapshot_release: impl FnOnce(),
) -> Result<prompts::PromptExportArtifact, AppError> {
    export_prompts_zip_in_snapshot_with_limits(
        conn,
        selection,
        destination,
        exported_at,
        app_version,
        PromptZipMetadataLimits::default(),
        before_snapshot_release,
    )
}

pub(crate) fn export_prompts_zip_to_path(
    conn: &Connection,
    selection: &prompts::PromptSelection,
    destination: &Path,
    exported_at: DateTime<Local>,
    app_version: &str,
) -> Result<prompts::PromptExportArtifact, AppError> {
    export_prompts_zip_in_snapshot(
        conn,
        selection,
        destination,
        exported_at,
        app_version,
        || {},
    )
}

pub(crate) fn preview_prompts_zip_from_path(
    conn: &Connection,
    path: &Path,
) -> Result<PromptZipPreview, AppError> {
    let prepared = prepare_prompt_zip_path(path)?;
    preview_prepared_prompts_zip(conn, &prepared)
}

fn preview_prepared_prompts_zip(
    conn: &Connection,
    prepared: &PreparedPromptZipImport,
) -> Result<PromptZipPreview, AppError> {
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let expected_library_revision = prompts::library_revision(&transaction)?;
    let mut new_prompts = 0_u64;
    let mut identical_prompts = 0_u64;
    let mut conflicting_prompts = 0_u64;
    let mut conflicts = Vec::new();
    let mut preview_budget =
        RetainedMetadataBudget::new(PromptZipMetadataLimits::default().max_metadata_bytes);
    preview_budget.charge(prepared.parsed.metadata_bytes, "parsedPackage")?;
    preview_budget.charge_type::<Vec<PromptZipConflict>>("conflicts")?;
    for prompt in &prepared.parsed.incoming {
        let local = transaction
            .query_row(
                "SELECT title, content FROM prompts WHERE id = ?1",
                [&prompt.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        match local {
            None => new_prompts += 1,
            Some((local_title, local_content))
                if local_title == prompt.title
                    && sha256_hex(local_content.as_bytes()) == prompt.content_sha256 =>
            {
                identical_prompts += 1;
            }
            Some((local_title, _)) => {
                conflicting_prompts += 1;
                preview_budget.charge_type::<PromptZipConflict>("conflicts[]")?;
                preview_budget.charge_str(&prompt.id, "conflicts[].id")?;
                preview_budget.charge_str(&prompt.title, "conflicts[].importedTitle")?;
                preview_budget.charge_str(&local_title, "conflicts[].localTitle")?;
                conflicts.push(PromptZipConflict {
                    id: prompt.id.clone(),
                    imported_title: prompt.title.clone(),
                    local_title,
                });
            }
        }
    }
    let mut tags_to_create = 0_u64;
    let mut tags_to_reuse = 0_u64;
    for key in prepared.parsed.package_tags.keys() {
        let exists = transaction
            .query_row(
                "SELECT 1 FROM prompt_tags WHERE normalized_name = ?1",
                [key],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            tags_to_reuse += 1;
        } else {
            tags_to_create += 1;
        }
    }
    transaction.commit()?;
    Ok(PromptZipPreview {
        path: Some(prepared.source_path.to_string_lossy().into_owned()),
        file_name: prepared
            .source_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        cancelled: false,
        sha256: Some(prepared.snapshot.sha256.clone()),
        size_bytes: prepared.snapshot.size_bytes,
        expected_library_revision,
        prompts: prepared.parsed.manifest.prompt_count,
        total_content_bytes: prepared.parsed.manifest.total_content_bytes,
        new_prompts,
        identical_prompts,
        conflicting_prompts,
        tags_to_create,
        tags_to_reuse,
        conflicts,
        valid: true,
        message: "提示词分享 ZIP 预检通过。".to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptZipConflict {
    pub id: String,
    pub imported_title: String,
    pub local_title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptZipPreview {
    pub path: Option<String>,
    pub file_name: Option<String>,
    pub cancelled: bool,
    pub sha256: Option<String>,
    pub size_bytes: u64,
    pub expected_library_revision: i64,
    pub prompts: u64,
    pub total_content_bytes: u64,
    pub new_prompts: u64,
    pub identical_prompts: u64,
    pub conflicting_prompts: u64,
    pub tags_to_create: u64,
    pub tags_to_reuse: u64,
    pub conflicts: Vec<PromptZipConflict>,
    pub valid: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptZipConflictStrategy {
    Duplicate,
    KeepLocal,
    Overwrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptZipImportRequest {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub expected_library_revision: i64,
    pub conflict_strategy: PromptZipConflictStrategy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptZipImportSummary {
    pub inserted: u64,
    pub skipped_same: u64,
    pub kept_local: u64,
    pub overwritten: u64,
    pub duplicated: u64,
    pub created_tags: u64,
    pub reused_tags: u64,
    pub library_revision: i64,
    pub message: String,
}

pub(crate) fn prepare_prompts_zip_import(
    request: &PromptZipImportRequest,
) -> Result<PreparedPromptZipImport, AppError> {
    if !valid_sha256(&request.sha256) || request.size_bytes == 0 {
        return Err(AppError::new(
            "prompt_zip_import_request_invalid",
            "提示词分享 ZIP 导入凭证无效，请重新预检。",
        ));
    }
    let source_path = PathBuf::from(&request.path);
    let snapshot = snapshot_package(&source_path)?;
    if snapshot.size_bytes != request.size_bytes
        || !snapshot.sha256.eq_ignore_ascii_case(&request.sha256)
    {
        return Err(AppError::new(
            "prompt_zip_file_changed",
            "提示词分享 ZIP 在预检后已发生变化，请重新预检。",
        ));
    }
    let parsed = inspect_snapshot_with_limits(&snapshot, PromptZipMetadataLimits::default())?;
    Ok(PreparedPromptZipImport {
        source_path,
        snapshot,
        parsed,
    })
}

#[cfg(test)]
pub(crate) fn import_prompts_zip_from_path(
    conn: &Connection,
    request: &PromptZipImportRequest,
) -> Result<PromptZipImportSummary, AppError> {
    let prepared = prepare_prompts_zip_import(request)?;
    import_prepared_prompts_zip(conn, request, prepared)
}

pub(crate) fn import_prepared_prompts_zip(
    conn: &Connection,
    request: &PromptZipImportRequest,
    prepared: PreparedPromptZipImport,
) -> Result<PromptZipImportSummary, AppError> {
    if prepared.source_path != Path::new(&request.path)
        || prepared.snapshot.size_bytes != request.size_bytes
        || !prepared
            .snapshot
            .sha256
            .eq_ignore_ascii_case(&request.sha256)
    {
        return Err(AppError::new(
            "prompt_zip_file_changed",
            "提示词分享 ZIP 的不可变快照与导入请求不一致，请重新预检。",
        ));
    }
    let PreparedPromptZipImport {
        snapshot,
        parsed:
            ParsedPromptZip {
                manifest,
                incoming,
                package_tags,
                metadata_bytes: _,
            },
        ..
    } = prepared;
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let actual_library_revision = prompts::library_revision(&transaction)?;
    if actual_library_revision != request.expected_library_revision {
        return Err(AppError::with_details(
            "prompt_zip_library_changed",
            "提示词库在预检后已发生变化，请重新预检。",
            format!(
                "expected={}, actual={actual_library_revision}",
                request.expected_library_revision
            ),
        ));
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ImportAction {
        Insert,
        SkipSame,
        KeepLocal,
        Overwrite,
        Duplicate,
    }
    #[derive(Debug)]
    struct ImportDecision {
        duplicate_target_id: Option<String>,
        action: ImportAction,
    }

    fn fresh_public_id(prefix: &str) -> String {
        unique_operation_id(prefix).replace('_', "-")
    }

    let mut decisions = Vec::with_capacity(incoming.len());
    let mut inserted = 0_u64;
    let mut skipped_same = 0_u64;
    let mut kept_local = 0_u64;
    let mut overwritten = 0_u64;
    let mut duplicated = 0_u64;
    let source_ids = incoming
        .iter()
        .map(|prompt| prompt.id.as_str())
        .collect::<HashSet<_>>();
    let mut generated_ids = HashSet::new();
    for prompt in &incoming {
        let local = transaction
            .query_row(
                "SELECT title, content FROM prompts WHERE id = ?1",
                [&prompt.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let decision = match local {
            None => {
                inserted += 1;
                ImportDecision {
                    duplicate_target_id: None,
                    action: ImportAction::Insert,
                }
            }
            Some((title, content))
                if title == prompt.title
                    && sha256_hex(content.as_bytes()) == prompt.content_sha256 =>
            {
                skipped_same += 1;
                ImportDecision {
                    duplicate_target_id: None,
                    action: ImportAction::SkipSame,
                }
            }
            Some(_) => match request.conflict_strategy {
                PromptZipConflictStrategy::KeepLocal => {
                    kept_local += 1;
                    ImportDecision {
                        duplicate_target_id: None,
                        action: ImportAction::KeepLocal,
                    }
                }
                PromptZipConflictStrategy::Overwrite => {
                    overwritten += 1;
                    ImportDecision {
                        duplicate_target_id: None,
                        action: ImportAction::Overwrite,
                    }
                }
                PromptZipConflictStrategy::Duplicate => {
                    duplicated += 1;
                    let mut target_id = fresh_public_id("prompt-import");
                    while source_ids.contains(target_id.as_str())
                        || generated_ids.contains(&target_id)
                        || transaction
                            .query_row("SELECT 1 FROM prompts WHERE id = ?1", [&target_id], |_| {
                                Ok(())
                            })
                            .optional()?
                            .is_some()
                    {
                        target_id = fresh_public_id("prompt-import");
                    }
                    generated_ids.insert(target_id.clone());
                    ImportDecision {
                        duplicate_target_id: Some(target_id),
                        action: ImportAction::Duplicate,
                    }
                }
            },
        };
        decisions.push(decision);
    }

    let mut actionable_tags = HashSet::new();
    for (prompt, decision) in incoming.iter().zip(decisions.iter()) {
        if decision.action != ImportAction::KeepLocal {
            actionable_tags.extend(prompt.tags.iter().map(|tag| tag.key.as_str()));
        }
    }
    let imported_at = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut tag_rows = HashMap::new();
    let mut created_tags = 0_u64;
    let mut reused_tags = 0_u64;
    for key in actionable_tags {
        let display = package_tags.get(key).ok_or_else(|| {
            AppError::new(
                "prompt_zip_database_failed",
                "无法解析导入标签的包内显示名称。",
            )
        })?;
        let existing = transaction
            .query_row(
                "SELECT row_id FROM prompt_tags WHERE normalized_name = ?1",
                [key],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let row_id = if let Some(row_id) = existing {
            reused_tags += 1;
            row_id
        } else {
            let mut tag_id = fresh_public_id("tag");
            while transaction
                .query_row("SELECT 1 FROM prompt_tags WHERE id = ?1", [&tag_id], |_| {
                    Ok(())
                })
                .optional()?
                .is_some()
            {
                tag_id = fresh_public_id("tag");
            }
            transaction.execute(
                "INSERT INTO prompt_tags(id, name, normalized_name, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?4)",
                rusqlite::params![tag_id, display, key, imported_at],
            )?;
            created_tags += 1;
            transaction.last_insert_rowid()
        };
        tag_rows.insert(key, row_id);
    }

    let new_record_count = decisions
        .iter()
        .filter(|decision| {
            matches!(
                decision.action,
                ImportAction::Insert | ImportAction::Duplicate
            )
        })
        .count();
    let mut new_manual_orders =
        prompts::manual_orders_for_front(&transaction, false, new_record_count)?.into_iter();

    let file = snapshot.temp.reopen()?;
    let mut archive = ZipArchive::new(file)?;
    let mut changed = created_tags > 0;
    for ((entry, expected_meta), decision) in manifest
        .entries
        .iter()
        .zip(incoming.iter())
        .zip(decisions.iter())
    {
        let record = read_incoming_prompt(&mut archive, &manifest, entry)?;
        if &record.meta != expected_meta {
            return Err(zip_error(
                "prompt_zip_file_changed",
                "提示词分享 ZIP 在导入读取期间发生变化。",
                entry.path.clone(),
            ));
        }
        let target_id = decision
            .duplicate_target_id
            .as_deref()
            .unwrap_or(&record.meta.id);
        let row_id = match decision.action {
            ImportAction::KeepLocal => continue,
            ImportAction::Insert | ImportAction::Duplicate => {
                let excerpt = prompts::plain_text_excerpt(&record.content);
                let manual_order = new_manual_orders.next().ok_or_else(|| {
                    AppError::new(
                        "prompt_zip_database_failed",
                        "导入提示词的手动排序值数量不匹配。",
                    )
                })?;
                transaction.execute(
                    "INSERT INTO prompts
                     (id, title, content, excerpt, pinned, manual_order, revision, created_at, updated_at)
                    VALUES(?1, ?2, ?3, ?4, 0, ?5, 1, ?6, ?6)",
                    rusqlite::params![
                        target_id,
                        record.meta.title,
                        record.content,
                        excerpt,
                        manual_order,
                        imported_at
                    ],
                )?;
                changed = true;
                transaction.last_insert_rowid()
            }
            ImportAction::Overwrite => {
                let excerpt = prompts::plain_text_excerpt(&record.content);
                let changed_rows = transaction.execute(
                    "UPDATE prompts
                     SET title = ?2, content = ?3, excerpt = ?4,
                         revision = revision + 1, updated_at = ?5
                    WHERE id = ?1",
                    rusqlite::params![
                        target_id,
                        record.meta.title,
                        record.content,
                        excerpt,
                        imported_at
                    ],
                )?;
                if changed_rows != 1 {
                    return Err(AppError::new(
                        "prompt_zip_library_changed",
                        "覆盖目标在导入事务中已不存在，请重新预检。",
                    ));
                }
                let row_id = transaction.query_row(
                    "SELECT row_id FROM prompts WHERE id = ?1",
                    [target_id],
                    |row| row.get::<_, i64>(0),
                )?;
                transaction.execute(
                    "DELETE FROM prompt_tag_links WHERE prompt_row_id = ?1",
                    [row_id],
                )?;
                changed = true;
                row_id
            }
            ImportAction::SkipSame => transaction.query_row(
                "SELECT row_id FROM prompts WHERE id = ?1",
                [target_id],
                |row| row.get::<_, i64>(0),
            )?,
        };
        let mut linked = false;
        for tag in &record.meta.tags {
            let tag_row_id = tag_rows.get(tag.key.as_str()).ok_or_else(|| {
                AppError::new("prompt_zip_database_failed", "无法解析导入标签的本机记录。")
            })?;
            let inserted_link = transaction.execute(
                "INSERT OR IGNORE INTO prompt_tag_links(prompt_row_id, tag_row_id)
                 VALUES(?1, ?2)",
                rusqlite::params![row_id, tag_row_id],
            )?;
            linked |= inserted_link == 1;
        }
        if decision.action == ImportAction::SkipSame && linked {
            transaction.execute(
                "UPDATE prompts
                 SET revision = revision + 1, updated_at = ?2 WHERE row_id = ?1",
                rusqlite::params![row_id, imported_at],
            )?;
            changed = true;
        }
    }
    if new_manual_orders.next().is_some() {
        return Err(AppError::new(
            "prompt_zip_database_failed",
            "导入提示词的手动排序值数量不匹配。",
        ));
    }

    let library_revision = if changed {
        transaction
            .execute(
                "INSERT INTO prompt_fts(prompt_fts) VALUES('integrity-check')",
                [],
            )
            .map_err(|error| {
                zip_error(
                    "prompt_zip_fts_integrity_failed",
                    "导入后的提示词全文索引完整性检查失败。",
                    error.to_string(),
                )
            })?;
        prompts::bump_library_revision(&transaction)?
    } else {
        actual_library_revision
    };
    transaction.commit()?;
    Ok(PromptZipImportSummary {
        inserted,
        skipped_same,
        kept_local,
        overwritten,
        duplicated,
        created_tags,
        reused_tags,
        library_revision,
        message: "提示词分享 ZIP 导入完成。".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rusqlite::Connection;
    use std::fs::File;
    use std::io::{Cursor, Read};
    use tempfile::tempdir;
    use zip::ZipArchive;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        prompts::migrate_prompt_library(&conn).unwrap();
        conn
    }

    fn read_zip_files(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|index| {
                let mut entry = archive.by_index(index).unwrap();
                let name = entry.name().to_string();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                (name, bytes)
            })
            .collect()
    }

    fn write_zip_files(path: &Path, files: &[(String, Vec<u8>)]) {
        let mut writer = ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (name, bytes) in files {
            writer.start_file(name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn write_raw_stored_zip_allowing_duplicates(path: &Path, files: &[(&str, &[u8])]) {
        fn u16_le(output: &mut Vec<u8>, value: u16) {
            output.extend_from_slice(&value.to_le_bytes());
        }
        fn u32_le(output: &mut Vec<u8>, value: u32) {
            output.extend_from_slice(&value.to_le_bytes());
        }

        let mut output = Vec::new();
        let mut central = Vec::new();
        for (name, bytes) in files {
            let local_offset = u32::try_from(output.len()).unwrap();
            let name_bytes = name.as_bytes();
            output.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
            u16_le(&mut output, 20);
            u16_le(&mut output, 0);
            u16_le(&mut output, 0);
            u16_le(&mut output, 0);
            u16_le(&mut output, 0);
            u32_le(&mut output, 0);
            u32_le(&mut output, u32::try_from(bytes.len()).unwrap());
            u32_le(&mut output, u32::try_from(bytes.len()).unwrap());
            u16_le(&mut output, u16::try_from(name_bytes.len()).unwrap());
            u16_le(&mut output, 0);
            output.extend_from_slice(name_bytes);
            output.extend_from_slice(bytes);

            central.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
            u16_le(&mut central, 20);
            u16_le(&mut central, 20);
            u16_le(&mut central, 0);
            u16_le(&mut central, 0);
            u16_le(&mut central, 0);
            u16_le(&mut central, 0);
            u32_le(&mut central, 0);
            u32_le(&mut central, u32::try_from(bytes.len()).unwrap());
            u32_le(&mut central, u32::try_from(bytes.len()).unwrap());
            u16_le(&mut central, u16::try_from(name_bytes.len()).unwrap());
            u16_le(&mut central, 0);
            u16_le(&mut central, 0);
            u16_le(&mut central, 0);
            u16_le(&mut central, 0);
            u32_le(&mut central, 0);
            u32_le(&mut central, local_offset);
            central.extend_from_slice(name_bytes);
        }
        let central_offset = u32::try_from(output.len()).unwrap();
        let central_size = u32::try_from(central.len()).unwrap();
        output.extend_from_slice(&central);
        output.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        u16_le(&mut output, 0);
        u16_le(&mut output, 0);
        u16_le(&mut output, u16::try_from(files.len()).unwrap());
        u16_le(&mut output, u16::try_from(files.len()).unwrap());
        u32_le(&mut output, central_size);
        u32_le(&mut output, central_offset);
        u16_le(&mut output, 0);
        std::fs::write(path, output).unwrap();
    }

    fn exported_test_zip(path: &Path) {
        let source = database();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("strict-prompt".to_string()),
                title: "Strict".to_string(),
                content: "Body".to_string(),
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap();
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["strict-prompt".to_string()],
            },
            path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 9, 0, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();
    }

    fn update_manifest_entry_for_markdown(files: &mut [(String, Vec<u8>)]) {
        let prompt_index = files
            .iter()
            .position(|(name, _)| name.starts_with("prompts/"))
            .unwrap();
        let prompt_path = files[prompt_index].0.clone();
        let prompt_bytes = files[prompt_index].1.clone();
        let manifest_index = files
            .iter()
            .position(|(name, _)| name == MANIFEST_PATH)
            .unwrap();
        let mut manifest: PromptZipManifest =
            serde_json::from_slice(&files[manifest_index].1).unwrap();
        let entry = manifest
            .entries
            .iter_mut()
            .find(|entry| entry.path == prompt_path)
            .unwrap();
        entry.file_bytes = prompt_bytes.len() as u64;
        entry.file_sha256 = sha256_hex(&prompt_bytes);
        files[manifest_index].1 = serde_json::to_vec_pretty(&manifest).unwrap();
    }

    #[test]
    fn bounded_entry_reader_rejects_actual_bytes_beyond_limit_or_declared_size() {
        let over_limit =
            read_exact_bounded(Cursor::new(vec![b'x'; 9]), 9, 8, "prompts/oversized.md")
                .unwrap_err();
        assert_eq!(over_limit.code, "prompt_zip_size_limit_exceeded");

        let false_directory_size =
            read_exact_bounded(Cursor::new(vec![b'x'; 5]), 4, 8, "prompts/mismatch.md")
                .unwrap_err();
        assert_eq!(false_directory_size.code, "prompt_zip_manifest_invalid");
    }

    #[test]
    fn export_limits_are_the_same_limits_enforced_by_import() {
        let too_many = validate_export_package_limits(MAX_PROMPTS + 1, 0, 0, 0, 0).unwrap_err();
        assert_eq!(too_many.code, "prompt_zip_size_limit_exceeded");

        let too_much_content =
            validate_export_package_limits(1, MAX_TOTAL_CONTENT_BYTES + 1, 1, 1, 1).unwrap_err();
        assert_eq!(too_much_content.code, "prompt_zip_size_limit_exceeded");

        let too_much_uncompressed =
            validate_export_package_limits(1, 1, MAX_ARCHIVE_UNCOMPRESSED_BYTES, 1, 1).unwrap_err();
        assert_eq!(too_much_uncompressed.code, "prompt_zip_size_limit_exceeded");

        let too_large_manifest =
            validate_export_package_limits(1, 1, 1, MAX_MANIFEST_BYTES + 1, 1).unwrap_err();
        assert_eq!(too_large_manifest.code, "prompt_zip_size_limit_exceeded");

        let too_large_file =
            validate_export_package_limits(1, 1, 1, 1, MAX_PACKAGE_FILE_BYTES + 1).unwrap_err();
        assert_eq!(too_large_file.code, "prompt_zip_size_limit_exceeded");
    }

    #[test]
    fn retained_metadata_budget_and_unique_tag_cap_accept_exact_boundaries() {
        let mut budget = RetainedMetadataBudget::new(10);
        budget.charge(4, "first").unwrap();
        budget.charge(6, "second").unwrap();
        assert_eq!(budget.used(), 10);
        assert_eq!(
            budget.charge(1, "overflow").unwrap_err().code,
            "prompt_zip_metadata_too_large"
        );

        let mut tags = HashMap::new();
        insert_package_tag(
            &mut tags,
            &IncomingTag {
                display: "A".to_string(),
                key: "a".to_string(),
            },
            2,
            &mut RetainedMetadataBudget::new(u64::MAX),
        )
        .unwrap();
        insert_package_tag(
            &mut tags,
            &IncomingTag {
                display: "B".to_string(),
                key: "b".to_string(),
            },
            2,
            &mut RetainedMetadataBudget::new(u64::MAX),
        )
        .unwrap();
        insert_package_tag(
            &mut tags,
            &IncomingTag {
                display: "a".to_string(),
                key: "a".to_string(),
            },
            2,
            &mut RetainedMetadataBudget::new(u64::MAX),
        )
        .unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(
            insert_package_tag(
                &mut tags,
                &IncomingTag {
                    display: "C".to_string(),
                    key: "c".to_string(),
                },
                2,
                &mut RetainedMetadataBudget::new(u64::MAX),
            )
            .unwrap_err()
            .code,
            "prompt_zip_too_many_tags"
        );
    }

    #[test]
    fn export_metadata_and_tag_limits_match_import_and_preserve_existing_destination() {
        let source = database();
        let tag_a = prompts::create_prompt_tag(&source, "A").unwrap();
        let tag_b = prompts::create_prompt_tag(&source, "B").unwrap();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("limited-export".to_string()),
                title: "Limited export".to_string(),
                content: "Body".to_string(),
                tag_ids: vec![tag_a.id, tag_b.id],
                pinned: false,
            },
        )
        .unwrap();
        let selection = prompts::PromptSelection::Explicit {
            ids: vec!["limited-export".to_string()],
        };
        let directory = tempdir().unwrap();
        let baseline = directory.path().join("baseline.zip");
        let exported_at = Local
            .with_ymd_and_hms(2026, 8, 31, 9, 30, 0)
            .single()
            .unwrap();
        export_prompts_zip_to_path(&source, &selection, &baseline, exported_at, "1.2.1").unwrap();
        let inspected =
            prepare_prompt_zip_path_with_limits(&baseline, PromptZipMetadataLimits::default())
                .unwrap();
        let exact = PromptZipMetadataLimits {
            max_unique_tags: 2,
            max_metadata_bytes: inspected.parsed.metadata_bytes,
        };

        let exact_path = directory.path().join("exact.zip");
        export_prompts_zip_in_snapshot_with_limits(
            &source,
            &selection,
            &exact_path,
            exported_at,
            "1.2.1",
            exact,
            || {},
        )
        .unwrap();
        prepare_prompt_zip_path_with_limits(&exact_path, exact).unwrap();
        assert_eq!(
            prepare_prompt_zip_path_with_limits(
                &baseline,
                PromptZipMetadataLimits {
                    max_unique_tags: 1,
                    ..exact
                },
            )
            .err()
            .unwrap()
            .code,
            "prompt_zip_too_many_tags"
        );
        assert_eq!(
            prepare_prompt_zip_path_with_limits(
                &baseline,
                PromptZipMetadataLimits {
                    max_metadata_bytes: exact.max_metadata_bytes - 1,
                    ..exact
                },
            )
            .err()
            .unwrap()
            .code,
            "prompt_zip_metadata_too_large"
        );

        let metadata_rejected = directory.path().join("metadata-rejected.zip");
        std::fs::write(&metadata_rejected, b"keep-metadata").unwrap();
        let error = export_prompts_zip_in_snapshot_with_limits(
            &source,
            &selection,
            &metadata_rejected,
            exported_at,
            "1.2.1",
            PromptZipMetadataLimits {
                max_metadata_bytes: exact.max_metadata_bytes - 1,
                ..exact
            },
            || {},
        )
        .unwrap_err();
        assert_eq!(error.code, "prompt_zip_metadata_too_large");
        assert_eq!(std::fs::read(&metadata_rejected).unwrap(), b"keep-metadata");

        let tags_rejected = directory.path().join("tags-rejected.zip");
        std::fs::write(&tags_rejected, b"keep-tags").unwrap();
        let error = export_prompts_zip_in_snapshot_with_limits(
            &source,
            &selection,
            &tags_rejected,
            exported_at,
            "1.2.1",
            PromptZipMetadataLimits {
                max_unique_tags: 1,
                ..exact
            },
            || {},
        )
        .unwrap_err();
        assert_eq!(error.code, "prompt_zip_too_many_tags");
        assert_eq!(std::fs::read(&tags_rejected).unwrap(), b"keep-tags");
    }

    #[test]
    fn incoming_tag_text_is_trimmed_nfc_casefolded_and_deduplicated() {
        let tags = normalize_incoming_tags(
            vec!["  Café  ".to_string(), "CAFE\u{301}".to_string()],
            "prompts/one.md",
        )
        .unwrap();

        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].display, "Café");
        assert_eq!(tags[0].key, "café");
    }

    #[test]
    fn preview_rejects_legacy_zip_without_manifest() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("legacy.zip");
        write_zip_files(
            &path,
            &[("prompts/legacy.md".to_string(), b"legacy".to_vec())],
        );

        let error = preview_prompts_zip_from_path(&database(), &path).unwrap_err();
        assert_eq!(error.code, "prompt_zip_legacy_unsupported");
    }

    #[test]
    fn preview_rejects_path_traversal_duplicate_and_extra_entries() {
        let directory = tempdir().unwrap();
        let traversal = directory.path().join("traversal.zip");
        write_zip_files(
            &traversal,
            &[
                (MANIFEST_PATH.to_string(), b"{}".to_vec()),
                ("../escape.md".to_string(), b"escape".to_vec()),
            ],
        );
        assert_eq!(
            preview_prompts_zip_from_path(&database(), &traversal)
                .unwrap_err()
                .code,
            "prompt_zip_path_unsafe"
        );

        let duplicate = directory.path().join("duplicate.zip");
        write_raw_stored_zip_allowing_duplicates(
            &duplicate,
            &[
                (MANIFEST_PATH, b"{}"),
                ("prompts/one.md", b"one"),
                ("prompts/one.md", b"two"),
            ],
        );
        let mut duplicate_file = File::open(&duplicate).unwrap();
        assert_eq!(raw_zip_entry_count(&mut duplicate_file).unwrap(), 3);
        assert_eq!(ZipArchive::new(duplicate_file).unwrap().len(), 2);
        let duplicate_error = preview_prompts_zip_from_path(&database(), &duplicate).unwrap_err();
        assert_eq!(
            duplicate_error.code, "prompt_zip_duplicate_entry",
            "details={:?}",
            duplicate_error.details
        );

        let extra = directory.path().join("extra.zip");
        exported_test_zip(&extra);
        let mut files = read_zip_files(&extra);
        files.push(("prompts/unlisted.md".to_string(), b"unlisted".to_vec()));
        write_zip_files(&extra, &files);
        assert_eq!(
            preview_prompts_zip_from_path(&database(), &extra)
                .unwrap_err()
                .code,
            "prompt_zip_extra_entry"
        );
    }

    #[test]
    fn preview_rejects_bom_unknown_frontmatter_and_digest_tampering() {
        let directory = tempdir().unwrap();

        let manifest_bom = directory.path().join("manifest-bom.zip");
        exported_test_zip(&manifest_bom);
        let mut files = read_zip_files(&manifest_bom);
        let manifest = files
            .iter_mut()
            .find(|(name, _)| name == MANIFEST_PATH)
            .unwrap();
        manifest.1.splice(0..0, [0xef, 0xbb, 0xbf]);
        write_zip_files(&manifest_bom, &files);
        assert_eq!(
            preview_prompts_zip_from_path(&database(), &manifest_bom)
                .unwrap_err()
                .code,
            "prompt_zip_bom_forbidden"
        );

        let markdown_bom = directory.path().join("markdown-bom.zip");
        exported_test_zip(&markdown_bom);
        let mut files = read_zip_files(&markdown_bom);
        files
            .iter_mut()
            .find(|(name, _)| name.starts_with("prompts/"))
            .unwrap()
            .1
            .splice(0..0, [0xef, 0xbb, 0xbf]);
        update_manifest_entry_for_markdown(&mut files);
        write_zip_files(&markdown_bom, &files);
        assert_eq!(
            preview_prompts_zip_from_path(&database(), &markdown_bom)
                .unwrap_err()
                .code,
            "prompt_zip_bom_forbidden"
        );

        let unknown_field = directory.path().join("unknown-frontmatter.zip");
        exported_test_zip(&unknown_field);
        let mut files = read_zip_files(&unknown_field);
        let markdown = &mut files
            .iter_mut()
            .find(|(name, _)| name.starts_with("prompts/"))
            .unwrap()
            .1;
        let text = String::from_utf8(markdown.clone()).unwrap();
        *markdown = text.replacen("title: ", "bogus: ", 1).into_bytes();
        update_manifest_entry_for_markdown(&mut files);
        write_zip_files(&unknown_field, &files);
        assert_eq!(
            preview_prompts_zip_from_path(&database(), &unknown_field)
                .unwrap_err()
                .code,
            "prompt_zip_frontmatter_invalid"
        );

        let tampered = directory.path().join("tampered.zip");
        exported_test_zip(&tampered);
        let mut files = read_zip_files(&tampered);
        let markdown = &mut files
            .iter_mut()
            .find(|(name, _)| name.starts_with("prompts/"))
            .unwrap()
            .1;
        let body = markdown.last_mut().unwrap();
        *body = if *body == b'y' { b'x' } else { b'y' };
        write_zip_files(&tampered, &files);
        assert_eq!(
            preview_prompts_zip_from_path(&database(), &tampered)
                .unwrap_err()
                .code,
            "prompt_zip_entry_hash_mismatch"
        );
    }

    #[test]
    fn exported_prompt_with_crlf_body_round_trips_byte_for_byte() {
        let source = database();
        let content = "first\r\nsecond\rthird\n";
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("prompt-crlf".to_string()),
                title: "CRLF body".to_string(),
                content: content.to_string(),
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("crlf.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["prompt-crlf".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 0, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        import_prompts_zip_from_path(
            &target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: preview.sha256.unwrap(),
                size_bytes: preview.size_bytes,
                expected_library_revision: preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap();

        let imported = target
            .query_row(
                "SELECT content FROM prompts WHERE id = 'prompt-crlf'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(imported.as_bytes(), content.as_bytes());
    }

    #[test]
    fn five_mib_prompt_body_round_trips_at_the_exact_boundary() {
        let source = database();
        let content = "x".repeat(prompts::PROMPT_CONTENT_MAX_BYTES);
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("prompt-five-mib".to_string()),
                title: "5 MiB".to_string(),
                content: content.clone(),
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("five-mib.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["prompt-five-mib".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 1, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        assert_eq!(
            preview.total_content_bytes,
            prompts::PROMPT_CONTENT_MAX_BYTES as u64
        );
        import_prompts_zip_from_path(
            &target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: preview.sha256.unwrap(),
                size_bytes: preview.size_bytes,
                expected_library_revision: preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap();
        assert_eq!(
            target
                .query_row(
                    "SELECT length(CAST(content AS BLOB)) FROM prompts
                     WHERE id = 'prompt-five-mib'",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .unwrap(),
            prompts::PROMPT_CONTENT_MAX_BYTES as u64
        );
    }

    #[test]
    fn identical_prompt_merges_text_matched_tags_and_reimport_is_idempotent() {
        let source = database();
        let source_tag = prompts::create_prompt_tag(&source, "Research").unwrap();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("same-content".to_string()),
                title: "Same title".to_string(),
                content: "Same body".to_string(),
                tag_ids: vec![source_tag.id],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("same.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["same-content".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 5, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        let original = prompts::create_prompt(
            &target,
            &prompts::PromptCreateInput {
                id: Some("same-content".to_string()),
                title: "Same title".to_string(),
                content: "Same body".to_string(),
                tag_ids: vec![],
                pinned: true,
            },
        )
        .unwrap();
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        assert_eq!(preview.identical_prompts, 1);
        let first = import_prompts_zip_from_path(
            &target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: preview.sha256.unwrap(),
                size_bytes: preview.size_bytes,
                expected_library_revision: preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap();
        assert_eq!(first.skipped_same, 1);
        assert_eq!(first.created_tags, 1);
        let merged = prompts::get_prompt_detail(&target, "same-content")
            .unwrap()
            .unwrap();
        assert!(merged.summary.pinned);
        assert_eq!(merged.summary.tags.len(), 1);
        assert_eq!(merged.summary.tags[0].name, "Research");
        assert_eq!(merged.summary.revision, original.summary.revision + 1);

        let second_preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        let second = import_prompts_zip_from_path(
            &target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: second_preview.sha256.unwrap(),
                size_bytes: second_preview.size_bytes,
                expected_library_revision: second_preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap();
        assert_eq!(second.skipped_same, 1);
        assert_eq!(second.created_tags, 0);
        assert_eq!(second.library_revision, first.library_revision);
        assert_eq!(
            prompts::get_prompt_detail(&target, "same-content")
                .unwrap()
                .unwrap()
                .summary
                .revision,
            merged.summary.revision
        );
    }

    #[test]
    fn keep_local_and_overwrite_conflict_strategies_preserve_their_contracts() {
        let source = database();
        let source_tag = prompts::create_prompt_tag(&source, "Imported tag").unwrap();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("conflict".to_string()),
                title: "Imported title".to_string(),
                content: "Imported searchable body".to_string(),
                tag_ids: vec![source_tag.id],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("conflict.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["conflict".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 10, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let keep_target = database();
        let kept = prompts::create_prompt(
            &keep_target,
            &prompts::PromptCreateInput {
                id: Some("conflict".to_string()),
                title: "Local title".to_string(),
                content: "Local body".to_string(),
                tag_ids: vec![],
                pinned: true,
            },
        )
        .unwrap();
        let keep_preview = preview_prompts_zip_from_path(&keep_target, &path).unwrap();
        let keep = import_prompts_zip_from_path(
            &keep_target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: keep_preview.sha256.unwrap(),
                size_bytes: keep_preview.size_bytes,
                expected_library_revision: keep_preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::KeepLocal,
            },
        )
        .unwrap();
        assert_eq!(keep.kept_local, 1);
        assert_eq!(keep.created_tags, 0);
        assert_eq!(
            keep.library_revision,
            keep_preview.expected_library_revision
        );
        assert_eq!(
            prompts::get_prompt_detail(&keep_target, "conflict")
                .unwrap()
                .unwrap(),
            kept
        );

        let overwrite_target = database();
        let local_tag = prompts::create_prompt_tag(&overwrite_target, "Local tag").unwrap();
        let local = prompts::create_prompt(
            &overwrite_target,
            &prompts::PromptCreateInput {
                id: Some("conflict".to_string()),
                title: "Local title".to_string(),
                content: "Local body".to_string(),
                tag_ids: vec![local_tag.id],
                pinned: true,
            },
        )
        .unwrap();
        let local_manual_order = overwrite_target
            .query_row(
                "SELECT manual_order FROM prompts WHERE id = 'conflict'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let overwrite_preview = preview_prompts_zip_from_path(&overwrite_target, &path).unwrap();
        let overwrite = import_prompts_zip_from_path(
            &overwrite_target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: overwrite_preview.sha256.unwrap(),
                size_bytes: overwrite_preview.size_bytes,
                expected_library_revision: overwrite_preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Overwrite,
            },
        )
        .unwrap();
        assert_eq!(overwrite.overwritten, 1);
        assert_eq!(overwrite.created_tags, 1);
        let overwritten = prompts::get_prompt_detail(&overwrite_target, "conflict")
            .unwrap()
            .unwrap();
        assert_eq!(overwritten.summary.title, "Imported title");
        assert_eq!(overwritten.content, "Imported searchable body");
        assert!(overwritten.summary.pinned);
        assert_eq!(overwritten.summary.created_at, local.summary.created_at);
        assert_eq!(overwritten.summary.revision, local.summary.revision + 1);
        assert_eq!(overwritten.summary.tags.len(), 1);
        assert_eq!(overwritten.summary.tags[0].name, "Imported tag");
        assert_eq!(
            overwrite_target
                .query_row(
                    "SELECT manual_order FROM prompts WHERE id = 'conflict'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            local_manual_order
        );
        let searchable = prompts::list_prompts(
            &overwrite_target,
            &prompts::PromptListRequest {
                query: "searchable".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(searchable.total, 1);
        prompts::prompt_fts_integrity_check(&overwrite_target).unwrap();
    }

    #[test]
    fn import_rejects_file_and_library_drift_without_mutating_the_library() {
        let source = database();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("drift-import".to_string()),
                title: "Drift".to_string(),
                content: "Body".to_string(),
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("drift.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["drift-import".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 15, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let file_target = database();
        let file_preview = preview_prompts_zip_from_path(&file_target, &path).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        let file_error = import_prompts_zip_from_path(
            &file_target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: file_preview.sha256.unwrap(),
                size_bytes: file_preview.size_bytes,
                expected_library_revision: file_preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap_err();
        assert_eq!(file_error.code, "prompt_zip_file_changed");
        assert_eq!(
            file_target
                .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );

        let stable_path = directory.path().join("stable.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["drift-import".to_string()],
            },
            &stable_path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 16, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();
        let library_target = database();
        let library_preview = preview_prompts_zip_from_path(&library_target, &stable_path).unwrap();
        prompts::create_prompt_tag(&library_target, "concurrent change").unwrap();
        let library_error = import_prompts_zip_from_path(
            &library_target,
            &PromptZipImportRequest {
                path: stable_path.to_string_lossy().into_owned(),
                sha256: library_preview.sha256.unwrap(),
                size_bytes: library_preview.size_bytes,
                expected_library_revision: library_preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap_err();
        assert_eq!(library_error.code, "prompt_zip_library_changed");
        assert_eq!(
            library_target
                .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn prepared_import_uses_immutable_snapshot_after_source_path_changes() {
        let source = database();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("prepared-import".to_string()),
                title: "Prepared".to_string(),
                content: "Prepared body".to_string(),
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("prepared.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["prepared-import".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 17, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        let request = PromptZipImportRequest {
            path: path.to_string_lossy().into_owned(),
            sha256: preview.sha256.unwrap(),
            size_bytes: preview.size_bytes,
            expected_library_revision: preview.expected_library_revision,
            conflict_strategy: PromptZipConflictStrategy::Duplicate,
        };
        let prepared = prepare_prompts_zip_import(&request).unwrap();
        std::fs::write(&path, b"replaced after immutable snapshot").unwrap();

        let result = import_prepared_prompts_zip(&target, &request, prepared).unwrap();
        assert_eq!(result.inserted, 1);
        assert_eq!(
            prompts::get_prompt_detail(&target, "prepared-import")
                .unwrap()
                .unwrap()
                .content,
            "Prepared body"
        );
    }

    #[test]
    fn import_failure_rolls_back_created_tags_prompts_and_library_revision() {
        let source = database();
        let tag = prompts::create_prompt_tag(&source, "rollback tag").unwrap();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("rollback-prompt".to_string()),
                title: "Rollback".to_string(),
                content: "Rollback body".to_string(),
                tag_ids: vec![tag.id],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("rollback.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["rollback-prompt".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 20, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        target
            .execute_batch(
                "CREATE TRIGGER fail_prompt_zip_import
                 BEFORE INSERT ON prompts
                 WHEN NEW.id = 'rollback-prompt'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced rollback');
                 END;",
            )
            .unwrap();
        let error = import_prompts_zip_from_path(
            &target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: preview.sha256.unwrap(),
                size_bytes: preview.size_bytes,
                expected_library_revision: preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "sqlite_error");
        assert_eq!(
            target
                .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            target
                .query_row("SELECT COUNT(*) FROM prompt_tags", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            prompts::library_revision(&target).unwrap(),
            preview.expected_library_revision
        );
        prompts::prompt_fts_integrity_check(&target).unwrap();
    }

    #[test]
    fn import_rebalances_exhausted_manual_order_space_and_keeps_package_order() {
        let source = database();
        for (id, title) in [("incoming-a", "A"), ("incoming-b", "B")] {
            prompts::create_prompt(
                &source,
                &prompts::PromptCreateInput {
                    id: Some(id.to_string()),
                    title: title.to_string(),
                    content: format!("{title} body"),
                    tag_ids: vec![],
                    pinned: false,
                },
            )
            .unwrap();
        }
        let directory = tempdir().unwrap();
        let path = directory.path().join("orders.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["incoming-a".to_string(), "incoming-b".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 10, 25, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        prompts::create_prompt(
            &target,
            &prompts::PromptCreateInput {
                id: Some("existing".to_string()),
                title: "Existing".to_string(),
                content: "Existing body".to_string(),
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap();
        target
            .execute(
                "UPDATE prompts SET manual_order = ?1 WHERE id = 'existing'",
                [i64::MIN],
            )
            .unwrap();
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        import_prompts_zip_from_path(
            &target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: preview.sha256.unwrap(),
                size_bytes: preview.size_bytes,
                expected_library_revision: preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap();

        let ids = {
            let mut statement = target
                .prepare(
                    "SELECT id FROM prompts WHERE pinned = 0
                     ORDER BY manual_order ASC, id ASC",
                )
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(ids, vec!["incoming-a", "incoming-b", "existing"]);
        let distinct_orders = target
            .query_row(
                "SELECT COUNT(DISTINCT manual_order) FROM prompts",
                [],
                |row| row.get::<_, u64>(0),
            )
            .unwrap();
        assert_eq!(distinct_orders, 3);
    }

    #[test]
    fn exported_share_zip_has_strict_manifest_and_markdown_without_body_in_manifest() {
        let conn = database();
        let tag = prompts::create_prompt_tag(&conn, "研究").unwrap();
        let source_tag_id = tag.id.clone();
        prompts::create_prompt(
            &conn,
            &prompts::PromptCreateInput {
                id: Some("prompt-export-one".to_string()),
                title: "深度研究".to_string(),
                content: "逐字保留的正文。".to_string(),
                tag_ids: vec![tag.id],
                pinned: true,
            },
        )
        .unwrap();
        let selection = prompts::PromptSelection::Explicit {
            ids: vec!["prompt-export-one".to_string()],
        };
        let directory = tempdir().unwrap();
        let output = directory.path().join("prompts.zip");
        let exported_at = Local
            .with_ymd_and_hms(2026, 8, 31, 10, 30, 0)
            .single()
            .unwrap();

        let artifact =
            export_prompts_zip_to_path(&conn, &selection, &output, exported_at, "1.2.1").unwrap();
        assert_eq!(artifact.item_count, 1);

        let mut archive = ZipArchive::new(File::open(output).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        assert!(manifest.contains("\"format\": \"skill-repo-tracker-prompt-library\""));
        assert!(manifest.contains("\"schemaVersion\": 1"));
        assert!(manifest.contains("\"appVersion\": \"1.2.1\""));
        assert!(manifest.contains("\"promptCount\": 1"));
        assert!(!manifest.contains("逐字保留的正文。"));
        assert!(!manifest.contains(&source_tag_id));

        let prompt_path = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .find(|name| name.starts_with("prompts/") && name.ends_with(".md"))
            .unwrap();
        let mut markdown = String::new();
        archive
            .by_name(&prompt_path)
            .unwrap()
            .read_to_string(&mut markdown)
            .unwrap();
        assert!(markdown.contains("tags: [\"研究\"]"));
        assert!(!markdown.contains(&source_tag_id));
        assert!(markdown.ends_with("逐字保留的正文。"));
    }

    #[test]
    fn preview_matches_tags_by_normalized_text_instead_of_source_ids() {
        let source = database();
        let source_tag = prompts::create_prompt_tag(&source, "  Café  ").unwrap();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("shared-prompt".to_string()),
                title: "Shared".to_string(),
                content: "Body".to_string(),
                tag_ids: vec![source_tag.id.clone()],
                pinned: false,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("share.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["shared-prompt".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 11, 0, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        let target_tag = prompts::create_prompt_tag(&target, "CAFE\u{301}").unwrap();
        assert_ne!(source_tag.id, target_tag.id);
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();

        assert_eq!(preview.prompts, 1);
        assert_eq!(preview.new_prompts, 1);
        assert_eq!(preview.identical_prompts, 0);
        assert_eq!(preview.conflicting_prompts, 0);
        assert_eq!(preview.tags_to_create, 0);
        assert_eq!(preview.tags_to_reuse, 1);
        assert_eq!(preview.expected_library_revision, 1);
        assert!(preview.valid);
        assert_eq!(preview.sha256.as_deref().map(str::len), Some(64));
    }

    #[test]
    fn duplicate_conflicts_create_a_new_prompt_and_reuse_local_text_matched_tags() {
        let source = database();
        let source_tag = prompts::create_prompt_tag(&source, "研究").unwrap();
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some("same-id".to_string()),
                title: "Imported title".to_string(),
                content: "Imported searchable body".to_string(),
                tag_ids: vec![source_tag.id],
                pinned: true,
            },
        )
        .unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join("share.zip");
        export_prompts_zip_to_path(
            &source,
            &prompts::PromptSelection::Explicit {
                ids: vec!["same-id".to_string()],
            },
            &path,
            Local
                .with_ymd_and_hms(2026, 8, 31, 11, 30, 0)
                .single()
                .unwrap(),
            "1.2.1",
        )
        .unwrap();

        let target = database();
        let local_tag = prompts::create_prompt_tag(&target, "研究").unwrap();
        prompts::create_prompt(
            &target,
            &prompts::PromptCreateInput {
                id: Some("same-id".to_string()),
                title: "Local title".to_string(),
                content: "Local body".to_string(),
                tag_ids: vec![],
                pinned: true,
            },
        )
        .unwrap();
        let preview = preview_prompts_zip_from_path(&target, &path).unwrap();
        assert_eq!(
            preview.conflicts,
            vec![PromptZipConflict {
                id: "same-id".to_string(),
                imported_title: "Imported title".to_string(),
                local_title: "Local title".to_string(),
            }]
        );

        let summary = import_prompts_zip_from_path(
            &target,
            &PromptZipImportRequest {
                path: path.to_string_lossy().into_owned(),
                sha256: preview.sha256.unwrap(),
                size_bytes: preview.size_bytes,
                expected_library_revision: preview.expected_library_revision,
                conflict_strategy: PromptZipConflictStrategy::Duplicate,
            },
        )
        .unwrap();
        assert_eq!(summary.duplicated, 1);
        assert_eq!(summary.created_tags, 0);
        assert_eq!(summary.reused_tags, 1);
        assert_eq!(
            target
                .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            target
                .query_row(
                    "SELECT content FROM prompts WHERE id = 'same-id'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Local body"
        );
        let imported = target
            .query_row(
                "SELECT p.id, p.pinned, t.id
                 FROM prompts p
                 JOIN prompt_tag_links l ON l.prompt_row_id = p.row_id
                 JOIN prompt_tags t ON t.row_id = l.tag_row_id
                 WHERE p.id <> 'same-id'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_ne!(imported.0, "same-id");
        assert!(!imported.1, "imported prompts default to unpinned");
        assert_eq!(imported.2, local_tag.id);
        prompts::prompt_fts_integrity_check(&target).unwrap();
    }

    #[test]
    fn filtered_export_drift_does_not_replace_an_existing_destination() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("export.sqlite");
        let writer = Connection::open(&database_path).unwrap();
        prompts::migrate_prompt_library(&writer).unwrap();
        prompts::create_prompt(
            &writer,
            &prompts::PromptCreateInput {
                id: Some("selected".to_string()),
                title: "Selected".to_string(),
                content: "Body".to_string(),
                tag_ids: vec![],
                pinned: false,
            },
        )
        .unwrap();
        let expected_library_revision = prompts::library_revision(&writer).unwrap();
        let selection = prompts::PromptSelection::Filter {
            filter: prompts::PromptFilter {
                query: String::new(),
                tag_ids: vec![],
                tag_mode: prompts::PromptTagMode::Any,
                sort: prompts::PromptSort::Manual,
            },
            excluded_ids: vec![],
            expected_library_revision,
        };
        let reader = prompts::open_prompt_read_connection(&database_path).unwrap();
        let destination = directory.path().join("share.zip");
        std::fs::write(&destination, b"keep-existing").unwrap();

        let error = export_prompts_zip_in_snapshot(
            &reader,
            &selection,
            &destination,
            Local
                .with_ymd_and_hms(2026, 8, 31, 12, 0, 0)
                .single()
                .unwrap(),
            "1.2.1",
            || {
                prompts::create_prompt_tag(&writer, "drift").unwrap();
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "prompt_selection_drift");
        assert_eq!(std::fs::read(&destination).unwrap(), b"keep-existing");
    }
}
