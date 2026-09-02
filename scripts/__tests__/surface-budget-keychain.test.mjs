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
  assert.deepEqual(discoverKeychainSurface(repositoryRoot), expected);
});
