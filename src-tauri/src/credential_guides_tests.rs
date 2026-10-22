use super::*;

fn fixture() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    std::path::PathBuf,
    Value,
) {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let executable = base.join("Tracker 中文 \" quotes \\ slash.app");
    fs::write(&executable, b"synthetic executable fixture").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let root = base.join("User data 凭据");
    fs::create_dir(&root).unwrap();
    let status = json!({"exists":true,"vaultId":"a".repeat(64),"locked":false,
        "sharing":true,"authorizationError":null,"cleanupFailed":false});
    (directory, executable, root, status)
}

fn config_json(text: &str) -> Value {
    let block = text
        .split("```json\n")
        .nth(1)
        .or_else(|| text.split("```yaml\n").nth(1))
        .unwrap();
    serde_json::from_str(block.split("\n```").next().unwrap()).unwrap()
}

#[test]
fn generates_only_selected_schema_and_roundtrips_paths_without_secret_access() {
    let (_directory, executable, root, mut status) = fixture();
    // The generator projects the public status fields only, even if a future
    // caller accidentally passes unrelated data alongside them.
    status["password"] = json!("synthetic-secret-must-not-appear");
    status["auth"] = json!("synthetic-access-must-not-appear");
    for client in [
        "codex",
        "claude_code",
        "workbuddy",
        "deepseek_harness",
        "generic",
    ] {
        let guide = generate(client, &executable, &root, &status).unwrap();
        assert_eq!(guide["ready"], true);
        assert_eq!(guide["reason"], Value::Null);
        let name = guide["serverName"].as_str().unwrap();
        assert!(name.len() <= 32);
        let text = guide["text"].as_str().unwrap();
        assert!(!text.contains("synthetic-secret-must-not-appear"));
        assert!(!text.contains("synthetic-access-must-not-appear"));
        assert!(!text.contains("{{"));
        assert!(!text.contains("--credential-bridge"));
        assert!(text.contains("尚未验证此客户端连接"));
        assert!(text.contains("不覆盖或自动改名"));
        assert!(text.contains("仅取任务必需字段"));
        if client == "codex" {
            assert!(text.contains(&format!("[mcp_servers.{name}]")));
            assert!(text.contains(&toml_string(executable.to_str().unwrap()).unwrap()));
            assert!(!text.contains("mcpServers"));
        } else {
            let config = config_json(text);
            let entry = match client {
                "claude_code" | "workbuddy" => &config["mcpServers"][name],
                "deepseek_harness" => {
                    assert_eq!(config[0]["insert"][0]["id"], name);
                    assert_eq!(
                        config[0]["insert"][0]["name"],
                        "@deepseek-ai/dsh-mcp-client"
                    );
                    &config[0]["insert"][0]["config"]
                }
                _ => &config,
            };
            assert_eq!(entry["command"], executable.to_str().unwrap());
            assert_eq!(
                entry["args"],
                json!([
                    "--credential-mcp",
                    "--root",
                    root,
                    "--vault-id",
                    "a".repeat(64)
                ])
            );
            assert!(entry.get("env").is_none());
            assert!(entry.get("cwd").is_none());
            if client == "claude_code" {
                assert_eq!(entry["type"], "stdio");
            }
            if client == "workbuddy" {
                assert!(entry.get("type").is_none());
            }
            if client == "generic" {
                assert!(text.contains("未适配"));
            }
        }
        for other in ["https://developers.openai.com/codex/mcp/", "https://code.claude.com/docs/en/mcp", "https://open.workbuddy.cn/en/docs/connector", "https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md"] {
            assert_eq!(text.contains(other), client_info(client).unwrap().source == other);
        }
    }
}

#[test]
fn copy_gate_keeps_unready_documents_readable_and_locked_authorization_reusable() {
    let (_directory, executable, root, status) = fixture();
    for (field, value, expected) in [
        ("exists", json!(false), "agent_vault_required"),
        ("vaultId", json!("invalid-vault"), "agent_vault_required"),
        ("sharing", json!(false), "agent_sharing_required"),
        ("cleanupFailed", json!(true), "cleanup_failed"),
        (
            "authorizationError",
            json!("credential_authorization_denied"),
            "credential_authorization_required",
        ),
    ] {
        let mut changed = status.clone();
        changed[field] = value;
        let guide = generate("codex", &executable, &root, &changed).unwrap();
        assert_eq!(guide["ready"], false);
        assert_eq!(guide["reason"], expected);
        assert!(!guide["text"].as_str().unwrap().contains("```"));
    }
    let mut locked = status.clone();
    locked["locked"] = json!(true);
    let guide = generate("codex", &executable, &root, &locked).unwrap();
    assert_eq!(guide["ready"], true);
    assert!(guide["text"]
        .as_str()
        .unwrap()
        .contains("已锁定，请在应用中手动解锁"));
    assert_eq!(
        generate("unknown", &executable, &root, &status),
        Err("invalid_agent_client")
    );
    assert_eq!(
        generate("codex", &root, &root, &status).unwrap()["reason"],
        "agent_bridge_unavailable"
    );
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        generate("codex", &executable, &root, &status).unwrap()["reason"],
        "agent_bridge_unavailable"
    );
}

#[test]
fn toml_encodes_controls_and_shell_metacharacters_as_data() {
    let value = "a\"b\\c\n\r\t\u{0}\u{7f} $(touch inert) `inert` 中文";
    let encoded = toml_string(value).unwrap();
    assert_eq!(serde_json::from_str::<String>(&encoded).unwrap(), value);
    assert!(encoded.contains("\\u007f"));
    assert!(!encoded.contains('\n'));
    assert!(!encoded.contains('\u{7f}'));
}
