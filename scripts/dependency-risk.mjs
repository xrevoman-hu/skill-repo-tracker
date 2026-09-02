#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gitPathExistsAtRef } from "./git-paths-core.mjs";
import {
  createIsolatedCargoAuditEnvironment,
  MAX_OUTPUT_BYTES,
  spawn,
} from "./dependency-risk-runtime.mjs";

export const DEPENDENCY_RISK_PATH = "docs/engineering/dependency-risk-ledger.json";
export const AUDITED_TARGETS = Object.freeze([
  "aarch64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const ROOT_FIELDS = ["schemaVersion", "risks"];
const PACKAGE_FIELDS = ["name", "version", "source"];
const ACTIVE_FIELDS = [
  "id",
  "status",
  "ecosystem",
  "package",
  "advisory",
  "warningKind",
  "affectedTargets",
  "owner",
  "createdOn",
  "reviewOn",
  "reason",
  "exitCondition",
  "reviewTriggers",
];
const RETIRED_FIELDS = [...ACTIVE_FIELDS, "retiredOn", "retirementReason"];
const RISK_ID = /^RISK-(\d{4})-(\d{3})$/;
const ADVISORY_ID = /^RUSTSEC-\d{4}-\d{4}$/;
const PACKAGE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;
const PACKAGE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CARGO_SOURCE = /^[a-z][a-z0-9+.-]*\+\S+$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TRIGGER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_DAYS = 90;
const AUDIT_VERSION = "0.22.2";
const KNOWN_WARNING_KINDS = new Set(["unsound", "unmaintained", "yanked", "notice"]);
const REGISTRY_INDEX_UPDATE_MARKER = "Updating crates.io index";
const REGISTRY_INDEX_FAILURE = /\bcouldn't\b/i;
const AUDIT_SETTINGS_FIELDS = [
  "target_arch",
  "target_os",
  "severity",
  "ignore",
  "informational_warnings",
];
const INFORMATIONAL_WARNINGS = Object.freeze(["notice", "unmaintained", "unsound"]);

function exactFields(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) errors.push(`${label} has unknown field ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) errors.push(`${label} is missing field ${key}`);
  }
  return true;
}

function parseDate(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
    ? timestamp
    : undefined;
}

function utcDay(value, label) {
  const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${label} must be a valid date`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function nonEmptyText(value, minimum = 12, maximum = 500) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\r\n]/.test(value)
  );
}

function validateSortedUnique(values, label, errors, { allowed, pattern } = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    errors.push(`${label} must contain non-empty strings`);
    return;
  }
  if (new Set(values).size !== values.length) errors.push(`${label} must be unique`);
  if (!isDeepStrictEqual(values, [...values].sort())) errors.push(`${label} must be sorted`);
  if (allowed && values.some((value) => !allowed.has(value))) {
    errors.push(`${label} may only name the fixed audited targets`);
  }
  if (pattern && values.some((value) => !pattern.test(value))) {
    errors.push(`${label} values must use canonical kebab-case identifiers`);
  }
}

