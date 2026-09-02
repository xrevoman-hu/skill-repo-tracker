import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  CHECK_NAME,
  evaluateTrustedPolicy,
  extractTrustedGovernanceEvidencePaths,
  isCriticalGovernancePath,
  runTrustedPolicyCheck,
} from "../trusted-policy-guard.mjs";

const ROOT = new URL("../../", import.meta.url);
const HEAD_SHA = "a".repeat(40);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(options) {
  return options?.body ? JSON.parse(options.body) : undefined;
}

function trustedCatalog() {
  return {
    schemaVersion: 1,
    assets: [
      {
        id: "active-policy",
        status: "active",
        enforcement: {
          evidence: [
            {
              path: "src/taskCoordinator.test.ts",
              selector: "late results cannot overwrite a newer generation",
            },
          ],
        },
      },
      {
        id: "superseded-policy",
        status: "superseded",
        enforcement: {
          evidence: [
            {
              path: "src/obsolete-policy.test.ts",
              selector: "obsolete evidence",
            },
          ],
        },
      },
    ],
    invariants: [
      {
        id: "ACTIVE-001",
        status: "active",
        evidence: [
          {
            path: "src-tauri/src/database.rs",
            selector: "inline_database_invariant",
          },
        ],
      },
      {
        id: "RETIRING-001",
        status: "retiring",
        evidence: [
          {
            path: "e2e/retiring-invariant.spec.ts",
            selector: "retiring invariant remains enforced",
          },
        ],
      },
      {
        id: "RETIRED-001",
        status: "retired",
        evidence: [
          {
            path: "e2e/retired-invariant.spec.ts",
            selector: "retired evidence",
          },
        ],
      },
    ],
  };
}

test("trusted governance catalog extracts only live evidence paths and rejects dangerous paths", () => {
  assert.deepEqual(
    extractTrustedGovernanceEvidencePaths(JSON.stringify(trustedCatalog())),
    [
      "e2e/retiring-invariant.spec.ts",
      "src-tauri/src/database.rs",
      "src/taskCoordinator.test.ts",
    ],
  );

  for (const path of [
    "../src/taskCoordinator.test.ts",
    "src\\taskCoordinator.test.ts",
    "src/taskCoordinator.test.ts\n.github/workflows/ci.yml",
  ]) {
    const catalog = trustedCatalog();
    catalog.assets[0].enforcement.evidence[0].path = path;
    assert.throws(
      () => extractTrustedGovernanceEvidencePaths(JSON.stringify(catalog)),
      /invalid evidence path/,
      path,
    );
  }
  assert.throws(
    () => extractTrustedGovernanceEvidencePaths("not json"),
    /not valid JSON/,
  );
  assert.throws(
    () => extractTrustedGovernanceEvidencePaths(JSON.stringify({ schemaVersion: 1 })),
    /assets must be an array/,
  );
});

test("governance evidence assertion changes require a fresh governance-reviewed label", () => {
  const selector = "does not publish a late result after its generation is invalidated";
  const original = readFileSync(new URL("src/taskCoordinator.test.ts", ROOT), "utf8");
  const assertionNeutered = original.replace(
    'expect(applied).toEqual(["current"]);',
    "expect(true).toBe(true);",
  );
  assert.notEqual(assertionNeutered, original);
  assert.match(original, new RegExp(selector));
  assert.match(assertionNeutered, new RegExp(selector));
  assert.doesNotMatch(assertionNeutered, /expect\(applied\)\.toEqual\(\["current"\]\)/);

  const trustedEvidencePaths = extractTrustedGovernanceEvidencePaths(
    readFileSync(new URL("docs/engineering/governance-assets.json", ROOT)),
  );
  assert.equal(trustedEvidencePaths.includes("src/taskCoordinator.test.ts"), true);
  const input = {
    changedFiles: 1,
    files: [{ filename: "src/taskCoordinator.test.ts" }],
    labels: [],
    eventAction: "opened",
    trustedEvidencePaths,
  };
  assert.deepEqual(evaluateTrustedPolicy(input), {
    criticalPaths: ["src/taskCoordinator.test.ts"],
    errors: ["critical governance paths require the governance-reviewed label"],
  });
  assert.deepEqual(
    evaluateTrustedPolicy({
      ...input,
      files: [
        {
          filename: "src/renamedCoordinator.test.ts",
          previousFilename: "src/taskCoordinator.test.ts",
        },
      ],
    }),
    {
      criticalPaths: ["src/taskCoordinator.test.ts"],
      errors: ["critical governance paths require the governance-reviewed label"],
    },
  );
  assert.deepEqual(
    evaluateTrustedPolicy({
      ...input,
      labels: ["governance-reviewed"],
      eventAction: "synchronize",
    }),
    {
      criticalPaths: ["src/taskCoordinator.test.ts"],
      errors: [
        "critical governance paths changed on a new head; remove and re-add the governance-reviewed label",
      ],
    },
  );
  assert.deepEqual(
    evaluateTrustedPolicy({
      ...input,
      labels: ["governance-reviewed"],
      eventAction: "labeled",
      eventLabel: "governance-reviewed",
    }),
    { criticalPaths: ["src/taskCoordinator.test.ts"], errors: [] },
  );
});

