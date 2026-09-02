import { validateGovernanceAssetCatalog } from "../governance-assets.mjs";

const INTRODUCED_BY = "a".repeat(40);
const PRINCIPLE_NAMES = [
  "架构、分层与依赖方向",
  "高风险不变量与回归测试",
  "Bug 复现、根因、同类扫描与沉淀",
  "模块化 Rules、ADR 与上下文选择",
  "功能、状态、权限与常驻成本克制",
  "GitHub 自动化与远端保护",
  "AI 自动验证、分层验收与资产退休",
];

export const validCatalog = () => ({
  schemaVersion: 1,
  contextBudgets: {
    default: { maxLines: 180, maxBytes: 14000 },
    alwaysLoad: { maxLines: 160, maxBytes: 12000 },
    hotspots: [],
  },
  principles: Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    name: PRINCIPLE_NAMES[index],
  })),
  gates: [
    {
      id: "verify", status: "active", kind: "package-script", ref: "verify",
      capabilities: ["deterministic-verification", "weekly-resilience"],
    },
    {
      id: "weekly",
      status: "active",
      kind: "workflow",
      ref: ".github/workflows/weekly.yml",
      capabilities: ["weekly-resilience"],
    },
  ],
  assets: [
    {
      id: "architecture-fact-source",
      kind: "architecture",
      path: "docs/engineering/architecture.md",
      status: "active",
      principles: [1, 4, 5, 6, 7],
      alwaysLoad: true,
      enforcement: {
        mode: "mixed",
        gates: ["verify"],
        evidence: [
          { path: "scripts/__tests__/architecture.test.mjs", selector: "protects layers" },
        ],
      },
    },
    {
      id: "rule-scheduling",
      kind: "rule",
      path: "docs/rules/scheduling.md",
      status: "active",
      principles: [1, 2, 3, 4, 5, 6, 7],
      reviewOnChange: ["src/taskCoordinator.ts", "src-tauri/src/"],
      enforcement: {
        mode: "mixed",
        gates: ["verify", "weekly"],
        evidence: [
          { path: "src/taskCoordinator.test.ts", selector: "late generation cannot win" },
        ],
      },
    },
    {
      id: "adr-scheduling",
      kind: "decision",
      path: "docs/adr/0001-scheduling.md",
      status: "active",
      principles: [1, 4, 5],
      checksum: "sha256:379201dc29e852f8bc3137170ac04ea27f6871dc431dbed1d2077577c024d2e0",
      reviewOnChange: ["src/taskCoordinator.ts"],
      enforcement: {
        mode: "review",
        gates: [],
        evidence: [],
      },
    },
    {
      id: "core-schema-v1",
      kind: "fixture",
      path: "src-tauri/tests/fixtures/core-schema/v1.sql",
      status: "active",
      principles: [2, 3, 7],
      checksum: "sha256:fc1c0e0c7ae8690bf702ade724d2543f81603a03b3956338f76ddef54ad713b9",
      enforcement: {
        mode: "automated",
        gates: ["verify"],
        evidence: [
          { path: "src-tauri/src/schema_tests.rs", selector: "upgrades_v1_fixture" },
        ],
      },
    },
    {
      id: "shared-glossary",
      kind: "glossary",
      path: "CONTEXT.md",
      status: "active",
      principles: [1, 3, 4, 7],
      alwaysLoad: true,
      enforcement: { mode: "review", gates: [], evidence: [] },
    },
    {
      id: "maintainability-system",
      kind: "playbook",
      path: "docs/engineering/maintainability-system.md",
      status: "active",
      principles: [1, 2, 3, 4, 5, 6, 7],
      alwaysLoad: true,
      enforcement: { mode: "review", gates: [], evidence: [] },
    },
    {
      id: "contribution-contract",
      kind: "policy",
      path: "CONTRIBUTING.md",
      status: "active",
      principles: [3, 4, 5, 7],
      alwaysLoad: true,
      enforcement: { mode: "review", gates: [], evidence: [] },
    },
  ],
  invariants: [
    {
      id: "TASK-GEN-001",
      status: "active",
      principles: [1, 2, 3, 4, 5, 6, 7],
      rule: "rule-scheduling",
      decisions: ["adr-scheduling"],
      protectedPaths: ["src/taskCoordinator.ts", "src-tauri/src/"],
      evidence: [
        { path: "src/taskCoordinator.test.ts", selector: "late generation cannot win" },
      ],
      gates: ["verify", "weekly"],
      introducedBy: INTRODUCED_BY,
      retireWhen: "foreground scheduling is removed",
    },
  ],
});

export const trackedFiles = [
  ".github/workflows/weekly.yml",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "docs/engineering/architecture.md",
  "docs/engineering/maintainability-system.md",
  "docs/engineering/verify-plan.json",
  "docs/rules/scheduling.md",
  "docs/adr/0001-scheduling.md",
  "scripts/__tests__/architecture.test.mjs",
  "src/taskCoordinator.ts",
  "src/taskCoordinator.test.ts",
  "src-tauri/src/lib.rs",
  "src-tauri/src/schema_tests.rs",
  "src-tauri/tests/fixtures/core-schema/v1.sql",
];

export const fileContents = {
  "CONTEXT.md": "# Context\n",
  "CONTRIBUTING.md": "# Contributing\n",
  "docs/engineering/architecture.md": "# Architecture\n",
  "docs/engineering/maintainability-system.md": "# Maintainability\n",
  "docs/engineering/verify-plan.json": JSON.stringify({
    steps: [
      { command: "npm", args: ["run", "test:scripts"] },
      { command: "npm", args: ["test"] },
      { command: "cargo", args: ["test"] },
    ],
  }),
  "docs/rules/scheduling.md": "# Scheduling Rule\n",
  "docs/adr/0001-scheduling.md": "# ADR\n\n- 状态：Accepted\n",
  "scripts/__tests__/architecture.test.mjs": 'test("protects layers", () => assert.ok(true));\n',
  "src/taskCoordinator.ts": "export const task = true;\n",
  "src/taskCoordinator.test.ts": 'test("late generation cannot win", () => expect(true).toBe(true));\n',
  "src-tauri/src/lib.rs": [
    "fn main() {}",
    "#[cfg(test)]",
    '#[path = "schema_tests.rs"]',
    "mod schema_tests;",
    "",
  ].join("\n"),
  "src-tauri/src/schema_tests.rs":
    "#[test]\nfn upgrades_v1_fixture() {}\n",
  "src-tauri/tests/fixtures/core-schema/v1.sql": "fixture-v1",
};

export function validate(catalog = validCatalog(), overrides = {}) {
  return validateGovernanceAssetCatalog({
    catalog,
    trackedFiles,
    packageScripts: {
      verify: "node scripts/verify.mjs",
      "test:scripts": "node --test scripts/__tests__/*.test.mjs",
      test: "vitest run",
    },
    readFile: (path) => fileContents[path],
    commitExists: (commit) => commit === INTRODUCED_BY,
    ...overrides,
  });
}
