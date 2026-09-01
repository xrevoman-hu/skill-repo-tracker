#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_CHECKS = [
  { context: "verify", label: "CI / verify" },
  { context: "coverage", label: "CI / coverage" },
  { context: "msrv", label: "CI / msrv" },
];
const REQUIRED_WORKFLOWS = [
  ["CI", ".github/workflows/ci.yml"],
  ["Release gate", ".github/workflows/release-gate.yml"],
  ["Security audit", ".github/workflows/security-audit.yml"],
  ["Weekly resilience", ".github/workflows/weekly-resilience.yml"],
];

function protectsMain(ruleset, defaultBranch) {
  const includes = ruleset.conditions?.ref_name?.include ?? [];
  const excludes = ruleset.conditions?.ref_name?.exclude ?? [];
  const explicitlyIncludesMain = includes.includes("refs/heads/main");
  const includesVerifiedDefaultMain =
    defaultBranch === "main" && includes.includes("~DEFAULT_BRANCH");
  return (
    ruleset.target === "branch" &&
    ruleset.enforcement === "active" &&
    excludes.length === 0 &&
    (explicitlyIncludesMain || includesVerifiedDefaultMain)
  );
}

export function evaluateGitHubGovernance({
  defaultBranch,
  rulesets,
  dependabotAlerts,
  securityUpdates,
  workflows,
  releaseEnvironment,
}) {
  const errors = [];
  const ruleset = (Array.isArray(rulesets) ? rulesets : []).find((candidate) =>
    protectsMain(candidate, defaultBranch),
  );
  if (!ruleset) {
    errors.push("no active ruleset protects main");
  } else {
    const rules = ruleset.rules ?? [];
    if (!rules.some((rule) => rule.type === "pull_request")) {
      errors.push("main ruleset does not require pull requests");
    }
    const statusRule = rules.find((rule) => rule.type === "required_status_checks");
    const contexts = new Set(
      statusRule?.parameters?.required_status_checks?.map((check) => check.context) ?? [],
    );
    for (const check of REQUIRED_CHECKS) {
      if (!contexts.has(check.context)) {
        errors.push(`main ruleset is missing required check: ${check.label}`);
      }
    }
    if (!statusRule?.parameters?.strict_required_status_checks_policy) {
      errors.push("main ruleset does not require branches to be up to date");
    }
    if (!rules.some((rule) => rule.type === "non_fast_forward")) {
      errors.push("main ruleset permits force pushes");
    }
    if (!rules.some((rule) => rule.type === "deletion")) {
      errors.push("main ruleset permits branch deletion");
    }
    if (!Array.isArray(ruleset.bypass_actors)) {
      errors.push("main ruleset bypass actors are missing or cannot be verified");
    } else if (ruleset.bypass_actors.length > 0) {
      errors.push("main ruleset has bypass actors; direct main changes are still possible");
    }
  }
  if (!dependabotAlerts) {
    errors.push("Dependabot alerts are not enabled or cannot be verified");
  }
  if (!securityUpdates) {
    errors.push("Dependabot security updates are not enabled or cannot be verified");
  }
  const activeWorkflow = (name, path) =>
    workflows?.some(
      (workflow) => workflow.name === name && workflow.path === path && workflow.state === "active",
    );
  for (const [name, path] of REQUIRED_WORKFLOWS) {
    if (!activeWorkflow(name, path)) errors.push(`active ${name} workflow is missing`);
  }
  const requiredReviewerRule = releaseEnvironment?.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  if (!requiredReviewerRule || (requiredReviewerRule.reviewers ?? []).length === 0) {
    errors.push("release Environment has no required reviewer or cannot be verified");
  }
  if (releaseEnvironment?.can_admins_bypass !== false) {
    errors.push("release Environment allows admin bypass or cannot be verified");
  }
  return errors;
}

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "inherit"],
  });
}

function endpointEnabled(endpoint) {
  const result = spawnSync("gh", ["api", "--silent", endpoint], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function optionalJson(endpoint) {
  try {
    return JSON.parse(gh(["api", endpoint], { quiet: true }));
  } catch {
    return undefined;
  }
}

function loadRemoteState() {
  const repository = JSON.parse(
    gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]),
  );
  const nameWithOwner = repository.nameWithOwner;
  if (!/^[^/]+\/[^/]+$/.test(nameWithOwner)) throw new Error("cannot resolve GitHub repository");
  const summaries = JSON.parse(gh(["api", `repos/${nameWithOwner}/rulesets`]));
  const rulesets = summaries.map((summary) =>
    JSON.parse(gh(["api", `repos/${nameWithOwner}/rulesets/${summary.id}`])),
  );
  return {
    nameWithOwner,
    defaultBranch: repository.defaultBranchRef?.name,
    rulesets,
    dependabotAlerts: endpointEnabled(`repos/${nameWithOwner}/vulnerability-alerts`),
    securityUpdates: endpointEnabled(`repos/${nameWithOwner}/automated-security-fixes`),
    workflows:
      optionalJson(`repos/${nameWithOwner}/actions/workflows?per_page=100`)?.workflows ?? [],
    releaseEnvironment: optionalJson(`repos/${nameWithOwner}/environments/release`),
  };
}

function main() {
  const state = loadRemoteState();
  const errors = evaluateGitHubGovernance(state);
  if (errors.length) {
    console.error(`FAIL GitHub governance (${state.nameWithOwner})`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS GitHub governance (${state.nameWithOwner})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
