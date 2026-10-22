use super::*;
use base64::Engine;
use std::{io::Cursor, os::unix::fs::PermissionsExt};

fn private_test_directory() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn fixture() -> (tempfile::TempDir, Host) {
    let directory = private_test_directory();
    let root = fs::canonicalize(directory.path()).unwrap();
    let mut host = Host::open(&root, "e0-unit-vault").unwrap();
    host.control(&json!({"action":"create","password":"e0 test password 密码  "}))
        .unwrap();
    // Unit-level injected authorization; the actual Keychain/process lane is separate.
    host.code = Some("a".repeat(64));
    host.sharing = true;
    (directory, host)
}

fn request(name: &str, arguments: Value) -> Value {
    json!({"auth":"a".repeat(64),"name":name,"arguments":arguments})
}

#[test]
fn unavailable_keychain_keeps_host_operable_and_existing_sharing_intent() {
    let (_directory, original) = fixture();
    original.persist_sharing(true).unwrap();
    let root = original.root.clone();
    drop(original);
    for access in [
        Err("credential_authorization_required"),
        Err("credential_store_unavailable"),
        Ok(None),
    ] {
        let expected = access
            .as_ref()
            .err()
            .copied()
            .unwrap_or("agent_access_missing");
        let mut host = Host::open_with_access(&root, "e0-unit-vault", |_| access).unwrap();
        let status = host.control(&json!({"action":"status"})).unwrap();
        assert_eq!(status["locked"], true);
        assert_eq!(status["sharing"], false);
        assert_eq!(status["sharingRequested"], true);
        assert_eq!(status["authorizationError"], expected);
        assert_eq!(fs::read(root.join("sharing.json")).unwrap(), b"true");
        assert_eq!(
            host.request(&request("srt_credentials_search", json!({})))
                .unwrap_err(),
            expected
        );
        assert_eq!(
            host.authorize_with(|_| panic!("locked must not prompt"))
                .unwrap_err(),
            "vault_locked"
        );
        host.control(&json!({"action":"shutdown"})).unwrap();
    }
}

#[test]
fn explicit_reauthorization_requires_unlock_and_preserves_existing_access_material() {
    let (_directory, mut host) = fixture();
    let lease = host
        .leases
        .deliver("ssh-001", 1, b"synthetic leased bytes")
        .unwrap();
    let leased_path = PathBuf::from(lease["path"].as_str().unwrap());
    let result = host.authorize_with(|_| Err("credential_authorization_cancelled"));
    assert_eq!(result.unwrap_err(), "credential_authorization_cancelled");
    assert!(!leased_path.exists());
    assert!(host.code.is_none());
    assert_eq!(
        host.request(&request("srt_credentials_search", json!({})))
            .unwrap_err(),
        "credential_authorization_cancelled"
    );
    host.authorize_with(|id| {
        assert_eq!(id, "e0-unit-vault");
        Ok("a".repeat(64))
    })
    .unwrap();
    assert!(host
        .request(&request("srt_credentials_search", json!({})))
        .is_ok());
    host.control(&json!({"action":"share","enabled":false}))
        .unwrap();
    host.authorize_with(|_| Ok("a".repeat(64))).unwrap();
    let status = host.control(&json!({"action":"status"})).unwrap();
    assert_eq!(status["sharingRequested"], false);
    assert_eq!(status["sharing"], false);
    assert_eq!(fs::read(host.root.join("sharing.json")).unwrap(), b"false");
    assert_eq!(
        host.request(&request("srt_credentials_search", json!({})))
            .unwrap_err(),
        "sharing_disabled"
    );
}

