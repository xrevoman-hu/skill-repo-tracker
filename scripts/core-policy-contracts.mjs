import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { TRACKED_DEPENDENCY_OVERRIDE_STEP } from "./workflow-policy-contracts.mjs";
import { policyRemovalPhase } from "./governance-policy-removal.mjs";

export {
  validateReleaseWorkflowPolicy,
  validateSecurityAuditWorkflowPolicy,
  validateWeeklyResilienceWorkflowPolicy,
} from "./workflow-policy-contracts.mjs";

const EXPECTED_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    useDefineForClassFields: true,
    lib: ["DOM", "DOM.Iterable", "ES2022"],
    allowJs: false,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: true,
    forceConsistentCasingInFileNames: true,
    module: "ESNext",
    moduleResolution: "Node",
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
    jsx: "react-jsx",
  },
  include: ["src"],
  references: [],
};

const EXPECTED_VITEST_CONFIG = `import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    maxWorkers: 2,
    setupFiles: ["./src/testSetup.ts"],
    css: false,
    exclude: [...configDefaults.exclude, "scripts/__tests__/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/frontend",
      reporter: ["text", "json-summary", "json", "lcov"],
      include: ["src/**/*.{ts,tsx,mts,cts}"],
      exclude: [
        "src/**/*.test.{ts,tsx,mts,cts}",
        "src/**/*.d.{ts,mts,cts}",
        "src/testSetup.ts",
      ],
    },
  },
});`;

const EXPECTED_VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { SAFARI_15_OBJECT_HAS_OWN_BANNER } from "./scripts/browser-compatibility-contract.mjs";

export default defineConfig({
  build: {
    target: "safari15",
    cssTarget: "safari15",
    sourcemap: false,
    rolldownOptions: {
      output: { postBanner: SAFARI_15_OBJECT_HAS_OWN_BANNER },
    },
  },
  clearScreen: false,
  publicDir: false,
  css: {
    postcss: { plugins: [] },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react()],
});`;

const EXPECTED_INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Skill Repo Tracker</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

const EXPECTED_PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});`;

const TOOLCHAIN_OVERRIDE_STEP = {
  name: "Reject repository-local toolchain overrides",
  run: 'set -euo pipefail\nfor path in .npmrc .cargo rust-toolchain; do\n  if [[ -e "$path" || -L "$path" ]]; then\n    echo "forbidden repository-local toolchain override: $path" >&2\n    exit 1\n  fi\ndone\n',
};

const MAIN_BASELINE_ENV = {
  VERIFY_BASE_REF: "${{ needs.baseline.outputs.validated_base }}",
  ARCHITECTURE_BASE_REF: "${{ needs.baseline.outputs.validated_base }}",
  COVERAGE_BASE_REF: "${{ needs.baseline.outputs.validated_base }}",
};
const MAIN_BASELINE_STEP = {
  name: "Validate the shared cumulative baseline",
  run: 'set -euo pipefail\ntest "$GITHUB_EVENT_NAME" = push\ntest "$GITHUB_REF" = refs/heads/main\n'
    + '[[ "$PUSH_BEFORE" =~ ^[0-9a-f]{40}$ ]]\ntest "$PUSH_BEFORE" != 0000000000000000000000000000000000000000\n'
    + '[[ "$VERIFY_BASE_REF" =~ ^[0-9a-f]{40}$ ]]\ntest "$VERIFY_BASE_REF" != 0000000000000000000000000000000000000000\n'
    + 'test "$VERIFY_BASE_REF" != "$GITHUB_SHA"\ntest "$VERIFY_BASE_REF" = "$ARCHITECTURE_BASE_REF"\n'
    + 'test "$VERIFY_BASE_REF" = "$COVERAGE_BASE_REF"\ngit cat-file -e "${VERIFY_BASE_REF}^{commit}"\n'
    + 'git merge-base --is-ancestor "$VERIFY_BASE_REF" "$PUSH_BEFORE"\ngit merge-base --is-ancestor "$PUSH_BEFORE" "$GITHUB_SHA"\n',
};

