# Skill Repo Tracker v1.1.8 Local DMG Install Validation

Status: passed on 2026-07-03 16:35 Asia/Shanghai.

This file records the local-install validation package for v1.1.8. The target
is a locally installable ad-hoc signed DMG, not a Developer ID signed or
Apple-notarized public release.

## Expected Checks

- Build `.app` and `.dmg`.
- Ad-hoc re-sign `.app` with hardened runtime and entitlements.
- Rebuild DMG from the signed app bundle.
- Verify SHA-256.
- Run `hdiutil verify`.
- Mount DMG.
- Verify mounted app with `codesign --verify --deep --strict --verbose=2`.
- Copy app to `/Applications/Skill Repo Tracker.app`, backing up an existing app first when present.
- Launch copied app once and confirm the main window opens.

## Result

- `npm run build`: passed.
- `./node_modules/.bin/tsc --noEmit`: passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: passed, 39 tests.
- `npm run tauri build -- --bundles app,dmg`: passed after rerun outside the sandbox for DMG creation.
- `.app` ad-hoc re-signed with hardened runtime and `src-tauri/entitlements.plist`.
- DMG rebuilt from the signed app bundle with an `Applications` alias.
- DMG ad-hoc signed.
- SHA-256: `72df3efdb9fb9a490685050bebb6c14796922d3ce4088aa8dccdb9f2bdf7a8b7`.
- Size: `7587994` bytes.
- `hdiutil verify`: passed.
- Mounted DMG contains `Skill Repo Tracker.app` and `Applications -> /Applications`.
- Mounted `.app` passed `codesign --verify --deep --strict --verbose=2`.
- Existing `/Applications/Skill Repo Tracker.app` backed up to `/private/tmp/Skill Repo Tracker.app.backup-20260703-163459`.
- New `.app` copied to `/Applications/Skill Repo Tracker.app`.
- Installed `.app` passed `codesign --verify --deep --strict --verbose=2`.
- Installed app launched from `/Applications`; `System Events` reported 1 window.

## Distribution Boundary

This package is suitable for zero-cost testing through GitHub Releases. It is
not a Developer ID signed or Apple-notarized no-warning public installer.
