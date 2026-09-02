import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function discoverCapabilitySurface(root) {
  const permissionRoot = path.join(root, "src-tauri/permissions");
  try {
    lstatSync(permissionRoot);
    throw new Error(
      "src-tauri/permissions is forbidden; custom Tauri ACL definitions require a dedicated surface and ADR",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const capabilityRoot = path.join(root, "src-tauri/capabilities");
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) {
        throw new Error(
          `${path.relative(root, absolute).split(path.sep).join("/")} capability must not be a symbolic link`,
        );
      } else if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new Error(
          `${path.relative(root, absolute).split(path.sep).join("/")} capability must be a regular .json file`,
        );
      } else files.push(absolute);
    }
  };
  visit(capabilityRoot);

  const surface = [];
  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const capability = JSON.parse(readFileSync(absolute, "utf8"));
    const allowedKeys = new Set([
      "$schema",
      "identifier",
      "description",
      "windows",
      "permissions",
    ]);
    for (const key of Object.keys(capability ?? {})) {
      if (!allowedKeys.has(key)) {
        throw new Error(`${relative} contains an unsupported top-level field: ${key}`);
      }
    }
    const identifier = capability?.identifier;
    if (typeof identifier !== "string" || !identifier.trim()) {
      throw new Error(`${relative} must define a non-empty capability identifier`);
    }
    if (
      !Array.isArray(capability.windows) ||
      capability.windows.some((window) => typeof window !== "string" || !window.trim())
    ) {
      throw new Error(`${relative} capability windows must be a string array`);
    }
    if (!Array.isArray(capability.permissions)) {
      throw new Error(`${relative} capability permissions must be an array`);
    }
    const prefix = `${relative}#${identifier}`;
    surface.push(`${prefix}:identifier=${identifier}`);
    for (const window of capability.windows) surface.push(`${prefix}:window=${window}`);
    for (const permission of capability.permissions) {
      if (
        typeof permission !== "string" &&
        (!permission ||
          typeof permission !== "object" ||
          typeof permission.identifier !== "string")
      ) {
        throw new Error(`${relative} contains an unsupported capability permission`);
      }
      surface.push(
        `${prefix}:permission=${typeof permission === "string" ? permission : canonicalJson(permission)}`,
      );
    }
  }
  return surface;
}

