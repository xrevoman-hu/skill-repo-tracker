import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  compareGovernanceAssetCatalogs,
  selectGovernanceContext,
} from "../governance-assets.mjs";

import { fileContents, trackedFiles, validCatalog, validate } from "./governance-assets-fixtures.mjs";

test("active assets, fixtures, gates, and invariants cannot be weakened against the base", () => {
  const base = validCatalog();
  const current = validCatalog();
  current.gates = current.gates.filter((gate) => gate.id !== "weekly");
  current.gates.find((gate) => gate.id === "verify").ref = "test";
  current.assets.find((asset) => asset.id === "rule-scheduling").reviewOnChange = [
    "src/taskCoordinator.ts",
  ];
  current.assets.find((asset) => asset.id === "core-schema-v1").checksum =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  current.invariants[0].protectedPaths = ["src/taskCoordinator.ts"];
  current.invariants[0].evidence = [];

  assert.deepEqual(compareGovernanceAssetCatalogs(current, base), [
    "active governance asset rule-scheduling removed review selector: src-tauri/src/",
    "active governance gate was removed without first entering retirement: weekly",
    "active governance invariant TASK-GEN-001 removed evidence: src/taskCoordinator.test.ts#late generation cannot win",
    "active governance invariant TASK-GEN-001 removed protected path: src-tauri/src/",
    "governance gate verify ref changed from verify to test",
    "published fixture checksum changed in the catalog: core-schema-v1",
  ]);
});

test("retirement transitions keep evidence until the next base and gate retirement is staged", () => {
  const base = validCatalog();
  const current = validCatalog();
  current.invariants[0].status = "retiring";
  current.invariants[0].retirement = { reason: "foreground scheduling is being removed" };
  current.invariants[0].gates = [];
  current.invariants[0].evidence = [];
  current.gates.find((gate) => gate.id === "weekly").status = "retired";
  current.gates.find((gate) => gate.id === "weekly").retirement = {
    reason: "weekly resilience moved to a replacement service",
  };

  assert.deepEqual(compareGovernanceAssetCatalogs(current, base), [
    "active governance gate weekly cannot skip directly to retired",
    "governance invariant TASK-GEN-001 removed evidence during retirement: src/taskCoordinator.test.ts#late generation cannot win",
    "governance invariant TASK-GEN-001 removed gate during retirement: verify",
    "governance invariant TASK-GEN-001 removed gate during retirement: weekly",
  ]);

  const retiringBase = validCatalog();
  retiringBase.gates.find((gate) => gate.id === "weekly").status = "retiring";
  retiringBase.gates.find((gate) => gate.id === "weekly").retirement = {
    reason: "weekly resilience moved to a replacement service",
  };
  const retired = structuredClone(retiringBase);
  retired.gates.find((gate) => gate.id === "weekly").status = "retired";
  assert.deepEqual(compareGovernanceAssetCatalogs(retired, retiringBase), []);
  const removed = structuredClone(retired);
  removed.gates = removed.gates.filter((gate) => gate.id !== "weekly");
  assert.deepEqual(compareGovernanceAssetCatalogs(removed, retired), [
    "retired governance gate tombstone was removed: weekly",
  ]);

  const reused = structuredClone(removed);
  reused.gates.push({
    id: "weekly",
    kind: "package-script",
    ref: "test",
    status: "active",
    capabilities: ["weekly-resilience"],
  });
  assert.deepEqual(compareGovernanceAssetCatalogs(reused, retired), [
    "governance gate weekly kind changed from workflow to package-script",
    "governance gate weekly ref changed from .github/workflows/weekly.yml to test",
    "governance gate weekly retirement metadata changed",
    "retired governance gate weekly cannot return to active",
  ]);
});

test("a referenced gate retires only after every owner moves to its active replacement", () => {
  const base = validCatalog();
  const announced = structuredClone(base);
  const weekly = announced.gates.find((gate) => gate.id === "weekly");
  weekly.status = "retiring";
  weekly.retirement = {
    reason: "weekly evidence is now covered by verify",
    replacement: "verify",
  };
  assert.deepEqual(compareGovernanceAssetCatalogs(announced, base), []);

  const migrated = structuredClone(announced);
  const scheduling = migrated.assets.find((asset) => asset.id === "rule-scheduling");
  scheduling.enforcement.gates = scheduling.enforcement.gates.filter(
    (gate) => gate !== "weekly",
  );
  migrated.invariants[0].gates = migrated.invariants[0].gates.filter(
    (gate) => gate !== "weekly",
  );
  assert.deepEqual(compareGovernanceAssetCatalogs(migrated, announced), []);

  const retired = structuredClone(migrated);
  retired.gates.find((gate) => gate.id === "weekly").status = "retired";
  assert.deepEqual(compareGovernanceAssetCatalogs(retired, migrated), []);
});

