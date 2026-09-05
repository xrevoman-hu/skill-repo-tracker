import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCoverageArtifactsRegenerated,
  buildCoverageBaselineUpdate,
  buildCoverageDiffArguments,
  calculateChangedCoverage,
  calculateChangedCoverageWithDetails,
  findRustConditionalLineRanges,
  findRustCfgTestLineRanges,
  findMissingCoverageFiles,
  floorCoveragePercent,
  isCoverageProductionPath,
  isOmittedCoverageLineExecutable,
  isProbablyExecutableSource,
  loadTrackedJsonAtBase,
  parseTrackedJsonAtBase,
  runCoverageBaselineProtocol,
  validateCoverageBaselineDocument,
  validateCoverageBaselineArguments,
  validateCoverageMeasurementDocument,
  summarizeLcov,
} from "../check-coverage.mjs";

test("changed coverage compares the base tree with the current working result", () => {
  assert.deepEqual(buildCoverageDiffArguments("base-sha", "src"), [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=0",
    "base-sha",
    "--",
    "src",
  ]);
});

test("changed coverage excludes tests and declarations but includes the app entrypoint", () => {
  assert.equal(isCoverageProductionPath("frontend", "src/App.tsx"), true);
  assert.equal(isCoverageProductionPath("frontend", "src/App.test.tsx"), false);
  assert.equal(isCoverageProductionPath("frontend", "src/App.spec.ts"), false);
  assert.equal(isCoverageProductionPath("frontend", "src/feature.mts"), true);
  assert.equal(isCoverageProductionPath("frontend", "src/feature.cts"), true);
  assert.equal(isCoverageProductionPath("frontend", "src/feature.test.mts"), false);
  assert.equal(isCoverageProductionPath("frontend", "src/contracts.d.mts"), false);
  assert.equal(isCoverageProductionPath("frontend", "src/contracts.d.cts"), false);
  assert.equal(isCoverageProductionPath("frontend", "src/testSetup.ts"), false);
  assert.equal(isCoverageProductionPath("frontend", "src/main.tsx"), true);
  assert.equal(isCoverageProductionPath("rust", "src-tauri/src/backups.rs"), true);
  assert.equal(isCoverageProductionPath("rust", "src-tauri/src/backups_tests.rs"), false);
  assert.equal(isCoverageProductionPath("rust", "src-tauri/src/test.rs"), true);
  assert.equal(isCoverageProductionPath("rust", "src-tauri/src/tests.rs"), true);
  assert.equal(isCoverageProductionPath("rust", "src-tauri/tests/schema.rs"), false);
});

test("coverage inventory fails closed when a production module disappears from LCOV", () => {
  assert.deepEqual(
    findMissingCoverageFiles({
      mode: "frontend",
      sourcePaths: ["src/covered.ts", "src/omitted.ts", "src/covered.test.ts"],
      lcovPaths: ["src/covered.ts"],
    }),
    ["src/omitted.ts"],
  );
  assert.deepEqual(
    findMissingCoverageFiles({
      mode: "rust",
      sourcePaths: [
        "src-tauri/src/lib.rs",
        "src-tauri/src/tests.rs",
        "src-tauri/src/lib_tests.rs",
      ],
      lcovPaths: [],
    }),
    ["src-tauri/src/lib.rs", "src-tauri/src/tests.rs"],
  );
});

test("TypeScript interface and DTO type lines are not counted as executable", () => {
  const contents = [
    "export interface Result {",
    "  id: string;",
    "  nested?: {",
    "    enabled: boolean;",
    "  };",
    "}",
    "export type Choice =",
    '  | { kind: "yes" }',
    '  | { kind: "no" };',
    "export const runtime = () => 1;",
  ].join("\n");
  for (const line of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(isProbablyExecutableSource("src/contracts.ts", contents, line), false);
  }
  assert.equal(isProbablyExecutableSource("src/contracts.ts", contents, 10), true);
});

test("Rust cfg(test) fields, helpers, statements, and inline modules are production-excluded", () => {
  const contents = [
    "struct Hooks {",
    "  #[cfg(test)]",
    "  callback: Option<Box<dyn FnOnce() + Send>> ,",
    "  live: bool,",
    "}",
    "#[cfg(test)]",
    "fn helper(",
    "  value: usize,",
    ") {",
    '  let braces = "{not code}";',
    "}",
    "fn production() {",
    "  #[cfg(test)]",
    "  if true {",
    "    helper(1);",
    "  }",
    "}",
    "#[cfg(test)]",
    "mod tests {",
    "  #[test]",
    "  fn works() {}",
    "}",
  ].join("\n");

  assert.deepEqual(findRustCfgTestLineRanges(contents), [
    { start: 2, end: 3 },
    { start: 6, end: 11 },
    { start: 13, end: 16 },
    { start: 18, end: 22 },
  ]);
});

