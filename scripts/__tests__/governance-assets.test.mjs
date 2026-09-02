import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compareGovernanceAssetCatalogs,
  selectGovernanceContext,
  validatePullRequestTemplate,
} from "../governance-assets.mjs";

import { fileContents, trackedFiles, validCatalog, validate } from "./governance-assets-fixtures.mjs";

test("a complete governance asset graph is accepted", () => {
  assert.deepEqual(validate(), []);
});

test("published v1.2.4 incidents remain explicit machine invariants", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("../../docs/engineering/governance-assets.json", import.meta.url)),
  );
  const byId = new Map(catalog.invariants.map((invariant) => [invariant.id, invariant]));

  const skillHash = byId.get("SKILL-HASH-001");
  assert.equal(skillHash?.introducedBy, "d40e750c3ba06d79db98ca0858e6c53d1a145a13");
  assert.deepEqual(skillHash?.protectedPaths, [
    "src-tauri/src/skill_hash.rs",
    "src-tauri/src/lib.rs",
  ]);
  assert.deepEqual(
    skillHash?.evidence.map(({ selector }) => selector),
    [
      "user_can_update_an_existing_skill_when_a_remote_file_and_directory_share_a_stem",
      "update_skill_rejects_an_unrelated_stored_hash_without_changing_metadata_or_files",
      "check_repositories_canonicalizes_same_sha_legacy_metadata_without_reopening_handled_customization",
      "check_repositories_preserves_a_pending_conflict_when_only_hash_encoding_changes",
    ],
  );

  const archiveTimeout = byId.get("GITHUB-ARCHIVE-TIMEOUT-001");
  assert.equal(
    archiveTimeout?.introducedBy,
    "16deea39d7ae0cf1506e6213e4fc6c157604dbfa",
  );
  assert.deepEqual(archiveTimeout?.protectedPaths, [
    "src-tauri/src/adapters.rs",
    "src-tauri/src/github_transport.rs",
  ]);
  assert.deepEqual(
    archiveTimeout?.evidence.map(({ selector }) => selector),
    ["archive_download_extends_only_the_archive_request_timeout"],
  );
});

test("every tracked Rule and ADR must be indexed exactly once", () => {
  const missingRule = validCatalog();
  missingRule.assets = missingRule.assets.filter((asset) => asset.id !== "rule-scheduling");
  assert.ok(
    validate(missingRule, {
      trackedFiles: [...trackedFiles, "docs/rules/prompts/import.md"],
    }).includes(
      "tracked Rule is not indexed by the governance catalog: docs/rules/scheduling.md",
    ),
  );
  assert.ok(
    validate(missingRule, {
      trackedFiles: [...trackedFiles, "docs/rules/prompts/import.md"],
    }).includes(
      "tracked Rule is not indexed by the governance catalog: docs/rules/prompts/import.md",
    ),
  );

  const duplicate = validCatalog();
  duplicate.assets.push({ ...duplicate.assets[1], id: "rule-scheduling-copy" });
  assert.ok(
    validate(duplicate).includes(
      "governance asset path is indexed more than once: docs/rules/scheduling.md",
    ),
  );
});

test("asset evidence, gates, selectors, commits, and active ADR status fail closed", () => {
  const catalog = validCatalog();
  catalog.assets[1].enforcement.evidence[0].selector = "missing regression";
  catalog.assets[1].enforcement.gates = ["missing-gate"];
  catalog.assets[2].path = "docs/adr/0001-scheduling.md";
  catalog.invariants[0].introducedBy = "deadbee";

  const errors = validate(catalog, {
    readFile: (path) =>
      path === "docs/adr/0001-scheduling.md"
        ? "# ADR\n\n- 状态：Proposed\n"
        : fileContents[path],
  });

  assert.ok(errors.includes("governance asset rule-scheduling references unknown gate: missing-gate"));
  assert.ok(
    errors.includes(
      "governance asset rule-scheduling evidence selector is not an executable test declaration in src/taskCoordinator.test.ts: missing regression",
    ),
  );
  assert.ok(
    errors.includes(
      "active decision adr-scheduling must declare '- 状态：Accepted' in docs/adr/0001-scheduling.md",
    ),
  );
  assert.ok(
    errors.includes(
      "governance invariant TASK-GEN-001 introducedBy must be a full 40-character lowercase commit SHA",
    ),
  );
});

