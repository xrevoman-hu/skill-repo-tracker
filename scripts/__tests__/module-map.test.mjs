import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRepositoryModuleMap,
  compareModuleMaps,
  discoverRustDependenciesFromSource,
  discoverTypeScriptDependenciesFromSource,
  findForbiddenCssImports,
  isProductionSource,
  selectModuleContext,
  validateModuleMap,
} from "../module-map.mjs";
import { trackedFiles, validMap } from "./module-map-fixtures.mjs";

const repositoryRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

test("every production file has exactly one module, layer, and owner Rule", () => {
  assert.deepEqual(
    validateModuleMap({
      map: validMap(),
      productionFiles: [
        "src/App.tsx",
        "src/GitHubWorkbench.tsx",
        "src-tauri/src/lib.rs",
        "src-tauri/src/prompts.rs",
      ],
      trackedFiles,
      dependencies: [],
      rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
    }),
    [],
  );
});

test("a new unowned production file fails closed", () => {
  const errors = validateModuleMap({
    map: validMap(),
    productionFiles: [...trackedFiles.filter((path) => path.startsWith("src/")), "src/NewView.tsx"],
    trackedFiles: [...trackedFiles, "src/NewView.tsx"],
    dependencies: [],
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });

  assert.ok(errors.includes("production file has no module owner: src/NewView.tsx"));
});

test("frontend .mts and .cts files are production sources while their tests are excluded", () => {
  const sourceRoots = validMap().sourceRoots;
  assert.equal(isProductionSource("src/runtime.mts", sourceRoots), true);
  assert.equal(isProductionSource("src/runtime.cts", sourceRoots), true);
  assert.equal(isProductionSource("src/runtime.test.mts", sourceRoots), false);
  assert.equal(isProductionSource("src/runtime.spec.cts", sourceRoots), false);
  assert.equal(isProductionSource("src/runtime.d.mts", sourceRoots), false);
});

test("Rust test.rs and tests.rs remain production across ownership and coverage inventories", () => {
  const sourceRoots = validMap().sourceRoots;
  assert.equal(isProductionSource("src-tauri/src/test.rs", sourceRoots), true);
  assert.equal(isProductionSource("src-tauri/src/tests.rs", sourceRoots), true);
  assert.equal(isProductionSource("src-tauri/src/feature_tests.rs", sourceRoots), false);
});

test("source roots cannot add a language that escapes the repository budgets", () => {
  const map = validMap();
  map.sourceRoots[0].extensions.push(".vue");
  const errors = validateModuleMap({
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles,
    dependencies: [],
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });
  assert.ok(errors.includes("source root src has unsupported frontend extension: .vue"));
});

test("exact-file and subtree source roots cannot shadow production files", () => {
  for (const [shadowPath, target] of [
    ["src/App.tsx", "src/App.tsx"],
    ["src-tauri", "src-tauri/src/lib.rs"],
  ]) {
    const map = validMap();
    map.sourceRoots.unshift({ path: shadowPath, runtime: "frontend", extensions: [".css"] });
    assert.equal(isProductionSource(target, map.sourceRoots), true);
    const errors = validateModuleMap({
      map,
      productionFiles: trackedFiles.filter((pathname) => pathname.startsWith("src")),
      trackedFiles,
      dependencies: [],
      rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
    });
    assert.ok(errors.some((error) => error.startsWith("module source roots overlap:")));
  }
});

test("duplicate ownership and missing owner documents fail closed", () => {
  const map = validMap();
  map.modules[1].paths.push("src/App.tsx");
  map.modules[1].ownerRule = "docs/rules/missing.md";
  map.modules[1].decisions = ["docs/adr/missing.md"];

  const errors = validateModuleMap({
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles,
    dependencies: [],
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });

  assert.ok(errors.includes("production file has multiple module owners: src/App.tsx"));
  assert.ok(errors.includes("module github-view owner Rule is not tracked: docs/rules/missing.md"));
  assert.ok(errors.includes("module github-view decision is not tracked: docs/adr/missing.md"));
});

