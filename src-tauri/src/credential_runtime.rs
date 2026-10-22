//! Explicit E0 entry points. Neither mode initializes Tauri or touches AppState.
//! The host accepts fixture control JSON only on its own stdin, never over MCP.

use crate::{
    credential_auth, credential_ipc, credential_leases::Leases, credential_mcp,
    credential_store::Store,
};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Write},
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[cfg(test)]
#[path = "credential_runtime_tests.rs"]
mod tests;

pub(crate) fn dispatch_from_env() -> Option<Result<(), &'static str>> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args
        .first()
        .is_some_and(|value| value == "--credential-host")
    {
        return Some(if args.len() == 3 && args[1] == "--root" {
            crate::credential_product::run(&PathBuf::from(&args[2]))
        } else {
            Err("invalid_credential_arguments")
        });
    }
    let (host, root, vault_id) = match credential_arguments(args)? {
        Ok(parsed) => parsed,
        Err(error) => return Some(Err(error)),
    };
    Some(if host {
        run_host(&root, &vault_id)
    } else {
        credential_mcp::run(&root, &vault_id)
    })
}

fn credential_arguments(
    arguments: Vec<OsString>,
) -> Option<Result<(bool, PathBuf, String), &'static str>> {
    // Any credential-mode intent must fail closed, even when misspelled or
    // placed after other flags. Such invocations must never open ordinary AppState.
    if !arguments
        .iter()
        .any(|argument| argument.as_encoded_bytes().starts_with(b"--credential"))
    {
        return None;
    }
    Some((|| {
        let host = match arguments.first().and_then(|argument| argument.to_str()) {
            Some("--credential-e0-host") => true,
            Some("--credential-bridge") => false,
            _ => return Err("invalid_credential_mode"),
        };
        let (root, vault_id) = parse_arguments(arguments.into_iter().skip(1).collect())?;
        Ok((host, root, vault_id))
    })())
}

fn parse_arguments(arguments: Vec<OsString>) -> Result<(PathBuf, String), &'static str> {
    if arguments.len() != 4 {
        return Err("expected_root_and_vault_id");
    }
    let mut root = None;
    let mut vault_id = None;
    for pair in arguments.chunks_exact(2) {
        if pair[0] == "--root" && root.is_none() {
            root = Some(PathBuf::from(&pair[1]));
        } else if pair[0] == "--vault-id" && vault_id.is_none() {
            vault_id = pair[1].to_str().map(str::to_owned);
        } else {
            return Err("invalid_credential_arguments");
        }
    }
    let root = root.ok_or("root_required")?;
    let vault_id = vault_id.ok_or("vault_id_required")?;
    if !root.is_absolute() || !credential_auth::valid_id(&vault_id) {
        return Err("invalid_credential_arguments");
    }
    Ok((root, vault_id))
}

fn prepare_root(root: &Path, vault_id: &str) -> Result<(), &'static str> {
    if !root.is_absolute() || !credential_auth::valid_id(vault_id) {
        return Err("invalid_e0_root");
    }
    if !root.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(root)
            .map_err(|_| "e0_root_create_failed")?;
    }
    if fs::canonicalize(root).map_err(|_| "e0_root_unavailable")? != root {
        return Err("invalid_e0_root");
    }
    credential_ipc::private_path(root, true)?;
    let marker = root.join("e0-vault.json");
    if !marker.exists() {
        let empty = fs::read_dir(root)
            .map_err(|_| "e0_root_unavailable")?
            .next()
            .is_none();
        if !empty {
            return Err("e0_root_not_empty");
        }
        let mut file = credential_ipc::create_private(&marker)?;
        let bytes =
            serde_json::to_vec(&json!({"schema":"srt-credential-e0-v1","vaultId":vault_id}))
                .map_err(|_| "e0_root_create_failed")?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "e0_root_create_failed")?;
    }
    credential_ipc::verify_root(root, vault_id)
}

pub(crate) struct Host {
    root: PathBuf,
    vault_id: String,
    store: Option<Store>,
    code: Option<String>,
    authorization_error: Option<&'static str>,
    sharing: bool,
    generation: u64,
    leases: Leases,
    cleanup_failed: bool,
    password_failures: u32,
    retry_after: Option<Instant>,
}

