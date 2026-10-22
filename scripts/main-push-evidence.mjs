#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createGitHubReader, EXPECTED_REPOSITORY } from "./main-push-github.mjs";
import { getMainOnlyPlan, policyRemovalPhase } from "./governance-policy-removal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = "docs/engineering/governance-assets.json";
const WORKFLOW = ".github/workflows/ci.yml";
const JOBS = ["baseline", "verify", "coverage", "msrv"];
const SHA = /^[a-f0-9]{40}$/;

function requireSha(value) {
  if (!SHA.test(value ?? "") || /^0+$/.test(value)) throw new Error("expected a nonzero full commit SHA");
  return value;
}

export function createMainGit(root = ROOT) {
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  }).trim();
  return {
    head: () => requireSha(git("rev-parse", "HEAD")),
    isAncestor: (base, head) => {
      try { git("merge-base", "--is-ancestor", requireSha(base), requireSha(head)); return true; }
      catch (error) { if (error.status === 1) return false; throw error; }
    },
    parents: (sha) => {
      requireSha(sha);
      const values = git("rev-list", "--parents", "-n", "1", sha).split(" ");
      if (values.shift() !== sha || values.some((value) => !SHA.test(value))) throw new Error("commit history is invalid");
      return values;
    },
    catalog: (sha) => JSON.parse(git("show", `${requireSha(sha)}:${CATALOG}`)),
    text: (sha, path) => execFileSync("git", ["show", `${requireSha(sha)}:${path}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

function repositoryName(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? "")) throw new Error("invalid repository identity");
  return value;
}

function validateRun(run, repository, sha, workflow) {
  if (!run || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || run.head_sha !== sha || run.head_branch !== "main" || run.event !== "push"
      || run.path !== WORKFLOW || run.workflow_id !== workflow.id
      || !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt)
      || run.run_attempt < 1 || !Number.isFinite(Date.parse(run.created_at))) {
    throw new Error("main CI run identity is invalid");
  }
  if (!["completed", "queued", "in_progress", "requested", "waiting", "pending"].includes(run.status)
      || (run.status === "completed" && !["success", "failure", "cancelled", "skipped", "neutral",
        "timed_out", "action_required", "stale", "startup_failure"].includes(run.conclusion))
      || (run.status !== "completed" && run.conclusion !== null)) throw new Error("main CI run state is unknown");
  return run;
}

export function createMainEvidence({ repository, reader = createGitHubReader() }) {
  repositoryName(repository);
  const prefix = `repos/${repository}`;
  const repositoryInfo = reader.get(prefix);
  if (repositoryInfo?.full_name !== repository || !Number.isSafeInteger(repositoryInfo.id)
      || repositoryInfo.id < 1) throw new Error("GitHub repository identity is invalid");
  reader.bindRepository(repository, repositoryInfo.id);
  const workflow = reader.get(`${prefix}/actions/workflows/ci.yml`);
  if (workflow?.path !== WORKFLOW || workflow.name !== "CI" || workflow.state !== "active"
      || !Number.isSafeInteger(workflow.id) || workflow.id < 1) throw new Error("CI workflow identity is invalid");
  const latest = (sha) => {
    requireSha(sha);
    const runs = reader.collection(`${prefix}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}`, "workflow_runs");
    for (const run of runs) validateRun(run, repository, sha, workflow);
    return runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
  };
  const inspect = (sha) => {
    const listed = latest(sha);
    if (!listed) return { successful: false, reason: "no_run" };
    const run = validateRun(reader.get(`${prefix}/actions/runs/${listed.id}`), repository, sha, workflow);
    if (run.id !== listed.id || run.created_at !== listed.created_at || run.run_attempt < listed.run_attempt) {
      throw new Error("latest CI run changed identity or regressed attempt");
    }
    if (run.status !== "completed" || run.conclusion !== "success") {
      return { successful: false, reason: run.conclusion ?? run.status, runId: run.id, attempt: run.run_attempt };
    }
    const jobs = reader.collection(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs");
    for (const job of jobs) {
      if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== sha
          || !JOBS.includes(job.name)) throw new Error("CI job identity or name is invalid");
    }
    const successful = jobs.length === JOBS.length && JOBS.every((name) => {
      const selected = jobs.filter((job) => job.name === name);
      return selected.length === 1 && selected[0].status === "completed" && selected[0].conclusion === "success";
    });
    // A rerun or a newly created run must not be hidden by an older green result.
    const confirmed = latest(sha);
    const detail = validateRun(reader.get(`${prefix}/actions/runs/${run.id}`), repository, sha, workflow);
    if (!confirmed || confirmed.id !== run.id || confirmed.run_attempt !== run.run_attempt
        || detail.id !== run.id || detail.run_attempt !== run.run_attempt
        || detail.status !== "completed" || detail.conclusion !== "success") {
      throw new Error("latest CI evidence changed during inspection");
    }
    return { successful, reason: successful ? "success" : "jobs_incomplete", runId: run.id, attempt: run.run_attempt };
  };
  return { inspect, repository };
}

function checkedPlan(git, sha, expectedPlan) {
  const catalog = git.catalog(sha);
  const plan = getMainOnlyPlan(catalog);
  if (expectedPlan && !isDeepStrictEqual(plan, expectedPlan)) throw new Error("main-only policy plan changed in history");
  const decision = catalog.assets.find((asset) => asset.id === plan.decision);
  // The catalog validator checks phase/shape; read actual Git bytes at this boundary too.
  if (!decision || decision.status !== "active" || decision.kind !== "decision"
      || !/^docs\/adr\/\d{4}-[a-z0-9-]+\.md$/.test(decision.path ?? "")) throw new Error("main-only decision is missing");
  const bytes = git.text(sha, decision.path);
  if (!/^- 状态：Accepted\s*$/m.test(bytes)
      || decision.checksum !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`) {
    throw new Error("main-only accepted decision bytes do not match catalog");
  }
  return { plan, phase: policyRemovalPhase(catalog) };
}

