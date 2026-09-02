import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";

import { canonicalCommandInvocations } from "./static-command-policy.mjs";

function evidenceKey(item) {
  return `${item?.path}#${item?.selector}`;
}

function removedValues(current, base) {
  const currentSet = new Set(current ?? []);
  return (base ?? []).filter((value) => !currentSet.has(value));
}

function missingCoverage(previous, replacement) {
  const replacementSet = new Set(replacement ?? []);
  return (previous ?? []).filter((value) => !replacementSet.has(value));
}

function gateReplacementContractErrors(previous, replacement, gateCoverage) {
  if (!replacement) return ["replacement is missing"];
  const errors = [];
  const replacementCapabilities = new Set(replacement.capabilities ?? []);
  const missingCapabilities = (previous.capabilities ?? []).filter(
    (capability) => !replacementCapabilities.has(capability),
  );
  if (missingCapabilities.length > 0) {
    errors.push(
      `${replacement.id} does not preserve capabilities: ${missingCapabilities.join(", ")}`,
    );
  }
  const previousRunners = gateCoverage?.get(previous.id) ?? new Set();
  const replacementRunners = gateCoverage?.get(replacement.id) ?? new Set();
  const missingRunners = [...previousRunners].filter((runner) => !replacementRunners.has(runner));
  if (missingRunners.length > 0) {
    errors.push(`${replacement.id} does not execute runners: ${missingRunners.join(", ")}`);
  }
  return errors;
}

function missingMigratedCoverage(previous, replacement, mappings, key = (value) => value) {
  const replacementSet = new Set((replacement ?? []).map(key));
  const mappedTargets = new Map();
  for (const mapping of mappings ?? []) {
    const from = key(mapping?.from);
    const to = key(mapping?.to);
    if (!mappedTargets.has(from)) mappedTargets.set(from, new Set());
    mappedTargets.get(from).add(to);
  }
  return (previous ?? []).filter((value) => {
    const previousKey = key(value);
    if (replacementSet.has(previousKey)) return false;
    return ![...(mappedTargets.get(previousKey) ?? [])].some((target) =>
      replacementSet.has(target),
    );
  });
}

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

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function humanContextAsset(asset) {
  return (
    asset.status === "active" &&
    (asset.alwaysLoad === true ||
      ["rule", "decision"].includes(asset.kind) ||
      [
        "CONTEXT.md",
        "docs/engineering/architecture.md",
        "docs/engineering/maintainability-system.md",
      ].includes(asset.path))
  );
}

export function validateContextBudgets(catalog, readFile) {
  const errors = [];
  const policy = catalog.contextBudgets;
  for (const [name, budget] of [["default", policy?.default], ["alwaysLoad", policy?.alwaysLoad]]) {
    if (!positiveInteger(budget?.maxLines) || !positiveInteger(budget?.maxBytes)) {
      errors.push(`context budget ${name} must declare positive maxLines and maxBytes`);
    }
  }
  if (
    positiveInteger(policy?.default?.maxLines) &&
    positiveInteger(policy?.alwaysLoad?.maxLines) &&
    policy.alwaysLoad.maxLines >= policy.default.maxLines
  ) {
    errors.push("alwaysLoad context maxLines must be tighter than the default");
  }
  if (
    positiveInteger(policy?.default?.maxBytes) &&
    positiveInteger(policy?.alwaysLoad?.maxBytes) &&
    policy.alwaysLoad.maxBytes >= policy.default.maxBytes
  ) {
    errors.push("alwaysLoad context maxBytes must be tighter than the default");
  }
  const assets = (catalog.assets ?? []).filter(humanContextAsset);
  const assetByPath = new Map(assets.map((asset) => [asset.path, asset]));
  const hotspots = new Map();
  for (const hotspot of policy?.hotspots ?? []) {
    if (hotspots.has(hotspot?.path)) errors.push(`context hotspot is duplicated: ${hotspot?.path}`);
    hotspots.set(hotspot?.path, hotspot);
    if (!assetByPath.has(hotspot?.path)) errors.push(`context hotspot is not an active human asset: ${hotspot?.path}`);
    if (!positiveInteger(hotspot?.maxLines) || !positiveInteger(hotspot?.maxBytes)) {
      errors.push(`context hotspot ${hotspot?.path} must declare positive maxLines and maxBytes`);
    }
    if (typeof hotspot?.reason !== "string" || hotspot.reason.trim() === "") {
      errors.push(`context hotspot ${hotspot?.path} must declare a reason`);
    }
  }
  for (const asset of assets) {
    const contents = readFile(asset.path);
    if (contents == null) continue;
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
    const lines = bytes.length === 0 ? 0 : bytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n").length;
    const budget = hotspots.get(asset.path) ?? (asset.alwaysLoad ? policy?.alwaysLoad : policy?.default);
    if (!budget) continue;
    if (lines > budget.maxLines) errors.push(`human context ${asset.path} exceeds maxLines ${budget.maxLines}: ${lines}`);
    if (bytes.length > budget.maxBytes) errors.push(`human context ${asset.path} exceeds maxBytes ${budget.maxBytes}: ${bytes.length}`);
  }
  return errors;
}

