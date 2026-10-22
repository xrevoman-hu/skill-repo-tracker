import assert from "node:assert/strict";
import test from "node:test";
import { createMainEvidence, resolveBaseline, requireSuccessfulMainHead, mainBaselineEnvironment,
  resolveLocalMainBaseline } from "../main-push-evidence.mjs";
import { createGitHubReader, parseGitHubResponse } from "../main-push-github.mjs";
import { ADR_BYTES, REPOSITORY, WORKFLOW, sha, runFixture, jobsFixture, gitFixture, catalogFixture } from "./main-push-fixtures.mjs";

function requestFixture({ runs = [runFixture()], detail, jobs, onList, remoteHead = sha("c") } = {}) {
  let listings = 0;
  return (endpoint) => {
    let body;
    if (endpoint === `repos/${REPOSITORY}`) body = { id: 91, full_name: REPOSITORY };
    else if (endpoint.endsWith("/actions/workflows/ci.yml")) body = WORKFLOW;
    else if (endpoint.includes("/actions/workflows/ci.yml/runs?")) {
      const head = new URL(`https://api.github.com/${endpoint}`).searchParams.get("head_sha");
      const selected = onList?.(++listings, head) ?? runs.filter((run) => run.head_sha === head);
      body = { total_count: selected.length, workflow_runs: selected };
    } else if (/\/attempts\/\d+\/jobs\?/.test(endpoint)) {
      const id = Number(/\/runs\/(\d+)/.exec(endpoint)[1]);
      const run = detail ?? runs.find((entry) => entry.id === id);
      const selected = jobs ?? jobsFixture(run);
      body = { total_count: selected.length, jobs: selected };
    } else if (/\/actions\/runs\/\d+$/.test(endpoint)) {
      body = detail ?? runs.find((run) => endpoint.endsWith(`/runs/${run.id}`));
    } else if (endpoint.endsWith("/git/ref/heads/main")) {
      body = { ref: "refs/heads/main", object: { type: "commit", sha: remoteHead } };
    } else throw new Error("unexpected fixture endpoint");
    return { status: 200, headers: {}, body };
  };
}
const evidence = (options) => createMainEvidence({ repository: REPOSITORY,
  reader: createGitHubReader({ request: requestFixture(options) }) });
const event = (before = sha("c")) => ({ repository: { full_name: REPOSITORY }, ref: "refs/heads/main", after: sha("d"), before });
const baseline = (overrides = {}) => resolveBaseline({ event: event(), head: sha("d"), repository: REPOSITORY,
  git: gitFixture(), evidence: { inspect: () => ({ successful: false }) }, ...overrides });

test("failed cancelled or absent pushes remain in the cumulative baseline after a documentation repair", () => {
  for (const reason of ["failure", "cancelled", "no_run", "queued"]) {
    const seen = [];
    const result = baseline({ evidence: { inspect: (head) => { seen.push(head); return { successful: false, reason }; } } });
    assert.equal(result.validatedBase, sha("a"));
    assert.deepEqual(seen, [sha("c"), sha("b")]);
  }
});

test("only the closest fully successful policy ancestor advances the validated base", () => {
  const result = baseline({ evidence: { inspect: (head) => ({ successful: head === sha("b"), runId: 31, attempt: 2 }) } });
  assert.equal(result.validatedBase, sha("b"));
  assert.equal(result.runId, 31);
  // A run becoming successful after selection cannot mutate the already selected result.
  assert.equal(result.validatedBase, sha("b"));
});

test("a newer failed run or rerun attempt hides every older successful result", () => {
  const old = runFixture();
  const newer = runFixture(2, old.head_sha, { created_at: "2026-10-02T00:00:00Z", conclusion: "failure" });
  assert.equal(evidence({ runs: [old, newer] }).inspect(old.head_sha).successful, false);
  assert.equal(evidence({ runs: [old], detail: { ...old, run_attempt: 2, conclusion: "cancelled" } }).inspect(old.head_sha).successful, false);
  const pending = { ...newer, status: "in_progress", conclusion: null };
  assert.equal(evidence({ runs: [old, pending] }).inspect(old.head_sha).successful, false);
});

test("run identity and successful four jobs must come from the exact repository workflow SHA and attempt", () => {
  const run = runFixture();
  assert.equal(evidence({ runs: [run] }).inspect(run.head_sha).successful, true);
  for (const patch of [{ event: "pull_request" }, { head_branch: "other" }, { path: ".github/workflows/spoof.yml" },
    { workflow_id: 18 }, { head_repository: { full_name: "fork/project" } }, { run_attempt: 0 }, { status: "unknown" }]) {
    assert.throws(() => evidence({ runs: [{ ...run, ...patch }] }).inspect(run.head_sha), /identity|state/);
  }
  assert.throws(() => evidence({ runs: [run], jobs: jobsFixture(run).map((job) => ({ ...job, run_attempt: 2 })) }).inspect(run.head_sha), /job identity/);
});

