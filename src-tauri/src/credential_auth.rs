//! E0 access material; never used to decrypt the vault or printed by the bridge.

const SERVICE: &str = "Skill Repo Tracker E0 Credential Access";

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
    match entry(vault_id)?.get_password() {
        Ok(value) if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(Some(value))
        }
        Ok(_) => Err("invalid_access_material"),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("credential_store_unavailable"),
    }
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
    let previous = load(vault_id)?;
    if !reset {
        if let Some(value) = previous {
            return Ok(value);
        }
    }
    let value = random_id()?;
    entry(vault_id)?
        .set_password(&value)
        .map_err(|_| "credential_store_write_failed")?;
    if load(vault_id)?.as_deref() != Some(value.as_str()) {
        return Err("credential_store_write_not_verified");
    }
    Ok(value)
}

pub(crate) fn remove(vault_id: &str) -> Result<(), &'static str> {
    match entry(vault_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("credential_store_delete_failed"),
    }
    if load(vault_id)?.is_some() {
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
