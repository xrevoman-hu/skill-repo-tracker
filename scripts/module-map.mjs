import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listRepositoryFiles } from "./git-paths.mjs";
import { findForbiddenCssImports } from "./module-map-css.mjs";
import {
  findForbiddenTrackedArtifactPaths,
  findSensitiveTrackedContent,
} from "./module-map-repository-policy.mjs";
import {
  findForbiddenRustIncludeMacros,
  findForbiddenRustModuleGraphSyntax,
  findRustSourceTreeHazards,
  rustCodeOnly,
  rustDelimiterRanges,
} from "./module-map-rust-policy.mjs";
import { findForbiddenTypeScriptModuleGraphPatterns } from "./module-map-typescript.mjs";
import { isDedicatedRustTestModulePath } from "./source-classification.mjs";

export { findForbiddenCssImports } from "./module-map-css.mjs";
export {
  findForbiddenTrackedArtifactPaths,
  findSensitiveTrackedContent,
} from "./module-map-repository-policy.mjs";
export {
  findForbiddenRustIncludeMacros,
  findForbiddenRustModuleGraphSyntax,
  findRustSourceTreeHazards,
} from "./module-map-rust-policy.mjs";
export { findForbiddenTypeScriptModuleGraphPatterns } from "./module-map-typescript.mjs";

export const MODULE_MAP_PATH = "docs/engineering/module-map.json";

const FRONTEND_TEST = /(?:\.(?:test|spec)\.(?:ts|tsx|mts|cts)|\/testSetup\.(?:ts|mts|cts)|\.d\.(?:ts|mts|cts))$/;
const SOURCE_EXTENSIONS = {
  frontend: new Set([".ts", ".tsx", ".mts", ".cts", ".css"]),
  rust: new Set([".rs"]),
};

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function repositoryFiles(root) {
  return listRepositoryFiles(root, ["src", "src-tauri/src"]);
}

export function isProductionSource(pathname, sourceRoots) {
  const roots = sourceRoots.filter((root) =>
    (pathname === root.path || pathname.startsWith(`${root.path}/`)) &&
    root.extensions?.some((extension) => pathname.endsWith(extension)),
  );
  return roots.some((root) =>
    (root.runtime === "frontend" && !FRONTEND_TEST.test(pathname)) ||
    (root.runtime === "rust" && !isDedicatedRustTestModulePath(pathname)),
  );
}

export function discoverProductionFiles(root, map) {
  return repositoryFiles(root)
    .filter((pathname) => isProductionSource(pathname, map.sourceRoots ?? []))
    .sort((left, right) => left.localeCompare(right));
}

