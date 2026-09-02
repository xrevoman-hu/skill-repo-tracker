import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkRepositorySurfaceBudget,
  compareSurfaceBudgets,
  discoverRepositorySurface,
  validateSurfaceBudget,
} from "../surface-budget.mjs";
import {
  emptyCategories,
  expectedTauriSecurity,
  minimalTauriConfig,
  writeMinimalSurfaceRepository,
} from "./surface-budget-fixtures.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("an unregistered production surface fails closed", () => {
  const budget = { schemaVersion: 1, categories: emptyCategories() };
  const actual = emptyCategories();
  actual.tauriCommands.push("new_privileged_command");

  assert.deepEqual(validateSurfaceBudget({ budget, actual }), [
    "unregistered tauriCommands surface: new_privileged_command",
  ]);
});

test("active surfaces cannot disappear without an explicit retirement", () => {
  const categories = emptyCategories();
  categories.tauriCommands.push({
    id: "get_settings",
    status: "active",
    purpose: "Read the local settings contract.",
  });

  assert.deepEqual(
    validateSurfaceBudget({
      budget: { schemaVersion: 1, categories },
      actual: emptyCategories(),
    }),
    ["active tauriCommands surface is missing from source: get_settings"],
  );
});

test("retiring surfaces may coexist with or leave source, but require a reason", () => {
  const categories = emptyCategories();
  categories.settingsFields.push({
    id: "UpdateSettingsRequest.legacyOption",
    status: "retiring",
    purpose: "Previously accepted a legacy preference.",
    retirementReason: "The preference never affected product behavior.",
  });
  assert.deepEqual(
    validateSurfaceBudget({
      budget: { schemaVersion: 1, categories },
      actual: emptyCategories(),
    }),
    [],
  );

  delete categories.settingsFields[0].retirementReason;
  assert.deepEqual(
    validateSurfaceBudget({
      budget: { schemaVersion: 1, categories },
      actual: emptyCategories(),
    }),
    [
      "retiring settingsFields surface UpdateSettingsRequest.legacyOption requires retirementReason",
    ],
  );
});

test("the base comparison requires a recorded retirement before removal", () => {
  const baseCategories = emptyCategories();
  baseCategories.capabilityPermissions.push({
    id: "dialog:default",
    status: "active",
    purpose: "Let the user choose an import or tool directory.",
  });
  const base = { schemaVersion: 1, categories: baseCategories };

  assert.deepEqual(
    compareSurfaceBudgets({ schemaVersion: 1, categories: emptyCategories() }, base),
    [
      "active capabilityPermissions surface was removed without first being marked retiring: dialog:default",
    ],
  );

  const retiringCategories = emptyCategories();
  retiringCategories.capabilityPermissions.push({
    ...baseCategories.capabilityPermissions[0],
    status: "retiring",
    retirementReason: "The last dialog consumer moved to a bounded backend intent.",
  });
  assert.deepEqual(
    compareSurfaceBudgets({ schemaVersion: 1, categories: retiringCategories }, base),
    [],
  );
  assert.deepEqual(
    compareSurfaceBudgets(
      { schemaVersion: 1, categories: emptyCategories() },
      { schemaVersion: 1, categories: retiringCategories },
    ),
    [],
  );

  const reactivatedCategories = structuredClone(retiringCategories);
  reactivatedCategories.capabilityPermissions[0].status = "active";
  delete reactivatedCategories.capabilityPermissions[0].retirementReason;
  assert.deepEqual(
    compareSurfaceBudgets(
      { schemaVersion: 1, categories: reactivatedCategories },
      { schemaVersion: 1, categories: retiringCategories },
    ),
    [
      "retiring capabilityPermissions surface cannot return to active: dialog:default",
    ],
  );

  const rewrittenRetirement = structuredClone(retiringCategories);
  rewrittenRetirement.capabilityPermissions[0].purpose = "Rewritten after retirement.";
  rewrittenRetirement.capabilityPermissions[0].retirementReason = "A different history.";
  assert.deepEqual(
    compareSurfaceBudgets(
      { schemaVersion: 1, categories: rewrittenRetirement },
      { schemaVersion: 1, categories: retiringCategories },
    ),
    [
      "retiring capabilityPermissions surface purpose changed in place: dialog:default",
    ],
  );

  const rewrittenReason = structuredClone(retiringCategories);
  rewrittenReason.capabilityPermissions[0].retirementReason = "A different history.";
  assert.deepEqual(
    compareSurfaceBudgets(
      { schemaVersion: 1, categories: rewrittenReason },
      { schemaVersion: 1, categories: retiringCategories },
    ),
    [
      "retiring capabilityPermissions surface retirementReason changed in place: dialog:default",
    ],
  );
});