test("gate retirement requires an active replacement chain or ADR-backed removal", () => {
  const missing = validCatalog();
  const missingGate = missing.gates.find((gate) => gate.id === "weekly");
  missingGate.status = "retiring";
  missingGate.retirement = { reason: "move the lane", replacement: "missing" };
  assert.ok(
    validate(missing).includes(
      "retiring governance gate weekly replacement chain references missing gate: missing",
    ),
  );

  const removed = validCatalog();
  const removedGate = removed.gates.find((gate) => gate.id === "weekly");
  removedGate.status = "retiring";
  removedGate.retirement = {
    reason: "the governed feature and lane were removed",
    featureRemoved: true,
    removalDecision: "adr-scheduling",
  };
  assert.ok(
    !validate(removed).some((error) => error.includes("governance gate weekly retirement")),
  );
});

test("retirement and supersession history cannot be rewritten after reaching the base", () => {
  const base = validCatalog();
  const baseGate = base.gates.find((gate) => gate.id === "weekly");
  baseGate.status = "retiring";
  baseGate.retirement = { reason: "weekly evidence moved", replacement: "verify" };
  base.invariants[0].status = "retiring";
  base.invariants[0].retirement = {
    reason: "foreground scheduling is being removed",
    replacement: "TASK-NEXT-002",
  };
  base.invariants.push({
    ...structuredClone(base.invariants[0]),
    id: "TASK-NEXT-002",
    status: "active",
    retirement: undefined,
  });
  const baseAsset = base.assets.find((asset) => asset.id === "adr-scheduling");
  baseAsset.status = "superseded";
  baseAsset.supersededBy = "architecture-fact-source";

  const current = structuredClone(base);
  const currentGate = current.gates.find((gate) => gate.id === "weekly");
  currentGate.status = "active";
  currentGate.retirement = { reason: "keep forever" };
  current.invariants[0].status = "active";
  current.invariants[0].retireWhen = "never";
  current.invariants[0].retirement = {
    reason: "different history",
    replacement: "TASK-NEXT-002",
  };
  const currentAsset = current.assets.find((asset) => asset.id === "adr-scheduling");
  currentAsset.status = "active";
  currentAsset.supersededBy = "rule-scheduling";

  const errors = compareGovernanceAssetCatalogs(current, base);
  assert.ok(errors.includes("retiring governance gate weekly cannot return to active"));
  assert.ok(errors.includes("governance gate weekly retirement metadata changed"));
  assert.ok(errors.includes("superseded governance asset adr-scheduling cannot return to active"));
  assert.ok(errors.includes("superseded governance asset adr-scheduling changed supersededBy"));
  assert.ok(errors.includes("retiring governance invariant TASK-GEN-001 cannot return to active"));
  assert.ok(errors.includes("governance invariant TASK-GEN-001 retireWhen changed"));
  assert.ok(errors.includes("governance invariant TASK-GEN-001 retirement metadata changed"));
});

test("published fixture assets are append-only and can never be superseded or removed", () => {
  const superseded = validCatalog();
  const fixture = superseded.assets.find((asset) => asset.id === "core-schema-v1");
  fixture.status = "superseded";
  fixture.supersededBy = "architecture-fact-source";
  assert.ok(
    validate(superseded).includes("published fixture core-schema-v1 must remain active forever"),
  );

  const removed = validCatalog();
  removed.assets = removed.assets.filter((asset) => asset.id !== "core-schema-v1");
  assert.deepEqual(compareGovernanceAssetCatalogs(removed, validCatalog()), [
    "published fixture asset was removed: core-schema-v1",
  ]);
});