function resolveTypeScriptSpecifier(from, specifier, knownFiles) {
  const canonical = specifier.replace(/[?#].*$/, "");
  if (!canonical) return undefined;
  const unresolved = canonical.startsWith("/src/")
    ? path.posix.normalize(canonical).slice(1)
    : canonical.startsWith(".")
      ? path.posix.normalize(path.posix.join(path.posix.dirname(from), canonical))
      : undefined;
  if (!unresolved || (unresolved !== "src" && !unresolved.startsWith("src/"))) return undefined;
  const extensionSubstitutions = [
    [/\.jsx?$/, [".ts", ".tsx"]],
    [/\.mjs$/, [".mts"]],
    [/\.cjs$/, [".cts"]],
  ];
  const substituted = extensionSubstitutions.flatMap(([pattern, extensions]) =>
    pattern.test(unresolved)
      ? extensions.map((extension) => unresolved.replace(pattern, extension))
      : [],
  );
  const candidates = [...new Set([
    unresolved, ...substituted,
    ...[".ts", ".tsx", ".mts", ".cts", ".css"].map((extension) => `${unresolved}${extension}`),
    ...["index.ts", "index.tsx", "index.mts", "index.cts"].map(
      (filename) => path.posix.join(unresolved, filename),
    ),
  ])];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function isImportMetaUrl(node) {
  return (
    ts.isPropertyAccessExpression(node) && node.name.text === "url" &&
    ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta"
  );
}

function newExpressionName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return undefined;
}

export function discoverTypeScriptDependenciesFromSource({ path: from, source, knownFiles }) {
  const specifiers = new Set();
  const scriptKind = from.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(from, source, ts.ScriptTarget.Latest, true, scriptKind);
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    } else if (ts.isNewExpression(node)) {
      const constructorName = newExpressionName(node);
      if (
        constructorName === "URL" && node.arguments?.length >= 2 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        isImportMetaUrl(node.arguments[1])
      ) {
        specifiers.add(node.arguments[0].text);
      } else if (["Worker", "SharedWorker"].includes(constructorName) &&
        ts.isStringLiteralLike(node.arguments?.[0])) {
        specifiers.add(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const dependencies = [];
  for (const specifier of specifiers) {
    const to = resolveTypeScriptSpecifier(from, specifier, knownFiles);
    if (to && to !== from) {
      dependencies.push({ from, to, kind: "typescript-import", specifier });
    }
  }
  return [...new Map(dependencies.map((item) => [item.to, item])).values()].sort((left, right) =>
    left.to.localeCompare(right.to),
  );
}

function rustUseTreeLeaves(source) {
  const leaves = [];
  for (const useKeyword of source.matchAll(/\buse\b/g)) {
    const start = useKeyword.index + useKeyword[0].length;
    let end = start;
    let depth = 0;
    while (end < source.length) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") depth -= 1;
      else if (source[end] === ";" && depth === 0) break;
      end += 1;
    }
    if (end >= source.length) continue;
    const tokens = source.slice(start, end).match(/::|[{},*]|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    let index = 0;
    const parseGroup = (prefix) => {
      index += 1;
      while (index < tokens.length && tokens[index] !== "}") {
        const before = index;
        parseTree(prefix);
        if (tokens[index] === ",") index += 1;
        else if (index === before) index += 1;
      }
      if (tokens[index] === "}") index += 1;
    };
    const parseTree = (prefix) => {
      if (tokens[index] === "::") index += 1;
      if (tokens[index] === "{") {
        parseGroup(prefix);
        return;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[index] ?? "")) return;
      const segments = [...prefix, tokens[index++]];
      while (tokens[index] === "::") {
        index += 1;
        if (tokens[index] === "{") {
          parseGroup(segments);
          return;
        }
        if (tokens[index] === "*") {
          index += 1;
          leaves.push({ segments: [...segments, "*"] });
          return;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[index] ?? "")) return;
        segments.push(tokens[index++]);
      }
      let alias;
      if (tokens[index] === "as") {
        index += 1;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[index] ?? "")) {
          alias = tokens[index++];
        }
      }
      leaves.push({ segments, alias });
    };
    parseTree([]);
  }
  return leaves;
}

function rustRootQualifiers(useTreeLeaves, source, includeSelf) {
  const qualifiers = new Set(["crate", "super"]);
  if (includeSelf) qualifiers.add("self");
  for (const match of source.matchAll(
    /\bextern\s+crate\s+self\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g,
  )) {
    qualifiers.add(match[1]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { segments, alias } of useTreeLeaves) {
      const aliasesRoot =
        segments.length === 1 || (segments.length === 2 && segments[1] === "self");
      if (
        alias &&
        alias !== "_" &&
        aliasesRoot &&
        qualifiers.has(segments[0]) &&
        !qualifiers.has(alias)
      ) {
        qualifiers.add(alias);
        changed = true;
      }
    }
  }
  return [...qualifiers];
}

function rustModuleNamesInRootUseTrees(useTreeLeaves, knownNames, qualifiers) {
  const names = new Set();
  const roots = new Set(qualifiers);
  for (const { segments } of useTreeLeaves) {
    if (roots.has(segments[0]) && knownNames.includes(segments[1])) names.add(segments[1]);
  }
  return names;
}

