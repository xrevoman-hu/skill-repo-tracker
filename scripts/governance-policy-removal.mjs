import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function freeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") freeze(nested);
  }
  return Object.freeze(value);
}

export const MAIN_ONLY_ID = "main-only-2026-10";
export const MAIN_ONLY_DECISION = "adr-0014-main-only";
export const MAIN_ONLY_RETIREMENT = Object.freeze({
  policyRemoval: MAIN_ONLY_ID,
  reason: "采用仅main快进推送，明确退出PR前置与正文机器审查；新push检查不具有等价保护能力",
});
const EVIDENCE_PATH = "scripts/__tests__/trusted-policy-guard.test.mjs";
const evidence = (selector) => ({ path: EVIDENCE_PATH, selector });
export const MAIN_ONLY_RETIRE = freeze({
  gates: ["trusted-policy"], assets: ["pr-evidence-template"],
  invariants: ["PR-EVIDENCE-001", "TRUSTED-SUITE-001"],
});
export const MAIN_ONLY_DROPS = freeze([
  { collection: "assets", id: "github-governance-policy", field: "enforcement.gates",
    values: ["trusted-policy"] },
  { collection: "assets", id: "github-governance-policy", field: "enforcement.evidence",
    values: [
      "trusted default-branch script publishes success on the exact PR head",
      "trusted workflow executes only base code and grants only the required write scope",
      "native job runner maps policy success and failure to fail-closed exit codes",
      "governance evidence assertion changes require a fresh governance-reviewed label",
    ].map(evidence) },
  { collection: "invariants", id: "GH-GATE-001", field: "gates", values: ["trusted-policy"] },
  { collection: "invariants", id: "GH-GATE-001", field: "protectedPaths",
    values: ["scripts/trusted-policy-guard.mjs"] },
  { collection: "invariants", id: "GH-GATE-001", field: "evidence", values: [
    "critical changes fail closed until governance-reviewed is present",
    "API failures also publish a failure check when the event head is valid",
  ].map(evidence) },
]);
export function mainOnlyPlan(bootstrapHead) {
  return structuredClone({ id: MAIN_ONLY_ID, kind: "pr-to-main-only-v1",
    decision: MAIN_ONLY_DECISION, bootstrapHead,
    retire: MAIN_ONLY_RETIRE, drop: MAIN_ONLY_DROPS });
}
const entity = (catalog, collection, id) => Array.isArray(catalog?.[collection])
  ? catalog[collection].find((item) => item?.id === id) : undefined;
const at = (value, field) => field.split(".").reduce((item, key) => item?.[key], value);
const includes = (values, expected) => Array.isArray(values) &&
  values.some((value) => isDeepStrictEqual(value, expected));
const targets = () => Object.entries(MAIN_ONLY_RETIRE)
  .flatMap(([collection, ids]) => ids.map((id) => ({ collection, id })));
const withoutLifecycle = ({ status: _status, retirement: _retirement, ...rest } = {}) => rest;
function planErrors(catalog) {
  const plans = catalog?.policyRemovals;
  if (!Array.isArray(plans)) return ["schema 2 catalog must declare policyRemovals array"];
  if (plans.length === 0) return [];
  if (plans.length !== 1) return ["policyRemovals permits exactly the main-only plan"];
  const plan = plans[0];
  if (!/^[0-9a-f]{40}$/.test(plan?.bootstrapHead ?? "") || /^0+$/.test(plan?.bootstrapHead ?? "") ||
      !isDeepStrictEqual(plan, mainOnlyPlan(plan?.bootstrapHead))) {
    return ["policy removal must match the exact immutable main-only plan and five drops"];
  }
  return [];
}

