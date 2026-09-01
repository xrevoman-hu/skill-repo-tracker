import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  isProductionModule,
  loadTrackedArchitectureBudgetAtBase,
  parseUnifiedDiffLines,
  shouldEnforceChangedCoverage,
  validateCiWorkflowPolicy,
  validateCriticalPackageScripts,
  validateRuntimeToolchain,
  validateReleaseWorkflowPolicy,
  validateRepositoryAutomationPolicy,
  validateSecurityAuditWorkflowPolicy,
  validateVersions,
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
  "verify:governance": "node scripts/governance.mjs all",
  verify: "node scripts/verify.mjs",
  "github:governance:check": "node scripts/github-governance-check.mjs",
  "release:verify": "node scripts/release-verify.mjs",
  "tauri:build": "tauri build",
};

test("architecture production inventory excludes dedicated test modules", () => {
  assert.equal(isProductionModule("src/App.tsx"), true);
  assert.equal(isProductionModule("src/App.test.tsx"), false);
  assert.equal(isProductionModule("src/feature.mts"), true);
  assert.equal(isProductionModule("src/feature.cts"), true);
  assert.equal(isProductionModule("src/feature.test.mts"), false);
  assert.equal(isProductionModule("src/contracts.d.mts"), false);
  assert.equal(isProductionModule("src/contracts.d.cts"), false);
  assert.equal(isProductionModule("src-tauri/src/backups.rs"), true);
  assert.equal(isProductionModule("src-tauri/src/backups_tests.rs"), false);
  assert.equal(isProductionModule("src-tauri/src/tests.rs"), false);
});

test("production JavaScript cannot bypass the TypeScript and coverage gates", () => {
  for (const path of [
    "src/feature.js",
    "src/feature.jsx",
    "src/feature.mjs",
    "src/feature.cjs",
  ]) {
    assert.equal(isForbiddenProductionJavaScriptPath(path), true);
  }
  assert.equal(isForbiddenProductionJavaScriptPath("src/feature.test.mjs"), false);
  assert.equal(isForbiddenProductionJavaScriptPath("scripts/governance.mjs"), false);
});

test("validateVersions accepts one version across every manifest", () => {
  assert.deepEqual(
    validateVersions({
      packageVersion: "1.2.2",
      lockRootVersion: "1.2.2",
      cargoVersion: "1.2.2",
      cargoLockVersion: "1.2.2",
      tauriVersion: "1.2.2",
    }),
    [],
  );
});

test("validateVersions reports the exact divergent source", () => {
  assert.deepEqual(
    validateVersions({
      packageVersion: "1.2.2",
      lockRootVersion: "1.2.2",
      cargoVersion: "1.2.2",
      cargoLockVersion: "1.2.1",
      tauriVersion: "1.2.2",
    }),
    ["src-tauri/Cargo.lock package version is 1.2.1; expected 1.2.2"],
  );
});

test("runtime toolchain requires the exact pinned Node and npm versions", () => {
  assert.deepEqual(
    validateRuntimeToolchain({ nodeVersion: "v22.23.1", npmVersion: "10.9.8" }),
    [],
  );
  assert.deepEqual(
    validateRuntimeToolchain({ nodeVersion: "v22.22.0", npmVersion: "11.0.0" }),
    [
      "running Node is v22.22.0; expected v22.23.1",
      "running npm is 11.0.0; expected 10.9.8",
    ],
  );
});

