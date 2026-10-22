//! Closed GUI action vocabulary; paths and secrets are never arbitrary commands.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

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
    PrepareExport,
    ExportFile,
    BackupCreate,
    RestorePick,
    RestorePreview,
    RestoreCommit,
    RestoreCancel,
    ChangePassword,
    AgentGuide,
    InspectFiles,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CredentialRequest {
    pub(super) action: Action,
    #[serde(flatten)]
    pub(super) arguments: Map<String, Value>,
}

impl CredentialRequest {
    pub(crate) fn validate_gui(&self) -> Result<(), &'static str> {
        if self.arguments.contains_key("path") {
            return Err("invalid_arguments");
        }
        Ok(())
    }

    pub(crate) fn control_request(&self) -> Result<Value, &'static str> {
        let mut request = serde_json::to_value(self).map_err(|_| "invalid_arguments")?;
        if self.action == Action::CopySecret {
            let field = self
                .arguments
                .get("field")
                .and_then(Value::as_str)
                .ok_or("invalid_secret_field")?;
            request["action"] = json!("read_fields");
            request["fields"] = json!([field]);
            request
                .as_object_mut()
                .ok_or("invalid_arguments")?
                .remove("field");
        }
        Ok(request)
    }

    pub(crate) fn export_binding(&self) -> Result<String, &'static str> {
        let record = self
            .arguments
            .get("recordId")
            .and_then(Value::as_str)
            .ok_or("record_id_required")?;
        let version = self
            .arguments
            .get("expectedVersion")
            .and_then(Value::as_i64)
            .ok_or("record_version_conflict")?;
        let field = self
            .arguments
            .get("field")
            .and_then(Value::as_str)
            .ok_or("field_not_found")?;
        Ok(json!([record, version, field]).to_string())
    }
}

impl Action {
    pub(crate) fn completed_mutation(self) -> bool {
        matches!(
            self,
            Self::Lock
                | Self::InvalidateSession
                | Self::BackupCreate
                | Self::ChangePassword
                | Self::RestoreCommit
                | Self::RestoreCancel
                | Self::Save
                | Self::Delete
                | Self::Share
                | Self::ResetAccess
                | Self::AuthorizeAccess
                | Self::RetryCleanup
        )
    }
}

#[cfg(test)]
#[path = "credential_command_model_tests.rs"]
mod tests;