test("ordinary product changes pass without the governance review label", () => {
  assert.deepEqual(
    evaluateTrustedPolicy({
      changedFiles: 2,
      files: [
        { filename: "src/App.tsx" },
        { filename: "src-tauri/src/lib.rs" },
      ],
      labels: [],
      eventAction: "synchronize",
    }),
    { criticalPaths: [], errors: [] },
  );
});

test("every critical governance fact source and every script is protected", () => {
  for (const path of [
    ".github/actions/setup/action.yml",
    ".github/workflows/trusted-policy.yml",
    ".cargo/config.toml",
    "src-tauri/.cargo/config.toml",
    ".npmrc",
    "CONTEXT.md",
    "CONTRIBUTING.md",
    "index.html",
    "npm-shrinkwrap.json",
    ".postcssrc.json",
    "styles/postcss.config.ts",
    "packages/hidden/npm-shrinkwrap.json",
    "public/payload.html",
    "SECURITY.md",
    "playwright.config.ts",
    "playwright.config.mts",
    "rust-toolchain",
    "scripts/trusted-policy-guard.mjs",
    "src-tauri/Cargo.toml",
    "src-tauri/build.rs",
    "src-tauri/capabilities/default.json",
    "src-tauri/permissions/custom.toml",
    "src-tauri/entitlements.plist",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.macos.conf.json",
    "src-tauri/Tauri.macos.toml",
    "vitest.workspace.ts",
    "vitest.projects.json",
    "vite.config.js",
    "docs/adr/0008-executable-governance-assets.md",
    "docs/rules/permissions.md",
    "docs/engineering/architecture.md",
    "docs/engineering/module-map.json",
    "docs/engineering/surface-budget.json",
    "docs/engineering/verify-plan.json",
    "docs/engineering/governance-assets.json",
  ]) {
    assert.equal(isCriticalGovernancePath(path), true, path);
  }
});

test("critical changes fail closed until governance-reviewed is present", () => {
  const input = {
    changedFiles: 1,
    files: [{ filename: "scripts/verify.mjs" }],
    labels: [],
    eventAction: "opened",
  };
  assert.deepEqual(evaluateTrustedPolicy(input), {
    criticalPaths: ["scripts/verify.mjs"],
    errors: [
      "critical governance paths require the governance-reviewed label",
    ],
  });
  assert.deepEqual(
    evaluateTrustedPolicy({
      ...input,
      labels: ["governance-reviewed"],
      eventAction: "labeled",
      eventLabel: "governance-reviewed",
    }),
    { criticalPaths: ["scripts/verify.mjs"], errors: [] },
  );
});

test("renaming a critical path away cannot bypass review", () => {
  assert.deepEqual(
    evaluateTrustedPolicy({
      changedFiles: 1,
      files: [
        {
          filename: "archive/old-verify.mjs",
          previousFilename: "scripts/verify.mjs",
        },
      ],
      labels: [],
      eventAction: "opened",
    }),
    {
      criticalPaths: ["scripts/verify.mjs"],
      errors: [
        "critical governance paths require the governance-reviewed label",
      ],
    },
  );
});

test("truncated or malformed API data fails closed", () => {
  assert.deepEqual(
    evaluateTrustedPolicy({
      changedFiles: 2,
      files: [{ filename: "src/App.tsx" }],
      labels: [],
      eventAction: "opened",
    }),
    {
      criticalPaths: [],
      errors: ["GitHub API returned 1 of 2 changed files"],
    },
  );
  assert.deepEqual(
    evaluateTrustedPolicy({
      changedFiles: 1,
      files: [{ filename: "src/App.tsx\n.github/workflows/ci.yml" }],
      labels: [],
      eventAction: "opened",
    }),
    {
      criticalPaths: [],
      errors: ["GitHub API returned an invalid changed filename"],
    },
  );
});

