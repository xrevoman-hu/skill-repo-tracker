# Release Notes

## v1.2.5 - 可执行治理与安全边界收口

这个补丁版不新增产品功能，而是把架构、Rules、ADR、高风险不变量和发布实物合同收敛成可跟随 Git 演进、可在本地与 GitHub 上自动执行的治理体系。

- `npm run verify` 继续作为唯一确定性入口；变更路径会选出应复审的 Rule、ADR 和 Invariant，架构、模块、表面积与验证计划预算会阻止新腐化。
- `main` 现在精确要求 `verify`、`coverage`、`msrv` 和 `Trusted policy / guard` 四项检查；治理关键路径必须在当前 PR head 上完成审查，新 push 会使旧标签证据失效。
- GitHub 治理检查器只精确识别 GitHub 托管的 `Dependabot Updates` 动态 workflow；未知动态 workflow、缺失路径或未知状态仍然 fail closed。
- Keychain service/account 限定在既有 namespace；CSP 固定 `form-action 'none'`，Tauri capability 只保留实际使用的 event/window 权限，外部导航只允许无凭据、无端口的 `https://github.com` URL，GitHub HTTP 只允许 HTTPS 且不继承环境代理。
- 统一发布事实链分别核对本地 commit、annotated tag、GitHub Release、远程 digest 和重新下载的 DMG，绿色源码检查不再被误当作已发布完成。
- 本版不改变 SQLite schema、设置、后台状态或系统权限；v1.2.4 的 Skill canonical/legacy hash 与源码 ZIP 120 秒修复保持原样，不作为本版新功能重复计入。
- Apple Silicon 安装包继续采用 ad-hoc 签名，不是 Developer ID 签名，也没有经过 Apple notarization；首次打开若被 macOS 拦截，请在 Finder 中按住 Control 点击 App 并选择“打开”，或在“系统设置 -> 隐私与安全性”中选择“仍要打开”。

English summary: v1.2.5 adds no product feature. It makes the tracked architecture, Rules, ADRs, invariants, budgets, and release artifact contract executable; activates four exact `main` checks (`verify`, `coverage`, `msrv`, and `Trusted policy / guard`); recognizes only GitHub's exact managed Dependabot workflow tuple while unknown workflows still fail closed; and tightens the existing Keychain namespace, CSP, minimal Tauri capability, external GitHub navigation, and HTTPS-only transport boundaries. The release chain now verifies the exact commit, annotated tag, GitHub Release metadata, digest, and freshly downloaded DMG. The v1.2.4 Skill digest and 120-second source-ZIP fixes remain unchanged and are not presented as v1.2.5 features. The Apple Silicon package remains ad-hoc signed, not Developer ID signed, and not Apple notarized. If macOS blocks the first launch, Control-click the app in Finder and choose Open, or use System Settings -> Privacy & Security -> Open Anyway.

## v1.2.4 - Skill 更新哈希兼容与大 ZIP 读取修复

这个补丁版修复了少数 Skill 在远端目录同时包含同名词干的文件和子目录时，下载 ZIP 与临时落盘目录会采用不同排序语义、从而导致更新校验失败的问题；同时修复较大源码 ZIP 被普通 GitHub API 的 30 秒预算过早中断的问题。

- ZIP 扫描与目录复验现在共享按相对路径组件排序的 canonical 摘要语义，`topic.md` 与 `topic/...` 等同词干路径不再产生伪哈希差异。
- 对 v1.2.3 已保存的旧摘要提供严格兼容迁移：只有同一固定远端 SHA、且本次下载内容独立复算命中 legacy digest 时才会迁移为 canonical digest。
- 已处理的本地自定义和等待用户处理的冲突会在摘要编码迁移后保持原状态；无关摘要继续 fail closed，不会修改本地 Skill 文件或元数据。
- 源码 ZIP 使用独立且有界的 120 秒完整请求预算，31 MB 等较大 Skill 仓库不再被普通 GitHub API 的 30 秒预算过早中断；普通 API 与 10 秒连接预算保持不变。
- 新增从公开 Tauri command seam 出发的更新、拒绝、已处理自定义与待处理冲突回归测试，并把摘要兼容边界写入文件系统 Rule。

English summary: v1.2.4 fixes false Skill update hash mismatches when a remote tree contains file/directory sibling paths with the same stem. ZIP scans and directory verification now share canonical component ordering. Legacy v1.2.3 digests migrate only for the same pinned remote SHA after an independently recomputed legacy match; unrelated hashes still fail closed without changing local files or metadata. Existing handled customizations and pending conflicts retain their state. Source ZIP downloads use a separate bounded 120-second request budget so larger Skill repositories are not cut off by the 30-second API budget; regular API and 10-second connect budgets remain unchanged. The Apple Silicon package is ad-hoc signed, not Developer ID signed, and not Apple notarized.

## v1.2.3 - 可靠性、安全边界与发布门禁

