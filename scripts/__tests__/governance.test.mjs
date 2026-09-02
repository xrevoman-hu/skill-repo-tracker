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

test("Vite public files and unregistered frontend asset types cannot bypass governance", () => {
  assert.deepEqual(
    checkRepositoryBoundaries({
      trackedFiles: [
        "public/payload.html",
        "src/payload.wasm",
        "src/fixture.txt",
        "src/promptsCss.test.mjs",
      ],
      packageJson: {
        dependencies: {},
        devDependencies: {},
        scripts: CRITICAL_PACKAGE_SCRIPTS,
      },
      lockUrls: [],
    }),
    [
      "Vite public directory is forbidden; production assets must enter a governed source inventory: public/payload.html",
      "unregistered frontend source or asset type is forbidden: src/payload.wasm",
      "unregistered frontend source or asset type is forbidden: src/fixture.txt",
    ],
  );
});

test("Vite cannot auto-discover an external PostCSS execution surface", () => {
  assert.deepEqual(
    checkRepositoryBoundaries({
      trackedFiles: [".postcssrc.json", "styles/postcss.config.ts"],
      packageJson: {
        dependencies: {},
        devDependencies: {},
        scripts: CRITICAL_PACKAGE_SCRIPTS,
        postcss: { plugins: ["hidden-plugin"] },
      },
      lockUrls: [],
    }),
    [
      "external PostCSS config is forbidden because Vite uses an exact inline plugin inventory: .postcssrc.json",
      "external PostCSS config is forbidden because Vite uses an exact inline plugin inventory: styles/postcss.config.ts",
      "executable JavaScript/TypeScript is outside governed roots: styles/postcss.config.ts",
      "package.json postcss config is forbidden because Vite uses an exact inline plugin inventory",
    ],
  );
});

test("executable repository code cannot live outside governed source and tooling roots", () => {
  assert.deepEqual(
    checkRepositoryBoundaries({
      trackedFiles: [
        "docs/helper.mjs",
        "support/escape.ts",
        "vite.config.mjs",
        "vitest.config.ts",
        "playwright.config.ts",
        "scripts/helper.mjs",
        "src/helper.ts",
        "e2e/helper.ts",
      ],
      packageJson: {
        dependencies: {},
        devDependencies: {},
        scripts: CRITICAL_PACKAGE_SCRIPTS,
      },
      lockUrls: [],
    }),
    [
      "executable JavaScript/TypeScript is outside governed roots: docs/helper.mjs",
      "executable JavaScript/TypeScript is outside governed roots: support/escape.ts",
    ],
  );
});

test("governance scripts cannot escape the audited JavaScript graph through another runtime", () => {
  assert.deepEqual(
    checkRepositoryBoundaries({
      trackedFiles: ["scripts/escape.py", "scripts/escape.sh", "scripts/governed.mjs"],
      packageJson: {
        dependencies: {},
        devDependencies: {},
        scripts: CRITICAL_PACKAGE_SCRIPTS,
      },
      lockUrls: [],
    }),
    [
      "unregistered governance script type is forbidden; executable tooling must remain in the audited .mjs graph: scripts/escape.py",
      "unregistered governance script type is forbidden; executable tooling must remain in the audited .mjs graph: scripts/escape.sh",
    ],
  );
});

test("repository-local npm and Cargo overrides cannot replace gate executors", () => {
  const errors = checkRepositoryBoundaries({
    trackedFiles: [
      ".npmrc",
      "rust-toolchain",
      ".cargo/config.toml",
      "src-tauri/.cargo/config.toml",
      "npm-shrinkwrap.json",
      "packages/hidden/npm-shrinkwrap.json",
    ],
    packageJson: {
      dependencies: {},
      devDependencies: {},
      scripts: CRITICAL_PACKAGE_SCRIPTS,
    },
    lockUrls: [],
  });
  assert.deepEqual(errors, [
    "repository-local toolchain override is forbidden because it can bypass deterministic gates: .npmrc",
    "repository-local toolchain override is forbidden because it can bypass deterministic gates: rust-toolchain",
    "repository-local toolchain override is forbidden because it can bypass deterministic gates: .cargo/config.toml",
    "repository-local toolchain override is forbidden because it can bypass deterministic gates: src-tauri/.cargo/config.toml",
    "tracked npm-shrinkwrap.json is forbidden because it overrides package-lock.json: npm-shrinkwrap.json",
    "tracked npm-shrinkwrap.json is forbidden because it overrides package-lock.json: packages/hidden/npm-shrinkwrap.json",
  ]);
});

