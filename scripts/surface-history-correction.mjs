import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { compareSurfaceBudgets } from "./surface-budget.mjs";

function freeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") freeze(nested);
  }
  return Object.freeze(value);
}

// ADR 0015 accepts two already committed documentation errors, not a general
// waiver mechanism. New commits and the working tree cannot use this record.
export const SURFACE_HISTORY_CORRECTION = freeze({
  id: "credential-restore-purpose-2026-10",
  parentSha: "cd9c09bb82ff848f8ff2d0bd8d8eb3f435af6a9e",
  commitSha: "d2cb71239eb930e882ce5717a86a1a5fe2f3b5a1",
  budgetPath: "docs/engineering/surface-budget.json",
  category: "rustPathSites",
  decision: {
    id: "adr-0015-surface-history-correction",
    path: "docs/adr/0015-surface-history-correction.md",
    sha256: "7f1475b0c750644b9ec5d20ce062a320df92e12c57c46e4c63bdea8f9ae021e7",
  },
  records: [
    {
      id: "src-tauri/src/credential_backup.rs:fs::rename:commit#1",
      before: {
        id: "src-tauri/src/credential_backup.rs:fs::rename:commit#1",
        status: "active",
        purpose: "Create and validate bounded SQLCipher snapshots, recover an interrupted switch, and serialize the single credential host (ADR 0013).",
      },
      beforeSha256: "1d12172b0b8e229b0953fbd4ee2e83af24cd515eb8efc7058c8e2a0aae2a6f9e",
      after: {
        id: "src-tauri/src/credential_backup.rs:fs::rename:commit#1",
        status: "retiring",
        retirementReason: "The same controlled rename now lives in commit_with_sync for restore fault injection.",
        purpose: "Moved unchanged to commit_with_sync so restore completion failures can be verified through the production path (ADR 0013).",
      },
      afterSha256: "8837e26c2eeb3d427166f106c59689aa46fcf210959aaf955bbb2f966e0cfc48",
    },
    {
      id: "src-tauri/src/credential_backup.rs:Path::exists:commit#1",
      before: {
        id: "src-tauri/src/credential_backup.rs:Path::exists:commit#1",
        status: "active",
        purpose: "Create and validate bounded SQLCipher snapshots, recover an interrupted switch, and serialize the single credential host (ADR 0013).",
      },
      beforeSha256: "81ee35dacb7b4cab96062979b8564355304cd224e9ddf8d5c63aec900f1af7fe",
      after: {
        id: "src-tauri/src/credential_backup.rs:Path::exists:commit#1",
        status: "retiring",
        retirementReason: "The same current-vault check now lives in commit_with_sync for restore fault injection.",
        purpose: "Moved unchanged to commit_with_sync for restore completion fault verification (ADR 0013).",
      },
      afterSha256: "844b130dc6f33a11d7785bf73511102b76452c1bec259b6776ffbd174f77acec",
    },
  ],
});

const sha256 = (bytes) => createHash("sha256").update(bytes, "utf8").digest("hex");

// These complete records contain string values only. Sorting their own keys
// binds every field while avoiding dependence on JSON object insertion order.
function entryDigest(entry) {
  return sha256(JSON.stringify(Object.fromEntries(
    Object.keys(entry).sort().map((key) => [key, entry[key]]),
  )));
}

export function isSurfaceCorrectionEdge({ parentSha, commitSha, budgetPath } = {}) {
  const approved = SURFACE_HISTORY_CORRECTION;
  return parentSha === approved.parentSha && commitSha === approved.commitSha
    && budgetPath === approved.budgetPath;
}

function decisionErrors({ decisionText, decisionAsset }) {
  const expected = SURFACE_HISTORY_CORRECTION.decision;
  if (typeof decisionText !== "string" || !/^- 状态：Accepted\s*$/m.test(decisionText)
      || sha256(decisionText) !== expected.sha256
      || decisionAsset?.id !== expected.id || decisionAsset.kind !== "decision"
      || decisionAsset.status !== "active" || decisionAsset.path !== expected.path
      || decisionAsset.checksum !== `sha256:${expected.sha256}`) {
    return ["surface history correction requires its exact registered Accepted ADR 0015 bytes"];
  }
  return [];
}

function recordErrors(current, previous) {
  const approved = SURFACE_HISTORY_CORRECTION;
  const errors = [];
  for (const record of approved.records) {
    for (const [budget, side] of [[previous, "before"], [current, "after"]]) {
      const entries = budget?.categories?.[approved.category];
      const matches = Array.isArray(entries) ? entries.filter((entry) => entry?.id === record.id) : [];
      if (matches.length !== 1 || !isDeepStrictEqual(matches[0], record[side])
          || entryDigest(matches[0]) !== record[`${side}Sha256`]) {
        errors.push(`surface history correction ${side} record differs: ${record.id}`);
      }
    }
  }
  return errors;
}

export function compareSurfaceHistoryEdge(current, previous, context = {}) {
  const originalErrors = compareSurfaceBudgets(current, previous);
  if (!isSurfaceCorrectionEdge(context)) return originalErrors;
  const anchorErrors = [...decisionErrors(context), ...recordErrors(current, previous)];
  if (anchorErrors.length) return [...originalErrors, ...anchorErrors];
  const approved = SURFACE_HISTORY_CORRECTION;
  const originalPurposes = new Map(approved.records.map((record) => [record.id, record.before.purpose]));
  // Only the comparison sees the approved purpose projection. The caller keeps
  // the untouched historical snapshot, so every following edge stays strict.
  const comparison = { ...current, categories: { ...current.categories,
    [approved.category]: current.categories[approved.category].map((entry) =>
      originalPurposes.has(entry.id) ? { ...entry, purpose: originalPurposes.get(entry.id) } : entry),
  } };
  return compareSurfaceBudgets(comparison, previous);
}