test("new surfaces start active and active semantics cannot be rewritten in place", () => {
  const baseCategories = emptyCategories();
  baseCategories.recurringTimers.push({
    id: "src/App.tsx:createForegroundSchedule:runScheduledCheck",
    status: "active",
    purpose: "Foreground-only repository check schedule.",
  });
  const base = { schemaVersion: 1, categories: baseCategories };

  const currentCategories = structuredClone(baseCategories);
  currentCategories.recurringTimers[0].purpose = "A broader background polling loop.";
  currentCategories.recurringTimers.push({
    id: "src/App.tsx:createForegroundSchedule:newSchedule",
    status: "retiring",
    purpose: "A surface cannot be born retired.",
    retirementReason: "It should never have shipped.",
  });

  assert.deepEqual(
    compareSurfaceBudgets({ schemaVersion: 1, categories: currentCategories }, base),
    [
      "active recurringTimers surface purpose changed in place: src/App.tsx:createForegroundSchedule:runScheduledCheck",
      "new recurringTimers surface must start active: src/App.tsx:createForegroundSchedule:newSchedule",
    ],
  );
});

test("malformed or duplicate budget entries fail closed", () => {
  const categories = emptyCategories();
  categories.externalHosts.push(
    { id: "https://api.github.com", status: "active", purpose: "" },
    {
      id: "https://api.github.com",
      status: "future",
      purpose: "A duplicate must not hide a malformed declaration.",
    },
  );
  categories.unknownSurface = [];
  const actual = emptyCategories();
  actual.externalHosts.push("https://api.github.com");

  assert.deepEqual(
    validateSurfaceBudget({ budget: { schemaVersion: 2, categories }, actual }),
    [
      "surface budget schemaVersion must be 1; found 2",
      "unknown surface budget category: unknownSurface",
      "active externalHosts surface https://api.github.com requires purpose",
      "duplicate externalHosts surface: https://api.github.com",
      "externalHosts surface https://api.github.com has invalid status: future",
    ],
  );
});