test("Rust test-range lexer ignores braces in char, byte-char, and raw byte literals", () => {
  const contents = [
    "#[cfg(test)]",
    "fn literals() {",
    "  let open = '{';",
    "  let close = b'}';",
    '  let bytes = br##"} fake close {"##;',
    '  let normal = b"} still a string";',
    "}",
    "fn production() {}",
  ].join("\n");
  assert.deepEqual(findRustCfgTestLineRanges(contents), [{ start: 1, end: 7 }]);
});

test("Rust cfg(any(test)) cannot inflate production LCOV", () => {
  const contents = [
    "#[cfg(any(test))]",
    "fn disguised_test_helper() {",
    "  assert!(true);",
    "}",
    "fn production() {}",
  ].join("\n");
  assert.deepEqual(findRustCfgTestLineRanges(contents), [{ start: 1, end: 4 }]);
});

test("non-test cfg items remain visible when the active coverage build omits them", () => {
  const contents = [
    '#[cfg(not(feature = "coverage-skip"))]',
    "fn default_feature_runtime() {",
    "  release_only_side_effect();",
    "}",
    "#[cfg(not(debug_assertions))]",
    "fn release_only_runtime() {",
    "  release_only_side_effect();",
    "}",
    "#[cfg_attr(coverage_nightly, coverage(off))]",
    "fn instrumentation_hidden() {",
    "  release_only_side_effect();",
    "}",
    "#[cfg(test)]",
    "fn test_helper() {}",
  ].join("\n");
  assert.deepEqual(findRustConditionalLineRanges(contents), [
    { start: 1, end: 4 },
    { start: 5, end: 8 },
    { start: 9, end: 12 },
  ]);
  assert.equal(
    isOmittedCoverageLineExecutable({
      mode: "rust",
      filePresentInLcov: true,
      sourceExecutable: true,
      conditionallyCompiled: true,
    }),
    true,
  );
});

test("LCOV summaries use only the records retained by production filtering", () => {
  assert.deepEqual(
    summarizeLcov({
      "src-tauri/src/example.rs": {
        lines: new Map([[1, true], [2, false]]),
        branches: new Map([[1, [true, false]]]),
        functions: new Map([["covered", true], ["missed", false]]),
      },
    }),
    { lines: 50, branches: 50, functions: 50 },
  );
});

test("an executable line omitted from LCOV is counted as uncovered", () => {
  assert.deepEqual(
    calculateChangedCoverage({
      changed: { "src/new-module.ts": [1, 2] },
      lcov: {},
      isExecutable: (_path, line) => line === 1,
    }),
    {
      linePercent: 0,
      branchPercent: 100,
      lineCovered: 0,
      lineTotal: 1,
      branchCovered: 0,
      branchTotal: 0,
    },
  );
});

test("Rust trusts zero-hit DA records but fails closed when an entire module is absent", () => {
  assert.equal(
    isOmittedCoverageLineExecutable({
      mode: "rust",
      filePresentInLcov: true,
      sourceExecutable: true,
    }),
    false,
  );
  assert.equal(
    isOmittedCoverageLineExecutable({
      mode: "rust",
      filePresentInLcov: false,
      sourceExecutable: true,
    }),
    true,
  );
  assert.equal(
    isOmittedCoverageLineExecutable({
      mode: "frontend",
      filePresentInLcov: true,
      sourceExecutable: true,
    }),
    true,
  );
});

test("changed branch coverage comes from branch records on changed lines", () => {
  assert.deepEqual(
    calculateChangedCoverage({
      changed: { "src/module.ts": [4] },
      lcov: {
        "src/module.ts": {
          lines: new Map([[4, true]]),
          branches: new Map([[4, [true, false]]]),
        },
      },
      isExecutable: () => true,
    }),
    {
      linePercent: 100,
      branchPercent: 50,
      lineCovered: 1,
      lineTotal: 1,
      branchCovered: 1,
      branchTotal: 2,
    },
  );
});

test("coverage percentages floor to two decimals instead of rounding a near-threshold result green", () => {
  assert.equal(floorCoveragePercent(79_999, 100_000), 79.99);
  assert.deepEqual(
    calculateChangedCoverage({
      changed: { "src/module.ts": [1, 2, 3] },
      lcov: {
        "src/module.ts": {
          lines: new Map([[1, true], [2, true], [3, false]]),
          branches: new Map(),
        },
      },
      isExecutable: () => true,
    }),
    {
      linePercent: 66.66,
      branchPercent: 100,
      lineCovered: 2,
      lineTotal: 3,
      branchCovered: 0,
      branchTotal: 0,
    },
  );
});

