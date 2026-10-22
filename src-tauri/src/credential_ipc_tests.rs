use super::*;
use serde_json::json;

fn root() -> (tempfile::TempDir, PathBuf, String) {
    let owner = tempfile::tempdir().unwrap();
    fs::set_permissions(owner.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = owner.path().canonicalize().unwrap();
    let id = crate::credential_auth::random_id().unwrap();
    let mut marker = create_private(&root.join("vault.json")).unwrap();
    marker
        .write_all(
            json!({"schema":"srt-credential-v1","vaultId":id})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    (owner, root, id)
}

struct EndpointCleanup(PathBuf);
impl Drop for EndpointCleanup {
    fn drop(&mut self) {
        // Only the three exact paths generated for this test's fresh identity.
        let _ = fs::remove_file(self.0.join("ipc"));
        let _ = fs::remove_file(self.0.join("host.lock"));
        let _ = fs::remove_dir(&self.0);
    }
}

#[test]
fn private_endpoint_connects_same_executable_exclusively_and_roundtrips_one_frame() {
    let (_owner, root, id) = root();
    let directory = endpoint_directory(&root, &id);
    let _cleanup = EndpointCleanup(directory.clone());
    let endpoint = bind_listener(&root, &id).unwrap();
    assert!(endpoint.accept().unwrap().is_none());
    assert!(matches!(
        bind_listener(&root, &id),
        Err("host_already_running")
    ));
    assert_eq!(
        fs::metadata(directory.join("ipc"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let mut client = connect_host(&root, &id).unwrap();
    let mut server = endpoint.accept().unwrap().unwrap();
    write_ipc(&mut client, &json!({"request":"synthetic only"})).unwrap();
    assert_eq!(
        read_ipc(&mut server, REQUEST_LIMIT).unwrap(),
        Some(json!({"request":"synthetic only"}))
    );
    write_ipc(&mut server, &json!({"result":"bounded"})).unwrap();
    assert_eq!(
        read_ipc(&mut client, FRAME_LIMIT).unwrap(),
        Some(json!({"result":"bounded"}))
    );
    drop(client);
    drop(server);
    drop(endpoint);
    assert!(!directory.join("ipc").exists());
    assert!(connect_host(&root, &id).is_err());
}

#[test]
fn endpoint_never_unlinks_a_replaced_file_or_accepts_a_regular_file_as_socket() {
    let (_owner, root, id) = root();
    let directory = endpoint_directory(&root, &id);
    let _cleanup = EndpointCleanup(directory.clone());
    let endpoint = bind_listener(&root, &id).unwrap();
    fs::remove_file(directory.join("ipc")).unwrap();
    create_private(&directory.join("ipc"))
        .unwrap()
        .write_all(b"replacement owned by user")
        .unwrap();
    assert!(matches!(connect_host(&root, &id), Err("unsafe_ipc_path")));
    drop(endpoint);
    assert_eq!(
        fs::read(directory.join("ipc")).unwrap(),
        b"replacement owned by user"
    );
    assert!(matches!(bind_listener(&root, &id), Err("unsafe_ipc_path")));
    assert_eq!(
        fs::read(directory.join("ipc")).unwrap(),
        b"replacement owned by user"
    );
}

#[test]
fn private_ipc_rejects_truncation_multiple_frames_and_oversize_without_a_tool_response() {
    for (bytes, limit, expected) in [
        (&b"{\"a\":1}"[..], 64, "invalid_ipc_frame"),
        (&b"{}\n{}\n"[..], 64, "invalid_ipc_frame"),
        (&b"not-json\n"[..], 64, "invalid_json"),
        (&b"{\"a\":123456}\n"[..], 8, "frame_limit_exceeded"),
    ] {
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        sender.write_all(bytes).unwrap();
        sender.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(read_ipc(&mut receiver, limit).unwrap_err(), expected);
    }
    let (sender, mut receiver) = UnixStream::pair().unwrap();
    sender.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(read_ipc(&mut receiver, FRAME_LIMIT).unwrap(), None);
    let mut reader = std::io::Cursor::new(b"{}\n");
    assert_eq!(read_request(&mut reader).unwrap(), Some(json!({})));
    let (mut sender, receiver) = UnixStream::pair().unwrap();
    assert_eq!(
        write_ipc(&mut sender, &json!("x".repeat(FRAME_LIMIT))).unwrap_err(),
        "frame_limit_exceeded"
    );
    drop(receiver);
    assert!(matches!(
        write_ipc(&mut sender, &json!({})),
        Err("ipc_unavailable" | "ipc_output_unavailable")
    ));
}

#[test]
fn only_canonical_private_roots_and_bounded_regular_files_are_accepted() {
    let (_owner, root, id) = root();
    assert!(verify_root(Path::new("relative"), &id).is_err());
    assert!(verify_root(&root, "wrong-id").is_err());
    let path = root.join("bounded");
    create_private(&path).unwrap().write_all(b"abcd").unwrap();
    assert_eq!(read_private(&path, 4).unwrap(), b"abcd");
    assert_eq!(read_private(&path, 3).unwrap_err(), "file_limit_exceeded");
    assert!(create_private(&path).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        read_private(&path, 4).unwrap_err(),
        "unsafe_path_permissions"
    );
    let link = root.join("alias");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert_eq!(
        private_path(&link, false).unwrap_err(),
        "unsafe_path_permissions"
    );
    fs::set_permissions(&root, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        private_path(&root, true).unwrap_err(),
        "unsafe_path_permissions"
    );
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    create_private(&root.join("e0-vault.json")).unwrap();
    assert_eq!(
        production_root(&root, &id).unwrap_err(),
        "invalid_vault_root"
    );
}
