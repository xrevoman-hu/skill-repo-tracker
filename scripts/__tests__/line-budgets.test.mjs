import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCompressionBudget,
  checkToolingSnapshot,
  compareCompressionBudgets,
  compareToolingBudgets,
  fileCompressionMetrics,
  findForbiddenTestRegistrationIndirection,
  findForbiddenToolingTestImports,
  isToolingModule,
  isToolingTestModule,
} from "../line-budgets.mjs";
import { compareArchitectureBudgets } from "../architecture-budget-checks.mjs";

test("tooling inventory excludes tests and includes executable repository scripts", () => {
  assert.equal(isToolingModule("scripts/governance.mjs"), true);
  assert.equal(isToolingModule("scripts/subdir/check.mjs"), true);
  assert.equal(isToolingModule("scripts/new-policy.js"), true);
  assert.equal(isToolingModule("scripts/new-policy.cjs"), true);
  assert.equal(isToolingModule("scripts/new-policy.ts"), true);
  assert.equal(isToolingModule("scripts/new-policy.cts"), true);
  assert.equal(isToolingModule("scripts/__tests__/governance.test.mjs"), false);
  assert.equal(isToolingModule("scripts/probe.spec.cjs"), false);
  assert.equal(isToolingModule("src/App.tsx"), false);
});

test("new governance tools share the production 800-line cap", () => {
  assert.deepEqual(
    checkToolingSnapshot({
      files: {
        "scripts/governance.mjs": 1200,
        "scripts/new-tool.mjs": 801,
      },
      budget: {
        newModuleMaxLines: 800,
        hotSpots: {
          "scripts/governance.mjs": {
            status: "active",
            maxLines: 1200,
            targetLines: 800,
            adr: "docs/adr/0008.md",
          },
        },
      },
    }),
    ["scripts/new-tool.mjs has 801 lines; new governance tools are limited to 800"],
  );
});

test("governance test modules have their own exact line and byte budget", () => {
  assert.equal(isToolingTestModule("scripts/__tests__/policy.test.mjs"), true);
  assert.equal(isToolingTestModule("scripts/__tests__/fixtures.mjs"), true);
  assert.equal(isToolingTestModule("scripts/policy.test.mjs"), false);

  const denseSource = `${"x".repeat(400)}\n`.repeat(164);
  assert.deepEqual(
    checkToolingSnapshot({
      files: {
        "scripts/__tests__/too-many-lines.test.mjs": 801,
        "scripts/__tests__/too-many-bytes.test.mjs": 164,
      },
      budget: {
        newModuleMaxLines: 800,
        maxLineBytes: 800,
        newModuleMaxBytes: 65_536,
        hotSpots: {},
      },
      compressionMetrics: {
        "scripts/__tests__/too-many-lines.test.mjs": fileCompressionMetrics("ok\n"),
        "scripts/__tests__/too-many-bytes.test.mjs": fileCompressionMetrics(denseSource),
      },
    }),
    [
      "scripts/__tests__/too-many-lines.test.mjs has 801 lines; new governance tools are limited to 800",
      "scripts/__tests__/too-many-bytes.test.mjs has 65764 bytes; new modules are limited to 65536",
    ],
  );
});

test("production and tooling modules cannot hide code in huge lines or oversized files", () => {
  const budget = {
    maxLineBytes: 800,
    newModuleMaxBytes: 65_536,
    hotSpots: {},
  };
  const metrics = {
    "src/one-line.ts": fileCompressionMetrics("x".repeat(801)),
    "src/dense.ts": fileCompressionMetrics(`${"x".repeat(400)}\n`.repeat(164)),
  };

  assert.deepEqual(checkCompressionBudget({ metrics, budget, scope: "production" }), [
    "src/one-line.ts has a 801-byte line; maximum is 800",
    "src/dense.ts has 65764 bytes; new modules are limited to 65536",
  ]);
});

test("active hotspots use exact byte snapshots and compression caps cannot be relaxed", () => {
  const budget = {
    maxLineBytes: 800,
    newModuleMaxBytes: 65_536,
    hotSpots: {
      "scripts/governance.mjs": {
        status: "active",
        maxBytes: 10,
      },
    },
  };
  assert.deepEqual(
    checkCompressionBudget({
      metrics: {
        "scripts/governance.mjs": fileCompressionMetrics("eleven bytes"),
      },
      budget,
      scope: "tooling",
    }),
    ["scripts/governance.mjs has 12 bytes; hotspot byte snapshot must equal 10"],
  );

  const relaxed = structuredClone(budget);
  relaxed.maxLineBytes = 801;
  relaxed.newModuleMaxBytes = 65_537;
  relaxed.hotSpots["scripts/governance.mjs"].maxBytes = 11;
  assert.deepEqual(compareCompressionBudgets(relaxed, budget, "tooling"), [
    "tooling maxLineBytes increased from 800 to 801",
    "tooling newModuleMaxBytes increased from 65536 to 65537",
    "tooling hotspot scripts/governance.mjs byte budget increased from 10 to 11",
  ]);
});