function validateRiskEntry(entry, index, today, enforceFreshness, errors) {
  const label = `dependency risk at index ${index}`;
  const fields = entry?.status === "retired" ? RETIRED_FIELDS : ACTIVE_FIELDS;
  if (!exactFields(entry, fields, label, errors)) return;

  const idMatch = typeof entry.id === "string" ? entry.id.match(RISK_ID) : undefined;
  if (!idMatch) errors.push(`${label} id must match RISK-YYYY-NNN`);
  if (!['active', 'retired'].includes(entry.status)) {
    errors.push(`${label} status must be active or retired`);
  }
  if (entry.ecosystem !== "cargo") errors.push(`${label} ecosystem must be cargo`);
  if (entry.warningKind !== "unsound") errors.push(`${label} warningKind must be unsound`);
  if (typeof entry.advisory !== "string" || !ADVISORY_ID.test(entry.advisory)) {
    errors.push(`${label} advisory must be a RUSTSEC advisory ID`);
  }
  if (typeof entry.owner !== "string" || !OWNER.test(entry.owner)) {
    errors.push(`${label} owner must be a canonical GitHub login without @`);
  }
  if (!nonEmptyText(entry.reason)) errors.push(`${label} reason must be a 12-500 character single line`);
  if (!nonEmptyText(entry.exitCondition)) {
    errors.push(`${label} exitCondition must be a 12-500 character single line`);
  }

  if (exactFields(entry.package, PACKAGE_FIELDS, `${label} package`, errors)) {
    if (typeof entry.package.name !== "string" || !PACKAGE_NAME.test(entry.package.name)) {
      errors.push(`${label} package.name must be a canonical Cargo package name`);
    }
    if (typeof entry.package.version !== "string" || !PACKAGE_VERSION.test(entry.package.version)) {
      errors.push(`${label} package.version must be a non-empty Cargo version`);
    }
    if (!nonEmptyText(entry.package.source, 5, 500) || !CARGO_SOURCE.test(entry.package.source)) {
      errors.push(`${label} package.source must be a canonical single-line Cargo source identity`);
    }
  }

  validateSortedUnique(
    entry.affectedTargets,
    `${label} affectedTargets`,
    errors,
    { allowed: new Set(AUDITED_TARGETS) },
  );
  validateSortedUnique(entry.reviewTriggers, `${label} reviewTriggers`, errors, { pattern: TRIGGER });

  const created = parseDate(entry.createdOn);
  const review = parseDate(entry.reviewOn);
  if (created === undefined) errors.push(`${label} createdOn must be a real YYYY-MM-DD UTC date`);
  if (review === undefined) errors.push(`${label} reviewOn must be a real YYYY-MM-DD UTC date`);
  if (created !== undefined && created > today) errors.push(`${label} createdOn cannot be in the future`);
  if (created !== undefined && idMatch && Number(idMatch[1]) !== new Date(created).getUTCFullYear()) {
    errors.push(`${label} id year must match createdOn`);
  }
  if (created !== undefined && review !== undefined) {
    const lifetime = (review - created) / DAY_MS;
    if (lifetime < 0 || lifetime > MAX_ACTIVE_DAYS) {
      errors.push(`${label} reviewOn must be within at most 90 UTC days of createdOn`);
    }
    if (entry.status === "active" && enforceFreshness && review < today) {
      errors.push(`${entry.id} expired on ${entry.reviewOn}`);
    }
  }

  if (entry.status === "retired") {
    const retired = parseDate(entry.retiredOn);
    if (retired === undefined) errors.push(`${label} retiredOn must be a real YYYY-MM-DD UTC date`);
    if (retired !== undefined && retired > today) errors.push(`${label} retiredOn cannot be in the future`);
    if (created !== undefined && retired !== undefined && retired < created) {
      errors.push(`${label} retiredOn cannot be earlier than createdOn`);
    }
    if (!nonEmptyText(entry.retirementReason)) {
      errors.push(`${label} retirementReason must be a 12-500 character single line`);
    }
  }
}

function riskIdentity(entry) {
  return [entry?.advisory, entry?.package?.name, entry?.package?.version, entry?.package?.source].join("\0");
}

export function validateDependencyRiskLedger(
  document,
  { now = new Date(), enforceFreshness = true } = {},
) {
  const errors = [];
  const today = utcDay(now, "now");
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return ["dependency risk ledger must be an object"];
  }
  for (const key of Object.keys(document)) {
    if (!ROOT_FIELDS.includes(key)) errors.push(`dependency risk ledger has unknown root field ${key}`);
  }
  for (const key of ROOT_FIELDS) {
    if (!Object.hasOwn(document, key)) errors.push(`dependency risk ledger is missing root field ${key}`);
  }
  if (document.schemaVersion !== 1) errors.push("dependency risk ledger schemaVersion must be 1");
  if (!Array.isArray(document.risks)) {
    errors.push("dependency risk ledger risks must be an array");
    return errors;
  }
  document.risks.forEach((entry, index) =>
    validateRiskEntry(entry, index, today, enforceFreshness, errors),
  );
  const ids = document.risks.map((entry) => entry?.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    errors.push("dependency risk IDs must be unique strings");
  }
  if (!isDeepStrictEqual(ids, [...ids].sort())) errors.push("dependency risks must be sorted by id");
  const identities = document.risks
    .filter((entry) => entry?.status === "active")
    .map(riskIdentity);
  if (new Set(identities).size !== identities.length) {
    errors.push("active dependency risk advisory and package identities must be unique");
  }
  return [...new Set(errors)];
}

