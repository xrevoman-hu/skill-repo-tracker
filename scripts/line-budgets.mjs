import path from "node:path";
import ts from "typescript";
import { isDeepStrictEqual } from "node:util";
import { findForbiddenToolingRuntimeLoading } from "./tooling-runtime-policy.mjs";

export { findForbiddenToolingRuntimeLoading };

const MAX_LINE_BYTES = 800;
const MAX_MODULE_BYTES = 65_536;

export function fileCompressionMetrics(contents) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
  const lines = buffer.toString("utf8").split(/\r?\n/);
  return {
    bytes: buffer.byteLength,
    maxLineBytes: Math.max(0, ...lines.map((line) => Buffer.byteLength(line))),
  };
}

export function checkCompressionBudget({ metrics, budget, scope }) {
  const errors = [];
  if (budget?.maxLineBytes !== MAX_LINE_BYTES) {
    errors.push(`${scope} max line bytes must remain ${MAX_LINE_BYTES}`);
  }
  if (budget?.newModuleMaxBytes !== MAX_MODULE_BYTES) {
    errors.push(`${scope} new module bytes must remain ${MAX_MODULE_BYTES}`);
  }
  for (const [path, metric] of Object.entries(metrics)) {
    if (metric.maxLineBytes > MAX_LINE_BYTES) {
      errors.push(`${path} has a ${metric.maxLineBytes}-byte line; maximum is ${MAX_LINE_BYTES}`);
    }
    const hotSpot = budget?.hotSpots?.[path];
    const status = hotSpot?.status ?? "active";
    if (hotSpot && status === "active" && metric.bytes !== hotSpot.maxBytes) {
      errors.push(
        `${path} has ${metric.bytes} bytes; hotspot byte snapshot must equal ${hotSpot.maxBytes}`,
      );
    } else if ((!hotSpot || status !== "active") && metric.bytes > MAX_MODULE_BYTES) {
      errors.push(`${path} has ${metric.bytes} bytes; new modules are limited to ${MAX_MODULE_BYTES}`);
    }
  }
  return errors;
}

export function compareCompressionBudgets(current, base, scope) {
  if (!base) return [];
  const errors = [];
  for (const field of ["maxLineBytes", "newModuleMaxBytes"]) {
    if (
      typeof base[field] === "number" &&
      (typeof current?.[field] !== "number" || current[field] > base[field])
    ) {
      errors.push(
        `${scope} ${field} increased from ${base[field]} to ${current?.[field] ?? "missing"}`,
      );
    }
  }
  for (const [path, previous] of Object.entries(base.hotSpots ?? {})) {
    if (typeof previous.maxBytes !== "number") continue;
    const snapshot = current?.hotSpots?.[path];
    // The line-budget lifecycle comparator owns removal; byte comparison owns surviving records.
    if (!snapshot) continue;
    if (typeof snapshot?.maxBytes !== "number" || snapshot.maxBytes > previous.maxBytes) {
      errors.push(
        `${scope} hotspot ${path} byte budget increased from ${previous.maxBytes} to ${snapshot?.maxBytes ?? "missing"}`,
      );
    }
  }
  return errors;
}

export function isToolingModule(path) {
  return (
    path.startsWith("scripts/") &&
    /\.(?:[cm]?js|[cm]?ts)$/.test(path) &&
    !path.startsWith("scripts/__tests__/") &&
    !/\.(?:test|spec)\.(?:[cm]?js|[cm]?ts)$/.test(path)
  );
}

export function isToolingTestModule(pathname) {
  return pathname.startsWith("scripts/__tests__/") && pathname.endsWith(".mjs");
}

function localToolingDependency(sourcePath, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return undefined;
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), specifier.replace(/[?#].*$/, "")),
  );
  const candidates = [
    unresolved,
    ...[".mjs", ".js", ".cjs", ".mts", ".ts", ".cts"].map(
      (extension) => `${unresolved}${extension}`,
    ),
    ...["index.mjs", "index.js", "index.mts", "index.ts"].map(
      (filename) => path.posix.join(unresolved, filename),
    ),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function toolingDependencies(sourcePath, source, knownFiles) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    toolingScriptKind(sourcePath),
  );
  const dependencies = new Set();
  const add = (node) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    const resolved = localToolingDependency(sourcePath, node.text, knownFiles);
    if (resolved) dependencies.add(resolved);
  };
  for (const node of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      add(node.moduleSpecifier);
    }
  }
  return dependencies;
}