test("changed coverage details preserve the aggregate and expose file-level diagnostics", () => {
  assert.deepEqual(
    calculateChangedCoverageWithDetails({
      changed: { "src/a.ts": [1], "src/b.ts": [2] },
      lcov: {
        "src/a.ts": {
          lines: new Map([[1, true]]),
          branches: new Map(),
        },
      },
      isExecutable: () => true,
    }),
    {
      linePercent: 50,
      branchPercent: 100,
      lineCovered: 1,
      lineTotal: 2,
      branchCovered: 0,
      branchTotal: 0,
      files: {
        "src/a.ts": {
          linePercent: 100,
          branchPercent: 100,
          lineCovered: 1,
          lineTotal: 1,
          branchCovered: 0,
          branchTotal: 0,
        },
        "src/b.ts": {
          linePercent: 0,
          branchPercent: 100,
          lineCovered: 0,
          lineTotal: 1,
          branchCovered: 0,
          branchTotal: 0,
        },
      },
    },
  );
});

test("coverage bootstrap requires a confirmed absent baseline and rejects corrupt tracked JSON", () => {
  assert.equal(
    parseTrackedJsonAtBase({ tracked: false, contents: undefined, label: "baseline" }),
    undefined,
  );
  assert.throws(
    () => parseTrackedJsonAtBase({ tracked: true, contents: "not-json", label: "baseline" }),
    /tracked baseline is invalid JSON/,
  );
  assert.throws(
    () =>
      loadTrackedJsonAtBase({
        tracked: true,
        readContents: () => {
          throw new Error("git object read failed");
        },
        label: "baseline",
      }),
    /cannot read tracked baseline/,
  );
});

test("coverage baseline documents fail closed when a metric is absent", () => {
  assert.throws(
    () =>
      validateCoverageBaselineDocument(
        {
          frontend: { lines: 70, branches: 70, functions: 70 },
          rust: { lines: 70, branches: 70 },
        },
        "tracked baseline",
      ),
    /tracked baseline has invalid rust\.functions/,
  );
});

test("current coverage baseline schema is strict while a tracked legacy base remains readable", () => {
  const metrics = { lines: 74.15, branches: 75.06, functions: 55.53 };
  const legacy = {
    measuredAtCommit: "working tree on an older release",
    frontend: metrics,
    rust: { lines: 70, branches: 60, functions: 32.09 },
    historicalNote: "ignored only when comparing an already-tracked base",
  };
  assert.equal(
    validateCoverageBaselineDocument(legacy, "legacy baseline", { legacy: true }),
    legacy,
  );
  assert.throws(
    () => validateCoverageBaselineDocument(legacy, "current baseline"),
    /current baseline must contain only measuredAtCommit, protocol, frontend, and rust/,
  );
  assert.throws(
    () =>
      validateCoverageBaselineDocument(
        {
          measuredAtCommit: "not-a-full-commit",
          protocol: "orchestrated-two-run-v1",
          frontend: metrics,
          rust: { lines: 70, branches: 60, functions: 32.09 },
        },
        "current baseline",
      ),
    /invalid measuredAtCommit/,
  );
  assert.throws(
    () =>
      validateCoverageBaselineDocument(
        {
          measuredAtCommit: "a".repeat(40),
          protocol: "orchestrated-two-run-v1",
          frontend: { ...metrics, branches: 75.061 },
          rust: { lines: 70, branches: 60, functions: 32.09 },
        },
        "current baseline",
      ),
    /at most two decimal places/,
  );
  assert.throws(
    () => validateCoverageBaselineDocument({
      measuredAtCommit: "b".repeat(40),
      protocol: "reviewed-bootstrap-v1",
      frontend: metrics,
      rust: { lines: 70, branches: 60, functions: 32.09 },
    }, "current baseline"),
    /may use reviewed-bootstrap-v1 only for ec4162/,
  );
});

