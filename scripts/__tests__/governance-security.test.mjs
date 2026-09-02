import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  checkArchitectureSnapshot,
  checkRepositoryBoundaries,
  compareArchitectureBudgets,
  compareCommandInventories,
  compareCoverage,
  extractFrontendCommands,
  extractRustCommands,
  findExplicitAny,
  findForbiddenClippySuppressions,
  findForbiddenCoveragePragmas,
  findForbiddenFrontendAliases,
  findForbiddenFrontendRuntimeUsage,
  findForbiddenRustIncludes,
  findForbiddenGithubTransportUsage,
  findForbiddenRustIgnores,
  findForbiddenRustTestCfg,
  findForbiddenTestModifiers,
  findFrontendImportEscapes,
  findFrontendModuleGraphHazards,
  findHtmlModuleEntryHazards,
  findProductionTestImports,
  findRustTestModulesVisibleInProduction,
  findUnpinnedWorkflowUses,
  isForbiddenProductionJavaScriptPath,
  isAlternateTauriConfigPath,
  isProductionModule,
  loadTrackedArchitectureBudgetAtBase,
  parseUnifiedDiffLines,
  shouldEnforceChangedCoverage,
  validateCiWorkflowPolicy,
  validateCriticalPackageScripts,
  validateCargoTestDiscoveryPolicy,
  validateCargoMetadataPolicy,
  validateIndexHtmlPolicy,
  validateRuntimeToolchain,
  validateReleaseWorkflowPolicy,
  validateRepositoryAutomationPolicy,
  validateSecurityAuditWorkflowPolicy,
  validatePlaywrightConfigPolicy,
  validateTrustedPolicyWorkflowPolicy,
  validateTypeScriptConfigPolicy,
  validateTauriBuildScriptPolicy,
  validateViteConfigPolicy,
  validateVersions,
  validateVitestConfigPolicy,
  validateWeeklyResilienceWorkflowPolicy,
} from "../governance.mjs";

const CRITICAL_PACKAGE_SCRIPTS = {
  typecheck: "tsc --noEmit",
  "typecheck:strict-islands": "tsc --noEmit --strict",
  test: "vitest run",
  "test:scripts": "node --test scripts/__tests__/*.test.mjs",
  "test:e2e": "playwright test",
  "test:coverage": "vitest run --coverage",
  "coverage:rust": "node scripts/rust-coverage.mjs",
  "coverage:check":
    "npm run test:coverage && node scripts/check-coverage.mjs frontend && npm run coverage:rust && node scripts/check-coverage.mjs rust",
  build: "vite build",
  "governance:context": "node scripts/governance-context.mjs",
  "verify:governance": "node scripts/governance.mjs all",
  verify: "node scripts/verify.mjs",
  "github:governance:check": "node scripts/github-governance-check.mjs",
  "release:verify": "node scripts/release-verify.mjs",
  preview: "vite preview --host 127.0.0.1",
  "tauri:build": "tauri build",
};

test("workflow uses are parsed recursively across block, flow, and reusable jobs", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  assert.deepEqual(
    findUnpinnedWorkflowUses(
      "probe.yml",
      [
        "jobs:",
        "  build:",
        "    steps:",
        `      - uses: actions/checkout@${sha}`,
        "      - { name: unsafe flow, uses: owner/action@main }",
        "  reusable:",
        "    uses: owner/repo/.github/workflows/reuse.yml@v1",
        "  local:",
        "    uses: ./.github/workflows/local.yml",
      ].join("\n"),
    ),
    [
      "third-party Action is not pinned to a full commit SHA: probe.yml: owner/action@main",
      "third-party Action is not pinned to a full commit SHA: probe.yml: owner/repo/.github/workflows/reuse.yml@v1",
    ],
  );
});

test("invalid workflow YAML fails closed", () => {
  assert.match(findUnpinnedWorkflowUses("broken.yml", "jobs: [")[0], /invalid YAML/);
});

