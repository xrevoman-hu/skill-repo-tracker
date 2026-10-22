import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { nativeCommandArguments } from "../native-command.mjs";
import { nativeLinkEnvironment } from "../credential-native-environment.mjs";
import { validateCredentialNativeSourcePolicy, validateTauriBuildScriptPolicy } from "../core-policy-contracts.mjs";

test("native command wrapper preserves exact MSRV, test and performance scopes", () => {
  assert.deepEqual(nativeCommandArguments("check-msrv"), {
    kind: "cargo",
    args: ["+1.88.0", "check", "--locked", "--all-targets", "--all-features", "--manifest-path", "src-tauri/Cargo.toml"],
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
    assert.match(source, /import \{ prepareCredentialNative \} from "\.\/credential-native-build\.mjs"/);
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
    baseline.replace("4.19.0", "4.5.7"),
    baseline.replace("3.53.4", "3.45.3"),
    baseline.replace("target/credential-native/4.19.0", "/unreviewed/library"),
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
    baseline.replace("https://codeload.github.com/sqlcipher/sqlcipher/tar.gz/refs/tags/v4.19.0", "https://unreviewed.invalid/source"),
    baseline.replace('sourceSha256: "7075f96cbabe45b4ecfc2e6b1745a625f856f695b0827a5506ce9ed85b906aa0"', 'sourceSha256: process.env.SOURCE_SHA'),
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
