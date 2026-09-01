#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const ARCHITECTURE_BUDGET_PATH = "docs/engineering/architecture-budget.json";
const BUILD_TOOLS = ["@vitejs/plugin-react", "vite", "vitest", "typescript"];
const CRITICAL_PACKAGE_SCRIPTS = {
  typecheck: "tsc --noEmit",
  "typecheck:strict-islands": "tsc --noEmit --strict",
  test: "vitest run",
  "test:scripts": "node --test scripts/__tests__/*.test.mjs",
  "test:e2e": "playwright test",
  "test:coverage": "vitest run --coverage",
  "coverage:rust": "node scripts/rust-coverage.mjs",
  "coverage:check":
    "npm run test:coverage && node scripts/check-coverage.mjs frontend && npm run coverage:rust && node scripts/check-coverage.mjs rust",
  build: "vite build",
  "verify:governance": "node scripts/governance.mjs all",
  verify: "node scripts/verify.mjs",
  "github:governance:check": "node scripts/github-governance-check.mjs",
  "release:verify": "node scripts/release-verify.mjs",
  "tauri:build": "tauri build",
};
const PRIVATE_PATHS = [
  /^AGENTS\.md$/,
  /^docs\/(?:internal|promo)(?:\/|$)/,
  /^assets\/brand(?:\/|$)/,
];

export function validateVersions(versions) {
  const expected = versions.packageVersion;
  const labels = {
    lockRootVersion: "package-lock.json root version",
    cargoVersion: "src-tauri/Cargo.toml package version",
    cargoLockVersion: "src-tauri/Cargo.lock package version",
    tauriVersion: "src-tauri/tauri.conf.json version",
  };

  return Object.entries(labels).flatMap(([key, label]) =>
    versions[key] === expected
      ? []
      : [`${label} is ${versions[key] ?? "missing"}; expected ${expected}`],
  );
}

export function validateRuntimeToolchain({ nodeVersion, npmVersion }) {
  const errors = [];
  if (nodeVersion !== "v22.23.1") {
    errors.push(`running Node is ${nodeVersion}; expected v22.23.1`);
  }
  if (npmVersion !== "10.9.8") {
    errors.push(`running npm is ${npmVersion}; expected 10.9.8`);
  }
  return errors;
}

export function validateCriticalPackageScripts(scripts) {
  return Object.entries(CRITICAL_PACKAGE_SCRIPTS).flatMap(([name, expected]) => {
    const actual = scripts?.[name];
    return actual === expected
      ? []
      : [`critical package script ${name} is ${actual ?? "missing"}; expected ${expected}`];
  });
}

export function checkRepositoryBoundaries({ trackedFiles, packageJson, lockUrls }) {
  const errors = [];
  for (const path of trackedFiles) {
    if (PRIVATE_PATHS.some((pattern) => pattern.test(path))) {
      errors.push(`private file is tracked: ${path}`);
    }
  }

  for (const tool of BUILD_TOOLS) {
    if (packageJson.dependencies?.[tool]) {
      errors.push(`build tool must be in devDependencies: ${tool}`);
    }
  }

  for (const url of lockUrls) {
    if (!url.startsWith("https://registry.npmjs.org/")) {
      errors.push(`package-lock contains a non-official registry URL: ${url}`);
    }
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      if (/^(?:file|link|workspace):/.test(specifier)) {
        errors.push(`${section} contains a local package outside governed src/: ${name}=${specifier}`);
      }
    }
  }
  if (packageJson.imports != null) {
    errors.push(
      "package.json imports aliases are forbidden; repository-relative module paths keep the governed graph auditable",
    );
  }
  errors.push(...validateCriticalPackageScripts(packageJson.scripts));
  return errors;
}

export function extractFrontendCommands(contents) {
  const commands = [];
  const sourceFile = parseTypeScript("src/api.ts", contents);
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "command" &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      /^[a-z][a-z0-9_]*$/.test(node.arguments[0].text)
    ) {
      commands.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return commands;
}

export function extractRustCommands(contents) {
  const code = maskRustNonCode(contents).split("");
  for (const attribute of rustAttributes(contents)) {
    for (let index = attribute.start; index < attribute.end; index += 1) {
      if (code[index] !== "\n" && code[index] !== "\r") code[index] = " ";
    }
  }
  const masked = code.join("");
  const commands = [];
  const marker = /\btauri\s*::\s*generate_handler\s*!\s*\[/g;
  for (const match of masked.matchAll(marker)) {
    const bodyStart = match.index + match[0].length;
    let cursor = bodyStart;
    let depth = 1;
    while (cursor < masked.length && depth > 0) {
      if (masked[cursor] === "[") depth += 1;
      else if (masked[cursor] === "]") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) continue;
    for (const entry of masked.slice(bodyStart, cursor - 1).split(",")) {
      const compact = entry.replace(/\s+/g, "");
      const name = compact.match(
        /^(?:[A-Za-z_][A-Za-z0-9_]*::)*([a-z][a-z0-9_]*)$/,
      )?.[1];
      if (name) commands.push(name);
    }
  }
  return commands;
}

export function compareCommandInventories({ frontend, rust }) {
  const errors = [];
  const duplicateNames = (commands) =>
    [...new Set(commands.filter((name, index) => commands.indexOf(name) !== index))].sort();
  for (const name of duplicateNames(frontend)) {
    errors.push(`frontend command is declared more than once: ${name}`);
  }
  for (const name of duplicateNames(rust)) {
    errors.push(`Rust command is registered more than once: ${name}`);
  }
  const frontendSet = new Set(frontend);
  const rustSet = new Set(rust);
  for (const name of [...frontendSet].filter((name) => !rustSet.has(name)).sort()) {
    errors.push(`frontend command is not registered by Rust: ${name}`);
  }
  for (const name of [...rustSet].filter((name) => !frontendSet.has(name)).sort()) {
    errors.push(`Rust command has no frontend API wrapper: ${name}`);
  }
  if (frontendSet.has("configure_schedule") || rustSet.has("configure_schedule")) {
    errors.push("removed command must not return: configure_schedule");
  }
  return errors;
}

function sourceLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
}

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

