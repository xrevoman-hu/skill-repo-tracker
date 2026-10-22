import { createHash } from "node:crypto";
import { validCatalog } from "./governance-assets-fixtures.mjs";
import { mainOnlyPlan, MAIN_ONLY_RETIRE, MAIN_ONLY_RETIREMENT, MAIN_ONLY_DROPS } from "../governance-policy-removal.mjs";

export const BOOTSTRAP = "b".repeat(40);
export const ADR_BYTES = Buffer.from("# ADR 0014\n\n- 状态：Accepted\n");
export const find = (catalog, collection, id) => catalog[collection].find((item) => item.id === id);
export function beforePolicy() {
  const catalog = validCatalog();
  catalog.schemaVersion = 1;
  delete catalog.policyRemovals;
  catalog.gates.push({ id: "trusted-policy", status: "active", kind: "workflow",
    ref: ".github/workflows/trusted-policy.yml", capabilities: ["base-sourced-policy-review"] });
  catalog.assets.push({ id: "pr-evidence-template", kind: "template", status: "active",
    path: ".github/pull_request_template.md", principles: [3, 4],
    enforcement: { mode: "mixed", gates: ["verify"], evidence: [
      { path: "scripts/__tests__/pr-evidence.test.mjs", selector: "checks PR" },
    ] } });
  catalog.assets.push({ id: "github-governance-policy", kind: "policy", status: "active",
    path: "docs/engineering/github-governance.md", principles: [6],
    enforcement: { mode: "mixed", gates: ["verify", "trusted-policy"], evidence: [
      ...structuredClone(MAIN_ONLY_DROPS[1].values),
      { path: "scripts/__tests__/github-governance.test.mjs", selector: "keeps remote protection" },
    ] } });
  catalog.assets.push({ id: "adr-0008-executable-governance", kind: "decision", status: "active",
    path: "docs/adr/0008-executable-governance-assets.md", checksum: `sha256:${"8".repeat(64)}` });
  for (const id of MAIN_ONLY_RETIRE.invariants) {
    catalog.invariants.push({ id, status: "active", principles: [3, 4, 6],
      rule: "rule-testing-release", decisions: ["adr-0008-executable-governance"],
      protectedPaths: ["scripts/trusted-policy-guard.mjs", ".github/workflows/ci.yml"],
      gates: ["verify", "trusted-policy"], evidence: structuredClone(MAIN_ONLY_DROPS[4].values),
      introducedBy: "a".repeat(40), retireWhen: "old protection is formally retired" });
  }
  catalog.invariants.push({ id: "GH-GATE-001", status: "active", principles: [6],
    rule: "rule-testing-release", decisions: ["adr-0008-executable-governance"],
    protectedPaths: ["scripts/trusted-policy-guard.mjs", "scripts/github-governance-check.mjs"],
    gates: ["verify", "trusted-policy"], evidence: [
      ...structuredClone(MAIN_ONLY_DROPS[4].values),
      { path: "scripts/__tests__/github-governance.test.mjs", selector: "keeps remote protection" },
    ], introducedBy: "a".repeat(40), retireWhen: "remote repository no longer exists" });
  return catalog;
}
export function stageA() {
  const catalog = beforePolicy();
  catalog.schemaVersion = 2;
  catalog.policyRemovals = [mainOnlyPlan(BOOTSTRAP)];
  catalog.assets.push({ id: "adr-0014-main-only", kind: "decision", status: "active",
    path: "docs/adr/0014-main-only-governance.md",
    checksum: `sha256:${createHash("sha256").update(ADR_BYTES).digest("hex")}`,
    principles: [4, 6, 7], reviewOnChange: ["scripts/"],
    enforcement: { mode: "review", gates: [], evidence: [] } });
  for (const [collection, ids] of Object.entries(MAIN_ONLY_RETIRE)) {
    for (const id of ids) Object.assign(find(catalog, collection, id), {
      status: "retiring", retirement: structuredClone(MAIN_ONLY_RETIREMENT),
    });
  }
  return catalog;
}
export function stageB() {
  const catalog = stageA();
  for (const [collection, ids] of Object.entries(MAIN_ONLY_RETIRE)) {
    for (const id of ids) find(catalog, collection, id).status = "retired";
  }
  for (const drop of MAIN_ONLY_DROPS) {
    const parts = drop.field.split(".");
    const field = parts.pop();
    const owner = parts.reduce((item, part) => item[part], find(catalog, drop.collection, drop.id));
    owner[field] = owner[field].filter((value) =>
      !drop.values.some((expected) => JSON.stringify(value) === JSON.stringify(expected)));
  }
  return catalog;
}
export const planOptions = (overrides = {}) => ({
  readFile: () => ADR_BYTES,
  readBootstrapCatalog: () => beforePolicy(),
  isBootstrapAncestor: (sha) => sha === BOOTSTRAP,
  ...overrides,
});
