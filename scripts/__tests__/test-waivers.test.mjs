import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activeTestWaiverIds,
  checkRepositoryTestWaivers,
  compareTestWaiverLedgers,
  validateTestWaiverLedger,
} from "../test-waivers.mjs";

const NOW = new Date("2026-09-15T12:00:00Z");

function activeWaiver(overrides = {}) {
  return {
    id: "WAIVER-2026-001",
    status: "active",
    lane: "e2e",
    issue: "https://github.com/xrevoman-hu/skill-repo-tracker/issues/42",
    owner: "@alice",
    createdOn: "2026-09-01",
    expiresOn: "2026-09-30",
    testSelectors: ["e2e/repository.spec.ts#restores a repository snapshot"],
    reason: "The isolated browser runner is being repaired without weakening the main suite.",
    ...overrides,
  };
}

function ledger(waivers = []) {
  return { schemaVersion: 1, waivers };
}

function retiredWaiver(overrides = {}) {
  return {
    ...activeWaiver(),
    status: "retired",
    retiredOn: "2026-09-10",
    retirementReason: "The isolated runner is deterministic again and the waiver is no longer used.",
    ...overrides,
  };
}

test("test waiver ledger rejects unknown fields, main lanes, and expired active entries", () => {
  assert.deepEqual(validateTestWaiverLedger(ledger([activeWaiver()]), { now: NOW }), []);
  assert.deepEqual(activeTestWaiverIds(ledger([activeWaiver()]), { now: NOW }), [
    "WAIVER-2026-001",
  ]);

  const cases = [
    [ledger([activeWaiver({ undocumented: true })]), /unknown field undocumented/],
    [ledger([activeWaiver({ lane: "verify" })]), /independent lane/],
    [ledger([activeWaiver({ expiresOn: "2026-09-14" })]), /expired on 2026-09-14/],
    [ledger([activeWaiver({ expiresOn: "2026-10-15" })]), /at most 30 UTC days/],
    [ledger([activeWaiver({ owner: "alice" })]), /GitHub handle/],
    [ledger([activeWaiver({ issue: "#42" })]), /canonical repository issue URL/],
    [
      ledger([
        activeWaiver({
          testSelectors: [
            "e2e/repository.spec.ts#restores a repository snapshot",
            "e2e/repository.spec.ts#restores a repository snapshot",
          ],
        }),
      ]),
      /testSelectors must be unique/,
    ],
    [
      ledger([activeWaiver({ testSelectors: ["../../outside.test.ts#hidden test"] })]),
      /canonical repository-relative test files/,
    ],
    [
      ledger([activeWaiver({ testSelectors: ["/tmp/outside.test.ts#hidden test"] })]),
      /canonical repository-relative test files/,
    ],
    [{ schemaVersion: 1, waivers: [], extra: true }, /unknown root field extra/],
  ];

  for (const [document, expected] of cases) {
    assert.ok(validateTestWaiverLedger(document, { now: NOW }).some((error) => expected.test(error)));
  }
});

test("active test waivers may retire without weakening their immutable scope", () => {
  const base = ledger([activeWaiver()]);
  const current = ledger([retiredWaiver()]);
  assert.deepEqual(validateTestWaiverLedger(current, { now: NOW }), []);
  assert.deepEqual(compareTestWaiverLedgers(current, base), []);
  assert.deepEqual(activeTestWaiverIds(current, { now: NOW }), []);
});

test("retired test waiver tombstones cannot be deleted, reactivated, or rewritten", () => {
  const base = ledger([retiredWaiver()]);
  assert.ok(compareTestWaiverLedgers(ledger(), base).some((error) => /cannot be deleted/.test(error)));
  assert.ok(
    compareTestWaiverLedgers(ledger([activeWaiver()]), base).some((error) =>
      /cannot be reactivated or rewritten/.test(error),
    ),
  );
  assert.ok(
    compareTestWaiverLedgers(
      ledger([retiredWaiver({ retirementReason: "A different historical story." })]),
      base,
    ).some((error) => /cannot be reactivated or rewritten/.test(error)),
  );
});

test("active test waiver scope is immutable and cannot disappear before retirement", () => {
  const base = ledger([activeWaiver()]);
  assert.ok(compareTestWaiverLedgers(ledger(), base).some((error) => /must retire before deletion/.test(error)));
  assert.ok(
    compareTestWaiverLedgers(
      ledger([activeWaiver({ expiresOn: "2026-10-01" })]),
      base,
    ).some((error) => /active scope is immutable/.test(error)),
  );
});

test("new retired test waiver tombstones are rejected", () => {
  assert.deepEqual(compareTestWaiverLedgers(ledger([retiredWaiver()]), ledger()), [
    "new test waiver WAIVER-2026-001 must start active",
  ]);
});

test("repository waiver checker validates the current tracked ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "srt-test-waivers-"));
  mkdirSync(join(root, "docs/engineering"), { recursive: true });
  mkdirSync(join(root, "e2e"), { recursive: true });
  writeFileSync(
    join(root, "e2e/repository.spec.ts"),
    'test("restores a repository snapshot", () => {});\n',
  );
  writeFileSync(
    join(root, "docs/engineering/test-waivers.json"),
    `${JSON.stringify(ledger([activeWaiver()]), null, 2)}\n`,
  );

  assert.deepEqual(
    checkRepositoryTestWaivers(root, { now: NOW, baseLedger: ledger() }),
    [],
  );

  for (const [selector, expected] of [
    ["e2e/missing.spec.ts#restores a repository snapshot", /test path does not exist/],
    ["e2e/repository.spec.ts#unknown static selector", /selector text does not exist/],
  ]) {
    writeFileSync(
      join(root, "docs/engineering/test-waivers.json"),
      `${JSON.stringify(ledger([activeWaiver({ testSelectors: [selector] })]), null, 2)}\n`,
    );
    assert.ok(
      checkRepositoryTestWaivers(root, { now: NOW, baseLedger: ledger() }).some((error) =>
        expected.test(error),
      ),
    );
  }

  writeFileSync(
    join(root, "docs/engineering/test-waivers.json"),
    `${JSON.stringify(ledger([activeWaiver({ expiresOn: "2026-09-14" })]), null, 2)}\n`,
  );
  assert.ok(
    checkRepositoryTestWaivers(root, { now: NOW, baseLedger: ledger() }).some((error) =>
      /expired on 2026-09-14/.test(error),
    ),
  );
});
