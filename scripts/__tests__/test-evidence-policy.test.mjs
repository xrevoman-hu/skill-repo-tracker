import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findForbiddenTestModifiers } from "../test-evidence-policy.mjs";

function runVitestMutation(registrations) {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "skill-repo-tracker-vitest-mutation-"),
  );
  const pathname = join(directory, "false-green.test.mjs");
  const vitestModule = new URL("../../node_modules/vitest/dist/index.js", import.meta.url).href;
  const vitestCli = fileURLToPath(
    new URL("../../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...cleanEnvironment } = process.env;
  writeFileSync(
    pathname,
    [`import { test } from ${JSON.stringify(vitestModule)};`, ...registrations].join("\n"),
  );
  try {
    return spawnSync(
      process.execPath,
      [vitestCli, "run", pathname, "--root", directory, "--environment", "node", "--reporter", "tap"],
      { encoding: "utf8", env: cleanEnvironment },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("throwing generator test bodies cannot masquerade as runner-level passing evidence", () => {
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...cleanEnvironment } = process.env;
  const mutation = [
    'import test from "node:test";',
    'test("false green", function* () { throw new Error("body must execute"); });',
  ].join("\n");
  const runner = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", mutation],
    { encoding: "utf8", env: cleanEnvironment },
  );

  assert.equal(runner.status, 0, `${runner.stdout}\n${runner.stderr}`);
  assert.match(runner.stdout, /ok 1 - false green/);
  assert.doesNotMatch(runner.stdout, /body must execute/);
  assert.match(
    findForbiddenTestModifiers("scripts/__tests__/false-green.test.mjs", mutation)[0],
    /generator callbacks are forbidden/,
  );
});

test("test code cannot terminate the runner before later failures execute", () => {
  const mutation = [
    'import test from "node:test";',
    "process.exit(0);",
    'test("must fail", () => { throw new Error("must execute"); });',
  ].join("\n");
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...cleanEnvironment } = process.env;
  const runner = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", mutation],
    { encoding: "utf8", env: cleanEnvironment },
  );

  assert.equal(runner.status, 0, `${runner.stdout}\n${runner.stderr}`);
  assert.doesNotMatch(runner.stdout, /must fail|must execute/);
  assert.ok(
    findForbiddenTestModifiers("scripts/__tests__/early-exit.test.mjs", mutation).some(
      (error) => error.includes("test runner termination API process.exit is forbidden"),
    ),
  );

  for (const source of [
    "const stop = process.exit; stop(0);",
    'process["ex" + "it"](0);',
    'globalThis.process.exit(0);',
    'import { exit } from "node:process"; exit(0);',
    "const runtime = process; runtime.exit(0);",
  ]) {
    assert.ok(
      findForbiddenTestModifiers("scripts/__tests__/exit-alias.test.mjs", source).length > 0,
      source,
    );
  }
});

test("direct and each registrations reject generator and async-generator callbacks", () => {
  const mutations = [
    'test("generator", function* () {});',
    'test("async generator", async function* () {});',
    'it("generator", function* () {});',
    'it("async generator", async function* () {});',
    'describe("generator", function* () {});',
    'describe("async generator", async function* () {});',
    'suite("generator", function* () {});',
    'suite("async generator", async function* () {});',
    'test.each([1])("generator", function* () {});',
    'test.each([1])("async generator", async function* () {});',
    'it.each([1])("generator", function* () {});',
    'it.each([1])("async generator", async function* () {});',
    'describe.each([1])("generator", function* () {});',
    'describe.each([1])("async generator", async function* () {});',
    'suite.each([1])("generator", function* () {});',
    'suite.each([1])("async generator", async function* () {});',
  ];

  for (const [index, mutation] of mutations.entries()) {
    const errors = findForbiddenTestModifiers(
      `scripts/__tests__/generator-${index}.test.mjs`,
      mutation,
    );
    assert.equal(errors.length, 1, mutation);
    assert.match(errors[0], /generator callbacks are forbidden/, mutation);
  }
});

