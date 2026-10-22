import { parse as parseYaml } from "yaml";
import { canonicalCommandInvocations } from "./static-command-policy.mjs";

export function evidenceRunner(path) {
  if (/^scripts\/__tests__\/.+\.test\.[cm]?js$/.test(path)) return "node-test:scripts";
  if (/^e2e\/.+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)) return "playwright";
  if (/^src\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return "vitest";
  if (/\.rs$/.test(path)) return "cargo-test";
  return undefined;
}

function commandRunners(command, packageScripts, readFile, seenScripts = new Set()) {
  const runners = new Set();
  const nestedScripts = [];
  for (const invocation of canonicalCommandInvocations(command)) {
    const [program, ...args] = invocation;
    if (
      program === "node" &&
      args[0] === "--test" &&
      args.some((argument) => argument.startsWith("scripts/__tests__/"))
    ) runners.add("node-test:scripts");
    if (program === "vitest") runners.add("vitest");
    if (program === "playwright" && args[0] === "test") runners.add("playwright");
    if (
      program === "cargo" &&
      (args[0] === "test" || (args[0] === "llvm-cov" && args[1] === "test"))
    ) runners.add("cargo-test");
    if (program === "npm" && args[0] === "test") nestedScripts.push("test");
    if (program === "npm" && args[0] === "run") {
      const scriptIndex = args[1] === "--silent" ? 2 : 1;
      if (/^[A-Za-z0-9:_-]+$/.test(args[scriptIndex] ?? "")) {
        nestedScripts.push(args[scriptIndex]);
      }
    }
  }
  for (const script of nestedScripts) {
    if (seenScripts.has(script)) continue;
    const nextSeen = new Set(seenScripts).add(script);
    for (const runner of commandRunners(packageScripts?.[script], packageScripts, readFile, nextSeen)) {
      runners.add(runner);
    }
    if (script === "verify") {
      try {
        const plan = JSON.parse(String(readFile("docs/engineering/verify-plan.json") ?? ""));
        for (const step of plan.steps ?? []) {
          const stepCommand = [step.command, ...(step.args ?? [])].join(" ");
          for (const runner of commandRunners(stepCommand, packageScripts, readFile, nextSeen)) {
            runners.add(runner);
          }
        }
      } catch {
        // The verify-plan validator reports malformed or missing plan data separately.
      }
    }
  }
  return runners;
}

function workflowRunCommands(contents) {
  const commands = [];
  const workflow = parseYaml(String(contents ?? "")) ?? {};
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === "string") {
        commands.push(step.run);
      }
    }
  }
  return commands;
}

export function gateRunnerCoverage(gates, packageScripts, readFile) {
  const coverage = new Map();
  for (const gate of gates ?? []) {
    const commands =
      gate.kind === "package-script"
        ? [`npm run ${gate.ref}`]
        : workflowRunCommands(readFile(gate.ref));
    const runners = new Set();
    for (const command of commands) {
      for (const runner of commandRunners(command, packageScripts, readFile)) {
        runners.add(runner);
      }
    }
    coverage.set(gate.id, runners);
  }
  return coverage;
}
