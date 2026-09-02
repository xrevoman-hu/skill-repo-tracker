import assert from "node:assert/strict";
import test from "node:test";

import {
  parseContextArguments,
  parseGitNameStatusZ,
  selectRepositoryContext,
} from "../governance-context.mjs";

test("NUL-delimited Git rename and copy records select both old and new paths", () => {
  assert.deepEqual(
    parseGitNameStatusZ(
      "M\0src/modified.ts\0R087\0docs/rules/old.md\0docs/rules/new.md\0C100\0src/a.ts\0src/b.ts\0",
    ),
    [
      "src/modified.ts",
      "docs/rules/old.md",
      "docs/rules/new.md",
      "src/a.ts",
      "src/b.ts",
    ],
  );
  assert.throws(
    () => parseGitNameStatusZ("R100\0docs/rules/old.md\0"),
    /incomplete Git name-status record: R100/,
  );
});

test("positional paths and both base-ref forms remain supported", () => {
  assert.deepEqual(parseContextArguments(["src/App.tsx", "docs/rules/tasks.md"]), {
    baseRef: undefined,
    paths: ["src/App.tsx", "docs/rules/tasks.md"],
  });
  assert.deepEqual(
    parseContextArguments(["--base-ref", "origin/main", "src/App.tsx"]),
    {
      baseRef: "origin/main",
      paths: ["src/App.tsx"],
    },
  );
  assert.deepEqual(
    parseContextArguments(["docs/rules/tasks.md", "--base-ref=HEAD~1"]),
    {
      baseRef: "HEAD~1",
      paths: ["docs/rules/tasks.md"],
    },
  );
});

test("base-ref fails closed when its value is absent or another option", () => {
  assert.throws(
    () => parseContextArguments(["--base-ref"]),
    /--base-ref requires a Git ref/,
  );
  assert.throws(
    () => parseContextArguments(["--base-ref", "--unknown"]),
    /--base-ref requires a Git ref/,
  );
  assert.throws(
    () => parseContextArguments(["--base-ref="]),
    /--base-ref requires a Git ref/,
  );
});

test("unknown options cannot be treated as changed paths", () => {
  assert.throws(
    () => parseContextArguments(["--unknown", "src/App.tsx"]),
    /unknown option: --unknown/,
  );
  assert.throws(() => parseContextArguments(["-x"]), /unknown option: -x/);
});

test("module ownership adds its Rule and ADR to the selected governance context", () => {
  const catalog = {
    assets: [
      { id: "global", path: "CONTEXT.md", status: "active", alwaysLoad: true },
      { id: "rule-prompts", path: "docs/rules/prompts.md", status: "active", kind: "rule" },
      { id: "adr-prompts", path: "docs/adr/prompts.md", status: "active", kind: "decision" },
    ],
    invariants: [],
  };
  const moduleMap = {
    modules: [
      {
        id: "frontend-prompts",
        ownerRule: "docs/rules/prompts.md",
        decisions: ["docs/adr/prompts.md"],
        paths: ["src/PromptsView.tsx"],
      },
    ],
  };

  assert.deepEqual(
    selectRepositoryContext(catalog, moduleMap, ["src/PromptsView.tsx"]),
    {
      assets: ["adr-prompts", "global", "rule-prompts"],
      invariants: [],
      modules: ["frontend-prompts"],
    },
  );
});
