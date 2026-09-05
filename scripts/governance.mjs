#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

import {
  ARCHITECTURE_BUDGET_PATH,
  checkArchitectureSnapshot,
  checkRepositoryProductionCompressionBudget,
  checkRepositoryToolingBudget,
  compareBudgetToBase,
} from "./architecture-budget-checks.mjs";
import { checkBundle } from "./bundle-policy.mjs";
import { frontendImportBoundaryViolation } from "./frontend-import-policy.mjs";
import { checkGovernanceAssets } from "./governance-assets-check.mjs";
import {
  findForbiddenCoveragePragmas,
  findForbiddenFrontendRuntimeUsage,
} from "./frontend-runtime-policy.mjs";
import {
  listRepositoryFiles,
  listTrackedIndexEntries,
} from "./git-paths.mjs";
import { findForbiddenTestModifiers } from "./test-evidence-policy.mjs";
import { checkRepositoryTestWaivers } from "./test-waivers.mjs";
import {
  isAlternateTauriConfigPath,
  validateCargoMetadataPolicy,
  validateCargoTestDiscoveryPolicy,
  validateCiWorkflowPolicy,
  validateIndexHtmlPolicy,
  validatePlaywrightConfigPolicy,
  validateRepositoryAutomationPolicy,
  validateReleaseWorkflowPolicy,
  validateSecurityAuditWorkflowPolicy,
  validateTrustedPolicyWorkflowPolicy,
  validateTypeScriptConfigPolicy,
  validateTauriBuildScriptPolicy,
  validateViteConfigPolicy,
  validateVitestConfigPolicy,
  validateWeeklyResilienceWorkflowPolicy,
} from "./core-policy-contracts.mjs";
import {
  checkRepositoryBoundaries,
  validateFrontendDeclarations,
  validateRuntimeToolchain,
  validateVersions,
} from "./repository-boundaries.mjs";
import {
  isDedicatedRustTestModulePath,
  isRustProductionSourcePath,
} from "./source-classification.mjs";

export {
  isAlternateTauriConfigPath,
  validateCargoMetadataPolicy,
  validateCargoTestDiscoveryPolicy,
  validateCiWorkflowPolicy,
  validateIndexHtmlPolicy,
  validatePlaywrightConfigPolicy,
  validateRepositoryAutomationPolicy,
  validateReleaseWorkflowPolicy,
  validateSecurityAuditWorkflowPolicy,
  validateTrustedPolicyWorkflowPolicy,
  validateTypeScriptConfigPolicy,
  validateTauriBuildScriptPolicy,
  validateViteConfigPolicy,
  validateVitestConfigPolicy,
  validateWeeklyResilienceWorkflowPolicy,
};

export {
  checkRepositoryBoundaries,
  validateCriticalPackageScripts,
  validateRuntimeToolchain,
  validateVersions,
} from "./repository-boundaries.mjs";

export {
  findForbiddenCoveragePragmas,
  findForbiddenFrontendRuntimeUsage,
} from "./frontend-runtime-policy.mjs";

export { findForbiddenTestModifiers } from "./test-evidence-policy.mjs";

