import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGitHubGovernance, loadPaginatedCollection, securityUpdatesState } from "../github-governance-check.mjs";
import { createGitHubReader } from "../main-push-github.mjs";
import { catalogFixture } from "./main-push-fixtures.mjs";

function passingState(phase = "retiring") {
  return {
    catalog: catalogFixture(phase), defaultBranch: "main", branches: [{ name: "main" }],
    rulesets: [{ target: "branch", enforcement: "active", bypass_actors: [],
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      rules: ["creation", "deletion", "non_fast_forward"].map((type) => ({ type })) }],
    dependabotAlerts: "enabled", securityUpdates: "disabled", secretScanning: "enabled", pushProtection: "enabled",
    workflows: [
      ["CI", "ci"], ["Release gate", "release-gate"], ["Security audit", "security-audit"],
      ["Weekly resilience", "weekly-resilience"], ...(phase === "retiring" ? [["Trusted policy", "trusted-policy"]] : []),
    ].map(([name, file]) => ({ name, path: `.github/workflows/${file}.yml`, state: "active" })),
    releaseEnvironment: { can_admins_bypass: false, protection_rules: [{ type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { login: "xrevoman-hu" } }] }] },
  };
}
const errors = (mutate, phase) => { const state = passingState(phase); mutate(state); return evaluateGitHubGovernance(state); };

test("accepts an active main ruleset with every required protection", () => {
  assert.deepEqual(evaluateGitHubGovernance(passingState()), []);
  assert.deepEqual(evaluateGitHubGovernance(passingState("retired")), []);
});

test("reports every missing remote control", () => {
  const result = evaluateGitHubGovernance({ catalog: catalogFixture(), defaultBranch: "main", rulesets: [], workflows: [] });
  for (const text of ["branches must be exactly main", "no active ruleset", "Dependabot alerts", "security updates",
    "secret scanning must", "push protection", "active CI", "active Release gate", "active Security audit",
    "active Weekly resilience", "active Trusted policy", "required reviewer", "admin bypass"]) {
    assert.ok(result.some((value) => value.includes(text)), text);
  }
});

test("does not accept a ruleset whose exclusions can remove main", () => {
  for (const include of [["refs/heads/main"], ["~DEFAULT_BRANCH"], ["~ALL", "refs/heads/main"]]) {
    assert.ok(errors((state) => { state.rulesets[0].conditions.ref_name.include = include; }).length);
  }
  assert.ok(errors((state) => { state.rulesets[0].conditions.ref_name.exclude = ["refs/heads/main"]; }).length);
});

test("the repository default branch must remain main for trusted policy", () => {
  assert.ok(errors((state) => { state.defaultBranch = "trunk"; }).some((error) => error.includes("default branch")));
  assert.ok(errors((state) => { state.branches.push({ name: "bot/update" }); }).some((error) => error.includes("exactly main")));
});

test("a second active branch ruleset cannot hide stacked main requirements", () => {
  assert.deepEqual(errors((state) => { state.rulesets.push(structuredClone(state.rulesets[0])); }),
    ["repository must have exactly one active branch ruleset; found 2"]);
});

test("an explicit main condition does not make a tag ruleset a branch protection", () => {
  assert.ok(errors((state) => { state.rulesets[0].target = "tag"; }).some((error) => error.includes("no active ruleset")));
});

test("main ruleset bypass actors must be explicitly present and empty", () => {
  assert.ok(errors((state) => { delete state.rulesets[0].bypass_actors; }).some((error) => error.includes("bypass")));
  assert.ok(errors((state) => { state.rulesets[0].bypass_actors.push({ actor_id: 1 }); }).some((error) => error.includes("bypass")));
});

test("main remains mergeable for one maintainer and has no stale or duplicate required checks", () => {
  for (const type of ["pull_request", "required_status_checks", "update", "required_signatures", "deletion"]) {
    assert.ok(errors((state) => { state.rulesets[0].rules.push({ type }); }).some((error) => error.includes("must contain only")), type);
  }
  for (const type of ["creation", "deletion", "non_fast_forward"]) {
    assert.ok(errors((state) => { state.rulesets[0].rules = state.rulesets[0].rules.filter((rule) => rule.type !== type); }).length, type);
  }
});

