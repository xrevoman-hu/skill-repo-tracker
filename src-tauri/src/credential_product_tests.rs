use super::*;
use std::os::unix::fs::PermissionsExt;

const PASSWORD: &str = "synthetic-product-master-only";

fn setup() -> (tempfile::TempDir, ProductHost) {
    crate::credential_auth::memory_tests::install();
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let canonical = root.path().canonicalize().unwrap();
    let id = prepare_root(&canonical, false).unwrap();
    let host = ProductHost::open(&canonical, &id).unwrap();
    (root, host)
}

fn create(host: &mut ProductHost) {
    host.control(&json!({"action":"create","password":PASSWORD,"confirmPassword":PASSWORD}))
        .unwrap();
}

fn save(host: &mut ProductHost) -> Value {
    host.control(&json!({"action":"save","type":"website","name":"Synthetic site","metadata":{"url":"https://example.test","username":"demo"},
        "note":"","secrets":{"password":" exact synthetic value \n"}})).unwrap()
}

fn verify(record: &Value, session: &str) -> Value {
    json!({"action":"verify","recordId":record["recordId"],"expectedVersion":record["version"],"password":PASSWORD,"sessionId":session})
}

fn read(record: &Value, session: &str) -> Value {
    json!({"action":"read_fields","recordId":record["recordId"],"expectedVersion":record["version"],"sessionId":session,"fields":["password"]})
}

#[test]
fn product_create_is_empty_locked_restart_retains_identity_without_unlock_ability() {
    let (_root, mut host) = setup();
    assert_eq!(host.status()["exists"], false);
    assert_eq!(host.status()["locked"], true);
    create(&mut host);
    assert_eq!(host.status()["sharing"], false);
    assert_eq!(
        host.control(&json!({"action":"list"})).unwrap()["records"],
        json!([])
    );
    let record = save(&mut host);
    let root = host.root.clone();
    let id = host.vault_id.clone();
    host.control(&json!({"action":"lock"})).unwrap();
    drop(host);
    let mut reopened = ProductHost::open(&root, &id).unwrap();
    assert_eq!(reopened.status()["locked"], true);
    assert_eq!(
        reopened
            .control(&json!({"action":"detail","recordId":record["recordId"]}))
            .unwrap_err(),
        "vault_locked"
    );
    reopened
        .control(&json!({"action":"unlock","password":PASSWORD}))
        .unwrap();
    assert_eq!(
        reopened
            .control(&json!({"action":"detail","recordId":record["recordId"]}))
            .unwrap()["name"],
        record["name"]
    );
}

#[test]
fn human_session_is_required_and_invalidated_before_or_after_verification() {
    let (_root, mut host) = setup();
    create(&mut host);
    let record = save(&mut host);
    assert_eq!(
        host.control(&read(&record, "synthetic-session-a"))
            .unwrap_err(),
        "human_verification_required"
    );
    host.control(&json!({"action":"invalidate_session","sessionId":"synthetic-session-a"}))
        .unwrap();
    assert_eq!(
        host.control(&verify(&record, "synthetic-session-a"))
            .unwrap_err(),
        "human_session_invalid"
    );
    host.control(&verify(&record, "synthetic-session-b"))
        .unwrap();
    assert_eq!(
        host.control(&read(&record, "synthetic-session-b")).unwrap()["fields"]["password"],
        " exact synthetic value \n"
    );
    let mut wrong = verify(&record, "synthetic-session-c");
    wrong["password"] = json!("wrong-synthetic-password");
    assert_eq!(
        host.control(&wrong).unwrap_err(),
        "password_or_vault_invalid"
    );
    assert_eq!(
        host.control(&read(&record, "synthetic-session-b"))
            .unwrap_err(),
        "human_verification_required"
    );
    host.control(&verify(&record, "synthetic-session-b"))
        .unwrap();
    host.control(&json!({"action":"invalidate_session","sessionId":"synthetic-session-b"}))
        .unwrap();
    assert_eq!(
        host.control(&read(&record, "synthetic-session-b"))
            .unwrap_err(),
        "human_verification_required"
    );
}

