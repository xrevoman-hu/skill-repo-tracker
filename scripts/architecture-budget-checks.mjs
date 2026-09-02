import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  findUnsafeGitPathInventory,
  gitPathExistsAtRef,
  listRepositoryFiles,
} from "./git-paths.mjs";

import {
  checkCompressionBudget,
  checkToolingSnapshot,
  compareCompressionBudgets,
  compareToolingBudgets,
  fileCompressionMetrics,
  findOrphanToolingModules,
  findStaticTestRegistrationHazards,
  findForbiddenToolingTestImports,
  findToolingTestHelperHazards,
  isToolingModule,
  isToolingTestModule,
} from "./line-budgets.mjs";
import {
  findJavaScriptRunnerHelperHazards,
  findRustTestInventoryHazards,
  FIXED_RUST_TEST_CFG,
} from "./module-map-test-policy.mjs";
import {
  discoverProductionFiles,
  MODULE_MAP_PATH,
} from "./module-map.mjs";
import { findForbiddenTestModifiers } from "./test-evidence-policy.mjs";
import { canonicalCommandInvocations } from "./static-command-policy.mjs";

export const ARCHITECTURE_BUDGET_PATH = "docs/engineering/architecture-budget.json";

function validateHotspotAdr(path, hotSpot, validAdrs) {
  if ((hotSpot.status ?? "active") !== "active" || hotSpot.maxLines <= 1000) return [];
  if (!/^docs\/adr\/[^/]+\.md$/.test(hotSpot.adr ?? "")) {
    return [`${path} exceeds 1000 lines but does not reference a tracked ADR path`];
  }
  if (validAdrs && !validAdrs.has(hotSpot.adr)) {
    return [`${path} exceeds 1000 lines but its ADR is not an active catalog decision: ${hotSpot.adr}`];
  }
  return [];
}

function countLines(path) {
  const contents = readFileSync(path, "utf8");
  return contents === ""
    ? 0
    : contents.split(/\r?\n/).length - (contents.endsWith("\n") ? 1 : 0);
}

function repositoryToolingFiles(root) {
  return listRepositoryFiles(root, ["scripts"]).filter(isToolingModule);
}

function repositoryToolingTestFiles(root) {
  return listRepositoryFiles(root, ["scripts/__tests__"]).filter(isToolingTestModule);
}

function repositoryTrackedFiles(root) {
  return listRepositoryFiles(root);
}

