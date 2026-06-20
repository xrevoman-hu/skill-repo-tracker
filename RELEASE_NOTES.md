# Release Notes

## v1.1.0 - Independent Skill Library

### Summary

This release fully removes the cc-switch-based workflow from Skill Repo Tracker. The app now owns an independent Skill library at `~/SkillRepoTracker/skills` and treats tool-specific Skills directories only as optional publish targets.

### Highlights

- Replaced the frontend folder picker with a Rust-backed native Tauri directory picker.
- Added editable folder inputs so hidden paths can be pasted and validated manually.
- Added `~/SkillRepoTracker/skills` as the default Skill library root.
- Added optional copy-based sync targets for Claude Code, Codex, Gemini, OpenCode, OpenClaw, and Hermes.
- Added per-Skill sync target overrides with inherited or custom target sets.
- Added sync records so the app only removes published copies it created.
- Added backup-before-replace behavior for sync, unsync, restore, and delete flows.
- Added a manual “Sync installed Skills” action in Settings.
- Removed the unused frontend `@tauri-apps/plugin-dialog` dependency.

### Breaking / Migration Notes

- cc-switch is no longer a default path, dependency, sync strategy, or source of truth.
- The new default install location is `~/SkillRepoTracker/skills`.
- Existing explicit `skills_root` settings are copied into the new library on first run; old directories are not moved or deleted.
- Symlink sync is not exposed in this release. Publishing uses safe copy replacement only.

### Verification

- `npm run build`
- `./node_modules/.bin/tsc --noEmit`
- `PATH=/Users/zhiwei/.cargo/bin:$PATH cargo fmt --check --manifest-path src-tauri/Cargo.toml`
- `PATH=/Users/zhiwei/.cargo/bin:$PATH cargo test --manifest-path src-tauri/Cargo.toml`
- `PATH=/Users/zhiwei/.cargo/bin:$PATH npm run tauri build -- --bundles app,dmg`