test("production tooling cannot import test-only modules through any module syntax", () => {
  assert.deepEqual(
    findForbiddenToolingTestImports(
      "scripts/release/check.mts",
      [
        'import helpers from "../__tests__/helpers.mjs";',
        'export { fixture } from "../fixture.spec.ts?raw";',
        'const lazy = import("../policy.test.mjs#case");',
        'const legacy = require("../__tests__/legacy.cjs");',
        'import fs from "node:fs";',
      ].join("\n"),
    ),
    [
      "scripts/release/check.mts imports test-only tooling module ../__tests__/helpers.mjs",
      "scripts/release/check.mts imports test-only tooling module ../__tests__/legacy.cjs",
      "scripts/release/check.mts imports test-only tooling module ../fixture.spec.ts?raw",
      "scripts/release/check.mts imports test-only tooling module ../policy.test.mjs#case",
      "scripts/release/check.mts:3:14 uses dynamic import; production tooling dependency closure accepts only top-level static import/export",
      "scripts/release/check.mts:4:16 uses require; production tooling dependency closure accepts only top-level static import/export",
    ],
  );
  assert.deepEqual(
    findForbiddenToolingTestImports(
      "scripts/release/check.mjs",
      [
        'import helper from "../../docs/helper.mjs";',
        'const rootCode = require("../../vite.config.mjs");',
        'const absolute = import("file:///tmp/escape.mjs");',
        "const hidden = import(testModule); const legacy = require(target);",
      ].join("\n"),
    ),
    [
      "scripts/release/check.mjs imports executable repository code outside governed scripts/: ../../docs/helper.mjs",
      "scripts/release/check.mjs imports executable repository code outside governed scripts/: ../../vite.config.mjs",
      "scripts/release/check.mjs imports executable repository code outside governed scripts/: file:///tmp/escape.mjs",
      "scripts/release/check.mjs uses a non-literal dynamic import; production tooling imports must be statically auditable",
      "scripts/release/check.mjs uses a non-literal require; production tooling imports must be statically auditable",
      "scripts/release/check.mjs:2:18 uses require; production tooling dependency closure accepts only top-level static import/export",
      "scripts/release/check.mjs:3:18 uses dynamic import; production tooling dependency closure accepts only top-level static import/export",
      "scripts/release/check.mjs:4:16 uses dynamic import; production tooling dependency closure accepts only top-level static import/export",
      "scripts/release/check.mjs:4:51 uses require; production tooling dependency closure accepts only top-level static import/export",
    ],
  );
});

test("production tooling import policy includes dynamic execution and loader hazards", () => {
  assert.deepEqual(
    findForbiddenToolingTestImports(
      "scripts/loader.mjs",
      'eval(readFileSync("payload.mjs", "utf8"));',
    ),
    [
      "scripts/loader.mjs:1:1 uses eval; production tooling cannot execute dynamically loaded code",
    ],
  );
  for (const source of [
    'process.getBuiltinModule("node:vm");',
    'Reflect.get(globalThis, "eval")("payload");',
    '(() => {}).constructor("payload")();',
  ]) {
    assert.ok(findForbiddenToolingTestImports("scripts/loader.mjs", source).length > 0, source);
  }
});

test("test registration imports must come from the runner that actually collects the path", () => {
  for (const [pathname, source, expectedRunner] of [
    [
      "scripts/__tests__/fake.test.mjs",
      'import { test } from "./noop.mjs"; test("fake", () => 1);',
      "node:test",
    ],
    [
      "src/fake.test.ts",
      'import { test } from "node:test"; test("fake", () => 1);',
      "vitest",
    ],
    [
      "e2e/fake.spec.ts",
      'import { test } from "vitest"; test("fake", () => 1);',
      "@playwright/test",
    ],
  ]) {
    assert.ok(
      findForbiddenTestRegistrationIndirection(pathname, source).includes(
        `${pathname}:1:10 test registration import must come from ${expectedRunner}`,
      ),
    );
  }
});

test("tooling hotspot snapshots must be lowered with the code", () => {
  assert.deepEqual(
    checkToolingSnapshot({
      files: { "scripts/governance.mjs": 1199 },
      budget: {
        newModuleMaxLines: 800,
        hotSpots: {
          "scripts/governance.mjs": {
            status: "active",
            maxLines: 1200,
            targetLines: 800,
          },
        },
      },
    }),
    [
      "scripts/governance.mjs has 1199 lines; tooling hotspot snapshot must equal 1200 and be updated downward with the code",
    ],
  );
});

