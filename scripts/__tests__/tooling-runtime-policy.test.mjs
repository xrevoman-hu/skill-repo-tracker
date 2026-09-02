import assert from "node:assert/strict";
import test from "node:test";

import { findForbiddenToolingRuntimeLoading } from "../line-budgets.mjs";

test("production tooling cannot evaluate executable payloads read from disk", () => {
  assert.deepEqual(
    findForbiddenToolingRuntimeLoading(
      "scripts/loader.mjs",
      [
        'import { readFileSync } from "node:fs";',
        'eval(readFileSync("scripts/__tests__/payload.mjs", "utf8"));',
      ].join("\n"),
    ),
    [
      "scripts/loader.mjs:2:1 uses eval; production tooling cannot execute dynamically loaded code",
    ],
  );
});

test("production tooling cannot load the node vm execution surface", () => {
  for (const source of [
    'import vm from "node:vm";',
    'import { runInThisContext } from "vm";',
    'const vm = require("node:vm");',
    'const vm = await import("node:vm");',
  ]) {
    assert.ok(
      findForbiddenToolingRuntimeLoading("scripts/loader.mjs", source).some((error) =>
        error.includes("loads node:vm; production tooling cannot create a dynamic code context")),
      source,
    );
  }
});

test("production tooling cannot create or register custom Node loaders", () => {
  for (const source of [
    'import { createRequire } from "node:module";',
    'import { createRequire as makeRequire } from "module";',
    'import * as moduleApi from "node:module";',
    'const moduleApi = require("node:module");',
    'const moduleApi = await import("node:module");',
    'module.register("./loader.mjs", import.meta.url);',
    'Module["registerHooks"]({ resolve() {} });',
  ]) {
    assert.ok(
      findForbiddenToolingRuntimeLoading("scripts/loader.mjs", source).some((error) =>
        error.includes("custom Node loader primitives are forbidden")),
      source,
    );
  }
});

test("production tooling dependency closure accepts only static import and export", () => {
  for (const source of [
    'if (false) import("./orphan.mjs");',
    'function hidden() { require("./orphan.mjs"); }',
  ]) {
    assert.ok(
      findForbiddenToolingRuntimeLoading("scripts/loader.mjs", source).some((error) =>
        error.includes("dependency closure accepts only top-level static import/export")),
      source,
    );
  }
});

test("production tooling cannot construct executable source dynamically", () => {
  for (const source of [
    'Function(readFileSync("payload.mjs", "utf8"))();',
    'new Function("return process")();',
    'globalThis.eval("process.exit(0)");',
    'const run = eval; run("process.exit(0)");',
    'const compile = globalThis["Function"]; compile("return process")();',
  ]) {
    assert.ok(
      findForbiddenToolingRuntimeLoading("scripts/loader.mjs", source).some((error) =>
        error.includes("cannot execute dynamically loaded code")),
      source,
    );
  }
});

test("builtin loader and reflection variants cannot recover dynamic execution", () => {
  for (const source of [
    'process.getBuiltinModule("node:vm");',
    'process["get" + "BuiltinModule"]("node:module");',
    'global.eval("process.exit(0)");',
    'globalThis["e" + "val"]("process.exit(0)");',
    'Reflect.get(globalThis, "eval")("process.exit(0)");',
    'Object.getOwnPropertyDescriptor(globalThis, "eval").value("process.exit(0)");',
    'new Proxy(globalThis, {}).eval("process.exit(0)");',
    '(() => {}).constructor("return process")();',
    'module["reg" + "ister"]("./loader.mjs", import.meta.url);',
    'const g = globalThis; g.eval("process.exit(0)");',
    'const G = global; G.Function("return process")();',
    'const key = "eval"; globalThis[key]("process.exit(0)");',
    'globalThis["eval".toString()]("process.exit(0)");',
    'globalThis.Reflect.get(globalThis, "eval")("process.exit(0)");',
    'new globalThis.Proxy(globalThis, {}).eval("process.exit(0)");',
    'const compile = toolbox["Fun" + "ction"]; compile("return process")();',
  ]) {
    assert.ok(
      findForbiddenToolingRuntimeLoading("scripts/loader.mjs", source).length > 0,
      source,
    );
  }
});

test("dynamic-loader words in comments and strings are inert", () => {
  assert.deepEqual(
    findForbiddenToolingRuntimeLoading(
      "scripts/decoy.mjs",
      [
        '// eval(readFileSync("payload.mjs", "utf8"));',
        'const note = "node:vm createRequire module.register eval";',
      ].join("\n"),
    ),
    [],
  );
});
