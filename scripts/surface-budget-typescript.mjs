import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const TIMER_APIS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
  "requestVideoFrameCallback",
  "cancelVideoFrameCallback",
]);
const ELEMENT_TIMER_APIS = new Set([
  "requestVideoFrameCallback",
  "cancelVideoFrameCallback",
]);
const TIMER_GLOBALS = new Set(["window", "globalThis", "self"]);
const WORKER_APIS = new Set(["Worker", "SharedWorker"]);
const TAURI_EVENT_METHODS = new Set(["emit", "emitTo", "listen", "once", "unlisten"]);
const FOREGROUND_SCHEDULE = "createForegroundSchedule";
const FOREGROUND_SCHEDULE_MODULE = "src/taskCoordinator";

function isTauriApiModule(specifier) {
  return specifier === "@tauri-apps/api" || specifier.startsWith("@tauri-apps/api/");
}

function hasViteWorkerQuery(specifier) {
  return /[?&](?:shared)?worker(?:[=&]|$)/i.test(specifier);
}

function validateTauriImport(relative, declaration, fail) {
  const moduleName = declaration.moduleSpecifier.text;
  const bindings = declaration.importClause?.namedBindings;
  const exactNamedImport = (expectedFile, expectedModule, expectedName) => {
    if (
      relative !== expectedFile ||
      moduleName !== expectedModule ||
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.length !== 1 ||
      bindings.elements[0].propertyName ||
      bindings.elements[0].name.text !== expectedName
    ) {
      fail(
        declaration,
        `${expectedModule} must keep its one reviewed ${expectedName} import in ${expectedFile}`,
      );
    }
  };
  if (moduleName === "@tauri-apps/api/core") {
    exactNamedImport("src/api.ts", moduleName, "invoke");
  } else if (moduleName === "@tauri-apps/api/window") {
    exactNamedImport("src/App.tsx", moduleName, "getCurrentWindow");
  } else {
    fail(declaration, `Tauri API module ${moduleName} is outside the reviewed IPC adapters`);
  }
}

function productionTypeScriptFiles(root) {
  const sourceRoot = path.join(root, "src");
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(absolute);
      } else if (
        /\.[cm]?[jt]sx?$/.test(entry.name) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      ) {
        files.push(absolute);
      }
    }
  };
  visit(sourceRoot);
  return files;
}

function parseTypeScript(relative, source) {
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    throw new Error(`${relative} cannot be parsed for timer inventory`);
  }
  return sourceFile;
}

function isNodeWithinTypeQuery(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeQueryNode(current)) return true;
    if (!ts.isQualifiedName(current) && !ts.isPropertyAccessExpression(current)) break;
  }
  return false;
}

function isTypeofOperand(node) {
  return ts.isTypeOfExpression(node.parent) && node.parent.expression === node;
}

function isWithinTypeNode(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || ts.isExpression(current)) return false;
  }
  return false;
}

function isNonReferenceName(node) {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && parent.initializer !== node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node)
  );
}

function directTimerCall(node) {
  if (!ts.isCallExpression(node) || node.questionDotToken) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee) && TIMER_APIS.has(callee.text)) return callee.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    !callee.questionDotToken &&
    TIMER_APIS.has(callee.name.text) &&
    (ELEMENT_TIMER_APIS.has(callee.name.text) ||
      (ts.isIdentifier(callee.expression) && TIMER_GLOBALS.has(callee.expression.text)))
  ) {
    return callee.name.text;
  }
  return null;
}

function staticReference(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    ts.isIdentifier(node.name)
  ) {
    const owner = staticReference(node.expression);
    return owner ? `${owner}.${node.name.text}` : null;
  }
  return null;
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function resolvesToScheduleModule(relative, specifier) {
  if (!specifier.startsWith(".")) return false;
  const resolved = path.posix
    .normalize(path.posix.join(path.posix.dirname(relative), specifier))
    .replace(/\.(?:[cm]?[jt]sx?)$/, "");
  return resolved === FOREGROUND_SCHEDULE_MODULE;
}

function foregroundRunTarget(call, relative) {
  if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) {
    throw new Error(`${relative} has a foreground schedule without one static options object`);
  }
  const options = call.arguments[0];
  if (
    options.properties.some(
      (property) => ts.isSpreadAssignment(property) || staticPropertyName(property.name) === null,
    )
  ) {
    throw new Error(`${relative} foreground schedule options must not be spread or computed`);
  }
  const runProperties = options.properties.filter(
    (property) => staticPropertyName(property.name) === "run",
  );
  if (runProperties.length !== 1) {
    throw new Error(`${relative} foreground schedule must have exactly one static run target`);
  }
  const run = runProperties[0];
  const target = ts.isShorthandPropertyAssignment(run)
    ? run.name.text
    : ts.isPropertyAssignment(run)
      ? staticReference(run.initializer)
      : null;
  if (!target) throw new Error(`${relative} foreground schedule run target must be a static reference`);
  return target;
}

