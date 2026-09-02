import ts from "typescript";

import { findForbiddenTestRegistrationIndirection } from "./line-budgets.mjs";

function parseTypeScript(path, contents) {
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(?:js|mjs|cjs)$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, scriptKind);
}

function sourceLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
}

function staticText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function propertyAccessChain(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isCallExpression(node)) return propertyAccessChain(node.expression);
  if (ts.isPropertyAccessExpression(node)) {
    const prefix = propertyAccessChain(node.expression);
    return prefix ? [...prefix, node.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const prefix = propertyAccessChain(node.expression);
    const property = staticText(node.argumentExpression);
    return prefix ? [...prefix, property ?? "*"] : undefined;
  }
  return undefined;
}

function unwrapStaticTestData(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function directRegistration(node, registrations) {
  if (!ts.isCallExpression(node)) return undefined;
  if (ts.isIdentifier(node.expression) && registrations.has(node.expression.text)) {
    return { name: node.expression.text, callback: node.arguments[1], arguments: node.arguments };
  }
  if (
    ts.isCallExpression(node.expression) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === "each" &&
    ts.isIdentifier(node.expression.expression.expression) &&
    registrations.has(node.expression.expression.expression.text)
  ) {
    return {
      name: `${node.expression.expression.expression.text}.each`,
      callback: node.arguments[1],
      arguments: node.arguments,
    };
  }
  return undefined;
}

function suiteCallbackControlFlowHazards(path, sourceFile, registration) {
  if (!["describe", "describe.each", "suite", "suite.each"].includes(registration.name)) {
    return [];
  }
  const callback = registration.callback;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return [];
  }
  const errors = [];
  const visit = (node) => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    const control = ts.isReturnStatement(node)
      ? "return"
      : ts.isBreakStatement(node)
        ? "break"
        : ts.isContinueStatement(node)
          ? "continue"
          : ts.isTryStatement(node)
            ? "try/finally"
            : ts.isThrowStatement(node)
              ? "throw"
              : undefined;
    if (control) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node)} ${registration.name} callback contains ${control} control flow; suite registration scope must remain deterministic`,
      );
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return errors;
}

export function findForbiddenTestModifiers(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const errors = findForbiddenTestRegistrationIndirection(path, contents);
  const forbidden = new Set(["skip", "skipIf", "runIf", "only", "todo"]);
  const registrations = new Set(["test", "it", "describe", "suite"]);
  const terminationApis = new Set(["abort", "exit", "exitCode", "reallyExit"]);
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.asteriskToken) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node)} generator callbacks are forbidden in governed test code because returning an unconsumed iterator can report false green`,
      );
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      ["node:process", "process"].includes(node.moduleSpecifier.text)
    ) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node)} importing process is forbidden in test code; runner termination capabilities must not be aliasable`,
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const chain = propertyAccessChain(node);
      const processIndex = chain?.indexOf("process") ?? -1;
      if (processIndex >= 0 && terminationApis.has(chain.at(-1))) {
        errors.push(
          `${path}:${sourceLocation(sourceFile, node)} test runner termination API ${chain.slice(processIndex).join(".")} is forbidden`,
        );
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "process" &&
        staticText(node.argumentExpression) === undefined
      ) {
        errors.push(
          `${path}:${sourceLocation(sourceFile, node)} computed process capability access is forbidden in test code`,
        );
      }
      if (
        chain &&
        chain.some((name) => forbidden.has(name)) &&
        !(
          (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
          node.parent.expression === node
        )
      ) {
        errors.push(
          `${path}:${sourceLocation(sourceFile, node)} ${chain.join(".")} is forbidden; tests must run in a dedicated lane instead`,
        );
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = staticText(node.arguments[0]);
        if (specifier === undefined) {
          errors.push(
            `${path}:${sourceLocation(sourceFile, node)} non-literal dynamic import is forbidden in test code because it can hide runner APIs and uncollected helpers`,
          );
        } else if (!specifier.startsWith(".")) {
          errors.push(
            `${path}:${sourceLocation(sourceFile, node)} dynamically imports test runner module ${specifier}; test runner APIs must remain static and directly registered`,
          );
        }
      }
      const registration = directRegistration(node, registrations);
      if (registration) {
        const { arguments: registrationArguments, callback, name } = registration;
        if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
          errors.push(
            `${path}:${sourceLocation(sourceFile, node)} ${name} must use the direct (title, callback[, timeout]) form; options and indirect callbacks are forbidden`,
          );
        } else {
          if (
            registrationArguments.length !== 2 &&
            !(
              registrationArguments.length === 3 &&
              ts.isNumericLiteral(registrationArguments[2])
            )
          ) {
            errors.push(
              `${path}:${sourceLocation(sourceFile, node)} ${name} must use exactly two arguments, or three when only a numeric literal timeout is allowed; TestOptions and non-literal timeouts are forbidden`,
            );
          }
        }
        errors.push(...suiteCallbackControlFlowHazards(path, sourceFile, registration));
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "each"
      ) {
        const data = unwrapStaticTestData(node.arguments[0]);
        if (!data || !ts.isArrayLiteralExpression(data) || data.elements.length === 0) {
          errors.push(
            `${path}:${sourceLocation(sourceFile, node)} .each data must be a direct non-empty array literal because dynamic or empty data can register no tests`,
          );
        } else if (
          data.elements.some(
            (element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element),
          )
        ) {
          errors.push(
            `${path}:${sourceLocation(sourceFile, node)} .each top-level spread and omitted elements are forbidden because they can register zero or indeterminate tests`,
          );
        }
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      (ts.isPropertyAccessExpression(node.tag) || ts.isElementAccessExpression(node.tag)) &&
      propertyAccessChain(node.tag)?.at(-1) === "each"
    ) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node)} tagged .each data is forbidden; use a direct non-empty array literal`,
      );
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "process" &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      ) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node)} process may not be aliased, destructured, or passed as a value in test code`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors.sort((left, right) => {
    const leftLocation = left.match(/:(\d+):(\d+) /);
    const rightLocation = right.match(/:(\d+):(\d+) /);
    return (
      Number(leftLocation?.[1] ?? 0) - Number(rightLocation?.[1] ?? 0) ||
      Number(leftLocation?.[2] ?? 0) - Number(rightLocation?.[2] ?? 0)
    );
  });
}