test("source-root runtimes and cross-runtime dependencies cannot be disguised by ownership", () => {
  const map = validMap();
  map.modules.find((module) => module.id === "rust-prompts").paths.push("src/escape.ts");
  const errors = validateModuleMap({
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src/escape.ts",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles: [...trackedFiles, "src/escape.ts"],
    dependencies: [
      {
        from: "src/escape.ts",
        to: "src/App.tsx",
        kind: "typescript-import",
        specifier: "./App",
      },
    ],
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });

  assert.ok(
    errors.includes(
      "module rust-prompts runtime rust does not match source root src runtime frontend for src/escape.ts",
    ),
  );
  assert.ok(
    errors.includes(
      "cross-runtime module dependency is forbidden: rust-prompts (rust) -> app-shell (frontend) via src/escape.ts -> src/App.tsx",
    ),
  );
});

test("a forbidden dependency edge fails with the source and target modules", () => {
  const errors = validateModuleMap({
    map: validMap(),
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles,
    dependencies: [
      {
        from: "src/GitHubWorkbench.tsx",
        to: "src/App.tsx",
        kind: "typescript-import",
        specifier: "./App",
      },
    ],
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });

  assert.ok(
    errors.includes(
      "forbidden module dependency: github-view (frontend-view) -> app-shell (frontend-shell) via src/GitHubWorkbench.tsx -> src/App.tsx",
    ),
  );
});

test("a forbidden dependency needs an exact, expiring, ADR-backed exception", () => {
  const map = validMap();
  map.dependencyExceptions = [
    {
      from: "src/GitHubWorkbench.tsx",
      to: "src/App.tsx",
      reason: "Legacy type ownership is being extracted.",
      retireWhen: "The contract moves to a view-independent module.",
      adr: "docs/adr/0007-staged-modularization.md",
    },
  ];
  const inputs = {
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles,
    dependencies: [
      {
        from: "src/GitHubWorkbench.tsx",
        to: "src/App.tsx",
        kind: "typescript-import",
        specifier: "./App",
      },
    ],
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  };
  assert.deepEqual(validateModuleMap(inputs), []);

  map.dependencyExceptions[0].to = "src/NotImported.ts";
  const errors = validateModuleMap(inputs);
  assert.ok(
    errors.includes(
      "stale module dependency exception: src/GitHubWorkbench.tsx -> src/NotImported.ts",
    ),
  );
  assert.ok(
    errors.some((error) => error.startsWith("forbidden module dependency: github-view")),
  );
});

test("TypeScript discovery resolves static, side-effect, re-export, and dynamic local imports", () => {
  const knownFiles = new Set([
    "src/App.tsx",
    "src/api.ts",
    "src/styles.css",
    "src/controllers/index.ts",
    "src/comment-only.ts",
  ]);
  const dependencies = discoverTypeScriptDependenciesFromSource({
    path: "src/App.tsx",
    source: `
      import { api } from "./api";
      import "./styles.css";
      export { controller } from "./controllers";
      const lazy = import("./api");
      import React from "react";
      // import "./comment-only";
    `,
    knownFiles,
  });

  assert.deepEqual(
    dependencies.map(({ to }) => to),
    ["src/api.ts", "src/controllers/index.ts", "src/styles.css"],
  );
});

test("TypeScript discovery canonicalizes query/hash and JS-family extension substitution", () => {
  const knownFiles = new Set([
    "src/App.tsx",
    "src/runtime.mts",
    "src/legacy.cts",
    "src/styles.css",
  ]);
  const dependencies = discoverTypeScriptDependenciesFromSource({
    path: "src/GitHubWorkbench.tsx",
    source: [
      'import "./App.js?client";',
      'import "./runtime.mjs#lazy";',
      'import "./legacy.cjs";',
      'import "./styles.css?inline";',
      'const lazy = import(`./App.js#template`);',
    ].join("\n"),
    knownFiles,
  });

  assert.deepEqual(
    dependencies.map(({ to }) => to),
    ["src/App.tsx", "src/legacy.cts", "src/runtime.mts", "src/styles.css"],
  );

  const errors = validateModuleMap({
    map: validMap(),
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles,
    dependencies: dependencies.filter(({ to }) => to === "src/App.tsx"),
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });
  assert.ok(
    errors.includes(
      "forbidden module dependency: github-view (frontend-view) -> app-shell (frontend-shell) via src/GitHubWorkbench.tsx -> src/App.tsx",
    ),
  );
});

