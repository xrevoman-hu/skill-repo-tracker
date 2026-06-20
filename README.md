# Skill Repo Tracker

[中文](#中文) | [English](#english)

![license](https://img.shields.io/badge/license-MIT-green)
![Tauri](https://img.shields.io/badge/Tauri-v2-blue)
![React](https://img.shields.io/badge/React-19-61dafb)
![Rust](https://img.shields.io/badge/Rust-backend-orange)
![macOS](https://img.shields.io/badge/macOS-12%2B-lightgrey)

## 中文

Skill Repo Tracker 是一个本地优先的 macOS 桌面应用，用来追踪 GitHub 仓库、备份指定 ref 的源码 ZIP、识别仓库中的 `SKILL.md`，并把远端 Skill 安装或更新到独立 Skill 主库，再按需同步到各工具目录。

它适合维护一组公开或私有 GitHub 仓库，尤其是需要持续关注 Skill 仓库更新、保留源码快照、审计备份 manifest 的个人和小团队。

当前版本：`v1.1.0`

### 功能

- **仓库追踪**：支持 `owner/repo`、GitHub URL、branch、tag 和 commit ref。
- **源码 ZIP 备份**：根据远端 SHA 与最近备份 SHA 判断是否需要备份，下载到 `.partial` 后原子化落盘。
- **Skill 识别与管理**：扫描仓库内多个 `SKILL.md`，支持安装、更新、跳过、备份后覆盖和强制覆盖。
- **独立 Skill 主库**：默认使用 `~/SkillRepoTracker/skills` 作为唯一安装、更新、删除和扫描来源。
- **可选同步目标**：可将主库 Skill 复制发布到 Claude Code、Codex、Gemini、OpenCode、OpenClaw 和 Hermes 的 Skills 目录。
- **任务与日志**：统一记录检测、备份、Skill 更新、失败重试和中断状态，默认保留最近 100 个任务。
- **本地数据**：仓库、Skill、任务、manifest、设置和计划任务写入 SQLite。
- **隐私友好**：GitHub token 存入 macOS Keychain；SQLite 只保存 token 是否已配置和最后验证时间。
- **设置页**：支持浅色/黑色主题、中文/英文、备份目录、Skill 主库目录、默认同步目标、并发数、重试次数、定时检测/备份和备份保留数量。

### 技术栈

- Tauri v2
- React 19 + TypeScript + Vite
- Rust backend commands
- SQLite via `rusqlite`
- GitHub API via `reqwest`
- macOS Keychain via `keyring`

### 快速开始

环境要求：

- macOS 12+
- Node.js 20+
- npm 10+
- Rust / Cargo 1.77+

安装依赖：

```bash
npm install
```

启动 Web 预览：

```bash
npm run dev
```

启动 Tauri 桌面开发版：

```bash
npm run tauri dev
```

Web 预览会使用 mock state；Tauri 桌面版会调用真实 Rust commands、SQLite、文件系统和 GitHub API。

如果系统找不到 `cargo`，请确认 Rust 已安装并位于 `PATH`。macOS 上通常可以临时使用：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

### 数据位置

- SQLite 数据库：macOS AppData/AppConfig 下的 `skill-repo-tracker.sqlite`
- 默认备份根目录：`~/SkillRepoBackups`
- 默认 Skill 主库目录：`~/SkillRepoTracker/skills`
- 默认同步备份目录：`~/SkillRepoTracker/sync-backups`
- 可选同步目标：`~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills`、`~/.config/opencode/skills`、`~/.openclaw/skills`、`~/.hermes/skills`
- GitHub token：macOS Keychain

Token 不会写入 SQLite、manifest 或任务日志。删除 token 后，私有仓库检测会返回权限相关错误。

### 备份语义

- “远端有更新”：`remote_head_sha != last_seen_sha`
- “有更新未备份”：`remote_head_sha != last_backup_sha`
- 时间字段只用于展示、排序和辅助理解，不作为备份判断主依据。
- 备份成功必须完成 ZIP 下载、最终文件 rename、sha256 计算、`manifest.json` 写入和 `task-log.jsonl` 写入。
- manifest 写入失败时不会更新 `last_backup_sha`。

### 构建桌面 App

生成 unsigned macOS `.app` 和 `.dmg`：

```bash
npm run tauri build -- --bundles app,dmg
```

常见产物位置：

- `src-tauri/target/release/bundle/macos/Skill Repo Tracker.app`
- `src-tauri/target/release/bundle/dmg/Skill Repo Tracker_1.1.0_*.dmg`

当前构建适合本地使用和开发验证。公开分发前，请使用 Apple Developer ID 完成签名和 notarization。

### 测试

前端构建：

```bash
npm run build
```

Rust 单元测试：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

打包检查：

```bash
npm run tauri build -- --bundles app,dmg
```

手动验收建议：

1. 添加普通仓库，仓库列表出现记录，Skill 页不新增 Skill。
2. 添加包含 `SKILL.md` 的仓库，检测后 Skill 页出现来源路径。
3. 点击“备份有更新”，生成备份任务、ZIP、`manifest.json` 和 `task-log.jsonl`。
4. 在设置页确认 Skill 主库目录可手动粘贴隐藏路径，也可通过原生目录选择器选择。
5. 设置默认同步目标，点击“同步已安装 Skills”，确认任务日志记录主库路径、目标工具、成功/失败状态和备份路径。
6. 在 Skill 详情中切换继承/自定义同步目标，自定义为空时确认仅保留在主库。
7. 对已安装 Skill 制造本地修改，点击更新时出现冲突处理弹窗。
8. 切换中文/英文、浅色/黑色主题，确认表格、Inspector、弹窗和设置页无明显溢出。

### 项目结构

```text
src/                  React + TypeScript frontend
src-tauri/            Tauri v2 Rust backend
assets/               Brand and app assets
LICENSE               MIT license
```

### FAQ

#### 为什么不是完整 Git mirror？

`v1.1.0` 仍只备份 GitHub 当前 ref 的源码 ZIP 快照。这让本地备份闭环更简单，也避免引入 Git mirror、LFS、submodule 和增量 fetch 的复杂度。

#### 普通仓库为什么会保留？

普通仓库是一等公民。即使 `skill_count = 0`，仍然可以检测远端 SHA、创建 ZIP 备份和查看备份历史。

#### Skill 更新会自动备份仓库吗？

不会。仓库备份和 Skill 更新是两个独立动作。Skill 更新先写入独立 Skill 主库，再按设置复制发布到工具目录；仓库 ZIP 备份必须在仓库页显式触发。

#### 私有仓库失败怎么办？

先在设置页保存并验证 GitHub token。如果仍失败，查看任务页日志中的 `github_not_found`、`github_rate_limited`、`ref_not_found` 或权限错误。

### 贡献

欢迎提交 Issue 和 Pull Request。建议先运行：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

请不要提交本地数据库、token、备份 ZIP、`dist/`、`node_modules/` 或 `src-tauri/target/`。

### License

MIT © 2026 xrevoman-hu

---

## English

Skill Repo Tracker is a local-first macOS desktop app for tracking GitHub repositories, backing up source ZIP snapshots for a selected ref, detecting `SKILL.md` files, and installing or updating remote Skills into an independent Skill library before optionally syncing them to tool-specific directories.

It is designed for individuals and small teams who maintain a set of public or private GitHub repositories and want a simple workflow for Skill updates, source snapshots, and auditable backup manifests.

Current version: `v1.1.0`

### Features

- **Repository tracking**: supports `owner/repo`, GitHub URLs, branches, tags, and commit refs.
- **Source ZIP backups**: compares the remote SHA with the last backup SHA, downloads to `.partial`, then atomically moves the final file into place.
- **Skill discovery and management**: scans multiple `SKILL.md` files per repository and supports install, update, skip, backup-then-overwrite, and force overwrite flows.
- **Independent Skill library**: uses `~/SkillRepoTracker/skills` as the single source of truth for installs, updates, deletes, and scans.
- **Optional sync targets**: can copy Skills from the library into Claude Code, Codex, Gemini, OpenCode, OpenClaw, and Hermes Skills directories.
- **Task and log history**: records checks, backups, Skill updates, retries, and interrupted states. The app keeps the latest 100 tasks by default.
- **Local data**: repositories, Skills, tasks, manifests, settings, and schedules are stored in SQLite.
- **Privacy-minded token storage**: GitHub tokens are stored in macOS Keychain. SQLite only stores whether a token is configured and the last verification time.
- **Settings**: light/dark theme, Chinese/English UI, backup root, Skill library root, default sync targets, concurrency, retry count, schedules, and backup retention.

### Stack

- Tauri v2
- React 19 + TypeScript + Vite
- Rust backend commands
- SQLite via `rusqlite`
- GitHub API via `reqwest`
- macOS Keychain via `keyring`

### Quick Start

Requirements:

- macOS 12+
- Node.js 20+
- npm 10+
- Rust / Cargo 1.77+

Install dependencies:

```bash
npm install
```

Start the Web preview:

```bash
npm run dev
```

Start the Tauri desktop app in development mode:

```bash
npm run tauri dev
```

The Web preview uses mock state. The Tauri desktop app calls the real Rust commands, SQLite database, filesystem, and GitHub API.

If `cargo` is not found, make sure Rust is installed and available in `PATH`. On macOS, you can often use:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

### Data Locations

- SQLite database: macOS AppData/AppConfig directory, under `skill-repo-tracker.sqlite`
- Default backup root: `~/SkillRepoBackups`
- Default Skill library root: `~/SkillRepoTracker/skills`
- Default sync backup root: `~/SkillRepoTracker/sync-backups`
- Optional sync targets: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/skills`, `~/.config/opencode/skills`, `~/.openclaw/skills`, `~/.hermes/skills`
- GitHub token: macOS Keychain

Tokens are not written to SQLite, manifests, or task logs. If the token is removed, private repository checks will fail with permission-related errors.

### Backup Semantics

- “Remote has updates”: `remote_head_sha != last_seen_sha`
- “Updated but not backed up”: `remote_head_sha != last_backup_sha`
- Time fields are for display, sorting, and context only. They are not the primary backup decision input.
- A successful backup requires ZIP download, final file rename, sha256 calculation, `manifest.json`, and `task-log.jsonl`.
- If manifest writing fails, `last_backup_sha` is not updated.

### Build The Desktop App

Build unsigned macOS `.app` and `.dmg` artifacts:

```bash
npm run tauri build -- --bundles app,dmg
```

Typical output paths:

- `src-tauri/target/release/bundle/macos/Skill Repo Tracker.app`
- `src-tauri/target/release/bundle/dmg/Skill Repo Tracker_1.1.0_*.dmg`

The local build is suitable for development and local verification. Public distribution should use Apple Developer ID signing and notarization.

### Tests

Frontend build:

```bash
npm run build
```

Rust unit tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Packaging check:

```bash
npm run tauri build -- --bundles app,dmg
```

Suggested manual checks:

1. Add a normal repository and confirm it appears in the repository list without adding a Skill.
2. Add a repository with `SKILL.md` and confirm the Skill page shows the source path.
3. Click “backup updated repositories” and confirm the task, ZIP, `manifest.json`, and `task-log.jsonl` are created.
4. In Settings, confirm the Skill library root accepts pasted hidden paths and can also be selected through the native folder picker.
5. Set default sync targets, click “Sync installed Skills”, and confirm task logs include the library path, tool targets, success/failure state, and backup paths.
6. In Skill detail, switch between inherited and custom sync targets; custom with no targets should keep the Skill in the library only.
7. Modify an installed Skill locally and confirm the update conflict dialog appears.
8. Toggle Chinese/English and light/dark themes and check that tables, inspectors, dialogs, and settings remain readable.

### Project Structure

```text
src/                  React + TypeScript frontend
src-tauri/            Tauri v2 Rust backend
assets/               Brand and app assets
LICENSE               MIT license
```

### FAQ

#### Why not a full Git mirror?

`v1.1.0` still backs up source ZIP snapshots for the current GitHub ref. This keeps the local backup workflow simpler and avoids the complexity of Git mirrors, LFS, submodules, and incremental fetches.

#### Why keep normal repositories?

Normal repositories are first-class entries. Even when `skill_count = 0`, they can still be checked for remote SHA changes, backed up as ZIP snapshots, and inspected through backup history.

#### Does a Skill update automatically back up the repository?

No. Repository backups and Skill updates are separate actions. Skill updates first write to the independent Skill library, then copy-publish to configured tool directories. Repository ZIP backups must be triggered from the repository view.

#### What if a private repository fails?

Save and validate a GitHub token in Settings first. If it still fails, inspect task logs for `github_not_found`, `github_rate_limited`, `ref_not_found`, or permission errors.

### Contributing

Issues and pull requests are welcome. Before opening a PR, please run:

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Please do not commit local databases, tokens, backup ZIP files, `dist/`, `node_modules/`, or `src-tauri/target/`.

### License

MIT © 2026 xrevoman-hu
