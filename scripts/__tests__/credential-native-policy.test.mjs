import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as credentialNative from "../credential-native-build.mjs";
import { nativeCommandArguments } from "../native-command.mjs";
import { nativeLinkEnvironment } from "../credential-native-environment.mjs";
import { validateCredentialNativeSourcePolicy, validateTauriBuildScriptPolicy } from "../core-policy-contracts.mjs";

// SQLCipher v4.20.0 README's complete license section, including its final blank line.
const SQLCIPHER_LICENSE = `## Community Edition Open Source License

Copyright (c) 2025, ZETETIC LLC
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the ZETETIC LLC nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY ZETETIC LLC ''AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL ZETETIC LLC BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

`;

function withNativeLicenseFixture(operation) {
  const root = mkdtempSync(join(tmpdir(), "srt-native-license-"));
  const app = join(root, "Fixture.app");
  const native = join(root, "native");
  const lib = join(native, "lib");
  const source = join(native, "LICENSE.sqlcipher");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(join(app, "Contents"), { recursive: true });
  mkdirSync(lib, { recursive: true });
  writeFileSync(source, SQLCIPHER_LICENSE);
  try { operation({ root, app, native, lib, source, resources }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("native license installation includes complete reviewed text in a fresh app", () => {
  withNativeLicenseFixture(({ app, native, lib, source, resources }) => {
    credentialNative.installCredentialNativeLicense(app, lib);
    assert.equal(readFileSync(join(resources, "LICENSE.sqlcipher"), "utf8"), SQLCIPHER_LICENSE);
    assert.equal(readFileSync(source, "utf8"), SQLCIPHER_LICENSE);
    credentialNative.installCredentialNativeLicense(app, lib);
    rmSync(native, { recursive: true });
    assert.doesNotThrow(() => credentialNative.verifyCredentialNativeLicense(app));
  });
});

test("native license verification rejects absent altered and symlinked bundle resources", () => {
  withNativeLicenseFixture(({ app, lib, source, resources }) => {
    assert.throws(() => credentialNative.verifyCredentialNativeLicense(app), /SQLCipher license/);
    credentialNative.installCredentialNativeLicense(app, lib);
    const license = join(resources, "LICENSE.sqlcipher");
    writeFileSync(license, "incomplete license");
    assert.throws(() => credentialNative.verifyCredentialNativeLicense(app), /SQLCipher license/);
    rmSync(license);
    symlinkSync(source, license);
    assert.throws(() => credentialNative.verifyCredentialNativeLicense(app), /SQLCipher license/);
    assert.throws(() => credentialNative.installCredentialNativeLicense(app, lib), /SQLCipher license/);
    assert.equal(readFileSync(source, "utf8"), SQLCIPHER_LICENSE);
  });
});

test("native license installation rejects unreviewed source and redirected app directories", () => {
  withNativeLicenseFixture(({ app, lib, source }) => {
    writeFileSync(source, "unreviewed source license");
    assert.throws(() => credentialNative.installCredentialNativeLicense(app, lib), /SQLCipher license/);
  });
  for (const segment of ["", "Contents", "Contents/Resources"]) {
    withNativeLicenseFixture(({ root, app, lib, source }) => {
      const outside = join(root, "outside");
      mkdirSync(outside);
      const redirected = join(app, segment);
      rmSync(redirected, { recursive: true, force: true });
      symlinkSync(outside, redirected);
      assert.throws(() => credentialNative.installCredentialNativeLicense(app, lib), /SQLCipher license/);
      assert.throws(() => credentialNative.verifyCredentialNativeLicense(app), /SQLCipher license/);
      assert.equal(readFileSync(source, "utf8"), SQLCIPHER_LICENSE);
    });
  }
});

test("native command wrapper preserves exact MSRV, test and performance scopes", () => {
  assert.deepEqual(nativeCommandArguments("check-msrv"), {
    kind: "cargo",
    args: ["+1.89.0", "check", "--locked", "--all-targets", "--all-features", "--manifest-path", "src-tauri/Cargo.toml"],
  });
  assert.deepEqual(nativeCommandArguments("rust-tests").args,
    ["test", "--locked", "--all-features", "--manifest-path", "src-tauri/Cargo.toml"]);
  assert.deepEqual(nativeCommandArguments("performance").args.slice(-5),
    ["prompt_library_release_performance_gate", "--", "--ignored", "--nocapture", "--test-threads=1"]);
  assert.deepEqual(nativeCommandArguments("tauri", ["build", "--bundles", "app"]),
    { kind: "tauri", args: ["build", "--bundles", "app"] });
});

test("native wrapper rejects arbitrary processes and altered fixed Rust lanes", () => {
  for (const [mode, args] of [
    ["sh", ["-c", "fictional command"]],
    ["cargo", ["test", "--no-default-features"]],
    ["check-msrv", ["--no-default-features"]],
    ["rust-tests", ["one_test"]],
    ["performance", ["--skip", "required"]],
    ["toString", []],
  ]) assert.throws(() => nativeCommandArguments(mode, args), /unsupported native command/);
});

test("native preparation is shared by verification, coverage and release without replacing their gates", () => {
  for (const name of ["verify", "rust-coverage", "release-verify", "native-command"]) {
    const source = readFileSync(new URL(`../${name}.mjs`, import.meta.url), "utf8");
    const imports = name === "release-verify"
      ? "installCredentialNativeLicense, prepareCredentialNative, verifyCredentialNativeLicense"
      : "prepareCredentialNative";
    assert.ok(source.includes(`import { ${imports} } from "./credential-native-build.mjs"`));
    assert.match(source, /prepareCredentialNative\(ROOT\)/);
    assert.match(source, /import \{ nativeLinkEnvironment \} from "\.\/credential-native-environment\.mjs"/);
    if (name === "verify") assert.match(source, /Object\.assign\(env, nativeLinkEnvironment\(prepareCredentialNative\(ROOT\)\)\)/);
    else assert.match(source, /env: \{ \.\.\.process\.env, \.\.\.nativeLinkEnvironment\(/);
  }
  const verify = readFileSync(new URL("../verify.mjs", import.meta.url), "utf8");
  assert.match(verify, /for \(const \{ label, command: commandName, args \} of VERIFY_PLAN\)/);
  assert.ok(verify.indexOf("validateVerifyPlan(VERIFY_PLAN)") < verify.indexOf("prepareCredentialNative(ROOT)"));
});

test("native linker environment cannot inherit a pkg-config or dynamic-library override", () => {
  const prepared = {
    SQLCIPHER_LIB_DIR: "/fictional/project/target/native/lib",
    SQLCIPHER_INCLUDE_DIR: "/fictional/project/target/native/include",
    SQLCIPHER_STATIC: "1",
    SRT_CIPHER_SOURCE_SHA256: "pinned-source-digest",
  };
  const ambient = { SQLCIPHER_LIB_DIR: "/unreviewed/lib", SQLCIPHER_STATIC: "0",
    SQLCIPHER_NO_PKG_CONFIG: "0", LIBSQLITE3_SYS_USE_PKG_CONFIG: "1" };
  assert.deepEqual({ ...ambient, ...nativeLinkEnvironment(prepared) }, {
    ...prepared, SQLCIPHER_NO_PKG_CONFIG: "1", LIBSQLITE3_SYS_USE_PKG_CONFIG: "0",
  });
  for (const mutation of [
    { ...prepared, SQLCIPHER_STATIC: "0" },
    { ...prepared, SQLCIPHER_LIB_DIR: "" },
    { ...prepared, EXTRA_LINKER: "unreviewed" },
    { ...prepared, SQLCIPHER_NO_PKG_CONFIG: "0" },
  ]) assert.throws(() => nativeLinkEnvironment(mutation), /exact prepared static contract/);
});

test("native build contract rejects removed integrity checks, alternate libraries and Tauri overrides", () => {
  const baseline = readFileSync(new URL("../../src-tauri/build.rs", import.meta.url), "utf8");
  assert.deepEqual(validateTauriBuildScriptPolicy(baseline), []);
  for (const mutation of [
    baseline.replace("verify_native_dependency();", ""),
    baseline.replace("SQLCIPHER_STATIC", "UNREVIEWED_STATIC"),
    baseline.replace("SQLCIPHER_NO_PKG_CONFIG", "UNREVIEWED_NO_PKG_CONFIG"),
    baseline.replace("LIBSQLITE3_SYS_USE_PKG_CONFIG", "UNREVIEWED_USE_PKG_CONFIG"),
    baseline.replace("4.20.0", "4.5.7"),
    baseline.replace("3.54.1", "3.45.3"),
    baseline.replace("target/credential-native/4.20.0", "/unreviewed/library"),
    baseline.replace("Sha256::digest(&bytes)", "Sha256::digest(b\"unchecked\")"),
    baseline.replace("framework=Security", "dylib=unreviewed"),
    baseline.replace("tauri_build::build();", 'println!("cargo:rustc-env=TAURI_CONFIG=unsafe"); tauri_build::build();'),
    "fn main() {\n    tauri_build::build();\n}\n",
  ]) {
    assert.notEqual(mutation, baseline);
    assert.match(validateTauriBuildScriptPolicy(mutation)[0], /exact reviewed native\/Tauri/);
  }
});

test("native preparation rejects source, environment, cache and compiler bypasses", () => {
  const baseline = readFileSync(new URL("../credential-native-build.mjs", import.meta.url), "utf8");
  assert.deepEqual(validateCredentialNativeSourcePolicy(baseline), []);
  for (const mutation of [
    baseline.replace("https://codeload.github.com/sqlcipher/sqlcipher/tar.gz/refs/tags/v4.20.0", "https://unreviewed.invalid/source"),
    baseline.replace('sourceSha256: "38705f51b61ac0636a5fd064f9a77fafabc7227b2aa2513f1b14c8bb1102affc"', 'sourceSha256: process.env.SOURCE_SHA'),
    baseline.replace('env: BUILD_ENV', 'env: process.env'),
    baseline.replace('resolve(root, "src-tauri/target/credential-native")', 'process.env.NATIVE_ROOT'),
    baseline.replace('rejectSymlinkAncestors(destination);', ''),
    baseline.replace('digest(readFileSync(file)) === receipt.files?.[name]', 'true'),
    baseline.replace('SQLCIPHER_STATIC: "1"', 'SQLCIPHER_STATIC: "0"'),
    baseline.replace('"--proto", "=https"', '"--location"'),
  ]) {
    assert.notEqual(mutation, baseline);
    assert.match(validateCredentialNativeSourcePolicy(mutation)[0], /exact reviewed pinned-source/);
  }
});
