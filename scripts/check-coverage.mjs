#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import {
  classifyRustCfgAttribute,
  compareCoverage,
  maskRustNonCode,
  parseUnifiedDiffLines,
  rustAttributes,
  shouldEnforceChangedCoverage,
} from "./governance.mjs";
import { gitPathExistsAtRef, listUntrackedFiles } from "./git-paths.mjs";
import { isRustProductionSourcePath } from "./source-classification.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "docs/engineering/coverage-baseline.json";

export function floorCoveragePercent(covered, total) {
  if (!Number.isFinite(covered) || !Number.isFinite(total) || covered < 0 || total < 0) {
    throw new Error("coverage counts must be finite non-negative numbers");
  }
  if (covered > total) throw new Error("covered coverage count cannot exceed total");
  return total === 0 ? 100 : Math.floor((covered * 10_000) / total) / 100;
}

function frontendSummary() {
  const summary = JSON.parse(
    readFileSync(resolve(ROOT, "coverage/frontend/coverage-summary.json"), "utf8"),
  ).total;
  return {
    lines: floorCoveragePercent(summary.lines.covered, summary.lines.total),
    branches: floorCoveragePercent(summary.branches.covered, summary.branches.total),
    functions: floorCoveragePercent(summary.functions.covered, summary.functions.total),
  };
}

export function isCoverageProductionPath(mode, path) {
  if (mode === "frontend") {
    return (
      path.startsWith("src/") &&
      /\.(?:[cm]?ts|tsx)$/.test(path) &&
      !/\.(?:test|spec)\.(?:[cm]?ts|tsx)$/.test(path) &&
      !/\.d\.(?:[cm]?ts)$/.test(path) &&
      path !== "src/testSetup.ts"
    );
  }
  if (mode === "rust") {
    return isRustProductionSourcePath(path);
  }
  throw new Error(`unknown coverage mode: ${mode}`);
}

export function findMissingCoverageFiles({ mode, sourcePaths, lcovPaths }) {
  const covered = new Set(lcovPaths);
  return sourcePaths
    .filter((path) => isCoverageProductionPath(mode, path))
    .filter((path) => !covered.has(path))
    .sort();
}

