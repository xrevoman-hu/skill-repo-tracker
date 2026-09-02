import assert from "node:assert/strict";
import test from "node:test";

import {
  findJavaScriptRunnerHelperHazards,
  findRustTestInventoryHazards,
  FIXED_RUST_TEST_CFG,
} from "../module-map-test-policy.mjs";

test("Vitest and Playwright helper closures allow passive fixtures and utilities", () => {
  const sources = {
    "src/policy.test.ts": 'import { fixture } from "./fixture"; test("ok", () => fixture);',
    "src/fixture.ts": "export const fixture = true;",
    "src/product-lazy.ts": 'export const load = () => import("./product-feature");',
    "src/product-feature.ts": "export const feature = true;",
    "e2e/demo.spec.ts": 'import { helper } from "./helper"; test("ok", () => helper);',
    "e2e/helper.ts": "export const helper = true;",
  };
  assert.deepEqual(
    findJavaScriptRunnerHelperHazards({ paths: Object.keys(sources), sources }),
    [],
  );
});

test("runner helpers cannot register, alias, or reflect test APIs", () => {
  const sources = {
    "src/policy.test.ts": [
      'import "./registrar";',
      'import "./alias";',
      'import "./reflected";',
      'test("root", () => {});',
    ].join("\n"),
    "src/registrar.ts": [
      'import { test } from "vitest";',
      'test.skip("hidden", () => { throw new Error("must execute"); });',
    ].join("\n"),
    "src/alias.ts": [
      'import { it as register } from "vitest";',
      'register("hidden", () => {});',
    ].join("\n"),
    "src/reflected.ts": [
      'import * as runner from "vitest";',
      'Reflect.get(runner, "describe")("hidden", () => {});',
    ].join("\n"),
    "e2e/demo.spec.ts": 'import "./registrar"; test("root", () => {});',
    "e2e/registrar.ts": [
      'import { suite } from "@playwright/test";',
      'suite("hidden", () => {});',
    ].join("\n"),
  };
  const errors = findJavaScriptRunnerHelperHazards({
    paths: Object.keys(sources),
    sources,
  });

  for (const pathname of [
    "src/registrar.ts",
    "src/alias.ts",
    "src/reflected.ts",
    "e2e/registrar.ts",
  ]) {
    assert.ok(errors.some((error) => error.includes(pathname)), pathname);
  }
  assert.ok(errors.some((error) => error.includes("test.skip is forbidden")));
  assert.ok(errors.some((error) => error.includes("registration API")));
  assert.ok(errors.some((error) => error.includes("Reflect.get is forbidden")));
});

test("runner-aware helpers must be statically reachable from discovered tests", () => {
  const sources = {
    "src/policy.test.ts": 'test("root", () => {});',
    "src/orphan.ts": 'import { test } from "vitest"; export const fixture = test;',
    "e2e/demo.spec.ts": 'test("root", () => {});',
    "e2e/orphan-helper.ts": "export const helper = true;",
  };
  const errors = findJavaScriptRunnerHelperHazards({
    paths: Object.keys(sources),
    sources,
  });

  assert.ok(
    errors.includes(
      "src/orphan.ts runner helper is not statically reachable from a discovered vitest test/spec",
    ),
  );
  assert.ok(
    errors.includes(
      "e2e/orphan-helper.ts runner helper is not statically reachable from a discovered playwright test/spec",
    ),
  );
});

test("reachable Vitest and Playwright helpers reject non-literal runner loading", () => {
  const sources = {
    "src/policy.test.ts": 'import "./dynamic-runner"; test("sentinel", () => {});',
    "src/dynamic-runner.ts": [
      'const moduleName = ["vi", "test"].join("");',
      "const runner = await import(moduleName);",
      'const register = runner[["te", "st"].join("")];',
      'register("hidden", function* () { throw new Error("must execute"); });',
    ].join("\n"),
    "e2e/demo.spec.ts": 'import "./dynamic-runner"; test("sentinel", async () => {});',
    "e2e/dynamic-runner.ts": [
      'const moduleName = ["@playwright", "/test"].join("");',
      "const runner = require(moduleName);",
      'const register = runner[["te", "st"].join("")];',
      'register("hidden", function* () { throw new Error("must execute"); });',
    ].join("\n"),
  };

  const errors = findJavaScriptRunnerHelperHazards({
    paths: Object.keys(sources),
    sources,
  });
  for (const pathname of ["src/dynamic-runner.ts", "e2e/dynamic-runner.ts"]) {
    assert.ok(
      errors.some(
        (error) => error.includes(pathname) && error.includes("statically auditable"),
      ),
      `${pathname}\n${errors.join("\n")}`,
    );
  }
});