test("Vite URL, Worker, and SharedWorker entrypoints participate in forbidden edges", () => {
  const knownFiles = new Set([
    "src/App.tsx",
    "src/worker.ts",
    "src/shared-worker.ts",
    "src/GitHubWorkbench.tsx",
  ]);
  const dependencies = discoverTypeScriptDependenciesFromSource({
    path: "src/GitHubWorkbench.tsx",
    source: [
      'const asset = new URL("./App.js?asset", import.meta.url);',
      'const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });',
      'const shared = new SharedWorker(new URL("./shared-worker.ts#runtime", import.meta.url));',
    ].join("\n"),
    knownFiles,
  });
  assert.deepEqual(
    dependencies.map(({ to }) => to),
    ["src/App.tsx", "src/shared-worker.ts", "src/worker.ts"],
  );

  const map = validMap();
  map.modules.find((module) => module.id === "app-shell").paths.push(
    "src/worker.ts",
    "src/shared-worker.ts",
  );
  const errors = validateModuleMap({
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src/worker.ts",
      "src/shared-worker.ts",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles: [...trackedFiles, "src/worker.ts", "src/shared-worker.ts"],
    dependencies,
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });
  for (const target of ["src/App.tsx", "src/shared-worker.ts", "src/worker.ts"]) {
    assert.ok(
      errors.includes(
        `forbidden module dependency: github-view (frontend-view) -> app-shell (frontend-shell) via src/GitHubWorkbench.tsx -> ${target}`,
      ),
    );
  }
});

test("CSS imports cannot hide a dependency edge, including escaped at-keywords", () => {
  for (const directive of [
    '@import "./shell.css";',
    '@\\69mport url("./shell.css");',
  ]) {
    assert.deepEqual(findForbiddenCssImports("src/feature.css", directive), [
      "src/feature.css uses CSS @import; import stylesheets from TypeScript so module dependencies remain auditable",
    ]);
  }
  assert.deepEqual(
    findForbiddenCssImports(
      "src/feature.css",
      '/* @import "decoy.css"; */ .label::before { content: "@import"; }',
    ),
    [],
  );

  for (const declaration of [
    'background: url("https://example.com/asset.png");',
    'mask-image: \\75rl(./local.svg);',
  ]) {
    assert.deepEqual(findForbiddenCssImports("src/feature.css", `.feature { ${declaration} }`), [
      "src/feature.css uses CSS url(); route assets and external hosts through the audited TypeScript inventory",
    ]);
  }
  assert.deepEqual(
    findForbiddenCssImports(
      "src/feature.css",
      '/* url(decoy.png) */ .label::before { content: "url(decoy.png)"; }',
    ),
    [],
  );
});

test("Rust discovery records declared modules and qualified sibling references only", () => {
  const result = discoverRustDependenciesFromSource({
    path: "src-tauri/src/lib.rs",
    source: `
      mod prompts;
      #[cfg(test)] mod tests;
      use crate as root;
      use root as second_root;
      use crate::{adapters::FilesystemAdapter, bare_module, prompts::{save_prompt, Prompt}};
      use super::{comment_only::Thing};
      use second_root::{test_only::Thing};
      let id = crate::temp_artifacts::unique_operation_id();
      let _ = crate::AppError::new("x", "y");
      // mod comment_only;
      #[cfg(test)] mod test_only;
    `,
    rustModulePaths: new Map([
      ["adapters", "src-tauri/src/adapters.rs"],
      ["bare_module", "src-tauri/src/bare_module.rs"],
      ["prompts", "src-tauri/src/prompts.rs"],
      ["temp_artifacts", "src-tauri/src/temp_artifacts.rs"],
      ["comment_only", "src-tauri/src/comment_only.rs"],
      ["test_only", "src-tauri/src/test_only.rs"],
    ]),
  });

  assert.deepEqual(result.declarations, [
    { name: "prompts", from: "src-tauri/src/lib.rs" },
  ]);
  assert.deepEqual(
    result.dependencies.map(({ to }) => to),
    [
      "src-tauri/src/adapters.rs",
      "src-tauri/src/bare_module.rs",
      "src-tauri/src/comment_only.rs",
      "src-tauri/src/prompts.rs",
      "src-tauri/src/temp_artifacts.rs",
      "src-tauri/src/test_only.rs",
    ],
  );
});

