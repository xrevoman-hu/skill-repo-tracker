#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectRepositoryContext } from "./governance-context.mjs";
import { changedPaths as collectChangedPaths } from "./governance-context.mjs";
import { MODULE_MAP_PATH } from "./module-map.mjs";
import { readActiveTestWaiverIds } from "./test-waivers.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const CATALOG_PATH = resolve(ROOT, "docs/engineering/governance-assets.json");
const MODULE_MAP_FILE = resolve(ROOT, MODULE_MAP_PATH);

const SECTION_HEADINGS = {
  changeKind: "变更类型",
  purpose: "变更目的",
  regression: "可复现证据",
  rootCause: "根因与同类扫描",
  stateBudget: "状态与权限预算",
  governance: "Rule / ADR / Invariant",
  testDebt: "Skip / flaky 债务",
  verification: "验证",
};

const CHANGE_KINDS = {
  bug: "Bug 修复",
  nonBug: "非 Bug 变更",
};

const STATE_BUDGETS = [
  {
    label: "设置项",
    marker: /不新增设置项/,
  },
  {
    label: "Tauri command/capability/entitlement/目录/网络 host",
    marker: /不新增\/扩大\s+Tauri command、capability、entitlement、目录或网络 host/,
  },
  {
    label: "后台状态/timer/daemon/常驻开销",
    marker: /不新增后台状态、timer、daemon 或常驻开销/,
  },
  {
    label: "数据库/导出/迁移兼容性",
    marker: /数据库\/导出\/迁移兼容性已说明并测试/,
  },
];

function withoutComments(value) {
  return String(value ?? "").replace(/<!--[\s\S]*?-->/g, "");
}