这个补丁版集中修复任务调度、备份目录访问和迁移失败路径，并把测试、覆盖率、MSRV、端到端测试与 ad-hoc DMG 实物校验收敛为统一发布门禁。

- 手工与定时任务共享 single-flight / generation 协调，旧任务或慢任务晚返回时不会再覆盖较新的结果；仅前台调度的产品边界保持不变。
- 打开备份目录只接受稳定的 `repositoryId`，实际路径由后端重新解析并 canonicalize，前端不再能提交任意文件系统路径。
- 移除没有实际作用的 `concurrency`、`retryCount` 和 `cleanupKeep` 设置；旧 SQLite 键继续保留并忽略，现有数据库无需破坏性迁移。
- 追加式迁移账本、事务和原子文件操作增强了失败回滚；文件系统、Keychain 和 GitHub 失败不会被误报为成功或留下半完成状态。
- `npm run verify` 成为确定性验证入口，CI 与发布流程另行覆盖 coverage、Rust MSRV、E2E 和完整 ad-hoc DMG 验证。
- 锁定依赖升级到 `quinn-proto 0.11.17`，修复对应的 high severity 公告。medium severity 的 `glib 0.18.5` 公告仍在跟踪，但不在 macOS arm64 产品的激活依赖图中，因此本版不宣称安全告警清零。
- local phase 会原子发布一个不可变、权限为 `0700` 的 generation 目录，其中 `manifest.json` 和 `manifest.token` 均为 `0600`；命令只输出文件路径，不再把 token 内容写入日志。这个未签名 token 只是产物字段载体，不是凭据或发布来源证明，整个 generation 目录也不会上传为 Release 资产或写入 Release notes。

English summary: v1.2.3 hardens task coordination, repository-based backup-folder access, additive migrations, and failure rollback while removing three no-op settings without breaking existing SQLite data. It also establishes verify, coverage, MSRV, E2E, and ad-hoc DMG release gates; updates `quinn-proto` to `0.11.17` for its high-severity advisory; and keeps manifest-token contents out of release logs. The separate medium-severity `glib 0.18.5` advisory remains tracked outside the active macOS arm64 dependency graph, so this release does not claim that all advisories are cleared. The Apple Silicon package is ad-hoc signed, not Developer ID signed, and not Apple notarized.

## v1.2.2 - 标签计数与提示词库界面修复

这个补丁版修复提示词保存后的标签使用数量未实时更新的问题。现在从详情编辑器新增或勾选标签并保存后，无需切换 Tab，标签管理面板会立即显示最新数量，并继续在后台以 SQLite 真值校正。

- 已有提示词可以可靠地新增、勾选和取消标签；抽屉内创建的新标签会自动选中，保存后卡片、详情和标签管理同步更新。
- 修复标签管理面板在小窗口或工具栏换行时被压缩的问题，并补齐加载、空态、错误重试和 20 标签上限保护。
- 提示词库工具栏按钮与其他 Tab 使用一致的通用样式，打开抽屉时不再改变按钮字号或几何尺寸。
- 抽屉动效缩短为轻量位移，保留点击外部安全关闭、未保存草稿保护和 reduced-motion 支持。

English summary: v1.2.2 fixes stale prompt-tag usage counts after saving, strengthens existing-prompt tag editing, aligns Prompt Library toolbar buttons with the other tabs, and makes the detail drawer motion lighter. The macOS package is ad-hoc signed, not Developer ID signed, and not notarized.

## v1.2.1 - 提示词分享、排序与标签体验

这个版本让提示词库真正具备跨设备分享闭环：批量 ZIP 保持一篇一个 Markdown，并增加不含正文的摘要清单；另一位 Skill Repo Tracker 用户可以先预检，再按明确冲突策略批量导入。标签只按规范化后的文本匹配，本机已有同名标签会复用，缺失标签会自动创建。

- 默认支持持久化手动排序，并保留“最近更新”视图；拖放有明确占位和落点，也支持键盘及组内首尾移动。
- 标签管理入口更清晰，补齐创建、搜索、重命名、同名合并、删除和防重复提交，并清理筛选、详情与草稿中的旧标签状态。
- 卡片显示更多紧凑标签，工具栏占用更少高度；抽屉支持安全的外部点击收起及 reduced-motion。
- 设置页 v1 JSON / v2 `.srtmigration` 继续兼容，提示词 ZIP 使用独立入口和严格清单校验。

English summary: v1.2.1 adds round-trip prompt ZIP import with text-matched tags, persistent manual ordering, reliable tag state, denser cards and toolbar controls, safe drawer click-away, and accessible drag feedback. The macOS package is ad-hoc signed, not Developer ID signed, and not notarized.

## v1.1.7 - 本地验证包

这个版本聚焦可验证的软件包记录。它延续 v1.1.6 的插件入口识别与失败态收口能力，并把本地 `.app` / `.dmg` 产物验证、版本号和校验和单独对齐。