test("Rust discovery resolves grouped aliases that still name the crate root", () => {
  const result = discoverRustDependenciesFromSource({
    path: "src-tauri/src/lib.rs",
    source: `
      use crate::{self as grouped_root};
      use {crate as braced_root};
      use {crate::{self as nested_root}};
      use grouped_root::{self as second_root};
      use {second_root as third_root};
      extern crate self as extern_root;
      let _ = grouped_root::prompts::save_prompt();
      let _ = braced_root::temp_artifacts::unique_operation_id();
      let _ = nested_root::prompt_zip::export();
      let _ = third_root::prompt_migration::import();
      let _ = extern_root::extern_only::run();
      let _ = self::self_only::run();
    `,
    rustModulePaths: new Map([
      ["prompts", "src-tauri/src/prompts.rs"],
      ["temp_artifacts", "src-tauri/src/temp_artifacts.rs"],
      ["prompt_zip", "src-tauri/src/prompt_zip.rs"],
      ["prompt_migration", "src-tauri/src/prompt_migration.rs"],
      ["extern_only", "src-tauri/src/extern_only.rs"],
      ["self_only", "src-tauri/src/self_only.rs"],
    ]),
  });

  assert.deepEqual(
    result.dependencies.map(({ to }) => to),
    [
      "src-tauri/src/extern_only.rs",
      "src-tauri/src/prompt_migration.rs",
      "src-tauri/src/prompt_zip.rs",
      "src-tauri/src/prompts.rs",
      "src-tauri/src/self_only.rs",
      "src-tauri/src/temp_artifacts.rs",
    ],
  );
});

test("extern crate self aliases and lib self references cannot hide forbidden Rust edges", () => {
  const map = validMap();
  map.layers.find((layer) => layer.id === "rust-composition").forbiddenDependencies.push(
    "rust-domain",
  );
  const externDependency = discoverRustDependenciesFromSource({
    path: "src-tauri/src/prompts.rs",
    source: "extern crate self as root; use root::composition_bridge::state;",
    rustModulePaths: new Map([
      ["composition_bridge", "src-tauri/src/composition_bridge.rs"],
    ]),
  });
  const selfDependency = discoverRustDependenciesFromSource({
    path: "src-tauri/src/lib.rs",
    source: "let _ = self::prompts::save_prompt();",
    rustModulePaths: new Map([["prompts", "src-tauri/src/prompts.rs"]]),
  });
  map.modules.find((module) => module.id === "rust-root").paths.push(
    "src-tauri/src/composition_bridge.rs",
  );
  const errors = validateModuleMap({
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
      "src-tauri/src/composition_bridge.rs",
    ],
    trackedFiles: [...trackedFiles, "src-tauri/src/composition_bridge.rs"],
    dependencies: [...externDependency.dependencies, ...selfDependency.dependencies],
    rustDeclarations: [
      { name: "prompts", from: "src-tauri/src/lib.rs" },
      { name: "composition_bridge", from: "src-tauri/src/lib.rs" },
    ],
  });

  assert.ok(
    errors.includes(
      "forbidden module dependency: rust-prompts (rust-domain) -> rust-root (rust-composition) via src-tauri/src/prompts.rs -> src-tauri/src/composition_bridge.rs",
    ),
  );
  assert.ok(
    errors.includes(
      "forbidden module dependency: rust-root (rust-composition) -> rust-prompts (rust-domain) via src-tauri/src/lib.rs -> src-tauri/src/prompts.rs",
    ),
  );
});

test("a grouped Rust root alias cannot hide a forbidden layer edge", () => {
  const map = validMap();
  map.modules.find((module) => module.id === "rust-root").paths.push(
    "src-tauri/src/composition_bridge.rs",
  );
  const discovered = discoverRustDependenciesFromSource({
    path: "src-tauri/src/prompts.rs",
    source: `
      use crate::{self as root};
      use {root as second_root};
      let _ = second_root::composition_bridge::state();
    `,
    rustModulePaths: new Map([
      ["composition_bridge", "src-tauri/src/composition_bridge.rs"],
    ]),
  });
  const errors = validateModuleMap({
    map,
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
      "src-tauri/src/composition_bridge.rs",
    ],
    trackedFiles: [...trackedFiles, "src-tauri/src/composition_bridge.rs"],
    dependencies: discovered.dependencies,
    rustDeclarations: [
      { name: "prompts", from: "src-tauri/src/lib.rs" },
      { name: "composition_bridge", from: "src-tauri/src/lib.rs" },
    ],
  });

  assert.ok(
    errors.includes(
      "forbidden module dependency: rust-prompts (rust-domain) -> rust-root (rust-composition) via src-tauri/src/prompts.rs -> src-tauri/src/composition_bridge.rs",
    ),
  );
});

