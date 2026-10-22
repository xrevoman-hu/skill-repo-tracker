//! E0 host observations, not a production authorization service or MCP implementation.
//!
//! The Keychain experiment requires an accessible native macOS credential store. A
//! denied/locked/unavailable store fails explicitly; this test must not be replaced
//! with a mock or silently skipped in CI. It touches one unique synthetic entry,
//! never an existing application account, and does not change OS access policies.
//! The socket experiment proves local transport/peer primitives only: an echoed
//! initialize-shaped message is not evidence of an MCP handshake or authorization.

use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    thread,
    time::{Duration, Instant},
};

const FRAME_LIMIT: usize = 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);

struct IsolatedKeychainEntry {
    service: String,
    account: String,
    cleanup_required: bool,
}

fn keychain_result<T>(result: keyring::Result<T>, operation: &'static str) -> T {
    result.unwrap_or_else(|error| {
        let category = match error {
            keyring::Error::NoStorageAccess(_) => "native store access denied",
            keyring::Error::PlatformFailure(_) => "native platform failure",
            keyring::Error::NoEntry => "synthetic entry missing",
            keyring::Error::BadEncoding(_) => "invalid stored encoding",
            keyring::Error::Ambiguous(_) => "ambiguous synthetic entry",
            _ => "native store operation failed",
        };
        panic!("E0 isolated Keychain {operation}: {category}; details redacted");
    })
}

impl IsolatedKeychainEntry {
    fn entry(&self) -> keyring::Entry {
        keychain_result(
            keyring::Entry::new(&self.service, &self.account),
            "construct",
        )
    }
}

impl Drop for IsolatedKeychainEntry {
    fn drop(&mut self) {
        if !self.cleanup_required {
            return;
        }
        let result =
            keyring::Entry::new(&self.service, &self.account).and_then(|entry| {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => entry.get_password(),
                    Err(error) => Err(error),
                }
            });
        if !matches!(result, Err(keyring::Error::NoEntry)) {
            eprintln!(
                "E0 isolated Keychain cleanup failed; synthetic entry may remain: service={}, account={}",
                self.service, self.account
            );
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn native_keychain_reopened_entry_reads_replacement_and_explicit_deletion() {
    // tempfile contributes an unpredictable identifier without enumerating items.
    let identity = tempfile::Builder::new()
        .prefix("srt-e0-native-")
        .tempdir()
        .expect("create isolated E0 identity");
    let suffix = identity
        .path()
        .file_name()
        .expect("temporary identity name")
        .to_str()
        .expect("temporary identity is UTF-8");
    let mut item = IsolatedKeychainEntry {
        service: format!("Skill Repo Tracker E0 Isolated {suffix}"),
        account: "synthetic-access-code".into(),
        cleanup_required: false,
    };
    let fresh_entry = item.entry();
    assert!(
        matches!(fresh_entry.get_password(), Err(keyring::Error::NoEntry)),
        "E0 unique entry is not absent or native store is unavailable; no write performed"
    );

    // After absence is established, cleanup is restricted to our unique entry,
    // including a partially successful write that reports an error.
    item.cleanup_required = true;
    keychain_result(
        fresh_entry.set_password("e0 synthetic access value one"),
        "create",
    );
    drop(fresh_entry);
    let reopened = item.entry();
    let first = keychain_result(reopened.get_password(), "read reopened entry");
    assert!(
        first == "e0 synthetic access value one",
        "E0 reopened entry did not preserve synthetic value"
    );
    keychain_result(
        reopened.set_password("e0 synthetic access value two"),
        "replace",
    );
    drop(reopened);
    let after_replacement = item.entry();
    let second = keychain_result(after_replacement.get_password(), "read replacement");
    assert!(
        second == "e0 synthetic access value two",
        "E0 replacement was not persisted"
    );
    keychain_result(after_replacement.delete_credential(), "delete");
    drop(after_replacement);
    assert!(
        matches!(item.entry().get_password(), Err(keyring::Error::NoEntry)),
        "E0 deleted synthetic entry remains readable or store check failed"
    );
    item.cleanup_required = false;
}

fn configure_stream(stream: &UnixStream) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))
}

