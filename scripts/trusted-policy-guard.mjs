#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHECK_NAME = "Trusted policy / guard";
export const REVIEW_LABEL = "governance-reviewed";

const MAX_GITHUB_FILES = 3_000;
const MAX_TRUSTED_CATALOG_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const API_VERSION = "2022-11-28";
const TRUSTED_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../docs/engineering/governance-assets.json",
);
const ASSET_STATUSES = new Set(["active", "superseded"]);
const INVARIANT_STATUSES = new Set(["active", "retiring", "retired"]);
const TRUSTED_EVENT_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "labeled",
  "unlabeled",
]);
const CRITICAL_PREFIXES = Object.freeze([
  ".github/workflows/",
  ".github/actions/",
  ".cargo/",
  "scripts/",
  "docs/engineering/",
  "docs/rules/",
  "docs/adr/",
  "src-tauri/capabilities/",
  "src-tauri/permissions/",
  "src-tauri/tauri.",
  "src-tauri/Tauri.",
  "playwright.config.",
  "public/",
  "tsconfig.",
  "vite.config.",
  "vitest.",
]);
const CRITICAL_EXACT_PATHS = new Set([
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".node-version",
  ".nvmrc",
  ".npmrc",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "index.html",
  "SECURITY.md",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.cts",
  "rust-toolchain.toml",
  "rust-toolchain",
  "tsconfig.json",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.ts",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/build.rs",
  "src-tauri/entitlements.plist",
  "src-tauri/tauri.conf.json",
]);

function unique(values) {
  return [...new Set(values)];
}

function isValidRepositoryPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateIdentifier(value, owner) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${owner} has an invalid id`);
  }
}

function validateEvidenceList(evidence, owner, collectedPaths, collect) {
  if (!Array.isArray(evidence)) {
    throw new Error(`${owner} evidence must be an array`);
  }
  for (const [index, item] of evidence.entries()) {
    const evidenceOwner = `${owner} evidence[${index}]`;
    if (!isPlainObject(item)) {
      throw new Error(`${evidenceOwner} must be an object`);
    }
    if (!isValidRepositoryPath(item.path)) {
      throw new Error(`${evidenceOwner} has an invalid evidence path`);
    }
    if (
      typeof item.selector !== "string" ||
      item.selector.length === 0 ||
      item.selector.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(item.selector)
    ) {
      throw new Error(`${evidenceOwner} has an invalid selector`);
    }
    if (collect) collectedPaths.add(item.path);
  }
}

function decodeTrustedCatalog(contents) {
  if (typeof contents === "string") {
    if (Buffer.byteLength(contents, "utf8") > MAX_TRUSTED_CATALOG_BYTES) {
      throw new Error("trusted governance catalog exceeds the size limit");
    }
    return contents;
  }
  if (!(contents instanceof Uint8Array)) {
    throw new Error("trusted governance catalog is missing or unreadable");
  }
  if (contents.byteLength > MAX_TRUSTED_CATALOG_BYTES) {
    throw new Error("trusted governance catalog exceeds the size limit");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error("trusted governance catalog is not valid UTF-8");
  }
}

export function extractTrustedGovernanceEvidencePaths(contents) {
  let catalog;
  try {
    catalog = JSON.parse(decodeTrustedCatalog(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("trusted governance catalog is not valid JSON");
    }
    throw error;
  }
  if (!isPlainObject(catalog)) {
    throw new Error("trusted governance catalog root must be an object");
  }
  if (catalog.schemaVersion !== 1) {
    throw new Error("trusted governance catalog schemaVersion must equal 1");
  }
  if (!Array.isArray(catalog.assets)) {
    throw new Error("trusted governance catalog assets must be an array");
  }
  if (!Array.isArray(catalog.invariants)) {
    throw new Error("trusted governance catalog invariants must be an array");
  }

  const collectedPaths = new Set();
  const assetIds = new Set();
  for (const [index, asset] of catalog.assets.entries()) {
    const owner = `trusted governance asset[${index}]`;
    if (!isPlainObject(asset)) throw new Error(`${owner} must be an object`);
    validateIdentifier(asset.id, owner);
    if (assetIds.has(asset.id)) throw new Error(`${owner} has a duplicate id: ${asset.id}`);
    assetIds.add(asset.id);
    if (!ASSET_STATUSES.has(asset.status)) {
      throw new Error(`${owner} has an unsupported status: ${asset.status ?? "missing"}`);
    }
    if (!isPlainObject(asset.enforcement)) {
      throw new Error(`${owner} enforcement must be an object`);
    }
    validateEvidenceList(
      asset.enforcement.evidence,
      owner,
      collectedPaths,
      asset.status === "active",
    );
  }

  const invariantIds = new Set();
  for (const [index, invariant] of catalog.invariants.entries()) {
    const owner = `trusted governance invariant[${index}]`;
    if (!isPlainObject(invariant)) throw new Error(`${owner} must be an object`);
    validateIdentifier(invariant.id, owner);
    if (invariantIds.has(invariant.id)) {
      throw new Error(`${owner} has a duplicate id: ${invariant.id}`);
    }
    invariantIds.add(invariant.id);
    if (!INVARIANT_STATUSES.has(invariant.status)) {
      throw new Error(`${owner} has an unsupported status: ${invariant.status ?? "missing"}`);
    }
    validateEvidenceList(
      invariant.evidence,
      owner,
      collectedPaths,
      invariant.status === "active" || invariant.status === "retiring",
    );
  }
  return [...collectedPaths].sort();
}

export function isCriticalGovernancePath(path, trustedEvidencePaths = []) {
  if (!isValidRepositoryPath(path)) return false;
  return (
    trustedEvidencePaths.includes(path) ||
    CRITICAL_EXACT_PATHS.has(path) ||
    /(?:^|\/)\.cargo(?:\/|$)/.test(path) ||
    /(?:^|\/)npm-shrinkwrap\.json$/.test(path) ||
    /(?:^|\/)(?:postcss\.config\.(?:js|cjs|mjs|ts|cts|mts)|\.postcssrc(?:\.(?:json|yaml|yml|js|cjs|mjs|ts|cts|mts))?)$/.test(path) ||
    CRITICAL_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

export function evaluateTrustedPolicy({
  changedFiles,
  files,
  labels,
  eventAction,
  eventLabel,
  trustedEvidencePaths = [],
}) {
  const errors = [];
  const criticalPaths = new Set();
  if (
    !Array.isArray(trustedEvidencePaths) ||
    trustedEvidencePaths.some((path) => !isValidRepositoryPath(path))
  ) {
    errors.push("trusted governance evidence paths are invalid");
    trustedEvidencePaths = [];
  }
  if (!TRUSTED_EVENT_ACTIONS.has(eventAction)) {
    errors.push("trusted policy received an invalid pull_request_target action");
  }
  if (
    ["labeled", "unlabeled"].includes(eventAction) &&
    (typeof eventLabel !== "string" ||
      eventLabel.length === 0 ||
      eventLabel.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(eventLabel))
  ) {
    errors.push("trusted policy received an invalid label event");
  }
  if (!Number.isInteger(changedFiles) || changedFiles < 0) {
    errors.push("GitHub API returned an invalid changed_files count");
  }
  if (!Array.isArray(files)) {
    errors.push("GitHub API returned an invalid changed files payload");
  } else {
    if (Number.isInteger(changedFiles) && changedFiles >= 0 && files.length !== changedFiles) {
      errors.push(`GitHub API returned ${files.length} of ${changedFiles} changed files`);
    }
    for (const file of files) {
      const candidates = [
        file?.filename,
        file?.previousFilename ?? file?.previous_filename,
      ].filter((path) => path != null);
      if (candidates.length === 0 || candidates.some((path) => !isValidRepositoryPath(path))) {
        errors.push("GitHub API returned an invalid changed filename");
        continue;
      }
      for (const path of candidates) {
        if (isCriticalGovernancePath(path, trustedEvidencePaths)) criticalPaths.add(path);
      }
    }
  }
  const labelNames = Array.isArray(labels) ? labels : undefined;
  if (!labelNames || labelNames.some((label) => typeof label !== "string")) {
    errors.push("GitHub API returned an invalid labels payload");
  } else if (criticalPaths.size > 0) {
    const hasReviewLabel = labelNames.includes(REVIEW_LABEL);
    if (eventAction === "synchronize") {
      errors.push(
        hasReviewLabel
          ? `critical governance paths changed on a new head; remove and re-add the ${REVIEW_LABEL} label`
          : `critical governance paths require the ${REVIEW_LABEL} label`,
      );
    } else if (
      eventAction === "labeled" &&
      eventLabel === REVIEW_LABEL &&
      hasReviewLabel
    ) {
      // The label event and API head are evaluated within the same trusted run.
    } else if (!hasReviewLabel) {
      errors.push(`critical governance paths require the ${REVIEW_LABEL} label`);
    } else {
      errors.push(
        `critical governance paths require a fresh ${REVIEW_LABEL} label event on the current head`,
      );
    }
  }
  return {
    criticalPaths: [...criticalPaths].sort(),
    errors: unique(errors),
  };
}

function validateRuntimeInput({ token, repository, pullNumber, expectedHeadSha, expectedBaseRef }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GITHUB_TOKEN is required");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }
  if (!Number.isInteger(Number(pullNumber)) || Number(pullNumber) <= 0) {
    throw new Error("pull request number is invalid");
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha ?? "")) {
    throw new Error("pull request head SHA is invalid");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(expectedBaseRef ?? "")) {
    throw new Error("pull request base ref is invalid");
  }
}

function githubUrl(apiUrl, endpoint) {
  const base = new URL(apiUrl ?? "https://api.github.com");
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("GITHUB_API_URL must be an HTTPS URL without credentials");
  }
  return new URL(endpoint.replace(/^\//, ""), `${base.href.replace(/\/$/, "")}/`);
}

async function githubRequest({
  fetchImpl,
  token,
  apiUrl,
  endpoint,
}) {
  const response = await fetchImpl(githubUrl(apiUrl, endpoint), {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": API_VERSION,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: GET ${endpoint} returned ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub API request failed: GET ${endpoint} returned invalid JSON`);
  }
}