test("accepted ADR bytes are immutable and changes require a new superseding ADR", () => {
  const missingChecksum = validCatalog();
  delete missingChecksum.assets.find((asset) => asset.id === "adr-scheduling").checksum;
  assert.ok(
    validate(missingChecksum).includes(
      "decision adr-scheduling must declare a sha256 checksum",
    ),
  );

  const rewrittenBytes = "# ADR\n\n- 状态：Accepted\n\nRewritten in place.\n";
  assert.ok(
    validate(validCatalog(), {
      readFile: (path) =>
        path === "docs/adr/0001-scheduling.md" ? rewrittenBytes : fileContents[path],
    }).includes(
      "decision adr-scheduling checksum changed: docs/adr/0001-scheduling.md",
    ),
  );

  const rewrittenCatalog = validCatalog();
  rewrittenCatalog.assets.find((asset) => asset.id === "adr-scheduling").checksum =
    `sha256:${createHash("sha256").update(rewrittenBytes).digest("hex")}`;
  assert.ok(
    compareGovernanceAssetCatalogs(rewrittenCatalog, validCatalog()).includes(
      "accepted decision checksum changed in the catalog: adr-scheduling",
    ),
  );

  const superseded = validCatalog();
  const previous = superseded.assets.find((asset) => asset.id === "adr-scheduling");
  previous.status = "superseded";
  previous.supersededBy = "adr-scheduling-v2";
  const replacementPath = "docs/adr/0002-scheduling.md";
  const replacementContents = "# ADR 2\n\n- 状态：Accepted\n\nNew decision.\n";
  superseded.assets.push({
    ...structuredClone(previous),
    id: "adr-scheduling-v2",
    path: replacementPath,
    status: "active",
    supersededBy: undefined,
    checksum: `sha256:${createHash("sha256").update(replacementContents).digest("hex")}`,
  });

  assert.deepEqual(compareGovernanceAssetCatalogs(superseded, validCatalog()), []);
  assert.deepEqual(
    validate(superseded, {
      trackedFiles: [...trackedFiles, replacementPath],
      readFile: (path) =>
        path === replacementPath ? replacementContents : fileContents[path],
    }),
    [],
  );
});

test("active assets and invariants require an explicit supersede or retiring step before deletion", () => {
  const base = validCatalog();
  const current = validCatalog();
  current.assets = current.assets.filter((asset) => asset.id !== "adr-scheduling");
  current.invariants = [];

  assert.deepEqual(compareGovernanceAssetCatalogs(current, base), [
    "active governance asset was removed without first being superseded: adr-scheduling",
    "active governance invariant was removed without first entering retirement: TASK-GEN-001",
  ]);
});