export function findOrphanToolingModules({ sources, entrypoints, standalone = {} }) {
  const errors = [];
  const knownFiles = new Set(Object.keys(sources));
  const roots = new Set(entrypoints);
  for (const [pathname, record] of Object.entries(standalone)) {
    if (!knownFiles.has(pathname)) {
      errors.push(`standalone tooling catalog references a missing module: ${pathname}`);
      continue;
    }
    if (!["cli", "generator"].includes(record.kind)) {
      errors.push(`standalone tooling module ${pathname} must declare kind cli or generator`);
    }
    if (typeof record.owner !== "string" || record.owner.trim() === "") {
      errors.push(`standalone tooling module ${pathname} must declare an owner`);
    }
    if (typeof record.retireWhen !== "string" || record.retireWhen.trim() === "") {
      errors.push(`standalone tooling module ${pathname} must declare retireWhen`);
    }
  }
  const reachable = new Set();
  const queue = [...roots].filter((pathname) => knownFiles.has(pathname));
  while (queue.length > 0) {
    const pathname = queue.shift();
    if (reachable.has(pathname)) continue;
    reachable.add(pathname);
    for (const dependency of toolingDependencies(pathname, sources[pathname], knownFiles)) {
      if (!reachable.has(dependency)) queue.push(dependency);
    }
  }
  for (const pathname of knownFiles) {
    if (!reachable.has(pathname) && !Object.hasOwn(standalone, pathname)) {
      errors.push(
        `orphan governance tool is not reachable from a package/workflow/verify entrypoint: ${pathname}`,
      );
    }
  }
  return errors.sort((left, right) => left.localeCompare(right));
}

export function findToolingTestHelperHazards({ sources, fixtureCatalog = {} }) {
  const knownFiles = new Set(Object.keys(sources));
  const collected = (pathname) => /^scripts\/__tests__\/[^/]+\.test\.mjs$/.test(pathname);
  const reachable = new Set();
  const queue = [...knownFiles].filter(collected);
  while (queue.length > 0) {
    const pathname = queue.shift();
    if (reachable.has(pathname)) continue;
    reachable.add(pathname);
    for (const dependency of toolingDependencies(pathname, sources[pathname], knownFiles)) {
      if (!reachable.has(dependency)) queue.push(dependency);
    }
  }
  const errors = [];
  for (const [pathname, record] of Object.entries(fixtureCatalog)) {
    if (!knownFiles.has(pathname)) {
      errors.push(`tooling fixture catalog references a missing helper: ${pathname}`);
    }
    if (typeof record?.owner !== "string" || record.owner.trim() === "") {
      errors.push(`tooling fixture ${pathname} must declare an owner`);
    }
    if (typeof record?.retireWhen !== "string" || record.retireWhen.trim() === "") {
      errors.push(`tooling fixture ${pathname} must declare retireWhen`);
    }
  }
  for (const pathname of [...knownFiles].filter((candidate) => !collected(candidate))) {
    const sourceFile = ts.createSourceFile(
      pathname,
      sources[pathname],
      ts.ScriptTarget.Latest,
      true,
      toolingScriptKind(pathname),
    );
    let importsNodeTest = false;
    const dynamicLoaders = [];
    const visit = (node) => {
      const specifier =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))
            ? node.arguments[0]
            : undefined;
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text === "node:test") {
        importsNodeTest = true;
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        !ts.isStringLiteralLike(node.arguments[0])
      ) {
        dynamicLoaders.push("dynamic import");
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        !ts.isStringLiteralLike(node.arguments[0])
      ) {
        dynamicLoaders.push("require");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (importsNodeTest) {
      errors.push(`tooling test helper imports node:test registration APIs: ${pathname}`);
    }
    if (reachable.has(pathname)) {
      for (const kind of new Set(dynamicLoaders)) {
        errors.push(
          `tooling test helper uses non-literal ${kind}; dependency closure must remain statically auditable: ${pathname}`,
        );
      }
    }
    if (!reachable.has(pathname) && !Object.hasOwn(fixtureCatalog, pathname)) {
      errors.push(
        `tooling test helper is not statically reachable from a collected *.test.mjs file: ${pathname}`,
      );
    }
  }
  return errors.sort((left, right) => left.localeCompare(right));
}

