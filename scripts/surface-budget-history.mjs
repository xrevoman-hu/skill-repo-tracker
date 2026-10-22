import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compareSurfaceBudgets, SURFACE_CATEGORIES } from "./surface-budget.mjs";

const BUDGET_PATH = "docs/engineering/surface-budget.json";
const MAX_COMMITS = 1000;

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`surface history Git read failed: ${args[0]}`);
  }
}

function commit(root, ref) {
  if (typeof ref !== "string" || !ref || ref.includes("\0")) {
    throw new Error("surface history requires a valid commit reference");
  }
  const sha = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("surface history requires a full commit SHA");
  return sha;
}

// History proves registration order only. Actual source discovery still runs at
// the current tree; historical scripts and source files are never executed.
export function validateSurfaceHistoryBudget(budget) {
  const errors = [];
  if (!budget || typeof budget !== "object" || Array.isArray(budget)
      || budget.schemaVersion !== 1) return ["surface history schemaVersion must be 1"];
  const categories = budget.categories;
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) {
    return ["surface history categories must be an object"];
  }
  for (const category of Object.keys(categories)) {
    if (!SURFACE_CATEGORIES.includes(category)) errors.push(`surface history unknown category: ${category}`);
  }
  for (const category of SURFACE_CATEGORIES) {
    const entries = categories[category];
    if (!Array.isArray(entries)) {
      errors.push(`surface history category must be an array: ${category}`);
      continue;
    }
    const ids = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || Object.keys(entry).some(key => !["id", "status", "purpose", "retirementReason"].includes(key))
          || typeof entry.id !== "string" || !entry.id.trim() || entry.id !== entry.id.trim()
          || typeof entry.purpose !== "string" || !entry.purpose.trim()
          || !["active", "retiring"].includes(entry.status)
          || (entry.retirementReason !== undefined && typeof entry.retirementReason !== "string")
          || (entry.status === "retiring" && !entry.retirementReason?.trim())) {
        errors.push(`surface history invalid entry: ${category}`);
        continue;
      }
      if (ids.has(entry.id)) errors.push(`surface history duplicate ${category}: ${entry.id}`);
      ids.add(entry.id);
    }
  }
  return errors;
}

function readBudget(root, sha) {
  let budget;
  try {
    budget = JSON.parse(git(root, ["show", `${sha}:${BUDGET_PATH}`]));
  } catch {
    throw new Error(`surface history missing or invalid JSON at ${sha}`);
  }
  const errors = validateSurfaceHistoryBudget(budget);
  if (errors.length) throw new Error(`surface history ${sha}: ${errors.join("; ")}`);
  return budget;
}

export function checkSurfaceBudgetHistory(root, { baseRef, headRef = "HEAD", currentBudget } = {}) {
  try {
    if (git(root, ["rev-parse", "--is-shallow-repository"]) !== "false") {
      return ["surface history requires complete, non-shallow Git history"];
    }
    const base = commit(root, baseRef);
    const head = commit(root, headRef);
    git(root, ["merge-base", "--is-ancestor", base, head]);
    const history = git(root, ["rev-list", "--reverse", "--parents", `--max-count=${MAX_COMMITS + 1}`, `${base}..${head}`]);
    const rows = history ? history.split("\n") : [];
    if (rows.length > MAX_COMMITS) return [`surface history exceeds ${MAX_COMMITS} commits`];
    let previousSha = base;
    let previous = readBudget(root, base);
    for (const row of rows) {
      const [sha, ...parents] = row.split(" ");
      if (!/^[a-f0-9]{40}$/.test(sha) || parents.length !== 1 || parents[0] !== previousSha) {
        return [`surface history must be a complete single-parent chain at ${sha}`];
      }
      const next = readBudget(root, sha);
      const errors = compareSurfaceBudgets(next, previous);
      if (errors.length) return errors.map(error => `surface history ${sha}: ${error}`);
      previous = next;
      previousSha = sha;
    }
    if (previousSha !== head) return ["surface history did not reach HEAD"];
    const current = currentBudget ?? JSON.parse(readFileSync(join(root, BUDGET_PATH), "utf8"));
    const shapeErrors = validateSurfaceHistoryBudget(current);
    if (shapeErrors.length) return shapeErrors.map(error => `surface history working tree: ${error}`);
    return compareSurfaceBudgets(current, previous).map(error => `surface history working tree: ${error}`);
  } catch (error) {
    return [error.message];
  }
}
