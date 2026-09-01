#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const explicitBase = process.env.VERIFY_BASE_REF;
const githubBase = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : undefined;
let base = explicitBase || githubBase;

function check(args) {
  execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
}

export function buildDiffCheckArguments(comparisonBase) {
  const checks = [];
  if (comparisonBase) {
    checks.push(["diff", "--check", `${comparisonBase}...HEAD`]);
  }
  checks.push(["diff", "--check"], ["diff", "--cached", "--check"]);
  return checks;
}

function main() {
  if (!base && process.env.CI) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD^"], {
        cwd: ROOT,
        stdio: "ignore",
      });
      base = "HEAD^";
    } catch {
      // A repository's first commit has no comparison base.
    }
  }

  for (const args of buildDiffCheckArguments(base)) check(args);
  if (base) console.log(`PASS committed diff whitespace (${base}...HEAD)`);
  console.log("PASS working tree and staged diff whitespace");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