function currentSourcePaths(mode) {
  const prefix = mode === "frontend" ? "src" : "src-tauri/src";
  const paths = [];
  const visit = (relativeDirectory) => {
    for (const entry of readdirSync(resolve(ROOT, relativeDirectory), { withFileTypes: true })) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  visit(prefix);
  return paths;
}

export function buildCoverageDiffArguments(baseRef, prefix) {
  return ["-c", "core.quotePath=false", "diff", "--unified=0", baseRef, "--", prefix];
}

function changedSourceLines(baseRef, prefix, mode) {
  if (!baseRef) return {};
  const diff = execFileSync(
    "git",
    buildCoverageDiffArguments(baseRef, prefix),
    { cwd: ROOT, encoding: "utf8" },
  );
  const changed = Object.fromEntries(
    Object.entries(parseUnifiedDiffLines(diff)).filter(([path]) =>
      isCoverageProductionPath(mode, path),
    ),
  );
  for (const path of listUntrackedFiles(ROOT, [prefix])) {
    if (!isCoverageProductionPath(mode, path)) continue;
    const contents = readFileSync(resolve(ROOT, path), "utf8");
    const lineCount = contents === "" ? 0 : contents.split(/\r?\n/).length;
    changed[path] = Array.from({ length: lineCount }, (_, index) => index + 1);
  }
  return changed;
}

function lineAtOffset(contents, offset) {
  return contents.slice(0, offset).split("\n").length;
}

function matchingBrace(masked, opening) {
  let depth = 0;
  for (let index = opening; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unclosed #[cfg(test)] Rust block");
}

function findRustAttributeItemLineRanges(contents, matchesAttribute) {
  const masked = maskRustNonCode(contents);
  const ranges = [];
  const attributes = rustAttributes(contents);
  for (const attribute of attributes) {
    if (!matchesAttribute(attribute)) continue;
    let cursor = attribute.end;
    while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
    while (true) {
      const followingAttribute = attributes.find((candidate) => candidate.start === cursor);
      if (!followingAttribute) break;
      cursor = followingAttribute.end;
      while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
    }
    let roundDepth = 0;
    let squareDepth = 0;
    let end;
    for (let index = cursor; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(") roundDepth += 1;
      else if (character === ")") roundDepth -= 1;
      else if (character === "[") squareDepth += 1;
      else if (character === "]") squareDepth -= 1;
      else if (roundDepth === 0 && squareDepth === 0 && character === "{") {
        end = matchingBrace(masked, index);
        break;
      } else if (
        roundDepth === 0 &&
        squareDepth === 0 &&
        (character === ";" || character === ",")
      ) {
        end = index;
        break;
      }
    }
    if (end == null) throw new Error("cannot determine conditional Rust item boundary");
    ranges.push({
      start: lineAtOffset(masked, attribute.start),
      end: lineAtOffset(masked, end),
    });
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) merged.push(range);
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

export function findRustCfgTestLineRanges(contents) {
  return findRustAttributeItemLineRanges(contents, (attribute) =>
    Boolean(classifyRustCfgAttribute(attribute.text)?.testOnly),
  );
}

export function findRustConditionalLineRanges(contents) {
  return findRustAttributeItemLineRanges(contents, (attribute) => {
    if (attribute.text.startsWith("#![")) return false;
    if (classifyRustCfgAttribute(attribute.text)?.testOnly) return false;
    const compact = attribute.text.replace(/\s+/g, "");
    return compact.startsWith("#[cfg(") || compact.startsWith("#[cfg_attr(");
  });
}

const rustTestLineCache = new Map();
const rustConditionalLineCache = new Map();

function rustTestLines(path) {
  if (!isCoverageProductionPath("rust", path)) return new Set();
  if (!rustTestLineCache.has(path)) {
    const absolute = resolve(ROOT, path);
    const lines = new Set();
    if (existsSync(absolute)) {
      for (const range of findRustCfgTestLineRanges(readFileSync(absolute, "utf8"))) {
        for (let line = range.start; line <= range.end; line += 1) lines.add(line);
      }
    }
    rustTestLineCache.set(path, lines);
  }
  return rustTestLineCache.get(path);
}

function rustConditionalLines(path) {
  if (!isCoverageProductionPath("rust", path)) return new Set();
  if (!rustConditionalLineCache.has(path)) {
    const absolute = resolve(ROOT, path);
    const lines = new Set();
    if (existsSync(absolute)) {
      for (const range of findRustConditionalLineRanges(readFileSync(absolute, "utf8"))) {
        for (let line = range.start; line <= range.end; line += 1) lines.add(line);
      }
    }
    rustConditionalLineCache.set(path, lines);
  }
  return rustConditionalLineCache.get(path);
}

function parseLcov(path, mode) {
  const files = {};
  let current;
  let functionLines;
  for (const row of readFileSync(path, "utf8").split("\n")) {
    if (row.startsWith("SF:")) {
      current = row.slice(3).replace(`${ROOT}/`, "");
      files[current] = { lines: new Map(), branches: new Map(), functions: new Map() };
      functionLines = new Map();
    } else if (current && row.startsWith("DA:")) {
      const [line, hits] = row.slice(3).split(",").map(Number);
      if (mode === "rust" && rustTestLines(current).has(line)) continue;
      files[current].lines.set(line, hits > 0);
    } else if (current && row.startsWith("BRDA:")) {
      const [line, , , taken] = row.slice(5).split(",");
      if (mode === "rust" && rustTestLines(current).has(Number(line))) continue;
      const branches = files[current].branches.get(Number(line)) ?? [];
      branches.push(taken !== "-" && Number(taken) > 0);
      files[current].branches.set(Number(line), branches);
    } else if (current && row.startsWith("FN:")) {
      const separator = row.indexOf(",", 3);
      const line = Number(row.slice(3, separator));
      const name = row.slice(separator + 1);
      functionLines.set(name, line);
      if (mode !== "rust" || !rustTestLines(current).has(line)) {
        files[current].functions.set(name, false);
      }
    } else if (current && row.startsWith("FNDA:")) {
      const separator = row.indexOf(",", 5);
      const hits = Number(row.slice(5, separator));
      const name = row.slice(separator + 1);
      const line = functionLines.get(name);
      if (line != null && (mode !== "rust" || !rustTestLines(current).has(line))) {
        files[current].functions.set(name, hits > 0);
      }
    }
  }
  return files;
}

export function summarizeLcov(files) {
  let lineTotal = 0;
  let lineCovered = 0;
  let branchTotal = 0;
  let branchCovered = 0;
  let functionTotal = 0;
  let functionCovered = 0;
  for (const file of Object.values(files)) {
    lineTotal += file.lines.size;
    lineCovered += [...file.lines.values()].filter(Boolean).length;
    for (const branches of file.branches.values()) {
      branchTotal += branches.length;
      branchCovered += branches.filter(Boolean).length;
    }
    functionTotal += file.functions.size;
    functionCovered += [...file.functions.values()].filter(Boolean).length;
  }
  return {
    lines: floorCoveragePercent(lineCovered, lineTotal),
    branches: floorCoveragePercent(branchCovered, branchTotal),
    functions: floorCoveragePercent(functionCovered, functionTotal),
  };
}

function rustSummary() {
  return summarizeLcov(parseLcov(resolve(ROOT, "coverage/rust.lcov"), "rust"));
}

function deepestNodeAtPosition(sourceFile, position) {
  let deepest = sourceFile;
  const visit = (node) => {
    if (node.getFullStart() <= position && position < node.getEnd()) {
      deepest = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return deepest;
}

export function isProbablyExecutableSource(path, contents, line) {
  const rows = contents.split(/\r?\n/);
  const source = rows[line - 1]?.trim() ?? "";
  if (!source || /^(?:\/\/|\/\*|\*|\*\/)/.test(source)) return false;
  if (/^[{}()[\],;]+$/.test(source)) return false;
  if (!/\.(?:[cm]?ts|tsx)$/.test(path)) {
    return !/^(?:use |mod )\b/.test(source);
  }

  const sourceFile = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line - 1, 0);
  const firstToken = lineStart + (rows[line - 1]?.search(/\S/) ?? 0);
  let node = deepestNodeAtPosition(sourceFile, firstToken);
  while (node) {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodSignature(node) ||
      ts.isCallSignatureDeclaration(node) ||
      ts.isConstructSignatureDeclaration(node) ||
      ts.isIndexSignatureDeclaration(node) ||
      ts.isTypeParameterDeclaration(node) ||
      (ts.isPropertyDeclaration(node) && !node.initializer) ||
      (ts.isParameter(node) && !node.initializer) ||
      ts.isTypeNode(node)
    ) {
      return false;
    }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.DeclareKeyword
    )) {
      return false;
    }
    node = node.parent;
  }
  return true;
}

export function isOmittedCoverageLineExecutable({
  mode,
  filePresentInLcov,
  sourceExecutable,
  conditionallyCompiled = false,
}) {
  // LLVM emits zero-hit DA records for compiled Rust. A missing line in a
  // present Rust source record is normally declarative/non-instrumentable.
  // A changed line inside a non-test cfg item is the exception: the active
  // coverage feature/profile can omit executable release code, so it must be
  // counted as uncovered instead of disappearing from the denominator.
  return sourceExecutable &&
    (mode !== "rust" || !filePresentInLcov || conditionallyCompiled);
}

export function calculateChangedCoverage({ changed, lcov, isExecutable }) {
  let lineTotal = 0;
  let lineCovered = 0;
  let branchTotal = 0;
  let branchCovered = 0;
  for (const [path, lines] of Object.entries(changed)) {
    const file = lcov[path];
    for (const line of lines) {
      if (file?.lines.has(line)) {
        lineTotal += 1;
        if (file.lines.get(line)) lineCovered += 1;
      } else if (isExecutable(path, line)) {
        // A new executable line/file omitted from LCOV is uncovered, not invisible.
        lineTotal += 1;
      }
      for (const covered of file?.branches.get(line) ?? []) {
        branchTotal += 1;
        if (covered) branchCovered += 1;
      }
    }
  }
  if (lineTotal === 0) return undefined;
  return {
    linePercent: floorCoveragePercent(lineCovered, lineTotal),
    branchPercent: floorCoveragePercent(branchCovered, branchTotal),
    lineCovered,
    lineTotal,
    branchCovered,
    branchTotal,
  };
}

export function calculateChangedCoverageWithDetails({ changed, lcov, isExecutable }) {
  const files = {};
  for (const [path, lines] of Object.entries(changed)) {
    const result = calculateChangedCoverage({
      changed: { [path]: lines },
      lcov,
      isExecutable,
    });
    if (result) files[path] = result;
  }
  const total = calculateChangedCoverage({ changed, lcov, isExecutable });
  return total ? { ...total, files } : undefined;
}

export function parseTrackedJsonAtBase({ tracked, contents, label }) {
  if (!tracked) return undefined;
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`tracked ${label} is invalid JSON`, { cause: error });
  }
}

