#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gitPathExistsAtRef } from "./git-paths.mjs";

export const TEST_WAIVER_PATH = "docs/engineering/test-waivers.json";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const ROOT_FIELDS = new Set(["schemaVersion", "waivers"]);
const COMMON_FIELDS = [
  "id",
  "status",
  "lane",
  "issue",
  "owner",
  "createdOn",
  "expiresOn",
  "testSelectors",
  "reason",
];
const RETIRED_FIELDS = ["retiredOn", "retirementReason"];
const INDEPENDENT_LANES = new Set([
  "coverage",
  "e2e",
  "msrv",
  "performance",
  "release",
  "weekly-resilience",
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_DAYS = 30;
const WAIVER_ID = /^WAIVER-(\d{4})-(\d{3})$/;
const ISSUE_URL = /^https:\/\/github\.com\/xrevoman-hu\/skill-repo-tracker\/issues\/[1-9]\d*$/;
const OWNER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEST_SELECTOR = /^[A-Za-z0-9_.\/-]+#[^#\r\n]{3,200}$/u;
const TEST_PATH = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)[A-Za-z0-9_.-]+_tests\.rs|^src-tauri\/tests\/[A-Za-z0-9_.\/-]+\.rs)$/;

function utcDay(value, label) {
  const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${label} must be a valid date`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
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

function exactFields(entry, allowed, label, errors) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(entry)) {
    if (!allowedSet.has(key)) errors.push(`${label} has unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(entry, key)) errors.push(`${label} is missing field ${key}`);
  }
  return true;
}

function nonEmptyText(value, minimum = 1, maximum = 500) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\r\n]/.test(value)
  );
}

function canonicalTestPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..") &&
    TEST_PATH.test(path)
  );
}

function validateEntry(entry, index, today, enforceFreshness, errors) {
  const label = `test waiver at index ${index}`;
  const status = entry?.status;
  const fields = status === "retired" ? [...COMMON_FIELDS, ...RETIRED_FIELDS] : COMMON_FIELDS;
  if (!exactFields(entry, fields, label, errors)) return;

  const idMatch = typeof entry.id === "string" ? entry.id.match(WAIVER_ID) : undefined;
  if (!idMatch) errors.push(`${label} id must match WAIVER-YYYY-NNN`);
  if (!["active", "retired"].includes(status)) {
    errors.push(`${label} status must be active or retired`);
  }
  if (!INDEPENDENT_LANES.has(entry.lane)) {
    errors.push(`${label} lane must name an approved independent lane`);
  }
  if (typeof entry.issue !== "string" || !ISSUE_URL.test(entry.issue)) {
    errors.push(`${label} issue must be the canonical repository issue URL`);
  }
  if (typeof entry.owner !== "string" || !OWNER.test(entry.owner)) {
    errors.push(`${label} owner must be a canonical GitHub handle`);
  }
  if (!nonEmptyText(entry.reason, 12)) {
    errors.push(`${label} reason must be a single-line explanation of 12-500 characters`);
  }

  const created = parseDate(entry.createdOn);
  const expires = parseDate(entry.expiresOn);
  if (created === undefined) errors.push(`${label} createdOn must be a real YYYY-MM-DD UTC date`);
  if (expires === undefined) errors.push(`${label} expiresOn must be a real YYYY-MM-DD UTC date`);
  if (created !== undefined && created > today) errors.push(`${label} createdOn cannot be in the future`);
  if (created !== undefined && idMatch && Number(idMatch[1]) !== new Date(created).getUTCFullYear()) {
    errors.push(`${label} id year must match createdOn`);
  }
  if (created !== undefined && expires !== undefined) {
    const lifetime = (expires - created) / DAY_MS;
    if (lifetime < 0 || lifetime > MAX_ACTIVE_DAYS) {
      errors.push(`${label} expiresOn must be within at most 30 UTC days of createdOn`);
    }
    if (status === "active" && enforceFreshness && expires < today) {
      errors.push(`${entry.id} expired on ${entry.expiresOn}`);
    }
  }

  if (!Array.isArray(entry.testSelectors) || entry.testSelectors.length === 0) {
    errors.push(`${label} testSelectors must be a non-empty array`);
  } else {
    if (entry.testSelectors.some((selector) => typeof selector !== "string" || !TEST_SELECTOR.test(selector))) {
      errors.push(`${label} testSelectors must use path#static-test-selector values`);
    }
    if (
      entry.testSelectors.some((selector) => {
        const path = typeof selector === "string" ? selector.split("#", 1)[0] : "";
        return !canonicalTestPath(path);
      })
    ) {
      errors.push(`${label} testSelectors paths must be canonical repository-relative test files`);
    }
    if (new Set(entry.testSelectors).size !== entry.testSelectors.length) {
      errors.push(`${label} testSelectors must be unique`);
    }
    const sorted = [...entry.testSelectors].sort();
    if (!isDeepStrictEqual(entry.testSelectors, sorted)) {
      errors.push(`${label} testSelectors must be sorted`);
    }
  }

  if (status === "retired") {
    const retired = parseDate(entry.retiredOn);
    if (retired === undefined) errors.push(`${label} retiredOn must be a real YYYY-MM-DD UTC date`);
    if (retired !== undefined && retired > today) errors.push(`${label} retiredOn cannot be in the future`);
    if (created !== undefined && retired !== undefined && retired < created) {
      errors.push(`${label} retiredOn cannot be earlier than createdOn`);
    }
    if (!nonEmptyText(entry.retirementReason, 12)) {
      errors.push(`${label} retirementReason must be a single-line explanation of 12-500 characters`);
    }
  }
}

