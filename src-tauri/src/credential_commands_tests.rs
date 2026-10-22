use super::*;

#[derive(Default)]
pub(super) struct FakeClipboard {
    pub(super) text: Mutex<Option<String>>,
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
            cancellation: 0,
            session: Some("synthetic-session".to_owned()),
        }),
        clipboard: Box::new(Arc::clone(clipboard)),
        selections: Mutex::new(crate::credential_file_io::Selections::default()),
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
    assert_eq!(client.delivery.lock().unwrap().cancellation, 0);
    client.invalidate_for(Action::Lock).unwrap();
    assert!(!clipboard.status().owned);
    assert_eq!(client.delivery.lock().unwrap().cancellation, 1);
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
    assert_eq!(client.delivery.lock().unwrap().cancellation, 0);
    client.invalidate_for(Action::Lock).unwrap();
    assert_eq!(client.delivery.lock().unwrap().cancellation, 1);
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

pub(super) fn cleanup_client() -> (
    tempfile::TempDir,
    CredentialClient,
    Arc<FakeClipboard>,
    PathBuf,
) {
    use std::os::unix::fs::DirBuilderExt;
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().canonicalize().unwrap();
    let root = parent.join("managed");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .unwrap();
    let destination = parent.join("exports");
    std::fs::create_dir(&destination).unwrap();
    let clipboard = Arc::new(FakeClipboard::default());
    clipboard.copy_text("synthetic copy").unwrap();
    let mut client = client(&clipboard);
    client.root = root;
    (directory, client, clipboard, destination)
}

// A bounded control-pipe peer, never a real vault or a Keychain caller. It only
// acknowledges the exact lock request, making an accidental status/read fail.
fn cleanup_connection(valid_reply: bool) -> HostConnection {
    let script = if valid_reply {
        r#"{ if ($0 != "{\"action\":\"lock\"}") exit 2; print "{\"ok\":true,\"result\":{\"locked\":true}}"; fflush(); }"#
    } else {
        r#"{ print "invalid-control-response"; fflush(); exit; }"#
    };
    scripted_connection(script)
}

pub(super) fn scripted_connection(script: &str) -> HostConnection {
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
        vault_id: "synthetic-vault".to_owned(),
    }
}

#[test]
fn cancelled_export_with_failed_drop_locks_before_releasing_connection() {
    let (_directory, client, clipboard, destination) = cleanup_client();
    let mut pending =
        crate::credential_export_journal::PendingExport::create(&client.root, &destination)
            .unwrap();
    pending.write(b"synthetic plaintext").unwrap();
    let moved = destination.with_file_name("moved-exports");
    std::fs::rename(&destination, &moved).unwrap();
    std::fs::create_dir(&destination).unwrap();
    drop(pending);
    assert!(client.root.join("export-pending.json").exists());
    let mut slot = client.connection.lock().unwrap();
    *slot = Some(cleanup_connection(true));
    assert_eq!(
        client.finish_export(Err("human_session_invalid"), &mut slot),
        Err("export_cleanup_failed")
    );
    assert!(slot.is_some());
    assert!(client.connection.try_lock().is_err());
    assert!(client.delivery.lock().unwrap().session.is_none());
    assert!(!clipboard.status().owned);
    assert!(client.root.join("export-pending.json").exists());
    assert_eq!(std::fs::read_dir(&moved).unwrap().count(), 1);
    // Restoring the original parent makes the same journal safely retryable.
    std::fs::remove_dir(&destination).unwrap();
    std::fs::rename(&moved, &destination).unwrap();
    crate::credential_export_journal::cleanup(&client.root).unwrap();
    assert_eq!(std::fs::read_dir(destination).unwrap().count(), 0);
}

#[test]
fn successful_drop_preserves_the_original_cancel_without_locking() {
    let (_directory, client, clipboard, destination) = cleanup_client();
    let mut pending =
        crate::credential_export_journal::PendingExport::create(&client.root, &destination)
            .unwrap();
    pending.write(b"synthetic plaintext").unwrap();
    drop(pending);
    let mut slot = client.connection.lock().unwrap();
    // This peer would force disposal if finish_export attempted an unnecessary lock.
    *slot = Some(cleanup_connection(false));
    assert_eq!(
        client.finish_export(Err("stale_generation"), &mut slot),
        Err("stale_generation")
    );
    assert!(slot.is_some());
    assert!(clipboard.status().owned);
    assert_eq!(client.delivery.lock().unwrap().generation, 3);
    assert!(!client.root.join("export-pending.json").exists());
}

#[test]
fn failed_cleanup_lock_discards_the_control_connection() {
    let (_directory, client, clipboard, _destination) = cleanup_client();
    let mut slot = client.connection.lock().unwrap();
    *slot = Some(cleanup_connection(false));
    assert_eq!(
        client.lock_after_cleanup_failure(&mut slot),
        Err("export_cleanup_failed")
    );
    assert!(slot.is_none());
    assert!(!clipboard.status().owned);
    assert!(client.delivery.lock().unwrap().session.is_none());
}

