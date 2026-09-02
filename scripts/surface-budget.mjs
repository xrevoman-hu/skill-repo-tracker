import { readFileSync } from "node:fs";
import path from "node:path";

import { discoverCargoDependencySurface } from "./surface-budget-cargo.mjs";
import { discoverEntitlementSurface } from "./surface-budget-entitlements.mjs";
import { discoverKeychainSurface } from "./surface-budget-keychain.mjs";
import { discoverRuntimeInputSurface } from "./surface-budget-runtime-inputs.mjs";
import { discoverRustExecutionSurface } from "./surface-budget-rust.mjs";
import {
  discoverCapabilitySurface,
  discoverTauriSecuritySurface,
} from "./surface-budget-tauri.mjs";
import { discoverFrontendTimerSurface } from "./surface-budget-typescript.mjs";

export const SURFACE_CATEGORIES = [
  "settingsFields",
  "tauriCommands",
  "capabilityPermissions",
  "tauriSecurityConfig",
  "entitlementKeys",
  "cspDirectives",
  "externalHosts",
  "rustDependencies",
  "rustTaskSites",
  "rustPathSites",
  "keychainEntries",
  "runtimeInputs",
  "tauriPlugins",
  "recurringTimers",
  "timerCalls",
];

function camelCase(snakeCase) {
  return snakeCase.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase());
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function findMatchingDelimiter(source, openingIndex, opening, closing) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === opening) depth += 1;
    else if (source[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) break;
    }
  }
  return -1;
}

