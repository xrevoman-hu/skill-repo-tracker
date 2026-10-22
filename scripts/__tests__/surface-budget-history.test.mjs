import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkSurfaceBudgetHistory,
  validateSurfaceHistoryBudget,
} from "../surface-budget-history.mjs";
import {
  checkRepositorySurfaceBudget,
  compareSurfaceBudgets,
  discoverRepositorySurface,
} from "../surface-budget.mjs";
import { emptyCategories, writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

const BUDGET_PATH = "docs/engineering/surface-budget.json";
const SURFACE_ID = "fixture_setting";
const active = (id = SURFACE_ID) => ({ id, status: "active", purpose: "Synthetic history fixture" });
const retiring = (id = SURFACE_ID) => ({
  ...active(id),
  status: "retiring",
  retirementReason: "Replaced by a reviewed implementation",
});
const budget = (entries = [], category = "settingsFields") => ({
  schemaVersion: 1,
  categories: { ...emptyCategories(), [category]: entries },
});

// Plumbing creates real objects without running commit hooks or any fixture code.
// All refs, objects, corruption and shallow markers are confined to this new repo.
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "surface-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_AUTHOR_NAME: "Surface History Fixture",
    GIT_AUTHOR_EMAIL: "surface-history@example.invalid",
    GIT_COMMITTER_NAME: "Surface History Fixture",
    GIT_COMMITTER_EMAIL: "surface-history@example.invalid",
  };
  const git = (args, input) => execFileSync("git", args, {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
  git(["init", "--quiet", "--object-format=sha1", "--initial-branch=main"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "gc.auto", "0"]);
  const write = (relativePath, contents) => {
    const destination = join(root, relativePath);
    if (contents === undefined) {
      rmSync(destination, { force: true });
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
  };
  let head;
  let serial = 0;
  const commit = (value, { parents = head ? [head] : [], files = {} } = {}) => {
    write(BUDGET_PATH, value === undefined ? undefined
      : typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    for (const [path, contents] of Object.entries(files)) write(path, contents);
    git(["add", "--all"]);
    const tree = git(["write-tree"]);
    head = git([
      "commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]),
      "-m", `surface fixture ${++serial}`,
    ]);
    git(["update-ref", "refs/heads/main", head]);
    return head;
  };
  return { root, git, write, commit };
}

function assertFailure(errors, ...expectedParts) {
  assert.ok(errors.length > 0, "the invalid history must fail closed");
  for (const part of expectedParts) {
    assert.ok(errors.some(error => error.includes(part)), `${part}\n${errors.join("\n")}`);
  }
}

test("surface history accepts the complete new active, retiring, then deletion chain", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  repo.commit(budget([active()]));
  repo.commit(budget([retiring()]));
  const head = repo.commit(budget());
  assert.equal(repo.git(["rev-list", "--count", `${base}..${head}`]), "3");
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), []);
});

test("surface history rejects a new item whose first appearance is retiring", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  const invalid = repo.commit(budget([retiring()]));
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }),
    invalid, "new settingsFields surface must start active", SURFACE_ID);
});

test("surface history rejects direct removal of an active item", t => {
  const repo = repository(t);
  const base = repo.commit(budget([active()]));
  const invalid = repo.commit(budget());
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }),
    invalid, "removed without first being marked retiring", SURFACE_ID);
});

test("surface history checks illegal intermediate edges even when both endpoints agree", t => {
  const repo = repository(t);
  const original = budget([active()]);
  const base = repo.commit(original);
  const invalid = repo.commit(budget());
  repo.commit(original);
  assert.deepEqual(compareSurfaceBudgets(original, original), []);
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }),
    invalid, "removed without first being marked retiring", SURFACE_ID);
});

