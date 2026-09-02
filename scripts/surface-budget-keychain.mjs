import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { isRustProductionSourcePath } from "./source-classification.mjs";

const KEYCHAIN_SURFACE = [
  "service=Skill Repo Tracker;account=github-account-token:github:<slug>",
  "service=Skill Repo Tracker;account=github-token",
];

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
      if (depth !== 0) throw new Error("Keychain Rust source has an unterminated comment");
      continue;
    }
    const raw = source.slice(index).match(/^(?:(?:b|c)?r)(#+)?"/);
    if (raw) {
      const terminator = `"${raw[1] ?? ""}`;
      let end = source.indexOf(terminator, index + raw[0].length);
      if (end < 0) throw new Error("Keychain Rust source has an unterminated raw string");
      end += terminator.length;
      while (index < end) {
        if (maskStrings) blank(index);
        index += 1;
      }
      continue;
    }
    const quote =
      source[index] === '"'
        ? index
        : ["b", "c"].includes(source[index]) && source[index + 1] === '"'
          ? index + 1
          : -1;
    if (quote >= 0) {
      let end = quote + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end] === '"') {
          end += 1;
          break;
        } else end += 1;
      }
      if (source[end - 1] !== '"') {
        throw new Error("Keychain Rust source has an unterminated string");
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

function cfgTestRanges(masked) {
  const ranges = [];
  for (const attribute of masked.matchAll(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g)) {
    let cursor = attribute.index + attribute[0].length;
    while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
    while (masked[cursor] === "#") {
      const bracket = masked.indexOf("[", cursor);
      const closing = findMatchingDelimiter(masked, bracket, "[", "]");
      if (bracket < 0 || closing < 0) {
        throw new Error("Keychain cfg(test) item has an invalid attribute");
      }
      cursor = closing + 1;
      while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
    }
    let roundDepth = 0;
    let squareDepth = 0;
    let end = -1;
    for (let index = cursor; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(") roundDepth += 1;
      else if (character === ")") roundDepth -= 1;
      else if (character === "[") squareDepth += 1;
      else if (character === "]") squareDepth -= 1;
      else if (roundDepth === 0 && squareDepth === 0 && character === "{") {
        end = findMatchingDelimiter(masked, index, "{", "}");
        break;
      } else if (
        roundDepth === 0 &&
        squareDepth === 0 &&
        (character === ";" || character === ",")
      ) {
        end = index;
        break;
      }
    }
    if (end < 0) throw new Error("Keychain cfg(test) item boundary could not be determined");
    ranges.push([attribute.index, end]);
  }
  return ranges;
}

function maskRanges(source, ranges) {
  const output = [...source];
  for (const [start, end] of ranges) {
    for (let index = start; index <= end; index += 1) {
      if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
    }
  }
  return output.join("");
}

function rustViews(source) {
  const structural = maskRustNonCode(source);
  const ranges = cfgTestRanges(structural);
  return {
    structural: maskRanges(structural, ranges),
    literal: maskRanges(maskRustNonCode(source, { maskStrings: false }), ranges),
  };
}

function productionRustFiles(root) {
  const sourceRoot = path.join(root, "src-tauri/src");
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) {
        throw new Error(`${relative} Keychain surface must not be a symbolic link`);
      } else if (entry.isFile() && isRustProductionSourcePath(relative)) files.push(absolute);
    }
  };
  visit(sourceRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function singleFunctionBody(structural, literal, name) {
  const candidates = [
    ...structural.matchAll(new RegExp(`\\bfn\\s+${name}\\s*\\(`, "g")),
  ];
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one canonical Keychain function ${name}`);
  }
  let opening = structural.indexOf("{", candidates[0].index);
  const semicolon = structural.indexOf(";", candidates[0].index);
  if (opening < 0 || (semicolon >= 0 && semicolon < opening)) {
    throw new Error(`canonical Keychain function ${name} must have a body`);
  }
  const closing = findMatchingDelimiter(structural, opening, "{", "}");
  if (closing < 0) throw new Error(`canonical Keychain function ${name} is unbalanced`);
  return literal.slice(opening + 1, closing).replace(/\s+/g, "");
}

function singleImplBody(structural, literal) {
  const candidates = [
    ...structural.matchAll(/\bimpl\s+CredentialStore\s+for\s+SystemKeychain\s*\{/g),
  ];
  if (candidates.length !== 1) {
    throw new Error("expected exactly one canonical Keychain CredentialStore implementation");
  }
  const opening = structural.indexOf("{", candidates[0].index);
  const closing = findMatchingDelimiter(structural, opening, "{", "}");
  if (closing < 0) throw new Error("canonical Keychain CredentialStore implementation is unbalanced");
  return literal.slice(opening + 1, closing).replace(/\s+/g, "");
}

function assertCanonicalLib(structural, literal) {
  const service = [
    ...literal.matchAll(/\bconst\s+TOKEN_SERVICE\s*:\s*&str\s*=\s*"([^"]*)"\s*;/g),
  ];
  const user = [
    ...literal.matchAll(/\bconst\s+TOKEN_USER\s*:\s*&str\s*=\s*"([^"]*)"\s*;/g),
  ];
  if (service.length !== 1 || service[0][1] !== "Skill Repo Tracker") {
    throw new Error("Keychain TOKEN_SERVICE must remain the exact reviewed service");
  }
  if (user.length !== 1 || user[0][1] !== "github-token") {
    throw new Error("Keychain TOKEN_USER must remain the exact reviewed legacy account");
  }
  const keyBody = singleFunctionBody(structural, literal, "github_account_token_key");
  if (keyBody !== 'format!("github-account-token:{account_id}")') {
    throw new Error("Keychain per-account key derivation must remain canonical");
  }
}

function assertCanonicalAdapters(structural, literal) {
  if (/\b(?:pub\s+)?use\b[^;]*\bkeyring\b/.test(structural)) {
    throw new Error("keyring alias or re-export is forbidden");
  }
  if (/\btype\s+[A-Za-z_][A-Za-z0-9_]*[^;=]*=\s*keyring\s*::/.test(structural)) {
    throw new Error("keyring alias or re-export is forbidden");
  }
  if (/(?:^|[^:A-Za-z0-9_])Entry\s*::\s*new\b/.test(structural)) {
    throw new Error("unqualified keyring Entry reference is forbidden");
  }

  const references = [
    ...structural.matchAll(
      /\bkeyring\s*::\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*::\s*([A-Za-z_][A-Za-z0-9_]*))?/g,
    ),
  ];
  for (const reference of references) {
    const [, root, member] = reference;
    if (
      !(
        (root === "Result" && member === undefined) ||
        (root === "Entry" && (member === undefined || member === "new")) ||
        (root === "Error" && member === "NoEntry")
      )
    ) {
      throw new Error(`unreviewed keyring Entry reference: keyring::${root}${member ? `::${member}` : ""}`);
    }
  }

  const constructors = [...structural.matchAll(/\bkeyring\s*::\s*Entry\s*::\s*new\s*\(/g)];
  if (constructors.length !== 1) {
    throw new Error(
      `expected exactly one canonical Keychain Entry seam; found ${constructors.length}`,
    );
  }

  const allowedBody = singleFunctionBody(structural, literal, "keychain_account_allowed");
  const expectedAllowed =
    'key==crate::TOKEN_USER||key.strip_prefix("github-account-token:github:")' +
    ".is_some_and(|account|{!account.is_empty()&&account.bytes().all(|byte|{" +
    "byte.is_ascii_lowercase()||byte.is_ascii_digit()||matches!(byte,b'-'|b'_')})})";
  if (allowedBody !== expectedAllowed) {
    throw new Error("Keychain account namespace validator must remain canonical");
  }

  const entryBody = singleFunctionBody(structural, literal, "system_keychain_entry");
  const expectedEntry =
    'ifservice!=crate::TOKEN_SERVICE{returnErr("unreviewedkeychainservice".to_string());}' +
    'if!keychain_account_allowed(key){returnErr("unreviewedkeychainaccountnamespace".to_string());}' +
    "keyring::Entry::new(crate::TOKEN_SERVICE,key).map_err(|error|error.to_string())";
  if (entryBody !== expectedEntry) {
    throw new Error("canonical Keychain Entry seam must validate service and account namespace");
  }

  const implementation = singleImplBody(structural, literal);
  const expectedImplementation =
    "fnget(&self,service:&str,key:&str)->Result<Option<String>,String>{" +
    "letentry=system_keychain_entry(service,key)?;map_keyring_get(entry.get_password())}" +
    "fnset(&self,service:&str,key:&str,secret:&str)->Result<(),String>{" +
    "system_keychain_entry(service,key)?.set_password(secret).map_err(|error|error.to_string())}" +
    "fndelete(&self,service:&str,key:&str)->Result<(),String>{" +
    "letentry=system_keychain_entry(service,key)?;map_keyring_delete(entry.delete_credential())}";
  if (implementation !== expectedImplementation) {
    throw new Error("canonical Keychain CredentialStore adapter contract changed");
  }
}

export function discoverKeychainSurface(root) {
  let libViews;
  let adapterViews;
  for (const absolute of productionRustFiles(root)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const views = rustViews(readFileSync(absolute, "utf8"));
    if (relative === "src-tauri/src/lib.rs") libViews = views;
    if (relative === "src-tauri/src/adapters.rs") adapterViews = views;
    if (/\bkeyring\s*::/.test(views.structural) && relative !== "src-tauri/src/adapters.rs") {
      throw new Error(
        `${relative} keyring references are restricted to src-tauri/src/adapters.rs`,
      );
    }
  }
  if (!libViews || !adapterViews) throw new Error("canonical Keychain source files are missing");
  if (!/\bkeyring\s*::/.test(adapterViews.structural)) return [];
  assertCanonicalLib(libViews.structural, libViews.literal);
  assertCanonicalAdapters(adapterViews.structural, adapterViews.literal);
  return [...KEYCHAIN_SURFACE];
}