export function findExplicitAny(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const errors = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      errors.push(`${path}:${sourceLocation(sourceFile, node)} uses explicit any`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

function propertyAccessChain(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isCallExpression(node)) return propertyAccessChain(node.expression);
  if (ts.isPropertyAccessExpression(node)) {
    const prefix = propertyAccessChain(node.expression);
    return prefix ? [...prefix, node.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    const prefix = propertyAccessChain(node.expression);
    return prefix ? [...prefix, node.argumentExpression.text] : undefined;
  }
  return undefined;
}

function stringLiteralValue(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function isImportMeta(node) {
  return (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === "meta"
  );
}

function isImportMetaGlob(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text.startsWith("glob") &&
    isImportMeta(node.expression)
  );
}

function isImportMetaUrl(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    isImportMeta(node.expression)
  );
}

function frontendModuleReferences(sourceFile) {
  const references = [];
  const referenceKeys = new Set();
  const hazards = [];
  const addReference = (node, specifier, kind) => {
    const key = `${node.pos}:${specifier}`;
    if (referenceKeys.has(key)) return;
    referenceKeys.add(key);
    references.push({ node, specifier, kind });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addReference(node.moduleSpecifier, node.moduleSpecifier.text, "module");
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier = stringLiteralValue(node.arguments[0]);
      if (node.arguments.length !== 1 || specifier == null) {
        hazards.push({ node, message: "uses a non-literal dynamic module import" });
      } else {
        addReference(node.arguments[0], specifier, "module");
      }
    } else if (ts.isCallExpression(node) && isImportMetaGlob(node.expression)) {
      hazards.push({
        node,
        message:
          "uses import.meta.glob; production module graphs must use explicit imports so test and path exclusions cannot be bypassed",
      });
    } else if (ts.isNewExpression(node)) {
      const constructorName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (constructorName === "URL") {
        const specifier = stringLiteralValue(node.arguments?.[0]);
        const base = node.arguments?.[1];
        if (base && isImportMetaUrl(base)) {
          if (specifier != null) addReference(node.arguments[0], specifier, "url");
          else hazards.push({ node, message: "uses a non-literal URL module reference" });
        }
        ts.forEachChild(node, visit);
        return;
      }
      if (!["Worker", "SharedWorker"].includes(constructorName)) {
        ts.forEachChild(node, visit);
        return;
      }
      const workerArgument = node.arguments?.[0];
      const direct = workerArgument && stringLiteralValue(workerArgument);
      if (direct != null) {
        addReference(workerArgument, direct, "worker");
      } else if (
        workerArgument &&
        ts.isNewExpression(workerArgument) &&
        ts.isIdentifier(workerArgument.expression) &&
        workerArgument.expression.text === "URL"
      ) {
        const base = workerArgument.arguments?.[1];
        if (!(base && isImportMetaUrl(base))) {
          hazards.push({
            node,
            message: `uses a non-literal ${constructorName} module URL`,
          });
        }
      } else {
        hazards.push({
          node,
          message: `uses a non-literal ${constructorName} module URL`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { references, hazards };
}

export function findForbiddenTestModifiers(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const errors = [];
  const forbidden = new Set(["skip", "skipIf", "runIf", "only", "todo"]);
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const chain = propertyAccessChain(node);
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
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

function isTestModuleSpecifier(specifier) {
  const path = specifier.split(/[?#]/, 1)[0];
  return /(?:^|\/)[^/]+\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/.test(path);
}

export function findProductionTestImports(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const errors = [];
  const report = (node, specifier) => {
    if (isTestModuleSpecifier(specifier)) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node)} imports excluded test module ${specifier}`,
      );
    }
  };
  const { references } = frontendModuleReferences(sourceFile);
  for (const { node, specifier } of references) report(node, specifier);
  return errors;
}

export function findFrontendImportEscapes(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const errors = [];
  const report = (node, specifier) => {
    const clean = specifier.split(/[?#]/, 1)[0];
    let escapes = clean.startsWith("file:") || (clean.startsWith("/") && !clean.startsWith("/src/"));
    if (clean.startsWith(".")) {
      const destination = posix.normalize(posix.join(posix.dirname(path), clean));
      escapes = destination !== "src" && !destination.startsWith("src/");
    }
    if (escapes) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node)} imports outside governed src/: ${specifier}`,
      );
    }
  };
  const { references } = frontendModuleReferences(sourceFile);
  for (const { node, specifier } of references) report(node, specifier);
  return errors;
}

export function findFrontendModuleGraphHazards(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  return frontendModuleReferences(sourceFile).hazards.map(
    ({ node, message }) => `${path}:${sourceLocation(sourceFile, node)} ${message}`,
  );
}

export function findForbiddenFrontendAliases(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const errors = [];
  const visit = (node) => {
    const propertyName =
      "name" in node && node.name
        ? ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
          ? node.name.text
          : ts.isComputedPropertyName(node.name) && ts.isStringLiteralLike(node.name.expression)
            ? node.name.expression.text
            : undefined
        : undefined;
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
      propertyName === "alias"
    ) {
      errors.push(
        `${path}:${sourceLocation(sourceFile, node.name)} defines a Vite alias; aliases are forbidden because the static module graph must resolve from repository-relative paths`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

export function findHtmlModuleEntryHazards(path, contents) {
  const dom = new JSDOM(contents, { includeNodeLocations: true });
  const errors = [];
  for (const script of dom.window.document.querySelectorAll("script")) {
    const line = dom.nodeLocation(script)?.startLine ?? 1;
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    if (type !== "module") {
      errors.push(
        `${path}:${line} contains a non-module script; only explicit governed src/ module entrypoints are allowed`,
      );
      continue;
    }
    const specifier = script.getAttribute("src");
    if (!specifier) {
      errors.push(
        `${path}:${line} contains an inline module script; use an explicit governed src/ entrypoint`,
      );
      continue;
    }
    const clean = specifier.split(/[?#]/, 1)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(clean) || clean.startsWith("data:")) {
      errors.push(`${path}:${line} loads an external module entrypoint: ${specifier}`);
      continue;
    }
    const destination = posix.normalize(
      clean.startsWith("/")
        ? clean.slice(1)
        : posix.join(posix.dirname(path), clean),
    );
    if (destination !== "src" && !destination.startsWith("src/")) {
      errors.push(`${path}:${line} loads a module entrypoint outside governed src/: ${specifier}`);
    } else if (isTestModuleSpecifier(destination)) {
      errors.push(`${path}:${line} loads an excluded test module entrypoint: ${specifier}`);
    } else if (/\.d\.(?:[cm]?ts)$/.test(destination)) {
      errors.push(`${path}:${line} loads an excluded declaration module entrypoint: ${specifier}`);
    }
  }
  dom.window.close();
  return errors;
}

export function findRustTestModulesVisibleInProduction(path, contents) {
  const errors = [];
  const masked = maskRustNonCode(contents);
  const attributes = rustAttributes(contents);
  const attributeGroups = [];
  for (const attribute of attributes) {
    const previous = attributeGroups.at(-1);
    if (previous && /^\s*$/.test(contents.slice(previous.at(-1).end, attribute.start))) {
      previous.push(attribute);
    } else {
      attributeGroups.push([attribute]);
    }
  }
  const moduleDeclaration =
    /\b(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*([;{])/g;
  for (const match of masked.matchAll(moduleDeclaration)) {
    const moduleName = match[1];
    const terminator = match[2];
    const group = attributeGroups.find((candidate) => {
      const last = candidate.at(-1);
      return last.end <= match.index && /^\s*$/.test(contents.slice(last.end, match.index));
    }) ?? [];
    const pathAttributes = group
      .map((attribute) => ({ attribute, value: rustPathAttributeValue(attribute.text) }))
      .filter(({ value }) => value !== undefined);
    const pathAttribute = pathAttributes[0]?.value;
    const isDedicatedTestModule =
      /^(?:tests?|.*_tests)$/.test(moduleName) ||
      (typeof pathAttribute === "string" && /(?:^|\/)(?:tests?|.*_tests)\.rs$/.test(pathAttribute));
    const testOnly = group.some((attribute) => isCanonicalRustCfgTest(attribute.text));
    const line = contents.slice(0, match.index).split("\n").length;
    if (
      pathAttributes.length > 1 ||
      pathAttribute === null ||
      (pathAttribute !== undefined && (!testOnly || !isDedicatedTestModule || terminator !== ";"))
    ) {
      const attributeLine = pathAttributes[0]?.attribute.line ?? line;
      errors.push(
        `${path}:${attributeLine} uses #[path] module ${pathAttribute ?? "unparseable path"}; only canonical #[cfg(test)] external dedicated *_tests.rs modules are allowed`,
      );
      continue;
    }
    if (!isDedicatedTestModule || testOnly) continue;
    errors.push(
      `${path}:${line} exposes dedicated test module ${pathAttribute ?? moduleName} without #[cfg(test)]`,
    );
  }
  return errors;
}

export function findForbiddenRustIncludes(path, contents) {
  const errors = [];
  for (const match of contents.matchAll(/\binclude!\s*\(/g)) {
    const line = contents.slice(0, match.index).split("\n").length;
    errors.push(
      `${path}:${line} uses include! in production; use a governed production module instead`,
    );
  }
  return errors;
}

function rawStringAt(contents, index) {
  const match = contents.slice(index).match(/^(?:b|c)?r(#{0,255})"/);
  if (!match) return undefined;
  const terminator = `"${match[1]}`;
  const close = contents.indexOf(terminator, index + match[0].length);
  return {
    end: close === -1 ? contents.length : close + terminator.length,
  };
}

function rustCharLiteralLength(contents, index) {
  const match = contents.slice(index).match(
    /^(?:b)?'(?:\\(?:[nrt0\\'" ]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f_]{1,6}\})|[^'\\\r\n])'/,
  );
  return match?.[0].length;
}

export function maskRustNonCode(contents) {
  const masked = contents.split("");
  let index = 0;
  let blockDepth = 0;
  let lineComment = false;
  const blank = (start, end = start + 1) => {
    for (let cursor = start; cursor < end; cursor += 1) {
      if (masked[cursor] !== "\n" && masked[cursor] !== "\r") masked[cursor] = " ";
    }
  };
  while (index < contents.length) {
    const current = contents[index];
    const next = contents[index + 1];
    if (lineComment) {
      blank(index);
      if (current === "\n") lineComment = false;
      index += 1;
      continue;
    }
    if (blockDepth > 0) {
      blank(index);
      if (current === "/" && next === "*") {
        blank(index + 1);
        blockDepth += 1;
        index += 2;
      } else if (current === "*" && next === "/") {
        blank(index + 1);
        blockDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      blank(index, index + 2);
      lineComment = true;
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      blank(index, index + 2);
      blockDepth = 1;
      index += 2;
      continue;
    }
    const raw = rawStringAt(contents, index);
    if (raw) {
      blank(index, raw.end);
      index = raw.end;
      continue;
    }
    const stringPrefix =
      current === '"' ? 0 : ["b", "c"].includes(current) && next === '"' ? 1 : undefined;
    if (stringPrefix !== undefined) {
      let cursor = index + stringPrefix + 1;
      let escaped = false;
      while (cursor < contents.length) {
        const character = contents[cursor];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    const charLength = rustCharLiteralLength(contents, index);
    if (charLength) {
      blank(index, index + charLength);
      index += charLength;
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

export function rustAttributes(contents) {
  const attributes = [];
  const masked = maskRustNonCode(contents);
  const startPattern = /#!?\[/g;
  for (const match of masked.matchAll(startPattern)) {
    const start = match.index;
    let cursor = masked.indexOf("[", start) + 1;
    let depth = 1;
    while (cursor < masked.length && depth > 0) {
      const character = masked[cursor];
      if (character === "[") depth += 1;
      else if (character === "]") depth -= 1;
      cursor += 1;
    }
    if (depth === 0) {
      attributes.push({
        text: contents.slice(start, cursor),
        start,
        end: cursor,
        line: contents.slice(0, start).split("\n").length,
      });
    }
  }
  return attributes;
}

function cfgTokenize(contents) {
  const tokens = [];
  let cursor = 0;
  while (cursor < contents.length) {
    const remainder = contents.slice(cursor);
    const whitespace = remainder.match(/^\s+/);
    if (whitespace) {
      cursor += whitespace[0].length;
      continue;
    }
    const identifier = remainder.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier[0] });
      cursor += identifier[0].length;
      continue;
    }
    if (["(", ")", ",", "="].includes(contents[cursor])) {
      tokens.push({ type: contents[cursor], value: contents[cursor] });
      cursor += 1;
      continue;
    }
    if (contents[cursor] === '"') {
      let end = cursor + 1;
      let escaped = false;
      while (end < contents.length) {
        const character = contents[end];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({ type: "string", value: contents.slice(cursor, end) });
      cursor = end;
      continue;
    }
    tokens.push({ type: "invalid", value: contents[cursor] });
    cursor += 1;
  }
  return tokens;
}

function parseCfgMeta(tokens) {
  let cursor = 0;
  const parse = () => {
    const name = tokens[cursor];
    if (name?.type !== "identifier") throw new Error("expected cfg predicate");
    cursor += 1;
    if (tokens[cursor]?.type === "=") {
      cursor += 1;
      if (tokens[cursor]?.type !== "string") throw new Error("expected cfg string value");
      cursor += 1;
      return { kind: "atom", name: name.value };
    }
    if (tokens[cursor]?.type !== "(") return { kind: "atom", name: name.value };
    cursor += 1;
    const children = [];
    while (tokens[cursor]?.type !== ")") {
      children.push(parse());
      if (tokens[cursor]?.type === ",") cursor += 1;
      else if (tokens[cursor]?.type !== ")") throw new Error("expected cfg comma");
      if (cursor >= tokens.length) throw new Error("unclosed cfg predicate");
    }
    cursor += 1;
    return { kind: name.value, children };
  };
  const result = parse();
  if (cursor !== tokens.length) throw new Error("unexpected cfg tokens");
  return result;
}

function cfgPossibilitiesWithoutTest(node) {
  if (node.kind === "atom") return node.name === "test" ? new Set([false]) : new Set([false, true]);
  const childPossibilities = node.children.map(cfgPossibilitiesWithoutTest);
  if (node.kind === "not" && childPossibilities.length === 1) {
    return new Set([...childPossibilities[0]].map((value) => !value));
  }
  if (node.kind === "all") {
    const possible = new Set();
    if (childPossibilities.every((values) => values.has(true))) possible.add(true);
    if (childPossibilities.some((values) => values.has(false))) possible.add(false);
    return possible;
  }
  if (node.kind === "any") {
    const possible = new Set();
    if (childPossibilities.some((values) => values.has(true))) possible.add(true);
    if (childPossibilities.every((values) => values.has(false))) possible.add(false);
    return possible;
  }
  return new Set([false, true]);
}

function cfgMentionsTest(node) {
  return node.kind === "atom"
    ? node.name === "test"
    : node.children.some((child) => cfgMentionsTest(child));
}

export function isCanonicalRustCfgTest(text) {
  return /^#\[\s*cfg\s*\(\s*test\s*\)\s*\]$/.test(text);
}

export function classifyRustCfgAttribute(text) {
  const match = text.match(/^#\[\s*cfg\s*\(([\s\S]*)\)\s*\]$/);
  if (!match) return undefined;
  const tokens = cfgTokenize(match[1]);
  const tokenMentionsTest = tokens.some(
    (token) => token.type === "identifier" && token.value === "test",
  );
  try {
    const expression = parseCfgMeta(tokens);
    const mentionsTest = cfgMentionsTest(expression);
    return {
      canonical: isCanonicalRustCfgTest(text),
      mentionsTest,
      testOnly: mentionsTest && !cfgPossibilitiesWithoutTest(expression).has(true),
      valid: true,
    };
  } catch {
    return { canonical: false, mentionsTest: tokenMentionsTest, testOnly: false, valid: false };
  }
}

function rustPathAttributeValue(text) {
  const body = text.match(/^#\[\s*path\s*=\s*([\s\S]+?)\s*\]$/)?.[1];
  if (body == null) return undefined;
  const normal = body.match(/^"([^"\\\r\n]*)"$/);
  if (normal) return normal[1];
  const raw = body.match(/^r(#{0,255})"([\s\S]*)"\1$/);
  if (raw) return raw[2];
  return null;
}

export function findForbiddenRustTestCfg(path, contents) {
  const errors = [];
  for (const attribute of rustAttributes(contents)) {
    const classification = classifyRustCfgAttribute(attribute.text);
    if (classification?.mentionsTest && !classification.canonical) {
      const isDebugOrTest =
        /^#\[\s*cfg\s*\(\s*any\s*\(\s*debug_assertions\s*,\s*test\s*,?\s*\)\s*\)\s*\]$/.test(
          attribute.text,
        );
      if (!isDebugOrTest) {
        errors.push(
          `${path}:${attribute.line} uses non-canonical test cfg; use exact #[cfg(test)] so production coverage filtering fails closed`,
        );
      }
    }
    if (
      /^#\[\s*cfg_attr\b/.test(attribute.text) &&
      cfgTokenize(attribute.text).some(
        (token) => token.type === "identifier" && token.value === "test",
      )
    ) {
      errors.push(
        `${path}:${attribute.line} conditionally applies test cfg; cfg_attr involving test is forbidden`,
      );
    }
  }
  return errors;
}

export function findForbiddenRustIgnores(path, contents) {
  const errors = [];
  const allowed = new Set(["prompt_library_release_performance_gate"]);
  for (const attribute of rustAttributes(contents)) {
    if (/^#\[\s*cfg_attr\b[\s\S]*\bignore\b/.test(attribute.text)) {
      errors.push(`${path}:${attribute.line} conditionally ignores a test; cfg_attr(ignore) is forbidden`);
      continue;
    }
    if (!/^#\[\s*ignore(?:\s*=\s*"[^"\n]*")?\s*\]$/.test(attribute.text)) continue;
    const following = contents.slice(attribute.end);
    const functionName = following.match(
      /^(?:\s*#\[[^\]\n]+\]\s*)*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
    )?.[1];
    if (!functionName || !allowed.has(functionName)) {
      errors.push(
        `${path}:${attribute.line} ignores non-whitelisted Rust test: ${functionName ?? "unknown"}`,
      );
    }
  }
  return errors;
}

export function findForbiddenClippySuppressions(path, contents) {
  const errors = [];
  for (const attribute of rustAttributes(contents)) {
    if (!/(?:\br#clippy|\bclippy)\s*::\s*(?:r#)?[A-Za-z_]/.test(attribute.text)) continue;
    if (
      /^#!?\[\s*cfg_attr\b/.test(attribute.text) &&
      /\b(?:allow|expect)\s*\(/.test(attribute.text)
    ) {
      errors.push(
        `${path}:${attribute.line} conditionally suppresses Clippy through cfg_attr; use an unconditional narrow expect with a reason`,
      );
    } else if (/^#!\[\s*(?:allow|expect)\s*\(/.test(attribute.text)) {
      errors.push(`${path}:${attribute.line} uses a crate/module-wide Clippy suppression`);
    } else if (/^#\[\s*allow\s*\(/.test(attribute.text)) {
      errors.push(`${path}:${attribute.line} uses allow(clippy); use a narrow expect with a reason`);
    } else if (
      /^#\[\s*expect\s*\(/.test(attribute.text) &&
      !/\breason\s*=\s*"[^"\n]+"/.test(attribute.text)
    ) {
      errors.push(`${path}:${attribute.line} uses expect(clippy) without a non-empty reason`);
    }
  }
  return errors;
}

export function findForbiddenGithubTransportUsage(path, contents) {
  const errors = [];
  if (
    /\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*->\s*&\s*reqwest::(?:(?:blocking|r#blocking)::)?(?:Client|ClientBuilder)\b/.test(
      contents,
    )
  ) {
    errors.push(`${path} exposes the raw GitHub HTTP client`);
  }
  if (path === "src-tauri/src/adapters.rs") return errors;
  if (
    /\breqwest::(?:(?:blocking|r#blocking)::)?(?:Client|ClientBuilder|RequestBuilder)\b|\b(?:Client|ClientBuilder)::(?:new|builder)\s*\(|\breqwest::\{[^}]*\b(?:Client|ClientBuilder|RequestBuilder)\b/.test(
      contents,
    )
  ) {
    errors.push(`${path} constructs or names a raw reqwest client outside adapters.rs`);
  }
  if (/\.github\s*\.\s*client\s*\(|\bGithubHttpAdapter\b[^\n{;]*\bclient\s*\(/.test(contents)) {
    errors.push(`${path} bypasses GithubHttpAdapter through client()`);
  }
  const httpRequestReceivers = new Set();
  for (const match of contents.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:reqwest::)?RequestBuilder\b/g,
  )) {
    httpRequestReceivers.add(match[1]);
  }
  for (const match of contents.matchAll(
    /\blet(?:\s+mut)?\s+([A-Za-z_][A-Za-z0-9_]*)[^=;\n]*=\s*([^;]+);/g,
  )) {
    if (
      /\breqwest\b|\b(?:client|github|adapter)\s*\.\s*(?:get|post|put|patch|delete|head|request)\s*\(/.test(
        match[2],
      )
    ) {
      httpRequestReceivers.add(match[1]);
    }
  }
  const receiverSend = [...contents.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*send\s*\(/g,
  )].some((match) => httpRequestReceivers.has(match[1]));
  const compact = contents.replace(/\/\/.*$/gm, " ").replace(/\s+/g, " ");
  const chainedSend =
    /(?:\breqwest::Client\b|\b(?:client|github|adapter)\s*\.\s*(?:get|post|put|patch|delete|head|request)\s*\()[^;]{0,1000}?\.\s*send\s*\(/.test(
      compact,
    );
  const directReqwestSend = /\breqwest::(?:(?:blocking|r#blocking)::)?get\s*\(/.test(compact);
  const hasRawHttpSend = receiverSend || chainedSend || directReqwestSend;
  if (hasRawHttpSend) {
    errors.push(`${path} sends an HTTP request outside adapters.rs`);
  }
  return errors;
}

export function findForbiddenFrontendRuntimeUsage(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const rawNetworkApis = new Set();
  let importsTauriCoreOutsideApi = false;
  let invokesTauriGlobal = false;

  const recordNetworkApi = (expression) => {
    const chain = propertyAccessChain(expression);
    if (!chain?.length) return;
    const api = chain.at(-1);
    const isGlobal = chain.length === 1 || ["window", "globalThis", "self"].includes(chain[0]);
    if (isGlobal && ["fetch", "XMLHttpRequest", "EventSource", "WebSocket"].includes(api)) {
      rawNetworkApis.add(api);
    }
    if (api === "sendBeacon" && chain.includes("navigator")) rawNetworkApis.add("sendBeacon");
    if (
      api === "invoke" &&
      (chain.includes("__TAURI__") || chain.includes("__TAURI_INTERNALS__"))
    ) {
      invokesTauriGlobal = true;
    }
  };

  const recordModuleSpecifier = (node) => {
    if (
      path !== "src/api.ts" &&
      ts.isStringLiteralLike(node) &&
      /^@tauri-apps\/api\/core(?:$|\/)/.test(node.text)
    ) {
      importsTauriCoreOutsideApi = true;
    }
  };

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      recordModuleSpecifier(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node)) {
      recordNetworkApi(node.expression);
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        recordModuleSpecifier(node.arguments[0]);
      }
    }
    if (ts.isNewExpression(node)) recordNetworkApi(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const errors = ["fetch", "XMLHttpRequest", "EventSource", "WebSocket", "sendBeacon"]
    .filter((api) => rawNetworkApis.has(api))
    .map(
      (api) =>
        `${path} uses raw frontend network API ${api}; route network access through AppService and Rust adapters`,
    );
  if (importsTauriCoreOutsideApi) {
    errors.push(`${path} imports @tauri-apps/api/core outside the governed src/api.ts wrapper`);
  }
  if (invokesTauriGlobal) {
    errors.push(`${path} invokes the raw Tauri global outside the governed src/api.ts wrapper`);
  }
  return errors;
}

export function checkArchitectureSnapshot({ files, budget }) {
  const errors = [];
  if (budget.newModuleMaxLines !== 800) {
    errors.push(
      `new production module cap must remain 800 lines; found ${budget.newModuleMaxLines ?? "missing"}`,
    );
  }
  for (const [path, lines] of Object.entries(files)) {
    const hotSpot = budget.hotSpots[path];
    if (hotSpot) {
      if (lines !== hotSpot.maxLines) {
        errors.push(
          `${path} has ${lines} lines; hotspot snapshot must equal ${hotSpot.maxLines} and be updated downward with the code`,
        );
      }
      continue;
    }
    if (lines > budget.newModuleMaxLines) {
      errors.push(
        `${path} has ${lines} lines; new production modules are limited to ${budget.newModuleMaxLines}`,
      );
    }
  }
  for (const path of Object.keys(budget.hotSpots)) {
    if (!Object.hasOwn(files, path)) {
      errors.push(`${path} is budgeted as a hotspot but is missing from production sources`);
    }
  }
  return errors;
}

export function parseUnifiedDiffLines(diff) {
  const changed = {};
  let currentFile;
  let destinationLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      changed[currentFile] ??= [];
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      destinationLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed[currentFile].push(destinationLine);
      destinationLine += 1;
    } else if (!line.startsWith("-")) {
      destinationLine += 1;
    }
  }
  return Object.fromEntries(Object.entries(changed).filter(([, lines]) => lines.length));
}

export function compareCoverage({ current, baseline, changed }) {
  const errors = [];
  for (const metric of ["lines", "branches", "functions"]) {
    if (current[metric] + Number.EPSILON < baseline[metric]) {
      errors.push(
        `overall ${metric} coverage regressed: ${current[metric]}% < ${baseline[metric]}%`,
      );
    }
  }
  if (changed?.linePercent != null && changed.linePercent < 80) {
    errors.push(`changed lines coverage is ${changed.linePercent}%; required 80%`);
  }
  if (changed?.branchPercent != null && changed.branchPercent < 70) {
    errors.push(`changed branches coverage is ${changed.branchPercent}%; required 70%`);
  }
  return errors;
}

export function shouldEnforceChangedCoverage({ baseRef }) {
  return Boolean(baseRef);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCargoPackageVersion(contents, packageName) {
  const blocks = contents.split(/\n\[\[?package\]?\]\n/);
  const block = blocks.find((candidate) =>
    new RegExp(`(?:^|\\n)name = "${packageName}"(?:\\n|$)`).test(candidate),
  );
  return block?.match(/(?:^|\n)version = "([^"]+)"/)?.[1];
}

function collectLockUrls(contents) {
  return [...contents.matchAll(/"resolved":\s*"([^"]+)"/g)].map((match) => match[1]);
}

function countLines(path) {
  const contents = readFileSync(path, "utf8");
  return contents === "" ? 0 : contents.split(/\r?\n/).length - (contents.endsWith("\n") ? 1 : 0);
}

export function isProductionModule(path) {
  if (![".ts", ".tsx", ".mts", ".cts", ".rs"].includes(extname(path))) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(path)) return false;
  if (/\.d\.(?:[cm]?ts)$/.test(path)) return false;
  if (/(?:^|\/)(?:tests?|.*_tests)\.rs$/.test(path)) return false;
  if (path.endsWith("src/testSetup.ts")) return false;
  return path.startsWith("src/") || path.startsWith("src-tauri/src/");
}

function visitWorkflowUses(value, visit, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitWorkflowUses(item, visit, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "uses") visit(child);
    visitWorkflowUses(child, visit, seen);
  }
}

export function findUnpinnedWorkflowUses(path, contents) {
  let workflow;
  try {
    workflow = parseYaml(contents, { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    return [`${path} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = [];
  visitWorkflowUses(workflow, (uses) => {
    if (typeof uses !== "string" || uses.trim() === "") {
      errors.push(`${path} contains a non-string or empty uses value`);
      return;
    }
    const reference = uses.trim();
    if (reference.startsWith("./")) return;
    if (!/@[0-9a-f]{40}$/.test(reference)) {
      errors.push(`third-party Action is not pinned to a full commit SHA: ${path}: ${reference}`);
    }
  });
  return errors;
}

const EXPECTED_CI_WORKFLOW = {
  name: "CI",
  on: {
    pull_request: null,
    push: { branches: ["main"] },
  },
  permissions: { contents: "read" },
  concurrency: {
    group: "ci-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true,
  },
  env: {
    NODE_VERSION: "22.23.1",
    VERIFY_BASE_REF: "${{ github.event.pull_request.base.sha }}",
    ARCHITECTURE_BASE_REF: "${{ github.event.pull_request.base.sha }}",
    COVERAGE_BASE_REF: "${{ github.event.pull_request.base.sha }}",
  },
  jobs: {
    verify: {
      name: "verify",
      "runs-on": "macos-15",
      "timeout-minutes": 45,
      steps: [
        {
          name: "Checkout full history",
          uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          with: { "fetch-depth": 0, "persist-credentials": false },
        },
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          with: { "node-version": "${{ env.NODE_VERSION }}", cache: "npm" },
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal --component clippy,rustfmt\nrustup default 1.95.0\n",
        },
        {
          name: "Install npm dependencies from the official registry",
          run: "npm ci --registry=https://registry.npmjs.org",
        },
        { name: "Install pinned Chromium", run: "npx playwright install chromium" },
        { name: "Run the deterministic repository gate", run: "npm run verify" },
        {
          name: "Run browser acceptance with DemoAppService",
          run: "npm run test:e2e",
        },
      ],
    },
    coverage: {
      name: "coverage",
      "runs-on": "macos-15",
      "timeout-minutes": 60,
      steps: [
        {
          name: "Checkout full history",
          uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          with: { "fetch-depth": 0, "persist-credentials": false },
        },
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          with: { "node-version": "${{ env.NODE_VERSION }}", cache: "npm" },
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal\nrustup toolchain install nightly-2026-08-01 --profile minimal --component llvm-tools-preview\nrustup default 1.95.0\n",
        },
        {
          name: "Install npm dependencies from the official registry",
          run: "npm ci --registry=https://registry.npmjs.org",
        },
        {
          name: "Install pinned cargo-llvm-cov",
          run: "cargo install cargo-llvm-cov --locked --version 0.9.0",
        },
        { name: "Enforce frontend and Rust coverage", run: "npm run coverage:check" },
      ],
    },
    msrv: {
      name: "msrv",
      "runs-on": "macos-15",
      "timeout-minutes": 35,
      steps: [
        {
          name: "Checkout",
          uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          with: { "persist-credentials": false },
        },
        {
          name: "Install the declared minimum Rust version",
          run: "rustup toolchain install 1.88.0 --profile minimal",
        },
        {
          name: "Compile every target at MSRV",
          run: "cargo +1.88.0 check --locked --all-targets --all-features --manifest-path src-tauri/Cargo.toml",
        },
      ],
    },
  },
};

const EXPECTED_SECURITY_AUDIT_WORKFLOW = {
  name: "Security audit",
  on: {
    workflow_dispatch: null,
    schedule: [{ cron: "17 2 * * 1" }],
  },
  permissions: { contents: "read" },
  concurrency: { group: "security-audit", "cancel-in-progress": true },
  jobs: {
    audit: {
      "runs-on": "macos-15",
      "timeout-minutes": 40,
      steps: [
        {
          name: "Checkout",
          uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          with: { "persist-credentials": false },
        },
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          with: { "node-version-file": ".node-version", cache: "npm" },
        },
        {
          name: "Audit npm lock through the official registry",
          run: "npm audit --audit-level=high --registry=https://registry.npmjs.org",
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal\nrustup default 1.95.0\n",
        },
        {
          name: "Install pinned cargo-audit",
          run: "cargo install cargo-audit --locked --version 0.21.2",
        },
        { name: "Audit Cargo.lock", run: "cargo audit --file src-tauri/Cargo.lock" },
      ],
    },
  },
};

const EXPECTED_WEEKLY_RESILIENCE_WORKFLOW = {
  name: "Weekly resilience",
  on: {
    workflow_dispatch: null,
    schedule: [{ cron: "43 3 * * 0" }],
  },
  permissions: { contents: "read" },
  concurrency: { group: "weekly-resilience", "cancel-in-progress": true },
  jobs: {
    "repeat-and-performance": {
      "runs-on": "macos-15",
      "timeout-minutes": 90,
      steps: [
        {
          name: "Checkout",
          uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          with: { "persist-credentials": false },
        },
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          with: { "node-version-file": ".node-version", cache: "npm" },
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal\nrustup default 1.95.0\n",
        },
        {
          name: "Install npm dependencies",
          run: "npm ci --registry=https://registry.npmjs.org",
        },
        {
          name: "Repeat race and filesystem suites",
          run: 'for attempt in 1 2 3; do\n  echo "repeat attempt ${attempt}/3"\n  npm test\n  cargo test --locked --all-features --manifest-path src-tauri/Cargo.toml\ndone\n',
        },
        {
          name: "Run the 10,000 prompts / 100 MiB release performance gate",
          run: "cargo test --release --locked --manifest-path src-tauri/Cargo.toml prompt_library_release_performance_gate -- --ignored --nocapture --test-threads=1",
        },
      ],
    },
  },
};

function validateExactWorkflowPolicy(contents, label, expectedWorkflow) {
  let workflow;
  try {
    workflow = parseYaml(contents, { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    return [
      `${label} workflow is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return isDeepStrictEqual(workflow, expectedWorkflow)
    ? []
    : [`${label} workflow must match the complete fail-closed template`];
}

export function validateCiWorkflowPolicy(contents) {
  return validateExactWorkflowPolicy(contents, "CI", EXPECTED_CI_WORKFLOW);
}

export function validateSecurityAuditWorkflowPolicy(contents) {
  return validateExactWorkflowPolicy(
    contents,
    "security audit",
    EXPECTED_SECURITY_AUDIT_WORKFLOW,
  );
}

export function validateWeeklyResilienceWorkflowPolicy(contents) {
  return validateExactWorkflowPolicy(
    contents,
    "weekly resilience",
    EXPECTED_WEEKLY_RESILIENCE_WORKFLOW,
  );
}

export function validateReleaseWorkflowPolicy(contents) {
  const exactVerifierCommand = `set -euo pipefail
manifest_file="$RUNNER_TEMP/srt-release-manifest.token"
trap 'rm -f "$manifest_file"' EXIT
manifest_token="$(
  node -e '
    const { readFileSync } = require("node:fs");
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const token = event.inputs?.releaseManifest;
    if (token != null && typeof token !== "string") process.exit(2);
    process.stdout.write(token ?? "");
  '
)"
if [[ "$RELEASE_PHASE" == "local" ]]; then
  if [[ -n "$manifest_token" ]]; then
    echo "releaseManifest must be empty for local verification" >&2
    exit 1
  fi
elif [[ ! "$manifest_token" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "releaseManifest is required and must be base64url for remote verification" >&2
  exit 1
fi
if [[ -n "$manifest_token" ]]; then
  printf '::add-mask::%s\\n' "$manifest_token"
fi
umask 077
printf '%s\\n' "$manifest_token" > "$manifest_file"
chmod 600 "$manifest_file"
manifest_token="$(<"$manifest_file")"
npm run --silent release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$manifest_token"
`;
  let workflow;
  try {
    workflow = parseYaml(contents, { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    return [
      `release workflow is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const errors = [];
  const expectedWorkflow = {
    name: "Release gate",
    on: {
      workflow_dispatch: {
        inputs: {
          version: {
            description: "Exact stable version (for example 1.2.2)",
            required: true,
            type: "string",
          },
          phase: {
            description: "Verification phase",
            required: true,
            default: "remote",
            type: "choice",
            options: ["local", "remote"],
          },
          releaseManifest: {
            description:
              "Operator-carried artifact field token; required for remote and not proof of local-gate provenance",
            required: false,
            type: "string",
          },
        },
      },
    },
    permissions: { contents: "read" },
    concurrency: {
      group: "release-gate-${{ inputs.version }}-${{ inputs.phase }}",
      "cancel-in-progress": false,
    },
    jobs: {
      "verify-release": {
        "runs-on": "macos-15",
        "timeout-minutes": 120,
        environment: "release",
        env: {
          GH_TOKEN: "${{ github.token }}",
          RELEASE_VERSION: "${{ inputs.version }}",
          RELEASE_PHASE: "${{ inputs.phase }}",
        },
        steps: [
          {
            name: "Checkout full history and tags",
            uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
            with: { "fetch-depth": 0, "persist-credentials": false },
          },
          {
            name: "Set up Node.js",
            uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
            with: { "node-version-file": ".node-version", cache: "npm" },
          },
          {
            name: "Set up pinned Rust",
            run: "rustup toolchain install 1.95.0 --profile minimal --component clippy,rustfmt\nrustup toolchain install 1.88.0 --profile minimal\nrustup toolchain install nightly-2026-08-01 --profile minimal --component llvm-tools-preview\nrustup default 1.95.0\n",
          },
          {
            name: "Install npm dependencies",
            run: "npm ci --registry=https://registry.npmjs.org",
          },
          {
            name: "Install local-phase coverage and browser tools",
            if: "inputs.phase == 'local'",
            run: "cargo install cargo-llvm-cov --locked --version 0.9.0\nnpx playwright install chromium\n",
          },
          {
            name: "Run the explicit release verification lane",
            run: exactVerifierCommand,
          },
        ],
      },
    },
  };
  if (!isDeepStrictEqual(workflow, expectedWorkflow)) {
    errors.push("release workflow must match the complete fail-closed template");
  }
  const triggers = Object.keys(workflow?.on ?? {});
  if (triggers.length !== 1 || triggers[0] !== "workflow_dispatch") {
    errors.push("release workflow must use only workflow_dispatch");
  }
  const permissions = workflow?.permissions;
  if (
    permissions == null ||
    typeof permissions !== "object" ||
    Array.isArray(permissions) ||
    Object.keys(permissions).length !== 1 ||
    permissions.contents !== "read"
  ) {
    errors.push("release workflow permissions must be exactly contents: read");
  }
  const jobs = workflow?.jobs;
  const jobNames = jobs && typeof jobs === "object" && !Array.isArray(jobs) ? Object.keys(jobs) : [];
  if (jobNames.length !== 1 || jobNames[0] !== "verify-release") {
    errors.push("release workflow must contain only the verify-release job");
  }
  const job = jobs?.["verify-release"];
  const runner = job?.["runs-on"];
  if (runner !== "macos-15") {
    errors.push(
      `release workflow verify-release runner is ${runner ?? "missing"}; expected the Apple Silicon macos-15 hosted runner`,
    );
  }
  const environment =
    typeof job?.environment === "string" ? job.environment : job?.environment?.name;
  if (environment !== "release") {
    errors.push("release workflow verify-release job must bind environment: release");
  }
  if (job?.permissions != null) {
    const jobPermissions = job.permissions;
    if (
      typeof jobPermissions !== "object" ||
      Array.isArray(jobPermissions) ||
      Object.keys(jobPermissions).length !== 1 ||
      jobPermissions.contents !== "read"
    ) {
      errors.push("release workflow job permissions may not exceed contents: read");
    }
  }
  const jobCanAlterVerifierFailure =
    Object.hasOwn(job ?? {}, "if") ||
    Object.hasOwn(job ?? {}, "continue-on-error") ||
    Object.hasOwn(job ?? {}, "shell") ||
    job?.defaults?.run?.shell != null ||
    job?.defaults?.run?.["working-directory"] != null;
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const verifierSteps = [];
  for (const step of steps) {
    if (typeof step?.uses === "string") {
      const action = step.uses.trim();
      if (!action.startsWith("actions/checkout@") && !action.startsWith("actions/setup-node@")) {
        errors.push(`release workflow uses an unapproved action: ${action}`);
      }
    }
    if (typeof step?.run === "string") {
      if (/\bnpm\s+run(?:\s+--silent)?\s+release:verify\b/.test(step.run)) {
        verifierSteps.push(step);
      }
      if (
        /\bgit\s+push\b|\bgh\s+release\b|\b(?:npm|cargo)\s+publish\b|\bgh\s+api\b[^\n]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(
          step.run,
        )
      ) {
        errors.push("release workflow contains a remote mutation command");
      }
    }
  }
  const verifierStep = verifierSteps[0];
  const verifierStepCanAlterFailure =
    verifierStep != null &&
    ["if", "continue-on-error", "shell", "timeout-minutes", "working-directory", "env"].some(
      (field) => Object.hasOwn(verifierStep, field),
    );
  if (
    verifierSteps.length !== 1 ||
    verifierStep.run.trim() !== exactVerifierCommand.trim() ||
    verifierStepCanAlterFailure ||
    jobCanAlterVerifierFailure
  ) {
    errors.push(
      "release verifier step must be unique, unconditional, fail-closed, and exact",
    );
  }
  return errors;
}

export function validateRepositoryAutomationPolicy({ workflowPaths, dependabotContents }) {
  const errors = [];
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-gate.yml",
    ".github/workflows/security-audit.yml",
    ".github/workflows/weekly-resilience.yml",
  ]) {
    if (!workflowPaths.includes(path)) errors.push(`required automation file is missing: ${path}`);
  }
  let dependabot;
  try {
    dependabot = parseYaml(dependabotContents ?? "", {
      maxAliasCount: 100,
      uniqueKeys: true,
    });
  } catch (error) {
    errors.push(
      `.github/dependabot.yml is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return errors;
  }
  const updates = Array.isArray(dependabot?.updates) ? dependabot.updates : [];
  for (const [ecosystem, directory, label] of [
    ["npm", "/", "npm / weekly"],
    ["cargo", "/src-tauri", "cargo /src-tauri weekly"],
  ]) {
    const configured = updates.some(
      (entry) =>
        entry?.["package-ecosystem"] === ecosystem &&
        entry?.directory === directory &&
        entry?.schedule?.interval === "weekly",
    );
    if (!configured) errors.push(`Dependabot is missing ${label} updates`);
  }
  return errors;
}

export function isForbiddenProductionJavaScriptPath(path) {
  return (
    path.startsWith("src/") &&
    /\.(?:js|jsx|mjs|cjs)$/.test(path) &&
    !/\.(?:test|spec)\.(?:js|jsx|mjs|cjs)$/.test(path)
  );
}

function trackedProductionFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "src", "src-tauri/src"],
    { cwd: root, encoding: "utf8" },
  );
  return output.trim().split("\n").filter(Boolean).filter(isProductionModule);
}

function repositorySourceFiles(root) {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "src",
      "src-tauri/src",
      "src-tauri/tests",
      "e2e",
      "scripts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  return output.trim().split("\n").filter(Boolean);
}

export function compareArchitectureBudgets(current, base) {
  const errors = [];
  for (const [path, previous] of Object.entries(base.hotSpots ?? {})) {
    const snapshot = current.hotSpots?.[path];
    if (!snapshot) {
      errors.push(`hotspot budget was removed instead of retired explicitly: ${path}`);
    } else if (snapshot.maxLines > previous.maxLines) {
      errors.push(
        `${path} budget increased from ${previous.maxLines} to ${snapshot.maxLines}; budgets may only decrease`,
      );
    } else if (
      typeof previous.targetLines === "number" &&
      (typeof snapshot.targetLines !== "number" || snapshot.targetLines > previous.targetLines)
    ) {
      errors.push(
        `${path} target increased from ${previous.targetLines} to ${snapshot.targetLines ?? "missing"}; targets may only decrease`,
      );
    }
  }
  for (const path of Object.keys(current.hotSpots ?? {}).filter(
    (path) => !Object.hasOwn(base.hotSpots ?? {}, path),
  )) {
    errors.push(
      `new hotspot budgets are forbidden; keep new modules within 800 lines: ${path}`,
    );
  }
  for (const metric of ["maxTotalBytes", "maxJavaScriptChunkBytes"]) {
    const previous = base.bundle?.[metric];
    const snapshot = current.bundle?.[metric];
    if (typeof previous === "number" && (typeof snapshot !== "number" || snapshot > previous)) {
      errors.push(
        `bundle ${metric} increased from ${previous} to ${snapshot ?? "missing"}; budgets may only decrease`,
      );
    }
  }
  return errors;
}

export function loadTrackedArchitectureBudgetAtBase({ tracked, readContents, label }) {
  if (!tracked) return undefined;
  let contents;
  try {
    contents = readContents();
  } catch (error) {
    throw new Error(`cannot read tracked ${label}`, { cause: error });
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`tracked ${label} is invalid JSON`, { cause: error });
  }
}

function compareBudgetToBase(root, budget, baseRef) {
  if (!baseRef) return [];
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  const tracked =
    execFileSync(
      "git",
      ["ls-tree", "--name-only", baseRef, "--", ARCHITECTURE_BUDGET_PATH],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ).trim() === ARCHITECTURE_BUDGET_PATH;
  const base = loadTrackedArchitectureBudgetAtBase({
    tracked,
    readContents: () =>
      execFileSync("git", ["show", `${baseRef}:${ARCHITECTURE_BUDGET_PATH}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    label: `${baseRef}:${ARCHITECTURE_BUDGET_PATH}`,
  });
  if (!base) return [];

  return compareArchitectureBudgets(budget, base);
}

function assertNoErrors(label, errors) {
  if (errors.length === 0) {
    console.log(`PASS ${label}`);
    return;
  }
  console.error(`FAIL ${label}`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

export function checkVersions(root = REPOSITORY_ROOT) {
  const packageJson = readJson(join(root, "package.json"));
  const packageLock = readJson(join(root, "package-lock.json"));
  const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  const tauriConfig = readJson(join(root, "src-tauri/tauri.conf.json"));
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];

  return validateVersions({
    packageVersion: packageJson.version,
    lockRootVersion: packageLock.version,
    cargoVersion,
    cargoLockVersion: readCargoPackageVersion(cargoLock, "skill-repo-tracker"),
    tauriVersion: tauriConfig.version,
  });
}

export function checkBoundaries(root = REPOSITORY_ROOT) {
  const trackedFiles = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  const packageJson = readJson(join(root, "package.json"));
  const tsconfig = readJson(join(root, "tsconfig.json"));
  const lockContents = readFileSync(join(root, "package-lock.json"), "utf8");
  const errors = checkRepositoryBoundaries({
    trackedFiles,
    packageJson,
    lockUrls: collectLockUrls(lockContents),
  });
  errors.push(
    ...validateRuntimeToolchain({
      nodeVersion: process.version,
      npmVersion: execFileSync("npm", ["--version"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    }),
  );
  errors.push(
    ...compareCommandInventories({
      frontend: extractFrontendCommands(readFileSync(join(root, "src/api.ts"), "utf8")),
      rust: extractRustCommands(readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8")),
    }),
  );
  if (packageJson.engines?.node !== "22.x" || packageJson.engines?.npm !== "10.9.8") {
    errors.push("package engines must pin Node 22.x and npm 10.9.8");
  }
  if (packageJson.packageManager !== "npm@10.9.8") {
    errors.push("packageManager must be npm@10.9.8");
  }
  if (tsconfig.compilerOptions?.allowJs !== false) {
    errors.push("tsconfig compilerOptions.allowJs must be false; production JavaScript is forbidden");
  }
  if (tsconfig.compilerOptions?.baseUrl != null || tsconfig.compilerOptions?.paths != null) {
    errors.push(
      "tsconfig baseUrl/paths aliases are forbidden; repository-relative module paths keep the governed graph auditable",
    );
  }
  if (readFileSync(join(root, ".node-version"), "utf8").trim() !== "22.23.1") {
    errors.push(".node-version must be 22.23.1");
  }
  if (readFileSync(join(root, ".nvmrc"), "utf8").trim() !== "22.23.1") {
    errors.push(".nvmrc must be 22.23.1");
  }
  const rustToolchain = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
  if (!/^channel = "1\.95\.0"$/m.test(rustToolchain)) {
    errors.push("rust-toolchain.toml must pin Rust 1.95.0");
  }
  const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  if (!/^rust-version = "1\.88\.0"$/m.test(cargoToml)) {
    errors.push("src-tauri/Cargo.toml rust-version must declare MSRV 1.88.0");
  }
  const sourceFiles = repositorySourceFiles(root);
  for (const path of sourceFiles) {
    const contents = readFileSync(join(root, path), "utf8");
    if (isForbiddenProductionJavaScriptPath(path)) {
      errors.push(
        `${path} is production JavaScript; use strict TypeScript so architecture and coverage gates apply`,
      );
    }
    if (isProductionModule(path) && /\.(?:[cm]?ts|tsx)$/.test(path)) {
      errors.push(...findExplicitAny(path, contents));
      errors.push(...findProductionTestImports(path, contents));
      errors.push(...findFrontendImportEscapes(path, contents));
      errors.push(...findFrontendModuleGraphHazards(path, contents));
      errors.push(...findForbiddenFrontendRuntimeUsage(path, contents));
    }
    if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(path)) {
      errors.push(...findForbiddenTestModifiers(path, contents));
    }
    if (path.endsWith(".rs")) {
      errors.push(...findForbiddenRustIgnores(path, contents));
      errors.push(...findForbiddenClippySuppressions(path, contents));
      errors.push(...findForbiddenRustTestCfg(path, contents));
      errors.push(...findForbiddenGithubTransportUsage(path, contents));
      if (isProductionModule(path)) {
        errors.push(...findRustTestModulesVisibleInProduction(path, contents));
        errors.push(...findForbiddenRustIncludes(path, contents));
      }
    }
  }
  const viteConfigPaths = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.cts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
  ].filter((path) => existsSync(join(root, path)));
  for (const viteConfigPath of viteConfigPaths) {
    errors.push(
      ...findForbiddenFrontendAliases(
        viteConfigPath,
        readFileSync(join(root, viteConfigPath), "utf8"),
      ),
    );
  }
  const htmlEntryPath = join(root, "index.html");
  if (existsSync(htmlEntryPath)) {
    errors.push(...findHtmlModuleEntryHazards("index.html", readFileSync(htmlEntryPath, "utf8")));
  }
  const actionPolicyFiles = [];
  const collectActionYaml = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collectActionYaml(path);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) actionPolicyFiles.push(path);
    }
  };
  collectActionYaml(join(root, ".github/workflows"));
  collectActionYaml(join(root, ".github/actions"));
  const workflowPaths = actionPolicyFiles.map((path) => relative(root, path));
  const dependabotPath = join(root, ".github/dependabot.yml");
  errors.push(
    ...validateRepositoryAutomationPolicy({
      workflowPaths,
      dependabotContents: existsSync(dependabotPath)
        ? readFileSync(dependabotPath, "utf8")
        : undefined,
    }),
  );
  for (const path of actionPolicyFiles) {
    const label = relative(root, path);
    const contents = readFileSync(path, "utf8");
    errors.push(...findUnpinnedWorkflowUses(label, contents));
    switch (label) {
      case ".github/workflows/ci.yml":
        errors.push(...validateCiWorkflowPolicy(contents));
        break;
      case ".github/workflows/release-gate.yml":
        errors.push(...validateReleaseWorkflowPolicy(contents));
        break;
      case ".github/workflows/security-audit.yml":
        errors.push(...validateSecurityAuditWorkflowPolicy(contents));
        break;
      case ".github/workflows/weekly-resilience.yml":
        errors.push(...validateWeeklyResilienceWorkflowPolicy(contents));
        break;
    }
  }
  return errors;
}

export function checkArchitecture(root = REPOSITORY_ROOT) {
  const budgetPath = join(root, ARCHITECTURE_BUDGET_PATH);
  const budget = readJson(budgetPath);
  const files = Object.fromEntries(
    trackedProductionFiles(root).map((path) => [path, countLines(join(root, path))]),
  );
  const errors = checkArchitectureSnapshot({ files, budget });
  for (const [path, hotSpot] of Object.entries(budget.hotSpots)) {
    if (hotSpot.maxLines > 1000) {
      if (!hotSpot.adr || !existsSync(join(root, hotSpot.adr))) {
        errors.push(`${path} exceeds 1000 lines but has no existing ADR exception`);
      }
    }
  }
  errors.push(
    ...compareBudgetToBase(root, budget, process.env.ARCHITECTURE_BASE_REF),
  );
  return errors;
}

export function checkBundle(root = REPOSITORY_ROOT) {
  const budget = readJson(join(root, "docs/engineering/architecture-budget.json")).bundle;
  const dist = join(root, "dist");
  if (!existsSync(dist)) return ["dist does not exist; run the Vite build before bundle budget"];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(dist);
  const totalBytes = files.reduce((sum, path) => sum + statSync(path).size, 0);
  const errors = [];
  if (totalBytes > budget.maxTotalBytes) {
    errors.push(`dist is ${totalBytes} bytes; total budget is ${budget.maxTotalBytes}`);
  }
  for (const path of files.filter((candidate) => candidate.endsWith(".js"))) {
    const bytes = statSync(path).size;
    if (bytes > budget.maxJavaScriptChunkBytes) {
      errors.push(
        `${relative(root, path)} is ${bytes} bytes; JavaScript chunk budget is ${budget.maxJavaScriptChunkBytes}`,
      );
    }
  }
  return errors;
}

async function main() {
  const command = process.argv[2] ?? "all";
  const checks = {
    versions: ["version consistency", () => checkVersions()],
    boundaries: ["repository boundaries", () => checkBoundaries()],
    architecture: ["architecture budget", () => checkArchitecture()],
    bundle: ["bundle budget", () => checkBundle()],
  };
  const selected = command === "all" ? ["versions", "boundaries", "architecture"] : [command];
  for (const key of selected) {
    if (!checks[key]) throw new Error(`unknown governance check: ${key}`);
    const [label, check] = checks[key];
    assertNoErrors(label, check());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
