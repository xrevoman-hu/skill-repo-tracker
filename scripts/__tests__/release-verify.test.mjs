import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertDmgSourceLayout,
  buildAppCodesignArguments,
  buildLocalReleaseSummary,
  buildLocalMainFetchArguments,
  buildReleaseManifest,
  buildRemoteFetchArguments,
  decodeReleaseManifestToken,
  encodeReleaseManifest,
  parseReleaseArguments,
  selectSingleReleaseAsset,
  validateRemoteBytes,
  validateRemoteCommit,
  validateRemoteDigest,
  validateFinalReleaseMetadata,
  validateLocalReleaseSource,
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

function releaseGenerationId(manifest) {
  return createHash("sha256").update(encodeReleaseManifest(manifest)).digest("hex");
}

function isolatedGitEnvironment() {
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete environment.GIT_CONFIG;
  delete environment.GIT_CONFIG_COUNT;
  delete environment.GIT_CONFIG_PARAMETERS;
  for (const name of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete environment[name];
  }
  return environment;
}

function spawnGit(directory, args) {
  return spawnSync(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: isolatedGitEnvironment(),
    },
  );
}

function runGit(directory, args) {
  const result = spawnGit(directory, args);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
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

test("local release handoff publishes both files through one immutable generation directory", () => {
  withTemporaryDirectory((directory) => {
    const manifest = buildReleaseManifest({
      version: "1.2.2",
      commit: "a".repeat(40),
      artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
      bytes: 42,
      sha256: "b".repeat(64),
    });
    const handoff = writeReleaseHandoffFiles({ directory, manifest });

    const generationDirectory = dirname(handoff.manifestPath);
    assert.equal(dirname(handoff.tokenPath), generationDirectory);
    assert.notEqual(generationDirectory, directory);
    assert.equal(
      basename(generationDirectory),
      `Skill Repo Tracker_1.2.2_aarch64.release-${releaseGenerationId(manifest)}`,
    );
    assert.equal(basename(handoff.manifestPath), "manifest.json");
    assert.equal(basename(handoff.tokenPath), "manifest.token");
    assert.equal(lstatSync(generationDirectory).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(generationDirectory).sort(), ["manifest.json", "manifest.token"]);
  });
});

test("local release handoff reuses only an exact immutable generation", () => {
  withTemporaryDirectory((directory) => {
    const manifest = buildReleaseManifest({
      version: "1.2.2",
      commit: "a".repeat(40),
      artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
      bytes: 42,
      sha256: "b".repeat(64),
    });
    const first = writeReleaseHandoffFiles({ directory, manifest });
    const firstManifest = statSync(first.manifestPath);
    const firstToken = statSync(first.tokenPath);
    const second = writeReleaseHandoffFiles({ directory, manifest });

    assert.deepEqual(second, first);
    assert.deepEqual(
      [statSync(second.manifestPath).dev, statSync(second.manifestPath).ino],
      [firstManifest.dev, firstManifest.ino],
    );
    assert.deepEqual(
      [statSync(second.tokenPath).dev, statSync(second.tokenPath).ino],
      [firstToken.dev, firstToken.ino],
    );
  });
});

test("local release handoff rejects a non-private pre-existing generation without mutation", () => {
  withTemporaryDirectory((directory) => {
    const manifest = buildReleaseManifest({
      version: "1.2.2",
      commit: "a".repeat(40),
      artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
      bytes: 42,
      sha256: "b".repeat(64),
    });
    const generationDirectory = join(
      directory,
      `Skill Repo Tracker_1.2.2_aarch64.release-${releaseGenerationId(manifest)}`,
    );
    mkdirSync(generationDirectory, { mode: 0o700 });
    const manifestPath = join(generationDirectory, "manifest.json");
    const tokenPath = join(generationDirectory, "manifest.token");
    writeFileSync(manifestPath, "stale manifest\n", { mode: 0o644 });
    writeFileSync(tokenPath, "stale token\n", { mode: 0o644 });

    assert.throws(() => writeReleaseHandoffFiles({ directory, manifest }));

    assert.equal(readFileSync(manifestPath, "utf8"), "stale manifest\n");
    assert.equal(readFileSync(tokenPath, "utf8"), "stale token\n");
    assert.deepEqual(
      readdirSync(directory).filter((entry) => entry.startsWith(".srt-release-handoff-")),
      [],
    );
  });
});

test("local release handoff rejects a symlink generation without touching its target", () => {
  withTemporaryDirectory((directory) => {
    const manifest = buildReleaseManifest({
      version: "1.2.2",
      commit: "a".repeat(40),
      artifact: "Skill Repo Tracker_1.2.2_aarch64.dmg",
      bytes: 42,
      sha256: "b".repeat(64),
    });
    const targetDirectory = join(directory, "untrusted-target");
    mkdirSync(targetDirectory, { mode: 0o700 });
    const generationDirectory = join(
      directory,
      `Skill Repo Tracker_1.2.2_aarch64.release-${releaseGenerationId(manifest)}`,
    );
    symlinkSync(targetDirectory, generationDirectory);

    assert.throws(
      () => writeReleaseHandoffFiles({ directory, manifest }),
      /private directory/,
    );

    assert.deepEqual(readdirSync(targetDirectory), []);
    assert.ok(lstatSync(generationDirectory).isSymbolicLink());
    assert.deepEqual(
      readdirSync(directory).filter((entry) => entry.startsWith(".srt-release-handoff-")),
      [],
    );
  });
});

test("local release summary exposes only the private token file path", () => {
  const lines = buildLocalReleaseSummary({
    dmgPath: "/tmp/Skill Repo Tracker_1.2.2_aarch64.dmg",
    manifestPath: "/tmp/Skill Repo Tracker_1.2.2_aarch64.release-id/manifest.json",
    tokenPath: "/tmp/Skill Repo Tracker_1.2.2_aarch64.release-id/manifest.token",
    bytes: 42,
    sha256: "b".repeat(64),
    commit: "a".repeat(40),
  });

  assert.deepEqual(lines, [
    "PASS release local artifact",
    "path=/tmp/Skill Repo Tracker_1.2.2_aarch64.dmg",
    "manifest=/tmp/Skill Repo Tracker_1.2.2_aarch64.release-id/manifest.json",
    "manifestTokenFile=/tmp/Skill Repo Tracker_1.2.2_aarch64.release-id/manifest.token",
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
    "--no-tags",
    "--prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "refs/tags/v1.2.2:refs/tags/_srt-release-remote/v1.2.2",
  ]);
});

test("local verification binds the build to fresh main before any artifact exists", () => {
  assert.deepEqual(buildLocalMainFetchArguments(), [
    "fetch",
    "--no-tags",
    "--prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  assert.doesNotThrow(() =>
    validateLocalReleaseSource({
      version: "1.2.3",
      head: "a".repeat(40),
      remoteMain: "a".repeat(40),
      remoteTagOutput: "",
    }),
  );
  assert.throws(
    () =>
      validateLocalReleaseSource({
        version: "1.2.3",
        head: "a".repeat(40),
        remoteMain: "b".repeat(40),
        remoteTagOutput: "",
      }),
    /must equal fresh origin\/main/,
  );
  assert.throws(
    () =>
      validateLocalReleaseSource({
        version: "1.2.3",
        head: "a".repeat(40),
        remoteMain: "a".repeat(40),
        remoteTagOutput: `${"c".repeat(40)}\trefs/tags/v1.2.3\n`,
      }),
    /remote tag v1\.2\.3 already exists/,
  );
});

test("remote verification requires the exact final release title", () => {
  const body = [
    "## 中文",
    "ad-hoc；不是 Developer ID，也没有 notarized。首次启动请 Control-click。",
    "## English",
    "Privacy & Security; ad-hoc, not Developer ID, not notarized; Control-click.",
  ].join("\n");
  const release = {
    tagName: "v1.2.3",
    name: "Skill Repo Tracker v1.2.3",
    isDraft: false,
    isPrerelease: false,
    body,
  };
  assert.doesNotThrow(() => validateFinalReleaseMetadata(release, "1.2.3", body));
  assert.throws(
    () => validateFinalReleaseMetadata({ ...release, name: "Almost v1.2.3" }, "1.2.3", body),
    /title Skill Repo Tracker v1\.2\.3/,
  );
  assert.throws(
    () => validateFinalReleaseMetadata({ ...release, isDraft: true }, "1.2.3", body),
    /must be final/,
  );
  assert.throws(
    () => validateFinalReleaseMetadata({ ...release, body: "" }, "1.2.3", body),
    /must exactly match docs\/releases\/v1\.2\.3\.md/,
  );
});

test("release phases call the source and metadata validators at their acceptance boundaries", () => {
  const source = readFileSync(new URL("../release-verify.mjs", import.meta.url), "utf8");
  const localPhase = source.slice(
    source.indexOf("function localPhase(version)"),
    source.indexOf("function remotePhase(version, manifest)"),
  );
  assert.equal(localPhase.match(/assertLocalReleaseSource\(version\)/g)?.length, 2);
  assert.ok(localPhase.indexOf("assertLocalReleaseSource(version)") < localPhase.indexOf('run("npm", ["run", "verify"])'));

  const remotePhase = source.slice(source.indexOf("function remotePhase(version, manifest)"));
  assert.equal(remotePhase.match(/validateFinalReleaseMetadata\(release, version,/g)?.length, 1);
  assert.ok(
    remotePhase.indexOf("validateFinalReleaseMetadata(release, version,") <
      remotePhase.indexOf("selectSingleReleaseAsset(release.assets, version)"),
  );
});

test("remote verification isolates the authoritative annotated tag and rejects rewrites", (t) => {
  withTemporaryDirectory((directory) => {
    const remote = join(directory, "remote.git");
    const publisher = join(directory, "publisher");
    const verifier = join(directory, "verifier");
    const hostileHooks = join(directory, "hostile-hooks");
    const hostileGitConfig = join(directory, "hostile.gitconfig");
    const version = "1.2.2";
    const publicTag = `refs/tags/v${version}`;
    const verifierTag = `refs/tags/_srt-release-remote/v${version}`;

    mkdirSync(hostileHooks);
    writeFileSync(join(hostileHooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hostileHooks, "pre-commit"), 0o755);
    writeFileSync(
      hostileGitConfig,
      `[commit]\n\tgpgSign = true\n[tag]\n\tgpgSign = true\n[core]\n\thooksPath = ${hostileHooks}\n`,
    );
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostileGitConfig;
    t.after(() => {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    });

    runGit(directory, ["init", "--bare", remote]);
    mkdirSync(publisher);
    runGit(publisher, ["init"]);
    runGit(publisher, ["config", "user.name", "Release Test"]);
    runGit(publisher, ["config", "user.email", "release-test@example.invalid"]);
    writeFileSync(join(publisher, "release.txt"), "release fixture\n");
    runGit(publisher, ["add", "release.txt"]);
    runGit(publisher, ["commit", "-m", "release fixture"]);
    runGit(publisher, ["branch", "-M", "main"]);
    const releaseCommit = runGit(publisher, ["rev-parse", "HEAD"]);
    runGit(publisher, ["tag", "-a", `v${version}`, "-m", "original release tag"]);
    runGit(publisher, ["remote", "add", "origin", remote]);
    runGit(publisher, ["push", "origin", "main", publicTag]);

    mkdirSync(verifier);
    runGit(verifier, ["init"]);
    runGit(verifier, ["remote", "add", "origin", remote]);
    runGit(verifier, ["fetch", "--no-tags", "origin", "main"]);
    runGit(verifier, ["checkout", "-b", "main", "FETCH_HEAD"]);
    // Simulate actions/checkout replacing the annotated public tag with a
    // lightweight tag at the checked-out commit.
    runGit(verifier, ["tag", `v${version}`, releaseCommit]);
    assert.equal(runGit(verifier, ["cat-file", "-t", publicTag]), "commit");

    runGit(verifier, buildRemoteFetchArguments(version));

    assert.equal(runGit(verifier, ["cat-file", "-t", publicTag]), "commit");
    assert.equal(runGit(verifier, ["cat-file", "-t", verifierTag]), "tag");
    assert.equal(runGit(verifier, ["rev-parse", `${verifierTag}^{commit}`]), releaseCommit);
    const originalVerifierTagObject = runGit(verifier, ["rev-parse", verifierTag]);

    runGit(publisher, [
      "tag",
      "-f",
      "-a",
      `v${version}`,
      "-m",
      "rewritten release tag object",
      releaseCommit,
    ]);
    runGit(publisher, ["push", "--force", "origin", publicTag]);

    const rejected = spawnGit(verifier, buildRemoteFetchArguments(version));
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /would clobber existing tag|rejected/);
    assert.equal(runGit(verifier, ["rev-parse", verifierTag]), originalVerifierTagObject);
    assert.equal(runGit(verifier, ["cat-file", "-t", publicTag]), "commit");
  });
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