#[test]
fn session_cannot_read_other_record_or_survive_revision_change_and_lock() {
    let (_root, mut host) = setup();
    create(&mut host);
    let record = save(&mut host);
    let other = save(&mut host);
    host.control(&verify(&record, "synthetic-session")).unwrap();
    assert_eq!(
        host.control(&read(&other, "synthetic-session"))
            .unwrap_err(),
        "human_verification_required"
    );
    host.control(&json!({"action":"save","recordId":record["recordId"],"expectedVersion":1,"type":"website","name":"Renamed", "metadata":{"url":"https://example.test","username":"demo"},"note":"","secrets":{}})).unwrap();
    assert_eq!(
        host.control(&read(&record, "synthetic-session"))
            .unwrap_err(),
        "record_version_conflict"
    );
    host.control(&json!({"action":"lock"})).unwrap();
    assert_eq!(
        host.control(&read(&other, "synthetic-session"))
            .unwrap_err(),
        "vault_locked"
    );
}

#[test]
fn mcp_remains_read_only_and_only_returns_explicit_fields_after_grant() {
    let (_root, mut host) = setup();
    create(&mut host);
    let record = save(&mut host);
    let mut request = json!({"auth":"a".repeat(64),"name":"srt_credentials_read_fields", "arguments":{"vaultId":host.vault_id,"recordId":record["recordId"],"fields":["password"]}});
    assert_eq!(host.request(&request).unwrap_err(), "sharing_disabled");
    host.sharing = true;
    host.code = Some("a".repeat(64));
    let result = host.request(&request).unwrap();
    assert_eq!(result["fields"].as_object().unwrap().len(), 1);
    request["arguments"]["fields"] = json!(["token"]);
    assert_eq!(host.request(&request).unwrap_err(), "invalid_secret_field");
    request["name"] = json!("save");
    assert_eq!(host.request(&request).unwrap_err(), "unknown_tool");
    host.control(&json!({"action":"lock"})).unwrap();
    assert_eq!(host.request(&request).unwrap_err(), "vault_locked");
}

#[test]
fn product_marker_rejects_fixture_roots_and_namespace_identity_is_stable() {
    let (root, host) = setup();
    assert_eq!(
        prepare_root(&root.path().canonicalize().unwrap(), false).unwrap(),
        host.vault_id
    );
    let fixture = tempfile::tempdir().unwrap();
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(fixture.path().join("e0-vault.json"), b"{}").unwrap();
    assert_eq!(
        prepare_root(&fixture.path().canonicalize().unwrap(), false).unwrap_err(),
        "vault_root_not_empty"
    );
}

#[test]
fn escaped_large_text_is_complete_and_does_not_lock_the_host() {
    let (_root, mut host) = setup();
    create(&mut host);
    let text = "\0".repeat(16 * 1024 * 1024);
    let response = bounded_response(Ok(json!({"fields":{"value":text}})));
    assert_eq!(response["ok"], true);
    assert_eq!(
        response["result"]["fields"]["value"]
            .as_str()
            .unwrap()
            .len(),
        16 * 1024 * 1024
    );
    assert_eq!(
        host.control(&json!({"action":"status"})).unwrap()["locked"],
        false
    );
    assert_eq!(
        bounded_response(Ok(json!({"fields":{"value":" complete\n "}})))["result"]["fields"]
            ["value"],
        " complete\n "
    );
}

