import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findToolingTestHelperHazards,
  findOrphanToolingModules,
  findStaticTestRegistrationHazards,
} from "../line-budgets.mjs";
import {
  discoverToolingEntrypointsFromPolicies,
  checkRepositoryTestInventory,
  expectedJavaScriptTestRunner,
} from "../architecture-budget-checks.mjs";

test("repository test inventory rejects a side-effect helper that registers test.skip", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "runner-helper-inventory-"));
  const sources = {
    "src/policy.test.ts": 'import "./registrar"; test("sentinel", () => {});',
    "src/registrar.ts": [
      'import { test } from "vitest";',
      'test.skip("false evidence", () => { throw new Error("must execute"); });',
    ].join("\n"),
    "e2e/demo.spec.ts": 'import "./fixture"; test("sentinel", () => {});',
    "e2e/fixture.ts": "export const fixture = true;",
  };
  try {
    for (const [pathname, source] of Object.entries(sources)) {
      mkdirSync(join(root, pathname, ".."), { recursive: true });
      writeFileSync(join(root, pathname), source);
    }
    const errors = checkRepositoryTestInventory(root, Object.keys(sources), {
      runner: {
        rustAllowedCfg: ["debug_assertions", 'target_os="macos"', "test", "unix"],
      },
    });
    assert.ok(
      errors.some(
        (error) => error.includes("src/registrar.ts") && error.includes("test.skip is forbidden"),
      ),
      errors.join("\n"),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
import { gateRunnerCoverage } from "../governance-assets-history.mjs";
import { canonicalCommandInvocations } from "../static-command-policy.mjs";

function runDynamicRunnerHelperMutation(runner) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `dynamic-${runner}-helper-`));
  const moduleName = runner === "node" ? "node:test" : runner === "vitest" ? "vitest" : "@playwright/test";
  const helper = [
    `const moduleName = ${JSON.stringify(moduleName.split(":" )[0].split("/test")[0])} + ${JSON.stringify(moduleName.includes(":") ? `:${moduleName.split(":")[1]}` : moduleName.includes("/test") ? "/test" : "")};`,
    "const runner = await import(moduleName);",
    'const register = runner[["te", "st"].join("")];',
    'register("hidden false green", function* () { throw new Error("must execute"); });',
  ].join("\n");
  const extension = runner === "vitest" ? "test.mjs" : runner === "playwright" ? "spec.mjs" : "test.mjs";
  const entry = join(root, `probe.${extension}`);
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...environment } = process.env;
  try {
    if (runner !== "node") {
      symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    }
    writeFileSync(join(root, "helper.mjs"), helper);
    writeFileSync(
      entry,
      [
        'import "./helper.mjs";',
        runner === "node"
          ? 'import test from "node:test";'
          : `import { test } from ${JSON.stringify(moduleName)};`,
        runner === "playwright"
          ? 'test("sentinel", async () => {});'
          : 'test("sentinel", () => {});',
      ].join("\n"),
    );
    if (runner === "node") {
      return spawnSync(process.execPath, ["--test", entry], {
        encoding: "utf8",
        env: environment,
      });
    }
    if (runner === "vitest") {
      return spawnSync(
        process.execPath,
        [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", entry, "--root", root],
        { encoding: "utf8", env: environment },
      );
    }
    return spawnSync(
      process.execPath,
      [
        join(process.cwd(), "node_modules/@playwright/test/cli.js"),
        "test",
        entry,
        "--config",
        root,
        "--reporter=line",
        "--workers=1",
      ],
      { cwd: root, encoding: "utf8", env: { ...environment, CI: "1" } },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test("test-like JavaScript paths must be visible to one configured runner", () => {
  assert.equal(expectedJavaScriptTestRunner("scripts/__tests__/policy.test.mjs"), "node:test");
  assert.equal(expectedJavaScriptTestRunner("src/feature.test.tsx"), "vitest");
  assert.equal(expectedJavaScriptTestRunner("e2e/demo.spec.ts"), "playwright");
  assert.equal(
    expectedJavaScriptTestRunner("scripts/__tests__/nested/ghost.test.mjs"),
    undefined,
  );
  assert.equal(expectedJavaScriptTestRunner("scripts/ghost.test.mjs"), undefined);
});

test("tooling modules must be in an entrypoint import closure or an owned standalone catalog", () => {
  const sources = {
    "scripts/verify.mjs": 'import "./policy.mjs";',
    "scripts/policy.mjs": 'export const policy = "active";',
    "scripts/orphan.mjs": 'export const hidden = "unowned";',
  };
  assert.deepEqual(
    findOrphanToolingModules({
      sources,
      entrypoints: new Set(["scripts/verify.mjs"]),
      standalone: {},
    }),
    [
      "orphan governance tool is not reachable from a package/workflow/verify entrypoint: scripts/orphan.mjs",
    ],
  );
  assert.deepEqual(
    findOrphanToolingModules({
      sources,
      entrypoints: new Set(["scripts/verify.mjs"]),
      standalone: {
        "scripts/orphan.mjs": {
          kind: "generator",
          owner: "release engineering",
          retireWhen: "the generator becomes part of verify",
        },
      },
    }),
    [],
  );
});

test("dead dynamic imports and uncalled require calls do not make tooling reachable", () => {
  for (const entrySource of [
    'if (false) import("./orphan.mjs");',
    'function hidden() { require("./orphan.mjs"); }',
  ]) {
    assert.deepEqual(
      findOrphanToolingModules({
        sources: {
          "scripts/verify.mjs": entrySource,
          "scripts/orphan.mjs": "export const hidden = true;",
        },
        entrypoints: new Set(["scripts/verify.mjs"]),
        standalone: {},
      }),
      [
        "orphan governance tool is not reachable from a package/workflow/verify entrypoint: scripts/orphan.mjs",
      ],
    );
  }
});

test("tooling entrypoints come only from structured command fields, not workflow comments", () => {
  assert.deepEqual(
    [...discoverToolingEntrypointsFromPolicies({
      knownFiles: new Set([
        "scripts/package-root.mjs",
        "scripts/verify-root.mjs",
        "scripts/workflow-root.mjs",
        "scripts/orphan.mjs",
      ]),
      packageJson: { scripts: { check: "node scripts/package-root.mjs" } },
      verifyPlan: {
        steps: [{ command: "node", args: ["scripts/verify-root.mjs"] }],
      },
      workflowSources: [
        [
          "# node scripts/orphan.mjs",
          "jobs:",
          "  verify:",
          "    steps:",
          "      - run: |",
          "          # node scripts/orphan.mjs",
          "          node scripts/workflow-root.mjs",
        ].join("\n"),
      ],
    })].sort(),
    [
      "scripts/package-root.mjs",
      "scripts/verify-root.mjs",
      "scripts/workflow-root.mjs",
    ],
  );
});

test("tooling entrypoints ignore echo, assignments, trailing comments, and dead shell branches", () => {
  const knownFiles = new Set(["scripts/live.mjs", "scripts/orphan.mjs"]);
  assert.deepEqual(
    [...discoverToolingEntrypointsFromPolicies({
      knownFiles,
      packageJson: {
        scripts: {
          live: "node scripts/live.mjs # node scripts/orphan.mjs",
          echo: "echo scripts/orphan.mjs",
          assigned: "TARGET=scripts/orphan.mjs; node $TARGET",
          dead: "if false; then node scripts/orphan.mjs; fi",
        },
      },
    })],
    ["scripts/live.mjs"],
  );
});

test("canonical command parsing rejects shell decoys but preserves explicit invocations", () => {
  assert.deepEqual(canonicalCommandInvocations("node scripts/live.mjs # echo scripts/orphan.mjs"), [
    ["node", "scripts/live.mjs"],
  ]);
  assert.deepEqual(canonicalCommandInvocations("echo node scripts/orphan.mjs"), [
    ["echo", "node", "scripts/orphan.mjs"],
  ]);
  for (const command of [
    "if false; then node scripts/orphan.mjs; fi",
    "TARGET=scripts/orphan.mjs; node $TARGET",
    "false && node scripts/orphan.mjs",
    "exit 0 && node scripts/orphan.mjs",
    "exit 0\nnode scripts/orphan.mjs",
    "exec true && node scripts/orphan.mjs",
    "return 0 && node scripts/orphan.mjs",
    "trap 'exit 0' DEBUG\nnode scripts/orphan.mjs",
    "set -n\nnode scripts/orphan.mjs",
    "command node scripts/orphan.mjs",
    "builtin eval 'node scripts/orphan.mjs'",
  ]) {
    assert.deepEqual(canonicalCommandInvocations(command), [], command);
  }
});

test("shell termination really prevents the marker command used by the mutation", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "command-policy-marker-"));
  const marker = join(root, "should-not-exist");
  try {
    for (const command of [
      `exit 0 && touch ${JSON.stringify(marker)}`,
      `exec true && touch ${JSON.stringify(marker)}`,
      `set -n\ntouch ${JSON.stringify(marker)}`,
      `trap 'exit 0' DEBUG\ntouch ${JSON.stringify(marker)}`,
    ]) {
      execFileSync("/bin/bash", ["-c", command]);
      assert.equal(existsSync(marker), false, command);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governance gate runner coverage ignores echoed and commented runner names", () => {
  const packageScripts = {
    echoVitest: "echo vitest run",
    commentCargo: "true # cargo test",
    printPlaywright: 'printf "playwright test"',
    echoNpm: "echo npm run test",
    real: "vitest run",
  };
  const gates = Object.keys(packageScripts).map((ref) => ({ id: ref, kind: "package-script", ref }));
  const coverage = gateRunnerCoverage(gates, packageScripts, () => "");
  for (const id of ["echoVitest", "commentCargo", "printPlaywright", "echoNpm"]) {
    assert.deepEqual([...coverage.get(id)], [], id);
  }
  assert.deepEqual([...coverage.get("real")], ["vitest"]);

  const workflows = {
    ".github/workflows/mixed.yml": [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: set -n",
      "      - run: vitest run",
    ].join("\n"),
    ".github/workflows/poisoned.yml": [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: |",
      "          trap 'exit 0' DEBUG",
      "          vitest run",
    ].join("\n"),
  };
  const workflowCoverage = gateRunnerCoverage(
    Object.keys(workflows).map((ref) => ({ id: ref, kind: "workflow", ref })),
    packageScripts,
    (path) => workflows[path],
  );
  assert.deepEqual([...workflowCoverage.get(".github/workflows/mixed.yml")], ["vitest"]);
  assert.deepEqual([...workflowCoverage.get(".github/workflows/poisoned.yml")], []);
});

test("tooling test helpers must be statically reachable and cannot register node:test", () => {
  const sources = {
    "scripts/__tests__/policy.test.mjs": 'import "./fixture.mjs"; test("ok", () => {});',
    "scripts/__tests__/fixture.mjs": "export const fixture = true;",
    "scripts/__tests__/ghost.mjs": "export const ghost = true;",
    "scripts/__tests__/dynamic.mjs": "export const dynamic = true;",
    "scripts/__tests__/registrar.mjs": 'import test from "node:test"; test("hidden", () => {});',
    "scripts/__tests__/lazy.test.mjs": 'import("./dynamic.mjs"); test("lazy", () => {});',
  };
  assert.deepEqual(findToolingTestHelperHazards({ sources }), [
    "tooling test helper imports node:test registration APIs: scripts/__tests__/registrar.mjs",
    "tooling test helper is not statically reachable from a collected *.test.mjs file: scripts/__tests__/dynamic.mjs",
    "tooling test helper is not statically reachable from a collected *.test.mjs file: scripts/__tests__/ghost.mjs",
    "tooling test helper is not statically reachable from a collected *.test.mjs file: scripts/__tests__/registrar.mjs",
  ]);
});

test("an intentionally standalone test fixture needs explicit lifecycle metadata", () => {
  const sources = { "scripts/__tests__/standalone-fixture.mjs": "export const fixture = true;" };
  assert.deepEqual(
    findToolingTestHelperHazards({
      sources,
      fixtureCatalog: {
        "scripts/__tests__/standalone-fixture.mjs": {
          owner: "governance",
          retireWhen: "the external fixture consumer is removed",
        },
      },
    }),
    [],
  );
  assert.deepEqual(
    findToolingTestHelperHazards({
      sources,
      fixtureCatalog: {
        "scripts/__tests__/standalone-fixture.mjs": { owner: "", retireWhen: "" },
      },
    }),
    [
      "tooling fixture scripts/__tests__/standalone-fixture.mjs must declare an owner",
      "tooling fixture scripts/__tests__/standalone-fixture.mjs must declare retireWhen",
    ],
  );
});

test("test helpers reject aliased, re-exported, and dynamic node:test registration APIs", () => {
  for (const source of [
    'import { it as register } from "node:test"; register("hidden", () => {});',
    'export { describe } from "node:test";',
    'const { suite } = await import("node:test"); suite("hidden", () => {});',
  ]) {
    assert.ok(
      findToolingTestHelperHazards({
        sources: {
          "scripts/__tests__/policy.test.mjs": 'import "./helper.mjs"; test("ok", () => {});',
          "scripts/__tests__/helper.mjs": source,
        },
      }).includes(
        "tooling test helper imports node:test registration APIs: scripts/__tests__/helper.mjs",
      ),
      source,
    );
  }
});

test("reachable node:test helpers reject computed non-literal runner loading", () => {
  const errors = findToolingTestHelperHazards({
    sources: {
      "scripts/__tests__/policy.test.mjs":
        'import "./dynamic-runner.mjs"; test("sentinel", () => {});',
      "scripts/__tests__/dynamic-runner.mjs": [
        'const moduleName = ["node", ":test"].join("");',
        "const runner = await import(moduleName);",
        'const register = runner[["te", "st"].join("")];',
        'register("hidden", function* () { throw new Error("must execute"); });',
      ].join("\n"),
    },
  });

  assert.ok(
    errors.includes(
      "tooling test helper uses non-literal dynamic import; dependency closure must remain statically auditable: scripts/__tests__/dynamic-runner.mjs",
    ),
    errors.join("\n"),
  );
});

test("dynamic helper registration can make Vitest, Playwright, and node:test falsely green", () => {
  for (const runner of ["vitest", "playwright", "node"]) {
    const result = runDynamicRunnerHelperMutation(runner);
    assert.equal(result.status, 0, `${runner}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, runner === "node" ? /hidden false green/ : /2 passed/, runner);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /must execute/, runner);
  }
});

test("standalone tooling catalog entries require reviewable lifecycle metadata", () => {
  assert.deepEqual(
    findOrphanToolingModules({
      sources: { "scripts/generator.mjs": "export {};" },
      entrypoints: new Set(),
      standalone: {
        "scripts/generator.mjs": { kind: "unknown", owner: "", retireWhen: "" },
      },
    }),
    [
      "standalone tooling module scripts/generator.mjs must declare an owner",
      "standalone tooling module scripts/generator.mjs must declare kind cli or generator",
      "standalone tooling module scripts/generator.mjs must declare retireWhen",
    ],
  );
});

test("JavaScript tests must register statically at top level or inside describe", () => {
  assert.deepEqual(
    findStaticTestRegistrationHazards(
      "src/good.test.ts",
      [
        'test("top", () => {});',
        'describe("group", () => {',
        '  it("nested", () => {});',
        "});",
      ].join("\n"),
    ),
    [],
  );

  for (const source of [
    'if (enabled) test("hidden", () => {});',
    'for (const row of rows) test("hidden", () => row);',
    'function register() { test("hidden", () => {}); } register();',
    'const register = () => test("hidden", () => {}); register();',
    'enabled && test("hidden", () => {});',
  ]) {
    const errors = findStaticTestRegistrationHazards("src/hidden.test.ts", source);
    assert.ok(errors.some((error) => error.includes("is not statically registered")));
    assert.ok(errors.some((error) => error.includes("does not statically register")));
  }
  assert.deepEqual(
    findStaticTestRegistrationHazards("src/empty.test.ts", "export const fixture = 1;"),
    ["src/empty.test.ts does not statically register any runnable test"],
  );
});
