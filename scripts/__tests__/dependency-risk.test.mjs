import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUDITED_TARGETS,
  checkRepositoryDependencyRisks,
  compareDependencyRiskLedgers,
  reconcileCargoAuditReport,
  runDependencyRiskAudit,
  validateDependencyRiskLedger,
} from "../dependency-risk.mjs";

const NOW = new Date("2026-09-02T12:00:00Z");
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const ROOT_ID = "path+file:///workspace#skill-repo-tracker@1.2.6";
const GLIB_ID = `${SOURCE}#glib@0.18.5`;

function activeRisk(overrides = {}) {
  return {
    id: "RISK-2026-001",
    status: "active",
    ecosystem: "cargo",
    package: { name: "glib", version: "0.18.5", source: SOURCE },
    advisory: "RUSTSEC-2024-0429",
    warningKind: "unsound",
    affectedTargets: ["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"],
    owner: "xrevoman-hu",
    createdOn: "2026-09-02",
    reviewOn: "2026-12-01",
    reason: "The advisory is confined to the existing Linux GTK dependency graph.",
    exitCondition: "Upgrade the Tauri and GTK graph to glib 0.20 or remove that graph.",
    reviewTriggers: ["begin-linux-distribution", "upgrade-tauri-wry-gtk"],
    ...overrides,
  };
}

function retiredRisk(overrides = {}) {
  return {
    ...activeRisk(),
    status: "retired",
    retiredOn: "2026-09-02",
    retirementReason: "The affected dependency graph no longer resolves in any audited target.",
    ...overrides,
  };
}

function ledger(risks = []) {
  return { schemaVersion: 1, risks };
}

function warning(overrides = {}) {
  return {
    kind: "unsound",
    advisory: { id: "RUSTSEC-2024-0429" },
    package: { name: "glib", version: "0.18.5", source: SOURCE },
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    settings: { ignore: [] },
    vulnerabilities: { found: false, count: 0, list: [] },
    warnings: {
      unsound: [warning()],
      unmaintained: [],
      yanked: [],
      notice: [],
    },
    ...overrides,
  };
}

function metadata(reachable) {
  return {
    packages: [
      { id: ROOT_ID, name: "skill-repo-tracker", version: "1.2.6", source: null },
      { id: GLIB_ID, name: "glib", version: "0.18.5", source: SOURCE },
    ],
    workspace_members: [ROOT_ID],
    resolve: {
      nodes: [
        { id: ROOT_ID, dependencies: reachable ? [GLIB_ID] : [] },
        { id: GLIB_ID, dependencies: [] },
      ],
    },
  };
}

function targetMetadata(overrides = {}) {
  return {
    "aarch64-apple-darwin": metadata(false),
    "aarch64-unknown-linux-gnu": metadata(true),
    "x86_64-unknown-linux-gnu": metadata(true),
    ...overrides,
  };
}

test("dependency risk ledger rejects stale and malformed active entries", () => {
  assert.deepEqual(validateDependencyRiskLedger(ledger([activeRisk()]), { now: NOW }), []);
  assert.deepEqual(AUDITED_TARGETS, [
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
  ]);

  const cases = [
    [{ schemaVersion: 1, risks: [], extra: true }, /unknown root field extra/],
    [ledger([activeRisk({ undocumented: true })]), /unknown field undocumented/],
    [ledger([activeRisk({ id: "RUSTSEC-2024-0429" })]), /RISK-YYYY-NNN/],
    [ledger([activeRisk({ ecosystem: "npm" })]), /ecosystem must be cargo/],
    [ledger([activeRisk({ warningKind: "unmaintained" })]), /warningKind must be unsound/],
    [ledger([activeRisk({ reviewOn: "2026-12-02" })]), /at most 90 UTC days/],
    [ledger([activeRisk({ reviewOn: "2026-09-01" })]), /expired on 2026-09-01/],
    [ledger([activeRisk({ affectedTargets: ["x86_64-pc-windows-msvc"] })]), /affectedTargets/],
    [
      ledger([
        activeRisk({
          affectedTargets: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
        }),
      ]),
      /affectedTargets must be sorted/,
    ],
    [ledger([activeRisk({ reviewTriggers: ["upgrade-tauri-wry-gtk", "upgrade-tauri-wry-gtk"] })]), /reviewTriggers must be unique/],
    [ledger([activeRisk({ package: { name: "glib", version: "0.18.5" } })]), /package is missing field source/],
  ];
  for (const [document, expected] of cases) {
    assert.ok(
      validateDependencyRiskLedger(document, { now: NOW }).some((error) => expected.test(error)),
      expected.source,
    );
  }
});