function sectionMap(body) {
  const sections = new Map();
  let current;
  for (const line of withoutComments(body).replace(/\r\n?/g, "\n").split("\n")) {
    const heading = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      current = heading[1];
      if (!sections.has(current)) sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return sections;
}

function section(sections, heading) {
  return (sections.get(heading) ?? []).join("\n");
}

function meaningfulText(value) {
  return withoutComments(value)
    .replace(/^\s*[-*]\s*/gm, "")
    .trim();
}

function checkboxChecked(sectionText, marker) {
  return sectionText.split("\n").some((line) => {
    const checkbox = line.match(/^\s*[-*]\s*\[[xX]\]\s*(.*)$/);
    return Boolean(checkbox && marker.test(checkbox[1]));
  });
}

function selectedChangeKinds(sectionText) {
  const selected = [];
  for (const line of sectionText.split("\n")) {
    const checkbox = line.match(/^\s*[-*]\s*\[[xX]\]\s*(.*)$/);
    if (!checkbox) continue;
    const label = meaningfulText(checkbox[1]);
    if (label === CHANGE_KINDS.bug) selected.push("bug");
    if (label === CHANGE_KINDS.nonBug) selected.push("nonBug");
  }
  return selected;
}

function tailAfterLastColon(line) {
  const index = Math.max(line.lastIndexOf("："), line.lastIndexOf(":"));
  return index === -1 ? "" : meaningfulText(line.slice(index + 1));
}

function explainedAfterColon(sectionText, marker) {
  const line = sectionText.split("\n").find((candidate) => marker.test(candidate));
  return Boolean(line && tailAfterLastColon(line));
}

function looksLikeFormField(line) {
  return /^\s*[-*]\s*(?:\[[ xX]\]\s*)?.+[：:]\s*/.test(line);
}

function fieldValue(sectionText, marker) {
  const lines = sectionText.split("\n");
  const index = lines.findIndex((line) => marker.test(line));
  if (index === -1) return "";

  const inline = tailAfterLastColon(lines[index]);
  if (inline) return inline;

  const continuation = [];
  for (const line of lines.slice(index + 1)) {
    if (looksLikeFormField(line)) break;
    if (meaningfulText(line)) continuation.push(line);
  }
  return meaningfulText(continuation.join("\n"));
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsIdentifier(value, identifier) {
  const escaped = escapedRegExp(identifier);
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`).test(value);
}

function isBugFixTitle(title) {
  return /\b(?:fix(?:es|ed)?|bug(?:fix)?|hotfix)\b|修复/i.test(title);
}

export function parseRequiredInvariantIds(value) {
  const ids = String(value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function normalizedIds(value) {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((id) => typeof id === "string" && id.trim())
            .map((id) => id.trim()),
        ),
      ]
    : parseRequiredInvariantIds(value);
}

export function selectRequiredGovernanceIds({ catalog, moduleMap, paths } = {}) {
  if (!catalog || typeof catalog !== "object") {
    throw new Error("governance catalog is missing or invalid");
  }
  if (!moduleMap || typeof moduleMap !== "object") {
    throw new Error("module map is missing or invalid");
  }
  if (!Array.isArray(paths)) throw new Error("changed paths are missing or invalid");
  const context = selectRepositoryContext(catalog, moduleMap, paths);
  const assetById = new Map((catalog.assets ?? []).map((asset) => [asset.id, asset]));
  return {
    assets: context.assets
      .filter((id) => ["rule", "decision"].includes(assetById.get(id)?.kind))
      .sort(),
    invariants: context.invariants,
  };
}

export function selectRequiredInvariantIds({ catalog, paths } = {}) {
  if (!catalog || typeof catalog !== "object") throw new Error("governance catalog is missing or invalid");
  if (!Array.isArray(paths)) throw new Error("changed paths are missing or invalid");
  return selectRepositoryContext(catalog, { modules: [] }, paths).invariants;
}

export function deriveRequiredGovernanceIds({
  baseRef,
  catalogPath = CATALOG_PATH,
  moduleMapPath = MODULE_MAP_FILE,
  readJson = (path) => JSON.parse(readFileSync(path, "utf8")),
  changedPaths = collectChangedPaths,
} = {}) {
  const normalizedBaseRef = typeof baseRef === "string" ? baseRef.trim() : "";
  if (!normalizedBaseRef) {
    throw new Error("VERIFY_BASE_REF is required for governance evidence discovery");
  }
  const catalog = readJson(catalogPath);
  const moduleMap = readJson(moduleMapPath);
  const paths = changedPaths({ baseRef: normalizedBaseRef, paths: [] });
  return selectRequiredGovernanceIds({ catalog, moduleMap, paths });
}

export function deriveRequiredInvariantIds({
  baseRef,
  catalogPath = CATALOG_PATH,
  readCatalog = (path) => JSON.parse(readFileSync(path, "utf8")),
  changedPaths = collectChangedPaths,
} = {}) {
  const normalizedBaseRef = typeof baseRef === "string" ? baseRef.trim() : "";
  if (!normalizedBaseRef) {
    throw new Error("VERIFY_BASE_REF is required for invariant discovery");
  }
  const catalog = readCatalog(catalogPath);
  const paths = changedPaths({ baseRef: normalizedBaseRef, paths: [] });
  return selectRequiredInvariantIds({ catalog, paths });
}

export function validatePullRequestEvidence({
  title,
  body,
  requiredAssetIds,
  requiredInvariantIds,
  activeWaiverIds,
} = {}) {
  const errors = [];
  const normalizedTitle = typeof title === "string" ? title.trim() : "";
  const normalizedBody = typeof body === "string" ? body : "";
  const assetIds = normalizedIds(requiredAssetIds);
  const invariantIds = normalizedIds(requiredInvariantIds);
  const activeWaivers = new Set(normalizedIds(activeWaiverIds));
  const sections = sectionMap(normalizedBody);

  if (!normalizedTitle) errors.push("PR 标题缺失");
  if (!normalizedBody.trim()) errors.push("PR 正文缺失");

  const changeKinds = selectedChangeKinds(
    section(sections, SECTION_HEADINGS.changeKind),
  );
  if (changeKinds.length !== 1) {
    errors.push("必须且只能选择一种变更类型：Bug 修复或非 Bug 变更");
  }
  const changeKind = changeKinds.length === 1 ? changeKinds[0] : undefined;
  if (changeKind === "nonBug" && normalizedTitle && isBugFixTitle(normalizedTitle)) {
    errors.push("标题表明是 Bug 修复，变更类型不能选择非 Bug 变更");
  }

  const purpose = section(sections, SECTION_HEADINGS.purpose);
  if (!fieldValue(purpose, /用户问题\/产品价值/)) {
    errors.push("变更目的必须填写用户问题/产品价值");
  }
  if (!fieldValue(purpose, /非目标/)) errors.push("变更目的必须填写非目标");
  if (!fieldValue(purpose, /验收层/)) errors.push("变更目的必须填写验收层");

  const stateBudget = section(sections, SECTION_HEADINGS.stateBudget);
  for (const budget of STATE_BUDGETS) {
    if (
      !checkboxChecked(stateBudget, budget.marker) &&
      !explainedAfterColon(stateBudget, budget.marker)
    ) {
      errors.push(`状态与权限预算未确认或解释：${budget.label}`);
    }
  }

  const governance = section(sections, SECTION_HEADINGS.governance);
  for (const id of assetIds) {
    if (!containsIdentifier(governance, id)) {
      errors.push(`缺少必须复审的 owning Rule/ADR asset ID：${id}`);
    }
  }
  if (invariantIds.length > 0) {
    for (const id of invariantIds) {
      if (!containsIdentifier(governance, id)) {
        errors.push(`缺少必须复审的高风险不变量 ID：${id}`);
      }
    }
  } else if (assetIds.length === 0 && !checkboxChecked(governance, /本变更未产生新的长期边界/)) {
    errors.push("没有匹配到高风险不变量时，必须确认本变更未产生新的长期边界");
  }

  const testDebt = section(sections, SECTION_HEADINGS.testDebt);
  const declaresNoWaiver = checkboxChecked(testDebt, /没有引用独立 lane test waiver/i);
  const waiverValue = fieldValue(testDebt, /填写 active ledger ID/i);
  const waiverIds = [...waiverValue.matchAll(/\bWAIVER-\d{4}-\d{3}\b/g)].map(
    (match) => match[0],
  );
  if (declaresNoWaiver && waiverValue) {
    errors.push("test waiver 声明必须且只能选择：无 waiver，或填写一个 active WAIVER ID");
  } else if (!declaresNoWaiver) {
    if (waiverIds.length !== 1 || waiverValue !== waiverIds[0]) {
      errors.push("skip/flaky 债务必须且只能填写一个 active WAIVER ID");
    } else if (!activeWaivers.has(waiverIds[0])) {
      errors.push(`test waiver ${waiverIds[0]} 不在 tracked ledger 的 active 清单中`);
    }
  }

  const verification = section(sections, SECTION_HEADINGS.verification);
  if (!checkboxChecked(verification, /`?npm\s+run\s+verify`?/)) {
    errors.push("必须勾选 npm run verify");
  }
  const laneRan =
    checkboxChecked(verification, /独立 lane.*已运行/) &&
    Boolean(fieldValue(verification, /独立 lane.*已运行/));
  const laneNotApplicable =
    checkboxChecked(verification, /独立 lane 不适用/) &&
    Boolean(fieldValue(verification, /独立 lane 不适用/));
  if (laneRan === laneNotApplicable) {
    errors.push("独立 lane 必须且只能选择：已运行并填写结果/链接，或不适用并填写原因");
  }
  if (!checkboxChecked(verification, /没有秘密、真实用户数据、`AGENTS\.md`、`docs\/internal\/` 或宣传草稿进入 diff/)) {
    errors.push("必须确认 diff 不包含秘密、真实用户数据或本机/内部资料");
  }

  if (changeKind === "bug") {
    const regression = section(sections, SECTION_HEADINGS.regression);
    const hasRegression =
      checkboxChecked(regression, /新增了能让旧实现失败的回归测试/) &&
      Boolean(fieldValue(regression, /新增了能让旧实现失败的回归测试/));
    const automationReason = fieldValue(regression, /若不能先写自动化失败测试/);
    if (!hasRegression && !automationReason) {
      errors.push("Bug 修复必须勾选回归测试，或填写不能自动化的原因与替代证据");
    }

    const rootCause = section(sections, SECTION_HEADINGS.rootCause);
    if (!fieldValue(rootCause, /根因（不要只复述症状）/)) {
      errors.push("Bug 修复必须填写根因");
    }
    if (!fieldValue(rootCause, /已扫描的同类入口、adapter、竞态或数据路径/)) {
      errors.push("Bug 修复必须填写同类扫描路径");
    }
    if (!fieldValue(rootCause, /扫描结论\/一并修复项/)) {
      errors.push("Bug 修复必须填写同类扫描结论");
    }
  }

  return errors;
}

export function runCli({
  env = process.env,
  deriveRequirements = deriveRequiredGovernanceIds,
  deriveInvariantIds,
  requiredAssetIds: injectedAssetIds,
  requiredInvariantIds: injectedInvariantIds,
  activeWaiverIds: injectedWaiverIds,
  loadActiveWaiverIds = ({ now: current }) =>
    readActiveTestWaiverIds(undefined, { now: current }),
  now = new Date(),
  stdout = console.log,
  stderr = console.error,
} = {}) {
  let requiredAssetIds;
  let requiredInvariantIds;
  if (injectedInvariantIds !== undefined) {
    requiredAssetIds = normalizedIds(injectedAssetIds);
    requiredInvariantIds = Array.isArray(injectedInvariantIds)
      ? injectedInvariantIds
      : parseRequiredInvariantIds(injectedInvariantIds);
  } else {
    try {
      const requirements = deriveInvariantIds
        ? { assets: [], invariants: deriveInvariantIds({ baseRef: env.VERIFY_BASE_REF }) }
        : deriveRequirements({ baseRef: env.VERIFY_BASE_REF });
      requiredAssetIds = normalizedIds(requirements.assets);
      requiredInvariantIds = normalizedIds(requirements.invariants);
    } catch (error) {
      stderr("PR evidence governance discovery failed:");
      stderr(`- ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  let activeWaiverIds;
  try {
    activeWaiverIds =
      injectedWaiverIds === undefined
        ? loadActiveWaiverIds({ now })
        : normalizedIds(injectedWaiverIds);
  } catch (error) {
    stderr("PR evidence waiver discovery failed:");
    stderr(`- ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const errors = validatePullRequestEvidence({
    title: env.PR_TITLE,
    body: env.PR_BODY,
    requiredAssetIds,
    requiredInvariantIds,
    activeWaiverIds,
  });
  if (errors.length > 0) {
    stderr("PR evidence validation failed:");
    for (const error of errors) stderr(`- ${error}`);
    return 1;
  }
  stdout("PASS pull request evidence completeness");
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCli();
}