test("GitHub transport policy keeps raw reqwest clients inside the adapter", () => {
  assert.deepEqual(
    findForbiddenGithubTransportUsage(
      "src-tauri/src/lib.rs",
      [
        "let client = reqwest::Client::new();",
        "state.adapters.github.client().get(url);",
        "let request: reqwest::RequestBuilder = client.get(url);",
        "request.send().await?;",
      ].join("\n"),
    ),
    [
      "src-tauri/src/lib.rs constructs or names a raw reqwest client outside adapters.rs",
      "src-tauri/src/lib.rs bypasses GithubHttpAdapter through client()",
      "src-tauri/src/lib.rs sends an HTTP request outside adapters.rs",
    ],
  );
  assert.deepEqual(
    findForbiddenGithubTransportUsage(
      "src-tauri/src/adapters.rs",
      "let client = reqwest::Client::new(); client.execute(request).await?;",
    ),
    [],
  );
  assert.deepEqual(
    findForbiddenGithubTransportUsage(
      "src-tauri/src/adapters.rs",
      "fn client(&self) -> &reqwest::Client { &self.0 }",
    ),
    ["src-tauri/src/adapters.rs exposes the raw GitHub HTTP client"],
  );
  assert.deepEqual(
    findForbiddenGithubTransportUsage(
      "src-tauri/src/lib.rs",
      [
        "use crate::adapters::GithubHttpAdapter;",
        "let adapter_type_is_available: Option<GithubHttpAdapter> = None;",
        "let _ = finished_tx.send(());",
      ].join("\n"),
    ),
    [],
  );
  for (const directGet of ["reqwest::get(url).await?;", "reqwest::blocking::get(url)?;"]) {
    assert.deepEqual(
      findForbiddenGithubTransportUsage("src-tauri/src/lib.rs", directGet),
      ["src-tauri/src/lib.rs sends an HTTP request outside adapters.rs"],
    );
  }
  for (const rawClient of [
    "let client = reqwest::ClientBuilder::new().build()?;",
    "let client = reqwest::blocking::Client::new();",
    "use reqwest::blocking::{Client, ClientBuilder}; let client = ClientBuilder::new();",
  ]) {
    assert.deepEqual(
      findForbiddenGithubTransportUsage("src-tauri/src/lib.rs", rawClient),
      ["src-tauri/src/lib.rs constructs or names a raw reqwest client outside adapters.rs"],
    );
  }
  assert.deepEqual(
    findForbiddenGithubTransportUsage(
      "src-tauri/src/lib.rs",
      "use reqwest as http; let client = http::Client::new(); let request = client.get(url); request.send().await?;",
    ),
    [
      "src-tauri/src/lib.rs aliases reqwest and can hide raw HTTP usage",
      "src-tauri/src/lib.rs constructs or names a raw reqwest client outside adapters.rs",
      "src-tauri/src/lib.rs sends an HTTP request outside adapters.rs",
    ],
  );
  assert.deepEqual(
    findForbiddenGithubTransportUsage(
      "src-tauri/src/adapters.rs",
      "pub(super) use reqwest as raw_http;",
    ),
    ["src-tauri/src/adapters.rs aliases reqwest and can hide raw HTTP usage", "src-tauri/src/adapters.rs re-exports the raw reqwest transport"],
  );
  assert.deepEqual(
    findForbiddenGithubTransportUsage(
      "src-tauri/src/lib.rs",
      "use { std::sync::Arc, reqwest as h }; let c = h::Client::new(); let r = c.get(url); r.send().await?;",
    ),
    [
      "src-tauri/src/lib.rs aliases reqwest and can hide raw HTTP usage",
      "src-tauri/src/lib.rs constructs or names a raw reqwest client outside adapters.rs",
    ],
  );
});

test("frontend runtime policy keeps network and Tauri invoke behind governed adapters", () => {
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/UnsafeView.tsx",
      [
        'import { invoke as rawInvoke } from "@tauri-apps/api/core";',
        'fetch("https://api.github.com/repos/example/repo");',
        'window.fetch("https://example.invalid");',
        "new XMLHttpRequest();",
        'new window.EventSource("https://example.invalid/events");',
        'new globalThis.WebSocket("wss://example.invalid");',
        'navigator.sendBeacon("https://example.invalid", "payload");',
        'window.__TAURI__.core.invoke("open_backup_folder", { path: "/tmp" });',
        'window.__TAURI_INTERNALS__.invoke("open_backup_folder", { path: "/tmp" });',
      ].join("\n"),
    ),
    [
      "src/UnsafeView.tsx uses raw frontend network API fetch; route network access through AppService and Rust adapters",
      "src/UnsafeView.tsx uses raw frontend network API XMLHttpRequest; route network access through AppService and Rust adapters",
      "src/UnsafeView.tsx uses raw frontend network API EventSource; route network access through AppService and Rust adapters",
      "src/UnsafeView.tsx uses raw frontend network API WebSocket; route network access through AppService and Rust adapters",
      "src/UnsafeView.tsx uses raw frontend network API sendBeacon; route network access through AppService and Rust adapters",
      "src/UnsafeView.tsx imports @tauri-apps/api/core outside the governed src/api.ts wrapper",
      "src/UnsafeView.tsx invokes the raw Tauri global outside the governed src/api.ts wrapper",
    ],
  );
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/api.ts",
      [
        'import { invoke } from "@tauri-apps/api/core";',
        'export const command = (name: string) => invoke(name);',
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/App.tsx",
      'service.checkForUpdates("1.2.3"); api.openUrl("https://example.invalid");',
    ),
    [],
  );
});

