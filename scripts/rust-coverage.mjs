#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RUST_COVERAGE_TEST_FILE_PATTERN } from "./source-classification.mjs";

export { RUST_COVERAGE_TEST_FILE_PATTERN } from "./source-classification.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userCargo = join(homedir(), ".cargo", "bin", "cargo");
const cargo = existsSync(userCargo) ? userCargo : "cargo";
const REQUIRED_CARGO_LLVM_COV = "0.9.0";

export function validateCoverageToolVersion(output) {
  if (output.trim() !== `cargo-llvm-cov ${REQUIRED_CARGO_LLVM_COV}`) {
    throw new Error(
      `cargo-llvm-cov ${REQUIRED_CARGO_LLVM_COV} is required; received ${output.trim() || "nothing"}`,
    );
  }
}

function run(args) {
  execFileSync(cargo, args, { cwd: ROOT, stdio: "inherit", env: process.env });
}

function main() {
  const version = execFileSync(cargo, ["llvm-cov", "--version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  validateCoverageToolVersion(version);
  mkdirSync(join(ROOT, "coverage"), { recursive: true });
  run([
    "+nightly-2026-08-01",
    "llvm-cov",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--locked",
    "--all-features",
    "--workspace",
    "--branch",
    "--ignore-filename-regex",
    RUST_COVERAGE_TEST_FILE_PATTERN,
    "--lcov",
    "--output-path",
    "coverage/rust.lcov",
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
