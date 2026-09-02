import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverRustExecutionSurface } from "../surface-budget-rust.mjs";
import { writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

test("canonical recursive DirBuilder creates are exact Rust path surfaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-dir-builder-surface-"));
  try {
    writeMinimalSurfaceRepository(root);
    writeFileSync(
      path.join(root, "src-tauri/src/directories.rs"),
      [
        "fn create_first(path: &std::path::Path) {",
        "  let _ = std::fs::DirBuilder::new().recursive(true).create(path);",
        "}",
        "fn create_second(path: &std::path::Path) {",
        "  let mut builder = std::fs::DirBuilder::new();",
        "  builder.recursive(true);",
        "  builder.create(path);",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(discoverRustExecutionSurface(root).rustPathSites, [
      "src-tauri/src/directories.rs:std::fs::DirBuilder::create:create_first#1",
      "src-tauri/src/directories.rs:std::fs::DirBuilder::create:create_second#1",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary create methods are not mistaken for DirBuilder path sites", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-other-create-"));
  try {
    writeMinimalSurfaceRepository(root);
    writeFileSync(
      path.join(root, "src-tauri/src/factory.rs"),
      "fn create(factory: &mut Factory, path: &str) { factory.create(path); }",
    );
    assert.deepEqual(discoverRustExecutionSurface(root).rustPathSites, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DirBuilder aliases, UFCS, traits, and wrapped values fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-dir-builder-bypass-"));
  try {
    writeMinimalSurfaceRepository(root);
    const sourcePath = path.join(root, "src-tauri/src/directories.rs");
    const bypasses = [
      "use std::fs::DirBuilder; fn create(path: &str) { DirBuilder::new().recursive(true).create(path); }",
      "use std::fs::{DirBuilder}; fn create(path: &str) { DirBuilder::new().recursive(true).create(path); }",
      "use std::fs::DirBuilder as Hidden; fn create(path: &str) { Hidden::new().recursive(true).create(path); }",
      "use std::fs as filesystem; fn create(path: &str) { filesystem::DirBuilder::new().recursive(true).create(path); }",
      "use std::{fs as filesystem}; fn create(path: &str) { filesystem::DirBuilder::new().recursive(true).create(path); }",
      "use std::fs; fn create(path: &str) { fs::DirBuilder::new().recursive(true).create(path); }",
      "use std::{fs}; fn create(path: &str) { fs::DirBuilder::new().recursive(true).create(path); }",
      "type Hidden = std::fs::DirBuilder; fn create(path: &str) { Hidden::new().recursive(true).create(path); }",
      "trait Create { fn create(&mut self, path: &str); } fn create(path: &str) { <std::fs::DirBuilder as Create>::create(&mut std::fs::DirBuilder::new(), path); }",
      "fn create(path: &str) { let constructor = std::fs::DirBuilder::new; constructor().recursive(true).create(path); }",
      "fn create(path: &str) { let builder = Some(std::fs::DirBuilder::new()); builder.unwrap().recursive(true).create(path); }",
      "fn create(path: &str) { let builder = Box::new(std::fs::DirBuilder::new()); builder.recursive(true).create(path); }",
      "fn create(path: &str) { let mut first = std::fs::DirBuilder::new(); let mut second = first; second.recursive(true); second.create(path); }",
      "fn create(path: &str) { std::fs::DirBuilder::new().create(path); }",
      "fn create(path: &str, recursive: bool) { std::fs::DirBuilder::new().recursive(recursive).create(path); }",
    ];
    for (const source of bypasses) {
      writeFileSync(sourcePath, source);
      assert.throws(
        () => discoverRustExecutionSurface(root),
        /DirBuilder|process or filesystem primitives/,
        source,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
