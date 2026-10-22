import assert from "node:assert/strict";
import test from "node:test";
import { authorizedPolicyDrop, getMainOnlyPlan, policyRemovalPhase,
  validateMainOnlyPolicyCatalog, validatePolicyRemovalPlan, validatePolicyRemovalTransition,
} from "../governance-policy-removal.mjs";
import { compareGovernanceAssetCatalogs, validateGovernanceAssetCatalog } from "../governance-assets.mjs";
import { beforePolicy, stageA, stageB, find, planOptions, ADR_BYTES } from "./governance-policy-removal-fixtures.mjs";
import { validate, validCatalog } from "./governance-assets-fixtures.mjs";

test("main-only policy requires the exact two-stage retirement and five drops", () => {
  assert.deepEqual(validateMainOnlyPolicyCatalog(stageA()), []);
  assert.deepEqual(validateMainOnlyPolicyCatalog(stageB()), []);
  assert.equal(policyRemovalPhase(stageA()), "retiring");
  assert.equal(policyRemovalPhase(stageB()), "retired");
  assert.deepEqual(validatePolicyRemovalPlan(stageA(), planOptions()), []);
  assert.deepEqual(compareGovernanceAssetCatalogs(stageA(), beforePolicy()), []);
  assert.deepEqual(compareGovernanceAssetCatalogs(stageB(), stageA()), []);
});

test("policy declaration and deletion in one cumulative push is rejected", () => {
  assert.match(validatePolicyRemovalTransition(stageB(), beforePolicy()).join("\n"), /already verified retiring baseline/);
  assert.equal(authorizedPolicyDrop(stageB(), beforePolicy(), {
    collection: "invariants", id: "GH-GATE-001", field: "gates", value: "trusted-policy",
  }), false);
});

test("policy bootstrap must be reachable pre-policy JSON and preserve original tombstones", () => {
  for (const options of [
    planOptions({ isBootstrapAncestor: () => false }),
    planOptions({ readBootstrapCatalog: () => undefined }),
    planOptions({ readBootstrapCatalog: () => { throw new Error("invalid JSON"); } }),
    planOptions({ readBootstrapCatalog: stageA }),
  ]) assert.match(validatePolicyRemovalPlan(stageA(), options).join("\n"), /bootstrap/);
  const changed = stageA();
  find(changed, "invariants", "PR-EVIDENCE-001").protectedPaths = ["new/path"];
  assert.match(validatePolicyRemovalPlan(changed, planOptions()).join("\n"), /preserve bootstrap record/);
  const absent = beforePolicy();
  find(absent, "assets", "github-governance-policy").enforcement.evidence.shift();
  assert.match(validatePolicyRemovalPlan(stageA(), planOptions({ readBootstrapCatalog: () => absent })).join("\n"), /not present in bootstrap/);
});

test("policy decision requires Accepted actual bytes and ADR-0008 cannot be rewritten", () => {
  assert.match(validatePolicyRemovalPlan(stageA(), planOptions({ readFile: () => "- 状态：Draft" })).join("\n"), /Accepted/);
  assert.match(validatePolicyRemovalPlan(stageA(), planOptions({ readFile: () => Buffer.concat([ADR_BYTES, Buffer.from("changed")]) })).join("\n"), /checksum/);
  const changed = stageA();
  find(changed, "assets", "adr-0008-executable-governance").checksum = "sha256:changed";
  assert.match(validatePolicyRemovalPlan(changed, planOptions()).join("\n"), /ADR-0008/);
});

test("policy plans reject extra missing duplicate and reordered entries", () => {
  for (const mutate of [
    (plan) => { plan.extra = true; },
    (plan) => { plan.drop.pop(); },
    (plan) => { plan.drop.push(structuredClone(plan.drop[0])); },
    (plan) => { plan.drop.reverse(); },
    (plan) => { plan.retire.assets.push("architecture-fact-source"); },
    (plan) => { plan.drop[0].values.push("ci"); },
    (plan) => { plan.bootstrapHead = "fake"; },
  ]) {
    const catalog = stageA(); mutate(catalog.policyRemovals[0]);
    assert.match(validateMainOnlyPolicyCatalog(catalog).join("\n"), /exact immutable/);
  }
  assert.throws(() => getMainOnlyPlan(validCatalog()), /missing/);
});

test("policy retirement cannot weaken any other owner or remove GH-GATE", () => {
  const other = stageB();
  find(other, "invariants", "GH-GATE-001").gates = [];
  assert.match(compareGovernanceAssetCatalogs(other, stageA()).join("\n"), /removed gate: verify/);
  const removed = stageB();
  removed.invariants = removed.invariants.filter((item) => item.id !== "GH-GATE-001");
  assert.match(compareGovernanceAssetCatalogs(removed, stageA()).join("\n"), /GH-GATE-001/);
  assert.equal(authorizedPolicyDrop(stageB(), stageA(), {
    collection: "invariants", id: "TASK-GEN-001", field: "gates", value: "trusted-policy",
  }), false);
});

test("retiring policy retains files and evidence and final phase rejects stale live owners", () => {
  const premature = stageA();
  find(premature, "assets", "github-governance-policy").enforcement.evidence.shift();
  assert.match(validateMainOnlyPolicyCatalog(premature).join("\n"), /premature/);
  const stale = stageB();
  find(stale, "assets", "architecture-fact-source").enforcement.gates.push("trusted-policy");
  assert.match(validateMainOnlyPolicyCatalog(stale).join("\n"), /live policy owner/);
  const catalog = stageA();
  const errors = validateGovernanceAssetCatalog({ catalog, trackedFiles: [], packageScripts: {},
    readFile: () => undefined, commitExists: () => true });
  assert.ok(errors.some((error) => error.includes("pr-evidence-template") && error.includes("not tracked")));
  assert.ok(errors.some((error) => error.includes("trusted-policy") && error.includes("untracked workflow")));
});

test("mixed phases copied capabilities and unrelated asset retirement fail closed", () => {
  const mixed = stageA(); find(mixed, "gates", "trusted-policy").status = "retired";
  assert.throws(() => policyRemovalPhase(mixed), /uniform/);
  const copied = stageA(); copied.gates[0].capabilities.push("base-sourced-policy-review");
  assert.match(validateMainOnlyPolicyCatalog(copied).join("\n"), /cannot be copied/);
  const other = stageA(); find(other, "assets", "architecture-fact-source").status = "retiring";
  assert.match(validateMainOnlyPolicyCatalog(other).join("\n"), /only the declared template/);
});

test("policy entries metadata and full retired tombstones are permanently immutable", () => {
  const changed = stageA(); changed.policyRemovals[0].bootstrapHead = "c".repeat(40);
  assert.match(validatePolicyRemovalTransition(changed, stageA()).join("\n"), /permanently immutable/);
  const missing = stageA(); missing.policyRemovals = [];
  assert.match(validatePolicyRemovalTransition(missing, stageA()).join("\n"), /permanently immutable/);
  for (const collection of ["gates", "assets", "invariants"]) {
    const current = stageB();
    const item = current[collection].find((record) => record.status === "retired");
    item.unreviewed = true;
    assert.match(compareGovernanceAssetCatalogs(current, stageB()).join("\n"), /immutable|record changed/);
  }
});

test("current catalog schema two leaves ordinary governance contracts enforced", () => {
  assert.deepEqual(validate(), []);
  const old = validCatalog(); old.schemaVersion = 1;
  assert.match(validate(old).join("\n"), /schemaVersion must be 2/);
});
