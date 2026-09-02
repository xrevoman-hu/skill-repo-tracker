import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findUnsafeGitPathInventory,
  listRepositoryFiles,
  listTrackedIndexEntries,
  parseNulDelimitedGitPaths,
} from "../git-paths.mjs";
import { findDangerousRepositoryPathErrors } from "../repository-boundaries.mjs";

test("NUL-delimited Git paths preserve Chinese, newline, and tab bytes exactly", () => {
  assert.deepEqual(
    parseNulDelimitedGitPaths(
      Buffer.from("src/中文模块.ts\0src/line\nbreak.ts\0src/tab\tname.ts\0"),
    ),
    ["src/中文模块.ts", "src/line\nbreak.ts", "src/tab\tname.ts"],
  );
  assert.throws(
    () => parseNulDelimitedGitPaths(Buffer.from("src/not-terminated.ts")),
    /must end with NUL/,
  );
  assert.throws(
    () => parseNulDelimitedGitPaths(Buffer.from([0x73, 0x72, 0x63, 0x2f, 0xff, 0x00])),
    /valid UTF-8/,
  );
});

test("real Git inventories preserve non-ASCII paths and boundaries reject dangerous names", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "git-path-inventory-"));
  const paths = [
    "src/中文模块.ts",
    "src/line\nbreak.ts",
    "src/tab\tname.ts",
    "src/back\\slash.ts",
  ];
  try {
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(join(root, "src"), { recursive: true });
    for (const pathname of paths) writeFileSync(join(root, pathname), "export {};\n");
    execFileSync("git", ["add", "--all"], { cwd: root });

    assert.deepEqual(new Set(listRepositoryFiles(root)), new Set(paths));
    assert.deepEqual(
      new Set(listTrackedIndexEntries(root).map((entry) => entry.path)),
      new Set(paths),
    );
    assert.deepEqual(findDangerousRepositoryPathErrors(["src/中文模块.ts"]), []);

    const errors = findDangerousRepositoryPathErrors(paths);
    for (const pathname of paths.slice(1)) {
      assert.ok(
        errors.some((error) => error.includes(JSON.stringify(pathname))),
        `${JSON.stringify(pathname)}\n${errors.join("\n")}`,
      );
    }
    assert.ok(
      findDangerousRepositoryPathErrors(["src/del\u007f.ts", "src/c0\u0001.ts"])
        .every((error) => error.includes("dangerous filename characters")),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governance tools cannot regress to newline-delimited Git path inventories", () => {
  for (const pathname of [
    "../module-map.mjs",
    "../governance.mjs",
    "../architecture-budget-checks.mjs",
    "../governance-assets-check.mjs",
    "../check-coverage.mjs",
    "../governance-context.mjs",
    "../git-paths-core.mjs",
  ]) {
    const source = readFileSync(new URL(pathname, import.meta.url), "utf8");
    assert.deepEqual(findUnsafeGitPathInventory(pathname, source), [], pathname);
  }

  for (const source of [
    'execFileSync("git", ["ls-files", "--cached"]);',
    'execFileSync("git", ["ls-tree", "--name-only", "HEAD"]);',
    'execFileSync("git", ["diff", "--name-status", "HEAD"]);',
  ]) {
    assert.ok(
      findUnsafeGitPathInventory("scripts/mutation.mjs", source).some((error) =>
        error.includes("must use -z"),
      ),
      source,
    );
  }
});