test("tooling budgets cannot grow, disappear, or bless a new hotspot", () => {
  assert.deepEqual(
    compareToolingBudgets(
      {
        newModuleMaxLines: 800,
        hotSpots: {
          "scripts/governance.mjs": { maxLines: 1300, targetLines: 900 },
          "scripts/new-tool.mjs": {
            status: "active",
            maxLines: 1000,
            targetLines: 700,
          },
        },
      },
      {
        newModuleMaxLines: 800,
        hotSpots: {
          "scripts/governance.mjs": {
            status: "active",
            maxLines: 1200,
            targetLines: 800,
          },
          "scripts/retiring-tool.mjs": {
            status: "active",
            maxLines: 900,
            targetLines: 700,
          },
        },
      },
    ),
    [
      "tooling hotspot scripts/governance.mjs budget increased from 1200 to 1300",
      "tooling hotspot scripts/governance.mjs target increased from 800 to 900",
      "active tooling hotspot was removed without retirement: scripts/retiring-tool.mjs",
      "new tooling hotspot budgets are forbidden; keep new tools within 800 lines: scripts/new-tool.mjs",
    ],
  );
});

test("tooling hotspot retirement is explicit and staged before deletion", () => {
  const active = {
    newModuleMaxLines: 800,
    hotSpots: {
      "scripts/governance.mjs": {
        status: "active",
        maxLines: 1200,
        targetLines: 800,
        maxBytes: 50000,
      },
    },
  };
  const retiring = structuredClone(active);
  retiring.hotSpots["scripts/governance.mjs"] = {
    status: "retiring",
    maxLines: 800,
    targetLines: 800,
    maxBytes: 50000,
    retirement: { reason: "module was split below the normal cap" },
  };
  assert.deepEqual(compareToolingBudgets(retiring, active), []);
  assert.deepEqual(
    checkToolingSnapshot({
      files: { "scripts/governance.mjs": 799 },
      budget: retiring,
    }),
    [],
  );

  const retired = structuredClone(retiring);
  retired.hotSpots["scripts/governance.mjs"].status = "retired";
  assert.deepEqual(compareToolingBudgets(retired, retiring), []);
  const removed = { newModuleMaxLines: 800, hotSpots: {} };
  assert.deepEqual(compareToolingBudgets(removed, retired), []);

  assert.deepEqual(compareToolingBudgets(removed, active), [
    "active tooling hotspot was removed without retirement: scripts/governance.mjs",
  ]);
  const skipped = structuredClone(active);
  skipped.hotSpots["scripts/governance.mjs"].status = "retired";
  skipped.hotSpots["scripts/governance.mjs"].retirement = { reason: "deleted" };
  assert.deepEqual(compareToolingBudgets(skipped, active), [
    "active tooling hotspot scripts/governance.mjs cannot skip directly to retired",
  ]);

  const reactivated = structuredClone(retiring);
  reactivated.hotSpots["scripts/governance.mjs"].status = "active";
  delete reactivated.hotSpots["scripts/governance.mjs"].retirement;
  assert.deepEqual(compareToolingBudgets(reactivated, retiring), [
    "retiring tooling hotspot scripts/governance.mjs cannot return to active",
    "tooling hotspot scripts/governance.mjs retirement metadata changed",
  ]);

  const rewritten = structuredClone(retiring);
  rewritten.hotSpots["scripts/governance.mjs"].retirement.reason = "rewritten history";
  rewritten.hotSpots["scripts/governance.mjs"].adr = "docs/adr/9999.md";
  assert.deepEqual(compareToolingBudgets(rewritten, retiring), [
    "tooling hotspot scripts/governance.mjs retirement metadata changed",
    "tooling hotspot scripts/governance.mjs ADR changed from undefined to docs/adr/9999.md",
  ]);
});

test("only pre-existing oversized stylesheets can enter the budget during CSS classification", () => {
  const base = {
    newModuleMaxLines: 800,
    hotSpots: {},
    tooling: { newModuleMaxLines: 800, hotSpots: {} },
  };
  const current = {
    ...base,
    hotSpots: {
      "src/styles.css": { maxLines: 90_000, maxBytes: 900_000, targetLines: 800 },
      "src/new.css": { maxLines: 900, targetLines: 800 },
    },
  };

  assert.deepEqual(
    compareArchitectureBudgets(current, base, {
      legacyHotspots: new Map([
        ["src/styles.css", { maxLines: 2_870, maxBytes: 120_000 }],
      ]),
    }),
    [
      "legacy CSS hotspot src/styles.css line budget exceeds base artifact: 90000 > 2870",
      "legacy CSS hotspot src/styles.css byte budget exceeds base artifact: 900000 > 120000",
      "new hotspot budgets are forbidden; keep new modules within 800 lines: src/new.css",
    ],
  );
});
