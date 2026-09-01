use super::{path_string, AppError};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::Path,
};
use walkdir::WalkDir;
use zip::ZipArchive;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkillZipHashes {
    pub(super) canonical: String,
    pub(super) legacy: Option<String>,
}

impl SkillZipHashes {
    pub(super) fn matches_stored_digest(&self, stored: Option<&str>) -> bool {
        stored.is_some_and(|digest| {
            digest == self.canonical.as_str() || self.legacy.as_deref() == Some(digest)
        })
    }
}

fn strip_zip_root(name: &str) -> &str {
    name.split_once('/').map_or(name, |(_, rest)| rest)
}

fn digest<I, P, C>(entries: I) -> Result<String, AppError>
where
    I: IntoIterator<Item = Result<(P, C), AppError>>,
    P: AsRef<[u8]>,
    C: AsRef<[u8]>,
{
    let mut hasher = Sha256::new();
    for entry in entries {
        let (relative, contents) = entry?;
        hasher.update(relative.as_ref());
        hasher.update(contents.as_ref());
    }
    Ok(hex::encode(hasher.finalize()))
}

pub(super) fn skill_hashes_from_zip(
    bytes: &[u8],
    skill_path: &str,
) -> Result<SkillZipHashes, AppError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let prefix = match skill_path {
        "." => String::new(),
        path => format!("{}/", path.trim_matches('/')),
    };
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if !file.is_file() {
            continue;
        }
        let output_relative = strip_zip_root(file.name())
            .strip_prefix(&prefix)
            .unwrap_or("")
            .to_string();
        if output_relative.is_empty() {
            continue;
        }
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;
        entries.push((output_relative, contents));
    }
    entries.sort_by(|left, right| left.0.split('/').cmp(right.0.split('/')));
    let canonical = digest(
        entries
            .iter()
            .map(|(relative, contents)| Ok((relative.as_bytes(), contents.as_slice()))),
    )?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let legacy = digest(
        entries
            .iter()
            .map(|(relative, contents)| Ok((relative.as_bytes(), contents.as_slice()))),
    )?;
    Ok(SkillZipHashes {
        legacy: (legacy != canonical).then_some(legacy),
        canonical,
    })
}

pub(super) fn hash_directory(path: &Path) -> Result<String, AppError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(error) => return Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(AppError::with_details(
                "skill_hash_symlink_unsupported",
                "Skill 内容包含符号链接，无法安全计算哈希。",
                path_string(path),
            ))
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(AppError::with_details(
                "skill_hash_not_directory",
                "Skill 哈希目标不是目录。",
                path_string(path),
            ))
        }
        Ok(_) => {}
    }
    let mut entries = Vec::new();
    for entry in WalkDir::new(path) {
        let entry = entry.map_err(|error| {
            AppError::with_details(
                "skill_hash_walk_failed",
                "Skill 目录遍历失败，未使用不完整内容计算哈希。",
                error.to_string(),
            )
        })?;
        if entry.file_type().is_symlink() {
            return Err(AppError::with_details(
                "skill_hash_symlink_unsupported",
                "Skill 内容包含符号链接，无法安全计算哈希。",
                path_string(entry.path()),
            ));
        }
        if entry.file_type().is_file() {
            entries.push(entry.path().to_path_buf());
        }
    }
    entries.sort();
    digest(entries.into_iter().map(|entry| {
        let relative = entry
            .strip_prefix(path)
            .map(|relative| relative.to_string_lossy().into_owned().into_bytes())
            .unwrap_or_default();
        Ok((relative, fs::read(entry)?))
    }))
}