#[test]
fn credential_mode_errors_never_fall_through_to_the_ordinary_app() {
    let args = |items: &[&str]| items.iter().map(|item| OsString::from(*item)).collect();
    assert!(credential_arguments(args(&[])).is_none());
    assert!(credential_arguments(args(&["--ordinary-option"])).is_none());
    for items in [
        vec!["--credential-bridge=wrong"],
        vec!["--credential-bridg"],
        vec!["--credentials"],
        vec!["--root", "/fixture", "--credential-bridge"],
        vec!["--credential-e0-host"],
        vec!["--credential-bridge", "--root", "/fixture"],
        vec![
            "--credential-bridge",
            "--root",
            "/fixture",
            "--vault-id",
            "e0",
            "extra",
        ],
    ] {
        assert!(
            credential_arguments(args(&items)).unwrap().is_err(),
            "{items:?}"
        );
    }
    let parsed = credential_arguments(args(&[
        "--credential-bridge",
        "--root",
        "/fixture",
        "--vault-id",
        "e0",
    ]))
    .unwrap()
    .unwrap();
    assert!(!parsed.0);
    assert_eq!(parsed.1, PathBuf::from("/fixture"));
    assert_eq!(parsed.2, "e0");
}

#[test]
fn protocol_requires_initialized_notification_and_preserves_json_rpc_identity() {
    let mut protocol = credential_mcp::Protocol::new();
    let before = protocol
        .handle(
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            |_, _| panic!(),
        )
        .unwrap();
    assert_eq!(before["error"]["code"], -32002);
    let malformed = protocol
        .handle(
            json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}),
            |_, _| panic!(),
        )
        .unwrap();
    assert_eq!(malformed["error"]["code"], -32602);
    let initialized=protocol.handle(json!({"jsonrpc":"2.0","id":"init","method":"initialize",
        "params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e0","version":"1"}}}),|_,_|panic!()).unwrap();
    assert_eq!(initialized["id"], "init");
    assert_eq!(initialized["result"]["protocolVersion"], "2025-03-26");
    assert!(protocol
        .handle(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            |_, _| panic!()
        )
        .is_none());
    let listed = protocol
        .handle(
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            |_, _| panic!(),
        )
        .unwrap();
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 4);
}

#[test]
fn encrypted_host_exposes_only_requested_fields_and_no_search_secrets() {
    let (_directory, mut host) = fixture();
    let search = host
        .request(&request(
            "srt_credentials_search",
            json!({"query":"website"}),
        ))
        .unwrap();
    assert_eq!(search["records"].as_array().unwrap().len(), 1);
    assert!(!search.to_string().contains("e0-website-value-only"));
    let result = host
        .request(&request(
            "srt_credentials_read_fields",
            json!({
        "vaultId":"e0-unit-vault","recordId":"website-001","fields":["password"]}),
        ))
        .unwrap();
    assert_eq!(result["fields"].as_object().unwrap().len(), 1);
    assert!(result["fields"]["password"].as_str() == Some("e0-website-value-only"));
    let bytes = fs::read(host.root.join("vault.db")).unwrap();
    assert!(!bytes
        .windows(b"e0-website-value-only".len())
        .any(|w| w == b"e0-website-value-only"));
}

#[test]
fn auth_lock_and_vault_identity_fail_before_returning_records() {
    let (_directory, mut host) = fixture();
    let mut call = request("srt_credentials_search", json!({}));
    call["auth"] = json!("b".repeat(64));
    assert_eq!(host.request(&call).unwrap_err(), "authorization_rejected");
    assert_eq!(
        host.request(&request(
            "srt_credentials_read_fields",
            json!({
        "vaultId":"another-vault","recordId":"website-001","fields":["password"]})
        ))
        .unwrap_err(),
        "vault_id_mismatch"
    );
    host.control(&json!({"action":"lock"})).unwrap();
    assert_eq!(
        host.request(&request("srt_credentials_search", json!({})))
            .unwrap_err(),
        "vault_locked"
    );
    host.sharing = false;
    assert_eq!(host.request(&call).unwrap_err(), "sharing_disabled");
}