test("retiring invariants remain append-only tombstones across path moves and replacements", () => {
  const base = validCatalog();
  base.invariants[0].status = "retiring";
  base.invariants[0].retirement = { reason: "foreground scheduling is being removed" };
  const removed = structuredClone(base);
  removed.invariants = [];

  assert.deepEqual(
    compareGovernanceAssetCatalogs(removed, base),
    ["retiring governance invariant tombstone was removed: TASK-GEN-001"],
  );

  base.invariants[0].retirement.replacement = "TASK-NEXT-002";
  const replaced = structuredClone(removed);
  replaced.invariants = [
    {
      ...structuredClone(base.invariants[0]),
      id: "TASK-NEXT-002",
      status: "active",
      retirement: undefined,
    },
  ];
  assert.deepEqual(
    compareGovernanceAssetCatalogs(replaced, base),
    ["retiring governance invariant tombstone was removed: TASK-GEN-001"],
  );

  const beforeMove = validCatalog();
  beforeMove.invariants[0].protectedPaths = ["src/old-task-path.ts"];
  const afterMove = structuredClone(beforeMove);
  afterMove.invariants[0].status = "retiring";
  afterMove.invariants[0].retirement = { reason: "the owned task path moved" };
  assert.deepEqual(compareGovernanceAssetCatalogs(afterMove, beforeMove), []);
  assert.ok(
    !validate(afterMove).some((error) =>
      error.includes("protected path matches no tracked file: src/old-task-path.ts"),
    ),
  );
  const prematureRetirement = structuredClone(afterMove);
  prematureRetirement.invariants[0].status = "retired";
  assert.ok(
    compareGovernanceAssetCatalogs(prematureRetirement, afterMove, { trackedPaths: [] }).includes(
      "retiring governance invariant TASK-GEN-001 cannot become retired without a complete active replacement or ADR-backed feature removal with no protected paths remaining",
    ),
  );

  const approvedMove = structuredClone(afterMove);
  approvedMove.invariants[0].retirement = {
    reason: "the owned task feature was removed",
    featureRemoved: true,
    removalDecision: "adr-scheduling",
  };
  assert.deepEqual(compareGovernanceAssetCatalogs(approvedMove, beforeMove), []);
  const afterSecondPr = structuredClone(approvedMove);
  afterSecondPr.invariants[0].status = "retired";
  assert.deepEqual(
    compareGovernanceAssetCatalogs(afterSecondPr, approvedMove, { trackedPaths: trackedFiles }),
    [],
  );
  assert.ok(
    compareGovernanceAssetCatalogs(afterSecondPr, approvedMove, {
      trackedPaths: [...trackedFiles, "src/old-task-path.ts"],
    }).includes(
      "retiring governance invariant TASK-GEN-001 cannot become retired without a complete active replacement or ADR-backed feature removal with no protected paths remaining",
    ),
  );
  assert.deepEqual(
    selectGovernanceContext(afterSecondPr, ["src/old-task-path.ts"]).invariants,
    [],
  );

  const removedRetired = structuredClone(afterSecondPr);
  removedRetired.invariants = [];
  assert.deepEqual(compareGovernanceAssetCatalogs(removedRetired, afterSecondPr), [
    "retired governance invariant tombstone was removed: TASK-GEN-001",
  ]);
  const rewrittenRetired = structuredClone(afterSecondPr);
  rewrittenRetired.invariants[0].retirement.reason = "rewritten history";
  assert.ok(
    compareGovernanceAssetCatalogs(rewrittenRetired, afterSecondPr).includes(
      "retired governance invariant TASK-GEN-001 record changed",
    ),
  );

  const skipped = validCatalog();
  skipped.invariants[0].status = "retired";
  skipped.invariants[0].retirement = { reason: "skip the required retiring stage" };
  assert.ok(
    compareGovernanceAssetCatalogs(skipped, validCatalog()).includes(
      "active governance invariant TASK-GEN-001 cannot skip directly to retired",
    ),
  );
});

test("replacement assets and invariants must preserve the complete governed surface", () => {
  const catalog = validCatalog();
  const asset = catalog.assets.find((item) => item.id === "adr-scheduling");
  asset.status = "superseded";
  asset.supersededBy = "architecture-fact-source";
  const assetErrors = validate(catalog);
  assert.ok(
    assetErrors.includes(
      "superseded governance asset adr-scheduling has incomplete replacement: kind decision is not covered by architecture",
    ),
  );
  assert.ok(
    assetErrors.some((error) =>
      error.includes(
        "superseded governance asset adr-scheduling has incomplete replacement: review selector is not covered:",
      )),
  );

  const base = validCatalog();
  const previous = base.invariants[0];
  previous.status = "retiring";
  previous.retirement = {
    reason: "move the contract to a new invariant",
    replacement: "TASK-NEXT-002",
  };
  base.invariants.push(
    {
      ...structuredClone(previous),
      id: "TASK-NEXT-002",
      status: "active",
      retirement: undefined,
      protectedPaths: ["src/taskCoordinator.ts"],
      gates: ["verify"],
    },
  );
  const invariantErrors = validate(base);
  assert.ok(
    invariantErrors.includes(
      "governance invariant TASK-GEN-001 retirement replacement is incomplete: protected path is not covered: src-tauri/src/",
    ),
  );
  assert.ok(
    invariantErrors.includes(
      "governance invariant TASK-GEN-001 retirement replacement is incomplete: gate is not covered: weekly",
    ),
  );
});

