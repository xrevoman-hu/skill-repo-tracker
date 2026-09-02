import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverRuntimeInputSurface } from "../surface-budget-runtime-inputs.mjs";
import { writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("production browser storage APIs remain forbidden until an adapter and key budget exist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-browser-storage-"));
  try {
    writeMinimalSurfaceRepository(root);
    const appPath = path.join(root, "src/App.tsx");
    for (const source of [
      'localStorage.setItem("hidden", "1");',
      'window.sessionStorage.getItem("hidden");',
      'globalThis["indexedDB"].open("hidden");',
      'const hidden = localStorage; hidden.clear();',
      'const { sessionStorage: hidden } = window; hidden.clear();',
      'Reflect.get(window, "localStorage").clear();',
      'Object.getOwnPropertyDescriptor(window, "sessionStorage")?.value.clear();',
      'Storage.prototype.setItem.call({}, "hidden", "1");',
      'window["local" + "Storage"].clear();',
      "const key = getKey(); window[key].clear();",
      "const root = window; const key = getKey(); root[key].clear();",
      "Reflect.get(window, getKey()).clear();",
    ]) {
      writeFileSync(appPath, source);
      assert.throws(
        () => discoverRuntimeInputSurface(root),
        /persistent browser storage is forbidden/,
        source,
      );
    }

    writeFileSync(appPath, '// localStorage\nconst label = "browser storage";');
    assert.deepEqual(discoverRuntimeInputSurface(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend query inputs are static, inventoried, and cannot hide behind aliases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-query-inputs-"));
  try {
    writeMinimalSurfaceRepository(
      root,
      `
        function initialParam(name: string) {
          return new URLSearchParams(window.location.search).get(name);
        }
        function initialFreeParam(name: string) {
          return new URLSearchParams(window.location.search).get(name);
        }
        const demo = initialParam("demo");
        const focus = initialFreeParam("focus");
      `,
    );
    assert.deepEqual(discoverRuntimeInputSurface(root), [
      "frontend:src/App.tsx:query:demo#1",
      "frontend:src/App.tsx:query:focus#1",
    ]);

    const appPath = path.join(root, "src/App.tsx");
    const baseline = readFileSync(appPath, "utf8");
    for (const source of [
      `${baseline}\nconst hidden = initialFreeParam(dynamicName);`,
      'const query = new URLSearchParams(window.location.search); query.get("hidden");',
      'const Parser = URLSearchParams; new Parser(window.location.search).get("hidden");',
      'const raw = window.location.search; raw.includes("hidden=1");',
      'new URLSearchParams(window.location.search)["get"]("hidden");',
      baseline.replace(
        "return new URLSearchParams(window.location.search).get(name);",
        "return null;",
      ),
    ]) {
      writeFileSync(appPath, source);
      assert.throws(
        () => discoverRuntimeInputSurface(root),
        /query input|URLSearchParams|location\.search/,
        source,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend build environment and process environment inputs fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-frontend-env-"));
  try {
    writeMinimalSurfaceRepository(root);
    const appPath = path.join(root, "src/App.tsx");
    for (const source of [
      "const hidden = import.meta.env.SRT_NEW_FEATURE;",
      'const hidden = import.meta["env"].SRT_NEW_FEATURE;',
      "const meta = import.meta; const hidden = meta.env.SRT_NEW_FEATURE;",
      "const hidden = process.env.SRT_NEW_FEATURE;",
      "const hidden = globalThis.process.env.SRT_NEW_FEATURE;",
      "const { env } = process; const hidden = env.SRT_NEW_FEATURE;",
    ]) {
      writeFileSync(appPath, source);
      assert.throws(
        () => discoverRuntimeInputSurface(root),
        /frontend environment inputs are forbidden/,
        source,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rust runtime and compile-time environment inputs are exact surfaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-rust-env-"));
  try {
    writeMinimalSurfaceRepository(root);
    const libPath = path.join(root, "src-tauri/src/lib.rs");
    writeFileSync(
      libPath,
      `
        const VERSION: &str = env!("CARGO_PKG_VERSION");
        #[cfg(debug_assertions)]
        fn debug_path() { let _ = std::env::var_os("SRT_DEBUG_DATABASE_PATH"); }
        fn temp_path() { let _ = std::env::temp_dir(); }
      `,
    );
    assert.deepEqual(discoverRuntimeInputSurface(root), [
      "rust:src-tauri/src/lib.rs:env!:CARGO_PKG_VERSION#1",
      "rust:src-tauri/src/lib.rs:std::env::temp_dir:<platform-temp>#1",
      "rust:src-tauri/src/lib.rs:std::env::var_os:SRT_DEBUG_DATABASE_PATH#1",
    ]);

    for (const source of [
      'fn hidden() { let _ = std::env::var("SRT_NEW_FEATURE"); }',
      'fn hidden() { let _ = std::env::args(); }',
      'fn hidden() { let _ = std::env::current_dir(); }',
      'fn hidden() { let _ = std::env::current_exe(); }',
      'fn hidden(path: &std::path::Path) { let _ = std::env::set_current_dir(path); }',
      'use std::env::var as hidden; fn read() { let _ = hidden("SRT_NEW_FEATURE"); }',
      "#[cfg(debug_assertions)] fn hidden() { let read = std::env::var; let _ = read; }",
      '#[cfg(debug_assertions)] fn hidden(name: &str) { let _ = std::env::var(name); }',
    ]) {
      writeFileSync(libPath, source);
      assert.throws(
        () => discoverRuntimeInputSurface(root),
        /environment input|std::env import/,
        source,
      );
    }

    writeFileSync(libPath, 'const HIDDEN: Option<&str> = option_env!("SRT_NEW_FEATURE");');
    assert.deepEqual(discoverRuntimeInputSurface(root), [
      "rust:src-tauri/src/lib.rs:option_env!:SRT_NEW_FEATURE#1",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the checked-in runtime input surface matches every live query and environment key", () => {
  assert.deepEqual(discoverRuntimeInputSurface(repositoryRoot), [
    "frontend:src/App.tsx:query:demo#1",
    "frontend:src/App.tsx:query:density#1",
    "frontend:src/App.tsx:query:focus#1",
    "frontend:src/App.tsx:query:inspectorRepo#1",
    "frontend:src/App.tsx:query:lang#1",
    "frontend:src/App.tsx:query:pluginSearch#1",
    "frontend:src/App.tsx:query:selectedPlugin#1",
    "frontend:src/App.tsx:query:selectedSkill#1",
    "frontend:src/App.tsx:query:tab#1",
    "frontend:src/App.tsx:query:theme#1",
    "rust:src-tauri/src/lib.rs:env!:CARGO_PKG_VERSION#1",
    "rust:src-tauri/src/lib.rs:env!:CARGO_PKG_VERSION#2",
    "rust:src-tauri/src/lib.rs:std::env::temp_dir:<platform-temp>#1",
    "rust:src-tauri/src/lib.rs:std::env::var_os:SRT_DEBUG_DATABASE_PATH#1",
    "rust:src-tauri/src/lib.rs:std::env::var:SRT_DEBUG_PROMPT_BYTES#1",
    "rust:src-tauri/src/lib.rs:std::env::var:SRT_DEBUG_PROMPT_COUNT#1",
    "rust:src-tauri/src/lib.rs:std::env::var:SRT_DEBUG_PROMPT_FIXTURE#1",
    "rust:src-tauri/src/lib.rs:std::env::var:SRT_DEBUG_PROMPT_TAGS#1",
    "rust:src-tauri/src/lib.rs:std::env::var:SRT_DEBUG_WINDOW_HEIGHT#1",
    "rust:src-tauri/src/lib.rs:std::env::var:SRT_DEBUG_WINDOW_WIDTH#1",
  ]);
});