function registrationKind(call) {
  if (ts.isIdentifier(call.expression) && ["test", "it", "describe", "suite"].includes(
    call.expression.text,
  )) {
    return call.expression.text;
  }
  if (
    ts.isCallExpression(call.expression) &&
    ts.isPropertyAccessExpression(call.expression.expression) &&
    call.expression.expression.name.text === "each" &&
    ts.isIdentifier(call.expression.expression.expression) &&
    ["test", "it", "describe", "suite"].includes(
      call.expression.expression.expression.text,
    )
  ) {
    return call.expression.expression.expression.text;
  }
  return undefined;
}

function registrationIsStatic(call, sourceFile) {
  let current = call;
  while (current.parent && current.parent !== sourceFile) {
    const parent = current.parent;
    if (ts.isFunctionLike(parent)) {
      const container = parent.parent;
      if (
        !ts.isCallExpression(container) ||
        !container.arguments.includes(parent) ||
        !["describe", "suite"].includes(registrationKind(container))
      ) {
        return false;
      }
      current = container;
      continue;
    }
    if (
      !ts.isExpressionStatement(parent) &&
      !ts.isBlock(parent) &&
      !ts.isParenthesizedExpression(parent)
    ) {
      return false;
    }
    current = parent;
  }
  return current.parent === sourceFile;
}

