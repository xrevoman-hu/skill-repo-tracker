import assert from "node:assert/strict";
import test from "node:test";

import {
  RUST_COVERAGE_TEST_FILE_PATTERN,
  validateCoverageToolVersion,
} from "../rust-coverage.mjs";

test("Rust coverage requires the pinned cargo-llvm-cov version", () => {
  assert.doesNotThrow(() => validateCoverageToolVersion("cargo-llvm-cov 0.9.0"));
  assert.throws(
    () => validateCoverageToolVersion("cargo-llvm-cov 0.8.2"),
    /cargo-llvm-cov 0.9.0 is required/,
  );
});

test("Rust coverage reports exclude dedicated test modules, not production modules", () => {
  const excluded = new RegExp(RUST_COVERAGE_TEST_FILE_PATTERN);
  assert.equal(excluded.test("/workspace/src-tauri/src/backups_tests.rs"), true);
  assert.equal(excluded.test("/workspace/src-tauri/src/prompts_schema_tests.rs"), true);
  assert.equal(excluded.test("/workspace/src-tauri/tests/schema_upgrade.rs"), true);
  assert.equal(excluded.test("/workspace/src-tauri/src/test.rs"), false);
  assert.equal(excluded.test("/workspace/src-tauri/src/tests.rs"), false);
  assert.equal(excluded.test("/workspace/src-tauri/src/backups.rs"), false);
});
