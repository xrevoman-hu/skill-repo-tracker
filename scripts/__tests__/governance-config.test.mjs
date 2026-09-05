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
  "test:coverage": "vitest run --coverage --no-file-parallelism --coverage.processingConcurrency=1",
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

test("architecture production inventory excludes dedicated test modules", () => {
  assert.equal(isProductionModule("src/App.tsx"), true);
  assert.equal(isProductionModule("src/App.test.tsx"), false);
  assert.equal(isProductionModule("src/feature.mts"), true);
  assert.equal(isProductionModule("src/feature.cts"), true);
  assert.equal(isProductionModule("src/feature.css"), true);
  assert.equal(isProductionModule("src/feature.test.mts"), false);
  assert.equal(isProductionModule("src/contracts.d.mts"), false);
  assert.equal(isProductionModule("src/contracts.d.cts"), false);
  assert.equal(isProductionModule("src-tauri/src/backups.rs"), true);
  assert.equal(isProductionModule("src-tauri/src/backups_tests.rs"), false);
  assert.equal(isProductionModule("src-tauri/src/test.rs"), true);
  assert.equal(isProductionModule("src-tauri/src/tests.rs"), true);
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
      packageName: "skill-repo-tracker",
      packageVersion: "1.2.2",
      lockRootName: "skill-repo-tracker",
      lockRootVersion: "1.2.2",
      lockPackageName: "skill-repo-tracker",
      lockPackageVersion: "1.2.2",
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
      packageName: "skill-repo-tracker",
      packageVersion: "1.2.2",
      lockRootName: "skill-repo-tracker",
      lockRootVersion: "1.2.2",
      lockPackageName: "skill-repo-tracker",
      lockPackageVersion: "1.2.2",
      cargoVersion: "1.2.2",
      cargoLockVersion: "1.2.1",
      tauriVersion: "1.2.2",
    }),
    ["src-tauri/Cargo.lock package version is 1.2.1; expected 1.2.2"],
  );
  assert.deepEqual(
    validateVersions({
      packageName: "skill-repo-tracker",
      packageVersion: "1.2.2",
      lockRootName: "renamed-package",
      lockRootVersion: "1.2.2",
      lockPackageName: "skill-repo-tracker",
      lockPackageVersion: "1.2.1",
      cargoVersion: "1.2.2",
      cargoLockVersion: "1.2.2",
      tauriVersion: "1.2.2",
    }),
    [
      'package-lock.json packages[""] version is 1.2.1; expected 1.2.2',
      "package-lock.json root name is renamed-package; expected skill-repo-tracker",
    ],
  );
});

test("runtime toolchain requires the exact pinned Node and npm versions", () => {
  assert.deepEqual(
    validateRuntimeToolchain({ nodeVersion: "v22.23.1", npmVersion: "10.9.8" }),
    [],
  );
  assert.deepEqual(
    validateCargoTestDiscoveryPolicy(
      '[package]\nname = "app"\n[dependencies]\nevil = { path = "../evil" }\n[workspace]\nmembers = ["../also-evil"]\n[lints.rust]\nwarnings = "allow"\n',
    ),
    [
      "src-tauri/Cargo.toml cannot add workspaces, patches, or replacements outside the governed crate",
      "src-tauri/Cargo.toml cannot add local path dependencies outside the governed crate",
      "src-tauri/Cargo.toml cannot override Rust or Clippy lint levels; command-line -D warnings is authoritative",
    ],
  );
  assert.deepEqual(
    validateRuntimeToolchain({ nodeVersion: "v22.22.0", npmVersion: "11.0.0" }),
    [
      "running Node is v22.22.0; expected v22.23.1",
      "running npm is 11.0.0; expected 10.9.8",
    ],
  );
});

