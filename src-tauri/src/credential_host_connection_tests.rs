use super::*;
use serde_json::json;
use std::process::{Command, Stdio};

fn peer(script: &str) -> HostConnection {
    let mut child = Command::new("/usr/bin/awk")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    HostConnection {
        input: child.stdin.take(),
        output: BufReader::new(child.stdout.take().unwrap()),
        child,
        executable: PathBuf::from("/synthetic-control-peer"),
        vault_id: String::new(),
    }
}

fn emit(value: &Value) -> String {
    format!(
        "print {}; fflush();",
        serde_json::to_string(&value.to_string()).unwrap()
    )
}

#[test]
fn ready_requires_a_locked_host_and_exact_namespace_identity_before_becoming_usable() {
    let valid = json!({"event":"ready","vaultId":"a".repeat(64),"locked":true});
    let mut connection = peer(&format!("BEGIN {{ {} }}", emit(&valid)));
    connection.accept_ready().unwrap();
    assert_eq!(connection.vault_id, "a".repeat(64));
    for (field, value) in [
        ("event", json!("other")),
        ("locked", json!(false)),
        ("vaultId", Value::Null),
        ("vaultId", json!("a".repeat(63))),
        ("vaultId", json!("z".repeat(64))),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        let mut connection = peer(&format!("BEGIN {{ {} }}", emit(&invalid)));
        assert_eq!(
            connection.accept_ready(),
            Err("credential_host_protocol_invalid")
        );
        assert!(connection.vault_id.is_empty());
    }
}

#[test]
fn control_response_requires_an_explicit_result_and_redacts_unknown_diagnostics() {
    for (response, expected) in [
        (
            json!({"ok":true,"result":{"locked":true}}),
            Ok(json!({"locked":true})),
        ),
        (json!({"ok":true}), Err("credential_host_protocol_invalid")),
        (
            json!({"ok":false,"error":"vault_locked"}),
            Err("vault_locked"),
        ),
        (
            json!({"ok":false,"error":"private path and synthetic secret"}),
            Err("credential_host_unavailable"),
        ),
        (
            json!({"ok":false,"error":42}),
            Err("credential_host_unavailable"),
        ),
    ] {
        let mut connection = peer(&format!("{{ {} }}", emit(&response)));
        assert_eq!(connection.exchange(&json!({"action":"status"})), expected);
    }
    let mut connection = peer("{ print \"not-json\"; fflush(); }");
    assert_eq!(
        connection.exchange(&json!({"action":"status"})),
        Err("credential_host_protocol_invalid")
    );
    let mut connection = peer("{ exit }");
    assert_eq!(
        connection.exchange(&json!({"action":"status"})),
        Err("credential_host_unavailable")
    );
    let mut connection = peer("{ exit }");
    connection.input.take();
    assert_eq!(
        connection.exchange(&json!({"action":"status"})),
        Err("credential_host_unavailable")
    );
}

#[test]
fn dropping_a_nonresponsive_peer_reaps_the_exact_child_after_closing_control_input() {
    // A private bounded fixture ignores EOF. No descendant or unrelated process exists.
    let mut connection = peer("BEGIN { print \"ready\"; fflush(); while (1) {} }");
    let pid = connection.child.id();
    let mut line = String::new();
    std::io::BufRead::read_line(&mut connection.output, &mut line).unwrap();
    assert_eq!(line, "ready\n");
    drop(connection);
    // SAFETY: signal 0 only queries the child PID; Drop already called wait.
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
