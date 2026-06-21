# Release Notes

## v1.1.2 - Skill 同步安全修正版

这个版本延续 v1.1.1 的 Skill 同步安全策略，适用于 Apple Silicon macOS 12+。

- 默认同步目标仍然只有 Claude Code 和 Codex，其他工具需要手动开启。
- 已自定义过同步目标的 Skill 会保留原设置。
- 取消同步目标不会立刻删除主库内容；批量应用或保存单个 Skill 设置时，应用会先备份再调整已发布副本。
- 主库仍然是 `~/SkillRepoTracker/skills`，工具目录只是发布目标。

下载说明：Apple Silicon，macOS 12+。

## v1.1.1 - 默认同步与产品说明更新

这个版本让 Skill 同步更安全、更可预期。

- 默认只发布到 Claude Code 和 Codex，其他工具需要手动开启。
- 已自定义过同步目标的 Skill 会保留原设置。
- 取消某个默认目标不会立刻删除文件；批量应用或保存单个 Skill 设置时，应用会先备份再调整已发布副本。
- 主库仍然是 `~/SkillRepoTracker/skills`，工具目录只是发布目标。

下载说明：Apple Silicon，macOS 12+。

## v1.1.0 - Independent Skill Library

This release makes Skill Repo Tracker independent from cc-switch. The app now owns one Skill library at `~/SkillRepoTracker/skills` and treats tool-specific Skill directories as optional publish targets.

- Replaced the frontend folder picker with a Rust-backed native directory picker.
- Added editable folder inputs so hidden paths can be pasted and validated manually.
- Added optional copy-based sync targets for Claude Code, Codex, Gemini, OpenCode, OpenClaw, and Hermes.
- Added per-Skill sync target overrides with inherited or custom target sets.
- Added sync records so the app only removes published copies it created.
- Added backup-before-replace behavior for sync, unsync, restore, and delete flows.
- Added a manual action to apply sync settings to installed Skills.