test("frontend network and Tauri globals cannot be hidden behind aliases", () => {
  const errors = findForbiddenFrontendRuntimeUsage(
    "src/AliasEscape.ts",
    [
      "const request = globalThis.fetch;",
      "request('https://api.github.com/repos/example/repo');",
      "document.defaultView?.fetch('https://example.invalid');",
      'document.defaultView?.["WebSocket"]("wss://example.invalid");',
      "const beacon = navigator.sendBeacon.bind(navigator);",
      "const internals = window.__TAURI_INTERNALS__;",
      "const invoke = internals.invoke;",
      "invoke('open_backup_folder', { repositoryId: '1' });",
      "const root = globalThis;",
      "const hidden = window[apiName];",
      'frames.fetch("https://example.invalid");',
      'new top.WebSocket("wss://example.invalid");',
      "parent.XMLHttpRequest();",
      'const frame = document.createElement("iframe"); frame.contentWindow!.fetch("https://example.invalid");',
    ].join("\n"),
  );
  assert.ok(errors.some((error) => error.includes("raw frontend network API fetch")));
  assert.ok(errors.some((error) => error.includes("raw frontend network API WebSocket")));
  assert.ok(errors.some((error) => error.includes("raw frontend network API sendBeacon")));
  assert.ok(errors.some((error) => error.includes("raw Tauri globals may only")));
  assert.ok(errors.some((error) => error.includes("globalThis may not be aliased")));
  assert.ok(errors.some((error) => error.includes("computed global access is forbidden")));
  assert.ok(errors.some((error) => error.includes("frames may not be aliased") || error.includes("raw frontend network API fetch")));
  assert.ok(errors.some((error) => error.includes("raw frontend network API WebSocket")));
  assert.ok(errors.some((error) => error.includes("raw frontend network API XMLHttpRequest")));
});

test("iframe window recovery is forbidden even with identifier or concatenated keys", () => {
  for (const source of [
    'const key = "fetch"; frame.contentWindow![key]("https://example.invalid");',
    'frame.contentWindow!["fe" + "tch"]("https://example.invalid");',
    'frame["content" + "Window"]!["fetch"]("https://example.invalid");',
    'frame.contentDocument!.defaultView?.fetch("https://example.invalid");',
  ]) {
    assert.ok(
      findForbiddenFrontendRuntimeUsage("src/IframeEscape.ts", source).some((error) =>
        error.includes("runtime reflection is forbidden")),
      source,
    );
  }
});

test("production frontend cannot dynamically execute ungoverned payloads", () => {
  const errors = findForbiddenFrontendRuntimeUsage(
    "src/PayloadEscape.ts",
    [
      'eval("run()")',
      'new Function("return 1")()',
      'WebAssembly.instantiateStreaming(response)',
      'const wasm = globalThis["WebAssembly"]',
      'const indirect = window.eval',
      'top.Function("return 1")()',
    ].join("\n"),
  );
  assert.ok(errors.some((error) => error.includes("dynamic execution API eval")));
  assert.ok(errors.some((error) => error.includes("dynamic execution API Function")));
  assert.ok(errors.some((error) => error.includes("dynamic execution API WebAssembly")));
  assert.ok(errors.some((error) => error.includes("dynamic execution API WebAssembly") && error.includes(":4")));
  assert.ok(errors.some((error) => error.includes("dynamic execution API eval") && error.includes(":5")));
  assert.ok(errors.some((error) => error.includes("dynamic execution API Function") && error.includes(":6")));
});

