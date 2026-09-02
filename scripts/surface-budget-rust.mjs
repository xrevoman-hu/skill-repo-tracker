import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { isRustProductionSourcePath } from "./source-classification.mjs";
import { discoverDirBuilderPathSites } from "./surface-budget-rust-dir-builder.mjs";

const TASK_APIS = new Set([
  "async_std::task::spawn",
  "async_std::task::spawn_blocking",
  "smol::spawn",
  "std::thread::spawn",
  "tauri::async_runtime::spawn",
  "tauri::async_runtime::spawn_blocking",
  "tokio::spawn",
  "tokio::task::spawn",
  "tokio::task::spawn_blocking",
  "tokio::task::spawn_local",
  "wasm_bindgen_futures::spawn_local",
]);

const TAURI_HOOKS = [
  "on_menu_event",
  "on_page_load",
  "on_tray_icon_event",
  "on_webview_event",
  "on_window_event",
  "setup",
];
const EXPECTED_BUILDER_CHAIN = ["plugin", "setup", "invoke_handler", "run", "expect"];
const RAW_NETWORK_TOKEN =
  /\b(?:TcpStream|TcpListener|UdpSocket|UnixStream|UnixListener|UnixDatagram)\b|\b(?:std|tokio|async_std)\s*::\s*(?:os\s*::\s*unix\s*::\s*)?net\s*::/;
