import ts from "typescript";

function deepestNodeAtPosition(sourceFile, position) {
  let deepest = sourceFile;
  const visit = (node) => {
    if (node.getFullStart() <= position && position < node.getEnd()) {
      deepest = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return deepest;
}

export function isProbablyExecutableSource(path, contents, line) {
  const rows = contents.split(/\r?\n/);
  const source = rows[line - 1]?.trim() ?? "";
  if (!source || /^(?:\/\/|\/\*|\*|\*\/)/.test(source)) return false;
  if (/^[{}()[\],;]+$/.test(source)) return false;
  if (!/\.(?:[cm]?ts|tsx)$/.test(path)) {
    return !/^(?:use |mod )\b/.test(source);
  }

  const sourceFile = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line - 1, 0);
  const firstToken = lineStart + (rows[line - 1]?.search(/\S/) ?? 0);
  let node = deepestNodeAtPosition(sourceFile, firstToken);
  while (node) {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodSignature(node) ||
      ts.isCallSignatureDeclaration(node) ||
      ts.isConstructSignatureDeclaration(node) ||
      ts.isIndexSignatureDeclaration(node) ||
      ts.isTypeParameterDeclaration(node) ||
      (ts.isPropertyDeclaration(node) && !node.initializer) ||
      (ts.isParameter(node) && !node.initializer) ||
      ts.isTypeNode(node)
    ) {
      return false;
    }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.DeclareKeyword
    )) {
      return false;
    }
    node = node.parent;
  }
  return true;
}