export {
  compareArchitectureBudgets,
  checkArchitectureSnapshot,
  loadTrackedArchitectureBudgetAtBase,
} from "./architecture-budget-checks.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
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
    const violation = frontendImportBoundaryViolation(path, specifier);
    if (violation) errors.push(`${path}:${sourceLocation(sourceFile, node)} ${violation}: ${specifier}`);
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
      typeof pathAttribute === "string"
        ? isDedicatedRustTestModulePath(pathAttribute)
        : /^(?:tests?|.*_tests)$/.test(moduleName);
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
    if (/\bcoverage\s*\(\s*off\s*\)/.test(attribute.text)) {
      errors.push(
        `${path}:${attribute.line} disables Rust coverage instrumentation; production coverage exclusions are forbidden`,
      );
    }
    if (/\bfeature\s*\(\s*coverage_attribute\s*\)/.test(attribute.text)) {
      errors.push(
        `${path}:${attribute.line} enables the Rust coverage exclusion attribute; production coverage exclusions are forbidden`,
      );
    }
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
    const attributeCode = maskRustNonCode(attribute.text);
    if (/\b(?:allow|expect)\s*\([\s\S]*?\bwarnings\b/.test(attributeCode)) {
      errors.push(
        `${path}:${attribute.line} suppresses the Rust warnings lint group; -D warnings must remain authoritative`,
      );
      continue;
    }
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
    /\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*->\s*(?:&\s*)?reqwest::(?:(?:blocking|r#blocking)::)?(?:Client|ClientBuilder)\b/.test(
      contents,
    )
  ) {
    errors.push(`${path} exposes the raw GitHub HTTP client`);
  }
  if (
    /\b(?:extern\s+crate|use)\s+(?:::)?reqwest\s+as\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*|\buse\s+(?:::)?reqwest\s*::\s*\{[^}]*\bself\s+as\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*|\buse\s*\{[^}]*?(?:::)?reqwest\s+as\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*/.test(
      contents,
    )
  ) {
    errors.push(`${path} aliases reqwest and can hide raw HTTP usage`);
  }
  if (
    path === "src-tauri/src/adapters.rs" &&
    /\bpub(?:\([^)]*\))?\s+(?:use\s+(?:::)?reqwest\b|type\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*reqwest::(?:(?:blocking|r#blocking)::)?(?:Client|ClientBuilder|RequestBuilder)\b)/.test(
      contents,
    )
  ) {
    errors.push(`${path} re-exports the raw reqwest transport`);
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
  if (![".ts", ".tsx", ".mts", ".cts", ".css", ".rs"].includes(extname(path))) return false;
  if (path.endsWith(".rs")) return isRustProductionSourcePath(path);
  if (/\.(?:test|spec)\.[^.]+$/.test(path)) return false;
  if (/\.d\.(?:[cm]?ts)$/.test(path)) return false;
  if (path.endsWith("src/testSetup.ts")) return false;
  return path.startsWith("src/");
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

export function isForbiddenProductionJavaScriptPath(path) {
  return (
    path.startsWith("src/") &&
    /\.(?:js|jsx|mjs|cjs)$/.test(path) &&
    !/\.(?:test|spec)\.(?:js|jsx|mjs|cjs)$/.test(path)
  );
}

function trackedProductionFiles(root) {
  return listRepositoryFiles(root, ["src", "src-tauri/src"]).filter(isProductionModule);
}

function repositorySourceFiles(root) {
  return listRepositoryFiles(root, [
    "src",
    "src-tauri/src",
    "src-tauri/tests",
    "e2e",
    "scripts",
  ]);
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
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    lockRootName: packageLock.name,
    lockRootVersion: packageLock.version,
    lockPackageName: packageLock.packages?.[""]?.name,
    lockPackageVersion: packageLock.packages?.[""]?.version,
    cargoVersion,
    cargoLockVersion: readCargoPackageVersion(cargoLock, "skill-repo-tracker"),
    tauriVersion: tauriConfig.version,
  });
}

export function checkBoundaries(root = REPOSITORY_ROOT) {
  const trackedEntries = listTrackedIndexEntries(root);
  const trackedFiles = trackedEntries.map((entry) => entry.path);
  const repositoryFiles = listRepositoryFiles(root);
  const packageJson = readJson(join(root, "package.json"));
  const packageLock = readJson(join(root, "package-lock.json"));
  const tsconfig = readJson(join(root, "tsconfig.json"));
  const lockContents = readFileSync(join(root, "package-lock.json"), "utf8");
  const errors = checkRepositoryBoundaries({
    trackedFiles,
    trackedEntries,
    repositoryFiles,
    packageJson,
    lockUrls: collectLockUrls(lockContents),
    lockPackages: packageLock.packages,
  });
  errors.push(...validateFrontendDeclarations(new Map(
    repositoryFiles.filter((path) => /^src\/.*\.d\.(?:ts|mts|cts)$/.test(path))
      .map((path) => [path, readFileSync(join(root, path))]),
  )));
  errors.push(...validateTypeScriptConfigPolicy(tsconfig));
  errors.push(
    ...validateVitestConfigPolicy(
      readFileSync(join(root, "vitest.config.ts"), "utf8"),
    ),
  );
  errors.push(
    ...validateViteConfigPolicy(readFileSync(join(root, "vite.config.mjs"), "utf8")),
  );
  errors.push(
    ...validatePlaywrightConfigPolicy(
      readFileSync(join(root, "playwright.config.ts"), "utf8"),
    ),
  );
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
  errors.push(...validateCargoTestDiscoveryPolicy(cargoToml));
  const hasRepositoryCargoOverride = trackedFiles.some(
    (path) => path === ".cargo" || path.startsWith(".cargo/"),
  );
  if (!hasRepositoryCargoOverride) {
    try {
      const metadata = JSON.parse(
        execFileSync(
          existsSync(join(homedir(), ".cargo", "bin", "cargo"))
            ? join(homedir(), ".cargo", "bin", "cargo")
            : "cargo",
          [
            "metadata",
            "--locked",
            "--offline",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
            "src-tauri/Cargo.toml",
          ],
          { cwd: root, encoding: "utf8" },
        ),
      );
      errors.push(...validateCargoMetadataPolicy(metadata, root));
    } catch (error) {
      errors.push(
        `Cargo metadata contract could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  errors.push(
    ...validateTauriBuildScriptPolicy(
      readFileSync(join(root, "src-tauri/build.rs"), "utf8"),
    ),
  );
  const sourceFiles = repositorySourceFiles(root);
  const frontendSources = new Map(sourceFiles.filter(path => path.startsWith("src/") && isProductionModule(path))
    .map(path => [path, readFileSync(join(root, path), "utf8")]));
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
      errors.push(...findForbiddenCoveragePragmas(path, contents));
      errors.push(...findForbiddenFrontendRuntimeUsage(path, contents, frontendSources));
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
    const htmlContents = readFileSync(htmlEntryPath, "utf8");
    errors.push(...validateIndexHtmlPolicy(htmlContents));
    errors.push(...findHtmlModuleEntryHazards("index.html", htmlContents));
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
      case ".github/workflows/trusted-policy.yml":
        errors.push(...validateTrustedPolicyWorkflowPolicy(contents));
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
  const catalog = readJson(join(root, "docs/engineering/governance-assets.json"));
  const trackedAdrs = new Set(listRepositoryFiles(root, ["docs/adr"]));
  const validAdrs = new Set(
    (catalog.assets ?? [])
      .filter(
        (asset) =>
          asset.kind === "decision" &&
          asset.status === "active" &&
          trackedAdrs.has(asset.path),
      )
      .map((asset) => asset.path),
  );
  const files = Object.fromEntries(
    trackedProductionFiles(root).map((path) => [path, countLines(join(root, path))]),
  );
  const errors = checkArchitectureSnapshot({ files, budget, validAdrs });
  errors.push(...checkRepositoryProductionCompressionBudget(root, budget));
  errors.push(...checkRepositoryToolingBudget(root, budget.tooling, { validAdrs }));
  errors.push(
    ...compareBudgetToBase(root, budget, process.env.ARCHITECTURE_BASE_REF),
  );
  return errors;
}

async function main() {
  const command = process.argv[2] ?? "all";
  const checks = {
    versions: ["version consistency", () => checkVersions()],
    boundaries: ["repository boundaries", () => checkBoundaries()],
    assets: [
      "governance assets",
      () => [
        ...checkGovernanceAssets(REPOSITORY_ROOT),
        ...checkRepositoryTestWaivers(REPOSITORY_ROOT),
      ],
    ],
    architecture: ["architecture budget", () => checkArchitecture()],
    bundle: ["bundle budget and production artifact policy", () => checkBundle(REPOSITORY_ROOT)],
  };
  const selected =
    command === "all" ? ["versions", "boundaries", "assets", "architecture"] : [command];
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
