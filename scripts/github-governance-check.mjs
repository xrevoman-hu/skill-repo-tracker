#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_CHECKS = [
  { context: "verify", label: "CI / verify" },
  { context: "coverage", label: "CI / coverage" },
  { context: "msrv", label: "CI / msrv" },
  { context: "Trusted policy / guard", label: "Trusted policy / guard" },
];
const EXPECTED_CHECK_INTEGRATION_ID = 15368;
const EXPECTED_RELEASE_REVIEWER = "xrevoman-hu";
const REQUIRED_WORKFLOWS = [
  ["CI", ".github/workflows/ci.yml"],
  ["Release gate", ".github/workflows/release-gate.yml"],
  ["Security audit", ".github/workflows/security-audit.yml"],
  ["Weekly resilience", ".github/workflows/weekly-resilience.yml"],
  ["Trusted policy", ".github/workflows/trusted-policy.yml"],
];
const ALLOWED_GITHUB_MANAGED_WORKFLOWS = [
  ["Dependabot Updates", "dynamic/dependabot/dependabot-updates"],
];
const KNOWN_INACTIVE_WORKFLOW_STATES = new Set([
  "deleted",
  "disabled_fork",
  "disabled_inactivity",
  "disabled_manually",
]);

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
  if (defaultBranch !== "main") {
    errors.push("repository default branch must be exactly main");
  }
  const activeBranchRulesets = (Array.isArray(rulesets) ? rulesets : []).filter(
    (candidate) => candidate.target === "branch" && candidate.enforcement === "active",
  );
  const hasSingleActiveBranchRuleset = activeBranchRulesets.length === 1;
  if (activeBranchRulesets.length > 1) {
    errors.push(
      `repository must have exactly one active branch ruleset; found ${activeBranchRulesets.length}`,
    );
  }
  const ruleset = hasSingleActiveBranchRuleset ? activeBranchRulesets[0] : undefined;
  if (activeBranchRulesets.length === 0 || (ruleset && !protectsMain(ruleset, defaultBranch))) {
    errors.push("no active ruleset protects main");
  } else if (ruleset) {
    const rules = ruleset.rules ?? [];
    const pullRequestRule = rules.find((rule) => rule.type === "pull_request");
    if (!pullRequestRule) {
      errors.push("main ruleset does not require pull requests");
    } else {
      if (pullRequestRule.parameters?.required_approving_review_count !== 0) {
        errors.push("main ruleset pull request approvals must be exactly 0");
      }
      if (
        pullRequestRule.parameters
          ?.require_extra_approval_for_unattributed_changes !== false
      ) {
        errors.push("main ruleset must disable extra approval for unattributed changes");
      }
    }
    const statusRule = rules.find((rule) => rule.type === "required_status_checks");
    const configuredChecks = statusRule?.parameters?.required_status_checks ?? [];
    const checksByContext = new Map(
      configuredChecks.map((check) => [check.context, check]),
    );
    for (const check of REQUIRED_CHECKS) {
      const configured = checksByContext.get(check.context);
      if (!configured) {
        errors.push(`main ruleset is missing required check: ${check.label}`);
      } else if (configured.integration_id !== EXPECTED_CHECK_INTEGRATION_ID) {
        errors.push(
          `main ruleset required check ${check.label} must be bound to GitHub Actions integration ${EXPECTED_CHECK_INTEGRATION_ID}`,
        );
      }
    }
    const requiredContexts = new Set(REQUIRED_CHECKS.map((check) => check.context));
    const seenContexts = new Set();
    for (const configured of configuredChecks) {
      if (seenContexts.has(configured.context)) {
        errors.push(`main ruleset has duplicate required check: ${configured.context}`);
      } else if (!requiredContexts.has(configured.context)) {
        errors.push(`main ruleset has unexpected required check: ${configured.context}`);
      }
      seenContexts.add(configured.context);
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
  const registeredWorkflows = new Set(
    [...REQUIRED_WORKFLOWS, ...ALLOWED_GITHUB_MANAGED_WORKFLOWS].map(
      ([name, path]) => `${name}\0${path}`,
    ),
  );
  for (const workflow of workflows ?? []) {
    const state = workflow?.state;
    if (state !== "active" && !KNOWN_INACTIVE_WORKFLOW_STATES.has(state)) {
      errors.push(
        `workflow state cannot be verified: ${workflow?.name ?? "missing-name"} (${state ?? "missing-state"})`,
      );
    } else if (
      state === "active" &&
      !registeredWorkflows.has(`${workflow?.name}\0${workflow?.path}`)
    ) {
      errors.push(
        `unregistered active workflow can bypass governance: ${workflow?.name ?? "missing-name"} (${workflow?.path ?? "missing-path"})`,
      );
    }
  }
  const requiredReviewerRule = releaseEnvironment?.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  const reviewers = requiredReviewerRule?.reviewers;
  const hasExactReviewer =
    Array.isArray(reviewers) &&
    reviewers.length === 1 &&
    reviewers[0]?.type === "User" &&
    reviewers[0]?.reviewer?.login === EXPECTED_RELEASE_REVIEWER;
  if (!hasExactReviewer) {
    errors.push(
      `release Environment required reviewer must be exactly ${EXPECTED_RELEASE_REVIEWER}`,
    );
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

export function loadPaginatedCollection(
  endpoint,
  { itemKey, runGh = gh } = {},
) {
  if (typeof endpoint !== "string" || !endpoint) {
    throw new Error("paginated GitHub endpoint must be a non-empty string");
  }
  const separator = endpoint.includes("?") ? "&" : "?";
  const paginatedEndpoint = `${endpoint}${separator}per_page=100`;
  const pages = JSON.parse(
    runGh(["api", "--paginate", "--slurp", paginatedEndpoint], { quiet: true }),
  );
  if (!Array.isArray(pages)) {
    throw new Error(`paginated GitHub response must be an array: ${endpoint}`);
  }
  return pages.flatMap((page, index) => {
    const items = itemKey === undefined ? page : page?.[itemKey];
    if (!Array.isArray(items)) {
      throw new Error(
        `paginated GitHub response page ${index + 1} has no ${itemKey ?? "array"}: ${endpoint}`,
      );
    }
    return items;
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
  const summaries = loadPaginatedCollection(`repos/${nameWithOwner}/rulesets`);
  const rulesets = summaries.map((summary) =>
    JSON.parse(gh(["api", `repos/${nameWithOwner}/rulesets/${summary.id}`])),
  );
  return {
    nameWithOwner,
    defaultBranch: repository.defaultBranchRef?.name,
    rulesets,
    dependabotAlerts: endpointEnabled(`repos/${nameWithOwner}/vulnerability-alerts`),
    securityUpdates: endpointEnabled(`repos/${nameWithOwner}/automated-security-fixes`),
    workflows: loadPaginatedCollection(`repos/${nameWithOwner}/actions/workflows`, {
      itemKey: "workflows",
    }),
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