#[test]
fn explicit_file_export_and_tls_leases_are_bound_to_the_selected_field() {
    let (_root, mut host) = setup();
    create(&mut host);
    let certificate = b"synthetic certificate\r\n";
    let private_key = vec![0, 255, 42, 0];
    let record = host.control(&json!({"action":"save","type":"tls","name":"Synthetic pair",
        "metadata":{},"note":"","secrets":{},"files":[
            {"field":"certificate","name":"cert.pem","bytesBase64":base64::engine::general_purpose::STANDARD.encode(certificate)},
            {"field":"privateKey","name":"key.bin","bytesBase64":base64::engine::general_purpose::STANDARD.encode(&private_key)}]})).unwrap();
    let export = json!({"action":"export_file","recordId":record["recordId"],"expectedVersion":1,"sessionId":"file-export-session","field":"privateKey"});
    assert_eq!(
        host.control(&export).unwrap_err(),
        "human_verification_required"
    );
    host.control(&verify(&record, "file-export-session"))
        .unwrap();
    let result = host.control(&export).unwrap();
    assert_eq!(result["name"], "key.bin");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(result["bytesBase64"].as_str().unwrap())
            .unwrap(),
        private_key
    );
    host.sharing = true;
    host.code = Some("a".repeat(64));
    let mut request = json!({"auth":"a".repeat(64),"name":"srt_credentials_lease_file","arguments":{"vaultId":host.vault_id,"recordId":record["recordId"]}});
    assert_eq!(
        host.request(&request).unwrap_err(),
        "file_selection_required"
    );
    request["arguments"]["field"] = json!("certificate");
    let lease = host.request(&request).unwrap();
    assert_eq!(lease["field"], "certificate");
    assert_eq!(
        fs::read(lease["path"].as_str().unwrap()).unwrap(),
        certificate
    );
    request["arguments"]["field"] = json!("absent");
    assert_eq!(host.request(&request).unwrap_err(), "file_not_found");
    let listed = host
        .request(&json!({"auth":"a".repeat(64),"name":"srt_credentials_search","arguments":{}}))
        .unwrap();
    assert_eq!(listed["records"][0]["files"].as_array().unwrap().len(), 2);
    assert!(!listed.to_string().contains("bytesBase64"));
    assert!(!listed.to_string().contains("synthetic certificate"));
    host.control(&json!({"action":"lock"})).unwrap();
    assert!(!Path::new(lease["path"].as_str().unwrap()).exists());
    assert_eq!(host.control(&export).unwrap_err(), "vault_locked");
}

#[test]
fn restore_controls_lock_before_validation_and_keep_existing_data_on_cancel() {
    let (_root, mut host) = setup();
    let external = tempfile::tempdir().unwrap();
    let backup = external
        .path()
        .canonicalize()
        .unwrap()
        .join("portable.srtvault");
    create(&mut host);
    let record = save(&mut host);
    host.control(&json!({"action":"backup_create","password":PASSWORD,"path":backup}))
        .unwrap();
    let request =
        json!({"action":"restore_preview","path":backup,"password":"wrong-synthetic-password"});
    assert!(host.control(&request).is_err());
    assert_eq!(host.status()["locked"], true);
    host.control(&json!({"action":"unlock","password":PASSWORD}))
        .unwrap();
    assert!(host
        .control(&json!({"action":"detail","recordId":record["recordId"]}))
        .is_ok());
    let summary = host
        .control(&json!({"action":"restore_preview","path":backup,"password":PASSWORD}))
        .unwrap();
    assert_eq!(summary["sameVault"], true);
    assert_eq!(host.status()["locked"], true);
    host.control(&json!({"action":"restore_cancel"})).unwrap();
    assert_eq!(
        host.control(&json!({"action":"restore_commit","restoreId":summary["restoreId"]}))
            .unwrap_err(),
        "restore_preview_required"
    );
    host.control(&json!({"action":"unlock","password":PASSWORD}))
        .unwrap();
    assert!(host
        .control(&json!({"action":"detail","recordId":record["recordId"]}))
        .is_ok());
}

#[test]
fn lock_and_unlock_invalidate_uncommitted_restore_tickets() {
    let (_root, mut host) = setup();
    let external = tempfile::tempdir().unwrap();
    let backup = external
        .path()
        .canonicalize()
        .unwrap()
        .join("portable.srtvault");
    create(&mut host);
    save(&mut host);
    host.control(&json!({"action":"backup_create","password":PASSWORD,"path":backup}))
        .unwrap();
    for action in ["lock", "unlock"] {
        let summary = host
            .control(&json!({"action":"restore_preview","path":backup,"password":PASSWORD}))
            .unwrap();
        host.control(&json!({"action":action,"password":PASSWORD}))
            .unwrap();
        assert_eq!(
            host.control(&json!({"action":"restore_commit","restoreId":summary["restoreId"]}))
                .unwrap_err(),
            "restore_preview_required"
        );
        assert!(!host.root.join("restore.pending.db").exists());
    }
}

