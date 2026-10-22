#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareCredentialNative } from "./credential-native-build.mjs";
import { nativeLinkEnvironment } from "./credential-native-environment.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = ["--manifest-path", "src-tauri/Cargo.toml"];

export function nativeCommandArguments(mode, trailing = []) {
  const cargo = {
    "check-msrv": ["+1.88.0", "check", "--locked", "--all-targets", "--all-features", ...MANIFEST],
    "rust-tests": ["test", "--locked", "--all-features", ...MANIFEST],
    "build-debug": ["build", "--locked", ...MANIFEST],
    "build-release": ["build", "--release", "--locked", ...MANIFEST],
    performance: [
      "test", "--release", "--locked", ...MANIFEST,
      "prompt_library_release_performance_gate", "--", "--ignored", "--nocapture", "--test-threads=1",
    ],
  };
  if (mode === "tauri") return { kind: "tauri", args: trailing };
  if (!Object.hasOwn(cargo, mode) || trailing.length !== 0) {
    throw new Error("unsupported native command or additional arguments");
  }
  return { kind: "cargo", args: cargo[mode] };
}

function main() {
  const selected = nativeCommandArguments(process.argv[2], process.argv.slice(3));
  const nativeEnv = prepareCredentialNative(ROOT);
  const userCargo = join(homedir(), ".cargo", "bin", "cargo");
  const command = selected.kind === "tauri"
    ? process.execPath
    : existsSync(userCargo) ? userCargo : "cargo";
  const args = selected.kind === "tauri"
    ? [join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...selected.args]
    : selected.args;
  execFileSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...nativeLinkEnvironment(nativeEnv) },
    stdio: "inherit",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
