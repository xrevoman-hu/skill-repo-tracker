//! GUI adapter for a locked, same-executable child. No Keychain API runs in this process.

use base64::Engine;
use serde_json::{json, Value};
use std::{
    io::BufReader,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    api_err,
    credential_clipboard::{ClipboardStatus, CredentialClipboard},
    credential_command_errors::message,
    credential_command_model::{Action, CredentialRequest},
    credential_host_connection::HostConnection,
    ApiResponse, AppError, AppState, CommandResult,
};

#[derive(Default)]
struct Delivery {
    generation: u64,
    cancellation: u64,
    session: Option<String>,
}

trait ClipboardPort: Send + Sync {
    fn copy_text(&self, text: &str) -> Result<(), &'static str>;
    fn clear_owned(&self) -> Result<(), &'static str>;
    fn status(&self) -> ClipboardStatus;
}

impl ClipboardPort for CredentialClipboard {
    fn copy_text(&self, text: &str) -> Result<(), &'static str> {
        CredentialClipboard::copy_text(self, text)
    }
    fn clear_owned(&self) -> Result<(), &'static str> {
        CredentialClipboard::clear_owned(self)
    }
    fn status(&self) -> ClipboardStatus {
        CredentialClipboard::status(self)
    }
}

trait NativeWindow {
    fn focused(&self) -> Result<bool, &'static str>;
    fn save_file(&self, name: &str, backup: bool) -> Result<Option<PathBuf>, &'static str>;
    fn open_backup(&self) -> Result<Option<PathBuf>, &'static str>;
}

impl NativeWindow for WebviewWindow {
    fn focused(&self) -> Result<bool, &'static str> {
        Ok(self.label() == "main" && self.is_focused().map_err(|_| "window_focus_unavailable")?)
    }

    fn save_file(&self, name: &str, backup: bool) -> Result<Option<PathBuf>, &'static str> {
        let mut picker = self.app_handle().dialog().file().set_file_name(name);
        if backup {
            picker = picker.add_filter("Encrypted credential vault", &["srtvault"]);
        }
        picker
            .blocking_save_file()
            .map(|path| path.into_path().map_err(|_| "selected_file_invalid"))
            .transpose()
    }

    fn open_backup(&self) -> Result<Option<PathBuf>, &'static str> {
        self.app_handle()
            .dialog()
            .file()
            .add_filter("Encrypted credential vault", &["srtvault"])
            .blocking_pick_file()
            .map(|path| path.into_path().map_err(|_| "selected_file_invalid"))
            .transpose()
    }
}

pub(crate) struct CredentialClient {
    root: PathBuf,
    connection: Mutex<Option<HostConnection>>,
    delivery: Mutex<Delivery>,
    clipboard: Box<dyn ClipboardPort>,
    selections: Mutex<crate::credential_file_io::Selections>,
}

impl CredentialClient {
    pub(crate) fn new(data_dir: &std::path::Path) -> Self {
        let client = Self {
            root: data_dir.join("credentials"),
            connection: Mutex::new(None),
            delivery: Mutex::new(Delivery::default()),
            clipboard: Box::new(CredentialClipboard::new()),
            selections: Mutex::new(crate::credential_file_io::Selections::default()),
        };
        // A failed cleanup remains in its durable journal. The ordinary status
        // and retry paths expose it; startup never unlocks or requests OS UI.
        let _ = client.start_existing(Self::start_host);
        client
    }

