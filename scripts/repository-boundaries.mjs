import { isAlternateTauriConfigPath } from "./core-policy-contracts.mjs";

const BUILD_TOOLS = ["@vitejs/plugin-react", "vite", "vitest", "typescript"];
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
const PRIVATE_PATHS = [
  /^AGENTS\.md$/,
  /^docs\/(?:internal|promo)(?:\/|$)/,
  /^assets\/brand(?:\/|$)/,
];
const GOVERNED_FRONTEND_PATH = /\.(?:ts|tsx|mts|cts|css)$/;
const GOVERNED_FRONTEND_TEST_JAVASCRIPT = /\.(?:test|spec)\.(?:js|jsx|mjs|cjs)$/;
const FRONTEND_DECLARATION_PATH = /^src\/.*\.d\.(?:ts|mts|cts)$/;
const CANONICAL_FRONTEND_DECLARATION_PATH = "src/vite-env.d.ts";
const CANONICAL_FRONTEND_DECLARATION = `/// <reference types="vite/client" />

interface Window {
  __TAURI_INTERNALS__?: unknown;
}
`;
const EXECUTABLE_JAVASCRIPT_TYPESCRIPT = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const GOVERNED_EXECUTABLE_ROOTS = ["src/", "scripts/", "e2e/"];
const GOVERNED_ROOT_EXECUTABLES = new Set([
  "playwright.config.ts",
  "vite.config.mjs",
  "vitest.config.ts",
]);

export function validateFrontendDeclarations(declarationContents) {
  const entries =
    declarationContents instanceof Map
      ? [...declarationContents.entries()]
      : Object.entries(declarationContents ?? {});
  const declarations = entries.filter(([pathname]) =>
    FRONTEND_DECLARATION_PATH.test(pathname),
  );
  const errors = [];
  const canonical = declarations.find(
    ([pathname]) => pathname === CANONICAL_FRONTEND_DECLARATION_PATH,
  );
  if (!canonical) {
    errors.push(
      `required frontend declaration is missing: ${CANONICAL_FRONTEND_DECLARATION_PATH}`,
    );
  }
  for (const [pathname] of declarations) {
    if (pathname !== CANONICAL_FRONTEND_DECLARATION_PATH) {
      errors.push(
        `frontend ambient declaration is forbidden; only ${CANONICAL_FRONTEND_DECLARATION_PATH} is allowed: ${pathname}`,
      );
    }
  }
  if (canonical) {
    const rawContents = canonical[1];
    const contents = Buffer.isBuffer(rawContents)
      ? rawContents.toString("utf8")
      : typeof rawContents === "string"
        ? rawContents
        : undefined;
    if (contents !== CANONICAL_FRONTEND_DECLARATION) {
      errors.push(
        "src/vite-env.d.ts must contain only the canonical vite/client reference and Window.__TAURI_INTERNALS__?: unknown declaration",
      );
    }
  }
  return errors.sort((left, right) => left.localeCompare(right));
}

export function validateVersions(versions) {
  const expected = versions.packageVersion;
  const labels = {
    lockRootVersion: "package-lock.json root version",
    lockPackageVersion: "package-lock.json packages[\"\"] version",
    cargoVersion: "src-tauri/Cargo.toml package version",
    cargoLockVersion: "src-tauri/Cargo.lock package version",
    tauriVersion: "src-tauri/tauri.conf.json version",
  };

  const errors = Object.entries(labels).flatMap(([key, label]) =>
    versions[key] === expected
      ? []
      : [`${label} is ${versions[key] ?? "missing"}; expected ${expected}`],
  );
  for (const [key, label] of [
    ["lockRootName", "package-lock.json root name"],
    ["lockPackageName", "package-lock.json packages[\"\"] name"],
  ]) {
    if (versions[key] !== versions.packageName) {
      errors.push(
        `${label} is ${versions[key] ?? "missing"}; expected ${versions.packageName ?? "missing"}`,
      );
    }
  }
  return errors;
}

export function validateRuntimeToolchain({ nodeVersion, npmVersion }) {
  const errors = [];
  if (nodeVersion !== "v22.23.1") {
    errors.push(`running Node is ${nodeVersion}; expected v22.23.1`);
  }
  if (npmVersion !== "10.9.8") {
    errors.push(`running npm is ${npmVersion}; expected 10.9.8`);
  }
  return errors;
}

export function validateCriticalPackageScripts(scripts) {
  const errors = Object.entries(CRITICAL_PACKAGE_SCRIPTS).flatMap(([name, expected]) => {
    const actual = scripts?.[name];
    return actual === expected
      ? []
      : [`critical package script ${name} is ${actual ?? "missing"}; expected ${expected}`];
  });
  for (const name of Object.keys(CRITICAL_PACKAGE_SCRIPTS)) {
    for (const hook of [`pre${name}`, `post${name}`]) {
      if (Object.hasOwn(scripts ?? {}, hook)) {
        errors.push(`critical package script lifecycle hook is forbidden: ${hook}`);
      }
    }
  }
  for (const hook of [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
  ]) {
    if (Object.hasOwn(scripts ?? {}, hook)) {
      errors.push(`package install lifecycle hook is forbidden: ${hook}`);
    }
  }
  return errors;
}

