# Release Notes

## v1.1.1 - 默认同步与产品说明更新

### Summary

这次版本把默认同步目标收窄到 Claude Code 和 Codex，并把 README 从功能清单改成产品价值说明。同步和取消同步的动作也在界面里写清楚：取消勾选不会静默删除文件，只有安装、更新、恢复、单个 Skill 自定义目标保存，或点击“应用同步设置到已安装 Skills”时才会执行同步调整。

### Highlights

- 默认同步目标固定为 Claude Code 和 Codex。
- Gemini、OpenCode、OpenClaw、Hermes 不再默认勾选，需要用户主动开启。
- 旧的“按本机已有工具目录自动默认”设置会迁移到 Claude Code + Codex；用户已显式改成其他目标组合时保留原设置。
- 设置页补充取消勾选后的动作说明，强调主库不会被删除。
- 单个 Skill 自定义同步目标补充即时生效说明。
- README 改为中文优先的产品说明，并加入真实界面截图。

### Sync Safety

- 取消同步只处理本应用发布并记录过的目标副本。
- 被移除的目标副本会先备份到 `~/SkillRepoTracker/sync-backups/...`。
- `~/SkillRepoTracker/skills` 仍然是唯一 Skill 主库。

### Verification

- `npm run build`
- `./node_modules/.bin/tsc --noEmit`
- `PATH=/Users/zhiwei/.cargo/bin:$PATH cargo fmt --check --manifest-path src-tauri/Cargo.toml`
- `PATH=/Users/zhiwei/.cargo/bin:$PATH cargo test --manifest-path src-tauri/Cargo.toml`
- `PATH=/Users/zhiwei/.cargo/bin:$PATH npm run tauri build -- --bundles app,dmg`

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