test("dependency risk lifecycle is append-only and active scope cannot be extended", () => {
  const base = ledger([activeRisk()]);
  assert.deepEqual(compareDependencyRiskLedgers(ledger([retiredRisk()]), base), []);
  assert.match(
    compareDependencyRiskLedgers(ledger(), base).join("\n"),
    /must retire before deletion/,
  );
  assert.match(
    compareDependencyRiskLedgers(
      ledger([activeRisk({ reviewOn: "2026-11-30" })]),
      base,
    ).join("\n"),
    /active scope is immutable/,
  );
  assert.match(
    compareDependencyRiskLedgers(ledger(), ledger([retiredRisk()])).join("\n"),
    /tombstone cannot be deleted/,
  );
  assert.match(
    compareDependencyRiskLedgers(ledger([activeRisk()]), ledger([retiredRisk()])).join("\n"),
    /cannot be reactivated or rewritten/,
  );
  assert.match(
    compareDependencyRiskLedgers(ledger([retiredRisk()]), ledger()).join("\n"),
    /must start active/,
  );

  const reviewedAgain = activeRisk({ id: "RISK-2026-002" });
  assert.deepEqual(
    validateDependencyRiskLedger(ledger([retiredRisk(), reviewedAgain]), { now: NOW }),
    [],
  );
  assert.deepEqual(
    compareDependencyRiskLedgers(ledger([retiredRisk(), reviewedAgain]), ledger([retiredRisk()])),
    [],
  );
  assert.deepEqual(
    compareDependencyRiskLedgers(ledger([retiredRisk(), reviewedAgain]), base),
    [],
  );
  assert.match(
    validateDependencyRiskLedger(
      ledger([activeRisk(), activeRisk({ id: "RISK-2026-002" })]),
      { now: NOW },
    ).join("\n"),
    /active dependency risk advisory and package identities must be unique/,
  );
});

test("repository checker validates current and base ledgers without network tools", () => {
  const root = mkdtempSync(join(tmpdir(), "srt-dependency-risk-"));
  mkdirSync(join(root, "docs/engineering"), { recursive: true });
  writeFileSync(
    join(root, "docs/engineering/dependency-risk-ledger.json"),
    `${JSON.stringify(ledger([activeRisk()]), null, 2)}\n`,
  );
  assert.deepEqual(
    checkRepositoryDependencyRisks(root, { now: NOW, baseLedger: ledger() }),
    [],
  );

  writeFileSync(
    join(root, "docs/engineering/dependency-risk-ledger.json"),
    `${JSON.stringify(ledger([activeRisk({ reviewOn: "2026-09-01" })]), null, 2)}\n`,
  );
  assert.match(
    checkRepositoryDependencyRisks(root, { now: NOW, baseLedger: ledger() }).join("\n"),
    /expired on 2026-09-01/,
  );
});

test("cargo audit reconciliation proves exact unsound target scope", () => {
  const result = reconcileCargoAuditReport(ledger([activeRisk()]), report(), targetMetadata(), {
    now: NOW,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unmaintained, { count: 0, advisoryIds: [] });

  const withUnmaintained = report();
  withUnmaintained.warnings.unmaintained.push(
    warning({ kind: "unmaintained", advisory: { id: "RUSTSEC-2025-0001" } }),
  );
  const summary = reconcileCargoAuditReport(
    ledger([activeRisk()]),
    withUnmaintained,
    targetMetadata(),
    { now: NOW },
  );
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.unmaintained, {
    count: 1,
    advisoryIds: ["RUSTSEC-2025-0001"],
  });
});