test("surface history preserves retirement, purpose and reason immutability on every edge", t => {
  const cases = [
    [active(), { ...active(), purpose: "Changed purpose" }, "purpose changed in place"],
    [retiring(), active(), "cannot return to active"],
    [retiring(), { ...retiring(), purpose: "Changed purpose" }, "purpose changed in place"],
    [retiring(), { ...retiring(), retirementReason: "Changed reason" }, "retirementReason changed in place"],
  ];
  for (const [before, after, message] of cases) {
    const repo = repository(t);
    const base = repo.commit(budget([before]));
    const invalid = repo.commit(budget([after]));
    repo.commit(budget([before]));
    assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), invalid, message);
  }
});

test("surface history validates the dirty working tree as the final edge", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  repo.commit(budget([active()]));
  repo.write(BUDGET_PATH, JSON.stringify(budget()));
  const errors = checkSurfaceBudgetHistory(repo.root, { baseRef: base });
  assertFailure(errors, "working tree", "removed without first being marked retiring");
  repo.write(BUDGET_PATH, JSON.stringify(budget([retiring()])));
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), []);
});

test("surface history validates an explicit current budget even with no committed edges", t => {
  const repo = repository(t);
  const base = repo.commit(budget([active()]));
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), []);
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base, currentBudget: budget() }),
    "working tree", "removed without first being marked retiring");
  const invalid = budget([{ ...active(), purpose: 42 }]);
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base, currentBudget: invalid }),
    "working tree", "invalid entry: settingsFields");
  assert.deepEqual(JSON.parse(readFileSync(join(repo.root, BUDGET_PATH), "utf8")), budget([active()]));
});

test("surface history rejects merge commits instead of choosing a parent", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  const left = repo.commit(budget());
  const right = repo.commit(budget(), { parents: [base] });
  repo.commit(budget(), { parents: [left, right] });
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), "complete single-parent chain");
});

test("surface history rejects a base outside the chosen head ancestry and invalid refs", t => {
  const repo = repository(t);
  const common = repo.commit(budget());
  const left = repo.commit(budget());
  const right = repo.commit(budget(), { parents: [common] });
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: left, headRef: right }), "merge-base");
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: "refs/heads/does-not-exist" }), "rev-parse");
  for (const baseRef of [undefined, "", "bad\0ref", 42]) {
    assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef }), "valid commit reference");
  }
});

test("surface history rejects an actual shallow repository even when the boundary commit exists", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  repo.commit(budget());
  repo.write(".git/shallow", `${base}\n`);
  assert.equal(repo.git(["rev-parse", "--is-shallow-repository"]), "true");
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), "non-shallow Git history");
});

test("surface history rejects a missing intermediate budget blob instead of skipping that edge", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  const invalid = repo.commit(budget([active()]));
  repo.commit(budget([retiring()]));
  const blob = repo.git(["rev-parse", `${invalid}:${BUDGET_PATH}`]);
  const objectPath = join(repo.root, ".git/objects", blob.slice(0, 2), blob.slice(2));
  assert.ok(existsSync(objectPath), "fixture must have a real loose object to remove");
  rmSync(objectPath);
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }),
    `missing or invalid JSON at ${invalid}`);
});

test("surface history rejects missing or malformed historical JSON despite a valid tip", t => {
  for (const value of [undefined, "{broken JSON"]) {
    const repo = repository(t);
    const base = repo.commit(budget());
    const invalid = repo.commit(value);
    repo.commit(budget());
    assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }),
      `missing or invalid JSON at ${invalid}`);
  }
});