test("main ruleset cannot re-enable unattributed-change approval drift", () => {
  for (const enabled of [false, true]) {
    assert.ok(errors((state) => { state.rulesets[0].rules.push({ type: "pull_request",
      parameters: { required_approving_review_count: 0, require_extra_approval_for_unattributed_changes: enabled } }); }).length);
  }
});

test("main-only phases cannot mix transitional and final workflows", () => {
  assert.ok(errors((state) => { state.workflows.pop(); }).some((error) => error.includes("Trusted policy")));
  assert.ok(errors((state) => { state.workflows.push({ name: "Trusted policy", path: ".github/workflows/trusted-policy.yml", state: "active" }); }, "retired").length);
  assert.ok(errors((state) => { state.catalog.gates[0].status = "retired"; }).some((error) => error.includes("policy phase")));
});

test("security update disabled state never collapses API failure into success", () => {
  for (const response of [{ status: 404 }, { status: 403 }, { status: 429 }, { status: 200, body: {} }]) {
    assert.equal(securityUpdatesState(response), "unknown");
  }
  assert.equal(securityUpdatesState({ status: 200, body: { enabled: false } }), "disabled");
  assert.equal(securityUpdatesState({ status: 200, body: { enabled: true } }), "enabled");
  for (const state of ["enabled", "unknown", undefined]) {
    assert.ok(errors((value) => { value.securityUpdates = state; }).length);
  }
});

test("release Environment must explicitly disable admin bypass", () => {
  for (const state of [true, undefined]) assert.ok(errors((value) => { value.releaseEnvironment.can_admins_bypass = state; }).length);
});

test("release Environment cannot substitute another user or team reviewer", () => {
  assert.ok(errors((state) => { state.releaseEnvironment.protection_rules[0].reviewers[0].reviewer.login = "someone-else"; }).length);
  assert.ok(errors((state) => { state.releaseEnvironment.protection_rules[0].reviewers[0].type = "Team"; }).length);
});

test("every required workflow must exist at its exact path and be active", () => {
  assert.ok(errors((state) => { state.workflows[0].state = "disabled_manually"; }).some((error) => error.includes("active CI")));
  assert.ok(errors((state) => { state.workflows.push({ ...state.workflows[0] }); }).some((error) => error.includes("duplicated")));
});

test("unregistered active workflows cannot publish releases or spoof required checks", () => {
  assert.deepEqual(errors((state) => { state.workflows.push({ name: "Backdoor release", path: ".github/workflows/backdoor.yml", state: "active" }); }),
    ["unregistered active workflow can bypass governance: Backdoor release (.github/workflows/backdoor.yml)"]);
});

test("GitHub-managed Dependabot workflow is outside the repository workflow allowlist", () => {
  assert.deepEqual(errors((state) => { state.workflows.push({ name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates", state: "active" }); }), []);
});

test("an unknown dynamic workflow cannot hide outside the repository workflow allowlist", () => {
  assert.ok(errors((state) => { state.workflows.push({ name: "Unknown managed workflow", path: "dynamic/unknown/workflow", state: "active" }); }).length);
});

test("an active workflow with an unverifiable path fails closed", () => {
  assert.ok(errors((state) => { state.workflows.push({ name: "Malformed workflow", state: "active" }); }).some((error) => error.includes("missing-path")));
});

test("a workflow with a missing or unknown state fails closed", () => {
  for (const value of [undefined, "disabled_future"]) {
    assert.ok(errors((state) => { state.workflows.push({ name: "Unknown", state: value }); }).some((error) => error.includes("state cannot be verified")));
  }
});

test("known inactive workflows remain outside the active workflow allowlist", () => {
  for (const value of ["deleted", "disabled_fork", "disabled_inactivity", "disabled_manually"]) {
    assert.deepEqual(errors((state) => { state.workflows.push({ name: "Historical", path: "dynamic/old", state: value }); }), []);
  }
});

test("remote rulesets and workflows are flattened across every GitHub API page", () => {
  const endpoint = "repos/example/project/actions/workflows";
  const request = (url) => url.endsWith("page=1") ? { status: 200,
    headers: { link: `<https://api.github.com/${endpoint}?per_page=100&page=2>; rel="next"` },
    body: { total_count: 101, workflows: Array.from({ length: 100 }, (_, id) => ({ id })) } }
    : { status: 200, headers: {}, body: { total_count: 101, workflows: [{ id: 100 }] } };
  assert.equal(loadPaginatedCollection(endpoint, { itemKey: "workflows", reader: createGitHubReader({ request }) }).length, 101);
});