export function findStaticTestRegistrationHazards(pathname, source) {
  const sourceFile = ts.createSourceFile(
    pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    toolingScriptKind(pathname),
  );
  const errors = [];
  let staticTests = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const kind = registrationKind(node);
      if (kind) {
        if (!registrationIsStatic(node, sourceFile)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          errors.push(
            `${pathname}:${line + 1}:${character + 1} ${kind} is not statically registered at top level or inside describe`,
          );
        } else if (["test", "it"].includes(kind)) {
          staticTests += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (staticTests === 0) {
    errors.push(`${pathname} does not statically register any runnable test`);
  }
  return [...new Set(errors)];
}

function toolingScriptKind(pathname) {
  if (pathname.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (pathname.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (pathname.endsWith(".ts") || pathname.endsWith(".mts") || pathname.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

export function findForbiddenTestRegistrationIndirection(pathname, source) {
  const sourceFile = ts.createSourceFile(
    pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    toolingScriptKind(pathname),
  );
  const errors = [];
  const forbidden = new Set(["skip", "skipIf", "runIf", "only", "todo"]);
  const registrations = new Set(["test", "it", "describe", "suite"]);
  const testRunnerModules = new Set(["node:test", "vitest", "@playwright/test"]);
  const expectedRunner = pathname.startsWith("scripts/__tests__/")
    ? "node:test"
    : pathname.startsWith("e2e/")
      ? "@playwright/test"
      : pathname.startsWith("src/")
        ? "vitest"
        : undefined;
  const globalObjects = new Set(["globalThis", "window", "self"]);
  const location = (node) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${line + 1}:${character + 1}`;
  };
  const hasStaticForbiddenMember = (identifier) => {
    let current = identifier;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isCallExpression(parent) && parent.expression === current) {
        current = parent;
        continue;
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
        if (forbidden.has(parent.name.text)) return true;
        current = parent;
        continue;
      }
      if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === current &&
        ts.isStringLiteralLike(parent.argumentExpression)
      ) {
        if (forbidden.has(parent.argumentExpression.text)) return true;
        current = parent;
        continue;
      }
      break;
    }
    return false;
  };
  const isNonReferencePropertyName = (identifier) => {
    const parent = identifier.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
      (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
      ((ts.isMethodDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isEnumMember(parent)) &&
        parent.name === identifier)
    );
  };
  const isExactImportBinding = (identifier) => {
    const parent = identifier.parent;
    if (ts.isImportClause(parent) && parent.name === identifier) return true;
    return (
      ts.isImportSpecifier(parent) &&
      parent.name === identifier &&
      (!parent.propertyName || parent.propertyName.text === identifier.text)
    );
  };
  const isAllowedRegistrationReference = (identifier) => {
    const parent = identifier.parent;
    if (isNonReferencePropertyName(identifier) || isExactImportBinding(identifier)) return true;
    if (ts.isCallExpression(parent) && parent.expression === identifier) return true;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === identifier &&
      parent.name.text === "each" &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      ts.isCallExpression(parent.parent.parent) &&
      parent.parent.parent.expression === parent.parent
    ) {
      return true;
    }
    return hasStaticForbiddenMember(identifier);
  };
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const registrationBindings = [];
      if (clause?.name && registrations.has(clause.name.text)) {
        registrationBindings.push(clause.name);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (registrations.has(element.name.text)) registrationBindings.push(element.name);
        }
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        if (registrations.has(clause.namedBindings.name.text)) {
          registrationBindings.push(clause.namedBindings.name);
        }
      }
      if (expectedRunner && node.moduleSpecifier.text !== expectedRunner) {
        for (const binding of registrationBindings) {
          errors.push(
            `${pathname}:${location(binding)} ${binding.text} registration import must come from ${expectedRunner}`,
          );
        }
      }
      if (
        testRunnerModules.has(node.moduleSpecifier.text) &&
        clause?.name &&
        clause.name.text !== "test"
      ) {
        errors.push(
          `${pathname}:${location(clause.name)} test runner default import must be named test`,
        );
      }
      if (
        testRunnerModules.has(node.moduleSpecifier.text) &&
        clause?.namedBindings &&
        ts.isNamespaceImport(clause.namedBindings)
      ) {
        errors.push(
          `${pathname}:${location(clause.namedBindings)} test runner namespace imports are forbidden`,
        );
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      globalObjects.has(node.expression.text) &&
      (ts.isElementAccessExpression(node) || registrations.has(node.name.text))
    ) {
      errors.push(
        `${pathname}:${location(node)} computed global test API access is forbidden`,
      );
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Reflect" &&
      node.expression.name.text === "get"
    ) {
      errors.push(
        `${pathname}:${location(node)} Reflect.get is forbidden in test modules because computed registration access is not auditable`,
      );
      return;
    }
    if (
      ts.isIdentifier(node) &&
      registrations.has(node.text) &&
      !isAllowedRegistrationReference(node)
    ) {
      errors.push(
        `${pathname}:${location(node)} ${node.text} registration API is used indirectly; only direct ${node.text}(...) and ${node.text}.each(...)(...) registration are allowed`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

function localToolingImportTarget(sourcePath, specifier) {
  const canonical = specifier.replace(/[?#].*$/, "");
  if (canonical.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), canonical));
  }
  if (canonical.startsWith("scripts/")) return path.posix.normalize(canonical);
  return undefined;
}

function isTestOnlyToolingTarget(target) {
  return (
    target.startsWith("scripts/__tests__/") ||
    /(?:^|\/)[^/]+\.(?:test|spec)(?:\.[cm]?[jt]s)?$/.test(target)
  );
}

export function findForbiddenToolingTestImports(sourcePath, source) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    toolingScriptKind(sourcePath),
  );
  const errors = new Set(findForbiddenToolingRuntimeLoading(sourcePath, source));
  const inspectSpecifier = (argument, kind) => {
    if (!argument || !ts.isStringLiteralLike(argument)) {
      errors.add(
        `${sourcePath} uses a non-literal ${kind}; production tooling imports must be statically auditable`,
      );
      return;
    }
    const canonical = argument.text.replace(/[?#].*$/, "");
    const target = localToolingImportTarget(sourcePath, argument.text);
    if (
      (target && !target.startsWith("scripts/")) ||
      canonical.startsWith("file:") ||
      canonical.startsWith("/")
    ) {
      errors.add(
        `${sourcePath} imports executable repository code outside governed scripts/: ${argument.text}`,
      );
    } else if (target && isTestOnlyToolingTarget(target)) {
      errors.add(`${sourcePath} imports test-only tooling module ${argument.text}`);
    }
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      inspectSpecifier(node.moduleSpecifier, "module specifier");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      inspectSpecifier(node.moduleReference.expression, "import-equals require");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      inspectSpecifier(node.arguments[0], "dynamic import");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      inspectSpecifier(node.arguments[0], "require");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...errors].sort((left, right) => left.localeCompare(right));
}

export function checkToolingSnapshot({ files, budget, compressionMetrics }) {
  const errors = [];
  if (budget?.newModuleMaxLines !== 800) {
    errors.push(
      `new governance tool cap must remain 800 lines; found ${budget?.newModuleMaxLines ?? "missing"}`,
    );
  }
  const hotSpots = budget?.hotSpots ?? {};
  for (const [path, snapshot] of Object.entries(hotSpots)) {
    const status = snapshot.status ?? "active";
    if (!["active", "retiring", "retired"].includes(status)) {
      errors.push(`tooling hotspot ${path} has unsupported status: ${status}`);
      continue;
    }
    if (
      ["retiring", "retired"].includes(status) &&
      (typeof snapshot.retirement?.reason !== "string" ||
        snapshot.retirement.reason.trim() === "")
    ) {
      errors.push(`${status} tooling hotspot ${path} must declare a retirement reason`);
    }
    const lines = files[path];
    if (status === "active" && typeof lines !== "number") {
      errors.push(`tooling hotspot is missing from the repository: ${path}`);
    } else if (status === "active" && lines !== snapshot.maxLines) {
      errors.push(
        `${path} has ${lines} lines; tooling hotspot snapshot must equal ${snapshot.maxLines} and be updated downward with the code`,
      );
    } else if (status !== "active" && typeof lines === "number" && lines > 800) {
      errors.push(
        `${status} tooling hotspot ${path} still has ${lines} lines; retirement requires the normal 800-line cap or file removal`,
      );
    }
  }
  for (const [path, lines] of Object.entries(files)) {
    if (!Object.hasOwn(hotSpots, path) && lines > 800) {
      errors.push(`${path} has ${lines} lines; new governance tools are limited to 800`);
    }
  }
  if (compressionMetrics) {
    errors.push(
      ...checkCompressionBudget({ metrics: compressionMetrics, budget, scope: "tooling" }),
    );
  }
  return errors;
}

export function compareToolingBudgets(current, base) {
  if (!base) return [];
  const errors = [];
  for (const [path, previous] of Object.entries(base.hotSpots ?? {})) {
    const snapshot = current?.hotSpots?.[path];
    const previousStatus = previous.status ?? "active";
    if (!snapshot) {
      if (previousStatus !== "retired") {
        errors.push(`${previousStatus} tooling hotspot was removed without retirement: ${path}`);
      }
      continue;
    }
    const status = snapshot.status ?? "active";
    if (previousStatus === "active" && status === "retired") {
      errors.push(`active tooling hotspot ${path} cannot skip directly to retired`);
    }
    if (previousStatus === "retiring" && status === "active") {
      errors.push(`retiring tooling hotspot ${path} cannot return to active`);
    }
    if (previousStatus === "retired" && status !== "retired") {
      errors.push(`retired tooling hotspot ${path} cannot return to ${status}`);
    }
    if (
      ["retiring", "retired"].includes(previousStatus) &&
      !isDeepStrictEqual(snapshot.retirement, previous.retirement)
    ) {
      errors.push(`tooling hotspot ${path} retirement metadata changed`);
    }
    if (snapshot.adr !== previous.adr) {
      errors.push(`tooling hotspot ${path} ADR changed from ${previous.adr} to ${snapshot.adr}`);
    }
    if (snapshot.maxLines > previous.maxLines) {
      errors.push(
        `tooling hotspot ${path} budget increased from ${previous.maxLines} to ${snapshot.maxLines}`,
      );
    }
    if (
      typeof previous.targetLines === "number" &&
      (typeof snapshot.targetLines !== "number" || snapshot.targetLines > previous.targetLines)
    ) {
      errors.push(
        `tooling hotspot ${path} target increased from ${previous.targetLines} to ${snapshot.targetLines ?? "missing"}`,
      );
    }
  }
  for (const path of Object.keys(current?.hotSpots ?? {}).filter(
    (path) => !Object.hasOwn(base.hotSpots ?? {}, path),
  )) {
    errors.push(
      `new tooling hotspot budgets are forbidden; keep new tools within 800 lines: ${path}`,
    );
  }
  if (
    typeof base.newModuleMaxLines === "number" &&
    (typeof current?.newModuleMaxLines !== "number" ||
      current.newModuleMaxLines > base.newModuleMaxLines)
  ) {
    errors.push(
      `new governance tool cap increased from ${base.newModuleMaxLines} to ${current?.newModuleMaxLines ?? "missing"}`,
    );
  }
  errors.push(...compareCompressionBudgets(current, base, "tooling"));
  return errors;
}