test("production frontend cannot recover governed runtime capabilities through reflection", () => {
  const errors = findForbiddenFrontendRuntimeUsage(
    "src/ReflectionEscape.ts",
    [
      'Reflect.get(document.defaultView!, "fetch")',
      'Reflect.get(globalThis, "Function")',
      'globalThis.Reflect.get(window, "setInterval")',
      'const reflection = Reflect; reflection.get(self, "Worker")',
      'new Proxy(document.defaultView!, handler)',
      'Object.getOwnPropertyDescriptor(document.defaultView!, "fetch")?.value',
      'Object.create(document.defaultView!).fetch("https://example.invalid")',
      'new (Object.create(document.defaultView!).WebSocket)("wss://example.invalid")',
      'const copied = Object.create(document.defaultView!); copied.fetch("https://example.invalid")',
      'Object.getPrototypeOf(document.defaultView!).fetch("https://example.invalid")',
      'const objectNamespace = Object; objectNamespace.create(document.defaultView!)',
      '(() => {}).constructor("return fetch")()',
    ].join("\n"),
  );
  for (const line of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    assert.ok(
      errors.some((error) =>
        error.includes(`ReflectionEscape.ts:${line}`) &&
        error.includes("runtime reflection is forbidden")
      ),
      `reflection escape on line ${line} must fail closed`,
    );
  }
  assert.ok(
    findForbiddenFrontendRuntimeUsage(
      "src/ConstructorEscape.ts",
      '(() => {}).constructor("return fetch")()',
    ).some((error) => error.includes("runtime reflection is forbidden")),
  );
});

test("production frontend cannot create unbudgeted asynchronous scheduling channels", () => {
  const errors = findForbiddenFrontendRuntimeUsage(
    "src/AsyncEscape.ts",
    [
      "queueMicrotask(run)",
      "scheduler.postTask(run)",
      "new MessageChannel()",
      'window.postMessage("tick", "*")',
      'globalThis["queueMicrotask"](run)',
    ].join("\n"),
  );
  assert.equal(
    errors.filter((error) => error.includes("asynchronous runtime API")).length,
    5,
  );
});

test("production frontend comments cannot hide branches from V8 coverage", () => {
  assert.deepEqual(
    findForbiddenCoveragePragmas(
      "src/feature.ts",
      [
        'const prose = "/* v8 ignore next */";',
        "const template = `// istanbul ignore next`;",
        "/* v8 ignore next */",
        "if (flag) run();",
        "// c8 ignore next",
        "if (other) run();",
        "/* istanbul ignore else */",
      ].join("\n"),
    ),
    [
      "src/feature.ts:3 disables frontend coverage instrumentation; v8/c8/istanbul ignore pragmas are forbidden in production",
      "src/feature.ts:5 disables frontend coverage instrumentation; v8/c8/istanbul ignore pragmas are forbidden in production",
      "src/feature.ts:7 disables frontend coverage instrumentation; v8/c8/istanbul ignore pragmas are forbidden in production",
    ],
  );
});

test("Tauri command inventory matches the frontend API boundary", () => {
  const frontend = extractFrontendCommands(`
    command<Repository[]>("list_repositories");
    command<void>("open_backup_folder", { repositoryId });
  `);
  const rust = extractRustCommands(`
    .invoke_handler(tauri::generate_handler![
      list_repositories,
      open_backup_folder,
    ])
  `);

  assert.deepEqual(frontend, ["list_repositories", "open_backup_folder"]);
  assert.deepEqual(rust, ["list_repositories", "open_backup_folder"]);
  assert.deepEqual(compareCommandInventories({ frontend, rust }), []);
});

test("Tauri command inventory ignores comments and string decoys", () => {
  const frontend = extractFrontendCommands(`
    /* command("ghost_block") */
    // command("ghost_line")
    const decoy = 'command("ghost_string")';
    command<void>("real_command");
  `);
  const rust = extractRustCommands(`
    /* tauri::generate_handler![ghost_block] */
    const _: &str = "tauri::generate_handler![ghost_string]";
    .invoke_handler(tauri::generate_handler![
      #[cfg(target_os = "macos")]
      crate::commands::real_command,
      /* ghost_nested, */
    ])
  `);

  assert.deepEqual(frontend, ["real_command"]);
  assert.deepEqual(rust, ["real_command"]);
});