test("missing duplicated skipped or neutral jobs cannot qualify a main SHA", () => {
  const run = runFixture();
  const jobs = jobsFixture(run);
  for (const selected of [jobs.slice(1), [...jobs.slice(1), { ...jobs[1], id: 9 }],
    jobs.map((job) => job.name === "coverage" ? { ...job, conclusion: "skipped" } : job),
    jobs.map((job) => job.name === "verify" ? { ...job, conclusion: "neutral" } : job)]) {
    assert.equal(evidence({ runs: [run], jobs: selected }).inspect(run.head_sha).successful, false);
  }
});

test("a newer run appearing while jobs are read fails closed instead of retaining old green evidence", () => {
  const run = runFixture();
  const newer = runFixture(2, run.head_sha, { created_at: "2026-10-02T00:00:00Z", conclusion: "failure" });
  assert.throws(() => evidence({ runs: [run], onList: (count) => count === 1 ? [run] : [run, newer] }).inspect(run.head_sha), /changed during inspection/);
});

test("zero before wrong event identity merges and broken ancestry cannot select a fallback", () => {
  for (const invalid of [{ ...event(), before: "0".repeat(40) }, { ...event(), after: sha("b") },
    { ...event(), ref: "refs/heads/other" }, { ...event(), repository: { full_name: "other/project" } },
    { ...event(), created: true }, { ...event(), before: sha("e") }]) assert.throws(() => baseline({ event: invalid }));
  const merge = gitFixture(); merge.parentMap.set(sha("c"), [sha("b"), sha("e")]);
  assert.throws(() => baseline({ git: merge }), /single-parent/);
  const missing = gitFixture(); missing.parentMap.delete(sha("c"));
  assert.throws(() => baseline({ git: missing }), /ancestor|missing commit/);
  assert.throws(() => baseline({ maxCandidates: 1 }), /budget/);
});

test("bootstrap plans and accepted decision bytes cannot be silently changed", () => {
  const withPlan = gitFixture(); withPlan.catalogs.set(sha("a"), catalogFixture());
  assert.throws(() => baseline({ git: withPlan }), /bootstrap/);
  const changed = gitFixture(); changed.catalogs.set(sha("c"), catalogFixture("retiring", sha("e")));
  assert.throws(() => baseline({ git: changed, evidence: { inspect: () => ({ successful: true }) } }), /plan changed/);
  const bytes = gitFixture(); bytes.text = () => `${ADR_BYTES}tampered\n`;
  assert.throws(() => baseline({ git: bytes }), /decision bytes/);
  const missing = gitFixture(); missing.catalogs.delete(sha("a"));
  assert.throws(() => baseline({ git: missing }), /missing catalog/);
});

test("release rejects retiring policy and never uses its own successful HEAD as baseline", () => {
  assert.throws(() => requireSuccessfulMainHead({ repository: REPOSITORY, git: gitFixture() }), /final retired/);
  const git = gitFixture({ phase: "retired" });
  const runs = [runFixture(1, sha("d")), runFixture(2, sha("c"))];
  const result = requireSuccessfulMainHead({ repository: REPOSITORY, git,
    reader: createGitHubReader({ request: requestFixture({ runs, remoteHead: sha("d") }) }) });
  assert.equal(result.head, sha("d")); assert.equal(result.validatedBase, sha("c"));
  assert.equal(result.headRunId, 1);
  assert.throws(() => requireSuccessfulMainHead({ repository: REPOSITORY, git,
    reader: createGitHubReader({ request: requestFixture({ remoteHead: sha("d"), runs: [runFixture(1, sha("d"), { conclusion: "failure" })] }) }) }), /not successful/);
  assert.throws(() => requireSuccessfulMainHead({ repository: REPOSITORY, git,
    reader: createGitHubReader({ request: requestFixture({ runs, remoteHead: sha("e") }) }) }), /official main/);
});

test("release rejects a HEAD rerun that starts while its successful ancestor is inspected", () => {
  for (const rerun of [
    { status: "completed", conclusion: "failure", reason: "failure" },
    { status: "in_progress", conclusion: null, reason: "in_progress" },
  ]) {
    const head = sha("d"), ancestor = sha("c");
    const headRun = runFixture(1, head);
    const runs = [headRun, runFixture(2, ancestor)];
    let ancestorInspected = false;
    const request = requestFixture({ runs, remoteHead: head, onList: (_count, queriedSha) => {
      if (queriedSha === ancestor && !ancestorInspected) {
        ancestorInspected = true;
        Object.assign(headRun, { run_attempt: 2, status: rerun.status, conclusion: rerun.conclusion });
      }
    } });
    // Inspecting HEAD before this ancestor would retain attempt 1's old green result.
    assert.throws(() => requireSuccessfulMainHead({ repository: REPOSITORY,
      git: gitFixture({ phase: "retired" }), reader: createGitHubReader({ request }) }),
    error => error.message === `final main CI is not successful: ${rerun.reason}`);
    assert.equal(ancestorInspected, true, "the rerun must be triggered during ancestor inspection");
  }
});

