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
  "test:coverage": "vitest run --coverage --no-file-parallelism",
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

const CHECKOUT_NODE24_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_NODE24_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const WORKFLOW_PATHS = [
  ".github/workflows/ci.yml",
  ".github/workflows/release-gate.yml",
  ".github/workflows/security-audit.yml",
  ".github/workflows/trusted-policy.yml",
  ".github/workflows/weekly-resilience.yml",
];

test("every GitHub workflow pins the approved Node 24-native actions", () => {
  for (const path of WORKFLOW_PATHS) {
    const contents = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const workflow = parseYaml(contents, { uniqueKeys: true });
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (String(step.uses ?? "").startsWith("actions/checkout@")) {
          assert.equal(step.uses, `actions/checkout@${CHECKOUT_NODE24_SHA}`, path);
        }
        if (String(step.uses ?? "").startsWith("actions/setup-node@")) {
          assert.equal(step.uses, `actions/setup-node@${SETUP_NODE_NODE24_SHA}`, path);
        }
      }
    }
  }
});

test("release workflow is manual, read-only, approved, and runs on Apple Silicon", () => {
  const valid = readFileSync(
    new URL("../../.github/workflows/release-gate.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(valid, /RELEASE_MANIFEST:\s*\$\{\{\s*inputs\.releaseManifest\s*\}\}/);
  assert.match(valid, /GITHUB_EVENT_PATH/);
  assert.match(valid, /::add-mask::/);
  assert.match(valid, /umask 077/);
  assert.match(valid, /chmod 600/);
  assert.doesNotMatch(valid, /name: Prepare and mask release manifest/);
  assert.doesNotMatch(valid, /RELEASE_MANIFEST_FILE|GITHUB_ENV/);
  assert.match(valid, /trap 'rm -f "\$manifest_file"' EXIT/);
  assert.match(valid, /npm run --silent release:verify/);
  assert.deepEqual(validateReleaseWorkflowPolicy(valid), []);
  assert.match(valid, /npm ci --ignore-scripts --registry=https:\/\/registry\.npmjs\.org/);
  assert.match(
    validateReleaseWorkflowPolicy(valid.replace("npm ci --ignore-scripts", "npm ci"))[0],
    /complete fail-closed template/,
  );

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
      "      - name: Run the explicit release verification lane\n        run: |",
      "      - name: Run the explicit release verification lane\n        continue-on-error: true\n        run: |",
    ),
    valid.replace(
      "      - name: Run the explicit release verification lane\n        run: |",
      "      - name: Run the explicit release verification lane\n        if: always()\n        run: |",
    ),
    valid.replace(
      "      - name: Run the explicit release verification lane\n        run: |",
      "      - name: Run the explicit release verification lane\n        shell: bash\n        run: |",
    ),
    valid.replace("    runs-on: macos-15", "    if: always()\n    runs-on: macos-15"),
    valid.replace(
      "    runs-on: macos-15",
      "    continue-on-error: true\n    runs-on: macos-15",
    ),
    valid.replace(
      '          npm run --silent release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$manifest_token"',
      '          npm run --silent release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$manifest_token"\n      - run: npm run --silent release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$manifest_token"',
    ),
    valid.replace(
      '          npm run --silent release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$manifest_token"',
      '          npm run --silent release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$manifest_token" || true',
    ),
    valid.replace("npm run --silent release:verify", "npm run release:verify"),
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
    valid.replace("          printf '::add-mask::%s\\n' \"$manifest_token\"\n", ""),
    valid.replace("          trap 'rm -f \"$manifest_file\"' EXIT\n", ""),
    valid.replace("          umask 077\n", ""),
    valid.replace("          chmod 600 \"$manifest_file\"", "          chmod 644 \"$manifest_file\""),
    valid.replace(
      "      RELEASE_PHASE: ${{ inputs.phase }}",
      "      RELEASE_PHASE: ${{ inputs.phase }}\n      RELEASE_MANIFEST: ${{ inputs.releaseManifest }}",
    ),
    valid.replace(
      "      - name: Reject tracked dependency and Cargo overrides",
      "      - name: Bypass tracked dependency and Cargo overrides",
    ),
  ]) {
    assert.ok(
      validateReleaseWorkflowPolicy(mutation).some((error) =>
        error.includes("release workflow must match the complete fail-closed template"),
      ),
    );
  }
});

