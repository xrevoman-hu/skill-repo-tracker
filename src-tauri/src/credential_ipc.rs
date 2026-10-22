//! Private same-user IPC. Both peers must be this exact executable before the
//! access code is sent. This does not isolate malicious code already running as
//! the same user with permission to run or replace the trusted executable.

use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, Read, Write},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const FRAME_LIMIT: usize = 24 * 1024 * 1024;
pub(crate) const REQUEST_LIMIT: usize = 64 * 1024;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn verify_root(root: &Path, vault_id: &str) -> Result<(), &'static str> {
    if !root.is_absolute()
        || !crate::credential_auth::valid_id(vault_id)
        || fs::canonicalize(root).map_err(|_| "root_unavailable")? != root
    {
        return Err("invalid_e0_root");
    }
    private_path(root, true)?;
    let product = production_root(root, vault_id)?;
    let marker_path = root.join(if product {
        "vault.json"
    } else {
        "e0-vault.json"
    });
    let marker: Value =
        serde_json::from_slice(&read_private(&marker_path, 512)?).map_err(|_| "invalid_e0_root")?;
    let schema = if product {
        "srt-credential-v1"
    } else {
        "srt-credential-e0-v1"
    };
    if marker != serde_json::json!({"schema":schema,"vaultId":vault_id}) {
        return Err("invalid_e0_root");
    }
    Ok(())
}

pub(crate) fn production_root(root: &Path, _vault_id: &str) -> Result<bool, &'static str> {
    let product = root.join("vault.json").exists();
    let fixture = root.join("e0-vault.json").exists();
    if product == fixture {
        return Err("invalid_vault_root");
    }
    Ok(product)
}

fn endpoint_directory(root: &Path, vault_id: &str) -> PathBuf {
    let mut hash = Sha256::new();
    hash.update(root.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(vault_id.as_bytes());
    let digest = hex::encode(hash.finalize());
    // SAFETY: geteuid takes no pointers.
    let uid = unsafe { libc::geteuid() };
    PathBuf::from(format!(
        "/private/tmp/srt-credential-e0-{uid}-{}",
        &digest[..24]
    ))
}

pub(crate) struct Endpoint {
    listener: UnixListener,
    _lock: File,
    path: PathBuf,
    identity: (u64, u64),
}

impl Endpoint {
    pub(crate) fn accept(&self) -> Result<Option<UnixStream>, &'static str> {
        match self.listener.accept() {
            Ok((stream, _)) => {
                verify_peer(&stream)?;
                Ok(Some(stream))
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(_) => Err("ipc_unavailable"),
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            if (metadata.dev(), metadata.ino()) == self.identity {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

pub(crate) fn bind_listener(root: &Path, vault_id: &str) -> Result<Endpoint, &'static str> {
    verify_root(root, vault_id)?;
    let directory = endpoint_directory(root, vault_id);
    if !directory.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| "ipc_directory_failed")?;
    }
    private_path(&directory, true)?;
    let lock_path = directory.join("host.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&lock_path)
        .map_err(|_| "ipc_lock_failed")?;
    private_path(&lock_path, false)?;
    // SAFETY: lock is an open descriptor retained for the complete host lifetime.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("host_already_running");
    }
    let path = directory.join("ipc");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_socket() {
            return Err("unsafe_ipc_path");
        }
        private_path(&path, false)?;
        fs::remove_file(&path).map_err(|_| "ipc_cleanup_failed")?;
    }
    let listener = UnixListener::bind(&path).map_err(|_| "ipc_bind_failed")?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "ipc_permissions_failed")?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| "ipc_unavailable")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "ipc_unavailable")?;
    Ok(Endpoint {
        listener,
        _lock: lock,
        path,
        identity: (metadata.dev(), metadata.ino()),
    })
}

pub(crate) fn connect_host(root: &Path, vault_id: &str) -> Result<UnixStream, &'static str> {
    verify_root(root, vault_id)?;
    let directory = endpoint_directory(root, vault_id);
    private_path(&directory, true)?;
    let path = directory.join("ipc");
    private_path(&path, false)?;
    if !fs::symlink_metadata(&path)
        .map_err(|_| "host_unavailable")?
        .file_type()
        .is_socket()
    {
        return Err("unsafe_ipc_path");
    }
    let stream = UnixStream::connect(path).map_err(|_| "host_unavailable")?;
    verify_peer(&stream)?;
    Ok(stream)
}

pub(crate) fn read_line(reader: &mut impl BufRead) -> Result<Option<Value>, &'static str> {
    read_line_limit(reader, FRAME_LIMIT)
}

pub(crate) fn read_request(reader: &mut impl BufRead) -> Result<Option<Value>, &'static str> {
    read_line_limit(reader, REQUEST_LIMIT)
}

