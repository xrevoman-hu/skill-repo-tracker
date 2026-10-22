use super::*;

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn product_entry_accepts_only_fixed_nonsecret_location_arguments() {
    let id = "a".repeat(64);
    let (root, returned) = product_arguments(&args(&[
        "--credential-mcp",
        "--root",
        "/Users/example/Library/Application Support/凭据",
        "--vault-id",
        &id,
    ]))
    .unwrap();
    assert_eq!(
        root,
        PathBuf::from("/Users/example/Library/Application Support/凭据")
    );
    assert_eq!(returned, id);
    for rejected in [
        vec!["--credential-mcp"],
        vec!["--credential-mcp", "--root", "relative", "--vault-id", &id],
        vec![
            "--credential-mcp",
            "--root",
            "/fixture",
            "--vault-id",
            "e0-test-id",
        ],
        vec!["--credential-mcp", "--root", "/fixture", "--token", &id],
        vec!["--credential-mcp", "--vault-id", &id, "--root", "/fixture"],
        vec![
            "--credential-bridge",
            "--root",
            "/fixture",
            "--vault-id",
            &id,
        ],
        vec![
            "--credential-mcp",
            "--root",
            "/fixture",
            "--vault-id",
            &id,
            "--password",
            "synthetic",
        ],
    ] {
        assert!(product_arguments(&args(&rejected)).is_err());
    }
}

#[test]
fn lease_schema_accepts_exact_optional_field_and_rejects_path_or_unknown_fields() {
    let id = json!({"vaultId":"a".repeat(64),"recordId":"record-001"});
    assert!(validate_call("srt_credentials_lease_file", &id).is_ok());
    for field in ["certificate", "private_key", "certificate_chain"] {
        let mut selected = id.clone();
        selected["field"] = json!(field);
        assert!(validate_call("srt_credentials_lease_file", &selected).is_ok());
    }
    for field in [
        json!(""),
        json!(null),
        json!(32),
        json!("../private_key"),
        json!("x".repeat(65)),
    ] {
        let mut selected = id.clone();
        selected["field"] = field;
        assert_eq!(
            validate_call("srt_credentials_lease_file", &selected),
            Err("invalid_secret_field")
        );
    }
    let mut unknown = id.clone();
    unknown["destinationPath"] = json!("/Users/example/destination");
    assert_eq!(
        validate_call("srt_credentials_lease_file", &unknown),
        Err("invalid_arguments")
    );
    let tools = tools();
    let lease = &tools["tools"][2];
    assert_eq!(lease["inputSchema"]["properties"]["field"]["maxLength"], 64);
    assert_eq!(
        lease["inputSchema"]["required"],
        json!(["vaultId", "recordId"])
    );
}

#[test]
fn lease_capacity_is_forwarded_with_release_guidance_without_becoming_a_host_failure() {
    let code = forwarded_error("too_many_file_leases");
    assert_eq!(code, "too_many_file_leases");
    let response = tool_result(Err(code));
    assert_eq!(response["isError"], true);
    let message = response["content"][0]["text"].as_str().unwrap();
    assert!(message.starts_with("too_many_file_leases:"));
    assert!(message.contains("srt_credentials_release_file"));
    assert!(message.contains("then retry"));
    assert!(!message.contains("host_unavailable"));
    assert_eq!(forwarded_error("cleanup_failed"), "cleanup_failed");
    assert_eq!(
        forwarded_error("untrusted path and synthetic secret"),
        "credential_request_failed"
    );
}