#[test]
fn successful_password_change_locks_human_sessions_and_preserves_shared_code() {
    let (_root, mut host) = setup();
    create(&mut host);
    let record = save(&mut host);
    host.control(&verify(&record, "password-change-session"))
        .unwrap();
    host.sharing = true;
    host.code = Some("a".repeat(64));
    host.persist_sharing().unwrap();
    let changed = "new-synthetic-master-password";
    let status = host.control(&json!({"action":"change_password","oldPassword":PASSWORD,"newPassword":changed,"confirmPassword":changed})).unwrap();
    assert_eq!(status["locked"], true);
    assert_eq!(status["sharing"], true);
    assert_eq!(host.code, Some("a".repeat(64)));
    assert!(host
        .control(&json!({"action":"unlock","password":PASSWORD}))
        .is_err());
    host.control(&json!({"action":"unlock","password":changed}))
        .unwrap();
    assert_eq!(
        host.control(&read(&record, "password-change-session"))
            .unwrap_err(),
        "human_verification_required"
    );
}

#[test]
fn reopened_product_clears_only_registered_leases_while_remaining_locked() {
    let (_directory, mut host) = setup();
    create(&mut host);
    let record = save(&mut host);
    let lease = host
        .leases
        .deliver(record["recordId"].as_str().unwrap(), 1, b"synthetic key")
        .unwrap();
    let unrelated = host.root.join("leases/user-export");
    fs::write(&unrelated, b"user managed copy").unwrap();
    let root = host.root.clone();
    let id = host.vault_id.clone();
    let database = fs::read(root.join("vault.db")).unwrap();
    drop(host);
    let reopened = ProductHost::open(&root, &id).unwrap();
    assert_eq!(reopened.status()["locked"], true);
    assert_eq!(reopened.status()["cleanupFailed"], false);
    assert_eq!(reopened.status()["cleanupRemaining"], 0);
    assert!(!Path::new(lease["path"].as_str().unwrap()).exists());
    assert_eq!(fs::read(unrelated).unwrap(), b"user managed copy");
    assert_eq!(fs::read(root.join("vault.db")).unwrap(), database);
}

#[test]
fn valid_lease_journal_cleanup_failure_remains_visible_until_retry() {
    let (_directory, mut host) = setup();
    create(&mut host);
    let record = save(&mut host);
    let lease = host
        .leases
        .deliver(record["recordId"].as_str().unwrap(), 1, b"synthetic key")
        .unwrap();
    let path = PathBuf::from(lease["path"].as_str().unwrap());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let root = host.root.clone();
    let id = host.vault_id.clone();
    let journal = fs::read(root.join("leases/ledger.json")).unwrap();
    drop(host);
    // E0 retains its strict startup failure; only the formal product gets a retryable host.
    assert!(Leases::open(&root).is_err());
    let mut reopened = ProductHost::open(&root, &id).unwrap();
    assert_eq!(reopened.status()["locked"], true);
    assert_eq!(reopened.status()["cleanupFailed"], true);
    assert_eq!(reopened.status()["cleanupRemaining"], 1);
    assert_eq!(fs::read(root.join("leases/ledger.json")).unwrap(), journal);
    assert_eq!(
        reopened
            .control(&json!({"action":"unlock","password":PASSWORD}))
            .unwrap_err(),
        "cleanup_failed"
    );
    assert_eq!(
        reopened
            .control(&json!({"action":"create","password":PASSWORD,"confirmPassword":PASSWORD}))
            .unwrap_err(),
        "cleanup_failed"
    );
    reopened.sharing = true;
    reopened.code = Some("a".repeat(64));
    assert_eq!(reopened.request(&json!({"auth":"a".repeat(64),"name":"srt_credentials_read_fields","arguments":{"recordId":record["recordId"],"fields":["password"]}})).unwrap_err(), "cleanup_failed");
    assert!(reopened
        .control(&json!({"action":"retry_cleanup"}))
        .is_err());
    assert!(reopened.cleanup_failed);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let status = reopened
        .control(&json!({"action":"retry_cleanup"}))
        .unwrap();
    assert_eq!(status["locked"], true);
    assert_eq!(status["cleanupFailed"], false);
    assert_eq!(status["cleanupRemaining"], 0);
    assert!(!path.exists());
    reopened
        .control(&json!({"action":"unlock","password":PASSWORD}))
        .unwrap();
    assert_eq!(
        reopened
            .control(&json!({"action":"detail","recordId":record["recordId"]}))
            .unwrap()["name"],
        record["name"]
    );
}