export function loadTrackedJsonAtBase({ tracked, readContents, label }) {
  if (!tracked) return undefined;
  let contents;
  try {
    contents = readContents();
  } catch (error) {
    throw new Error(`cannot read tracked ${label}`, { cause: error });
  }
  return parseTrackedJsonAtBase({ tracked, contents, label });
}

const COVERAGE_MODES = ["frontend", "rust"];
const COVERAGE_METRICS = ["lines", "branches", "functions"];

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateMetricValue(value, label, { requireTwoDecimals = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} is invalid`);
  }
  if (requireTwoDecimals && Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) {
    throw new Error(`${label} must be recorded to at most two decimal places`);
  }
}

export function validateCoverageBaselineDocument(document, label, { legacy = false } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const mode of COVERAGE_MODES) {
    for (const metric of COVERAGE_METRICS) {
      const value = document[mode]?.[metric];
      try {
        validateMetricValue(value, `${label}.${mode}.${metric}`, {
          requireTwoDecimals: !legacy,
        });
      } catch (error) {
        if (error instanceof Error && error.message === `${label}.${mode}.${metric} is invalid`) {
          throw new Error(`${label} has invalid ${mode}.${metric}`);
        }
        throw error;
      }
    }
    if (!legacy && !hasExactKeys(document[mode], COVERAGE_METRICS)) {
      throw new Error(`${label}.${mode} must contain only lines, branches, and functions`);
    }
  }
  if (!legacy) {
    if (!hasExactKeys(document, ["measuredAtCommit", ...COVERAGE_MODES])) {
      throw new Error(`${label} must contain only measuredAtCommit, frontend, and rust`);
    }
    if (!/^[0-9a-f]{40}$/.test(document.measuredAtCommit ?? "")) {
      throw new Error(`${label} has invalid measuredAtCommit`);
    }
  }
  return document;
}

export function validateCoverageMeasurementDocument(document, label) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (!hasExactKeys(document, ["commit", "clean", ...COVERAGE_MODES])) {
    throw new Error(`${label} must contain only commit, clean, frontend, and rust`);
  }
  if (!/^[0-9a-f]{40}$/.test(document.commit ?? "")) {
    throw new Error(`${label} has invalid commit`);
  }
  if (document.clean !== true) throw new Error(`${label} must come from a clean worktree`);
  for (const mode of COVERAGE_MODES) {
    const metrics = document[mode];
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
      throw new Error(`${label}.${mode} must be a JSON object`);
    }
    if (!hasExactKeys(metrics, COVERAGE_METRICS)) {
      throw new Error(`${label}.${mode} must contain only lines, branches, and functions`);
    }
    for (const metric of COVERAGE_METRICS) {
      validateMetricValue(metrics[metric], `${label}.${mode}.${metric}`);
    }
  }
  return document;
}

function floorPercentageValue(value) {
  return Math.floor((value + 1e-9) * 100) / 100;
}

export function buildCoverageBaselineUpdate({ first, second, previous, expectedCommit }) {
  const firstRun = validateCoverageMeasurementDocument(first, "first coverage run");
  const secondRun = validateCoverageMeasurementDocument(second, "second coverage run");
  const previousBaseline = validateCoverageBaselineDocument(previous, "current coverage baseline");
  if (firstRun.commit !== secondRun.commit) {
    throw new Error("coverage baseline runs must use the same commit");
  }
  if (expectedCommit && firstRun.commit !== expectedCommit) {
    throw new Error(`coverage baseline runs must use current commit ${expectedCommit}`);
  }

  const next = { measuredAtCommit: firstRun.commit, frontend: {}, rust: {} };
  for (const mode of COVERAGE_MODES) {
    for (const metric of COVERAGE_METRICS) {
      const firstValue = firstRun[mode][metric];
      const secondValue = secondRun[mode][metric];
      if (Math.abs(firstValue - secondValue) > 0.010000001) {
        throw new Error(
          `${mode}.${metric} drifted by more than 0.01 percentage points between runs`,
        );
      }
      const candidate = floorPercentageValue(Math.min(firstValue, secondValue));
      if (candidate + Number.EPSILON < previousBaseline[mode][metric]) {
        throw new Error(
          `coverage baseline may not decrease: ${mode}.${metric} ${candidate}% < ${previousBaseline[mode][metric]}%`,
        );
      }
      next[mode][metric] = candidate;
    }
  }
  return validateCoverageBaselineDocument(next, "updated coverage baseline");
}

function gitCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function isCleanWorktree() {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim() === "";
}

function captureCoverageMeasurement() {
  if (!isCleanWorktree()) throw new Error("coverage baseline measurements require a clean worktree");
  return {
    commit: gitCommit(),
    clean: true,
    frontend: frontendSummary(),
    rust: rustSummary(),
  };
}

function updateCoverageBaseline(firstPath, secondPath, write) {
  if (!firstPath || !secondPath) {
    throw new Error(
      "usage: node scripts/check-coverage.mjs baseline <first.json> <second.json> [--write]",
    );
  }
  if (!isCleanWorktree()) throw new Error("coverage baseline updates require a clean worktree");
  const baselineFile = resolve(ROOT, BASELINE_PATH);
  const next = buildCoverageBaselineUpdate({
    first: JSON.parse(readFileSync(resolve(firstPath), "utf8")),
    second: JSON.parse(readFileSync(resolve(secondPath), "utf8")),
    previous: JSON.parse(readFileSync(baselineFile, "utf8")),
    expectedCommit: gitCommit(),
  });
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (write) writeFileSync(baselineFile, serialized, "utf8");
  else process.stdout.write(serialized);
}

function changedCoverage(baseRef, prefix, lcovPath, mode) {
  if (!baseRef) return undefined;
  const changed = changedSourceLines(baseRef, prefix, mode);
  const lcov = parseLcov(resolve(ROOT, lcovPath), mode);
  const sourceCache = new Map();
  return calculateChangedCoverageWithDetails({
    changed,
    lcov,
    isExecutable: (path, line) => {
      const absolute = resolve(ROOT, path);
      if (!existsSync(absolute)) return false;
      if (!sourceCache.has(path)) sourceCache.set(path, readFileSync(absolute, "utf8"));
      const contents = sourceCache.get(path);
      if (mode === "rust" && rustTestLines(path).has(line)) return false;
      return isOmittedCoverageLineExecutable({
        mode,
        filePresentInLcov: Boolean(lcov[path]),
        sourceExecutable: isProbablyExecutableSource(path, contents, line),
        conditionallyCompiled:
          mode === "rust" && rustConditionalLines(path).has(line),
      });
    },
  });
}

function baselineAtBase(baseRef) {
  if (!baseRef) return undefined;
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const tracked = gitPathExistsAtRef(ROOT, baseRef, BASELINE_PATH);
  return loadTrackedJsonAtBase({
    tracked,
    readContents: () =>
      execFileSync("git", ["show", `${baseRef}:${BASELINE_PATH}`], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    label: `${baseRef}:${BASELINE_PATH}`,
  });
}

function main() {
  const mode = process.argv[2];
  if (mode === "snapshot") {
    process.stdout.write(`${JSON.stringify(captureCoverageMeasurement(), null, 2)}\n`);
    return;
  }
  if (mode === "baseline") {
    const options = process.argv.slice(3);
    const paths = options.filter((argument) => argument !== "--write");
    updateCoverageBaseline(paths[0], paths[1], options.includes("--write"));
    return;
  }
  if (!["frontend", "rust"].includes(mode)) {
    throw new Error("usage: node scripts/check-coverage.mjs frontend|rust|snapshot|baseline");
  }
  const baselineFile = resolve(ROOT, BASELINE_PATH);
  if (!existsSync(baselineFile)) throw new Error(`${BASELINE_PATH} is missing`);
  const baselineDocument = validateCoverageBaselineDocument(
    JSON.parse(readFileSync(baselineFile, "utf8")),
    BASELINE_PATH,
  );
  const baseline = baselineDocument[mode];
  const baseRef = process.env.COVERAGE_BASE_REF;
  const rawPreviousBaseline = baselineAtBase(baseRef);
  const previousBaselineFile = rawPreviousBaseline
    ? validateCoverageBaselineDocument(
        rawPreviousBaseline,
        `${baseRef}:${BASELINE_PATH}`,
        { legacy: true },
      )
    : undefined;
  const enforceChanged = shouldEnforceChangedCoverage({
    baseRef,
    baselineExistsAtBase: Boolean(previousBaselineFile),
  });
  const lcovPath =
    mode === "frontend" ? "coverage/frontend/lcov.info" : "coverage/rust.lcov";
  const lcov = parseLcov(resolve(ROOT, lcovPath), mode);
  const current = mode === "frontend" ? frontendSummary() : summarizeLcov(lcov);
  const missingCoverageFiles = findMissingCoverageFiles({
    mode,
    sourcePaths: currentSourcePaths(mode),
    lcovPaths: Object.keys(lcov),
  });
  const changed = enforceChanged
    ? mode === "frontend"
      ? changedCoverage(baseRef, "src", lcovPath, mode)
      : changedCoverage(baseRef, "src-tauri/src", lcovPath, mode)
    : undefined;
  const errors = [
    ...missingCoverageFiles.map(
      (path) => `production source is missing from ${mode} coverage inventory: ${path}`,
    ),
    ...compareCoverage({ current, baseline, changed }),
    ...compareCoverage({
      current: baseline,
      baseline: previousBaselineFile?.[mode] ?? baseline,
    }).map(
      (message) => `coverage baseline may not decrease: ${message}`,
    ),
  ];
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    console.error(`coverage totals: current=${JSON.stringify(current)} baseline=${JSON.stringify(baseline)}`);
    if (changed?.files) {
      console.error(`changed ${mode} coverage by file:`);
      for (const [path, result] of Object.entries(changed.files)) {
        console.error(
          `  ${path}: lines ${result.linePercent}% (${result.lineCovered}/${result.lineTotal}), branches ${result.branchPercent}% (${result.branchCovered}/${result.branchTotal})`,
        );
      }
    }
    process.exitCode = 1;
    return;
  }
  if (baseRef && !previousBaselineFile) {
    console.log(
      `BOOTSTRAP ${mode} overall baseline comparison: ${baseRef} has no ${BASELINE_PATH}; changed-line thresholds were still enforced`,
    );
  }
  console.log(`PASS ${mode} coverage`, { current, baseline, changed });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