test("surface history rejects duplicate IDs and malformed historical entry fields", t => {
  const cases = [
    [budget([active(), active()]), "duplicate settingsFields"],
    [budget([{ ...active(), id: 7 }]), "invalid entry: settingsFields"],
    [budget([{ ...active(), id: " padded " }]), "invalid entry: settingsFields"],
    [budget([{ ...active(), id: "" }]), "invalid entry: settingsFields"],
    [budget([{ ...active(), status: "retired" }]), "invalid entry: settingsFields"],
    [budget([{ ...active(), purpose: {} }]), "invalid entry: settingsFields"],
    [budget([{ ...active(), purpose: " " }]), "invalid entry: settingsFields"],
    [budget([{ ...active(), retirementReason: 1 }]), "invalid entry: settingsFields"],
    [budget([{ ...retiring(), retirementReason: "" }]), "invalid entry: settingsFields"],
    [budget([{ ...active(), unknown: true }]), "invalid entry: settingsFields"],
    [budget([null]), "invalid entry: settingsFields"],
    [budget([[]]), "invalid entry: settingsFields"],
  ];
  for (const [invalidBudget, expected] of cases) {
    const repo = repository(t);
    const base = repo.commit(budget());
    const invalid = repo.commit(invalidBudget);
    repo.commit(budget());
    assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), invalid, expected);
  }
});

test("surface history validates the base JSON schema and complete category structure", t => {
  const missingCategory = budget();
  delete missingCategory.categories.timerCalls;
  const cases = [
    [null, "schemaVersion must be 1"],
    [[], "schemaVersion must be 1"],
    [{ ...budget(), schemaVersion: "1" }, "schemaVersion must be 1"],
    [{ ...budget(), categories: [] }, "categories must be an object"],
    [missingCategory, "category must be an array: timerCalls"],
    [{ ...budget(), categories: { ...emptyCategories(), settingsFields: {} } }, "category must be an array"],
    [{ ...budget(), categories: { ...emptyCategories(), extra: [] } }, "unknown category: extra"],
  ];
  for (const [invalidBudget, expected] of cases) {
    const repo = repository(t);
    const base = repo.commit(invalidBudget);
    repo.commit(budget());
    assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), base, expected);
  }
  assert.deepEqual(validateSurfaceHistoryBudget(budget()), []);
});

test("surface history rejects missing and malformed working tree JSON without changing HEAD", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  repo.write(BUDGET_PATH, "{broken JSON");
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }));
  repo.write(BUDGET_PATH, undefined);
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }));
  assert.equal(repo.git(["rev-parse", "HEAD"]), base);
});

test("surface history reads fixed JSON without checking out or executing historical scripts", t => {
  const repo = repository(t);
  const marker = join(repo.root, "history-executions.log");
  const trap = `import { appendFileSync } from "node:fs";\n`
    + `appendFileSync(${JSON.stringify(marker)}, "executed\\n");\nthrow new Error("historical script executed");\n`;
  const files = {
    "scripts/surface-budget.mjs": trap,
    "scripts/surface-budget-history.mjs": trap,
    "scripts/governance-assets-check.mjs": trap,
    "package.json": JSON.stringify({ scripts: { verify: "node scripts/governance-assets-check.mjs" } }),
    "unrelated.json": "{not a surface budget",
  };
  const base = repo.commit(budget(), { files });
  repo.commit(budget([active()]));
  const head = repo.commit(budget([retiring()]), {
    files: Object.fromEntries(Object.keys(files).map(path => [path, undefined])),
  });
  repo.write("keep-local.txt", "dirty worktree remains intact\n");
  const statusBefore = repo.git(["status", "--porcelain=v1", "-z"]);
  const indexBefore = readFileSync(join(repo.root, ".git/index"));
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), []);
  assert.equal(existsSync(marker), false, "historical script execution spy must remain zero");
  assert.deepEqual(readFileSync(join(repo.root, ".git/index")), indexBefore);
  assert.equal(repo.git(["rev-parse", "HEAD"]), head);
  assert.equal(repo.git(["status", "--porcelain=v1", "-z"]), statusBefore);
  assert.equal(readFileSync(join(repo.root, "keep-local.txt"), "utf8"), "dirty worktree remains intact\n");
});

