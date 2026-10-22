use super::{
    tests::{cleanup_client, scripted_connection},
    *,
};
use std::cell::Cell;

pub(super) struct TestWindow<'a> {
    pub(super) focus: Result<bool, &'static str>,
    pub(super) selection: Result<Option<PathBuf>, &'static str>,
    pub(super) on_focus: Option<&'a dyn Fn()>,
    pub(super) on_select: Option<&'a dyn Fn()>,
}

impl Default for TestWindow<'_> {
    fn default() -> Self {
        Self {
            focus: Ok(true),
            selection: Ok(None),
            on_focus: None,
            on_select: None,
        }
    }
}

impl NativeWindow for TestWindow<'_> {
    fn focused(&self) -> Result<bool, &'static str> {
        if let Some(callback) = self.on_focus {
            callback();
        }
        self.focus
    }
    fn save_file(&self, name: &str, backup: bool) -> Result<Option<PathBuf>, &'static str> {
        assert_eq!(
            name,
            if backup {
                "credentials.srtvault"
            } else {
                "synthetic-key"
            }
        );
        if let Some(callback) = self.on_select {
            callback();
        }
        self.selection.clone()
    }
    fn open_backup(&self) -> Result<Option<PathBuf>, &'static str> {
        if let Some(callback) = self.on_select {
            callback();
        }
        self.selection.clone()
    }
}

pub(super) fn request(value: Value) -> CredentialRequest {
    serde_json::from_value(value).unwrap()
}

pub(super) fn ok(value: Value) -> Value {
    json!({"ok":true,"result":value})
}

pub(super) fn peer(exchanges: Vec<(Value, Value)>) -> HostConnection {
    let mut script = String::new();
    for (index, (input, output)) in exchanges.into_iter().enumerate() {
        script.push_str(&format!(
            "NR == {} {{ if ($0 != {}) exit 9; print {}; fflush(); next }}\n",
            index + 1,
            serde_json::to_string(&input.to_string()).unwrap(),
            serde_json::to_string(&output.to_string()).unwrap()
        ));
    }
    script.push_str("{ exit 9 }");
    scripted_connection(&script)
}

pub(super) fn connect(client: &CredentialClient, exchanges: Vec<(Value, Value)>) {
    *client.connection.lock().unwrap() = Some(peer(exchanges));
}

pub(super) fn run(
    client: &CredentialClient,
    input: Value,
    window: &dyn NativeWindow,
) -> Result<Value, &'static str> {
    let request = request(input);
    let stamp = client.invalidate_for(request.action).unwrap();
    client.perform(request, window, stamp, |_| {
        panic!("this command must use the supplied control peer")
    })
}

pub(super) fn human(action: &str) -> Value {
    json!({"action":action,"recordId":"synthetic-record","expectedVersion":2,"sessionId":"synthetic-session"})
}

pub(super) fn prepare() -> Value {
    json!({"action":"prepare_export","recordId":"synthetic-record","expectedVersion":2,"field":"privateKey"})
}

pub(super) fn detail() -> Value {
    json!({"version":2,"files":[{"field":"privateKey","name":"synthetic-key"}]})
}

pub(super) fn export(selection_id: &str) -> Value {
    let mut value = human("export_file");
    value["selectionId"] = json!(selection_id);
    value["field"] = json!("privateKey");
    value
}

#[test]
fn status_starts_only_the_supplied_host_and_returns_actual_bridge_location() {
    let (_dir, client, _clipboard, _destination) = cleanup_client();
    let called = Cell::new(0);
    let result = client
        .perform(
            request(json!({"action":"status"})),
            &TestWindow::default(),
            (3, 0),
            |_| {
                called.set(called.get() + 1);
                Ok(peer(vec![(
                    json!({"action":"status"}),
                    ok(json!({"locked":true})),
                )]))
            },
        )
        .unwrap();
    assert_eq!(called.get(), 1);
    assert_eq!(result["locked"], true);
    assert_eq!(result["bridgeCommand"], "/synthetic-control-peer");
    assert_eq!(
        result["bridgeArgs"],
        json!([
            "--credential-mcp",
            "--root",
            client.root,
            "--vault-id",
            "synthetic-vault"
        ])
    );
    assert_eq!(result["clipboard"]["owned"], true);
    *client.connection.lock().unwrap() = None;
    assert_eq!(
        client.perform(
            request(json!({"action":"status"})),
            &TestWindow::default(),
            (3, 0),
            |_| Err("credential_host_unavailable")
        ),
        Err("credential_host_unavailable")
    );
}

