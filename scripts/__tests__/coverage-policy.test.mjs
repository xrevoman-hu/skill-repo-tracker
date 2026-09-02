import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoverageDiffArguments,
  calculateChangedCoverage,
  calculateChangedCoverageWithDetails,
  findRustConditionalLineRanges,
  findRustCfgTestLineRanges,
  findMissingCoverageFiles,
  isCoverageProductionPath,
  isOmittedCoverageLineExecutable,
  isProbablyExecutableSource,
  loadTrackedJsonAtBase,
  parseTrackedJsonAtBase,
  validateCoverageBaselineDocument,
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
