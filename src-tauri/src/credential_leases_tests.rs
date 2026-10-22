//! Controlled child-process barriers. Nothing in this module is in the product binary.
use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock, TryLockError},
    time::{Duration, Instant},
};

struct Control {
    directory: PathBuf,
    stage: String,
}

static CONTROL: OnceLock<Control> = OnceLock::new();

pub(crate) fn install(directory: PathBuf, stage: String) {
    assert!(CONTROL.set(Control { directory, stage }).is_ok());
}

pub(crate) fn pause(stage: &str) {
    let Some(control) = CONTROL.get().filter(|control| control.stage == stage) else {
        return;
    };
    fs::write(control.directory.join("reached"), stage).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !control.directory.join("resume").exists() {
        assert!(Instant::now() < deadline, "test barrier was not released");
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub(crate) fn before_ipc_delivery<T>(host: &Mutex<T>) {
    assert!(matches!(host.try_lock(), Err(TryLockError::WouldBlock)));
    pause("ipc_delivery");
}

pub(crate) fn write_prefix<'a>(file: &mut File, bytes: &'a [u8]) -> Result<&'a [u8], &'static str> {
    if CONTROL
        .get()
        .is_some_and(|control| control.stage == "partial_write")
    {
        let split = bytes.len() / 2;
        assert!(split > 0 && split < bytes.len());
        file.write_all(&bytes[..split])
            .and_then(|()| file.sync_all())
            .map_err(|_| "lease_write_failed")?;
        pause("partial_write");
        Ok(&bytes[split..])
    } else {
        Ok(bytes)
    }
}

#[test]
fn unarmed_test_hook_preserves_full_file_and_unregistered_neighbors() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut leases = super::Leases::open(root.path()).unwrap();
    let neighbor = root.path().join("leases/user-export.key");
    fs::write(&neighbor, b"unregistered synthetic export").unwrap();
    let bytes = b"full synthetic bytes\0\xff\r\n";
    let delivered = leases.deliver("synthetic-record", 1, bytes).unwrap();
    let path = PathBuf::from(delivered["path"].as_str().unwrap());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    leases.clear().unwrap();
    assert!(!path.exists());
    assert_eq!(
        fs::read(&neighbor).unwrap(),
        b"unregistered synthetic export"
    );
}