// Pure structural validation: historical JSON is data, never executable policy code.
export function validateMainOnlyPolicyCatalog(catalog) {
  if (catalog?.schemaVersion !== 2) return ["current policy catalog schemaVersion must be 2"];
  const errors = planErrors(catalog);
  if (errors.length) return errors;
  for (const collection of ["gates", "assets", "invariants"]) {
    if (!Array.isArray(catalog[collection]) || catalog[collection].some((item) => !item || typeof item !== "object")) {
      errors.push(`policy catalog ${collection} must be an array of records`);
    }
  }
  if (errors.length) return errors;
  const plan = catalog.policyRemovals[0];
  if (!plan) {
    for (const collection of ["gates", "assets", "invariants"]) {
      if ((catalog[collection] ?? []).some((item) => item.retirement?.policyRemoval != null)) {
        errors.push("policy retirement requires its declared main-only plan");
      }
    }
    return errors;
  }
  for (const collection of ["gates", "assets", "invariants"]) {
    const ids = catalog[collection].map((item) => item.id);
    if (new Set(ids).size !== ids.length) errors.push(`policy catalog ${collection} has duplicate IDs`);
  }
  const states = [];
  for (const { collection, id } of targets()) {
    const item = entity(catalog, collection, id);
    if (!item || !["retiring", "retired"].includes(item.status) ||
        !isDeepStrictEqual(item.retirement, MAIN_ONLY_RETIREMENT)) {
      errors.push(`policy removal ${collection}/${id} must carry the exact retirement metadata`);
    }
    states.push(item?.status);
    if (collection === "assets" && (item?.kind !== "template" || item.path !== ".github/pull_request_template.md")) {
      errors.push("policy removal asset must be the PR evidence template");
    }
    if (collection === "gates" && (item?.kind !== "workflow" || item.ref !== ".github/workflows/trusted-policy.yml")) {
      errors.push("policy removal gate must be the original trusted-policy workflow");
    }
  }
  if (new Set(states).size !== 1) errors.push("policy retirement phase must be uniform for all four entities");
  const decision = entity(catalog, "assets", plan.decision);
  if (decision?.status !== "active" || decision?.kind !== "decision" ||
      decision?.path !== "docs/adr/0014-main-only-governance.md") {
    errors.push("policy removal requires the active registered ADR-0014 decision");
  }
  for (const collection of ["gates", "assets", "invariants"]) {
    for (const item of catalog[collection] ?? []) {
      if (item.retirement?.policyRemoval != null &&
          !MAIN_ONLY_RETIRE[collection].includes(item.id)) {
        errors.push(`unauthorized policy retirement: ${collection}/${item.id}`);
      }
      if (collection === "assets" && ["retiring", "retired"].includes(item.status) &&
          !MAIN_ONLY_RETIRE.assets.includes(item.id)) {
        errors.push(`only the declared template may use asset retirement: ${item.id}`);
      }
      if (collection === "gates" && item.id !== "trusted-policy" &&
          Array.isArray(item.capabilities) && item.capabilities.includes("base-sourced-policy-review")) {
        errors.push(`removed trusted capability cannot be copied to gate ${item.id}`);
      }
    }
  }
  for (const drop of plan.drop) {
    const owner = entity(catalog, drop.collection, drop.id);
    if (owner?.status !== "active") errors.push(`policy drop owner must remain active: ${drop.id}`);
    const values = at(owner, drop.field);
    if (!Array.isArray(values)) errors.push(`policy drop field must remain an array: ${drop.id}.${drop.field}`);
    for (const value of drop.values) {
      if (states[0] === "retiring" && !includes(values, value)) {
        errors.push(`policy drop is premature: ${drop.id}.${drop.field}`);
      }
      if (states[0] === "retired" && includes(values, value)) {
        errors.push(`final policy phase must apply every declared drop: ${drop.id}.${drop.field}`);
      }
    }
  }
  if (states[0] === "retired") {
    const forbiddenPaths = new Set(["scripts/trusted-policy-guard.mjs", EVIDENCE_PATH,
      ".github/pull_request_template.md", "scripts/__tests__/pr-evidence.test.mjs"]);
    for (const collection of ["assets", "invariants"]) {
      for (const owner of catalog[collection] ?? []) {
        if (!["active", "retiring"].includes(owner.status)) continue;
        const gates = collection === "assets" ? owner.enforcement?.gates : owner.gates;
        const proofs = collection === "assets" ? owner.enforcement?.evidence : owner.evidence;
        if ((gates != null && !Array.isArray(gates)) || (proofs != null && !Array.isArray(proofs)) ||
            (owner.protectedPaths != null && !Array.isArray(owner.protectedPaths))) {
          errors.push(`live policy owner fields must be arrays: ${owner.id}`);
          continue;
        }
        if (gates?.includes("trusted-policy") || proofs?.some((proof) => forbiddenPaths.has(proof?.path)) ||
            owner.protectedPaths?.some((path) => forbiddenPaths.has(path))) {
          errors.push(`live policy owner retains retired PR protection: ${owner.id}`);
        }
      }
    }
  }
  return [...new Set(errors)];
}

export function getMainOnlyPlan(catalog) {
  const errors = validateMainOnlyPolicyCatalog(catalog);
  if (errors.length || catalog?.policyRemovals?.length !== 1) {
    throw new Error(errors.join("; ") || "main-only policy plan is missing");
  }
  return catalog.policyRemovals[0];
}
export function policyRemovalPhase(catalog) {
  getMainOnlyPlan(catalog);
  return entity(catalog, "gates", "trusted-policy").status;
}
export function isPolicyRetirement(catalog, collection, item) {
  return catalog?.policyRemovals?.length === 1 &&
    MAIN_ONLY_RETIRE[collection]?.includes(item?.id) &&
    isDeepStrictEqual(item.retirement, MAIN_ONLY_RETIREMENT) &&
    ["retiring", "retired"].includes(item.status);
}

