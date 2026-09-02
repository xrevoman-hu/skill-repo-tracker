import path from "node:path";
import ts from "typescript";

import { rustCodeOnly, rustDelimiterRanges } from "./module-map-rust-policy.mjs";
import { isDedicatedRustTestModulePath } from "./source-classification.mjs";
import { findForbiddenTestModifiers } from "./test-evidence-policy.mjs";

const JAVASCRIPT_RUNNERS = [
  { root: "src/", module: "vitest", name: "vitest" },
  { root: "e2e/", module: "@playwright/test", name: "playwright" },
];
const JAVASCRIPT_SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const JAVASCRIPT_TEST = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const TEST_REGISTRATIONS = new Set(["test", "it", "describe", "suite"]);

function javaScriptKind(pathname) {
  if (pathname.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (pathname.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(pathname)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseJavaScript(pathname, source) {
  return ts.createSourceFile(
    pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    javaScriptKind(pathname),
  );
}

function javaScriptLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
}

function resolveStaticJavaScriptDependency(from, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return undefined;
  const canonical = specifier.replace(/[?#].*$/, "");
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), canonical),
  );
  const substitutions = [
    [/\.jsx?$/, [".ts", ".tsx"]],
    [/\.mjs$/, [".mts"]],
    [/\.cjs$/, [".cts"]],
  ].flatMap(([pattern, extensions]) =>
    pattern.test(unresolved)
      ? extensions.map((extension) => unresolved.replace(pattern, extension))
      : [],
  );
  const candidates = [
    unresolved,
    ...substitutions,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map(
      (extension) => `${unresolved}${extension}`,
    ),
    ...["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.jsx"].map(
      (filename) => path.posix.join(unresolved, filename),
    ),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function staticJavaScriptDependencies(pathname, source, knownFiles) {
  const sourceFile = parseJavaScript(pathname, source);
  const dependencies = new Set();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const target = resolveStaticJavaScriptDependency(
        pathname,
        statement.moduleSpecifier.text,
        knownFiles,
      );
      if (target) dependencies.add(target);
    }
  }
  return [...dependencies];
}

function helperDirectRegistrationHazards(pathname, source) {
  const sourceFile = parseJavaScript(pathname, source);
  const errors = [];
  const registrationName = (call) => {
    if (ts.isIdentifier(call.expression) && TEST_REGISTRATIONS.has(call.expression.text)) {
      return call.expression.text;
    }
    if (
      ts.isCallExpression(call.expression) &&
      ts.isPropertyAccessExpression(call.expression.expression) &&
      call.expression.expression.name.text === "each" &&
      ts.isIdentifier(call.expression.expression.expression) &&
      TEST_REGISTRATIONS.has(call.expression.expression.expression.text)
    ) {
      return `${call.expression.expression.expression.text}.each`;
    }
    return undefined;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = registrationName(node);
      if (name) {
        errors.push(
          `${pathname}:${javaScriptLocation(sourceFile, node)} runner helper calls ${name} registration API; helpers may export fixtures or utilities but cannot register tests`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

function helperRunnerImportHazards(
  pathname,
  source,
  runnerModule,
  { rejectDynamicLoading = false } = {},
) {
  const sourceFile = parseJavaScript(pathname, source);
  const errors = [];
  const reject = (node, detail) => {
    errors.push(
      `${pathname}:${javaScriptLocation(sourceFile, node)} runner helper exposes ${detail} registration API from ${runnerModule}; helpers may import assertions but cannot register tests`,
    );
  };
  const rejectDynamicLoader = (node, kind) => {
    errors.push(
      `${pathname}:${javaScriptLocation(sourceFile, node)} runner helper uses ${kind}; helper dependency closure must remain statically auditable`,
    );
  };
  const inspectStatic = (node) => {
    if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    if (node.moduleSpecifier.text !== runnerModule) return;
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause) reject(node, "namespace");
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (TEST_REGISTRATIONS.has(imported)) reject(element, imported);
        }
      }
      return;
    }
    const clause = node.importClause;
    if (clause?.name) reject(clause.name, "default");
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      reject(clause.namedBindings, "namespace");
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (TEST_REGISTRATIONS.has(imported)) reject(element, imported);
      }
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) inspectStatic(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === runnerModule) {
        reject(node, "dynamic");
      } else if (rejectDynamicLoading) {
        rejectDynamicLoader(node, "dynamic import");
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      if (ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === runnerModule) {
        reject(node, "dynamic");
      } else if (rejectDynamicLoading) {
        rejectDynamicLoader(node, "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

export function findJavaScriptRunnerHelperHazards({ paths, sources }) {
  const errors = [];
  for (const runner of JAVASCRIPT_RUNNERS) {
    const runnerPaths = paths.filter(
      (pathname) => pathname.startsWith(runner.root) && JAVASCRIPT_SOURCE.test(pathname),
    );
    const knownFiles = new Set(runnerPaths);
    const tests = runnerPaths.filter((pathname) => JAVASCRIPT_TEST.test(pathname));
    const reachable = new Set(tests);
    const queue = [...tests];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const dependency of staticJavaScriptDependencies(
        current,
        sources[current] ?? "",
        knownFiles,
      )) {
        if (reachable.has(dependency)) continue;
        reachable.add(dependency);
        queue.push(dependency);
      }
    }
    for (const pathname of runnerPaths.filter((candidate) => !JAVASCRIPT_TEST.test(candidate))) {
      const source = sources[pathname] ?? "";
      const importErrors = helperRunnerImportHazards(pathname, source, runner.module, {
        rejectDynamicLoading: reachable.has(pathname),
      });
      const directErrors = helperDirectRegistrationHazards(pathname, source);
      const modifierErrors = findForbiddenTestModifiers(pathname, source);
      const runnerAware = importErrors.length + directErrors.length + modifierErrors.length > 0;
      const mustBeReachable = runner.root === "e2e/" || runnerAware;
      if (mustBeReachable && !reachable.has(pathname)) {
        errors.push(
          `${pathname} runner helper is not statically reachable from a discovered ${runner.name} test/spec`,
        );
      }
      if (reachable.has(pathname) || runnerAware) {
        errors.push(...importErrors, ...directErrors, ...modifierErrors);
      }
    }
  }
  return uniqueSorted(errors);
}

export const FIXED_RUST_TEST_CFG = [
  "debug_assertions",
  'target_os="macos"',
  "test",
  "unix",
];


function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function matchingBrace(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function rawAttributes(raw) {
  return [...raw.matchAll(/#\s*\[[^\]]+\]/g)].map((match) => match[0]);
}

function normalizedCfg(attribute) {
  const body = attribute.match(/^#\s*\[\s*cfg\s*\(([\s\S]*)\)\s*\]$/)?.[1];
  return body?.replace(/\s+/g, "");
}

function moduleRanges(source, code) {
  const ranges = [];
  const pattern = /(?<attrs>(?:[ \t]*#\s*\[[^\]]+\][ \t]*(?:\r?\n|))*)[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(?<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/gm;
  for (const match of code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingBrace(code, opening);
    if (closing === undefined) continue;
    const attrs = rawAttributes(source.slice(match.index, opening));
    ranges.push({
      opening,
      closing,
      cfg: attrs.map(normalizedCfg).filter(Boolean),
      cfgAttr: attrs.some((attribute) => /^#\s*\[\s*cfg_attr\b/.test(attribute)),
    });
  }
  return ranges;
}

function testFunctions(source, code) {
  const tests = [];
  const pattern = /(?<attrs>(?:[ \t]*#\s*\[[^\]]+\][ \t]*(?:\r?\n|))*)[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?fn[ \t]+(?<name>[A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const match of code.matchAll(pattern)) {
    const attrs = rawAttributes(source.slice(match.index, match.index + match.groups.attrs.length));
    if (!attrs.some((attribute) => /^#\s*\[\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*test\s*\]$/.test(attribute))) {
      continue;
    }
    tests.push({
      index: match.index,
      name: match.groups.name,
      cfg: attrs.map(normalizedCfg).filter(Boolean),
      cfgAttr: attrs.some((attribute) => /^#\s*\[\s*cfg_attr\b/.test(attribute)),
    });
  }
  return tests;
}

function productionModuleDeclarations(pathname, source, code, productionPaths) {
  const targets = [];
  const delimiters = rustDelimiterRanges(code);
  const pattern = /(?<attrs>(?:[ \t]*#\s*\[[^\]]+\][ \t]*(?:\r?\n|))*)[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(?<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]*;/gm;
  for (const match of code.matchAll(pattern)) {
    const attrs = rawAttributes(source.slice(match.index, match.index + match[0].length));
    if (attrs.some((attribute) => /^#\s*\[\s*cfg(?:_attr)?\b/.test(attribute))) continue;
    if (attrs.some((attribute) => /^#\s*\[\s*path\b/.test(attribute))) continue;
    if (delimiters.some(
      (range) => match.index > range.opening && match.index < range.closing,
    )) continue;
    const target = path.posix.join(path.posix.dirname(pathname), `${match.groups.name}.rs`);
    if (productionPaths.has(target)) targets.push(target);
  }
  return targets;
}

function externalTestDeclarations(pathname, source, code) {
  const declarations = [];
  const pattern = /(?<attrs>(?:[ \t]*#\s*\[[^\]]+\][ \t]*(?:\r?\n|))*)[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(?<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]*;/gm;
  for (const match of code.matchAll(pattern)) {
    const raw = source.slice(match.index, match.index + match[0].length);
    const attrs = rawAttributes(raw);
    const pathValue = attrs
      .map((attribute) => attribute.match(/^#\s*\[\s*path\s*=\s*"([^"\\\r\n]+)"\s*\]$/)?.[1])
      .find(Boolean);
    if (!pathValue) continue;
    declarations.push({
      target: path.posix.normalize(path.posix.join(path.posix.dirname(pathname), pathValue)),
      canonicalTestCfg:
        attrs.filter((attribute) => normalizedCfg(attribute) !== undefined).length === 1 &&
        attrs.some((attribute) => normalizedCfg(attribute) === "test") &&
        !attrs.some((attribute) => /^#\s*\[\s*cfg_attr\b/.test(attribute)),
    });
  }
  return declarations;
}

export function findRustTestInventoryHazards({ paths, sources, allowedCfg }) {
  const errors = [];
  const allowed = new Set(allowedCfg);
  const rustPaths = paths.filter((pathname) => pathname.endsWith(".rs"));
  const sourceFor = (pathname) => sources[pathname] ?? "";
  const externalTests = rustPaths.filter(
    (pathname) => pathname.startsWith("src-tauri/src/") && isDedicatedRustTestModulePath(pathname),
  );
  const productionPaths = new Set(rustPaths.filter(
    (pathname) => pathname.startsWith("src-tauri/src/") && !isDedicatedRustTestModulePath(pathname),
  ));
  const productionEdges = new Map();
  for (const pathname of productionPaths) {
    const source = sourceFor(pathname);
    const code = rustCodeOnly(source);
    productionEdges.set(
      pathname,
      productionModuleDeclarations(pathname, source, code, productionPaths),
    );
  }
  const cargoRoots = [...productionPaths].filter(
    (pathname) => pathname === "src-tauri/src/lib.rs" || pathname === "src-tauri/src/main.rs",
  );
  const reachableProduction = new Set(cargoRoots);
  const pendingProduction = [...cargoRoots];
  while (pendingProduction.length > 0) {
    const current = pendingProduction.pop();
    for (const target of productionEdges.get(current) ?? []) {
      if (reachableProduction.has(target)) continue;
      reachableProduction.add(target);
      pendingProduction.push(target);
    }
  }
  for (const pathname of productionPaths) {
    if (!reachableProduction.has(pathname)) {
      errors.push(`Rust production test host is not reachable from a Cargo root: ${pathname}`);
    }
  }
  const declarationCounts = new Map();
  for (const pathname of reachableProduction) {
    const source = sourceFor(pathname);
    const code = rustCodeOnly(source);
    for (const declaration of externalTestDeclarations(pathname, source, code)) {
      if (!externalTests.includes(declaration.target)) continue;
      if (!declaration.canonicalTestCfg) {
        errors.push(
          `${pathname} exposes ${declaration.target} without exact #[cfg(test)] and #[path]`,
        );
        continue;
      }
      declarationCounts.set(
        declaration.target,
        (declarationCounts.get(declaration.target) ?? 0) + 1,
      );
    }
  }
  for (const pathname of externalTests) {
    const count = declarationCounts.get(pathname) ?? 0;
    if (count !== 1) {
      errors.push(
        `${pathname} must be reachable exactly once from the lib/main cfg(test) module tree; found ${count}`,
      );
    }
  }

  for (const pathname of rustPaths.filter((candidate) => candidate.startsWith("src-tauri/tests/"))) {
    const relative = pathname.slice("src-tauri/tests/".length);
    if (relative.includes("/")) {
      errors.push(
        `nested Rust integration test source is not runner-modeled: ${pathname}`,
      );
    }
  }

  for (const pathname of rustPaths) {
    const source = sourceFor(pathname);
    const code = rustCodeOnly(source);
    const ranges = moduleRanges(source, code);
    const delimiters = rustDelimiterRanges(code);
    const tests = testFunctions(source, code);
    const knownRunnerRoot =
      pathname.startsWith("src-tauri/src/") || pathname.startsWith("src-tauri/tests/");
    if (!knownRunnerRoot && (tests.length > 0 || isDedicatedRustTestModulePath(pathname))) {
      errors.push(`Rust test-like file is not reachable by a configured Cargo target: ${pathname}`);
    }
    let runnableTests = 0;
    for (const rustTest of tests) {
      const containers = ranges.filter(
        (range) => rustTest.index > range.opening && rustTest.index < range.closing,
      );
      const moduleRangeKeys = new Set(
        containers.map((range) => `${range.opening}:${range.closing}`),
      );
      const nonModuleContainers = delimiters.filter(
        (range) =>
          rustTest.index > range.opening &&
          rustTest.index < range.closing &&
          !moduleRangeKeys.has(`${range.opening}:${range.closing}`),
      );
      if (nonModuleContainers.length > 0) {
        errors.push(
          `${pathname} test ${rustTest.name} is not a direct crate or module item and may not be runner-discoverable`,
        );
        continue;
      }
      runnableTests += 1;
      const cfg = [...rustTest.cfg, ...containers.flatMap((range) => range.cfg)];
      const hasCfgAttr = rustTest.cfgAttr || containers.some((range) => range.cfgAttr);
      for (const condition of cfg) {
        if (!allowed.has(condition)) {
          errors.push(
            `${pathname} test ${rustTest.name} uses runner-dependent cfg(${condition})`,
          );
        }
      }
      if (hasCfgAttr) {
        errors.push(`${pathname} test ${rustTest.name} uses cfg_attr and is not fixed-runner auditable`);
      }
      if (
        pathname.startsWith("src-tauri/src/") &&
        !externalTests.includes(pathname) &&
        !containers.some((range) => range.cfg.includes("test"))
      ) {
        errors.push(
          `${pathname} test ${rustTest.name} is not enclosed by an exact #[cfg(test)] module`,
        );
      }
    }
    const externalOrIntegration =
      externalTests.includes(pathname) ||
      (pathname.startsWith("src-tauri/tests/") && !pathname.slice("src-tauri/tests/".length).includes("/"));
    if (
      (externalOrIntegration || /\.(?:test|spec)\.rs$/.test(pathname)) &&
      runnableTests === 0
    ) {
      errors.push(`${pathname} does not statically declare any Rust test`);
    }
  }
  return uniqueSorted(errors);
}
