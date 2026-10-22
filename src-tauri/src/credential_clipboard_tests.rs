use super::*;

#[derive(Default)]
struct FakeState {
    generation: isize,
    text: Option<String>,
    fail_clear: bool,
    fail_read: bool,
    fail_write: bool,
    replace_during_read: bool,
    clears: usize,
}

struct FakePasteboard(Arc<Mutex<FakeState>>);

impl Pasteboard for FakePasteboard {
    fn change_count(&mut self) -> ClipboardResult<isize> {
        Ok(self.0.lock().unwrap().generation)
    }

    fn text_digest(&mut self) -> ClipboardResult<Option<[u8; 32]>> {
        let mut fake = self.0.lock().unwrap();
        if fake.fail_read {
            return Err("credential_clipboard_read_failed");
        }
        let result = fake.text.as_deref().map(digest);
        if fake.replace_during_read {
            fake.replace_during_read = false;
            fake.generation += 1;
        }
        Ok(result)
    }

    fn clear(&mut self) -> ClipboardResult<isize> {
        let mut fake = self.0.lock().unwrap();
        if fake.fail_clear {
            return Err("credential_clipboard_cleanup_failed");
        }
        fake.generation += 1;
        fake.clears += 1;
        fake.text = None;
        Ok(fake.generation)
    }

    fn set_text(&mut self, text: &str) -> ClipboardResult<()> {
        let mut fake = self.0.lock().unwrap();
        if fake.fail_write {
            return Err("credential_clipboard_write_failed");
        }
        fake.text = Some(text.into());
        Ok(())
    }
}

fn fixture() -> (ClipboardState, Arc<Mutex<FakeState>>) {
    let fake = Arc::new(Mutex::new(FakeState::default()));
    (
        ClipboardState {
            board: Box::new(FakePasteboard(Arc::clone(&fake))),
            owned: None,
            deadline: None,
            error: None,
            stopping: false,
        },
        fake,
    )
}

#[test]
fn expires_only_the_owned_copy_at_thirty_seconds() {
    let (mut state, fake) = fixture();
    let now = Instant::now();
    state.copy("synthetic-secret", now).unwrap();
    state.expire(now + Duration::from_secs(29));
    assert!(state.status().owned);
    assert_eq!(fake.lock().unwrap().clears, 1);
    state.expire(now + Duration::from_secs(30));
    assert!(!state.status().owned);
    assert_eq!(fake.lock().unwrap().text, None);
    assert_eq!(fake.lock().unwrap().clears, 2);
}

#[test]
fn later_user_copy_even_identical_text_is_preserved() {
    for replacement in ["synthetic-secret", "later-user-text"] {
        let (mut state, fake) = fixture();
        state.copy("synthetic-secret", Instant::now()).unwrap();
        {
            let mut fake = fake.lock().unwrap();
            fake.generation += 1;
            fake.text = Some(replacement.into());
        }
        state.clear_owned().unwrap();
        assert_eq!(fake.lock().unwrap().text.as_deref(), Some(replacement));
        assert_eq!(fake.lock().unwrap().clears, 1);
        assert!(!state.status().owned);
    }
}

#[test]
fn both_content_and_stable_generation_are_required_before_clear() {
    let (mut state, fake) = fixture();
    state.copy("synthetic-secret", Instant::now()).unwrap();
    fake.lock().unwrap().text = Some("other-content-with-same-count".into());
    state.clear_owned().unwrap();
    assert_eq!(fake.lock().unwrap().clears, 1);

    state.copy("synthetic-secret", Instant::now()).unwrap();
    fake.lock().unwrap().replace_during_read = true;
    state.clear_owned().unwrap();
    assert_eq!(fake.lock().unwrap().clears, 2);
    assert_eq!(
        fake.lock().unwrap().text.as_deref(),
        Some("synthetic-secret")
    );
}

#[test]
fn newer_app_copy_gets_its_own_deadline() {
    let (mut state, fake) = fixture();
    let now = Instant::now();
    state.copy("first", now).unwrap();
    state.copy("second", now + Duration::from_secs(20)).unwrap();
    state.expire(now + Duration::from_secs(30));
    assert_eq!(fake.lock().unwrap().text.as_deref(), Some("second"));
    state.expire(now + Duration::from_secs(50));
    assert_eq!(fake.lock().unwrap().text, None);
}

