//! E0 experiments against the host's OpenSSH and Unix filesystem primitives.
//! These tests do not implement a vault, file lease service, or Windows ACLs.
//! Every key is generated in an isolated temporary directory and is disposable.

#[cfg(unix)]
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{symlink, DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    process::{Command, Output, Stdio},
};

#[cfg(unix)]
const DEMO_PASSPHRASE: &str = "srt-e0-disposable-passphrase";

#[cfg(unix)]
fn generate_fixture_key(path: &Path, algorithm: &str, pem: bool, passphrase: &str) {
    let mut command = Command::new("/usr/bin/ssh-keygen");
    command.args(["-q", "-t", algorithm, "-C", "srt-e0-disposable-fixture"]);
    if algorithm == "rsa" {
        command.args(["-b", "2048"]);
    }
    if pem {
        command.args(["-m", "PEM"]);
    }
    let output = command
        .args(["-N", passphrase, "-f"])
        .arg(path)
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env_remove("SSH_ASKPASS")
        .stdin(Stdio::null())
        .output()
        .expect("the host OpenSSH key generator must be available for E0");
    assert!(output.status.success(), "synthetic key generation failed");
}

#[cfg(unix)]
fn derive_public_key(path: &Path, passphrase: &str) -> Output {
    // -P contains only the fixed disposable fixture passphrase. Never use this
    // command construction to pass a real user's secret through argv.
    Command::new("/usr/bin/ssh-keygen")
        .args(["-y", "-P", passphrase, "-f"])
        .arg(path)
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env_remove("SSH_ASKPASS")
        .stdin(Stdio::null())
        .output()
        .expect("the host OpenSSH key reader must be available for E0")
}

#[cfg(unix)]
fn create_private_file(path: &Path, bytes: &[u8]) -> File {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .expect("a new restricted fixture file should be creatable");
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    file
}

#[cfg(unix)]
fn public_material(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(unix)]
#[test]
fn openssh_and_pem_original_bytes_remain_consumable_after_source_removal() {
    let sandbox = tempfile::tempdir().unwrap();
    let managed = sandbox.path().join("受管文件 with spaces");
    DirBuilder::new().mode(0o700).create(&managed).unwrap();
    assert_eq!(
        fs::metadata(&managed).unwrap().permissions().mode() & 0o777,
        0o700
    );

    for (name, algorithm, pem, passphrase) in [
        ("openssh-plain", "ed25519", false, ""),
        ("openssh-encrypted", "ed25519", false, DEMO_PASSPHRASE),
        ("pem-plain", "rsa", true, ""),
        ("pem-encrypted", "rsa", true, DEMO_PASSPHRASE),
    ] {
        let source = sandbox.path().join(name);
        generate_fixture_key(&source, algorithm, pem, passphrase);
        let original = fs::read(&source).unwrap();
        let public = fs::read(source.with_extension("pub")).unwrap();
        let first_line = original.split(|byte| *byte == b'\n').next().unwrap();
        let format_marker = if pem { "RSA" } else { "OPENSSH" };
        assert!(
            std::str::from_utf8(first_line)
                .unwrap()
                .contains(format_marker),
            "fixture format must match the requested storage encoding"
        );

        let delivered = managed.join(format!("{name} 私钥 copy"));
        drop(create_private_file(&delivered, &original));
        assert_eq!(
            fs::metadata(&delivered).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(&source).unwrap();
        assert!(!source.exists());

        let result = derive_public_key(&delivered, passphrase);
        assert!(result.status.success(), "OpenSSH must consume the copy");
        assert_eq!(public_material(&result.stdout), public_material(&public));
        assert!(
            original == fs::read(&delivered).unwrap(),
            "consuming the copy must not transform the private-key bytes"
        );

        if !passphrase.is_empty() {
            for wrong in ["", "wrong-disposable-passphrase"] {
                let rejected = derive_public_key(&delivered, wrong);
                assert!(!rejected.status.success(), "wrong passphrase was accepted");
                assert!(rejected.stdout.is_empty(), "failure returned public output");
                assert!(
                    original == fs::read(&delivered).unwrap(),
                    "failed decryption must not rewrite the imported file"
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn openssh_rejects_world_readable_private_key_and_accepts_restricted_copy() {
    let sandbox = tempfile::tempdir().unwrap();
    let path = sandbox.path().join("disposable-permissions-key");
    generate_fixture_key(&path, "ed25519", false, "");
    let original = fs::read(&path).unwrap();

    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let rejected = derive_public_key(&path, "");
    assert!(
        !rejected.status.success(),
        "publicly readable key was accepted"
    );
    assert!(rejected.stdout.is_empty());

    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let accepted = derive_public_key(&path, "");
    assert!(accepted.status.success());
    assert!(
        original == fs::read(&path).unwrap(),
        "permissions changed key bytes"
    );
}

#[cfg(unix)]
#[test]
fn private_file_creation_rejects_existing_file_without_overwriting() {
    let sandbox = tempfile::tempdir().unwrap();
    let path = sandbox.path().join("existing-fixture");
    let original = b"existing disposable fixture bytes";
    drop(create_private_file(&path, original));

    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path);

    assert_eq!(
        result.unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert!(original.as_slice() == fs::read(&path).unwrap());
}

#[cfg(unix)]
#[test]
fn nofollow_open_rejects_symlink_without_modifying_its_target() {
    let sandbox = tempfile::tempdir().unwrap();
    let target = sandbox.path().join("unrelated-fixture");
    let link = sandbox.path().join("attempted-delivery");
    let original = b"unrelated disposable fixture must remain";
    drop(create_private_file(&target, original));
    symlink(&target, &link).unwrap();

    let result = OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&link);

    assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::ELOOP));
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(original.as_slice() == fs::read(&target).unwrap());
}

#[cfg(unix)]
#[test]
fn unlink_removes_new_path_access_but_does_not_revoke_an_open_handle() {
    let sandbox = tempfile::tempdir().unwrap();
    let path = sandbox.path().join("disposable-open-handle-fixture");
    let original = b"already opened fixture cannot be recalled";
    drop(create_private_file(&path, original));
    let mut open_handle = File::open(&path).unwrap();

    fs::remove_file(&path).unwrap();
    assert!(!path.exists());
    assert_eq!(
        File::open(&path).unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
    let mut observed = Vec::new();
    open_handle.read_to_end(&mut observed).unwrap();
    assert!(original.as_slice() == observed);
}