fn accept_before_deadline(listener: &UnixListener) -> io::Result<UnixStream> {
    let deadline = Instant::now() + IO_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                configure_stream(&stream)?;
                return Ok(stream);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "E0 accept timeout"));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
}

fn read_bounded_line(stream: &UnixStream) -> io::Result<Vec<u8>> {
    let mut limited = BufReader::new(stream).take((FRAME_LIMIT + 1) as u64);
    let mut frame = Vec::new();
    limited.read_until(b'\n', &mut frame)?;
    if frame.len() > FRAME_LIMIT || frame.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "E0 invalid or oversized frame",
        ));
    }
    Ok(frame)
}

fn assert_native_peer_is_current_user(stream: &UnixStream) {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: the live stream owns the descriptor; both output pointers refer to
    // initialized, correctly sized local values for the duration of this call.
    let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    assert_eq!(result, 0, "E0 native peer credential lookup failed");
    // SAFETY: geteuid has no pointer inputs and is supported by this macOS lane.
    let current_uid = unsafe { libc::geteuid() };
    assert_eq!(uid, current_uid, "E0 socket peer is not the current user");
}

#[cfg(target_os = "macos")]
#[test]
fn native_unix_socket_has_private_mode_native_peers_and_bounded_lines() {
    let directory = tempfile::Builder::new()
        .prefix("srt-e0-ipc-")
        .tempdir()
        .expect("create isolated socket directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("restrict socket directory");
    let socket_path = directory.path().join("ipc");
    let listener = UnixListener::bind(&socket_path).expect("bind private Unix socket");
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
        .expect("restrict socket mode");
    assert_eq!(
        fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&socket_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    listener
        .set_nonblocking(true)
        .expect("bound accept to deadline");

    let server = thread::spawn(move || {
        for expected_id in [1, 2] {
            let mut stream = accept_before_deadline(&listener).expect("accept E0 client");
            assert_native_peer_is_current_user(&stream);
            let frame = read_bounded_line(&stream).expect("read bounded E0 line");
            let value: serde_json::Value =
                serde_json::from_slice(&frame).expect("parse non-secret E0 message");
            assert_eq!(value["id"], expected_id);
            assert_eq!(value["method"], "initialize");
            stream.write_all(&frame).expect("echo E0 transport line");
        }
        let mut stream = accept_before_deadline(&listener).expect("accept oversized E0 client");
        assert_native_peer_is_current_user(&stream);
        let result = read_bounded_line(&stream);
        assert!(
            matches!(result, Err(ref error) if error.kind() == io::ErrorKind::InvalidData),
            "E0 oversized frame was not bounded"
        );
        stream
            .write_all(b"frame_too_large\n")
            .expect("return fixed E0 framing error");
    });

    for id in [1, 2] {
        let mut client = UnixStream::connect(&socket_path).expect("connect private E0 client");
        configure_stream(&client).expect("bound E0 client IO");
        assert_native_peer_is_current_user(&client);
        let mut frame = serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize"
        }))
        .expect("serialize synthetic E0 message");
        frame.push(b'\n');
        client.write_all(&frame).expect("send E0 line");
        assert_eq!(read_bounded_line(&client).unwrap(), frame);
    }

    let mut oversized = UnixStream::connect(&socket_path).expect("connect E0 frame-limit client");
    configure_stream(&oversized).expect("bound E0 frame-limit IO");
    let mut frame = vec![b'x'; FRAME_LIMIT + 1];
    frame.push(b'\n');
    oversized.write_all(&frame).expect("send oversized E0 line");
    assert_eq!(read_bounded_line(&oversized).unwrap(), b"frame_too_large\n");
    drop(oversized);
    server.join().expect("E0 transport server terminated");
    assert!(
        UnixStream::connect(&socket_path).is_err(),
        "E0 listener remained available after termination"
    );
}
