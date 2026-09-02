import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverRepositorySurface, validateSurfaceBudget } from "../surface-budget.mjs";
import { discoverRustExecutionSurface } from "../surface-budget-rust.mjs";
import {
  emptyCategories,
  writeMinimalSurfaceRepository,
} from "./surface-budget-fixtures.mjs";

test("rusqlite disk connections are exact Rust path surfaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-rusqlite-surface-"));
  try {
    writeMinimalSurfaceRepository(root);
    const hiddenPath = path.join(root, "src-tauri/src/hidden.rs");
    writeFileSync(
      hiddenPath,
      [
        "use rusqlite::{Connection, OpenFlags};",
        "fn connect(path: &std::path::Path) {",
        "  let _ = Connection::open(path);",
        "  let _ = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY);",
        "  let _ = rusqlite::Connection::open(path);",
        "}",
      ].join("\n"),
    );
    const ids = [
      "src-tauri/src/hidden.rs:rusqlite::Connection::open_with_flags:connect#1",
      "src-tauri/src/hidden.rs:rusqlite::Connection::open:connect#1",
      "src-tauri/src/hidden.rs:rusqlite::Connection::open:connect#2",
    ];
    assert.deepEqual(discoverRustExecutionSurface(root).rustPathSites, ids);
    const errors = validateSurfaceBudget({
      budget: { schemaVersion: 1, categories: emptyCategories() },
      actual: discoverRepositorySurface(root),
    });
    for (const id of ids) {
      assert.ok(errors.includes(`unregistered rustPathSites surface: ${id}`), id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rusqlite in-memory connections do not consume path budget", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-rusqlite-memory-"));
  try {
    writeMinimalSurfaceRepository(root);
    writeFileSync(
      path.join(root, "src-tauri/src/memory.rs"),
      [
        "use rusqlite::Connection;",
        "fn connect() {",
        "  let _ = Connection::open_in_memory();",
        "  let _ = rusqlite::Connection::open_in_memory();",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(discoverRustExecutionSurface(root).rustPathSites, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rusqlite path aliases, UFCS, traits, and indirect calls fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-rusqlite-bypass-"));
  try {
    writeMinimalSurfaceRepository(root);
    const hiddenPath = path.join(root, "src-tauri/src/hidden.rs");
    const bypasses = [
      "use rusqlite::Connection as Hidden; fn connect(path: &str) { let _ = Hidden::open(path); }",
      "use rusqlite::{Connection as Hidden}; fn connect(path: &str) { let _ = Hidden::open(path); }",
      "use rusqlite as database; fn connect(path: &str) { let _ = database::Connection::open(path); }",
      "use {rusqlite as database}; fn connect(path: &str) { let _ = database::Connection::open(path); }",
      "extern crate rusqlite as database; fn connect(path: &str) { let _ = database::Connection::open(path); }",
      "use rusqlite::{self as database, Connection}; fn connect(path: &str) { let _ = database::Connection::open(path); }",
      "use rusqlite::Connection; type Hidden = Connection; fn connect(path: &str) { let _ = Hidden::open(path); }",
      "type Hidden = rusqlite::Connection; fn connect(path: &str) { let _ = Hidden::open(path); }",
      "use rusqlite::Connection; trait Open { fn open(path: &str); } fn connect(path: &str) { <Connection as Open>::open(path); }",
      "trait Open { fn open(path: &str); } fn connect(path: &str) { <rusqlite::Connection as Open>::open(path); }",
      "use rusqlite::Connection; fn connect(path: &str) { let _ = <Connection>::open(path); }",
      "use rusqlite::Connection; fn connect(path: &str) { let open = Connection::open; let _ = open(path); }",
      "pub use rusqlite::Connection as Hidden; fn connect(path: &str) { let _ = Hidden::open(path); }",
      "mod database { pub use rusqlite::Connection; } use database::Connection; fn connect(path: &str) { let _ = Connection::open(path); }",
    ];
    for (const source of bypasses) {
      writeFileSync(hiddenPath, source);
      assert.throws(
        () => discoverRustExecutionSurface(root),
        /rusqlite.*(?:alias|canonical direct call|UFCS|trait|re-export)|process or filesystem primitives/i,
        source,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