#[test]
fn lock_removes_managed_files_and_startup_recovers_journaled_crash_residue() {
    let (_directory, mut host) = fixture();
    host.control(&json!({"action":"fixture_file","bytesBase64":
        base64::engine::general_purpose::STANDARD.encode(b"E0 file bytes\0\xff")}))
        .unwrap();
    let call = request(
        "srt_credentials_lease_file",
        json!({"vaultId":"e0-unit-vault","recordId":"ssh-001"}),
    );
    let lease = host.request(&call).unwrap();
    let path = PathBuf::from(lease["path"].as_str().unwrap());
    assert!(path.exists());
    assert_eq!(fs::read(&path).unwrap(), b"E0 file bytes\0\xff");
    host.control(&json!({"action":"lock"})).unwrap();
    assert!(!path.exists());
    host.control(&json!({"action":"unlock","password":"e0 test password 密码  "}))
        .unwrap();
    let leaked = host.request(&call).unwrap();
    let leaked_path = PathBuf::from(leaked["path"].as_str().unwrap());
    let root = host.root.clone();
    drop(host);
    assert!(leaked_path.exists());
    let recovered = Host::open(&root, "e0-unit-vault").unwrap();
    assert!(recovered.store.is_none());
    assert!(!leaked_path.exists());
}

#[test]
fn expiration_is_monotonic_and_releasing_unknown_id_does_not_delete_other_files() {
    let (_directory, mut host) = fixture();
    let lease = host
        .leases
        .deliver("ssh-001", 1, b"E0 disposable bytes")
        .unwrap();
    let id = lease["leaseId"].as_str().unwrap();
    let path = PathBuf::from(lease["path"].as_str().unwrap());
    let unrelated = host.root.join("leases").join("user-export.txt");
    fs::write(&unrelated, b"keep").unwrap();
    host.leases.release(&"b".repeat(64)).unwrap();
    assert!(path.exists());
    host.leases.expire_for_test(id);
    host.leases.prune().unwrap();
    assert!(!path.exists());
    host.leases.release(id).unwrap();
    host.leases.release(id).unwrap();
    assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
}

#[test]
fn cleanup_failure_persists_disabled_sharing_and_preserves_unmanaged_path() {
    let (_directory, mut host) = fixture();
    let lease = host
        .leases
        .deliver("ssh-001", 1, b"E0 disposable bytes")
        .unwrap();
    let path = PathBuf::from(lease["path"].as_str().unwrap());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
        host.control(&json!({"action":"share","enabled":false}))
            .unwrap_err(),
        "lease_cleanup_failed"
    );
    assert!(!host.sharing);
    assert!(host.cleanup_failed);
    assert_eq!(fs::read(host.root.join("sharing.json")).unwrap(), b"false");
    assert!(path.is_dir());
    assert_eq!(
        host.request(&request("srt_credentials_search", json!({})))
            .unwrap_err(),
        "sharing_disabled"
    );
}

#[test]
fn mcp_release_permission_failure_blocks_reads_until_explicit_successful_cleanup_retry() {
    let (_directory, mut host) = fixture();
    host.control(&json!({"action":"fixture_file","bytesBase64":
        base64::engine::general_purpose::STANDARD.encode(b"E0 MCP file fixture")}))
        .unwrap();
    let lease = host
        .request(&request(
            "srt_credentials_lease_file",
            json!({
                "vaultId":"e0-unit-vault","recordId":"ssh-001"
            }),
        ))
        .unwrap();
    let path = PathBuf::from(lease["path"].as_str().unwrap());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(
        host.request(&request(
            "srt_credentials_release_file",
            json!({
                "leaseId":lease["leaseId"]
            })
        ))
        .unwrap_err(),
        "unsafe_path_permissions"
    );
    assert!(host.cleanup_failed);
    let read = request(
        "srt_credentials_read_fields",
        json!({
            "vaultId":"e0-unit-vault","recordId":"website-001","fields":["password"]
        }),
    );
    assert_eq!(host.request(&read).unwrap_err(), "cleanup_failed");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    host.control(&json!({"action":"lock"})).unwrap();
    host.control(&json!({"action":"unlock","password":"e0 test password 密码  "}))
        .unwrap();
    assert_eq!(host.request(&read).unwrap_err(), "cleanup_failed");
    host.control(&json!({"action":"retry_cleanup"})).unwrap();
    assert!(!host.cleanup_failed);
    assert!(!path.exists());
    assert_eq!(
        host.request(&read).unwrap()["fields"]["password"],
        "e0-website-value-only"
    );
}

