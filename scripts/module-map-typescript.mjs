import ts from "typescript";

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function newExpressionName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return undefined;
}

function isAuditedImportMetaUrl(metaProperty) {
  const urlAccess = metaProperty.parent;
  if (
    !ts.isPropertyAccessExpression(urlAccess) ||
    urlAccess.expression !== metaProperty ||
    urlAccess.name.text !== "url"
  ) {
    return false;
  }
  const constructor = urlAccess.parent;
  return (
    ts.isNewExpression(constructor) &&
    newExpressionName(constructor) === "URL" &&
    constructor.arguments?.[1] === urlAccess &&
    ts.isStringLiteralLike(constructor.arguments?.[0])
  );
}

export function findForbiddenTypeScriptModuleGraphPatterns(pathname, source) {
  const scriptKind = pathname.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const errors = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))
    ) {
      errors.push(
        `${pathname} uses a non-literal dynamic import; every bundled dependency must be explicit in the module map`,
      );
    }
    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === "meta" &&
      !isAuditedImportMetaUrl(node)
    ) {
      errors.push(
        `${pathname} uses import.meta outside new URL(<literal>, import.meta.url); Vite glob and computed entrypoints are forbidden`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return uniqueSorted(errors);
}
