//! Secret clipboard ownership is a native generation plus a digest, never text alone.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const CLEAR_AFTER: Duration = Duration::from_secs(30);
type ClipboardResult<T> = Result<T, &'static str>;

#[derive(Clone, Serialize)]
pub(crate) struct ClipboardStatus {
    pub(crate) owned: bool,
    pub(crate) error: Option<&'static str>,
}

trait Pasteboard: Send {
    fn change_count(&mut self) -> ClipboardResult<isize>;
    fn text_digest(&mut self) -> ClipboardResult<Option<[u8; 32]>>;
    fn clear(&mut self) -> ClipboardResult<isize>;
    fn set_text(&mut self, text: &str) -> ClipboardResult<()>;
}

struct Ownership {
    generation: isize,
    digest: [u8; 32],
}

struct ClipboardState {
    board: Box<dyn Pasteboard>,
    owned: Option<Ownership>,
    deadline: Option<Instant>,
    error: Option<&'static str>,
    stopping: bool,
}

fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

impl ClipboardState {
    fn copy(&mut self, text: &str, now: Instant) -> ClipboardResult<()> {
        let generation = self.board.clear()?;
        self.owned = Some(Ownership {
            generation,
            digest: digest(text),
        });
        self.deadline = Some(now + CLEAR_AFTER);
        // Retain the attempted ownership even on failure so lock/drop can retry
        // conditional cleanup; no plaintext is kept in the worker state.
        self.board.set_text(text)?;
        if !self.matches_owned()? {
            self.owned = None;
            self.deadline = None;
            return Err("credential_clipboard_copy_interrupted");
        }
        Ok(())
    }

    fn matches_owned(&mut self) -> ClipboardResult<bool> {
        let Some(owned) = self.owned.as_ref() else {
            return Ok(false);
        };
        if self.board.change_count()? != owned.generation {
            return Ok(false);
        }
        let current_digest = self
            .board
            .text_digest()?
            .ok_or("credential_clipboard_read_failed")?;
        Ok(current_digest == owned.digest && self.board.change_count()? == owned.generation)
    }

    fn clear_owned(&mut self) -> ClipboardResult<()> {
        // A failed cleanup remains visible and can be retried explicitly. Do
        // not continuously poll the system clipboard after a denied operation.
        self.deadline = None;
        if self.matches_owned()? {
            let expected = self
                .owned
                .as_ref()
                .and_then(|owned| owned.generation.checked_add(1))
                .ok_or("credential_clipboard_cleanup_failed")?;
            // NSPasteboard has no compare-and-clear primitive across processes.
            // Count + digest + count avoid clearing any already-observed later
            // write, including identical text; this is not an OS atomic CAS.
            if self.board.clear()? != expected {
                return Err("credential_clipboard_cleanup_failed");
            }
        }
        self.owned = None;
        Ok(())
    }

    fn expire(&mut self, now: Instant) {
        if self.deadline.is_some_and(|deadline| deadline <= now) {
            self.error = self.clear_owned().err();
        }
    }

    fn status(&self) -> ClipboardStatus {
        ClipboardStatus {
            owned: self.owned.is_some(),
            error: self.error,
        }
    }
}

struct Shared {
    state: Mutex<ClipboardState>,
    changed: Condvar,
}

pub(crate) struct CredentialClipboard {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl CredentialClipboard {
    pub(crate) fn new() -> Self {
        Self::with_board(Box::new(NativePasteboard))
    }

