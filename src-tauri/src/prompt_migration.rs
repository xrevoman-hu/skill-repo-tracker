//! Prompt-library migration v2 transport.
//!
//! The public v1 migration JSON remains owned by `lib.rs`. This module only
//! detects and validates that legacy payload, and embeds it byte-for-byte in a
//! v2 `.srtmigration` ZIP alongside streaming prompt-library JSONL entries.

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path};
use tempfile::NamedTempFile;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub const PROMPT_MIGRATION_SCHEMA_VERSION: u32 = 2;
pub const MAX_PROMPT_BODY_BYTES: u64 = 5_242_880;
const MAX_LEGACY_V1_JSON_BYTES: u64 = 134_217_728;
const MAX_MANIFEST_BYTES: u64 = 1_048_576;
const MAX_TAG_RECORD_BYTES: u64 = 32_768;
const MAX_LINK_RECORD_BYTES: u64 = 4_096;
const PROMPT_RECORD_METADATA_ALLOWANCE_BYTES: u64 = 1_048_576;
const PACKAGE_FORMAT: &str = "skill-repo-tracker-prompt-migration";
const MANIFEST_PATH: &str = "manifest.json";
const LEGACY_PATH: &str = "legacy-v1.json";
const TAGS_PATH: &str = "tags.jsonl";
const PROMPTS_PATH: &str = "prompts.jsonl";
const LINKS_PATH: &str = "links.jsonl";
const EXPECTED_PATHS: [&str; 5] = [
    MANIFEST_PATH,
    LEGACY_PATH,
    TAGS_PATH,
    PROMPTS_PATH,
    LINKS_PATH,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptMigrationError {
    code: String,
    message: String,
}

impl PromptMigrationError {
    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for PromptMigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PromptMigrationError {}

impl From<std::io::Error> for PromptMigrationError {
    fn from(error: std::io::Error) -> Self {
        Self::new("prompt_migration_io_failed", error.to_string())
    }
}

impl From<zip::result::ZipError> for PromptMigrationError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::new("prompt_migration_zip_invalid", error.to_string())
    }
}

impl From<serde_json::Error> for PromptMigrationError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("prompt_migration_json_invalid", error.to_string())
    }
}

impl From<rusqlite::Error> for PromptMigrationError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("prompt_migration_database_failed", error.to_string())
    }
}