#[test]
fn malformed_or_replaced_startup_journals_are_not_recreated() {
    use std::os::unix::fs::symlink;
    let (_directory, host) = setup();
    let journal = host.root.join("leases/ledger.json");
    fs::write(&journal, b"invalid synthetic ledger").unwrap();
    assert!(ProductHost::open(&host.root, &host.vault_id).is_err());
    assert_eq!(fs::read(&journal).unwrap(), b"invalid synthetic ledger");
    fs::remove_file(&journal).unwrap();
    let absent = host.root.join("not-a-ledger");
    symlink(&absent, &journal).unwrap();
    assert!(ProductHost::open(&host.root, &host.vault_id).is_err());
    assert!(fs::symlink_metadata(&journal)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!absent.exists());
}

#[test]
fn shared_authorization_survives_reopen_but_reset_invalidates_every_old_reader() {
    let (_directory, mut host) = setup();
    assert_eq!(
        host.control(&json!({"action":"share","enabled":true}))
            .unwrap_err(),
        "vault_locked"
    );
    create(&mut host);
    let record = save(&mut host);
    host.control(&json!({"action":"share","enabled":true}))
        .unwrap();
    let old_code = host.code.clone().unwrap();
    let request = json!({"auth":old_code,"name":"srt_credentials_read_fields","arguments":{"vaultId":host.vault_id,"recordId":record["recordId"],"fields":["password"]}});
    assert!(host.request(&request).is_ok());
    host.control(&json!({"action":"share","enabled":false}))
        .unwrap();
    assert_eq!(host.request(&request).unwrap_err(), "sharing_disabled");
    assert_eq!(fs::read(host.root.join("sharing.json")).unwrap(), b"false");
    host.control(&json!({"action":"share","enabled":true}))
        .unwrap();
    assert_eq!(host.code.as_deref(), Some(old_code.as_str()));
    host.control(&json!({"action":"reset_access"})).unwrap();
    assert_ne!(host.code.as_deref(), Some(old_code.as_str()));
    assert_eq!(
        host.request(&request).unwrap_err(),
        "authorization_rejected"
    );
    let new_code = host.code.clone().unwrap();
    let root = host.root.clone();
    let id = host.vault_id.clone();
    drop(host);
    let mut reopened = ProductHost::open(&root, &id).unwrap();
    assert_eq!(reopened.status()["locked"], true);
    assert_eq!(reopened.code.as_deref(), Some(new_code.as_str()));
    assert_eq!(
        reopened.request(&request).unwrap_err(),
        "authorization_rejected"
    );
    let mut fresh = request.clone();
    fresh["auth"] = json!(new_code);
    assert_eq!(reopened.request(&fresh).unwrap_err(), "vault_locked");
    reopened
        .control(&json!({"action":"unlock","password":PASSWORD}))
        .unwrap();
    reopened
        .control(&json!({"action":"authorize_access"}))
        .unwrap();
    assert_eq!(
        reopened.request(&fresh).unwrap()["fields"]["password"],
        " exact synthetic value \n"
    );
}