async function loadPullRequestData({
  fetchImpl,
  token,
  apiUrl,
  repository,
  pullNumber,
  expectedHeadSha,
  expectedBaseRef,
}) {
  const endpoint = `/repos/${repository}/pulls/${pullNumber}`;
  const pull = await githubRequest({ fetchImpl, token, apiUrl, endpoint });
  if (pull?.number !== Number(pullNumber)) {
    throw new Error("GitHub API returned a different pull request number");
  }
  if (pull?.head?.sha !== expectedHeadSha) {
    throw new Error("pull request head changed while trusted policy was running");
  }
  if (pull?.base?.ref !== expectedBaseRef) {
    throw new Error("GitHub API returned a different pull request base ref");
  }
  if (!Number.isInteger(pull.changed_files) || pull.changed_files < 0) {
    throw new Error("GitHub API returned an invalid changed_files count");
  }
  if (pull.changed_files > MAX_GITHUB_FILES) {
    throw new Error(
      `pull request has ${pull.changed_files} files; GitHub exposes at most ${MAX_GITHUB_FILES}`,
    );
  }
  if (!Array.isArray(pull.labels)) {
    throw new Error("GitHub API returned an invalid labels payload");
  }
  const labels = pull.labels.map((label) => label?.name);
  if (labels.some((label) => typeof label !== "string")) {
    throw new Error("GitHub API returned an invalid labels payload");
  }

  const files = [];
  for (let page = 1; page <= Math.ceil(MAX_GITHUB_FILES / PAGE_SIZE); page += 1) {
    if (files.length >= pull.changed_files) break;
    const pageFiles = await githubRequest({
      fetchImpl,
      token,
      apiUrl,
      endpoint: `${endpoint}/files?per_page=${PAGE_SIZE}&page=${page}`,
    });
    if (!Array.isArray(pageFiles)) {
      throw new Error("GitHub API returned an invalid changed files page");
    }
    files.push(
      ...pageFiles.map((file) => ({
        filename: file?.filename,
        previousFilename: file?.previous_filename,
      })),
    );
    if (pageFiles.length < PAGE_SIZE) break;
  }
  return { changedFiles: pull.changed_files, files, labels };
}

export async function runTrustedPolicy({
  fetchImpl = globalThis.fetch,
  token,
  apiUrl = "https://api.github.com",
  repository,
  pullNumber,
  expectedHeadSha,
  expectedBaseRef,
  eventAction,
  eventLabel,
  readTrustedCatalog = () => readFileSync(TRUSTED_CATALOG_PATH),
}) {
  validateRuntimeInput({ token, repository, pullNumber, expectedHeadSha, expectedBaseRef });
  let decision;
  try {
    const trustedEvidencePaths = extractTrustedGovernanceEvidencePaths(
      readTrustedCatalog(),
    );
    const input = await loadPullRequestData({
      fetchImpl,
      token,
      apiUrl,
      repository,
      pullNumber: Number(pullNumber),
      expectedHeadSha,
      expectedBaseRef,
    });
    decision = evaluateTrustedPolicy({
      ...input,
      eventAction,
      eventLabel,
      trustedEvidencePaths,
    });
  } catch (error) {
    decision = {
      criticalPaths: [],
      errors: [error instanceof Error ? error.message : "trusted policy failed unexpectedly"],
    };
  }
  const conclusion = decision.errors.length === 0 ? "success" : "failure";
  return { ...decision, conclusion };
}

export async function runTrustedPolicyCli({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readTrustedCatalog,
  log = console.log,
  error = console.error,
} = {}) {
  const result = await runTrustedPolicy({
    fetchImpl,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL,
    repository: env.GITHUB_REPOSITORY,
    pullNumber: Number(env.PR_NUMBER),
    expectedHeadSha: env.PR_HEAD_SHA,
    expectedBaseRef: env.PR_BASE_REF,
    eventAction: env.PR_EVENT_ACTION,
    eventLabel: env.PR_EVENT_LABEL,
    readTrustedCatalog,
  });
  if (result.conclusion === "success") {
    log(`PASS ${CHECK_NAME}`);
    return 0;
  }
  error(`FAIL ${CHECK_NAME}`);
  for (const message of result.errors) error(`- ${message}`);
  for (const path of result.criticalPaths) error(`- critical path: ${path}`);
  return 1;
}

async function main() {
  process.exitCode = await runTrustedPolicyCli({
    env: process.env,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
