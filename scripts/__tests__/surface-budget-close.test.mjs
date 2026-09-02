import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverRepositorySurface } from "../surface-budget.mjs";
import { writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

test("the Tauri close guard keeps every capability used by the locked SDK wrapper", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-tauri-close-capability-"));
  try {
    writeMinimalSurfaceRepository(root);
    writeFileSync(
      path.join(root, "src/App.tsx"),
      "getCurrentWindow().onCloseRequested(async (event) => { event.preventDefault(); });",
    );
    assert.doesNotThrow(() => discoverRepositorySurface(root));

    const capabilityPath = path.join(root, "src-tauri/capabilities/default.json");
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8"));
    capability.permissions = capability.permissions.filter(
      (permission) => permission !== "core:window:allow-destroy",
    );
    writeFileSync(capabilityPath, JSON.stringify(capability));
    assert.throws(
      () => discoverRepositorySurface(root),
      /onCloseRequested requires.*core:window:allow-destroy/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