export function discoverTauriSecuritySurface(tauriConfig) {
  const allowedTopLevelKeys = [
    "$schema",
    "productName",
    "version",
    "identifier",
    "build",
    "app",
    "bundle",
  ];
  if (!tauriConfig || typeof tauriConfig !== "object" || Array.isArray(tauriConfig)) {
    throw new Error("tauri.conf.json must contain one top-level object");
  }
  for (const key of Object.keys(tauriConfig)) {
    if (!allowedTopLevelKeys.includes(key)) {
      throw new Error(`tauri.conf.json topLevel.${key} is forbidden`);
    }
  }
  const expectedIdentity = {
    $schema: "https://schema.tauri.app/config/2",
    productName: "Skill Repo Tracker",
    identifier: "com.skillrepotracker.desktop",
  };
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (tauriConfig[key] !== expected) {
      throw new Error(`tauri.conf.json ${key} must equal ${JSON.stringify(expected)}`);
    }
  }
  if (typeof tauriConfig.version !== "string" || !tauriConfig.version.trim()) {
    throw new Error("tauri.conf.json version must be a non-empty string");
  }

  const build = tauriConfig?.build;
  const expectedBuild = {
    beforeBuildCommand: "npm run build",
    beforeDevCommand: "npm run dev",
    devUrl: "http://127.0.0.1:5173",
    frontendDist: "../dist",
  };
  if (!build || typeof build !== "object" || Array.isArray(build)) {
    throw new Error("tauri.conf.json must define build as an object");
  }
  const allowedBuildKeys = Object.keys(expectedBuild);
  for (const key of Object.keys(build)) {
    if (!allowedBuildKeys.includes(key)) {
      throw new Error(`tauri.conf.json build.${key} is forbidden`);
    }
  }
  for (const [key, expected] of Object.entries(expectedBuild)) {
    if (build[key] !== expected) {
      throw new Error(`tauri.conf.json build.${key} must equal ${JSON.stringify(expected)}`);
    }
  }
  if (Object.hasOwn(build, "beforeBundleCommand")) {
    throw new Error("tauri.conf.json build.beforeBundleCommand is forbidden");
  }

  const bundle = tauriConfig?.bundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("tauri.conf.json must define bundle as an object");
  }
  const expectedBundle = {
    active: true,
    targets: ["app", "dmg"],
    category: "DeveloperTool",
    icon: ["icons/icon.png", "icons/icon.icns"],
    shortDescription: "Track GitHub repositories, backups, and local Skills.",
    longDescription: "A local-first GitHub repository and Skills update manager.",
  };
  const allowedBundleKeys = [...Object.keys(expectedBundle), "macOS"];
  for (const key of Object.keys(bundle)) {
    if (!allowedBundleKeys.includes(key)) {
      throw new Error(`tauri.conf.json bundle.${key} is forbidden`);
    }
  }
  for (const [key, expected] of Object.entries(expectedBundle)) {
    if (canonicalJson(bundle[key]) !== canonicalJson(expected)) {
      throw new Error(`tauri.conf.json bundle.${key} must equal ${canonicalJson(expected)}`);
    }
  }

  const macOS = bundle.macOS;
  const expectedMacOS = {
    hardenedRuntime: true,
    entitlements: "entitlements.plist",
    minimumSystemVersion: "12.0",
  };
  if (!macOS || typeof macOS !== "object" || Array.isArray(macOS)) {
    throw new Error("tauri.conf.json bundle.macOS must be an object");
  }
  for (const key of Object.keys(macOS)) {
    if (!Object.hasOwn(expectedMacOS, key)) {
      throw new Error(`tauri.conf.json bundle.macOS.${key} is forbidden`);
    }
  }
  for (const [key, expected] of Object.entries(expectedMacOS)) {
    if (canonicalJson(macOS[key]) !== canonicalJson(expected)) {
      throw new Error(`tauri.conf.json bundle.macOS.${key} must equal ${canonicalJson(expected)}`);
    }
  }

  const app = tauriConfig?.app;
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw new Error("tauri.conf.json must define app as an object");
  }
  const allowedAppKeys = ["windows", "security"];
  for (const key of Object.keys(app)) {
    if (!allowedAppKeys.includes(key)) throw new Error(`tauri.conf.json app.${key} is forbidden`);
  }
  const expectedWindow = {
    title: "Skill Repo Tracker",
    width: 1440,
    height: 1024,
    minWidth: 1120,
    minHeight: 720,
    resizable: true,
  };
  const windows = app.windows ?? [];
  if (!Array.isArray(windows)) throw new Error("tauri.conf.json app.windows must be an array");
  if (windows.length !== 1) throw new Error("tauri.conf.json app.windows must contain one window");
  for (const [index, window] of windows.entries()) {
    if (!window || typeof window !== "object" || Array.isArray(window)) {
      throw new Error(`tauri.conf.json app.windows[${index}] must be an object`);
    }
    for (const key of Object.keys(window)) {
      if (!Object.hasOwn(expectedWindow, key)) {
        throw new Error(`tauri.conf.json app.windows[${index}].${key} is forbidden`);
      }
    }
    if (canonicalJson(window) !== canonicalJson(expectedWindow)) {
      throw new Error(`tauri.conf.json app.windows[${index}] must equal the reviewed window`);
    }
  }

  const security = app.security;
  if (!security || typeof security !== "object" || Array.isArray(security)) {
    throw new Error("tauri.conf.json must define app.security as an object");
  }
  if (Object.hasOwn(security, "capabilities")) {
    throw new Error(
      "tauri.conf.json app.security.capabilities is forbidden; use tracked capability files",
    );
  }
  const allowedSecurityKeys = ["assetProtocol", "csp", "dangerousDisableAssetCspModification"];
  for (const key of Object.keys(security)) {
    if (!allowedSecurityKeys.includes(key)) {
      throw new Error(`tauri.conf.json app.security.${key} is forbidden`);
    }
  }
  const assetProtocol = security.assetProtocol ?? {};
  if (!assetProtocol || typeof assetProtocol !== "object" || Array.isArray(assetProtocol)) {
    throw new Error("tauri.conf.json app.security.assetProtocol must be an object");
  }

  return [
    `topLevel.allowedKeys=${canonicalJson(allowedTopLevelKeys)}`,
    `topLevel.$schema=${canonicalJson(tauriConfig.$schema)}`,
    `topLevel.identifier=${canonicalJson(tauriConfig.identifier)}`,
    `topLevel.productName=${canonicalJson(tauriConfig.productName)}`,
    "topLevel.plugins=absent",
    `build.beforeBuildCommand=${canonicalJson(build.beforeBuildCommand)}`,
    `build.allowedKeys=${canonicalJson(allowedBuildKeys)}`,
    "build.beforeBundleCommand=absent",
    `build.beforeDevCommand=${canonicalJson(build.beforeDevCommand)}`,
    `build.devUrl=${canonicalJson(build.devUrl)}`,
    `build.frontendDist=${canonicalJson(build.frontendDist)}`,
    `bundle.allowedKeys=${canonicalJson(allowedBundleKeys)}`,
    ...Object.keys(expectedBundle).map((key) => `bundle.${key}=${canonicalJson(bundle[key])}`),
    "bundle.externalBin=absent",
    `bundle.macOS.allowedKeys=${canonicalJson(Object.keys(expectedMacOS))}`,
    ...Object.keys(expectedMacOS).map((key) => `bundle.macOS.${key}=${canonicalJson(macOS[key])}`),
    "bundle.resources=absent",
    `app.allowedKeys=${canonicalJson(allowedAppKeys)}`,
    `app.windows=${canonicalJson(windows)}`,
    "app.windows.url=absent",
    "app.withGlobalTauri=false",
    "app.security.capabilities=external-files-only",
    `app.security.allowedKeys=${canonicalJson(allowedSecurityKeys)}`,
    `app.security.assetProtocol.enable=${canonicalJson(assetProtocol.enable ?? false)}`,
    `app.security.assetProtocol.scope=${canonicalJson(assetProtocol.scope ?? [])}`,
    `app.security.dangerousDisableAssetCspModification=${canonicalJson(
      security.dangerousDisableAssetCspModification ?? false,
    )}`,
  ];
}