export function compareContextBudgets(current, base) {
  const errors = [];
  for (const tier of ["default", "alwaysLoad"]) {
    for (const metric of ["maxLines", "maxBytes"]) {
      if (current.contextBudgets?.[tier]?.[metric] > base.contextBudgets?.[tier]?.[metric]) {
        errors.push(`context budget ${tier}.${metric} cannot increase`);
      }
    }
  }
  const currentHotspots = new Map((current.contextBudgets?.hotspots ?? []).map((item) => [item.path, item]));
  const currentAssets = new Map((current.assets ?? []).map((asset) => [asset.id, asset]));
  const baseAssetsByPath = new Map((base.assets ?? []).map((asset) => [asset.path, asset]));
  const baseAssetPaths = new Set((base.assets ?? []).map((asset) => asset.path));
  const inheritedHotspotPaths = new Set();
  for (const previous of base.contextBudgets?.hotspots ?? []) {
    const previousAsset = baseAssetsByPath.get(previous.path);
    const currentAsset = previousAsset && currentAssets.get(previousAsset.id);
    let targetAsset = currentAsset;
    let label = `context hotspot ${previous.path}`;
    if (!currentAsset) {
      errors.push(`${label} asset record is missing`);
      continue;
    }
    if (currentAsset.status === "superseded") {
      const resolution = resolveActiveAssetReplacement(currentAsset, currentAssets);
      if (resolution.error) {
        errors.push(`${label} has no active asset replacement`);
        continue;
      }
      targetAsset = resolution.replacement;
      label += ` replacement ${resolution.replacement.path}`;
    }
    const hotspot = currentHotspots.get(targetAsset.path);
    const budget =
      hotspot ?? current.contextBudgets?.[targetAsset.alwaysLoad ? "alwaysLoad" : "default"];
    if (hotspot && targetAsset.path !== previous.path) inheritedHotspotPaths.add(targetAsset.path);
    if (hotspot?.reason !== undefined && hotspot.reason !== previous.reason) {
      errors.push(`${label} reason changed`);
    }
    for (const metric of ["maxLines", "maxBytes"]) {
      if (budget?.[metric] > previous[metric]) errors.push(`${label} ${metric} cannot increase`);
    }
  }
  for (const hotspot of current.contextBudgets?.hotspots ?? []) {
    if (
      baseAssetPaths.has(hotspot.path) &&
      !inheritedHotspotPaths.has(hotspot.path) &&
      !(base.contextBudgets?.hotspots ?? []).some((item) => item.path === hotspot.path)
    ) {
      errors.push(`existing context asset cannot gain a new hotspot: ${hotspot.path}`);
    }
  }
  return errors;
}

