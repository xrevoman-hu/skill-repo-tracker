import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { SAFARI_15_OBJECT_HAS_OWN_BANNER } from "./browser-compatibility-contract.mjs";

const MAX_REVIEWED_COLOR_MIX = 4;
const MAX_REVIEWED_STARTING_STYLE = 2;

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function assetPath(value) {
  return value.startsWith("/") ? `dist${value}` : undefined;
}

function occurrenceCount(contents, pattern) {
  return [...contents.matchAll(pattern)].length;
}

function selectorHasDeclaration(contents, selector, declaration) {
  for (const match of contents.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((candidate) => candidate.trim());
    if (selectors.includes(selector) && match[2].includes(declaration)) return true;
  }
  return false;
}

function decodeCssForPolicy(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(
      /\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ]+)?|(\r\n|[\s\S]))/gi,
      (_match, hexadecimal, escaped) => {
        if (hexadecimal) {
          const codePoint = Number.parseInt(hexadecimal, 16);
          return codePoint === 0 || codePoint > 0x10ffff
            ? "\ufffd"
            : String.fromCodePoint(codePoint);
        }
        return /^(?:\r\n|[\n\f\r])$/.test(escaped) ? "" : escaped;
      },
    );
}

function validateJavaScriptLoaders(file) {
  const errors = [];
  const sourceFile = ts.createSourceFile(
    file.path,
    file.contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    errors.push(`${file.path} is not valid JavaScript`);
    return errors;
  }
  let hasModuleLoader = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
    ) {
      hasModuleLoader = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (hasModuleLoader) errors.push(`${file.path} contains an unreviewed module-loading surface`);
  return errors;
}