test("a new critical head invalidates a surviving review label", () => {
  const input = {
    changedFiles: 1,
    files: [{ filename: "scripts/verify.mjs" }],
    labels: ["governance-reviewed"],
  };
  assert.deepEqual(
    evaluateTrustedPolicy({ ...input, eventAction: "synchronize" }),
    {
      criticalPaths: ["scripts/verify.mjs"],
      errors: [
        "critical governance paths changed on a new head; remove and re-add the governance-reviewed label",
      ],
    },
  );
  assert.deepEqual(
    evaluateTrustedPolicy({
      ...input,
      eventAction: "labeled",
      eventLabel: "governance-reviewed",
    }),
    { criticalPaths: ["scripts/verify.mjs"], errors: [] },
  );
});

test("an unrelated label event cannot reuse a stale governance review", () => {
  assert.deepEqual(
    evaluateTrustedPolicy({
      changedFiles: 1,
      files: [{ filename: "scripts/verify.mjs" }],
      labels: ["governance-reviewed", "documentation"],
      eventAction: "labeled",
      eventLabel: "documentation",
    }),
    {
      criticalPaths: ["scripts/verify.mjs"],
      errors: [
        "critical governance paths require a fresh governance-reviewed label event on the current head",
      ],
    },
  );
});

test("reopening a critical PR cannot reuse an earlier successful review", () => {
  assert.deepEqual(
    evaluateTrustedPolicy({
      changedFiles: 1,
      files: [{ filename: "scripts/verify.mjs" }],
      labels: ["governance-reviewed"],
      eventAction: "reopened",
    }),
    {
      criticalPaths: ["scripts/verify.mjs"],
      errors: [
        "critical governance paths require a fresh governance-reviewed label event on the current head",
      ],
    },
  );
});

test("editing PR metadata or retargeting a critical PR requires a fresh review event", () => {
  assert.deepEqual(
    evaluateTrustedPolicy({
      changedFiles: 1,
      files: [{ filename: "scripts/verify.mjs" }],
      labels: ["governance-reviewed"],
      eventAction: "edited",
    }),
    {
      criticalPaths: ["scripts/verify.mjs"],
      errors: [
        "critical governance paths require a fresh governance-reviewed label event on the current head",
      ],
    },
  );
});

test("trusted default-branch script publishes success on the exact PR head", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/pulls/17")) {
      return jsonResponse({
        number: 17,
        changed_files: 1,
        head: { sha: HEAD_SHA },
        base: { ref: "main" },
        labels: [],
      });
    }
    if (String(url).includes("/pulls/17/files?")) {
      return jsonResponse([{ filename: "src/App.tsx" }]);
    }
    if (String(url).endsWith("/check-runs")) {
      return jsonResponse({ id: 91 }, 201);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runTrustedPolicyCheck({
    fetchImpl,
    token: "test-token",
    repository: "owner/repo",
    pullNumber: 17,
    expectedHeadSha: HEAD_SHA,
    expectedBaseRef: "main",
    eventAction: "opened",
    detailsUrl: "https://github.com/owner/repo/actions/runs/123",
    externalId: "trusted-policy:123:1:17",
  });

  assert.equal(result.conclusion, "success");
  const create = calls.find(({ url }) => url.endsWith("/check-runs"));
  assert.deepEqual(requestBody(create.options), {
    name: CHECK_NAME,
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    details_url: "https://github.com/owner/repo/actions/runs/123",
    external_id: "trusted-policy:123:1:17",
    completed_at: result.completedAt,
    output: {
      title: "Trusted policy passed",
      summary: "No critical governance path requires additional review.",
    },
  });
});

test("policy failures are published as a completed failure check", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/pulls/17")) {
      return jsonResponse({
        number: 17,
        changed_files: 1,
        head: { sha: HEAD_SHA },
        base: { ref: "main" },
        labels: [],
      });
    }
    if (String(url).includes("/pulls/17/files?")) {
      return jsonResponse([{ filename: "scripts/verify.mjs" }]);
    }
    if (String(url).endsWith("/check-runs")) {
      return jsonResponse({ id: 92 }, 201);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runTrustedPolicyCheck({
    fetchImpl,
    token: "test-token",
    repository: "owner/repo",
    pullNumber: 17,
    expectedHeadSha: HEAD_SHA,
    expectedBaseRef: "main",
    eventAction: "opened",
  });

  assert.equal(result.conclusion, "failure");
  const create = calls.find(({ url }) => url.endsWith("/check-runs"));
  assert.equal(requestBody(create.options).conclusion, "failure");
  assert.match(
    requestBody(create.options).output.summary,
    /governance-reviewed/,
  );
});

