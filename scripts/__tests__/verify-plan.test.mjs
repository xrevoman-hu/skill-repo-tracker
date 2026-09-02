import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  VERIFY_PLAN,
  VERIFY_PLAN_DOCUMENT,
  compareVerifyPlans,
  validateVerifyPlan,
  validateVerifyPlanDocument,
} from "../verify-plan.mjs";

function clonePlan() {
  return structuredClone(VERIFY_PLAN);
}

test("the deterministic verify plan keeps every fail-closed step in order", () => {
  assert.deepEqual(validateVerifyPlan(VERIFY_PLAN), []);
  assert.deepEqual(validateVerifyPlanDocument(VERIFY_PLAN_DOCUMENT), []);
  assert.deepEqual(
    VERIFY_PLAN,
    VERIFY_PLAN_DOCUMENT.steps.map(({ id, label, command, args }) => ({
      id,
      label,
      command,
      args,
    })),
  );
});

test("the tracked verify plan document has an exact schema and unique step IDs", () => {
  const unknownTopLevel = structuredClone(VERIFY_PLAN_DOCUMENT);
  unknownTopLevel.allowFailure = true;
  assert.deepEqual(validateVerifyPlanDocument(unknownTopLevel), [
    "verify plan document contains unsupported fields: allowFailure",
  ]);

  const duplicate = structuredClone(VERIFY_PLAN_DOCUMENT);
  duplicate.steps[1].id = duplicate.steps[0].id;
  assert.deepEqual(validateVerifyPlanDocument(duplicate), [
    "verify plan step id scripts is duplicated",
  ]);

  const weakened = structuredClone(VERIFY_PLAN_DOCUMENT);
  weakened.steps[0].allowFailure = true;
  assert.deepEqual(validateVerifyPlanDocument(weakened), [
    "verify plan step scripts contains unsupported fields: allowFailure",
  ]);
});

test("removing or reordering a verify step fails", () => {
  const removed = clonePlan().filter((step) => step.id !== "rust-clippy");
  assert.deepEqual(validateVerifyPlan(removed), [
    "verify plan step order changed; expected scripts, governance, typecheck, strict-islands, vitest, vite-build, bundle-budget, rust-fmt, rust-clippy, rust-tests, git-diff",
  ]);

  const reordered = clonePlan();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.deepEqual(validateVerifyPlan(reordered), [
    "verify plan step order changed; expected scripts, governance, typecheck, strict-islands, vitest, vite-build, bundle-budget, rust-fmt, rust-clippy, rust-tests, git-diff",
  ]);
});

test("Rust locked inputs and Clippy warning denial cannot be weakened", () => {
  const unlocked = clonePlan();
  unlocked.find((step) => step.id === "rust-tests").args = unlocked
    .find((step) => step.id === "rust-tests")
    .args.filter((argument) => argument !== "--locked");
  assert.deepEqual(validateVerifyPlan(unlocked), [
    "verify plan step rust-tests command or arguments changed",
  ]);

  const warningAllowed = clonePlan();
  warningAllowed.find((step) => step.id === "rust-clippy").args = warningAllowed
    .find((step) => step.id === "rust-clippy")
    .args.filter((argument) => argument !== "warnings");
  assert.deepEqual(validateVerifyPlan(warningAllowed), [
    "verify plan step rust-clippy command or arguments changed",
  ]);
});

test("verify steps cannot opt into tolerated failure", () => {
  const weakened = clonePlan();
  weakened[0].allowFailure = true;
  assert.deepEqual(validateVerifyPlan(weakened), [
    "verify plan step scripts contains unsupported fields: allowFailure",
  ]);
});

test("a base verify step cannot be deleted, reordered, or silently rewritten", () => {
  const deleted = structuredClone(VERIFY_PLAN_DOCUMENT);
  deleted.steps = deleted.steps.filter((step) => step.id !== "rust-clippy");
  assert.deepEqual(compareVerifyPlans(deleted, VERIFY_PLAN_DOCUMENT), [
    "verify plan base step rust-clippy was deleted",
  ]);

  const reordered = structuredClone(VERIFY_PLAN_DOCUMENT);
  [reordered.steps[0], reordered.steps[1]] = [
    reordered.steps[1],
    reordered.steps[0],
  ];
  assert.deepEqual(compareVerifyPlans(reordered, VERIFY_PLAN_DOCUMENT), [
    "verify plan base step order changed; expected scripts, governance, typecheck, strict-islands, vitest, vite-build, bundle-budget, rust-fmt, rust-clippy, rust-tests, git-diff",
  ]);

  const changedCommand = structuredClone(VERIFY_PLAN_DOCUMENT);
  changedCommand.steps.find((step) => step.id === "vitest").command = "true";
  assert.deepEqual(compareVerifyPlans(changedCommand, VERIFY_PLAN_DOCUMENT), [
    "verify plan constitution capability frontend-unit-regressions requires its exact audited command and arguments",
  ]);

  const changedArguments = structuredClone(VERIFY_PLAN_DOCUMENT);
  changedArguments.steps.find((step) => step.id === "rust-tests").args = [
    "test",
  ];
  assert.deepEqual(compareVerifyPlans(changedArguments, VERIFY_PLAN_DOCUMENT), [
    "verify plan constitution capability rust-regressions requires its exact audited command and arguments",
  ]);
});

