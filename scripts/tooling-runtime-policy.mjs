import ts from "typescript";

function scriptKind(pathname) {
  if (pathname.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (pathname.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:[cm]?ts)$/.test(pathname)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function staticText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return staticText(node.argumentExpression);
  return undefined;
}

function rootIdentifier(node) {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function dynamicCodeName(node) {
  if (ts.isIdentifier(node)) return ["eval", "Function"].includes(node.text) ? node.text : undefined;
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || !["global", "globalThis"].includes(node.expression.text)) {
    return undefined;
  }
  const member = memberName(node);
  return ["eval", "Function"].includes(member) ? member : undefined;
}

export function findForbiddenToolingRuntimeLoading(pathname, source) {
  const sourceFile = ts.createSourceFile(
    pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(pathname),
  );
  const errors = new Set();
  const location = (node) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${line + 1}:${character + 1}`;
  };
  const moduleSpecifier = (node) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    if (["node:vm", "vm"].includes(node.text)) {
      errors.add(
        `${pathname}:${location(node)} loads node:vm; production tooling cannot create a dynamic code context`,
      );
    } else if (["node:module", "module"].includes(node.text)) {
      errors.add(
        `${pathname}:${location(node)} loads ${node.text}; custom Node loader primitives are forbidden`,
      );
    }
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      moduleSpecifier(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      moduleSpecifier(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.add(
        `${pathname}:${location(node)} uses dynamic import; production tooling dependency closure accepts only top-level static import/export`,
      );
      moduleSpecifier(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      errors.add(
        `${pathname}:${location(node)} uses require; production tooling dependency closure accepts only top-level static import/export`,
      );
      moduleSpecifier(node.arguments[0]);
    }

    const dynamicCode =
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      dynamicCodeName(node.expression);
    if (dynamicCode) {
      errors.add(
        `${pathname}:${location(node)} uses ${dynamicCode}; production tooling cannot execute dynamically loaded code`,
      );
    }
    const referencedCode = dynamicCodeName(node);
    const invokedDirectly = node.parent &&
      (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) &&
      node.parent.expression === node;
    const propertyName =
      ts.isIdentifier(node) &&
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name === node;
    if (referencedCode && !invokedDirectly && !propertyName) {
      errors.add(
        `${pathname}:${location(node)} references ${referencedCode}; production tooling cannot execute dynamically loaded code`,
      );
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = memberName(node);
      const root = rootIdentifier(node);
      if (
        ts.isElementAccessExpression(node) &&
        (["global", "globalThis"].includes(root) ||
          (ts.isIdentifier(node.expression) &&
            ["process", "module", "Module"].includes(node.expression.text)))
      ) {
        errors.add(`${pathname}:${location(node)} computed loader/global access is forbidden`);
      }
      if (["eval", "Function"].includes(member)) {
        errors.add(
          `${pathname}:${location(node)} ${member} property access is forbidden on every receiver`,
        );
      }
      if (
        ["global", "globalThis"].includes(root) &&
        ["Reflect", "Object", "Proxy"].includes(member)
      ) {
        errors.add(`${pathname}:${location(node)} reflected global constructor access is forbidden`);
      }
      if (member === "getBuiltinModule") {
        errors.add(
          `${pathname}:${location(node)} process.getBuiltinModule is forbidden; builtin loaders must remain static imports`,
        );
      }
      if (
        ["register", "registerHooks"].includes(member) &&
        ts.isIdentifier(node.expression) &&
        ["module", "Module"].includes(node.expression.text)
      ) {
        errors.add(`${pathname}:${location(node)} custom Node loader primitives are forbidden`);
      }
      if (["constructor", "__proto__", "prototype"].includes(member)) {
        errors.add(`${pathname}:${location(node)} reflective prototype access is forbidden`);
      }
      if (
        [
          "getOwnPropertyDescriptor",
          "getOwnPropertyDescriptors",
          "getPrototypeOf",
          "setPrototypeOf",
          "defineProperty",
          "defineProperties",
        ].includes(member)
      ) {
        errors.add(`${pathname}:${location(node)} reflective Object access is forbidden`);
      }
    }
    if (
      ts.isIdentifier(node) &&
      ["Reflect", "Proxy"].includes(node.text) &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node
      )
    ) {
      errors.add(`${pathname}:${location(node)} ${node.text} reflection is forbidden`);
    }
    if (
      ts.isIdentifier(node) &&
      ["global", "globalThis"].includes(node.text) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      ) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      errors.add(`${pathname}:${location(node)} ${node.text} cannot be captured or passed as a value`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...errors];
}
