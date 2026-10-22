//! Product credential host. It runs only as a GUI-owned child, never in AppState.

use crate::{
    credential_auth, credential_backup, credential_ipc, credential_leases::Leases,
    credential_records::VaultStore,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

fn prepare_root(root: &Path, locked: bool) -> Result<String, &'static str> {
    if !root.is_absolute() {
        return Err("invalid_vault_root");
    }
    if !root.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(root)
            .map_err(|_| "vault_root_create_failed")?;
    }
    if fs::canonicalize(root).map_err(|_| "vault_root_unavailable")? != root {
        return Err("invalid_vault_root");
    }
    credential_ipc::private_path(root, true)?;
    credential_backup::recover(root)?;
    let marker = root.join("vault.json");
    if !marker.exists() {
        if fs::read_dir(root)
            .map_err(|_| "vault_root_unavailable")?
            .any(|entry| !entry.is_ok_and(|entry| locked && entry.file_name() == ".host.lock"))
        {
            return Err("vault_root_not_empty");
        }
        let vault_id = credential_auth::random_id()?;
        let mut file = credential_ipc::create_private(&marker)?;
        let bytes = serde_json::to_vec(&json!({"schema":"srt-credential-v1","vaultId":vault_id}))
            .map_err(|_| "vault_root_create_failed")?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "vault_root_create_failed")?;
    }
    let marker: Value = serde_json::from_slice(&credential_ipc::read_private(&marker, 512)?)
        .map_err(|_| "invalid_vault_root")?;
    let vault_id = marker
        .get("vaultId")
        .and_then(Value::as_str)
        .ok_or("invalid_vault_root")?;
    if !credential_auth::valid_id(vault_id)
        || marker != json!({"schema":"srt-credential-v1","vaultId":vault_id})
    {
        return Err("invalid_vault_root");
    }
    Ok(vault_id.to_owned())
}

struct HumanSession {
    id: String,
    record: String,
    version: i64,
    generation: u64,
}

pub(crate) struct ProductHost {
    root: PathBuf,
    vault_id: String,
    store: Option<VaultStore>,
    code: Option<String>,
    sharing: bool,
    authorization_error: Option<&'static str>,
    generation: u64,
    leases: Leases,
    cleanup_failed: bool,
    human: Option<HumanSession>,
    invalidated: HashSet<String>,
    password_failures: u32,
    retry_after: Option<Instant>,
    restore: Option<credential_backup::PreparedRestore>,
    access_reset: bool,
}