function rustInventory(overrides = {}) {
  const sources = {
    "src-tauri/src/lib.rs": "mod feature;",
    "src-tauri/src/feature.rs": [
      "#[cfg(test)]",
      '#[path = "feature_tests.rs"]',
      "mod tests;",
    ].join("\n"),
    "src-tauri/src/feature_tests.rs": "#[test]\nfn works() {}",
    ...overrides,
  };
  return findRustTestInventoryHazards({
    paths: Object.keys(sources),
    sources,
    allowedCfg: FIXED_RUST_TEST_CFG,
  });
}

test("external Rust tests are uniquely reachable through an exact cfg(test) module", () => {
  assert.deepEqual(rustInventory(), []);
  assert.deepEqual(
    rustInventory({
      "src-tauri/src/feature.rs": "pub fn production() {}",
    }),
    [
      "src-tauri/src/feature_tests.rs must be reachable exactly once from the lib/main cfg(test) module tree; found 0",
    ],
  );
});

test("runner-dependent Rust cfg and cfg_attr tests fail closed", () => {
  for (const attribute of ["#[cfg(windows)]", "#[cfg_attr(unix, ignore)]"]) {
    const errors = rustInventory({
      "src-tauri/src/feature_tests.rs": `${attribute}\n#[test]\nfn hidden() {}`,
    });
    assert.ok(
      errors.some((error) => error.includes("runner-dependent cfg") || error.includes("cfg_attr")),
      `${attribute} should be rejected`,
    );
  }

  assert.deepEqual(
    rustInventory({
      "src-tauri/src/feature_tests.rs": [
        "#[cfg(unix)]",
        "#[cfg(target_os = \"macos\")]",
        "#[cfg(debug_assertions)]",
        "#[test]",
        "fn fixed_runner() {}",
      ].join("\n"),
    }),
    [],
  );
});

test("nested Rust integration tests are rejected until their module tree is modeled", () => {
  const sources = {
    "src-tauri/tests/integration.rs": "#[test]\nfn direct() {}",
    "src-tauri/tests/helpers/ghost.rs": "#[test]\nfn ghost() {}",
  };
  assert.ok(
    findRustTestInventoryHazards({
      paths: Object.keys(sources),
      sources,
      allowedCfg: FIXED_RUST_TEST_CFG,
    }).includes(
      "nested Rust integration test source is not runner-modeled: src-tauri/tests/helpers/ghost.rs",
    ),
  );
});

test("Rust tests outside configured Cargo targets are rejected", () => {
  const sources = {
    "tests/ghost_tests.rs": "#[test]\nfn ghost() {}",
  };
  assert.ok(
    findRustTestInventoryHazards({
      paths: Object.keys(sources),
      sources,
      allowedCfg: FIXED_RUST_TEST_CFG,
    }).includes(
      "Rust test-like file is not reachable by a configured Cargo target: tests/ghost_tests.rs",
    ),
  );
});

test("Rust test attributes inside macros or item blocks cannot impersonate runnable tests", () => {
  for (const source of [
    'macro_rules! hidden { () => { #[test] fn must_fail() { panic!("executed") } }; }',
    'const _: () = { #[test] fn must_fail() { panic!("executed") } };',
  ]) {
    const errors = findRustTestInventoryHazards({
      paths: ["src-tauri/tests/ghost.rs"],
      sources: { "src-tauri/tests/ghost.rs": source },
      allowedCfg: FIXED_RUST_TEST_CFG,
    });
    assert.ok(
      errors.includes(
        "src-tauri/tests/ghost.rs test must_fail is not a direct crate or module item and may not be runner-discoverable",
      ),
    );
    assert.ok(errors.includes("src-tauri/tests/ghost.rs does not statically declare any Rust test"));
  }
});

test("Rust production test hosts and their external tests must be rooted at lib.rs or main.rs", () => {
  const sources = {
    "src-tauri/src/lib.rs": "pub fn run() {}",
    "src-tauri/src/orphan.rs": [
      "mod orphan;",
      "#[cfg(test)]",
      '#[path = "orphan_tests.rs"]',
      "mod tests;",
    ].join("\n"),
    "src-tauri/src/orphan_tests.rs": '#[test]\nfn must_fail() { panic!("executed") }',
  };
  const errors = findRustTestInventoryHazards({
    paths: Object.keys(sources),
    sources,
    allowedCfg: FIXED_RUST_TEST_CFG,
  });

  assert.ok(
    errors.includes(
      "Rust production test host is not reachable from a Cargo root: src-tauri/src/orphan.rs",
    ),
  );
  assert.ok(
    errors.includes(
      "src-tauri/src/orphan_tests.rs must be reachable exactly once from the lib/main cfg(test) module tree; found 0",
    ),
  );
});

test("multiline Rust test attributes remain runner-visible to the static inventory", () => {
  assert.deepEqual(
    findRustTestInventoryHazards({
      paths: ["src-tauri/tests/direct.rs"],
      sources: { "src-tauri/tests/direct.rs": "# [\n test\n]\nfn direct() {}" },
      allowedCfg: FIXED_RUST_TEST_CFG,
    }),
    [],
  );
});