function maskRustNonCode(source, { maskStrings = true } = {}) {
  const output = [...source];
  const blank = (index) => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      const stop = end < 0 ? source.length : end;
      while (index < stop) blank(index++);
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
        } else {
          blank(index++);
        }
      }
      if (depth !== 0) throw new Error("Rust source contains an unterminated block comment");
      continue;
    }
    const raw = source.slice(index).match(/^(?:(?:b|c)?r)(#+)?"/);
    if (raw) {
      const hashes = raw[1] ?? "";
      const terminator = `"${hashes}`;
      let end = source.indexOf(terminator, index + raw[0].length);
      if (end < 0) throw new Error("Rust source contains an unterminated raw string");
      end += terminator.length;
      while (index < end) {
        if (maskStrings) blank(index);
        index += 1;
      }
      continue;
    }
    const byteOrStringPrefix =
      source[index] === '"'
        ? 0
        : ["b", "c"].includes(source[index]) && source[index + 1] === '"'
          ? 1
          : -1;
    if (byteOrStringPrefix >= 0) {
      const quote = index + byteOrStringPrefix;
      let end = quote + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end] === '"') {
          end += 1;
          break;
        } else end += 1;
      }
      if (end > source.length || source[end - 1] !== '"') {
        throw new Error("Rust source contains an unterminated string");
      }
      while (index < end) {
        if (maskStrings) blank(index);
        index += 1;
      }
      continue;
    }
    const character = source.slice(index).match(/^(?:b)?'(?:\\.|[^'\\\r\n])'/);
    if (character) {
      const end = index + character[0].length;
      while (index < end) {
        if (maskStrings) blank(index);
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function hasConditionalRustAttribute(maskedSource, declarationIndex) {
  const previousBoundary = Math.max(
    maskedSource.lastIndexOf("}", declarationIndex - 1),
    maskedSource.lastIndexOf(";", declarationIndex - 1),
  );
  const prefix = maskedSource.slice(previousBoundary + 1, declarationIndex);
  return /#\s*\[\s*cfg(?:_attr)?\b[\s\S]*\]\s*$/.test(prefix);
}

function hasConditionalRustContext(maskedSource, declarationIndex) {
  if (hasConditionalRustAttribute(maskedSource, declarationIndex)) return true;
  const openBraces = [];
  for (let index = 0; index < declarationIndex; index += 1) {
    if (maskedSource[index] === "{") openBraces.push(index);
    else if (maskedSource[index] === "}") openBraces.pop();
  }
  return openBraces.some((openingBrace) => {
    const previousBoundary = Math.max(
      maskedSource.lastIndexOf("}", openingBrace - 1),
      maskedSource.lastIndexOf(";", openingBrace - 1),
    );
    return /#\s*\[\s*cfg(?:_attr)?\b[\s\S]*\]/.test(
      maskedSource.slice(previousBoundary + 1, openingBrace),
    );
  });
}

function rustStructFields(source, structName) {
  const masked = maskRustNonCode(source);
  const expression = new RegExp(
    `(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${structName}\\s*\\{`,
    "g",
  );
  const matches = [...masked.matchAll(expression)];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one unconditional Rust struct ${structName}; found ${matches.length}`,
    );
  }
  const match = matches[0];
  if (hasConditionalRustContext(masked, match.index)) {
    throw new Error(`Rust struct ${structName} must not be cfg-conditional`);
  }
  const openingBrace = masked.indexOf("{", match.index);
  const closingBrace = findMatchingDelimiter(masked, openingBrace, "{", "}");
  if (closingBrace < 0) throw new Error(`Rust struct ${structName} has unbalanced braces`);
  const body = masked.slice(openingBrace + 1, closingBrace);
  return [...body.matchAll(/(?:^|,)\s*(?:pub(?:\([^)]*\))?\s+)?([a-z][a-z0-9_]*)\s*:/g)].map(
    ([, field]) => `${structName}.${camelCase(field)}`,
  );
}

function tauriCommands(source) {
  const masked = maskRustNonCode(source);
  const candidates = [...masked.matchAll(/tauri::generate_handler!\s*\[/g)];
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one unconditional tauri::generate_handler registry; found ${candidates.length}`,
    );
  }
  const candidate = candidates[0];
  if (hasConditionalRustContext(masked, candidate.index)) {
    throw new Error("tauri::generate_handler registry must not be cfg-conditional");
  }
  const invokeHandlerTokens = [...masked.matchAll(/\binvoke_handler\b/g)];
  const invokeHandlerCalls = [...masked.matchAll(/\.\s*invoke_handler\s*\(/g)];
  if (invokeHandlerTokens.length !== 1 || invokeHandlerCalls.length !== 1) {
    throw new Error(
      `expected exactly one direct Builder.invoke_handler call; found ${invokeHandlerTokens.length} token(s) and ${invokeHandlerCalls.length} method call(s)`,
    );
  }
  const invoke = invokeHandlerCalls[0];
  if (hasConditionalRustContext(masked, invoke.index)) {
    throw new Error("Builder.invoke_handler must not be cfg-conditional");
  }
  const openingParenthesis = masked.indexOf("(", invoke.index);
  const closingParenthesis = findMatchingDelimiter(masked, openingParenthesis, "(", ")");
  if (closingParenthesis < 0) throw new Error("Builder.invoke_handler call is unbalanced");
  const openingBracket = masked.indexOf("[", candidate.index);
  const closingBracket = findMatchingDelimiter(masked, openingBracket, "[", "]");
  if (closingBracket < 0) throw new Error("tauri::generate_handler registry is unbalanced");
  if (
    candidate.index < openingParenthesis ||
    closingBracket > closingParenthesis ||
    masked.slice(openingParenthesis + 1, candidate.index).trim() ||
    masked.slice(closingBracket + 1, closingParenthesis).trim()
  ) {
    throw new Error(
      "tauri::generate_handler must be the sole direct Builder.invoke_handler argument",
    );
  }
  const commands = masked
    .slice(openingBracket + 1, closingBracket)
    .split(",")
    .map((command) => command.trim())
    .filter(Boolean);
  for (const command of commands) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/.test(command)) {
      throw new Error(`tauri::generate_handler contains a non-static command: ${command}`);
    }
  }
  return commands;
}

function singleRustImplBody(masked, traitName, typeName) {
  const candidates = [
    ...masked.matchAll(
      new RegExp(`\\bimpl\\s+${traitName}\\s+for\\s+${typeName}\\s*\\{`, "g"),
    ),
  ];
  if (candidates.length !== 1 || hasConditionalRustContext(masked, candidates[0]?.index ?? 0)) {
    throw new Error(`expected exactly one unconditional impl ${traitName} for ${typeName}`);
  }
  const openingBrace = masked.indexOf("{", candidates[0].index);
  const closingBrace = findMatchingDelimiter(masked, openingBrace, "{", "}");
  if (closingBrace < 0) throw new Error(`impl ${traitName} for ${typeName} is unbalanced`);
  return masked.slice(openingBrace + 1, closingBrace);
}

function cspDirectives(csp) {
  if (typeof csp !== "string" || !csp.trim()) {
    throw new Error("tauri.conf.json must define a non-empty app.security.csp");
  }
  const entries = [];
  for (const rawDirective of csp.split(";")) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [directive, ...values] = tokens;
    if (values.length === 0) entries.push(directive);
    for (const value of values) entries.push(`${directive} ${value}`);
  }
  return entries;
}

