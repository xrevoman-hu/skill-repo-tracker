import { createHash } from "node:crypto";
import { executableTestDeclarations, reachableRustEvidencePaths, evidencePathIsCollected } from "./governance-evidence.mjs";
import { isPolicyRetirement, validateMainOnlyPolicyCatalog } from "./governance-policy-removal.mjs";
import {
  assetReplacementCoverageErrors,
  evidenceRunner,
  gateRunnerCoverage,
  invariantReplacementCoverageErrors,
  migrationAuthorizationErrors,
  resolveActiveAssetReplacement,
  validateContextBudgets,
  validateGateRetirements,
} from "./governance-assets-history.mjs";
export { compareGovernanceAssetCatalogs } from "./governance-assets-history.mjs";

const PRINCIPLES = new Map([
  [1, "架构、分层与依赖方向"],
  [2, "高风险不变量与回归测试"],
  [3, "Bug 复现、根因、同类扫描与沉淀"],
  [4, "模块化 Rules、ADR 与上下文选择"],
  [5, "功能、状态、权限与常驻成本克制"],
  [6, "GitHub 自动化与远端保护"],
  [7, "AI 自动验证、分层验收与资产退休"],
]);
const PRINCIPLE_IDS = [...PRINCIPLES.keys()];
const REQUIRED_GLOBAL_ASSET_IDS = new Set([
  "shared-glossary",
  "maintainability-system",
  "architecture-fact-source",
  "contribution-contract",
]);
const ASSET_KINDS = new Set([
  "architecture",
  "budget",
  "decision",
  "fixture",
  "glossary",
  "playbook",
  "policy",
  "rule",
  "template",
]);
const ASSET_STATUSES = new Set(["active", "superseded"]);
const GATE_STATUSES = new Set(["active", "retiring", "retired"]);
const ENFORCEMENT_MODES = new Set(["automated", "mixed", "review"]);
const REQUIRED_PR_TEMPLATE_MARKERS = [
  "## 变更类型",
  "Bug 修复",
  "非 Bug 变更",
  "## 变更目的",
  "用户问题/产品价值",
  "非目标",
  "验收层",
  "## 可复现证据",
  "## 根因与同类扫描",
  "## 状态与权限预算",
  "## Rule / ADR / Invariant",
  "## Skip / flaky 债务",
  "## 验证",
  "已复审资产/高风险不变量 ID：",
  "`npm run verify`",
  "与本变更相关的独立 lane（coverage/E2E/MSRV/性能/Release）已运行，结果/链接：",
  "独立 lane 不适用，原因：",
  "没有秘密、真实用户数据、`AGENTS-local.md`、`docs/internal/` 或宣传草稿进入 diff",
];

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function selectorMatchesPath(selector, path) {
  return selector.endsWith("/") ? path.startsWith(selector) : path === selector;
}

function anySelectorMatches(selectors, paths) {
  return selectors.some((selector) => paths.some((path) => selectorMatchesPath(selector, path)));
}

function readText(readFile, path) {
  const contents = readFile(path);
  if (contents == null) return undefined;
  return Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents);
}

function validatePrinciples(principles, label, errors) {
  if (!Array.isArray(principles) || principles.length === 0) {
    errors.push(`${label} must reference at least one governance principle`);
    return;
  }
  for (const principle of principles) {
    if (!PRINCIPLE_IDS.includes(principle)) {
      errors.push(`${label} references unknown governance principle: ${principle}`);
    }
  }
}

function validateEvidence({
  owner,
  evidence,
  enforcementGates,
  gateCoverage,
  tracked,
  readFile,
  rustReachable,
  errors,
}) {
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || typeof item.path !== "string" || typeof item.selector !== "string") {
      errors.push(`${owner} evidence must contain path and selector`);
      continue;
    }
    if (!tracked.has(item.path)) {
      errors.push(`${owner} evidence path is not tracked: ${item.path}`);
      continue;
    }
    const contents = readText(readFile, item.path);
    if (contents == null) {
      errors.push(`${owner} evidence cannot be read: ${item.path}`);
    } else if (!evidencePathIsCollected(item.path, rustReachable)) {
      errors.push(`${owner} evidence is not collected by a governed test runner: ${item.path}`);
    } else if (!executableTestDeclarations(contents, item.path).has(item.selector)) {
      errors.push(
        `${owner} evidence selector is not an executable test declaration in ${item.path}: ${item.selector}`,
      );
    }
    const runner = evidenceRunner(item.path);
    if (
      runner &&
      !(enforcementGates ?? []).some((gateId) => gateCoverage.get(gateId)?.has(runner))
    ) {
      errors.push(
        `${owner} evidence runner ${runner} is not executed by any declared gate: ${item.path}`,
      );
    }
  }
}