function validateSafari15Bundle(files) {
  const errors = [];
  for (const file of files.filter((candidate) => candidate.path.endsWith(".js"))) {
    if (!file.contents.startsWith(SAFARI_15_OBJECT_HAS_OWN_BANNER)) {
      errors.push(
        `${file.path} is missing the reviewed Safari 15 Object.hasOwn compatibility prelude`,
      );
    }
  }

  const css = files
    .filter((candidate) => candidate.path.endsWith(".css"))
    .map((candidate) => candidate.contents)
    .join("\n");
  const decodedCss = decodeCssForPolicy(css);
  if (/:has\(/i.test(decodedCss)) {
    errors.push("production CSS uses :has() without a Safari 15-compatible selector");
  }
  if (
    /:focus-visible\b/i.test(decodedCss) &&
    !/@supports\s+not\s+selector\(\s*:focus-visible\s*\)\s*\{/i.test(decodedCss)
  ) {
    errors.push("production CSS uses :focus-visible without the reviewed Safari 15 focus fallback");
  }
  const colorMixCount = occurrenceCount(decodedCss, /color-mix\(/gi);
  const startingStyleCount = occurrenceCount(decodedCss, /@starting-style\b/gi);
  if (colorMixCount > MAX_REVIEWED_COLOR_MIX) {
    errors.push(
      `production CSS has ${colorMixCount} color-mix() enhancements; reviewed maximum is ${MAX_REVIEWED_COLOR_MIX}`,
    );
  }
  if (startingStyleCount > MAX_REVIEWED_STARTING_STYLE) {
    errors.push(
      `production CSS has ${startingStyleCount} @starting-style enhancements; reviewed maximum is ${MAX_REVIEWED_STARTING_STYLE}`,
    );
  }
  if (colorMixCount > 0) {
    const fallbacks = [
      [".prompt-tag", "background:var(--prompt-accent-soft)"],
      [".prompt-card.is-drag-placeholder", "background:var(--prompt-accent-soft)"],
      [".prompt-import-success", "background:var(--prompt-accent-soft)"],
      [".prompt-inline-error", "background:var(--prompt-surface-raised)"],
    ];
    for (const [selector, declaration] of fallbacks) {
      if (!selectorHasDeclaration(css, selector, declaration)) {
        errors.push(`production CSS is missing the Safari 15 fallback ${selector} { ${declaration} }`);
      }
    }
  }
  return errors;
}

export function validateBuiltBundleSnapshot(files, budget) {
  const errors = [];
  const byPath = new Map();
  for (const file of files) {
    if (byPath.has(file.path)) errors.push(`dist contains duplicate path ${file.path}`);
    byPath.set(file.path, file);
  }
  errors.push(...validateSafari15Bundle(files));

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > budget.maxTotalBytes) {
    errors.push(`dist is ${totalBytes} bytes; total budget is ${budget.maxTotalBytes}`);
  }

  for (const file of files) {
    const isIndex = file.path === "dist/index.html";
    const isAsset = /^dist\/assets\/[A-Za-z0-9_.-]+\.(?:css|js)$/.test(file.path);
    if (!isIndex && !isAsset) {
      errors.push(`${file.path} is outside the governed HTML/CSS/JavaScript bundle inventory`);
    }
    if (file.path.endsWith(".map")) {
      errors.push(`${file.path} is a forbidden production source map`);
    }
    if (/\bsourceMappingURL\s*=/.test(file.contents)) {
      errors.push(`${file.path} contains a forbidden sourceMappingURL reference`);
    }
    if (file.path.endsWith(".js")) {
      errors.push(...validateJavaScriptLoaders(file));
    }
    if (file.path.endsWith(".css")) {
      const decodedCss = decodeCssForPolicy(file.contents);
      if (/@import\b/i.test(decodedCss)) {
        errors.push(`${file.path} contains a forbidden CSS @import surface`);
      }
      if (/url\(\s*(["']?)(?:https?:)?\/\//i.test(decodedCss)) {
        errors.push(`${file.path} contains a forbidden remote CSS URL`);
      }
    }
    if (file.path.endsWith(".js") && file.bytes > budget.maxJavaScriptChunkBytes) {
      errors.push(
        `${file.path} is ${file.bytes} bytes; JavaScript chunk budget is ${budget.maxJavaScriptChunkBytes}`,
      );
    }
  }

  const index = byPath.get("dist/index.html");
  if (!index) {
    errors.push("dist/index.html is missing from the production bundle");
    return errors;
  }

  const document = new JSDOM(index.contents).window.document;
  const refreshMeta = [...document.querySelectorAll("meta[http-equiv]")].some(
    (element) => element.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh",
  );
  if (refreshMeta) errors.push("dist/index.html contains forbidden meta refresh navigation");
  const cspMeta = [...document.querySelectorAll("meta[http-equiv]")].some(
    (element) => element.getAttribute("http-equiv")?.trim().toLowerCase() === "content-security-policy",
  );
  if (cspMeta) errors.push("dist/index.html cannot override the Tauri Content-Security-Policy");
  if (document.querySelector("style, [style]")) {
    errors.push("dist/index.html contains forbidden inline CSS");
  }
  const loadingAttributes = new Set([
    "action",
    "archive",
    "background",
    "cite",
    "code",
    "codebase",
    "data",
    "formaction",
    "href",
    "longdesc",
    "manifest",
    "ping",
    "poster",
    "profile",
    "src",
    "srcset",
    "usemap",
    "xlink:href",
  ]);
  for (const element of [...document.querySelectorAll("*")]) {
    if ([...element.attributes].some((attribute) => /^on/i.test(attribute.name))) {
      errors.push("dist/index.html contains a forbidden inline event handler");
      break;
    }
    const hasUnreviewedLoader = [...element.attributes].some((attribute) => {
      const name = attribute.name.toLowerCase();
      if (!loadingAttributes.has(name)) return false;
      return !(
        (element.localName === "script" && name === "src") ||
        (element.localName === "link" && name === "href")
      );
    });
    if (hasUnreviewedLoader) {
      errors.push("dist/index.html contains an unreviewed navigation or resource-loading attribute");
      break;
    }
  }
  const scripts = [...document.querySelectorAll("script")];
  if (scripts.length !== 1) {
    errors.push(`dist/index.html must contain exactly one self-hosted module script; found ${scripts.length}`);
  }
  for (const script of scripts) {
    const src = script.getAttribute("src") ?? "";
    if (
      script.getAttribute("type") !== "module" ||
      script.textContent?.trim() ||
      !/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(src)
    ) {
      errors.push("dist/index.html contains an inline, remote, or non-module script");
      continue;
    }
    const referenced = assetPath(src);
    if (!referenced || !byPath.has(referenced)) {
      errors.push(`dist/index.html references missing script asset ${src}`);
    }
  }

  const links = [...document.querySelectorAll("link")];
  if (!links.some((link) => link.getAttribute("rel") === "stylesheet")) {
    errors.push("dist/index.html must reference at least one self-hosted stylesheet");
  }
  for (const link of links) {
    const rel = link.getAttribute("rel") ?? "";
    const href = link.getAttribute("href") ?? "";
    const expectedExtension = rel === "stylesheet" ? "css" : rel === "modulepreload" ? "js" : "";
    if (!expectedExtension || !new RegExp(`^/assets/[A-Za-z0-9_.-]+\\.${expectedExtension}$`).test(href)) {
      errors.push("dist/index.html contains an unsupported or remote link asset");
      continue;
    }
    const referenced = assetPath(href);
    if (!referenced || !byPath.has(referenced)) {
      errors.push(`dist/index.html references missing link asset ${href}`);
    }
  }

  if (document.querySelector("base, iframe, object, embed")) {
    errors.push("dist/index.html contains a CSP-incompatible embedded or base navigation surface");
  }
  return errors;
}

export function checkBundle(root) {
  const budget = JSON.parse(
    readFileSync(join(root, "docs/engineering/architecture-budget.json"), "utf8"),
  ).bundle;
  const dist = join(root, "dist");
  if (!existsSync(dist)) return ["dist does not exist; run the Vite build before bundle budget"];
  const files = [];
  const errors = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const displayPath = normalizedRelative(root, path);
      if (entry.isSymbolicLink()) {
        errors.push(`${displayPath} is a forbidden symbolic link in the production bundle`);
      } else if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push({
          path: displayPath,
          bytes: statSync(path).size,
          contents: readFileSync(path, "utf8"),
        });
      } else {
        errors.push(`${displayPath} is an unsupported production bundle entry`);
      }
    }
  };
  visit(dist);
  return [...errors, ...validateBuiltBundleSnapshot(files, budget)];
}