test("tracked symlinks and submodules cannot move executable sources outside governance roots", () => {
  assert.deepEqual(
    checkRepositoryBoundaries({
      trackedFiles: ["src/escaped.ts", "vendor/hidden"],
      trackedEntries: [
        { mode: "120000", path: "src/escaped.ts" },
        { mode: "160000", path: "vendor/hidden" },
      ],
      packageJson: {
        dependencies: {},
        devDependencies: {},
        scripts: CRITICAL_PACKAGE_SCRIPTS,
      },
      lockUrls: [],
    }),
    [
      "tracked path must be a regular file, not mode 120000: src/escaped.ts",
      "tracked path must be a regular file, not mode 160000: vendor/hidden",
    ],
  );
});

test("Vitest workspace and projects auto-discovery cannot replace the governed suite", () => {
  for (const path of [
    "vitest.workspace.ts",
    "vitest.workspace.json",
    "vitest.projects.mts",
    "vitest.projects.cjs",
  ]) {
    assert.deepEqual(
      checkRepositoryBoundaries({
        trackedFiles: [path],
        packageJson: {
          dependencies: {},
          devDependencies: {},
          scripts: CRITICAL_PACKAGE_SCRIPTS,
        },
        lockUrls: [],
      }),
      [
        ...(/\.(?:ts|mts|cjs)$/.test(path)
          ? [`executable JavaScript/TypeScript is outside governed roots: ${path}`]
          : []),
        `Vitest workspace/projects config is forbidden because it can replace governed test discovery: ${path}`,
      ],
    );
  }
});

