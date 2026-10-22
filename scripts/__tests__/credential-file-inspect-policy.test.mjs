import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverRustExecutionSurface } from "../surface-budget-rust.mjs";
import { writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

const baseline = readFileSync(new URL("../../src-tauri/src/credential_file_inspect.rs", import.meta.url), "utf8");

function fixture(action) {
  const root = mkdtempSync(path.join(tmpdir(), "srt-file-inspect-policy-"));
  try {
    writeMinimalSurfaceRepository(root);
    const target = path.join(root, "src-tauri/src/credential_file_inspect.rs");
    writeFileSync(target, baseline);
    action(root, target);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("credential inspector admits only its bounded OpenSSL process with private output", () => {
  fixture((root, target) => {
    const surface = discoverRustExecutionSurface(root);
    assert.ok(surface.rustPathSites.includes(
      'src-tauri/src/credential_file_inspect.rs:Command::new("/usr/bin/openssl"):run#1'));
    assert.ok(surface.rustPathSites.includes(
      "src-tauri/src/credential_file_inspect.rs:tempfile::tempfile:run#1"));
    assert.ok(surface.rustPathSites.includes(
      "src-tauri/src/credential_file_inspect.rs:tempfile::tempdir:inspect#1"));
    assert.equal(surface.rustTaskSites.length, 0);
    // Whitespace/comments outside literals are not policy changes.
    writeFileSync(target, baseline.replace('.env_clear()', '.env_clear( /* inherited environment rejected */ )'));
    assert.doesNotThrow(() => discoverRustExecutionSurface(root));
  });
});

test("credential inspector rejects executable, environment, pipe and argument widening", () => {
  fixture((root, target) => {
    for (const [before, after] of [
      ['"/usr/bin/openssl"', '"openssl"'],
      ['"/usr/bin/openssl"', '"/usr/bin/ open ssl"'],
      ['"/usr/bin/openssl"', '"/bin/sh"'],
      ['"/usr/bin/openssl"', "requested_program"],
      [".args(arguments)", ".args(user_arguments)"],
      [".env_clear()", ""],
      [".env_clear()", '.env_clear().env("SECRET", passphrase)'],
      [".stdin(Stdio::piped())", ".stdin(Stdio::inherit())"],
      [".stdout(Stdio::from(writer))", ".stdout(Stdio::inherit())"],
      [".stderr(Stdio::null())", ".stderr(Stdio::piped())"],
      ["tempfile::tempfile()", 'File::create("named-plaintext")'],
      ['"-pubout".into()', '"-text".into()'],
      ['"-pubkey".into()', '"-text".into()'],
      ['"stdin".into()', 'passphrase.into()'],
      ['"-CAfile".into()', '"-CApath".into()'],
      ['"-check_ss_sig".into()', '"-purpose".into()'],
      ["empty_store.as_os_str().to_owned()", '"/etc/ssl/certs".into()'],
      ["fn run(", "pub(crate) fn run("],
      ["fn key_arguments(", "pub(crate) fn key_arguments("],
      [/run\(\s*&key_arguments\(path\)/, "run(&vec![user_argument]"],
    ]) {
      const mutation = baseline.replace(before, after);
      assert.notEqual(mutation, baseline, String(before));
      writeFileSync(target, mutation);
      assert.throws(() => discoverRustExecutionSurface(root), /credential inspector/, String(before));
    }
  });
});

test("credential inspector rejects unbounded lifetimes, outputs and reusable execution seams", () => {
  fixture((root, target) => {
    for (const mutation of [
      baseline.replace("Duration::from_secs(5)", "Duration::from_secs(500)"),
      baseline.replace("Duration::from_millis(10)", "Duration::from_millis(0)"),
      baseline.replace("64 * 1024", "1024 * 1024"),
      baseline.replace(/output\s*\.take\(OUTPUT_LIMIT \+ 1\)/, "output"),
      baseline.replace("value.len() > 1024", "value.len() > 65536"),
      baseline.replace("let _ = self.child.kill();", ""),
      baseline.replace("let _ = self.child.wait();", ""),
      baseline.replace("impl Drop for OwnedChild", "impl Drop for UnusedChild"),
      baseline + "\nfn another() { run(user_arguments, secret, deadline); }",
      baseline + "\nfn alias() { let execute = run; execute(user_arguments, secret, deadline); }",
      baseline + "\nfn alias() { let arguments = key_arguments; }",
      baseline + '\nfn another() { Command::new("/usr/bin/openssl").args(arguments).env_clear().stdin(Stdio::piped()).stdout(Stdio::from(writer)).stderr(Stdio::null()).spawn(); }',
    ]) {
      assert.notEqual(mutation, baseline);
      writeFileSync(target, mutation);
      assert.throws(() => discoverRustExecutionSurface(root), /credential inspector/);
    }
    rmSync(target);
    writeFileSync(path.join(root, "src-tauri/src/other.rs"), baseline);
    assert.throws(() => discoverRustExecutionSurface(root), /process Command|Rust spawn primitive/);
  });
});
