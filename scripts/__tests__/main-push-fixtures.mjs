import { createHash } from "node:crypto";
import { MAIN_ONLY_RETIREMENT, mainOnlyPlan } from "../governance-policy-removal.mjs";
import { EXPECTED_REPOSITORY } from "../main-push-github.mjs";

export const sha = (character) => character.repeat(40);
export const ADR_BYTES = "# ADR 0014 fixture\n\n- 状态：Accepted\n";

export function catalogFixture(phase = "retiring", bootstrap = sha("a")) {
  const plan = mainOnlyPlan(bootstrap);
  const catalog = { schemaVersion: 2, policyRemovals: [plan], gates: [], assets: [], invariants: [] };
  for (const [collection, ids] of Object.entries(plan.retire)) {
    for (const id of ids) catalog[collection].push({ id, status: phase,
      ...(collection === "assets" ? { kind: "template", path: ".github/pull_request_template.md" } : {}),
      ...(collection === "gates" ? { kind: "workflow", ref: ".github/workflows/trusted-policy.yml" } : {}),
      retirement: structuredClone(MAIN_ONLY_RETIREMENT) });
  }
  catalog.assets.push({ id: plan.decision, kind: "decision", status: "active",
    path: "docs/adr/0014-main-only-governance.md",
    checksum: `sha256:${createHash("sha256").update(ADR_BYTES).digest("hex")}` });
  for (const drop of plan.drop) {
    let owner = catalog[drop.collection].find((entry) => entry.id === drop.id);
    if (!owner) { owner = { id: drop.id, status: "active" }; catalog[drop.collection].push(owner); }
    const keys = drop.field.split("."); let target = owner;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = phase === "retiring" ? structuredClone(drop.values) : [];
  }
  return catalog;
}

export function gitFixture({ head = sha("d"), bootstrap = sha("a"), phase = "retiring" } = {}) {
  const catalog = catalogFixture(phase, bootstrap);
  const parents = new Map([[sha("d"), [sha("c")]], [sha("c"), [sha("b")]], [sha("b"), [sha("a")]]]);
  const catalogs = new Map([[sha("a"), { schemaVersion: 1 }],
    ...[sha("b"), sha("c"), sha("d")].map((id) => [id, structuredClone(catalog)])]);
  return { catalogs, parentMap: parents, head: () => head,
    isAncestor: (base, headId) => {
      const seen = new Set(); let value = headId;
      while (value && !seen.has(value)) {
        if (value === base) return true;
        seen.add(value); value = parents.get(value)?.[0];
      }
      return false;
    },
    parents: (id) => { if (!parents.has(id)) throw new Error("missing commit"); return parents.get(id); },
    catalog: (id) => { if (!catalogs.has(id)) throw new Error("missing catalog"); return catalogs.get(id); },
    text: () => ADR_BYTES };
}

export const REPOSITORY = EXPECTED_REPOSITORY;
export const WORKFLOW = { id: 17, path: ".github/workflows/ci.yml", name: "CI", state: "active" };
export function runFixture(id = 1, head = sha("b"), extra = {}) {
  return { id, head_sha: head, head_branch: "main", event: "push", workflow_id: 17,
    path: WORKFLOW.path, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
    created_at: "2026-10-01T00:00:00Z", run_attempt: 1, status: "completed", conclusion: "success", ...extra };
}
export function jobsFixture(run) {
  return ["baseline", "verify", "coverage", "msrv"].map((name, index) => ({
    id: index + 1, name, run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha,
    status: "completed", conclusion: "success",
  }));
}
