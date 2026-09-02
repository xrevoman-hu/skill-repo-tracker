import assert from "node:assert/strict";
import test from "node:test";

import { compareGovernanceAssetCatalogs } from "../governance-assets.mjs";
import { validCatalog, validate } from "./governance-assets-fixtures.mjs";

test("a coverage gate cannot retire into a weaker test-only lane", () => {
  const base = validCatalog();
  base.gates.push({
    id: "coverage",
    status: "active",
    kind: "package-script",
    ref: "coverage:check",
    capabilities: ["frontend-coverage", "rust-coverage"],
  });
  const current = structuredClone(base);
  const coverage = current.gates.find((gate) => gate.id === "coverage");
  coverage.status = "retiring";
  coverage.retirement = {
    reason: "replace coverage with a cheaper lane",
    replacement: "coverage-lite",
  };
  current.gates.push({
    id: "coverage-lite",
    status: "active",
    kind: "package-script",
    ref: "test:scripts",
    capabilities: ["script-regressions"],
  });
  for (const asset of current.assets) {
    asset.enforcement.gates = (asset.enforcement.gates ?? []).map((gate) =>
      gate === "coverage" ? "coverage-lite" : gate,
    );
  }
  for (const invariant of current.invariants) {
    invariant.gates = (invariant.gates ?? []).map((gate) =>
      gate === "coverage" ? "coverage-lite" : gate,
    );
  }

  assert.ok(
    validate(current, {
      packageScripts: {
        verify: "node scripts/verify.mjs",
        "test:scripts": "node --test scripts/__tests__/*.test.mjs",
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        "coverage:check": "npm run test:coverage && cargo test",
      },
    }).some((error) =>
      error.includes("coverage-lite does not preserve capabilities") ||
      error.includes("coverage-lite does not execute runners"),
    ),
  );
  assert.ok(
    compareGovernanceAssetCatalogs(current, base).some((error) =>
      error.includes("coverage-lite does not preserve capabilities"),
    ),
  );
});

test("a tracked YAML outside GitHub workflows cannot impersonate an executable gate", () => {
  const catalog = validCatalog();
  catalog.gates.push({
    id: "phantom-weekly",
    status: "active",
    kind: "workflow",
    ref: "evidence/phantom-weekly.yml",
    capabilities: ["weekly-resilience"],
  });
  assert.ok(
    validate(catalog, {
      trackedFiles: ["evidence/phantom-weekly.yml"],
      readFile: (path) => path === "evidence/phantom-weekly.yml"
        ? "jobs:\n  fake:\n    steps:\n      - run: vitest run\n"
        : undefined,
    }).some((error) => error.includes("must reference .github/workflows/<file>.yml")),
  );
});