const EXPECTED_CI_WORKFLOW = {
  name: "CI",
  on: {
    push: { branches: ["main"] },
  },
  permissions: { contents: "read" },
  concurrency: {
    group: "ci-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": false,
  },
  env: {
    NODE_VERSION: "22.23.1",
    PUSH_BEFORE: "${{ github.event.before }}",
  },
  jobs: {
    baseline: {
      name: "baseline", "runs-on": "ubuntu-latest", "timeout-minutes": 10,
      permissions: { contents: "read", actions: "read" },
      outputs: { validated_base: "${{ steps.resolve.outputs.validated_base }}" },
      steps: [
        { name: "Checkout full history", uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "fetch-depth": 0, "persist-credentials": false } },
        { name: "Set up pinned Node.js without package cache",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "${{ env.NODE_VERSION }}", "package-manager-cache": false } },
        { name: "Resolve the cumulative successful main ancestor", id: "resolve",
          env: { GH_TOKEN: "${{ github.token }}" }, run: "node scripts/main-push-evidence.mjs baseline" },
      ],
    },
    verify: {
      name: "verify",
      needs: "baseline",
      env: MAIN_BASELINE_ENV,
      "runs-on": "macos-15",
      "timeout-minutes": 45,
      steps: [
        {
          name: "Checkout full history",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "fetch-depth": 0, "persist-credentials": false },
        },
        MAIN_BASELINE_STEP,
        TRACKED_DEPENDENCY_OVERRIDE_STEP,
        TOOLCHAIN_OVERRIDE_STEP,
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "${{ env.NODE_VERSION }}", cache: "npm" },
        },
        {
          name: "Install npm dependencies from the official registry",
          run: "npm ci --ignore-scripts --registry=https://registry.npmjs.org",
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal --component clippy,rustfmt\nrustup default 1.95.0\n",
        },
        {
          name: "Validate gate invocation before npm lifecycle execution",
          run: "node scripts/governance.mjs boundaries",
        },
        { name: "Install pinned Chromium", run: "npx playwright install chromium" },
        { name: "Run the deterministic repository gate", run: "npm run verify" },
        {
          name: "Run browser acceptance with DemoAppService",
          run: "npm run test:e2e",
        },
      ],
    },
    coverage: {
      name: "coverage",
      needs: "baseline",
      env: MAIN_BASELINE_ENV,
      "runs-on": "macos-15",
      "timeout-minutes": 60,
      steps: [
        {
          name: "Checkout full history",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "fetch-depth": 0, "persist-credentials": false },
        },
        MAIN_BASELINE_STEP,
        TRACKED_DEPENDENCY_OVERRIDE_STEP,
        TOOLCHAIN_OVERRIDE_STEP,
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "${{ env.NODE_VERSION }}", cache: "npm" },
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal\nrustup toolchain install nightly-2026-08-01 --profile minimal --component llvm-tools-preview\nrustup default 1.95.0\n",
        },
        {
          name: "Install npm dependencies from the official registry",
          run: "npm ci --ignore-scripts --registry=https://registry.npmjs.org",
        },
        {
          name: "Validate gate invocation before npm lifecycle execution",
          run: "node scripts/governance.mjs boundaries",
        },
        {
          name: "Install pinned cargo-llvm-cov",
          run: "cargo install cargo-llvm-cov --locked --version 0.9.0",
        },
        { name: "Enforce frontend and Rust coverage", run: "npm run coverage:check" },
      ],
    },
    msrv: {
      name: "msrv",
      needs: "baseline",
      env: MAIN_BASELINE_ENV,
      "runs-on": "macos-15",
      "timeout-minutes": 35,
      steps: [
        {
          name: "Checkout",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "fetch-depth": 0, "persist-credentials": false },
        },
        MAIN_BASELINE_STEP,
        TRACKED_DEPENDENCY_OVERRIDE_STEP,
        TOOLCHAIN_OVERRIDE_STEP,
        {
          name: "Set up Node.js for native preparation",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "${{ env.NODE_VERSION }}", "package-manager-cache": false },
        },
        {
          name: "Install the declared minimum Rust version",
          run: "rustup toolchain install 1.88.0 --profile minimal",
        },
        {
          name: "Compile every target at MSRV",
          run: "node scripts/native-command.mjs check-msrv",
        },
      ],
    },
  },
};

const EXPECTED_GITHUB_ACTIONS_DEPENDABOT_ENTRY = {
  "package-ecosystem": "github-actions",
  directory: "/",
  schedule: { interval: "weekly", day: "monday" },
  "open-pull-requests-limit": 0,
  labels: ["dependencies", "ci"],
  groups: {
    "minor-and-patch": {
      patterns: ["*"],
      "update-types": ["minor", "patch"],
    },
  },
  ignore: [
    {
      "dependency-name": "*",
      "update-types": ["version-update:semver-major"],
    },
  ],
};