test("verify plan evolution requires an explicit replacement and retirement lifecycle", () => {
  const retiring = structuredClone(VERIFY_PLAN_DOCUMENT);
  const oldStep = retiring.steps.find((step) => step.id === "bundle-budget");
  oldStep.status = "retiring";
  oldStep.retirement = {
    reason: "The replacement verifies bundle and dependency budgets together.",
    replacement: "product-budget",
  };
  retiring.steps.push({
    id: "product-budget",
    label: "产品预算",
    command: "node",
    args: ["scripts/governance.mjs", "bundle"],
    capabilities: ["frontend-bundle-budget"],
    status: "active",
  });
  assert.deepEqual(compareVerifyPlans(retiring, VERIFY_PLAN_DOCUMENT), []);

  const retired = structuredClone(retiring);
  retired.steps.find((step) => step.id === "bundle-budget").status = "retired";
  assert.deepEqual(compareVerifyPlans(retired, retiring), []);

  const removedAfterRetirement = structuredClone(retired);
  removedAfterRetirement.steps = removedAfterRetirement.steps.filter(
    (step) => step.id !== "bundle-budget",
  );
  assert.deepEqual(compareVerifyPlans(removedAfterRetirement, retired), [
    "verify plan base step bundle-budget was deleted",
  ]);

  const skippedLifecycle = structuredClone(retiring);
  const skipped = skippedLifecycle.steps.find(
    (step) => step.id === "bundle-budget",
  );
  skipped.status = "retired";
  assert.deepEqual(compareVerifyPlans(skippedLifecycle, VERIFY_PLAN_DOCUMENT), [
    "verify plan base step bundle-budget must enter retiring before retired",
  ]);

  const rewrittenRetirement = structuredClone(retired);
  rewrittenRetirement.steps.find(
    (step) => step.id === "bundle-budget",
  ).retirement.reason = "A different reason added after review.";
  assert.deepEqual(compareVerifyPlans(rewrittenRetirement, retiring), [
    "verify plan base step bundle-budget retirement metadata changed",
  ]);

  const inactiveNewStep = structuredClone(VERIFY_PLAN_DOCUMENT);
  inactiveNewStep.steps.push({
    id: "old-product-budget",
    label: "旧产品预算",
    command: "node",
    args: ["scripts/governance.mjs", "bundle"],
    capabilities: ["frontend-bundle-budget"],
    status: "retiring",
    retirement: {
      reason: "A new step cannot enter the plan already retiring.",
      replacement: "bundle-budget",
    },
  });
  assert.deepEqual(compareVerifyPlans(inactiveNewStep, VERIFY_PLAN_DOCUMENT), [
    "verify plan new step old-product-budget must start with active status",
  ]);
});

test("verify plan replacement chains preserve every retired capability", () => {
  const firstPr = structuredClone(VERIFY_PLAN_DOCUMENT);
  const vitest = firstPr.steps.find((step) => step.id === "vitest");
  vitest.status = "retiring";
  vitest.retirement = {
    reason: "Attempt to replace frontend regression coverage with an unrelated gate.",
    replacement: "git-diff",
  };
  assert.deepEqual(compareVerifyPlans(firstPr, VERIFY_PLAN_DOCUMENT), [
    "verify plan step vitest replacement git-diff does not cover capabilities: frontend-unit-regressions",
  ]);

  const validFirstPr = structuredClone(VERIFY_PLAN_DOCUMENT);
  const retiringVitest = validFirstPr.steps.find((step) => step.id === "vitest");
  retiringVitest.status = "retiring";
  retiringVitest.retirement = {
    reason: "Move frontend regression coverage to the next runner.",
    replacement: "frontend-regressions-v2",
  };
  validFirstPr.steps.push({
    id: "frontend-regressions-v2",
    label: "Frontend regressions v2",
    command: "npm",
    args: ["test"],
    capabilities: ["frontend-unit-regressions"],
    status: "active",
  });
  assert.deepEqual(compareVerifyPlans(validFirstPr, VERIFY_PLAN_DOCUMENT), []);

  const secondPr = structuredClone(validFirstPr);
  secondPr.steps.find((step) => step.id === "vitest").status = "retired";
  const v2 = secondPr.steps.find((step) => step.id === "frontend-regressions-v2");
  v2.status = "retiring";
  v2.retirement = {
    reason: "Move the same capability to the third runner.",
    replacement: "frontend-regressions-v3",
  };
  secondPr.steps.push({
    id: "frontend-regressions-v3",
    label: "Frontend regressions v3",
    command: "npm",
    args: ["test"],
    capabilities: ["frontend-unit-regressions"],
    status: "active",
  });
  assert.deepEqual(compareVerifyPlans(secondPr, validFirstPr), []);

  const rewrittenCapability = structuredClone(validFirstPr);
  rewrittenCapability.steps.find((step) => step.id === "vitest").capabilities = [
    "weaker-capability",
  ];
  assert.deepEqual(compareVerifyPlans(rewrittenCapability, validFirstPr), [
    "verify plan step vitest replacement frontend-regressions-v2 does not cover capabilities: weaker-capability",
  ]);

  const forgedRunner = structuredClone(validFirstPr);
  const replacement = forgedRunner.steps.find(
    (step) => step.id === "frontend-regressions-v2",
  );
  replacement.command = "node";
  replacement.args = ["scripts/check-diff.mjs"];
  assert.deepEqual(compareVerifyPlans(forgedRunner, VERIFY_PLAN_DOCUMENT), [
    "verify plan constitution capability frontend-unit-regressions requires its exact audited command and arguments",
  ]);
});

test("the verify runner validates its plan before executing any step", () => {
  const runner = readFileSync(new URL("../verify.mjs", import.meta.url), "utf8");
  assert.match(runner, /validateVerifyPlan\(VERIFY_PLAN\)/);
  assert.ok(
    runner.indexOf("validateVerifyPlan(VERIFY_PLAN)") <
      runner.indexOf("for (const { label, command: commandName, args } of VERIFY_PLAN)"),
  );
});
