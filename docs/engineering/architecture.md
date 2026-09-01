# Skill Repo Tracker 架构与演进边界

本文是可提交、可审查的架构事实源。机器私有路径和本机约束留在不入库的
`AGENTS.md`；产品边界、模块依赖与长期决策必须写在本文、ADR 或 `docs/rules/`。

## 产品边界

Skill Repo Tracker 是 local-first macOS 桌面应用：React/TypeScript 负责交互，
Tauri command 是进程边界，Rust 服务负责 SQLite、Keychain、文件系统和 GitHub
访问。SQLite 保存非敏感元数据；GitHub token 只存 macOS Keychain。Web demo
必须通过 `DemoAppService` 提供数据，不能在 View 内散布运行时分支。

## 依赖方向

```text
React View -> feature controller/reducer -> AppService port
                                           |-> TauriAppService -> Tauri commands
                                           `-> DemoAppService  -> deterministic fixtures

Tauri commands -> domain service -> repository/adapter -> SQLite | Keychain | GitHub | FS
```

- View 可依赖 contracts、共享 UI primitives、i18n 和 design tokens。
- adapter 可以实现领域 port，但不能反向从 View 导入类型。
- Tauri command 只做输入校验、鉴权/路径边界和响应映射，不承载工作流。
- `src-tauri/src/lib.rs` 最终只保留状态装配、command 注册和 `run`。

## 数据与并发不变量

- 数据库变更遵循追加式 `schema_migrations`，发布过的迁移不得重写。
- 文件替换必须在同一文件系统内临时写入、校验、原子替换；失败不得暴露半成品。
- 任务采用 single-flight + generation：同一资源只允许一个有效执行者，晚回流的旧
  generation 不得覆盖新结果。
- 调度仅在应用前台存活；任务完成后才计算下一次触发，慢任务不会跨间隔重入。
- Skill 主库是事实源；工具目录是发布副本，删除只依据 `skill_sync_records`。

## 演进预算

机器执行的预算在 `architecture-budget.json`。既有热点上限只能下降；新增生产模块
不得超过 800 行，不能通过把新文件追加为热点来获得例外。超过 1,000 行的既有例外
必须有 ADR，并在拆分 PR 中同步下调预算。
阶段目标是 `App.tsx < 700`、`lib.rs < 500`。新功能不得继续堆入这些热点。

## 验证层次

`npm run verify` 是本地和 CI 的唯一确定性入口；`CI / verify` 随后追加 Playwright E2E。
Coverage、MSRV、网络安全审计、性能门和发布实物验证是独立 lane；一个 lane 的绿色不能
代替另一个。发布流程
详见 `docs/rules/testing-release.md`。