test("Cargo direct dependency identity, source, and features are explicit surfaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-cargo-surface-"));
  try {
    writeMinimalSurfaceRepository(root);
    const manifestPath = path.join(root, "src-tauri/Cargo.toml");
    const manifest = (version, extra = "") => `[package]
name = "fixture"
version = "0.0.0"
[dependencies]
reqwest = { version = "${version}", default-features = false, features = ["json", "rustls-tls"] }
${extra}`;
    writeFileSync(manifestPath, manifest("0.12"));
    const baseline = discoverRepositorySurface(root).rustDependencies;
    assert.equal(baseline.length, 1);
    assert.match(baseline[0], /^normal:reqwest=/);

    writeFileSync(manifestPath, manifest("0.13"));
    assert.deepEqual(discoverRepositorySurface(root).rustDependencies, baseline);

    const categories = emptyCategories();
    categories.rustDependencies = baseline.map((id) => ({
      id,
      status: "active",
      purpose: "Test production dependency contract.",
    }));
    writeFileSync(manifestPath, manifest("0.13", 'attohttpc = "0.30"'));
    const widened = emptyCategories();
    widened.rustDependencies = discoverRepositorySurface(root).rustDependencies;
    assert.ok(
      validateSurfaceBudget({
        budget: { schemaVersion: 1, categories },
        actual: widened,
      }).some((error) => /unregistered rustDependencies surface: normal:attohttpc=/.test(error)),
    );

    writeFileSync(
      manifestPath,
      `${manifest("0.13")}\n[build-dependencies]\ntauri-build = "2"\n[dev-dependencies]\ntauri = { version = "2", features = ["test"] }\n`,
    );
    assert.deepEqual(
      discoverRepositorySurface(root).rustDependencies.map((id) => id.split(":", 1)[0]),
      ["build", "dev", "normal"],
    );

    const forbiddenTables = [
      "[dependencies.reqwest]\nversion = \"0.12\"\n",
      "[build-dependencies.tauri-build]\nversion = \"2\"\n",
      "[dev-dependencies.tauri]\nversion = \"2\"\n",
      "[target.'cfg(target_os = \"macos\")'.dependencies.reqwest]\nversion = \"0.12\"\n",
    ];
    for (const declaration of forbiddenTables) {
      writeFileSync(manifestPath, `[package]\nname = "fixture"\nversion = "0.0.0"\n${declaration}`);
      assert.throws(
        () => discoverRepositorySurface(root),
        /dependency table form is forbidden/,
      );
    }

    const forbiddenDottedKeys = [
      'dependencies.evil = "1"',
      'build-dependencies.evil = "1"',
      'dev-dependencies.evil = "1"',
      '\"dependencies\".evil = "1"',
      'target.\'cfg(target_os = "macos")\'.dependencies.evil = "1"',
    ];
    for (const declaration of forbiddenDottedKeys) {
      writeFileSync(manifestPath, `${declaration}\n[package]\nname = "fixture"\nversion = "0.0.0"\n`);
      assert.throws(() => discoverRepositorySurface(root), /dotted dependency keys are forbidden/);
    }

    writeFileSync(
      manifestPath,
      `${manifest("0.13")}\n[features]\ndangerous = ["reqwest/blocking", "reqwest/native-tls"]\n`,
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /package features are forbidden/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository discovery inventories every governed production surface", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-surface-budget-"));
  try {
    for (const directory of ["src", "src-tauri/src", "src-tauri/capabilities"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    writeFileSync(
      path.join(root, "src-tauri/Cargo.toml"),
      "[package]\nname = \"fixture\"\nversion = \"0.0.0\"\n[dependencies]\n",
    );
    writeFileSync(
      path.join(root, "src-tauri/src/lib.rs"),
      `
        pub struct AppSettings {
          backup_root: String,
          github_token_configured: bool,
        }
        pub struct UpdateSettingsRequest { backup_root: Option<String> }
        fn run() {
          tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .setup(|_| Ok(()))
            .invoke_handler(tauri::generate_handler![get_settings, update_settings])
            .run(tauri::generate_context!())
            .expect("test app");
        }
      `,
    );
    writeFileSync(
      path.join(root, "src-tauri/capabilities/default.json"),
      JSON.stringify({
        identifier: "default",
        windows: ["main"],
        permissions: ["core:default", "dialog:default"],
      }),
    );
    mkdirSync(path.join(root, "src-tauri/capabilities/scoped"), { recursive: true });
    writeFileSync(
      path.join(root, "src-tauri/capabilities/scoped/import.json"),
      JSON.stringify({
        identifier: "import-window",
        windows: ["import"],
        permissions: [{ identifier: "dialog:allow-open", allow: [{ multiple: false }] }],
      }),
    );
    writeFileSync(
      path.join(root, "src-tauri/entitlements.plist"),
      `<?xml version="1.0"?><plist><dict>
        <key>com.apple.security.app-sandbox</key><true/>
        <key>nested</key><dict><key>ignored-child-key</key><true/></dict>
      </dict></plist>`,
    );
    writeFileSync(
      path.join(root, "src-tauri/tauri.conf.json"),
      JSON.stringify(
        minimalTauriConfig(
          "default-src 'self'; connect-src 'self' https://api.github.com; object-src 'none'",
        ),
      ),
    );
    writeFileSync(
      path.join(root, "src-tauri/src/adapters.rs"),
      `
        struct ReqwestGithubHttpAdapter(reqwest::Client);
        fn github_request_allowed(url: &reqwest::Url) -> bool {
          url.scheme() == "https" && matches!(url.host_str(), Some("api.github.com" | "codeload.github.com"))
        }
        fn github_redirect_allowed(url: &reqwest::Url, previous_redirects: usize) -> bool {
          previous_redirects < MAX_GITHUB_REDIRECTS && github_request_allowed(url)
        }
        impl Default for ReqwestGithubHttpAdapter {
          fn default() -> Self {
            let redirect = reqwest::redirect::Policy::custom(|attempt| {
              let previous_redirects = attempt.previous().len().saturating_sub(1);
              if github_redirect_allowed(attempt.url(), previous_redirects) { attempt.follow() } else { attempt.error("blocked") }
            });
            let client = reqwest::Client::builder()
              .no_proxy()
              .redirect(redirect)
              .connect_timeout(GITHUB_CONNECT_TIMEOUT)
              .timeout(GITHUB_REQUEST_TIMEOUT)
              .https_only(true)
              .build()
              .expect("valid test client");
            Self(client)
          }
        }
        impl GithubHttpAdapter for ReqwestGithubHttpAdapter {
          fn execute(&self, request: reqwest::Request) {
            if !github_request_allowed(request.url()) { return; }
            self.0.execute(request);
          }
        }
      `,
    );
    writeFileSync(
      path.join(root, "src/App.tsx"),
      `
        import { createForegroundSchedule } from "./taskCoordinator";
        createForegroundSchedule({ intervalMs, run: runScheduledCheck });
        createForegroundSchedule({ intervalMs, run: runScheduledBackup });
      `,
    );
    writeFileSync(
      path.join(root, "src/taskCoordinator.ts"),
      "export function createForegroundSchedule(_options: unknown) { return { stop() {} }; }",
    );
    writeFileSync(path.join(root, "src/Transient.ts"), "window.setTimeout(render, 1);");
    writeFileSync(path.join(root, "src/Poller.ts"), "window.setInterval(poll, 1000);");
    writeFileSync(
      path.join(root, "src/Ignored.test.ts"),
      "createForegroundSchedule({ intervalMs: 1, run: testOnly });",
    );

    assert.deepEqual(discoverRepositorySurface(root), {
      settingsFields: [
        "AppSettings.backupRoot",
        "AppSettings.githubTokenConfigured",
        "UpdateSettingsRequest.backupRoot",
      ],
      tauriCommands: ["get_settings", "update_settings"],
      capabilityPermissions: [
        "src-tauri/capabilities/default.json#default:identifier=default",
        "src-tauri/capabilities/default.json#default:permission=core:default",
        "src-tauri/capabilities/default.json#default:permission=dialog:default",
        "src-tauri/capabilities/default.json#default:window=main",
        "src-tauri/capabilities/scoped/import.json#import-window:identifier=import-window",
        'src-tauri/capabilities/scoped/import.json#import-window:permission={"allow":[{"multiple":false}],"identifier":"dialog:allow-open"}',
        "src-tauri/capabilities/scoped/import.json#import-window:window=import",
      ],
      tauriSecurityConfig: expectedTauriSecurity(),
      entitlementKeys: [
        "com.apple.security.app-sandbox=true",
        'nested={"ignored-child-key":true}',
      ],
      cspDirectives: [
        "connect-src 'self'",
        "connect-src https://api.github.com",
        "default-src 'self'",
        "object-src 'none'",
      ],
      externalHosts: ["https://api.github.com", "https://codeload.github.com"],
      rustDependencies: [],
      rustTaskSites: [],
      rustPathSites: [],
      keychainEntries: [],
      runtimeInputs: [],
      tauriPlugins: [
        "src-tauri/src/lib.rs:builder=plugin>setup>invoke_handler>run>expect",
        "src-tauri/src/lib.rs:hook=setup#1",
        "src-tauri/src/lib.rs:plugin=tauri_plugin_dialog::init()",
      ],
      recurringTimers: [
        "src/App.tsx:createForegroundSchedule:runScheduledBackup",
        "src/App.tsx:createForegroundSchedule:runScheduledCheck",
        "src/Poller.ts:setInterval#1",
      ],
      timerCalls: [
        "src/Poller.ts:setInterval#1",
        "src/Transient.ts:setTimeout#1",
      ],
    });

    writeFileSync(
      path.join(root, "src-tauri/entitlements.plist"),
      `<?xml version="1.0"?><plist><dict/></plist>`,
    );
    assert.deepEqual(discoverRepositorySurface(root).entitlementKeys, []);

    writeFileSync(
      path.join(root, "src-tauri/src/adapters.rs"),
      `
        struct ReqwestGithubHttpAdapter(reqwest::Client);
        fn github_request_allowed(url: &reqwest::Url) -> bool {
          url.scheme() == "https" && matches!(url.host_str(), Some("api.github.com"))
        }
        fn github_redirect_allowed(url: &reqwest::Url, previous_redirects: usize) -> bool { true }
        impl Default for ReqwestGithubHttpAdapter {
          fn default() -> Self {
            let first = reqwest::Client::builder().build().unwrap();
            let second = reqwest::Client::builder().build().unwrap();
            Self(first)
          }
        }
        impl GithubHttpAdapter for ReqwestGithubHttpAdapter {
          fn execute(&self, request: reqwest::Request) {
            if !github_request_allowed(request.url()) { return; }
            self.0.execute(request);
          }
        }
      `,
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /redirect policy|redirect host allowlist|single hardened ReqwestGithubHttpAdapter/,
    );

    writeMinimalSurfaceRepository(root);
    const adapterPath = path.join(root, "src-tauri/src/adapters.rs");
    writeFileSync(
      adapterPath,
      readFileSync(adapterPath, "utf8").replace(
        'url.scheme() == "https" && matches!(url.host_str(), Some("api.github.com"))',
        'url.scheme() == "https" && matches!(url.host_str(), Some("api.github.com" | "codeload.github.com")) || runtime_host_policy(url)',
      ),
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /GitHub request host allowlist must remain a static exact match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timer inventory rejects aliases, bind, destructuring, computed access, and global aliases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-timer-surface-"));
  try {
    writeMinimalSurfaceRepository(
      root,
      `
        type Timer = ReturnType<typeof setTimeout>;
        type Keyboard = globalThis.KeyboardEvent;
        if (typeof setTimeout === "function" && typeof window !== "undefined") {
          setTimeout(render, 1);
        }
      `,
    );
    assert.deepEqual(discoverRepositorySurface(root).timerCalls, ["src/App.tsx:setTimeout#1"]);

    writeFileSync(
      path.join(root, "src/App.tsx"),
      'const video = document.createElement("video"); video.requestVideoFrameCallback(render);',
    );
    assert.deepEqual(discoverRepositorySurface(root).timerCalls, [
      "src/App.tsx:requestVideoFrameCallback#1",
    ]);

    const bypasses = [
      "const later = window.setTimeout.bind(window); later(render, 1);",
      "const { setTimeout: later } = window; later(render, 1);",
      'window["setTimeout"](render, 1);',
      "const browser = window; browser.setTimeout(render, 1);",
      "const later = setTimeout; later(render, 1);",
      "document.defaultView?.setInterval(render, 1);",
      "window.parent.setTimeout(render, 1);",
      'window.parent["setTimeout"](render, 1);',
      "setTimeout?.(render, 1);",
      "video.requestVideoFrameCallback.bind(video)(render);",
      'video["requestVideoFrameCallback"](render);',
    ];
    for (const bypass of bypasses) {
      writeFileSync(path.join(root, "src/App.tsx"), bypass);
      assert.throws(
        () => discoverRepositorySurface(root),
        /may not|computed access|canonical (?:direct )?timer call/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend workers and Tauri event IPC remain forbidden execution surfaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-foreground-execution-"));
  try {
    const bypasses = [
      'new Worker(new URL("./worker.ts", import.meta.url));',
      'import BuildWorker from "./worker.ts?worker"; new BuildWorker();',
      'import SharedBuildWorker from "./worker.ts?sharedworker"; new SharedBuildWorker();',
      'import InlineWorker from "./worker.ts?worker&inline"; new InlineWorker();',
      'const WorkerModule = await import("./worker.ts?worker"); new WorkerModule.default();',
      'new window.SharedWorker("./worker.js");',
      'const WorkerAlias = globalThis.Worker; new WorkerAlias("./worker.js");',
      'window["Worker"]("./worker.js");',
      'navigator.serviceWorker.register("/service-worker.js");',
      'const browser = navigator; browser.serviceWorker.register("/service-worker.js");',
      'import { emit } from "@tauri-apps/api/event"; emit("hidden", {});',
      'import { event } from "@tauri-apps/api"; event.emit("hidden", {});',
      'import * as tauri from "@tauri-apps/api"; tauri.event.listen("hidden", handler);',
      'const eventApi = await import("@tauri-apps/api/event"); eventApi.listen("hidden", handler);',
      'const eventApi = require("@tauri-apps/api/event"); eventApi.emit("hidden");',
      'import { getCurrentWindow } from "@tauri-apps/api/window"; getCurrentWindow().emit("hidden", {});',
      'import { getCurrentWindow } from "@tauri-apps/api/window"; const appWindow = getCurrentWindow(); appWindow["emit"]("hidden", {});',
    ];
    for (const bypass of bypasses) {
      writeMinimalSurfaceRepository(root, bypass);
      assert.throws(
        () => discoverRepositorySurface(root),
        /foreground-only (?:scheduling )?boundary|service workers|navigator may not be aliased|Tauri API|Tauri event|reviewed onCloseRequested|computed access/,
        bypass,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreground schedule inventory rejects aliased imports and wrapper calls", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-foreground-schedule-"));
  try {
    writeMinimalSurfaceRepository(
      root,
      `
        import { createForegroundSchedule } from "./taskCoordinator";
        createForegroundSchedule({ intervalMs: 10, run: runScheduledCheck });
      `,
    );
    assert.deepEqual(discoverRepositorySurface(root).recurringTimers, [
      "src/App.tsx:createForegroundSchedule:runScheduledCheck",
    ]);

    const bypasses = [
      `import { createForegroundSchedule as make } from "./taskCoordinator";
       make({ intervalMs: 10, run: runScheduledCheck });`,
      `import { createForegroundSchedule } from "./taskCoordinator";
       const make = createForegroundSchedule;
       make({ intervalMs: 10, run: runScheduledCheck });`,
      `import { createForegroundSchedule } from "./taskCoordinator";
       function make(options: unknown) { return createForegroundSchedule(options); }`,
      `import * as coordinator from "./taskCoordinator";
       coordinator.createForegroundSchedule({ intervalMs: 10, run: runScheduledCheck });`,
      `createForegroundSchedule({ intervalMs: 10, run: runScheduledCheck });`,
      `import { createForegroundSchedule } from "./taskCoordinator";
       createForegroundSchedule({ intervalMs: 10, run: async () => undefined });`,
    ];
    for (const bypass of bypasses) {
      writeFileSync(path.join(root, "src/App.tsx"), bypass);
      assert.throws(
        () => discoverRepositorySurface(root),
        /foreground schedule|createForegroundSchedule|taskCoordinator/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the checked-in surface budget matches the production repository", () => {
  assert.deepEqual(checkRepositorySurfaceBudget(repositoryRoot), []);
});
