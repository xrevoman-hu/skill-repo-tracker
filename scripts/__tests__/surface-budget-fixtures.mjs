import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const emptyCategories = () => ({
  settingsFields: [],
  tauriCommands: [],
  capabilityPermissions: [],
  tauriSecurityConfig: [],
  entitlementKeys: [],
  cspDirectives: [],
  externalHosts: [],
  rustDependencies: [],
  rustTaskSites: [],
  rustPathSites: [],
  keychainEntries: [],
  runtimeInputs: [],
  tauriPlugins: [],
  recurringTimers: [],
  timerCalls: [],
});

export function minimalTauriConfig(csp = "default-src 'self'; object-src 'none'") {
  return {
    $schema: "https://schema.tauri.app/config/2",
    productName: "Skill Repo Tracker",
    version: "0.0.0",
    identifier: "com.skillrepotracker.desktop",
    build: {
      beforeBuildCommand: "npm run build",
      beforeDevCommand: "npm run dev",
      devUrl: "http://127.0.0.1:5173",
      frontendDist: "../dist",
    },
    app: {
      windows: [
        {
          title: "Skill Repo Tracker",
          width: 1440,
          height: 1024,
          minWidth: 1120,
          minHeight: 720,
          resizable: true,
        },
      ],
      security: { csp },
    },
    bundle: {
      active: true,
      targets: ["app", "dmg"],
      category: "DeveloperTool",
      icon: ["icons/icon.png", "icons/icon.icns"],
      shortDescription: "Track GitHub repositories, backups, and local Skills.",
      longDescription: "A local-first GitHub repository and Skills update manager.",
      macOS: {
        hardenedRuntime: true,
        entitlements: "entitlements.plist",
        minimumSystemVersion: "12.0",
      },
    },
  };
}

export function expectedTauriSecurity({
  assetProtocolEnable = false,
  assetProtocolScope = [],
  dangerousDisableAssetCspModification = false,
} = {}) {
  return [
    'app.allowedKeys=["windows","security"]',
    'app.security.allowedKeys=["assetProtocol","csp","dangerousDisableAssetCspModification"]',
    `app.security.assetProtocol.enable=${JSON.stringify(assetProtocolEnable)}`,
    `app.security.assetProtocol.scope=${JSON.stringify(assetProtocolScope)}`,
    "app.security.capabilities=external-files-only",
    `app.security.dangerousDisableAssetCspModification=${JSON.stringify(dangerousDisableAssetCspModification)}`,
    "app.windows.url=absent",
    'app.windows=[{"height":1024,"minHeight":720,"minWidth":1120,"resizable":true,"title":"Skill Repo Tracker","width":1440}]',
    "app.withGlobalTauri=false",
    'build.allowedKeys=["beforeBuildCommand","beforeDevCommand","devUrl","frontendDist"]',
    'build.beforeBuildCommand="npm run build"',
    "build.beforeBundleCommand=absent",
    'build.beforeDevCommand="npm run dev"',
    'build.devUrl="http://127.0.0.1:5173"',
    'build.frontendDist="../dist"',
    "bundle.active=true",
    'bundle.allowedKeys=["active","targets","category","icon","shortDescription","longDescription","macOS"]',
    'bundle.category="DeveloperTool"',
    "bundle.externalBin=absent",
    'bundle.icon=["icons/icon.png","icons/icon.icns"]',
    'bundle.longDescription="A local-first GitHub repository and Skills update manager."',
    'bundle.macOS.allowedKeys=["hardenedRuntime","entitlements","minimumSystemVersion"]',
    'bundle.macOS.entitlements="entitlements.plist"',
    "bundle.macOS.hardenedRuntime=true",
    'bundle.macOS.minimumSystemVersion="12.0"',
    "bundle.resources=absent",
    'bundle.shortDescription="Track GitHub repositories, backups, and local Skills."',
    'bundle.targets=["app","dmg"]',
    'topLevel.$schema="https://schema.tauri.app/config/2"',
    'topLevel.allowedKeys=["$schema","productName","version","identifier","build","app","bundle"]',
    'topLevel.identifier="com.skillrepotracker.desktop"',
    "topLevel.plugins=absent",
    'topLevel.productName="Skill Repo Tracker"',
  ];
}

export function writeMinimalSurfaceRepository(root, frontend = "") {
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
      pub struct AppSettings { backup_root: String }
      pub struct UpdateSettingsRequest { backup_root: Option<String> }
      fn run() {
        tauri::Builder::default()
          .plugin(tauri_plugin_dialog::init())
          .setup(|_| Ok(()))
          .invoke_handler(tauri::generate_handler![get_settings])
          .run(tauri::generate_context!())
          .expect("test app");
      }
    `,
  );
  writeFileSync(
    path.join(root, "src-tauri/src/adapters.rs"),
    `
      struct ReqwestGithubHttpAdapter(reqwest::Client);
      fn github_request_allowed(url: &reqwest::Url) -> bool {
        url.scheme() == "https" && matches!(url.host_str(), Some("api.github.com"))
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
    path.join(root, "src-tauri/capabilities/default.json"),
    JSON.stringify({
      identifier: "default",
      windows: ["main"],
      permissions: [
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-destroy",
      ],
    }),
  );
  writeFileSync(
    path.join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify(minimalTauriConfig()),
  );
  writeFileSync(
    path.join(root, "src-tauri/entitlements.plist"),
    '<?xml version="1.0"?><plist><dict/></plist>',
  );
  writeFileSync(
    path.join(root, "src/taskCoordinator.ts"),
    "export function createForegroundSchedule(_options: unknown) { return { stop() {} }; }",
  );
  writeFileSync(path.join(root, "src/App.tsx"), frontend);
}
