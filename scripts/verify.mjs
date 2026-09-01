#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargoBin = join(homedir(), ".cargo", "bin");
const env = {
  ...process.env,
  PATH: existsSync(cargoBin)
    ? `${cargoBin}${delimiter}${process.env.PATH ?? ""}`
    : process.env.PATH,
};

const steps = [
  ["治理脚本测试", "npm", ["run", "test:scripts"]],
  ["版本、边界与架构预算", process.execPath, ["scripts/governance.mjs", "all"]],
  ["TypeScript 全量检查", "npm", ["run", "typecheck"]],
  ["TypeScript strict islands", "npm", ["run", "typecheck:strict-islands"]],
  ["Vitest 全量测试", "npm", ["test"]],
  ["Vite 生产构建", "npm", ["run", "build"]],
  ["前端包体预算", process.execPath, ["scripts/governance.mjs", "bundle"]],
  [
    "Rust 格式",
    "cargo",
    ["fmt", "--check", "--manifest-path", "src-tauri/Cargo.toml"],
  ],
  [
    "Rust Clippy",
    "cargo",
    [
      "clippy",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ],
  ],
  [
    "Rust 全量测试",
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-features",
    ],
  ],
  ["Git 空白错误", process.execPath, ["scripts/check-diff.mjs"]],
];

for (const [label, command, args] of steps) {
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