// One message per private IPC connection. Absolute deadlines prevent a peer
// from extending the timeout indefinitely by trickling bytes between reads.
pub(crate) fn read_ipc(
    stream: &mut UnixStream,
    limit: usize,
) -> Result<Option<Value>, &'static str> {
    let deadline = Instant::now() + TIMEOUT;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("ipc_timeout")?;
        if remaining.is_zero() {
            return Err("ipc_timeout");
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "ipc_unavailable")?;
        let count = stream
            .read(&mut buffer)
            .map_err(|_| "ipc_input_unavailable")?;
        if count == 0 {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("invalid_ipc_frame")
            };
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > limit {
            return Err("frame_limit_exceeded");
        }
        if let Some(end) = buffer[..count].iter().position(|byte| *byte == b'\n') {
            if end + 1 != count {
                return Err("invalid_ipc_frame");
            }
            return serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "invalid_json");
        }
    }
}

pub(crate) fn write_ipc(stream: &mut UnixStream, value: &Value) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "encode_failed")?;
    if bytes.len() >= FRAME_LIMIT {
        return Err("frame_limit_exceeded");
    }
    bytes.push(b'\n');
    let deadline = Instant::now() + TIMEOUT;
    let mut offset = 0;
    while offset < bytes.len() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("ipc_timeout")?;
        if remaining.is_zero() {
            return Err("ipc_timeout");
        }
        stream
            .set_write_timeout(Some(remaining))
            .map_err(|_| "ipc_unavailable")?;
        let count = stream
            .write(&bytes[offset..])
            .map_err(|_| "ipc_output_unavailable")?;
        if count == 0 {
            return Err("ipc_output_unavailable");
        }
        offset += count;
    }
    Ok(())
}

pub(crate) fn bounded_response(value: Value) -> Value {
    if crate::credential_protocol::fits_limit(&value, FRAME_LIMIT) {
        value
    } else {
        serde_json::json!({"error":"secret_text_response_too_large"})
    }
}

fn read_line_limit(reader: &mut impl BufRead, limit: usize) -> Result<Option<Value>, &'static str> {
    let mut bytes = Vec::new();
    let count = reader
        .take((limit + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "input_unavailable")?;
    if count == 0 {
        return Ok(None);
    }
    if bytes.len() > limit || bytes.last() != Some(&b'\n') {
        return Err("frame_limit_exceeded");
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "invalid_json")
}

pub(crate) fn write_line(writer: &mut impl Write, value: &Value) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "encode_failed")?;
    if bytes.len() >= FRAME_LIMIT {
        return Err("frame_limit_exceeded");
    }
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .and_then(|()| writer.flush())
        .map_err(|_| "output_unavailable")
}

pub(crate) fn private_path(path: &Path, directory: bool) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "path_unavailable")?;
    // SAFETY: geteuid has no pointer inputs.
    let uid = unsafe { libc::geteuid() };
    let expected_mode = if directory { 0o700 } else { 0o600 };
    if metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.permissions().mode() & 0o777 != expected_mode
        || (directory && !metadata.is_dir())
    {
        return Err("unsafe_path_permissions");
    }
    Ok(())
}

pub(crate) fn create_private(path: &Path) -> Result<File, &'static str> {
    OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "private_file_create_failed")
}

pub(crate) fn read_private(path: &Path, limit: usize) -> Result<Vec<u8>, &'static str> {
    private_path(path, false)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "private_file_open_failed")?;
    if !file
        .metadata()
        .map_err(|_| "private_file_open_failed")?
        .is_file()
    {
        return Err("not_regular_file");
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "private_file_read_failed")?;
    if bytes.len() > limit {
        return Err("file_limit_exceeded");
    }
    Ok(bytes)
}

pub(crate) fn verify_peer(stream: &UnixStream) -> Result<(), &'static str> {
    stream
        .set_nonblocking(false)
        .map_err(|_| "ipc_unavailable")?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|_| "ipc_unavailable")?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|_| "ipc_unavailable")?;
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: live fd, writable output pointers matching getpeereid's types.
    let code = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    // SAFETY: geteuid takes no pointers.
    if code != 0 || uid != unsafe { libc::geteuid() } {
        return Err("untrusted_ipc_peer");
    }
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
    // SAFETY: output has pid_t size, and len is a valid socklen_t pointer.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            0,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut len,
        )
    };
    if result != 0 || pid <= 0 || len as usize != std::mem::size_of_val(&pid) {
        return Err("untrusted_ipc_peer");
    }
    let mut buffer = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: proc_pidpath receives the actual allocated buffer size.
    let count = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if count <= 0 {
        return Err("untrusted_ipc_peer");
    }
    let end = buffer
        .iter()
        .position(|b| *b == 0)
        .ok_or("untrusted_ipc_peer")?;
    let executable = std::str::from_utf8(&buffer[..end]).map_err(|_| "untrusted_ipc_peer")?;
    let own = std::env::current_exe().map_err(|_| "executable_identity_unavailable")?;
    if fs::canonicalize(executable).map_err(|_| "untrusted_ipc_peer")?
        != fs::canonicalize(own).map_err(|_| "executable_identity_unavailable")?
    {
        return Err("untrusted_ipc_peer");
    }
    Ok(())
}

#[cfg(test)]
#[path = "credential_ipc_tests.rs"]
mod tests;
