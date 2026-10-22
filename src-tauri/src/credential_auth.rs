//! E0 access material; never used to decrypt the vault or printed by the bridge.

const SERVICE: &str = "Skill Repo Tracker E0 Credential Access";
// These adapters run only in the dedicated credential host/bridge processes.
// Keychain's UI policy is process-wide; serialize every operation, including the
// one explicitly interactive operation, so no background call inherits it.
static INTERACTION: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn noninteractive<T>(
    operation: impl FnOnce() -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    let _serial = INTERACTION
        .lock()
        .map_err(|_| "credential_store_unavailable")?;
    let _no_ui = security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
        .map_err(|_| "credential_store_unavailable")?;
    operation()
}

fn storage_error(error: keyring::Error) -> &'static str {
    match error {
        keyring::Error::NoStorageAccess(error) | keyring::Error::PlatformFailure(error) => {
            match error
                .downcast_ref::<security_framework::base::Error>()
                .map(|error| error.code())
            {
                // errSecInteractionNotAllowed / errSecInteractionRequired.
                Some(-25308 | -25315) => "credential_authorization_required",
                Some(-25293) => "credential_authorization_denied",
                Some(-128) => "credential_authorization_cancelled",
                _ => "credential_store_unavailable",
            }
        }
        _ => "credential_store_unavailable",
    }
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn entry(vault_id: &str) -> Result<keyring::Entry, &'static str> {
    if !valid_id(vault_id) {
        return Err("invalid_vault_id");
    }
    keyring::Entry::new(SERVICE, &format!("vault:{vault_id}"))
        .map_err(|_| "credential_store_unavailable")
}

pub(crate) fn load(vault_id: &str) -> Result<Option<String>, &'static str> {
    noninteractive(|| load_existing(vault_id))
}

fn load_existing(vault_id: &str) -> Result<Option<String>, &'static str> {
    match entry(vault_id)?.get_password() {
        Ok(value) if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(Some(value))
        }
        Ok(_) => Err("invalid_access_material"),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(storage_error(error)),
    }
}

// Called only after a local, explicit action and a successful master unlock.
// The OS decides whether to grant this executable access. Never change ACLs,
// synthesize a replacement code, or retry interactively from an MCP request.
pub(crate) fn authorize_existing(vault_id: &str) -> Result<String, &'static str> {
    let _serial = INTERACTION
        .lock()
        .map_err(|_| "credential_store_unavailable")?;
    let previous = load_existing(vault_id)?.ok_or("agent_access_missing")?;
    // Confirm this process can read unchanged material without another prompt.
    // Persistence across new bridge/host processes requires separate acceptance;
    // a one-off Allow must not be reported as a persistent upgrade grant.
    let _no_ui = security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
        .map_err(|_| "credential_store_unavailable")?;
    let current = load_existing(vault_id)?.ok_or("agent_access_missing")?;
    if !equal_material(&previous, &current) {
        return Err("credential_store_changed");
    }
    Ok(current)
}

pub(crate) fn random_id() -> Result<String, &'static str> {
    let mut bytes = [0_u8; 32];
    // SAFETY: getentropy writes at most the supplied length into a valid buffer.
    if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return Err("system_random_unavailable");
    }
    Ok(hex::encode(bytes))
}

pub(crate) fn establish(vault_id: &str, reset: bool) -> Result<String, &'static str> {
    noninteractive(|| establish_without_ui(vault_id, reset))
}

fn establish_without_ui(vault_id: &str, reset: bool) -> Result<String, &'static str> {
    let previous = load_existing(vault_id)?;
    if !reset {
        if let Some(value) = previous {
            return Ok(value);
        }
    }
    let value = random_id()?;
    entry(vault_id)?
        .set_password(&value)
        .map_err(storage_error)?;
    if load_existing(vault_id)?.as_deref() != Some(value.as_str()) {
        return Err("credential_store_write_not_verified");
    }
    Ok(value)
}

pub(crate) fn remove(vault_id: &str) -> Result<(), &'static str> {
    noninteractive(|| remove_without_ui(vault_id))
}

fn remove_without_ui(vault_id: &str) -> Result<(), &'static str> {
    match entry(vault_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(storage_error(error)),
    }
    if load_existing(vault_id)?.is_some() {
        return Err("credential_store_delete_not_verified");
    }
    Ok(())
}

pub(crate) fn equal_material(left: &str, right: &str) -> bool {
    // Fixed-length full comparison is used only for an opaque local access code.
    // This is not a password derivation or a new cryptographic wire protocol.
    if left.len() != 64 || right.len() != 64 {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

// The product uses an independent namespace; E0 access items remain fixtures.
fn production_entry(vault_id: &str) -> Result<keyring::Entry, &'static str> {
    if !valid_id(vault_id) {
        return Err("invalid_vault_id");
    }
    keyring::Entry::new(
        "Skill Repo Tracker Credential Access",
        &format!("vault:{vault_id}"),
    )
    .map_err(|_| "credential_store_unavailable")
}

fn production_existing(vault_id: &str) -> Result<Option<String>, &'static str> {
    match production_entry(vault_id)?.get_password() {
        Ok(value) if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            Ok(Some(value))
        }
        Ok(_) => Err("invalid_access_material"),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(storage_error(error)),
    }
}

pub(crate) fn production_load(vault_id: &str) -> Result<Option<String>, &'static str> {
    noninteractive(|| production_existing(vault_id))
}

pub(crate) fn production_establish(vault_id: &str, reset: bool) -> Result<String, &'static str> {
    noninteractive(|| {
        let previous = production_existing(vault_id)?;
        if !reset {
            if let Some(value) = previous {
                return Ok(value);
            }
        }
        let value = random_id()?;
        production_entry(vault_id)?
            .set_password(&value)
            .map_err(storage_error)?;
        if production_existing(vault_id)?.as_deref() != Some(value.as_str()) {
            return Err("credential_store_write_not_verified");
        }
        Ok(value)
    })
}

pub(crate) fn production_authorize(vault_id: &str) -> Result<String, &'static str> {
    let _serial = INTERACTION
        .lock()
        .map_err(|_| "credential_store_unavailable")?;
    let previous = production_existing(vault_id)?.ok_or("agent_access_missing")?;
    let _no_ui = security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
        .map_err(|_| "credential_store_unavailable")?;
    let current = production_existing(vault_id)?.ok_or("agent_access_missing")?;
    if !equal_material(&previous, &current) {
        return Err("credential_store_changed");
    }
    Ok(current)
}

#[cfg(test)]
#[path = "credential_auth_tests.rs"]
pub(crate) mod memory_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_auth_failures_are_distinct_and_never_reported_as_missing() {
        for (code, expected) in [
            (-25308, "credential_authorization_required"),
            (-25315, "credential_authorization_required"),
            (-25293, "credential_authorization_denied"),
            (-128, "credential_authorization_cancelled"),
            (-25291, "credential_store_unavailable"),
            (-25295, "credential_store_unavailable"),
        ] {
            let error = security_framework::base::Error::from_code(code);
            assert_eq!(
                storage_error(keyring::Error::PlatformFailure(Box::new(error))),
                expected
            );
        }
    }
}