test("ordinary callbacks cannot return an unconsumed throwing generator", () => {
  const mutation = [
    'import { test } from "vitest";',
    'test("false green", () => (function* () {',
    '  throw new Error("body must execute");',
    '})());',
  ].join("\n");
  const runner = runVitestMutation(mutation.split("\n").slice(1));

  assert.equal(runner.status, 0, `${runner.stdout}\n${runner.stderr}`);
  assert.match(runner.stdout, /ok \d+ - false green/);
  assert.doesNotMatch(runner.stdout, /body must execute/);
  assert.ok(
    findForbiddenTestModifiers("src/generator-return.test.ts", mutation).some((error) =>
      error.includes("generator callbacks are forbidden in governed test code"),
    ),
  );
});

test("test runner APIs cannot be recovered through dynamic imports", () => {
  const mutation = [
    'import { test } from "vitest";',
    'test("sentinel", () => {});',
    'const runner = await import("vitest");',
    'const hidden = runner[["te", "st"].join("")][["sk", "ip"].join("")];',
    'hidden("must execute", () => { throw new Error("body must execute"); });',
  ].join("\n");
  const runner = runVitestMutation(mutation.split("\n").slice(1));

  assert.equal(runner.status, 0, `${runner.stdout}\n${runner.stderr}`);
  assert.match(runner.stdout, /# SKIP/);
  assert.doesNotMatch(runner.stdout, /body must execute/);
  assert.ok(
    findForbiddenTestModifiers("src/dynamic-runner.test.ts", mutation).some((error) =>
      error.includes("dynamically imports test runner module vitest"),
    ),
  );
  assert.ok(
    findForbiddenTestModifiers(
      "src/dynamic-runner-name.test.ts",
      'const runnerName = "vitest"; const runner = await import(runnerName);',
    ).some((error) => error.includes("non-literal dynamic import")),
  );
});

test("Vitest TestOptions and spread tables cannot create false-green evidence", () => {
  const optionMutation = [
    'test("option false green", () => {',
    '  throw new Error("option body must execute");',
    '}, { skip: true });',
  ].join("\n");
  const spreadMutation = [
    'test.each([...[]])("spread row %#", () => {',
    '  throw new Error("spread body must execute");',
    '});',
  ].join("\n");
  const runner = runVitestMutation([
    optionMutation,
    spreadMutation,
    'test("sentinel", () => {});',
  ]);

  assert.equal(runner.status, 0, `${runner.stdout}\n${runner.stderr}`);
  assert.match(runner.stdout, /option false green # SKIP/);
  assert.match(runner.stdout, /ok \d+ - sentinel/);
  assert.doesNotMatch(runner.stdout, /spread row|body must execute/);
  assert.match(
    findForbiddenTestModifiers("src/options.test.ts", optionMutation)[0],
    /only a numeric literal timeout is allowed/,
  );
  assert.match(
    findForbiddenTestModifiers("src/spread.test.ts", spreadMutation)[0],
    /spread and omitted elements are forbidden/,
  );
});

test("direct and each registrations reject TestOptions and non-literal timeouts", () => {
  const mutations = [
    'test("skip", () => {}, { skip: true });',
    'it("todo", () => {}, { todo: true });',
    'describe("only", () => {}, { only: true });',
    'suite("fails", () => {}, { fails: true });',
    'test.each([1])("retry", () => {}, { retry: 1 });',
    'it.each([1])("repeats", () => {}, { repeats: 2 });',
    'describe.each([1])("skip", () => {}, { skip: true });',
    'suite.each([1])("todo", () => {}, { todo: true });',
    'test("identifier timeout", () => {}, TIMEOUT);',
    'it.each([1])("object timeout", () => {}, { timeout: 1000 });',
    'describe("computed timeout", () => {}, 500 + 500);',
    'suite("too many", () => {}, 1000, 2000);',
  ];

  for (const [index, mutation] of mutations.entries()) {
    const errors = findForbiddenTestModifiers(
      `scripts/__tests__/options-${index}.test.mjs`,
      mutation,
    );
    assert.equal(errors.length, 1, mutation);
    assert.match(errors[0], /only a numeric literal timeout is allowed/, mutation);
  }

  const accepted = [
    'test("two arguments", () => {});',
    'it("numeric timeout", () => {}, 1000);',
    'describe("numeric timeout", () => {}, 1000);',
    'suite("numeric timeout", () => {}, 1000);',
    'test.each([1])("two arguments", () => {});',
    'it.each([1])("numeric timeout", () => {}, 1000);',
    'describe.each([1])("numeric timeout", () => {}, 1000);',
    'suite.each([1])("numeric timeout", () => {}, 1000);',
  ].join("\n");
  assert.deepEqual(
    findForbiddenTestModifiers("scripts/__tests__/timeouts.test.mjs", accepted),
    [],
  );
});

test("each data rejects spreads and omitted elements for every registration API", () => {
  const mutations = [
    'test.each([...[]])("zero", () => {});',
    'it.each([,])("omitted", () => {});',
    'describe.each([[1], ...rows])("spread", () => {});',
    'suite.each([, [1]])("mixed omission", () => {});',
  ];

  for (const [index, mutation] of mutations.entries()) {
    const errors = findForbiddenTestModifiers(
      `scripts/__tests__/each-shape-${index}.test.mjs`,
      mutation,
    );
    assert.equal(errors.length, 1, mutation);
    assert.match(errors[0], /spread and omitted elements are forbidden/, mutation);
  }
});

test("suite callbacks cannot return before registering a throwing test", () => {
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...cleanEnvironment } = process.env;
  const mutation = [
    'import { describe, test } from "node:test";',
    'describe("suite", () => {',
    '  return;',
    '  test("must fail", () => { throw new Error("must execute"); });',
    '});',
    'test("dummy", () => {});',
  ].join("\n");
  const runner = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", mutation],
    { encoding: "utf8", env: cleanEnvironment },
  );

  assert.equal(runner.status, 0, `${runner.stdout}\n${runner.stderr}`);
  assert.match(runner.stdout, /ok 1 - suite/);
  assert.match(runner.stdout, /ok 2 - dummy/);
  assert.doesNotMatch(runner.stdout, /must fail|must execute/);
  assert.ok(
    findForbiddenTestModifiers("scripts/__tests__/false-suite.test.mjs", mutation).some(
      (error) => error.includes("describe callback contains return control flow"),
    ),
  );
});

test("describe and suite registration scope rejects control-flow escape hatches", () => {
  const mutations = [
    'describe("return", () => { return; test("hidden", () => {}); });',
    'suite("throw", () => { throw new Error("stop"); test("hidden", () => {}); });',
    'describe.each([1])("try", () => { try { test("hidden", () => {}); } finally {} });',
    'suite.each([1])("break", () => { for (;;) { break; } test("visible", () => {}); });',
    'describe("continue", () => { for (const row of []) { continue; } test("visible", () => {}); });',
  ];
  for (const [index, mutation] of mutations.entries()) {
    const errors = findForbiddenTestModifiers(
      `scripts/__tests__/suite-control-${index}.test.mjs`,
      mutation,
    );
    assert.ok(
      errors.some((error) => error.includes("callback contains")),
      `${mutation}\n${errors.join("\n")}`,
    );
  }

  const safe = [
    'test("test return", () => { return; });',
    'it("test try", () => { try { return; } finally {} });',
    'describe("suite", () => {',
    '  const helper = () => { return; };',
    '  test("nested body", () => { helper(); return; });',
    '});',
  ].join("\n");
  assert.deepEqual(
    findForbiddenTestModifiers("scripts/__tests__/safe-control.test.mjs", safe),
    [],
  );
});
