# macOS Release Checklist

This checklist has two lanes:

- Zero-cost test distribution: ad-hoc signed `.app` and `.dmg`, published with
  clear manual Gatekeeper instructions.
- Public no-warning distribution: Developer ID signed and Apple notarized DMG.

Do not describe an ad-hoc package as notarized or no-warning.

## Zero-Cost Test Distribution

Use this lane when no Apple Developer ID signing identity is available.

```bash
APP="src-tauri/target/release/bundle/macos/Skill Repo Tracker.app"
DMG="src-tauri/target/release/bundle/dmg/Skill Repo Tracker_1.1.8_aarch64.dmg"

codesign --force --deep --sign - "$APP"
codesign --force --sign - "$DMG"
codesign --verify --deep --strict --verbose=4 "$APP"
codesign --verify --verbose=4 "$DMG"
hdiutil verify "$DMG"
```

Release notes must tell users that first launch may require Control-click/Open,
Privacy & Security -> Open Anyway, or `xattr -cr` after download.

## Public No-Warning Distribution

## Required Signing Inputs

- A valid `Developer ID Application` certificate must appear in:

```bash
security find-identity -v -p codesigning
```

- Notarization credentials must be available through Apple ID environment variables, App Store Connect API key variables, or a stored `notarytool` keychain profile.
- Secrets must stay outside the repository. Prefer environment variables such as `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`, or an Apple API key profile.

## Build

```bash
npm run build
npm run typecheck
PATH=/Users/zhiwei/.cargo/bin:$PATH cargo fmt --check --manifest-path src-tauri/Cargo.toml
PATH=/Users/zhiwei/.cargo/bin:$PATH cargo test --manifest-path src-tauri/Cargo.toml
PATH=/Users/zhiwei/.cargo/bin:$PATH npm run tauri build -- --bundles app,dmg
```

The Tauri config enables hardened runtime and uses `src-tauri/entitlements.plist`. Provide the signing identity through the build environment instead of committing a personal certificate name.

## Artifact Validation

```bash
APP="src-tauri/target/release/bundle/macos/Skill Repo Tracker.app"
DMG="src-tauri/target/release/bundle/dmg/Skill Repo Tracker_1.1.8_aarch64.dmg"

hdiutil verify "$DMG"
hdiutil imageinfo "$DMG"
codesign --display --verbose=4 "$APP"
codesign --verify --deep --strict --verbose=4 "$APP"
spctl --assess --type execute --verbose=4 "$APP"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
xcrun stapler validate "$DMG"
```

Expected release state:

- `codesign` reports a real Developer ID identity, not `Signature=adhoc`.
- `TeamIdentifier` is present.
- `codesign --verify --deep --strict` succeeds.
- `spctl` accepts both the app and the DMG.
- `stapler validate` succeeds for the DMG.

## Install-Path Acceptance

Run this on a clean test user or machine before creating the GitHub Release.

```bash
MOUNT_DIR="$(mktemp -d /tmp/srt-dmg.XXXXXX)"
hdiutil attach "$DMG" -readonly -nobrowse -noautoopen -mountpoint "$MOUNT_DIR"
ditto "$MOUNT_DIR/Skill Repo Tracker.app" "/Applications/Skill Repo Tracker.app"
codesign --verify --deep --strict --verbose=4 "/Applications/Skill Repo Tracker.app"
spctl --assess --type execute --verbose=4 "/Applications/Skill Repo Tracker.app"
open "/Applications/Skill Repo Tracker.app"
hdiutil detach "$MOUNT_DIR"
```

The app must launch without the macOS "damaged" warning.

## Public No-Warning Publish Gate

Stop before publishing a no-warning public DMG when any of these are true:

- No valid Developer ID identity is installed.
- Notarization credentials are unavailable.
- The built app is unsigned or only ad-hoc signed.
- `codesign`, `spctl`, or `stapler` validation fails.
- The app has not been launched from the copied `/Applications` path.