test("ADR-backed invariant migrations preserve history across path and evidence renames", () => {
  const announced = validCatalog();
  const previous = announced.invariants[0];
  previous.status = "retiring";
  previous.retirement = {
    reason: "the task coordinator was split into a renamed module",
    replacement: "TASK-GEN-002",
    migration: {
      decision: "adr-scheduling",
      protectedPaths: [
        { from: "src/taskCoordinator.ts", to: "src/taskCoordinatorV2.ts" },
      ],
      evidence: [
        {
          from: {
            path: "src/taskCoordinator.test.ts",
            selector: "late generation cannot win",
          },
          to: {
            path: "src/taskCoordinatorV2.test.ts",
            selector: "late generation still cannot win",
          },
        },
      ],
    },
  };
  announced.invariants.push({
    ...structuredClone(previous),
    id: "TASK-GEN-002",
    status: "active",
    retirement: undefined,
    protectedPaths: ["src/taskCoordinatorV2.ts", "src-tauri/src/"],
    evidence: [
      {
        path: "src/taskCoordinatorV2.test.ts",
        selector: "late generation still cannot win",
      },
    ],
  });

  const retired = structuredClone(announced);
  retired.invariants[0].status = "retired";
  assert.deepEqual(compareGovernanceAssetCatalogs(retired, announced), []);

  const unauthorized = structuredClone(announced);
  unauthorized.invariants[0].retirement.migration.decision = "missing-decision";
  assert.ok(
    validate(unauthorized, {
      trackedFiles: [
        ...trackedFiles,
        "src/taskCoordinatorV2.ts",
        "src/taskCoordinatorV2.test.ts",
      ],
      readFile: (path) =>
        path === "src/taskCoordinatorV2.ts"
          ? "export const task = true;\n"
          : path === "src/taskCoordinatorV2.test.ts"
            ? 'test("late generation still cannot win", () => expect(true).toBe(true));\n'
            : fileContents[path],
    }).includes(
      "governance invariant TASK-GEN-001 retirement migration is invalid: migration decision must reference a different active decision asset",
    ),
  );

  const malformed = structuredClone(announced);
  malformed.invariants[0].retirement.migration.evidence = [{ from: null, to: null }];
  assert.ok(
    validate(malformed).some((error) =>
      error.includes("migration evidence entries must declare concrete from and to values"),
    ),
  );

  const unapproved = structuredClone(announced);
  unapproved.invariants[0].retirement.migration = undefined;
  const unapprovedRetired = structuredClone(unapproved);
  unapprovedRetired.invariants[0].status = "retired";
  assert.ok(
    compareGovernanceAssetCatalogs(unapprovedRetired, unapproved).some((error) =>
      error.includes("cannot become retired without a complete active replacement"),
    ),
  );
});

test("ADR-backed asset migrations preserve Rule selectors and evidence across renames", () => {
  const base = validCatalog();
  const current = structuredClone(base);
  const previous = current.assets.find((asset) => asset.id === "rule-scheduling");
  previous.status = "superseded";
  previous.supersededBy = "rule-scheduling-v2";
  previous.migration = {
    decision: "adr-scheduling",
    reviewSelectors: [
      { from: "src/taskCoordinator.ts", to: "src/taskCoordinatorV2.ts" },
    ],
    evidence: [
      {
        from: {
          path: "src/taskCoordinator.test.ts",
          selector: "late generation cannot win",
        },
        to: {
          path: "src/taskCoordinatorV2.test.ts",
          selector: "late generation still cannot win",
        },
      },
    ],
  };
  current.assets.push({
    ...structuredClone(previous),
    id: "rule-scheduling-v2",
    path: "docs/rules/scheduling-v2.md",
    status: "active",
    supersededBy: undefined,
    migration: undefined,
    reviewOnChange: ["src/taskCoordinatorV2.ts", "src-tauri/src/"],
    enforcement: {
      ...structuredClone(previous.enforcement),
      evidence: [
        {
          path: "src/taskCoordinatorV2.test.ts",
          selector: "late generation still cannot win",
        },
      ],
    },
  });
  assert.ok(
    !compareGovernanceAssetCatalogs(current, base).some((error) =>
      error.includes("rule-scheduling has incomplete replacement"),
    ),
  );

  const unapproved = structuredClone(current);
  unapproved.assets.find((asset) => asset.id === "rule-scheduling").migration = undefined;
  assert.ok(
    compareGovernanceAssetCatalogs(unapproved, base).some((error) =>
      error.includes("rule-scheduling has incomplete replacement"),
    ),
  );
});