test("typecheck and test discovery configurations cannot silently shrink", () => {
  const tsconfig = JSON.parse(
    readFileSync(new URL("../../tsconfig.json", import.meta.url), "utf8"),
  );
  const vitest = readFileSync(
    new URL("../../vitest.config.ts", import.meta.url),
    "utf8",
  );
  const vite = readFileSync(new URL("../../vite.config.mjs", import.meta.url), "utf8");
  const playwright = readFileSync(
    new URL("../../playwright.config.ts", import.meta.url),
    "utf8",
  );
  const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const cargo = readFileSync(
    new URL("../../src-tauri/Cargo.toml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(validateTypeScriptConfigPolicy(tsconfig), []);
  assert.deepEqual(validateVitestConfigPolicy(vitest), []);
  assert.deepEqual(validateViteConfigPolicy(vite), []);
  assert.deepEqual(validatePlaywrightConfigPolicy(playwright), []);
  assert.deepEqual(validateIndexHtmlPolicy(indexHtml), []);
  assert.deepEqual(validateCargoTestDiscoveryPolicy(cargo), []);

  assert.match(
    validateTypeScriptConfigPolicy({
      ...tsconfig,
      compilerOptions: { ...tsconfig.compilerOptions, noCheck: true },
    })[0],
    /strict production discovery/,
  );
  assert.match(
    validateTypeScriptConfigPolicy({ ...tsconfig, include: [] })[0],
    /strict production discovery/,
  );
  assert.match(
    validateVitestConfigPolicy(
      vitest.replace("test: {", "test: {\n    passWithNoTests: true,\n    include: [\"src/always-green.test.ts\"],"),
    )[0],
    /test and coverage discovery/,
  );
  assert.match(
    validateViteConfigPolicy(
      vite.replace("plugins: [react()]", "plugins: [react(), { transform() { return 'evil' } }]")
    )[0],
    /production build contract/,
  );
  assert.match(
    validateViteConfigPolicy(
      vite.replace('target: "safari15"', 'target: "baseline-widely-available"'),
    )[0],
    /production build contract/,
  );
  assert.match(
    validateViteConfigPolicy(
      vite.replace('cssTarget: "safari15"', 'cssTarget: "baseline-widely-available"'),
    )[0],
    /production build contract/,
  );
  assert.match(
    validateViteConfigPolicy(vite.replace("sourcemap: false", "sourcemap: true"))[0],
    /production build contract/,
  );
  assert.match(
    validateViteConfigPolicy(
      vite.replace("output: { postBanner: SAFARI_15_OBJECT_HAS_OWN_BANNER }", "output: {}"),
    )[0],
    /production build contract/,
  );
  assert.match(
    validateViteConfigPolicy(vite.replace("publicDir: false", 'publicDir: "public"'))[0],
    /production build contract/,
  );
  assert.match(
    validateViteConfigPolicy(
      vite.replace("postcss: { plugins: [] }", 'postcss: "./.postcssrc.json"'),
    )[0],
    /production build contract/,
  );
  assert.match(
    validateIndexHtmlPolicy(
      indexHtml.replace("</body>", '<iframe src="/payload.html"></iframe>\n  </body>'),
    )[0],
    /exact governed Vite entrypoint/,
  );
  assert.match(
    validatePlaywrightConfigPolicy(
      playwright.replace('testDir: "./e2e"', 'testDir: "./empty-e2e"'),
    )[0],
    /E2E discovery contract/,
  );
  assert.match(
    validatePlaywrightConfigPolicy(
      playwright.replace("failOnFlakyTests: Boolean(process.env.CI)", "failOnFlakyTests: false"),
    )[0],
    /E2E discovery contract/,
  );
  assert.deepEqual(
    validateCargoTestDiscoveryPolicy(`${cargo}\nautotests = false\n[lib]\ntest = false\n`),
    [
      "src-tauri/Cargo.toml cannot disable automatic test discovery",
      "src-tauri/Cargo.toml cannot disable a Cargo test target or harness",
    ],
  );
});

test("Cargo metadata locks the real lib, bin, and build entrypoints", () => {
  const repositoryRoot = "/workspace/repository";
  const crateRoot = `${repositoryRoot}/src-tauri`;
  const packageId = `path+file://${crateRoot}#skill-repo-tracker@1.2.3`;
  const valid = {
    packages: [
      {
        name: "skill-repo-tracker",
        id: packageId,
        manifest_path: `${crateRoot}/Cargo.toml`,
        dependencies: [{ name: "serde", source: "registry+https://github.com/rust-lang/crates.io-index" }],
        targets: [
          {
            kind: ["staticlib", "cdylib", "rlib"],
            crate_types: ["staticlib", "cdylib", "rlib"],
            name: "skill_repo_tracker_lib",
            src_path: `${crateRoot}/src/lib.rs`,
            test: true,
            doctest: true,
          },
          {
            kind: ["bin"],
            crate_types: ["bin"],
            name: "skill-repo-tracker",
            src_path: `${crateRoot}/src/main.rs`,
            test: true,
            doctest: false,
          },
          {
            kind: ["custom-build"],
            crate_types: ["bin"],
            name: "build-script-build",
            src_path: `${crateRoot}/build.rs`,
            test: false,
            doctest: false,
          },
        ],
      },
    ],
    workspace_root: crateRoot,
    workspace_members: [packageId],
    workspace_default_members: [packageId],
  };
  assert.deepEqual(validateCargoMetadataPolicy(valid, repositoryRoot), []);

  const escaped = structuredClone(valid);
  escaped.packages[0].targets[0].src_path = `${crateRoot}/src/alternate.rs`;
  escaped.packages[0].targets[2].src_path = `${crateRoot}/other-build.rs`;
  escaped.packages[0].targets.push({
    kind: ["test"],
    crate_types: ["bin"],
    name: "schema",
    src_path: `${crateRoot}/tests/empty.rs`,
    test: true,
    doctest: false,
  });
  escaped.packages[0].dependencies.push({ name: "evil", source: null });
  assert.deepEqual(validateCargoMetadataPolicy(escaped, repositoryRoot), [
    "Cargo metadata contains local path dependencies: evil",
    "Cargo targets must remain the exact governed src/lib.rs, src/main.rs, and build.rs entrypoints",
  ]);
});
