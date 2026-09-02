#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectGovernanceContext } from "./governance-assets.mjs";
import { parseNulDelimitedGitPaths } from "./git-paths.mjs";
import { MODULE_MAP_PATH, selectModuleContext } from "./module-map.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const CATALOG_PATH = resolve(ROOT, "docs/engineering/governance-assets.json");
const MODULE_MAP_FILE = resolve(ROOT, MODULE_MAP_PATH);

export function selectRepositoryContext(catalog, moduleMap, paths) {
  const governance = selectGovernanceContext(catalog, paths);
  const modules = selectModuleContext(moduleMap, paths);
  const assetByPath = new Map((catalog.assets ?? []).map((asset) => [asset.path, asset.id]));
  const assets = new Set(governance.assets);
  for (const path of [...modules.ownerRules, ...modules.decisions]) {
    const id = assetByPath.get(path);
    if (!id) throw new Error(`module context references an unindexed governance asset: ${path}`);
    assets.add(id);
  }
  return {
    assets: [...assets].sort(),
    invariants: governance.invariants,
    modules: modules.modules,
  };
}

function gitZeroSeparated(args) {
  return parseNulDelimitedGitPaths(execFileSync("git", args, { cwd: ROOT }));
}

export function parseGitNameStatusZ(output) {
  const fields = parseNulDelimitedGitPaths(output, "git diff --name-status -z");
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^[A-Z][0-9]*$/.test(status ?? "")) {
      throw new Error(`cannot parse Git name-status record: ${status || "missing status"}`);
    }
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    if (index + pathCount > fields.length) {
      throw new Error(`incomplete Git name-status record: ${status}`);
    }
    for (let offset = 0; offset < pathCount; offset += 1) {
      const path = fields[index++];
      if (!path) throw new Error(`empty path in Git name-status record: ${status}`);
      paths.push(path);
    }
  }
  return paths;
}

function gitChangedPaths(args) {
  const output = execFileSync("git", args, { cwd: ROOT });
  return parseGitNameStatusZ(output);
}

export function parseContextArguments(args) {
  let baseRef;
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base-ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--base-ref requires a Git ref");
      }
      baseRef = value;
      index += 1;
    } else if (argument.startsWith("--base-ref=")) {
      baseRef = argument.slice("--base-ref=".length);
      if (!baseRef) throw new Error("--base-ref requires a Git ref");
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      paths.push(argument);
    }
  }
  return { baseRef, paths };
}

export function changedPaths({ baseRef, paths }) {
  const selected = new Set(paths);
  if (baseRef) {
    execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
      cwd: ROOT,
      stdio: "ignore",
    });
    for (const path of gitChangedPaths([
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      `${baseRef}...HEAD`,
    ])) {
      selected.add(path);
    }
  }
  if (paths.length === 0) {
    for (const path of gitChangedPaths([
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
    ])) selected.add(path);
    for (const path of gitChangedPaths([
      "diff",
      "--cached",
      "--name-status",
      "-z",
      "--find-renames",
    ])) selected.add(path);
    for (const path of gitZeroSeparated([
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
    ])) {
      selected.add(path);
    }
  }
  return [...selected].sort();
}

function main() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const moduleMap = JSON.parse(readFileSync(MODULE_MAP_FILE, "utf8"));
  const paths = changedPaths(parseContextArguments(process.argv.slice(2)));
  const selected = selectRepositoryContext(catalog, moduleMap, paths);
  const assets = new Map(catalog.assets.map((asset) => [asset.id, asset]));
  const invariants = new Map(catalog.invariants.map((invariant) => [invariant.id, invariant]));

  console.log(`Governance context (${paths.length} changed path${paths.length === 1 ? "" : "s"})`);
  if (paths.length > 0) {
    console.log("\nChanged paths:");
    for (const path of paths) console.log(`- ${path}`);
  }
  console.log("\nAssets to load:");
  for (const id of selected.assets) {
    const asset = assets.get(id);
    console.log(`- ${id}: ${asset.path}`);
  }
  console.log("\nOwning modules:");
  if (selected.modules.length === 0) console.log("- none");
  for (const id of selected.modules) console.log(`- ${id}`);
  console.log("\nHigh-risk invariants to review:");
  if (selected.invariants.length === 0) console.log("- none");
  for (const id of selected.invariants) {
    const invariant = invariants.get(id);
    const rule = assets.get(invariant.rule);
    console.log(`- ${id}: Rule=${rule.path}; retire when ${invariant.retireWhen}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