#[test]
fn cleanup_failure_stays_observable_and_explicit_retry_can_clear() {
    let (mut state, fake) = fixture();
    let now = Instant::now();
    state.copy("synthetic-secret", now).unwrap();
    fake.lock().unwrap().fail_clear = true;
    state.expire(now + CLEAR_AFTER);
    assert!(state.status().owned);
    assert_eq!(
        state.status().error,
        Some("credential_clipboard_cleanup_failed")
    );
    assert!(state.deadline.is_none());
    fake.lock().unwrap().fail_clear = false;
    state.error = state.clear_owned().err();
    assert!(!state.status().owned);
    assert!(state.status().error.is_none());
    assert_eq!(fake.lock().unwrap().text, None);
}

#[test]
fn inability_to_read_does_not_clear_unknown_content() {
    let (mut state, fake) = fixture();
    let now = Instant::now();
    state.copy("synthetic-secret", now).unwrap();
    fake.lock().unwrap().fail_read = true;
    state.expire(now + CLEAR_AFTER);
    assert_eq!(
        state.status().error,
        Some("credential_clipboard_read_failed")
    );
    assert_eq!(fake.lock().unwrap().clears, 1);
}

#[test]
fn copy_failure_cannot_report_success_and_retains_conditional_cleanup() {
    let (mut state, fake) = fixture();
    let now = Instant::now();
    fake.lock().unwrap().fail_write = true;
    assert_eq!(
        state.copy("synthetic-secret", now),
        Err("credential_clipboard_write_failed")
    );
    assert!(state.status().owned);
    state.expire(now + CLEAR_AFTER);
    assert!(state.status().owned);
    assert_eq!(
        state.status().error,
        Some("credential_clipboard_read_failed")
    );
    assert_eq!(fake.lock().unwrap().text, None);
}

#[test]
fn wrapper_is_send_sync_reuses_one_worker_and_drop_clears_its_copy() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<CredentialClipboard>();
    let fake = Arc::new(Mutex::new(FakeState::default()));
    let clipboard = CredentialClipboard::with_board(Box::new(FakePasteboard(Arc::clone(&fake))));
    assert!(clipboard.worker.lock().unwrap().is_none());
    clipboard.copy_text("first").unwrap();
    let worker_id = clipboard
        .worker
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .thread()
        .id();
    clipboard.copy_text("second").unwrap();
    assert_eq!(
        clipboard
            .worker
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .thread()
            .id(),
        worker_id
    );
    assert!(clipboard.status().owned);
    drop(clipboard);
    assert_eq!(fake.lock().unwrap().text, None);
}

#[test]
fn lock_cleanup_is_immediate_idempotent_and_surfaces_errors() {
    let fake = Arc::new(Mutex::new(FakeState::default()));
    let clipboard = CredentialClipboard::with_board(Box::new(FakePasteboard(Arc::clone(&fake))));
    clipboard.copy_text("synthetic-secret").unwrap();
    fake.lock().unwrap().fail_clear = true;
    assert_eq!(
        clipboard.clear_owned(),
        Err("credential_clipboard_cleanup_failed")
    );
    assert_eq!(
        clipboard.status().error,
        Some("credential_clipboard_cleanup_failed")
    );
    fake.lock().unwrap().fail_clear = false;
    clipboard.clear_owned().unwrap();
    clipboard.clear_owned().unwrap();
    assert!(!clipboard.status().owned);
    assert!(clipboard.status().error.is_none());
    assert_eq!(fake.lock().unwrap().clears, 2);
}

#[test]
fn drop_recovers_poisoned_state_and_worker_locks_without_waiting_on_itself() {
    let fake = Arc::new(Mutex::new(FakeState::default()));
    let clipboard = CredentialClipboard::with_board(Box::new(FakePasteboard(Arc::clone(&fake))));
    clipboard.copy_text("synthetic-secret").unwrap();
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _worker = clipboard.worker.lock().unwrap();
        let _state = clipboard.shared.state.lock().unwrap();
        panic!("synthetic poison fixture");
    }));
    assert!(poisoned.is_err());
    assert_eq!(
        clipboard.status().error,
        Some("credential_clipboard_unavailable")
    );
    drop(clipboard);
    assert_eq!(fake.lock().unwrap().text, None);
}