export function validateTestWaiverLedger(
  document,
  { now = new Date(), enforceFreshness = true } = {},
) {
  const errors = [];
  const today = utcDay(now, "now");
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return ["test waiver ledger must be an object"];
  }
  for (const key of Object.keys(document)) {
    if (!ROOT_FIELDS.has(key)) errors.push(`test waiver ledger has unknown root field ${key}`);
  }
  for (const key of ROOT_FIELDS) {
    if (!Object.hasOwn(document, key)) errors.push(`test waiver ledger is missing root field ${key}`);
  }
  if (document.schemaVersion !== 1) errors.push("test waiver ledger schemaVersion must be 1");
  if (!Array.isArray(document.waivers)) {
    errors.push("test waiver ledger waivers must be an array");
    return errors;
  }

  document.waivers.forEach((entry, index) =>
    validateEntry(entry, index, today, enforceFreshness, errors),
  );
  const ids = document.waivers.map((entry) => entry?.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    errors.push("test waiver IDs must be unique strings");
  }
  if (!isDeepStrictEqual(ids, [...ids].sort())) errors.push("test waivers must be sorted by id");
  return errors;
}

function commonActiveShape(entry) {
  return Object.fromEntries(
    COMMON_FIELDS.map((field) => [field, field === "status" ? "active" : entry?.[field]]),
  );
}

export function compareTestWaiverLedgers(current, base) {
  const errors = [];
  if (current?.schemaVersion !== base?.schemaVersion) {
    errors.push("test waiver ledger schemaVersion is immutable");
  }
  const currentById = new Map((current?.waivers ?? []).map((entry) => [entry.id, entry]));
  const baseById = new Map((base?.waivers ?? []).map((entry) => [entry.id, entry]));

  for (const [id, previous] of baseById) {
    const next = currentById.get(id);
    if (!next) {
      errors.push(
        previous.status === "retired"
          ? `retired test waiver ${id} tombstone cannot be deleted`
          : `active test waiver ${id} must retire before deletion`,
      );
      continue;
    }
    if (previous.status === "retired") {
      if (!isDeepStrictEqual(next, previous)) {
        errors.push(`retired test waiver ${id} cannot be reactivated or rewritten`);
      }
      continue;
    }
    if (next.status === "active") {
      if (!isDeepStrictEqual(next, previous)) {
        errors.push(`test waiver ${id} active scope is immutable; create a new waiver instead`);
      }
    } else if (next.status === "retired") {
      if (!isDeepStrictEqual(commonActiveShape(next), previous)) {
        errors.push(`test waiver ${id} cannot change scope while retiring`);
      }
    }
  }
  for (const [id, entry] of currentById) {
    if (!baseById.has(id) && entry.status !== "active") {
      errors.push(`new test waiver ${id} must start active`);
    }
  }
  return errors;
}