test("runner requires re-labeling after synchronize on the API-confirmed head", async () => {
  const checkPayloads = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/pulls/17")) {
      return jsonResponse({
        number: 17,
        changed_files: 1,
        head: { sha: HEAD_SHA },
        base: { ref: "main" },
        labels: [{ name: "governance-reviewed" }],
      });
    }
    if (String(url).includes("/pulls/17/files?")) {
      return jsonResponse([{ filename: "scripts/verify.mjs" }]);
    }
    if (String(url).endsWith("/check-runs")) {
      checkPayloads.push(requestBody(options));
      return jsonResponse({ id: 100 + checkPayloads.length }, 201);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const common = {
    fetchImpl,
    token: "test-token",
    repository: "owner/repo",
    pullNumber: 17,
    expectedHeadSha: HEAD_SHA,
    expectedBaseRef: "main",
  };

  const synchronized = await runTrustedPolicyCheck({
    ...common,
    eventAction: "synchronize",
  });
  const relabeled = await runTrustedPolicyCheck({
    ...common,
    eventAction: "labeled",
    eventLabel: "governance-reviewed",
  });

  assert.equal(synchronized.conclusion, "failure");
  assert.match(synchronized.errors.join("\n"), /remove and re-add/);
  assert.equal(relabeled.conclusion, "success");
  assert.deepEqual(
    checkPayloads.map(({ head_sha, conclusion }) => ({ head_sha, conclusion })),
    [
      { head_sha: HEAD_SHA, conclusion: "failure" },
      { head_sha: HEAD_SHA, conclusion: "success" },
    ],
  );
});

test("API failures also publish a failure check when the event head is valid", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/pulls/17")) {
      return jsonResponse({ message: "temporary failure" }, 503);
    }
    if (String(url).endsWith("/check-runs")) {
      return jsonResponse({ id: 93 }, 201);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runTrustedPolicyCheck({
    fetchImpl,
    token: "test-token",
    repository: "owner/repo",
    pullNumber: 17,
    expectedHeadSha: HEAD_SHA,
    expectedBaseRef: "main",
    eventAction: "opened",
  });

  assert.equal(result.conclusion, "failure");
  const create = calls.find(({ url }) => url.endsWith("/check-runs"));
  assert.equal(requestBody(create.options).head_sha, HEAD_SHA);
  assert.match(requestBody(create.options).output.summary, /GitHub API request failed/);
});

test("a missing trusted base catalog publishes failure without reading PR contents", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/check-runs")) {
      return jsonResponse({ id: 94 }, 201);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runTrustedPolicyCheck({
    fetchImpl,
    token: "test-token",
    repository: "owner/repo",
    pullNumber: 17,
    expectedHeadSha: HEAD_SHA,
    expectedBaseRef: "main",
    eventAction: "opened",
    readTrustedCatalog() {
      throw new Error("trusted governance catalog is missing or unreadable");
    },
  });

  assert.equal(result.conclusion, "failure");
  assert.deepEqual(result.errors, [
    "trusted governance catalog is missing or unreadable",
  ]);
  assert.equal(calls.some(({ url }) => url.includes("/pulls/17")), false);
  const create = calls.find(({ url }) => url.endsWith("/check-runs"));
  assert.equal(requestBody(create.options).head_sha, HEAD_SHA);
  assert.equal(requestBody(create.options).conclusion, "failure");
});

test("trusted workflow executes only base code and grants only the required write scope", () => {
  const contents = readFileSync(
    new URL(".github/workflows/trusted-policy.yml", ROOT),
    "utf8",
  );
  const workflow = parseYaml(contents, { uniqueKeys: true });

  assert.deepEqual(workflow.on, {
    pull_request_target: {
      branches: ["main"],
      types: [
        "opened",
        "reopened",
        "synchronize",
        "edited",
        "labeled",
        "unlabeled",
      ],
    },
  });
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "pull-requests": "read",
    checks: "write",
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.equal(workflow.jobs.dispatch.name, "dispatch");
  const checkout = workflow.jobs.dispatch.steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with["fetch-depth"], 1);
  for (const match of contents.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(match[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(contents, /pull_request\.head\.(?:ref|repo)/);
  assert.doesNotMatch(contents, /github\.head_ref|refs\/pull|checkout[^\n]*head/i);
  assert.match(contents, /node scripts\/trusted-policy-guard\.mjs/);
  assert.match(contents, /PR_EVENT_ACTION:\s*\$\{\{ github\.event\.action \}\}/);
  assert.match(contents, /PR_EVENT_LABEL:\s*\$\{\{ github\.event\.label\.name \}\}/);
});
