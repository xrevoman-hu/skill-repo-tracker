#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createGitHubReader, EXPECTED_REPOSITORY } from "./main-push-github.mjs";
import { policyRemovalPhase } from "./governance-policy-removal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_WORKFLOWS = [
  ["CI", ".github/workflows/ci.yml"],
  ["Release gate", ".github/workflows/release-gate.yml"],
  ["Security audit", ".github/workflows/security-audit.yml"],
  ["Weekly resilience", ".github/workflows/weekly-resilience.yml"],
];
const TRUSTED = ["Trusted policy", ".github/workflows/trusted-policy.yml"];
const MANAGED = ["Dependabot Updates", "dynamic/dependabot/dependabot-updates"];
const INACTIVE = new Set(["deleted", "disabled_fork", "disabled_inactivity", "disabled_manually"]);

export function evaluateGitHubGovernance({ defaultBranch, rulesets, branches, dependabotAlerts,
  securityUpdates, secretScanning, pushProtection, workflows, releaseEnvironment, catalog }) {
  const errors = [];
  let phase;
  try { phase = policyRemovalPhase(catalog); }
  catch { errors.push("main-only policy phase is invalid or cannot be verified"); }
  if (defaultBranch !== "main") errors.push("repository default branch must be exactly main");
  if (!Array.isArray(branches) || branches.length !== 1 || branches[0]?.name !== "main") {
    errors.push("repository branches must be exactly main");
  }
  const active = (Array.isArray(rulesets) ? rulesets : []).filter(
    (entry) => entry.target === "branch" && entry.enforcement === "active",
  );
  if (active.length > 1) errors.push(`repository must have exactly one active branch ruleset; found ${active.length}`);
  const ruleset = active.length === 1 ? active[0] : undefined;
  if (active.length === 0 || (ruleset && !isDeepStrictEqual(ruleset.conditions,
    { ref_name: { include: ["~ALL"], exclude: [] } }))) errors.push("no active ruleset protects all branches without exclusions");
  if (ruleset) {
    if (!Array.isArray(ruleset.bypass_actors)) errors.push("main ruleset bypass actors are missing or cannot be verified");
    else if (ruleset.bypass_actors.length) errors.push("main ruleset has bypass actors");
    const rules = ruleset.rules;
    const expected = ["creation", "deletion", "non_fast_forward"];
    if (!Array.isArray(rules) || rules.length !== 3 || expected.some((type) =>
      rules.filter((rule) => isDeepStrictEqual(rule, { type })).length !== 1)) {
      errors.push("main ruleset must contain only creation, deletion and non_fast_forward without parameters");
    }
  }
  if (dependabotAlerts !== "enabled") errors.push("Dependabot alerts are not enabled or cannot be verified");
  if (securityUpdates !== "disabled") errors.push("Dependabot security updates must be explicitly disabled");
  if (secretScanning !== "enabled") errors.push("secret scanning must remain enabled");
  if (pushProtection !== "enabled") errors.push("secret scanning push protection must remain enabled");
  const required = [...REQUIRED_WORKFLOWS, ...(phase === "retiring" ? [TRUSTED] : [])];
  for (const [name, path] of required) {
    const matches = (workflows ?? []).filter((workflow) => workflow.name === name && workflow.path === path && workflow.state === "active");
    if (matches.length !== 1) errors.push(`active ${name} workflow is missing or duplicated`);
  }
  const registered = new Set([...required, MANAGED].map(([name, path]) => `${name}\0${path}`));
  for (const workflow of workflows ?? []) {
    if (workflow?.state !== "active" && !INACTIVE.has(workflow?.state)) {
      errors.push(`workflow state cannot be verified: ${workflow?.name ?? "missing-name"} (${workflow?.state ?? "missing-state"})`);
    } else if (workflow.state === "active" && !registered.has(`${workflow.name}\0${workflow.path}`)) {
      errors.push(`unregistered active workflow can bypass governance: ${workflow.name ?? "missing-name"} (${workflow.path ?? "missing-path"})`);
    }
  }
  const reviewerRules = releaseEnvironment?.protection_rules?.filter((rule) => rule.type === "required_reviewers");
  const reviewers = reviewerRules?.[0]?.reviewers;
  if (reviewerRules?.length !== 1 || reviewers?.length !== 1 || reviewers[0]?.type !== "User"
      || reviewers[0]?.reviewer?.login !== "xrevoman-hu") {
    errors.push("release Environment required reviewer must be exactly xrevoman-hu");
  }
  if (releaseEnvironment?.can_admins_bypass !== false) errors.push("release Environment allows admin bypass or cannot be verified");
  return errors;
}

export function securityUpdatesState(response) {
  if (response?.status !== 200 || typeof response.body?.enabled !== "boolean") return "unknown";
  return response.body.enabled ? "enabled" : "disabled";
}

export function loadPaginatedCollection(endpoint, { itemKey, reader = createGitHubReader({ root: ROOT }) } = {}) {
  return reader.collection(endpoint, itemKey);
}

function loadRemoteState() {
  const nameWithOwner = EXPECTED_REPOSITORY;
  const reader = createGitHubReader({ root: ROOT });
  const base = `repos/${nameWithOwner}`;
  const repository = reader.get(base);
  if (repository?.full_name !== nameWithOwner) throw new Error("repository identity changed");
  reader.bindRepository(nameWithOwner, repository.id);
  const summaries = loadPaginatedCollection(`${base}/rulesets`, { reader });
  const rulesets = summaries.map((summary) => {
    if (!Number.isSafeInteger(summary.id) || summary.id < 1) throw new Error("invalid ruleset identity");
    const detail = reader.get(`${base}/rulesets/${summary.id}`);
    if (detail?.id !== summary.id) throw new Error("ruleset identity changed");
    return detail;
  });
  return {
    nameWithOwner, defaultBranch: repository.default_branch, rulesets,
    branches: loadPaginatedCollection(`${base}/branches`, { reader }),
    dependabotAlerts: reader.response(`${base}/vulnerability-alerts`).status === 204 ? "enabled" : "unknown",
    securityUpdates: securityUpdatesState(reader.response(`${base}/automated-security-fixes`)),
    secretScanning: repository.security_and_analysis?.secret_scanning?.status,
    pushProtection: repository.security_and_analysis?.secret_scanning_push_protection?.status,
    workflows: loadPaginatedCollection(`${base}/actions/workflows`, { itemKey: "workflows", reader }),
    releaseEnvironment: reader.get(`${base}/environments/release`),
    catalog: JSON.parse(readFileSync(resolve(ROOT, "docs/engineering/governance-assets.json"), "utf8")),
  };
}

function main() {
  const state = loadRemoteState();
  const errors = evaluateGitHubGovernance(state);
  if (errors.length) {
    console.error(`FAIL GitHub governance (${state.nameWithOwner})`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log(`PASS GitHub governance (${state.nameWithOwner}) phase=${policyRemovalPhase(state.catalog)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "GitHub governance failed"); process.exitCode = 1;
  }
}