test("asset replacement chains are acyclic, terminate active, and cover every old asset", () => {
  const catalog = validCatalog();
  const first = catalog.assets.find((asset) => asset.id === "adr-scheduling");
  first.status = "superseded";
  first.supersededBy = "adr-scheduling-v2";
  const second = {
    ...structuredClone(first),
    id: "adr-scheduling-v2",
    path: "docs/adr/0002-scheduling.md",
    supersededBy: "adr-scheduling-v3",
  };
  const final = {
    ...structuredClone(first),
    id: "adr-scheduling-v3",
    path: "docs/adr/0003-scheduling.md",
    status: "active",
    supersededBy: undefined,
  };
  catalog.assets.push(second, final);
  const chainPaths = ["docs/adr/0002-scheduling.md", "docs/adr/0003-scheduling.md"];
  const readChainFile = (path) =>
    chainPaths.includes(path) ? "# ADR\n\n- 状态：Accepted\n" : fileContents[path];

  assert.deepEqual(
    validate(catalog, {
      trackedFiles: [...trackedFiles, ...chainPaths],
      readFile: readChainFile,
    }),
    [],
  );

  const cyclic = structuredClone(catalog);
  const cyclicFinal = cyclic.assets.find((asset) => asset.id === "adr-scheduling-v3");
  cyclicFinal.status = "superseded";
  cyclicFinal.supersededBy = "adr-scheduling";
  assert.ok(
    validate(cyclic, {
      trackedFiles: [...trackedFiles, ...chainPaths],
      readFile: readChainFile,
    }).includes(
      "superseded governance asset adr-scheduling replacement chain is cyclic: adr-scheduling -> adr-scheduling-v2 -> adr-scheduling-v3 -> adr-scheduling",
    ),
  );

  const missing = structuredClone(catalog);
  missing.assets.find((asset) => asset.id === "adr-scheduling-v2").supersededBy = "missing";
  assert.ok(
    validate(missing, {
      trackedFiles: [...trackedFiles, ...chainPaths],
      readFile: readChainFile,
    }).includes(
      "superseded governance asset adr-scheduling replacement chain references missing asset: missing",
    ),
  );
});

test("superseded records are immutable while a later replacement may extend the complete chain", () => {
  const base = validCatalog();
  const first = base.assets.find((asset) => asset.id === "adr-scheduling");
  first.status = "superseded";
  first.supersededBy = "adr-scheduling-v2";
  base.assets.push({
    ...structuredClone(first),
    id: "adr-scheduling-v2",
    path: "docs/adr/0002-scheduling.md",
    status: "active",
    supersededBy: undefined,
  });

  const chained = structuredClone(base);
  const second = chained.assets.find((asset) => asset.id === "adr-scheduling-v2");
  second.status = "superseded";
  second.supersededBy = "adr-scheduling-v3";
  chained.assets.push({
    ...structuredClone(second),
    id: "adr-scheduling-v3",
    path: "docs/adr/0003-scheduling.md",
    status: "active",
    supersededBy: undefined,
  });
  assert.deepEqual(compareGovernanceAssetCatalogs(chained, base), []);

  const rewritten = structuredClone(chained);
  rewritten.assets.find((asset) => asset.id === "adr-scheduling").historicalNote = "rewritten";
  assert.ok(
    compareGovernanceAssetCatalogs(rewritten, base).includes(
      "superseded governance asset adr-scheduling record changed",
    ),
  );

  const removed = structuredClone(chained);
  removed.assets = removed.assets.filter((asset) => asset.id !== "adr-scheduling");
  assert.ok(
    compareGovernanceAssetCatalogs(removed, base).includes(
      "superseded governance asset record was removed: adr-scheduling",
    ),
  );

  const incomplete = structuredClone(chained);
  incomplete.assets.find((asset) => asset.id === "adr-scheduling-v3").reviewOnChange = [];
  const gaps = compareGovernanceAssetCatalogs(incomplete, base);
  assert.ok(
    gaps.includes(
      "superseded governance asset adr-scheduling has incomplete replacement: review selector is not covered: src/taskCoordinator.ts",
    ),
  );
  assert.ok(
    gaps.includes(
      "superseded governance asset adr-scheduling-v2 has incomplete replacement: review selector is not covered: src/taskCoordinator.ts",
    ),
  );
});