impl Host {
    pub(crate) fn open(root: &Path, vault_id: &str) -> Result<Self, &'static str> {
        Self::open_with_access(root, vault_id, credential_auth::load)
    }

    fn open_with_access(
        root: &Path,
        vault_id: &str,
        access: impl FnOnce(&str) -> Result<Option<String>, &'static str>,
    ) -> Result<Self, &'static str> {
        prepare_root(root, vault_id)?;
        // Recover registered plaintext before Keychain access can fail or prompt.
        let leases = Leases::open(root)?;
        let sharing_path = root.join("sharing.json");
        let sharing = if sharing_path.exists() {
            serde_json::from_slice::<bool>(&credential_ipc::read_private(&sharing_path, 8)?)
                .map_err(|_| "sharing_state_invalid")?
        } else {
            false
        };
        let (code, authorization_error) = if sharing {
            match access(vault_id) {
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
            authorization_error,
            sharing,
            generation: 1,
            leases,
            cleanup_failed: false,
            password_failures: 0,
            retry_after: None,
        })
    }

    fn persist_sharing(&self, enabled: bool) -> Result<(), &'static str> {
        credential_ipc::verify_root(&self.root, &self.vault_id)?;
        let pending = self.root.join("sharing.new");
        if pending.exists() {
            credential_ipc::private_path(&pending, false)?;
            fs::remove_file(&pending).map_err(|_| "sharing_state_write_failed")?;
        }
        let mut file = credential_ipc::create_private(&pending)?;
        file.write_all(if enabled { b"true" } else { b"false" })
            .and_then(|()| file.sync_all())
            .map_err(|_| "sharing_state_write_failed")?;
        drop(file);
        fs::rename(pending, self.root.join("sharing.json"))
            .map_err(|_| "sharing_state_write_failed")?;
        File::open(&self.root)
            .and_then(|file| file.sync_all())
            .map_err(|_| "sharing_state_write_failed")
    }

    fn invalidate(&mut self, lock: bool) -> Result<(), &'static str> {
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or("generation_exhausted")?;
        if lock {
            self.store = None;
        }
        let previous_failure = self.cleanup_failed;
        self.cleanup_failed = true;
        self.leases.clear()?;
        self.cleanup_failed = previous_failure;
        Ok(())
    }

    fn lease_result<T>(&mut self, result: Result<T, &'static str>) -> Result<T, &'static str> {
        if matches!(
            result.as_ref().err().copied(),
            Some(
                "path_unavailable"
                    | "unsafe_path_permissions"
                    | "private_file_create_failed"
                    | "lease_write_failed"
                    | "lease_cleanup_failed"
                    | "lease_journal_failed"
                    | "lease_journal_cleanup_failed"
            )
        ) {
            self.cleanup_failed = true;
        }
        result
    }

    fn disable_sharing(&mut self) -> Result<(), &'static str> {
        self.sharing = false;
        // Persistence still runs if file cleanup fails. Failed cleanup must not
        // restore an earlier sharing grant after the next manual unlock.
        let cleanup = self.invalidate(false);
        let persisted = self.persist_sharing(false);
        cleanup.and(persisted)
    }

    fn unlock(&mut self, password: &str, create: bool) -> Result<(), &'static str> {
        if self.retry_after.is_some_and(|until| Instant::now() < until) {
            return Err("password_retry_later");
        }
        if self.store.is_some() {
            return Err("vault_already_unlocked");
        }
        let result = if create {
            Store::create(&self.root.join("vault.db"), password, &self.vault_id)
        } else {
            Store::unlock(&self.root.join("vault.db"), password, &self.vault_id)
        };
        match result {
            Ok(store) => {
                self.store = Some(store);
                self.password_failures = 0;
                self.retry_after = None;
                Ok(())
            }
            Err(error) => {
                self.password_failures = self.password_failures.saturating_add(1);
                if self.password_failures >= 5 {
                    let multiplier = 1_u64 << (self.password_failures - 5).min(4);
                    self.retry_after =
                        Some(Instant::now() + Duration::from_secs((30 * multiplier).min(300)));
                }
                Err(error)
            }
        }
    }

    pub(crate) fn control(&mut self, value: &Value) -> Result<Value, &'static str> {
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .ok_or("action_required")?;
        match action {
            "create" | "unlock" => self.unlock(
                value
                    .get("password")
                    .and_then(Value::as_str)
                    .ok_or("password_required")?,
                action == "create",
            )?,
            "lock" | "shutdown" => self.invalidate(true)?,
            "authorize_access" => {
                self.authorize_with(credential_auth::authorize_existing)?;
            }
            "share" => {
                let enabled = value
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or("enabled_required")?;
                if enabled {
                    let code = credential_auth::establish(&self.vault_id, false)?;
                    self.persist_sharing(true)?;
                    self.code = Some(code);
                    self.authorization_error = None;
                    self.sharing = true;
                } else {
                    self.disable_sharing()?;
                }
            }
            "reset_access" => {
                let enabled = self.sharing;
                self.code = None;
                self.disable_sharing()?;
                let code = credential_auth::establish(&self.vault_id, true)?;
                self.persist_sharing(enabled)?;
                self.code = Some(code);
                self.authorization_error = None;
                self.sharing = enabled;
            }
            "clear_authorization" => {
                self.code = None;
                self.disable_sharing()?;
                credential_auth::remove(&self.vault_id)?;
                self.authorization_error = None;
            }
            "fixture_file" => {
                self.invalidate(false)?;
                self.store.as_ref().ok_or("vault_locked")?.fixture_file(
                    value
                        .get("bytesBase64")
                        .and_then(Value::as_str)
                        .ok_or("bytes_required")?,
                )?;
            }
            "status" => {}
            "engine" => return self.store.as_ref().ok_or("vault_locked")?.engine(),
            "retry_cleanup" => {
                self.cleanup_failed = true;
                self.leases.clear()?;
                self.cleanup_failed = false;
            }
            _ => return Err("unknown_control_action"),
        }
        Ok(
            json!({"locked":self.store.is_none(),"sharing":self.sharing && self.code.is_some(),
            "sharingRequested":self.sharing,"authorizationError":self.authorization_error,
            "generation":self.generation,"cleanupFailed":self.cleanup_failed}),
        )
    }

    fn authorize_with(
        &mut self,
        authorize: impl FnOnce(&str) -> Result<String, &'static str>,
    ) -> Result<(), &'static str> {
        self.store.as_ref().ok_or("vault_locked")?;
        // Keep this available after a failed reset or explicit sharing disable.
        // Recovering Keychain access does not itself enable sharing.
        // Reauthorization invalidates existing deliveries even if the OS denies it.
        self.code = None;
        self.authorization_error = Some("credential_authorization_required");
        self.invalidate(false)?;
        match authorize(&self.vault_id) {
            Ok(code) => {
                self.code = Some(code);
                self.authorization_error = None;
                Ok(())
            }
            Err(error) => {
                self.authorization_error = Some(error);
                Err(error)
            }
        }
    }

    pub(crate) fn request(&mut self, value: &Value) -> Result<Value, &'static str> {
        if !self.sharing {
            return Err("sharing_disabled");
        }
        if let Some(error) = self.authorization_error {
            return Err(error);
        }
        if !value
            .get("auth")
            .and_then(Value::as_str)
            .zip(self.code.as_deref())
            .is_some_and(|(provided, expected)| credential_auth::equal_material(provided, expected))
        {
            return Err("authorization_rejected");
        }
        if self.store.is_none() {
            return Err("vault_locked");
        }
        if self.cleanup_failed {
            return Err("cleanup_failed");
        }
        let generation = self.generation;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .ok_or("unknown_tool")?;
        let args = value.get("arguments").ok_or("invalid_arguments")?;
        credential_mcp::validate_call(name, args)?;
        if args
            .get("vaultId")
            .is_some_and(|id| id.as_str() != Some(self.vault_id.as_str()))
        {
            return Err("vault_id_mismatch");
        }
        let store = self.store.as_ref().ok_or("vault_locked")?;
        let mut result = match name {
            "srt_credentials_search" => store.search(args)?,
            "srt_credentials_read_fields" => store.read_fields(args)?,
            "srt_credentials_lease_file" => {
                let id = crate::credential_store::record_id(args)?;
                let (version, bytes) = store.asset(id)?;
                let delivered = self.leases.deliver(id, version, &bytes);
                self.lease_result(delivered)?
            }
            "srt_credentials_release_file" => {
                let released = self
                    .leases
                    .release(args["leaseId"].as_str().ok_or("invalid_lease_id")?);
                self.lease_result(released)?;
                json!({"released":true})
            }
            _ => return Err("unknown_tool"),
        };
        if generation != self.generation || !self.sharing || self.store.is_none() {
            return Err("stale_generation");
        }
        result["vaultId"] = json!(self.vault_id);
        Ok(result)
    }
}

