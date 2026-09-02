import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverRustDependenciesFromSource,
  findForbiddenRustIncludeMacros,
  findForbiddenRustModuleGraphSyntax,
  findRustSourceTreeHazards,
  validateModuleMap,
} from "../module-map.mjs";
import { trackedFiles, validMap } from "./module-map-fixtures.mjs";

test("Rust source identity is flat, .rs-only, and basename-unique", () => {
  assert.deepEqual(
    findRustSourceTreeHazards([
      "src-tauri/src/lib.rs",
      "src-tauri/src/database.rs",
      "src/App.tsx",
    ]),
    [],
  );

  assert.deepEqual(
    findRustSourceTreeHazards([
      "src-tauri/src/lib.rs",
      "src-tauri/src/payload.inc",
      "src-tauri/src/generated/schema.json",
      "src-tauri/src/domain/state.rs",
      "src-tauri/src/adapters/state.rs",
    ]),
    [
      "nested Rust source paths are forbidden until module identity is modeled: src-tauri/src/adapters/state.rs",
      "nested Rust source paths are forbidden until module identity is modeled: src-tauri/src/domain/state.rs",
      "Rust module basename identity conflict for state: src-tauri/src/adapters/state.rs, src-tauri/src/domain/state.rs",
      "Rust source root accepts only .rs files: src-tauri/src/generated/schema.json",
      "Rust source root accepts only .rs files: src-tauri/src/payload.inc",
    ],
  );
});

test("raw identifiers and production path modules cannot escape the Rust module graph", () => {
  assert.deepEqual(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      "mod r#type; use crate::r#type::Hidden;",
    ),
    [
      "src-tauri/src/lib.rs uses a raw Rust identifier; raw identifiers are forbidden until module graph canonicalization is modeled",
    ],
  );
  assert.deepEqual(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      '#[path = "payload.rs"] mod hidden;',
    ),
    [
      "src-tauri/src/lib.rs uses a production #[path] module; only cfg(test) external test modules are allowed",
    ],
  );
  assert.deepEqual(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      '#[cfg_attr(not(test), path = "payload.rs")] mod hidden;',
    ),
    [
      "src-tauri/src/lib.rs uses a production #[path] module; only cfg(test) external test modules are allowed",
    ],
  );
  assert.deepEqual(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      '#[\n  cfg_attr(not(test),\n    path = "payload.rs"\n  )\n]\nmod hidden;',
    ),
    [
      "src-tauri/src/lib.rs uses a production #[path] module; only cfg(test) external test modules are allowed",
    ],
  );
  assert.deepEqual(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      '#[cfg(test)]\n#[path = "lib_tests.rs"]\nmod tests;',
    ),
    [],
  );
  assert.deepEqual(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      '#[cfg(test)]\n#[path = "payload.rs"]\nmod tests;',
    ),
    [
      "src-tauri/src/lib.rs uses a production #[path] module; only cfg(test) external test modules are allowed",
    ],
  );
});

test("repeated super paths and local macros cannot hide Rust dependency edges", () => {
  for (const source of [
    "use super::super::repositories::Repository;",
    "use super::{super::repositories::Repository};",
    "let _ = super::super::repositories::load();",
    "mod nested { fn load() { super::super::repositories::load(); } }",
  ]) {
    assert.ok(
      findForbiddenRustModuleGraphSyntax("src-tauri/src/lib.rs", source).some((error) =>
        error.includes("repeated super:: paths are forbidden")),
      source,
    );
  }
  assert.ok(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      "macro_rules! edge { ($m:ident) => { crate::$m::load() } }",
    ).some((error) => error.includes("local macro_rules definitions are forbidden")),
  );
  assert.deepEqual(
    findForbiddenRustModuleGraphSyntax(
      "src-tauri/src/lib.rs",
      '// super::super::repositories\nconst NOTE: &str = "macro_rules! hidden";',
    ),
    [],
  );
});