#[test]
fn bad_requests_password_backoff_and_invalid_sessions_cannot_change_or_reveal_records() {
    let (_directory, mut host) = setup();
    for (request, expected) in [
        (json!({}), "action_required"),
        (json!({"action":"unknown"}), "unknown_control_action"),
        (json!({"action":"create"}), "password_required"),
        (
            json!({"action":"create","password":PASSWORD}),
            "password_confirmation_mismatch",
        ),
        (json!({"action":"share"}), "enabled_required"),
    ] {
        assert_eq!(host.control(&request).unwrap_err(), expected);
    }
    create(&mut host);
    let record = save(&mut host);
    for (request, expected) in [
        (
            json!({"action":"unlock","password":PASSWORD}),
            "vault_already_unlocked",
        ),
        (json!({"action":"detail"}), "record_id_required"),
        (
            json!({"action":"invalidate_session"}),
            "session_id_required",
        ),
        (
            json!({"action":"invalidate_session","sessionId":"bad/id"}),
            "human_session_invalid",
        ),
        (json!({"action":"backup_create"}), "password_required"),
        (
            json!({"action":"change_password","oldPassword":PASSWORD,"newPassword":PASSWORD}),
            "password_confirmation_mismatch",
        ),
    ] {
        assert_eq!(host.control(&request).unwrap_err(), expected);
    }
    let mut check = verify(&record, "test-session");
    check.as_object_mut().unwrap().remove("sessionId");
    assert_eq!(host.control(&check).unwrap_err(), "session_id_required");
    check["sessionId"] = json!("bad/session");
    assert_eq!(host.control(&check).unwrap_err(), "human_session_invalid");
    check["sessionId"] = json!("test-session");
    check.as_object_mut().unwrap().remove("password");
    assert_eq!(host.control(&check).unwrap_err(), "password_required");
    check["password"] = json!("wrong synthetic password");
    for _ in 0..5 {
        assert_eq!(
            host.control(&check).unwrap_err(),
            "password_or_vault_invalid"
        );
    }
    check["password"] = json!(PASSWORD);
    assert_eq!(host.control(&check).unwrap_err(), "password_retry_later");
    host.retry_after = Some(Instant::now() - Duration::from_secs(1));
    host.control(&check).unwrap();
    assert_eq!(host.password_failures, 0);
    let mut missing_session = read(&record, "test-session");
    missing_session.as_object_mut().unwrap().remove("sessionId");
    assert_eq!(
        host.control(&missing_session).unwrap_err(),
        "human_verification_required"
    );
    host.control(&json!({"action":"delete","recordId":record["recordId"],"expectedVersion":1}))
        .unwrap();
    assert_eq!(
        host.control(&json!({"action":"list"})).unwrap()["records"],
        json!([])
    );
    assert!(host.human.is_none());
}

#[test]
fn file_inspection_uses_verified_original_bytes_and_releases_its_private_files() {
    let (_directory, mut host) = setup();
    create(&mut host);
    let website = save(&mut host);
    host.control(&verify(&website, "website-session")).unwrap();
    let mut inspect = read(&website, "website-session");
    inspect["action"] = json!("inspect_files");
    assert_eq!(
        host.control(&inspect).unwrap_err(),
        "file_inspection_unsupported"
    );
    let bytes = b"unrecognized synthetic file";
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let record = host.control(&json!({"action":"save","type":"ssh","name":"Synthetic SSH","metadata":{"host":"example.test","username":"synthetic"},"note":"","secrets":{"passphrase":"synthetic only"},"files":[{"field":"privateKey","name":"synthetic.key","bytesBase64":encoded}]})).unwrap();
    host.control(&verify(&record, "ssh-session")).unwrap();
    inspect = read(&record, "ssh-session");
    inspect["action"] = json!("inspect_files");
    let result = host.control(&inspect).unwrap();
    assert_eq!(result["keyParsed"], Value::Null);
    assert!(result["limitations"]
        .as_array()
        .unwrap()
        .contains(&json!("key_format_unsupported")));
    assert_eq!(host.leases.pending_count(), 0);
    assert!(!host.cleanup_failed);
    let mut exporter = inspect.clone();
    exporter["action"] = json!("export_file");
    assert_eq!(host.control(&exporter).unwrap_err(), "field_required");
    exporter["field"] = json!("privateKey");
    assert_eq!(host.control(&exporter).unwrap()["bytesBase64"], encoded);
    exporter["field"] = json!("absent");
    assert_eq!(host.control(&exporter).unwrap_err(), "file_not_found");
    assert!(host.control(&read(&record, "ssh-session")).is_err());
}

