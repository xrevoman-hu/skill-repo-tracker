import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGitHubGovernance } from "../github-governance-check.mjs";

test("accepts an active main ruleset with every required protection", () => {
  assert.deepEqual(
    evaluateGitHubGovernance({
      defaultBranch: "main",
      rulesets: [
        {
          name: "protect-main",
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["refs/heads/main"] } },
          bypass_actors: [],
          rules: [
            { type: "pull_request" },
            {
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: [
                  { context: "verify" },
                  { context: "coverage" },
                  { context: "msrv" },
                ],
              },
            },
            { type: "non_fast_forward" },
            { type: "deletion" },
          ],
        },
      ],
      dependabotAlerts: true,
      securityUpdates: true,
      workflows: [
        { name: "CI", path: ".github/workflows/ci.yml", state: "active" },
        {
          name: "Release gate",
          path: ".github/workflows/release-gate.yml",
          state: "active",
        },
        {
          name: "Security audit",
          path: ".github/workflows/security-audit.yml",
          state: "active",
        },
        {
          name: "Weekly resilience",
          path: ".github/workflows/weekly-resilience.yml",
          state: "active",
        },
      ],
      releaseEnvironment: {
        can_admins_bypass: false,
        protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
      },
    }),
    [],
  );
});

test("reports every missing remote control", () => {
  assert.deepEqual(
    evaluateGitHubGovernance({
      defaultBranch: "main",
      rulesets: [],
      dependabotAlerts: false,
      securityUpdates: false,
      workflows: [],
      releaseEnvironment: undefined,
    }),
    [
      "no active ruleset protects main",
      "Dependabot alerts are not enabled or cannot be verified",
      "Dependabot security updates are not enabled or cannot be verified",
      "active CI workflow is missing",
      "active Release gate workflow is missing",
      "active Security audit workflow is missing",
      "active Weekly resilience workflow is missing",
      "release Environment has no required reviewer or cannot be verified",
      "release Environment allows admin bypass or cannot be verified",
    ],
  );
});

test("does not accept a ruleset whose exclusions can remove main", () => {
  const errors = evaluateGitHubGovernance({
    defaultBranch: "main",
    rulesets: [
      {
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: {
            include: ["~DEFAULT_BRANCH"],
            exclude: ["refs/heads/main"],
          },
        },
        rules: [],
      },
    ],
    dependabotAlerts: true,
    securityUpdates: true,
    workflows: [
      { name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { name: "Release gate", path: ".github/workflows/release-gate.yml", state: "active" },
      {
        name: "Security audit",
        path: ".github/workflows/security-audit.yml",
        state: "active",
      },
      {
        name: "Weekly resilience",
        path: ".github/workflows/weekly-resilience.yml",
        state: "active",
      },
    ],
    releaseEnvironment: {
      can_admins_bypass: false,
      protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
    },
  });

  assert.deepEqual(errors, ["no active ruleset protects main"]);
});

function passingState(overrides = {}) {
  return {
    defaultBranch: "main",
    rulesets: [
      {
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        bypass_actors: [],
        rules: [
          { type: "pull_request" },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "verify" },
                { context: "coverage" },
                { context: "msrv" },
              ],
            },
          },
          { type: "non_fast_forward" },
          { type: "deletion" },
        ],
      },
    ],
    dependabotAlerts: true,
    securityUpdates: true,
    workflows: [
      { name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { name: "Release gate", path: ".github/workflows/release-gate.yml", state: "active" },
      {
        name: "Security audit",
        path: ".github/workflows/security-audit.yml",
        state: "active",
      },
      {
        name: "Weekly resilience",
        path: ".github/workflows/weekly-resilience.yml",
        state: "active",
      },
    ],
    releaseEnvironment: {
      can_admins_bypass: false,
      protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
    },
    ...overrides,
  };
}

test("DEFAULT_BRANCH rules protect main only when the live default branch is main", () => {
  assert.deepEqual(evaluateGitHubGovernance(passingState()), []);
  assert.deepEqual(evaluateGitHubGovernance(passingState({ defaultBranch: "trunk" })), [
    "no active ruleset protects main",
  ]);
  assert.deepEqual(evaluateGitHubGovernance(passingState({ defaultBranch: undefined })), [
    "no active ruleset protects main",
  ]);

  const explicitMain = passingState({ defaultBranch: "trunk" });
  explicitMain.rulesets[0].conditions.ref_name.include = ["refs/heads/main"];
  assert.deepEqual(evaluateGitHubGovernance(explicitMain), []);
});

test("an explicit main condition does not make a tag ruleset a branch protection", () => {
  const state = passingState();
  state.rulesets[0].target = "tag";
  state.rulesets[0].conditions.ref_name.include = ["refs/heads/main"];
  assert.deepEqual(evaluateGitHubGovernance(state), ["no active ruleset protects main"]);
});

test("main ruleset bypass actors must be explicitly present and empty", () => {
  const missing = passingState();
  delete missing.rulesets[0].bypass_actors;
  assert.deepEqual(evaluateGitHubGovernance(missing), [
    "main ruleset bypass actors are missing or cannot be verified",
  ]);

  const configured = passingState();
  configured.rulesets[0].bypass_actors = [{ actor_id: 1 }];
  assert.deepEqual(evaluateGitHubGovernance(configured), [
    "main ruleset has bypass actors; direct main changes are still possible",
  ]);
});

test("required checks use Check Run contexts rather than workflow display labels", () => {
  const state = passingState();
  const statusRule = state.rulesets[0].rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  statusRule.parameters.required_status_checks = [
    { context: "CI / verify" },
    { context: "CI / coverage" },
    { context: "CI / msrv" },
  ];

  assert.deepEqual(evaluateGitHubGovernance(state), [
    "main ruleset is missing required check: CI / verify",
    "main ruleset is missing required check: CI / coverage",
    "main ruleset is missing required check: CI / msrv",
  ]);
});

test("release Environment must explicitly disable admin bypass", () => {
  const missing = passingState();
  delete missing.releaseEnvironment.can_admins_bypass;
  assert.deepEqual(evaluateGitHubGovernance(missing), [
    "release Environment allows admin bypass or cannot be verified",
  ]);

  const enabled = passingState();
  enabled.releaseEnvironment.can_admins_bypass = true;
  assert.deepEqual(evaluateGitHubGovernance(enabled), [
    "release Environment allows admin bypass or cannot be verified",
  ]);
});

test("every required workflow must exist at its exact path and be active", () => {
  const state = passingState();
  state.workflows = state.workflows.filter((workflow) => workflow.name !== "Security audit");
  assert.deepEqual(evaluateGitHubGovernance(state), [
    "active Security audit workflow is missing",
  ]);
});