#[test]
fn published_export_keeps_its_completion_classification_after_cleanup_failure() {
    use std::os::unix::fs::PermissionsExt;
    let (_directory, client, _clipboard, destination) = cleanup_client();
    let mut pending =
        crate::credential_export_journal::PendingExport::create(&client.root, &destination)
            .unwrap();
    pending.write(b"synthetic original bytes").unwrap();
    let exported = destination.join("chosen-key");
    let journal = client.root.join("export-pending.json");
    std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o644)).unwrap();
    let result = pending
        .publish(&exported, false)
        .map(|()| json!({"exported":true}));
    assert_eq!(result, Err("file_export_cleanup_failed"));
    drop(pending);
    let mut slot = client.connection.lock().unwrap();
    *slot = Some(cleanup_connection(true));
    assert_eq!(
        client.finish_export(result, &mut slot),
        Err("file_export_cleanup_failed")
    );
    assert!(slot.is_some());
    assert_eq!(
        std::fs::read(exported).unwrap(),
        b"synthetic original bytes"
    );
    assert!(journal.exists());
}

fn existing_marker(client: &CredentialClient) {
    use std::os::unix::fs::PermissionsExt;
    let marker = client.root.join("vault.json");
    std::fs::write(
        &marker,
        serde_json::to_vec(&json!({"schema":"srt-credential-v1","vaultId":"a".repeat(64)}))
            .unwrap(),
    )
    .unwrap();
    std::fs::set_permissions(marker, std::fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn startup_without_a_formal_marker_stays_lazy_and_does_not_create_a_root() {
    let (_directory, mut client, _clipboard, _destination) = cleanup_client();
    client
        .start_existing(|_| panic!("an unmarked directory must not start a host"))
        .unwrap();
    assert!(client.connection.lock().unwrap().is_none());
    assert_eq!(std::fs::read_dir(&client.root).unwrap().count(), 0);
    client.root = client.root.with_file_name("absent-credentials");
    client
        .start_existing(|_| panic!("a missing root must not start a host"))
        .unwrap();
    assert!(!client.root.exists());
}

#[test]
fn startup_cleans_registered_exports_after_starting_the_existing_host() {
    let (_directory, client, _clipboard, destination) = cleanup_client();
    existing_marker(&client);
    let mut pending =
        crate::credential_export_journal::PendingExport::create(&client.root, &destination)
            .unwrap();
    pending.write(b"synthetic startup residue").unwrap();
    let journal = client.root.join("export-pending.json");
    let entry: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    let staging = PathBuf::from(entry["path"].as_str().unwrap());
    client
        .start_existing(|_| {
            assert!(journal.exists());
            assert!(staging.exists());
            // Any control request would get an invalid response: startup must not unlock.
            Ok(cleanup_connection(false))
        })
        .unwrap();
    assert!(client.connection.lock().unwrap().is_some());
    assert!(!journal.exists());
    assert!(!staging.exists());
    drop(pending);
}

#[test]
fn startup_failure_retains_export_journal_for_the_next_request() {
    use std::os::unix::fs::PermissionsExt;
    let (_directory, client, _clipboard, destination) = cleanup_client();
    existing_marker(&client);
    let mut pending =
        crate::credential_export_journal::PendingExport::create(&client.root, &destination)
            .unwrap();
    pending.write(b"synthetic startup residue").unwrap();
    let journal = client.root.join("export-pending.json");
    assert_eq!(
        client.start_existing(|_| Err("credential_host_unavailable")),
        Err("credential_host_unavailable")
    );
    assert!(client.connection.lock().unwrap().is_none());
    assert!(journal.exists());
    std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        client.start_existing(|_| Ok(cleanup_connection(true))),
        Err("export_cleanup_failed")
    );
    assert!(client.connection.lock().unwrap().is_some());
    assert!(journal.exists());
    std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o600)).unwrap();
    crate::credential_export_journal::cleanup(&client.root).unwrap();
    drop(pending);
}

#[test]
fn cleanup_error_keeps_a_host_only_after_confirming_its_locked_state() {
    let script = r#"{ if ($0 == "{\"action\":\"lock\"}") print "{\"ok\":false,\"error\":\"lease_cleanup_failed\"}"; else if ($0 == "{\"action\":\"status\"}") print "{\"ok\":true,\"result\":{\"locked\":true,\"cleanupFailed\":true,\"cleanupRemaining\":1}}"; else exit 2; fflush(); }"#;
    let (_directory, client, _clipboard, _destination) = cleanup_client();
    let mut slot = client.connection.lock().unwrap();
    *slot = Some(scripted_connection(script));
    let status = client.lock_after_cleanup_failure(&mut slot).unwrap();
    assert_eq!(status["locked"], true);
    assert_eq!(status["cleanupFailed"], true);
    assert_eq!(status["cleanupRemaining"], 1);
    assert!(slot.is_some());
}
