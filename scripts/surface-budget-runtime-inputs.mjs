import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { isRustProductionSourcePath } from "./source-classification.mjs";

const QUERY_HELPERS = new Set(["initialParam", "initialFreeParam"]);
const STORAGE_NAMES = new Set(["localStorage", "sessionStorage", "indexedDB", "Storage"]);
const RUST_ENV_FUNCTIONS = new Set(["var", "var_os"]);
const FORBIDDEN_RUST_ENV_FUNCTIONS = new Set([
  "args",
  "args_os",
  "vars",
  "vars_os",
  "set_var",
  "remove_var",
  "current_dir",
  "current_exe",
  "set_current_dir",
]);

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function productionTypeScriptFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(absolute);
      } else if (
        entry.isFile() &&
        /\.[cm]?[jt]sx?$/.test(entry.name) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      ) {
        files.push(absolute);
      }
    }
  };
  visit(path.join(root, "src"));
  return files.sort((left, right) => left.localeCompare(right));
}

function productionRustFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && isRustProductionSourcePath(relative)) files.push(absolute);
    }
  };
  visit(path.join(root, "src-tauri/src"));
  return files.sort((left, right) => left.localeCompare(right));
}

function staticString(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return staticString(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  return undefined;
}

function isImportMeta(node) {
  return (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === "meta"
  );
}

function canonicalLocationSearch(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    node.name.text === "search" &&
    ts.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    node.expression.name.text === "location" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "window"
  );
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current;
  }
  return undefined;
}

function isDeclarationName(node) {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && parent.initializer !== node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node)
  );
}