test("evidence selectors must name actual JavaScript or Rust test declarations", () => {
  const catalog = validCatalog();
  catalog.assets[0].enforcement.evidence[0].selector = "comment only";
  catalog.assets[1].enforcement.evidence[0].selector = "ordinary string";
  catalog.assets[3].enforcement.evidence[0].selector = "rust_comment_only";
  catalog.assets[3].enforcement.evidence.push({
    path: "src-tauri/src/schema_tests.rs",
    selector: "rust_string_only",
  });
  catalog.assets[3].enforcement.evidence.push({
    path: "src-tauri/src/schema_tests.rs",
    selector: "upgrades_v1_fixture",
  });

  const errors = validate(catalog, {
    readFile: (path) => {
      if (path === "scripts/__tests__/architecture.test.mjs") {
        return [
          "// test(\"comment only\", () => {});",
          "const example = 'test(\"ordinary string\", () => {})';",
        ].join("\n");
      }
      if (path === "src/taskCoordinator.test.ts") {
        return [
          "const title = \"ordinary string\";",
          "test(title, () => {});",
          "it(`late generation cannot win`, () => {});",
        ].join("\n");
      }
      if (path === "src-tauri/src/schema_tests.rs") {
        return [
          "// #[test] fn rust_comment_only() {}",
          "const EXAMPLE: &str = r#\"#[tokio::test] async fn rust_string_only() {}\"#;",
          "#[tokio::test]",
          "async fn upgrades_v1_fixture() {}",
        ].join("\n");
      }
      return fileContents[path];
    },
  });

  assert.ok(
    errors.includes(
      "governance asset architecture-fact-source evidence selector is not an executable test declaration in scripts/__tests__/architecture.test.mjs: comment only",
    ),
  );
  assert.ok(
    errors.includes(
      "governance asset rule-scheduling evidence selector is not an executable test declaration in src/taskCoordinator.test.ts: ordinary string",
    ),
  );
  assert.ok(
    errors.includes(
      "governance asset core-schema-v1 evidence selector is not an executable test declaration in src-tauri/src/schema_tests.rs: rust_comment_only",
    ),
  );
  assert.ok(
    errors.includes(
      "governance asset core-schema-v1 evidence selector is not an executable test declaration in src-tauri/src/schema_tests.rs: rust_string_only",
    ),
  );
  assert.ok(
    !errors.some((error) => error.includes("upgrades_v1_fixture")),
    "a #[tokio::test] function must remain executable evidence",
  );
});

test("JavaScript evidence needs a non-empty function callback, not only a title", () => {
  const catalog = validCatalog();
  const errors = validate(catalog, {
    readFile: (path) => {
      if (path === "scripts/__tests__/architecture.test.mjs") {
        return [
          'test("protects layers");',
          'test("protects layers", () => {});',
          'test("protects layers", { skip: true }, () => { throw new Error("never"); });',
          'test.each([])("protects layers", () => { throw new Error("never"); });',
          'describe.each([])("decoy", () => { test("protects layers", () => assert.ok(true)); });',
        ].join("\n");
      }
      return fileContents[path];
    },
  });

  assert.ok(
    errors.includes(
      "governance asset architecture-fact-source evidence selector is not an executable test declaration in scripts/__tests__/architecture.test.mjs: protects layers",
    ),
  );

  assert.deepEqual(
    validate(catalog, {
      readFile: (path) =>
        path === "scripts/__tests__/architecture.test.mjs"
          ? 'test("protects layers", async function () { await verify(); }, 1000);'
          : fileContents[path],
    }),
    [],
  );
});