test("platform Tauri overlays and custom build logic cannot escape the governed config", () => {
  for (const path of [
    "src-tauri/tauri.macos.conf.json",
    "src-tauri/tauri.macos.conf.json5",
    "src-tauri/Tauri.macos.toml",
    "src-tauri/tauri.linux.conf.toml",
  ]) {
    assert.equal(isAlternateTauriConfigPath(path), true, path);
  }
  assert.equal(isAlternateTauriConfigPath("src-tauri/tauri.conf.json"), false);
  const boundaryErrors = checkRepositoryBoundaries({
    trackedFiles: ["src-tauri/tauri.conf.json", "src-tauri/tauri.macos.conf.json"],
    packageJson: {
      dependencies: {},
      devDependencies: {},
      scripts: CRITICAL_PACKAGE_SCRIPTS,
    },
    lockUrls: [],
  });
  assert.deepEqual(boundaryErrors, [
    "alternate Tauri config is forbidden; keep src-tauri/tauri.conf.json as the only effective config: src-tauri/tauri.macos.conf.json",
  ]);
  assert.deepEqual(
    validateTauriBuildScriptPolicy("fn main() {\n    tauri_build::build();\n}\n"),
    [],
  );
  assert.match(
    validateTauriBuildScriptPolicy(
      "fn main() { println!(\"cargo:rustc-env=TAURI_CONFIG=unsafe\"); tauri_build::build(); }\n",
    )[0],
    /exact default Tauri build contract/,
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
        workspaces: ["packages/*"],
        scripts: CRITICAL_PACKAGE_SCRIPTS,
      },
      lockUrls: [],
      lockPackages: {
        "": { workspaces: ["packages/*"] },
        "node_modules/hidden": { resolved: "packages/hidden", link: true },
      },
    }),
    [
      "dependencies contains a local package outside governed src/: shared=file:../shared",
      "devDependencies contains a local package outside governed src/: tooling=workspace:*",
      "package.json workspaces are forbidden until every workspace source root is governed",
      "package-lock.json root workspaces are forbidden until every workspace source root is governed",
      "package-lock contains a local linked package outside governed src/: node_modules/hidden",
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

test("critical npm lifecycle hooks cannot execute before or after a governed gate", () => {
  const scripts = {
    ...CRITICAL_PACKAGE_SCRIPTS,
    preverify: "true",
    "posttest:scripts": "true",
    preinstall: "node exploit.mjs",
    prepare: "node exploit.mjs",
  };
  assert.deepEqual(validateCriticalPackageScripts(scripts), [
    "critical package script lifecycle hook is forbidden: posttest:scripts",
    "critical package script lifecycle hook is forbidden: preverify",
    "package install lifecycle hook is forbidden: preinstall",
    "package install lifecycle hook is forbidden: prepare",
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

  assert.equal(errors.length, 11);
  assert.match(errors[0], /test\.skip is forbidden/);
  assert.match(errors[1], /it\.concurrent\.only is forbidden/);
  assert.match(errors[2], /test\.skipIf is forbidden/);
  assert.match(errors[3], /test\.each\.skip is forbidden/);
  assert.match(errors[4], /test\.runIf is forbidden/);
  assert.match(errors[5], /values\.skip is forbidden/);
  assert.match(errors[6], /test\.skip is forbidden/);
  assert.match(errors[7], /it\.only is forbidden/);
  assert.match(errors[8], /test\.each\.skip is forbidden/);
  assert.match(errors[9], /test registration API is used indirectly/);
  assert.match(errors[10], /t\.todo is forbidden/);
});

test("test policy requires static non-empty data tables", () => {
  const errors = findForbiddenTestModifiers(
    "scripts/__tests__/false-evidence.test.mjs",
    [
      'test("skipped", { skip: true }, () => { throw new Error("never"); });',
      'test("indirect", options, callback);',
      'test.each([])("zero rows", () => { throw new Error("never"); });',
      'const rows = [1]; test.each(rows)("indirect rows", () => {});',
      'test.each(new Array(0))("constructed rows", () => {});',
      'test.each(flag ? [1] : [])("conditional rows", () => {});',
      'test.each`value\n${1}`("tagged rows", () => {});',
      'test.each(([1] as const))("static rows", () => {});',
      'test("safe", () => {}, 1000);',
    ].join("\n"),
  );
  assert.equal(errors.length, 8);
  assert.match(errors[0], /direct \(title, callback/);
  assert.match(errors[1], /direct \(title, callback/);
  for (const error of errors.slice(2, 6)) {
    assert.match(error, /\.each data must be a direct non-empty array literal/);
  }
  assert.match(errors[6], /test registration API is used indirectly/);
  assert.match(errors[7], /tagged \.each data is forbidden/);
});

test("test policy rejects computed, aliased, destructured, and rebound registration APIs", () => {
  const errors = findForbiddenTestModifiers(
    "scripts/__tests__/indirect.test.mjs",
    [
      'const mode = "skip"; test[mode]("computed", () => {});',
      "const { skip: disabled } = test; disabled(\"destructured\", () => {});",
      "const alias = it; alias(\"aliased\", () => {});",
      "let rebound; rebound = describe;",
      "suite = replacement;",
      'test("safe direct", () => {});',
      'it.each([1])("safe table", () => {});',
    ].join("\n"),
  );

  assert.equal(errors.length, 5);
  assert.match(errors[0], /test registration API is used indirectly/);
  assert.match(errors[1], /test registration API is used indirectly/);
  assert.match(errors[2], /it registration API is used indirectly/);
  assert.match(errors[3], /describe registration API is used indirectly/);
  assert.match(errors[4], /suite registration API is used indirectly/);
});

test("test registration APIs cannot escape through value positions or reflection", () => {
  const errors = findForbiddenTestModifiers(
    "scripts/__tests__/reflected.test.mjs",
    [
      'import test from "node:test";',
      'import { describe, it, suite } from "node:test";',
      'import runner from "node:test";',
      'import * as runnerNamespace from "vitest";',
      "register(test);",
      "consume([it]);",
      'Reflect.get(globalThis, "describe")("hidden", () => {});',
      'Reflect.get(suite, "skip")("hidden", () => {});',
      'globalThis[registrationName]("hidden", () => {});',
      'test("safe", () => {});',
      'describe.each([1])("safe table", () => {});',
    ].join("\n"),
  );

  assert.equal(errors.length, 7);
  assert.match(errors[0], /test runner default import must be named test/);
  assert.match(errors[1], /test runner namespace imports are forbidden/);
  assert.match(errors[2], /test registration API is used indirectly/);
  assert.match(errors[3], /it registration API is used indirectly/);
  assert.match(errors[4], /Reflect\.get is forbidden/);
  assert.match(errors[5], /Reflect\.get is forbidden/);
  assert.match(errors[6], /computed global test API access is forbidden/);
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

test("absolute Vite imports cannot traverse out of src or attach loader queries", () => {
  const errors = findFrontendImportEscapes(
    "src/product.ts",
    [
      'import payload from "/src/../README.md?raw";',
      'import raw from "/src/App.tsx?raw";',
      'import safe from "/src/App";',
    ].join("\n"),
  ).map((error) => error.replace(/:\d+:\d+/, ":LINE"));

  assert.deepEqual(errors, [
    "src/product.ts:LINE imports outside governed src/: /src/../README.md?raw",
    "src/product.ts:LINE uses a Vite loader query or fragment outside the governed module contract: /src/App.tsx?raw",
  ]);
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

  assert.deepEqual(
    findRustTestModulesVisibleInProduction(
      "src-tauri/src/product.rs",
      '#[cfg(test)]\n#[path = "tests.rs"]\nmod tests;',
    ),
    [
      "src-tauri/src/product.rs:2 uses #[path] module tests.rs; only canonical #[cfg(test)] external dedicated *_tests.rs modules are allowed",
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

test("production Rust cannot opt out of LLVM coverage instrumentation", () => {
  assert.deepEqual(
    findForbiddenRustTestCfg(
      "src-tauri/src/example.rs",
      [
        "#![cfg_attr(coverage_nightly, feature(coverage_attribute))]",
        "#[cfg_attr(coverage_nightly, coverage(off))]",
        "fn hidden_from_lcov() {}",
      ].join("\n"),
    ),
    [
      "src-tauri/src/example.rs:1 enables the Rust coverage exclusion attribute; production coverage exclusions are forbidden",
      "src-tauri/src/example.rs:2 disables Rust coverage instrumentation; production coverage exclusions are forbidden",
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
        "#![allow(warnings)]",
        "fn crate_wide_warning_escape() {}",
        '#[expect(warnings, reason = "do not fail CI")]',
        "fn local_warning_escape() {}",
        '#[expect(clippy::too_many_arguments, reason = "warnings are reviewed here")]',
        "fn reason_text_is_not_a_lint_name() {}",
      ].join("\n"),
    ),
    [
      "src-tauri/src/example.rs:1 uses a crate/module-wide Clippy suppression",
      "src-tauri/src/example.rs:2 uses allow(clippy); use a narrow expect with a reason",
      "src-tauri/src/example.rs:4 uses expect(clippy) without a non-empty reason",
      "src-tauri/src/example.rs:8 conditionally suppresses Clippy through cfg_attr; use an unconditional narrow expect with a reason",
      "src-tauri/src/example.rs:10 conditionally suppresses Clippy through cfg_attr; use an unconditional narrow expect with a reason",
      "src-tauri/src/example.rs:12 uses allow(clippy); use a narrow expect with a reason",
      "src-tauri/src/example.rs:16 suppresses the Rust warnings lint group; -D warnings must remain authoritative",
      "src-tauri/src/example.rs:18 suppresses the Rust warnings lint group; -D warnings must remain authoritative",
    ],
  );
});