export function activeTestWaiverIds(document, options = {}) {
  const errors = validateTestWaiverLedger(document, options);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return document.waivers
    .filter((entry) => entry.status === "active")
    .map((entry) => entry.id)
    .sort();
}

export function readTestWaiverLedger(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readActiveTestWaiverIds(
  path = join(REPOSITORY_ROOT, TEST_WAIVER_PATH),
  options = {},
) {
  return activeTestWaiverIds(readTestWaiverLedger(path), options);
}

function validateActiveTestSelectors(root, document) {
  const errors = [];
  for (const waiver of document.waivers ?? []) {
    if (waiver?.status !== "active" || !Array.isArray(waiver.testSelectors)) continue;
    for (const reference of waiver.testSelectors) {
      if (typeof reference !== "string" || !TEST_SELECTOR.test(reference)) continue;
      const separator = reference.indexOf("#");
      const path = reference.slice(0, separator);
      const selector = reference.slice(separator + 1);
      if (!canonicalTestPath(path)) continue;
      const absolute = join(root, path);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        errors.push(`${waiver.id} test path does not exist: ${path}`);
        continue;
      }
      if (!readFileSync(absolute, "utf8").includes(selector)) {
        errors.push(`${waiver.id} selector text does not exist in ${path}: ${selector}`);
      }
    }
  }
  return errors;
}

function baseLedgerAtRef(root, baseRef) {
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  if (!gitPathExistsAtRef(root, baseRef, TEST_WAIVER_PATH)) {
    return { schemaVersion: 1, waivers: [] };
  }
  return JSON.parse(
    execFileSync("git", ["show", `${baseRef}:${TEST_WAIVER_PATH}`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

export function checkRepositoryTestWaivers(root = REPOSITORY_ROOT, options = {}) {
  const now = options.now ?? new Date();
  let current;
  try {
    current = readTestWaiverLedger(join(root, TEST_WAIVER_PATH));
  } catch (error) {
    return [`cannot read ${TEST_WAIVER_PATH}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = [
    ...validateTestWaiverLedger(current, { now }),
    ...validateActiveTestSelectors(root, current),
  ];
  const hasInjectedBase = Object.hasOwn(options, "baseLedger");
  const baseRef = options.baseRef ?? process.env.VERIFY_BASE_REF;
  if (!hasInjectedBase && !baseRef) return errors;

  let base;
  try {
    base = hasInjectedBase ? options.baseLedger : baseLedgerAtRef(root, baseRef);
  } catch (error) {
    return [
      ...errors,
      `cannot read base test waiver ledger: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  errors.push(
    ...validateTestWaiverLedger(base, { now, enforceFreshness: false }),
    ...compareTestWaiverLedgers(current, base),
  );
  return [...new Set(errors)];
}

export function runTestWaiverCli({ root = REPOSITORY_ROOT, now = new Date(), stdout = console.log, stderr = console.error } = {}) {
  const errors = checkRepositoryTestWaivers(root, { now });
  if (errors.length > 0) {
    stderr("Test waiver ledger validation failed:");
    for (const error of errors) stderr(`- ${error}`);
    return 1;
  }
  stdout("PASS tracked test waiver ledger");
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runTestWaiverCli();
}
