import assert from "node:assert/strict";
import test from "node:test";

import {
  findForbiddenTrackedArtifactPaths,
  findSensitiveTrackedContent,
} from "../module-map.mjs";

test("tracked private inputs and generated product artifacts fail closed", () => {
  assert.deepEqual(
    findForbiddenTrackedArtifactPaths([
      ".env.example",
      ".env",
      "config/.env.local",
      "certs/release.pem",
      "certs/profile.mobileprovision",
      "release/Skill Repo Tracker_1.2.3_aarch64.dmg",
      "release/Skill Repo Tracker.app/Contents/MacOS/app",
      "fixtures/export.srtmigration",
      "Skill Repo Tracker_1.2.3_aarch64.release-id/manifest.json",
      "private/manifest.token",
    ]),
    [
      "tracked environment file is forbidden: .env",
      "tracked environment file is forbidden: config/.env.local",
      "tracked generated product artifact is forbidden: fixtures/export.srtmigration",
      "tracked generated product artifact is forbidden: release/Skill Repo Tracker_1.2.3_aarch64.dmg",
      "tracked generated product artifact is forbidden: release/Skill Repo Tracker.app/Contents/MacOS/app",
      "tracked private release handoff is forbidden: private/manifest.token",
      "tracked private release handoff is forbidden: Skill Repo Tracker_1.2.3_aarch64.release-id/manifest.json",
      "tracked signing or private-key material is forbidden: certs/profile.mobileprovision",
      "tracked signing or private-key material is forbidden: certs/release.pem",
    ],
  );
});

test("probable secrets and real personal home paths are rejected without echoing values", () => {
  const token = ["ghp", "_", "A".repeat(36)].join("");
  const privateKey = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const realHome = ["", "Users", "developer", "project"].join("/");
  const errors = findSensitiveTrackedContent(
    "docs/probe.md",
    [`token=${token}`, privateKey, realHome].join("\n"),
  );
  assert.equal(errors.length, 3);
  assert.ok(errors.some((error) => error.includes("probable GitHub token")));
  assert.ok(errors.some((error) => error.includes("probable private key")));
  assert.ok(errors.some((error) => error.includes("personal home path")));
  assert.ok(errors.every((error) => !error.includes(token)));
});

test("documented fictional personal paths and binary assets are allowed", () => {
  assert.deepEqual(
    findSensitiveTrackedContent(
      "fixtures/paths.txt",
      [
        "/Users/example/project",
        "/Users/source-machine/project",
        "/Users/target-machine/project",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    findSensitiveTrackedContent("docs/image.png", Buffer.from([0, 1, 2, 3])),
    [],
  );
});
