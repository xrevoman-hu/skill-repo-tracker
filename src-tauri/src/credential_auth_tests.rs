//! Test-only persistent memory provider. The native Keychain adapter is never
//! constructed by these tests; each scenario uses a distinct random vault ID.
use super::*;
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence};
use std::{
    any::Any,
    collections::HashMap,
    sync::{Arc, Mutex, Once, OnceLock},
};

#[derive(Default)]
struct Data {
    value: Option<Vec<u8>>,
    read_error: Option<i32>,
    write_error: Option<i32>,
    skip_write: bool,
    skip_delete: bool,
    reads: usize,
    change_on_second_read: bool,
}
type Memory = Arc<Mutex<Data>>;
static ENTRIES: OnceLock<Mutex<HashMap<(String, String), Memory>>> = OnceLock::new();

struct MemoryEntry(Memory);
impl CredentialApi for MemoryEntry {
    fn set_secret(&self, bytes: &[u8]) -> keyring::Result<()> {
        let mut data = self.0.lock().unwrap();
        if let Some(code) = data.write_error.take() {
            return Err(platform_error(code));
        }
        if !data.skip_write {
            data.value = Some(bytes.to_vec());
        }
        Ok(())
    }
    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        let mut data = self.0.lock().unwrap();
        if let Some(code) = data.read_error.take() {
            return Err(platform_error(code));
        }
        data.reads += 1;
        if data.change_on_second_read && data.reads == 2 {
            data.value = Some(vec![b'b'; 64]);
        }
        data.value.clone().ok_or(keyring::Error::NoEntry)
    }
    fn delete_credential(&self) -> keyring::Result<()> {
        let mut data = self.0.lock().unwrap();
        if data.skip_delete {
            return Ok(());
        }
        data.value.take().map(|_| ()).ok_or(keyring::Error::NoEntry)
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}
struct MemoryBuilder;
impl CredentialBuilderApi for MemoryBuilder {
    fn build(
        &self,
        target: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<Credential>> {
        assert!(target.is_none());
        assert!([SERVICE, "Skill Repo Tracker Credential Access"].contains(&service));
        assert!(user.starts_with("vault:"));
        let entry = ENTRIES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entry((service.into(), user.into()))
            .or_default()
            .clone();
        Ok(Box::new(MemoryEntry(entry)))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn persistence(&self) -> CredentialPersistence {
        CredentialPersistence::ProcessOnly
    }
}

pub(crate) fn install() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| keyring::set_default_credential_builder(Box::new(MemoryBuilder)));
}

fn platform_error(code: i32) -> keyring::Error {
    keyring::Error::PlatformFailure(Box::new(security_framework::base::Error::from_code(code)))
}
fn configure(id: &str, product: bool, change: impl FnOnce(&mut Data)) {
    install();
    let entry = if product {
        production_entry(id)
    } else {
        entry(id)
    }
    .unwrap();
    let memory = entry
        .get_credential()
        .downcast_ref::<MemoryEntry>()
        .unwrap();
    change(&mut memory.0.lock().unwrap());
}

#[test]
fn access_code_persists_across_entry_handles_resets_and_never_crosses_namespaces() {
    install();
    let id = random_id().unwrap();
    assert_eq!(load(&id), Ok(None));
    assert_eq!(production_load(&id), Ok(None));
    assert_eq!(authorize_existing(&id).unwrap_err(), "agent_access_missing");
    assert_eq!(
        production_authorize(&id).unwrap_err(),
        "agent_access_missing"
    );
    let fixture = establish(&id, false).unwrap();
    assert_eq!(establish(&id, false).unwrap(), fixture);
    assert_eq!(authorize_existing(&id).unwrap(), fixture);
    assert_eq!(production_load(&id), Ok(None));
    let product = production_establish(&id, false).unwrap();
    assert_ne!(fixture, product);
    assert_eq!(production_establish(&id, false).unwrap(), product);
    assert_eq!(production_authorize(&id).unwrap(), product);
    assert_ne!(production_establish(&id, true).unwrap(), product);
    assert_ne!(establish(&id, true).unwrap(), fixture);
    remove(&id).unwrap();
    remove(&id).unwrap();
    assert_eq!(load(&id), Ok(None));
    assert!(production_load(&id).unwrap().is_some());
}

#[test]
fn malformed_missing_or_changed_material_is_never_silently_regenerated() {
    install();
    for invalid in ["", "bad/id", &"x".repeat(65)] {
        assert!(matches!(entry(invalid), Err("invalid_vault_id")));
        assert!(matches!(production_entry(invalid), Err("invalid_vault_id")));
    }
    for product in [false, true] {
        let id = random_id().unwrap();
        configure(&id, product, |data| {
            data.value = Some(b"invalid value".to_vec())
        });
        let result = if product {
            production_load(&id)
        } else {
            load(&id)
        };
        assert_eq!(result.unwrap_err(), "invalid_access_material");
        configure(&id, product, |data| {
            data.value = Some(vec![b'a'; 64]);
            data.reads = 0;
            data.change_on_second_read = true;
        });
        let result = if product {
            production_authorize(&id)
        } else {
            authorize_existing(&id)
        };
        assert_eq!(result.unwrap_err(), "credential_store_changed");
    }
    assert!(!equal_material("short", &"a".repeat(64)));
    assert!(!equal_material(&"a".repeat(64), "short"));
    assert!(!equal_material(&"a".repeat(64), &"b".repeat(64)));
    assert!(equal_material(&"a".repeat(64), &"a".repeat(64)));
}

#[test]
fn authorization_and_persistence_failures_preserve_explicit_error_codes() {
    install();
    for product in [false, true] {
        let id = random_id().unwrap();
        configure(&id, product, |data| data.read_error = Some(-25308));
        assert_eq!(
            if product {
                production_load(&id)
            } else {
                load(&id)
            }
            .unwrap_err(),
            "credential_authorization_required"
        );
        configure(&id, product, |data| data.write_error = Some(-25293));
        assert_eq!(
            if product {
                production_establish(&id, false)
            } else {
                establish(&id, false)
            }
            .unwrap_err(),
            "credential_authorization_denied"
        );
        configure(&id, product, |data| data.skip_write = true);
        assert_eq!(
            if product {
                production_establish(&id, false)
            } else {
                establish(&id, false)
            }
            .unwrap_err(),
            "credential_store_write_not_verified"
        );
    }
    let id = random_id().unwrap();
    establish(&id, false).unwrap();
    configure(&id, false, |data| data.skip_delete = true);
    assert_eq!(
        remove(&id).unwrap_err(),
        "credential_store_delete_not_verified"
    );
    assert_eq!(
        storage_error(keyring::Error::NoEntry),
        "credential_store_unavailable"
    );
}
