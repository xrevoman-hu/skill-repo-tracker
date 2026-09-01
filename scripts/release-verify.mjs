#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const PRODUCT_NAME = "Skill Repo Tracker";

export function parseReleaseArguments(argv) {
  const values = {};
  const allowed = new Set(["lane", "version", "phase", "manifest-token"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error(`invalid release argument near ${key ?? "end of input"}`);
    }
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`unsupported release argument: --${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate release argument: --${name}`);
    values[name] = value;
  }
  if (values.lane !== "adhoc") throw new Error("--lane must be adhoc");
  if (!/^\d+\.\d+\.\d+$/.test(values.version ?? "")) {
    throw new Error("--version must be an explicit stable semver");
  }
  if (!["local", "remote"].includes(values.phase)) {
    throw new Error("--phase must be local or remote");
  }
  const manifestToken = values["manifest-token"]?.trim() || undefined;
  if (values.phase === "remote" && !manifestToken) {
    throw new Error(
      "--manifest-token carrying the local artifact fields is required for remote verification",
    );
  }
  if (values.phase === "local" && manifestToken) {
    throw new Error("--manifest-token is only accepted by remote verification");
  }
  const manifest = manifestToken
    ? decodeReleaseManifestToken(manifestToken, values.version)
    : undefined;
  return {
    lane: values.lane,
    version: values.version,
    phase: values.phase,
    manifest,
  };
}

export function buildReleaseManifest({ version, commit, artifact, bytes, sha256: digest }) {
  return {
    schemaVersion: 1,
    lane: "adhoc",
    version,
    commit,
    artifact,
    bytes,
    sha256: digest,
  };
}