    fn start_existing(
        &self,
        start: impl FnOnce(&Self) -> Result<HostConnection, &'static str>,
    ) -> Result<(), &'static str> {
        if !self
            .root
            .join("vault.json")
            .try_exists()
            .map_err(|_| "credential_host_unavailable")?
        {
            return Ok(());
        }
        let mut slot = self
            .connection
            .lock()
            .map_err(|_| "credential_host_unavailable")?;
        *slot = Some(start(self)?);
        // The ready response guarantees a locked host owns the root lock before
        // GUI-owned export staging is recovered. Unknown roots stay unmodified.
        crate::credential_export_journal::cleanup(&self.root)
    }

    fn start_host(&self) -> Result<HostConnection, &'static str> {
        let executable = std::env::current_exe().map_err(|_| "credential_host_unavailable")?;
        let executable = executable
            .canonicalize()
            .map_err(|_| "credential_host_unavailable")?;
        let mut child = Command::new(&executable)
            .arg("--credential-host")
            .arg("--root")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "credential_host_unavailable")?;
        let input = child.stdin.take();
        let Some(output) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("credential_host_unavailable");
        };
        let mut connection = HostConnection {
            child,
            input,
            output: BufReader::new(output),
            executable,
            vault_id: String::new(),
        };
        connection.accept_ready()?;
        Ok(connection)
    }

    pub(crate) fn invalidate_focus(&self) {
        if let Ok(mut delivery) = self.delivery.lock() {
            delivery.generation = delivery.generation.saturating_add(1);
            delivery.session = None;
        }
    }

    pub(crate) fn clear_on_exit(&self) {
        if let Ok(mut delivery) = self.delivery.lock() {
            delivery.generation = delivery.generation.saturating_add(1);
            delivery.session = None;
            let _ = self.clipboard.clear_owned();
        }
    }

    fn invalidate_for(&self, action: Action) -> Result<(u64, u64), &'static str> {
        let mut delivery = self
            .delivery
            .lock()
            .map_err(|_| "credential_host_unavailable")?;
        if matches!(
            action,
            Action::InvalidateSession
                | Action::Lock
                | Action::Save
                | Action::Delete
                | Action::ResetAccess
                | Action::Share
                | Action::RestorePick
                | Action::RestorePreview
                | Action::RestoreCommit
                | Action::RestoreCancel
                | Action::ChangePassword
        ) {
            delivery.generation = delivery
                .generation
                .checked_add(1)
                .ok_or("generation_exhausted")?;
            delivery.session = None;
            // WebView blur also sends invalidate_session. It must revoke
            // secret delivery without cancelling the native picker itself.
            if action != Action::InvalidateSession {
                delivery.cancellation = delivery
                    .cancellation
                    .checked_add(1)
                    .ok_or("generation_exhausted")?;
            }
            if matches!(
                action,
                Action::Lock
                    | Action::RestorePick
                    | Action::RestorePreview
                    | Action::RestoreCommit
                    | Action::ChangePassword
                    | Action::Save
                    | Action::Delete
            ) {
                self.selections
                    .lock()
                    .map_err(|_| "credential_host_unavailable")?
                    .export = None;
            }
            // Closing a drawer or switching apps must preserve the value long
            // enough to paste. Only lock/expiry/exit clear an owned copy.
            if matches!(
                action,
                Action::Lock
                    | Action::RestorePick
                    | Action::RestorePreview
                    | Action::RestoreCommit
                    | Action::ChangePassword
            ) {
                let _ = self.clipboard.clear_owned();
            }
        }
        Ok((delivery.generation, delivery.cancellation))
    }

    fn perform(
        &self,
        request: CredentialRequest,
        window: &dyn NativeWindow,
        stamp: (u64, u64),
        mut start: impl FnMut(&Self) -> Result<HostConnection, &'static str>,
    ) -> Result<Value, &'static str> {
        let mut slot = self
            .connection
            .lock()
            .map_err(|_| "credential_host_unavailable")?;
        let export = request.action == Action::ExportFile;
        let result = self.perform_inner(request, window, stamp, &mut slot, &mut start);
        // All staged values have dropped, but no other GUI operation can unlock
        // or export until the same connection guard finishes cleanup and locking.
        if export {
            self.finish_export(result, &mut slot)
        } else {
            result
        }
    }

    fn lock_after_cleanup_failure(
        &self,
        slot: &mut Option<HostConnection>,
    ) -> Result<Value, &'static str> {
        self.invalidate_focus();
        let _ = self.clipboard.clear_owned();
        let response = slot
            .as_mut()
            .ok_or("credential_host_unavailable")
            .and_then(|connection| {
                connection.exchange(&json!({"action":"lock"})).or_else(|_| {
                    // A valid lease-cleanup failure still locks the host. Confirm
                    // that state before preserving its retryable cleanup report.
                    connection.exchange(&json!({"action":"status"}))
                })
            });
        match response {
            Ok(status) if status.get("locked") == Some(&Value::Bool(true)) => Ok(status),
            _ => {
                // Closing the control pipe stops the host if locking cannot be confirmed.
                *slot = None;
                Err("export_cleanup_failed")
            }
        }
    }

    fn finish_export(
        &self,
        result: Result<Value, &'static str>,
        slot: &mut Option<HostConnection>,
    ) -> Result<Value, &'static str> {
        let cleanup_failed =
            slot.is_some() && crate::credential_export_journal::cleanup(&self.root).is_err();
        if cleanup_failed
            || matches!(
                result,
                Err("export_cleanup_failed" | "file_export_cleanup_failed")
            )
        {
            let published = matches!(&result, Ok(value) if value.get("exported") == Some(&Value::Bool(true)))
                || matches!(result, Err("file_export_cleanup_failed"));
            let _ = self.lock_after_cleanup_failure(slot);
            return Err(if published {
                "file_export_cleanup_failed"
            } else {
                "export_cleanup_failed"
            });
        }
        result
    }

    fn perform_inner(
        &self,
        request: CredentialRequest,
        window: &dyn NativeWindow,
        stamp: (u64, u64),
        slot: &mut Option<HostConnection>,
        start: &mut dyn FnMut(&Self) -> Result<HostConnection, &'static str>,
    ) -> Result<Value, &'static str> {
        let (mut generation, cancellation) = stamp;
        let action = request.action;
        let session = request
            .arguments
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        request.validate_gui()?;
        if matches!(
            action,
            Action::ReadFields | Action::CopySecret | Action::ExportFile | Action::InspectFiles
        ) {
            let delivery = self
                .delivery
                .lock()
                .map_err(|_| "credential_host_unavailable")?;
            if session.is_none() || delivery.session != session || delivery.generation != generation
            {
                return Err("human_verification_required");
            }
        }
        let mut serialized = request.control_request()?;
        if self
            .delivery
            .lock()
            .map_err(|_| "credential_host_unavailable")?
            .cancellation
            != cancellation
        {
            return Err("stale_generation");
        }
        if slot.is_none() {
            *slot = Some(start(self)?);
        }
        if crate::credential_export_journal::cleanup(&self.root).is_err() {
            let mut status = self.lock_after_cleanup_failure(slot)?;
            if matches!(action, Action::Status | Action::Lock | Action::RetryCleanup) {
                status["cleanupFailed"] = json!(true);
                status["cleanupRemaining"] =
                    json!(status["cleanupRemaining"].as_u64().unwrap_or(0) + 1);
                return Ok(status);
            }
            return Err("export_cleanup_failed");
        }
        let connection = slot.as_mut().ok_or("credential_host_unavailable")?;
        let native_outcome = self.native_intent(&request, &mut serialized, connection, window);
        if matches!(
            native_outcome,
            Err("credential_host_unavailable" | "credential_host_protocol_invalid")
        ) {
            *slot = None;
            self.invalidate_focus();
            return Err("credential_host_unavailable");
        }
        if let Some(result) = native_outcome? {
            let delivery = self
                .delivery
                .lock()
                .map_err(|_| "credential_host_unavailable")?;
            if delivery.cancellation != cancellation {
                let mut selections = self
                    .selections
                    .lock()
                    .map_err(|_| "credential_host_unavailable")?;
                selections.export = None;
                selections.restore = None;
                return Err("stale_generation");
            }
            return Ok(result);
        }
        {
            let delivery = self
                .delivery
                .lock()
                .map_err(|_| "credential_host_unavailable")?;
            if delivery.cancellation != cancellation {
                return Err("stale_generation");
            }
            // A native save panel blurs the window. Ciphertext backup needs no
            // human record session; explicit lock/cancel still cancels above.
            if action == Action::BackupCreate {
                generation = delivery.generation;
            }
        }
        let outcome = connection.exchange(&serialized);
        if matches!(
            outcome,
            Err("credential_host_unavailable" | "credential_host_protocol_invalid")
        ) {
            *slot = None;
            self.invalidate_focus();
            return Err("credential_host_unavailable");
        }
        let mut result = outcome?;
        if action == Action::RestoreCommit
            && result.get("restartRequired") == Some(&Value::Bool(true))
        {
            *slot = None;
            let durability_warning = result.get("durabilityWarning") == Some(&Value::Bool(true));
            // The disk switch has committed. A restart failure must not claim
            // that restoration failed or that the original vault is unchanged.
            match start(self).and_then(|mut next| {
                let status = next.exchange(&json!({"action":"status"}))?;
                Ok((next, status))
            }) {
                Ok((next, mut status)) => {
                    *slot = Some(next);
                    if durability_warning {
                        status["durabilityWarning"] = json!(true);
                    }
                    result = status;
                }
                Err(_) => {
                    result["sharing"] = json!(false);
                    return Ok(result);
                }
            }
        }
        let connection = slot.as_mut().ok_or("credential_host_unavailable")?;
        let staged = if action == Action::ExportFile {
            let id = request
                .arguments
                .get("selectionId")
                .and_then(Value::as_str)
                .ok_or("file_selection_required")?;
            let mut selections = self
                .selections
                .lock()
                .map_err(|_| "credential_host_unavailable")?;
            let selected = selections.export.take().ok_or("file_selection_required")?;
            if selected.id != id || selected.binding != request.export_binding()? {
                return Err("file_selection_required");
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(result["bytesBase64"].as_str().ok_or("file_export_failed")?)
                .map_err(|_| "file_export_failed")?;
            Some(selected.stage(&bytes, &self.root)?)
        } else {
            None
        };
        // is_focused may synchronously dispatch to the main thread. Call it
        // before taking delivery: the main-thread focus callback takes that lock.
        let focus = if matches!(
            action,
            Action::Verify
                | Action::ReadFields
                | Action::CopySecret
                | Action::ExportFile
                | Action::InspectFiles
        ) {
            window.focused()?
        } else {
            true
        };
        // The short delivery lock is never held while waiting for host/KDF/UI work.
        let mut delivery = self
            .delivery
            .lock()
            .map_err(|_| "credential_host_unavailable")?;
        let stale = delivery.generation != generation;
        if stale && matches!(action, Action::Create | Action::Unlock) {
            drop(delivery);
            let _ = connection.exchange(&json!({"action":"lock"}));
            return Err("stale_generation");
        }
        if stale && !action.completed_mutation() {
            return Err("stale_generation");
        }
        if matches!(
            action,
            Action::Verify
                | Action::ReadFields
                | Action::CopySecret
                | Action::ExportFile
                | Action::InspectFiles
        ) && !focus
        {
            delivery.generation = delivery.generation.saturating_add(1);
            delivery.session = None;
            return Err("human_session_invalid");
        }
        if action == Action::Verify {
            delivery.session = session;
        }
        if let Some(staged) = staged {
            staged.commit()?;
            return Ok(json!({"exported":true}));
        }
        if action == Action::CopySecret {
            let field = request
                .arguments
                .get("field")
                .and_then(Value::as_str)
                .ok_or("invalid_secret_field")?;
            let value = result["fields"]
                .get(field)
                .and_then(Value::as_str)
                .ok_or("field_not_found")?;
            self.clipboard.copy_text(value)?;
            return Ok(json!({"copied":true,"cleanupAfterSeconds":30}));
        }
        if matches!(
            action,
            Action::Status
                | Action::Create
                | Action::Unlock
                | Action::Lock
                | Action::Share
                | Action::ResetAccess
                | Action::AuthorizeAccess
                | Action::RetryCleanup
                | Action::RestoreCommit
                | Action::RestoreCancel
                | Action::ChangePassword
        ) {
            result["bridgeCommand"] = json!(connection.executable);
            result["bridgeArgs"] = json!([
                "--credential-mcp",
                "--root",
                self.root.to_string_lossy(),
                "--vault-id",
                connection.vault_id
            ]);
            result["clipboard"] = serde_json::to_value(self.clipboard.status())
                .map_err(|_| "clipboard_unavailable")?;
        }
        Ok(result)
    }

    fn native_intent(
        &self,
        request: &CredentialRequest,
        serialized: &mut Value,
        connection: &mut HostConnection,
        window: &dyn NativeWindow,
    ) -> Result<Option<Value>, &'static str> {
        use crate::credential_file_io::Selection;
        match request.action {
            Action::AgentGuide => {
                let client = request
                    .arguments
                    .get("client")
                    .and_then(Value::as_str)
                    .ok_or("agent_client_unsupported")?;
                let status = connection.exchange(&json!({"action":"status"}))?;
                return crate::credential_guides::generate(
                    client,
                    &connection.executable,
                    &self.root,
                    &status,
                )
                .map(Some);
            }
            Action::PrepareExport => {
                let binding = request.export_binding()?;
                let detail = connection.exchange(
                    &json!({"action":"detail","recordId":request.arguments["recordId"]}),
                )?;
                if detail["version"] != request.arguments["expectedVersion"] {
                    return Err("record_version_conflict");
                }
                let field = request
                    .arguments
                    .get("field")
                    .and_then(Value::as_str)
                    .ok_or("field_not_found")?;
                let name = detail["files"]
                    .as_array()
                    .and_then(|files| files.iter().find(|file| file["field"] == field))
                    .and_then(|file| file["name"].as_str())
                    .ok_or("field_not_found")?;
                let selected = window.save_file(name, false)?;
                let mut selections = self
                    .selections
                    .lock()
                    .map_err(|_| "credential_host_unavailable")?;
                selections.export = None;
                let Some(path) = selected else {
                    return Ok(Some(json!({"selectionId":null})));
                };
                let selected = Selection::capture(path, binding, &self.root, false)?;
                let result = json!({"selectionId":selected.id,"name":selected.name()});
                selections.export = Some(selected);
                return Ok(Some(result));
            }
            Action::RestorePick => {
                connection.exchange(&json!({"action":"lock"}))?;
                connection.exchange(&json!({"action":"restore_cancel"}))?;
                let selected = window.open_backup()?;
                let mut selections = self
                    .selections
                    .lock()
                    .map_err(|_| "credential_host_unavailable")?;
                selections.restore = None;
                let Some(path) = selected else {
                    return Ok(Some(json!({"selectionId":null})));
                };
                let selected = Selection::capture(path, "restore".into(), &self.root, true)?;
                let result = json!({"selectionId":selected.id,"name":selected.name()});
                selections.restore = Some(selected);
                return Ok(Some(result));
            }
            Action::RestorePreview => {
                let id = request
                    .arguments
                    .get("selectionId")
                    .and_then(Value::as_str)
                    .ok_or("file_selection_required")?;
                let selections = self
                    .selections
                    .lock()
                    .map_err(|_| "credential_host_unavailable")?;
                let selected = selections
                    .restore
                    .as_ref()
                    .filter(|selected| selected.id == id)
                    .ok_or("file_selection_required")?;
                selected.validate()?;
                serialized["path"] = json!(selected.path);
            }
            Action::RestoreCancel => {
                self.selections
                    .lock()
                    .map_err(|_| "credential_host_unavailable")?
                    .restore = None;
            }
            Action::BackupCreate => {
                let selected = window.save_file("credentials.srtvault", true)?;
                let Some(path) = selected else {
                    return Ok(Some(json!({"created":false,"cancelled":true})));
                };
                let selected = Selection::capture(path, "backup".into(), &self.root, false)?;
                selected.validate()?;
                serialized["path"] = json!(selected.path);
            }
            _ => {}
        }
        Ok(None)
    }
}