test("Rust production module files must be declared exactly once", () => {
  const errors = validateModuleMap({
    map: validMap(),
    productionFiles: [
      "src/App.tsx",
      "src/GitHubWorkbench.tsx",
      "src-tauri/src/lib.rs",
      "src-tauri/src/prompts.rs",
    ],
    trackedFiles,
    dependencies: [],
    rustDeclarations: [],
  });

  assert.ok(
    errors.includes("Rust production module is not declared: src-tauri/src/prompts.rs (mod prompts;)"),
  );
});

test("base comparison makes ownership moves and policy weakening reviewable through an ADR", () => {
  const base = validMap();
  const current = validMap();
  current.modules[0].paths = [];
  current.modules[1].paths.push("src/App.tsx");
  current.layers[1].forbiddenDependencies = [];

  assert.deepEqual(compareModuleMaps(current, base), [
    "dependency policy was weakened without an ADR-backed change: frontend-view -> frontend-shell",
    "module ownership changed without an ADR-backed move: src/App.tsx app-shell/frontend-shell/docs/rules/testing-release.md -> github-view/frontend-view/docs/rules/permissions.md",
  ]);

  current.moves = [
    {
      path: "src/App.tsx",
      fromModule: "app-shell",
      toModule: "github-view",
      adr: "docs/adr/0007-staged-modularization.md",
    },
  ];
  current.policyChanges = [
    {
      from: "frontend-view",
      to: "frontend-shell",
      adr: "docs/adr/0007-staged-modularization.md",
    },
  ];
  assert.deepEqual(compareModuleMaps(current, base), []);
});

test("base comparison prevents source-root contraction, decision erasure, and unreviewed layers", () => {
  const base = validMap();
  const current = validMap();
  current.sourceRoots[0] = {
    path: "src",
    runtime: "rust",
    extensions: [".ts", ".tsx", ".mts", ".css"],
  };
  current.modules[0].decisions = [];
  current.layers.push({
    id: "frontend-unreviewed",
    runtime: "frontend",
    forbiddenDependencies: [],
  });

  assert.deepEqual(compareModuleMaps(current, base), [
    "module app-shell removed historical decision: docs/adr/0007-staged-modularization.md",
    "module layer was added without an ADR-backed policy change: frontend-unreviewed",
    "module source root extension was removed: src .cts",
    "module source root runtime changed: src frontend -> rust",
  ]);

  current.policyChanges = [
    {
      kind: "add-layer",
      layer: "frontend-unreviewed",
      adr: "docs/adr/0007-staged-modularization.md",
    },
  ];
  assert.ok(
    !compareModuleMaps(current, base).includes(
      "module layer was added without an ADR-backed policy change: frontend-unreviewed",
    ),
  );

  const missingRoot = validMap();
  missingRoot.sourceRoots = missingRoot.sourceRoots.filter((root) => root.path !== "src");
  assert.ok(compareModuleMaps(missingRoot, base).includes("module source root was removed: src"));
});

test("source-root additions and reordering require append-only ADR policy records", () => {
  const base = validMap();
  const added = validMap();
  added.sourceRoots.push({ path: "generated", runtime: "frontend", extensions: [".ts"] });
  assert.ok(compareModuleMaps(added, base).includes(
    "module source root was added without an ADR-backed policy change: generated",
  ));
  added.policyChanges = [{
    kind: "add-source-root",
    path: "generated",
    adr: "docs/adr/0007-staged-modularization.md",
  }];
  assert.ok(!compareModuleMaps(added, base).some((error) => error.includes("source root was added")));

  const reordered = validMap();
  reordered.sourceRoots.reverse();
  assert.ok(compareModuleMaps(reordered, base).includes(
    "module source roots were reordered without an ADR-backed policy change",
  ));
  reordered.policyChanges = [{
    kind: "reorder-source-roots",
    order: reordered.sourceRoots.map(({ path }) => path),
    adr: "docs/adr/0007-staged-modularization.md",
  }];
  assert.ok(!compareModuleMaps(reordered, base).some((error) => error.includes("were reordered")));
});