#[test]
fn untrusted_paths_and_unverified_reads_fail_before_host_start() {
    let (_dir, client, _clipboard, _destination) = cleanup_client();
    assert_eq!(
        run(
            &client,
            json!({"action":"backup_create","path":"/untrusted/path"}),
            &TestWindow::default()
        ),
        Err("invalid_arguments")
    );
    for action in ["read_fields", "copy_secret", "export_file", "inspect_files"] {
        let mut input = human(action);
        input["sessionId"] = Value::Null;
        assert_eq!(
            run(&client, input, &TestWindow::default()),
            Err("human_verification_required")
        );
    }
    let mut mismatched = human("read_fields");
    mismatched["sessionId"] = json!("another-session");
    assert_eq!(
        run(&client, mismatched, &TestWindow::default()),
        Err("human_verification_required")
    );
    assert_eq!(
        client.perform(
            request(human("read_fields")),
            &TestWindow::default(),
            (2, 0),
            |_| panic!()
        ),
        Err("human_verification_required")
    );
    assert_eq!(
        run(&client, human("copy_secret"), &TestWindow::default()),
        Err("invalid_secret_field")
    );
    assert_eq!(
        client.perform(
            request(json!({"action":"list"})),
            &TestWindow::default(),
            (3, 1),
            |_| panic!()
        ),
        Err("stale_generation")
    );
}

#[test]
fn verification_read_copy_and_inspection_use_real_control_frames_and_short_focus_check() {
    let (_dir, client, clipboard, _destination) = cleanup_client();
    let verify = human("verify");
    let mut read = human("read_fields");
    read["fields"] = json!(["password"]);
    let inspect = human("inspect_files");
    connect(
        &client,
        vec![
            (verify.clone(), ok(json!({"verified":true}))),
            (
                read.clone(),
                ok(json!({"fields":{"password":"synthetic secret"}})),
            ),
            (
                read.clone(),
                ok(json!({"fields":{"password":"synthetic secret"}})),
            ),
            (inspect.clone(), ok(json!({"pairMatches":true}))),
        ],
    );
    let observed = Cell::new(0);
    let focus = || {
        assert!(client.delivery.try_lock().is_ok());
        observed.set(observed.get() + 1);
    };
    let window = TestWindow {
        on_focus: Some(&focus),
        ..Default::default()
    };
    assert_eq!(
        run(&client, verify, &window).unwrap(),
        json!({"verified":true})
    );
    assert_eq!(
        run(&client, read, &window).unwrap()["fields"]["password"],
        "synthetic secret"
    );
    let mut copy = human("copy_secret");
    copy["field"] = json!("password");
    assert_eq!(
        run(&client, copy, &window).unwrap(),
        json!({"copied":true,"cleanupAfterSeconds":30})
    );
    assert_eq!(
        clipboard.text.lock().unwrap().as_deref(),
        Some("synthetic secret")
    );
    assert_eq!(
        run(&client, inspect, &window).unwrap(),
        json!({"pairMatches":true})
    );
    assert_eq!(observed.get(), 4);
}

#[test]
fn focus_loss_or_generation_change_after_host_response_never_delivers_secrets() {
    for (focus, stale, expected) in [
        (Ok(false), false, "human_session_invalid"),
        (
            Err("window_focus_unavailable"),
            false,
            "window_focus_unavailable",
        ),
        (Ok(true), true, "stale_generation"),
    ] {
        let (_dir, client, clipboard, _destination) = cleanup_client();
        let mut copy = human("copy_secret");
        copy["field"] = json!("password");
        let mut control = human("read_fields");
        control["fields"] = json!(["password"]);
        connect(
            &client,
            vec![(
                control,
                ok(json!({"fields":{"password":"must not be copied"}})),
            )],
        );
        let change = || {
            if stale {
                client.invalidate_focus();
            }
        };
        let window = TestWindow {
            focus,
            on_focus: Some(&change),
            ..Default::default()
        };
        assert_eq!(run(&client, copy, &window), Err(expected));
        assert_eq!(
            clipboard.text.lock().unwrap().as_deref(),
            Some("synthetic copy")
        );
        if focus == Ok(false) || stale {
            assert!(client.delivery.lock().unwrap().session.is_none());
        }
    }
    let (_dir, client, _clipboard, _destination) = cleanup_client();
    let input = human("verify");
    connect(&client, vec![(input.clone(), ok(json!({"verified":true})))]);
    assert_eq!(
        run(
            &client,
            input,
            &TestWindow {
                focus: Ok(false),
                ..Default::default()
            }
        ),
        Err("human_session_invalid")
    );
    assert!(client.delivery.lock().unwrap().session.is_none());
}

#[test]
fn copy_rejects_a_missing_requested_field_and_preserves_existing_clipboard() {
    let (_dir, client, clipboard, _destination) = cleanup_client();
    let mut copy = human("copy_secret");
    copy["field"] = json!("password");
    let mut control = human("read_fields");
    control["fields"] = json!(["password"]);
    connect(
        &client,
        vec![(control, ok(json!({"fields":{"unrequested":"unrelated"}})))],
    );
    assert_eq!(
        run(&client, copy, &TestWindow::default()),
        Err("field_not_found")
    );
    assert_eq!(
        clipboard.text.lock().unwrap().as_deref(),
        Some("synthetic copy")
    );
}

