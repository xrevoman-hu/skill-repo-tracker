#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERIFY_PLAN, validateVerifyPlan } from "./verify-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargoBin = join(homedir(), ".cargo", "bin");
const env = {
  ...process.env,
  PATH: existsSync(cargoBin)
    ? `${cargoBin}${delimiter}${process.env.PATH ?? ""}`
    : process.env.PATH,
};

const planErrors = validateVerifyPlan(VERIFY_PLAN);
if (planErrors.length > 0) {
  for (const error of planErrors) console.error(`FAIL verify contract: ${error}`);
  process.exit(1);
}

for (const { label, command: commandName, args } of VERIFY_PLAN) {
  const command = commandName === "node" ? process.execPath : commandName;
  console.log(`\n=== ${label} ===`);
  try {
    execFileSync(command, args, {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });
  } catch (error) {
    const exitCode = typeof error.status === "number" ? error.status : 1;
    console.error(`\nFAIL ${label} (exit ${exitCode})`);
    process.exit(exitCode);
  }
}

console.log("\nPASS npm run verify");