export function validateGovernanceAssetCatalog({
  catalog,
  trackedFiles,
  packageScripts,
  readFile,
  commitExists,
}) {
  const errors = [];
  const tracked = new Set(trackedFiles);
  const rustReachable = reachableRustEvidencePaths(tracked, readFile);
  if (catalog?.schemaVersion !== 2) {
    errors.push(`governance catalog schemaVersion must be 2; found ${catalog?.schemaVersion ?? "missing"}`);
  }
  errors.push(...validateMainOnlyPolicyCatalog(catalog));

  const principles = Array.isArray(catalog?.principles) ? catalog.principles : [];
  const principleIds = principles.map((principle) => principle?.id);
  if (
    principleIds.length !== PRINCIPLE_IDS.length ||
    !PRINCIPLE_IDS.every((id) => principleIds.includes(id)) ||
    duplicates(principleIds).length > 0
  ) {
    errors.push("governance catalog must define principles 1 through 7 exactly once");
  }
  for (const principle of principles) {
    const expectedName = PRINCIPLES.get(principle?.id);
    if (expectedName && principle?.name !== expectedName) {
      errors.push(
        `governance principle ${principle.id} name must remain exactly: ${expectedName}`,
      );
    }
  }

  const gates = Array.isArray(catalog?.gates) ? catalog.gates : [];
  const gateIds = gates.map((gate) => gate?.id).filter(Boolean);
  for (const id of duplicates(gateIds)) errors.push(`governance gate id is duplicated: ${id}`);
  const gateById = new Map(gates.map((gate) => [gate?.id, gate]));
  const gateCoverage = gateRunnerCoverage(gates, packageScripts, readFile);
  for (const gate of gates) {
    if (!gate?.id || !["package-script", "workflow"].includes(gate.kind)) {
      errors.push("governance gate must have an id and a supported kind");
      continue;
    }
    if (!GATE_STATUSES.has(gate.status)) {
      errors.push(
        `governance gate ${gate.id} has unsupported status: ${gate.status ?? "missing"}`,
      );
    }
    if (
      ["retiring", "retired"].includes(gate.status) &&
      (typeof gate.retirement?.reason !== "string" || gate.retirement.reason.trim() === "")
    ) {
      errors.push(`${gate.status} governance gate ${gate.id} must declare a retirement reason`);
    }
    if (gate.status === "active" && gate.retirement != null) {
      errors.push(`active governance gate ${gate.id} cannot declare retirement metadata`);
    }
    if (
      gate.status !== "retired" &&
      gate.kind === "package-script" &&
      !Object.hasOwn(packageScripts ?? {}, gate.ref)
    ) {
      errors.push(`governance gate ${gate.id} references missing package script: ${gate.ref}`);
    }
    if (gate.status !== "retired" && gate.kind === "workflow" && !tracked.has(gate.ref)) {
      errors.push(`governance gate ${gate.id} references untracked workflow: ${gate.ref}`);
    }
  }

  const assets = Array.isArray(catalog?.assets) ? catalog.assets : [];
  const assetIds = assets.map((asset) => asset?.id).filter(Boolean);
  const assetPaths = assets.map((asset) => asset?.path).filter(Boolean);
  for (const id of duplicates(assetIds)) errors.push(`governance asset id is duplicated: ${id}`);
  for (const path of duplicates(assetPaths)) {
    errors.push(`governance asset path is indexed more than once: ${path}`);
  }
  const assetById = new Map(assets.map((asset) => [asset?.id, asset]));

  errors.push(...validateGateRetirements(gates, gateById, assetById, { gateCoverage, catalog }));

  for (const id of REQUIRED_GLOBAL_ASSET_IDS) {
    const asset = assetById.get(id);
    if (asset?.status !== "active" || asset.alwaysLoad !== true) {
      errors.push(`required global governance asset ${id} must remain active with alwaysLoad=true`);
    }
  }

  for (const asset of assets) {
    const owner = `governance asset ${asset?.id ?? "missing-id"}`;
    if (!asset?.id || !ASSET_KINDS.has(asset.kind)) {
      errors.push(`${owner} must have a stable id and supported kind`);
      continue;
    }
    const policyRetirement = isPolicyRetirement(catalog, "assets", asset);
    if (!ASSET_STATUSES.has(asset.status) && !policyRetirement) {
      errors.push(`${owner} has unsupported status: ${asset.status ?? "missing"}`);
    }
    if (asset.status === "superseded") {
      for (const error of migrationAuthorizationErrors(asset.id, asset.migration, assetById)) {
        errors.push(`superseded ${owner} migration is invalid: ${error}`);
      }
      const resolution = resolveActiveAssetReplacement(asset, assetById);
      if (resolution.error) {
        errors.push(`superseded ${owner} ${resolution.error}`);
      } else {
        for (const gap of assetReplacementCoverageErrors(asset, resolution.replacement, { gateById })) {
          errors.push(`superseded ${owner} has incomplete replacement: ${gap}`);
        }
      }
    } else {
      if (asset.supersededBy != null) errors.push(`active ${owner} cannot declare supersededBy`);
      if (asset.migration != null) errors.push(`active ${owner} cannot declare migration metadata`);
    }
    if (policyRetirement && asset.status === "retired") continue;
    if (typeof asset.path !== "string" || !tracked.has(asset.path)) {
      errors.push(`${owner} path is not tracked: ${asset.path ?? "missing"}`);
      continue;
    }
    const rawContents = readFile(asset.path);
    const contents =
      rawContents == null
        ? undefined
        : Buffer.isBuffer(rawContents)
          ? rawContents.toString("utf8")
          : String(rawContents);
    if (contents == null) errors.push(`${owner} cannot be read: ${asset.path}`);
    validatePrinciples(asset.principles, owner, errors);

    if (["rule", "decision"].includes(asset.kind)) {
      if (!Array.isArray(asset.reviewOnChange) || asset.reviewOnChange.length === 0) {
        errors.push(`${owner} must declare reviewOnChange selectors`);
      } else {
        for (const selector of asset.reviewOnChange) {
          if (!trackedFiles.some((path) => selectorMatchesPath(selector, path))) {
            errors.push(`${owner} review selector matches no tracked path: ${selector}`);
          }
        }
      }
    }

    const enforcement = asset.enforcement ?? {};
    if (!ENFORCEMENT_MODES.has(enforcement.mode)) {
      errors.push(`${owner} has unsupported enforcement mode: ${enforcement.mode ?? "missing"}`);
    }
    const enforcementGates = Array.isArray(enforcement.gates) ? enforcement.gates : [];
    for (const gateId of enforcementGates) {
      const gate = gateById.get(gateId);
      if (!gate) errors.push(`${owner} references unknown gate: ${gateId}`);
      else if (gate.status === "retired") errors.push(`${owner} references retired gate: ${gateId}`);
    }
    const evidence = Array.isArray(enforcement.evidence) ? enforcement.evidence : [];
    if (["automated", "mixed"].includes(enforcement.mode)) {
      if (enforcementGates.length === 0) errors.push(`${owner} must name an automated gate`);
      if (evidence.length === 0) errors.push(`${owner} must name executable evidence`);
    }
    validateEvidence({
      owner,
      evidence,
      enforcementGates,
      gateCoverage,
      tracked,
      readFile,
      rustReachable,
      errors,
    });

    if (asset.kind === "decision") {
      const expected = asset.checksum?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
      const actual =
        rawContents == null
          ? undefined
          : createHash("sha256")
              .update(Buffer.isBuffer(rawContents) ? rawContents : Buffer.from(String(rawContents)))
              .digest("hex");
      if (!expected) {
        errors.push(`decision ${asset.id} must declare a sha256 checksum`);
      } else if (actual !== expected) {
        errors.push(`decision ${asset.id} checksum changed: ${asset.path}`);
      }
      if (asset.status === "active" && contents != null && !/^\s*-\s*状态：Accepted\s*$/m.test(contents)) {
        errors.push(
          `active decision ${asset.id} must declare '- 状态：Accepted' in ${asset.path}`,
        );
      }
    }
    if (asset.kind === "fixture") {
      if (asset.status !== "active") {
        errors.push(`published fixture ${asset.id} must remain active forever`);
      }
      const expected = asset.checksum?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
      const actual =
        rawContents == null
          ? undefined
          : createHash("sha256")
              .update(Buffer.isBuffer(rawContents) ? rawContents : Buffer.from(String(rawContents)))
              .digest("hex");
      if (!expected) {
        errors.push(`fixture ${asset.id} must declare a sha256 checksum`);
      } else if (actual !== expected) {
        errors.push(`fixture ${asset.id} checksum changed: ${asset.path}`);
      }
    }
  }

  const indexedRulePaths = new Set(
    assets.filter((asset) => asset.kind === "rule").map((asset) => asset.path),
  );
  const indexedDecisionPaths = new Set(
    assets.filter((asset) => asset.kind === "decision").map((asset) => asset.path),
  );
  for (const path of trackedFiles.filter((path) => /^docs\/rules\/.+\.md$/.test(path))) {
    if (!indexedRulePaths.has(path)) {
      errors.push(`tracked Rule is not indexed by the governance catalog: ${path}`);
    }
  }
  for (const path of trackedFiles.filter((path) => /^docs\/adr\/.+\.md$/.test(path))) {
    if (!indexedDecisionPaths.has(path)) {
      errors.push(`tracked ADR is not indexed by the governance catalog: ${path}`);
    }
  }

  const invariants = Array.isArray(catalog?.invariants) ? catalog.invariants : [];
  const invariantIds = invariants.map((invariant) => invariant?.id).filter(Boolean);
  const invariantById = new Map(invariants.map((invariant) => [invariant?.id, invariant]));
  for (const id of duplicates(invariantIds)) {
    errors.push(`governance invariant id is duplicated: ${id}`);
  }
  for (const invariant of invariants) {
    const owner = `governance invariant ${invariant?.id ?? "missing-id"}`;
    if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}$/.test(invariant?.id ?? "")) {
      errors.push(`${owner} must use a stable uppercase ID ending in three digits`);
      continue;
    }
    if (!["active", "retiring", "retired"].includes(invariant.status)) {
      errors.push(`${owner} has unsupported status: ${invariant.status ?? "missing"}`);
    }
    if (
      ["retiring", "retired"].includes(invariant.status) &&
      (typeof invariant.retirement?.reason !== "string" ||
        invariant.retirement.reason.trim() === "")
    ) {
      errors.push(`${invariant.status} ${owner} must declare a retirement reason`);
    }
    if (invariant.status === "active" && invariant.retirement != null) {
      errors.push(`active ${owner} cannot declare retirement metadata`);
    }
    const policyRetirement = isPolicyRetirement(catalog, "invariants", invariant);
    const retirementKinds = [Boolean(invariant.retirement?.replacement),
      invariant.retirement?.featureRemoved === true, Boolean(invariant.retirement?.policyRemoval)];
    if (retirementKinds.filter(Boolean).length > 1) {
      errors.push(`${owner} retirement reasons are mutually exclusive`);
    }
    if (invariant.retirement?.replacement) {
      for (const error of migrationAuthorizationErrors(
        invariant.id,
        invariant.retirement?.migration,
        assetById,
      )) {
        errors.push(`${owner} retirement migration is invalid: ${error}`);
      }
      const replacement = invariantById.get(invariant.retirement.replacement);
      if (replacement?.status !== "active" || replacement.id === invariant.id) {
        errors.push(`${owner} retirement replacement must reference another active invariant`);
      } else {
        for (const gap of invariantReplacementCoverageErrors(invariant, replacement, { gateById })) {
          errors.push(`${owner} retirement replacement is incomplete: ${gap}`);
        }
      }
    } else if (invariant.retirement?.migration != null) {
      errors.push(`${owner} cannot declare a migration without a retirement replacement`);
    }
    if (invariant.status === "retired" && !invariant.retirement?.replacement && !policyRetirement) {
      const removalDecision = assetById.get(invariant.retirement?.removalDecision);
      if (invariant.retirement?.featureRemoved !== true || removalDecision?.kind !== "decision") {
        errors.push(
          `${owner} retired tombstone must reference a removalDecision ADR and declare featureRemoved=true`,
        );
      }
    }
    validatePrinciples(invariant.principles, owner, errors);
    const rule = assetById.get(invariant.rule);
    if (rule?.kind !== "rule") errors.push(`${owner} references unknown Rule asset: ${invariant.rule}`);
    for (const decisionId of Array.isArray(invariant.decisions) ? invariant.decisions : []) {
      if (assetById.get(decisionId)?.kind !== "decision") {
        errors.push(`${owner} references unknown decision asset: ${decisionId}`);
      }
    }
    const protectedPaths = Array.isArray(invariant.protectedPaths)
      ? invariant.protectedPaths
      : [];
    if (protectedPaths.length === 0) {
      errors.push(`${owner} must protect at least one tracked path`);
    }
    for (const selector of protectedPaths) {
      if (
        invariant.status === "active" &&
        !trackedFiles.some((path) => selectorMatchesPath(selector, path))
      ) {
        errors.push(`${owner} protected path matches no tracked file: ${selector}`);
      }
    }
    const invariantGates = Array.isArray(invariant.gates) ? invariant.gates : [];
    if (invariantGates.length === 0) {
      errors.push(`${owner} must name at least one gate`);
    }
    for (const gateId of invariantGates) {
      const gate = gateById.get(gateId);
      if (!gate && invariant.status !== "retired") {
        errors.push(`${owner} references unknown gate: ${gateId}`);
      } else if (gate?.status === "retired" && invariant.status !== "retired") {
        errors.push(`${owner} references retired gate: ${gateId}`);
      }
    }
    const invariantEvidence = Array.isArray(invariant.evidence) ? invariant.evidence : [];
    if (invariantEvidence.length === 0) {
      errors.push(`${owner} must name executable evidence`);
    }
    if (invariant.status !== "retired") {
      validateEvidence({
        owner,
        evidence: invariantEvidence,
        enforcementGates: invariantGates,
        gateCoverage,
        tracked,
        readFile,
        rustReachable,
        errors,
      });
    }
    if (!/^[0-9a-f]{40}$/.test(invariant.introducedBy ?? "")) {
      errors.push(`${owner} introducedBy must be a full 40-character lowercase commit SHA`);
    } else if (!commitExists(invariant.introducedBy)) {
      errors.push(`${owner} introducedBy commit does not exist: ${invariant.introducedBy}`);
    }
    if (typeof invariant.retireWhen !== "string" || invariant.retireWhen.trim() === "") {
      errors.push(`${owner} must declare a concrete retireWhen condition`);
    }
  }

  for (const principle of PRINCIPLE_IDS) {
    const covered = invariants.some(
      (invariant) =>
        invariant.status === "active" &&
        invariant.principles?.includes(principle) &&
        invariant.gates?.length > 0 &&
        invariant.evidence?.length > 0,
    );
    if (!covered) {
      errors.push(`governance principle ${principle} has no active executable invariant`);
    }
  }

  errors.push(...validateContextBudgets(catalog, readFile));

  return [...new Set(errors)].sort();
}

