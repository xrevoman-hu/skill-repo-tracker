import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertDmgSourceLayout,
  buildAppCodesignArguments,
  buildLocalReleaseSummary,
  buildReleaseManifest,
  buildRemoteFetchArguments,
  decodeReleaseManifestToken,
  encodeReleaseManifest,
  parseReleaseArguments,
  selectSingleReleaseAsset,
  validateRemoteBytes,
  validateRemoteCommit,
  validateRemoteDigest,
  validateReleaseHost,
  validateMountedDmgLayout,
  withCleanWorktreeBoundary,
  writeReleaseHandoffFiles,
} from "../release-verify.mjs";

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "srt-release-test-"));
  try {
    callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("ad-hoc app signing preserves hardened runtime and the declared entitlements", () => {
  assert.deepEqual(buildAppCodesignArguments("/tmp/App.app", "/repo/entitlements.plist"), [
    "--force",
    "--deep",
    "--options",
    "runtime",
    "--entitlements",
    "/repo/entitlements.plist",
    "--sign",
    "-",
    "/tmp/App.app",
  ]);
});

test("release verifier accepts only the explicit supported contract", () => {
  assert.deepEqual(
    parseReleaseArguments([
      "--lane",
      "adhoc",
      "--version",
      "1.2.2",
      "--phase",
      "local",
    ]),
    {
      lane: "adhoc",
      version: "1.2.2",
      phase: "local",
      manifest: undefined,
    },
  );
});

test("remote verification requires one operator-carried field-binding manifest", () => {
  assert.throws(
    () =>
      parseReleaseArguments([
        "--lane",
        "adhoc",
        "--version",
        "1.2.2",
        "--phase",
        "remote",
      ]),
    /--manifest-token carrying the local artifact fields is required/,
  );
  const manifest = buildReleaseManifest({
    version: "1.2.2",
    commit: "b".repeat(40),
    artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
    bytes: 42,
    sha256: "a".repeat(64),
  });
  const token = encodeReleaseManifest(manifest);
  assert.deepEqual(
    parseReleaseArguments([
      "--lane",
      "adhoc",
      "--version",
      "1.2.2",
      "--phase",
      "remote",
      "--manifest-token",
      token,
    ]),
    {
      lane: "adhoc",
      version: "1.2.2",
      phase: "remote",
      manifest,
    },
  );
  assert.deepEqual(decodeReleaseManifestToken(token, "1.2.2"), manifest);
  assert.throws(
    () => decodeReleaseManifestToken(token, "1.2.3"),
    /does not match requested version/,
  );
});

test("operator-carried manifest and remote digest form one artifact identity chain", () => {
  assert.deepEqual(
    buildReleaseManifest({
      version: "1.2.2",
      commit: "a".repeat(40),
      artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
      bytes: 42,
      sha256: "b".repeat(64),
    }),
    {
      schemaVersion: 1,
      lane: "adhoc",
      version: "1.2.2",
      commit: "a".repeat(40),
      artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
      bytes: 42,
      sha256: "b".repeat(64),
    },
  );
  assert.doesNotThrow(() =>
    validateRemoteCommit({
      expectedCommit: "a".repeat(40),
      releaseCommit: "a".repeat(40),
    }),
  );
  assert.throws(
    () =>
      validateRemoteCommit({
        expectedCommit: "a".repeat(40),
        releaseCommit: "b".repeat(40),
      }),
    /does not match the operator-provided manifest commit/,
  );
  assert.doesNotThrow(() =>
    validateRemoteDigest({
      expectedSha256: "b".repeat(64),
      serverDigest: `sha256:${"b".repeat(64)}`,
      downloadedSha256: "b".repeat(64),
    }),
  );
  assert.throws(
    () =>
      validateRemoteDigest({
        expectedSha256: "b".repeat(64),
        serverDigest: `sha256:${"c".repeat(64)}`,
        downloadedSha256: "c".repeat(64),
      }),
    /does not match the operator-provided manifest SHA-256/,
  );
  assert.doesNotThrow(() =>
    validateRemoteBytes({ expectedBytes: 42, serverBytes: 42, downloadedBytes: 42 }),
  );
  assert.throws(
    () => validateRemoteBytes({ expectedBytes: 42, serverBytes: 42, downloadedBytes: 43 }),
    /downloaded asset bytes 43 do not match the operator-provided manifest bytes 42/,
  );
});

test("local release handoff stores both manifest representations as 0600 files", () => {
  withTemporaryDirectory((directory) => {
    const manifest = buildReleaseManifest({
      version: "1.2.2",
      commit: "a".repeat(40),
      artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
      bytes: 42,
      sha256: "b".repeat(64),
    });

    const handoff = writeReleaseHandoffFiles({ directory, manifest });

    assert.equal(statSync(handoff.manifestPath).mode & 0o777, 0o600);
    assert.equal(statSync(handoff.tokenPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(handoff.manifestPath, "utf8")), manifest);
    assert.deepEqual(
      decodeReleaseManifestToken(readFileSync(handoff.tokenPath, "utf8").trim(), "1.2.2"),
      manifest,
    );
  });
});

test("local release summary exposes only the private token file path", () => {
  const lines = buildLocalReleaseSummary({
    dmgPath: "/tmp/Skill Repo Tracker_1.2.2_aarch64.dmg",
    manifestPath: "/tmp/Skill Repo Tracker_1.2.2_aarch64.release.json",
    tokenPath: "/tmp/Skill Repo Tracker_1.2.2_aarch64.release.token",
    bytes: 42,
    sha256: "b".repeat(64),
    commit: "a".repeat(40),
  });

  assert.deepEqual(lines, [
    "PASS release local artifact",
    "path=/tmp/Skill Repo Tracker_1.2.2_aarch64.dmg",
    "manifest=/tmp/Skill Repo Tracker_1.2.2_aarch64.release.json",
    "manifestTokenFile=/tmp/Skill Repo Tracker_1.2.2_aarch64.release.token",
    "bytes=42",
    `sha256=${"b".repeat(64)}`,
    `commit=${"a".repeat(40)}`,
  ]);
  assert.ok(lines.every((line) => !line.startsWith("manifestToken=")));
});

test("top-level release errors never echo an operator-carried manifest token", () => {
  const token = Buffer.from("SRT_RELEASE_TOKEN_SENTINEL", "utf8").toString("base64url");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../release-verify.mjs", import.meta.url)),
      "--lane",
      "adhoc",
      "--version",
      "1.2.2",
      "--phase",
      "remote",
      "--manifest-token",
      token,
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
});

test("remote verification accepts exactly one public DMG asset", () => {
  const expected = {
    name: "Skill.Repo.Tracker_1.2.2_aarch64.dmg",
    size: 42,
    digest: `sha256:${"b".repeat(64)}`,
  };
  assert.equal(selectSingleReleaseAsset([expected], "1.2.2"), expected);
  assert.throws(
    () => selectSingleReleaseAsset([], "1.2.2"),
    /must contain exactly one asset named Skill\.Repo\.Tracker_1\.2\.2_aarch64\.dmg; found none/,
  );
  assert.throws(
    () => selectSingleReleaseAsset([expected, { name: "unexpected.sha256" }], "1.2.2"),
    /found Skill\.Repo\.Tracker_1\.2\.2_aarch64\.dmg, unexpected\.sha256/,
  );
  assert.throws(
    () => selectSingleReleaseAsset([{ name: "wrong.dmg" }], "1.2.2"),
    /found wrong\.dmg/,
  );
});

test("manifest fields are bound only after the final clean-worktree check", () => {
  const calls = [];
  const result = withCleanWorktreeBoundary(
    () => calls.push("clean"),
    () => {
      calls.push("manifest");
      return "bound";
    },
  );
  assert.equal(result, "bound");
  assert.deepEqual(calls, ["clean", "manifest"]);

  assert.throws(
    () =>
      withCleanWorktreeBoundary(
        () => {
          throw new Error("dirty");
        },
        () => calls.push("must not run"),
      ),
    /dirty/,
  );
  assert.deepEqual(calls, ["clean", "manifest"]);
});

test("release verifier fails closed for unsupported lanes", () => {
  assert.throws(
    () =>
      parseReleaseArguments([
        "--lane",
        "notarized",
        "--version",
        "1.2.2",
        "--phase",
        "local",
      ]),
    /--lane must be adhoc/,
  );
});

test("release verifier requires a stable semver and phase", () => {
  assert.throws(
    () => parseReleaseArguments(["--lane", "adhoc", "--version", "latest"]),
    /--version must be an explicit stable semver/,
  );
});

test("remote verification fetches fresh main and tag into explicit destinations", () => {
  assert.deepEqual(buildRemoteFetchArguments("1.2.2"), [
    "fetch",
    "--prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "refs/tags/v1.2.2:refs/tags/v1.2.2",
  ]);
});

test("local release verification accepts only Apple Silicon macOS hosts", () => {
  assert.doesNotThrow(() => validateReleaseHost("darwin", "arm64"));
  assert.throws(
    () => validateReleaseHost("darwin", "x64"),
    /local release verification requires macOS arm64; current host is darwin\/x64/,
  );
  assert.throws(
    () => validateReleaseHost("linux", "arm64"),
    /local release verification requires macOS arm64; current host is linux\/arm64/,
  );
});

test("DMG source staging contains exactly one real product app", () => {
  withTemporaryDirectory((directory) => {
    mkdirSync(join(directory, "Skill Repo Tracker.app"));
    assert.doesNotThrow(() => assertDmgSourceLayout(directory));

    writeFileSync(join(directory, "unexpected.txt"), "not part of the release\n");
    assert.throws(
      () => assertDmgSourceLayout(directory),
      /DMG source staging must contain only Skill Repo Tracker\.app/,
    );
  });
});

test("DMG source staging rejects an app symlink", () => {
  withTemporaryDirectory((directory) => {
    symlinkSync(directory, join(directory, "Skill Repo Tracker.app"));
    assert.throws(
      () => assertDmgSourceLayout(directory),
      /staged product app must be a real directory/,
    );
  });
});

test("mounted DMG accepts only the product app, exact Applications link, and Finder metadata", () => {
  withTemporaryDirectory((directory) => {
    mkdirSync(join(directory, "Skill Repo Tracker.app"));
    symlinkSync("/Applications", join(directory, "Applications"));
    writeFileSync(join(directory, ".DS_Store"), "fixture");
    assert.doesNotThrow(() => validateMountedDmgLayout(directory));

    writeFileSync(join(directory, "README.txt"), "unexpected\n");
    assert.throws(
      () => validateMountedDmgLayout(directory),
      /mounted DMG has unexpected top-level entries: README\.txt/,
    );
  });
});

test("mounted DMG requires Applications to be the exact /Applications symlink", () => {
  withTemporaryDirectory((directory) => {
    mkdirSync(join(directory, "Skill Repo Tracker.app"));
    mkdirSync(join(directory, "Applications"));
    assert.throws(
      () => validateMountedDmgLayout(directory),
      /Applications must be a symbolic link to \/Applications/,
    );
  });

  withTemporaryDirectory((directory) => {
    mkdirSync(join(directory, "Skill Repo Tracker.app"));
    symlinkSync("/tmp", join(directory, "Applications"));
    assert.throws(
      () => validateMountedDmgLayout(directory),
      /Applications symlink target is \/tmp; expected \/Applications/,
    );
  });
});
