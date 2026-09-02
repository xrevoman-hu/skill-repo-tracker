import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGitHubGovernance,
  loadPaginatedCollection,
} from "../github-governance-check.mjs";

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
            { type: "pull_request", parameters: { required_approving_review_count: 0 } },
            {
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: [
                  { context: "verify", integration_id: 15368 },
                  { context: "coverage", integration_id: 15368 },
                  { context: "msrv", integration_id: 15368 },
                  { context: "Trusted policy / guard", integration_id: 15368 },
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
        {
          name: "Trusted policy",
          path: ".github/workflows/trusted-policy.yml",
          state: "active",
        },
      ],
      releaseEnvironment: {
        can_admins_bypass: false,
        protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "xrevoman-hu" } }] }],
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
      "active Trusted policy workflow is missing",
      "release Environment required reviewer must be exactly xrevoman-hu",
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
      {
        name: "Trusted policy",
        path: ".github/workflows/trusted-policy.yml",
        state: "active",
      },
    ],
    releaseEnvironment: {
      can_admins_bypass: false,
      protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "xrevoman-hu" } }] }],
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
          { type: "pull_request", parameters: { required_approving_review_count: 0 } },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "verify", integration_id: 15368 },
                { context: "coverage", integration_id: 15368 },
                { context: "msrv", integration_id: 15368 },
                { context: "Trusted policy / guard", integration_id: 15368 },
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
      {
        name: "Trusted policy",
        path: ".github/workflows/trusted-policy.yml",
        state: "active",
      },
    ],
    releaseEnvironment: {
      can_admins_bypass: false,
      protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "xrevoman-hu" } }] }],
    },
    ...overrides,
  };
}

test("the repository default branch must remain main for trusted policy", () => {
  assert.deepEqual(evaluateGitHubGovernance(passingState()), []);
  assert.deepEqual(evaluateGitHubGovernance(passingState({ defaultBranch: "trunk" })), [
    "repository default branch must be exactly main",
    "no active ruleset protects main",
  ]);
  assert.deepEqual(evaluateGitHubGovernance(passingState({ defaultBranch: undefined })), [
    "repository default branch must be exactly main",
    "no active ruleset protects main",
  ]);

  const explicitMain = passingState({ defaultBranch: "trunk" });
  explicitMain.rulesets[0].conditions.ref_name.include = ["refs/heads/main"];
  assert.deepEqual(evaluateGitHubGovernance(explicitMain), [
    "repository default branch must be exactly main",
  ]);
});

test("a second active branch ruleset cannot hide stacked main requirements", () => {
  const state = passingState();
  state.rulesets.push({
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: "stale-never-produced", integration_id: 15368 },
          ],
        },
      },
    ],
  });

  assert.deepEqual(evaluateGitHubGovernance(state), [
    "repository must have exactly one active branch ruleset; found 2",
  ]);
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
    { context: "CI / verify", integration_id: 15368 },
    { context: "CI / coverage", integration_id: 15368 },
    { context: "CI / msrv", integration_id: 15368 },
    { context: "Trusted policy / guard", integration_id: 15368 },
  ];

  assert.deepEqual(evaluateGitHubGovernance(state), [
    "main ruleset is missing required check: CI / verify",
    "main ruleset is missing required check: CI / coverage",
    "main ruleset is missing required check: CI / msrv",
    "main ruleset has unexpected required check: CI / verify",
    "main ruleset has unexpected required check: CI / coverage",
    "main ruleset has unexpected required check: CI / msrv",
  ]);
});

test("main remains mergeable for one maintainer and has no stale or duplicate required checks", () => {
  const state = passingState();
  const pullRequestRule = state.rulesets[0].rules.find(
    (rule) => rule.type === "pull_request",
  );
  pullRequestRule.parameters.required_approving_review_count = 1;
  const statusRule = state.rulesets[0].rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  statusRule.parameters.required_status_checks.push(
    { context: "stale-never-produced", integration_id: 15368 },
    { context: "verify", integration_id: 15368 },
  );

  assert.deepEqual(evaluateGitHubGovernance(state), [
    "main ruleset pull request approvals must be exactly 0",
    "main ruleset has unexpected required check: stale-never-produced",
    "main ruleset has duplicate required check: verify",
  ]);
});