impl From<crate::AppError> for PromptMigrationError {
    fn from(error: crate::AppError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MigrationPackageKind {
    LegacyV1Json,
    PromptLibraryV2Zip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptConflictStrategy {
    KeepLocal,
    Overwrite,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptMigrationTag {
    pub id: String,
    pub name: String,
    pub normalized_name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptMigrationPrompt {
    pub id: String,
    pub title: String,
    pub content: String,
    pub excerpt: String,
    pub pinned: bool,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub content_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptMigrationLink {
    pub prompt_id: String,
    pub tag_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptMigrationLimits {
    pub max_prompt_body_bytes: u64,
    pub max_total_body_bytes: u64,
    pub max_archive_uncompressed_bytes: u64,
    pub max_prompts: u64,
    pub max_tags: u64,
    pub max_links: u64,
}

impl Default for PromptMigrationLimits {
    fn default() -> Self {
        Self {
            max_prompt_body_bytes: MAX_PROMPT_BODY_BYTES,
            max_total_body_bytes: 1_073_741_824,
            max_archive_uncompressed_bytes: 1_207_959_552,
            max_prompts: 1_000_000,
            max_tags: 100_000,
            max_links: 20_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MigrationTransportLimits {
    max_legacy_v1_json_bytes: u64,
    max_manifest_bytes: u64,
    max_tag_record_bytes: u64,
    max_link_record_bytes: u64,
    prompt_record_metadata_allowance_bytes: u64,
}

impl Default for MigrationTransportLimits {
    fn default() -> Self {
        Self {
            max_legacy_v1_json_bytes: MAX_LEGACY_V1_JSON_BYTES,
            max_manifest_bytes: MAX_MANIFEST_BYTES,
            max_tag_record_bytes: MAX_TAG_RECORD_BYTES,
            max_link_record_bytes: MAX_LINK_RECORD_BYTES,
            prompt_record_metadata_allowance_bytes: PROMPT_RECORD_METADATA_ALLOWANCE_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMigrationExportSummary {
    pub prompts: u64,
    pub tags: u64,
    pub links: u64,
    pub total_body_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptImportAction {
    Insert,
    SkipSame,
    KeepLocal,
    Overwrite,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImportDecision {
    pub incoming_id: String,
    pub target_id: String,
    pub action: PromptImportAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMigrationPreflight {
    pub prompts: u64,
    pub tags: u64,
    pub links: u64,
    pub total_body_bytes: u64,
    pub inserted: u64,
    pub skipped_same: u64,
    pub kept_local: u64,
    pub overwritten: u64,
    pub duplicated: u64,
    pub decisions: Vec<PromptImportDecision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMigrationImportSummary {
    pub preflight: PromptMigrationPreflight,
    pub inserted_tags: u64,
    pub library_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryManifest {
    path: String,
    count: u64,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptPackageManifest {
    format: String,
    schema_version: u32,
    app_version: String,
    exported_at: String,
    legacy_v1: EntryManifest,
    tags: EntryManifest,
    prompts: EntryManifest,
    links: EntryManifest,
    max_prompt_body_bytes: u64,
    total_body_bytes: u64,
    excluded_sensitive_fields: Vec<String>,
}

#[derive(Debug, Clone)]
struct PromptMeta {
    id: String,
    content_sha256: String,
    pinned: bool,
}

#[derive(Debug, Clone)]
struct TagResolution {
    target_id: String,
    insert: bool,
}

#[derive(Debug, Clone)]
struct PackageInspection {
    manifest: PromptPackageManifest,
    preflight: PromptMigrationPreflight,
    decisions: HashMap<String, PromptImportDecision>,
    tag_resolutions: HashMap<String, TagResolution>,
    manual_order_counts: [usize; 2],
}

#[derive(Debug)]
struct EntryDigest {
    path: String,
    count: u64,
    bytes: u64,
    sha256: String,
}

impl EntryDigest {
    fn into_manifest(self) -> EntryManifest {
        EntryManifest {
            path: self.path,
            count: self.count,
            bytes: self.bytes,
            sha256: self.sha256,
        }
    }
}

struct HashingWriter<'a, W: Write + Seek> {
    inner: &'a mut ZipWriter<W>,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write + Seek> Write for HashingWriter<'_, W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.hasher.update(&buffer[..written]);
        self.bytes = self.bytes.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

struct BoundedCountingWriter {
    bytes: u64,
    max_bytes: u64,
    exceeded: bool,
}

impl BoundedCountingWriter {
    fn new(max_bytes: u64) -> Self {
        Self {
            bytes: 0,
            max_bytes,
            exceeded: false,
        }
    }
}

impl Write for BoundedCountingWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next = self
            .bytes
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| std::io::Error::other("JSONL record size overflow"))?;
        if next > self.max_bytes {
            self.exceeded = true;
            return Err(std::io::Error::other("JSONL record exceeds byte limit"));
        }
        self.bytes = next;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
    bytes: u64,
}

impl<R> HashingReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        (self.bytes, hex::encode(self.hasher.finalize()))
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..read]);
        self.bytes = self.bytes.saturating_add(read as u64);
        Ok(read)
    }
}

pub fn detect_migration_package<R: Read + Seek>(
    reader: &mut R,
) -> Result<MigrationPackageKind, PromptMigrationError> {
    reader.seek(SeekFrom::Start(0))?;
    let mut prefix = [0_u8; 4096];
    let read = reader.read(&mut prefix)?;
    reader.seek(SeekFrom::Start(0))?;
    let visible = &prefix[..read];
    let first = visible.iter().position(|byte| !byte.is_ascii_whitespace());
    if first.is_some_and(|index| matches!(visible[index], b'{' | b'[')) {
        read_legacy_v1_json(reader)?;
        reader.seek(SeekFrom::Start(0))?;
        return Ok(MigrationPackageKind::LegacyV1Json);
    }
    if visible.starts_with(b"PK\x03\x04") {
        let mut archive = ZipArchive::new(&mut *reader)?;
        validate_archive_layout(&mut archive, u64::MAX)?;
        let manifest = read_manifest(&mut archive)?;
        validate_manifest_identity(&manifest)?;
        drop(archive);
        reader.seek(SeekFrom::Start(0))?;
        return Ok(MigrationPackageKind::PromptLibraryV2Zip);
    }
    Err(PromptMigrationError::new(
        "prompt_migration_format_unknown",
        "无法识别迁移包格式。",
    ))
}

pub fn read_legacy_v1_json<R: Read + Seek>(
    reader: &mut R,
) -> Result<Vec<u8>, PromptMigrationError> {
    reader.seek(SeekFrom::Start(0))?;
    let mut contents = Vec::new();
    reader
        .take(MAX_LEGACY_V1_JSON_BYTES + 1)
        .read_to_end(&mut contents)?;
    if contents.len() as u64 > MAX_LEGACY_V1_JSON_BYTES {
        return Err(PromptMigrationError::new(
            "migration_v1_too_large",
            "旧版迁移包超过允许大小。",
        ));
    }
    validate_legacy_v1_bytes(&contents)?;
    reader.seek(SeekFrom::Start(0))?;
    Ok(contents)
}

pub fn extract_embedded_legacy_v1_json<R: Read + Seek>(
    reader: &mut R,
) -> Result<Vec<u8>, PromptMigrationError> {
    reader.seek(SeekFrom::Start(0))?;
    let mut archive = ZipArchive::new(&mut *reader)?;
    validate_archive_layout(&mut archive, u64::MAX)?;
    let bytes = read_bounded_entry(&mut archive, LEGACY_PATH, MAX_LEGACY_V1_JSON_BYTES)?;
    validate_legacy_v1_bytes(&bytes)?;
    drop(archive);
    reader.seek(SeekFrom::Start(0))?;
    Ok(bytes)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn write_v2_package<W, Tags, Prompts, Links>(
    writer: W,
    legacy_v1_json: &[u8],
    app_version: &str,
    exported_at: &str,
    tags: Tags,
    prompts: Prompts,
    links: Links,
) -> Result<PromptMigrationExportSummary, PromptMigrationError>
where
    W: Write + Seek,
    Tags: IntoIterator<Item = Result<PromptMigrationTag, PromptMigrationError>>,
    Prompts: IntoIterator<Item = Result<PromptMigrationPrompt, PromptMigrationError>>,
    Links: IntoIterator<Item = Result<PromptMigrationLink, PromptMigrationError>>,
{
    write_v2_package_with_limits(
        writer,
        legacy_v1_json,
        app_version,
        exported_at,
        tags,
        prompts,
        links,
        &PromptMigrationLimits::default(),
        MigrationTransportLimits::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn write_v2_package_with_limits<W, Tags, Prompts, Links>(
    writer: W,
    legacy_v1_json: &[u8],
    app_version: &str,
    exported_at: &str,
    tags: Tags,
    prompts: Prompts,
    links: Links,
    limits: &PromptMigrationLimits,
    transport_limits: MigrationTransportLimits,
) -> Result<PromptMigrationExportSummary, PromptMigrationError>
where
    W: Write + Seek,
    Tags: IntoIterator<Item = Result<PromptMigrationTag, PromptMigrationError>>,
    Prompts: IntoIterator<Item = Result<PromptMigrationPrompt, PromptMigrationError>>,
    Links: IntoIterator<Item = Result<PromptMigrationLink, PromptMigrationError>>,
{
    validate_legacy_v1_bytes_with_limit(legacy_v1_json, transport_limits.max_legacy_v1_json_bytes)?;
    if app_version.trim().is_empty() || exported_at.trim().is_empty() {
        return Err(PromptMigrationError::new(
            "prompt_migration_manifest_invalid",
            "应用版本和导出时间不能为空。",
        ));
    }

    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let mut zip = ZipWriter::new(writer);

    zip.start_file(LEGACY_PATH, options)?;
    let mut legacy_sink = HashingWriter {
        inner: &mut zip,
        hasher: Sha256::new(),
        bytes: 0,
    };
    legacy_sink.write_all(legacy_v1_json)?;
    let legacy_digest = finish_writer_digest(LEGACY_PATH, 1, legacy_sink).into_manifest();
    ensure_entry_bytes_within_limit(&legacy_digest, transport_limits.max_legacy_v1_json_bytes)?;

    zip.start_file(TAGS_PATH, options)?;
    let mut tag_sink = HashingWriter {
        inner: &mut zip,
        hasher: Sha256::new(),
        bytes: 0,
    };
    let mut tag_ids = HashSet::new();
    let mut tag_names = HashSet::new();
    let mut tag_count = 0_u64;
    for tag in tags {
        let tag = tag?;
        validate_tag_record(&tag)?;
        if !tag_ids.insert(tag.id.clone()) || !tag_names.insert(tag.normalized_name.clone()) {
            return Err(PromptMigrationError::new(
                "prompt_migration_duplicate_tag",
                "迁移包包含重复的标签 ID 或规范化名称。",
            ));
        }
        tag_count =
            checked_increment(tag_count, limits.max_tags, "prompt_migration_too_many_tags")?;
        write_jsonl_record(
            &mut tag_sink,
            &tag,
            TAGS_PATH,
            transport_limits.max_tag_record_bytes,
        )?;
    }
    let tags_digest = finish_writer_digest(TAGS_PATH, tag_count, tag_sink).into_manifest();

    zip.start_file(PROMPTS_PATH, options)?;
    let mut prompt_sink = HashingWriter {
        inner: &mut zip,
        hasher: Sha256::new(),
        bytes: 0,
    };
    let mut prompt_ids = HashSet::new();
    let mut prompt_count = 0_u64;
    let mut total_body_bytes = 0_u64;
    for prompt in prompts {
        let prompt = prompt?;
        let body_bytes = validate_prompt_record(&prompt, limits)?;
        if !prompt_ids.insert(prompt.id.clone()) {
            return Err(PromptMigrationError::new(
                "prompt_migration_duplicate_prompt",
                "迁移包包含重复的提示词 ID。",
            ));
        }
        prompt_count = checked_increment(
            prompt_count,
            limits.max_prompts,
            "prompt_migration_too_many_prompts",
        )?;
        total_body_bytes = total_body_bytes.checked_add(body_bytes).ok_or_else(|| {
            PromptMigrationError::new("prompt_migration_total_size_overflow", "正文总大小溢出。")
        })?;
        if total_body_bytes > limits.max_total_body_bytes {
            return Err(PromptMigrationError::new(
                "prompt_migration_total_body_too_large",
                "迁移包中的提示词正文总大小超过允许上限。",
            ));
        }
        write_jsonl_record(
            &mut prompt_sink,
            &prompt,
            PROMPTS_PATH,
            max_prompt_record_bytes_with_allowance(
                limits,
                transport_limits.prompt_record_metadata_allowance_bytes,
            )?,
        )?;
    }
    let prompts_digest =
        finish_writer_digest(PROMPTS_PATH, prompt_count, prompt_sink).into_manifest();

    zip.start_file(LINKS_PATH, options)?;
    let mut link_sink = HashingWriter {
        inner: &mut zip,
        hasher: Sha256::new(),
        bytes: 0,
    };
    let mut link_count = 0_u64;
    let mut link_pairs = HashSet::new();
    let mut prompt_link_counts: HashMap<String, u64> = HashMap::new();
    for link in links {
        let link = link?;
        validate_public_id(&link.prompt_id, "提示词")?;
        validate_public_id(&link.tag_id, "标签")?;
        if !prompt_ids.contains(&link.prompt_id) || !tag_ids.contains(&link.tag_id) {
            return Err(PromptMigrationError::new(
                "prompt_migration_dangling_link",
                "标签关联引用了迁移包中不存在的提示词或标签。",
            ));
        }
        if !link_pairs.insert((link.prompt_id.clone(), link.tag_id.clone())) {
            return Err(PromptMigrationError::new(
                "prompt_migration_duplicate_link",
                "迁移包包含重复的标签关联。",
            ));
        }
        let per_prompt = prompt_link_counts
            .entry(link.prompt_id.clone())
            .or_default();
        *per_prompt += 1;
        if *per_prompt > 20 {
            return Err(PromptMigrationError::new(
                "prompt_migration_too_many_prompt_tags",
                "单篇提示词最多关联 20 个标签。",
            ));
        }
        link_count = checked_increment(
            link_count,
            limits.max_links,
            "prompt_migration_too_many_links",
        )?;
        write_jsonl_record(
            &mut link_sink,
            &link,
            LINKS_PATH,
            transport_limits.max_link_record_bytes,
        )?;
    }
    let links_digest = finish_writer_digest(LINKS_PATH, link_count, link_sink).into_manifest();

    let manifest = PromptPackageManifest {
        format: PACKAGE_FORMAT.to_string(),
        schema_version: PROMPT_MIGRATION_SCHEMA_VERSION,
        app_version: app_version.to_string(),
        exported_at: exported_at.to_string(),
        legacy_v1: legacy_digest,
        tags: tags_digest,
        prompts: prompts_digest,
        links: links_digest,
        max_prompt_body_bytes: MAX_PROMPT_BODY_BYTES,
        total_body_bytes,
        excluded_sensitive_fields: vec![
            "githubToken".to_string(),
            "tokenKey".to_string(),
            "keychainData".to_string(),
            "taskLogs".to_string(),
            "sourceCode".to_string(),
            "sourceArchive".to_string(),
        ],
    };
    let manifest_bytes =
        serialize_manifest_bounded(&manifest, transport_limits.max_manifest_bytes)?;
    ensure_archive_uncompressed_bytes(
        [
            manifest.legacy_v1.bytes,
            manifest.tags.bytes,
            manifest.prompts.bytes,
            manifest.links.bytes,
            manifest_bytes.len() as u64,
        ],
        limits.max_archive_uncompressed_bytes,
    )?;
    zip.start_file(MANIFEST_PATH, options)?;
    zip.write_all(&manifest_bytes)?;
    let mut writer = zip.finish()?;
    writer.flush()?;

    Ok(PromptMigrationExportSummary {
        prompts: prompt_count,
        tags: tag_count,
        links: link_count,
        total_body_bytes,
    })
}

pub fn write_v2_package_atomic<Tags, Prompts, Links>(
    path: &Path,
    legacy_v1_json: &[u8],
    app_version: &str,
    exported_at: &str,
    tags: Tags,
    prompts: Prompts,
    links: Links,
) -> Result<PromptMigrationExportSummary, PromptMigrationError>
where
    Tags: IntoIterator<Item = Result<PromptMigrationTag, PromptMigrationError>>,
    Prompts: IntoIterator<Item = Result<PromptMigrationPrompt, PromptMigrationError>>,
    Links: IntoIterator<Item = Result<PromptMigrationLink, PromptMigrationError>>,
{
    write_v2_package_atomic_with_limits(
        path,
        legacy_v1_json,
        app_version,
        exported_at,
        tags,
        prompts,
        links,
        &PromptMigrationLimits::default(),
        MigrationTransportLimits::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn write_v2_package_atomic_with_limits<Tags, Prompts, Links>(
    path: &Path,
    legacy_v1_json: &[u8],
    app_version: &str,
    exported_at: &str,
    tags: Tags,
    prompts: Prompts,
    links: Links,
    limits: &PromptMigrationLimits,
    transport_limits: MigrationTransportLimits,
) -> Result<PromptMigrationExportSummary, PromptMigrationError>
where
    Tags: IntoIterator<Item = Result<PromptMigrationTag, PromptMigrationError>>,
    Prompts: IntoIterator<Item = Result<PromptMigrationPrompt, PromptMigrationError>>,
    Links: IntoIterator<Item = Result<PromptMigrationLink, PromptMigrationError>>,
{
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| {
            PromptMigrationError::new(
                "prompt_migration_path_invalid",
                "迁移包必须写入明确的父目录。",
            )
        })?;
    if !parent.is_dir() {
        return Err(PromptMigrationError::new(
            "prompt_migration_parent_missing",
            "迁移包目标目录不存在。",
        ));
    }
    let mut temporary = NamedTempFile::new_in(parent)?;
    let summary = write_v2_package_with_limits(
        temporary.as_file_mut(),
        legacy_v1_json,
        app_version,
        exported_at,
        tags,
        prompts,
        links,
        limits,
        transport_limits,
    )?;
    temporary.as_file_mut().flush()?;
    temporary.as_file_mut().sync_all()?;
    temporary.persist(path).map_err(|error| {
        PromptMigrationError::new(
            "prompt_migration_atomic_replace_failed",
            error.error.to_string(),
        )
    })?;
    File::open(parent)?.sync_all()?;
    Ok(summary)
}

fn finish_writer_digest<W: Write + Seek>(
    path: &str,
    count: u64,
    writer: HashingWriter<'_, W>,
) -> EntryDigest {
    EntryDigest {
        path: path.to_string(),
        count,
        bytes: writer.bytes,
        sha256: hex::encode(writer.hasher.finalize()),
    }
}

fn write_jsonl_record<W: Write + Seek, T: Serialize>(
    sink: &mut HashingWriter<'_, W>,
    value: &T,
    path: &str,
    max_record_bytes: u64,
) -> Result<(), PromptMigrationError> {
    let mut counter = BoundedCountingWriter::new(max_record_bytes);
    let count_result = serde_json::to_writer(&mut counter, value);
    if counter.exceeded {
        return Err(PromptMigrationError::new(
            "prompt_migration_jsonl_record_too_large",
            format!("ZIP 项 {path} 包含超过允许上限的单条记录。"),
        ));
    }
    count_result?;
    if let Err(error) = counter.write_all(b"\n") {
        if counter.exceeded {
            return Err(PromptMigrationError::new(
                "prompt_migration_jsonl_record_too_large",
                format!("ZIP 项 {path} 包含超过允许上限的单条记录。"),
            ));
        }
        return Err(error.into());
    }

    serde_json::to_writer(&mut *sink, value)?;
    sink.write_all(b"\n")?;
    Ok(())
}

fn serialize_manifest_bounded(
    manifest: &PromptPackageManifest,
    max_bytes: u64,
) -> Result<Vec<u8>, PromptMigrationError> {
    let mut counter = BoundedCountingWriter::new(max_bytes);
    let count_result = serde_json::to_writer_pretty(&mut counter, manifest);
    if counter.exceeded {
        return Err(PromptMigrationError::new(
            "prompt_migration_entry_too_large",
            format!("ZIP 项 {MANIFEST_PATH} 超过允许上限。"),
        ));
    }
    count_result?;
    if let Err(error) = counter.write_all(b"\n") {
        if counter.exceeded {
            return Err(PromptMigrationError::new(
                "prompt_migration_entry_too_large",
                format!("ZIP 项 {MANIFEST_PATH} 超过允许上限。"),
            ));
        }
        return Err(error.into());
    }

    let capacity = usize::try_from(counter.bytes).map_err(|_| {
        PromptMigrationError::new(
            "prompt_migration_entry_too_large",
            format!("ZIP 项 {MANIFEST_PATH} 超过本机可分配上限。"),
        )
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    serde_json::to_writer_pretty(&mut bytes, manifest)?;
    bytes.push(b'\n');
    debug_assert_eq!(bytes.len() as u64, counter.bytes);
    Ok(bytes)
}

fn ensure_named_bytes_within_limit(
    path: &str,
    actual_bytes: u64,
    max_bytes: u64,
) -> Result<(), PromptMigrationError> {
    if actual_bytes > max_bytes {
        return Err(PromptMigrationError::new(
            "prompt_migration_entry_too_large",
            format!("ZIP 项 {path} 超过允许上限。"),
        ));
    }
    Ok(())
}

fn ensure_entry_bytes_within_limit(
    entry: &EntryManifest,
    max_bytes: u64,
) -> Result<(), PromptMigrationError> {
    ensure_named_bytes_within_limit(&entry.path, entry.bytes, max_bytes)
}

fn ensure_archive_uncompressed_bytes(
    entry_bytes: impl IntoIterator<Item = u64>,
    max_bytes: u64,
) -> Result<u64, PromptMigrationError> {
    let mut total = 0_u64;
    for bytes in entry_bytes {
        total = total.checked_add(bytes).ok_or_else(|| {
            PromptMigrationError::new(
                "prompt_migration_archive_size_overflow",
                "迁移包解压大小溢出。",
            )
        })?;
        if total > max_bytes {
            return Err(PromptMigrationError::new(
                "prompt_migration_archive_too_large",
                "迁移包解压后大小超过允许上限。",
            ));
        }
    }
    Ok(total)
}

fn checked_increment(
    current: u64,
    limit: u64,
    code: &'static str,
) -> Result<u64, PromptMigrationError> {
    let next = current
        .checked_add(1)
        .ok_or_else(|| PromptMigrationError::new(code, "迁移包记录数量溢出。"))?;
    if next > limit {
        return Err(PromptMigrationError::new(
            code,
            "迁移包记录数量超过允许上限。",
        ));
    }
    Ok(next)
}

fn validate_public_id(value: &str, kind: &str) -> Result<(), PromptMigrationError> {
    let valid = !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(PromptMigrationError::new(
            "prompt_migration_id_invalid",
            format!("{kind} ID 格式无效。"),
        ))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_tag_record(tag: &PromptMigrationTag) -> Result<(), PromptMigrationError> {
    validate_public_id(&tag.id, "标签")?;
    let normalized = crate::prompts::normalize_tag_name(&tag.name).map_err(|_| {
        PromptMigrationError::new("prompt_migration_tag_invalid", "标签名称不符合产品约束。")
    })?;
    if tag.name != normalized.display || tag.normalized_name != normalized.key {
        return Err(PromptMigrationError::new(
            "prompt_migration_tag_not_normalized",
            "标签名称未按 trim、Unicode NFC 和大小写规则规范化。",
        ));
    }
    if tag.created_at.trim().is_empty() || tag.updated_at.trim().is_empty() {
        return Err(PromptMigrationError::new(
            "prompt_migration_timestamp_invalid",
            "标签时间字段不能为空。",
        ));
    }
    Ok(())
}

fn validate_prompt_record(
    prompt: &PromptMigrationPrompt,
    limits: &PromptMigrationLimits,
) -> Result<u64, PromptMigrationError> {
    validate_public_id(&prompt.id, "提示词")?;
    let title = crate::prompts::validate_prompt_title(&prompt.title).map_err(|_| {
        PromptMigrationError::new(
            "prompt_migration_prompt_title_invalid",
            "提示词标题不符合产品约束。",
        )
    })?;
    if title != prompt.title {
        return Err(PromptMigrationError::new(
            "prompt_migration_prompt_title_not_normalized",
            "提示词标题未按 trim 和 Unicode NFC 规则规范化。",
        ));
    }
    crate::prompts::validate_prompt_content(&prompt.content).map_err(|_| {
        PromptMigrationError::new(
            "prompt_migration_prompt_content_invalid",
            "提示词正文为空或超过产品上限。",
        )
    })?;
    let body_bytes = prompt.content.len() as u64;
    if body_bytes > limits.max_prompt_body_bytes {
        return Err(PromptMigrationError::new(
            "prompt_migration_prompt_content_too_large",
            "单篇提示词正文超过迁移预检上限。",
        ));
    }
    let expected_hash = sha256_hex(prompt.content.as_bytes());
    if prompt.content_sha256 != expected_hash {
        return Err(PromptMigrationError::new(
            "prompt_migration_prompt_hash_mismatch",
            "提示词正文摘要校验失败。",
        ));
    }
    if prompt.excerpt != crate::prompts::plain_text_excerpt(&prompt.content) {
        return Err(PromptMigrationError::new(
            "prompt_migration_prompt_excerpt_mismatch",
            "提示词纯文本摘要与正文不一致。",
        ));
    }
    if prompt.revision < 1 {
        return Err(PromptMigrationError::new(
            "prompt_migration_revision_invalid",
            "提示词 revision 必须大于等于 1。",
        ));
    }
    if prompt.created_at.trim().is_empty() || prompt.updated_at.trim().is_empty() {
        return Err(PromptMigrationError::new(
            "prompt_migration_timestamp_invalid",
            "提示词时间字段不能为空。",
        ));
    }
    Ok(body_bytes)
}

fn validate_legacy_v1_bytes(bytes: &[u8]) -> Result<(), PromptMigrationError> {
    validate_legacy_v1_bytes_with_limit(bytes, MAX_LEGACY_V1_JSON_BYTES)
}

fn validate_legacy_v1_bytes_with_limit(
    bytes: &[u8],
    max_bytes: u64,
) -> Result<(), PromptMigrationError> {
    ensure_named_bytes_within_limit(LEGACY_PATH, bytes.len() as u64, max_bytes)?;
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| {
        PromptMigrationError::new(
            "migration_v1_json_invalid",
            format!("旧版迁移包 JSON 无法解析：{error}"),
        )
    })?;
    let root = value.as_object().ok_or_else(|| {
        PromptMigrationError::new("migration_v1_json_invalid", "旧版迁移包根节点必须是对象。")
    })?;
    if root
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        != Some(1)
    {
        return Err(PromptMigrationError::new(
            "migration_v1_schema_unsupported",
            "内嵌旧版迁移包必须使用 schemaVersion=1。",
        ));
    }
    audit_sensitive_json_keys(&value, "$")
}

fn audit_sensitive_json_keys(
    value: &serde_json::Value,
    path: &str,
) -> Result<(), PromptMigrationError> {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                let normalized = key
                    .chars()
                    .filter(|character| character.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect::<String>();
                if matches!(
                    normalized.as_str(),
                    "token"
                        | "tokenkey"
                        | "githubtoken"
                        | "keychaindata"
                        | "tasklogs"
                        | "sourcecode"
                        | "sourcearchive"
                ) {
                    return Err(PromptMigrationError::new(
                        "prompt_migration_sensitive_field",
                        format!("迁移包包含禁止的敏感字段：{path}.{key}"),
                    ));
                }
                audit_sensitive_json_keys(child, &format!("{path}.{key}"))?;
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                audit_sensitive_json_keys(child, &format!("{path}[{index}]"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn valid_archive_name(name: &str) -> bool {
    if name.contains('\\') || name.starts_with('/') || name.ends_with('/') {
        return false;
    }
    let path = Path::new(name);
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn validate_archive_layout<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    max_uncompressed_bytes: u64,
) -> Result<(), PromptMigrationError> {
    let expected = EXPECTED_PATHS.into_iter().collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        let name = file.name().to_string();
        if file.is_dir() || !valid_archive_name(&name) || !expected.contains(name.as_str()) {
            return Err(PromptMigrationError::new(
                "prompt_migration_zip_path_invalid",
                "迁移包包含未授权、目录穿越或目录型 ZIP 项。",
            ));
        }
        if !seen.insert(name) {
            return Err(PromptMigrationError::new(
                "prompt_migration_zip_duplicate_entry",
                "迁移包包含重复的 ZIP 项。",
            ));
        }
        total = total.checked_add(file.size()).ok_or_else(|| {
            PromptMigrationError::new(
                "prompt_migration_archive_size_overflow",
                "迁移包解压大小溢出。",
            )
        })?;
        if total > max_uncompressed_bytes {
            return Err(PromptMigrationError::new(
                "prompt_migration_archive_too_large",
                "迁移包解压后大小超过允许上限。",
            ));
        }
    }
    if seen != expected.into_iter().map(str::to_string).collect() {
        return Err(PromptMigrationError::new(
            "prompt_migration_zip_entry_missing",
            "迁移包缺少必要的 ZIP 项。",
        ));
    }
    Ok(())
}

fn read_bounded_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, PromptMigrationError> {
    let entry = archive.by_name(path)?;
    if entry.size() > max_bytes {
        return Err(PromptMigrationError::new(
            "prompt_migration_entry_too_large",
            format!("ZIP 项 {path} 超过允许上限。"),
        ));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(PromptMigrationError::new(
            "prompt_migration_entry_too_large",
            format!("ZIP 项 {path} 超过允许上限。"),
        ));
    }
    Ok(bytes)
}

fn read_manifest<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<PromptPackageManifest, PromptMigrationError> {
    let bytes = read_bounded_entry(archive, MANIFEST_PATH, MAX_MANIFEST_BYTES)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        PromptMigrationError::new(
            "prompt_migration_manifest_invalid",
            format!("迁移包 manifest 无法解析：{error}"),
        )
    })
}

fn validate_manifest_identity(
    manifest: &PromptPackageManifest,
) -> Result<(), PromptMigrationError> {
    if manifest.format != PACKAGE_FORMAT
        || manifest.schema_version != PROMPT_MIGRATION_SCHEMA_VERSION
        || manifest.app_version.trim().is_empty()
        || manifest.exported_at.trim().is_empty()
        || manifest.max_prompt_body_bytes != MAX_PROMPT_BODY_BYTES
    {
        return Err(PromptMigrationError::new(
            "prompt_migration_schema_unsupported",
            "迁移包格式或 schemaVersion 不兼容。",
        ));
    }
    let entries = [
        (&manifest.legacy_v1, LEGACY_PATH),
        (&manifest.tags, TAGS_PATH),
        (&manifest.prompts, PROMPTS_PATH),
        (&manifest.links, LINKS_PATH),
    ];
    if entries
        .iter()
        .any(|(entry, expected)| entry.path != *expected)
    {
        return Err(PromptMigrationError::new(
            "prompt_migration_manifest_invalid",
            "manifest 中的 ZIP 项路径不符合固定协议。",
        ));
    }
    Ok(())
}

fn verify_entry_digest(
    expected: &EntryManifest,
    actual: &EntryDigest,
) -> Result<(), PromptMigrationError> {
    if expected.path != actual.path
        || expected.count != actual.count
        || expected.bytes != actual.bytes
        || expected.sha256 != actual.sha256
    {
        return Err(PromptMigrationError::new(
            "prompt_migration_entry_digest_mismatch",
            format!("ZIP 项 {} 的数量、大小或 SHA-256 校验失败。", actual.path),
        ));
    }
    Ok(())
}

fn read_jsonl_entry<R, T, F>(
    archive: &mut ZipArchive<R>,
    path: &str,
    max_count: u64,
    max_record_bytes: u64,
    mut visit: F,
) -> Result<EntryDigest, PromptMigrationError>
where
    R: Read + Seek,
    T: for<'de> Deserialize<'de>,
    F: FnMut(T) -> Result<(), PromptMigrationError>,
{
    let entry = archive.by_name(path)?;
    let mut hashing = HashingReader::new(entry);
    let mut count = 0_u64;
    {
        let mut buffered = BufReader::new(&mut hashing);
        loop {
            let mut record = Vec::new();
            let read = (&mut buffered)
                .take(max_record_bytes + 1)
                .read_until(b'\n', &mut record)?;
            if read == 0 {
                break;
            }
            if record.len() as u64 > max_record_bytes {
                return Err(PromptMigrationError::new(
                    "prompt_migration_jsonl_record_too_large",
                    format!("ZIP 项 {path} 包含超过允许上限的单条记录。"),
                ));
            }
            if record.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let item = serde_json::from_slice::<T>(&record).map_err(|error| {
                PromptMigrationError::new(
                    "prompt_migration_jsonl_invalid",
                    format!("ZIP 项 {path} 无法解析：{error}"),
                )
            })?;
            count = checked_increment(count, max_count, "prompt_migration_too_many_records")?;
            visit(item)?;
        }
    }
    let (bytes, sha256) = hashing.finish();
    Ok(EntryDigest {
        path: path.to_string(),
        count,
        bytes,
        sha256,
    })
}

fn max_prompt_record_bytes(limits: &PromptMigrationLimits) -> Result<u64, PromptMigrationError> {
    max_prompt_record_bytes_with_allowance(limits, PROMPT_RECORD_METADATA_ALLOWANCE_BYTES)
}

fn max_prompt_record_bytes_with_allowance(
    limits: &PromptMigrationLimits,
    metadata_allowance_bytes: u64,
) -> Result<u64, PromptMigrationError> {
    limits
        .max_prompt_body_bytes
        .checked_mul(6)
        .and_then(|bytes| bytes.checked_add(metadata_allowance_bytes))
        .ok_or_else(|| {
            PromptMigrationError::new(
                "prompt_migration_record_limit_overflow",
                "提示词 JSONL 单条记录上限溢出。",
            )
        })
}

pub fn preflight_v2_for_connection<R: Read + Seek>(
    connection: &Connection,
    reader: &mut R,
    limits: &PromptMigrationLimits,
    strategy: PromptConflictStrategy,
) -> Result<PromptMigrationPreflight, PromptMigrationError> {
    inspect_v2_package(connection, reader, limits, strategy).map(|inspection| inspection.preflight)
}

#[cfg(test)]
pub fn import_v2_transactional<R: Read + Seek>(
    connection: &mut Connection,
    reader: &mut R,
    limits: &PromptMigrationLimits,
    strategy: PromptConflictStrategy,
) -> Result<PromptMigrationImportSummary, PromptMigrationError> {
    import_v2_transactional_with_legacy(
        connection,
        reader,
        limits,
        strategy,
        |_transaction, _legacy_v1_json| Ok(()),
    )
}

/// Imports the embedded v1 metadata and prompt payload under one SQLite
/// transaction. Production callers should adapt their existing v1 merge
/// routine through `import_legacy`; returning an error rolls back both v1 and
/// prompt-library writes. `import_v2_transactional` is the prompt-only wrapper.
pub fn import_v2_transactional_with_legacy<R, LegacyImport>(
    connection: &mut Connection,
    reader: &mut R,
    limits: &PromptMigrationLimits,
    strategy: PromptConflictStrategy,
    import_legacy: LegacyImport,
) -> Result<PromptMigrationImportSummary, PromptMigrationError>
where
    R: Read + Seek,
    LegacyImport: FnOnce(&rusqlite::Transaction<'_>, &[u8]) -> Result<(), PromptMigrationError>,
{
    let transaction = connection.transaction()?;
    let inspection = inspect_v2_package(&transaction, reader, limits, strategy)?;

    reader.seek(SeekFrom::Start(0))?;
    let mut archive = ZipArchive::new(&mut *reader)?;
    validate_archive_layout(&mut archive, limits.max_archive_uncompressed_bytes)?;
    let manifest = read_manifest(&mut archive)?;
    validate_manifest_identity(&manifest)?;
    if manifest != inspection.manifest {
        return Err(PromptMigrationError::new(
            "prompt_migration_preflight_drift",
            "迁移包 manifest 在预检后发生变化。",
        ));
    }
    let legacy_v1_json = read_bounded_entry(&mut archive, LEGACY_PATH, MAX_LEGACY_V1_JSON_BYTES)?;
    verify_entry_digest(
        &inspection.manifest.legacy_v1,
        &EntryDigest {
            path: LEGACY_PATH.to_string(),
            count: 1,
            bytes: legacy_v1_json.len() as u64,
            sha256: sha256_hex(&legacy_v1_json),
        },
    )?;
    import_legacy(&transaction, &legacy_v1_json)?;
    let mut inserted_tags = 0_u64;
    let tags_digest = read_jsonl_entry::<_, PromptMigrationTag, _>(
        &mut archive,
        TAGS_PATH,
        limits.max_tags,
        MAX_TAG_RECORD_BYTES,
        |tag| {
            let resolution = inspection.tag_resolutions.get(&tag.id).ok_or_else(|| {
                PromptMigrationError::new("prompt_migration_preflight_drift", "标签预检决策缺失。")
            })?;
            if resolution.insert {
                transaction.execute(
                    "INSERT INTO prompt_tags(id, name, normalized_name, created_at, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5)",
                    params![
                        resolution.target_id,
                        tag.name,
                        tag.normalized_name,
                        tag.created_at,
                        tag.updated_at
                    ],
                )?;
                inserted_tags += 1;
            }
            Ok(())
        },
    )?;
    verify_entry_digest(&inspection.manifest.tags, &tags_digest)?;

    let imported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut manual_orders = [
        crate::prompts::manual_orders_for_front(
            &transaction,
            false,
            inspection.manual_order_counts[0],
        )?
        .into_iter(),
        crate::prompts::manual_orders_for_front(
            &transaction,
            true,
            inspection.manual_order_counts[1],
        )?
        .into_iter(),
    ];
    let mut changed_prompt_targets = HashSet::new();
    let prompts_digest = read_jsonl_entry::<_, PromptMigrationPrompt, _>(
        &mut archive,
        PROMPTS_PATH,
        limits.max_prompts,
        max_prompt_record_bytes(limits)?,
        |prompt| {
            let decision = inspection.decisions.get(&prompt.id).ok_or_else(|| {
                PromptMigrationError::new(
                    "prompt_migration_preflight_drift",
                    "提示词预检决策缺失。",
                )
            })?;
            match decision.action {
                PromptImportAction::SkipSame | PromptImportAction::KeepLocal => return Ok(()),
                PromptImportAction::Insert => {
                    let group = if prompt.pinned { 1 } else { 0 };
                    let manual_order = manual_orders[group].next().ok_or_else(|| {
                        PromptMigrationError::new(
                            "prompt_migration_preflight_drift",
                            "提示词手动排序预分配数量不足。",
                        )
                    })?;
                    transaction.execute(
                        "INSERT INTO prompts
                         (id, title, content, excerpt, pinned, manual_order, revision, created_at, updated_at)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            decision.target_id,
                            prompt.title,
                            prompt.content,
                            prompt.excerpt,
                            if prompt.pinned { 1 } else { 0 },
                            manual_order,
                            prompt.revision,
                            prompt.created_at,
                            prompt.updated_at
                        ],
                    )?;
                }
                PromptImportAction::Duplicate => {
                    let group = if prompt.pinned { 1 } else { 0 };
                    let manual_order = manual_orders[group].next().ok_or_else(|| {
                        PromptMigrationError::new(
                            "prompt_migration_preflight_drift",
                            "提示词手动排序预分配数量不足。",
                        )
                    })?;
                    transaction.execute(
                        "INSERT INTO prompts
                         (id, title, content, excerpt, pinned, manual_order, revision, created_at, updated_at)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
                        params![
                            decision.target_id,
                            prompt.title,
                            prompt.content,
                            prompt.excerpt,
                            if prompt.pinned { 1 } else { 0 },
                            manual_order,
                            imported_at
                        ],
                    )?;
                }
                PromptImportAction::Overwrite => {
                    let group = if prompt.pinned { 1 } else { 0 };
                    let manual_order = manual_orders[group].next().ok_or_else(|| {
                        PromptMigrationError::new(
                            "prompt_migration_preflight_drift",
                            "提示词手动排序预分配数量不足。",
                        )
                    })?;
                    let local_revision: i64 = transaction.query_row(
                        "SELECT revision FROM prompts WHERE id = ?1",
                        [&decision.target_id],
                        |row| row.get(0),
                    )?;
                    let next_revision = prompt.revision.max(local_revision.saturating_add(1));
                    let changed = transaction.execute(
                        "UPDATE prompts
                         SET title = ?2, content = ?3, excerpt = ?4, pinned = ?5,
                             manual_order = ?6, revision = ?7, updated_at = ?8
                         WHERE id = ?1",
                        params![
                            decision.target_id,
                            prompt.title,
                            prompt.content,
                            prompt.excerpt,
                            if prompt.pinned { 1 } else { 0 },
                            manual_order,
                            next_revision,
                            prompt.updated_at
                        ],
                    )?;
                    if changed != 1 {
                        return Err(PromptMigrationError::new(
                            "prompt_migration_conflict_drift",
                            "覆盖目标在导入事务中已不存在。",
                        ));
                    }
                    transaction.execute(
                        "DELETE FROM prompt_tag_links
                         WHERE prompt_row_id = (SELECT row_id FROM prompts WHERE id = ?1)",
                        [&decision.target_id],
                    )?;
                }
            }
            changed_prompt_targets.insert(decision.target_id.clone());
            Ok(())
        },
    )?;
    verify_entry_digest(&inspection.manifest.prompts, &prompts_digest)?;
    if manual_orders.iter().any(|orders| orders.len() != 0) {
        return Err(PromptMigrationError::new(
            "prompt_migration_preflight_drift",
            "提示词手动排序预分配数量与导入结果不一致。",
        ));
    }

    let links_digest = read_jsonl_entry::<_, PromptMigrationLink, _>(
        &mut archive,
        LINKS_PATH,
        limits.max_links,
        MAX_LINK_RECORD_BYTES,
        |link| {
            let prompt_decision = inspection.decisions.get(&link.prompt_id).ok_or_else(|| {
                PromptMigrationError::new(
                    "prompt_migration_preflight_drift",
                    "标签关联缺少提示词预检决策。",
                )
            })?;
            if matches!(
                prompt_decision.action,
                PromptImportAction::SkipSame | PromptImportAction::KeepLocal
            ) {
                return Ok(());
            }
            let tag_resolution = inspection
                .tag_resolutions
                .get(&link.tag_id)
                .ok_or_else(|| {
                    PromptMigrationError::new(
                        "prompt_migration_preflight_drift",
                        "标签关联缺少标签预检决策。",
                    )
                })?;
            let changed = transaction.execute(
                "INSERT INTO prompt_tag_links(prompt_row_id, tag_row_id)
                 SELECT prompt.row_id, tag.row_id
                 FROM prompts AS prompt, prompt_tags AS tag
                 WHERE prompt.id = ?1 AND tag.id = ?2",
                params![prompt_decision.target_id, tag_resolution.target_id],
            )?;
            if changed != 1 {
                return Err(PromptMigrationError::new(
                    "prompt_migration_reference_drift",
                    "导入事务无法解析提示词或标签引用。",
                ));
            }
            Ok(())
        },
    )?;
    verify_entry_digest(&inspection.manifest.links, &links_digest)?;

    let changed = inserted_tags > 0 || !changed_prompt_targets.is_empty();
    let library_revision = if changed {
        transaction
            .execute(
                "INSERT INTO prompt_fts(prompt_fts) VALUES('integrity-check')",
                [],
            )
            .map_err(|error| {
                PromptMigrationError::new(
                    "prompt_migration_fts_integrity_failed",
                    format!("全文索引完整性检查失败：{error}"),
                )
            })?;
        let updated = transaction.execute(
            "UPDATE prompt_library_meta
             SET library_revision = library_revision + 1 WHERE id = 1",
            [],
        )?;
        if updated != 1 {
            return Err(PromptMigrationError::new(
                "prompt_migration_meta_missing",
                "提示词库元数据行缺失。",
            ));
        }
        transaction.query_row(
            "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
            [],
            |row| row.get(0),
        )?
    } else {
        transaction.query_row(
            "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
            [],
            |row| row.get(0),
        )?
    };

    drop(archive);
    transaction.commit()?;
    reader.seek(SeekFrom::Start(0))?;

    Ok(PromptMigrationImportSummary {
        preflight: inspection.preflight,
        inserted_tags,
        library_revision,
    })
}

fn inspect_v2_package<R: Read + Seek>(
    connection: &Connection,
    reader: &mut R,
    limits: &PromptMigrationLimits,
    strategy: PromptConflictStrategy,
) -> Result<PackageInspection, PromptMigrationError> {
    reader.seek(SeekFrom::Start(0))?;
    let mut archive = ZipArchive::new(&mut *reader)?;
    validate_archive_layout(&mut archive, limits.max_archive_uncompressed_bytes)?;
    let manifest = read_manifest(&mut archive)?;
    validate_manifest_identity(&manifest)?;
    for required in [
        "githubToken",
        "tokenKey",
        "keychainData",
        "taskLogs",
        "sourceCode",
        "sourceArchive",
    ] {
        if !manifest
            .excluded_sensitive_fields
            .iter()
            .any(|field| field == required)
        {
            return Err(PromptMigrationError::new(
                "prompt_migration_sensitive_policy_missing",
                "manifest 未声明完整的敏感字段排除策略。",
            ));
        }
    }

    let legacy_bytes = read_bounded_entry(&mut archive, LEGACY_PATH, MAX_LEGACY_V1_JSON_BYTES)?;
    validate_legacy_v1_bytes(&legacy_bytes)?;
    verify_entry_digest(
        &manifest.legacy_v1,
        &EntryDigest {
            path: LEGACY_PATH.to_string(),
            count: 1,
            bytes: legacy_bytes.len() as u64,
            sha256: sha256_hex(&legacy_bytes),
        },
    )?;

    let mut tag_ids = HashSet::new();
    let mut normalized_names = HashSet::new();
    let mut tag_resolutions = HashMap::new();
    let tags_digest = read_jsonl_entry::<_, PromptMigrationTag, _>(
        &mut archive,
        TAGS_PATH,
        limits.max_tags,
        MAX_TAG_RECORD_BYTES,
        |tag| {
            validate_tag_record(&tag)?;
            if !tag_ids.insert(tag.id.clone())
                || !normalized_names.insert(tag.normalized_name.clone())
            {
                return Err(PromptMigrationError::new(
                    "prompt_migration_duplicate_tag",
                    "迁移包包含重复的标签 ID 或规范化名称。",
                ));
            }
            let resolution = resolve_tag(connection, &tag)?;
            tag_resolutions.insert(tag.id.clone(), resolution);
            Ok(())
        },
    )?;
    verify_entry_digest(&manifest.tags, &tags_digest)?;

    let mut prompt_ids = HashSet::new();
    let mut prompt_meta = Vec::new();
    let mut total_body_bytes = 0_u64;
    let prompts_digest = read_jsonl_entry::<_, PromptMigrationPrompt, _>(
        &mut archive,
        PROMPTS_PATH,
        limits.max_prompts,
        max_prompt_record_bytes(limits)?,
        |prompt| {
            let body_bytes = validate_prompt_record(&prompt, limits)?;
            if !prompt_ids.insert(prompt.id.clone()) {
                return Err(PromptMigrationError::new(
                    "prompt_migration_duplicate_prompt",
                    "迁移包包含重复的提示词 ID。",
                ));
            }
            total_body_bytes = total_body_bytes.checked_add(body_bytes).ok_or_else(|| {
                PromptMigrationError::new(
                    "prompt_migration_total_size_overflow",
                    "正文总大小溢出。",
                )
            })?;
            if total_body_bytes > limits.max_total_body_bytes {
                return Err(PromptMigrationError::new(
                    "prompt_migration_total_body_too_large",
                    "迁移包中的提示词正文总大小超过允许上限。",
                ));
            }
            prompt_meta.push(PromptMeta {
                id: prompt.id,
                content_sha256: prompt.content_sha256,
                pinned: prompt.pinned,
            });
            Ok(())
        },
    )?;
    verify_entry_digest(&manifest.prompts, &prompts_digest)?;
    if manifest.total_body_bytes != total_body_bytes {
        return Err(PromptMigrationError::new(
            "prompt_migration_body_summary_mismatch",
            "manifest 中的正文总大小与实际内容不一致。",
        ));
    }

    let mut link_pairs = HashSet::new();
    let mut prompt_link_counts: HashMap<String, u64> = HashMap::new();
    let links_digest = read_jsonl_entry::<_, PromptMigrationLink, _>(
        &mut archive,
        LINKS_PATH,
        limits.max_links,
        MAX_LINK_RECORD_BYTES,
        |link| {
            validate_public_id(&link.prompt_id, "提示词")?;
            validate_public_id(&link.tag_id, "标签")?;
            if !prompt_ids.contains(&link.prompt_id) || !tag_ids.contains(&link.tag_id) {
                return Err(PromptMigrationError::new(
                    "prompt_migration_dangling_link",
                    "标签关联引用了迁移包中不存在的提示词或标签。",
                ));
            }
            if !link_pairs.insert((link.prompt_id.clone(), link.tag_id.clone())) {
                return Err(PromptMigrationError::new(
                    "prompt_migration_duplicate_link",
                    "迁移包包含重复的标签关联。",
                ));
            }
            let count = prompt_link_counts.entry(link.prompt_id).or_default();
            *count += 1;
            if *count > 20 {
                return Err(PromptMigrationError::new(
                    "prompt_migration_too_many_prompt_tags",
                    "单篇提示词最多关联 20 个标签。",
                ));
            }
            Ok(())
        },
    )?;
    verify_entry_digest(&manifest.links, &links_digest)?;

    let mut reserved_targets = prompt_ids.clone();
    let mut decisions = HashMap::new();
    let mut decision_list = Vec::with_capacity(prompt_meta.len());
    let mut inserted = 0_u64;
    let mut skipped_same = 0_u64;
    let mut kept_local = 0_u64;
    let mut overwritten = 0_u64;
    let mut duplicated = 0_u64;
    let mut manual_order_counts = [0_usize; 2];
    for prompt in prompt_meta {
        let local = connection
            .query_row(
                "SELECT content FROM prompts WHERE id = ?1",
                [&prompt.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let (action, target_id) = match local {
            None => {
                inserted += 1;
                (PromptImportAction::Insert, prompt.id.clone())
            }
            Some(content) if sha256_hex(content.as_bytes()) == prompt.content_sha256 => {
                skipped_same += 1;
                (PromptImportAction::SkipSame, prompt.id.clone())
            }
            Some(_) => match strategy {
                PromptConflictStrategy::KeepLocal => {
                    kept_local += 1;
                    (PromptImportAction::KeepLocal, prompt.id.clone())
                }
                PromptConflictStrategy::Overwrite => {
                    overwritten += 1;
                    (PromptImportAction::Overwrite, prompt.id.clone())
                }
                PromptConflictStrategy::Duplicate => {
                    duplicated += 1;
                    let target_id = next_duplicate_id(
                        connection,
                        &prompt.id,
                        &prompt.content_sha256,
                        &reserved_targets,
                    )?;
                    reserved_targets.insert(target_id.clone());
                    (PromptImportAction::Duplicate, target_id)
                }
            },
        };
        let decision = PromptImportDecision {
            incoming_id: prompt.id.clone(),
            target_id,
            action,
        };
        if matches!(
            decision.action,
            PromptImportAction::Insert
                | PromptImportAction::Duplicate
                | PromptImportAction::Overwrite
        ) {
            let group = if prompt.pinned { 1 } else { 0 };
            manual_order_counts[group] =
                manual_order_counts[group].checked_add(1).ok_or_else(|| {
                    PromptMigrationError::new(
                        "prompt_migration_order_count_overflow",
                        "迁移包手动排序计数溢出。",
                    )
                })?;
        }
        decisions.insert(prompt.id, decision.clone());
        decision_list.push(decision);
    }

    drop(archive);
    reader.seek(SeekFrom::Start(0))?;
    Ok(PackageInspection {
        manifest,
        preflight: PromptMigrationPreflight {
            prompts: prompts_digest.count,
            tags: tags_digest.count,
            links: links_digest.count,
            total_body_bytes,
            inserted,
            skipped_same,
            kept_local,
            overwritten,
            duplicated,
            decisions: decision_list,
        },
        decisions,
        tag_resolutions,
        manual_order_counts,
    })
}

fn resolve_tag(
    connection: &Connection,
    tag: &PromptMigrationTag,
) -> Result<TagResolution, PromptMigrationError> {
    let by_id = connection
        .query_row(
            "SELECT id, normalized_name FROM prompt_tags WHERE id = ?1",
            [&tag.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((target_id, normalized_name)) = by_id {
        if normalized_name != tag.normalized_name {
            return Err(PromptMigrationError::new(
                "prompt_migration_tag_id_conflict",
                "标签 ID 与本机不同规范化名称冲突，不能静默覆盖。",
            ));
        }
        return Ok(TagResolution {
            target_id,
            insert: false,
        });
    }
    let by_normalized = connection
        .query_row(
            "SELECT id FROM prompt_tags WHERE normalized_name = ?1",
            [&tag.normalized_name],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(match by_normalized {
        Some(target_id) => TagResolution {
            target_id,
            insert: false,
        },
        None => TagResolution {
            target_id: tag.id.clone(),
            insert: true,
        },
    })
}

fn next_duplicate_id(
    connection: &Connection,
    incoming_id: &str,
    content_sha256: &str,
    reserved: &HashSet<String>,
) -> Result<String, PromptMigrationError> {
    let hash_prefix = content_sha256.get(..8).unwrap_or(content_sha256);
    for number in 1..=10_000_u32 {
        let suffix = if number == 1 {
            format!("-import-{hash_prefix}")
        } else {
            format!("-import-{hash_prefix}-{number}")
        };
        let keep = 160_usize.saturating_sub(suffix.len());
        let prefix = &incoming_id[..incoming_id.len().min(keep)];
        let candidate = format!("{prefix}{suffix}");
        let exists = connection
            .query_row("SELECT 1 FROM prompts WHERE id = ?1", [&candidate], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !exists && !reserved.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(PromptMigrationError::new(
        "prompt_migration_duplicate_id_exhausted",
        "无法为导入副本生成唯一提示词 ID。",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read, Seek, SeekFrom};

    struct SwapOnSecondOuterRewind {
        original: Cursor<Vec<u8>>,
        tampered: Cursor<Vec<u8>>,
        swapped: bool,
        previous_was_zero_rewind: bool,
    }

    impl SwapOnSecondOuterRewind {
        fn new(original: Vec<u8>, tampered: Vec<u8>) -> Self {
            Self {
                original: Cursor::new(original),
                tampered: Cursor::new(tampered),
                swapped: false,
                previous_was_zero_rewind: false,
            }
        }

        fn active(&mut self) -> &mut Cursor<Vec<u8>> {
            if self.swapped {
                &mut self.tampered
            } else {
                &mut self.original
            }
        }
    }

    impl Read for SwapOnSecondOuterRewind {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.previous_was_zero_rewind = false;
            self.active().read(buffer)
        }
    }

    impl Seek for SwapOnSecondOuterRewind {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            let is_zero_rewind = matches!(position, SeekFrom::Start(0));
            if is_zero_rewind && self.previous_was_zero_rewind {
                self.swapped = true;
                self.tampered.set_position(0);
            }
            self.previous_was_zero_rewind = is_zero_rewind;
            self.active().seek(position)
        }
    }

    const LEGACY: &[u8] = br#"{
      "schemaVersion": 1,
      "appVersion": "1.2.0",
      "repositories": [],
      "skills": [],
      "plugins": [],
      "userNotes": []
    }"#;

    fn tag(id: &str, name: &str, normalized_name: &str) -> PromptMigrationTag {
        PromptMigrationTag {
            id: id.to_string(),
            name: name.to_string(),
            normalized_name: normalized_name.to_string(),
            created_at: "2026-08-30T08:00:00Z".to_string(),
            updated_at: "2026-08-30T08:00:00Z".to_string(),
        }
    }

    fn prompt(id: &str, title: &str, content: &str) -> PromptMigrationPrompt {
        PromptMigrationPrompt {
            id: id.to_string(),
            title: title.to_string(),
            content: content.to_string(),
            excerpt: crate::prompts::plain_text_excerpt(content),
            pinned: false,
            revision: 3,
            created_at: "2026-08-30T08:00:00Z".to_string(),
            updated_at: "2026-08-30T09:00:00Z".to_string(),
            content_sha256: sha256_hex(content.as_bytes()),
        }
    }

    fn package(
        tags: Vec<PromptMigrationTag>,
        prompts: Vec<PromptMigrationPrompt>,
        links: Vec<PromptMigrationLink>,
    ) -> Cursor<Vec<u8>> {
        let mut output = Cursor::new(Vec::new());
        write_v2_package(
            &mut output,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            tags.into_iter().map(Ok::<_, PromptMigrationError>),
            prompts.into_iter().map(Ok::<_, PromptMigrationError>),
            links.into_iter().map(Ok::<_, PromptMigrationError>),
        )
        .unwrap();
        output.set_position(0);
        output
    }

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        crate::prompts::migrate_prompt_library(&connection).unwrap();
        connection
    }

    fn insert_local_prompt(connection: &Connection, id: &str, content: &str) {
        connection
            .execute(
                "INSERT INTO prompts
                 (id, title, content, excerpt, pinned, revision, created_at, updated_at)
                 VALUES(?1, '本机标题', ?2, ?3, 0, 7, 'local-created', 'local-updated')",
                params![id, content, crate::prompts::plain_text_excerpt(content)],
            )
            .unwrap();
    }

    #[test]
    fn detects_legacy_v1_json_before_v2_routing() {
        let mut input = Cursor::new(br#"{ "schemaVersion": 1, "repositories": [] }"#.to_vec());
        assert_eq!(
            detect_migration_package(&mut input).unwrap(),
            MigrationPackageKind::LegacyV1Json
        );
    }

    #[test]
    fn streams_v2_round_trip_and_preserves_embedded_v1() {
        let role = tag("tag-role", "角色", "角色");
        let research = prompt(
            "prompt-research",
            "深度研究",
            "你是一名研究员，请梳理研究资料并给出证据。",
        );
        let link = PromptMigrationLink {
            prompt_id: research.id.clone(),
            tag_id: role.id.clone(),
        };
        let mut package = package(vec![role], vec![research], vec![link]);

        assert_eq!(
            detect_migration_package(&mut package).unwrap(),
            MigrationPackageKind::PromptLibraryV2Zip
        );
        assert_eq!(
            extract_embedded_legacy_v1_json(&mut package).unwrap(),
            LEGACY
        );

        let mut connection = database();
        let preflight = preflight_v2_for_connection(
            &connection,
            &mut package,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::KeepLocal,
        )
        .unwrap();
        assert_eq!(
            (preflight.prompts, preflight.tags, preflight.links),
            (1, 1, 1)
        );
        assert_eq!(preflight.inserted, 1);

        let imported = import_v2_transactional(
            &mut connection,
            &mut package,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::KeepLocal,
        )
        .unwrap();
        assert_eq!(imported.library_revision, 1);
        assert_eq!(imported.inserted_tags, 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT content FROM prompts WHERE id = 'prompt-research'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "你是一名研究员，请梳理研究资料并给出证据。"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM prompt_tag_links", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM prompt_fts WHERE prompt_fts MATCH '研究资料'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn v2_import_preserves_jsonl_stream_order_without_adding_a_wire_rank() {
        let mut pinned_second = prompt("pinned-second", "置顶二", "置顶正文二");
        pinned_second.pinned = true;
        let mut pinned_first = prompt("pinned-first", "置顶一", "置顶正文一");
        pinned_first.pinned = true;
        let prompts = vec![
            prompt("normal-z", "普通 Z", "普通正文 Z"),
            pinned_second,
            prompt("normal-a", "普通 A", "普通正文 A"),
            pinned_first,
        ];
        let mut migration = package(vec![], prompts, vec![]);

        {
            let mut archive = ZipArchive::new(&mut migration).unwrap();
            let mut entry = archive.by_name(PROMPTS_PATH).unwrap();
            let mut jsonl = String::new();
            entry.read_to_string(&mut jsonl).unwrap();
            assert!(!jsonl.contains("manualOrder"));
            assert!(!jsonl.contains("manual_order"));
        }
        migration.set_position(0);

        let mut connection = database();
        insert_local_prompt(&connection, "local-existing", "本机正文");
        connection
            .execute(
                "UPDATE prompts SET manual_order = ?1 WHERE id = 'local-existing'",
                [i64::MIN],
            )
            .unwrap();
        import_v2_transactional(
            &mut connection,
            &mut migration,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::Duplicate,
        )
        .unwrap();

        let visible_ids = connection
            .prepare(
                "SELECT id FROM prompts
                 ORDER BY pinned DESC, manual_order ASC, id ASC",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            visible_ids,
            [
                "pinned-second",
                "pinned-first",
                "normal-z",
                "normal-a",
                "local-existing",
            ]
        );
    }

    #[test]
    fn enforces_single_and_total_utf8_body_limits_during_preflight() {
        let mut single = package(vec![], vec![prompt("prompt-one", "一", "四个字")], vec![]);
        let connection = database();
        let limits = PromptMigrationLimits {
            max_prompt_body_bytes: 3,
            ..PromptMigrationLimits::default()
        };
        assert_eq!(
            preflight_v2_for_connection(
                &connection,
                &mut single,
                &limits,
                PromptConflictStrategy::KeepLocal
            )
            .unwrap_err()
            .code(),
            "prompt_migration_prompt_content_too_large"
        );

        let mut total = package(
            vec![],
            vec![
                prompt("prompt-a", "A", "abc"),
                prompt("prompt-b", "B", "def"),
            ],
            vec![],
        );
        let limits = PromptMigrationLimits {
            max_total_body_bytes: 5,
            ..PromptMigrationLimits::default()
        };
        assert_eq!(
            preflight_v2_for_connection(
                &connection,
                &mut total,
                &limits,
                PromptConflictStrategy::KeepLocal
            )
            .unwrap_err()
            .code(),
            "prompt_migration_total_body_too_large"
        );
    }

    #[test]
    fn rejects_dangling_links_before_writing_a_valid_package() {
        let mut output = Cursor::new(Vec::new());
        let error = write_v2_package(
            &mut output,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            vec![tag("tag-role", "角色", "角色")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            Vec::<PromptMigrationPrompt>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            vec![PromptMigrationLink {
                prompt_id: "missing-prompt".to_string(),
                tag_id: "tag-role".to_string(),
            }]
            .into_iter()
            .map(Ok::<_, PromptMigrationError>),
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_dangling_link");
    }

    #[test]
    fn chooses_keep_overwrite_duplicate_and_always_skips_same_content() {
        let connection = database();
        insert_local_prompt(&connection, "prompt-conflict", "本机正文");
        insert_local_prompt(&connection, "prompt-same", "完全相同");
        let mut package = package(
            vec![],
            vec![
                prompt("prompt-conflict", "远端标题", "远端正文"),
                prompt("prompt-same", "相同标题", "完全相同"),
            ],
            vec![],
        );

        for (strategy, expected) in [
            (
                PromptConflictStrategy::KeepLocal,
                PromptImportAction::KeepLocal,
            ),
            (
                PromptConflictStrategy::Overwrite,
                PromptImportAction::Overwrite,
            ),
            (
                PromptConflictStrategy::Duplicate,
                PromptImportAction::Duplicate,
            ),
        ] {
            let preflight = preflight_v2_for_connection(
                &connection,
                &mut package,
                &PromptMigrationLimits::default(),
                strategy,
            )
            .unwrap();
            assert_eq!(preflight.decisions[0].action, expected);
            assert_eq!(preflight.decisions[1].action, PromptImportAction::SkipSame);
            if strategy == PromptConflictStrategy::Duplicate {
                assert_ne!(preflight.decisions[0].target_id, "prompt-conflict");
                assert!(preflight.decisions[0]
                    .target_id
                    .starts_with("prompt-conflict-import-"));
            }
        }
    }

    #[test]
    fn duplicate_import_keeps_local_and_maps_normalized_tag_to_existing_tag() {
        let mut connection = database();
        insert_local_prompt(&connection, "prompt-conflict", "本机正文");
        connection
            .execute(
                "INSERT INTO prompt_tags
                 (id, name, normalized_name, created_at, updated_at)
                 VALUES('tag-local-role', '角色', '角色', 'local', 'local')",
                [],
            )
            .unwrap();
        let mut package = package(
            vec![tag("tag-incoming-role", "角色", "角色")],
            vec![prompt("prompt-conflict", "远端标题", "远端正文")],
            vec![PromptMigrationLink {
                prompt_id: "prompt-conflict".to_string(),
                tag_id: "tag-incoming-role".to_string(),
            }],
        );
        let imported = import_v2_transactional(
            &mut connection,
            &mut package,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::Duplicate,
        )
        .unwrap();
        assert_eq!(imported.inserted_tags, 0);
        let duplicate_id = &imported.preflight.decisions[0].target_id;
        assert_eq!(
            connection
                .query_row(
                    "SELECT content FROM prompts WHERE id = ?1",
                    [duplicate_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "远端正文"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT tag.id
                     FROM prompt_tag_links AS link
                     JOIN prompts AS prompt ON prompt.row_id = link.prompt_row_id
                     JOIN prompt_tags AS tag ON tag.row_id = link.tag_row_id
                     WHERE prompt.id = ?1",
                    [duplicate_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "tag-local-role"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT content FROM prompts WHERE id = 'prompt-conflict'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "本机正文"
        );
    }

    #[test]
    fn overwrite_preserves_local_creation_time_bumps_revision_and_replaces_links() {
        let mut connection = database();
        insert_local_prompt(&connection, "prompt-conflict", "本机正文");
        connection
            .execute(
                "INSERT INTO prompt_tags
                 (id, name, normalized_name, created_at, updated_at)
                 VALUES('tag-old', '旧标签', '旧标签', 'local', 'local')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO prompt_tag_links(prompt_row_id, tag_row_id)
                 SELECT prompt.row_id, tag.row_id FROM prompts AS prompt, prompt_tags AS tag
                 WHERE prompt.id = 'prompt-conflict' AND tag.id = 'tag-old'",
                [],
            )
            .unwrap();
        let mut package = package(
            vec![tag("tag-new", "新标签", "新标签")],
            vec![prompt("prompt-conflict", "远端标题", "远端正文")],
            vec![PromptMigrationLink {
                prompt_id: "prompt-conflict".to_string(),
                tag_id: "tag-new".to_string(),
            }],
        );
        let imported = import_v2_transactional(
            &mut connection,
            &mut package,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::Overwrite,
        )
        .unwrap();
        assert_eq!(imported.preflight.overwritten, 1);
        let (content, revision, created_at): (String, i64, String) = connection
            .query_row(
                "SELECT content, revision, created_at FROM prompts WHERE id = 'prompt-conflict'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(content, "远端正文");
        assert_eq!(revision, 8);
        assert_eq!(created_at, "local-created");
        assert_eq!(
            connection
                .query_row(
                    "SELECT tag.id
                     FROM prompt_tag_links AS link
                     JOIN prompts AS prompt ON prompt.row_id = link.prompt_row_id
                     JOIN prompt_tags AS tag ON tag.row_id = link.tag_row_id
                     WHERE prompt.id = 'prompt-conflict'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "tag-new"
        );
    }

    #[test]
    fn overwrite_uses_incoming_stream_order_for_same_and_cross_pinned_groups() {
        let mut connection = database();
        for (id, content) in [
            ("local-a", "本机 A"),
            ("local-b", "本机 B"),
            ("local-cross", "本机跨组"),
            ("normal-sentinel", "普通哨兵"),
            ("pinned-sentinel", "置顶哨兵"),
        ] {
            insert_local_prompt(&connection, id, content);
        }
        connection
            .execute(
                "UPDATE prompts SET manual_order = ?1 WHERE id = 'normal-sentinel'",
                [i64::MIN],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE prompts SET pinned = 1, manual_order = ?1
                 WHERE id = 'pinned-sentinel'",
                [i64::MIN],
            )
            .unwrap();

        let incoming_b = prompt("local-b", "远端 B", "远端正文 B");
        let mut incoming_cross = prompt("local-cross", "远端跨组", "远端跨组正文");
        incoming_cross.pinned = true;
        let incoming_a = prompt("local-a", "远端 A", "远端正文 A");
        let mut migration = package(vec![], vec![incoming_b, incoming_cross, incoming_a], vec![]);

        {
            let mut archive = ZipArchive::new(&mut migration).unwrap();
            let mut entry = archive.by_name(PROMPTS_PATH).unwrap();
            let mut jsonl = String::new();
            entry.read_to_string(&mut jsonl).unwrap();
            assert!(!jsonl.contains("manualOrder"));
            assert!(!jsonl.contains("manual_order"));
        }
        migration.set_position(0);

        let imported = import_v2_transactional(
            &mut connection,
            &mut migration,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::Overwrite,
        )
        .unwrap();
        assert_eq!(imported.preflight.overwritten, 3);

        let visible = connection
            .prepare(
                "SELECT id, pinned, manual_order FROM prompts
                 ORDER BY pinned DESC, manual_order ASC, id ASC",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            visible.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            [
                "local-cross",
                "pinned-sentinel",
                "local-b",
                "local-a",
                "normal-sentinel",
            ]
        );
        assert!(visible
            .windows(2)
            .all(|rows| { rows[0].1 != rows[1].1 || rows[0].2 < rows[1].2 }));
        let (pinned, revision, created_at): (bool, i64, String) = connection
            .query_row(
                "SELECT pinned, revision, created_at FROM prompts WHERE id = 'local-cross'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(pinned);
        assert_eq!(revision, 8);
        assert_eq!(created_at, "local-created");
    }

    #[test]
    fn overwrite_rank_reallocation_rolls_back_with_late_prompt_failure() {
        let mut connection = database();
        insert_local_prompt(&connection, "local-overwrite", "本机正文");
        connection
            .execute(
                "UPDATE prompts SET manual_order = ?1 WHERE id = 'local-overwrite'",
                [i64::MIN],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO prompt_tags
                 (id, name, normalized_name, created_at, updated_at)
                 VALUES('tag-old', '旧标签', '旧标签', 'local', 'local')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO prompt_tag_links(prompt_row_id, tag_row_id)
                 SELECT prompt.row_id, tag.row_id FROM prompts AS prompt, prompt_tags AS tag
                 WHERE prompt.id = 'local-overwrite' AND tag.id = 'tag-old'",
                [],
            )
            .unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_late_prompt
                 BEFORE INSERT ON prompts WHEN new.id = 'prompt-b'
                 BEGIN SELECT RAISE(ABORT, 'forced late import failure'); END;",
            )
            .unwrap();
        let mut migration = package(
            vec![tag("tag-new", "新标签", "新标签")],
            vec![
                prompt("local-overwrite", "远端标题", "远端正文"),
                prompt("prompt-b", "B", "正文 B"),
            ],
            vec![PromptMigrationLink {
                prompt_id: "local-overwrite".to_string(),
                tag_id: "tag-new".to_string(),
            }],
        );

        let error = import_v2_transactional(
            &mut connection,
            &mut migration,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::Overwrite,
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_database_failed");
        let local: (String, bool, i64, i64) = connection
            .query_row(
                "SELECT content, pinned, manual_order, revision
                 FROM prompts WHERE id = 'local-overwrite'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(local, ("本机正文".to_string(), false, i64::MIN, 7));
        assert_eq!(
            connection
                .query_row(
                    "SELECT tag.id FROM prompt_tag_links AS link
                     JOIN prompt_tags AS tag ON tag.row_id = link.tag_row_id
                     JOIN prompts AS prompt ON prompt.row_id = link.prompt_row_id
                     WHERE prompt.id = 'local-overwrite'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "tag-old"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM prompt_tags", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn importing_same_content_is_idempotent_and_does_not_bump_library_revision() {
        let mut connection = database();
        let incoming = prompt("prompt-same", "相同标题", "完全相同");
        let mut first = package(vec![], vec![incoming.clone()], vec![]);
        let first_summary = import_v2_transactional(
            &mut connection,
            &mut first,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::Overwrite,
        )
        .unwrap();
        assert_eq!(first_summary.library_revision, 1);

        let mut second = package(vec![], vec![incoming], vec![]);
        let second_summary = import_v2_transactional(
            &mut connection,
            &mut second,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::Overwrite,
        )
        .unwrap();
        assert_eq!(second_summary.preflight.skipped_same, 1);
        assert_eq!(second_summary.library_revision, 1);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn rolls_back_tags_prompts_links_and_revision_on_late_database_failure() {
        let mut connection = database();
        connection
            .execute_batch(
                "CREATE TABLE legacy_marker(value TEXT NOT NULL);
                 CREATE TRIGGER reject_second_import
                 BEFORE INSERT ON prompts WHEN new.id = 'prompt-b'
                 BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;",
            )
            .unwrap();
        let mut package = package(
            vec![tag("tag-role", "角色", "角色")],
            vec![
                prompt("prompt-a", "A", "正文 A"),
                prompt("prompt-b", "B", "正文 B"),
            ],
            vec![PromptMigrationLink {
                prompt_id: "prompt-a".to_string(),
                tag_id: "tag-role".to_string(),
            }],
        );
        let error = import_v2_transactional_with_legacy(
            &mut connection,
            &mut package,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::KeepLocal,
            |transaction, legacy| {
                assert_eq!(legacy, LEGACY);
                transaction.execute("INSERT INTO legacy_marker(value) VALUES('imported')", [])?;
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_database_failed");
        for table in ["prompts", "prompt_tags", "prompt_tag_links"] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM legacy_marker", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn rejects_sensitive_legacy_fields_without_echoing_secret_values() {
        let secret = "do-not-print-this-secret";
        let mut legacy =
            Cursor::new(format!(r#"{{"schemaVersion":1,"githubToken":"{secret}"}}"#).into_bytes());
        let error = read_legacy_v1_json(&mut legacy).unwrap_err();
        assert_eq!(error.code(), "prompt_migration_sensitive_field");
        assert!(!error.to_string().contains(secret));
    }

    #[test]
    fn rejects_unexpected_or_traversal_zip_entries() {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut output);
            let options = SimpleFileOptions::default();
            for path in EXPECTED_PATHS {
                writer.start_file(path, options).unwrap();
                writer.write_all(b"{}").unwrap();
            }
            writer.start_file("../escape", options).unwrap();
            writer.write_all(b"secret").unwrap();
            writer.finish().unwrap();
        }
        output.set_position(0);
        assert_eq!(
            detect_migration_package(&mut output).unwrap_err().code(),
            "prompt_migration_zip_path_invalid"
        );
    }

    #[test]
    fn detects_manifest_digest_tampering_before_import() {
        let original = package(vec![], vec![prompt("prompt-a", "A", "完整正文")], vec![]);
        let mut source = ZipArchive::new(original).unwrap();
        let mut tampered = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut tampered);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for path in EXPECTED_PATHS {
                let mut entry = source.by_name(path).unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                if path == PROMPTS_PATH {
                    bytes.push(b'\n');
                }
                writer.start_file(path, options).unwrap();
                writer.write_all(&bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        tampered.set_position(0);
        let connection = database();
        assert_eq!(
            preflight_v2_for_connection(
                &connection,
                &mut tampered,
                &PromptMigrationLimits::default(),
                PromptConflictStrategy::KeepLocal
            )
            .unwrap_err()
            .code(),
            "prompt_migration_entry_digest_mismatch"
        );
    }

    #[test]
    fn second_import_pass_rechecks_entry_digest_and_rolls_back_writes() {
        let original = package(
            vec![tag("tag-role", "角色", "角色")],
            vec![prompt("prompt-a", "A", "完整正文")],
            vec![PromptMigrationLink {
                prompt_id: "prompt-a".to_string(),
                tag_id: "tag-role".to_string(),
            }],
        )
        .into_inner();
        let mut source = ZipArchive::new(Cursor::new(original.clone())).unwrap();
        let mut tampered = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut tampered);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for path in EXPECTED_PATHS {
                let mut entry = source.by_name(path).unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                if path == PROMPTS_PATH {
                    bytes.push(b'\n');
                }
                writer.start_file(path, options).unwrap();
                writer.write_all(&bytes).unwrap();
            }
            writer.finish().unwrap();
        }

        let mut switching = SwapOnSecondOuterRewind::new(original, tampered.into_inner());
        let mut connection = database();
        let error = import_v2_transactional(
            &mut connection,
            &mut switching,
            &PromptMigrationLimits::default(),
            PromptConflictStrategy::KeepLocal,
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_entry_digest_mismatch");
        for table in ["prompts", "prompt_tags", "prompt_tag_links"] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn writer_output_preflights_under_the_same_body_and_uncompressed_limits() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("symmetric.srtmigration");
        let body_bytes = "正文".len() as u64;
        let limits = PromptMigrationLimits {
            max_prompt_body_bytes: body_bytes,
            max_total_body_bytes: body_bytes,
            max_archive_uncompressed_bytes: 16_384,
            max_prompts: 1,
            max_tags: 1,
            max_links: 1,
        };
        let transport_limits = MigrationTransportLimits {
            max_legacy_v1_json_bytes: LEGACY.len() as u64,
            max_manifest_bytes: 4_096,
            max_tag_record_bytes: 512,
            max_link_record_bytes: 512,
            prompt_record_metadata_allowance_bytes: 1_024,
        };
        let summary = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            vec![tag("tag-role", "角色", "角色")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            vec![prompt("prompt-a", "A", "正文")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            vec![PromptMigrationLink {
                prompt_id: "prompt-a".to_string(),
                tag_id: "tag-role".to_string(),
            }]
            .into_iter()
            .map(Ok::<_, PromptMigrationError>),
            &limits,
            transport_limits,
        )
        .unwrap();
        assert_eq!((summary.prompts, summary.tags, summary.links), (1, 1, 1));

        let mut archive_file = File::open(&destination).unwrap();
        let mut archive = ZipArchive::new(&mut archive_file).unwrap();
        let actual_uncompressed_bytes = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().size())
            .sum::<u64>();
        assert!(actual_uncompressed_bytes <= limits.max_archive_uncompressed_bytes);
        drop(archive);
        drop(archive_file);

        let connection = database();
        let mut package = File::open(&destination).unwrap();
        let preflight = preflight_v2_for_connection(
            &connection,
            &mut package,
            &limits,
            PromptConflictStrategy::KeepLocal,
        )
        .unwrap();
        assert_eq!(
            (preflight.prompts, preflight.tags, preflight.links),
            (1, 1, 1)
        );
        assert_eq!(preflight.total_body_bytes, body_bytes);
    }

    #[test]
    fn atomic_writer_rejects_injected_transport_limits_without_replacing_target() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("library.srtmigration");
        std::fs::write(&destination, b"old").unwrap();
        let empty_tags = || {
            Vec::<PromptMigrationTag>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>)
        };
        let empty_prompts = || {
            Vec::<PromptMigrationPrompt>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>)
        };
        let empty_links = || {
            Vec::<PromptMigrationLink>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>)
        };

        let mut transport = MigrationTransportLimits::default();
        transport.max_legacy_v1_json_bytes = LEGACY.len() as u64 - 1;
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            empty_tags(),
            empty_prompts(),
            empty_links(),
            &PromptMigrationLimits::default(),
            transport,
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_entry_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");

        let mut transport = MigrationTransportLimits::default();
        transport.max_tag_record_bytes = 16;
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            vec![tag("tag-role", "角色", "角色")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            empty_prompts(),
            empty_links(),
            &PromptMigrationLimits::default(),
            transport,
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_jsonl_record_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");

        let prompt_record_limits = PromptMigrationLimits {
            max_prompt_body_bytes: 1,
            ..PromptMigrationLimits::default()
        };
        let mut transport = MigrationTransportLimits::default();
        transport.prompt_record_metadata_allowance_bytes = 1;
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            empty_tags(),
            vec![prompt("prompt-a", "A", "x")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            empty_links(),
            &prompt_record_limits,
            transport,
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_jsonl_record_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");

        let mut transport = MigrationTransportLimits::default();
        transport.max_link_record_bytes = 1;
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            vec![tag("tag-role", "角色", "角色")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            vec![prompt("prompt-a", "A", "x")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            vec![PromptMigrationLink {
                prompt_id: "prompt-a".to_string(),
                tag_id: "tag-role".to_string(),
            }]
            .into_iter()
            .map(Ok::<_, PromptMigrationError>),
            &PromptMigrationLimits::default(),
            transport,
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_jsonl_record_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");

        let mut transport = MigrationTransportLimits::default();
        transport.max_manifest_bytes = 1;
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            empty_tags(),
            empty_prompts(),
            empty_links(),
            &PromptMigrationLimits::default(),
            transport,
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_entry_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_writer_rejects_body_and_archive_limits_without_replacing_target() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("library.srtmigration");
        std::fs::write(&destination, b"old").unwrap();
        let empty_tags = || {
            Vec::<PromptMigrationTag>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>)
        };
        let empty_links = || {
            Vec::<PromptMigrationLink>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>)
        };

        let single_limits = PromptMigrationLimits {
            max_prompt_body_bytes: 2,
            ..PromptMigrationLimits::default()
        };
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            empty_tags(),
            vec![prompt("prompt-a", "A", "abc")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            empty_links(),
            &single_limits,
            MigrationTransportLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_prompt_content_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");

        let total_limits = PromptMigrationLimits {
            max_total_body_bytes: 5,
            ..PromptMigrationLimits::default()
        };
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            empty_tags(),
            vec![
                prompt("prompt-a", "A", "abc"),
                prompt("prompt-b", "B", "def"),
            ]
            .into_iter()
            .map(Ok::<_, PromptMigrationError>),
            empty_links(),
            &total_limits,
            MigrationTransportLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_total_body_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");

        let archive_limits = PromptMigrationLimits {
            max_archive_uncompressed_bytes: 1,
            ..PromptMigrationLimits::default()
        };
        let error = write_v2_package_atomic_with_limits(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            empty_tags(),
            vec![prompt("prompt-a", "A", "x")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            empty_links(),
            &archive_limits,
            MigrationTransportLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "prompt_migration_archive_too_large");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_writer_replaces_destination_after_finish_flush_and_sync() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("library.srtmigration");
        std::fs::write(&destination, b"old").unwrap();
        let summary = write_v2_package_atomic(
            &destination,
            LEGACY,
            "1.2.0",
            "2026-08-30T10:00:00+08:00",
            Vec::<PromptMigrationTag>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            vec![prompt("prompt-a", "A", "正文")]
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
            Vec::<PromptMigrationLink>::new()
                .into_iter()
                .map(Ok::<_, PromptMigrationError>),
        )
        .unwrap();
        assert_eq!(summary.prompts, 1);
        let mut file = File::open(destination).unwrap();
        assert_eq!(
            detect_migration_package(&mut file).unwrap(),
            MigrationPackageKind::PromptLibraryV2Zip
        );
    }
}