export function validatePolicyRemovalPlan(catalog, { readFile, readBootstrapCatalog,
  isBootstrapAncestor } = {}) {
  const errors = validateMainOnlyPolicyCatalog(catalog);
  if (errors.length || !catalog.policyRemovals.length) return errors;
  const plan = getMainOnlyPlan(catalog);
  const decision = entity(catalog, "assets", plan.decision);
  const bytes = readFile?.(decision.path);
  if (bytes == null || !/^\s*-\s*状态：Accepted\s*$/m.test(String(bytes))) {
    errors.push("policy removal ADR must have actual Accepted bytes");
  } else if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== decision.checksum) {
    errors.push("policy removal ADR checksum does not match its actual bytes");
  }
  let bootstrap;
  try {
    if (!isBootstrapAncestor?.(plan.bootstrapHead)) throw new Error("not an ancestor");
    bootstrap = readBootstrapCatalog?.(plan.bootstrapHead);
    if (!bootstrap || ![1, 2].includes(bootstrap.schemaVersion) || bootstrap.policyRemovals?.length) {
      throw new Error("bootstrap must precede the policy declaration");
    }
  } catch {
    errors.push("policy bootstrap must be a real reachable ancestor with the pre-policy catalog");
    return errors;
  }
  for (const { collection, id } of targets()) {
    const original = entity(bootstrap, collection, id);
    const current = entity(catalog, collection, id);
    if (original?.status !== "active" || !isDeepStrictEqual(withoutLifecycle(current), withoutLifecycle(original))) {
      errors.push(`policy tombstone must preserve bootstrap record: ${collection}/${id}`);
    }
  }
  for (const drop of plan.drop) {
    for (const value of drop.values) {
      if (!includes(at(entity(bootstrap, drop.collection, drop.id), drop.field), value)) {
        errors.push(`policy drop was not present in bootstrap catalog: ${drop.id}.${drop.field}`);
      }
    }
  }
  const originalAdr = entity(bootstrap, "assets", "adr-0008-executable-governance");
  const currentAdr = entity(catalog, "assets", "adr-0008-executable-governance");
  if (!originalAdr || currentAdr?.status !== "active" || currentAdr.checksum !== originalAdr.checksum) {
    errors.push("ADR-0008 must remain active with its original checksum");
  }
  return errors;
}

export function validatePolicyRemovalTransition(current, base) {
  const errors = [];
  const previousPlans = base?.policyRemovals ?? [];
  const currentPlans = current?.policyRemovals ?? [];
  if (previousPlans.length && !isDeepStrictEqual(currentPlans, previousPlans)) {
    errors.push("declared policy removal plans are permanently immutable");
  }
  if (!currentPlans.length) return errors;
  errors.push(...validateMainOnlyPolicyCatalog(current));
  if (errors.length) return errors;
  const phase = policyRemovalPhase(current);
  if (!previousPlans.length && phase !== "retiring") {
    errors.push("policy retirement requires an already verified retiring baseline; declaration and deletion cannot share a push");
  }
  for (const { collection, id } of targets()) {
    const before = entity(base, collection, id);
    const after = entity(current, collection, id);
    const expected = !previousPlans.length ? "active" : entity(base, "gates", "trusted-policy")?.status;
    if (!before || before.status !== expected ||
        !isDeepStrictEqual(withoutLifecycle(before), withoutLifecycle(after))) {
      errors.push(`policy retirement must preserve the entire previous record: ${collection}/${id}`);
    }
    if (before?.status === "retired" && !isDeepStrictEqual(before, after)) {
      errors.push(`retired policy tombstone is immutable: ${collection}/${id}`);
    }
  }
  if (previousPlans.length) {
    errors.push(...validateMainOnlyPolicyCatalog(base).map((error) => `invalid policy baseline: ${error}`));
    if (entity(base, "gates", "trusted-policy")?.status === "retired" && phase !== "retired") {
      errors.push("retired policy phase cannot return to retiring");
    }
  }
  return errors;
}

// Called for each individual removed value; never bypass the ordinary comparator.
export function authorizedPolicyDrop(current, base, { collection, id, field, value }) {
  if (!base?.policyRemovals?.length || validatePolicyRemovalTransition(current, base).length) return false;
  if (policyRemovalPhase(current) !== "retired") return false;
  const drop = current.policyRemovals[0].drop.find((item) => item.collection === collection &&
    item.id === id && item.field === field);
  return drop?.values.some((item) => isDeepStrictEqual(item, value) ||
    (typeof value === "string" && typeof item === "object" && `${item.path}#${item.selector}` === value)) ?? false;
}
