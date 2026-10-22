//! Minimal MCP STDIO adapter. It transports only four declared credential tools;
//! it never executes a shell, creates a vault, or accepts a master password.

use serde_json::{json, Value};
use std::{io, path::Path};

const PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

pub(crate) fn tools() -> Value {
    let identity = json!({
        "vaultId":{"type":"string","minLength":1,"maxLength":64},
        "recordId":{"type":"string","minLength":1,"maxLength":64}
    });
    let mut read = identity.clone();
    read["fields"] = json!({"type":"array","minItems":1,"maxItems":8,
        "items":{"type":"string","minLength":1,"maxLength":64}});
    json!({"tools":[
        {"name":"srt_credentials_search","description":"Find credential locators by name, host or account. Returns no secret fields. Disambiguate multiple matches before reading.",
         "inputSchema":{"type":"object","properties":{
            "query":{"type":"string","maxLength":512},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false},
         "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":"srt_credentials_read_fields","description":"Read only the requested secret fields of one exact record in the configured vault. Values can enter this client's context and history. Never print them unless the user's task requires it.",
         "inputSchema":{"type":"object","properties":read,"required":["vaultId","recordId","fields"],"additionalProperties":false},
         "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":"srt_credentials_lease_file","description":"Create a restricted local file for one record attachment. Use the returned path with a native tool, then release the lease. It expires after 15 minutes or earlier on lock/revocation.",
         "inputSchema":{"type":"object","properties":identity,"required":["vaultId","recordId"],"additionalProperties":false},
         "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}},
        {"name":"srt_credentials_release_file","description":"Remove only a previously issued managed file using its lease ID. Does not remove user exports or original source files.",
         "inputSchema":{"type":"object","properties":{"leaseId":{"type":"string","minLength":64,"maxLength":64}},"required":["leaseId"],"additionalProperties":false},
         "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}
    ]})
}

pub(crate) fn validate_call(name: &str, arguments: &Value) -> Result<(), &'static str> {
    let map = arguments.as_object().ok_or("invalid_arguments")?;
    let allowed: &[&str] = match name {
        "srt_credentials_search" => &["query", "limit"],
        "srt_credentials_read_fields" => &["vaultId", "recordId", "fields"],
        "srt_credentials_lease_file" => &["vaultId", "recordId"],
        "srt_credentials_release_file" => &["leaseId"],
        _ => return Err("unknown_tool"),
    };
    if map.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("invalid_arguments");
    }
    for key in ["vaultId", "recordId", "leaseId", "query"] {
        if map.get(key).is_some_and(|value| !value.is_string()) {
            return Err("invalid_arguments");
        }
    }
    if map
        .get("limit")
        .is_some_and(|value| value.as_u64().is_none())
    {
        return Err("invalid_arguments");
    }
    if name == "srt_credentials_read_fields" || name == "srt_credentials_lease_file" {
        if map
            .get("vaultId")
            .and_then(Value::as_str)
            .is_none_or(|id| !crate::credential_auth::valid_id(id))
        {
            return Err("vault_id_required");
        }
        crate::credential_store::record_id(arguments)?;
    }
    if name == "srt_credentials_release_file"
        && map
            .get("leaseId")
            .and_then(Value::as_str)
            .is_none_or(|id| id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid_lease_id");
    }
    Ok(())
}

pub(crate) fn tool_result(result: Result<Value, &'static str>) -> Value {
    match result {
        Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}],
            "structuredContent":value,"isError":false}),
        Err(code) => {
            json!({"content":[{"type":"text","text":format!("{code}: resolve in the local credential host; do not paste passwords or access codes into chat.")}],"isError":true})
        }
    }
}