export function discoverToolingEntrypointsFromPolicies({
  knownFiles,
  packageJson = {},
  verifyPlan = {},
  workflowSources = [],
}) {
  const commands = Object.values(packageJson.scripts ?? {}).filter(
    (value) => typeof value === "string",
  );
  for (const step of verifyPlan.steps ?? []) {
    if (typeof step.command === "string") {
      commands.push(
        [step.command, ...(step.args ?? []).filter((value) => typeof value === "string")].join(" "),
      );
    }
  }
  for (const source of workflowSources) {
    const workflow = parseYaml(source) ?? {};
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (typeof step?.run !== "string") continue;
        commands.push(
          step.run.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#")).join("\n"),
        );
      }
    }
  }
  const entrypoints = new Set();
  for (const command of commands) {
    for (const invocation of canonicalCommandInvocations(command)) {
      if (invocation[0] !== "node") continue;
      const candidates = invocation
        .slice(1)
        .filter((argument) => /^(?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.(?:mjs|js|cjs|mts|ts|cts)$/.test(argument));
      for (const candidate of candidates) {
        const pathname = candidate.replace(/^\.\//, "");
        if (knownFiles.has(pathname)) entrypoints.add(pathname);
      }
    }
  }
  return entrypoints;
}

function discoverToolingEntrypoints(root, knownFiles) {
  const readJson = (pathname) => JSON.parse(readFileSync(join(root, pathname), "utf8"));
  const workflowSources = repositoryTrackedFiles(root)
    .filter((pathname) => pathname.startsWith(".github/workflows/") && /\.ya?ml$/.test(pathname))
    .map((pathname) => readFileSync(join(root, pathname), "utf8"));
  return discoverToolingEntrypointsFromPolicies({
    knownFiles,
    packageJson: readJson("package.json"),
    verifyPlan: readJson("docs/engineering/verify-plan.json"),
    workflowSources,
  });
}

function isJavaScriptTestLike(pathname) {
  return /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(pathname);
}

export function expectedJavaScriptTestRunner(pathname) {
  if (/^scripts\/__tests__\/[^/]+\.test\.mjs$/.test(pathname)) return "node:test";
  if (pathname.startsWith("src/") && isJavaScriptTestLike(pathname)) return "vitest";
  if (pathname.startsWith("e2e/") && isJavaScriptTestLike(pathname)) return "playwright";
  return undefined;
}

export function checkRepositoryTestInventory(root, paths, testBudget) {
  const errors = [];
  const configuredCfg = [...(testBudget?.runner?.rustAllowedCfg ?? [])].sort();
  if (JSON.stringify(configuredCfg) !== JSON.stringify(FIXED_RUST_TEST_CFG)) {
    errors.push(
      `Rust test runner cfg budget must remain ${FIXED_RUST_TEST_CFG.join(", ")}`,
    );
  }
  for (const pathname of paths.filter(isJavaScriptTestLike)) {
    const runner = expectedJavaScriptTestRunner(pathname);
    if (!runner) {
      errors.push(`test-like JavaScript file is not reachable by a configured runner: ${pathname}`);
      continue;
    }
    const source = readFileSync(join(root, pathname), "utf8");
    errors.push(...findForbiddenTestModifiers(pathname, source));
    errors.push(...findStaticTestRegistrationHazards(pathname, source));
  }
  const javaScriptPaths = paths.filter((pathname) => /\.(?:[cm]?[jt]sx?)$/.test(pathname));
  errors.push(...findJavaScriptRunnerHelperHazards({
    paths: javaScriptPaths,
    sources: Object.fromEntries(javaScriptPaths.map((pathname) => [
      pathname,
      readFileSync(join(root, pathname), "utf8"),
    ])),
  }));
  const rustPaths = paths.filter((pathname) => pathname.endsWith(".rs"));
  errors.push(...findRustTestInventoryHazards({
    paths: rustPaths,
    sources: Object.fromEntries(rustPaths.map((pathname) => [
      pathname,
      readFileSync(join(root, pathname), "utf8"),
    ])),
    allowedCfg: FIXED_RUST_TEST_CFG,
  }));
  return errors;
}

export function checkArchitectureSnapshot({ files, budget, validAdrs }) {
  const errors = [];
  if (budget?.newModuleMaxLines !== 800) {
    errors.push(
      `new production module cap must remain 800 lines; found ${budget?.newModuleMaxLines ?? "missing"}`,
    );
  }
  const hotSpots = budget?.hotSpots ?? {};
  for (const [path, hotSpot] of Object.entries(hotSpots)) {
    const status = hotSpot.status ?? "active";
    if (!["active", "retiring", "retired"].includes(status)) {
      errors.push(`architecture hotspot ${path} has unsupported status: ${status}`);
      continue;
    }
    if (
      ["retiring", "retired"].includes(status) &&
      (typeof hotSpot.retirement?.reason !== "string" ||
        hotSpot.retirement.reason.trim() === "")
    ) {
      errors.push(`${status} architecture hotspot ${path} must declare a retirement reason`);
    }
    errors.push(...validateHotspotAdr(path, hotSpot, validAdrs));
    const lines = files[path];
    if (status === "active" && typeof lines !== "number") {
      errors.push(`${path} is budgeted as a hotspot but is missing from production sources`);
    } else if (status === "active" && lines !== hotSpot.maxLines) {
      errors.push(
        `${path} has ${lines} lines; hotspot snapshot must equal ${hotSpot.maxLines} and be updated downward with the code`,
      );
    } else if (status !== "active" && typeof lines === "number" && lines > 800) {
      errors.push(
        `${status} architecture hotspot ${path} still has ${lines} lines; retirement requires the normal 800-line cap or file removal`,
      );
    }
  }
  for (const [path, lines] of Object.entries(files)) {
    if (!Object.hasOwn(hotSpots, path) && lines > 800) {
      errors.push(`${path} has ${lines} lines; new production modules are limited to 800`);
    }
  }
  return errors;
}

export function compareArchitectureBudgets(
  current,
  base,
  { legacyHotspots = new Map() } = {},
) {
  const errors = [];
  for (const [path, previous] of Object.entries(base.hotSpots ?? {})) {
    const snapshot = current.hotSpots?.[path];
    const previousStatus = previous.status ?? "active";
    if (!snapshot) {
      if (previousStatus !== "retired") {
        errors.push(`hotspot budget was removed instead of retired explicitly: ${path}`);
      }
      continue;
    }
    const status = snapshot.status ?? "active";
    if (previousStatus === "active" && status === "retired") {
      errors.push(`active architecture hotspot ${path} cannot skip directly to retired`);
    }
    if (previousStatus === "retiring" && status === "active") {
      errors.push(`retiring architecture hotspot ${path} cannot return to active`);
    }
    if (previousStatus === "retired" && status !== "retired") {
      errors.push(`retired architecture hotspot ${path} cannot return to ${status}`);
    }
    if (
      ["retiring", "retired"].includes(previousStatus) &&
      !isDeepStrictEqual(snapshot.retirement, previous.retirement)
    ) {
      errors.push(`architecture hotspot ${path} retirement metadata changed`);
    }
    if (snapshot.adr !== previous.adr) {
      errors.push(`architecture hotspot ${path} ADR changed from ${previous.adr} to ${snapshot.adr}`);
    }
    if (snapshot.maxLines > previous.maxLines) {
      errors.push(
        `${path} budget increased from ${previous.maxLines} to ${snapshot.maxLines}; budgets may only decrease`,
      );
    } else if (
      typeof previous.targetLines === "number" &&
      (typeof snapshot.targetLines !== "number" || snapshot.targetLines > previous.targetLines)
    ) {
      errors.push(
        `${path} target increased from ${previous.targetLines} to ${snapshot.targetLines ?? "missing"}; targets may only decrease`,
      );
    }
  }
  for (const path of Object.keys(current.hotSpots ?? {}).filter(
    (path) => !Object.hasOwn(base.hotSpots ?? {}, path),
  )) {
    const baseArtifact = path.endsWith(".css") ? legacyHotspots.get(path) : undefined;
    if (baseArtifact) {
      const snapshot = current.hotSpots[path];
      if (snapshot.maxLines > baseArtifact.maxLines) {
        errors.push(
          `legacy CSS hotspot ${path} line budget exceeds base artifact: ${snapshot.maxLines} > ${baseArtifact.maxLines}`,
        );
      }
      if (snapshot.maxBytes > baseArtifact.maxBytes) {
        errors.push(
          `legacy CSS hotspot ${path} byte budget exceeds base artifact: ${snapshot.maxBytes} > ${baseArtifact.maxBytes}`,
        );
      }
      continue;
    }
    errors.push(`new hotspot budgets are forbidden; keep new modules within 800 lines: ${path}`);
  }
  for (const metric of ["maxTotalBytes", "maxJavaScriptChunkBytes"]) {
    const previous = base.bundle?.[metric];
    const snapshot = current.bundle?.[metric];
    if (typeof previous === "number" && (typeof snapshot !== "number" || snapshot > previous)) {
      errors.push(
        `bundle ${metric} increased from ${previous} to ${snapshot ?? "missing"}; budgets may only decrease`,
      );
    }
  }
  errors.push(...compareCompressionBudgets(current, base, "production"));
  errors.push(...compareToolingBudgets(current.tooling, base.tooling));
  errors.push(...compareToolingBudgets(current.tooling?.tests, base.tooling?.tests));
  return errors;
}

export function loadTrackedArchitectureBudgetAtBase({ tracked, readContents, label }) {
  if (!tracked) return undefined;
  let contents;
  try {
    contents = readContents();
  } catch (error) {
    throw new Error(`cannot read tracked ${label}`, { cause: error });
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`tracked ${label} is invalid JSON`, { cause: error });
  }
}