test("Tauri command inventory fails closed on drift and retired scheduling command", () => {
  assert.deepEqual(
    compareCommandInventories({
      frontend: ["list_repositories", "frontend_only", "configure_schedule"],
      rust: ["list_repositories", "rust_only", "configure_schedule"],
    }),
    [
      "frontend command is not registered by Rust: frontend_only",
      "Rust command has no frontend API wrapper: rust_only",
      "removed command must not return: configure_schedule",
    ],
  );
});

test("architecture snapshot is exact for hotspots and enforces the 800-line new-module cap", () => {
  assert.deepEqual(
    checkArchitectureSnapshot({
      files: {
        "src/App.tsx": 7001,
        "src/new-feature.ts": 801,
      },
      budget: {
        hotSpots: {
          "src/App.tsx": { maxLines: 7000, adr: "docs/adr/0007.md" },
        },
        newModuleMaxLines: 800,
      },
    }),
    [
      "src/App.tsx has 7001 lines; hotspot snapshot must equal 7000 and be updated downward with the code",
      "src/new-feature.ts has 801 lines; new production modules are limited to 800",
    ],
  );
  assert.deepEqual(
    checkArchitectureSnapshot({
      files: { "src/App.tsx": 6999 },
      budget: {
        hotSpots: { "src/App.tsx": { maxLines: 7000 } },
        newModuleMaxLines: 800,
      },
    }),
    [
      "src/App.tsx exceeds 1000 lines but does not reference a tracked ADR path",
      "src/App.tsx has 6999 lines; hotspot snapshot must equal 7000 and be updated downward with the code",
    ],
  );
});

test("architecture snapshot does not permit raising the global new-module cap", () => {
  assert.deepEqual(
    checkArchitectureSnapshot({
      files: {},
      budget: { hotSpots: {}, newModuleMaxLines: 801 },
    }),
    ["new production module cap must remain 800 lines; found 801"],
  );
});

test("architecture budgets cannot bless a new oversized module as a hotspot", () => {
  assert.deepEqual(
    compareArchitectureBudgets(
      {
        hotSpots: {
          "src/App.tsx": { maxLines: 6000 },
          "src/new-feature.ts": { maxLines: 1200, adr: "docs/adr/9999.md" },
        },
      },
      { hotSpots: { "src/App.tsx": { maxLines: 6000 } } },
    ),
    ["new hotspot budgets are forbidden; keep new modules within 800 lines: src/new-feature.ts"],
  );
});

test("architecture hotspot targets cannot be raised or silently removed", () => {
  assert.deepEqual(
    compareArchitectureBudgets(
      { hotSpots: { "src/App.tsx": { maxLines: 6000, targetLines: 900 } } },
      { hotSpots: { "src/App.tsx": { maxLines: 6000, targetLines: 700 } } },
    ),
    ["src/App.tsx target increased from 700 to 900; targets may only decrease"],
  );
  assert.deepEqual(
    compareArchitectureBudgets(
      { hotSpots: { "src/App.tsx": { maxLines: 6000 } } },
      { hotSpots: { "src/App.tsx": { maxLines: 6000, targetLines: 700 } } },
    ),
    ["src/App.tsx target increased from 700 to missing; targets may only decrease"],
  );
});

