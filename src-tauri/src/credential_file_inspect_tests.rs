use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

fn synthetic_pem(kind: &str) -> String {
    // Public delimiter only, assembled at runtime. There is no private-key
    // payload in this fixture; cryptographic fixtures are generated in the test.
    format!("-----BEGIN {kind}-----\nsynthetic-invalid-body")
}

fn private_file(root: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = root.join(name);
    fs::write(&path, bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    path
}

fn synthetic_certificate(root: &Path, name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let key = root.join(format!("{name}-key.pem"));
    let certificate = root.join(format!("{name}-certificate.pem"));
    run(
        &[
            "req".into(),
            "-x509".into(),
            "-newkey".into(),
            "rsa:2048".into(),
            "-nodes".into(),
            "-keyout".into(),
            key.as_os_str().to_owned(),
            "-out".into(),
            certificate.as_os_str().to_owned(),
            "-subj".into(),
            format!("/CN={name}.invalid").into(),
            "-days".into(),
            "1".into(),
        ],
        None,
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap()
    .unwrap();
    for path in [&key, &certificate] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    (key, certificate)
}

#[test]
fn format_hints_are_markers_only_and_never_claim_file_validity() {
    for (kind, expected) in [
        ("OPENSSH PRIVATE KEY", "openssh_private_key"),
        ("ENCRYPTED PRIVATE KEY", "pem_encrypted_private_key"),
        ("RSA PRIVATE KEY", "pem_private_key"),
        ("PRIVATE KEY", "pem_private_key"),
        ("EC PRIVATE KEY", "pem_private_key"),
        ("DSA PRIVATE KEY", "pem_private_key"),
        ("CERTIFICATE", "pem_certificate"),
        ("PKCS7", "pkcs7_certificate"),
    ] {
        assert_eq!(
            format_hint(format!("  \n{}", synthetic_pem(kind)).as_bytes()),
            expected
        );
    }
    assert_eq!(
        format_hint(b"PuTTY-User-Key-File-3: ssh-rsa"),
        "putty_private_key"
    );
    assert_eq!(format_hint(b"not a file"), "binary_or_unknown");
    assert_eq!(format_hint(b"   \n"), "binary_or_unknown");
    assert_eq!(format_hint(&[0x30, 0x82, 0xff, 0x00]), "binary_or_unknown");
}

#[test]
fn native_inspection_checks_pairs_passphrases_and_only_supplied_chain() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let (key, certificate) = synthetic_certificate(&root, "local-fixture");
    let (other_key, other_certificate) = synthetic_certificate(&root, "other-fixture");
    let key_before = fs::read(&key).unwrap();
    let certificate_before = fs::read(&certificate).unwrap();
    let matched = inspect(Some(&key), Some(&certificate), Some(&certificate), None).unwrap();
    assert_eq!(matched["keyParsed"], true);
    assert_eq!(matched["certificateParsed"], true);
    assert_eq!(matched["pairMatches"], true);
    assert_eq!(matched["chainStatus"], "verified_against_supplied_chain");
    assert_eq!(matched["verificationScope"], "local_files_only");
    assert!(matched["limitations"]
        .as_array()
        .unwrap()
        .contains(&json!("chain_trust_is_user_supplied")));
    let mismatch = inspect(
        Some(&other_key),
        Some(&certificate),
        Some(&other_certificate),
        None,
    )
    .unwrap();
    assert_eq!(mismatch["pairMatches"], false);
    assert_eq!(mismatch["chainStatus"], "not_verified");
    let cert_only = inspect(None, Some(&certificate), None, None).unwrap();
    assert_eq!(cert_only["keyParsed"], Value::Null);
    assert_eq!(cert_only["pairMatches"], Value::Null);
    assert_eq!(cert_only["certificateParsed"], true);
    let encrypted = root.join("encrypted-key.pem");
    let passphrase = "synthetic passphrase 密码 ";
    run(
        &[
            "pkcs8".into(),
            "-topk8".into(),
            "-in".into(),
            key.as_os_str().to_owned(),
            "-out".into(),
            encrypted.as_os_str().to_owned(),
            "-passout".into(),
            "stdin".into(),
        ],
        Some(passphrase),
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap()
    .unwrap();
    fs::set_permissions(&encrypted, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        inspect(Some(&encrypted), Some(&certificate), None, Some(passphrase)).unwrap()
            ["pairMatches"],
        true
    );
    let wrong = inspect(
        Some(&encrypted),
        Some(&certificate),
        None,
        Some("wrong synthetic phrase"),
    )
    .unwrap();
    assert_eq!(wrong["keyParsed"], false);
    assert_eq!(wrong["pairMatches"], Value::Null);
    assert_eq!(fs::read(&key).unwrap(), key_before);
    assert_eq!(fs::read(&certificate).unwrap(), certificate_before);
    let serialized = matched.to_string();
    assert!(!serialized.contains("BEGIN"));
    assert!(!serialized.contains(root.to_str().unwrap()));
    assert!(!serialized.contains(passphrase));
}

#[test]
fn unsupported_and_unreadable_inputs_are_distinct_from_mismatched_pairs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let openssh = private_file(
        &root,
        "unsupported",
        synthetic_pem("OPENSSH PRIVATE KEY").as_bytes(),
    );
    let unsupported = inspect(Some(&openssh), None, None, None).unwrap();
    assert_eq!(unsupported["keyParsed"], Value::Null);
    assert_eq!(unsupported["pairMatches"], Value::Null);
    assert!(unsupported["limitations"]
        .as_array()
        .unwrap()
        .contains(&json!("key_format_unsupported")));
    let corrupt = private_file(&root, "corrupt", synthetic_pem("PRIVATE KEY").as_bytes());
    assert_eq!(
        inspect(Some(&corrupt), None, None, None).unwrap()["keyParsed"],
        false
    );
    let cert = private_file(
        &root,
        "bad-certificate",
        synthetic_pem("CERTIFICATE").as_bytes(),
    );
    let invalid = inspect(None, Some(&cert), Some(&cert), None).unwrap();
    assert_eq!(invalid["certificateParsed"], false);
    assert_eq!(invalid["chainStatus"], "certificate_required");
    assert_eq!(
        inspect(None, None, Some(&openssh), None).unwrap()["chainStatus"],
        "not_verified"
    );
    let linked = root.join("linked");
    symlink(&corrupt, &linked).unwrap();
    assert_eq!(
        inspect(Some(&linked), None, None, None),
        Err("file_inspection_unavailable")
    );
    fs::set_permissions(&corrupt, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        inspect(Some(&corrupt), None, None, None),
        Err("file_inspection_unavailable")
    );
    for passphrase in ["line\nnext", "line\rnext", "null\0next", &"x".repeat(1025)] {
        assert_eq!(
            inspect(None, None, None, Some(passphrase)),
            Err("file_passphrase_unsupported")
        );
    }
    assert_eq!(
        run(&[], None, Instant::now()),
        Err("file_inspection_timeout")
    );
}

#[test]
fn fixed_process_templates_never_put_passphrases_or_shell_text_in_arguments() {
    let key = Path::new("/Users/example/lease $(inert) 中文");
    assert_eq!(
        key_arguments(key),
        vec![
            OsString::from("pkey"),
            "-in".into(),
            key.as_os_str().to_owned(),
            "-passin".into(),
            "stdin".into(),
            "-pubout".into()
        ]
    );
    assert_eq!(certificate_arguments(key)[0], "x509");
    let arguments = chain_arguments(key, key, Path::new("/Users/example/empty-ca-directory"));
    assert_eq!(arguments[0], "verify");
    assert_eq!(arguments[1], "-CAfile");
    assert_eq!(arguments[3], "-CApath");
}