test("trusted policy head check is required by its exact Check Run name", () => {
  const state = passingState();
  const statusRule = state.rulesets[0].rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  statusRule.parameters.required_status_checks =
    statusRule.parameters.required_status_checks.filter(
      (check) => check.context !== "Trusted policy / guard",
    );

  assert.deepEqual(evaluateGitHubGovernance(state), [
    "main ruleset is missing required check: Trusted policy / guard",
  ]);
});

test("required checks must be bound to an explicit GitHub integration", () => {
  const state = passingState();
  const statusRule = state.rulesets[0].rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  delete statusRule.parameters.required_status_checks[3].integration_id;

  assert.deepEqual(evaluateGitHubGovernance(state), [
    "main ruleset required check Trusted policy / guard must be bound to GitHub Actions integration 15368",
  ]);
});

test("required checks reject a different positive integration id", () => {
  const state = passingState();
  const statusRule = state.rulesets[0].rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  statusRule.parameters.required_status_checks[0].integration_id = 1;
  assert.deepEqual(evaluateGitHubGovernance(state), [
    "main ruleset required check CI / verify must be bound to GitHub Actions integration 15368",
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

test("release Environment cannot substitute another user or team reviewer", () => {
  const wrongUser = passingState();
  wrongUser.releaseEnvironment.protection_rules[0].reviewers = [
    { type: "User", reviewer: { login: "someone-else" } },
  ];
  assert.deepEqual(evaluateGitHubGovernance(wrongUser), [
    "release Environment required reviewer must be exactly xrevoman-hu",
  ]);

  const team = passingState();
  team.releaseEnvironment.protection_rules[0].reviewers = [
    { type: "Team", reviewer: { slug: "release-team" } },
  ];
  assert.deepEqual(evaluateGitHubGovernance(team), [
    "release Environment required reviewer must be exactly xrevoman-hu",
  ]);
});

test("every required workflow must exist at its exact path and be active", () => {
  const state = passingState();
  state.workflows = state.workflows.filter((workflow) => workflow.name !== "Security audit");
  assert.deepEqual(evaluateGitHubGovernance(state), [
    "active Security audit workflow is missing",
  ]);
});

test("unregistered active workflows cannot publish releases or spoof required checks", () => {
  const state = passingState();
  state.workflows.push({
    name: "Backdoor release",
    path: ".github/workflows/backdoor.yml",
    state: "active",
  });
  assert.deepEqual(evaluateGitHubGovernance(state), [
    "unregistered active workflow can bypass governance: Backdoor release (.github/workflows/backdoor.yml)",
  ]);
});

test("remote rulesets and workflows are flattened across every GitHub API page", () => {
  const calls = [];
  const pagesByEndpoint = new Map([
    [
      "repos/example/project/rulesets?per_page=100",
      [
        Array.from({ length: 30 }, (_, index) => ({ id: index + 1 })),
        [{ id: 31 }],
      ],
    ],
    [
      "repos/example/project/actions/workflows?per_page=100",
      [
        { workflows: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) },
        { workflows: [{ id: 101 }] },
      ],
    ],
  ]);
  const runGh = (args) => {
    calls.push(args);
    return JSON.stringify(pagesByEndpoint.get(args.at(-1)));
  };

  assert.equal(
    loadPaginatedCollection("repos/example/project/rulesets", { runGh }).length,
    31,
  );
  assert.equal(
    loadPaginatedCollection("repos/example/project/actions/workflows", {
      itemKey: "workflows",
      runGh,
    }).length,
    101,
  );
  assert.deepEqual(calls, [
    ["api", "--paginate", "--slurp", "repos/example/project/rulesets?per_page=100"],
    [
      "api",
      "--paginate",
      "--slurp",
      "repos/example/project/actions/workflows?per_page=100",
    ],
  ]);
});