test("dependency exception history is immutable until its dependency edge disappears", () => {
  const base = validMap();
  base.dependencyExceptions = [{
    from: "src/GitHubWorkbench.tsx",
    to: "src/App.tsx",
    reason: "Legacy shell contract.",
    retireWhen: "The contract moves out of the shell.",
    adr: "docs/adr/0007-staged-modularization.md",
  }];
  const dependencyKeys = new Set(["src/GitHubWorkbench.tsx\0src/App.tsx"]);
  for (const [field, value] of [
    ["reason", "A rewritten explanation."],
    ["retireWhen", "never"],
    ["adr", "docs/adr/0005-prompt-export-and-migration.md"],
  ]) {
    const current = structuredClone(base);
    current.dependencyExceptions[0][field] = value;
    assert.ok(
      compareModuleMaps(current, base, { dependencyKeys }).some(
        (error) => error.startsWith("module dependency exception history was rewritten:"),
      ),
    );
  }

  const removed = structuredClone(base);
  removed.dependencyExceptions = [];
  assert.ok(
    compareModuleMaps(removed, base, { dependencyKeys }).some(
      (error) => error.startsWith("module dependency exception history was removed:"),
    ),
  );
  assert.deepEqual(compareModuleMaps(removed, base, { dependencyKeys: new Set() }), []);
});

test("module moves and policy changes form an append-only immutable audit log", () => {
  const base = validMap();
  base.moves = [{
    path: "src/App.tsx",
    fromModule: "legacy-shell",
    toModule: "app-shell",
    adr: "docs/adr/0007-staged-modularization.md",
  }];
  base.policyChanges = [
    {
      from: "frontend-view",
      to: "frontend-shell",
      adr: "docs/adr/0007-staged-modularization.md",
    },
    {
      kind: "add-layer",
      layer: "frontend-view",
      adr: "docs/adr/0007-staged-modularization.md",
    },
  ];

  for (const [collection, index] of [["moves", 0], ["policyChanges", 0], ["policyChanges", 1]]) {
    const removed = structuredClone(base);
    removed[collection].splice(index, 1);
    assert.ok(compareModuleMaps(removed, base).some((error) => error.includes("was removed")));

    const rewritten = structuredClone(base);
    rewritten[collection][index].adr = "docs/adr/0005-prompt-export-and-migration.md";
    assert.ok(compareModuleMaps(rewritten, base).some((error) => error.includes("was rewritten")));
  }

  const appended = structuredClone(base);
  appended.moves.push({
    path: "src/GitHubWorkbench.tsx",
    fromModule: "github-view",
    toModule: "app-shell",
    adr: "docs/adr/0007-staged-modularization.md",
  });
  appended.policyChanges.push({
    from: "frontend-shell",
    to: "frontend-view",
    adr: "docs/adr/0007-staged-modularization.md",
  });
  assert.deepEqual(compareModuleMaps(appended, base), []);
});

test("module map audit-record identities cannot be duplicated", () => {
  const map = validMap();
  const move = {
    path: "src/App.tsx",
    fromModule: "legacy-shell",
    toModule: "app-shell",
    adr: "docs/adr/0007-staged-modularization.md",
  };
  const policyChange = {
    from: "frontend-view",
    to: "frontend-shell",
    adr: "docs/adr/0007-staged-modularization.md",
  };
  map.moves = [move, { ...move }];
  map.policyChanges = [policyChange, { ...policyChange }];
  const errors = validateModuleMap({
    map,
    productionFiles: trackedFiles.filter((pathname) => pathname.startsWith("src")),
    trackedFiles,
    dependencies: [],
    rustDeclarations: [{ name: "prompts", from: "src-tauri/src/lib.rs" }],
  });
  assert.ok(errors.some((error) => error.startsWith("duplicate module map move:")));
  assert.ok(errors.some((error) => error.startsWith("duplicate module map policy change:")));
});

test("context selection returns the owning module, Rule, and ADR without loading unrelated modules", () => {
  assert.deepEqual(selectModuleContext(validMap(), ["src/GitHubWorkbench.tsx"]), {
    modules: ["github-view"],
    ownerRules: ["docs/rules/permissions.md"],
    decisions: [],
  });
});

test("the tracked module map covers the current repository", () => {
  assert.deepEqual(checkRepositoryModuleMap(repositoryRoot), []);
});
