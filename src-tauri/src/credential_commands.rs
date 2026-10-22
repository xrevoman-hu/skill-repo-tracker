//! GUI adapter for a lazy, same-executable child. No Keychain API runs in this process.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    io::BufReader,
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State, WebviewWindow};

use crate::{
    api_err,
    credential_clipboard::{ClipboardStatus, CredentialClipboard},
    ApiResponse, AppError, AppState, CommandResult,
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Status,
    Create,
    Unlock,
    Lock,
    List,
    Detail,
    Save,
    Delete,
    Verify,
    ReadFields,
    CopySecret,
    InvalidateSession,
    Share,
    ResetAccess,
    AuthorizeAccess,
    RetryCleanup,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CredentialRequest {
    action: Action,
    #[serde(flatten)]
    arguments: Map<String, Value>,
}

struct Connection {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    executable: PathBuf,
    vault_id: String,
}

fn read_response(reader: &mut BufReader<ChildStdout>) -> Result<Value, &'static str> {
    crate::credential_protocol::read_line(reader)?.ok_or("credential_host_unavailable")
}

impl Connection {
    fn exchange(&mut self, request: &Value) -> Result<Value, &'static str> {
        if !crate::credential_protocol::fits_frame(request) {
            return Err("credential_request_too_large");
        }
        let input = self.input.as_mut().ok_or("credential_host_unavailable")?;
        crate::credential_protocol::write_line(input, request)?;
        let response = read_response(&mut self.output)?;
        if response.get("ok") == Some(&Value::Bool(true)) {
            response
                .get("result")
                .cloned()
                .ok_or("credential_host_protocol_invalid")
        } else {
            // The subprocess returns only reviewed fixed codes. Never expose its raw output.
            Err(error_code(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("credential_host_unavailable"),
            ))
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Closing the sole control pipe makes the host lock and clean its own leases.
        self.input.take();
        for _ in 0..25 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // A stuck OS authorization prompt must not leave an orphan credential host.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Delivery {
    generation: u64,
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

pub(crate) struct CredentialClient {
    root: PathBuf,
    connection: Mutex<Option<Connection>>,
    delivery: Mutex<Delivery>,
    clipboard: Box<dyn ClipboardPort>,
}

impl CredentialClient {
    pub(crate) fn new(data_dir: &std::path::Path) -> Self {
        Self {
            root: data_dir.join("credentials"),
            connection: Mutex::new(None),
            delivery: Mutex::new(Delivery::default()),
            clipboard: Box::new(CredentialClipboard::new()),
        }
    }

    fn start_host(&self) -> Result<Connection, &'static str> {
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
        let mut connection = Connection {
            child,
            input,
            output: BufReader::new(output),
            executable,
            vault_id: String::new(),
        };
        let ready = read_response(&mut connection.output)?;
        let vault_id = ready
            .get("vaultId")
            .and_then(Value::as_str)
            .ok_or("credential_host_protocol_invalid")?;
        if ready.get("event").and_then(Value::as_str) != Some("ready")
            || vault_id.len() != 64
            || !vault_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("credential_host_protocol_invalid");
        }
        connection.vault_id = vault_id.to_owned();
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

    fn invalidate_for(&self, action: Action) -> Result<u64, &'static str> {
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
        ) {
            delivery.generation = delivery
                .generation
                .checked_add(1)
                .ok_or("generation_exhausted")?;
            delivery.session = None;
            // Closing a drawer or switching apps must preserve the value long
            // enough to paste. Only lock/expiry/exit clear an owned copy.
            if action == Action::Lock {
                let _ = self.clipboard.clear_owned();
            }
        }
        Ok(delivery.generation)
    }

    fn perform(
        &self,
        request: CredentialRequest,
        window: &WebviewWindow,
        generation: u64,
    ) -> Result<Value, &'static str> {
        let action = request.action;
        let session = request
            .arguments
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if matches!(action, Action::ReadFields | Action::CopySecret) {
            let delivery = self
                .delivery
                .lock()
                .map_err(|_| "credential_host_unavailable")?;
            if session.is_none() || delivery.session != session || delivery.generation != generation
            {
                return Err("human_verification_required");
            }
        }
        let mut serialized = serde_json::to_value(&request).map_err(|_| "invalid_arguments")?;
        if action == Action::CopySecret {
            let field = request
                .arguments
                .get("field")
                .and_then(Value::as_str)
                .ok_or("invalid_secret_field")?;
            serialized["action"] = json!("read_fields");
            serialized["fields"] = json!([field]);
            serialized
                .as_object_mut()
                .ok_or("invalid_arguments")?
                .remove("field");
        }
        let mut slot = self
            .connection
            .lock()
            .map_err(|_| "credential_host_unavailable")?;
        if slot.is_none() {
            *slot = Some(self.start_host()?);
        }
        let connection = slot.as_mut().ok_or("credential_host_unavailable")?;
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
        let connection = slot.as_mut().ok_or("credential_host_unavailable")?;
        // is_focused may synchronously dispatch to the main thread. Call it
        // before taking delivery: the main-thread focus callback takes that lock.
        let focus = if matches!(
            action,
            Action::Verify | Action::ReadFields | Action::CopySecret
        ) {
            window.label() == "main"
                && window
                    .is_focused()
                    .map_err(|_| "window_focus_unavailable")?
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
        if stale && !matches!(action, Action::Lock | Action::InvalidateSession) {
            return Err("stale_generation");
        }
        if matches!(
            action,
            Action::Verify | Action::ReadFields | Action::CopySecret
        ) && !focus
        {
            delivery.generation = delivery.generation.saturating_add(1);
            delivery.session = None;
            return Err("human_session_invalid");
        }
        if action == Action::Verify {
            delivery.session = session;
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
        ) {
            result["bridgeCommand"] = json!(connection.executable);
            result["bridgeArgs"] = json!([
                "--credential-bridge",
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
    let response =
        tauri::async_runtime::spawn_blocking(move || client.perform(request, &window, generation))
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

fn message(code: &str) -> &'static str {
    match code {
        "password_or_vault_invalid" => "主密码不正确，或凭据库无法验证。",
        "password_confirmation_mismatch" => "两次输入的主密码不一致。",
        "password_length_invalid" => "主密码至少12个字符，且不能超过1024字节。",
        "password_retry_later" => "验证失败次数过多，请稍后重试。",
        "vault_locked" => "凭据库已锁定，请先解锁。",
        "record_not_found" => "记录不存在或已被删除。",
        "record_version_conflict" => "记录已更新，请重新加载后编辑。",
        "human_verification_required" | "human_session_invalid" | "stale_generation" => {
            "当前验证已失效，请重新验证。"
        }
        "record_required_fields_missing" => "请填写当前类型的必填定位字段。",
        "record_required_secret_missing" => "当前类型的必填秘密不能为空。",
        "ssh_private_key_file_required" => "SSH凭据需要导入私钥文件。",
        "record_port_invalid" => "端口必须是1至65535的整数。",
        "record_url_invalid" => "请输入不含账号密码的HTTP或HTTPS网址。",
        "record_host_invalid" => "主机只能填写主机名或IP，不能包含连接串。",
        "secret_limit_exceeded" => "秘密文本不能超过1MiB。",
        "file_limit_exceeded" => "单次保存的附件原字节总量不能超过16MiB。",
        "file_not_text" => "此文件不是UTF-8文本，请使用原文件导出。",
        "secret_text_response_too_large" => "此文件作为文本显示时超过传输上限，请使用原文件导出。",
        "credential_authorization_required" | "credential_authorization_denied" => {
            "需要恢复系统钥匙串授权，请在设置中明确授权。"
        }
        "credential_authorization_cancelled" => "系统钥匙串授权已取消。",
        "clipboard_changed" => "剪贴板已变化，未清除其他复制内容。",
        _ => "凭据操作未完成，请检查输入后重试；已保存的数据不会被错误内容覆盖。",
    }
}

fn error_code(code: &str) -> &'static str {
    const CODES: &[&str] = &[
        "vault_already_exists",
        "vault_already_unlocked",
        "vault_locked",
        "vault_storage_failed",
        "vault_data_invalid",
        "password_or_vault_invalid",
        "password_confirmation_mismatch",
        "password_length_invalid",
        "password_required",
        "password_retry_later",
        "record_not_found",
        "record_version_conflict",
        "record_version_exhausted",
        "record_fields_invalid",
        "record_name_or_type_invalid",
        "record_type_immutable",
        "record_note_too_large",
        "record_required_fields_missing",
        "record_required_secret_missing",
        "record_port_invalid",
        "record_url_invalid",
        "record_host_invalid",
        "record_files_invalid",
        "ssh_private_key_file_required",
        "invalid_record_id",
        "invalid_secret_field",
        "field_not_found",
        "fields_required",
        "invalid_field_count",
        "secret_limit_exceeded",
        "file_limit_exceeded",
        "file_not_text",
        "secret_text_response_too_large",
        "human_verification_required",
        "human_session_invalid",
        "human_session_limit",
        "session_id_required",
        "stale_generation",
        "vault_record_limit",
        "invalid_search_bounds",
        "cleanup_failed",
        "sharing_state_write_failed",
        "sharing_state_invalid",
        "credential_authorization_required",
        "credential_authorization_denied",
        "credential_authorization_cancelled",
        "credential_store_unavailable",
        "credential_store_changed",
        "credential_store_write_not_verified",
        "agent_access_missing",
        "invalid_access_material",
        "vault_identity_or_format_mismatch",
        "vault_unavailable",
        "vault_key_failed",
        "encryption_engine_unavailable",
        "generation_exhausted",
        "unsafe_path_permissions",
        "path_unavailable",
        "private_file_create_failed",
        "lease_cleanup_failed",
        "lease_journal_failed",
    ];
    CODES
        .iter()
        .copied()
        .find(|known| *known == code)
        .unwrap_or("credential_host_unavailable")
}

#[cfg(test)]
#[path = "credential_commands_tests.rs"]
mod tests;
