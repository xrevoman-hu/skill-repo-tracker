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