test("JavaScript evidence must be statically registered at file or suite scope", () => {
  const catalog = validCatalog();
  const decoyErrors = validate(catalog, {
    readFile: (path) =>
      path === "scripts/__tests__/architecture.test.mjs"
        ? [
            'if (false) test("protects layers", () => assert.ok(true));',
            'function decoy() { test("protects layers", () => assert.ok(true)); }',
          ].join("\n")
        : fileContents[path],
  });
  assert.ok(
    decoyErrors.includes(
      "governance asset architecture-fact-source evidence selector is not an executable test declaration in scripts/__tests__/architecture.test.mjs: protects layers",
    ),
  );

  assert.deepEqual(
    validate(catalog, {
      readFile: (path) =>
        path === "scripts/__tests__/architecture.test.mjs"
          ? 'describe("architecture", () => { test("protects layers", () => assert.ok(true)); });'
          : fileContents[path],
    }),
    [],
  );
});

test("tracked evidence outside a governed test runner cannot satisfy an invariant", () => {
  const catalog = validCatalog();
  catalog.assets[0].enforcement.evidence[0] = {
    path: "scripts/proof.test.mjs",
    selector: "protects layers",
  };
  const errors = validate(catalog, {
    trackedFiles: [...trackedFiles, "scripts/proof.test.mjs"],
    readFile: (path) =>
      path === "scripts/proof.test.mjs"
        ? 'test("protects layers", () => assert.ok(true));'
        : fileContents[path],
  });
  assert.ok(
    errors.includes(
      "governance asset architecture-fact-source evidence is not collected by a governed test runner: scripts/proof.test.mjs",
    ),
  );
});

test("Rust evidence must be reachable from the Cargo lib test root, not an orphan chain or cycle", () => {
  const catalog = validCatalog();
  catalog.assets[3].enforcement.evidence = [{
    path: "src-tauri/src/proof_tests.rs",
    selector: "orphan_proof",
  }];
  const carrier = [
    "#[cfg(test)]",
    '#[path = "proof_tests.rs"]',
    "mod proof_tests;",
  ].join("\n");
  const proof = "#[test]\nfn orphan_proof() {}\n";
  for (const isolatedFiles of [
    { "src-tauri/src/carrier_tests.rs": carrier, "src-tauri/src/proof_tests.rs": proof },
    {
      "src-tauri/src/carrier_tests.rs": carrier,
      "src-tauri/src/proof_tests.rs": [
        proof,
        "#[cfg(test)]",
        '#[path = "carrier_tests.rs"]',
        "mod carrier_tests;",
      ].join("\n"),
    },
  ]) {
    const errors = validate(catalog, {
      trackedFiles: [...trackedFiles, ...Object.keys(isolatedFiles)],
      readFile: (path) => isolatedFiles[path] ?? fileContents[path],
    });
    assert.ok(errors.includes(
      "governance asset core-schema-v1 evidence is not collected by a governed test runner: src-tauri/src/proof_tests.rs",
    ));
  }

  const reachableFiles = {
    "src-tauri/src/lib.rs": "mod carrier;\n",
    "src-tauri/src/carrier.rs": carrier,
    "src-tauri/src/proof_tests.rs": proof,
  };
  assert.deepEqual(validate(catalog, {
    trackedFiles: [...trackedFiles, "src-tauri/src/carrier.rs", "src-tauri/src/proof_tests.rs"],
    readFile: (path) => reachableFiles[path] ?? fileContents[path],
  }), []);
});

test("Rust evidence under a conditional cfg or cfg_attr ancestor is not executable", () => {
  const catalog = validCatalog();
  for (const source of [
    [
      '#[cfg(target_os = "windows")]',
      "mod unreachable {",
      "  #[test]",
      "  fn upgrades_v1_fixture() { assert!(true); }",
      "}",
    ],
    [
      '#[cfg_attr(target_os = "windows", ignore)]',
      "#[test]",
      "fn upgrades_v1_fixture() { assert!(true); }",
    ],
  ]) {
    const errors = validate(catalog, {
      readFile: (path) =>
        path === "src-tauri/src/schema_tests.rs"
          ? source.join("\n")
          : fileContents[path],
    });
    assert.ok(
      errors.includes(
        "governance asset core-schema-v1 evidence selector is not an executable test declaration in src-tauri/src/schema_tests.rs: upgrades_v1_fixture",
      ),
    );
  }
});

