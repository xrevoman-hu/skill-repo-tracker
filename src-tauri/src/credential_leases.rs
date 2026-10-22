//! A bounded, non-secret journal is durable before any plaintext file is created.
//! Startup clears only journaled IDs; it never scans and deletes arbitrary files.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const LEASE_SECONDS: u64 = 15 * 60;
const MAX_LEASES: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Lease {
    id: String,
    expires_at: u64,
}

pub(crate) struct Leases {
    directory: PathBuf,
    entries: Vec<Lease>,
    deadlines: HashMap<String, Instant>,
}

fn pending_path(directory: &Path) -> Result<Option<PathBuf>, &'static str> {
    crate::credential_ipc::private_path(directory, true)?;
    let pending = directory.join("ledger.new");
    match fs::symlink_metadata(&pending) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("lease_journal_cleanup_failed");
            }
            crate::credential_ipc::private_path(&pending, false)?;
            Ok(Some(pending))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("lease_journal_cleanup_failed"),
    }
}

fn remove_pending(directory: &Path) -> Result<(), &'static str> {
    if let Some(pending) = pending_path(directory)? {
        fs::remove_file(pending).map_err(|_| "lease_journal_cleanup_failed")?;
    }
    Ok(())
}

impl Leases {
    pub(crate) fn cleanup_required(error: &str) -> bool {
        matches!(
            error,
            "path_unavailable"
                | "unsafe_path_permissions"
                | "private_file_create_failed"
                | "lease_write_failed"
                | "lease_cleanup_failed"
                | "lease_journal_failed"
                | "lease_journal_cleanup_failed"
        )
    }

    pub(crate) fn open(root: &Path) -> Result<Self, &'static str> {
        let mut result = Self::load(root)?;
        remove_pending(&result.directory)?;
        result.clear()?;
        Ok(result)
    }

    pub(crate) fn open_for_product(root: &Path) -> Result<(Self, bool), &'static str> {
        let mut result = Self::load(root)?;
        let failed = remove_pending(&result.directory)
            .and_then(|()| result.clear())
            .is_err();
        Ok((result, failed))
    }

    fn load(root: &Path) -> Result<Self, &'static str> {
        let directory = root.join("leases");
        if !directory.exists() {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .map_err(|_| "lease_directory_failed")?;
        }
        crate::credential_ipc::private_path(&directory, true)?;
        let journal = directory.join("ledger.json");
        let entries: Vec<Lease> = match fs::symlink_metadata(&journal) {
            Ok(_) => {
                serde_json::from_slice(&crate::credential_ipc::read_private(&journal, 32 * 1024)?)
                    .map_err(|_| "lease_journal_invalid")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => return Err("lease_journal_invalid"),
        };
        if entries.len() > MAX_LEASES
            || entries.iter().any(|entry| {
                entry.id.len() != 64 || !entry.id.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("lease_journal_invalid");
        }
        // Invalid roots or journal staging are not a recoverable delete failure.
        pending_path(&directory)?;
        Ok(Self {
            directory,
            entries,
            deadlines: HashMap::new(),
        })
    }

    fn persist(&self) -> Result<(), &'static str> {
        crate::credential_ipc::private_path(&self.directory, true)?;
        // A failed write or rename can leave our fixed staging file. Recover
        // only a private regular file before retrying the atomic journal write.
        remove_pending(&self.directory)?;
        let bytes = serde_json::to_vec(&self.entries).map_err(|_| "lease_journal_failed")?;
        let pending = self.directory.join("ledger.new");
        let mut file = crate::credential_ipc::create_private(&pending)?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "lease_journal_failed")?;
        drop(file);
        fs::rename(pending, self.directory.join("ledger.json"))
            .map_err(|_| "lease_journal_failed")?;
        File::open(&self.directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "lease_journal_failed")
    }

    pub(crate) fn deliver(
        &mut self,
        record_id: &str,
        version: i64,
        bytes: &[u8],
    ) -> Result<Value, &'static str> {
        self.prune()?;
        if self.entries.len() >= MAX_LEASES {
            return Err("too_many_file_leases");
        }
        if bytes.is_empty() || bytes.len() > crate::credential_store::MAX_FILE {
            return Err("file_limit_exceeded");
        }
        let id = crate::credential_auth::random_id()?;
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock_unavailable")?
            .as_secs()
            + LEASE_SECONDS;
        self.entries.push(Lease {
            id: id.clone(),
            expires_at,
        });
        // There can be an entry without a file after a crash, never the reverse.
        if let Err(error) = self.persist() {
            self.entries.pop();
            return Err(error);
        }
        self.deadlines.insert(
            id.clone(),
            Instant::now() + Duration::from_secs(LEASE_SECONDS),
        );
        let path = self.directory.join(format!("{id}.key"));
        let write = (|| {
            let mut file = crate::credential_ipc::create_private(&path)?;
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| "lease_write_failed")
        })();
        if let Err(error) = write {
            self.release(&id)?;
            return Err(error);
        }
        Ok(
            json!({"leaseId":id,"recordId":record_id,"assetVersion":version,
            "path":path,"expiresAt":expires_at,"leaseSeconds":LEASE_SECONDS}),
        )
    }

    pub(crate) fn release(&mut self, id: &str) -> Result<(), &'static str> {
        let Some(index) = self.entries.iter().position(|item| item.id == id) else {
            // Repeated release is idempotent. An unknown ID never authorizes
            // deriving a path or deleting a file, including an unrelated export.
            return Ok(());
        };
        crate::credential_ipc::private_path(&self.directory, true)?;
        let path = self.directory.join(format!("{id}.key"));
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err("lease_cleanup_failed");
                }
                crate::credential_ipc::private_path(&path, false)?;
                fs::remove_file(path).map_err(|_| "lease_cleanup_failed")?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("lease_cleanup_failed"),
        }
        self.entries.remove(index);
        self.deadlines.remove(id);
        self.persist()
    }

    pub(crate) fn clear(&mut self) -> Result<(), &'static str> {
        let ids: Vec<_> = self.entries.iter().map(|entry| entry.id.clone()).collect();
        for id in ids {
            self.release(&id)?;
        }
        // Also repairs a failed final release, whose plaintext file and in-memory
        // entry are already gone while the older durable journal still remains.
        self.persist()
    }

    pub(crate) fn pending_count(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn prune(&mut self) -> Result<(), &'static str> {
        let now = Instant::now();
        let ids: Vec<_> = self
            .deadlines
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.release(&id)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn expire_for_test(&mut self, id: &str) {
        self.deadlines.insert(id.to_owned(), Instant::now());
    }
}