export function resolveBaseline({ event, head, repository, git, evidence, maxCandidates = 1000 }) {
  requireSha(head); repositoryName(repository);
  if (event?.repository?.full_name !== repository || event.ref !== "refs/heads/main"
      || event.after !== head || event.deleted || event.created) throw new Error("expected an existing main push for exact HEAD");
  const before = requireSha(event.before);
  if (head === before || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 1000) {
    throw new Error("main push range or candidate budget is invalid");
  }
  const { plan } = checkedPlan(git, head);
  const bootstrap = requireSha(plan.bootstrapHead);
  const old = git.catalog(bootstrap);
  if (old.schemaVersion !== 1 || (old.policyRemovals?.length ?? 0) !== 0) throw new Error("bootstrap must predate the policy plan");
  if (!git.isAncestor(bootstrap, before)) throw new Error("bootstrap is not an ancestor of push before");
  const pushed = new Set();
  let current = head;
  while (current !== before) {
    if (pushed.has(current) || pushed.size >= 1000) throw new Error("main push ancestry budget exhausted");
    pushed.add(current);
    const parents = git.parents(current);
    if (parents.length !== 1) throw new Error("main range must be a complete single-parent chain");
    current = requireSha(parents[0]);
  }
  const seen = new Set();
  for (let candidate = before; candidate !== bootstrap;) {
    if (seen.has(candidate) || seen.size >= maxCandidates) throw new Error("main candidate budget exhausted");
    seen.add(candidate);
    const parents = git.parents(candidate);
    if (parents.length !== 1) throw new Error("main range must be a complete single-parent chain");
    const result = evidence.inspect(candidate);
    if (result.successful) {
      checkedPlan(git, candidate, plan);
      return { validatedBase: candidate, head, before, ...result, bootstrap: false };
    }
    candidate = requireSha(parents[0]);
  }
  return { validatedBase: bootstrap, head, before, bootstrap: true };
}

function localRepository(repository) {
  if (repository !== undefined && repository !== EXPECTED_REPOSITORY) throw new Error("repository override is forbidden");
  return EXPECTED_REPOSITORY;
}

export function resolveLocalMainBaseline({ root = ROOT, repository, git = createMainGit(root), reader } = {}) {
  const name = localRepository(repository);
  const api = reader ?? createGitHubReader({ root });
  const remote = api.get(`repos/${name}/git/ref/heads/main`);
  if (remote?.ref !== "refs/heads/main" || remote.object?.type !== "commit") throw new Error("remote main identity is invalid");
  const head = git.head();
  return resolveBaseline({ head, repository: name, git,
    evidence: createMainEvidence({ repository: name, reader: api }),
    event: { repository: { full_name: name }, ref: "refs/heads/main", after: head, before: requireSha(remote.object.sha) } });
}

export function requireSuccessfulMainHead({ root = ROOT, repository, git = createMainGit(root), reader } = {}) {
  const name = localRepository(repository);
  const head = git.head();
  if (checkedPlan(git, head).phase !== "retired") throw new Error("release requires the final retired main-only phase");
  const api = reader ?? createGitHubReader({ root });
  const remote = api.get(`repos/${name}/git/ref/heads/main`);
  if (remote?.ref !== "refs/heads/main" || remote.object?.type !== "commit" || remote.object.sha !== head) {
    throw new Error("release HEAD differs from the current official main");
  }
  const evidence = createMainEvidence({ repository: name, reader: api });
  const parents = git.parents(head);
  if (parents.length !== 1) throw new Error("release HEAD must have one strict parent");
  const baseline = resolveBaseline({ head, repository: name, git, evidence,
    event: { repository: { full_name: name }, ref: "refs/heads/main", after: head, before: parents[0] } });
  const result = evidence.inspect(head);
  if (!result.successful) throw new Error(`final main CI is not successful: ${result.reason}`);
  const finalMain = api.get(`repos/${name}/git/ref/heads/main`);
  if (finalMain?.ref !== "refs/heads/main" || finalMain.object?.type !== "commit" || finalMain.object.sha !== head) {
    throw new Error("official main changed during release evidence inspection");
  }
  return { ...baseline, headRunId: result.runId, headAttempt: result.attempt };
}

export function mainBaselineEnvironment({ validatedBase }) {
  requireSha(validatedBase);
  return { VERIFY_BASE_REF: validatedBase, ARCHITECTURE_BASE_REF: validatedBase, COVERAGE_BASE_REF: validatedBase };
}

function main() {
  if (process.argv.length === 3 && process.argv[2] === "local-baseline") {
    console.log(JSON.stringify(resolveLocalMainBaseline())); return;
  }
  if (process.argv.length !== 3 || process.argv[2] !== "baseline" || process.env.GITHUB_EVENT_NAME !== "push"
      || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_WORKFLOW !== "CI"
      || !process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_OUTPUT) throw new Error("baseline requires the CI main push context");
  const git = createMainGit(); const head = git.head();
  if (process.env.GITHUB_SHA !== head) throw new Error("checkout differs from event HEAD");
  const repository = repositoryName(process.env.GITHUB_REPOSITORY);
  if (repository !== EXPECTED_REPOSITORY) throw new Error("CI repository differs from the governed origin");
  const evidence = createMainEvidence({ repository, reader: createGitHubReader({ root: ROOT }) });
  const result = resolveBaseline({ event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
    head, repository, git, evidence });
  appendFileSync(process.env.GITHUB_OUTPUT, `validated_base=${result.validatedBase}\n`);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "main CI evidence failed"); process.exitCode = 1;
  }
}