test("Rust evidence under cfg(unix) remains executable on the pinned macOS lanes", () => {
  const catalog = validCatalog();
  assert.deepEqual(
    validate(catalog, {
      readFile: (path) =>
        path === "src-tauri/src/schema_tests.rs"
          ? [
              "#[cfg(unix)]",
              "mod macos_runner_tests {",
              "  #[test]",
              "  fn upgrades_v1_fixture() { assert!(true); }",
              "}",
            ].join("\n")
          : fileContents[path],
    }),
    [],
  );
});

test("introducedBy requires a full lowercase SHA that resolves to a commit", () => {
  const malformed = validCatalog();
  malformed.invariants[0].introducedBy = "A".repeat(40);
  assert.ok(
    validate(malformed, { commitExists: () => true }).includes(
      "governance invariant TASK-GEN-001 introducedBy must be a full 40-character lowercase commit SHA",
    ),
  );

  const missing = validCatalog();
  missing.invariants[0].introducedBy = "b".repeat(40);
  assert.ok(
    validate(missing).includes(
      `governance invariant TASK-GEN-001 introducedBy commit does not exist: ${"b".repeat(40)}`,
    ),
  );
});

test("active and retiring invariants cannot be empty shells", () => {
  for (const status of ["active", "retiring"]) {
    const catalog = validCatalog();
    catalog.invariants[0].status = status;
    if (status === "retiring") {
      catalog.invariants[0].retirement = { reason: "foreground scheduling is being removed" };
    }
    catalog.invariants[0].gates = [];
    catalog.invariants[0].evidence = [];
    const errors = validate(catalog);
    assert.ok(errors.includes("governance invariant TASK-GEN-001 must name at least one gate"));
    assert.ok(errors.includes("governance invariant TASK-GEN-001 must name executable evidence"));
  }
});

test("principle coverage comes from active executable invariants, not catalog self-description", () => {
  const catalog = validCatalog();
  catalog.invariants[0].principles = [2, 3, 4];
  const errors = validate(catalog);
  assert.ok(errors.includes("governance principle 1 has no active executable invariant"));
  assert.ok(errors.includes("governance principle 5 has no active executable invariant"));
  assert.ok(errors.includes("governance principle 6 has no active executable invariant"));
  assert.ok(errors.includes("governance principle 7 has no active executable invariant"));
});

test("principle names and required global context assets cannot be rewritten or weakened", () => {
  const renamed = validCatalog();
  renamed.principles[0].name = "generic architecture";
  assert.ok(
    validate(renamed).includes(
      "governance principle 1 name must remain exactly: 架构、分层与依赖方向",
    ),
  );

  const weakened = validCatalog();
  weakened.assets.find((asset) => asset.id === "shared-glossary").alwaysLoad = false;
  assert.ok(
    validate(weakened).includes(
      "required global governance asset shared-glossary must remain active with alwaysLoad=true",
    ),
  );
  assert.ok(
    compareGovernanceAssetCatalogs(weakened, validCatalog()).includes(
      "active governance asset shared-glossary removed alwaysLoad=true",
    ),
  );
});

test("published fixture checksums are immutable", () => {
  const errors = validate(validCatalog(), {
    readFile: (path) =>
      path === "src-tauri/tests/fixtures/core-schema/v1.sql"
        ? "fixture-was-rewritten"
        : fileContents[path],
  });
  assert.ok(
    errors.includes(
      "fixture core-schema-v1 checksum changed: src-tauri/tests/fixtures/core-schema/v1.sql",
    ),
  );
});