function analyzeFrontendFile(relative, source) {
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    throw new Error(`${relative} cannot be parsed for runtime input inventory`);
  }
  const violations = [];
  const inputs = [];
  const helperDefinitions = new Map([...QUERY_HELPERS].map((name) => [name, 0]));
  const helperParsers = new Map([...QUERY_HELPERS].map((name) => [name, 0]));
  let helperReferences = 0;
  const line = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const fail = (node, message) => violations.push(`${relative}:${line(node)} ${message}`);

  const recordQuery = (node, key) => {
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
      fail(node, "query input keys must be static identifier-like strings");
      return;
    }
    inputs.push({ kind: "query", key, position: node.getStart(sourceFile) });
  };

  const visit = (node) => {
    if (ts.isIdentifier(node) && STORAGE_NAMES.has(node.text)) {
      fail(node, `persistent browser storage is forbidden: ${node.text}`);
    }
    const literal =
      ts.isStringLiteralLike(node) || ts.isBinaryExpression(node) ? staticString(node) : undefined;
    if (literal !== undefined && STORAGE_NAMES.has(literal)) {
      fail(node, `persistent browser storage is forbidden: ${literal}`);
    }

    if (isImportMeta(node)) {
      const directProperty =
        ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
      if (!directProperty || node.parent.name.text === "env") {
        fail(node, "frontend environment inputs are forbidden");
      }
    }
    if (ts.isIdentifier(node) && node.text === "process" && !isDeclarationName(node)) {
      fail(node, "frontend environment inputs are forbidden");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === "process" ||
        (node.name.text === "env" &&
          (isImportMeta(node.expression) ||
            (ts.isIdentifier(node.expression) && node.expression.text === "process") ||
            (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "process"))))
    ) {
      fail(node, "frontend environment inputs are forbidden");
    }
    if (ts.isElementAccessExpression(node)) {
      const property = staticString(node.argumentExpression);
      if (
        property === undefined &&
        ts.isIdentifier(node.expression) &&
        ["window", "globalThis", "self"].includes(node.expression.text)
      ) {
        fail(node, "persistent browser storage is forbidden through computed global access");
      }
      if (
        (property === "env" &&
          (isImportMeta(node.expression) ||
            (ts.isIdentifier(node.expression) && node.expression.text === "process"))) ||
        property === "process"
      ) {
        fail(node, "frontend environment inputs are forbidden");
      }
      if (property === "location" || property === "search" || property === "searchParams") {
        fail(node, "query input access must use the canonical window.location.search parser");
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URLSearchParams") {
      const property = node.parent;
      const call = ts.isPropertyAccessExpression(property) && property.expression === node
        ? property.parent
        : undefined;
      if (
        node.arguments?.length !== 1 ||
        !canonicalLocationSearch(node.arguments[0]) ||
        !ts.isPropertyAccessExpression(property) ||
        property.name.text !== "get" ||
        !ts.isCallExpression(call) ||
        call.expression !== property ||
        call.arguments.length !== 1
      ) {
        fail(node, "URLSearchParams query input must be one direct canonical .get call");
      } else {
        const key = staticString(call.arguments[0]);
        if (key !== undefined) recordQuery(call, key);
        else {
          const owner = enclosingFunction(call);
          const ownerName = owner?.name?.text;
          const firstParameter = owner?.parameters?.[0]?.name;
          if (
            !ownerName ||
            !QUERY_HELPERS.has(ownerName) ||
            !ts.isIdentifier(firstParameter) ||
            firstParameter.text !== "name" ||
            !ts.isIdentifier(call.arguments[0]) ||
            call.arguments[0].text !== "name"
          ) {
            fail(call, "query input keys must be static outside the two canonical helpers");
          } else {
            helperParsers.set(ownerName, helperParsers.get(ownerName) + 1);
          }
        }
      }
    }
    if (ts.isIdentifier(node) && node.text === "URLSearchParams") {
      if (!ts.isNewExpression(node.parent) || node.parent.expression !== node) {
        fail(node, "URLSearchParams may not be aliased or passed as a value");
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "location") {
      const canonical = ts.isPropertyAccessExpression(node.parent) && canonicalLocationSearch(node.parent);
      if (!canonical || !ts.isIdentifier(node.expression) || node.expression.text !== "window") {
        fail(node, "location.search may only feed the canonical URLSearchParams parser");
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "search") {
      const parentIsCanonicalParser =
        canonicalLocationSearch(node) &&
        ts.isNewExpression(node.parent) &&
        node.parent.arguments?.[0] === node;
      if (!parentIsCanonicalParser) {
        fail(node, "location.search may only feed the canonical URLSearchParams parser");
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "searchParams") {
      fail(node, "query input access must use the canonical window.location.search parser");
    }

    if (ts.isIdentifier(node) && QUERY_HELPERS.has(node.text)) {
      helperReferences += 1;
      if (ts.isFunctionDeclaration(node.parent) && node.parent.name === node) {
        helperDefinitions.set(node.text, helperDefinitions.get(node.text) + 1);
      } else if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        recordQuery(node.parent, staticString(node.parent.arguments[0]));
      } else {
        fail(node, `${node.text} may not be aliased, wrapped, or passed as a value`);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      ["window", "globalThis", "self"].includes(node.initializer.text)
    ) {
      fail(node, "persistent browser storage is forbidden through global object aliases");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ((node.expression.expression.text === "Reflect" && node.expression.name.text === "get") ||
        (node.expression.expression.text === "Object" &&
          node.expression.name.text === "getOwnPropertyDescriptor"))
    ) {
      fail(node, "persistent browser storage is forbidden through reflective capability access");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const [name, count] of helperDefinitions) {
    if (helperReferences > 0 && (count !== 1 || helperParsers.get(name) !== 1)) {
      violations.push(
        `${relative}:1 query input helper ${name} must have exactly one definition and one canonical parser`,
      );
    }
  }
  if (violations.length > 0) throw new Error(violations[0]);

  const counts = new Map();
  return inputs
    .sort((left, right) => left.position - right.position)
    .map(({ kind, key }) => {
      const countKey = `${kind}:${key}`;
      const index = (counts.get(countKey) ?? 0) + 1;
      counts.set(countKey, index);
      return `frontend:${relative}:${kind}:${key}#${index}`;
    });
}

function findMatchingDelimiter(source, openingIndex, opening, closing) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === opening) depth += 1;
    else if (source[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function maskRustNonCode(source) {
  const output = [...source];
  const blank = (index) => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") blank(index++);
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      blank(index++);
      blank(index++);
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          blank(index++);
          blank(index++);
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          blank(index++);
          blank(index++);
        } else blank(index++);
      }
      if (depth !== 0) throw new Error("Rust runtime input source has an unterminated comment");
      continue;
    }
    const raw = source.slice(index).match(/^(?:b)?r(#+)?"/);
    if (raw) {
      const terminator = `"${raw[1] ?? ""}`;
      let end = source.indexOf(terminator, index + raw[0].length);
      if (end < 0) throw new Error("Rust runtime input source has an unterminated raw string");
      end += terminator.length;
      while (index < end) blank(index++);
      continue;
    }
    const quote = source[index] === '"' ? index : source[index] === "b" && source[index + 1] === '"' ? index + 1 : -1;
    if (quote >= 0) {
      let end = quote + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end] === '"') {
          end += 1;
          break;
        } else end += 1;
      }
      if (source[end - 1] !== '"') throw new Error("Rust runtime input source has an unterminated string");
      while (index < end) blank(index++);
      continue;
    }
    const character = source.slice(index).match(/^(?:b)?'(?:\\.|[^'\\\r\n])'/);
    if (character) {
      const end = index + character[0].length;
      while (index < end) blank(index++);
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function hasDebugCfgContext(masked, position) {
  const debugAttribute = /#\s*\[\s*cfg\s*\(\s*debug_assertions\s*\)\s*\]/;
  const boundaries = [];
  for (let index = 0; index < position; index += 1) {
    if (masked[index] === "{") boundaries.push(index);
    else if (masked[index] === "}") boundaries.pop();
  }
  const previous = Math.max(
    masked.lastIndexOf(";", position - 1),
    masked.lastIndexOf("}", position - 1),
    masked.lastIndexOf("{", position - 1),
  );
  if (debugAttribute.test(masked.slice(previous + 1, position))) return true;
  return boundaries.some((opening) => {
    const before = Math.max(masked.lastIndexOf(";", opening - 1), masked.lastIndexOf("}", opening - 1));
    return debugAttribute.test(masked.slice(before + 1, opening));
  });
}

function enclosingRustFunctions(masked) {
  const functions = [];
  for (const match of masked.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    let opening = match.index + match[0].length;
    while (opening < masked.length && !["{", ";"].includes(masked[opening])) opening += 1;
    if (masked[opening] !== "{") continue;
    const closing = findMatchingDelimiter(masked, opening, "{", "}");
    if (closing >= 0) functions.push({ name: match[1], opening, closing });
  }
  return functions;
}

function rustFunctionAt(functions, position) {
  return functions
    .filter(({ opening, closing }) => opening < position && position < closing)
    .sort((left, right) => right.opening - left.opening)[0]?.name;
}

function callArguments(source, masked, match) {
  const opening = masked.indexOf("(", match.index);
  const closing = findMatchingDelimiter(masked, opening, "(", ")");
  if (opening < 0 || closing < 0) throw new Error("Rust environment input call is unbalanced");
  return source.slice(opening + 1, closing).trim();
}

function staticRustKey(arguments_) {
  return arguments_.match(/^"([A-Z][A-Z0-9_]*)"(?:\s*,[\s\S]*)?$/)?.[1];
}

function analyzeRustFile(relative, source) {
  const masked = maskRustNonCode(source);
  const functions = enclosingRustFunctions(masked);
  const inputs = [];
  if (/\b(?:pub\s+)?use\s+(?:::)?std\s*(?:::\s*env\b|\s+as\b)/.test(masked)) {
    throw new Error(`${relative} std::env import or alias is forbidden`);
  }
  if (/\b(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*env\s*::/.test(masked.replace(/\bstd\s*::\s*env\s*::/g, ""))) {
    throw new Error(`${relative} environment input must use the exact std::env path`);
  }
  for (const name of FORBIDDEN_RUST_ENV_FUNCTIONS) {
    if (new RegExp(`\\bstd\\s*::\\s*env\\s*::\\s*${name}\\s*\\(`).test(masked)) {
      throw new Error(`${relative} unconditional std::env::${name} environment input is forbidden`);
    }
  }

  const stdEnvReferences = [
    ...masked.matchAll(/\bstd\s*::\s*env\s*::\s*([A-Za-z_][A-Za-z0-9_]*)\b/g),
  ];
  const allowedPureFunctions = new Set(["join_paths", "split_paths"]);
  for (const match of stdEnvReferences) {
    const name = match[1];
    if (
      ["var", "var_os", "temp_dir", "consts"].includes(name) ||
      allowedPureFunctions.has(name)
    ) {
      continue;
    }
    throw new Error(`${relative} unconditional std::env::${name} environment input is forbidden`);
  }

  const tempReferences = stdEnvReferences.filter((match) => match[1] === "temp_dir");
  const tempCalls = [
    ...masked.matchAll(/\bstd\s*::\s*env\s*::\s*temp_dir\s*\(/g),
  ];
  if (tempReferences.length !== tempCalls.length) {
    throw new Error(`${relative} std::env::temp_dir may not be aliased or passed as a value`);
  }
  for (const match of tempCalls) {
    if (callArguments(source, masked, match) !== "") {
      throw new Error(`${relative} std::env::temp_dir call must not accept arguments`);
    }
    inputs.push({
      api: "std::env::temp_dir",
      key: "<platform-temp>",
      position: match.index,
    });
  }

  const dynamicHelpers = [];
  const environmentReferences = [
    ...masked.matchAll(/\bstd\s*::\s*env\s*::\s*(var|var_os)\b/g),
  ];
  const environmentCalls = [
    ...masked.matchAll(/\bstd\s*::\s*env\s*::\s*(var|var_os)\s*\(/g),
  ];
  if (environmentReferences.length !== environmentCalls.length) {
    throw new Error(`${relative} environment input functions may not be aliased or passed as values`);
  }
  for (const match of environmentCalls) {
    const api = match[1];
    const arguments_ = callArguments(source, masked, match);
    const key = staticRustKey(arguments_);
    if (!hasDebugCfgContext(masked, match.index)) {
      throw new Error(`${relative} runtime environment input must be cfg(debug_assertions)`);
    }
    if (key) {
      inputs.push({ api: `std::env::${api}`, key, position: match.index });
      continue;
    }
    if (
      api !== "var" ||
      arguments_ !== "name" ||
      relative !== "src-tauri/src/lib.rs" ||
      rustFunctionAt(functions, match.index) !== "debug_fixture_number"
    ) {
      throw new Error(`${relative} dynamic std::env environment input is forbidden`);
    }
    dynamicHelpers.push(match.index);
  }
  if (dynamicHelpers.length > 1) {
    throw new Error(`${relative} must keep one canonical debug_fixture_number environment seam`);
  }
  if (dynamicHelpers.length === 1) {
    for (const match of masked.matchAll(/\bdebug_fixture_number\s*\(/g)) {
      const arguments_ = callArguments(source, masked, match);
      const key = staticRustKey(arguments_);
      if (!key || !hasDebugCfgContext(masked, match.index)) {
        throw new Error(`${relative} debug_fixture_number calls require one static cfg(debug_assertions) key`);
      }
      inputs.push({ api: "std::env::var", key, position: match.index });
    }
  }

  for (const match of masked.matchAll(/\b(option_env|env)!\s*\(/g)) {
    const key = staticRustKey(callArguments(source, masked, match));
    if (!key) throw new Error(`${relative} compile-time environment input key must be static`);
    inputs.push({ api: `${match[1]}!`, key, position: match.index });
  }
  const counts = new Map();
  return inputs
    .sort((left, right) => left.position - right.position)
    .map(({ api, key }) => {
      const countKey = `${api}:${key}`;
      const index = (counts.get(countKey) ?? 0) + 1;
      counts.set(countKey, index);
      return `rust:${relative}:${api}:${key}#${index}`;
    });
}

export function discoverRuntimeInputSurface(root) {
  const inputs = [];
  for (const absolute of productionTypeScriptFiles(root)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    inputs.push(...analyzeFrontendFile(relative, readFileSync(absolute, "utf8")));
  }
  for (const absolute of productionRustFiles(root)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    inputs.push(...analyzeRustFile(relative, readFileSync(absolute, "utf8")));
  }
  return uniqueSorted(inputs);
}