test("local pre-push lookup supplies the same proven SHA to all three verification consumers", () => {
  const result = resolveLocalMainBaseline({ repository: REPOSITORY, git: gitFixture(),
    reader: createGitHubReader({ request: requestFixture({ runs: [] }) }) });
  assert.equal(result.before, sha("c"));
  assert.deepEqual(mainBaselineEnvironment(result), { VERIFY_BASE_REF: sha("a"), ARCHITECTURE_BASE_REF: sha("a"), COVERAGE_BASE_REF: sha("a") });
  assert.throws(() => mainBaselineEnvironment({ validatedBase: "0".repeat(40) }));
});

test("API status JSON and pagination failures never become an absent-run fallback", () => {
  for (const status of [403, 429, 500]) {
    assert.throws(() => createMainEvidence({ repository: REPOSITORY,
      reader: createGitHubReader({ request: () => ({ status, headers: {}, body: {} }) }) }), /failed with status/);
  }
  assert.throws(() => parseGitHubResponse("HTTP/2.0 200 OK\nContent-Type: application/json\n\n{broken"));
  assert.throws(() => parseGitHubResponse("{\"body\":{}}"), /headers/);
  assert.equal(parseGitHubResponse("HTTP/2.0 204 No Content\r\nContent-Type: application/json\r\n\r\n").status, 204);
  const endpoint = "repos/example/project/actions/workflows/ci.yml/runs";
  for (const response of [
    { status: 200, headers: {}, body: { total_count: 1, workflow_runs: [] } },
    { status: 200, headers: {}, body: { total_count: 2, workflow_runs: [{ id: 1 }, { id: 1 }] } },
    { status: 200, headers: { link: '<https://attacker.invalid/?page=2>; rel="next"' }, body: { total_count: 0, workflow_runs: [] } },
    { status: 200, headers: {}, body: { workflow_runs: [] } },
  ]) assert.throws(() => createGitHubReader({ request: () => response }).collection(endpoint, "workflow_runs"));
});

test("API and pagination budgets stop rather than skip unverified candidates", () => {
  const reader = createGitHubReader({ maxRequests: 2, request: () => ({ status: 200, headers: {}, body: {} }) });
  reader.get("repos/example/project/one"); reader.get("repos/example/project/two");
  assert.throws(() => reader.get("repos/example/project/three"), /request budget/);
  const endpoint = "repos/example/project/actions/workflows";
  const request = () => ({ status: 200,
    headers: { link: `<https://api.github.com/${endpoint}?per_page=100&page=2>; rel="next"` },
    body: { total_count: 101, workflows: Array.from({ length: 100 }, (_, id) => ({ id })) } });
  assert.throws(() => createGitHubReader({ request }).collection(endpoint, "workflows", { maxPages: 1 }), /page budget/);
});

test("canonical pagination only accepts the previously verified repository ID and unchanged filters", () => {
  const endpoint = "repos/example/project/actions/workflows/ci.yml/runs?head_sha=abc&event=push";
  const target = "https://api.github.com/repositories/91/actions/workflows/ci.yml/runs?head_sha=abc&event=push&per_page=100&page=2";
  const readerFor = (link) => createGitHubReader({ request: (url) => url.endsWith("page=1")
    ? { status: 200, headers: { link: `<${link}>; rel="next"` },
      body: { total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, id) => ({ id })) } }
    : { status: 200, headers: {}, body: { total_count: 101, workflow_runs: [{ id: 100 }] } } });
  const reader = readerFor(target); reader.bindRepository("example/project", 91);
  assert.equal(reader.collection(endpoint, "workflow_runs").length, 101);
  assert.throws(() => readerFor(target).collection(endpoint, "workflow_runs"), /escaped/);
  for (const link of [target.replace("/91/", "/92/"), target.replace("head_sha=abc", "head_sha=other"),
    target.replace("ci.yml", "another.yml"), target.replace("api.github.com", "attacker.invalid")]) {
    const invalid = readerFor(link); invalid.bindRepository("example/project", 91);
    assert.throws(() => invalid.collection(endpoint, "workflow_runs"), /escaped/);
  }
  assert.throws(() => reader.bindRepository("example/project", 92), /changed/);
});

test("fork repository overrides cannot substitute a same-SHA green run", () => {
  assert.throws(() => requireSuccessfulMainHead({ repository: "fork/project", git: gitFixture({ phase: "retired" }) }), /override/);
  const calls = [], request = requestFixture({ runs: [], remoteHead: sha("d") });
  const reader = createGitHubReader({ request: (endpoint) => { calls.push(endpoint); return request(endpoint); } });
  assert.throws(() => requireSuccessfulMainHead({ git: gitFixture({ phase: "retired" }), reader }), /not successful/);
  assert.ok(calls.length > 0 && calls.every((endpoint) => endpoint.startsWith(`repos/${REPOSITORY}/`) || endpoint === `repos/${REPOSITORY}`));
});