test("fixture checksums hash raw bytes before any UTF-8 evidence decoding", () => {
  const firstInvalidUtf8 = Buffer.from([0x80]);
  const secondInvalidUtf8 = Buffer.from([0x81]);
  assert.equal(firstInvalidUtf8.toString("utf8"), secondInvalidUtf8.toString("utf8"));
  const catalog = validCatalog();
  const fixture = catalog.assets.find((asset) => asset.id === "core-schema-v1");
  fixture.checksum = `sha256:${createHash("sha256").update(firstInvalidUtf8).digest("hex")}`;
  const readFixture = (bytes) => (path) =>
    path === fixture.path ? bytes : fileContents[path];

  assert.ok(
    !validate(catalog, { readFile: readFixture(firstInvalidUtf8) }).some((error) =>
      error.includes("fixture core-schema-v1 checksum changed"),
    ),
  );
  assert.ok(
    validate(catalog, { readFile: readFixture(secondInvalidUtf8) }).includes(
      "fixture core-schema-v1 checksum changed: src-tauri/tests/fixtures/core-schema/v1.sql",
    ),
  );
});

test("human context budgets are executable, globally tighter, and cannot grow against base", () => {
  const oversized = validCatalog();
  const longArchitecture = `${"architecture\n".repeat(160)}overflow`;
  assert.ok(
    validate(oversized, {
      readFile: (path) =>
        path === "docs/engineering/architecture.md" ? longArchitecture : fileContents[path],
    }).includes(
      "human context docs/engineering/architecture.md exceeds maxLines 160: 161",
    ),
  );

  const looseGlobal = validCatalog();
  looseGlobal.contextBudgets.alwaysLoad = { ...looseGlobal.contextBudgets.default };
  const looseErrors = validate(looseGlobal);
  assert.ok(looseErrors.includes("alwaysLoad context maxLines must be tighter than the default"));
  assert.ok(looseErrors.includes("alwaysLoad context maxBytes must be tighter than the default"));

  const base = validCatalog();
  base.contextBudgets.hotspots = [
    {
      path: "docs/engineering/architecture.md",
      maxLines: 200,
      maxBytes: 16000,
      reason: "legacy architecture context",
    },
  ];
  const grown = structuredClone(base);
  grown.contextBudgets.default.maxLines += 1;
  grown.contextBudgets.hotspots[0].maxBytes += 1;
  assert.deepEqual(compareGovernanceAssetCatalogs(grown, base), [
    "context budget default.maxLines cannot increase",
    "context hotspot docs/engineering/architecture.md maxBytes cannot increase",
  ]);

  const newlyBlessed = validCatalog();
  newlyBlessed.contextBudgets.hotspots = structuredClone(base.contextBudgets.hotspots);
  assert.ok(
    compareGovernanceAssetCatalogs(newlyBlessed, validCatalog()).includes(
      "existing context asset cannot gain a new hotspot: docs/engineering/architecture.md",
    ),
  );

  const tightenedToDefault = structuredClone(base);
  tightenedToDefault.contextBudgets.hotspots = [];
  assert.ok(
    !compareGovernanceAssetCatalogs(tightenedToDefault, base).some((error) =>
      error.startsWith("context hotspot"),
    ),
  );
});

test("declared gates must transitively execute each evidence runner", () => {
  const mismatched = validCatalog();
  mismatched.gates.push({
    id: "security",
    status: "active",
    kind: "workflow",
    ref: ".github/workflows/security.yml",
  });
  mismatched.assets.find((asset) => asset.id === "architecture-fact-source").enforcement.gates = [
    "security",
  ];
  assert.ok(
    validate(mismatched, {
      trackedFiles: [...trackedFiles, ".github/workflows/security.yml"],
      readFile: (path) =>
        path === ".github/workflows/security.yml"
          ? "# run: npm run verify\nname: comment-only decoy\n"
          : fileContents[path],
    }).includes(
      "governance asset architecture-fact-source evidence runner node-test:scripts is not executed by any declared gate: scripts/__tests__/architecture.test.mjs",
    ),
  );

  assert.ok(
    !validate(mismatched, {
      trackedFiles: [...trackedFiles, ".github/workflows/security.yml"],
      readFile: (path) =>
        path === ".github/workflows/security.yml"
          ? "jobs:\n  test:\n    steps:\n      - run: npm run verify\n"
          : fileContents[path],
    }).some((error) => error.includes("evidence runner node-test:scripts")),
  );

  const brokenPlan = validCatalog();
  assert.ok(
    validate(brokenPlan, {
      readFile: (path) =>
        path === "docs/engineering/verify-plan.json"
          ? JSON.stringify({ steps: [{ command: "cargo", args: ["test"] }] })
          : fileContents[path],
    }).includes(
      "governance asset architecture-fact-source evidence runner node-test:scripts is not executed by any declared gate: scripts/__tests__/architecture.test.mjs",
    ),
  );
});