test("cargo audit reconciliation fails closed on findings and inconsistent counters", () => {
  const vulnerability = warning({ kind: "vulnerability", advisory: { id: "RUSTSEC-2026-9999" } });
  const cases = [
    [
      report({ vulnerabilities: { found: true, count: 1, list: [vulnerability] } }),
      /vulnerabilities are never allowlisted.*RUSTSEC-2026-9999/,
    ],
    [report({ vulnerabilities: { found: false, count: 1, list: [] } }), /count does not match list/],
    [{ ...report(), settings: { ignore: ["RUSTSEC-2026-9999"] } }, /settings.ignore must be empty/],
    [
      (() => {
        const value = report();
        value.warnings.yanked.push(warning({ kind: "yanked" }));
        return value;
      })(),
      /yanked warnings are never allowed/,
    ],
    [
      (() => {
        const value = report();
        value.warnings.notice.push(warning({ kind: "notice" }));
        return value;
      })(),
      /notice warnings require explicit checker support/,
    ],
    [
      (() => {
        const value = report();
        value.warnings.future_kind = [];
        return value;
      })(),
      /unknown cargo audit warning category future_kind/,
    ],
  ];
  for (const [auditReport, expected] of cases) {
    assert.match(
      reconcileCargoAuditReport(ledger([activeRisk()]), auditReport, targetMetadata(), { now: NOW }).errors.join("\n"),
      expected,
    );
  }
});

test("unmaintained warnings remain report-only only after complete identity validation", () => {
  for (const [mutation, expected] of [
    [
      warning({
        kind: "unmaintained",
        advisory: { id: "RUSTSEC-2025-0001" },
        package: { name: "glib", version: "0.18.5" },
      }),
      /package must include string name, version, and source/,
    ],
    [
      warning({ kind: "unsound", advisory: { id: "RUSTSEC-2025-0001" } }),
      /kind does not match its warning category/,
    ],
  ]) {
    const auditReport = report();
    auditReport.warnings.unmaintained.push(mutation);
    assert.match(
      reconcileCargoAuditReport(ledger([activeRisk()]), auditReport, targetMetadata(), {
        now: NOW,
      }).errors.join("\n"),
      expected,
    );
  }
});

test("cargo audit reconciliation fails closed outside the exact active unsound set", () => {
  assert.match(
    reconcileCargoAuditReport(ledger(), report(), targetMetadata(), { now: NOW }).errors.join("\n"),
    /missing an active dependency risk/,
  );
  assert.match(
    reconcileCargoAuditReport(ledger([activeRisk()]), { ...report(), warnings: {} }, targetMetadata(), { now: NOW }).errors.join("\n"),
    /active dependency risk RISK-2026-001 is stale/,
  );
  const duplicate = report();
  duplicate.warnings.unsound.push(warning());
  assert.match(
    reconcileCargoAuditReport(ledger([activeRisk()]), duplicate, targetMetadata(), { now: NOW }).errors.join("\n"),
    /duplicate unsound warning identity/,
  );
  assert.match(
    reconcileCargoAuditReport(
      ledger([activeRisk()]),
      report(),
      targetMetadata({ "aarch64-apple-darwin": metadata(true) }),
      { now: NOW },
    ).errors.join("\n"),
    /actual target set.*aarch64-apple-darwin/,
  );
});

test("cargo audit reconciliation rejects malformed or ambiguous metadata", () => {
  const ambiguous = metadata(true);
  ambiguous.packages.push({
    id: `${GLIB_ID}-duplicate`,
    name: "glib",
    version: "0.18.5",
    source: SOURCE,
  });
  assert.match(
    reconcileCargoAuditReport(
      ledger([activeRisk()]),
      report(),
      targetMetadata({ "aarch64-unknown-linux-gnu": ambiguous }),
      { now: NOW },
    ).errors.join("\n"),
    /package identity is ambiguous/,
  );
  assert.match(
    reconcileCargoAuditReport(
      ledger([activeRisk()]),
      report(),
      targetMetadata({ "aarch64-unknown-linux-gnu": { packages: [], workspace_members: [], resolve: null } }),
      { now: NOW },
    ).errors.join("\n"),
    /metadata.*resolve/,
  );
});