impl ProductHost {
    fn open(root: &Path, vault_id: &str) -> Result<Self, &'static str> {
        let (leases, cleanup_failed) = Leases::open_for_product(root)?;
        let sharing_file = root.join("sharing.json");
        let access_reset = credential_backup::bool_setting(root, "access-reset.json")?;
        let sharing = if sharing_file.exists() {
            serde_json::from_slice::<bool>(&credential_ipc::read_private(&sharing_file, 8)?)
                .map_err(|_| "sharing_state_invalid")?
        } else {
            false
        };
        let (code, authorization_error) = if sharing && !access_reset {
            match credential_auth::production_load(vault_id) {
                Ok(Some(code)) => (Some(code), None),
                Ok(None) => (None, Some("agent_access_missing")),
                Err(error) => (None, Some(error)),
            }
        } else {
            (None, None)
        };
        Ok(Self {
            root: root.to_owned(),
            vault_id: vault_id.to_owned(),
            store: None,
            code,
            sharing,
            authorization_error,
            generation: 1,
            leases,
            cleanup_failed,
            human: None,
            invalidated: HashSet::new(),
            password_failures: 0,
            retry_after: None,
            restore: None,
            access_reset,
        })
    }

    fn status(&self) -> Value {
        json!({"exists":self.root.join("vault.db").exists(),"locked":self.store.is_none(),
            "vaultId":self.vault_id,"sharing":self.sharing && self.code.is_some(),
            "sharingRequested":self.sharing,"authorizationError":self.authorization_error,
            "cleanupFailed":self.cleanup_failed,"generation":self.generation,
            "cleanupRemaining":self.leases.pending_count(),
            "lastBackupAt":credential_backup::last_backup(&self.root),
            "limits":{"passwordMinChars":12,"passwordMaxBytes":1024,"secretMaxBytes":1048576,
                "fileMaxBytes":16777216,"fileTotalMaxBytes":16777216,"maxRecords":1000,
                "backupMaxBytes":credential_backup::MAX_BACKUP}})
    }

    fn invalidate(&mut self, lock: bool) -> Result<(), &'static str> {
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or("generation_exhausted")?;
        self.human = None;
        if lock {
            self.store = None;
            self.invalidated.clear();
        }
        self.cleanup_failed = true;
        self.leases.clear()?;
        self.cleanup_failed = false;
        Ok(())
    }

    fn persist_sharing(&self) -> Result<(), &'static str> {
        credential_ipc::verify_root(&self.root, &self.vault_id)?;
        let pending = self.root.join("sharing.new");
        if pending.exists() {
            credential_ipc::private_path(&pending, false)?;
            fs::remove_file(&pending).map_err(|_| "sharing_state_write_failed")?;
        }
        let mut file = credential_ipc::create_private(&pending)?;
        file.write_all(if self.sharing { b"true" } else { b"false" })
            .and_then(|()| file.sync_all())
            .map_err(|_| "sharing_state_write_failed")?;
        drop(file);
        fs::rename(pending, self.root.join("sharing.json"))
            .map_err(|_| "sharing_state_write_failed")
    }

    fn verify_password(
        &mut self,
        password: &str,
        create: bool,
    ) -> Result<VaultStore, &'static str> {
        if self.retry_after.is_some_and(|until| Instant::now() < until) {
            return Err("password_retry_later");
        }
        let result = if create {
            VaultStore::create(&self.root.join("vault.db"), password, &self.vault_id)
        } else {
            VaultStore::unlock(&self.root.join("vault.db"), password, &self.vault_id)
        };
        self.password_result(result)
    }

    fn password_result<T>(&mut self, result: Result<T, &'static str>) -> Result<T, &'static str> {
        match result {
            Ok(store) => {
                self.password_failures = 0;
                self.retry_after = None;
                Ok(store)
            }
            Err(error) => {
                self.password_failures = self.password_failures.saturating_add(1);
                if self.password_failures >= 5 {
                    self.retry_after = Some(
                        Instant::now()
                            + Duration::from_secs(
                                (30 * (1u64 << (self.password_failures - 5).min(4))).min(300),
                            ),
                    );
                }
                Err(error)
            }
        }
    }

    fn store(&self) -> Result<&VaultStore, &'static str> {
        if self.cleanup_failed {
            return Err("cleanup_failed");
        }
        self.store.as_ref().ok_or("vault_locked")
    }

    fn require_human(&self, request: &Value) -> Result<(), &'static str> {
        let record = self.store()?.require_version(request)?;
        let session = request
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("human_verification_required")?;
        if self.invalidated.contains(session)
            || self.human.as_ref().is_none_or(|human| {
                human.id != session
                    || human.record != record
                    || human.generation != self.generation
                    || Some(human.version) != request.get("expectedVersion").and_then(Value::as_i64)
            })
        {
            return Err("human_verification_required");
        }
        Ok(())
    }

    fn inspect_files(&mut self, request: &Value) -> Result<Value, &'static str> {
        self.require_human(request)?;
        let record_id = crate::credential_store::record_id(request)?;
        let detail = self.store()?.detail(record_id)?;
        if !["ssh", "tls"].contains(&detail["type"].as_str().unwrap_or("")) {
            return Err("file_inspection_unsupported");
        }
        let fields = detail["secretFields"]
            .as_array()
            .ok_or("vault_data_invalid")?;
        let passphrase = if fields.iter().any(|field| field == "passphrase") {
            Some(
                self.store()?
                    .read_fields(&json!({"recordId":record_id,"fields":["passphrase"]}))?["fields"]
                    ["passphrase"]
                    .as_str()
                    .ok_or("vault_data_invalid")?
                    .to_owned(),
            )
        } else {
            None
        };
        let mut deliveries = Vec::new();
        let outcome = (|| {
            for field in ["privateKey", "certificate", "chain"] {
                if !fields.iter().any(|present| present == field) {
                    continue;
                }
                let version = self.store()?.version(record_id)?;
                let bytes = match self.store()?.asset_named(record_id, Some(field)) {
                    Ok((_, _, _, bytes)) => bytes,
                    Err("file_not_found") => self
                        .store()?
                        .read_fields(&json!({"recordId":record_id,"fields":[field]}))?["fields"]
                        [field]
                        .as_str()
                        .ok_or("vault_data_invalid")?
                        .as_bytes()
                        .to_vec(),
                    Err(error) => return Err(error),
                };
                let lease = match self.leases.deliver(record_id, version, &bytes) {
                    Ok(lease) => lease,
                    Err(error) => {
                        self.cleanup_failed = Leases::cleanup_required(error);
                        return Err(error);
                    }
                };
                deliveries.push((
                    field,
                    lease["leaseId"]
                        .as_str()
                        .ok_or("vault_data_invalid")?
                        .to_owned(),
                    PathBuf::from(lease["path"].as_str().ok_or("vault_data_invalid")?),
                ));
            }
            let selected = |field| {
                deliveries
                    .iter()
                    .find(|(name, _, _)| *name == field)
                    .map(|(_, _, path)| path.as_path())
            };
            crate::credential_file_inspect::inspect(
                selected("privateKey"),
                selected("certificate"),
                selected("chain"),
                passphrase.as_deref(),
            )
        })();
        let mut cleanup_error = None;
        for (_, id, _) in deliveries {
            if let Err(error) = self.leases.release(&id) {
                cleanup_error = Some(error);
            }
        }
        if let Some(error) = cleanup_error {
            self.cleanup_failed = true;
            return Err(error);
        }
        outcome
    }

    fn commit_restore(
        &mut self,
        request: &Value,
        commit: impl FnOnce(
            &Path,
            credential_backup::PreparedRestore,
            &str,
        ) -> Result<(String, bool), &'static str>,
    ) -> Result<Value, &'static str> {
        let token = request
            .get("restoreId")
            .and_then(Value::as_str)
            .ok_or("restore_preview_required")?;
        if self
            .restore
            .as_ref()
            .is_none_or(|prepared| prepared.token != token)
        {
            return Err("restore_preview_required");
        }
        self.invalidate(true)?;
        let prepared = self.restore.take().ok_or("restore_preview_required")?;
        let (new_id, durability_warning) = commit(&self.root, prepared, &self.vault_id)?;
        if new_id != self.vault_id {
            self.sharing = false;
            self.code = None;
            self.authorization_error = None;
            self.access_reset = true;
            self.vault_id = new_id;
        }
        let mut status = self.status();
        status["restartRequired"] = json!(true);
        status["durabilityWarning"] = json!(durability_warning);
        Ok(status)
    }

    pub(crate) fn control(&mut self, request: &Value) -> Result<Value, &'static str> {
        let action = request
            .get("action")
            .and_then(Value::as_str)
            .ok_or("action_required")?;
        match action {
            "status" => {}
            "create" | "unlock" => {
                if self.cleanup_failed {
                    return Err("cleanup_failed");
                }
                if self.store.is_some() {
                    return Err("vault_already_unlocked");
                }
                self.restore = None;
                credential_backup::cancel(&self.root)?;
                let password = request
                    .get("password")
                    .and_then(Value::as_str)
                    .ok_or("password_required")?;
                if action == "create"
                    && request.get("confirmPassword").and_then(Value::as_str) != Some(password)
                {
                    return Err("password_confirmation_mismatch");
                }
                self.store = Some(self.verify_password(password, action == "create")?);
            }
            "lock" | "shutdown" => {
                self.restore = None;
                let invalidated = self.invalidate(true);
                let cancelled = credential_backup::cancel(&self.root);
                invalidated?;
                cancelled?;
            }
            "list" => return self.store()?.list(request),
            "detail" => {
                return self.store()?.detail(
                    request
                        .get("recordId")
                        .and_then(Value::as_str)
                        .ok_or("record_id_required")?,
                )
            }
            "save" | "delete" => {
                self.store()?;
                self.invalidate(false)?;
                return if action == "save" {
                    self.store()?.save(request)
                } else {
                    self.store()?.delete(request)
                };
            }
            "verify" => {
                let record = self.store()?.require_version(request)?.to_owned();
                let session = request
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or("session_id_required")?;
                if !credential_auth::valid_id(session)
                    || self.invalidated.contains(session)
                    || self.invalidated.len() >= 1024
                {
                    return Err("human_session_invalid");
                }
                self.human = None;
                let password = request
                    .get("password")
                    .and_then(Value::as_str)
                    .ok_or("password_required")?;
                drop(self.verify_password(password, false)?);
                let version = self.store()?.version(&record)?;
                self.human = Some(HumanSession {
                    id: session.to_owned(),
                    record,
                    version,
                    generation: self.generation,
                });
                return Ok(json!({"verified":true}));
            }
            "read_fields" => {
                self.require_human(request)?;
                return self.store()?.read_fields(request);
            }
            "export_file" => {
                self.require_human(request)?;
                let record_id = crate::credential_store::record_id(request)?;
                let field = request
                    .get("field")
                    .and_then(Value::as_str)
                    .ok_or("field_required")?;
                let (_, _, name, bytes) = self.store()?.asset_named(record_id, Some(field))?;
                // Only the GUI's private IPC consumer receives these bytes. Its
                // command writes the picker-bound destination, never the WebView.
                return Ok(
                    json!({"name":name,"bytesBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                );
            }
            "inspect_files" => return self.inspect_files(request),
            "backup_create" => {
                self.store()?;
                let password = request
                    .get("password")
                    .and_then(Value::as_str)
                    .ok_or("password_required")?;
                drop(self.verify_password(password, false)?);
                let path = request
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("backup_path_required")?;
                return credential_backup::create(
                    &self.root,
                    self.store()?,
                    password,
                    Path::new(path),
                );
            }
            "restore_preview" => {
                self.invalidate(true)?;
                self.restore = None;
                if self.retry_after.is_some_and(|until| Instant::now() < until) {
                    return Err("password_retry_later");
                }
                let path = request
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("backup_path_required")?;
                let password = request
                    .get("password")
                    .and_then(Value::as_str)
                    .ok_or("password_required")?;
                let result = credential_backup::preview(
                    &self.root,
                    Path::new(path),
                    password,
                    &self.vault_id,
                );
                let prepared = self.password_result(result)?;
                let summary = prepared.summary.clone();
                self.restore = Some(prepared);
                return Ok(summary);
            }
            "restore_cancel" => {
                self.restore = None;
                let invalidated = self.invalidate(true);
                let cancelled = credential_backup::cancel(&self.root);
                invalidated?;
                cancelled?;
            }
            "restore_commit" => {
                return self.commit_restore(request, credential_backup::commit);
            }
            "change_password" => {
                self.store()?;
                let old = request
                    .get("oldPassword")
                    .and_then(Value::as_str)
                    .ok_or("password_required")?;
                let new = request
                    .get("newPassword")
                    .and_then(Value::as_str)
                    .ok_or("password_required")?;
                if request.get("confirmPassword").and_then(Value::as_str) != Some(new) {
                    return Err("password_confirmation_mismatch");
                }
                drop(self.verify_password(old, false)?);
                let prepared = credential_backup::change_password(
                    &self.root,
                    self.store()?,
                    &self.vault_id,
                    old,
                    new,
                )?;
                self.invalidate(true)?;
                credential_backup::commit_password(&self.root, prepared, &self.vault_id)?;
            }
            "invalidate_session" => {
                let session = request
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or("session_id_required")?;
                if !credential_auth::valid_id(session) {
                    return Err("human_session_invalid");
                }
                if self.invalidated.len() >= 1024 {
                    self.human = None;
                    return Err("human_session_limit");
                }
                self.invalidated.insert(session.to_owned());
                if self.human.as_ref().is_some_and(|human| human.id == session) {
                    self.human = None;
                }
                return Ok(json!({"invalidated":true}));
            }
            "share" => {
                let enabled = request
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or("enabled_required")?;
                if enabled {
                    self.store()?;
                    let code =
                        credential_auth::production_establish(&self.vault_id, self.access_reset)?;
                    if self.access_reset {
                        credential_backup::clear_access_reset(&self.root)?;
                        self.access_reset = false;
                    }
                    self.sharing = true;
                    if let Err(error) = self.persist_sharing() {
                        self.sharing = false;
                        return Err(error);
                    }
                    self.code = Some(code);
                    self.authorization_error = None;
                } else {
                    self.sharing = false;
                    let cleanup = self.invalidate(false);
                    self.persist_sharing()?;
                    cleanup?;
                }
            }
            "reset_access" => {
                self.store()?;
                let previously_enabled = self.sharing;
                self.sharing = false;
                self.code = None;
                self.invalidate(false)?;
                self.persist_sharing()?;
                self.code = Some(credential_auth::production_establish(&self.vault_id, true)?);
                if self.access_reset {
                    credential_backup::clear_access_reset(&self.root)?;
                    self.access_reset = false;
                }
                self.sharing = previously_enabled;
                if let Err(error) = self.persist_sharing() {
                    self.sharing = false;
                    self.code = None;
                    return Err(error);
                }
                self.authorization_error = None;
            }
            "authorize_access" => {
                self.store()?;
                if self.access_reset {
                    return Err("agent_access_missing");
                }
                self.code = None;
                self.authorization_error = Some("credential_authorization_required");
                self.invalidate(false)?;
                match credential_auth::production_authorize(&self.vault_id) {
                    Ok(code) => {
                        self.code = Some(code);
                        self.authorization_error = None;
                    }
                    Err(error) => {
                        self.authorization_error = Some(error);
                        return Err(error);
                    }
                }
            }
            "retry_cleanup" => {
                self.cleanup_failed = true;
                self.leases.clear()?;
                self.cleanup_failed = false;
            }
            _ => return Err("unknown_control_action"),
        }
        Ok(self.status())
    }

    fn request(&mut self, request: &Value) -> Result<Value, &'static str> {
        if !self.sharing {
            return Err("sharing_disabled");
        }
        if let Some(error) = self.authorization_error {
            return Err(error);
        }
        if !request
            .get("auth")
            .and_then(Value::as_str)
            .zip(self.code.as_deref())
            .is_some_and(|(actual, expected)| credential_auth::equal_material(actual, expected))
        {
            return Err("authorization_rejected");
        }
        self.store()?;
        let name = request
            .get("name")
            .and_then(Value::as_str)
            .ok_or("unknown_tool")?;
        let args = request.get("arguments").ok_or("invalid_arguments")?;
        crate::credential_mcp::validate_call(name, args)?;
        if args
            .get("vaultId")
            .is_some_and(|id| id.as_str() != Some(self.vault_id.as_str()))
        {
            return Err("vault_id_mismatch");
        }
        let mut result = match name {
            "srt_credentials_search" => {
                let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50);
                if !(1..=100).contains(&limit) {
                    return Err("invalid_search_bounds");
                }
                let listed = self.store()?.list(args)?;
                let records=listed["records"].as_array().ok_or("vault_data_invalid")?.iter().take(limit as usize)
                    .map(|record|json!({"recordId":record["recordId"],"type":record["type"],"name":record["name"],
                        "metadata":record["metadata"],"files":record["files"],"secretFields":record["secretFields"]})).collect::<Vec<_>>();
                json!({"records":records})
            }
            "srt_credentials_read_fields" => self.store()?.read_fields(args)?,
            "srt_credentials_lease_file" => {
                let id = crate::credential_store::record_id(args)?;
                let field = args.get("field").and_then(Value::as_str);
                let (version, field, name, bytes) = self.store()?.asset_named(id, field)?;
                match self.leases.deliver(id, version, &bytes) {
                    Ok(mut value) => {
                        value["field"] = json!(field);
                        value["name"] = json!(name);
                        value
                    }
                    Err(error) => {
                        self.cleanup_failed = Leases::cleanup_required(error);
                        return Err(error);
                    }
                }
            }
            "srt_credentials_release_file" => {
                if let Err(error) = self
                    .leases
                    .release(args["leaseId"].as_str().ok_or("invalid_lease_id")?)
                {
                    self.cleanup_failed = true;
                    return Err(error);
                }
                json!({"released":true})
            }
            _ => return Err("unknown_tool"),
        };
        result["vaultId"] = json!(self.vault_id);
        Ok(result)
    }
}

