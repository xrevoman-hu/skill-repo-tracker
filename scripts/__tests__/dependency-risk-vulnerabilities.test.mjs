import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AUDITED_TARGETS, reconcileCargoAuditReport, runDependencyRiskAudit } from "../dependency-risk.mjs";

const NOW = new Date("2026-09-30T12:00:00Z");
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const LEDGER = { schemaVersion: 1, risks: [] };
const METADATA = {
  packages: [{ id: "fixture-root", name: "fixture-root", version: "0.0.0", source: null }],
  workspace_members: ["fixture-root"],
  resolve: { nodes: [{ id: "fixture-root", dependencies: [] }] },
};
const TARGET_METADATA = Object.fromEntries(AUDITED_TARGETS.map((target) => [target, METADATA]));
const EXPECTED = "cargo audit vulnerabilities are never allowlisted: RUSTSEC-2026-9999 fixture-package@1.2.3";

function vulnerabilityReport() {
  return {
    settings: { target_arch: [], target_os: [], severity: null, ignore: [], informational_warnings: ["notice", "unmaintained", "unsound"] },
    vulnerabilities: {
      found: true, count: 1,
      // RustSec 0.33.0 Vulnerability serializes these four fields, without kind.
      list: [{
        advisory: { id: "RUSTSEC-2026-9999" },
        versions: { patched: [">=1.2.4"], unaffected: [] },
        affected: null,
        package: { name: "fixture-package", version: "1.2.3", source: SOURCE },
      }],
    },
    warnings: { unsound: [], unmaintained: [], yanked: [], notice: [] },
  };
}

test("RustSec vulnerability records without kind retain advisory and package diagnostics and fail audit", () => {
  const report = vulnerabilityReport();
  assert.equal(Object.hasOwn(report.vulnerabilities.list[0], "kind"), false);
  const result = reconcileCargoAuditReport(LEDGER, report, TARGET_METADATA, { now: NOW });
  assert.deepEqual(result.errors, [EXPECTED]);
});

test("vulnerability context never relaxes warning kind or package identity checks", () => {
  const report = vulnerabilityReport();
  report.warnings.unmaintained.push({
    advisory: { id: "RUSTSEC-2026-9998" },
    package: { name: "unmaintained-fixture", version: "1.0.0", source: SOURCE },
  });
  report.vulnerabilities.list[0].package.version = "";
  const errors = reconcileCargoAuditReport(LEDGER, report, TARGET_METADATA, { now: NOW }).errors;
  assert.ok(errors.includes("unmaintained warning 0 kind must be exactly unmaintained"));
  assert.ok(errors.includes("vulnerability 0 package.version must be a canonical non-empty Cargo version"));
  assert.ok(errors.some((error) => error.startsWith("cargo audit vulnerabilities are never allowlisted:")));
});

test("audit runner fails and names real-shape vulnerabilities even when cargo audit exits zero", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "srt-vulnerability-report-"));
  try {
    mkdirSync(join(root, "docs/engineering"), { recursive: true });
    writeFileSync(join(root, "docs/engineering/dependency-risk-ledger.json"), JSON.stringify(LEDGER));
    for (const auditStatus of [0, 1]) {
      const output = [];
      const errors = [];
      const status = runDependencyRiskAudit({
        root, now: NOW,
        spawnSyncImpl(command, args) {
          if (command === "cargo-audit" && args[1] === "--version") {
            return { status: 0, signal: null, stdout: "cargo-audit-audit 0.22.2\n", stderr: "" };
          }
          if (command === "cargo-audit" && args.includes("terminal")) {
            return { status: auditStatus, signal: null, stdout: "", stderr: "Updating crates.io index\nScanning src-tauri/Cargo.lock for vulnerabilities (1 crate dependency)\n" };
          }
          return {
            status: command === "cargo-audit" ? auditStatus : 0, signal: null,
            stdout: JSON.stringify(command === "cargo-audit" ? vulnerabilityReport() : METADATA), stderr: "",
          };
        },
        stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
      });
      assert.equal(status, 1);
      assert.ok(errors.includes(`- ${EXPECTED}`));
      assert.ok(errors.includes("Dependency risk audit failed:"));
      assert.equal(errors.some((line) => line.includes("kind must be exactly vulnerability") || line.endsWith(": unknown")), false);
      assert.equal(output.some((line) => line.startsWith("PASS")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