fn forward(
    root: &Path,
    vault_id: &str,
    access: &mut Option<String>,
    name: &str,
    arguments: &Value,
) -> Result<Value, &'static str> {
    validate_call(name, arguments)?;
    // Peer identity is checked before retrieving or sending any access material.
    let mut stream = crate::credential_ipc::connect_host(root, vault_id)?;
    if access.is_none() {
        *access =
            Some(crate::credential_auth::load(vault_id)?.ok_or("agent_access_not_configured")?);
    }
    let code = access.as_ref().ok_or("agent_access_not_configured")?;
    crate::credential_ipc::write_ipc(
        &mut stream,
        &json!({"auth":code,"name":name,"arguments":arguments}),
    )?;
    let response =
        crate::credential_ipc::read_ipc(&mut stream, crate::credential_ipc::FRAME_LIMIT)?
            .ok_or("host_unavailable")?;
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        return Err(match error {
            "vault_locked" => "vault_locked",
            "sharing_disabled" => "sharing_disabled",
            "authorization_rejected" => "authorization_rejected",
            "vault_id_mismatch" => "vault_id_mismatch",
            "record_not_found" => "record_not_found",
            "field_not_found" => "field_not_found",
            "file_not_found" => "file_not_found",
            "lease_not_found" => "lease_not_found",
            "cleanup_failed" => "cleanup_failed",
            "stale_generation" => "stale_generation",
            _ => "credential_request_failed",
        });
    }
    response
        .get("result")
        .cloned()
        .ok_or("invalid_host_response")
}

pub(crate) struct Protocol {
    initialized: bool,
    ready: bool,
}

impl Protocol {
    pub(crate) fn new() -> Self {
        Self {
            initialized: false,
            ready: false,
        }
    }

    pub(crate) fn handle(
        &mut self,
        request: Value,
        mut call: impl FnMut(&str, &Value) -> Result<Value, &'static str>,
    ) -> Option<Value> {
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str);
        let failure = |code, message| json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}});
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || method.is_none()
            || id
                .as_ref()
                .is_some_and(|value| !value.is_string() && !value.is_i64() && !value.is_u64())
        {
            return Some(failure(-32600, "Invalid Request"));
        }
        let method = method?;
        if id.is_none() {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return None;
        }
        let result = match method {
            "initialize" if !self.initialized => {
                let requested = request
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str);
                if requested.is_none()
                    || !request
                        .pointer("/params/capabilities")
                        .is_some_and(Value::is_object)
                    || !request
                        .pointer("/params/clientInfo/name")
                        .is_some_and(Value::is_string)
                    || !request
                        .pointer("/params/clientInfo/version")
                        .is_some_and(Value::is_string)
                {
                    return Some(failure(-32602, "Invalid params"));
                }
                let version = requested
                    .filter(|value| PROTOCOLS.contains(value))
                    .unwrap_or(PROTOCOLS[0]);
                self.initialized = true;
                json!({"protocolVersion":version,"capabilities":{"tools":{}},
                    "serverInfo":{"name":"srt-credential-e0","version":"0.1.0"},
                    "instructions":"Local E0 fixture vault. Search locators, disambiguate, then request only required fields. Files require a lease and release. Host must remain manually unlocked."})
            }
            "ping" => json!({}),
            _ if !self.ready => return Some(failure(-32002, "Not initialized")),
            "tools/list" => tools(),
            "tools/call" => {
                let Some(name) = request.pointer("/params/name").and_then(Value::as_str) else {
                    return Some(failure(-32602, "Invalid params"));
                };
                let arguments = request
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                tool_result(validate_call(name, &arguments).and_then(|()| call(name, &arguments)))
            }
            _ => return Some(failure(-32601, "Method not found")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
}

pub(crate) fn run(root: &Path, vault_id: &str) -> Result<(), &'static str> {
    crate::credential_ipc::verify_root(root, vault_id)?;
    let mut protocol = Protocol::new();
    let mut access = None;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let value = match crate::credential_ipc::read_request(&mut input) {
            Ok(Some(value)) => value,
            Ok(None) => return Ok(()),
            Err("invalid_json") => {
                crate::credential_ipc::write_line(
                    &mut output,
                    &json!({"jsonrpc":"2.0","id":null,
                    "error":{"code":-32700,"message":"Parse error"}}),
                )?;
                continue;
            }
            Err(error) => return Err(error),
        };
        if let Some(response) = protocol.handle(value, |name, args| {
            forward(root, vault_id, &mut access, name, args)
        }) {
            crate::credential_ipc::write_line(&mut output, &response)?;
        }
    }
}