test("the testing Rule is the only document containing operator release commands", () => {
  const rule = readFileSync(
    new URL("../../docs/rules/testing-release.md", import.meta.url),
    "utf8",
  );
  assert.match(rule, /npm run release:verify -- --lane adhoc/);
  assert.match(rule, /--manifest-token "\$RELEASE_MANIFEST_TOKEN"/);
  assert.doesNotMatch(rule, /unset RELEASE_MANIFEST_TOKEN/);

  for (const path of ["../../README.md", "../../docs/macos-release-checklist.md"]) {
    const contents = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(contents, /docs\/rules\/testing-release\.md|rules\/testing-release\.md/);
    assert.doesNotMatch(contents, /release:verify|--manifest-token|RELEASE_MANIFEST_TOKEN/);
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
    [
      "remove pull request trigger",
      valid.replace(
        "  pull_request:\n    types: [opened, reopened, synchronize, edited]\n",
        "",
      ),
    ],
    [
      "remove PR metadata edit trigger",
      valid.replace(", edited]", "]"),
    ],
    ["rename required job", valid.replace("  verify:\n    name: verify", "  verify-renamed:\n    name: verify")],
    [
      "run PR evidence before its npm dependencies exist",
      valid.replace(
        "      - name: Install npm dependencies from the official registry\n        run: npm ci --registry=https://registry.npmjs.org\n      - name: Enforce PR learning evidence",
        "      - name: Enforce PR learning evidence",
      ).replace(
        "      - name: Set up pinned Rust",
        "      - name: Install npm dependencies from the official registry\n        run: npm ci --ignore-scripts --registry=https://registry.npmjs.org\n      - name: Set up pinned Rust",
      ),
    ],
    [
      "remove the executor override preflight",
      valid.replace(
        /      - name: Reject repository-local toolchain overrides\n        run: \|\n(?:          .*\n){7}/,
        "",
      ),
    ],
    [
      "remove the tracked dependency override preflight",
      valid.replace(
        "      - name: Reject tracked dependency and Cargo overrides",
        "      - name: Bypass tracked dependency and Cargo overrides",
      ),
    ],
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

test("trusted policy workflow is an exact base-only machine contract", () => {
  const valid = readFileSync(
    new URL("../../.github/workflows/trusted-policy.yml", import.meta.url),
    "utf8",
  );
  assert.match(valid, /package-manager-cache: false/);
  assert.deepEqual(validateTrustedPolicyWorkflowPolicy(valid), []);

  for (const [label, mutation] of [
    ["extra privileged job", `${valid}\n  unsafe:\n    permissions: { contents: write }\n    runs-on: ubuntu-latest\n    steps: [{ run: true }]\n`],
    ["job permission override", valid.replace("    runs-on: ubuntu-latest", "    permissions: { contents: write }\n    runs-on: ubuntu-latest")],
    ["checkout PR head", valid.replace("github.event.pull_request.base.sha", "github.event.pull_request.head.sha")],
    ["execute another command", valid.replace("        run: node scripts/trusted-policy-guard.mjs", "        run: node scripts/trusted-policy-guard.mjs\n      - run: true")],
    ["remove edited trigger", valid.replace(", edited,", ",")],
    ["restore Checks API write access", valid.replace("  pull-requests: read", "  pull-requests: read\n  checks: write")],
    ["rename the native required job", valid.replace("    name: Trusted policy / guard", "    name: dispatch")],
    ["restore implicit package-manager caching", valid.replace("          package-manager-cache: false\n", "")],
  ]) {
    assert.ok(
      validateTrustedPolicyWorkflowPolicy(mutation).includes(
        "trusted policy workflow must match the complete fail-closed template",
      ),
      label,
    );
  }
  assert.match(
    validateTrustedPolicyWorkflowPolicy("jobs: [")[0],
    /trusted policy workflow is invalid YAML/,
  );
});

test("security audit workflow keeps registry and Cargo audits fail-closed and scheduled", () => {
  const valid = readFileSync(
    new URL("../../.github/workflows/security-audit.yml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(validateSecurityAuditWorkflowPolicy(valid), []);

  for (const [label, mutation] of [
    [
      "remove tracked dependency override preflight",
      valid.replace(
        "      - name: Reject tracked dependency and Cargo overrides",
        "      - name: Bypass tracked dependency and Cargo overrides",
      ),
    ],
    [
      "replace npm audit with true",
      valid.replace(
        "run: npm audit --audit-level=high --registry=https://registry.npmjs.org",
        "run: true",
      ),
    ],
    [
      "mask dependency risk audit failure",
      valid.replace(
        "run: node scripts/dependency-risk.mjs audit",
        "run: node scripts/dependency-risk.mjs audit || true",
      ),
    ],
    [
      "bypass the ledger with raw cargo audit",
      valid.replace(
        "run: node scripts/dependency-risk.mjs audit",
        "run: cargo audit --file src-tauri/Cargo.lock",
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
  assert.match(valid, /run: node scripts\/test-waivers\.mjs/);
  assert.deepEqual(validateWeeklyResilienceWorkflowPolicy(valid), []);

  for (const [label, mutation] of [
    [
      "remove tracked dependency override preflight",
      valid.replace(
        "      - name: Reject tracked dependency and Cargo overrides",
        "      - name: Bypass tracked dependency and Cargo overrides",
      ),
    ],
    ["replace repeated Vitest with true", valid.replace("            npm test", "            true")],
    [
      "remove tracked waiver freshness check",
      valid.replace("run: node scripts/test-waivers.mjs", "run: true"),
    ],
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

test("every dependency-consuming workflow rejects shrinkwrap and nested Cargo config first", () => {
  for (const [path, validator, expectedPreflights] of [
    ["../../.github/workflows/ci.yml", validateCiWorkflowPolicy, 3],
    ["../../.github/workflows/release-gate.yml", validateReleaseWorkflowPolicy, 1],
    ["../../.github/workflows/security-audit.yml", validateSecurityAuditWorkflowPolicy, 1],
    ["../../.github/workflows/weekly-resilience.yml", validateWeeklyResilienceWorkflowPolicy, 1],
  ]) {
    const contents = readFileSync(new URL(path, import.meta.url), "utf8");
    const workflow = parseYaml(contents, { uniqueKeys: true });
    let preflights = 0;
    for (const job of Object.values(workflow.jobs)) {
      const steps = job.steps ?? [];
      const preflight = steps.findIndex(
        (step) => step.name === "Reject tracked dependency and Cargo overrides",
      );
      const consumers = steps.flatMap((step, index) =>
        String(step.uses ?? "").startsWith("actions/setup-node@") ||
        /(?:^|\s)(?:npm|cargo|tauri)\s/m.test(step.run ?? "")
          ? [index]
          : [],
      );
      if (consumers.length === 0) continue;
      preflights += 1;
      assert.ok(preflight >= 0 && consumers.every((index) => preflight < index), path);
    }
    assert.equal(preflights, expectedPreflights, path);
    for (const mutation of [
      contents.replace("git ls-files -z", "git ls-files"),
      contents.replace(".npmrc|rust-toolchain|", ".npmrc|"),
      contents.replace("npm-shrinkwrap.json|*/npm-shrinkwrap.json|", ""),
      contents.replace("|*/.cargo|*/.cargo/*", ""),
    ]) {
      assert.ok(validator(mutation).length > 0, path);
    }
  }
});

test("repository automation policy requires scheduled workflows and bounded weekly dependency updates", () => {
  const workflowPaths = WORKFLOW_PATHS;
  const dependabot = `
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: cargo
    directory: /src-tauri
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 2
    labels: [dependencies, ci]
    groups:
      minor-and-patch:
        patterns: ["*"]
        update-types: [minor, patch]
    ignore:
      - dependency-name: "*"
        update-types: [version-update:semver-major]
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
  assert.ok(errors.some((error) => error.includes("github-actions / weekly")));
  assert.deepEqual(
    validateRepositoryAutomationPolicy({
      workflowPaths: [...workflowPaths, ".github/workflows/backdoor.yml"],
      dependabotContents: dependabot,
    }),
    ["unregistered automation file is forbidden: .github/workflows/backdoor.yml"],
  );

  const actualDependabot = readFileSync(
    new URL("../../.github/dependabot.yml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    validateRepositoryAutomationPolicy({ workflowPaths, dependabotContents: actualDependabot }),
    [],
  );
  for (const mutation of [
    dependabot.replace("open-pull-requests-limit: 2", "open-pull-requests-limit: 3"),
    dependabot.replace("labels: [dependencies, ci]", "labels: [dependencies]"),
    dependabot.replace("update-types: [minor, patch]", "update-types: [major, minor, patch]"),
    dependabot.replace(
      "        update-types: [version-update:semver-major]\n",
      "",
    ),
  ]) {
    assert.ok(
      validateRepositoryAutomationPolicy({ workflowPaths, dependabotContents: mutation }).some(
        (error) => error.includes("github-actions / weekly"),
      ),
    );
  }
});