test("context hotspot budgets follow asset replacement chains without growing", () => {
  const base = validCatalog();
  base.contextBudgets.hotspots = [
    {
      path: "docs/engineering/architecture.md",
      maxLines: 200,
      maxBytes: 16000,
      reason: "legacy architecture context",
    },
  ];
  const replaced = structuredClone(base);
  const oldArchitecture = replaced.assets.find(
    (asset) => asset.id === "architecture-fact-source",
  );
  oldArchitecture.status = "superseded";
  oldArchitecture.supersededBy = "architecture-fact-source-v2";
  replaced.assets.push({
    ...structuredClone(oldArchitecture),
    id: "architecture-fact-source-v2",
    path: "docs/engineering/architecture-v2.md",
    status: "active",
    supersededBy: undefined,
  });
  replaced.contextBudgets.hotspots = [
    {
      path: "docs/engineering/architecture-v2.md",
      maxLines: 201,
      maxBytes: 16001,
      reason: "legacy architecture context",
    },
  ];
  const errors = compareGovernanceAssetCatalogs(replaced, base);
  assert.ok(
    errors.includes(
      "context hotspot docs/engineering/architecture.md replacement docs/engineering/architecture-v2.md maxLines cannot increase",
    ),
  );
  assert.ok(
    errors.includes(
      "context hotspot docs/engineering/architecture.md replacement docs/engineering/architecture-v2.md maxBytes cannot increase",
    ),
  );

  replaced.contextBudgets.hotspots[0].maxLines = 200;
  replaced.contextBudgets.hotspots[0].maxBytes = 16000;
  assert.ok(
    !compareGovernanceAssetCatalogs(replaced, base).some((error) =>
      error.startsWith("context hotspot"),
    ),
  );
  replaced.contextBudgets.hotspots = [];
  assert.ok(
    !compareGovernanceAssetCatalogs(replaced, base).some((error) =>
      error.startsWith("context hotspot"),
    ),
  );
});

test("retiring invariants remain reviewable and require a concrete reason", () => {
  const catalog = validCatalog();
  catalog.invariants[0].status = "retiring";
  catalog.invariants[0].retirement = { reason: "foreground scheduling is being removed" };
  catalog.invariants.push({
    ...structuredClone(catalog.invariants[0]),
    id: "ARCH-COVER-001",
    status: "active",
    retirement: undefined,
    protectedPaths: ["docs/engineering/architecture.md"],
  });

  assert.deepEqual(validate(catalog), []);
  assert.deepEqual(
    selectGovernanceContext(catalog, ["src/taskCoordinator.ts"]).invariants,
    ["TASK-GEN-001"],
  );

  delete catalog.invariants[0].retirement;
  assert.ok(
    validate(catalog).includes(
      "retiring governance invariant TASK-GEN-001 must declare a retirement reason",
    ),
  );
});

test("catalog lifecycle metadata is valid before it becomes immutable history", () => {
  const catalog = validCatalog();
  catalog.gates[0].retirement = { reason: "hidden future rewrite" };
  catalog.assets[2].status = "superseded";
  catalog.assets[2].supersededBy = "missing-asset";
  catalog.invariants[0].retirement = { reason: "hidden future rewrite" };

  const errors = validate(catalog);
  assert.ok(errors.includes("active governance gate verify cannot declare retirement metadata"));
  assert.ok(
    errors.includes(
      "superseded governance asset adr-scheduling replacement chain references missing asset: missing-asset",
    ),
  );
  assert.ok(
    errors.includes("active governance invariant TASK-GEN-001 cannot declare retirement metadata"),
  );
});

test("new catalog records must enter lifecycle as active instead of fabricating history", () => {
  const base = validCatalog();
  const current = structuredClone(base);
  current.gates.push({
    id: "fabricated-gate",
    kind: "package-script",
    ref: "verify",
    status: "retired",
    retirement: { reason: "never existed", replacement: "verify" },
  });
  current.assets.push({
    ...structuredClone(current.assets[2]),
    id: "fabricated-asset",
    path: "docs/adr/fabricated.md",
    status: "superseded",
    supersededBy: "adr-scheduling",
  });
  current.invariants.push({
    ...structuredClone(current.invariants[0]),
    id: "TASK-FAKE-002",
    status: "retiring",
    retirement: { reason: "never existed" },
  });
  assert.deepEqual(compareGovernanceAssetCatalogs(current, base), [
    "new governance asset fabricated-asset must enter lifecycle as active",
    "new governance gate fabricated-gate must enter lifecycle as active",
    "new governance invariant TASK-FAKE-002 must enter lifecycle as active",
  ]);
});
