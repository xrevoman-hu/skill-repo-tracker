//! Exact identities for plaintext export staging; never scan user directories.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const JOURNAL: &str = "export-pending.json";
const PREFIX: &str = ".srt-export-";
const MAX_JOURNAL: u64 = 16_384;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
    owner: u32,
}

impl Identity {
    fn of(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            owner: metadata.uid(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    schema: u32,
    path: PathBuf,
    parent: Identity,
    file: Identity,
}

fn failure(_: impl std::fmt::Debug) -> &'static str {
    "export_cleanup_failed"
}

fn owner() -> u32 {
    // SAFETY: geteuid has no parameters and returns the current process identity.
    unsafe { libc::geteuid() }
}

fn check_root(root: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(root).map_err(failure)?;
    if !root.is_absolute()
        || root.canonicalize().map_err(failure)? != root
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != owner()
        || metadata.mode() & 0o077 != 0
    {
        return Err("export_cleanup_failed");
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), &'static str> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(failure)
}

fn read(root: &Path) -> Result<Option<Entry>, &'static str> {
    check_root(root)?;
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join(JOURNAL))
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error)),
    };
    let metadata = file.metadata().map_err(failure)?;
    if !metadata.is_file()
        || metadata.uid() != owner()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_JOURNAL
    {
        return Err("export_cleanup_failed");
    }
    let mut bytes = Vec::new();
    file.take(MAX_JOURNAL + 1)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() as u64 > MAX_JOURNAL {
        return Err("export_cleanup_failed");
    }
    let entry: Entry = serde_json::from_slice(&bytes).map_err(failure)?;
    let name = entry
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("export_cleanup_failed")?;
    if entry.schema != 1
        || !entry.path.is_absolute()
        || entry.file.owner != owner()
        || !name.strip_prefix(PREFIX).is_some_and(|suffix| {
            suffix.len() == 64 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("export_cleanup_failed");
    }
    Ok(Some(entry))
}

fn register(root: &Path, entry: &Entry) -> Result<(), &'static str> {
    check_root(root)?;
    if read(root)?.is_some() {
        return Err("export_cleanup_failed");
    }
    let bytes = serde_json::to_vec(entry).map_err(failure)?;
    let mut pending = tempfile::Builder::new()
        .prefix(".export-journal-")
        .tempfile_in(root)
        .map_err(failure)?;
    pending
        .write_all(&bytes)
        .and_then(|()| pending.as_file().sync_all())
        .map_err(failure)?;
    pending
        .persist_noclobber(root.join(JOURNAL))
        .map_err(failure)?;
    sync_directory(root)
}

fn check_parent(entry: &Entry) -> Result<&Path, &'static str> {
    let parent = entry.path.parent().ok_or("export_cleanup_failed")?;
    let metadata = fs::symlink_metadata(parent).map_err(failure)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || parent.canonicalize().map_err(failure)? != parent
        || Identity::of(&metadata) != entry.parent
    {
        return Err("export_cleanup_failed");
    }
    Ok(parent)
}

fn remove_staging(entry: &Entry) -> Result<(), &'static str> {
    let parent = check_parent(entry)?;
    let metadata = match fs::symlink_metadata(&entry.path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(failure(error)),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || Identity::of(&metadata) != entry.file
        || metadata.mode() & 0o077 != 0
    {
        return Err("export_cleanup_failed");
    }
    fs::remove_file(&entry.path).map_err(failure)?;
    sync_directory(parent)
}

fn clear(root: &Path, entry: &Entry) -> Result<(), &'static str> {
    match read(root)? {
        None => return Ok(()),
        Some(current) if current == *entry => {}
        Some(_) => return Err("export_cleanup_failed"),
    }
    fs::remove_file(root.join(JOURNAL)).map_err(failure)?;
    sync_directory(root)
}

/// Call only while the application's host owns the root lock and its GUI
/// connection serializes export operations. Identity changes fail closed.
pub(crate) fn cleanup(root: &Path) -> Result<(), &'static str> {
    let Some(entry) = read(root)? else {
        return Ok(());
    };
    remove_staging(&entry)?;
    clear(root, &entry)
}

pub(crate) struct PendingExport {
    root: PathBuf,
    entry: Entry,
    file: Option<File>,
}

impl PendingExport {
    pub(crate) fn create(root: &Path, parent: &Path) -> Result<Self, &'static str> {
        cleanup(root)?;
        let parent_metadata = fs::symlink_metadata(parent).map_err(failure)?;
        if !parent.is_absolute()
            || parent.canonicalize().map_err(failure)? != parent
            || !parent_metadata.is_dir()
            || parent_metadata.file_type().is_symlink()
        {
            return Err("export_cleanup_failed");
        }
        let mut nonce = [0u8; 32];
        // SAFETY: a fixed-size writable buffer is supplied to the OS CSPRNG.
        if unsafe { libc::getentropy(nonce.as_mut_ptr().cast(), nonce.len()) } != 0 {
            return Err("system_random_unavailable");
        }
        let path = parent.join(format!("{PREFIX}{}", hex::encode(nonce)));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(failure)?;
        let pending = Self {
            root: root.to_owned(),
            entry: Entry {
                schema: 1,
                path,
                parent: Identity::of(&parent_metadata),
                file: Identity::of(&file.metadata().map_err(failure)?),
            },
            file: Some(file),
        };
        // Empty file and directory entry are durable before its identity is logged.
        pending
            .file
            .as_ref()
            .ok_or("export_cleanup_failed")?
            .sync_all()
            .map_err(failure)?;
        sync_directory(parent)?;
        register(root, &pending.entry)?;
        Ok(pending)
    }

    pub(crate) fn write(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        if read(&self.root)?.as_ref() != Some(&self.entry) {
            return Err("export_cleanup_failed");
        }
        check_parent(&self.entry)?;
        let metadata = fs::symlink_metadata(&self.entry.path).map_err(failure)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || Identity::of(&metadata) != self.entry.file
            || metadata.mode() & 0o077 != 0
        {
            return Err("export_cleanup_failed");
        }
        let file = self.file.as_mut().ok_or("export_cleanup_failed")?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "file_export_failed")
    }

    pub(crate) fn publish(&self, destination: &Path, replace: bool) -> Result<(), &'static str> {
        let parent = check_parent(&self.entry)?;
        let metadata = fs::symlink_metadata(&self.entry.path).map_err(failure)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || Identity::of(&metadata) != self.entry.file
            || metadata.mode() & 0o077 != 0
        {
            return Err("export_cleanup_failed");
        }
        if replace {
            fs::rename(&self.entry.path, destination).map_err(|_| "file_export_failed")?;
        } else {
            fs::hard_link(&self.entry.path, destination).map_err(|_| "file_export_failed")?;
            fs::remove_file(&self.entry.path).map_err(|_| "file_export_cleanup_failed")?;
        }
        sync_directory(parent).map_err(|_| "file_export_cleanup_failed")?;
        clear(&self.root, &self.entry).map_err(|_| "file_export_cleanup_failed")
    }
}

impl Drop for PendingExport {
    fn drop(&mut self) {
        // A failed cleanup retains the journal for explicit retry or next startup.
        if remove_staging(&self.entry).is_ok() {
            let _ = clear(&self.root, &self.entry);
        }
    }
}

#[cfg(test)]
#[path = "credential_export_journal_tests.rs"]
mod tests;