test("context selection loads global assets and only matching Rules, ADRs, and invariants", () => {
  const globalAssets = [
    "architecture-fact-source",
    "contribution-contract",
    "maintainability-system",
    "shared-glossary",
  ];
  assert.deepEqual(
    selectGovernanceContext(validCatalog(), ["src/taskCoordinator.ts"]),
    {
      assets: ["adr-scheduling", ...globalAssets, "rule-scheduling"].sort(),
      invariants: ["TASK-GEN-001"],
    },
  );
  assert.deepEqual(selectGovernanceContext(validCatalog(), ["README.md"]), {
    assets: globalAssets,
    invariants: [],
  });
  assert.deepEqual(selectGovernanceContext(validCatalog(), ["src-tauri/src/lib.rs"]), {
    assets: ["adr-scheduling", ...globalAssets, "rule-scheduling"].sort(),
    invariants: ["TASK-GEN-001"],
  });
  assert.deepEqual(selectGovernanceContext(validCatalog(), ["docs/rules/scheduling.md"]), {
    assets: ["adr-scheduling", ...globalAssets, "rule-scheduling"].sort(),
    invariants: ["TASK-GEN-001"],
  });
  assert.deepEqual(selectGovernanceContext(validCatalog(), ["docs/adr/0001-scheduling.md"]), {
    assets: ["adr-scheduling", ...globalAssets, "rule-scheduling"].sort(),
    invariants: ["TASK-GEN-001"],
  });
  assert.deepEqual(selectGovernanceContext(validCatalog(), ["src/taskCoordinator.test.ts"]), {
    assets: ["adr-scheduling", ...globalAssets, "rule-scheduling"].sort(),
    invariants: ["TASK-GEN-001"],
  });
});

test("the PR template keeps the Bug learning and cost-budget evidence fields", () => {
  const valid = [
    "## 变更类型",
    "Bug 修复",
    "非 Bug 变更",
    "## 变更目的",
    "用户问题/产品价值",
    "非目标",
    "验收层",
    "## 可复现证据",
    "## 根因与同类扫描",
    "## 状态与权限预算",
    "## Rule / ADR / Invariant",
    "## Skip / flaky 债务",
    "## 验证",
    "已复审资产/高风险不变量 ID：",
    "`npm run verify`",
    "与本变更相关的独立 lane（coverage/E2E/MSRV/性能/Release）已运行，结果/链接：",
    "独立 lane 不适用，原因：",
    "没有秘密、真实用户数据、`AGENTS.md`、`docs/internal/` 或宣传草稿进入 diff",
  ].join("\n");
  assert.deepEqual(validatePullRequestTemplate(valid), []);
  assert.deepEqual(validatePullRequestTemplate(valid.replace("## 根因与同类扫描", "")), [
    "pull request template is missing required evidence marker: ## 根因与同类扫描",
  ]);
  for (const marker of [
    "## 变更类型",
    "Bug 修复",
    "非 Bug 变更",
    "用户问题/产品价值",
    "非目标",
    "验收层",
  ]) {
    assert.deepEqual(validatePullRequestTemplate(valid.replace(marker, "")), [
      `pull request template is missing required evidence marker: ${marker}`,
    ]);
  }
});