function activeShape(entry) {
  return Object.fromEntries(
    ACTIVE_FIELDS.map((field) => [field, field === "status" ? "active" : entry?.[field]]),
  );
}

export function compareDependencyRiskLedgers(current, base) {
  const errors = [];
  if (current?.schemaVersion !== base?.schemaVersion) {
    errors.push("dependency risk ledger schemaVersion is immutable");
  }
  const currentById = new Map((current?.risks ?? []).map((entry) => [entry.id, entry]));
  const baseById = new Map((base?.risks ?? []).map((entry) => [entry.id, entry]));
  for (const [id, previous] of baseById) {
    const next = currentById.get(id);
    if (!next) {
      errors.push(
        previous.status === "retired"
          ? `retired dependency risk ${id} tombstone cannot be deleted`
          : `active dependency risk ${id} must retire before deletion`,
      );
      continue;
    }
    if (previous.status === "retired") {
      if (!isDeepStrictEqual(next, previous)) {
        errors.push(`retired dependency risk ${id} cannot be reactivated or rewritten`);
      }
    } else if (next.status === "active") {
      if (!isDeepStrictEqual(next, previous)) {
        errors.push(`dependency risk ${id} active scope is immutable; create a new risk instead`);
      }
    } else if (next.status === "retired" && !isDeepStrictEqual(activeShape(next), previous)) {
      errors.push(`dependency risk ${id} cannot change scope while retiring`);
    }
  }
  for (const [id, entry] of currentById) {
    if (!baseById.has(id) && entry.status !== "active") {
      errors.push(`new dependency risk ${id} must start active`);
    }
  }
  return errors;
}

