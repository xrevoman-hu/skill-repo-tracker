import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverTypeScriptDependenciesFromSource,
  findForbiddenTypeScriptModuleGraphPatterns,
} from "../module-map.mjs";

test("Vite glob and computed dynamic imports cannot escape the module graph", () => {
  for (const source of [
    'const modules = import.meta.glob("./shell/*.ts", { eager: true });',
    'const glob = import.meta["glob"]; glob("./shell/*.ts");',
    "const meta = import.meta; meta.glob('./shell/*.ts');",
  ]) {
    assert.deepEqual(findForbiddenTypeScriptModuleGraphPatterns("src/feature.ts", source), [
      "src/feature.ts uses import.meta outside new URL(<literal>, import.meta.url); Vite glob and computed entrypoints are forbidden",
    ]);
  }

  for (const source of [
    "const target = './api'; import(target);",
    "const name = 'api'; import(`./${name}.ts`);",
  ]) {
    assert.deepEqual(findForbiddenTypeScriptModuleGraphPatterns("src/feature.ts", source), [
      "src/feature.ts uses a non-literal dynamic import; every bundled dependency must be explicit in the module map",
    ]);
  }

  assert.deepEqual(
    findForbiddenTypeScriptModuleGraphPatterns(
      "src/feature.ts",
      'const asset = new URL("./asset.ts", import.meta.url); const lazy = import("./api");',
    ),
    [],
  );
});

test("canonical absolute src imports stay inside the owned module graph", () => {
  assert.deepEqual(
    discoverTypeScriptDependenciesFromSource({
      path: "src/feature.ts",
      source: 'import App from "/src/App";',
      knownFiles: new Set(["src/feature.ts", "src/App.tsx"]),
    }),
    [
      {
        from: "src/feature.ts",
        kind: "typescript-import",
        specifier: "/src/App",
        to: "src/App.tsx",
      },
    ],
  );
});