function externalGithubHosts(source) {
  const masked = maskRustNonCode(source);
  const requestCandidates = [...masked.matchAll(/\bfn\s+github_request_allowed\s*\(/g)];
  const redirectCandidates = [...masked.matchAll(/\bfn\s+github_redirect_allowed\s*\(/g)];
  if (requestCandidates.length !== 1 || redirectCandidates.length !== 1) {
    throw new Error(
      `expected exactly one GitHub request and redirect allowlist function; found ${requestCandidates.length}/${redirectCandidates.length}`,
    );
  }
  if (
    hasConditionalRustContext(masked, requestCandidates[0].index) ||
    hasConditionalRustContext(masked, redirectCandidates[0].index)
  ) {
    throw new Error("GitHub host allowlist functions must not be cfg-conditional");
  }
  const openingBrace = masked.indexOf("{", requestCandidates[0].index);
  const closingBrace = findMatchingDelimiter(masked, openingBrace, "{", "}");
  if (openingBrace < 0 || closingBrace < 0) {
    throw new Error("GitHub request host allowlist has unbalanced braces");
  }
  const policy = source.slice(requestCandidates[0].index, closingBrace + 1);
  const policyWithoutComments = maskRustNonCode(policy, { maskStrings: false });
  const policyOpeningBrace = policyWithoutComments.indexOf("{");
  const policyClosingBrace = policyWithoutComments.lastIndexOf("}");
  const expression = policyWithoutComments
    .slice(policyOpeningBrace + 1, policyClosingBrace)
    .replace(/\s+/g, "");
  if (
    policyOpeningBrace < 0 ||
    policyClosingBrace < policyOpeningBrace ||
    !/^url\.scheme\(\)=="https"&&matches!\(url\.host_str\(\),Some\("[a-z0-9.-]+\.[a-z0-9.-]+"(?:\|"[a-z0-9.-]+\.[a-z0-9.-]+")*\)\)$/i.test(
      expression,
    )
  ) {
    throw new Error("GitHub request host allowlist must remain a static exact match");
  }
  const hosts = [...policyWithoutComments.matchAll(/"([a-z0-9.-]+\.[a-z0-9.-]+)"/gi)].map(
    ([, host]) => `https://${host}`,
  );
  if (hosts.length === 0) throw new Error("GitHub request host allowlist is empty or dynamic");

  const redirectAllowlistOpeningBrace = masked.indexOf("{", redirectCandidates[0].index);
  const redirectFunctionClosingBrace = findMatchingDelimiter(
    masked,
    redirectAllowlistOpeningBrace,
    "{",
    "}",
  );
  if (redirectAllowlistOpeningBrace < 0 || redirectFunctionClosingBrace < 0) {
    throw new Error("GitHub redirect host allowlist has unbalanced braces");
  }
  const redirectFunctionExpression = masked
    .slice(redirectAllowlistOpeningBrace + 1, redirectFunctionClosingBrace)
    .replace(/\s+/g, "");
  if (
    redirectFunctionExpression !==
    "previous_redirects<MAX_GITHUB_REDIRECTS&&github_request_allowed(url)"
  ) {
    throw new Error(
      "GitHub redirect host allowlist must enforce the static host policy and redirect limit",
    );
  }

  const defaultImplBody = singleRustImplBody(masked, "Default", "ReqwestGithubHttpAdapter");
  const adapterImplBody = singleRustImplBody(
    masked,
    "GithubHttpAdapter",
    "ReqwestGithubHttpAdapter",
  );
  const clientBuilders = [
    ...masked.matchAll(/\breqwest::Client::(?:new|builder)\s*\(/g),
  ];
  const rawExecuteSites = [...masked.matchAll(/\bself\.0\.execute\s*\(\s*request\s*\)/g)];
  const redirectPolicies = [
    ...masked.matchAll(
      /\breqwest::redirect::Policy::custom\s*\(\s*\|\s*attempt\s*\|\s*\{/g,
    ),
  ];
  if (redirectPolicies.length !== 1) {
    throw new Error(`GitHub transport must define exactly one redirect policy; found ${redirectPolicies.length}`);
  }
  const redirectOpeningBrace = masked.indexOf("{", redirectPolicies[0].index);
  const redirectClosingBrace = findMatchingDelimiter(masked, redirectOpeningBrace, "{", "}");
  const redirectBody = masked
    .slice(redirectOpeningBrace + 1, redirectClosingBrace)
    .replace(/\s+/g, "");
  const redirectCalls = [...masked.matchAll(/\bredirect\s*\(/g)];
  const redirectTokens = [...masked.matchAll(/\bredirect\b/g)];
  const redirectBindingPrefix = masked.slice(
    Math.max(
      masked.lastIndexOf(";", redirectPolicies[0].index - 1),
      masked.lastIndexOf("}", redirectPolicies[0].index - 1),
    ) + 1,
    redirectPolicies[0].index,
  );
  const expectedRedirectBody =
    "letprevious_redirects=attempt.previous().len().saturating_sub(1);" +
    "ifgithub_redirect_allowed(attempt.url(),previous_redirects){attempt.follow()}" +
    "else{attempt.error()}";
  const expectedDefaultImpl =
    "fndefault()->Self{" +
    "letredirect=reqwest::redirect::Policy::custom(|attempt|{" +
    expectedRedirectBody +
    "});" +
    "letclient=reqwest::Client::builder()" +
    ".no_proxy()" +
    ".redirect(redirect)" +
    ".connect_timeout(GITHUB_CONNECT_TIMEOUT)" +
    ".timeout(GITHUB_REQUEST_TIMEOUT)" +
    ".https_only(true)" +
    ".build().expect();" +
    "Self(client)}";
  if (
    redirectClosingBrace < 0 ||
    redirectBody !== expectedRedirectBody ||
    redirectCalls.length !== 1 ||
    redirectTokens.length !== 4 ||
    !/let\s+redirect\s*=\s*$/.test(redirectBindingPrefix) ||
    !/\.\s*redirect\s*\(\s*redirect\s*\)/.test(masked) ||
    defaultImplBody.replace(/\s+/g, "") !== expectedDefaultImpl ||
    (defaultImplBody.match(/\bgithub_redirect_allowed\b/g) ?? []).length !== 1 ||
    (adapterImplBody.match(/\bgithub_request_allowed\b/g) ?? []).length !== 1 ||
    clientBuilders.length !== 1 ||
    clientBuilders[0][0] !== "reqwest::Client::builder(" ||
    rawExecuteSites.length !== 1 ||
    !/if\s*!\s*github_request_allowed\s*\(\s*request\.url\s*\(\s*\)\s*\)/.test(masked) ||
    !/github_redirect_allowed\s*\(\s*attempt\.url\s*\(\s*\)\s*,\s*previous_redirects\s*\)/.test(masked) ||
    /\breqwest::(?:(?:blocking|r#blocking)::)?get\s*\(|\.send\s*\(/.test(masked)
  ) {
    throw new Error(
      "GitHub transport must remain the single hardened ReqwestGithubHttpAdapter",
    );
  }
  return hosts;
}

export function discoverRepositorySurface(root) {
  const rustLib = readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  const appSource = readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const tauriConfig = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const frontendTimers = discoverFrontendTimerSurface(root);
  const rustExecution = discoverRustExecutionSurface(root);
  const capabilityPermissions = uniqueSorted(discoverCapabilitySurface(root));
  if (/\.\s*onCloseRequested\s*\(/.test(appSource)) {
    const prefix = "src-tauri/capabilities/default.json#default:permission=";
    const requiredClosePermissions = [
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      "core:window:allow-destroy",
    ];
    for (const permission of requiredClosePermissions) {
      if (!capabilityPermissions.includes(`${prefix}${permission}`)) {
        throw new Error(
          `Tauri onCloseRequested requires the reviewed main-window capability: ${permission}`,
        );
      }
    }
  }
  return {
    settingsFields: uniqueSorted([
      ...rustStructFields(rustLib, "AppSettings"),
      ...rustStructFields(rustLib, "UpdateSettingsRequest"),
    ]),
    tauriCommands: uniqueSorted(tauriCommands(rustLib)),
    capabilityPermissions,
    tauriSecurityConfig: uniqueSorted(discoverTauriSecuritySurface(tauriConfig)),
    entitlementKeys: uniqueSorted(
      discoverEntitlementSurface(path.join(root, "src-tauri/entitlements.plist")),
    ),
    cspDirectives: uniqueSorted(cspDirectives(tauriConfig?.app?.security?.csp)),
    externalHosts: uniqueSorted(
      externalGithubHosts(readFileSync(path.join(root, "src-tauri/src/adapters.rs"), "utf8")),
    ),
    rustDependencies: discoverCargoDependencySurface(root),
    rustTaskSites: rustExecution.rustTaskSites,
    rustPathSites: rustExecution.rustPathSites,
    keychainEntries: discoverKeychainSurface(root),
    runtimeInputs: discoverRuntimeInputSurface(root),
    tauriPlugins: rustExecution.tauriPlugins,
    recurringTimers: uniqueSorted(frontendTimers.recurringTimers),
    timerCalls: uniqueSorted(frontendTimers.timerCalls),
  };
}

export function checkRepositorySurfaceBudget(root, { baseBudget = null } = {}) {
  let budget;
  try {
    budget = JSON.parse(
      readFileSync(path.join(root, "docs/engineering/surface-budget.json"), "utf8"),
    );
  } catch (error) {
    return [`surface budget could not be read: ${error.message}`];
  }
  let actual;
  try {
    actual = discoverRepositorySurface(root);
  } catch (error) {
    return [`production surface discovery failed: ${error.message}`];
  }
  return [
    ...validateSurfaceBudget({ budget, actual }),
    ...compareSurfaceBudgets(budget, baseBudget),
  ];
}

export function compareSurfaceBudgets(current, base) {
  if (!base) return [];
  const errors = [];
  for (const category of SURFACE_CATEGORIES) {
    const currentById = new Map(
      (current?.categories?.[category] ?? []).map((entry) => [entry.id, entry]),
    );
    for (const previous of base?.categories?.[category] ?? []) {
      const entry = currentById.get(previous.id);
      if (previous.status === "active" && !entry) {
        errors.push(
          `active ${category} surface was removed without first being marked retiring: ${previous.id}`,
        );
      } else if (previous.status === "active" && entry?.purpose !== previous.purpose) {
        errors.push(`active ${category} surface purpose changed in place: ${previous.id}`);
      } else if (previous.status === "retiring" && entry?.status === "active") {
        errors.push(`retiring ${category} surface cannot return to active: ${previous.id}`);
      } else if (
        previous.status === "retiring" &&
        entry &&
        entry.purpose !== previous.purpose
      ) {
        errors.push(`retiring ${category} surface purpose changed in place: ${previous.id}`);
      } else if (
        previous.status === "retiring" &&
        entry &&
        entry.retirementReason !== previous.retirementReason
      ) {
        errors.push(`retiring ${category} surface retirementReason changed in place: ${previous.id}`);
      }
    }
    const baseIds = new Set(
      (base?.categories?.[category] ?? []).map((entry) => entry.id),
    );
    for (const entry of current?.categories?.[category] ?? []) {
      if (!baseIds.has(entry.id) && entry.status !== "active") {
        errors.push(`new ${category} surface must start active: ${entry.id}`);
      }
    }
  }
  return errors;
}

export function validateSurfaceBudget({ budget, actual }) {
  const errors = [];
  if (budget?.schemaVersion !== 1) {
    errors.push(
      `surface budget schemaVersion must be 1; found ${budget?.schemaVersion ?? "missing"}`,
    );
  }
  const categories = budget?.categories;
  for (const category of SURFACE_CATEGORIES) {
    if (!Array.isArray(categories?.[category])) {
      errors.push(`surface budget category must be an array: ${category}`);
    }
  }
  for (const category of Object.keys(categories ?? {})) {
    if (!SURFACE_CATEGORIES.includes(category)) {
      errors.push(`unknown surface budget category: ${category}`);
    }
  }
  for (const category of SURFACE_CATEGORIES) {
    const entries = Array.isArray(categories?.[category]) ? categories[category] : [];
    const registered = new Set();
    const discovered = new Set(actual?.[category] ?? []);
    for (const entry of entries) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id) {
        errors.push(`${category} surface requires a non-empty id`);
        continue;
      }
      if (registered.has(id)) errors.push(`duplicate ${category} surface: ${id}`);
      registered.add(id);
      if (!["active", "retiring"].includes(entry.status)) {
        errors.push(`${category} surface ${id} has invalid status: ${entry.status ?? "missing"}`);
        continue;
      }
      if (!entry.purpose?.trim()) {
        errors.push(`${entry.status} ${category} surface ${id} requires purpose`);
      }
      if (entry.status === "retiring" && !entry.retirementReason?.trim()) {
        errors.push(`retiring ${category} surface ${id} requires retirementReason`);
      }
      if (entry.status === "active" && !discovered.has(id)) {
        errors.push(`active ${category} surface is missing from source: ${id}`);
      }
    }
    for (const id of actual?.[category] ?? []) {
      if (!registered.has(id)) errors.push(`unregistered ${category} surface: ${id}`);
    }
  }
  return errors;
}