test("valid registration history does not replace current source discovery", t => {
  const repo = repository(t);
  writeMinimalSurfaceRepository(repo.root);
  const registered = {
    schemaVersion: 1,
    categories: Object.fromEntries(Object.entries(discoverRepositorySurface(repo.root))
      .map(([category, ids]) => [category, ids.map(id => active(id))])),
  };
  const base = repo.commit(registered);
  assert.deepEqual(checkRepositorySurfaceBudget(repo.root), []);
  repo.write("src/App.tsx", "export const delayed = () => setTimeout(() => {}, 1);\n");
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), []);
  assertFailure(checkRepositorySurfaceBudget(repo.root), "unregistered timerCalls surface: src/App.tsx:setTimeout#1");
});

test("surface history accepts the nine exact credential entities through their original lifecycle order", t => {
  const repo = repository(t);
  // Public identifiers, with the original relative transition order; no local commit SHA is a fixture.
  const dependency = 'dev:rusqlite={"defaultFeatures":true,"features":["backup","bundled-sqlcipher-vendored-openssl"],"optional":false,"package":"rusqlite","source":{"kind":"registry","registry":"crates-io"},"target":null}';
  const leases = [
    "src-tauri/src/credential_leases.rs:Path::exists:open#1",
    "src-tauri/src/credential_leases.rs:Path::exists:open#2",
    "src-tauri/src/credential_leases.rs:std::fs::DirBuilder::create:open#1",
    "src-tauri/src/credential_leases.rs:fs::symlink_metadata:remove_pending#1",
    "src-tauri/src/credential_leases.rs:Path::is_file:remove_pending#1",
  ];
  const runtime = "src-tauri/src/credential_runtime.rs:Path::exists:open#1";
  const backup = [
    "src-tauri/src/credential_backup.rs:fs::rename:commit#1",
    "src-tauri/src/credential_backup.rs:Path::exists:commit#1",
  ];
  const original = budget();
  const base = repo.commit(original);
  const state = budget([active(dependency)], "rustDependencies");
  repo.commit(state);
  state.categories.rustDependencies = [retiring(dependency)];
  state.categories.rustPathSites = [...leases.map(id => active(id)), active(runtime)];
  repo.commit(state);
  state.categories.rustPathSites = [...leases.map(id => active(id)), retiring(runtime)];
  repo.commit(state);
  state.categories.rustPathSites = [...leases.map(id => retiring(id)), retiring(runtime), ...backup.map(id => active(id))];
  repo.commit(state);
  state.categories.rustPathSites = [...leases, runtime, ...backup].map(id => retiring(id));
  repo.commit(state);
  const endpointErrors = compareSurfaceBudgets(state, original);
  assert.equal(endpointErrors.length, 9, "endpoint comparison loses all nine earlier active registrations");
  for (const id of [dependency, ...leases, runtime, ...backup]) {
    assertFailure(endpointErrors, `surface must start active: ${id}`);
  }
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), []);
  repo.commit(budget());
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), []);
});

test("surface history accepts exactly 1000 committed edges and rejects 1001 without truncating", t => {
  const repo = repository(t);
  const base = repo.commit(budget());
  // One fast-import creates real commits sharing one tree, without 1001 worktree copies or hooks.
  let stream = "";
  for (let index = 1; index <= 1001; index++) {
    const message = `surface boundary ${index}\n`;
    stream += `commit refs/heads/main\nmark :${index}\n`
      + `committer Surface History Fixture <surface-history@example.invalid> ${1700000000 + index} +0000\n`
      + `data ${Buffer.byteLength(message)}\n${message}`
      + `from ${index === 1 ? base : `:${index - 1}`}\n\n`;
  }
  repo.git(["fast-import", "--quiet", "--done"], `${stream}done\n`);
  const head1000 = repo.git(["rev-parse", "HEAD^"]);
  assert.equal(repo.git(["rev-list", "--count", `${base}..HEAD`]), "1001");
  assert.deepEqual(checkSurfaceBudgetHistory(repo.root, { baseRef: base, headRef: head1000 }), []);
  assertFailure(checkSurfaceBudgetHistory(repo.root, { baseRef: base }), "exceeds 1000 commits");
});