export function checkRepositoryBoundaries({
  trackedFiles,
  trackedEntries = [],
  repositoryFiles = trackedFiles,
  packageJson,
  lockUrls,
  lockPackages = {},
}) {
  const errors = findDangerousRepositoryPathErrors(repositoryFiles);
  for (const entry of trackedEntries) {
    if (!["100644", "100755"].includes(entry.mode)) {
      errors.push(
        `tracked path must be a regular file, not mode ${entry.mode}: ${entry.path}`,
      );
    }
  }
  for (const path of trackedFiles) {
    if (PRIVATE_PATHS.some((pattern) => pattern.test(path))) {
      errors.push(`private file is tracked: ${path}`);
    }
    if (
      path === ".npmrc" ||
      path === "rust-toolchain" ||
      /(?:^|\/)\.cargo(?:\/|$)/.test(path)
    ) {
      errors.push(
        `repository-local toolchain override is forbidden because it can bypass deterministic gates: ${path}`,
      );
    }
    if (/(?:^|\/)npm-shrinkwrap\.json$/.test(path)) {
      errors.push(`tracked npm-shrinkwrap.json is forbidden because it overrides package-lock.json: ${path}`);
    }
    if (path.startsWith("public/")) {
      errors.push(
        `Vite public directory is forbidden; production assets must enter a governed source inventory: ${path}`,
      );
    }
    if (
      FRONTEND_DECLARATION_PATH.test(path) &&
      path !== CANONICAL_FRONTEND_DECLARATION_PATH
    ) {
      errors.push(
        `frontend ambient declaration is forbidden; only ${CANONICAL_FRONTEND_DECLARATION_PATH} is allowed: ${path}`,
      );
    }
    if (
      /(?:^|\/)(?:postcss\.config\.(?:js|cjs|mjs|ts|cts|mts)|\.postcssrc(?:\.(?:json|yaml|yml|js|cjs|mjs|ts|cts|mts))?)$/.test(path)
    ) {
      errors.push(
        `external PostCSS config is forbidden because Vite uses an exact inline plugin inventory: ${path}`,
      );
    }
    if (path.startsWith("scripts/") && !path.endsWith(".mjs")) {
      errors.push(
        `unregistered governance script type is forbidden; executable tooling must remain in the audited .mjs graph: ${path}`,
      );
    }
    if (
      path.startsWith("src/") &&
      !GOVERNED_FRONTEND_PATH.test(path) &&
      !GOVERNED_FRONTEND_TEST_JAVASCRIPT.test(path)
    ) {
      errors.push(`unregistered frontend source or asset type is forbidden: ${path}`);
    }
    if (
      EXECUTABLE_JAVASCRIPT_TYPESCRIPT.test(path) &&
      !GOVERNED_EXECUTABLE_ROOTS.some((root) => path.startsWith(root)) &&
      !GOVERNED_ROOT_EXECUTABLES.has(path)
    ) {
      errors.push(`executable JavaScript/TypeScript is outside governed roots: ${path}`);
    }
    if (/^vitest\.(?:workspace|projects)(?:\.|$)/.test(path)) {
      errors.push(
        `Vitest workspace/projects config is forbidden because it can replace governed test discovery: ${path}`,
      );
    }
    if (/^vite\.config\./.test(path) && path !== "vite.config.mjs") {
      errors.push(`alternate Vite config is forbidden; keep the exact vite.config.mjs: ${path}`);
    }
    if (/^playwright\.config\./.test(path) && path !== "playwright.config.ts") {
      errors.push(
        `alternate Playwright config is forbidden; keep the exact playwright.config.ts: ${path}`,
      );
    }
    if (isAlternateTauriConfigPath(path)) {
      errors.push(
        `alternate Tauri config is forbidden; keep src-tauri/tauri.conf.json as the only effective config: ${path}`,
      );
    }
  }

  for (const tool of BUILD_TOOLS) {
    if (packageJson.dependencies?.[tool]) {
      errors.push(`build tool must be in devDependencies: ${tool}`);
    }
  }

  for (const url of lockUrls) {
    if (!url.startsWith("https://registry.npmjs.org/")) {
      errors.push(`package-lock contains a non-official registry URL: ${url}`);
    }
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      if (/^(?:file|link|workspace):/.test(specifier)) {
        errors.push(`${section} contains a local package outside governed src/: ${name}=${specifier}`);
      }
    }
  }
  if (packageJson.workspaces != null) {
    errors.push(
      "package.json workspaces are forbidden until every workspace source root is governed",
    );
  }
  if (Object.hasOwn(packageJson, "postcss")) {
    errors.push(
      "package.json postcss config is forbidden because Vite uses an exact inline plugin inventory",
    );
  }
  if (lockPackages[""]?.workspaces != null) {
    errors.push(
      "package-lock.json root workspaces are forbidden until every workspace source root is governed",
    );
  }
  for (const [path, metadata] of Object.entries(lockPackages)) {
    if (
      path !== "" &&
      (metadata?.link === true || /^(?:file|link):/.test(metadata?.resolved ?? ""))
    ) {
      errors.push(`package-lock contains a local linked package outside governed src/: ${path}`);
    }
  }
  if (packageJson.imports != null) {
    errors.push(
      "package.json imports aliases are forbidden; repository-relative module paths keep the governed graph auditable",
    );
  }
  errors.push(...validateCriticalPackageScripts(packageJson.scripts));
  return errors;
}

export function findDangerousRepositoryPathErrors(paths) {
  return [...new Set(paths ?? [])]
    .filter(
      (pathname) =>
        typeof pathname !== "string" || /[\u0000-\u001f\u007f\\]/u.test(pathname),
    )
    .map(
      (pathname) =>
        `repository path contains dangerous filename characters: ${JSON.stringify(pathname)}`,
    )
    .sort((left, right) => left.localeCompare(right));
}
