# Release Notes

## v1.1.7 - 非宣传物料本地验证包

这个版本不合入公众号推文、宣传截图或两版宣传视频，只发布可验证的软件包记录。它延续 v1.1.6 的插件入口识别与失败态收口能力，并把本地 `.app` / `.dmg` 产物验证、版本号和校验和单独对齐。

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