export function assetReplacementCoverageErrors(
  previous,
  replacement,
  { migration = previous?.migration, gateById } = {},
) {
  if (!replacement) return ["replacement is missing"];
  const errors = [];
  if (replacement.kind !== previous.kind) {
    errors.push(`kind ${previous.kind} is not covered by ${replacement.kind}`);
  }
  if (replacement.enforcement?.mode !== previous.enforcement?.mode) {
    errors.push(
      `enforcement mode ${previous.enforcement?.mode} is not covered by ${replacement.enforcement?.mode}`,
    );
  }
  if (previous.alwaysLoad === true && replacement.alwaysLoad !== true) {
    errors.push("alwaysLoad=true is not covered");
  }
  for (const [label, before, after, mappings, key] of [
    ["principle", previous.principles, replacement.principles],
    ["review selector", previous.reviewOnChange, replacement.reviewOnChange, migration?.reviewSelectors],
    ["evidence", previous.enforcement?.evidence, replacement.enforcement?.evidence, migration?.evidence, evidenceKey],
  ]) {
    for (const value of missingMigratedCoverage(before, after, mappings, key)) {
      errors.push(`${label} is not covered: ${key ? key(value) : value}`);
    }
  }
  for (const gate of missingCoverage(
    previous.enforcement?.gates,
    replacement.enforcement?.gates,
  )) {
    if (!gateRemovalHasActiveReplacement(gate, replacement.enforcement?.gates, gateById)) {
      errors.push(`gate is not covered: ${gate}`);
    }
  }
  return errors;
}

export function resolveActiveAssetReplacement(asset, assetById) {
  const chain = [asset.id];
  const seen = new Set(chain);
  let current = asset;
  while (current?.status === "superseded") {
    const nextId = current.supersededBy;
    if (typeof nextId !== "string" || nextId === "") {
      return { chain, error: "replacement chain has no supersededBy target" };
    }
    chain.push(nextId);
    if (seen.has(nextId)) {
      return { chain, error: `replacement chain is cyclic: ${chain.join(" -> ")}` };
    }
    seen.add(nextId);
    current = assetById.get(nextId);
    if (!current) {
      return { chain, error: `replacement chain references missing asset: ${nextId}` };
    }
  }
  if (current?.status !== "active") {
    return {
      chain,
      error: `replacement chain must terminate at an active asset; found ${current?.status ?? "missing"}`,
    };
  }
  return { chain, replacement: current };
}

export function resolveActiveGateReplacement(gate, gateById) {
  const chain = [gate.id];
  const seen = new Set(chain);
  let current = gate;
  while (["retiring", "retired"].includes(current?.status)) {
    const nextId = current.retirement?.replacement;
    if (typeof nextId !== "string" || nextId === "") {
      return { chain, error: "replacement chain has no retirement replacement" };
    }
    chain.push(nextId);
    if (seen.has(nextId)) {
      return { chain, error: `replacement chain is cyclic: ${chain.join(" -> ")}` };
    }
    seen.add(nextId);
    current = gateById.get(nextId);
    if (!current) {
      return { chain, error: `replacement chain references missing gate: ${nextId}` };
    }
  }
  if (current?.status !== "active") {
    return {
      chain,
      error: `replacement chain must terminate at an active gate; found ${current?.status ?? "missing"}`,
    };
  }
  return { chain, replacement: current };
}

export function migrationAuthorizationErrors(ownerId, migration, assetById) {
  if (migration == null) return [];
  const errors = [];
  const allowed = new Set([
    "decision", "reviewSelectors", "protectedPaths", "decisions", "rules", "evidence",
  ]);
  for (const key of Object.keys(migration)) {
    if (!allowed.has(key)) errors.push(`migration declares unsupported field: ${key}`);
  }
  const decision = assetById.get(migration.decision);
  const resolution = decision?.status === "superseded"
    ? resolveActiveAssetReplacement(decision, assetById)
    : { replacement: decision };
  if (
    migration.decision === ownerId || resolution.error ||
    resolution.replacement?.status !== "active" ||
    resolution.replacement?.kind !== "decision"
  ) {
    errors.push("migration decision must reference a different active decision asset");
  }
  let mappingCount = 0;
  for (const field of ["reviewSelectors", "protectedPaths", "decisions", "rules", "evidence"]) {
    const mappings = migration[field];
    if (mappings == null) continue;
    if (!Array.isArray(mappings) || mappings.length === 0) {
      errors.push(`migration ${field} must be a non-empty array`);
      continue;
    }
    mappingCount += mappings.length;
    const seen = new Set();
    const key = field === "evidence" ? evidenceKey : (value) => value;
    for (const mapping of mappings) {
      const from = key(mapping?.from);
      const to = key(mapping?.to);
      if (
        typeof from !== "string" || !from || from.includes("undefined") ||
        typeof to !== "string" || !to || to.includes("undefined")
      ) {
        errors.push(`migration ${field} entries must declare concrete from and to values`);
      } else if (seen.has(from)) {
        errors.push(`migration ${field} maps the same source more than once: ${from}`);
      }
      seen.add(from);
    }
  }
  if (mappingCount === 0) errors.push("migration must declare at least one concrete mapping");
  return errors;
}