function writeAuditRoot() {
  const root = mkdtempSync(join(tmpdir(), "srt-dependency-audit-"));
  mkdirSync(join(root, "docs/engineering"), { recursive: true });
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  writeFileSync(
    join(root, "docs/engineering/dependency-risk-ledger.json"),
    `${JSON.stringify(ledger([activeRisk()]), null, 2)}\n`,
  );
  writeFileSync(join(root, "src-tauri/Cargo.toml"), "[package]\nname='fixture'\nversion='0.0.0'\n");
  writeFileSync(join(root, "src-tauri/Cargo.lock"), "# fixture\n");
  return root;
}

function successfulSpawn(calls, auditReport = report(), metadataByTarget = targetMetadata()) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "cargo-audit" && args[1] === "--version") {
      return { status: 0, signal: null, stdout: "cargo-audit-audit 0.22.2\n", stderr: "" };
    }
    if (command === "cargo-audit") {
      return { status: 0, signal: null, stdout: JSON.stringify(auditReport), stderr: "" };
    }
    const target = args[args.indexOf("--filter-platform") + 1];
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify(metadataByTarget[target]),
      stderr: "",
    };
  };
}

test("audit runner proves every warning against the audited target graph", () => {
  const root = writeAuditRoot();
  const calls = [];
  const stdout = [];
  const stderr = [];
  const code = runDependencyRiskAudit({
    root,
    now: NOW,
    spawnSyncImpl: successfulSpawn(calls),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join("\n"), /PASS dependency risk ledger reconciles 1 active unsound warning/);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].command, "cargo-audit");
  assert.deepEqual(calls[0].args, ["audit", "--version"]);
  assert.equal(calls[1].command, "cargo-audit");
  assert.deepEqual(calls[1].args, [
    "audit",
    "--format",
    "json",
    "--file",
    "src-tauri/Cargo.lock",
  ]);
  for (const [index, target] of AUDITED_TARGETS.entries()) {
    assert.deepEqual(calls[index + 2].args, [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      target,
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ]);
  }
  assert.ok(calls.slice(2).every((call) => call.command === "cargo"));
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.ok(calls.every((call) => call.options.maxBuffer === 32 * 1024 * 1024));
});

test("audit runner stays independent from pull request base history", () => {
  const root = writeAuditRoot();
  const previous = process.env.VERIFY_BASE_REF;
  process.env.VERIFY_BASE_REF = "missing-base-ref";
  try {
    assert.equal(
      runDependencyRiskAudit({
        root,
        now: NOW,
        spawnSyncImpl: successfulSpawn([]),
        stdout: () => {},
        stderr: () => {},
      }),
      0,
    );
  } finally {
    if (previous === undefined) delete process.env.VERIFY_BASE_REF;
    else process.env.VERIFY_BASE_REF = previous;
  }
});

test("audit runner rejects wrong versions, malformed JSON, and fake-green nonzero exits", () => {
  const root = writeAuditRoot();
  const cases = [
    [
      () => ({ status: 0, signal: null, stdout: "cargo-audit 0.22.1\n", stderr: "" }),
      /must be exactly 0.22.2/,
    ],
    [
      () => ({ status: 0, signal: null, stdout: "cargo-audit 0.22.2\n", stderr: "" }),
      /must be exactly 0.22.2/,
    ],
    [
      (command, args) =>
        command === "cargo-audit" && args[1] === "--version"
          ? { status: 0, signal: null, stdout: "cargo-audit-audit 0.22.2\n", stderr: "" }
          : { status: 0, signal: null, stdout: "not json", stderr: "" },
      /invalid cargo audit JSON/,
    ],
    [
      (command, args) =>
        command === "cargo-audit" && args[1] === "--version"
          ? { status: 0, signal: null, stdout: "cargo-audit-audit 0.22.2\n", stderr: "" }
          : { status: 2, signal: null, stdout: JSON.stringify(report()), stderr: "network failed" },
      /cargo audit exited with status 2/,
    ],
    [
      () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: new Error("terminated") }),
      /could not execute cargo-audit --version/,
    ],
  ];
  for (const [spawnSyncImpl, expected] of cases) {
    const errors = [];
    assert.equal(
      runDependencyRiskAudit({
        root,
        now: NOW,
        spawnSyncImpl,
        stdout: () => {},
        stderr: (line) => errors.push(line),
      }),
      1,
    );
    assert.match(errors.join("\n"), expected);
  }
});
