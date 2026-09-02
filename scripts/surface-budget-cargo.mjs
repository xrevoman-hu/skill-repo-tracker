import { readFileSync } from "node:fs";
import path from "node:path";

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

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && character === "\\" && !escaped) escaped = true;
      else if (character === quote && !escaped) quote = null;
      else escaped = false;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  if (quote) throw new Error("Cargo.toml dependency line contains an unterminated string");
  return line;
}

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === '"' && character === "\\" && !escaped) escaped = true;
      else if (character === quote && !escaped) quote = null;
      else escaped = false;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth -= 1;
    else if (character === "{") curlyDepth += 1;
    else if (character === "}") curlyDepth -= 1;
    else if (character === "," && squareDepth === 0 && curlyDepth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
    if (squareDepth < 0 || curlyDepth < 0) throw new Error("Cargo.toml dependency value is unbalanced");
  }
  if (quote || squareDepth !== 0 || curlyDepth !== 0) {
    throw new Error("Cargo.toml dependency value is unbalanced");
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function tomlString(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  throw new Error(`Cargo.toml dependency value must be a static string: ${value}`);
}

function stringArray(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("Cargo.toml dependency features must be one static string array");
  }
  const body = trimmed.slice(1, -1).trim();
  return body ? splitTopLevel(body).map(tomlString) : [];
}

function dependencyContract(name, rawValue, context) {
  const trimmed = rawValue.trim();
  const fields = new Map();
  if (/^(?:"(?:\\.|[^"\\])*"|'[^']*')$/.test(trimmed)) {
    tomlString(trimmed);
    fields.set("version", trimmed);
  } else {
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      throw new Error(`${name} dependency must use a one-line string or inline table`);
    }
    for (const part of splitTopLevel(trimmed.slice(1, -1))) {
      const match = part.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([\s\S]+)$/);
      if (!match || fields.has(match[1])) throw new Error(`${name} dependency has an invalid field`);
      fields.set(match[1], match[2].trim());
    }
  }
  const allowed = new Set([
    "branch",
    "default-features",
    "features",
    "git",
    "optional",
    "package",
    "path",
    "registry",
    "rev",
    "tag",
    "version",
  ]);
  for (const field of fields.keys()) {
    if (!allowed.has(field)) throw new Error(`${name} dependency uses unsupported field ${field}`);
  }
  const sources = ["git", "path", "registry"].filter((field) => fields.has(field));
  if (sources.length > 1) throw new Error(`${name} dependency has multiple source identities`);
  const stringField = (field) => (fields.has(field) ? tomlString(fields.get(field)) : undefined);
  const booleanField = (field, fallback) => {
    if (!fields.has(field)) return fallback;
    if (!/^(?:true|false)$/.test(fields.get(field))) {
      throw new Error(`${name} dependency ${field} must be a static boolean`);
    }
    return fields.get(field) === "true";
  };
  const source = fields.has("git")
    ? {
        kind: "git",
        url: stringField("git"),
        branch: stringField("branch") ?? null,
        rev: stringField("rev") ?? null,
        tag: stringField("tag") ?? null,
      }
    : fields.has("path")
      ? { kind: "path", path: stringField("path") }
      : { kind: "registry", registry: stringField("registry") ?? "crates-io" };
  const contract = {
    package: stringField("package") ?? name,
    source,
    defaultFeatures: booleanField("default-features", true),
    features: [...new Set(fields.has("features") ? stringArray(fields.get("features")) : [])].sort(),
    optional: booleanField("optional", false),
    target: context.target,
  };
  return `${context.kind}:${name}=${canonicalJson(contract)}`;
}

function dependencySection(section) {
  if (section === "features") {
    throw new Error(
      "Cargo.toml package features are forbidden until their complete graph has a reviewed surface budget",
    );
  }
  if (
    /^(?:dependencies|build-dependencies|dev-dependencies)\./.test(section) ||
    /^target\..+\.(?:dependencies|build-dependencies|dev-dependencies)\./.test(section)
  ) {
    throw new Error(
      `Cargo.toml dependency table form is forbidden; use a one-line declaration: ${section}`,
    );
  }
  const direct = {
    dependencies: "normal",
    "build-dependencies": "build",
    "dev-dependencies": "dev",
  }[section];
  if (direct) return { kind: direct, target: null };
  const target = section.match(/^target\.(.+)\.(dependencies|build-dependencies|dev-dependencies)$/);
  if (target) {
    return {
      kind: { dependencies: "normal", "build-dependencies": "build", "dev-dependencies": "dev" }[
        target[2]
      ],
      target: target[1],
    };
  }
  if (/(?:^|\.)dependencies$/.test(section)) {
    throw new Error(`Cargo.toml uses an unsupported dependency section: ${section}`);
  }
  return null;
}

export function discoverCargoDependencySurface(root) {
  const source = readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const contracts = [];
  const seen = new Set();
  let context = null;
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      context = dependencySection(section[1].trim());
      continue;
    }
    const dottedKeyProbe = line.replace(/["']/g, "");
    if (
      /^(?:dependencies|build-dependencies|dev-dependencies)\s*\./.test(dottedKeyProbe) ||
      /^target\s*\.[\s\S]*?\.\s*(?:dependencies|build-dependencies|dev-dependencies)\s*\./.test(
        dottedKeyProbe,
      )
    ) {
      throw new Error(
        `Cargo.toml:${index + 1} dotted dependency keys are forbidden; use a reviewed dependency section`,
      );
    }
    if (!context) continue;
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*([\s\S]+)$/);
    if (!assignment) throw new Error(`Cargo.toml:${index + 1} dependency declaration is unsupported`);
    const identity = `${context.kind}:${context.target ?? "all"}:${assignment[1]}`;
    if (seen.has(identity)) throw new Error(`Cargo.toml has duplicate direct dependency ${identity}`);
    seen.add(identity);
    contracts.push(dependencyContract(assignment[1], assignment[2], context));
  }
  return contracts.sort((left, right) => left.localeCompare(right));
}
