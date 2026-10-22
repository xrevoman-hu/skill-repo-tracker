import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRustExecutionSurface } from "../surface-budget-rust.mjs";
import { discoverRuntimeInputSurface } from "../surface-budget-runtime-inputs.mjs";
import { discoverKeychainSurface } from "../surface-budget-keychain.mjs";
import { writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

test("credential focus invalidation and orphan cleanup retain their bounded native hooks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-product-lifecycle-policy-"));
  try {
    writeMinimalSurfaceRepository(root);
    for (const [file, mutations, error] of [
      ["credential_commands.rs", [
        (source) => source.replace('get_webview_window("main")', 'get_webview_window("other")'),
        (source) => source.replace("WindowEvent::Focused(false)", "WindowEvent::Focused(true)"),
        (source) => source.replace("client.invalidate_focus();", "client.unlock();"),
        (source) => source.replace("RunEvent::Exit)", "RunEvent::ExitRequested)"),
      ], /credential (native focus|exit) hook/],
      ["credential_product.rs", [
        (source) => source.replace("Duration::from_millis(250)", "Duration::from_millis(0)"),
        (source) => source.replace("std::process::exit(1)", "std::process::exit(0)"),
        (source) => source.replace("libc::getppid()", "libc::getpid()"),
      ], /credential parent watcher/],
    ]) {
      const target = path.join(root, "src-tauri/src", file);
      const baseline = readFileSync(new URL(`../../src-tauri/src/${file}`, import.meta.url), "utf8");
      writeFileSync(target, baseline);
      assert.doesNotThrow(() => discoverRustExecutionSurface(root));
      for (const mutate of mutations) {
        const mutation = mutate(baseline);
        assert.notEqual(mutation, baseline);
        writeFileSync(target, mutation);
        assert.throws(() => discoverRustExecutionSurface(root), error);
      }
      rmSync(target);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("credential GUI can spawn only the exact same-executable host pipe contract", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-product-process-policy-"));
  try {
    writeMinimalSurfaceRepository(root);
    const target = path.join(root, "src-tauri/src/credential_commands.rs");
    const baseline = 'fn start_host() { let executable = std::env::current_exe(); ' +
      'Command::new(&executable).arg("--credential-host").arg("--root").arg(&self.root)' +
      '.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn(); }';
    writeFileSync(target, baseline);
    assert.ok(discoverRustExecutionSurface(root).rustPathSites.includes(
      "src-tauri/src/credential_commands.rs:Command::new(<credential-host>):start_host#1"));
    assert.ok(discoverRuntimeInputSurface(root).includes(
      "rust:src-tauri/src/credential_commands.rs:std::env::current_exe:<current-executable>#1"));
    for (const mutation of [
      baseline.replace("&executable", '"sh"'),
      baseline.replace('"--credential-host"', '"--credential-e0-host"'),
      baseline.replace('"--root"', '"--password"'),
      baseline.replace("&self.root", "&user_input"),
      baseline.replace("Stdio::null()", "Stdio::inherit()"),
      baseline.replace(".spawn()", '.env("ACCESS_CODE", secret).spawn()'),
      baseline.replace("start_host", "another_action"),
    ]) {
      assert.notEqual(mutation, baseline);
      writeFileSync(target, mutation);
      assert.throws(() => discoverRustExecutionSurface(root), /process Command|Rust spawn primitive/);
    }
    rmSync(target);
    writeFileSync(path.join(root, "src-tauri/src/other.rs"), baseline);
    assert.throws(() => discoverRustExecutionSurface(root), /process Command|Rust spawn primitive/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("product Keychain access preserves its namespace and explicit unlock gate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-product-auth-policy-"));
  try {
    writeMinimalSurfaceRepository(root);
    const auth = readFileSync(new URL("../../src-tauri/src/credential_auth.rs", import.meta.url), "utf8");
    const host = readFileSync(new URL("../../src-tauri/src/credential_product.rs", import.meta.url), "utf8");
    const authPath = path.join(root, "src-tauri/src/credential_auth.rs");
    const hostPath = path.join(root, "src-tauri/src/credential_product.rs");
    writeFileSync(authPath, auth); writeFileSync(hostPath, host);
    assert.ok(discoverKeychainSurface(root).includes("service=Skill Repo Tracker Credential Access;account=vault:<id>"));
    for (const mutation of [
      auth.replace('"Skill Repo Tracker Credential Access"', '"Skill Repo Tracker"'),
      auth.replace("noninteractive(|| production_existing(vault_id))", "production_existing(vault_id)"),
      auth.replace("fn production_entry", "pub(crate) fn production_entry"),
    ]) {
      assert.notEqual(mutation, auth); writeFileSync(authPath, mutation);
      assert.throws(() => discoverKeychainSurface(root), /credential Keychain/);
    }
    writeFileSync(authPath, auth);
    const start = host.indexOf('"authorize_access" =>');
    assert.ok(start > 0);
    const change = (before, after) => host.slice(0, start) + host.slice(start).replace(before, after);
    for (const mutation of [
      change('"authorize_access"', '"status"'),
      change("self.store()?;", ""),
      change("self.invalidate(false)?;", ""),
      change("self.code", "self.sharing = true; self.code"),
      host + '\nfn automatic() { credential_auth::production_authorize("vault"); }',
    ]) {
      assert.notEqual(mutation, host); writeFileSync(hostPath, mutation);
      assert.throws(() => discoverKeychainSurface(root), /credential product authorization/);
    }
    rmSync(hostPath);
    writeFileSync(path.join(root, "src-tauri/src/credential_mcp.rs"),
      'fn read() { credential_auth::production_authorize("vault"); }');
    assert.throws(() => discoverKeychainSurface(root), /credential product authorization/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native secret clipboard APIs and its single worker remain in the dedicated adapter", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-product-clipboard-policy-"));
  try {
    writeMinimalSurfaceRepository(root);
    const target = path.join(root, "src-tauri/src/credential_clipboard.rs");
    const baseline = readFileSync(new URL("../../src-tauri/src/credential_clipboard.rs", import.meta.url), "utf8");
    writeFileSync(target, baseline);
    assert.ok(discoverRustExecutionSurface(root).rustTaskSites.includes(
      "src-tauri/src/credential_clipboard.rs:std::thread::Builder::spawn:start_worker#1"));
    for (const mutation of [
      baseline.replace('"credential-clipboard".into()', '"another-worker".into()'),
      baseline.replace("cleanup_worker(shared)", "arbitrary_worker(shared)"),
      baseline.replace("NSPasteboard::generalPasteboard()", "NSPasteboard::pasteboardWithUniqueName()"),
      baseline + '\nfn extra() { objc2_app_kit::NSPasteboard::generalPasteboard(); }',
      baseline + '\nuse objc2_app_kit::NSPasteboard as Hidden;',
    ]) {
      assert.notEqual(mutation, baseline); writeFileSync(target, mutation);
      assert.throws(() => discoverRustExecutionSurface(root), /clipboard/);
    }
    rmSync(target);
    writeFileSync(path.join(root, "src-tauri/src/other.rs"),
      'fn clear() { objc2_app_kit::NSPasteboard::generalPasteboard(); }');
    assert.throws(() => discoverRustExecutionSurface(root), /clipboard/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