export function validateReleaseManifest(manifest, expectedVersion) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("release manifest must be an object");
  }
  const expectedKeys = [
    "artifact",
    "bytes",
    "commit",
    "lane",
    "schemaVersion",
    "sha256",
    "version",
  ];
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("release manifest has missing or unsupported fields");
  }
  if (manifest.schemaVersion !== 1 || manifest.lane !== "adhoc") {
    throw new Error("release manifest has an unsupported schema or lane");
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `release manifest version ${manifest.version ?? "missing"} does not match requested version ${expectedVersion}`,
    );
  }
  if (manifest.artifact !== `${PRODUCT_NAME}_${expectedVersion}_aarch64.dmg`) {
    throw new Error(`release manifest has an unexpected local artifact name: ${manifest.artifact}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) {
    throw new Error("release manifest commit must be a full lowercase commit SHA");
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) {
    throw new Error("release manifest bytes must be a positive safe integer");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256 ?? "")) {
    throw new Error("release manifest sha256 must be 64 lowercase hex characters");
  }
  return manifest;
}

export function encodeReleaseManifest(manifest) {
  const validated = validateReleaseManifest(manifest, manifest?.version);
  return Buffer.from(JSON.stringify(validated), "utf8").toString("base64url");
}

export function writeReleaseHandoffFiles({ directory, manifest }) {
  const validated = validateReleaseManifest(manifest, manifest?.version);
  const prefix = `${PRODUCT_NAME}_${validated.version}_aarch64.release`;
  const manifestPath = join(directory, `${prefix}.json`);
  const tokenPath = join(directory, `${prefix}.token`);
  const token = encodeReleaseManifest(validated);

  writeFileSync(manifestPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);

  return { manifestPath, tokenPath };
}

export function buildLocalReleaseSummary({
  dmgPath,
  manifestPath,
  tokenPath,
  bytes,
  sha256: digest,
  commit,
}) {
  return [
    "PASS release local artifact",
    `path=${dmgPath}`,
    `manifest=${manifestPath}`,
    `manifestTokenFile=${tokenPath}`,
    `bytes=${bytes}`,
    `sha256=${digest}`,
    `commit=${commit}`,
  ];
}

export function decodeReleaseManifestToken(token, expectedVersion) {
  if (!/^[A-Za-z0-9_-]+$/.test(token ?? "")) {
    throw new Error("release manifest token is not canonical base64url");
  }
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("release manifest token is not valid JSON", { cause: error });
  }
  const validated = validateReleaseManifest(manifest, expectedVersion);
  if (encodeReleaseManifest(validated) !== token) {
    throw new Error("release manifest token is not canonical base64url");
  }
  return validated;
}

export function validateRemoteDigest({ expectedSha256, serverDigest, downloadedSha256 }) {
  if (downloadedSha256 !== expectedSha256) {
    throw new Error(
      `downloaded asset SHA-256 ${downloadedSha256} does not match the operator-provided manifest SHA-256 ${expectedSha256}`,
    );
  }
  const expectedServerDigest = `sha256:${expectedSha256}`;
  if (serverDigest !== expectedServerDigest) {
    throw new Error(
      `release server digest ${serverDigest ?? "missing"} does not match the operator-provided manifest SHA-256 ${expectedSha256}`,
    );
  }
}

export function validateRemoteCommit({ expectedCommit, releaseCommit }) {
  if (releaseCommit !== expectedCommit) {
    throw new Error(
      `release commit ${releaseCommit} does not match the operator-provided manifest commit ${expectedCommit}`,
    );
  }
}

export function validateRemoteBytes({ expectedBytes, serverBytes, downloadedBytes }) {
  if (downloadedBytes !== expectedBytes) {
    throw new Error(
      `downloaded asset bytes ${downloadedBytes} do not match the operator-provided manifest bytes ${expectedBytes}`,
    );
  }
  if (serverBytes !== expectedBytes) {
    throw new Error(
      `release server bytes ${serverBytes ?? "missing"} do not match the operator-provided manifest bytes ${expectedBytes}`,
    );
  }
}

export function selectSingleReleaseAsset(assets, version) {
  const expectedName = `Skill.Repo.Tracker_${version}_aarch64.dmg`;
  const names = Array.isArray(assets)
    ? assets.map((asset) => asset?.name ?? "<unnamed>")
    : [];
  if (names.length !== 1 || names[0] !== expectedName) {
    throw new Error(
      `GitHub Release must contain exactly one asset named ${expectedName}; found ${names.length === 0 ? "none" : names.join(", ")}`,
    );
  }
  return assets[0];
}

export function withCleanWorktreeBoundary(assertClean, buildManifestFields) {
  assertClean();
  return buildManifestFields();
}

export function buildRemoteFetchArguments(version) {
  return [
    "fetch",
    "--prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    `refs/tags/v${version}:refs/tags/v${version}`,
  ];
}

export function validateReleaseHost(platform, architecture) {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new Error(
      `local release verification requires macOS arm64; current host is ${platform}/${architecture}`,
    );
  }
}

export function buildAppCodesignArguments(appPath, entitlementsPath) {
  return [
    "--force",
    "--deep",
    "--options",
    "runtime",
    "--entitlements",
    entitlementsPath,
    "--sign",
    "-",
    appPath,
  ];
}

function cargoExecutable() {
  const candidate = join(process.env.HOME ?? "", ".cargo", "bin", "cargo");
  return existsSync(candidate) ? candidate : "cargo";
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: process.env,
    ...options,
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} does not exist: ${path}`);
  }
}

function assertDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} does not exist: ${path}`);
  }
}

export function assertDmgSourceLayout(stagingRoot) {
  const expectedApp = `${PRODUCT_NAME}.app`;
  const entries = readdirSync(stagingRoot).sort();
  if (entries.length !== 1 || entries[0] !== expectedApp) {
    throw new Error(`DMG source staging must contain only ${expectedApp}`);
  }
  const stagedApp = join(stagingRoot, expectedApp);
  if (!lstatSync(stagedApp).isDirectory()) {
    throw new Error("staged product app must be a real directory");
  }
}

export function validateMountedDmgLayout(mountRoot) {
  const expectedApp = `${PRODUCT_NAME}.app`;
  const allowedEntries = new Set([expectedApp, "Applications", ".DS_Store"]);
  const entries = readdirSync(mountRoot).sort();
  const unexpected = entries.filter((entry) => !allowedEntries.has(entry));
  if (unexpected.length > 0) {
    throw new Error(`mounted DMG has unexpected top-level entries: ${unexpected.join(", ")}`);
  }
  if (!entries.includes(expectedApp)) {
    throw new Error(`mounted DMG is missing ${expectedApp}`);
  }
  const mountedApp = join(mountRoot, expectedApp);
  if (!lstatSync(mountedApp).isDirectory()) {
    throw new Error("mounted product app must be a real directory");
  }
  const applicationsLink = join(mountRoot, "Applications");
  if (!entries.includes("Applications") || !lstatSync(applicationsLink).isSymbolicLink()) {
    throw new Error("Applications must be a symbolic link to /Applications");
  }
  const applicationsTarget = readlinkSync(applicationsLink);
  if (applicationsTarget !== "/Applications") {
    throw new Error(
      `Applications symlink target is ${applicationsTarget}; expected /Applications`,
    );
  }
  if (entries.includes(".DS_Store") && !lstatSync(join(mountRoot, ".DS_Store")).isFile()) {
    throw new Error("mounted DMG .DS_Store must be a regular file when present");
  }
}

function manifestVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

function verifyRequestedVersion(version) {
  run(process.execPath, [join(SCRIPT_DIR, "governance.mjs"), "versions"]);
  if (manifestVersion() !== version) {
    throw new Error(`requested version ${version} does not match manifests (${manifestVersion()})`);
  }
}

function assertCleanWorktree() {
  const status = run("git", ["status", "--porcelain"], { capture: true }).trim();
  if (status) throw new Error("release verification requires a clean worktree");
}

function verifyMountedDmg(dmgPath, version) {
  const mountRoot = mkdtempSync(join(tmpdir(), "srt-release-mount-"));
  const mountedApp = join(mountRoot, `${PRODUCT_NAME}.app`);
  let mounted = false;
  try {
    run("hdiutil", [
      "attach",
      dmgPath,
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountRoot,
    ]);
    mounted = true;
    validateMountedDmgLayout(mountRoot);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", mountedApp]);
    const mountedVersion = run(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print:CFBundleShortVersionString", join(mountedApp, "Contents/Info.plist")],
      { capture: true },
    ).trim();
    if (mountedVersion !== version) {
      throw new Error(`mounted app version is ${mountedVersion}; expected ${version}`);
    }
    const executable = run(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print:CFBundleExecutable", join(mountedApp, "Contents/Info.plist")],
      { capture: true },
    ).trim();
    const architecture = run("file", [join(mountedApp, "Contents/MacOS", executable)], {
      capture: true,
    });
    if (!architecture.includes("arm64")) {
      throw new Error(`mounted app is not Apple Silicon: ${architecture.trim()}`);
    }
  } finally {
    try {
      if (mounted) run("hdiutil", ["detach", mountRoot]);
    } finally {
      rmSync(mountRoot, { recursive: true, force: true });
    }
  }
}

function localPhase(version) {
  validateReleaseHost(process.platform, process.arch);
  assertCleanWorktree();
  run("npm", ["run", "verify"]);
  run("npm", ["run", "coverage:check"]);
  run("npm", ["run", "test:e2e"]);
  run(cargoExecutable(), [
    "+1.88.0",
    "check",
    "--locked",
    "--all-targets",
    "--all-features",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ]);
  run(cargoExecutable(), [
    "test",
    "--release",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "prompt_library_release_performance_gate",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1",
  ]);
  run("npm", ["run", "tauri:build", "--", "--bundles", "app,dmg"]);

  const bundleRoot = join(ROOT, "src-tauri/target/release/bundle");
  const appPath = join(bundleRoot, "macos", `${PRODUCT_NAME}.app`);
  const dmgDirectory = join(bundleRoot, "dmg");
  const dmgPath = join(dmgDirectory, `${PRODUCT_NAME}_${version}_aarch64.dmg`);
  const bundler = join(dmgDirectory, "bundle_dmg.sh");
  const entitlements = join(ROOT, "src-tauri", "entitlements.plist");
  assertDirectory(appPath, "built app");
  assertFile(bundler, "Tauri DMG bundler");
  assertFile(entitlements, "macOS entitlements");

  run("codesign", buildAppCodesignArguments(appPath, entitlements));
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);

  // The DMG produced before the app was re-signed is stale by definition.
  // Stage only the signed product app so adjacent build artifacts can never leak into the DMG.
  const stagingRoot = mkdtempSync(join(tmpdir(), "srt-release-staging-"));
  try {
    const stagedApp = join(stagingRoot, `${PRODUCT_NAME}.app`);
    run("ditto", [appPath, stagedApp]);
    assertDmgSourceLayout(stagingRoot);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", stagedApp]);
    // Remove only the fully resolved expected artifact, then package the staged signed app.
    rmSync(dmgPath, { force: true });
    run("bash", [
      bundler,
      "--volname",
      PRODUCT_NAME,
      "--app-drop-link",
      "380",
      "205",
      dmgPath,
      stagingRoot,
    ]);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  assertFile(dmgPath, "rebuilt DMG");
  run("codesign", ["--force", "--sign", "-", dmgPath]);
  run("codesign", ["--verify", "--verbose=4", dmgPath]);
  run("hdiutil", ["verify", dmgPath]);
  verifyMountedDmg(dmgPath, version);
  // Recheck after every gate and build tool, immediately before binding the manifest fields.
  const { bytes, commit, digest, manifest } = withCleanWorktreeBoundary(
    assertCleanWorktree,
    () => {
      const cleanCommit = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
      const cleanDigest = sha256(dmgPath);
      const cleanBytes = statSync(dmgPath).size;
      return {
        bytes: cleanBytes,
        commit: cleanCommit,
        digest: cleanDigest,
        manifest: buildReleaseManifest({
          version,
          commit: cleanCommit,
          artifact: basename(dmgPath),
          bytes: cleanBytes,
          sha256: cleanDigest,
        }),
      };
    },
  );
  const { manifestPath, tokenPath } = writeReleaseHandoffFiles({
    directory: dmgDirectory,
    manifest,
  });
  for (const line of buildLocalReleaseSummary({
    dmgPath,
    manifestPath,
    tokenPath,
    bytes,
    sha256: digest,
    commit,
  })) {
    console.log(line);
  }
}

function remotePhase(version, manifest) {
  assertCleanWorktree();
  // Refresh exactly the refs validated below. The tag refspec deliberately has
  // no leading `+`: a moved/conflicting release tag must fail closed.
  run("git", buildRemoteFetchArguments(version));
  const head = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
  const remote = run("git", ["rev-parse", "origin/main"], { capture: true }).trim();
  const tag = run("git", ["rev-list", "-n", "1", `v${version}`], { capture: true }).trim();
  const tagType = run("git", ["cat-file", "-t", `v${version}`], { capture: true }).trim();
  if (head !== remote || head !== tag) {
    throw new Error(`commit mismatch: HEAD=${head} origin/main=${remote} tag=${tag}`);
  }
  validateRemoteCommit({ expectedCommit: manifest.commit, releaseCommit: head });
  if (tagType !== "tag") throw new Error(`v${version} is not an annotated tag`);

  const release = JSON.parse(
    run(
      "gh",
      [
        "release",
        "view",
        `v${version}`,
        "--json",
        "tagName,name,url,isDraft,isPrerelease,assets",
      ],
      { capture: true },
    ),
  );
  if (release.tagName !== `v${version}` || release.isDraft || release.isPrerelease) {
    throw new Error("GitHub Release is missing or is not a final release");
  }
  const assetName = `Skill.Repo.Tracker_${version}_aarch64.dmg`;
  const asset = selectSingleReleaseAsset(release.assets, version);

  const downloadRoot = mkdtempSync(join(tmpdir(), "srt-release-download-"));
  try {
    run("gh", [
      "release",
      "download",
      `v${version}`,
      "--pattern",
      assetName,
      "--dir",
      downloadRoot,
    ]);
    const downloaded = join(downloadRoot, assetName);
    assertFile(downloaded, "downloaded GitHub Release asset");
    run("codesign", ["--verify", "--verbose=4", downloaded]);
    run("hdiutil", ["verify", downloaded]);
    verifyMountedDmg(downloaded, version);
    const downloadedSha256 = sha256(downloaded);
    validateRemoteDigest({
      expectedSha256: manifest.sha256,
      serverDigest: asset.digest,
      downloadedSha256,
    });
    validateRemoteBytes({
      expectedBytes: manifest.bytes,
      serverBytes: asset.size,
      downloadedBytes: statSync(downloaded).size,
    });
    const digest = `sha256:${downloadedSha256}`;
    console.log(`PASS release remote artifact ${release.url}`);
    console.log(`digest=${digest}`);
  } finally {
    rmSync(downloadRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseReleaseArguments(process.argv.slice(2));
  verifyRequestedVersion(options.version);
  if (options.phase === "local") localPhase(options.version);
  else remotePhase(options.version, options.manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