pub(crate) fn run(root: &Path) -> Result<(), &'static str> {
    let _root_lock = credential_backup::lock_root(root)?;
    let vault_id = prepare_root(root, true)?;
    let endpoint = credential_ipc::bind_listener(root, &vault_id)?;
    let host = Arc::new(Mutex::new(ProductHost::open(root, &vault_id)?));
    let stopping = Arc::new(AtomicBool::new(false));
    let watcher = watch_parent(Arc::clone(&stopping))?;
    let server_host = Arc::clone(&host);
    let server_stopping = Arc::clone(&stopping);
    let server = std::thread::spawn(move || {
        while !server_stopping.load(Ordering::Acquire) {
            if let Ok(mut host) = server_host.lock() {
                if host.leases.prune().is_err() {
                    host.cleanup_failed = true;
                }
            }
            if let Ok(Some(mut stream)) = endpoint.accept() {
                if let Ok(Some(request)) =
                    credential_ipc::read_ipc(&mut stream, credential_ipc::REQUEST_LIMIT)
                {
                    if let Ok(mut host) = server_host.lock() {
                        let response = match host.request(&request) {
                            Ok(value) => json!({"result":value}),
                            Err(code) => json!({"error":code}),
                        };
                        let response = credential_ipc::bounded_response(response);
                        let _ = credential_ipc::write_ipc(&mut stream, &response);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let outcome = (|| {
        let mut input = io::stdin().lock();
        let mut output = io::stdout().lock();
        crate::credential_protocol::write_line(
            &mut output,
            &json!({"event":"ready","vaultId":vault_id,"locked":true}),
        )?;
        while let Some(request) = crate::credential_protocol::read_line(&mut input)? {
            let shutdown = request.get("action").and_then(Value::as_str) == Some("shutdown");
            let result = host
                .lock()
                .map_err(|_| "host_unavailable")?
                .control(&request);
            let response = bounded_response(result);
            crate::credential_protocol::write_line(&mut output, &response)?;
            if shutdown {
                break;
            }
        }
        Ok(())
    })();
    stopping.store(true, Ordering::Release);
    let cleanup = host
        .lock()
        .map_err(|_| "host_unavailable")?
        .invalidate(true);
    server.join().map_err(|_| "host_thread_failed")?;
    watcher.join().map_err(|_| "host_thread_failed")?;
    outcome.and(cleanup)
}

fn bounded_response(result: Result<Value, &'static str>) -> Value {
    let response = match result {
        Ok(value) => json!({"ok":true,"result":value}),
        Err(code) => json!({"ok":false,"error":code}),
    };
    if !crate::credential_protocol::fits_frame(&response) {
        json!({"ok":false,"error":"secret_text_response_too_large"})
    } else {
        response
    }
}

fn watch_parent(stopping: Arc<AtomicBool>) -> Result<std::thread::JoinHandle<()>, &'static str> {
    // SAFETY: getppid has no pointer inputs and only observes this process's parent.
    let parent = unsafe { libc::getppid() };
    if parent <= 1 {
        return Err("credential_parent_unavailable");
    }
    Ok(std::thread::spawn(move || {
        while !stopping.load(Ordering::Acquire) {
            // Independent of HostMutex: an OS authorization prompt cannot keep
            // an unlocked child alive after the GUI process has exited.
            // SAFETY: getppid takes no pointers; no arbitrary PID is signalled.
            if unsafe { libc::getppid() } != parent {
                std::process::exit(1);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }))
}

#[cfg(test)]
#[path = "credential_product_tests.rs"]
mod tests;