// This adapter exists only in this test module. The UUID-like native name is
// resolved on each call so no Objective-C object crosses a Rust thread boundary.
#[cfg(target_os = "macos")]
#[derive(Clone)]
struct NamedNativePasteboard(String);

#[cfg(target_os = "macos")]
impl NamedNativePasteboard {
    fn new() -> Self {
        objc2::rc::autoreleasepool(|_| {
            Self(
                objc2_app_kit::NSPasteboard::pasteboardWithUniqueName()
                    .name()
                    .to_string(),
            )
        })
    }

    fn with_board<T>(&self, operation: impl FnOnce(&objc2_app_kit::NSPasteboard) -> T) -> T {
        objc2::rc::autoreleasepool(|_| {
            let name = objc2_foundation::NSString::from_str(&self.0);
            operation(&objc2_app_kit::NSPasteboard::pasteboardWithName(&name))
        })
    }
}

#[cfg(target_os = "macos")]
impl Pasteboard for NamedNativePasteboard {
    fn change_count(&mut self) -> ClipboardResult<isize> {
        self.with_board(|board| Ok(board.changeCount()))
    }

    fn text_digest(&mut self) -> ClipboardResult<Option<[u8; 32]>> {
        self.with_board(|board| {
            let text = board.stringForType(unsafe { objc2_app_kit::NSPasteboardTypeString });
            Ok(text.map(|text| digest(&text.to_string())))
        })
    }

    fn clear(&mut self) -> ClipboardResult<isize> {
        self.with_board(|board| Ok(board.clearContents()))
    }

    fn set_text(&mut self, text: &str) -> ClipboardResult<()> {
        self.with_board(|board| {
            let text = objc2_foundation::NSString::from_str(text);
            if board.setString_forType(&text, unsafe { objc2_app_kit::NSPasteboardTypeString }) {
                Ok(())
            } else {
                Err("credential_clipboard_write_failed")
            }
        })
    }
}

#[cfg(target_os = "macos")]
impl Drop for NamedNativePasteboard {
    fn drop(&mut self) {
        // This is a unique, synthetic test pasteboard, never the user's general
        // pasteboard. Remove its synthetic value even if an assertion unwinds.
        let _ = self.clear();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn native_named_pasteboard_ownership_tracks_actual_appkit_change_counts() {
    let mut other_writer = NamedNativePasteboard::new();
    let initial_count = other_writer.change_count().unwrap();
    let mut state = ClipboardState {
        board: Box::new(other_writer.clone()),
        owned: None,
        deadline: None,
        error: None,
        stopping: false,
    };
    state
        .copy("synthetic-native-secret", Instant::now())
        .unwrap();
    let copied_count = other_writer.change_count().unwrap();
    assert_eq!(copied_count, initial_count + 1);
    assert_eq!(state.owned.as_ref().unwrap().generation, copied_count);
    assert_eq!(
        other_writer.text_digest().unwrap(),
        Some(digest("synthetic-native-secret"))
    );
    state.clear_owned().unwrap();
    assert_eq!(other_writer.change_count().unwrap(), copied_count + 1);
    assert_eq!(other_writer.text_digest().unwrap(), None);

    state
        .copy("synthetic-native-secret", Instant::now())
        .unwrap();
    let first_owner_count = state.owned.as_ref().unwrap().generation;
    let later_owner_count = other_writer.clear().unwrap();
    other_writer.set_text("synthetic-native-secret").unwrap();
    assert_eq!(later_owner_count, first_owner_count + 1);
    assert_eq!(other_writer.change_count().unwrap(), later_owner_count);
    state.clear_owned().unwrap();
    assert!(!state.status().owned);
    assert_eq!(other_writer.change_count().unwrap(), later_owner_count);
    assert_eq!(
        other_writer.text_digest().unwrap(),
        Some(digest("synthetic-native-secret"))
    );
}