test("coverage baseline updates require two clean runs on one commit and cannot lower history", () => {
  const commit = "a".repeat(40);
  const first = {
    commit,
    clean: true,
    artifacts: {
      frontend: { path: "coverage/frontend/coverage-summary.json", mtimeMs: 100 },
      rust: { path: "coverage/rust.lcov", mtimeMs: 200 },
    },
    frontend: { lines: 80.019, branches: 81.009, functions: 82.019 },
    rust: { lines: 83.019, branches: 84.019, functions: 85.019 },
  };
  const second = {
    commit,
    clean: true,
    artifacts: {
      frontend: { path: "coverage/frontend/coverage-summary.json", mtimeMs: 300 },
      rust: { path: "coverage/rust.lcov", mtimeMs: 400 },
    },
    frontend: { lines: 80.011, branches: 81.001, functions: 82.011 },
    rust: { lines: 83.011, branches: 84.011, functions: 85.011 },
  };
  const previous = {
    measuredAtCommit: "c".repeat(40),
    protocol: "orchestrated-two-run-v1",
    frontend: { lines: 80, branches: 81, functions: 82 },
    rust: { lines: 83, branches: 84, functions: 85 },
  };

  assert.deepEqual(
    buildCoverageBaselineUpdate({ first, second, previous, expectedCommit: commit }),
    {
      measuredAtCommit: commit,
      protocol: "orchestrated-two-run-v1",
      frontend: { lines: 80.01, branches: 81, functions: 82.01 },
      rust: { lines: 83.01, branches: 84.01, functions: 85.01 },
    },
  );
  assert.throws(
    () => validateCoverageMeasurementDocument({ ...first, clean: false }, "first run"),
    /clean worktree/,
  );
  assert.throws(
    () =>
      buildCoverageBaselineUpdate({
        first,
        second: { ...second, commit: "b".repeat(40) },
        previous,
      }),
    /same commit/,
  );
  assert.throws(
    () =>
      buildCoverageBaselineUpdate({
        first,
        second: {
          ...second,
          frontend: { ...second.frontend, lines: 80.03 },
        },
        previous,
      }),
    /drifted by more than 0\.01 percentage points/,
  );
  assert.throws(
    () =>
      buildCoverageBaselineUpdate({
        first,
        second,
        previous: {
          ...previous,
          frontend: { ...previous.frontend, lines: 80.02 },
        },
      }),
    /coverage baseline may not decrease/,
  );
  assert.throws(
    () => buildCoverageBaselineUpdate({
      first,
      second: {
        ...second,
        artifacts: { ...second.artifacts, frontend: { ...second.artifacts.frontend, mtimeMs: 100 } },
      },
      previous,
    }),
    /artifact was not regenerated/,
  );
});

test("coverage baseline protocol owns both live runs and rejects external snapshots", () => {
  const commit = "a".repeat(40);
  const measurements = [
    {
      commit,
      clean: true,
      artifacts: {
        frontend: { path: "coverage/frontend/coverage-summary.json", mtimeMs: 100 },
        rust: { path: "coverage/rust.lcov", mtimeMs: 200 },
      },
      frontend: { lines: 80.01, branches: 81, functions: 82.01 },
      rust: { lines: 83.01, branches: 84.01, functions: 85.01 },
    },
    {
      commit,
      clean: true,
      artifacts: {
        frontend: { path: "coverage/frontend/coverage-summary.json", mtimeMs: 300 },
        rust: { path: "coverage/rust.lcov", mtimeMs: 400 },
      },
      frontend: { lines: 80.01, branches: 81, functions: 82.01 },
      rust: { lines: 83.01, branches: 84.01, functions: 85.01 },
    },
  ];
  const calls = [];
  const result = runCoverageBaselineProtocol({
    previous: {
      measuredAtCommit: "c".repeat(40),
      protocol: "orchestrated-two-run-v1",
      frontend: { lines: 80, branches: 81, functions: 82 },
      rust: { lines: 83, branches: 84, functions: 85 },
    },
    expectedCommit: commit,
    runCoverageCycle: (cycle) => {
      calls.push(cycle);
      return measurements[cycle - 1];
    },
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.protocol, "orchestrated-two-run-v1");
  assert.deepEqual(validateCoverageBaselineArguments([]), { write: false });
  assert.deepEqual(validateCoverageBaselineArguments(["--write"]), { write: true });
  assert.throws(
    () => validateCoverageBaselineArguments(["first.json", "second.json", "--write"]),
    /does not accept external snapshot evidence/,
  );
  assert.throws(
    () => validateCoverageBaselineArguments(["--write", "--write"]),
    /does not accept external snapshot evidence/,
  );
});

test("each orchestrated coverage cycle must regenerate both live artifacts", () => {
  const commit = "a".repeat(40);
  const current = {
    commit,
    clean: true,
    artifacts: {
      frontend: { path: "coverage/frontend/coverage-summary.json", mtimeMs: 300 },
      rust: { path: "coverage/rust.lcov", mtimeMs: 400 },
    },
    frontend: { lines: 80.01, branches: 81, functions: 82.01 },
    rust: { lines: 83.01, branches: 84.01, functions: 85.01 },
  };
  assert.doesNotThrow(() => assertCoverageArtifactsRegenerated({ frontend: 100, rust: 200 }, current));
  assert.throws(
    () => assertCoverageArtifactsRegenerated({ frontend: 300, rust: 200 }, current),
    /frontend coverage artifact was not regenerated/,
  );
  assert.throws(
    () => assertCoverageArtifactsRegenerated({ frontend: 100, rust: 400 }, current),
    /rust coverage artifact was not regenerated/,
  );
});