function analyzeFile(relative, source) {
  const sourceFile = parseTypeScript(relative, source);
  const timerCalls = [];
  const schedules = [];
  const definitions = [];
  const violations = [];
  const visitedImports = new Set();
  let scheduleImports = 0;
  const line = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const fail = (node, message) => violations.push(`${relative}:${line(node)} ${message}`);

  const validateScheduleImport = (specifier) => {
    if (visitedImports.has(specifier)) return;
    visitedImports.add(specifier);
    const declaration = specifier.parent.parent.parent;
    const moduleName = ts.isStringLiteralLike(declaration.moduleSpecifier)
      ? declaration.moduleSpecifier.text
      : "";
    const imported = specifier.propertyName?.text ?? specifier.name.text;
    if (
      imported !== FOREGROUND_SCHEDULE ||
      specifier.name.text !== FOREGROUND_SCHEDULE ||
      !resolvesToScheduleModule(relative, moduleName)
    ) {
      fail(specifier, `${FOREGROUND_SCHEDULE} import must keep its exact name and source module`);
    } else scheduleImports += 1;
  };

  const visit = (node) => {
    if (ts.isStringLiteralLike(node) && hasViteWorkerQuery(node.text)) {
      fail(node, "Vite worker/sharedworker import queries are forbidden by the foreground-only boundary");
    }
    const timerApi = directTimerCall(node);
    if (timerApi) timerCalls.push({ api: timerApi, position: node.getStart(sourceFile) });
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      TIMER_APIS.has(node.expression.text) &&
      !timerApi
    ) {
      fail(node, `${node.expression.text} must be a canonical direct timer call`);
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (isTauriApiModule(node.moduleSpecifier.text)) validateTauriImport(relative, node, fail);
      if (resolvesToScheduleModule(relative, node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) {
          fail(node, `${FOREGROUND_SCHEDULE_MODULE} must not be default/namespace imported`);
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (isTauriApiModule(node.moduleSpecifier.text)) {
        fail(node, "Tauri API re-exports are forbidden; use governed adapters");
      }
      if (resolvesToScheduleModule(relative, node.moduleSpecifier.text)) {
        fail(node, `${FOREGROUND_SCHEDULE_MODULE} must not be re-exported`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      if (isTauriApiModule(node.arguments[0].text)) {
        fail(node, "Tauri APIs must not be loaded dynamically");
      }
      if (resolvesToScheduleModule(relative, node.arguments[0].text)) {
        fail(node, `${FOREGROUND_SCHEDULE_MODULE} must not be loaded dynamically`);
      }
    }

    if (ts.isIdentifier(node) && node.text === FOREGROUND_SCHEDULE) {
      if (ts.isFunctionDeclaration(node.parent) && node.parent.name === node) {
        const exported = node.parent.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (relative !== `${FOREGROUND_SCHEDULE_MODULE}.ts` || !exported) {
          fail(node, `${FOREGROUND_SCHEDULE} must have one exported canonical definition`);
        }
        definitions.push(`${relative}:${line(node)}`);
      } else if (ts.isImportSpecifier(node.parent)) {
        validateScheduleImport(node.parent);
      } else if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        schedules.push(
          `${relative}:${FOREGROUND_SCHEDULE}:${foregroundRunTarget(node.parent, relative)}`,
        );
      } else {
        fail(node, `${FOREGROUND_SCHEDULE} may not be aliased, wrapped, or passed as a value`);
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === FOREGROUND_SCHEDULE) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === FOREGROUND_SCHEDULE)
    ) {
      fail(node, `${FOREGROUND_SCHEDULE} must be called through its exact named import`);
    }

    if (ts.isElementAccessExpression(node)) {
      const staticProperty =
        ts.isStringLiteralLike(node.argumentExpression) ||
        ts.isNumericLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      if (staticProperty !== null && (TIMER_APIS.has(staticProperty) || WORKER_APIS.has(staticProperty))) {
        fail(node, `computed access to ${staticProperty} is forbidden`);
      }
      if (staticProperty === "serviceWorker") {
        fail(node, "service workers are forbidden by the foreground-only scheduling boundary");
      }
      if (staticProperty !== null && TAURI_EVENT_METHODS.has(staticProperty)) {
        fail(node, `Tauri event method ${staticProperty} is forbidden; use governed commands`);
      }
      if (
        staticProperty === null &&
        (() => {
          const owner = staticReference(node.expression);
          const rootOwner = owner?.split(".")[0];
          return TIMER_GLOBALS.has(rootOwner) || owner === "navigator" || owner?.endsWith(".navigator");
        })()
      ) {
        fail(node, `dynamic computed access on a governed browser global is forbidden`);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      TIMER_APIS.has(node.name.text)
    ) {
      const canonicalCall =
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        directTimerCall(node.parent) === node.name.text;
      const directGlobalTypeReference =
        !node.questionDotToken &&
        ts.isIdentifier(node.expression) &&
        TIMER_GLOBALS.has(node.expression.text) &&
        (isNodeWithinTypeQuery(node) || isTypeofOperand(node));
      if (!canonicalCall && !directGlobalTypeReference) {
        fail(node, `${node.getText(sourceFile)} is not a canonical timer call`);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      (WORKER_APIS.has(node.name.text) || node.name.text === "serviceWorker")
    ) {
      fail(node, `${node.name.text} is forbidden by the foreground-only scheduling boundary`);
    }
    if (ts.isPropertyAccessExpression(node) && TAURI_EVENT_METHODS.has(node.name.text)) {
      fail(node, `Tauri event method ${node.name.text} is forbidden; use governed commands`);
    }
    if (ts.isIdentifier(node) && node.text === "getCurrentWindow") {
      const importBinding = ts.isImportSpecifier(node.parent) && node.parent.name === node;
      const call = ts.isCallExpression(node.parent) && node.parent.expression === node;
      const closeProperty = call &&
        ts.isPropertyAccessExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent &&
        node.parent.parent.name.text === "onCloseRequested";
      const closeCall = closeProperty &&
        ts.isCallExpression(node.parent.parent.parent) &&
        node.parent.parent.parent.expression === node.parent.parent;
      if (!importBinding && !closeCall) {
        fail(node, "getCurrentWindow may only register the reviewed onCloseRequested guard");
      }
    }
    if (ts.isIdentifier(node) && TIMER_APIS.has(node.text) && !isNonReferenceName(node)) {
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      const qualifiedName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      if (!directCall && !qualifiedName && !isNodeWithinTypeQuery(node) && !isTypeofOperand(node)) {
        fail(node, `${node.text} may not be shadowed, aliased, or passed as a value`);
      }
    }
    if (ts.isIdentifier(node) && TIMER_GLOBALS.has(node.text)) {
      const propertyTarget =
        ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
      const elementTarget =
        ts.isElementAccessExpression(node.parent) && node.parent.expression === node;
      if (
        !propertyTarget &&
        !elementTarget &&
        !isNodeWithinTypeQuery(node) &&
        !isTypeofOperand(node) &&
        !isWithinTypeNode(node) &&
        !isNonReferenceName(node)
      ) {
        fail(node, `${node.text} may not be aliased or destructured`);
      }
    }
    if (
      ts.isIdentifier(node) &&
      WORKER_APIS.has(node.text) &&
      !isNonReferenceName(node) &&
      !isWithinTypeNode(node)
    ) {
      fail(node, `${node.text} is forbidden by the foreground-only scheduling boundary`);
    }
    if (ts.isIdentifier(node) && node.text === "navigator") {
      const propertyTarget =
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node;
      if (!propertyTarget && !isWithinTypeNode(node) && !isNonReferenceName(node)) {
        fail(node, "navigator may not be aliased around the service-worker policy");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (violations.length > 0) throw new Error(violations[0]);
  if (schedules.length > 0 && scheduleImports !== 1) {
    throw new Error(
      `${relative} foreground schedules require exactly one canonical named import; found ${scheduleImports}`,
    );
  }

  const counts = new Map();
  const timers = timerCalls
    .sort((left, right) => left.position - right.position)
    .map(({ api }) => {
      const index = (counts.get(api) ?? 0) + 1;
      counts.set(api, index);
      return { api, id: `${relative}:${api}#${index}` };
    });
  return { definitions, schedules, timers };
}

export function discoverFrontendTimerSurface(root) {
  const definitions = [];
  const recurringTimers = [];
  const timerCalls = [];
  for (const absolute of productionTypeScriptFiles(root)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const result = analyzeFile(relative, readFileSync(absolute, "utf8"));
    definitions.push(...result.definitions);
    recurringTimers.push(...result.schedules);
    recurringTimers.push(
      ...result.timers.filter(({ api }) => api === "setInterval").map(({ id }) => id),
    );
    timerCalls.push(...result.timers.map(({ id }) => id));
  }
  if (definitions.length !== 1) {
    throw new Error(
      `expected exactly one canonical ${FOREGROUND_SCHEDULE} definition; found ${definitions.length}`,
    );
  }
  return { recurringTimers, timerCalls };
}
