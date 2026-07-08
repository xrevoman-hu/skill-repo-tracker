# Skill Repo Tracker Agent Guide

## Communication

- 使用简体中文和用户沟通、汇报和制定计划。
- 调用技能时，将用户的中文意图和对应英文技术意图一起匹配，例如“列表排序、搜索、时间列”同时按 “React table sorting, search, timestamp columns” 理解。
- 面向用户的文档优先中文；API 名称、命令、数据库字段、组件名和文件路径保持英文原文，方便检索。

## Project Shape

- 本项目是本地优先的 macOS 桌面应用，技术栈为 Tauri 2、React、TypeScript、Rust、SQLite。
- 前端入口集中在 `src/App.tsx`、`src/GitHubWorkbench.tsx`、`src/PluginsView.tsx` 和 `src/styles.css`。
- 后端主逻辑集中在 `src-tauri/src/lib.rs`，插件扫描逻辑在 `src-tauri/src/plugins.rs`。
- SQLite 数据库文件名由后端决定，为 `skill-repo-tracker.sqlite`。

## Git And Release Boundaries

- 远程 `origin/main` 是发布和主分支事实来源；报告或发布前必须用远程 ref 校验当前状态。
- 不要在未确认的情况下打 tag、构建 DMG、创建 GitHub Release 或修改版本号。
- 公开产品截图保留在 `docs/images/v1.1.8/`；宣传草稿、内部素材和生成过程文件不进入公开发布面。
- 宣传资料默认加入 `.gitignore`，例如 `docs/promo/`、`docs/internal/`、旧宣传图、`assets/brand/` 和生成型宣传素材目录。

## Local Artifact Rules

- 只有用户明确要求生成本地验证包时，才构建 Apple Silicon `.app` 和 `.dmg`。
- 本地验证包不等于正式发布：不打 tag、不创建 GitHub Release、不推送远程，除非用户同时明确要求。
- 构建前先运行 `npm run typecheck`、`npm run build`、`PATH=/Users/zhiwei/.cargo/bin:$PATH cargo fmt --check --manifest-path src-tauri/Cargo.toml`、`PATH=/Users/zhiwei/.cargo/bin:$PATH cargo test --manifest-path src-tauri/Cargo.toml` 和 `git diff --check`。
- 构建命令固定为 `PATH=/Users/zhiwei/.cargo/bin:$PATH npm run tauri build -- --bundles app,dmg`。
- 本地构建文件名固定为 `Skill Repo Tracker_<version>_aarch64.dmg`，路径在 `src-tauri/target/release/bundle/dmg/`。
- 本地验证包使用 ad-hoc 签名；必须校验 `.app`、`.dmg`、`hdiutil verify`、只读挂载内容、挂载内 app 签名，并记录文件大小、SHA-256 和当前 commit。
- ad-hoc 包不是 Developer ID signed，也不是 Apple notarized；交付说明必须提醒首次启动可能需要 Control-click Open、Privacy & Security -> Open Anyway 或 `xattr -cr`。

## GitHub Release Rules

- 只有用户明确要求“发布”、“发版”或“GitHub Release”时，才执行正式发布流程。
- 正式发布前必须同步版本到 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`src-tauri/src/lib.rs` 的 `APP_VERSION` 和 `APP_USER_AGENT`。
- Release notes 使用中英文结构，优先讲功能价值和用户可感知变化，不展开内部实现细节。
- GitHub Release 上传资产名固定为 `Skill.Repo.Tracker_<version>_aarch64.dmg`；本地构建名仍保留空格形式。
- 正式发布流程必须创建 annotated tag，推送 `main` 和 tag 到 `origin`，用 `gh release create` 创建非 draft、非 prerelease 的 Release，并远端校验 main、tag、Release asset 和 digest。
- GitHub CLI Release 校验只使用支持字段：`tagName`、`name`、`url`、`isDraft`、`isPrerelease` 和 `assets`。

## Data And Safety

- GitHub token 只应通过 macOS Keychain 管理，不能写入 SQLite、迁移包、日志或文档。
- 迁移包只能包含非敏感元数据、仓库、Skills、插件和备注；不能包含 token、Keychain key、本地源码、源码 ZIP 或任务日志。
- `skill_library_root` 是 Skill 主库的事实来源；工具目录只是发布目标。
- `skill_sync_records` 是删除/回滚安全边界，只能移除应用自己发布并记录过的副本。

## Local Services

- 本地 MySQL 由 FlyEnv 管理，路径为 `/opt/homebrew/Cellar/mysql@8.4/8.4.5`。
- 如果后续任务需要 MySQL 且 3306 端口没有监听服务，只提示用户去 FlyEnv 启动数据库；不要安装新的 MySQL。

## Verification

- 常规前端验证：`npm run typecheck` 和 `npm run build`。
- Rust 验证使用本机 Cargo 路径：`PATH=/Users/zhiwei/.cargo/bin:$PATH cargo fmt --check --manifest-path src-tauri/Cargo.toml`。
- Rust 测试：`PATH=/Users/zhiwei/.cargo/bin:$PATH cargo test --manifest-path src-tauri/Cargo.toml`。
- 提交前运行 `git diff --check`，并确认没有宣传/内部素材误入暂存区。