const databaseFixtureModule = `
#[cfg(test)]
mod tests {
    const FIXTURES: [&str; 3] = [
        include_str!("../tests/fixtures/core-schema/v1.1.12.sql"),
        include_str!("../tests/fixtures/core-schema/v1.2.0.sql"),
        include_str!("../tests/fixtures/core-schema/v1.2.2.sql"),
    ];
}
`;

test("only the three historical database schema fixtures may use include_str", () => {
  assert.deepEqual(
    findForbiddenRustIncludeMacros("src-tauri/src/database.rs", databaseFixtureModule),
    [],
  );

  for (const [pathname, source] of [
    ["src-tauri/src/lib.rs", 'fn load() { include_str!("payload.txt"); }'],
    ["src-tauri/src/lib.rs", 'fn load() { include_bytes!("payload.bin"); }'],
    ["src-tauri/src/lib.rs", 'include!("payload.inc");'],
    ["src-tauri/src/lib.rs", 'use std::include as hidden; hidden!("payload.inc");'],
    ["src-tauri/src/lib.rs", 'fn load() { include_str!(concat!("payload", ".txt")); }'],
    [
      "src-tauri/src/database.rs",
      'const FIXTURE: &str = include_str!("../tests/fixtures/core-schema/v1.2.2.sql");',
    ],
    [
      "src-tauri/src/database.rs",
      databaseFixtureModule.replace(
        "];",
        '    include_str!("../tests/fixtures/core-schema/v9.9.9.sql"),\n    ];',
      ),
    ],
    ["src-tauri/src/lib.rs", "use std::include_str as hidden;"],
  ]) {
    assert.ok(
      findForbiddenRustIncludeMacros(pathname, source).some((error) =>
        error.includes("production Rust include macros are limited")),
      `${pathname} should reject ${source}`,
    );
  }
});

test("comments and strings cannot manufacture include macro findings", () => {
  assert.deepEqual(
    findForbiddenRustIncludeMacros(
      "src-tauri/src/lib.rs",
      [
        '// include_str!("payload.txt")',
        '/* include_bytes!("payload.bin") */',
        'const NOTE: &str = "include_str!(\\\"payload.txt\\\")";',
        'const RAW: &str = r#"include_bytes!("payload.bin")"#;',
      ].join("\n"),
    ),
    [],
  );
});

test("Rust production modules must be reachable from a Cargo root, not a self-declared orphan", () => {
  const map = validMap();
  map.modules.find((module) => module.id === "rust-prompts").paths.push(
    "src-tauri/src/orphan.rs",
  );
  const errors = validateModuleMap({
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
      "src-tauri/src/orphan.rs",
    ],
    trackedFiles: [...trackedFiles, "src-tauri/src/orphan.rs"],
    dependencies: [],
    rustDeclarations: [
      { name: "prompts", from: "src-tauri/src/lib.rs" },
      { name: "orphan", from: "src-tauri/src/orphan.rs" },
    ],
  });

  assert.ok(
    errors.includes(
      "Rust production module is not reachable from lib.rs or main.rs: src-tauri/src/orphan.rs",
    ),
  );
});

test("macro-contained and cfg-dependent mod declarations cannot manufacture Rust reachability", () => {
  const discovered = discoverRustDependenciesFromSource({
    path: "src-tauri/src/lib.rs",
    source: [
      "mod visible;",
      "# [cfg(\n  any()\n)]\nmod conditional;",
      "macro_rules! hidden { () => { mod generated; } }",
    ].join("\n"),
    rustModulePaths: new Map([
      ["visible", "src-tauri/src/visible.rs"],
      ["conditional", "src-tauri/src/conditional.rs"],
      ["generated", "src-tauri/src/generated.rs"],
    ]),
  });

  assert.deepEqual(discovered.declarations, [
    { name: "visible", from: "src-tauri/src/lib.rs" },
  ]);
});
