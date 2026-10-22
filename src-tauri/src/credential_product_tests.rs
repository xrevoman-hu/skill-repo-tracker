use super::*;
use std::os::unix::fs::PermissionsExt;

const PASSWORD: &str = "synthetic-product-master-only";

fn setup() -> (tempfile::TempDir, ProductHost) {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let canonical = root.path().canonicalize().unwrap();
    let id = prepare_root(&canonical).unwrap();
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
        prepare_root(&root.path().canonicalize().unwrap()).unwrap(),
        host.vault_id
    );
    let fixture = tempfile::tempdir().unwrap();
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(fixture.path().join("e0-vault.json"), b"{}").unwrap();
    assert_eq!(
        prepare_root(&fixture.path().canonicalize().unwrap()).unwrap_err(),
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