function baseLedgerAtRef(root, baseRef) {
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  if (!gitPathExistsAtRef(root, baseRef, DEPENDENCY_RISK_PATH)) {
    return { schemaVersion: 1, risks: [] };
  }
  return JSON.parse(
    execFileSync("git", ["show", `${baseRef}:${DEPENDENCY_RISK_PATH}`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

export function checkRepositoryDependencyRisks(root = REPOSITORY_ROOT, options = {}) {
  const now = options.now ?? new Date();
  let current;
  try {
    current = JSON.parse(readFileSync(join(root, DEPENDENCY_RISK_PATH), "utf8"));
  } catch (error) {
    return [`cannot read ${DEPENDENCY_RISK_PATH}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateDependencyRiskLedger(current, { now });
  const injected = Object.hasOwn(options, "baseLedger");
  const baseRef = Object.hasOwn(options, "baseRef")
    ? options.baseRef
    : process.env.VERIFY_BASE_REF;
  if (!injected && !baseRef) return errors;
  let base;
  try {
    base = injected ? options.baseLedger : baseLedgerAtRef(root, baseRef);
  } catch (error) {
    return [...errors, `cannot read base dependency risk ledger: ${error instanceof Error ? error.message : String(error)}`];
  }
  return [
    ...new Set([
      ...errors,
      ...validateDependencyRiskLedger(base, { now, enforceFreshness: false }),
      ...compareDependencyRiskLedgers(current, base),
    ]),
  ];
}

function reportList(report, name, errors) {
  const value = report?.warnings?.[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`cargo audit warnings.${name} must be an array`);
    return [];
  }
  return value;
}

function advisoryId(value, label, errors) {
  const id = value?.advisory?.id;
  if (typeof id !== "string" || !ADVISORY_ID.test(id)) {
    errors.push(`${label} advisory.id must be a RUSTSEC advisory ID`);
    return undefined;
  }
  return id;
}

function auditIdentity(value, kind, index, errors) {
  const label = `${kind} warning ${index}`;
  const advisory = advisoryId(value, label, errors);
  const package_ = value?.package;
  if (!package_ || typeof package_ !== "object" || Array.isArray(package_)) {
    errors.push(`${label} package must be an object`);
    return undefined;
  }
  const { name, version, source } = package_;
  let canonical = true;
  if (value?.kind !== kind) {
    errors.push(`${label} kind must be exactly ${kind}`);
    canonical = false;
  }
  if (typeof name !== "string" || !PACKAGE_NAME.test(name)) {
    errors.push(`${label} package.name must be a canonical Cargo package name`);
    canonical = false;
  }
  if (typeof version !== "string" || !PACKAGE_VERSION.test(version)) {
    errors.push(`${label} package.version must be a canonical non-empty Cargo version`);
    canonical = false;
  }
  if (!nonEmptyText(source, 5, 500) || !CARGO_SOURCE.test(source)) {
    errors.push(`${label} package.source must be a canonical single-line Cargo source identity`);
    canonical = false;
  }
  return advisory && canonical ? { advisory, name, version, source } : undefined;
}

function identityKey(identity) {
  return [identity.advisory, identity.name, identity.version, identity.source].join("\0");
}

function validateMetadataGraph(metadata, target, errors) {
  const label = `cargo metadata for ${target}`;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  if (!Array.isArray(metadata.packages) || metadata.packages.length === 0) {
    errors.push(`${label} packages must be a non-empty array`);
    return undefined;
  }
  if (!Array.isArray(metadata.workspace_members) || metadata.workspace_members.length === 0) {
    errors.push(`${label} workspace_members must be a non-empty array`);
    return undefined;
  }
  if (!metadata.resolve || typeof metadata.resolve !== "object" ||
      !Array.isArray(metadata.resolve.nodes) || metadata.resolve.nodes.length === 0) {
    errors.push(`${label} resolve.nodes must be a non-empty array`);
    return undefined;
  }

  const packages = new Map();
  let valid = true;
  for (const package_ of metadata.packages) {
    if (!package_ || typeof package_.id !== "string" || package_.id.length === 0 ||
        packages.has(package_.id)) {
      errors.push(`${label} package IDs must be unique non-empty strings`);
      valid = false;
      continue;
    }
    packages.set(package_.id, package_);
  }

  const nodes = new Map();
  for (const node of metadata.resolve.nodes) {
    if (!node || typeof node.id !== "string" || node.id.length === 0 ||
        !Array.isArray(node.dependencies) || nodes.has(node.id)) {
      errors.push(`${label} resolve nodes must have unique non-empty string IDs and dependency arrays`);
      valid = false;
      continue;
    }
    nodes.set(node.id, node.dependencies);
    if (!packages.has(node.id)) {
      errors.push(`${label} resolve node ${node.id} does not reference a package`);
      valid = false;
    }
  }
  if (new Set(metadata.workspace_members).size !== metadata.workspace_members.length) {
    errors.push(`${label} workspace_members must be unique`);
    valid = false;
  }
  for (const id of metadata.workspace_members) {
    if (typeof id !== "string" || id.length === 0 || !packages.has(id) || !nodes.has(id)) {
      errors.push(`${label} workspace members must reference packages and resolve nodes`);
      valid = false;
    }
  }
  for (const dependencies of nodes.values()) {
    if (new Set(dependencies).size !== dependencies.length) {
      errors.push(`${label} resolve node dependencies must be unique`);
      valid = false;
    }
    for (const dependency of dependencies) {
      if (typeof dependency !== "string" || dependency.length === 0 ||
          !packages.has(dependency) || !nodes.has(dependency)) {
        errors.push(`${label} dependency references an unknown package or resolve node`);
        valid = false;
      }
    }
  }
  return valid ? { packages, nodes, workspaceMembers: metadata.workspace_members } : undefined;
}

function reachablePackage(graph, identity, target, errors) {
  if (!graph) return false;
  const label = `cargo metadata for ${target}`;
  const matches = [...graph.packages.values()].filter(
    (package_) => package_.name === identity.name && package_.version === identity.version &&
      package_.source === identity.source,
  );
  if (matches.length > 1) {
    errors.push(`${label} package identity is ambiguous for ${identity.name}@${identity.version}`);
    return false;
  }
  const reachable = new Set();
  const pending = [...graph.workspaceMembers];
  while (pending.length > 0) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    const dependencies = graph.nodes.get(id);
    reachable.add(id);
    pending.push(...dependencies);
  }
  return matches.length === 1 && reachable.has(matches[0].id);
}

function validateAuditSettings(settings, errors) {
  if (!exactFields(settings, AUDIT_SETTINGS_FIELDS, "cargo audit settings", errors)) return;
  for (const field of ["target_arch", "target_os", "ignore"]) {
    if (!Array.isArray(settings[field]) || settings[field].length !== 0) {
      errors.push(`cargo audit settings.${field} must be an empty array`);
    }
  }
  if (settings.severity !== null) errors.push("cargo audit settings.severity must be null");
  const informational = settings.informational_warnings;
  if (!Array.isArray(informational) || informational.some((value) => typeof value !== "string") ||
      new Set(informational).size !== INFORMATIONAL_WARNINGS.length ||
      !isDeepStrictEqual([...informational].sort(), INFORMATIONAL_WARNINGS)) {
    errors.push(
      "cargo audit settings.informational_warnings must contain exactly notice, unmaintained, and unsound",
    );
  }
}

export function reconcileCargoAuditReport(ledger, report, metadataByTarget, options = {}) {
  const errors = validateDependencyRiskLedger(ledger, { now: options.now ?? new Date() });
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      errors: [...errors, "cargo audit report must be an object"],
      unmaintained: { count: 0, identities: [] },
    };
  }
  validateAuditSettings(report.settings, errors);

  const vulnerabilities = report.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities.found !== "boolean" ||
      !Number.isInteger(vulnerabilities.count) || !Array.isArray(vulnerabilities.list)) {
    errors.push("cargo audit vulnerabilities must include found, count, and list");
  } else {
    if (vulnerabilities.count !== vulnerabilities.list.length) {
      errors.push("cargo audit vulnerability count does not match list length");
    }
    if (vulnerabilities.found !== (vulnerabilities.list.length > 0)) {
      errors.push("cargo audit vulnerability found flag does not match list contents");
    }
    if (vulnerabilities.list.length > 0) {
      const ids = vulnerabilities.list.map(
        (entry, index) => auditIdentity(entry, "vulnerability", index, errors)?.advisory,
      ).filter(Boolean).sort();
      errors.push(`cargo audit vulnerabilities are never allowlisted: ${ids.join(", ") || "unknown"}`);
    }
  }

  if (!report.warnings || typeof report.warnings !== "object" || Array.isArray(report.warnings)) {
    errors.push("cargo audit warnings must be an object");
  } else {
    for (const kind of Object.keys(report.warnings)) {
      if (!KNOWN_WARNING_KINDS.has(kind)) {
        errors.push(`unknown cargo audit warning category ${kind}`);
      }
    }
  }
  const unsound = reportList(report, "unsound", errors);
  const unmaintained = reportList(report, "unmaintained", errors);
  const yanked = reportList(report, "yanked", errors);
  const notice = reportList(report, "notice", errors);
  if (yanked.length > 0) errors.push("cargo audit yanked warnings are never allowed");
  if (notice.length > 0) errors.push("cargo audit notice warnings require explicit checker support");

  const warningIdentities = Object.fromEntries(
    [["unsound", unsound], ["unmaintained", unmaintained], ["yanked", yanked], ["notice", notice]]
      .map(([kind, entries]) => [
        kind,
        entries.map((entry, index) => auditIdentity(entry, kind, index, errors)).filter(Boolean),
      ]),
  );
  const unmaintainedIdentities = [...new Set(warningIdentities.unmaintained.map((identity) =>
    `${identity.name}@${identity.version} / ${identity.advisory} / ${identity.source}`,
  ))].sort();
  const active = (ledger?.risks ?? []).filter((entry) => entry?.status === "active");
  const activeByIdentity = new Map(active.map((entry) => [riskIdentity(entry), entry]));
  const seenWarnings = new Set();
  const matchedRisks = new Set();
  const metadataKeys = metadataByTarget && typeof metadataByTarget === "object" &&
    !Array.isArray(metadataByTarget) ? Object.keys(metadataByTarget) : [];
  if (!metadataByTarget || typeof metadataByTarget !== "object" || Array.isArray(metadataByTarget)) {
    errors.push("cargo metadata by target must be an object");
  }
  for (const target of metadataKeys) {
    if (!AUDITED_TARGETS.includes(target)) errors.push(`unexpected audited target metadata ${target}`);
  }
  const graphByTarget = {};
  for (const target of AUDITED_TARGETS) {
    if (!Object.hasOwn(metadataByTarget ?? {}, target)) {
      errors.push(`missing cargo metadata for audited target ${target}`);
      continue;
    }
    graphByTarget[target] = validateMetadataGraph(metadataByTarget[target], target, errors);
  }

  warningIdentities.unsound.forEach((identity) => {
    const key = identityKey(identity);
    if (seenWarnings.has(key)) {
      errors.push(`duplicate unsound warning identity ${identity.advisory} ${identity.name}@${identity.version}`);
      return;
    }
    seenWarnings.add(key);
    const actualTargets = [];
    for (const target of AUDITED_TARGETS) {
      if (reachablePackage(graphByTarget[target], identity, target, errors)) {
        actualTargets.push(target);
      }
    }
    const risk = activeByIdentity.get(key);
    if (!risk) {
      errors.push(`unsound warning ${identity.advisory} ${identity.name}@${identity.version} is missing an active dependency risk`);
      return;
    }
    matchedRisks.add(risk.id);
    if (!isDeepStrictEqual(actualTargets, risk.affectedTargets)) {
      errors.push(
        `${risk.id} actual target set [${actualTargets.join(", ")}] does not match registered affectedTargets [${risk.affectedTargets.join(", ")}]`,
      );
    }
  });
  for (const risk of active) {
    if (!matchedRisks.has(risk.id)) errors.push(`active dependency risk ${risk.id} is stale`);
  }
  return {
    errors: [...new Set(errors)],
    unmaintained: {
      count: unmaintainedIdentities.length,
      identities: unmaintainedIdentities,
    },
  };
}

function commandFailure(result, label) {
  if (result?.error) return `could not execute ${label}: ${result.error.message}`;
  if (result?.signal) return `${label} terminated by ${result.signal}`;
  if (!Number.isInteger(result?.status)) return `${label} did not return an exit status`;
  return undefined;
}

function parseJsonOutput(output, label) {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`${label} exceeded the 32 MiB output limit`);
  }
  if (output.trim().length === 0) throw new Error(`${label} was empty`);
  return JSON.parse(output);
}

function canonicalRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function runDependencyRiskAudit({
  root = REPOSITORY_ROOT,
  now = new Date(),
  lockfile = "src-tauri/Cargo.lock",
  manifestPath = "src-tauri/Cargo.toml",
  spawnSyncImpl,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const failures = checkRepositoryDependencyRisks(root, { now, baseRef: undefined });
  if (!canonicalRelativePath(lockfile) || !canonicalRelativePath(manifestPath)) {
    failures.push("Cargo lockfile and manifest paths must be canonical repository-relative paths");
  }
  if (failures.length > 0) {
    stderr("Dependency risk audit failed:");
    failures.forEach((error) => stderr(`- ${error}`));
    return 1;
  }

  const version = spawn("cargo-audit", ["audit", "--version"], root, spawnSyncImpl);
  const versionFailure = commandFailure(version, "cargo-audit --version");
  if (versionFailure || version.status !== 0) {
    stderr(`Dependency risk audit failed: ${versionFailure ?? `cargo-audit --version exited with status ${version.status}`}`);
    return 1;
  }
  const versionMatch = version.stdout.trim().match(/^cargo-audit-audit (\d+\.\d+\.\d+)$/);
  if (!versionMatch || versionMatch[1] !== AUDIT_VERSION) {
    stderr(`Dependency risk audit failed: cargo-audit must be exactly ${AUDIT_VERSION}`);
    return 1;
  }

  const isolated = createIsolatedCargoAuditEnvironment();
  let audit;
  let auditReport;
  try {
    const registryPreflight = spawn(
      "cargo-audit",
      ["audit", "--deny", "yanked", "--format", "terminal", "--color", "never", "--file", lockfile],
      root,
      spawnSyncImpl,
      isolated.env,
    );
    const registryFailure = commandFailure(registryPreflight, "cargo audit registry preflight");
    const registryLines = registryPreflight.stderr.split(/\r?\n/u).map((line) => line.trim());
    if (registryFailure || registryPreflight.status !== 0) {
      failures.push(
        registryFailure ?? `cargo audit registry preflight exited with status ${registryPreflight.status}`,
      );
    }
    if (!registryLines.includes(REGISTRY_INDEX_UPDATE_MARKER)) {
      failures.push("cargo audit registry preflight did not prove a crates.io index update");
    }
    if (!registryLines.some((line) => line.startsWith(`Scanning ${lockfile} for vulnerabilities`))) {
      failures.push("cargo audit registry preflight did not prove the requested lockfile was scanned");
    }
    if (REGISTRY_INDEX_FAILURE.test(registryPreflight.stderr)) {
      failures.push("cargo audit registry preflight could not complete every yanked-package check");
    }

    audit = spawn(
      "cargo-audit",
      ["audit", "--format", "json", "--file", lockfile],
      root,
      spawnSyncImpl,
      isolated.env,
    );
    const auditFailure = commandFailure(audit, "cargo audit");
    if (auditFailure) {
      stderr(`Dependency risk audit failed: ${auditFailure}`);
      return 1;
    }
    if (audit.stderr.trim().length > 0) {
      failures.push("cargo audit wrote to stderr, so registry and advisory scan completeness cannot be proven");
    }
    try {
      auditReport = parseJsonOutput(audit.stdout, "cargo audit JSON");
    } catch (error) {
      stderr(`Dependency risk audit failed: invalid cargo audit JSON: ${error.message}`);
      return 1;
    }
  } finally {
    isolated.cleanup();
  }

  const metadataByTarget = {};
  for (const target of AUDITED_TARGETS) {
    const result = spawn(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        target,
        "--manifest-path",
        manifestPath,
      ],
      root,
      spawnSyncImpl,
    );
    const failure = commandFailure(result, `cargo metadata for ${target}`);
    if (failure || result.status !== 0) {
      failures.push(failure ?? `cargo metadata for ${target} exited with status ${result.status}`);
      continue;
    }
    try {
      metadataByTarget[target] = parseJsonOutput(result.stdout, `cargo metadata for ${target}`);
    } catch (error) {
      failures.push(`invalid cargo metadata JSON for ${target}: ${error.message}`);
    }
  }
  const ledger = JSON.parse(readFileSync(join(root, DEPENDENCY_RISK_PATH), "utf8"));
  const reconciled = reconcileCargoAuditReport(ledger, auditReport, metadataByTarget, { now });
  failures.push(...reconciled.errors);
  if (audit.status !== 0) failures.push(`cargo audit exited with status ${audit.status}`);

  for (const identity of reconciled.unmaintained.identities) {
    stdout(`REPORT-ONLY unmaintained warning: ${identity}`);
  }

  if (failures.length > 0) {
    stderr("Dependency risk audit failed:");
    [...new Set(failures)].forEach((error) => stderr(`- ${error}`));
    return 1;
  }
  const activeCount = ledger.risks.filter((entry) => entry.status === "active").length;
  stdout(`PASS dependency risk ledger reconciles ${activeCount} active unsound warning${activeCount === 1 ? "" : "s"}`);
  return 0;
}

function runRepositoryCheck({ root = REPOSITORY_ROOT, stdout = console.log, stderr = console.error } = {}) {
  const errors = checkRepositoryDependencyRisks(root);
  if (errors.length > 0) {
    stderr("Dependency risk ledger validation failed:");
    errors.forEach((error) => stderr(`- ${error}`));
    return 1;
  }
  stdout("PASS tracked dependency risk ledger");
  return 0;
}

function runCli(args = process.argv.slice(2)) {
  if (args.length === 0 || (args.length === 1 && args[0] === "check")) return runRepositoryCheck();
  if (args[0] !== "audit") {
    console.error("Usage: node scripts/dependency-risk.mjs [check|audit --file src-tauri/Cargo.lock]");
    return 2;
  }
  if (args.length === 1) return runDependencyRiskAudit();
  if (args.length === 3 && args[1] === "--file") return runDependencyRiskAudit({ lockfile: args[2] });
  console.error("Usage: node scripts/dependency-risk.mjs audit --file src-tauri/Cargo.lock");
  return 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCli();
}