const UNAPPROVED_TRANSPORT_TOKEN = /\b(?:hyper|isahc|surf|ureq)\s*::/;
const TAURI_EVENT_TOKEN =
  /\btauri\s*::\s*(?:event\s*::|Emitter\b|Listener\b)|\b(?:Emitter|Listener)\b|\.\s*(?:emit|emit_all|emit_filter|emit_str|emit_to|listen|listen_any|listen_global|once|once_global|unlisten)\s*\(/;
const TAURI_RUNTIME_WINDOW_TOKEN =
  /\b(?:tauri\s*::\s*)?(?:WebviewWindowBuilder|WindowBuilder)\b|\bWebviewUrl\s*::\s*External\b|\.\s*(?:eval|navigate|initialization_script|initialization_scripts)\s*\(/;

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

function maskRustNonCode(source) {
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
        } else blank(index++);
      }
      if (depth !== 0) throw new Error("Rust source contains an unterminated block comment");
      continue;
    }
    const raw = source.slice(index).match(/^(?:(?:b|c)?r)(#+)?"/);
    if (raw) {
      const terminator = `"${raw[1] ?? ""}`;
      let end = source.indexOf(terminator, index + raw[0].length);
      if (end < 0) throw new Error("Rust source contains an unterminated raw string");
      end += terminator.length;
      while (index < end) blank(index++);
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
      if (end > source.length || source[end - 1] !== '"') {
        throw new Error("Rust source contains an unterminated string");
      }
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

function maskCfgTestItems(masked) {
  const output = [...masked];
  const attributes = [...masked.matchAll(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g)];
  for (const attribute of attributes) {
    let cursor = attribute.index + attribute[0].length;
    while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
    while (masked[cursor] === "#") {
      const bracket = masked.indexOf("[", cursor);
      const closing = findMatchingDelimiter(masked, bracket, "[", "]");
      if (bracket < 0 || closing < 0) throw new Error("Rust cfg(test) item has an invalid attribute");
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
    if (end < 0) throw new Error("Rust cfg(test) item boundary could not be determined");
    for (let index = attribute.index; index <= end; index += 1) {
      if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
    }
  }
  return output.join("");
}

function productionRustFiles(root) {
  const sourceRoot = path.join(root, "src-tauri/src");
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`${relative} Rust production surface must not be a symbolic link`);
      } else if (
        entry.isFile() &&
        isRustProductionSourcePath(relative)
      ) {
        files.push(absolute);
      }
    }
  };
  visit(sourceRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function enclosingFunctions(masked) {
  const functions = [];
  for (const match of masked.matchAll(/\b(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    let opening = match.index + match[0].length;
    while (opening < masked.length && masked[opening] !== "{" && masked[opening] !== ";") {
      opening += 1;
    }
    if (masked[opening] !== "{") continue;
    const closing = findMatchingDelimiter(masked, opening, "{", "}");
    if (closing < 0) throw new Error(`Rust function ${match[1]} has unbalanced braces`);
    functions.push({ name: match[1], opening, closing });
  }
  return functions;
}

function functionAt(functions, position) {
  return (
    functions
      .filter(({ opening, closing }) => opening < position && position < closing)
      .sort((left, right) => right.opening - left.opening)[0]?.name ?? "<module>"
  );
}

function rustTaskSites(relative, masked) {
  const taskTokens = [...masked.matchAll(/\bspawn(?:_blocking|_local)?\b/g)];
  const references = [
    ...masked.matchAll(
      /\b((?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)+spawn(?:_blocking|_local)?)\b/g,
    ),
  ];
  if (taskTokens.length !== references.length) {
    throw new Error(`${relative} uses an aliased, method, macro, or wrapped Rust spawn primitive`);
  }
  const functions = enclosingFunctions(masked);
  const counts = new Map();
  const sites = [];
  for (const reference of references) {
    const api = reference[1].replace(/\s+/g, "");
    let cursor = reference.index + reference[0].length;
    while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
    if (masked[cursor] !== "(" || !TASK_APIS.has(api)) {
      throw new Error(`${relative} Rust spawn primitive must be a canonical direct call: ${api}`);
    }
    const owner = functionAt(functions, reference.index);
    const key = `${api}:${owner}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    sites.push(`${relative}:${api}:${owner}#${ordinal}`);
  }
  return sites;
}

function rejectRustForeignExecution(relative, masked) {
  for (const attribute of masked.matchAll(/#\s*\[/g)) {
    const opening = masked.indexOf("[", attribute.index);
    const closing = findMatchingDelimiter(masked, opening, "[", "]");
    if (closing < 0) throw new Error(`${relative} Rust attribute is unbalanced`);
    if (
      /\b(?:link|link_name|link_ordinal|link_section)\b/.test(
        masked.slice(opening + 1, closing),
      )
    ) {
      throw new Error(`${relative} native linkage attributes are forbidden`);
    }
  }
  if (/\bextern\b(?!\s+crate\b)/.test(masked)) {
    throw new Error(`${relative} foreign ABI declarations are forbidden`);
  }
  const importsAssemblyMacro = [...masked.matchAll(/\b(?:pub\s+)?use\b[\s\S]*?;/g)].some(
    (statement) => /\b(?:asm|global_asm)\b/.test(statement[0]),
  );
  if (/\b(?:asm|global_asm)\s*!/.test(masked) || importsAssemblyMacro) {
    throw new Error(`${relative} inline or global assembly is forbidden`);
  }
}

function rejectReqwestTransportBypass(relative, masked) {
  const isGithubAdapter = relative === "src-tauri/src/adapters.rs";
  const useStatements = [...masked.matchAll(/\b(?:pub\s+)?use\b[\s\S]*?;/g)].map(
    (match) => match[0],
  );
  const importsTransport = useStatements.some(
    (statement) =>
      /\breqwest\s+as\b/.test(statement) ||
      /\breqwest\s*::\s*(?:blocking\s*::\s*)?(?:Client|ClientBuilder|RequestBuilder)\b/.test(
        statement,
      ) ||
      /\breqwest\s*::\s*\{[\s\S]*?\b(?:Client|ClientBuilder|RequestBuilder|self|\*)\b/.test(
        statement,
      ),
  );
  const referencesTransport =
    /\breqwest\s*::\s*(?:blocking\s*::\s*)?(?:Client|ClientBuilder|RequestBuilder)\b/.test(
      masked,
    ) ||
    /\breqwest\s*::\s*(?:blocking\s*::\s*)?get\s*\(/.test(masked) ||
    /\bextern\s+crate\s+reqwest\b/.test(masked);

  if (!isGithubAdapter) {
    if (importsTransport || referencesTransport) {
      throw new Error(`${relative} reqwest transport must route through the GitHub adapter`);
    }
    return;
  }

  if (importsTransport || /\bextern\s+crate\s+reqwest\b/.test(masked)) {
    throw new Error(`${relative} reqwest transport aliases are forbidden`);
  }
  if (
    /\btype\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^;=]+>)?\s*=\s*reqwest\s*::\s*(?:Client|ClientBuilder|RequestBuilder)\b/.test(
      masked,
    )
  ) {
    throw new Error(`${relative} reqwest transport type aliases are forbidden`);
  }
  const adapterImpls = [
    ...masked.matchAll(/\bimpl\s+GithubHttpAdapter\s+for\s+ReqwestGithubHttpAdapter\s*\{/g),
  ];
  const adapterImplBody = (() => {
    if (adapterImpls.length !== 1) return "";
    const opening = masked.indexOf("{", adapterImpls[0].index);
    const closing = findMatchingDelimiter(masked, opening, "{", "}");
    return closing < 0 ? "" : masked.slice(opening + 1, closing);
  })();
  const canonicalSignatures = [
    ...adapterImplBody.matchAll(
      /\bfn\s+execute\s*\(\s*&\s*self\s*,\s*request\s*:\s*reqwest\s*::\s*Request\s*\)/g,
    ),
  ];
  const executeCalls = [...masked.matchAll(/\.\s*execute\s*\(/g)];
  const canonicalExecuteCalls = [
    ...masked.matchAll(/\bself\s*\.\s*0\s*\.\s*execute\s*\(\s*request\s*\)/g),
  ];
  if (
    adapterImpls.length !== 1 ||
    canonicalSignatures.length !== 1 ||
    executeCalls.length !== 1 ||
    canonicalExecuteCalls.length !== 1 ||
    /\.\s*(?:send|request)\s*\(/.test(masked) ||
    /\.\s*(?:get|post|put|patch|delete|head)\s*\(/.test(masked) ||
    /\b(?:reqwest\s*::\s*)?Client\s*::\s*(?:execute|get|post|put|patch|delete|head|request)\b/.test(
      masked,
    ) ||
    /\bRequestBuilder\b/.test(masked)
  ) {
    throw new Error(
      `${relative} must contain exactly one canonical audited reqwest transport call`,
    );
  }
}

function inventoryRusqlitePathCalls(relative, masked, functions, counts, sites) {
  const useStatements = [...masked.matchAll(/\b(?:pub\s+)?use\b[\s\S]*?;/g)].map(
    (match) => match[0],
  );
  let importsConnectionDirectly = false;
  for (const statement of useStatements) {
    if (/\brusqlite\b/.test(statement)) {
      if (/^\s*pub\s+use\b/.test(statement) || /\bas\b/.test(statement)) {
        throw new Error(`${relative} rusqlite aliases and re-exports are forbidden`);
      }
      const compact = statement.replace(/\s+/g, "");
      if (
        /^use(?:::)?rusqlite::Connection;$/.test(compact) ||
        (/^use(?:::)?rusqlite::\{[^{}]+\};$/.test(compact) &&
          compact
            .slice(compact.indexOf("{") + 1, compact.lastIndexOf("}"))
            .split(",")
            .includes("Connection"))
      ) {
        importsConnectionDirectly = true;
      }
    } else if (/\bConnection\b/.test(statement)) {
      throw new Error(`${relative} rusqlite Connection must not use an indirect import`);
    }
  }
  if (/\bextern\s+crate\s+rusqlite\s+as\b/.test(masked)) {
    throw new Error(`${relative} rusqlite root aliases are forbidden`);
  }
  if (
    /\btype\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^;=]+>)?\s*=\s*(?:(?:::)?rusqlite\s*::\s*)?Connection\b/.test(
      masked,
    )
  ) {
    throw new Error(`${relative} rusqlite Connection type aliases are forbidden`);
  }
  if (
    /<\s*(?:(?:::)?rusqlite\s*::\s*)?Connection(?:\s+as\s+[^>]+)?\s*>\s*::\s*(?:r#)?(?:open|open_with_flags)\b/.test(
      masked,
    )
  ) {
    throw new Error(`${relative} rusqlite UFCS or trait path opening is forbidden`);
  }
  const referencePattern =
    /(^|[^:A-Za-z0-9_>])((?:(?:::)?rusqlite\s*::\s*)?Connection)\s*::\s*(open_with_flags|open)\b/gm;
  const callPattern =
    /(^|[^:A-Za-z0-9_>])((?:(?:::)?rusqlite\s*::\s*)?Connection)\s*::\s*(open_with_flags|open)\s*\(/gm;
  const references = [...masked.matchAll(referencePattern)];
  const calls = [...masked.matchAll(callPattern)];
  if (references.length !== calls.length) {
    throw new Error(`${relative} rusqlite path primitives must remain canonical direct calls`);
  }
  if (references.some((reference) => !/rusqlite/.test(reference[2])) && !importsConnectionDirectly) {
    throw new Error(`${relative} rusqlite Connection must use a canonical direct import`);
  }
  for (const call of calls) {
    const api = `rusqlite::Connection::${call[3]}`;
    const owner = functionAt(functions, call.index);
    const key = `${api}:${owner}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    sites.push(`${relative}:${api}:${owner}#${ordinal}`);
  }
}

function rustPathSites(relative, source, masked) {
  rejectRustForeignExecution(relative, masked);
  rejectReqwestTransportBypass(relative, masked);
  if (/\bextern\s+crate\s+(?:dirs|libc|opener|tempfile|walkdir)\b/.test(masked)) {
    throw new Error(`${relative} must not alias governed filesystem or process crates`);
  }
  if (/\bmacro_rules\s*!/.test(masked)) {
    throw new Error(
      `${relative} must not define local Rust macros that can hide governed execution primitives`,
    );
  }
  if (RAW_NETWORK_TOKEN.test(masked) || UNAPPROVED_TRANSPORT_TOKEN.test(masked)) {
    throw new Error(`${relative} must not use raw or unapproved network transports`);
  }
  if (
    relative !== "src-tauri/src/adapters.rs" &&
    /\breqwest\s*::\s*(?:Client\s*::\s*(?:new|builder)|(?:blocking\s*::\s*)?get)\s*\(/.test(
      masked,
    )
  ) {
    throw new Error(`${relative} must route HTTP transport through the GitHub adapter`);
  }
  if (TAURI_EVENT_TOKEN.test(masked)) {
    throw new Error(`${relative} must not use Tauri event IPC; use governed commands`);
  }
  if (TAURI_RUNTIME_WINDOW_TOKEN.test(masked)) {
    throw new Error(`${relative} must not create or navigate runtime Tauri windows or webviews`);
  }
  if (
    /\btype\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^;=]+>)?\s*=\s*(?:(?:(?:std|tokio|async_std)\s*::\s*)?fs\s*::\s*)?(?:File|OpenOptions)\b|\btype\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^;=]+>)?\s*=\s*(?:(?:std\s*::\s*)?path\s*::\s*)?(?:Path|PathBuf)\b/.test(
      masked,
    )
  ) {
    throw new Error(`${relative} must not hide filesystem primitives behind a type alias`);
  }
  if (
    /\btype\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^;=]+>)?\s*=\s*(?:(?:walkdir\s*::\s*)?WalkDir|(?:tempfile\s*::\s*)?NamedTempFile|tempfile\s*::\s*Builder)\b/.test(
      masked,
    )
  ) {
    throw new Error(`${relative} must not hide filesystem-capable crates behind a type alias`);
  }
  if (
    /\b(?:std|process|Command|fs|File|OpenOptions|path|Path|PathBuf|self)\s+as\s+[A-Za-z_]/.test(
      masked,
    )
  ) {
    throw new Error(`${relative} must not alias process or filesystem primitives`);
  }
  for (const useStatement of masked.matchAll(/\buse\b[\s\S]*?;/g)) {
    const text = useStatement[0];
    if (/\blibc\b/.test(text)) {
      throw new Error(`${relative} libc imports are forbidden; use canonical libc:: calls`);
    }
    if (
      /\bos\s*::\s*unix\b/.test(text) &&
      /\bfs\s*::\s*(?:\*|[a-z][a-z0-9_]*)(?:\s+as\s+\w+)?\b/.test(text)
    ) {
      throw new Error(`${relative} must not directly import Unix filesystem functions`);
    }
    if (/\b(?:dirs|opener|tempfile|walkdir)\b/.test(text)) {
      const compact = text.replace(/\s+/g, "");
      if (!["usetempfile::NamedTempFile;", "usewalkdir::WalkDir;"].includes(compact)) {
        throw new Error(
          `${relative} filesystem-capable crate imports must remain canonical direct type imports`,
        );
      }
    }
    const compact = text.replace(/\s+/g, "").replace(/^use/, "");
    if (
      /(?:^|[,{}])(?:(?:std|tokio|async_std)::)?fs::(?:\*|[a-z][A-Za-z0-9_]*)(?:as[A-Za-z_][A-Za-z0-9_]*)?(?=[,;}])/.test(
        compact,
      )
    ) {
      throw new Error(`${relative} must not directly import filesystem functions`);
    }
    for (const group of text.matchAll(/\bfs\s*::\s*\{([\s\S]*?)\}/g)) {
      if (
        group[1]
          .split(",")
          .map((part) => part.trim())
          .some((part) => /^[a-z][a-z0-9_]*(?:\s+as\s+\w+)?$/.test(part) && part !== "self")
      ) {
        throw new Error(`${relative} must not directly import filesystem functions`);
      }
    }
  }

  const functions = enclosingFunctions(masked);
  const counts = new Map();
  const sites = [];
  const inventoryCalls = (referencePattern, callPattern, normalize, label) => {
    const references = [...masked.matchAll(referencePattern)];
    const calls = [...masked.matchAll(callPattern)];
    if (references.length !== calls.length) {
      throw new Error(`${relative} ${label} primitives must remain canonical direct calls`);
    }
    for (const call of calls) {
      const api = normalize(call);
      const owner = functionAt(functions, call.index);
      const key = `${api}:${owner}`;
      const ordinal = (counts.get(key) ?? 0) + 1;
      counts.set(key, ordinal);
      sites.push(`${relative}:${api}:${owner}#${ordinal}`);
    }
  };
  sites.push(
    ...discoverDirBuilderPathSites(relative, masked, (position) =>
      functionAt(functions, position),
    ),
  );
  inventoryRusqlitePathCalls(relative, masked, functions, counts, sites);
  inventoryCalls(
    /(^|[^:A-Za-z0-9_])(?:std\s*::\s*)?fs\s*::\s*([a-z][a-z0-9_]*)\b/gm,
    /(^|[^:A-Za-z0-9_])(?:std\s*::\s*)?fs\s*::\s*([a-z][a-z0-9_]*)\s*\(/gm,
    (call) => `fs::${call[2]}`,
    "std::fs",
  );
  inventoryCalls(
    /\b(?:(?:std\s*::\s*)?fs\s*::\s*)?(File|OpenOptions)\s*::\s*([a-z][a-z0-9_]*)\b/g,
    /\b(?:(?:std\s*::\s*)?fs\s*::\s*)?(File|OpenOptions)\s*::\s*([a-z][a-z0-9_]*)\s*\(/g,
    (call) => `${call[1]}::${call[2]}`,
    "File/OpenOptions",
  );
  inventoryCalls(
    /\.\s*(canonicalize|exists|is_dir|is_file|metadata|read_dir|read_link|symlink_metadata|try_exists)\b/g,
    /\.\s*(canonicalize|exists|is_dir|is_file|metadata|read_dir|read_link|symlink_metadata|try_exists)\s*\(/g,
    (call) => `Path::${call[1]}`,
    "path metadata",
  );
  inventoryCalls(
    /\.\s*open\b/g,
    /\.\s*open\s*\(/g,
    () => "OpenOptions::open",
    "path-opening",
  );
  inventoryCalls(
    /\bstd\s*::\s*os\s*::\s*unix\s*::\s*fs\s*::\s*([a-z][a-z0-9_]*)\b/g,
    /\bstd\s*::\s*os\s*::\s*unix\s*::\s*fs\s*::\s*([a-z][a-z0-9_]*)\s*\(/g,
    (call) => `unix_fs::${call[1]}`,
    "Unix filesystem",
  );
  inventoryCalls(
    /\b(?:(?:std\s*::\s*)?path\s*::\s*)?(Path|PathBuf)\s*::\s*(canonicalize|exists|is_dir|is_file|metadata|read_dir|read_link|symlink_metadata|try_exists)\b/g,
    /\b(?:(?:std\s*::\s*)?path\s*::\s*)?(Path|PathBuf)\s*::\s*(canonicalize|exists|is_dir|is_file|metadata|read_dir|read_link|symlink_metadata|try_exists)\s*\(/g,
    (call) => `${call[1]}::${call[2]}`,
    "Path/PathBuf associated metadata",
  );
  inventoryCalls(
    /\b(?:walkdir\s*::\s*)?WalkDir\s*::\s*new\b/g,
    /\b(?:walkdir\s*::\s*)?WalkDir\s*::\s*new\s*\(/g,
    () => "WalkDir::new",
    "walkdir",
  );
  inventoryCalls(
    /\b(?:tempfile\s*::\s*)?NamedTempFile\s*::\s*(new|new_in)\b/g,
    /\b(?:tempfile\s*::\s*)?NamedTempFile\s*::\s*(new|new_in)\s*\(/g,
    (call) => `NamedTempFile::${call[1]}`,
    "NamedTempFile",
  );
  inventoryCalls(
    /\btempfile\s*::\s*(Builder\s*::\s*new|tempdir|tempdir_in|tempfile|tempfile_in|spooled_tempfile)\b/g,
    /\btempfile\s*::\s*(Builder\s*::\s*new|tempdir|tempdir_in|tempfile|tempfile_in|spooled_tempfile)\s*\(/g,
    (call) => `tempfile::${call[1].replace(/\s+/g, "")}`,
    "tempfile",
  );
  inventoryCalls(
    /\bdirs\s*::\s*([a-z][a-z0-9_]*)\b/g,
    /\bdirs\s*::\s*([a-z][a-z0-9_]*)\s*\(/g,
    (call) => `dirs::${call[1]}`,
    "dirs",
  );
  inventoryCalls(
    /\bopener\s*::\s*open\b/g,
    /\bopener\s*::\s*open\s*\(/g,
    () => "opener::open",
    "opener",
  );
  for (const reference of masked.matchAll(/\blibc\s*::\s*([a-z][a-z0-9_]*)\b/g)) {
    let cursor = reference.index + reference[0].length;
    while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
    if (masked[cursor] !== "(") {
      if (!["c_int", "stat"].includes(reference[1])) {
        throw new Error(`${relative} libc primitive must remain a canonical direct call`);
      }
      continue;
    }
    const api = `libc::${reference[1]}`;
    const owner = functionAt(functions, reference.index);
    const key = `${api}:${owner}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    sites.push(`${relative}:${api}:${owner}#${ordinal}`);
  }

  const commandReferences = [...masked.matchAll(/\bCommand\s*::\s*new\b/g)];
  const commandCalls = [...masked.matchAll(/\bCommand\s*::\s*new\s*\(/g)];
  if (commandReferences.length !== commandCalls.length) {
    throw new Error(`${relative} process Command must remain a canonical direct call`);
  }
  for (const call of commandCalls) {
    const expected = 'Command::new("open").arg("-a").arg(&browser.app_name).arg(&url).status()';
    const expression = source
      .slice(call.index)
      .match(
        /^Command\s*::\s*new\s*\(\s*"open"\s*\)\s*\.\s*arg\s*\(\s*"-a"\s*\)\s*\.\s*arg\s*\(\s*&\s*browser\.app_name\s*\)\s*\.\s*arg\s*\(\s*&\s*url\s*\)\s*\.\s*status\s*\(\s*\)/,
      )?.[0]
      .replace(/\s+/g, "");
    if (expression !== expected) {
      throw new Error(`${relative} process Command is not the approved macOS open intent`);
    }
    const owner = functionAt(functions, call.index);
    const key = `Command::new(\"open\"):${owner}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    sites.push(`${relative}:${key}#${ordinal}`);
  }
  return sites;
}

function tauriBuilderSites(relative, masked) {
  const sites = [];
  if (/\b(?:tauri|Builder)\s+as\s+[A-Za-z_]/.test(masked)) {
    throw new Error(`${relative} must not alias the Tauri Builder`);
  }
  if (
    [...masked.matchAll(/\b(?:pub\s+)?use\b[\s\S]*?;/g)].some((statement) =>
      /\btauri\b[\s\S]*\bBuilder\b/.test(statement[0]),
    )
  ) {
    throw new Error(`${relative} must not import or re-export the Tauri Builder`);
  }
  const builders = [...masked.matchAll(/\btauri\s*::\s*Builder\s*::\s*default\s*\(\s*\)/g)];
  const builderTokens = [...masked.matchAll(/\btauri\s*::\s*Builder\b/g)];
  if (builderTokens.length !== builders.length) {
    throw new Error(`${relative} Tauri Builder must use one canonical direct constructor`);
  }
  if (builders.length > 1) {
    throw new Error(`${relative} must not construct a second Tauri Builder`);
  }
  if (builders.length === 1) {
    const methods = [];
    let cursor = builders[0].index + builders[0][0].length;
    while (true) {
      while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
      if (masked[cursor] !== ".") break;
      cursor += 1;
      while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
      const method = masked.slice(cursor).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (!method) throw new Error(`${relative} Tauri Builder chain contains a dynamic method`);
      cursor += method[0].length;
      while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
      if (masked[cursor] !== "(") {
        throw new Error(`${relative} Tauri Builder methods must not use aliases or turbofish`);
      }
      const closing = findMatchingDelimiter(masked, cursor, "(", ")");
      if (closing < 0) throw new Error(`${relative} Tauri Builder method is unbalanced`);
      methods.push(method[1]);
      cursor = closing + 1;
    }
    if (methods.join(",") !== EXPECTED_BUILDER_CHAIN.join(",")) {
      throw new Error(
        `${relative} Tauri Builder chain must remain ${EXPECTED_BUILDER_CHAIN.join(" -> ")}`,
      );
    }
    sites.push(`${relative}:builder=${EXPECTED_BUILDER_CHAIN.join(">")}`);
  }
  const requiredChainMethods = new Map([
    ["plugin", builders.length],
    ["setup", builders.length],
    ["invoke_handler", builders.length],
    ["run", builders.length],
  ]);
  for (const hook of TAURI_HOOKS) {
    if (!requiredChainMethods.has(hook)) requiredChainMethods.set(hook, 0);
  }
  for (const [method, expectedCount] of requiredChainMethods) {
    const calls = [...masked.matchAll(new RegExp(`\\.\\s*${method}\\s*\\(`, "g"))];
    if (calls.length !== expectedCount) {
      throw new Error(
        `${relative} Tauri ${method} is outside the sole canonical Builder chain`,
      );
    }
  }
  const inventoryMethod = (method, describe) => {
    const references = [
      ...masked.matchAll(new RegExp(`(?:\\.|::)\\s*${method}\\b`, "g")),
    ];
    const calls = [
      ...masked.matchAll(new RegExp(`\\.\\s*${method}\\s*\\(`, "g")),
    ];
    if (references.length !== calls.length) {
      throw new Error(`${relative} Tauri ${method} must remain a direct Builder method call`);
    }
    for (const [index, call] of calls.entries()) sites.push(describe(call, index + 1));
  };
  inventoryMethod("plugin", (call) => {
    const opening = masked.indexOf("(", call.index);
    const closing = findMatchingDelimiter(masked, opening, "(", ")");
    if (closing < 0) throw new Error(`${relative} Tauri plugin registration is unbalanced`);
    const factory = masked.slice(opening + 1, closing).replace(/\s+/g, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*\(\)$/.test(factory)) {
      throw new Error(`${relative} Tauri plugin must use one static zero-argument factory`);
    }
    return `${relative}:plugin=${factory}`;
  });
  for (const hook of TAURI_HOOKS) {
    inventoryMethod(hook, (_call, ordinal) => `${relative}:hook=${hook}#${ordinal}`);
  }
  return sites;
}

export function discoverRustExecutionSurface(root) {
  const rustTaskSitesResult = [];
  const rustPathSitesResult = [];
  const tauriPlugins = [];
  let builderCount = 0;
  for (const absolute of productionRustFiles(root)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const source = readFileSync(absolute, "utf8");
    const masked = maskCfgTestItems(maskRustNonCode(source));
    rustTaskSitesResult.push(...rustTaskSites(relative, masked));
    rustPathSitesResult.push(...rustPathSites(relative, source, masked));
    const builderSites = tauriBuilderSites(relative, masked);
    if (builderSites.some((site) => site.includes(":builder="))) builderCount += 1;
    tauriPlugins.push(...builderSites);
  }
  if (builderCount !== 1) {
    throw new Error(`expected exactly one canonical Tauri Builder chain; found ${builderCount}`);
  }
  return {
    rustTaskSites: uniqueSorted(rustTaskSitesResult),
    rustPathSites: uniqueSorted(rustPathSitesResult),
    tauriPlugins: uniqueSorted(tauriPlugins),
  };
}