fn run_host(root: &Path, vault_id: &str) -> Result<(), &'static str> {
    prepare_root(root, vault_id)?;
    // Acquire singleton ownership before recovering any previous lease journal.
    let endpoint = credential_ipc::bind_listener(root, vault_id)?;
    let host = Arc::new(Mutex::new(Host::open(root, vault_id)?));
    let stopping = Arc::new(AtomicBool::new(false));
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
                let request = credential_ipc::read_ipc(&mut stream, credential_ipc::REQUEST_LIMIT);
                if let Ok(Some(request)) = request {
                    if let Ok(mut host) = server_host.lock() {
                        let response = match host.request(&request) {
                            Ok(value) => json!({"result":value}),
                            Err(code) => json!({"error":code}),
                        };
                        // Holding this lock through delivery makes control acknowledgments
                        // linearizable: after lock/revoke returns, no old request can send.
                        let response = credential_ipc::bounded_response(response);
                        let _ = credential_ipc::write_ipc(&mut stream, &response);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let result = (|| {
        let mut input = io::stdin().lock();
        let mut output = io::stdout().lock();
        credential_ipc::write_line(
            &mut output,
            &json!({"event":"ready","vaultId":vault_id,"locked":true}),
        )?;
        while let Some(value) = credential_ipc::read_line(&mut input)? {
            let shutdown = value.get("action").and_then(Value::as_str) == Some("shutdown");
            let outcome = host.lock().map_err(|_| "host_unavailable")?.control(&value);
            let response = match outcome {
                Ok(result) => json!({"ok":true,"result":result}),
                Err(error) => json!({"ok":false,"error":error}),
            };
            credential_ipc::write_line(&mut output, &response)?;
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
    result.and(cleanup)
}
