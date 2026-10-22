import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverKeychainSurface } from "../surface-budget-keychain.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const expected = [
  "service=Skill Repo Tracker;account=github-account-token:github:<slug>",
  "service=Skill Repo Tracker;account=github-token",
];

function canonicalLib() {
  return `
    const TOKEN_SERVICE: &str = "Skill Repo Tracker";
    const TOKEN_USER: &str = "github-token";
    fn github_account_token_key(account_id: &str) -> String {
      format!("github-account-token:{account_id}")
    }
  `;
}

function canonicalAdapters() {
  return `
    fn keychain_account_allowed(key: &str) -> bool {
      key == crate::TOKEN_USER
        || key.strip_prefix("github-account-token:github:").is_some_and(|account| {
          !account.is_empty()
            && account.bytes().all(|byte| {
              byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'-' | b'_')
            })
        })
    }
    fn system_keychain_entry(service: &str, key: &str) -> Result<keyring::Entry, String> {
      if service != crate::TOKEN_SERVICE {
        return Err("unreviewed keychain service".to_string());
      }
      if !keychain_account_allowed(key) {
        return Err("unreviewed keychain account namespace".to_string());
      }
      keyring::Entry::new(crate::TOKEN_SERVICE, key).map_err(|error| error.to_string())
    }
    trait CredentialStore {
      fn get(&self, service: &str, key: &str) -> Result<Option<String>, String>;
      fn set(&self, service: &str, key: &str, secret: &str) -> Result<(), String>;
      fn delete(&self, service: &str, key: &str) -> Result<(), String>;
    }
    struct SystemKeychain;
    impl CredentialStore for SystemKeychain {
      fn get(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        let entry = system_keychain_entry(service, key)?;
        map_keyring_get(entry.get_password())
      }
      fn set(&self, service: &str, key: &str, secret: &str) -> Result<(), String> {
        system_keychain_entry(service, key)?
          .set_password(secret)
          .map_err(|error| error.to_string())
      }
      fn delete(&self, service: &str, key: &str) -> Result<(), String> {
        let entry = system_keychain_entry(service, key)?;
        map_keyring_delete(entry.delete_credential())
      }
    }
  `;
}

function writeFixture(root) {
  mkdirSync(path.join(root, "src-tauri/src"), { recursive: true });
  writeFileSync(path.join(root, "src-tauri/src/lib.rs"), canonicalLib());
  writeFileSync(path.join(root, "src-tauri/src/adapters.rs"), canonicalAdapters());
}

test("Keychain service and account namespaces are exact reviewed surfaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-keychain-surface-"));
  try {
    writeFixture(root);
    assert.deepEqual(discoverKeychainSurface(root), expected);

    const libPath = path.join(root, "src-tauri/src/lib.rs");
    for (const mutation of [
      canonicalLib().replace("Skill Repo Tracker", "Unreviewed Service"),
      canonicalLib().replace("github-token", "unreviewed-token"),
      canonicalLib().replace("github-account-token:{account_id}", "hidden:{account_id}"),
    ]) {
      writeFileSync(libPath, mutation);
      assert.throws(() => discoverKeychainSurface(root), /Keychain|keychain|TOKEN_/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the canonical adapters.rs Entry constructor seam may touch keyring", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-keychain-adapter-"));
  try {
    writeFixture(root);
    const adaptersPath = path.join(root, "src-tauri/src/adapters.rs");
    const baseline = readFileSync(adaptersPath, "utf8");
    for (const mutation of [
      `${baseline}\nfn hidden(key: &str) { let _ = keyring::Entry::new("Unreviewed Service", key); }`,
      baseline.replace(
        "keyring::Entry::new(crate::TOKEN_SERVICE, key)",
        "keyring::Entry::new(service, key)",
      ),
      `${baseline}\nuse keyring::Entry as Hidden;`,
      `${baseline}\ntype Hidden = keyring::Entry;`,
      `${baseline}\nfn hidden(key: &str) { let _ = Entry::new(crate::TOKEN_SERVICE, key); }`,
    ]) {
      writeFileSync(adaptersPath, mutation);
      assert.throws(
        () => discoverKeychainSurface(root),
        /canonical Keychain Entry seam|keyring alias|keyring Entry reference/,
        mutation,
      );
    }

    writeFileSync(adaptersPath, baseline);
    writeFileSync(
      path.join(root, "src-tauri/src/hidden.rs"),
      'fn hidden() { let _ = keyring::Entry::new("Unreviewed Service", "hidden"); }',
    );
    assert.throws(
      () => discoverKeychainSurface(root),
      /keyring references are restricted to src-tauri\/src\/adapters\.rs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the checked-in Keychain adapter matches the exact namespace contract", () => {
  assert.deepEqual(discoverKeychainSurface(repositoryRoot), [
    "service=Skill Repo Tracker Credential Access;account=vault:<id>",
    "service=Skill Repo Tracker E0 Credential Access;account=vault:<id>",
    ...expected,
  ]);
});

test("credential Keychain background access cannot enable UI or bypass the serialized guard", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-keychain-interaction-"));
  try {
    writeFixture(root);
    const target = path.join(root, "src-tauri/src/credential_auth.rs");
    const baseline = readFileSync(path.join(repositoryRoot, "src-tauri/src/credential_auth.rs"), "utf8");
    writeFileSync(target, baseline);
    assert.equal(discoverKeychainSurface(root).length, 4);
    for (const mutation of [
      baseline.replace("noninteractive(|| load_existing(vault_id))", "load_existing(vault_id)"),
      baseline.replace("noninteractive(|| establish_without_ui(vault_id, reset))", "establish_without_ui(vault_id, reset)"),
      baseline.replace("noninteractive(|| remove_without_ui(vault_id))", "remove_without_ui(vault_id)"),
      baseline.replace(".lock()", ".try_lock()"),
      baseline.replace("    operation()", "    drop(_no_ui); operation()"),
      baseline.replace("if !equal_material(&previous, &current)", "if false && !equal_material(&previous, &current)"),
      baseline.replace('let previous = load_existing(vault_id)?.ok_or("agent_access_missing")?;', "let previous = establish(vault_id, true)?;"),
      baseline.replace("Some(-128)", "Some(-1)"),
      baseline.replace("fn load_existing(", "pub(crate) fn load_existing("),
      `${baseline}\nfn hidden() { load_existing("elsewhere"); }`,
      `${baseline}\nfn hidden() { let _ = security_framework::os::macos::keychain::SecKeychain::default(); }`,
      `${baseline}\nuse security_framework::os::macos::keychain::SecKeychain as Hidden;`,
      `${baseline}\ntype Hidden = security_framework::os::macos::keychain::SecKeychain;`,
    ]) {
      assert.notEqual(mutation, baseline);
      writeFileSync(target, mutation);
      assert.throws(() => discoverKeychainSurface(root), /credential Keychain/);
    }
    writeFileSync(target, baseline);
    writeFileSync(path.join(root, "src-tauri/src/other.rs"),
      "fn hidden() { security_framework::os::macos::keychain::SecKeychain::disable_user_interaction(); }");
    assert.throws(() => discoverKeychainSurface(root), /security-framework is restricted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