#[test]
fn malformed_transport_is_discarded_but_reviewed_domain_errors_remain_retryable() {
    for (input, native) in [
        (json!({"action":"list"}), false),
        (json!({"action":"agent_guide","client":"codex"}), true),
    ] {
        let (_dir, client, _clipboard, _destination) = cleanup_client();
        let control = if native {
            json!({"action":"status"})
        } else {
            input.clone()
        };
        connect(&client, vec![(control, json!({"ok":true}))]);
        assert_eq!(
            run(&client, input, &TestWindow::default()),
            Err("credential_host_unavailable")
        );
        assert!(client.connection.lock().unwrap().is_none());
        assert!(client.delivery.lock().unwrap().session.is_none());
    }
    let (_dir, client, _clipboard, _destination) = cleanup_client();
    connect(
        &client,
        vec![(
            json!({"action":"list"}),
            json!({"ok":false,"error":"vault_locked"}),
        )],
    );
    assert_eq!(
        run(&client, json!({"action":"list"}), &TestWindow::default()),
        Err("vault_locked")
    );
    assert!(client.connection.lock().unwrap().is_some());
}

#[test]
fn late_unlock_is_relocked_while_committed_mutations_keep_their_result() {
    for action in [Action::Unlock, Action::Create, Action::List, Action::Save] {
        let (_dir, client, _clipboard, _destination) = cleanup_client();
        let input = serde_json::to_value(CredentialRequest {
            action,
            arguments: Default::default(),
        })
        .unwrap();
        let stamp = client.invalidate_for(action).unwrap();
        let mut frames = vec![(input.clone(), ok(json!({"done":true})))];
        if matches!(action, Action::Unlock | Action::Create) {
            frames.push((json!({"action":"lock"}), ok(json!({"locked":true}))));
        }
        frames.push((json!({"action":"status"}), ok(json!({"confirmed":true}))));
        let mut frames = Some(frames);
        let result = client.perform(request(input), &TestWindow::default(), stamp, |_| {
            client.invalidate_focus();
            Ok(peer(frames.take().unwrap()))
        });
        if action == Action::Save {
            assert_eq!(result.unwrap(), json!({"done":true}));
        } else {
            assert_eq!(result, Err("stale_generation"));
        }
        assert_eq!(
            client
                .connection
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .exchange(&json!({"action":"status"}))
                .unwrap(),
            json!({"confirmed":true})
        );
    }
}

#[test]
fn agent_guide_reads_only_public_status_and_rejects_an_unknown_client() {
    let (_dir, client, _clipboard, _destination) = cleanup_client();
    connect(
        &client,
        vec![
            (
                json!({"action":"status"}),
                ok(
                    json!({"exists":false,"locked":true,"password":"synthetic-secret-must-not-leak"}),
                ),
            ),
            (
                json!({"action":"status"}),
                ok(json!({"exists":false,"locked":true})),
            ),
        ],
    );
    let result = run(
        &client,
        json!({"action":"agent_guide","client":"codex"}),
        &TestWindow::default(),
    )
    .unwrap();
    assert_eq!(result["client"], "codex");
    assert_eq!(result["ready"], false);
    assert!(!result
        .to_string()
        .contains("synthetic-secret-must-not-leak"));
    assert_eq!(
        run(
            &client,
            json!({"action":"agent_guide","client":"unknown"}),
            &TestWindow::default()
        ),
        Err("invalid_agent_client")
    );
    assert_eq!(
        run(
            &client,
            json!({"action":"agent_guide"}),
            &TestWindow::default()
        ),
        Err("agent_client_unsupported")
    );
}

#[test]
fn clipboard_failure_is_reported_without_returning_or_replacing_the_secret() {
    struct UnavailableClipboard;
    impl ClipboardPort for UnavailableClipboard {
        fn copy_text(&self, _: &str) -> Result<(), &'static str> {
            Err("clipboard_unavailable")
        }
        fn clear_owned(&self) -> Result<(), &'static str> {
            Ok(())
        }
        fn status(&self) -> ClipboardStatus {
            ClipboardStatus {
                owned: false,
                error: None,
            }
        }
    }
    let (_dir, mut client, _clipboard, _destination) = cleanup_client();
    client.clipboard = Box::new(UnavailableClipboard);
    let mut copy = human("copy_secret");
    copy["field"] = json!("password");
    let mut control = human("read_fields");
    control["fields"] = json!(["password"]);
    connect(
        &client,
        vec![(
            control,
            ok(json!({"fields":{"password":"synthetic secret"}})),
        )],
    );
    assert_eq!(
        run(&client, copy, &TestWindow::default()),
        Err("clipboard_unavailable")
    );
}

#[test]
fn invalidation_counter_exhaustion_fails_closed_before_a_control_operation() {
    let (_dir, client, _clipboard, _destination) = cleanup_client();
    client.delivery.lock().unwrap().generation = u64::MAX;
    assert_eq!(
        client.invalidate_for(Action::Save),
        Err("generation_exhausted")
    );
    let mut delivery = client.delivery.lock().unwrap();
    delivery.generation = 1;
    delivery.cancellation = u64::MAX;
    drop(delivery);
    assert_eq!(
        client.invalidate_for(Action::Lock),
        Err("generation_exhausted")
    );
    assert!(client.delivery.lock().unwrap().session.is_none());
    assert!(client.connection.lock().unwrap().is_none());
}
