import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverRepositorySurface,
  validateSurfaceBudget,
} from "../surface-budget.mjs";
import { discoverRustExecutionSurface } from "../surface-budget-rust.mjs";
import {
  emptyCategories,
  expectedTauriSecurity,
  minimalTauriConfig,
  writeMinimalSurfaceRepository,
} from "./surface-budget-fixtures.mjs";

test("Rust background tasks, Tauri plugins, and setup hooks are explicit budget surfaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-rust-execution-surface-"));
  try {
    writeMinimalSurfaceRepository(root);
    const daemonPath = path.join(root, "src-tauri/src/daemon.rs");
    writeFileSync(
      daemonPath,
      "fn run_daemon() { tauri::async_runtime::spawn(async move { loop {} }); }",
    );
    const taskId =
      "src-tauri/src/daemon.rs:tauri::async_runtime::spawn:run_daemon#1";
    assert.deepEqual(discoverRepositorySurface(root).rustTaskSites, [taskId]);
    assert.ok(
      validateSurfaceBudget({
        budget: { schemaVersion: 1, categories: emptyCategories() },
        actual: discoverRepositorySurface(root),
      }).includes(`unregistered rustTaskSites surface: ${taskId}`),
    );

    writeFileSync(
      daemonPath,
      `use tauri::async_runtime::spawn as launch;
       fn run_daemon() { launch(async move { loop {} }); }`,
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /aliased, method, macro, or wrapped Rust spawn primitive|canonical direct call/,
    );

    writeFileSync(
      daemonPath,
      "#[cfg(test)] fn test_daemon() { std::thread::spawn(|| loop {}); }",
    );
    assert.deepEqual(discoverRepositorySurface(root).rustTaskSites, []);

    writeFileSync(
      daemonPath,
      'fn persist(path: &std::path::Path) { std::fs::write(path, b"data").unwrap(); }',
    );
    const pathId = "src-tauri/src/daemon.rs:fs::write:persist#1";
    assert.deepEqual(discoverRepositorySurface(root).rustPathSites, [pathId]);
    assert.ok(
      validateSurfaceBudget({
        budget: { schemaVersion: 1, categories: emptyCategories() },
        actual: discoverRepositorySurface(root),
      }).includes(`unregistered rustPathSites surface: ${pathId}`),
    );

    writeFileSync(
      daemonPath,
      "fn inspect(path: &std::path::Path) { let _ = std::path::Path::metadata(path); }",
    );
    assert.deepEqual(discoverRepositorySurface(root).rustPathSites, [
      "src-tauri/src/daemon.rs:Path::metadata:inspect#1",
    ]);

    const dependencyPathSites = [
      ["fn scan(path: &str) { let _ = walkdir::WalkDir::new(path); }", ["WalkDir::new:scan#1"]],
      [
        "fn stage(path: &std::path::Path) { let _ = tempfile::NamedTempFile::new_in(path); }",
        ["NamedTempFile::new_in:stage#1"],
      ],
      ["fn home() { let _ = dirs::home_dir(); }", ["dirs::home_dir:home#1"]],
      ["fn open(path: &str) { let _ = opener::open(path); }", ["opener::open:open#1"]],
      ["fn link(from: &str, to: &str) { let _ = std::os::unix::fs::symlink(from, to); }", ["unix_fs::symlink:link#1"]],
      ["fn open(path: &str) { let mut options = std::fs::OpenOptions::new(); let _ = options.open(path); }", ["OpenOptions::new:open#1", "OpenOptions::open:open#1"]],
    ];
    for (const [source, suffixes] of dependencyPathSites) {
      writeFileSync(daemonPath, source);
      assert.deepEqual(
        discoverRepositorySurface(root).rustPathSites,
        suffixes.map((suffix) => `src-tauri/src/daemon.rs:${suffix}`).sort(),
      );
    }

    const pathBypasses = [
      "fn connect() { std::net::TcpStream::connect(\"evil.example:443\").unwrap(); }",
      'use std::process::Command; fn connect() { Command::new("curl").arg("https://evil.example").status(); }',
      'use std::fs::{write as persist}; fn save(path: &std::path::Path) { persist(path, b"x"); }',
      'use std::fs::read; fn load(path: &std::path::Path) { let _ = read(path); }',
      'use std::fs::*; fn load(path: &std::path::Path) { let _ = read(path); }',
      'use std::{fs::read}; fn load(path: &std::path::Path) { let _ = read(path); }',
      'use std::{fs::read as hidden_read}; fn load(path: &std::path::Path) { let _ = hidden_read(path); }',
      "use std::fs::File; type HiddenFile = File; fn hidden(path: &str) { let _ = HiddenFile::open(path); }",
      "type HiddenFile = std::fs::File; fn hidden(path: &str) { let _ = HiddenFile::open(path); }",
      "fn connect() { let _client = reqwest::Client::new(); }",
      "fn connect(client: &reqwest::Client, request: reqwest::Request) { let _ = client.execute(request); }",
      "fn connect(builder: reqwest::RequestBuilder) { let _ = builder.send(); }",
      "use libc::{socket, connect}; fn hidden() { let _ = socket(0, 0, 0); }",
      "use libc::{self, open}; fn hidden() { let _ = open(core::ptr::null(), 0); }",
      "pub use libc::unlink; fn hidden() { let _ = unlink(core::ptr::null()); }",
      "use libc::*; fn hidden() { let _ = socket(0, 0, 0); }",
      "use libc::open as hidden_open; fn hidden() { let _ = hidden_open(core::ptr::null(), 0); }",
      "extern crate libc as hidden_libc; fn hidden() { let _ = hidden_libc::socket(0, 0, 0); }",
      "use std::path::Path as HiddenPath; fn hidden(path: &HiddenPath) { let _ = HiddenPath::metadata(path); }",
      "type HiddenPath = std::path::Path; fn hidden(path: &HiddenPath) { let _ = HiddenPath::metadata(path); }",
      "use walkdir::WalkDir as HiddenWalk; fn hidden(path: &str) { let _ = HiddenWalk::new(path); }",
      "use tempfile::NamedTempFile as HiddenTemp; fn hidden(path: &std::path::Path) { let _ = HiddenTemp::new_in(path); }",
      "use opener::open; fn hidden(path: &str) { let _ = open(path); }",
      "use dirs::home_dir; fn hidden() { let _ = home_dir(); }",
      "use std::os::unix::fs::symlink; fn hidden(from: &str, to: &str) { let _ = symlink(from, to); }",
      "type HiddenWalk = walkdir::WalkDir; fn hidden(path: &str) { let _ = HiddenWalk::new(path); }",
      "type HiddenTemp = tempfile::NamedTempFile; fn hidden(path: &std::path::Path) { let _ = HiddenTemp::new_in(path); }",
      "fn hidden(app: &tauri::AppHandle) { let _ = tauri::WebviewWindowBuilder::new(app, \"evil\", tauri::WebviewUrl::External(url)); }",
      'use tauri::Listener; fn attach(app: &tauri::AppHandle) { app.listen("hidden", |_| {}); }',
      'macro_rules! io { ($op:ident, $path:expr) => { std::fs::$op($path) } } fn save(path: &str) { io!(read, path); }',
    ];
    for (const bypass of pathBypasses) {
      writeFileSync(daemonPath, bypass);
      assert.throws(
        () => discoverRepositorySurface(root),
        /network transport|route HTTP transport|reqwest transport|libc imports|governed filesystem or process crates|filesystem-capable crate imports|approved macOS open intent|filesystem functions|filesystem primitives behind a type alias|filesystem-capable crates behind a type alias|process or filesystem primitives|Tauri event IPC|runtime Tauri windows|local Rust macros/,
        bypass,
      );
    }
    rmSync(daemonPath);
    for (const productionName of ["test.rs", "tests.rs"]) {
      const productionPath = path.join(root, "src-tauri/src", productionName);
      writeFileSync(productionPath, "fn hidden() { let _ = reqwest::Client::new(); }");
      assert.throws(
        () => discoverRepositorySurface(root),
        /reqwest transport must route through the GitHub adapter/,
        `${productionName} must remain a production surface`,
      );
      rmSync(productionPath);
    }

    const libPath = path.join(root, "src-tauri/src/lib.rs");
    const baselineLib = readFileSync(libPath, "utf8");
    assert.deepEqual(discoverRepositorySurface(root).tauriPlugins, [
      "src-tauri/src/lib.rs:builder=plugin>setup>invoke_handler>run>expect",
      "src-tauri/src/lib.rs:hook=setup#1",
      "src-tauri/src/lib.rs:plugin=tauri_plugin_dialog::init()",
    ]);

    const builderMutations = [
      '.register_uri_scheme_protocol("evil", handler)',
      '.register_asynchronous_uri_scheme_protocol("evil", handler)',
      '.append_invoke_initialization_script("evil")',
      ".on_navigation(|_| true)",
      ".plugin_boxed(plugin)",
      ".manage(unbudgeted_state)",
      ".plugin(audit_plugin::init())",
    ];
    for (const mutation of builderMutations) {
      writeFileSync(
        libPath,
        baselineLib.replace("tauri::Builder::default()", `tauri::Builder::default()${mutation}`),
      );
      assert.throws(
        () => discoverRepositorySurface(root),
        /Tauri Builder chain must remain|Tauri plugin must use/,
        mutation,
      );
    }

    writeFileSync(
      libPath,
      baselineLib.replace("tauri_plugin_dialog::init()", "plugin"),
    );
    assert.throws(() => discoverRepositorySurface(root), /static zero-argument factory/);

    writeFileSync(
      libPath,
      `${baselineLib}\nfn second() { let _ = tauri::Builder::default(); }`,
    );
    assert.throws(() => discoverRepositorySurface(root), /second Tauri Builder/);

    const alternateBuilders = [
      "fn second() { let b: tauri::Builder<tauri::Wry> = Default::default(); let _ = b.run(context); }",
      "fn second() { let _ = tauri::Builder::<tauri::Wry>::default(); }",
      "type HiddenBuilder = tauri::Builder<tauri::Wry>; fn second() -> HiddenBuilder { Default::default() }",
      "fn second() { let b = Default::default(); let _ = b.invoke_handler(dynamic_handler); }",
    ];
    for (const mutation of alternateBuilders) {
      writeFileSync(libPath, `${baselineLib}\n${mutation}`);
      assert.throws(
        () => discoverRepositorySurface(root),
        /canonical direct constructor|second Tauri Builder|outside the sole canonical Builder chain/,
        mutation,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rust foreign linkage and inline assembly fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-rust-foreign-surface-"));
  try {
    writeMinimalSurfaceRepository(root);
    const sourcePath = path.join(root, "src-tauri/src/foreign.rs");
    const mutations = [
      [
        "system foreign block",
        'unsafe extern "C" { fn system(command: *const core::ffi::c_char) -> core::ffi::c_int; }',
        /foreign ABI declarations are forbidden/,
      ],
      [
        "socket foreign block",
        'extern "C" { fn socket(domain: i32, kind: i32, protocol: i32) -> i32; }',
        /foreign ABI declarations are forbidden/,
      ],
      [
        "extern function declaration",
        'pub unsafe extern "C" fn plugin_entry() {}',
        /foreign ABI declarations are forbidden/,
      ],
      [
        "native link attribute",
        '#[link(name = "c")] unsafe extern "C" { fn system(command: *const core::ffi::c_char) -> i32; }',
        /native linkage attributes are forbidden/,
      ],
      [
        "std asm",
        'fn execute() { unsafe { std::arch::asm!("nop"); } }',
        /inline or global assembly is forbidden/,
      ],
      [
        "core global asm",
        'core::arch::global_asm!(".byte 0x90");',
        /inline or global assembly is forbidden/,
      ],
      [
        "renamed asm import",
        'use std::arch::asm as machine_code; fn execute() { unsafe { machine_code!("nop"); } }',
        /inline or global assembly is forbidden/,
      ],
      [
        "aliased core global asm import",
        'use core as runtime; use runtime::arch::global_asm as embed; embed!(".byte 0x90");',
        /inline or global assembly is forbidden/,
      ],
    ];
    for (const [label, source, expected] of mutations) {
      writeFileSync(sourcePath, source);
      assert.throws(() => discoverRepositorySurface(root), expected, label);
    }

    writeFileSync(
      sourcePath,
      [
        '// unsafe extern "C" { fn socket(domain: i32) -> i32; }',
        'const DECOY: &str = "#[link(name = \\"c\\")] std::arch::asm!(\\"nop\\")";',
        '#[cfg(test)] unsafe extern "C" { fn system(command: *const core::ffi::c_char) -> i32; }',
        '#[cfg(test)] fn assembly_test() { unsafe { core::arch::asm!("nop"); } }',
      ].join("\n"),
    );
    assert.doesNotThrow(() => discoverRepositorySurface(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Tauri security defaults are inventoried and inline capabilities fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-tauri-security-"));
  try {
    writeMinimalSurfaceRepository(root);
    assert.deepEqual(discoverRepositorySurface(root).tauriSecurityConfig, expectedTauriSecurity());

    const widenedConfig = minimalTauriConfig();
    widenedConfig.app.security.assetProtocol = { enable: true, scope: ["$HOME/**"] };
    widenedConfig.app.security.dangerousDisableAssetCspModification = ["script-src"];
    writeFileSync(
      path.join(root, "src-tauri/tauri.conf.json"),
      JSON.stringify(widenedConfig),
    );
    assert.deepEqual(
      discoverRepositorySurface(root).tauriSecurityConfig,
      expectedTauriSecurity({
        assetProtocolEnable: true,
        assetProtocolScope: ["$HOME/**"],
        dangerousDisableAssetCspModification: ["script-src"],
      }),
    );

    const inlineCapabilityConfig = minimalTauriConfig();
    inlineCapabilityConfig.app.security.capabilities = [
      { identifier: "inline", permissions: ["shell:allow-execute"] },
    ];
    writeFileSync(
      path.join(root, "src-tauri/tauri.conf.json"),
      JSON.stringify(inlineCapabilityConfig),
    );
    assert.throws(() => discoverRepositorySurface(root), /capabilities is forbidden/);

    const mutations = [
      [
        "beforeBuildCommand",
        (config) => (config.build.beforeBuildCommand = "npm run unsafe"),
      ],
      ["beforeDevCommand", (config) => (config.build.beforeDevCommand = "npm run unsafe")],
      ["devUrl", (config) => (config.build.devUrl = "https://evil.example")],
      ["frontendDist", (config) => (config.build.frontendDist = "https://evil.example")],
      [
        "beforeBundleCommand",
        (config) => (config.build.beforeBundleCommand = "curl evil.example"),
      ],
      ["build.runner", (config) => (config.build.runner = "unsafe-runner")],
      ["build.features", (config) => (config.build.features = ["unsafe-feature"])],
      ["topLevel.plugins", (config) => (config.plugins = { updater: { endpoints: ["https://evil.example"] } })],
      ["topLevel.unknown", (config) => (config.unknown = true)],
      ["productName", (config) => (config.productName = "Impostor")],
      ["identifier", (config) => (config.identifier = "com.evil.desktop")],
      ["$schema", (config) => (config.$schema = "https://evil.example/schema.json")],
      ["externalBin", (config) => (config.bundle.externalBin = ["sidecar"])],
      ["resources", (config) => (config.bundle.resources = ["../secrets"])],
      ["bundle.active", (config) => (config.bundle.active = false)],
      ["bundle.targets", (config) => (config.bundle.targets = ["app"])],
      ["bundle.category", (config) => (config.bundle.category = "Utility")],
      ["bundle.icon", (config) => (config.bundle.icon = ["../outside.icns"])],
      [
        "bundle.macOS.hardenedRuntime",
        (config) => (config.bundle.macOS.hardenedRuntime = false),
      ],
      [
        "bundle.macOS.entitlements",
        (config) => (config.bundle.macOS.entitlements = "other.plist"),
      ],
      [
        "bundle.macOS.minimumSystemVersion",
        (config) => (config.bundle.macOS.minimumSystemVersion = "10.0"),
      ],
      [
        "bundle.macOS.files",
        (config) => (config.bundle.macOS.files = { "../payload": "MacOS/helper" }),
      ],
      [
        "bundle.macOS.frameworks",
        (config) => (config.bundle.macOS.frameworks = ["../evil.framework"]),
      ],
      [
        "bundle.macOS.infoPlist",
        (config) => (config.bundle.macOS.infoPlist = "../evil.plist"),
      ],
      [
        "bundle.macOS.exceptionDomain",
        (config) => (config.bundle.macOS.exceptionDomain = "evil.example"),
      ],
      [
        "bundle.macOS.signingIdentity",
        (config) => (config.bundle.macOS.signingIdentity = "Injected"),
      ],
      [
        "bundle.macOS.providerShortName",
        (config) => (config.bundle.macOS.providerShortName = "Injected"),
      ],
      [
        "windows[0].url",
        (config) => (config.app.windows = [{ url: "https://evil.example" }]),
      ],
      ["app.macOSPrivateApi", (config) => (config.app.macOSPrivateApi = true)],
      ["app.windows[0]", (config) => (config.app.windows[0].width = 1600)],
      ["windows[0].devtools", (config) => (config.app.windows[0].devtools = true)],
      [
        "windows[0].proxyUrl",
        (config) => (config.app.windows[0].proxyUrl = "http://127.0.0.1:8080"),
      ],
      [
        "windows[0].additionalBrowserArgs",
        (config) => (config.app.windows[0].additionalBrowserArgs = "--disable-web-security"),
      ],
      ["windows[0].incognito", (config) => (config.app.windows[0].incognito = true)],
      [
        "windows[0].browserExtensionsEnabled",
        (config) => (config.app.windows[0].browserExtensionsEnabled = true),
      ],
      [
        "windows[0].useHttpsScheme",
        (config) => (config.app.windows[0].useHttpsScheme = true),
      ],
      [
        "windows[0].dataDirectory",
        (config) => (config.app.windows[0].dataDirectory = "../unbudgeted-profile"),
      ],
      ["withGlobalTauri", (config) => (config.app.withGlobalTauri = true)],
      ["app.security.devCsp", (config) => (config.app.security.devCsp = "default-src *")],
      ["app.security.freezePrototype", (config) => (config.app.security.freezePrototype = true)],
      [
        "app.security.pattern",
        (config) =>
          (config.app.security.pattern = {
            use: "isolation",
            options: { dir: "../unbudgeted-isolation" },
          }),
      ],
      [
        "app.security.headers",
        (config) => (config.app.security.headers = { "access-control-allow-origin": "*" }),
      ],
      ["app.security.unexpected", (config) => (config.app.security.unexpected = true)],
    ];
    for (const [field, mutate] of mutations) {
      const config = minimalTauriConfig();
      mutate(config);
      writeFileSync(
        path.join(root, "src-tauri/tauri.conf.json"),
        JSON.stringify(config),
      );
      assert.throws(
        () => discoverRepositorySurface(root),
        new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Tauri capability discovery rejects TOML, untracked formats, and symbolic links", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-capability-format-"));
  try {
    writeMinimalSurfaceRepository(root);
    const capabilityRoot = path.join(root, "src-tauri/capabilities");
    const tomlPath = path.join(capabilityRoot, "escape.toml");
    writeFileSync(
      tomlPath,
      'identifier = "escape"\nwindows = ["main"]\npermissions = ["shell:allow-execute"]\n',
    );
    assert.throws(() => discoverRepositorySurface(root), /must be a regular \.json file/);
    rmSync(tomlPath);

    const unknownPath = path.join(capabilityRoot, "escape.yaml");
    writeFileSync(unknownPath, "identifier: escape\n");
    assert.throws(() => discoverRepositorySurface(root), /must be a regular \.json file/);
    rmSync(unknownPath);

    const permissionRoot = path.join(root, "src-tauri/permissions");
    mkdirSync(permissionRoot);
    writeFileSync(
      path.join(permissionRoot, "escape.toml"),
      '[[permission]]\nidentifier = "escape"\ncommands.allow = ["hidden_command"]\n',
    );
    assert.throws(() => discoverRepositorySurface(root), /src-tauri\/permissions is forbidden/);
    rmSync(permissionRoot, { recursive: true, force: true });

    symlinkSync(path.join(capabilityRoot, "default.json"), path.join(capabilityRoot, "alias.json"));
    assert.throws(() => discoverRepositorySurface(root), /must not be a symbolic link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Tauri capability discovery rejects unbudgeted top-level capability selectors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-capability-fields-"));
  try {
    writeMinimalSurfaceRepository(root);
    const capabilityPath = path.join(root, "src-tauri/capabilities/default.json");
    const baseline = JSON.parse(readFileSync(capabilityPath, "utf8"));
    const mutations = [
      ["remote", { urls: ["https://evil.example"] }],
      ["local", false],
      ["webviews", ["*"]],
      ["platforms", ["macOS"]],
      ["unexpected", true],
    ];
    for (const [field, value] of mutations) {
      writeFileSync(capabilityPath, JSON.stringify({ ...baseline, [field]: value }));
      assert.throws(
        () => discoverRepositorySurface(root),
        new RegExp(`unsupported top-level field: ${field}`),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rust discovery ignores comment and string decoys but rejects duplicate or cfg registries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-rust-surface-"));
  try {
    writeMinimalSurfaceRepository(root);
    const libPath = path.join(root, "src-tauri/src/lib.rs");
    const baselineLib = readFileSync(libPath, "utf8");
    writeFileSync(
      libPath,
      `${baselineLib}\n// struct AppSettings { decoy: bool }\nconst DECOY: &str = "tauri::generate_handler![evil]";`,
    );
    assert.deepEqual(discoverRepositorySurface(root).settingsFields, [
      "AppSettings.backupRoot",
      "UpdateSettingsRequest.backupRoot",
    ]);

    writeFileSync(libPath, `${baselineLib}\npub struct AppSettings { decoy: bool }`);
    assert.throws(() => discoverRepositorySurface(root), /exactly one unconditional Rust struct AppSettings/);

    writeFileSync(
      libPath,
      `${baselineLib}\n#[cfg(test)] fn decoy() { tauri::generate_handler![evil]; }`,
    );
    assert.throws(() => discoverRepositorySurface(root), /exactly one unconditional tauri::generate_handler/);

    writeFileSync(
      libPath,
      baselineLib.replace(
        ".invoke_handler(tauri::generate_handler![get_settings])",
        ".invoke_handler(tauri::generate_handler![get_settings]).invoke_handler(|_invoke| {})",
      ),
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /exactly one direct Builder\.invoke_handler|Tauri Builder chain must remain/,
    );

    writeFileSync(
      libPath,
      baselineLib
        .replace("fn run() {", "fn run() { let _registry = tauri::generate_handler![get_settings];")
        .replace(
          ".invoke_handler(tauri::generate_handler![get_settings])",
          ".invoke_handler(dynamic_handler)",
        ),
    );
    assert.throws(() => discoverRepositorySurface(root), /sole direct Builder\.invoke_handler argument/);
    writeFileSync(libPath, baselineLib);

    const adapterPath = path.join(root, "src-tauri/src/adapters.rs");
    const baselineAdapter = readFileSync(adapterPath, "utf8");
    const transportBypasses = [
      [
        "aliased client",
        (source) =>
          source.replace(
            "self.0.execute(request)",
            "let client = &self.0; client.execute(request)",
          ),
      ],
      [
        "renamed request",
        (source) =>
          source
            .replace(
              "fn execute(&self, request: reqwest::Request)",
              "fn execute(&self, outbound: reqwest::Request)",
            )
            .replace("github_request_allowed(request.url())", "github_request_allowed(outbound.url())")
            .replace("self.0.execute(request)", "self.0.execute(outbound)"),
      ],
      [
        "RequestBuilder send",
        (source) =>
          source.replace(
            "self.0.execute(request)",
            'self.0.get("https://evil.example").send()',
          ),
      ],
      [
        "RequestBuilder IntoFuture",
        (source) =>
          source.replace(
            "self.0.execute(request)",
            'let _ = self.0.get("https://evil.example").await; self.0.execute(request)',
          ),
      ],
      [
        "Client UFCS",
        (source) =>
          source.replace(
            "self.0.execute(request)",
            "reqwest::Client::execute(&self.0, request)",
          ),
      ],
    ];
    for (const [name, mutate] of transportBypasses) {
      writeFileSync(adapterPath, mutate(baselineAdapter));
      assert.throws(
        () => discoverRustExecutionSurface(root),
        /canonical audited reqwest transport call/,
        name,
      );
    }
    writeFileSync(
      adapterPath,
      `${baselineAdapter}\n// fn github_request_allowed(url: &Url) {}\nconst DECOY: &str = "fn github_redirect_allowed()";`,
    );
    assert.deepEqual(discoverRepositorySurface(root).externalHosts, ["https://api.github.com"]);

    writeFileSync(
      adapterPath,
      baselineAdapter.replace(
        'if github_redirect_allowed(attempt.url(), previous_redirects) { attempt.follow() } else { attempt.error("blocked") }',
        "let _allowed = github_redirect_allowed(attempt.url(), previous_redirects); attempt.follow()",
      ),
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /single hardened ReqwestGithubHttpAdapter/,
    );

    writeFileSync(
      adapterPath,
      baselineAdapter.replace(
        "previous_redirects < MAX_GITHUB_REDIRECTS && github_request_allowed(url)",
        "true",
      ),
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /redirect host allowlist must enforce/,
    );

    const clientBuilderMutations = [
      [
        "system proxy enabled",
        (source) => source.replace(".no_proxy()", ""),
      ],
      [
        "missing connect timeout",
        (source) => source.replace(".connect_timeout(GITHUB_CONNECT_TIMEOUT)", ""),
      ],
      [
        "missing request timeout",
        (source) => source.replace(".timeout(GITHUB_REQUEST_TIMEOUT)", ""),
      ],
      ["HTTP allowed", (source) => source.replace(".https_only(true)", ".https_only(false)")],
      [
        "invalid certificates accepted",
        (source) => source.replace(
          ".https_only(true)",
          ".danger_accept_invalid_certs(true).https_only(true)",
        ),
      ],
      [
        "proxy override",
        (source) => source.replace(
          ".https_only(true)",
          ".proxy(runtime_proxy).https_only(true)",
        ),
      ],
      [
        "DNS override",
        (source) => source.replace(
          ".https_only(true)",
          '.resolve("api.github.com", runtime_address).https_only(true)',
        ),
      ],
    ];
    for (const [name, mutate] of clientBuilderMutations) {
      writeFileSync(adapterPath, mutate(baselineAdapter));
      assert.throws(
        () => discoverRepositorySurface(root),
        /single hardened ReqwestGithubHttpAdapter/,
        name,
      );
    }

    writeFileSync(
      adapterPath,
      baselineAdapter.replace(
        ".redirect(redirect)",
        ".redirect(reqwest::redirect::Policy::none())",
      ),
    );
    assert.throws(
      () => discoverRepositorySurface(root),
      /single hardened ReqwestGithubHttpAdapter/,
    );

    writeFileSync(
      adapterPath,
      `${baselineAdapter}\n#[cfg(test)] fn github_request_allowed(url: &reqwest::Url) -> bool { true }`,
    );
    assert.throws(() => discoverRepositorySurface(root), /exactly one GitHub request and redirect/);

    writeFileSync(
      adapterPath,
      baselineAdapter.replace(
        "fn github_request_allowed",
        '#[cfg(feature = "unsafe-policy")]\nfn github_request_allowed',
      ),
    );
    assert.throws(() => discoverRepositorySurface(root), /must not be cfg-conditional/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("entitlement discovery ignores valid comments and rejects XML decoys or ambiguity", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srt-entitlement-surface-"));
  try {
    writeMinimalSurfaceRepository(root);
    const plistPath = path.join(root, "src-tauri/entitlements.plist");
    writeFileSync(
      plistPath,
      `<?xml version="1.0"?><plist><!-- <key>comment-decoy</key> --><dict>
        <key>com.apple.security.app-sandbox</key><true/>
      </dict></plist>`,
    );
    assert.deepEqual(discoverRepositorySurface(root).entitlementKeys, [
      "com.apple.security.app-sandbox=true",
    ]);

    const entitlementValues = (flag, groups, nested) =>
      `<?xml version="1.0"?><plist><dict>
        <key>flag</key><${flag}/>
        <key>groups</key><array>${groups.map((group) => `<string>${group}</string>`).join("")}</array>
        <key>nested</key><dict>${Object.entries(nested)
          .map(([key, value]) => `<key>${key}</key><integer>${value}</integer>`)
          .join("")}</dict>
      </dict></plist>`;
    writeFileSync(plistPath, entitlementValues("false", ["group.one"], { limit: 1 }));
    const baselineEntitlements = [
      "flag=false",
      'groups=["group.one"]',
      'nested={"limit":1}',
    ];
    assert.deepEqual(discoverRepositorySurface(root).entitlementKeys, baselineEntitlements);
    const entitlementBudget = emptyCategories();
    entitlementBudget.entitlementKeys = baselineEntitlements.map((id) => ({
      id,
      status: "active",
      purpose: "Test entitlement value contract.",
    }));
    const assertValueMutationBlocked = (xml, removed, added) => {
      writeFileSync(plistPath, xml);
      const actual = emptyCategories();
      actual.entitlementKeys = discoverRepositorySurface(root).entitlementKeys;
      assert.deepEqual(
        validateSurfaceBudget({
          budget: { schemaVersion: 1, categories: entitlementBudget },
          actual,
        }).filter((error) => error.includes("entitlementKeys")),
        [
          `active entitlementKeys surface is missing from source: ${removed}`,
          `unregistered entitlementKeys surface: ${added}`,
        ],
      );
    };
    assertValueMutationBlocked(
      entitlementValues("true", ["group.one"], { limit: 1 }),
      "flag=false",
      "flag=true",
    );
    assertValueMutationBlocked(
      entitlementValues("false", ["group.one", "group.two"], { limit: 1 }),
      'groups=["group.one"]',
      'groups=["group.one","group.two"]',
    );
    assertValueMutationBlocked(
      entitlementValues("false", ["group.one"], { extra: 2, limit: 1 }),
      'nested={"limit":1}',
      'nested={"extra":2,"limit":1}',
    );

    const malformed = [
      '<?xml version="1.0"?><plist><dict><key>duplicate</key><true/><key>duplicate</key><false/></dict></plist>',
      '<?xml version="1.0"?><plist><dict/></plist><dict/>',
      '<?xml version="1.0"?><plist><dict><![CDATA[<key>decoy</key>]]></dict></plist>',
      '<?xml version="1.0"?><plist><!-- unterminated<dict/></plist>',
      '<?xml version="1.0"?><plist><!-- invalid -- comment --><dict/></plist>',
      '<?xml version="1.0"?><plist></plist><dict><key>outside</key><true/></dict>',
      '<?xml version="1.0"?><dict/><plist></plist>',
    ];
    for (const xml of malformed) {
      writeFileSync(plistPath, xml);
      assert.throws(() => discoverRepositorySurface(root), /entitlements\.plist/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
