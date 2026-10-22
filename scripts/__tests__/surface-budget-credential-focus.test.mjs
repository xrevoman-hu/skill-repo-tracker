import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRepositorySurface } from "../surface-budget.mjs";
import { writeMinimalSurfaceRepository } from "./surface-budget-fixtures.mjs";

const reviewed = `import { listen } from "@tauri-apps/api/event";
export const api = {
  onCredentialBlur: (handler: () => void) =>
    listen("tauri://blur", handler, { target: { kind: "Window", label: "main" } }),
};`;

function repository(run) {
  const root = mkdtempSync(path.join(tmpdir(), "srt-credential-focus-surface-"));
  try {
    // No onCloseRequested: the credential adapter must establish its own requirements.
    writeMinimalSurfaceRepository(root);
    writeFileSync(path.join(root, "src/api.ts"), reviewed);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("only the fixed credential native-blur adapter is admitted with the existing event capabilities", () => {
  repository((root) => {
    const surface = discoverRepositorySurface(root);
    assert.ok(surface.capabilityPermissions.includes(
      "src-tauri/capabilities/default.json#default:permission=core:event:allow-listen",
    ));
    assert.deepEqual(surface.timerCalls, []);
    assert.deepEqual(surface.recurringTimers, []);
  });
});

test("the credential blur adapter independently requires both listener lifecycle capabilities", () => {
  for (const missing of ["core:event:allow-listen", "core:event:allow-unlisten"]) {
    repository((root) => {
      const file = path.join(root, "src-tauri/capabilities/default.json");
      const capability = JSON.parse(readFileSync(file, "utf8"));
      capability.permissions = capability.permissions.filter((permission) => permission !== missing);
      writeFileSync(file, JSON.stringify(capability));
      assert.throws(() => discoverRepositorySurface(root), /credential blur requires.*core:event:allow-/);
    });
  }
});

test("credential event and target cannot broaden, become dynamic, or gain hidden options", () => {
  const mutations = [
    reviewed.replace('"tauri://blur"', '"secret-channel"'),
    reviewed.replace('"tauri://blur"', "eventName"),
    reviewed.replace('"tauri://blur"', '`tauri://${kind}`'),
    reviewed.replace('{ target: { kind: "Window", label: "main" } }', '{}'),
    reviewed.replace('{ target: { kind: "Window", label: "main" } }', 'undefined'),
    reviewed.replace(', { target: { kind: "Window", label: "main" } }', ''),
    reviewed.replace('{ target: { kind: "Window", label: "main" } }', '{ target: "main" }'),
    reviewed.replace('{ target: { kind: "Window", label: "main" } }', '{ target: { kind: "Any" } }'),
    reviewed.replace('kind: "Window"', 'kind: "AnyLabel"'),
    reviewed.replace('kind: "Window"', 'kind: "WebviewWindow"'),
    reviewed.replace('label: "main"', 'label: "other"'),
    reviewed.replace('label: "main"', 'label: currentLabel'),
    reviewed.replace('label: "main"', 'label: "main", extra: true'),
    reviewed.replace('label: "main"', 'label: "main", ...extra'),
    reviewed.replace('target: {', 'target: target || {'),
    reviewed.replace('target: {', '["target"]: {'),
    reviewed.replace('label: "main"', '["label"]: "main"'),
    reviewed.replace('label: "main"', 'label: "main", label: "other"'),
    reviewed.replace('kind: "Window"', 'kind: "Window", ...options'),
    reviewed.replace('} }),', '} }, extra),'),
    reviewed.replace('"tauri://blur", handler', '"tauri://blur", anotherHandler'),
  ];
  repository((root) => {
    for (const source of mutations) {
      writeFileSync(path.join(root, "src/api.ts"), source);
      assert.throws(() => discoverRepositorySurface(root), /Tauri listen may only|cannot be parsed/, source);
    }
  });
});

test("the event import cannot be aliased, re-exported, shadowed, or used as a generic function", () => {
  const mutations = [
    reviewed.replace('{ listen }', '{ listen as subscribe }').replace('    listen(', '    subscribe('),
    reviewed.replace('{ listen }', '* as events').replace('    listen(', '    events.listen('),
    reviewed.replace('{ listen }', 'eventApi, { listen }'),
    reviewed.replace('{ listen }', '{ type listen }'),
    reviewed.replace('import { listen }', 'import type { listen }'),
    reviewed.replace('{ listen }', '{ listen, emit }'),
    reviewed.replace('    listen(', '    listen?.('),
    reviewed.replace('    listen(', '    listen.call(null, '),
    reviewed + '\nexport { listen };',
    reviewed + '\nconst subscribe = listen;',
    reviewed + '\nfunction hidden(listen) { return listen; }',
    reviewed + '\nlisten("tauri://blur", handler, { target: { kind: "Window", label: "main" } });',
    reviewed + '\nexport { listen } from "@tauri-apps/api/event";',
    reviewed + '\nconst events = await import("@tauri-apps/api/event");',
    reviewed + '\nconst events = require("@tauri-apps/api/event");',
    reviewed.replace('onCredentialBlur:', 'otherAdapter:'),
    reviewed.replace('export const api', 'const api'),
    reviewed.replace('export const api', 'export let api'),
    reviewed.replace('export const api', 'export const otherApi'),
    reviewed.replace('onCredentialBlur: (handler: () => void) =>', 'onCredentialBlur: async (handler: () => void) =>'),
    reviewed.replace('onCredentialBlur: (handler: () => void) =>', 'onCredentialBlur: (handler: () => void, hidden: unknown) =>'),
    reviewed.replace('onCredentialBlur: (handler: () => void) =>', 'onCredentialBlur: (handler = fallback) =>'),
    reviewed.replace('\n};', '\n  onCredentialBlur: unrelated,\n};'),
    reviewed.replace('\n};', '\n  ...otherApi,\n};'),
    reviewed.replace('import { listen } from "@tauri-apps/api/event";', ''),
    'import { listen } from "@tauri-apps/api/event";',
  ];
  repository((root) => {
    for (const source of mutations) {
      writeFileSync(path.join(root, "src/api.ts"), source);
      assert.throws(() => discoverRepositorySurface(root), /Tauri|reviewed .* import/, source);
    }
  });
});

test("computed API members cannot overwrite the fixed credential blur subscription", () => {
  repository((root) => {
    const source = 'const key: string = ["onCredential", "Blur"].join("");\n' +
      reviewed.replace('\n};', '\n  [key]: async (_handler: () => void) => () => {},\n};');
    writeFileSync(path.join(root, "src/api.ts"), source);
    assert.throws(
      () => discoverRepositorySurface(root),
      /Tauri listen may only be the exact api\.onCredentialBlur adapter/,
    );
  });
});

test("the fixed adapter cannot move into a view or coexist with a second raw event call", () => {
  repository((root) => {
    writeFileSync(path.join(root, "src/App.tsx"), reviewed);
    assert.throws(() => discoverRepositorySurface(root), /reviewed listen import in src\/api.ts/);
    writeFileSync(path.join(root, "src/App.tsx"), 'import { listen } from "@tauri-apps/api/event"; listen("tauri://blur", callback);');
    assert.throws(() => discoverRepositorySurface(root), /reviewed listen import in src\/api.ts/);
  });
});