export function discoverRustDependenciesFromSource({ path: from, source, rustModulePaths }) {
  const code = rustCodeOnly(source);
  const knownNames = [...rustModulePaths.keys()];
  const useTreeLeaves = rustUseTreeLeaves(code);
  const rootQualifiers = rustRootQualifiers(
    useTreeLeaves,
    code,
    path.posix.basename(from) === "lib.rs",
  );
  const rootQualifierPattern = rootQualifiers.join("|");
  const declarations = [];
  const referenced = new Set();
  const delimiterRanges = rustDelimiterRanges(code);
  const declarationPattern = /^(?<attributes>(?:[ \t]*#\s*\[[^\]]+\][ \t]*(?:\r?\n|))*)[ \t]*(?:(?:pub(?:\([^)]*\))?)\s+)?mod\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
  for (const match of code.matchAll(declarationPattern)) {
    if (/#\s*\[\s*cfg(?:_attr)?\b/.test(match.groups.attributes)) continue;
    if (delimiterRanges.some(
      (range) => match.index > range.opening && match.index < range.closing,
    )) continue;
    const name = match.groups.name;
    if (!rustModulePaths.has(name)) continue;
    declarations.push({ name, from });
    referenced.add(name);
  }
  for (const match of code.matchAll(
    new RegExp(
      `\\b(?:${rootQualifierPattern})\\s*::\\s*([A-Za-z_][A-Za-z0-9_]*)`,
      "g",
    ),
  )) {
    if (rustModulePaths.has(match[1])) referenced.add(match[1]);
  }
  for (const name of rustModuleNamesInRootUseTrees(useTreeLeaves, knownNames, rootQualifiers)) {
    referenced.add(name);
  }
  const dependencies = [...referenced]
    .map((name) => ({
      from,
      to: rustModulePaths.get(name),
      kind: "rust-module-reference",
      specifier: name,
    }))
    .filter(({ to }) => to && to !== from)
    .sort((left, right) => left.to.localeCompare(right.to));
  return { declarations, dependencies };
}

export function discoverModuleDependencies(root, map, productionFiles) {
  const knownFiles = new Set(productionFiles);
  const rustModulePaths = new Map(
    productionFiles
      .filter((pathname) => pathname.startsWith("src-tauri/src/") && pathname.endsWith(".rs"))
      .filter((pathname) => !pathname.endsWith("/lib.rs") && !pathname.endsWith("/main.rs"))
      .map((pathname) => [path.posix.basename(pathname, ".rs"), pathname]),
  );
  const dependencies = [];
  const rustDeclarations = [];
  const hazards = findRustSourceTreeHazards(productionFiles);
  for (const pathname of productionFiles) {
    const source = readFileSync(path.join(root, pathname), "utf8");
    if (pathname.startsWith("src/") && pathname.endsWith(".css")) {
      hazards.push(...findForbiddenCssImports(pathname, source));
    } else if (pathname.startsWith("src/") && /\.(?:ts|tsx|mts|cts)$/.test(pathname)) {
      hazards.push(...findForbiddenTypeScriptModuleGraphPatterns(pathname, source));
      dependencies.push(
        ...discoverTypeScriptDependenciesFromSource({
          path: pathname,
          source,
          knownFiles,
        }),
      );
    } else if (pathname.startsWith("src-tauri/src/") && pathname.endsWith(".rs")) {
      hazards.push(...findForbiddenRustIncludeMacros(pathname, source));
      hazards.push(...findForbiddenRustModuleGraphSyntax(pathname, source));
      const discovered = discoverRustDependenciesFromSource({
        path: pathname,
        source,
        rustModulePaths,
      });
      dependencies.push(...discovered.dependencies);
      rustDeclarations.push(...discovered.declarations);
    }
  }
  const key = ({ from, to, kind }) => `${kind}\0${from}\0${to}`;
  return {
    dependencies: [...new Map(dependencies.map((item) => [key(item), item])).values()].sort(
      (left, right) => key(left).localeCompare(key(right)),
    ),
    rustDeclarations,
    hazards,
  };
}

function mapByPath(map) {
  const ownership = new Map();
  for (const module of map.modules ?? []) {
    for (const pathname of module.paths ?? []) {
      const entries = ownership.get(pathname) ?? [];
      entries.push(module);
      ownership.set(pathname, entries);
    }
  }
  return ownership;
}

function matchingSourceRoots(pathname, sourceRoots) {
  return sourceRoots.filter(
    (root) =>
      (pathname === root.path || pathname.startsWith(`${root.path}/`)) &&
      root.extensions?.some((extension) => pathname.endsWith(extension)),
  );
}

const dependencyKey = ({ from, to }) => `${from}\0${to}`;

const changeRecordIdentity = (kind, record) => JSON.stringify(
  kind === "move" ? [record.path, record.fromModule, record.toModule ?? null]
    : record.kind === "add-layer" ? [record.kind, record.layer]
      : record.kind === "add-source-root" ? [record.kind, record.path]
        : record.kind === "reorder-source-roots" ? [record.kind, record.order]
      : ["dependency-policy", record.from, record.to],
);
const recordFingerprint = (record) => JSON.stringify(
  Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
);

function validateChangeRecords(map, tracked) {
  const errors = [];
  for (const [kind, records] of [
    ["move", map.moves ?? []],
    ["policy change", map.policyChanges ?? []],
  ]) {
    const identities = new Set();
    for (const record of records) {
      const identity = changeRecordIdentity(kind, record);
      if (identities.has(identity)) errors.push(`duplicate module map ${kind}: ${identity}`);
      identities.add(identity);
      if (
        typeof record.adr !== "string" ||
        !record.adr.startsWith("docs/adr/") ||
        !tracked.has(record.adr)
      ) {
        errors.push(`module map ${kind} requires a tracked ADR: ${record.adr ?? "missing"}`);
      }
    }
  }
  return errors;
}

export function validateModuleMap({
  map,
  productionFiles,
  trackedFiles,
  dependencies,
  rustDeclarations,
  hazards = [],
}) {
  const errors = [];
  errors.push(...hazards);
  const tracked = new Set(trackedFiles);
  const production = new Set(productionFiles);
  if (map?.schemaVersion !== 1) {
    errors.push(`module map schemaVersion must be 1; found ${map?.schemaVersion ?? "missing"}`);
  }
  const sourceRoots = map?.sourceRoots ?? [];
  const sourceRootIds = new Set();
  for (const [index, root] of sourceRoots.entries()) {
    if (!root.path || sourceRootIds.has(root.path)) {
      errors.push(`duplicate or missing module map source root: ${root.path ?? "missing"}`);
    }
    for (const previous of sourceRoots.slice(0, index)) {
      if (root.path === previous.path || root.path?.startsWith(`${previous.path}/`) ||
          previous.path?.startsWith(`${root.path}/`)) {
        errors.push(`module source roots overlap: ${previous.path ?? "missing"} <> ${root.path ?? "missing"}`);
      }
    }
    sourceRootIds.add(root.path);
    if (!["frontend", "rust"].includes(root.runtime)) {
      errors.push(`source root ${root.path ?? "missing"} has invalid runtime: ${root.runtime}`);
    }
    if (!Array.isArray(root.extensions) || root.extensions.length === 0) {
      errors.push(`source root ${root.path ?? "missing"} must declare extensions`);
    } else {
      for (const extension of root.extensions) {
        if (!SOURCE_EXTENSIONS[root.runtime]?.has(extension)) {
          errors.push(
            `source root ${root.path ?? "missing"} has unsupported ${root.runtime} extension: ${extension}`,
          );
        }
      }
    }
  }

  const layers = new Map();
  for (const layer of map?.layers ?? []) {
    if (!layer.id || layers.has(layer.id)) {
      errors.push(`duplicate or missing module layer: ${layer.id ?? "missing"}`);
      continue;
    }
    layers.set(layer.id, layer);
  }
  for (const layer of layers.values()) {
    if (!["frontend", "rust"].includes(layer.runtime)) {
      errors.push(`module layer ${layer.id} has invalid runtime: ${layer.runtime}`);
    }
    if (!Array.isArray(layer.forbiddenDependencies)) {
      errors.push(`module layer ${layer.id} must declare forbiddenDependencies`);
      continue;
    }
    for (const target of layer.forbiddenDependencies) {
      const targetLayer = layers.get(target);
      if (!targetLayer) errors.push(`module layer ${layer.id} forbids unknown layer: ${target}`);
      else if (targetLayer.runtime !== layer.runtime) {
        errors.push(`module layer ${layer.id} cannot govern another runtime: ${target}`);
      }
    }
  }

  const modules = new Map();
  for (const module of map?.modules ?? []) {
    if (!module.id || modules.has(module.id)) {
      errors.push(`duplicate or missing module id: ${module.id ?? "missing"}`);
      continue;
    }
    modules.set(module.id, module);
    const layer = layers.get(module.layer);
    if (!layer) errors.push(`module ${module.id} has unknown layer: ${module.layer ?? "missing"}`);
    else if (module.runtime !== layer.runtime) {
      errors.push(`module ${module.id} runtime ${module.runtime} does not match layer ${layer.id}`);
    }
    if (
      typeof module.ownerRule !== "string" ||
      !module.ownerRule.startsWith("docs/rules/") ||
      !tracked.has(module.ownerRule)
    ) {
      errors.push(`module ${module.id} owner Rule is not tracked: ${module.ownerRule ?? "missing"}`);
    }
    if (!Array.isArray(module.decisions)) {
      errors.push(`module ${module.id} must declare decisions (an empty array is valid)`);
    } else {
      for (const decision of module.decisions) {
        if (!decision.startsWith("docs/adr/") || !tracked.has(decision)) {
          errors.push(`module ${module.id} decision is not tracked: ${decision}`);
        }
      }
    }
    if (!Array.isArray(module.paths) || module.paths.length === 0) {
      errors.push(`module ${module.id} must own at least one production file`);
    }
    for (const pathname of module.paths ?? []) {
      if (!production.has(pathname)) {
        errors.push(`module ${module.id} owns a path that is not a production file: ${pathname}`);
        continue;
      }
      const roots = matchingSourceRoots(pathname, sourceRoots);
      if (roots.length !== 1) {
        errors.push(
          `production file must match exactly one source root: ${pathname} (matched ${roots.length})`,
        );
      } else if (module.runtime !== roots[0].runtime) {
        errors.push(
          `module ${module.id} runtime ${module.runtime} does not match source root ${roots[0].path} runtime ${roots[0].runtime} for ${pathname}`,
        );
      }
    }
  }

  const ownership = mapByPath(map ?? {});
  for (const pathname of production) {
    const owners = ownership.get(pathname) ?? [];
    if (owners.length === 0) errors.push(`production file has no module owner: ${pathname}`);
    else if (owners.length > 1) errors.push(`production file has multiple module owners: ${pathname}`);
  }
  for (const [pathname, owners] of ownership) {
    if (owners.length > 1 && production.has(pathname)) {
      const message = `production file has multiple module owners: ${pathname}`;
      if (!errors.includes(message)) errors.push(message);
    }
  }

  const dependencyKeys = new Set((dependencies ?? []).map(dependencyKey));
  const exceptions = new Map();
  for (const exception of map?.dependencyExceptions ?? []) {
    const key = dependencyKey(exception);
    if (exceptions.has(key)) {
      errors.push(`duplicate module dependency exception: ${exception.from} -> ${exception.to}`);
    }
    exceptions.set(key, exception);
    if (!dependencyKeys.has(key)) {
      errors.push(`stale module dependency exception: ${exception.from} -> ${exception.to}`);
    }
    if (typeof exception.reason !== "string" || exception.reason.trim() === "") {
      errors.push(`module dependency exception requires a reason: ${exception.from} -> ${exception.to}`);
    }
    if (typeof exception.retireWhen !== "string" || exception.retireWhen.trim() === "") {
      errors.push(
        `module dependency exception requires retireWhen: ${exception.from} -> ${exception.to}`,
      );
    }
    if (
      typeof exception.adr !== "string" ||
      !exception.adr.startsWith("docs/adr/") ||
      !tracked.has(exception.adr)
    ) {
      errors.push(
        `module dependency exception requires a tracked ADR: ${exception.from} -> ${exception.to}`,
      );
    }
  }

  for (const dependency of dependencies ?? []) {
    const from = ownership.get(dependency.from)?.[0];
    const to = ownership.get(dependency.to)?.[0];
    if (!from || !to || from.id === to.id) continue;
    if (from.runtime !== to.runtime) {
      errors.push(
        `cross-runtime module dependency is forbidden: ${from.id} (${from.runtime}) -> ${to.id} (${to.runtime}) via ${dependency.from} -> ${dependency.to}`,
      );
      continue;
    }
    const fromLayer = layers.get(from.layer);
    if (
      fromLayer?.forbiddenDependencies?.includes(to.layer) &&
      !exceptions.has(dependencyKey(dependency))
    ) {
      errors.push(
        `forbidden module dependency: ${from.id} (${from.layer}) -> ${to.id} (${to.layer}) via ${dependency.from} -> ${dependency.to}`,
      );
    }
  }

  const declarationCounts = new Map();
  const rustModulePaths = new Map(
    productionFiles
      .filter((candidate) =>
        candidate.startsWith("src-tauri/src/") &&
        candidate.endsWith(".rs") &&
        !candidate.endsWith("/lib.rs") &&
        !candidate.endsWith("/main.rs")
      )
      .map((pathname) => [path.posix.basename(pathname, ".rs"), pathname]),
  );
  const rustEdges = new Map();
  for (const declaration of rustDeclarations ?? []) {
    declarationCounts.set(declaration.name, (declarationCounts.get(declaration.name) ?? 0) + 1);
    const target = rustModulePaths.get(declaration.name);
    if (target) {
      const targets = rustEdges.get(declaration.from) ?? new Set();
      targets.add(target);
      rustEdges.set(declaration.from, targets);
    }
  }
  for (const pathname of productionFiles.filter(
    (candidate) =>
      candidate.startsWith("src-tauri/src/") &&
      candidate.endsWith(".rs") &&
      !candidate.endsWith("/lib.rs") &&
      !candidate.endsWith("/main.rs"),
  )) {
    const name = path.posix.basename(pathname, ".rs");
    const count = declarationCounts.get(name) ?? 0;
    if (count === 0) {
      errors.push(`Rust production module is not declared: ${pathname} (mod ${name};)`);
    } else if (count > 1) {
      errors.push(`Rust production module is declared ${count} times: ${pathname}`);
    }
  }
  const rustRoots = productionFiles.filter(
    (candidate) => candidate === "src-tauri/src/lib.rs" || candidate === "src-tauri/src/main.rs",
  );
  const reachableRust = new Set(rustRoots);
  const pendingRust = [...rustRoots];
  while (pendingRust.length > 0) {
    const current = pendingRust.pop();
    for (const target of rustEdges.get(current) ?? []) {
      if (reachableRust.has(target)) continue;
      reachableRust.add(target);
      pendingRust.push(target);
    }
  }
  for (const pathname of rustModulePaths.values()) {
    if (!reachableRust.has(pathname)) {
      errors.push(
        `Rust production module is not reachable from lib.rs or main.rs: ${pathname}`,
      );
    }
  }
  errors.push(...validateChangeRecords(map ?? {}, tracked));
  return uniqueSorted(errors);
}

function ownershipDescriptor(module) {
  return module ? `${module.id}/${module.layer}/${module.ownerRule}` : "unowned";
}

export function compareModuleMaps(current, base, { dependencyKeys } = {}) {
  const errors = [];
  for (const [kind, previousRecords, currentRecords, identity, removable = () => false] of [
    ["module dependency exception history", base.dependencyExceptions ?? [],
      current.dependencyExceptions ?? [], dependencyKey,
      (record) => dependencyKeys && !dependencyKeys.has(dependencyKey(record))],
    ["historical module map move", base.moves ?? [], current.moves ?? [],
      (record) => changeRecordIdentity("move", record)],
    ["historical module map policy change", base.policyChanges ?? [], current.policyChanges ?? [],
      (record) => changeRecordIdentity("policy change", record)],
  ]) {
    const currentByIdentity = new Map(currentRecords.map((record) => [identity(record), record]));
    for (const previous of previousRecords) {
      const key = identity(previous);
      const next = currentByIdentity.get(key);
      if (!next && !removable(previous)) errors.push(`${kind} was removed: ${key}`);
      else if (next && recordFingerprint(next) !== recordFingerprint(previous)) {
        errors.push(`${kind} was rewritten: ${key}`);
      }
    }
  }
  const currentSourceRoots = new Map((current.sourceRoots ?? []).map((root) => [root.path, root]));
  const baseSourceRootPaths = (base.sourceRoots ?? []).map(({ path }) => path);
  const baseSourceRootSet = new Set(baseSourceRootPaths);
  for (const previous of base.sourceRoots ?? []) {
    const next = currentSourceRoots.get(previous.path);
    if (!next) {
      errors.push(`module source root was removed: ${previous.path}`);
      continue;
    }
    if (next.runtime !== previous.runtime) {
      errors.push(`module source root runtime changed: ${previous.path} ${previous.runtime} -> ${next.runtime}`);
    }
    for (const extension of previous.extensions ?? []) {
      if (!(next.extensions ?? []).includes(extension)) {
        errors.push(`module source root extension was removed: ${previous.path} ${extension}`);
      }
    }
  }
  for (const root of current.sourceRoots ?? []) {
    if (baseSourceRootSet.has(root.path)) continue;
    const approved = (current.policyChanges ?? []).some(
      (change) => change.kind === "add-source-root" && change.path === root.path,
    );
    if (!approved) errors.push(`module source root was added without an ADR-backed policy change: ${root.path}`);
  }
  const retainedOrder = (current.sourceRoots ?? []).map(({ path }) => path)
    .filter((path) => baseSourceRootSet.has(path));
  const expectedOrder = baseSourceRootPaths.filter((path) => currentSourceRoots.has(path));
  if (JSON.stringify(retainedOrder) !== JSON.stringify(expectedOrder)) {
    const approved = (current.policyChanges ?? []).some((change) =>
      change.kind === "reorder-source-roots" &&
      JSON.stringify(change.order) === JSON.stringify(retainedOrder));
    if (!approved) errors.push("module source roots were reordered without an ADR-backed policy change");
  }
  const currentModules = new Map((current.modules ?? []).map((module) => [module.id, module]));
  for (const previous of base.modules ?? []) {
    const nextDecisions = new Set(currentModules.get(previous.id)?.decisions ?? []);
    for (const decision of previous.decisions ?? []) {
      if (!nextDecisions.has(decision)) {
        errors.push(`module ${previous.id} removed historical decision: ${decision}`);
      }
    }
  }
  const currentOwnership = mapByPath(current);
  const baseOwnership = mapByPath(base);
  for (const [pathname, owners] of baseOwnership) {
    const previous = owners[0];
    const next = currentOwnership.get(pathname)?.[0];
    if (ownershipDescriptor(previous) === ownershipDescriptor(next)) continue;
    const approved = (current.moves ?? []).some((move) => move.path === pathname &&
      move.fromModule === previous?.id && (move.toModule ?? null) === (next?.id ?? null));
    if (!approved) {
      errors.push(
        `module ownership changed without an ADR-backed move: ${pathname} ${ownershipDescriptor(previous)} -> ${ownershipDescriptor(next)}`,
      );
    }
  }
  const currentLayers = new Map((current.layers ?? []).map((layer) => [layer.id, layer]));
  const baseLayers = new Set((base.layers ?? []).map((layer) => layer.id));
  for (const layer of current.layers ?? []) {
    if (baseLayers.has(layer.id)) continue;
    const approved = (current.policyChanges ?? []).some(
      (change) => change.kind === "add-layer" && change.layer === layer.id,
    );
    if (!approved) errors.push(`module layer was added without an ADR-backed policy change: ${layer.id}`);
  }
  for (const layer of base.layers ?? []) {
    for (const target of layer.forbiddenDependencies ?? []) {
      if (currentLayers.get(layer.id)?.forbiddenDependencies?.includes(target)) continue;
      const approved = (current.policyChanges ?? []).some(
        (change) => change.from === layer.id && change.to === target,
      );
      if (!approved) errors.push(`dependency policy was weakened without an ADR-backed change: ${layer.id} -> ${target}`);
    }
  }
  return errors.sort((left, right) => left.localeCompare(right));
}

export function selectModuleContext(map, changedPaths) {
  const changed = new Set(changedPaths);
  const selected = (map.modules ?? []).filter((module) =>
    (module.paths ?? []).some((pathname) => changed.has(pathname)),
  );
  return {
    modules: uniqueSorted(selected.map((module) => module.id)),
    ownerRules: uniqueSorted(selected.map((module) => module.ownerRule)),
    decisions: uniqueSorted(selected.flatMap((module) => module.decisions ?? [])),
  };
}

export function checkRepositoryModuleMap(root, { baseMap } = {}) {
  const map = JSON.parse(readFileSync(path.join(root, MODULE_MAP_PATH), "utf8"));
  const trackedFiles = listRepositoryFiles(root);
  const productionFiles = discoverProductionFiles(root, map);
  const discovered = discoverModuleDependencies(root, map, productionFiles);
  const repositoryHazards = findForbiddenTrackedArtifactPaths(trackedFiles);
  for (const pathname of trackedFiles) {
    try {
      const absolute = path.join(root, pathname);
      if (lstatSync(absolute).isFile()) {
        repositoryHazards.push(...findSensitiveTrackedContent(pathname, readFileSync(absolute)));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const errors = validateModuleMap({
    map,
    productionFiles,
    trackedFiles,
    dependencies: discovered.dependencies,
    rustDeclarations: discovered.rustDeclarations,
    hazards: [
      ...repositoryHazards,
      ...findRustSourceTreeHazards(trackedFiles),
      ...discovered.hazards,
    ],
  });
  if (baseMap) errors.push(...compareModuleMaps(map, baseMap, {
    dependencyKeys: new Set(discovered.dependencies.map(dependencyKey)),
  }));
  return uniqueSorted(errors);
}
