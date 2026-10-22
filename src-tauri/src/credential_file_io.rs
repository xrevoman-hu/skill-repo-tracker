//! Native dialog selections are opaque, single-use intents, never frontend paths.
use std::{
    fs::{self, Metadata},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    size: u64,
    modified: (i64, i64),
}

fn identity(metadata: &Metadata) -> Identity {
    Identity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified: (metadata.mtime(), metadata.mtime_nsec()),
    }
}

fn target_identity(path: &Path) -> Result<Option<Identity>, &'static str> {
    match fs::symlink_metadata(path) {
        Ok(value) if value.is_file() && !value.file_type().is_symlink() => {
            Ok(Some(identity(&value)))
        }
        Ok(_) => Err("selected_file_invalid"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("selected_file_unavailable"),
    }
}

pub(crate) struct Selection {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) binding: String,
    parent: (u64, u64),
    target: Option<Identity>,
}

impl Selection {
    pub(crate) fn capture(
        path: PathBuf,
        binding: String,
        protected: &Path,
        existing: bool,
    ) -> Result<Self, &'static str> {
        if !path.is_absolute() {
            return Err("selected_file_invalid");
        }
        let parent = path.parent().ok_or("selected_file_invalid")?;
        let canonical = fs::canonicalize(parent).map_err(|_| "selected_file_unavailable")?;
        let name = path.file_name().ok_or("selected_file_invalid")?;
        let path = canonical.join(name);
        // Explicit exports/restores must never overwrite the live managed vault.
        if path.starts_with(protected) && !(existing && path == protected.join("recovery.srtvault"))
        {
            return Err("selected_file_is_managed");
        }
        let parent_metadata =
            fs::symlink_metadata(&canonical).map_err(|_| "selected_file_unavailable")?;
        if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
            return Err("selected_file_invalid");
        }
        let target = target_identity(&path)?;
        if existing && target.is_none() {
            return Err("selected_file_unavailable");
        }
        if existing
            && target
                .as_ref()
                .is_some_and(|value| value.size > 256 * 1024 * 1024)
        {
            return Err("backup_limit_exceeded");
        }
        let mut nonce = [0u8; 32];
        // SAFETY: a valid, bounded writable buffer is supplied to the OS CSPRNG.
        if unsafe { libc::getentropy(nonce.as_mut_ptr().cast(), nonce.len()) } != 0 {
            return Err("system_random_unavailable");
        }
        Ok(Self {
            id: hex::encode(nonce),
            path,
            binding,
            parent: (parent_metadata.dev(), parent_metadata.ino()),
            target,
        })
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let parent = self.path.parent().ok_or("selected_file_invalid")?;
        if fs::canonicalize(parent).map_err(|_| "selected_file_changed")? != parent {
            return Err("selected_file_changed");
        }
        let metadata = fs::symlink_metadata(parent).map_err(|_| "selected_file_changed")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || (metadata.dev(), metadata.ino()) != self.parent
            || target_identity(&self.path)? != self.target
        {
            return Err("selected_file_changed");
        }
        Ok(())
    }

    pub(crate) fn name(&self) -> String {
        self.path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    pub(crate) fn stage(self, bytes: &[u8], root: &Path) -> Result<StagedExport, &'static str> {
        if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
            return Err("file_limit_exceeded");
        }
        self.validate()?;
        let mut file = crate::credential_export_journal::PendingExport::create(
            root,
            self.path.parent().ok_or("selected_file_invalid")?,
        )?;
        self.validate()?;
        file.write(bytes)?;
        Ok(StagedExport {
            selection: self,
            file,
        })
    }
}

pub(crate) struct StagedExport {
    selection: Selection,
    file: crate::credential_export_journal::PendingExport,
}

impl StagedExport {
    // Caller holds the short delivery lock after checking native focus/generation.
    pub(crate) fn commit(self) -> Result<(), &'static str> {
        self.selection.validate()?;
        self.file
            .publish(&self.selection.path, self.selection.target.is_some())
    }
}

#[derive(Default)]
pub(crate) struct Selections {
    pub(crate) export: Option<Selection>,
    pub(crate) restore: Option<Selection>,
}

#[cfg(test)]
#[path = "credential_file_io_tests.rs"]
mod tests;
