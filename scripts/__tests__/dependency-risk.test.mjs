import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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
const PREFLIGHT_STDERR = "Loaded 1239 security advisories\nUpdating crates.io index\nScanning src-tauri/Cargo.lock for vulnerabilities (2 crate dependencies)";

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
    settings: {
      target_arch: [],
      target_os: [],
      severity: null,
      ignore: [],
      informational_warnings: ["unmaintained", "unsound", "notice"],
    },
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

function emptyReport(overrides = {}) {
  return report({
    warnings: { unsound: [], unmaintained: [], yanked: [], notice: [] },
    ...overrides,
  });
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
    [ledger([activeRisk({ package: { name: "glib", version: "latest", source: SOURCE } })]), /package.version/],
    [ledger([activeRisk({ package: { name: "glib", version: "0.18.5", source: "crates.io" } })]), /package.source/],
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
  assert.deepEqual(result.unmaintained, { count: 0, identities: [] });

  const withUnmaintained = report();
  const alpha = warning({
    kind: "unmaintained",
    advisory: { id: "RUSTSEC-2025-0001" },
    package: { name: "alpha", version: "1.0.0", source: SOURCE },
  });
  const zeta = warning({
    kind: "unmaintained",
    advisory: { id: "RUSTSEC-2025-0002" },
    package: { name: "zeta", version: "2.0.0", source: SOURCE },
  });
  withUnmaintained.warnings.unmaintained.push(zeta, alpha, structuredClone(alpha));
  const summary = reconcileCargoAuditReport(
    ledger([activeRisk()]),
    withUnmaintained,
    targetMetadata(),
    { now: NOW },
  );
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.unmaintained, {
    count: 2,
    identities: [
      `alpha@1.0.0 / RUSTSEC-2025-0001 / ${SOURCE}`,
      `zeta@2.0.0 / RUSTSEC-2025-0002 / ${SOURCE}`,
    ],
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
    [
      { ...report(), settings: { ...report().settings, ignore: ["RUSTSEC-2026-9999"] } },
      /settings.ignore must be an empty array/,
    ],
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

test("cargo audit settings must exactly describe an unfiltered complete informational scan", () => {
  const mutations = [
    [{ ...report().settings, severity: "medium" }, /settings.severity must be null/],
    [{ ...report().settings, target_arch: ["aarch64"] }, /settings.target_arch must be an empty array/],
    [{ ...report().settings, target_os: ["macos"] }, /settings.target_os must be an empty array/],
    [
      { ...report().settings, informational_warnings: ["unmaintained", "unsound"] },
      /informational_warnings must contain exactly/,
    ],
    [
      { ...report().settings, informational_warnings: ["notice", "unmaintained", "unsound", "future"] },
      /informational_warnings must contain exactly/,
    ],
    [{ ...report().settings, future_filter: [] }, /settings has unknown field future_filter/],
  ];
  for (const [settings, expected] of mutations) {
    assert.match(
      reconcileCargoAuditReport(
        ledger([activeRisk()]),
        { ...report(), settings },
        targetMetadata(),
        { now: NOW },
      ).errors.join("\n"),
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
      /package.source must be a canonical single-line Cargo source identity/,
    ],
    [
      warning({ kind: "unsound", advisory: { id: "RUSTSEC-2025-0001" } }),
      /kind must be exactly unmaintained/,
    ],
    [
      warning({ kind: undefined, advisory: { id: "RUSTSEC-2025-0001" } }),
      /kind must be exactly unmaintained/,
    ],
    [
      warning({
        kind: "unmaintained",
        advisory: { id: "RUSTSEC-2025-0001" },
        package: { name: "glib bad", version: "0.18.5", source: SOURCE },
      }),
      /package.name must be a canonical Cargo package name/,
    ],
    [
      warning({
        kind: "unmaintained",
        advisory: { id: "RUSTSEC-2025-0001" },
        package: { name: "glib", version: "0.18.5", source: ` ${SOURCE}` },
      }),
      /package.source must be a canonical single-line Cargo source identity/,
    ],
    [
      warning({
        kind: "unmaintained",
        advisory: { id: "RUSTSEC-2025-0001" },
        package: { name: "glib", version: "latest", source: SOURCE },
      }),
      /package.version must be a canonical non-empty Cargo version/,
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
      targetMetadata({
        "aarch64-unknown-linux-gnu": {
          packages: [{ id: ROOT_ID }],
          workspace_members: [ROOT_ID],
          resolve: null,
        },
      }),
      { now: NOW },
    ).errors.join("\n"),
    /metadata.*resolve/,
  );
});

test("zero-warning audits still require exactly three complete target graphs", () => {
  const clean = emptyReport();
  assert.deepEqual(
    reconcileCargoAuditReport(ledger(), clean, targetMetadata(), { now: NOW }).errors,
    [],
  );

  const missing = targetMetadata();
  delete missing["aarch64-apple-darwin"];
  assert.match(
    reconcileCargoAuditReport(ledger(), clean, missing, { now: NOW }).errors.join("\n"),
    /missing cargo metadata for audited target aarch64-apple-darwin/,
  );

  const extra = targetMetadata({ "x86_64-pc-windows-msvc": metadata(false) });
  assert.match(
    reconcileCargoAuditReport(ledger(), clean, extra, { now: NOW }).errors.join("\n"),
    /unexpected audited target metadata x86_64-pc-windows-msvc/,
  );

  const broken = targetMetadata({
    "aarch64-apple-darwin": { packages: [], workspace_members: [], resolve: { nodes: [] } },
  });
  assert.match(
    reconcileCargoAuditReport(ledger(), clean, broken, { now: NOW }).errors.join("\n"),
    /packages must be a non-empty array/,
  );

  const unknownDependency = metadata(false);
  unknownDependency.resolve.nodes[0].dependencies.push("missing-package");
  assert.match(
    reconcileCargoAuditReport(
      ledger(),
      clean,
      targetMetadata({ "aarch64-apple-darwin": unknownDependency }),
      { now: NOW },
    ).errors.join("\n"),
    /dependency references an unknown package or resolve node/,
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

test("dependency risk CLI boots in a fresh checkout without node_modules", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "srt-dependency-fresh-checkout-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "docs/engineering"), { recursive: true });
  copyFileSync(new URL("../dependency-risk.mjs", import.meta.url), join(root, "scripts/dependency-risk.mjs"));
  copyFileSync(new URL("../dependency-risk-runtime.mjs", import.meta.url), join(root, "scripts/dependency-risk-runtime.mjs"));
  copyFileSync(new URL("../git-paths-core.mjs", import.meta.url), join(root, "scripts/git-paths-core.mjs"));
  writeFileSync(
    join(root, "docs/engineering/dependency-risk-ledger.json"),
    `${JSON.stringify(ledger(), null, 2)}\n`,
  );
  assert.equal(existsSync(join(root, "node_modules")), false);
  const env = { ...process.env };
  delete env.VERIFY_BASE_REF;
  assert.match(
    execFileSync(process.execPath, [join(root, "scripts/dependency-risk.mjs"), "check"], {
      cwd: root,
      encoding: "utf8",
      env,
    }),
    /PASS tracked dependency risk ledger/,
  );
});

function successfulSpawn(calls, auditReport = report(), metadataByTarget = targetMetadata()) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "cargo-audit" && args[1] === "--version") {
      return { status: 0, signal: null, stdout: "cargo-audit-audit 0.22.2\n", stderr: "" };
    }
    if (command === "cargo-audit" && args.includes("terminal")) {
      return { status: 0, signal: null, stdout: "", stderr: `${PREFLIGHT_STDERR}\n` };
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
  assert.equal(calls.length, 6);
  assert.equal(calls[0].command, "cargo-audit");
  assert.deepEqual(calls[0].args, ["audit", "--version"]);
  assert.equal(calls[1].command, "cargo-audit");
  assert.deepEqual(calls[1].args, [
    "audit",
    "--deny",
    "yanked",
    "--format",
    "terminal",
    "--color",
    "never",
    "--file",
    "src-tauri/Cargo.lock",
  ]);
  assert.deepEqual(calls[2].args, [
    "audit",
    "--format",
    "json",
    "--file",
    "src-tauri/Cargo.lock",
  ]);
  for (const [index, target] of AUDITED_TARGETS.entries()) {
    assert.deepEqual(calls[index + 3].args, [
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
  assert.ok(calls.slice(3).every((call) => call.command === "cargo"));
  const isolatedCargoHome = calls[1].options.env.CARGO_HOME;
  assert.equal(calls[2].options.env, calls[1].options.env);
  assert.equal(existsSync(isolatedCargoHome), false);
  assert.ok(calls.slice(3).every((call) => call.options.env === undefined));
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.ok(calls.every((call) => call.options.maxBuffer === 32 * 1024 * 1024));
});

test("registry preflight requires a fresh index marker and complete yanked checks", () => {
  const cases = [
    ["Scanning src-tauri/Cargo.lock for vulnerabilities", 0, /did not prove a crates.io index update/],
    ["Updating crates.io index", 0, /did not prove the requested lockfile was scanned/],
    [`${PREFLIGHT_STDERR}\ncouldn't update crates.io index`, 0, /could not complete every yanked-package check/],
    [`${PREFLIGHT_STDERR}\ncouldn't open crates.io index`, 0, /could not complete every yanked-package check/],
    [`${PREFLIGHT_STDERR}\ncouldn't check if package glib is yanked`, 0, /could not complete every yanked-package check/],
    [`${PREFLIGHT_STDERR}\nyanked dependency found`, 2, /registry preflight exited with status 2/],
  ];
  for (const [terminalStderr, status, expected] of cases) {
    const calls = [];
    const normal = successfulSpawn(calls);
    const errors = [];
    assert.equal(runDependencyRiskAudit({
      root: writeAuditRoot(), now: NOW,
      spawnSyncImpl: (command, args, options) =>
        command === "cargo-audit" && args.includes("terminal")
          ? { status, signal: null, stdout: "", stderr: `${terminalStderr}\n` }
          : normal(command, args, options),
      stdout: () => {}, stderr: (line) => errors.push(line),
    }), 1);
    assert.match(errors.join("\n"), expected);
    assert.equal(existsSync(calls.find((call) => call.args.includes("json")).options.env.CARGO_HOME), false);
  }
});

test("report-only identities survive vulnerability, unknown-category, and nonzero failures", () => {
  const cases = [
    ["vulnerability", (value) => { value.vulnerabilities = { found: true, count: 1, list: [warning({ kind: "vulnerability", advisory: { id: "RUSTSEC-2026-9999" } })] }; }, false, /vulnerabilities are never allowlisted/],
    ["unknown", (value) => { value.warnings.future_kind = []; }, false, /unknown cargo audit warning category/],
    ["nonzero", () => {}, true, /cargo audit exited with status 2/],
  ];
  for (const [label, mutate, nonzero, expected] of cases) {
    const auditReport = report();
    auditReport.warnings.unmaintained.push(warning({
      kind: "unmaintained", advisory: { id: "RUSTSEC-2025-0001" },
      package: { name: "alpha", version: "1.0.0", source: SOURCE },
    }));
    mutate(auditReport);
    const normal = successfulSpawn([], auditReport);
    const output = [];
    const errors = [];
    assert.equal(runDependencyRiskAudit({
      root: writeAuditRoot(), now: NOW,
      spawnSyncImpl: (command, args, options) => {
        const result = normal(command, args, options);
        return nonzero && command === "cargo-audit" && args.includes("json")
          ? { ...result, status: 2 } : result;
      },
      stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
    }), 1, label);
    assert.ok(output.includes(`REPORT-ONLY unmaintained warning: alpha@1.0.0 / RUSTSEC-2025-0001 / ${SOURCE}`), label);
    assert.match(errors.join("\n"), expected, label);
  }
});

test("audit runner reports every unique unmaintained identity in stable order", () => {
  const auditReport = report();
  const alpha = warning({
    kind: "unmaintained",
    advisory: { id: "RUSTSEC-2025-0001" },
    package: { name: "alpha", version: "1.0.0", source: SOURCE },
  });
  auditReport.warnings.unmaintained.push(
    warning({
      kind: "unmaintained",
      advisory: { id: "RUSTSEC-2025-0002" },
      package: { name: "zeta", version: "2.0.0", source: SOURCE },
    }),
    alpha,
    structuredClone(alpha),
  );
  const stdout = [];
  assert.equal(
    runDependencyRiskAudit({
      root: writeAuditRoot(),
      now: NOW,
      spawnSyncImpl: successfulSpawn([], auditReport),
      stdout: (line) => stdout.push(line),
      stderr: () => {},
    }),
    0,
  );
  assert.deepEqual(stdout.slice(0, 2), [
    `REPORT-ONLY unmaintained warning: alpha@1.0.0 / RUSTSEC-2025-0001 / ${SOURCE}`,
    `REPORT-ONLY unmaintained warning: zeta@2.0.0 / RUSTSEC-2025-0002 / ${SOURCE}`,
  ]);
});

test("audit runner rejects successful cargo audit output accompanied by stderr", () => {
  const normal = successfulSpawn([]);
  const errors = [];
  assert.equal(
    runDependencyRiskAudit({
      root: writeAuditRoot(),
      now: NOW,
      spawnSyncImpl: (command, args, options) => {
        const result = normal(command, args, options);
        return command === "cargo-audit" && args.includes("json")
          ? { ...result, stderr: "warning: advisory registry scan was skipped\n" }
          : result;
      },
      stdout: () => {},
      stderr: (line) => errors.push(line),
    }),
    1,
  );
  assert.match(errors.join("\n"), /wrote to stderr.*scan completeness cannot be proven/);
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
