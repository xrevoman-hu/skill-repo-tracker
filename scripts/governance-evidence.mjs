import path from "node:path";
import ts from "typescript";

function readText(readFile, path) {
  const contents = readFile(path);
  if (contents == null) return undefined;
  return Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents);
}

function nonEmptyJavaScriptTestCallback(argument) {
  if (!argument || (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))) {
    return false;
  }
  return !ts.isBlock(argument.body) || argument.body.statements.length > 0;
}

function javascriptTestCallback(call) {
  if (![2, 3].includes(call.arguments.length)) return undefined;
  if (call.arguments.length === 3 && !ts.isNumericLiteral(call.arguments[2])) return undefined;
  return nonEmptyJavaScriptTestCallback(call.arguments[1]) ? call.arguments[1] : undefined;
}

function javascriptTestDeclarations(contents, path) {
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : path.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS,
  );
  const declarations = new Set();
  const visitStatements = (statements) => {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
        continue;
      }
      const call = statement.expression;
      const root = ts.isIdentifier(call.expression) ? call.expression.text : undefined;
      const callback = javascriptTestCallback(call);
      if (["test", "it"].includes(root) && callback) {
        const title = call.arguments[0];
        if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
          declarations.add(title.text);
        }
      } else if (["describe", "suite", "context"].includes(root) && callback) {
        if (ts.isBlock(callback.body)) visitStatements(callback.body.statements);
      }
    }
  };
  visitStatements(source.statements);
  return declarations;
}

function maskRustNonCode(contents) {
  const characters = [...contents];
  let index = 0;
  const blank = (position) => {
    if (characters[position] !== "\n" && characters[position] !== "\r") {
      characters[position] = " ";
    }
  };
  while (index < characters.length) {
    if (characters[index] === "/" && characters[index + 1] === "/") {
      while (index < characters.length && characters[index] !== "\n") blank(index++);
      continue;
    }
    if (characters[index] === "/" && characters[index + 1] === "*") {
      let depth = 0;
      while (index < characters.length) {
        if (characters[index] === "/" && characters[index + 1] === "*") {
          blank(index++);
          blank(index++);
          depth += 1;
        } else if (characters[index] === "*" && characters[index + 1] === "/") {
          blank(index++);
          blank(index++);
          depth -= 1;
          if (depth === 0) break;
        } else {
          blank(index++);
        }
      }
      continue;
    }

    let rawCursor = index;
    if (characters[rawCursor] === "b") rawCursor += 1;
    let rawHashCount = -1;
    if (characters[rawCursor] === "r") {
      rawCursor += 1;
      const hashStart = rawCursor;
      while (characters[rawCursor] === "#" && rawCursor - hashStart < 255) rawCursor += 1;
      if (characters[rawCursor] === '"') rawHashCount = rawCursor - hashStart;
    }
    if (rawHashCount >= 0) {
      const prefixLength = rawCursor - index + 1;
      const terminator = ['"', ...Array(rawHashCount).fill("#")];
      for (let offset = 0; offset < prefixLength; offset += 1) blank(index++);
      while (index < characters.length) {
        if (terminator.every((character, offset) => characters[index + offset] === character)) {
          for (let offset = 0; offset < terminator.length; offset += 1) blank(index++);
          break;
        }
        blank(index++);
      }
      continue;
    }

    const stringPrefixLength =
      characters[index] === "b" && characters[index + 1] === '"'
        ? 2
        : characters[index] === '"'
          ? 1
          : 0;
    if (stringPrefixLength > 0) {
      for (let offset = 0; offset < stringPrefixLength; offset += 1) blank(index++);
      let escaped = false;
      while (index < characters.length) {
        const character = characters[index];
        blank(index++);
        if (!escaped && character === '"') break;
        if (!escaped && character === "\\") escaped = true;
        else escaped = false;
      }
      continue;
    }

    const charStart =
      characters[index] === "b" && characters[index + 1] === "'"
        ? index + 1
        : characters[index] === "'"
          ? index
          : -1;
    if (charStart >= 0) {
      let cursor = charStart + 1;
      let escaped = false;
      let closing = -1;
      while (cursor < characters.length && characters[cursor] !== "\n") {
        const character = characters[cursor];
        if (!escaped && character === "'") {
          closing = cursor;
          break;
        }
        if (!escaped && character === "\\") escaped = true;
        else escaped = false;
        cursor += 1;
      }
      if (closing >= 0) {
        while (index <= closing) blank(index++);
        continue;
      }
    }
    index += 1;
  }
  return characters.join("");
}

