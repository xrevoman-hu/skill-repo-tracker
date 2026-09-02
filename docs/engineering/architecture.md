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

`module-map.json` 把 `src/` 与 `src-tauri/src/` 的每个生产文件精确归入一个 module、layer
和 owner Rule；新增文件未登记、重复归属、owner Rule/ADR 失联或越过禁止依赖边都会让
`npm run verify` 失败。TypeScript 门禁解析可确定的本地静态、side-effect、re-export 与
literal dynamic import；带插值或变量的 `import()`、`import.meta.glob` 及其他 computed Vite
入口一律 fail closed。Rust source root 只接受扁平的 `.rs` 文件；嵌套目录、basename 身份冲突
及非 Rust 文件都会失败。门禁解析 `mod` 声明和显式 `crate::module` / `super::module` 兄弟模块
引用；每个生产 module 必须沿 direct、非条件 `mod` 声明从 Cargo `lib.rs`/`main.rs` 可达，
macro、自声明或不可达环不能充数。raw identifier 与 production `#[path]` 在依赖图完成建模前 fail closed，`#[path]` 仅允许
`#[cfg(test)]` 的独立 `*_tests.rs`。生产 Rust 禁止 `include!` / `include_str!` /
`include_bytes!` 及其导入别名引入未建模输入，唯一例外是 `database.rs` 的 `cfg(test)` 历史
schema fixture 精确清单。它刻意不猜测运行时依赖注入、
宏展开或仍留在 `lib.rs` 的无限定 root item 依赖，
这些继续由编译器、测试与热点预算约束，避免用不可靠的“全知依赖图”制造假精确。

这两个目录是当前唯一自有生产 source roots。仓库禁止 Git symlink/submodule、npm
workspace/link/file package、Cargo workspace/path dependency/patch/replace，以及 Vitest 自动
发现的 `vitest.workspace.*` / `vitest.projects.*`；否则编译器或测试运行器可能执行机器资产图、
coverage 与预算没有扫描的代码。增加新的 source root 必须先让 module map、类型检查、测试发现、
coverage、权限表面积与行预算全部覆盖，再以 ADR 放开边界，不能先接入后补治理。
Vite 的 `publicDir` 固定关闭，`index.html` 是精确锁定的唯一 HTML 入口；`src/` 只允许已被
module map、strict TypeScript、CSS 检查或测试发现覆盖的扩展。WASM、raw 文本、HTML、图片等
新资产类型必须先建立可审计 inventory 与处理合同，不能借 `?url` / `?raw` 进入产品包；生产
前端也禁止 `eval`、`Function` 与 `WebAssembly` 动态执行未建档 payload。CSS 同样禁止
`@import` 与 `url()` 隐式引入依赖、远端 host 或未登记资产；PostCSS 固定为空的 inline plugin
清单，并禁止 package 字段或 `.postcssrc`/`postcss.config.*` 自动发现另一条构建执行链。
tracked 文件名与文本内容也执行最小泄密扫描：除根 `.env.example` 外禁止 `.env*`、签名私钥、
release handoff、DMG/App/`.srtmigration` 实物；禁止常见真实 token、private key 和个人 home
路径。测试路径只允许 `/Users/example`、`/Users/source-machine`、`/Users/target-machine`
这三个明确的虚构身份。
Rust 边界还会读取 `cargo metadata --locked --offline --no-deps` 的实际解析结果，确认真正的
lib、bin、build target 仍是 `src/lib.rs`、`src/main.rs`、`build.rs`，而不是只相信 manifest
文本看起来正确；兼容文件 `rust-toolchain` 被全局禁止，唯一工具链事实源是
`rust-toolchain.toml`。

已有的 `promptLibraryAdapter -> PromptsView` 类型反向依赖以精确、带 ADR 和退出条件的
exception 公开记录；exception 必须对应真实 import，依赖消失后未同步删除会失败。模块
归属迁移或放宽禁止边必须在 `module-map.json` 留下 ADR-backed move/policy change，不能在
同一次改动中静默改写架构事实。

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
治理脚本及 `scripts/__tests__/` 测试/fixture helper 同样受 `architecture-budget.json` 的
独立 tooling 预算约束；新文件最多 800 行、单行最多 800 bytes、模块最多 65,536 bytes，
不能让防腐工具或它的测试本身成为无上限的新热点。生产与治理文件同时限制物理行宽，
不能把大量语句压成单行绕过行数预算。
非测试治理脚本必须从 `package.json`、verify plan 或受保护 workflow 的入口经静态 import
可达；确需独立运行的 CLI/generator 必须在 tooling `standalone` 清单记录 kind、owner 与
`retireWhen`，孤儿脚本直接失败。所有 test-like JS 文件必须位于对应 runner 可发现的目录，
在顶层或 `describe` 内静态注册至少一个 test；Rust 外置 `*_tests.rs` 必须经精确
`#[cfg(test)]` module tree 从 Cargo root 唯一可达，test 必须是 crate/module direct item，
macro 或其他 item block 中未展开的 `#[test]` 不能作为证据；runner 条件只允许当前 macOS lane 的固定 cfg 清单。
生产 settings、Tauri commands、capability、entitlement、CSP/host 与
recurring timer 的精确清单由 `surface-budget.json` 锁定，新增项必须显式说明用途。

## 治理资产

共同词汇见 `CONTEXT.md`；七项原则到 Architecture、ADR、Rule、Invariant、回归证据与 gate
的机器索引见 `governance-assets.json`，生命周期见 `maintainability-system.md`。修改前用
`npm run governance:context` 按 changed paths 选择上下文；catalog 只保存关系，不复制正文。

## 验证层次

`npm run verify` 是本地和 CI 的唯一确定性入口；其步骤与顺序来自 tracked
`verify-plan.json`，并在 PR 上与 base 比较。每一步声明稳定 `capabilities`；退休链的最终
active replacement 必须覆盖旧步骤全部能力；现有 constitution capability 还绑定 exact
command/args，不能由新步骤只靠自报字符串冒充。历史 retired step 作为 append-only tombstone
保留，不能靠两次 PR 静默移除一类验证。
`CI / verify` 随后追加 Playwright E2E。
Coverage、MSRV、网络安全审计、性能门和发布实物验证是独立 lane；一个 lane 的绿色不能
代替另一个。发布流程
详见 `docs/rules/testing-release.md`。