export function validateGateRetirements(gates, gateById, assetById, { gateCoverage } = {}) {
  const errors = [];
  for (const gate of gates) {
    if (
      !Array.isArray(gate.capabilities) || gate.capabilities.length === 0 ||
      gate.capabilities.some((capability) => typeof capability !== "string" || !capability.trim()) ||
      new Set(gate.capabilities).size !== gate.capabilities.length
    ) {
      errors.push(`governance gate ${gate.id} capabilities must be unique non-empty strings`);
    }
    if (
      gate.kind === "workflow" &&
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(gate.ref ?? "")
    ) {
      errors.push(
        `governance gate ${gate.id} must reference .github/workflows/<file>.yml`,
      );
    }
  }
  for (const gate of gates.filter((item) => ["retiring", "retired"].includes(item.status))) {
    const owner = `${gate.status} governance gate ${gate.id}`;
    const replacement = gate.retirement?.replacement;
    const featureRemoved = gate.retirement?.featureRemoved === true;
    if (replacement && featureRemoved) {
      errors.push(`${owner} retirement cannot declare both replacement and featureRemoved`);
      continue;
    }
    if (replacement) {
      const resolution = resolveActiveGateReplacement(gate, gateById);
      if (resolution.error) errors.push(`${owner} ${resolution.error}`);
      else {
        for (const gap of gateReplacementContractErrors(gate, resolution.replacement, gateCoverage)) {
          errors.push(`${owner} replacement ${gap}`);
        }
      }
      continue;
    }
    const decision = assetById.get(gate.retirement?.removalDecision);
    const resolution = decision?.status === "superseded"
      ? resolveActiveAssetReplacement(decision, assetById)
      : { replacement: decision };
    if (
      !featureRemoved || resolution.error ||
      resolution.replacement?.status !== "active" ||
      resolution.replacement?.kind !== "decision"
    ) {
      errors.push(`${owner} retirement requires an active replacement chain or ADR-backed feature removal`);
    }
  }
  return errors;
}

function gateRemovalHasActiveReplacement(gateId, ownerGates, gateById) {
  const gate = gateById.get(gateId);
  if (!gate || !["retiring", "retired"].includes(gate.status)) return false;
  const resolution = resolveActiveGateReplacement(gate, gateById);
  return !resolution.error && (ownerGates ?? []).includes(resolution.replacement.id);
}

export function invariantReplacementCoverageErrors(previous, replacement, { gateById } = {}) {
  if (!replacement) return ["replacement is missing"];
  const errors = [];
  const migration = previous.retirement?.migration;
  for (const [label, before, after, mappings, key] of [
    ["protected path", previous.protectedPaths, replacement.protectedPaths, migration?.protectedPaths],
    ["principle", previous.principles, replacement.principles],
    ["decision", previous.decisions, replacement.decisions, migration?.decisions],
    ["rule", [previous.rule], [replacement.rule], migration?.rules],
    ["evidence", previous.evidence, replacement.evidence, migration?.evidence, evidenceKey],
  ]) {
    for (const value of missingMigratedCoverage(before, after, mappings, key)) {
      errors.push(`${label} is not covered: ${key ? key(value) : value}`);
    }
  }
  for (const gate of missingCoverage(previous.gates, replacement.gates)) {
    if (!gateRemovalHasActiveReplacement(gate, replacement.gates, gateById)) {
      errors.push(`gate is not covered: ${gate}`);
    }
  }
  return errors;
}

