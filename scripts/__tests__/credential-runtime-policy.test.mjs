import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverKeychainSurface } from "../surface-budget-keychain.mjs";
import { discoverRuntimeInputSurface } from "../surface-budget-runtime-inputs.mjs";
import { discoverRustExecutionSurface } from "../surface-budget-rust.mjs";
import { writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

function fixture(prefix, action) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try { writeMinimalSurfaceRepository(root); action(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("credential Unix sockets are inventoried only in the dedicated adapter and never permit network aliases", () => {
  fixture("srt-credential-ipc-policy-", (root) => {
    const source = 'use std::os::unix::net::{UnixListener, UnixStream}; fn bind_listener() { UnixListener::bind("owned"); } fn connect_host() { UnixStream::connect("owned"); }';
    const target = path.join(root, "src-tauri/src/credential_ipc.rs");
    writeFileSync(target, source);
    assert.deepEqual(discoverRustExecutionSurface(root).rustPathSites, [
      "src-tauri/src/credential_ipc.rs:UnixListener::bind:bind_listener#1",
      "src-tauri/src/credential_ipc.rs:UnixStream::connect:connect_host#1",
    ]);
    for (const mutation of [
      `${source} fn hidden() { std::net::TcpStream::connect("elsewhere"); }`,
      `${source} fn hidden() { UnixStream::pair(); }`,
      `${source} use std::os::unix::net::UnixStream as Hidden;`,
      `${source} type Hidden = UnixStream;`,
      `${source} use std::os::unix::net::*;`,
      source.replace('UnixStream::connect("owned")', "let _hidden = UnixStream::connect"),
      `${source} fn hidden() { std::os::unix::net::UnixDatagram::bind("elsewhere"); }`,
    ]) {
      writeFileSync(target, mutation);
      assert.throws(() => discoverRustExecutionSurface(root), /credential socket|network transport/);
    }
    rmSync(target);
    writeFileSync(path.join(root, "src-tauri/src/other.rs"), source);
    assert.throws(() => discoverRustExecutionSurface(root), /network transport/);
  });
});

test("credential CLI and executable identity inputs require exact files and functions", () => {
  fixture("srt-credential-input-policy-", (root) => {
    const runtime = path.join(root, "src-tauri/src/credential_runtime.rs");
    const ipc = path.join(root, "src-tauri/src/credential_ipc.rs");
    writeFileSync(runtime, "fn dispatch_from_env() { std::env::args_os(); }");
    writeFileSync(ipc, "fn verify_peer() { std::env::current_exe(); }");
    assert.deepEqual(discoverRuntimeInputSurface(root), [
      "rust:src-tauri/src/credential_ipc.rs:std::env::current_exe:<current-executable>#1",
      "rust:src-tauri/src/credential_runtime.rs:std::env::args_os:<credential-cli>#1",
    ]);
    for (const mutation of [
      "fn arbitrary() { std::env::args_os(); }",
      "fn dispatch_from_env() { std::env::args(); }",
      "fn dispatch_from_env() { let get = std::env::args_os; get(); }",
      "fn dispatch_from_env() { std::env::vars(); }",
      'fn dispatch_from_env() { std::env::var("ACCESS_CODE"); }',
    ]) {
      writeFileSync(runtime, mutation);
      assert.throws(() => discoverRuntimeInputSurface(root), /environment input/);
    }
  });
});

test("credential Keychain namespace cannot widen or acquire an additional Entry seam", () => {
  fixture("srt-credential-keychain-policy-", (root) => {
    const target = path.join(root, "src-tauri/src/credential_auth.rs");
    const baseline = readFileSync(new URL("../../src-tauri/src/credential_auth.rs", import.meta.url), "utf8");
    writeFileSync(target, baseline);
    assert.ok(discoverKeychainSurface(root).includes("service=Skill Repo Tracker E0 Credential Access;account=vault:<id>"));
    for (const mutation of [
      baseline.replace("Skill Repo Tracker E0 Credential Access", "Skill Repo Tracker"),
      baseline.replace("value.len() <= 64", "value.len() <= 64000"),
      baseline.replace('format!("vault:{vault_id}")', 'format!("github-token:{vault_id}")'),
      baseline.replace("if !valid_id(vault_id)", "if false"),
      `${baseline}\nfn extra() { keyring::Entry::new("other", "other"); }`,
    ]) {
      assert.notEqual(mutation, baseline);
      writeFileSync(target, mutation);
      assert.throws(() => discoverKeychainSurface(root), /credential Keychain/);
    }
  });
});

test("interactive credential authorization is only an unlocked explicit local control action", () => {
  fixture("srt-credential-explicit-auth-", (root) => {
    const target = path.join(root, "src-tauri/src/credential_runtime.rs");
    const baseline = readFileSync(new URL("../../src-tauri/src/credential_runtime.rs", import.meta.url), "utf8");
    writeFileSync(target, baseline);
    assert.doesNotThrow(() => discoverKeychainSurface(root));
    const inAuthorization = (before, after) => {
      const start = baseline.indexOf("fn authorize_with(");
      assert.ok(start > 0);
      return baseline.slice(0, start) + baseline.slice(start).replace(before, after);
    };
    for (const mutation of [
      baseline.replace('"authorize_access" =>', '"status" =>'),
      baseline.replace("self.authorize_with(credential_auth::authorize_existing)?;", "credential_auth::authorize_existing(&self.vault_id)?;"),
      inAuthorization('self.store.as_ref().ok_or("vault_locked")?;', ""),
      inAuthorization("self.code = None;", "self.sharing = true; self.code = None;"),
      inAuthorization("self.code = None;", "self.persist_sharing(true)?; self.code = None;"),
      inAuthorization("self.invalidate(false)?;", ""),
      inAuthorization("self.authorization_error = Some(error);", "self.authorization_error = None;"),
      `${baseline}\nfn mcp_request() { credential_auth::authorize_existing("vault"); }`,
    ]) {
      assert.notEqual(mutation, baseline);
      writeFileSync(target, mutation);
      assert.throws(() => discoverKeychainSurface(root), /credential Keychain interactive access/);
    }
    rmSync(target);
    writeFileSync(path.join(root, "src-tauri/src/credential_mcp.rs"),
      "fn request() { credential_auth::authorize_existing(\"vault\"); }");
    assert.throws(() => discoverKeychainSurface(root), /credential Keychain interactive access/);
  });
});

test("credential directories permit only mode 0700 at their exact owner functions", () => {
  fixture("srt-credential-directory-policy-", (root) => {
    const target = path.join(root, "src-tauri/src/credential_ipc.rs");
    const source = "fn bind_listener() { std::fs::DirBuilder::new().mode(0o700).create(path); }";
    writeFileSync(target, source);
    assert.deepEqual(discoverRustExecutionSurface(root).rustPathSites, [
      "src-tauri/src/credential_ipc.rs:std::fs::DirBuilder::create:bind_listener#1",
    ]);
    for (const mutation of [
      source.replace("0o700", "0o777"),
      source.replace("0o700", "permissions"),
      source.replace("bind_listener", "arbitrary"),
      source.replace(".mode(0o700)", ""),
      source.replace(".mode(0o700)", ".mode(0o700).recursive(true)"),
      source.replace(".mode(0o700)", ".recursive(true)"),
      source.replace("std::fs::DirBuilder::new()", "DirBuilder::new()"),
    ]) {
      writeFileSync(target, mutation);
      assert.throws(() => discoverRustExecutionSurface(root), /DirBuilder/);
    }
    rmSync(target);
    writeFileSync(path.join(root, "src-tauri/src/other.rs"), source);
    assert.throws(() => discoverRustExecutionSurface(root), /DirBuilder/);
  });
});