export function selectGovernanceContext(catalog, changedPaths) {
  const changedAssetIds = new Set(
    (catalog.assets ?? [])
      .filter((asset) => changedPaths.includes(asset.path))
      .map((asset) => asset.id),
  );
  const selectedAssets = new Set(
    (catalog.assets ?? [])
    .filter(
      (asset) =>
        asset.status === "active" &&
        (asset.alwaysLoad === true ||
          changedPaths.includes(asset.path) ||
          (["rule", "decision"].includes(asset.kind) &&
            anySelectorMatches(asset.reviewOnChange ?? [], changedPaths))),
    )
      .map((asset) => asset.id),
  );
  const selectedInvariants = (catalog.invariants ?? [])
    .filter(
      (invariant) =>
        ["active", "retiring"].includes(invariant.status) &&
        (anySelectorMatches(invariant.protectedPaths ?? [], changedPaths) ||
          (invariant.evidence ?? []).some((item) => changedPaths.includes(item.path)) ||
          changedAssetIds.has(invariant.rule) ||
          (invariant.decisions ?? []).some((decision) => changedAssetIds.has(decision))),
    );
  for (const invariant of selectedInvariants) {
    selectedAssets.add(invariant.rule);
    for (const decision of invariant.decisions ?? []) selectedAssets.add(decision);
  }
  return {
    assets: [...selectedAssets].sort(),
    invariants: selectedInvariants.map((invariant) => invariant.id).sort(),
  };
}

export function validatePullRequestTemplate(contents) {
  return REQUIRED_PR_TEMPLATE_MARKERS.flatMap((marker) =>
    contents.includes(marker)
      ? []
      : [`pull request template is missing required evidence marker: ${marker}`],
  );
}
