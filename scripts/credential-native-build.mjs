import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// Official tagged source; changing this manifest requires a dependency review.
export const CREDENTIAL_NATIVE_MANIFEST = Object.freeze({
  sqlcipher: "4.19.0",
  sqlite: "3.53.4",
  provider: "commoncrypto",
  sourceUrl: "https://codeload.github.com/sqlcipher/sqlcipher/tar.gz/refs/tags/v4.19.0",
  sourceSha256: "7075f96cbabe45b4ecfc2e6b1745a625f856f695b0827a5506ce9ed85b906aa0",
  deploymentTarget: "12.0",
});

const DEFINES = Object.freeze([
  "SQLITE_HAS_CODEC", "SQLITE_TEMP_STORE=2", "SQLCIPHER_CRYPTO_CC",
  "SQLITE_EXTRA_INIT=sqlcipher_extra_init", "SQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown",
  "SQLITE_CORE", "SQLITE_DEFAULT_FOREIGN_KEYS=1", "SQLITE_ENABLE_API_ARMOR",
  "SQLITE_ENABLE_COLUMN_METADATA", "SQLITE_ENABLE_DBSTAT_VTAB", "SQLITE_ENABLE_FTS3",
  "SQLITE_ENABLE_FTS3_PARENTHESIS", "SQLITE_ENABLE_FTS5", "SQLITE_ENABLE_JSON1",
  "SQLITE_ENABLE_LOAD_EXTENSION=1", "SQLITE_ENABLE_MEMORY_MANAGEMENT", "SQLITE_ENABLE_RTREE",
  "SQLITE_ENABLE_STAT4", "SQLITE_SOUNDEX", "SQLITE_THREADSAFE=1", "SQLITE_USE_URI",
  "HAVE_USLEEP=1", "HAVE_ISNAN", "_POSIX_THREAD_SAFE_FUNCTIONS",
]);
const BUILD_ENV = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" });
const OUTPUT_FILES = Object.freeze(["lib/libsqlcipher.a", "include/sqlite3.h", "LICENSE.sqlcipher"]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ordinaryFile(path) {
  return existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
}

function rejectSymlinkAncestors(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("credential native cache cannot traverse symbolic links");
    }
    if (cursor === dirname(cursor)) break;
  }
}

function privateDirectory(path) {
  rejectSymlinkAncestors(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error("credential native cache must be an ordinary directory");
  }
}