function maskConditionalRustEvidence(contents) {
  const characters = [...maskRustNonCode(contents)];
  const blank = (position) => {
    if (characters[position] !== "\n" && characters[position] !== "\r") {
      characters[position] = " ";
    }
  };
  const initial = characters.join("");
  for (const attribute of initial.matchAll(/#\s*\[\s*(?:cfg|cfg_attr)\b[\s\S]*?\]/g)) {
    const normalized = attribute[0].replace(/\s+/g, "");
    if (["#[cfg(test)]", "#[cfg(unix)]"].includes(normalized)) continue;
    let opening = initial.indexOf("{", attribute.index + attribute[0].length);
    const semicolon = initial.indexOf(";", attribute.index + attribute[0].length);
    if (opening === -1 || (semicolon !== -1 && semicolon < opening)) continue;
    let depth = 0;
    let closing = opening;
    for (; closing < characters.length; closing += 1) {
      if (initial[closing] === "{") depth += 1;
      else if (initial[closing] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    for (let position = attribute.index; position <= closing; position += 1) blank(position);
  }
  return characters.join("");
}

function rustTestDeclarations(contents) {
  const declarations = new Set();
  const code = maskConditionalRustEvidence(contents);
  const declaration = /#\s*\[\s*(?:tokio\s*::\s*)?test(?:\s*\([^\]]*\))?\s*\]\s*(?:#\s*\[[^\]]*\]\s*)*(?:(?:pub(?:\s*\([^)]*\))?\s+)?)(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of code.matchAll(declaration)) declarations.add(match[1]);
  return declarations;
}

export function executableTestDeclarations(contents, path) {
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return javascriptTestDeclarations(contents, path);
  if (path.endsWith(".rs")) return rustTestDeclarations(contents);
  return new Set();
}

function javascriptEvidencePathIsCollected(path) {
  if (path.startsWith("scripts/")) {
    return /^scripts\/__tests__\/[^/]+\.test\.mjs$/.test(path);
  }
  if (path.startsWith("e2e/")) {
    return /^e2e\/.+\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(path);
  }
  return /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(path);
}

function rustModuleTargets(parentPath, contents, tracked) {
  const targets = new Set();
  const code = maskConditionalRustEvidence(contents);
  const declaration = /((?:#\s*\[[^\]]*\]\s*)*)(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  for (const match of code.matchAll(declaration)) {
    const attributes = match[1];
    const conditions = [...attributes.matchAll(/#\s*\[\s*(?:cfg|cfg_attr)\b[^\]]*\]/g)]
      .map(([attribute]) => attribute.replace(/\s+/g, ""));
    if (conditions.some((condition) => !["#[cfg(test)]", "#[cfg(unix)]"].includes(condition))) {
      continue;
    }
    const original = contents.slice(match.index, match.index + match[0].length);
    const declaredPath = original.match(/#\s*\[\s*path\s*=\s*"([^"\r\n]+)"\s*\]/)?.[1];
    if (/#\s*\[\s*path\b/.test(attributes) && !declaredPath) continue;
    const parentDirectory = path.posix.dirname(parentPath);
    const stem = path.posix.basename(parentPath, ".rs");
    const moduleDirectory = ["lib", "main", "mod"].includes(stem)
      ? parentDirectory
      : path.posix.join(parentDirectory, stem);
    const candidates = declaredPath
      ? [path.posix.normalize(path.posix.join(parentDirectory, declaredPath))]
      : [
          path.posix.join(moduleDirectory, `${match[2]}.rs`),
          path.posix.join(moduleDirectory, match[2], "mod.rs"),
        ];
    const target = candidates.find((candidate) => tracked.has(candidate));
    if (target) targets.add(target);
  }
  return targets;
}

export function reachableRustEvidencePaths(tracked, readFile) {
  const roots = ["src-tauri/src/lib.rs", "src-tauri/src/main.rs"];
  const reachable = new Set(roots.filter((root) => tracked.has(root)));
  const queue = [...reachable];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    const contents = readText(readFile, parent);
    if (contents == null) continue;
    for (const target of rustModuleTargets(parent, contents, tracked)) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  return reachable;
}

function rustEvidencePathIsCollected(path, rustReachable) {
  if (/^src-tauri\/tests\/[^/]+\.rs$/.test(path)) return true;
  return /^src-tauri\/src\/.+\.rs$/.test(path) && rustReachable.has(path);
}

export function evidencePathIsCollected(path, rustReachable) {
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return javascriptEvidencePathIsCollected(path);
  if (path.endsWith(".rs")) return rustEvidencePathIsCollected(path, rustReachable);
  return false;
}