export function compareGovernanceAssetCatalogs(current, base, { trackedPaths } = {}) {
  if (!base) return [];
  const errors = compareContextBudgets(current, base);
  const currentGates = new Map((current.gates ?? []).map((gate) => [gate.id, gate]));
  for (const previous of base.gates ?? []) {
    const gate = currentGates.get(previous.id);
    const previousStatus = previous.status ?? "active";
    if (!gate) {
      errors.push(
        previousStatus === "active"
          ? `active governance gate was removed without first entering retirement: ${previous.id}`
          : previousStatus === "retiring"
            ? `retiring governance gate was removed before reaching retired: ${previous.id}`
            : `retired governance gate tombstone was removed: ${previous.id}`,
      );
      continue;
    }
    if (gate.kind !== previous.kind) {
      errors.push(
        `governance gate ${previous.id} kind changed from ${previous.kind} to ${gate.kind}`,
      );
    }
    if (gate.ref !== previous.ref) {
      errors.push(
        `governance gate ${previous.id} ref changed from ${previous.ref} to ${gate.ref}`,
      );
    }
    for (const capability of missingCoverage(previous.capabilities, gate.capabilities)) {
      errors.push(`governance gate ${previous.id} removed capability: ${capability}`);
    }
    if (previousStatus === "active" && gate.status === "retired") {
      errors.push(`active governance gate ${previous.id} cannot skip directly to retired`);
    }
    if (previousStatus === "retiring" && gate.status === "active") {
      errors.push(`retiring governance gate ${previous.id} cannot return to active`);
    }
    if (previousStatus === "retired" && gate.status !== "retired") {
      errors.push(`retired governance gate ${previous.id} cannot return to ${gate.status}`);
    }
    if (
      ["retiring", "retired"].includes(previousStatus) &&
      !isDeepStrictEqual(gate.retirement, previous.retirement)
    ) {
      errors.push(`governance gate ${previous.id} retirement metadata changed`);
    }
    if (previousStatus === "active" && gate.status === "retiring") {
      const resolution = resolveActiveGateReplacement(gate, currentGates);
      if (!resolution.error) {
        for (const gap of gateReplacementContractErrors(previous, resolution.replacement)) {
          errors.push(`retiring governance gate ${previous.id} replacement ${gap}`);
        }
      }
    }
  }

  const currentAssets = new Map((current.assets ?? []).map((asset) => [asset.id, asset]));
  for (const previous of base.assets ?? []) {
    const asset = currentAssets.get(previous.id);
    if (!asset) {
      if (previous.kind === "fixture") {
        errors.push(`published fixture asset was removed: ${previous.id}`);
      } else if (previous.status === "active") {
        errors.push(
          `active governance asset was removed without first being superseded: ${previous.id}`,
        );
      } else if (previous.status === "superseded") {
        errors.push(`superseded governance asset record was removed: ${previous.id}`);
      }
      continue;
    }
    if (asset.path !== previous.path) {
      errors.push(`governance asset ${previous.id} path changed from ${previous.path} to ${asset.path}`);
    }
    if (asset.kind !== previous.kind) {
      errors.push(`governance asset ${previous.id} kind changed from ${previous.kind} to ${asset.kind}`);
    }
    if (previous.kind === "fixture" && asset.checksum !== previous.checksum) {
      errors.push(`published fixture checksum changed in the catalog: ${previous.id}`);
    }
    if (previous.kind === "decision" && asset.checksum !== previous.checksum) {
      errors.push(`accepted decision checksum changed in the catalog: ${previous.id}`);
    }
    if (previous.status === "superseded") {
      if (asset.status !== "superseded") {
        errors.push(`superseded governance asset ${previous.id} cannot return to ${asset.status}`);
      }
      if (asset.supersededBy !== previous.supersededBy) {
        errors.push(`superseded governance asset ${previous.id} changed supersededBy`);
      }
      if (!isDeepStrictEqual(asset, previous)) {
        errors.push(`superseded governance asset ${previous.id} record changed`);
      }
      const resolution = resolveActiveAssetReplacement(asset, currentAssets);
      if (resolution.error) {
        errors.push(`superseded governance asset ${previous.id} ${resolution.error}`);
      } else {
        for (const gap of assetReplacementCoverageErrors(previous, resolution.replacement, {
          migration: asset.migration,
          gateById: currentGates,
        })) {
          errors.push(`superseded governance asset ${previous.id} has incomplete replacement: ${gap}`);
        }
      }
    }
    if (previous.status === "active" && ["active", "superseded"].includes(asset.status)) {
      if (previous.alwaysLoad === true && asset.alwaysLoad !== true) {
        errors.push(`active governance asset ${previous.id} removed alwaysLoad=true`);
      }
      if (asset.enforcement?.mode !== previous.enforcement?.mode) {
        errors.push(
          `active governance asset ${previous.id} changed enforcement mode from ${previous.enforcement?.mode} to ${asset.enforcement?.mode}`,
        );
      }
      for (const principle of removedValues(asset.principles, previous.principles)) {
        errors.push(`active governance asset ${previous.id} removed principle: ${principle}`);
      }
      for (const selector of removedValues(asset.reviewOnChange, previous.reviewOnChange)) {
        errors.push(`active governance asset ${previous.id} removed review selector: ${selector}`);
      }
      for (const gate of removedValues(
        asset.enforcement?.gates,
        previous.enforcement?.gates,
      )) {
        if (!gateRemovalHasActiveReplacement(gate, asset.enforcement?.gates, currentGates)) {
          errors.push(`active governance asset ${previous.id} removed gate: ${gate}`);
        }
      }
      const evidence = (asset.enforcement?.evidence ?? []).map(evidenceKey);
      for (const item of removedValues(
        evidence,
        (previous.enforcement?.evidence ?? []).map(evidenceKey),
      )) {
        errors.push(`active governance asset ${previous.id} removed evidence: ${item}`);
      }
    }
    if (previous.status === "active" && asset.status === "superseded") {
      const resolution = resolveActiveAssetReplacement(asset, currentAssets);
      if (resolution.error) {
        errors.push(`superseded governance asset ${previous.id} ${resolution.error}`);
      } else {
        for (const gap of assetReplacementCoverageErrors(previous, resolution.replacement, {
          migration: asset.migration,
          gateById: currentGates,
        })) {
          errors.push(`superseded governance asset ${previous.id} has incomplete replacement: ${gap}`);
        }
      }
    }
  }

  const currentInvariants = new Map(
    (current.invariants ?? []).map((invariant) => [invariant.id, invariant]),
  );
  for (const previous of base.invariants ?? []) {
    const invariant = currentInvariants.get(previous.id);
    if (!invariant) {
      if (previous.status === "active") {
        errors.push(
          `active governance invariant was removed without first entering retirement: ${previous.id}`,
        );
      } else if (["retiring", "retired"].includes(previous.status)) {
        errors.push(`${previous.status} governance invariant tombstone was removed: ${previous.id}`);
      }
      continue;
    }
    if (previous.status === "retired") {
      if (invariant.status !== "retired") {
        errors.push(`retired governance invariant ${previous.id} cannot return to ${invariant.status}`);
      }
      if (!isDeepStrictEqual(invariant, previous)) {
        errors.push(`retired governance invariant ${previous.id} record changed`);
      }
      continue;
    }
    if (previous.status === "active" || previous.status === "retiring") {
      if (previous.status === "active" && invariant.status === "retired") {
        errors.push(`active governance invariant ${previous.id} cannot skip directly to retired`);
      }
      if (previous.status === "retiring" && invariant.status === "active") {
        errors.push(`retiring governance invariant ${previous.id} cannot return to active`);
      }
      if (previous.status === "retiring" && invariant.status === "retired") {
        const replacement = currentInvariants.get(previous.retirement?.replacement);
        const migrationErrors = migrationAuthorizationErrors(
          previous.id,
          previous.retirement?.migration,
          currentAssets,
        );
        for (const error of migrationErrors) {
          errors.push(`governance invariant ${previous.id} retirement migration is invalid: ${error}`);
        }
        const replacementIsComplete =
          replacement?.status === "active" &&
          migrationErrors.length === 0 &&
          invariantReplacementCoverageErrors(previous, replacement, {
            gateById: currentGates,
          }).length === 0;
        const removalDecision = currentAssets.get(previous.retirement?.removalDecision);
        const hasRemovalDecision =
          previous.retirement?.featureRemoved === true && removalDecision?.kind === "decision";
        const candidatePaths = Array.isArray(trackedPaths)
          ? trackedPaths
          : previous.protectedPaths ?? [];
        const liveSelectors = (previous.protectedPaths ?? []).filter((selector) =>
          candidatePaths.some((path) =>
            selector.endsWith("/") ? path.startsWith(selector) : path === selector,
          ),
        );
        if (!replacementIsComplete && (!hasRemovalDecision || liveSelectors.length > 0)) {
          errors.push(
            `retiring governance invariant ${previous.id} cannot become retired without a complete active replacement or ADR-backed feature removal with no protected paths remaining`,
          );
        }
      }
      if (invariant.retireWhen !== previous.retireWhen) {
        errors.push(`governance invariant ${previous.id} retireWhen changed`);
      }
      if (
        previous.status === "retiring" &&
        !isDeepStrictEqual(invariant.retirement, previous.retirement)
      ) {
        errors.push(`governance invariant ${previous.id} retirement metadata changed`);
      }
      const retirementSuffix = ["retiring", "retired"].includes(invariant.status)
        ? " during retirement"
        : "";
      for (const path of removedValues(invariant.protectedPaths, previous.protectedPaths)) {
        errors.push(
          `${invariant.status === "active" ? "active governance invariant" : "governance invariant"} ${previous.id} removed protected path${retirementSuffix}: ${path}`,
        );
      }
      for (const gate of removedValues(invariant.gates, previous.gates)) {
        if (!gateRemovalHasActiveReplacement(gate, invariant.gates, currentGates)) {
          errors.push(
            `${invariant.status === "active" ? "active governance invariant" : "governance invariant"} ${previous.id} removed gate${retirementSuffix}: ${gate}`,
          );
        }
      }
      for (const item of removedValues(
        (invariant.evidence ?? []).map(evidenceKey),
        (previous.evidence ?? []).map(evidenceKey),
      )) {
        errors.push(
          `${invariant.status === "active" ? "active governance invariant" : "governance invariant"} ${previous.id} removed evidence${retirementSuffix}: ${item}`,
        );
      }
      for (const principle of removedValues(invariant.principles, previous.principles)) {
        errors.push(
          `${invariant.status === "active" ? "active governance invariant" : "governance invariant"} ${previous.id} removed principle${retirementSuffix}: ${principle}`,
        );
      }
      for (const decision of removedValues(invariant.decisions, previous.decisions)) {
        errors.push(
          `${invariant.status === "active" ? "active governance invariant" : "governance invariant"} ${previous.id} removed decision${retirementSuffix}: ${decision}`,
        );
      }
      if (invariant.rule !== previous.rule) {
        errors.push(
          `governance invariant ${previous.id} changed Rule from ${previous.rule} to ${invariant.rule}`,
        );
      }
      if (invariant.introducedBy !== previous.introducedBy) {
        errors.push(`governance invariant ${previous.id} changed introducedBy commit`);
      }
    }
  }
  const baseGateIds = new Set((base.gates ?? []).map((gate) => gate.id));
  for (const gate of currentGates.values()) {
    if (!baseGateIds.has(gate.id) && gate.status !== "active") {
      errors.push(`new governance gate ${gate.id} must enter lifecycle as active`);
    }
  }
  const baseAssetIds = new Set((base.assets ?? []).map((asset) => asset.id));
  for (const asset of currentAssets.values()) {
    if (!baseAssetIds.has(asset.id) && asset.status !== "active") {
      errors.push(`new governance asset ${asset.id} must enter lifecycle as active`);
    }
  }
  const baseInvariantIds = new Set((base.invariants ?? []).map((invariant) => invariant.id));
  for (const invariant of currentInvariants.values()) {
    if (!baseInvariantIds.has(invariant.id) && invariant.status !== "active") {
      errors.push(`new governance invariant ${invariant.id} must enter lifecycle as active`);
    }
  }
  return [...new Set(errors)].sort();
}