test("architecture hotspots retire explicitly after returning below the normal cap", () => {
  const active = {
    newModuleMaxLines: 800,
    hotSpots: {
      "src/App.tsx": {
        status: "active", maxLines: 1200, targetLines: 700, maxBytes: 50000,
      },
    },
  };
  const retiring = structuredClone(active);
  retiring.hotSpots["src/App.tsx"] = {
    status: "retiring",
    maxLines: 800,
    targetLines: 700,
    maxBytes: 50000,
    retirement: { reason: "the shell was split below the normal module cap" },
  };
  assert.deepEqual(compareArchitectureBudgets(retiring, active), []);
  assert.deepEqual(
    checkArchitectureSnapshot({ files: { "src/App.tsx": 799 }, budget: retiring }),
    [],
  );

  const retired = structuredClone(retiring);
  retired.hotSpots["src/App.tsx"].status = "retired";
  assert.deepEqual(compareArchitectureBudgets(retired, retiring), []);
  assert.deepEqual(
    compareArchitectureBudgets(
      { newModuleMaxLines: 800, hotSpots: {} },
      retired,
    ),
    [],
  );

  const skipped = structuredClone(active);
  skipped.hotSpots["src/App.tsx"].status = "retired";
  skipped.hotSpots["src/App.tsx"].retirement = { reason: "deleted" };
  assert.deepEqual(compareArchitectureBudgets(skipped, active), [
    "active architecture hotspot src/App.tsx cannot skip directly to retired",
  ]);

  const reactivated = structuredClone(retiring);
  reactivated.hotSpots["src/App.tsx"].status = "active";
  delete reactivated.hotSpots["src/App.tsx"].retirement;
  assert.deepEqual(compareArchitectureBudgets(reactivated, retiring), [
    "retiring architecture hotspot src/App.tsx cannot return to active",
    "architecture hotspot src/App.tsx retirement metadata changed",
  ]);

  const rewritten = structuredClone(retiring);
  rewritten.hotSpots["src/App.tsx"].retirement.reason = "rewritten history";
  rewritten.hotSpots["src/App.tsx"].adr = "docs/adr/9999.md";
  assert.deepEqual(compareArchitectureBudgets(rewritten, retiring), [
    "architecture hotspot src/App.tsx retirement metadata changed",
    "architecture hotspot src/App.tsx ADR changed from undefined to docs/adr/9999.md",
  ]);
});

test("bundle budgets cannot be raised or silently removed", () => {
  assert.deepEqual(
    compareArchitectureBudgets(
      {
        hotSpots: {},
        bundle: { maxTotalBytes: 5000 },
      },
      {
        hotSpots: {},
        bundle: { maxTotalBytes: 4000, maxJavaScriptChunkBytes: 2000 },
      },
    ),
    [
      "bundle maxTotalBytes increased from 4000 to 5000; budgets may only decrease",
      "bundle maxJavaScriptChunkBytes increased from 2000 to missing; budgets may only decrease",
    ],
  );
});

test("architecture budget bootstrap rejects tracked base read and JSON failures", () => {
  assert.equal(
    loadTrackedArchitectureBudgetAtBase({
      tracked: false,
      readContents: () => {
        throw new Error("must not read an absent path");
      },
      label: "base budget",
    }),
    undefined,
  );
  assert.throws(
    () =>
      loadTrackedArchitectureBudgetAtBase({
        tracked: true,
        readContents: () => {
          throw new Error("git read failed");
        },
        label: "base budget",
      }),
    /cannot read tracked base budget/,
  );
  assert.throws(
    () =>
      loadTrackedArchitectureBudgetAtBase({
        tracked: true,
        readContents: () => "not-json",
        label: "base budget",
      }),
    /tracked base budget is invalid JSON/,
  );
});

test("parseUnifiedDiffLines extracts only added destination lines", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -2,2 +2,3 @@",
    " unchanged",
    "+added",
    "+another",
    "@@ -20 +21 @@",
    "+last",
    "diff --git a/src/遗漏.ts b/src/遗漏.ts",
    "+++ b/src/遗漏.ts",
    "@@ -0,0 +1 @@",
    "+export const uncovered = true;",
  ].join("\n");

  assert.deepEqual(parseUnifiedDiffLines(diff), {
    "src/a.ts": [3, 4, 21],
    "src/遗漏.ts": [1],
  });
});

test("compareCoverage rejects regressions and uncovered changed lines", () => {
  const result = compareCoverage({
    current: { lines: 79.99, branches: 70, functions: 81 },
    baseline: { lines: 80, branches: 69, functions: 81 },
    changed: { linePercent: 79, branchPercent: 69 },
  });

  assert.deepEqual(result, [
    "overall lines coverage regressed: 79.99% < 80%",
    "changed lines coverage is 79%; required 80%",
    "changed branches coverage is 69%; required 70%",
  ]);
});

test("changed coverage is enforced whenever a base commit is available", () => {
  assert.equal(
    shouldEnforceChangedCoverage({ baseRef: "origin/main", baselineExistsAtBase: false }),
    true,
  );
  assert.equal(
    shouldEnforceChangedCoverage({ baseRef: "origin/main", baselineExistsAtBase: true }),
    true,
  );
  assert.equal(
    shouldEnforceChangedCoverage({ baseRef: undefined, baselineExistsAtBase: true }),
    false,
  );
});
