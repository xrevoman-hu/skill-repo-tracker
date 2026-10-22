use super::*;
use std::os::unix::fs::PermissionsExt;

const PASSWORD: &str = "synthetic-product-master-only";

fn setup() -> (tempfile::TempDir, VaultStore) {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let store = VaultStore::create(
        &directory.path().canonicalize().unwrap().join("vault.db"),
        PASSWORD,
        "synthetic-product-vault",
    )
    .unwrap();
    (directory, store)
}

pub(super) fn website() -> Value {
    json!({"action":"save","type":"website","name":"Synthetic site","metadata":{"url":"https://example.test","username":"demo"},
        "note":"fixture note","secrets":{"password":"  ORIGINAL\r\n秘密  "}})
}

#[test]
fn product_vault_starts_empty_and_eight_types_preserve_requested_values() {
    let (directory, store) = setup();
    assert_eq!(store.list(&json!({})).unwrap()["records"], json!([]));
    let mut inputs = vec![website()];
    inputs.extend([
        json!({"type":"ssh","name":"Synthetic key","metadata":{},"note":"","secrets":{"passphrase":" phrase "},
            "files":[{"field":"privateKey","name":"demo.key","bytesBase64":"ICBrZXkNCiA="}]}),
        json!({"type":"tls","name":"Synthetic cert","metadata":{"domain":"example.test"},"note":"","secrets":{"certificate":" cert\n "}}),
        json!({"type":"database_instance","name":"Same name","metadata":{"engine":"MySQL","host":"db.example.test","port":"3306","username":"demo"},"note":"","secrets":{"password":"instance-value"}}),
        json!({"type":"database_user","name":"Same name","metadata":{"engine":"MySQL","host":"db.example.test","port":"3306","username":"demo","database":"demo_db"},"note":"","secrets":{"password":"user-value"}}),
        json!({"type":"email","name":"Synthetic email","metadata":{"email":"demo@example.test","username":"demo"},"note":"","secrets":{"password":"mail-value"}}),
        json!({"type":"api_token","name":"Synthetic API","metadata":{},"note":"","secrets":{"token":" token\n "}}),
        json!({"type":"generic","name":"Synthetic generic","metadata":{},"note":"","secrets":{"value":"\n generic \n"}}),
    ]);
    let mut ids = std::collections::HashSet::new();
    for input in inputs {
        let saved = store.save(&input).unwrap();
        assert!(ids.insert(saved["recordId"].as_str().unwrap().to_owned()));
        assert!(saved.get("secrets").is_none());
        assert_eq!(saved["version"], 1);
        for (field, expected) in input["secrets"].as_object().unwrap() {
            let read = store
                .read_fields(&json!({"recordId":saved["recordId"],"fields":[field]}))
                .unwrap();
            assert_eq!(&read["fields"][field], expected);
            assert_eq!(read["fields"].as_object().unwrap().len(), 1);
        }
    }
    assert_eq!(ids.len(), 8);
    assert_eq!(
        store.list(&json!({"type":"database_user"})).unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.list(&json!({"query":"ORIGINAL"})).unwrap()["records"],
        json!([])
    );
    drop(store);
    let raw = fs::read(directory.path().join("vault.db")).unwrap();
    assert!(!raw.starts_with(b"SQLite format 3"));
    assert!(!raw.windows(8).any(|bytes| bytes == b"ORIGINAL"));
    assert!(VaultStore::unlock(
        &directory.path().canonicalize().unwrap().join("vault.db"),
        "wrong-synthetic-password",
        "synthetic-product-vault"
    )
    .is_err());
    let reopened = VaultStore::unlock(
        &directory.path().canonicalize().unwrap().join("vault.db"),
        PASSWORD,
        "synthetic-product-vault",
    )
    .unwrap();
    assert_eq!(
        reopened.list(&json!({})).unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
}

#[test]
fn edit_preserves_omitted_secret_and_rejects_clear_required_or_stale_revision() {
    let (_directory, store) = setup();
    let saved = store.save(&website()).unwrap();
    let mut update = website();
    update["recordId"] = saved["recordId"].clone();
    update["expectedVersion"] = json!(1);
    update["name"] = json!("Renamed");
    update["secrets"] = json!({});
    let second = store.save(&update).unwrap();
    assert_eq!(second["recordId"], saved["recordId"]);
    assert_eq!(second["version"], 2);
    let read = store
        .read_fields(&json!({"recordId":saved["recordId"],"fields":["password"]}))
        .unwrap();
    assert_eq!(read["fields"]["password"], website()["secrets"]["password"]);
    assert_eq!(store.save(&update).unwrap_err(), "record_version_conflict");
    update["expectedVersion"] = json!(2);
    update["secrets"] = json!({"password":null});
    assert_eq!(
        store.save(&update).unwrap_err(),
        "record_required_secret_missing"
    );
    assert_eq!(
        store.version(saved["recordId"].as_str().unwrap()).unwrap(),
        2
    );
    update["secrets"] = json!({"password":" replacement \n"});
    let replaced = store.save(&update).unwrap();
    assert_eq!(replaced["version"], 3);
    assert!(store
        .delete(&json!({"recordId":saved["recordId"],"expectedVersion":2}))
        .is_err());
    store
        .delete(&json!({"recordId":saved["recordId"],"expectedVersion":3}))
        .unwrap();
    assert_eq!(
        store
            .detail(saved["recordId"].as_str().unwrap())
            .unwrap_err(),
        "record_not_found"
    );
    assert_ne!(
        store.save(&website()).unwrap()["recordId"],
        saved["recordId"]
    );
}

#[test]
fn original_binary_files_survive_source_loss_and_failed_replacement() {
    let (directory, store) = setup();
    let bytes = b"\x00\xff synthetic\r\n  original bytes";
    let mut input = json!({"type":"ssh","name":"Binary kept","metadata":{},"note":"","secrets":{"passphrase":" synthetic phrase "},
        "files":[{"field":"privateKey","name":"密钥 with spaces.key","bytesBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}]});
    let saved = store.save(&input).unwrap();
    assert_eq!(saved["files"][0]["textReadable"], false);
    let record = saved["recordId"].as_str().unwrap();
    assert_eq!(store.asset(record).unwrap().1, bytes);
    assert_eq!(
        store
            .read_fields(&json!({"recordId":record,"fields":["privateKey"]}))
            .unwrap_err(),
        "file_not_text"
    );
    input["recordId"] = json!(record);
    input["expectedVersion"] = json!(1);
    input["files"][0]["bytesBase64"] = json!("not-base64!!");
    assert_eq!(store.save(&input).unwrap_err(), "record_files_invalid");
    assert_eq!(store.asset(record).unwrap().1, bytes);
    input["files"] = json!([]);
    input["secrets"] = json!({"passphrase":null});
    let edited = store.save(&input).unwrap();
    assert_eq!(edited["secretFields"], json!(["privateKey"]));
    assert_eq!(store.asset(record).unwrap().1, bytes);
    assert_eq!(
        fs::metadata(directory.path().join("vault.db"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn validation_rejects_connection_secrets_ports_and_text_in_place_of_ssh_file() {
    let (_directory, store) = setup();
    let mut input = website();
    input["metadata"]["url"] = json!("https://user:secret@example.test");
    assert_eq!(store.save(&input).unwrap_err(), "record_url_invalid");
    let mut database = json!({"type":"database_user","name":"db","metadata":{"engine":"MySQL","host":"db.example.test","port":"65536","username":"demo","database":"db"},"note":"","secrets":{"password":"demo"}});
    assert_eq!(store.save(&database).unwrap_err(), "record_port_invalid");
    database["metadata"]["port"] = json!("3306");
    database["metadata"]["host"] = json!("user:secret@host");
    assert_eq!(store.save(&database).unwrap_err(), "record_host_invalid");
    assert_eq!(store.save(&json!({"type":"ssh","name":"key","metadata":{},"note":"","secrets":{"privateKey":"plain text"}})).unwrap_err(),"ssh_private_key_file_required");
    assert_eq!(store.list(&json!({})).unwrap()["records"], json!([]));
}

#[test]
fn failed_creation_removes_only_its_pending_file_and_cannot_overwrite_existing_vault() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().canonicalize().unwrap().join("vault.db");
    assert!(VaultStore::create(&path, "short", "synthetic-product-vault").is_err());
    assert!(!path.exists());
    assert!(!path.with_extension("pending").exists());
    let store = VaultStore::create(&path, PASSWORD, "synthetic-product-vault").unwrap();
    store.save(&website()).unwrap();
    drop(store);
    let before = fs::read(&path).unwrap();
    assert!(VaultStore::create(&path, "different-synthetic-password", "other-vault").is_err());
    assert_eq!(before, fs::read(&path).unwrap());
}

#[test]
fn generic_text_and_file_are_independent_and_clearing_one_preserves_the_other() {
    let (_directory, store) = setup();
    let mut input = json!({"type":"generic","name":"Text and file","metadata":{},"note":"", "secrets":{"value":" original text "},
        "files":[{"field":"attachment","name":"original.bin","bytesBase64":"//4="}]});
    let saved = store.save(&input).unwrap();
    let record = saved["recordId"].as_str().unwrap();
    assert_eq!(
        store
            .read_fields(&json!({"recordId":record,"fields":["value"]}))
            .unwrap()["fields"]["value"],
        " original text "
    );
    assert_eq!(store.asset(record).unwrap().1, vec![255, 254]);
    input["recordId"] = json!(record);
    input["expectedVersion"] = json!(1);
    input["files"] = json!([]);
    input["secrets"] = json!({"attachment":null});
    store.save(&input).unwrap();
    assert!(store.asset(record).is_err());
    assert_eq!(
        store
            .read_fields(&json!({"recordId":record,"fields":["value"]}))
            .unwrap()["fields"]["value"],
        " original text "
    );
}
