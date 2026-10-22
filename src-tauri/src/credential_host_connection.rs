//! Bounded private control-pipe IO and ownership of the GUI's credential child.
use crate::credential_command_errors::error_code;
use serde_json::Value;
use std::{
    io::BufReader,
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout},
    time::Duration,
};

pub(crate) struct HostConnection {
    pub(crate) child: Child,
    pub(crate) input: Option<ChildStdin>,
    pub(crate) output: BufReader<ChildStdout>,
    pub(crate) executable: PathBuf,
    pub(crate) vault_id: String,
}

pub(crate) fn read_response(reader: &mut BufReader<ChildStdout>) -> Result<Value, &'static str> {
    crate::credential_protocol::read_line(reader)?.ok_or("credential_host_unavailable")
}

impl HostConnection {
    pub(crate) fn accept_ready(&mut self) -> Result<(), &'static str> {
        let ready = read_response(&mut self.output)?;
        let vault_id = ready
            .get("vaultId")
            .and_then(Value::as_str)
            .ok_or("credential_host_protocol_invalid")?;
        if ready.get("event").and_then(Value::as_str) != Some("ready")
            || ready.get("locked") != Some(&Value::Bool(true))
            || vault_id.len() != 64
            || !vault_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("credential_host_protocol_invalid");
        }
        self.vault_id = vault_id.to_owned();
        Ok(())
    }

    pub(crate) fn exchange(&mut self, request: &Value) -> Result<Value, &'static str> {
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
            // The subprocess returns only reviewed fixed codes, never raw diagnostics.
            Err(error_code(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("credential_host_unavailable"),
            ))
        }
    }
}

impl Drop for HostConnection {
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

#[cfg(test)]
#[path = "credential_host_connection_tests.rs"]
mod tests;
