import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function stripXmlComments(source) {
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf("<!--", cursor);
    const orphanClosing = source.indexOf("-->", cursor);
    if (orphanClosing >= 0 && (opening < 0 || orphanClosing < opening)) {
      throw new Error("entitlements.plist contains an orphan XML comment terminator");
    }
    if (opening < 0) {
      output += source.slice(cursor);
      break;
    }
    output += source.slice(cursor, opening);
    const closing = source.indexOf("-->", opening + 4);
    if (closing < 0) throw new Error("entitlements.plist contains an unterminated XML comment");
    const body = source.slice(opening + 4, closing);
    if (body.includes("--") || body.endsWith("-")) {
      throw new Error("entitlements.plist contains an invalid XML comment");
    }
    const nested = source.indexOf("<!--", opening + 4);
    if (nested >= 0 && nested < closing) {
      throw new Error("entitlements.plist contains a nested XML comment");
    }
    output += source.slice(opening, closing + 3).replace(/[^\r\n]/g, " ");
    cursor = closing + 3;
  }
  return output;
}

function topLevelPlistKeys(source) {
  const xml = stripXmlComments(source);
  if (/<!\[CDATA\[/i.test(xml)) throw new Error("entitlements.plist must not use CDATA decoys");
  const plistOpenings = [...xml.matchAll(/<plist\b[^>]*>/gi)];
  const plistClosings = [...xml.matchAll(/<\/plist>/gi)];
  if (plistOpenings.length !== 1 || plistClosings.length !== 1) {
    throw new Error("entitlements.plist must contain exactly one plist root");
  }
  const plistOpening = plistOpenings[0];
  const plistClosing = plistClosings[0];
  if (plistClosing.index < plistOpening.index + plistOpening[0].length) {
    throw new Error("entitlements.plist closes its root before opening it");
  }
  let prefix = xml.slice(0, plistOpening.index);
  prefix = prefix.replace(/^\s*<\?xml\b[^?]*\?>/i, "");
  prefix = prefix.replace(
    /^\s*<!DOCTYPE\s+plist\s+PUBLIC\s+"-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"\s+"http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"\s*>/i,
    "",
  );
  if (prefix.trim() || xml.slice(plistClosing.index + plistClosing[0].length).trim()) {
    throw new Error("entitlements.plist root must contain the entire XML document");
  }
  const plistBody = xml.slice(plistOpening.index + plistOpening[0].length, plistClosing.index);
  const keyOpenCount = (plistBody.match(/<key\b/gi) ?? []).length;
  const keyCloseCount = (plistBody.match(/<\/key>/gi) ?? []).length;
  const keyMatches = [...plistBody.matchAll(/<key>([\s\S]*?)<\/key>/gi)];
  if (keyOpenCount !== keyCloseCount || keyMatches.length !== keyOpenCount) {
    throw new Error("entitlements.plist contains a malformed key element");
  }
  const dictOpenCount = (plistBody.match(/<dict\b/gi) ?? []).length;
  const dictTokens = [
    ...plistBody.matchAll(/<dict\b[^>]*\/>|<dict\b[^>]*>|<\/dict>|<key>([\s\S]*?)<\/key>/gi),
  ];
  if (dictTokens.filter((match) => /^<dict\b/i.test(match[0])).length !== dictOpenCount) {
    throw new Error("entitlements.plist contains a malformed dict element");
  }
  const keys = [];
  let dictionaryDepth = 0;
  let rootDictionaries = 0;
  let rootStart = -1;
  let rootEnd = -1;
  for (const match of dictTokens) {
    if (/^<dict\b/i.test(match[0])) {
      if (dictionaryDepth === 0) {
        rootDictionaries += 1;
        if (rootStart < 0) rootStart = match.index;
      }
      if (/\/>$/.test(match[0])) {
        if (dictionaryDepth === 0) rootEnd = match.index + match[0].length;
      } else dictionaryDepth += 1;
    } else if (/^<\/dict>$/i.test(match[0])) {
      dictionaryDepth -= 1;
      if (dictionaryDepth < 0) throw new Error("entitlements.plist closes a dict before it opens");
      if (dictionaryDepth === 0) rootEnd = match.index + match[0].length;
    } else if (dictionaryDepth === 1) keys.push(decodeXml(match[1].trim()));
  }
  if (dictionaryDepth !== 0) throw new Error("entitlements.plist has unbalanced dict elements");
  if (rootDictionaries !== 1) {
    throw new Error(`entitlements.plist must contain exactly one root dict; found ${rootDictionaries}`);
  }
  if (plistBody.slice(0, rootStart).trim() || plistBody.slice(rootEnd).trim()) {
    throw new Error("entitlements.plist root dict must be the only plist child");
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error("entitlements.plist contains duplicate top-level keys");
  }
  return keys;
}

export function discoverEntitlementSurface(entitlementsPath) {
  const xmlKeys = topLevelPlistKeys(readFileSync(entitlementsPath, "utf8")).sort((left, right) =>
    left.localeCompare(right),
  );
  let parsed;
  try {
    parsed = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", entitlementsPath], {
        encoding: "utf8",
      }),
    );
  } catch (error) {
    throw new Error(`entitlements.plist could not be parsed canonically: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("entitlements.plist root must be a dictionary");
  }
  const parsedKeys = Object.keys(parsed).sort((left, right) => left.localeCompare(right));
  if (canonicalJson(xmlKeys) !== canonicalJson(parsedKeys)) {
    throw new Error("entitlements.plist XML keys do not match its canonical dictionary");
  }
  return parsedKeys.map((key) => `${key}=${canonicalJson(parsed[key])}`);
}