function execute(command, args, cwd) {
  execFileSync(command, args, {
    cwd, env: BUILD_ENV, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function output(command, args) {
  return execFileSync(command, args, {
    env: BUILD_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  }).trim();
}

function sourceArchive(cache) {
  const downloads = join(cache, "downloads");
  privateDirectory(downloads);
  const archive = join(downloads, "sqlcipher-v4.19.0.tar.gz");
  if (existsSync(archive)) {
    if (!ordinaryFile(archive) || digest(readFileSync(archive)) !== CREDENTIAL_NATIVE_MANIFEST.sourceSha256) {
      throw new Error("SQLCipher source cache integrity failure; remove the invalid build cache explicitly");
    }
    return archive;
  }
  const download = mkdtempSync(join(downloads, "download-"));
  try {
    const partial = join(download, "source.tar.gz");
    // No redirects or ambient curl configuration. Only this pinned public URL is fetched.
    execute("/usr/bin/curl", [
      "-q", "--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2",
      "--max-time", "90", "--max-filesize", "33554432", "--output", partial,
      CREDENTIAL_NATIVE_MANIFEST.sourceUrl,
    ], download);
    if (digest(readFileSync(partial)) !== CREDENTIAL_NATIVE_MANIFEST.sourceSha256) {
      throw new Error("SQLCipher downloaded source does not match its pinned SHA-256");
    }
    renameSync(partial, archive);
    return archive;
  } finally {
    rmSync(download, { recursive: true, force: true });
  }
}

function validCachedBuild(destination, fingerprint) {
  rejectSymlinkAncestors(destination);
  const receiptPath = join(destination, "build-receipt.json");
  if (!ordinaryFile(receiptPath)) return false;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    return Object.entries(CREDENTIAL_NATIVE_MANIFEST).every(([key, value]) => receipt[key] === value)
      && receipt.fingerprint === fingerprint && OUTPUT_FILES.every((name) => {
      const file = join(destination, name);
      return ordinaryFile(file) && digest(readFileSync(file)) === receipt.files?.[name];
    });
  } catch {
    return false;
  }
}

/** Build-only dependency preparation. Importing this module never downloads or executes anything. */
export function prepareCredentialNative(root) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("SQLCipher native preparation supports macOS only; Windows E0 remains blocked");
  }
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const target = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const cache = resolve(root, "src-tauri/target/credential-native");
  privateDirectory(cache);
  const archive = sourceArchive(cache);
  const sdk = output("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const compiler = output("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang"]);
  const compilerVersion = output(compiler, ["--version"]);
  const sdkVersion = output("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
  const flags = [
    "-O2", "-fPIC", "-arch", architecture,
    `-mmacosx-version-min=${CREDENTIAL_NATIVE_MANIFEST.deploymentTarget}`,
    "-isysroot", sdk, ...DEFINES.map((define) => `-D${define}`),
  ];
  const fingerprint = digest(JSON.stringify({
    manifest: CREDENTIAL_NATIVE_MANIFEST, target, compilerVersion, sdkVersion, flags,
  }));
  const destination = join(cache, CREDENTIAL_NATIVE_MANIFEST.sqlcipher, target);
  const env = {
    SQLCIPHER_LIB_DIR: join(destination, "lib"),
    SQLCIPHER_INCLUDE_DIR: join(destination, "include"),
    SQLCIPHER_STATIC: "1",
    SRT_CIPHER_SOURCE_SHA256: CREDENTIAL_NATIVE_MANIFEST.sourceSha256,
  };
  if (validCachedBuild(destination, fingerprint)) return env;
  if (existsSync(destination)) {
    throw new Error("SQLCipher build cache is stale or modified; remove only its version/target directory and retry");
  }
  const staging = mkdtempSync(join(cache, "build-"));
  try {
    const source = join(staging, "source");
    const product = join(staging, "product");
    for (const directory of [source, join(product, "lib"), join(product, "include")]) privateDirectory(directory);
    execute("/usr/bin/tar", ["-xzf", archive, "--strip-components=1", "-C", source], staging);
    if (readFileSync(join(source, "VERSION"), "utf8").trim() !== CREDENTIAL_NATIVE_MANIFEST.sqlite) {
      throw new Error("SQLCipher archive SQLite version mismatch");
    }
    execute("/bin/sh", ["./configure", "--disable-shared", "--enable-static", "--disable-tcl", "--disable-readline"], source);
    execute("/usr/bin/make", ["sqlite3.c"], source);
    execute(compiler, [...flags, "-c", join(source, "sqlite3.c"), "-o", join(staging, "sqlite3.o")], source);
    execute("/usr/bin/ar", ["-crs", join(product, "lib/libsqlcipher.a"), join(staging, "sqlite3.o")], staging);
    copyFileSync(join(source, "sqlite3.h"), join(product, "include/sqlite3.h"));
    const readme = readFileSync(join(source, "README.md"), "utf8");
    const start = readme.indexOf("## Community Edition Open Source License");
    const end = readme.indexOf("# Begin SQLite README.md", start);
    if (start < 0 || end < start) throw new Error("SQLCipher source license section missing");
    writeFileSync(join(product, "LICENSE.sqlcipher"), readme.slice(start, end));
    const receipt = {
      ...CREDENTIAL_NATIVE_MANIFEST, target, compilerVersion, sdkVersion, flags, fingerprint,
      files: Object.fromEntries(OUTPUT_FILES.map((name) => [name, digest(readFileSync(join(product, name)))])),
    };
    writeFileSync(join(product, "build-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    privateDirectory(dirname(destination));
    renameSync(product, destination);
    console.log(`Prepared SQLCipher ${receipt.sqlcipher} / SQLite ${receipt.sqlite} (${target}, CommonCrypto)`);
    return env;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