#[test]
fn mcp_lease_capacity_error_does_not_latch_a_cleanup_failure() {
    let (_directory, mut host) = fixture();
    let call = request(
        "srt_credentials_lease_file",
        json!({
            "vaultId":"e0-unit-vault","recordId":"ssh-001"
        }),
    );
    assert_eq!(host.request(&call).unwrap_err(), "file_not_found");
    assert!(!host.cleanup_failed);
    host.control(&json!({"action":"fixture_file","bytesBase64":
        base64::engine::general_purpose::STANDARD.encode(b"E0 capacity fixture")}))
        .unwrap();
    for _ in 0..64 {
        host.request(&call).unwrap();
    }
    assert_eq!(host.request(&call).unwrap_err(), "too_many_file_leases");
    assert!(!host.cleanup_failed);
    assert!(host
        .request(&request("srt_credentials_search", json!({})))
        .is_ok());
    host.control(&json!({"action":"lock"})).unwrap();
}

#[test]
fn failed_journal_rename_can_be_retried_without_restarting_or_losing_other_files() {
    let (_directory, mut host) = fixture();
    let lease = host
        .leases
        .deliver("ssh-001", 1, b"E0 disposable bytes")
        .unwrap();
    let path = PathBuf::from(lease["path"].as_str().unwrap());
    let directory = host.root.join("leases");
    let journal = directory.join("ledger.json");
    let pending = directory.join("ledger.new");
    let backup = directory.join("journal-test-backup.json");
    let unrelated = directory.join("user-export.txt");
    fs::write(&unrelated, b"keep").unwrap();
    fs::rename(&journal, &backup).unwrap();
    fs::create_dir(&journal).unwrap();
    assert_eq!(
        host.control(&json!({"action":"lock"})).unwrap_err(),
        "lease_journal_failed"
    );
    assert!(host.cleanup_failed);
    assert!(!path.exists());
    assert!(pending.is_file());
    assert!(host.control(&json!({"action":"retry_cleanup"})).is_err());
    assert!(host.cleanup_failed);
    fs::remove_dir(&journal).unwrap();
    fs::rename(&backup, &journal).unwrap();
    host.control(&json!({"action":"retry_cleanup"})).unwrap();
    assert!(!host.cleanup_failed);
    assert!(!pending.exists());
    assert_eq!(fs::read(&journal).unwrap(), b"[]");
    host.leases.deliver("ssh-001", 2, b"E0 new lease").unwrap();
    host.leases.clear().unwrap();
    assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
}