impl Drop for CredentialClient {
    fn drop(&mut self) {
        let _ = self.clipboard.clear_owned();
    }
}

pub(crate) fn register_focus(app: &tauri::App, client: &Arc<CredentialClient>) {
    let client = Arc::clone(client);
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                client.invalidate_focus();
            }
        });
    }
}

pub(crate) fn handle_exit(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if matches!(event, tauri::RunEvent::Exit) {
        app.state::<AppState>().credentials.clear_on_exit();
    }
}

#[tauri::command]
pub(crate) async fn credential_request(
    request: CredentialRequest,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<Value> {
    let client = Arc::clone(&state.credentials);
    // Cancellation advances the generation immediately on command entry, before
    // the blocking pool or the child pipe can queue this action behind a KDF.
    let generation = match client.invalidate_for(request.action) {
        Ok(value) => value,
        Err(code) => return Ok(api_err(AppError::new(code, message(code)))),
    };
    let response = tauri::async_runtime::spawn_blocking(move || {
        client.perform(request, &window, generation, CredentialClient::start_host)
    })
    .await;
    Ok(match response {
        Ok(Ok(value)) => ApiResponse::ok(value),
        Ok(Err(code)) => api_err(AppError::new(code, message(code))),
        Err(_) => api_err(AppError::new(
            "credential_host_unavailable",
            "凭据服务不可用，请锁定后重新打开软件。",
        )),
    })
}

#[cfg(test)]
#[path = "credential_commands_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "credential_command_flow_tests.rs"]
mod flow_tests;

#[cfg(test)]
#[path = "credential_command_file_tests.rs"]
mod file_tests;
