import { isDedicatedRustTestModulePath } from "./source-classification.mjs";

const RUST_SOURCE_ROOT = "src-tauri/src/";
const DATABASE_SOURCE = `${RUST_SOURCE_ROOT}database.rs`;
const DATABASE_TEST_FIXTURES = new Set([
  'include_str!("../tests/fixtures/core-schema/v1.1.12.sql")',
  'include_str!("../tests/fixtures/core-schema/v1.2.0.sql")',
  'include_str!("../tests/fixtures/core-schema/v1.2.2.sql")',
]);

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function findRustSourceTreeHazards(paths) {
  const errors = [];
  const modulePaths = new Map();
  for (const pathname of paths.filter((candidate) => candidate.startsWith(RUST_SOURCE_ROOT))) {
    if (!pathname.endsWith(".rs")) {
      errors.push(`Rust source root accepts only .rs files: ${pathname}`);
      continue;
    }
    const relative = pathname.slice(RUST_SOURCE_ROOT.length);
    if (relative.includes("/")) {
      errors.push(
        `nested Rust source paths are forbidden until module identity is modeled: ${pathname}`,
      );
    }
    const basename = relative.slice(relative.lastIndexOf("/") + 1, -3);
    const candidates = modulePaths.get(basename) ?? [];
    candidates.push(pathname);
    modulePaths.set(basename, candidates);
  }
  for (const [basename, candidates] of modulePaths) {
    if (candidates.length > 1) {
      errors.push(
        `Rust module basename identity conflict for ${basename}: ${candidates.sort().join(", ")}`,
      );
    }
  }
  return uniqueSorted(errors);
}

export function findForbiddenRustModuleGraphSyntax(pathname, source) {
  const code = rustCodeOnly(source);
  const errors = [];
  if (/\br#[A-Za-z_][A-Za-z0-9_]*/.test(code)) {
    errors.push(
      `${pathname} uses a raw Rust identifier; raw identifiers are forbidden until module graph canonicalization is modeled`,
    );
  }
  if (/\bsuper\s*::\s*(?:\{\s*)?super\s*::/.test(code)) {
    errors.push(
      `${pathname} repeated super:: paths are forbidden until nested Rust module identity is modeled`,
    );
  }
  if (/\bmacro_rules\s*!/.test(code)) {
    errors.push(
      `${pathname} defines a local macro_rules macro; local macro_rules definitions are forbidden because generated module edges are not statically auditable`,
    );
  }

  const pathAttributes = [...code.matchAll(/#\s*\[[^\]]*\bpath\s*=/g)];
  const allowedTestPathAttributes = new Set();
  for (const declaration of code.matchAll(
    /^(?<attributes>(?:[ \t]*#\s*\[[^\]\r\n]*\][ \t]*(?:\r?\n|))*)[ \t]*(?:(?:pub(?:\([^)]*\))?)\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*;/gm,
  )) {
    const attributes = declaration.groups.attributes;
    if (!/cfg\s*\(\s*test\s*\)/.test(attributes)) continue;
    for (const pathAttribute of attributes.matchAll(/#\s*\[\s*path\s*=/g)) {
      const attributeIndex = declaration.index + pathAttribute.index;
      const explicitTestModule = source.slice(attributeIndex).match(
        /^#\s*\[\s*path\s*=\s*"([^"/]+\.rs)"\s*\]/,
      );
      if (explicitTestModule && isDedicatedRustTestModulePath(explicitTestModule[1])) {
        allowedTestPathAttributes.add(attributeIndex);
      }
    }
  }
  if (pathAttributes.some((attribute) => !allowedTestPathAttributes.has(attribute.index))) {
    errors.push(
      `${pathname} uses a production #[path] module; only cfg(test) external test modules are allowed`,
    );
  }
  return uniqueSorted(errors);
}

export function rustCodeOnly(source) {
  const output = [...source];
  const blank = (index) => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  for (let index = 0; index < source.length;) {
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") blank(index++);
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 0;
      while (index < source.length) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          blank(index++);
          blank(index++);
        } else if (source.startsWith("*/", index)) {
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
    const character = source.slice(index).match(
      /^(?:b)?'(?:\\(?:[nrt0\\'" ]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f_]{1,6}\})|[^'\\\r\n])'/,
    );
    if (character) {
      for (let count = 0; count < character[0].length; count += 1) blank(index++);
      continue;
    }
    const raw = source.slice(index).match(/^r(#+)?"/);
    if (raw) {
      const hashes = raw[1] ?? "";
      const closing = `"${hashes}`;
      for (let count = 0; count < raw[0].length; count += 1) blank(index++);
      while (index < source.length && !source.startsWith(closing, index)) blank(index++);
      for (let count = 0; count < closing.length && index < source.length; count += 1) {
        blank(index++);
      }
      continue;
    }
    if (source[index] === '"') {
      blank(index++);
      while (index < source.length) {
        const escaped = source[index] === "\\";
        const closed = source[index] === '"';
        blank(index++);
        if (escaped && index < source.length) blank(index++);
        else if (closed) break;
      }
      continue;
    }
    index += 1;
  }
  return output.join("");
}

export function rustDelimiterRanges(source) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const closings = new Set(Object.values(pairs));
  const stack = [];
  const ranges = [];
  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];
    if (pairs[token]) stack.push({ opening: index, open: token });
    else if (closings.has(token) && stack.length > 0) {
      const candidate = stack.at(-1);
      if (pairs[candidate.open] !== token) continue;
      stack.pop();
      ranges.push({ opening: candidate.opening, closing: index });
    }
  }
  return ranges;
}

function matchingDelimiter(source, opening, open, close) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function databaseTestModuleRange(code) {
  const matches = [...code.matchAll(
    /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+tests\s*\{/g,
  )];
  if (matches.length !== 1) return undefined;
  const opening = matches[0].index + matches[0][0].lastIndexOf("{");
  const closing = matchingDelimiter(code, opening, "{", "}");
  return closing === undefined ? undefined : { opening, closing };
}

export function findForbiddenRustIncludeMacros(pathname, source) {
  const code = rustCodeOnly(source);
  const allowedRange = pathname === DATABASE_SOURCE ? databaseTestModuleRange(code) : undefined;
  const errors = [];
  for (const match of code.matchAll(/\binclude(?:_(?:str|bytes))?\b/g)) {
    const invocation = code.slice(match.index).match(/^include(?:_(?:str|bytes))?\s*!\s*\(/);
    const opening = invocation ? match.index + invocation[0].lastIndexOf("(") : undefined;
    const closing = opening === undefined
      ? undefined
      : matchingDelimiter(code, opening, "(", ")");
    const canonical = closing === undefined
      ? undefined
      : source.slice(match.index, closing + 1).replace(/\s+/g, "");
    const insideAllowedTestModule =
      allowedRange && match.index > allowedRange.opening && closing < allowedRange.closing;
    const allowedDatabaseFixture =
      match[0] === "include_str" &&
      insideAllowedTestModule &&
      DATABASE_TEST_FIXTURES.has(canonical);
    if (!allowedDatabaseFixture) {
      errors.push(
        `${pathname} uses forbidden ${match[0]} input; production Rust include macros are limited to the three database cfg(test) schema fixtures`,
      );
    }
  }
  return uniqueSorted(errors);
}