#[test]
fn search_is_metadata_only_and_rejects_wrong_vault_or_invalid_bounds() {
    let (_directory, mut host) = setup();
    create(&mut host);
    let record = save(&mut host);
    host.control(&json!({"action":"share","enabled":true}))
        .unwrap();
    let mut request = json!({"auth":host.code,"name":"srt_credentials_search","arguments":{"query":"Synthetic","limit":1}});
    let found = host.request(&request).unwrap();
    assert_eq!(found["records"][0]["recordId"], record["recordId"]);
    assert!(!found.to_string().contains("exact synthetic value"));
    let wrong_vault = json!({"auth":host.code,"name":"srt_credentials_read_fields","arguments":{"vaultId":"other-vault","recordId":record["recordId"],"fields":["password"]}});
    assert_eq!(host.request(&wrong_vault).unwrap_err(), "vault_id_mismatch");
    for limit in [0, 101] {
        request["arguments"]["limit"] = json!(limit);
        assert_eq!(host.request(&request).unwrap_err(), "invalid_search_bounds");
    }
    request["arguments"]["limit"] = json!(100);
    request.as_object_mut().unwrap().remove("auth");
    assert_eq!(
        host.request(&request).unwrap_err(),
        "authorization_rejected"
    );
    request["auth"] = json!(host.code);
    request.as_object_mut().unwrap().remove("arguments");
    assert_eq!(host.request(&request).unwrap_err(), "invalid_arguments");
    request.as_object_mut().unwrap().remove("name");
    assert_eq!(host.request(&request).unwrap_err(), "unknown_tool");
    host.authorization_error = Some("credential_authorization_required");
    assert_eq!(
        host.request(&request).unwrap_err(),
        "credential_authorization_required"
    );
}

#[test]
fn lease_capacity_rejection_keeps_reading_and_releasing_existing_files_available() {
    let (_directory, mut host) = setup();
    create(&mut host);
    let record = host.control(&json!({"action":"save","type":"generic","name":"capacity fixture","metadata":{},"note":"","secrets":{},"files":[{"field":"attachment","name":"one.bin","bytesBase64":"YQ=="}]})).unwrap();
    host.control(&json!({"action":"share","enabled":true}))
        .unwrap();
    let request = json!({"auth":host.code,"name":"srt_credentials_lease_file","arguments":{"vaultId":host.vault_id,"recordId":record["recordId"],"field":"attachment"}});
    let mut leases = Vec::new();
    for _ in 0..64 {
        leases.push(host.request(&request).unwrap());
    }
    assert_eq!(host.request(&request).unwrap_err(), "too_many_file_leases");
    assert!(!host.cleanup_failed);
    assert_eq!(host.leases.pending_count(), 64);
    let found = host
        .request(&json!({"auth":host.code,"name":"srt_credentials_search","arguments":{}}))
        .unwrap();
    assert_eq!(found["records"][0]["recordId"], record["recordId"]);
    for lease in leases {
        let path = PathBuf::from(lease["path"].as_str().unwrap());
        host.request(&json!({"auth":host.code,"name":"srt_credentials_release_file","arguments":{"leaseId":lease["leaseId"]}})).unwrap();
        assert!(!path.exists());
    }
    assert_eq!(host.leases.pending_count(), 0);
    assert!(host.request(&request).is_ok());
    host.control(&json!({"action":"lock"})).unwrap();
    assert_eq!(host.leases.pending_count(), 0);
}