- 版本号统一更新到 `1.1.7`，覆盖前端显示、Tauri 配置、Cargo 元数据、package metadata 和 Rust GitHub user-agent。
- README 中的当前版本和本地 DMG 产物路径更新到 `v1.1.7`。
- 新增 `docs/release-checksums-v1.1.7.txt`，记录本地验证 DMG 的路径、大小和 SHA-256。
- 本地验证产物仍未 notarize，不作为普通用户公开分发包；公开发布 DMG 仍需要 Developer ID 签名和 Apple notarization。

## v1.1.6 - 插件入口识别与失败态收口

这个版本把插件安装入口从 README/插件清单里的零散命令收拢到独立插件页，同时修正扫描失败时静默保存为“0 Skills / 0 Plugins”的误导状态。它解决的是“先看清来源和风险，再决定是否行动”，不是完整插件市场，也不会自动执行插件安装。

- ZIP、SKILL.md 和插件入口扫描失败时会返回失败状态并记录任务，不再把失败仓库保存成空识别结果。
- 新增插件扫描模块和边界测试，保留 `plugins`、`plugin_skill_links`、`list_plugins`、`get_plugin_detail` 数据/接口，语义明确为“安装入口识别”。
- 插件页从超长 `App.tsx` 拆出，前端 API 补充 `UiPlugin`、`PluginDetail` 等类型，降低新增逻辑的 `any` 扩散。
- 插件表格新增专属列宽、安装命令列、键盘可达行操作、详情页复制安装命令按钮，以及“未发现入口”和“当前筛选无结果”的不同空状态。
- 仓库详情和 Skill 详情中的插件条目现在可以直接跳转到插件详情，方便从来源、Skill 和安装入口之间来回核对。

下载说明：Apple Silicon，macOS 12+。本地验证产物未 notarize，不作为普通用户公开分发包。

## v1.1.5 - 右侧详情空白收起修复

这个版本补齐仓库列表类页面的右侧详情关闭闭环，让仓库页和 GitHub 工作台都能通过点击主区域空白收起详情，同时保留正常行点击和操作按钮行为。

- 仓库页继续支持点击标题/列表/表格下方空白收起右侧详情，筛选、搜索、复选框和备份按钮不会误触关闭。
- GitHub 工作台不再自动选中第一条仓库；点击仓库行打开详情，点击空白或右侧关闭按钮收起详情。
- 统一详情收起点击判断，避免仓库页和 GitHub 页各自维护一份交互规则。

下载说明：Apple Silicon，macOS 12+。本地验证产物未 notarize，不作为普通用户公开分发包。

## v1.1.4 - 手动 GitHub 账号与私仓健壮性

这个版本移除 GitHub 默认账号和旧全局 token 兜底逻辑。GitHub 账号需要在工作台里逐个手动添加，私仓追踪应从对应账号的仓库目录进入，避免旧 token 或默认账号在后台误用。

- 启动时清理旧版 `default` / `github:legacy-default` 账号、对应 GitHub catalog、旧全局 token 状态，并将相关已追踪仓库的账号绑定置空。
- GitHub API token 选择只来自显式账号绑定；手动 URL 添加不再借默认 token 访问私仓。
- GitHub 工作台移除“默认”标记和“设为默认”操作，删除账号后不会自动提升任何账号为默认。
- 添加账号改为顶部按钮 + 弹窗流程，账号列表可横向滚动，适合管理多个 GitHub 账号。
- 仓库筛选补齐“个人公开”和“个人私有”，组织/协作仓库不会混入个人仓库筛选。
- 仓库页支持点击主区域空白收起右侧详情，同时保留行点击、复选框、筛选、搜索和备份按钮的原行为。

下载说明：Apple Silicon，macOS 12+。本地验证产物未 notarize，不作为普通用户公开分发包。

## v1.1.3 - GitHub 私仓与 Star 工作台

这个版本新增独立 GitHub 工作台，用于管理多个 GitHub 账号 token、浏览可访问仓库和 Star 项目，并把私仓按正确账号加入追踪。

- 新增 GitHub 账号档案：SQLite 只保存账号元数据和 keyring 引用，真实 token 仍只进入 macOS Keychain。
- 新增仓库目录：可刷新个人仓库、私仓、组织可访问仓库和 Starred 仓库，并按全部 / 私有 / Starred / 已追踪筛选。
- 支持 Star / Unstar、从 GitHub 加入追踪、取消追踪、验证账号和删除账号。
- 已追踪仓库会记录首选 GitHub 账号，后续检测、备份、README 和 Skill 读取会优先使用对应账号 token。
- 设置页保留 GitHub 安全状态和工作台入口，不再把 token 配置做成孤立流程。

下载说明：Apple Silicon，macOS 12+。本地验证产物未 notarize，不作为普通用户公开分发包。

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
