import assert from "node:assert/strict";
import test from "node:test";

import { buildDiffCheckArguments } from "../check-diff.mjs";

test("diff checks always include working tree and staged changes without a base", () => {
  assert.deepEqual(buildDiffCheckArguments(undefined), [
    ["diff", "--check"],
    ["diff", "--cached", "--check"],
  ]);
});

test("diff checks retain working tree and staged checks when a committed base exists", () => {
  assert.deepEqual(buildDiffCheckArguments("origin/main"), [
    ["diff", "--check", "origin/main...HEAD"],
    ["diff", "--check"],
    ["diff", "--cached", "--check"],
  ]);
});
