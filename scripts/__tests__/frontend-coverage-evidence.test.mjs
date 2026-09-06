import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { calculateChangedCoverage } from "../check-coverage.mjs";
import { createFrontendLineEvidence, detailedLineEvidence } from "../frontend-coverage-evidence.mjs";

const span = (start, end = start) => ({ start: { line: start, column: 0 }, end: { line: end, column: null } });
const source = Array.from({ length: 20 }, () => "value").join("\n");

function evidenceFixture() {
  return {
    record: {
      statementMap: { 0: span(2, 15), 1: span(6), 2: span(10, 12) }, s: { 0: 1, 1: 0, 2: 0 },
      fnMap: { 0: { name: "outer", decl: span(1), loc: span(1, 16) },
        1: { name: "callback", decl: span(9), loc: span(9, 13) } },
      f: { 0: 1, 1: 0 },
      branchMap: { 0: { loc: span(4, 8), type: "cond-expr", locations: [span(4), span(5, 8)] } },
      b: { 0: [1, 0] },
    },
    lcov: { lines: new Map([[2, true], [6, false], [10, false]]), branches: new Map([[4, [true, false]]]),
      functions: new Map([["outer", true], ["callback", false]]) },
  };
}

test("multiline statement evidence retains the denominator and never promotes nested zero-hit regions", () => {
  const { record, lcov } = evidenceFixture();
  const covered = detailedLineEvidence(record, lcov, source);
  assert.equal(covered(1), true, "executed function declaration has FN evidence");
  assert.equal(covered(3), true, "multiline statement continuation has range evidence");
  for (const line of [5, 6, 7, 8, 9, 10, 11, 12, 13, 17]) assert.equal(covered(line), false);
  const input = { changed: { "src/view.tsx": [1, 2, 3, 5, 6, 9, 11, 14, 17] },
    lcov: { "src/view.tsx": lcov }, isExecutable: () => true };
  const before = calculateChangedCoverage(input);
  const after = calculateChangedCoverage({ ...input, isCovered: (_path, line) => covered(line) });
  assert.equal(before.lineTotal, 9);
  assert.equal(after.lineTotal, before.lineTotal);
  assert.equal(before.lineCovered, 1);
  assert.equal(after.lineCovered, 4);
});

test("a present zero-hit LCOV line cannot be overridden by supplementary evidence", () => {
  const result = calculateChangedCoverage({ changed: { "src/a.ts": [1] },
    lcov: { "src/a.ts": { lines: new Map([[1, false]]), branches: new Map() } },
    isExecutable: () => true, isCovered: () => true });
  assert.equal(result.lineCovered, 0);
});

test("missing statement coverage remains uncovered even inside a called function body", () => {
  const { record, lcov } = evidenceFixture();
  delete record.statementMap[0];
  delete record.s[0];
  lcov.lines.delete(2);
  assert.equal(detailedLineEvidence(record, lcov, source)(3), false);
  assert.throws(() => detailedLineEvidence(undefined, lcov, source), /missing/);
});

test("detail reports fail closed on missing counters, malformed spans or inconsistent LCOV", () => {
  for (const mutate of [
    (record) => { delete record.s[0]; },
    (record) => { record.s[0] = -1; },
    (record) => { record.s[0] = 0; },
    (record) => { record.statementMap[0] = span(2, 100); },
    (record) => { record.f[0] = NaN; },
    (record) => { record.f[1] = 1; },
    (record) => { record.b[0] = [1]; },
    (record) => { record.b[0] = [1, 1]; },
    (record) => { delete record.fnMap; },
    (record) => { record.branchMap[0].locations[1] = span(0); },
    (record) => { record.branchMap[0].locations[1] = { start: {}, end: {} }; },
  ]) {
    const { record, lcov } = evidenceFixture();
    mutate(record);
    assert.throws(() => detailedLineEvidence(record, lcov, source));
  }
});

test("a synthetic implicit else has no source lines to mark, while its branch still stays uncovered", () => {
  const { record, lcov } = evidenceFixture();
  record.branchMap[0] = { loc: span(4), type: "if", locations: [span(4), { start: {}, end: {} }] };
  const covered = detailedLineEvidence(record, lcov, source);
  assert.equal(covered(3), true);
  const result = calculateChangedCoverage({ changed: { "src/a.ts": [4] },
    lcov: { "src/a.ts": lcov }, isExecutable: () => true, isCovered: (_path, line) => covered(line) });
  assert.equal(result.branchCovered, 1);
  assert.equal(result.branchTotal, 2);
});

test("detailed report lookup binds the exact source path and fails on missing inventory", () => {
  const { record, lcov } = evidenceFixture();
  const absolute = resolve("/tmp/evidence", "src/a.ts");
  const options = { coverage: { [absolute]: { ...record, path: absolute } },
    lcov: { "src/a.ts": lcov }, root: "/tmp/evidence", readSource: () => source };
  const covered = createFrontendLineEvidence(options);
  assert.equal(covered("src/a.ts", 3), true);
  assert.equal(covered("src/a.ts", 3), true);
  assert.throws(() => covered("src/missing.ts", 3), /path/);
  assert.throws(() => createFrontendLineEvidence({ ...options, coverage: [] }), /invalid/);
  assert.throws(() => createFrontendLineEvidence({ ...options,
    coverage: { [absolute]: { ...record, path: "/tmp/other.ts" } } })("src/a.ts", 3), /path/);
});
