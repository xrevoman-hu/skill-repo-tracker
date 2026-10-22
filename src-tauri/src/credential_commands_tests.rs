use super::*;

#[derive(Default)]
struct FakeClipboard {
    text: Mutex<Option<String>>,
}
impl ClipboardPort for Arc<FakeClipboard> {
    fn copy_text(&self, text: &str) -> Result<(), &'static str> {
        *self.text.lock().unwrap() = Some(text.to_owned());
        Ok(())
    }
    fn clear_owned(&self) -> Result<(), &'static str> {
        *self.text.lock().unwrap() = None;
        Ok(())
    }
    fn status(&self) -> ClipboardStatus {
        ClipboardStatus {
            owned: self.text.lock().unwrap().is_some(),
            error: None,
        }
    }
}

fn client(clipboard: &Arc<FakeClipboard>) -> CredentialClient {
    CredentialClient {
        root: PathBuf::from("/synthetic-vault-not-opened"),
        connection: Mutex::new(None),
        delivery: Mutex::new(Delivery {
            generation: 3,
            session: Some("synthetic-session".to_owned()),
        }),
        clipboard: Box::new(Arc::clone(clipboard)),
    }
}

#[test]
fn leaving_app_or_drawer_invalidates_session_but_preserves_copy_for_pasting() {
    let clipboard = Arc::new(FakeClipboard::default());
    clipboard.copy_text("synthetic copy for other app").unwrap();
    let client = client(&clipboard);
    client.invalidate_focus();
    assert_eq!(client.delivery.lock().unwrap().generation, 4);
    assert!(client.delivery.lock().unwrap().session.is_none());
    assert_eq!(
        clipboard.text.lock().unwrap().as_deref(),
        Some("synthetic copy for other app")
    );
    client.invalidate_for(Action::InvalidateSession).unwrap();
    assert!(clipboard.status().owned);
    client.invalidate_for(Action::Lock).unwrap();
    assert!(!clipboard.status().owned);
}

#[test]
fn focus_invalidation_does_not_wait_for_a_slow_host_request() {
    let clipboard = Arc::new(FakeClipboard::default());
    let client = client(&clipboard);
    let _slow_request = client.connection.lock().unwrap();
    // A KDF/host request owns the connection lock, but the native focus event
    // must invalidate delivery independently instead of queueing behind it.
    client.invalidate_focus();
    assert_eq!(client.delivery.lock().unwrap().generation, 4);
    assert!(client.delivery.lock().unwrap().session.is_none());
}

#[test]
fn explicit_exit_clears_owned_copy_without_waiting_for_host_authorization() {
    let clipboard = Arc::new(FakeClipboard::default());
    clipboard.copy_text("synthetic secret").unwrap();
    let client = client(&clipboard);
    let _blocked_authorization = client.connection.lock().unwrap();
    client.clear_on_exit();
    assert!(!clipboard.status().owned);
    assert!(client.delivery.lock().unwrap().session.is_none());
}

#[test]
fn unknown_actions_and_master_password_over_mcp_are_not_gui_backdoors() {
    assert!(serde_json::from_value::<CredentialRequest>(json!({"action":"fixture_file"})).is_err());
    assert!(serde_json::from_value::<CredentialRequest>(json!({"action":"shutdown"})).is_err());
    let request:CredentialRequest=serde_json::from_value(json!({"action":"copy_secret","recordId":"synthetic-record", "expectedVersion":1,"sessionId":"synthetic-session","field":"password"})).unwrap();
    assert!(request.action == Action::CopySecret);
}