export function compareBudgetToBase(root, budget, baseRef) {
  if (!baseRef) return [];
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  const tracked = gitPathExistsAtRef(root, baseRef, ARCHITECTURE_BUDGET_PATH);
  const base = loadTrackedArchitectureBudgetAtBase({
    tracked,
    readContents: () =>
      execFileSync("git", ["show", `${baseRef}:${ARCHITECTURE_BUDGET_PATH}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    label: `${baseRef}:${ARCHITECTURE_BUDGET_PATH}`,
  });
  if (!base) return [];
  const legacyHotspots = new Map();
  for (const path of Object.keys(budget.hotSpots ?? {})) {
    if (Object.hasOwn(base.hotSpots ?? {}, path) || !path.endsWith(".css")) continue;
    try {
      const contents = execFileSync("git", ["show", `${baseRef}:${path}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines =
        contents === ""
          ? 0
          : contents.split(/\r?\n/).length - (contents.endsWith("\n") ? 1 : 0);
      if (lines > 800) {
        legacyHotspots.set(path, {
          maxLines: lines,
          maxBytes: fileCompressionMetrics(contents).bytes,
        });
      }
    } catch {
      // A newly-created stylesheet is not legacy debt and must remain below the normal cap.
    }
  }
  return compareArchitectureBudgets(budget, base, { legacyHotspots });
}

export function checkRepositoryToolingBudget(root, budget, { validAdrs } = {}) {
  const toolingFiles = repositoryToolingFiles(root);
  const toolingSources = Object.fromEntries(
    toolingFiles.map((pathname) => [pathname, readFileSync(join(root, pathname), "utf8")]),
  );
  const files = Object.fromEntries(
    toolingFiles.map((path) => [path, countLines(join(root, path))]),
  );
  const compressionMetrics = Object.fromEntries(
    toolingFiles.map((path) => [path, fileCompressionMetrics(readFileSync(join(root, path)))]),
  );
  const errors = checkToolingSnapshot({ files, budget, compressionMetrics });
  for (const path of toolingFiles) {
    errors.push(
      ...findForbiddenToolingTestImports(path, readFileSync(join(root, path), "utf8")),
    );
    errors.push(
      ...findUnsafeGitPathInventory(path, readFileSync(join(root, path), "utf8")),
    );
  }
  errors.push(...findOrphanToolingModules({
    sources: toolingSources,
    entrypoints: discoverToolingEntrypoints(root, new Set(toolingFiles)),
    standalone: budget?.standalone,
  }));
  for (const [path, hotSpot] of Object.entries(budget?.hotSpots ?? {})) {
    errors.push(...validateHotspotAdr(path, hotSpot, validAdrs));
  }
  const testFiles = repositoryToolingTestFiles(root);
  const testSources = Object.fromEntries(
    testFiles.map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );
  const testMetrics = Object.fromEntries(
    testFiles.map((path) => [path, fileCompressionMetrics(readFileSync(join(root, path)))]),
  );
  errors.push(
    ...checkToolingSnapshot({
      files: Object.fromEntries(testFiles.map((path) => [path, countLines(join(root, path))])),
      budget: budget?.tests,
      compressionMetrics: testMetrics,
    }),
  );
  errors.push(
    ...findToolingTestHelperHazards({
      sources: testSources,
      fixtureCatalog: budget?.tests?.fixtures,
    }),
  );
  errors.push(...checkRepositoryTestInventory(root, repositoryTrackedFiles(root), budget?.tests));
  return errors;
}

export function checkRepositoryProductionCompressionBudget(root, budget) {
  const moduleMap = JSON.parse(readFileSync(join(root, MODULE_MAP_PATH), "utf8"));
  const metrics = Object.fromEntries(
    discoverProductionFiles(root, moduleMap).map((path) => [
      path,
      fileCompressionMetrics(readFileSync(join(root, path))),
    ]),
  );
  return checkCompressionBudget({ metrics, budget, scope: "production" });
}