test("release workflow is manual, read-only, approved, and runs on Apple Silicon", () => {
  const valid = readFileSync(
    new URL("../../.github/workflows/release-gate.yml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(validateReleaseWorkflowPolicy(valid), []);

  const unsafe = valid
    .replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n")
    .replace("contents: read", "contents: write")
    .replace("runs-on: macos-15", "runs-on: macos-15-arm64")
    .replace("environment: release", "environment: production");
  const errors = validateReleaseWorkflowPolicy(unsafe);
  assert.ok(errors.some((error) => error.includes("only workflow_dispatch")));
  assert.ok(errors.some((error) => error.includes("contents: read")));
  assert.ok(errors.some((error) => error.includes("Apple Silicon macos-15")));
  assert.ok(errors.some((error) => error.includes("environment: release")));

  for (const mutation of [
    valid.replace(
      "        run: npm run release:verify",
      "        continue-on-error: true\n        run: npm run release:verify",
    ),
    valid.replace(
      "        run: npm run release:verify",
      "        if: always()\n        run: npm run release:verify",
    ),
    valid.replace(
      "        run: npm run release:verify",
      "        shell: bash\n        run: npm run release:verify",
    ),
    valid.replace("    runs-on: macos-15", "    if: always()\n    runs-on: macos-15"),
    valid.replace(
      "    runs-on: macos-15",
      "    continue-on-error: true\n    runs-on: macos-15",
    ),
    `${valid}\n      - run: npm run release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$RELEASE_MANIFEST"\n`,
    valid.replace('"$RELEASE_MANIFEST"', '"$RELEASE_MANIFEST" || true'),
  ]) {
    assert.ok(
      validateReleaseWorkflowPolicy(mutation).some((error) =>
        error.includes("release verifier step must be unique, unconditional, fail-closed, and exact"),
      ),
    );
  }

  for (const mutation of [
    valid.replace(
      "permissions:\n",
      "defaults:\n  run:\n    shell: bash {0} || true\npermissions:\n",
    ),
    valid.replace(
      "      - name: Run the explicit release verification lane",
      "      - name: Rewrite the verifier command\n        run: npm pkg set scripts.release:verify=true\n      - name: Run the explicit release verification lane",
    ),
  ]) {
    assert.ok(
      validateReleaseWorkflowPolicy(mutation).some((error) =>
        error.includes("release workflow must match the complete fail-closed template"),
      ),
    );
  }
});

test("CI workflow keeps every required gate fail-closed and exact", () => {
  const valid = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.deepEqual(validateCiWorkflowPolicy(valid), []);

  for (const [label, mutation] of [
    ["replace verify with true", valid.replace("run: npm run verify", "run: true")],
    [
      "mask coverage failure",
      valid.replace("run: npm run coverage:check", "run: npm run coverage:check || true"),
    ],
    [
      "allow E2E failure",
      valid.replace(
        "      - name: Run browser acceptance with DemoAppService\n        run: npm run test:e2e",
        "      - name: Run browser acceptance with DemoAppService\n        continue-on-error: true\n        run: npm run test:e2e",
      ),
    ],
    ["remove pull request trigger", valid.replace("  pull_request:\n", "")],
    ["rename required job", valid.replace("  verify:\n    name: verify", "  verify-renamed:\n    name: verify")],
    [
      "rewrite a critical package script",
      valid.replace(
        "      - name: Run the deterministic repository gate",
        "      - name: Rewrite the deterministic gate\n        run: npm pkg set scripts.verify=true\n      - name: Run the deterministic repository gate",
      ),
    ],
    [
      "remove the locked MSRV flag",
      valid.replace("cargo +1.88.0 check --locked", "cargo +1.88.0 check"),
    ],
  ]) {
    assert.ok(
      validateCiWorkflowPolicy(mutation).includes(
        "CI workflow must match the complete fail-closed template",
      ),
      label,
    );
  }
  assert.match(validateCiWorkflowPolicy("jobs: [")[0], /CI workflow is invalid YAML/);
});

test("security audit workflow keeps registry and Cargo audits fail-closed and scheduled", () => {
  const valid = readFileSync(
    new URL("../../.github/workflows/security-audit.yml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(validateSecurityAuditWorkflowPolicy(valid), []);

  for (const [label, mutation] of [
    [
      "replace npm audit with true",
      valid.replace(
        "run: npm audit --audit-level=high --registry=https://registry.npmjs.org",
        "run: true",
      ),
    ],
    [
      "mask Cargo audit failure",
      valid.replace(
        "run: cargo audit --file src-tauri/Cargo.lock",
        "run: cargo audit --file src-tauri/Cargo.lock || true",
      ),
    ],
    [
      "allow audit job failure",
      valid.replace("    runs-on: macos-15", "    continue-on-error: true\n    runs-on: macos-15"),
    ],
    ["remove schedule", valid.replace('  schedule:\n    - cron: "17 2 * * 1"\n', "")],
  ]) {
    assert.ok(
      validateSecurityAuditWorkflowPolicy(mutation).includes(
        "security audit workflow must match the complete fail-closed template",
      ),
      label,
    );
  }
  assert.match(
    validateSecurityAuditWorkflowPolicy("jobs: [")[0],
    /security audit workflow is invalid YAML/,
  );
});

test("weekly resilience workflow keeps repeats and the performance gate fail-closed", () => {
  const valid = readFileSync(
    new URL("../../.github/workflows/weekly-resilience.yml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(validateWeeklyResilienceWorkflowPolicy(valid), []);

  for (const [label, mutation] of [
    ["replace repeated Vitest with true", valid.replace("            npm test", "            true")],
    [
      "remove performance command",
      valid.replace(
        "run: cargo test --release --locked --manifest-path src-tauri/Cargo.toml prompt_library_release_performance_gate -- --ignored --nocapture --test-threads=1",
        "run: true",
      ),
    ],
    ["reduce repetition", valid.replace("for attempt in 1 2 3; do", "for attempt in 1 2; do")],
    [
      "allow repeat step failure",
      valid.replace(
        "      - name: Repeat race and filesystem suites\n        run: |",
        "      - name: Repeat race and filesystem suites\n        continue-on-error: true\n        run: |",
      ),
    ],
    ["remove schedule", valid.replace('  schedule:\n    - cron: "43 3 * * 0"\n', "")],
  ]) {
    assert.ok(
      validateWeeklyResilienceWorkflowPolicy(mutation).includes(
        "weekly resilience workflow must match the complete fail-closed template",
      ),
      label,
    );
  }
  assert.match(
    validateWeeklyResilienceWorkflowPolicy("jobs: [")[0],
    /weekly resilience workflow is invalid YAML/,
  );
});

test("repository automation policy requires both scheduled workflows and weekly npm/Cargo updates", () => {
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/release-gate.yml",
    ".github/workflows/security-audit.yml",
    ".github/workflows/weekly-resilience.yml",
  ];
  const dependabot = `
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: cargo
    directory: /src-tauri
    schedule: { interval: weekly }
`;
  assert.deepEqual(
    validateRepositoryAutomationPolicy({ workflowPaths, dependabotContents: dependabot }),
    [],
  );
  const errors = validateRepositoryAutomationPolicy({
    workflowPaths: workflowPaths.slice(0, 2),
    dependabotContents: "version: 2\nupdates: []\n",
  });
  assert.ok(errors.some((error) => error.includes("security-audit.yml")));
  assert.ok(errors.some((error) => error.includes("weekly-resilience.yml")));
  assert.ok(errors.some((error) => error.includes("npm / weekly")));
  assert.ok(errors.some((error) => error.includes("cargo /src-tauri weekly")));
});

test("repository boundaries reject private material and runtime build tools", () => {
  assert.deepEqual(
    checkRepositoryBoundaries({
      trackedFiles: ["AGENTS.md", "docs/internal/note.md"],
      packageJson: {
        dependencies: { vite: "6.4.3" },
        devDependencies: {},
        scripts: CRITICAL_PACKAGE_SCRIPTS,
      },
      lockUrls: ["https://registry.npmmirror.com/example.tgz"],
    }),
    [
      "private file is tracked: AGENTS.md",
      "private file is tracked: docs/internal/note.md",
      "build tool must be in devDependencies: vite",
      "package-lock contains a non-official registry URL: https://registry.npmmirror.com/example.tgz",
    ],
  );
});

test("repository boundaries reject local package escape hatches", () => {
  assert.deepEqual(
    checkRepositoryBoundaries({
      trackedFiles: [],
      packageJson: {
        dependencies: { shared: "file:../shared" },
        devDependencies: { tooling: "workspace:*" },
        imports: { "#hidden": "./src/hidden.test.ts" },
        scripts: CRITICAL_PACKAGE_SCRIPTS,
      },
      lockUrls: [],
    }),
    [
      "dependencies contains a local package outside governed src/: shared=file:../shared",
      "devDependencies contains a local package outside governed src/: tooling=workspace:*",
      "package.json imports aliases are forbidden; repository-relative module paths keep the governed graph auditable",
    ],
  );
});

test("critical package scripts are exact and repository boundaries enforce them", () => {
  assert.deepEqual(validateCriticalPackageScripts(CRITICAL_PACKAGE_SCRIPTS), []);

  for (const [name, replacement] of [
    ["verify", "true"],
    ["coverage:check", "npm run test:coverage || true"],
    ["test:e2e", "playwright test || true"],
    ["release:verify", "node scripts/release-verify.mjs || true"],
  ]) {
    const scripts = { ...CRITICAL_PACKAGE_SCRIPTS, [name]: replacement };
    const expected = `critical package script ${name} is ${replacement}; expected ${CRITICAL_PACKAGE_SCRIPTS[name]}`;
    assert.deepEqual(validateCriticalPackageScripts(scripts), [expected]);
    assert.ok(
      checkRepositoryBoundaries({
        trackedFiles: [],
        packageJson: { dependencies: {}, devDependencies: {}, scripts },
        lockUrls: [],
      }).includes(expected),
    );
  }

  assert.deepEqual(validateCriticalPackageScripts({}), [
    ...Object.entries(CRITICAL_PACKAGE_SCRIPTS).map(
      ([name, command]) => `critical package script ${name} is missing; expected ${command}`,
    ),
  ]);
});

test("TypeScript AST rejects explicit any without matching prose or string literals", () => {
  const errors = findExplicitAny(
    "src/example.ts",
    ['const prose = "any";', "type Safe = unknown;", "type Unsafe = any;"].join("\n"),
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0], /^src\/example\.ts:3:\d+ uses explicit any$/);
});

test("test policy rejects focus, skip, and conditional run modifiers", () => {
  const errors = findForbiddenTestModifiers(
    "src/example.test.ts",
    [
      'test.skip("blocked", () => {});',
      'it.concurrent.only("focused", () => {});',
      'test.skipIf(true)("conditional", () => {});',
      'test.each([1, 2]).skip("table", () => {});',
      'test.runIf(false)("disabled", () => {});',
      "const iterator = values.skip(1);",
      'test["skip"]("element", () => {});',
      "it['only']('element focus', () => {});",
      'test.each([1])["skip"]("element table", () => {});',
      "const t = test; const aliased = t.todo;",
      'const prose = "test.todo";',
    ].join("\n"),
  );

  assert.equal(errors.length, 10);
  assert.match(errors[0], /test\.skip is forbidden/);
  assert.match(errors[1], /it\.concurrent\.only is forbidden/);
  assert.match(errors[2], /test\.skipIf is forbidden/);
  assert.match(errors[3], /test\.each\.skip is forbidden/);
  assert.match(errors[4], /test\.runIf is forbidden/);
  assert.match(errors[5], /values\.skip is forbidden/);
  assert.match(errors[6], /test\.skip is forbidden/);
  assert.match(errors[7], /it\.only is forbidden/);
  assert.match(errors[8], /test\.each\.skip is forbidden/);
  assert.match(errors[9], /t\.todo is forbidden/);
});

test("Worker module URLs are part of the governed production module graph", () => {
  const contents = [
    'new Worker(new URL("./hidden.test.ts", import.meta.url));',
    'new SharedWorker(new URL("../../outside.ts", import.meta.url));',
    'new globalThis.Worker(new URL("./global.test.ts", import.meta.url));',
    'new Worker(new URL(runtimePath, import.meta.url));',
  ].join("\n");
  assert.equal(findProductionTestImports("src/features/product.ts", contents).length, 2);
  assert.equal(findFrontendImportEscapes("src/features/product.ts", contents).length, 1);
  assert.deepEqual(
    findFrontendModuleGraphHazards("src/features/product.ts", contents).map((error) =>
      error.replace(/:\d+:\d+/, ":LINE"),
    ),
    ["src/features/product.ts:LINE uses a non-literal URL module reference"],
  );
});

test("import.meta.glob cannot create an unaudited production graph", () => {
  assert.deepEqual(
    findFrontendModuleGraphHazards(
      "src/product.ts",
      'const modules = import.meta.glob("./fixtures/**/*.test.ts");',
    ).map((error) => error.replace(/:\d+:\d+/, ":LINE")),
    [
      "src/product.ts:LINE uses import.meta.glob; production module graphs must use explicit imports so test and path exclusions cannot be bypassed",
    ],
  );
});

test("Vite new URL assets cannot smuggle excluded modules into production", () => {
  const contents = [
    'const hidden = new URL("./fixture.test.ts", import.meta.url);',
    "const dynamic = new URL(runtimePath, import.meta.url);",
  ].join("\n");
  assert.equal(findProductionTestImports("src/product.ts", contents).length, 1);
  assert.deepEqual(
    findFrontendModuleGraphHazards("src/product.ts", contents).map((error) =>
      error.replace(/:\d+:\d+/, ":LINE"),
    ),
    ["src/product.ts:LINE uses a non-literal URL module reference"],
  );
});

test("Vite aliases cannot disguise test or out-of-tree imports", () => {
  assert.equal(
    findForbiddenFrontendAliases(
      "vite.config.ts",
      [
        'export default { resolve: { alias: { "@hidden": "/tmp/private" } } };',
        "const alias = {}; export const shorthand = { alias };",
        'export const computed = { ["alias"]: {} };',
      ].join("\n"),
    ).length,
    3,
  );
});

test("HTML module entrypoints stay inside governed production src", () => {
  assert.deepEqual(
    findHtmlModuleEntryHazards(
      "index.html",
      [
        '<script type="module" src="/src/main.tsx"></script>',
        '<script type="module" src="/src/hidden.test.ts?raw"></script>',
        '<script type="module" src="./scripts/outside.ts"></script>',
        '<script type="module">import "./src/inline.test.ts"</script>',
        '<script type="module" src="https://example.test/app.js"></script>',
        '<script src="/outside.js"></script>',
        '<script>window.escape = true</script>',
      ].join("\n"),
    ),
    [
      "index.html:2 loads an excluded test module entrypoint: /src/hidden.test.ts?raw",
      "index.html:3 loads a module entrypoint outside governed src/: ./scripts/outside.ts",
      "index.html:4 contains an inline module script; use an explicit governed src/ entrypoint",
      "index.html:5 loads an external module entrypoint: https://example.test/app.js",
      "index.html:6 contains a non-module script; only explicit governed src/ module entrypoints are allowed",
      "index.html:7 contains a non-module script; only explicit governed src/ module entrypoints are allowed",
    ],
  );
});

test("production TypeScript cannot import modules excluded as tests", () => {
  assert.deepEqual(
    findProductionTestImports(
      "src/product.ts",
      [
        'import value from "./helper.test";',
        'export { demo } from "./demo.spec.ts";',
        'const lazy = import("./lazy.test.tsx");',
        'const legacy = require("./legacy.spec");',
        'import Worker from "./worker.test.ts?worker";',
        'import raw from "./fixture.spec.ts?raw#fragment";',
        'import safe from "./contest";',
      ].join("\n"),
    ).map((error) => error.replace(/:\d+:\d+/, ":LINE")),
    [
      "src/product.ts:LINE imports excluded test module ./helper.test",
      "src/product.ts:LINE imports excluded test module ./demo.spec.ts",
      "src/product.ts:LINE imports excluded test module ./lazy.test.tsx",
      "src/product.ts:LINE imports excluded test module ./legacy.spec",
      "src/product.ts:LINE imports excluded test module ./worker.test.ts?worker",
      "src/product.ts:LINE imports excluded test module ./fixture.spec.ts?raw#fragment",
    ],
  );
});

test("frontend production imports cannot resolve outside governed src", () => {
  assert.deepEqual(
    findFrontendImportEscapes(
      "src/features/product.ts",
      [
        'import safe from "../shared";',
        'export { escaped } from "../../outside";',
        'const lazy = import("../../../private.ts?raw");',
        'const absolute = require("file:///tmp/unsafe.ts");',
      ].join("\n"),
    ).map((error) => error.replace(/:\d+:\d+/, ":LINE")),
    [
      "src/features/product.ts:LINE imports outside governed src/: ../../outside",
      "src/features/product.ts:LINE imports outside governed src/: ../../../private.ts?raw",
      "src/features/product.ts:LINE imports outside governed src/: file:///tmp/unsafe.ts",
    ],
  );
});

test("dedicated Rust test modules must be unreachable outside cfg(test)", () => {
  assert.deepEqual(
    findRustTestModulesVisibleInProduction(
      "src-tauri/src/product.rs",
      [
        "#[cfg(test)]",
        '#[path = "safe_tests.rs"]',
        "mod tests;",
        "mod leaked_tests;",
        '#[path = "hidden-production.inc"]',
        "mod hidden;",
      ].join("\n"),
    ),
    [
      "src-tauri/src/product.rs:4 exposes dedicated test module leaked_tests without #[cfg(test)]",
      "src-tauri/src/product.rs:5 uses #[path] module hidden-production.inc; only canonical #[cfg(test)] external dedicated *_tests.rs modules are allowed",
    ],
  );
});

test("Rust raw path attributes cannot bypass the dedicated test-module boundary", () => {
  assert.deepEqual(
    findRustTestModulesVisibleInProduction(
      "src-tauri/src/product.rs",
      [
        '#[cfg(test)] #[path = r#"safe_tests.rs"#] mod tests;',
        "#[cfg(test)]",
        '    #[path = r##"hidden-production.inc"##]',
        "mod hidden;",
      ].join("\n"),
    ),
    [
      "src-tauri/src/product.rs:3 uses #[path] module hidden-production.inc; only canonical #[cfg(test)] external dedicated *_tests.rs modules are allowed",
    ],
  );
});

test("non-canonical test cfg and cfg_attr(test) fail closed", () => {
  assert.deepEqual(
    findForbiddenRustTestCfg(
      "src-tauri/src/example.rs",
      [
        "#[cfg(test)]",
        "fn canonical() {}",
        "#[cfg(any(test))]",
        "fn disguised() {}",
        "#[cfg_attr(feature = \"probe\", cfg(test))]",
        "fn conditional() {}",
        "#[cfg(any(debug_assertions, test))]",
        "fn debug_or_test() {}",
        "#[cfg(not(test))]",
        "fn production_companion() {}",
      ].join("\n"),
    ),
    [
      "src-tauri/src/example.rs:3 uses non-canonical test cfg; use exact #[cfg(test)] so production coverage filtering fails closed",
      "src-tauri/src/example.rs:5 conditionally applies test cfg; cfg_attr involving test is forbidden",
      "src-tauri/src/example.rs:9 uses non-canonical test cfg; use exact #[cfg(test)] so production coverage filtering fails closed",
    ],
  );
});

test("production Rust cannot use include! to hide code in excluded test files", () => {
  assert.deepEqual(
    findForbiddenRustIncludes(
      "src-tauri/src/product.rs",
      ['include!("helper_tests.rs");', 'include!(concat!(env!("OUT_DIR"), "/generated.rs"));'].join("\n"),
    ),
    [
      "src-tauri/src/product.rs:1 uses include! in production; use a governed production module instead",
      "src-tauri/src/product.rs:2 uses include! in production; use a governed production module instead",
    ],
  );
});

test("Rust ignore policy permits only the named release performance gate", () => {
  const errors = findForbiddenRustIgnores(
    "src-tauri/src/example.rs",
    [
      "#[test]",
      '#[ignore = "run by release lane"]',
      "fn prompt_library_release_performance_gate() {}",
      "#[test]",
      "#[ignore]",
      "fn forgotten_regression() {}",
      "#[cfg_attr(any(), ignore)]",
      "fn conditionally_forgotten() {}",
    ].join("\n"),
  );

  assert.deepEqual(errors, [
    "src-tauri/src/example.rs:5 ignores non-whitelisted Rust test: forgotten_regression",
    "src-tauri/src/example.rs:7 conditionally ignores a test; cfg_attr(ignore) is forbidden",
  ]);
});

test("Clippy suppressions must be narrow expectations with reasons", () => {
  assert.deepEqual(
    findForbiddenClippySuppressions(
      "src-tauri/src/example.rs",
      [
        "#![allow( clippy::all )]",
        "#[allow(clippy::too_many_arguments)]",
        "fn hidden() {}",
        "#[expect(clippy::too_many_arguments)]",
        "fn unexplained() {}",
        '#[expect(clippy::too_many_arguments, reason = "wire boundary")]',
        "fn justified() {}",
        "#[cfg_attr(test, allow(clippy::unwrap_used))]",
        "fn conditional_allow() {}",
        '#[cfg_attr(test, expect(clippy::unwrap_used, reason = "conditional"))]',
        "fn conditional_expect() {}",
        "#[allow(clippy :: all)]",
        "fn spaced_allow() {}",
        '#[expect(r#clippy :: unwrap_used, reason = "raw identifier probe")]',
        "fn raw_identifier_expect() {}",
      ].join("\n"),
    ),
    [
      "src-tauri/src/example.rs:1 uses a crate/module-wide Clippy suppression",
      "src-tauri/src/example.rs:2 uses allow(clippy); use a narrow expect with a reason",
      "src-tauri/src/example.rs:4 uses expect(clippy) without a non-empty reason",
      "src-tauri/src/example.rs:8 conditionally suppresses Clippy through cfg_attr; use an unconditional narrow expect with a reason",
      "src-tauri/src/example.rs:10 conditionally suppresses Clippy through cfg_attr; use an unconditional narrow expect with a reason",
      "src-tauri/src/example.rs:12 uses allow(clippy); use a narrow expect with a reason",
    ],
  );
});

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