function validateExactWorkflowPolicy(contents, label, expectedWorkflow) {
  let workflow;
  try {
    workflow = parseYaml(contents, { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    return [
      `${label} workflow is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return isDeepStrictEqual(workflow, expectedWorkflow)
    ? []
    : [`${label} workflow must match the complete fail-closed template`];
}

export function validateTypeScriptConfigPolicy(config) {
  return isDeepStrictEqual(config, EXPECTED_TSCONFIG)
    ? []
    : ["tsconfig.json must match the complete strict production discovery contract"];
}

export function validateVitestConfigPolicy(contents) {
  return contents.trim() === EXPECTED_VITEST_CONFIG.trim()
    ? []
    : ["vitest.config.ts must match the complete test and coverage discovery contract"];
}

export function validateViteConfigPolicy(contents) {
  return contents.trim() === EXPECTED_VITE_CONFIG.trim()
    ? []
    : ["vite.config.mjs must match the complete governed production build contract"];
}

export function validateIndexHtmlPolicy(contents) {
  return contents.trim() === EXPECTED_INDEX_HTML.trim()
    ? []
    : ["index.html must match the exact governed Vite entrypoint"];
}

export function validatePlaywrightConfigPolicy(contents) {
  return contents.trim() === EXPECTED_PLAYWRIGHT_CONFIG.trim()
    ? []
    : ["playwright.config.ts must match the complete DemoAppService E2E discovery contract"];
}

export function validateCargoTestDiscoveryPolicy(contents) {
  const errors = [];
  if (/^\s*autotests\s*=\s*false\s*(?:#.*)?$/m.test(contents)) {
    errors.push("src-tauri/Cargo.toml cannot disable automatic test discovery");
  }
  if (/^\s*(?:test|harness)\s*=\s*false\s*(?:#.*)?$/m.test(contents)) {
    errors.push("src-tauri/Cargo.toml cannot disable a Cargo test target or harness");
  }
  if (/^\s*\[(?:workspace(?:\.|\])|patch\.|replace\])/m.test(contents)) {
    errors.push(
      "src-tauri/Cargo.toml cannot add workspaces, patches, or replacements outside the governed crate",
    );
  }
  if (/^\s*path\s*=|\{[^}\n]*\bpath\s*=/m.test(contents)) {
    errors.push(
      "src-tauri/Cargo.toml cannot add local path dependencies outside the governed crate",
    );
  }
  if (/^\s*\[lints(?:\.|\])|^\s*lints(?:\.|\s*=)/m.test(contents)) {
    errors.push(
      "src-tauri/Cargo.toml cannot override Rust or Clippy lint levels; command-line -D warnings is authoritative",
    );
  }
  return errors;
}

export function validateCargoMetadataPolicy(metadata, repositoryRoot) {
  const crateRoot = resolve(repositoryRoot, "src-tauri");
  const packageEntry = Array.isArray(metadata?.packages) && metadata.packages.length === 1
    ? metadata.packages[0]
    : undefined;
  const errors = [];
  if (!packageEntry || packageEntry.name !== "skill-repo-tracker") {
    errors.push("Cargo metadata must contain exactly the governed skill-repo-tracker package");
    return errors;
  }
  if (
    resolve(metadata.workspace_root ?? "") !== crateRoot ||
    metadata.workspace_members?.length !== 1 ||
    metadata.workspace_default_members?.length !== 1 ||
    metadata.workspace_members[0] !== packageEntry.id ||
    metadata.workspace_default_members[0] !== packageEntry.id
  ) {
    errors.push("Cargo workspace metadata must resolve only the governed src-tauri crate");
  }
  if (resolve(packageEntry.manifest_path ?? "") !== resolve(crateRoot, "Cargo.toml")) {
    errors.push("Cargo package manifest must remain src-tauri/Cargo.toml");
  }
  const localDependencies = (packageEntry.dependencies ?? [])
    .filter((dependency) => dependency.source == null)
    .map((dependency) => dependency.name)
    .sort();
  if (localDependencies.length > 0) {
    errors.push(`Cargo metadata contains local path dependencies: ${localDependencies.join(", ")}`);
  }
  const actualTargets = (packageEntry.targets ?? [])
    .map((target) => ({
      kind: [...(target.kind ?? [])].sort(),
      crateTypes: [...(target.crate_types ?? [])].sort(),
      name: target.name,
      path: resolve(target.src_path ?? ""),
      test: target.test,
      doctest: target.doctest,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expectedTargets = [
    {
      kind: ["custom-build"],
      crateTypes: ["bin"],
      name: "build-script-build",
      path: resolve(crateRoot, "build.rs"),
      test: false,
      doctest: false,
    },
    {
      kind: ["bin"],
      crateTypes: ["bin"],
      name: "skill-repo-tracker",
      path: resolve(crateRoot, "src/main.rs"),
      test: true,
      doctest: false,
    },
    {
      kind: ["cdylib", "rlib", "staticlib"],
      crateTypes: ["cdylib", "rlib", "staticlib"],
      name: "skill_repo_tracker_lib",
      path: resolve(crateRoot, "src/lib.rs"),
      test: true,
      doctest: true,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (!isDeepStrictEqual(actualTargets, expectedTargets)) {
    errors.push(
      "Cargo targets must remain the exact governed src/lib.rs, src/main.rs, and build.rs entrypoints",
    );
  }
  return errors;
}

export function isAlternateTauriConfigPath(path) {
  if (path === "src-tauri/tauri.conf.json") return false;
  return /^src-tauri\/(?:tauri(?:\.[^/]+)?\.conf\.(?:json|json5|toml)|Tauri(?:\.[^/]+)?\.toml)$/i.test(
    path,
  );
}

export function validateTauriBuildScriptPolicy(contents) {
  // ADR 0010: exact native integrity checks followed by the existing Tauri build.
  const reviewed = "fd51a39260793bd4c4c13cdc6e803b67d65bfa6103eb7dbebd51a1d967f5fd55";
  return createHash("sha256").update(contents).digest("hex") === reviewed
    ? []
    : ["src-tauri/build.rs must remain the exact reviewed native/Tauri build contract"];
}

export function validateRepositoryAutomationPolicy({ workflowPaths, dependabotContents, catalog }) {
  const errors = [];
  let phase;
  try { phase = policyRemovalPhase(catalog); }
  catch { return ["automation requires a valid main-only policy phase"]; }
  const requiredAutomationPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/release-gate.yml",
    ".github/workflows/security-audit.yml",
    ".github/workflows/weekly-resilience.yml",
  ];
  if (phase === "retiring") requiredAutomationPaths.push(".github/workflows/trusted-policy.yml");
  for (const path of requiredAutomationPaths) {
    if (!workflowPaths.includes(path)) errors.push(`required automation file is missing: ${path}`);
  }
  const registeredPaths = new Set(requiredAutomationPaths);
  for (const path of workflowPaths) {
    if (!registeredPaths.has(path)) {
      errors.push(`unregistered automation file is forbidden: ${path}`);
    }
  }
  let dependabot;
  try {
    dependabot = parseYaml(dependabotContents ?? "", {
      maxAliasCount: 100,
      uniqueKeys: true,
    });
  } catch (error) {
    errors.push(
      `.github/dependabot.yml is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return errors;
  }
  if (dependabot?.version !== 2) {
    errors.push("Dependabot config version must be exactly 2");
  }
  const updates = Array.isArray(dependabot?.updates) ? dependabot.updates : [];
  if (!isDeepStrictEqual(Object.keys(dependabot ?? {}).sort(), ["updates", "version"])) {
    errors.push("Dependabot config has unsupported top-level fields");
  }
  for (const [ecosystem, directory, label, dependencyLabel] of [
    ["npm", "/", "npm / weekly", "javascript"],
    ["cargo", "/src-tauri", "cargo /src-tauri weekly", "rust"],
  ]) {
    const expected = { "package-ecosystem": ecosystem, directory,
      schedule: { interval: "weekly", day: "monday" }, "open-pull-requests-limit": 0,
      labels: ["dependencies", dependencyLabel] };
    const matches = updates.filter((entry) => isDeepStrictEqual(entry, expected));
    if (matches.length !== 1) errors.push(`Dependabot is missing ${label} updates with zero PR limit`);
  }
  if (updates.length !== 3) errors.push("Dependabot must contain exactly three registered ecosystems");
  const githubActionsEntries = updates.filter(
    (entry) => entry?.["package-ecosystem"] === "github-actions",
  );
  if (
    githubActionsEntries.length !== 1 ||
    !isDeepStrictEqual(githubActionsEntries[0], EXPECTED_GITHUB_ACTIONS_DEPENDABOT_ENTRY)
  ) {
    errors.push(
      "Dependabot github-actions / weekly updates must match the complete bounded minor-and-patch contract",
    );
  }
  return errors;
}

export function validateCiWorkflowPolicy(contents) {
  return validateExactWorkflowPolicy(contents, "CI", EXPECTED_CI_WORKFLOW);
}

// ADR 0010: this build-only native source can fetch and execute compiler tools.
// Keep the complete reviewed implementation pinned, alongside explicit negative tests.
export function validateCredentialNativeSourcePolicy(contents) {
  const expected = "d0dbdb76770f5ee044478fc72294cee44364290e3cce7c23b816d2e416d9fe34";
  return createHash("sha256").update(contents).digest("hex") === expected
    ? [] : ["native preparation must remain the exact reviewed pinned-source contract"];
}