    fn with_board(board: Box<dyn Pasteboard>) -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(ClipboardState {
                    board,
                    owned: None,
                    deadline: None,
                    error: None,
                    stopping: false,
                }),
                changed: Condvar::new(),
            }),
            worker: Mutex::new(None),
        }
    }

    fn start_worker(&self) -> ClipboardResult<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "credential_clipboard_unavailable")?;
        if worker.is_none() {
            let shared = Arc::clone(&self.shared);
            *worker = Some(
                std::thread::Builder::new()
                    .name("credential-clipboard".into())
                    .spawn(move || cleanup_worker(shared))
                    .map_err(|_| "credential_clipboard_unavailable")?,
            );
        }
        Ok(())
    }

    // The caller also holds the short delivery lock while rechecking its
    // session epoch. This mutex serializes copy/expiry/lock native operations.
    pub(crate) fn copy_text(&self, text: &str) -> ClipboardResult<()> {
        self.start_worker()?;
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "credential_clipboard_unavailable")?;
        let result = state.copy(text, Instant::now());
        state.error = result.err();
        self.shared.changed.notify_one();
        result
    }

    pub(crate) fn clear_owned(&self) -> ClipboardResult<()> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "credential_clipboard_unavailable")?;
        let result = state.clear_owned();
        state.error = result.err();
        self.shared.changed.notify_one();
        result
    }

    pub(crate) fn status(&self) -> ClipboardStatus {
        self.shared
            .state
            .lock()
            .map(|state| state.status())
            .unwrap_or(ClipboardStatus {
                owned: true,
                error: Some("credential_clipboard_unavailable"),
            })
    }
}

fn cleanup_worker(shared: Arc<Shared>) {
    let Ok(mut state) = shared.state.lock() else {
        return;
    };
    loop {
        if state.stopping {
            break;
        }
        state.expire(Instant::now());
        let next = match state.deadline {
            Some(deadline) => shared
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(Instant::now()))
                .map(|(state, _)| state)
                .map_err(|_| ()),
            None => shared.changed.wait(state).map_err(|_| ()),
        };
        match next {
            Ok(next) => state = next,
            Err(_) => break,
        }
    }
}

impl Drop for CredentialClipboard {
    fn drop(&mut self) {
        {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.stopping = true;
            state.error = state.clear_owned().err();
            self.shared.changed.notify_one();
        }
        if let Some(worker) = self
            .worker
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

struct NativePasteboard;

#[cfg(target_os = "macos")]
impl Pasteboard for NativePasteboard {
    fn change_count(&mut self) -> ClipboardResult<isize> {
        objc2::rc::autoreleasepool(|_| {
            Ok(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount())
        })
    }

    fn text_digest(&mut self) -> ClipboardResult<Option<[u8; 32]>> {
        objc2::rc::autoreleasepool(|_| {
            let board = objc2_app_kit::NSPasteboard::generalPasteboard();
            // The framework exports this immutable NSString constant.
            let text = board.stringForType(unsafe { objc2_app_kit::NSPasteboardTypeString });
            Ok(text.map(|text| digest(&text.to_string())))
        })
    }

    fn clear(&mut self) -> ClipboardResult<isize> {
        objc2::rc::autoreleasepool(|_| {
            Ok(objc2_app_kit::NSPasteboard::generalPasteboard().clearContents())
        })
    }

    fn set_text(&mut self, text: &str) -> ClipboardResult<()> {
        objc2::rc::autoreleasepool(|_| {
            let board = objc2_app_kit::NSPasteboard::generalPasteboard();
            let text = objc2_foundation::NSString::from_str(text);
            // The framework exports this immutable NSString constant.
            if board.setString_forType(&text, unsafe { objc2_app_kit::NSPasteboardTypeString }) {
                Ok(())
            } else {
                Err("credential_clipboard_write_failed")
            }
        })
    }
}

#[cfg(not(target_os = "macos"))]
impl Pasteboard for NativePasteboard {
    fn change_count(&mut self) -> ClipboardResult<isize> {
        Err("credential_clipboard_platform_unverified")
    }

    fn text_digest(&mut self) -> ClipboardResult<Option<[u8; 32]>> {
        Err("credential_clipboard_platform_unverified")
    }

    fn clear(&mut self) -> ClipboardResult<isize> {
        Err("credential_clipboard_platform_unverified")
    }

    fn set_text(&mut self, _text: &str) -> ClipboardResult<()> {
        Err("credential_clipboard_platform_unverified")
    }
}

#[cfg(test)]
#[path = "credential_clipboard_tests.rs"]
mod tests;