#[test]
fn pending_journal_recovery_refuses_symlinks_non_private_files_and_directories() {
    let (_directory, mut host) = fixture();
    let pending = host.root.join("leases/ledger.new");
    let unrelated = host.root.join("user-export.txt");
    fs::write(&unrelated, b"keep").unwrap();
    std::os::unix::fs::symlink(&unrelated, &pending).unwrap();
    assert!(host.leases.clear().is_err());
    assert!(fs::symlink_metadata(&pending)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
    fs::remove_file(&pending).unwrap();
    fs::write(&pending, b"unowned transaction").unwrap();
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(host.leases.clear().is_err());
    assert_eq!(fs::read(&pending).unwrap(), b"unowned transaction");
    fs::remove_file(&pending).unwrap();
    fs::create_dir(&pending).unwrap();
    assert!(host.leases.clear().is_err());
    assert!(pending.is_dir());
    fs::remove_dir(&pending).unwrap();
    host.leases.clear().unwrap();
    assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
}

#[test]
fn boundaries_reject_unknown_arguments_and_wrong_types_without_secret_fallback() {
    let (_directory, mut host) = fixture();
    for arguments in [
        json!({"limit":0}),
        json!({"limit":101}),
        json!({"limit":"50"}),
        json!({"query":true}),
        json!({"query":"x".repeat(513)}),
        json!({"password":"no"}),
    ] {
        assert!(host
            .request(&request("srt_credentials_search", arguments))
            .is_err());
    }
    for fields in [
        json!([]),
        json!(["missing"]),
        json!([true]),
        json!(vec!["password"; 9]),
    ] {
        assert!(host
            .request(&request(
                "srt_credentials_read_fields",
                json!({
            "vaultId":"e0-unit-vault","recordId":"website-001","fields":fields})
            ))
            .is_err());
    }
    assert!(host.request(&request("execute_shell", json!({}))).is_err());
    assert!(!host.cleanup_failed);
}

#[test]
fn private_root_rejects_unmarked_data_and_wrong_vault_without_changing_it() {
    let directory = private_test_directory();
    let root = fs::canonicalize(directory.path()).unwrap();
    fs::write(root.join("existing.db"), b"unrelated").unwrap();
    assert_eq!(
        prepare_root(&root, "e0-unit-vault").unwrap_err(),
        "e0_root_not_empty"
    );
    assert_eq!(fs::read(root.join("existing.db")).unwrap(), b"unrelated");
    let (_directory, host) = fixture();
    assert_eq!(
        credential_ipc::verify_root(&host.root, "different-vault").unwrap_err(),
        "invalid_e0_root"
    );
}

#[test]
fn password_validation_rejects_trimmed_input_and_enforces_failure_cooldown() {
    let (_directory, mut host) = fixture();
    host.control(&json!({"action":"lock"})).unwrap();
    for _ in 0..5 {
        assert!(host
            .control(&json!({"action":"unlock","password":"e0 test password 密码"}))
            .is_err());
    }
    assert_eq!(
        host.control(&json!({"action":"unlock","password":"e0 test password 密码  "}))
            .unwrap_err(),
        "password_retry_later"
    );
    assert!(host.store.is_none());
}

#[test]
fn password_scalar_and_utf8_boundaries_survive_actual_encrypted_reopen_without_trimming() {
    let maximum = format!("  {}  ", "密".repeat(340));
    assert_eq!(maximum.len(), 1024);
    for (password, rejected) in [
        ("密".repeat(12), "密".repeat(11)),
        (maximum.clone(), format!("{maximum}x")),
    ] {
        let directory = private_test_directory();
        let root = fs::canonicalize(directory.path()).unwrap();
        let mut host = Host::open(&root, "e0-password-boundary").unwrap();
        assert_eq!(
            host.control(&json!({"action":"create","password":rejected}))
                .unwrap_err(),
            "password_length_invalid"
        );
        assert!(!root.join("vault.db").exists());
        host.control(&json!({"action":"create","password":password}))
            .unwrap();
        host.control(&json!({"action":"lock"})).unwrap();
        if password.starts_with(' ') {
            assert!(host
                .control(&json!({"action":"unlock","password":password.trim()}))
                .is_err());
            assert!(host.store.is_none());
        }
        host.control(&json!({"action":"unlock","password":password}))
            .unwrap();
        let result = host
            .store
            .as_ref()
            .unwrap()
            .search(&json!({"query":"website"}))
            .unwrap();
        assert_eq!(result["records"][0]["recordId"], "website-001");
    }
}

#[test]
fn attachment_sixteen_mib_roundtrips_and_one_extra_byte_preserves_the_previous_asset() {
    let (_directory, mut host) = fixture();
    let bytes = vec![0xa5_u8; 16 * 1024 * 1024 + 1];
    let accepted = &bytes[..16 * 1024 * 1024];
    host.control(&json!({"action":"fixture_file","bytesBase64":
        base64::engine::general_purpose::STANDARD.encode(accepted)}))
        .unwrap();
    host.control(&json!({"action":"lock"})).unwrap();
    host.control(&json!({"action":"unlock","password":"e0 test password 密码  "}))
        .unwrap();
    let (version, restored) = host.store.as_ref().unwrap().asset("ssh-001").unwrap();
    assert_eq!(version, 1);
    assert_eq!(restored, accepted);
    drop(restored);
    assert_eq!(
        host.control(&json!({"action":"fixture_file","bytesBase64":
            base64::engine::general_purpose::STANDARD.encode(&bytes)}))
            .unwrap_err(),
        "file_limit_exceeded"
    );
    host.control(&json!({"action":"lock"})).unwrap();
    host.control(&json!({"action":"unlock","password":"e0 test password 密码  "}))
        .unwrap();
    let (version, restored) = host.store.as_ref().unwrap().asset("ssh-001").unwrap();
    assert_eq!(version, 1);
    assert_eq!(restored, accepted);
}

#[test]
fn secret_read_accepts_one_mib_and_rejects_one_extra_byte_from_real_encrypted_rows() {
    let (_directory, mut host) = fixture();
    host.control(&json!({"action":"lock"})).unwrap();
    // The E0 UI has no field writer. Seed only this test-owned encrypted fixture
    // through SQL, then exercise the unchanged production reader after reopening.
    let connection = rusqlite::Connection::open_with_flags(
        host.root.join("vault.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap();
    connection
        .pragma_update(None, "key", "e0 test password 密码  ")
        .unwrap();
    for (record, size) in [("website-001", 1024 * 1024), ("email-001", 1024 * 1024 + 1)] {
        assert_eq!(
            connection
                .execute(
                    "UPDATE records SET secrets=?1 WHERE id=?2",
                    rusqlite::params![json!({"password":"x".repeat(size)}).to_string(), record],
                )
                .unwrap(),
            1
        );
    }
    drop(connection);
    host.control(&json!({"action":"unlock","password":"e0 test password 密码  "}))
        .unwrap();
    let result = host
        .request(&request(
            "srt_credentials_read_fields",
            json!({
                "vaultId":"e0-unit-vault","recordId":"website-001","fields":["password"]
            }),
        ))
        .unwrap();
    assert_eq!(
        result["fields"]["password"].as_str().unwrap(),
        "x".repeat(1024 * 1024)
    );
    assert_eq!(
        host.request(&request(
            "srt_credentials_read_fields",
            json!({
                "vaultId":"e0-unit-vault","recordId":"email-001","fields":["password"]
            })
        ))
        .unwrap_err(),
        "secret_limit_exceeded"
    );
}

#[test]
fn stdio_line_framing_does_not_drop_read_ahead_and_rejects_oversize() {
    let mut reader = Cursor::new(b"{\"id\":1}\n{\"id\":2}\n");
    assert_eq!(
        credential_ipc::read_line(&mut reader).unwrap().unwrap()["id"],
        1
    );
    assert_eq!(
        credential_ipc::read_line(&mut reader).unwrap().unwrap()["id"],
        2
    );
    assert!(credential_ipc::read_line(&mut reader).unwrap().is_none());
    let mut oversized = Cursor::new(vec![b' '; credential_ipc::FRAME_LIMIT + 1]);
    assert_eq!(
        credential_ipc::read_line(&mut oversized).unwrap_err(),
        "frame_limit_exceeded"
    );
    let mut oversized_request = Cursor::new(vec![b' '; credential_ipc::REQUEST_LIMIT + 1]);
    assert_eq!(
        credential_ipc::read_request(&mut oversized_request).unwrap_err(),
        "frame_limit_exceeded"
    );
}
