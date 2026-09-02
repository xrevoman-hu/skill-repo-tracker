import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function spawn(command, args, root, spawnSyncImpl = spawnSync, environment) {
  const options = {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
  };
  if (environment) options.env = environment;
  const result = spawnSyncImpl(command, args, options);
  const stdout = typeof result?.stdout === "string" ? result.stdout : String(result?.stdout ?? "");
  const stderr = typeof result?.stderr === "string" ? result.stderr : String(result?.stderr ?? "");
  return { ...result, stdout, stderr };
}

export function createIsolatedCargoAuditEnvironment() {
  const cargoHome = mkdtempSync(join(tmpdir(), "skill-repo-tracker-cargo-audit-"));
  let active = true;
  return {
    cargoHome,
    env: { ...process.env, CARGO_HOME: cargoHome },
    cleanup() {
      if (!active) return;
      active = false;
      rmSync(cargoHome, { force: true, recursive: true });
    },
  };
}
