# 提示词库 / Prompt Library

## 中文

Skill Repo Tracker v1.2.0 在本地 SQLite 数据库中增加提示词库。提示词、标签和关联关系留在本机；应用不会把提示词上传到云端。

### 使用方式

- “提示词库”位于“技能”和“插件”之间。
- 卡片展示标题、最多三个标签、正文摘要、置顶状态、更新时间和复制操作。
- 点击卡片后，右侧抽屉以只读方式显示安全渲染的 GFM Markdown；必须点击“编辑”才会进入原始 Markdown 编辑态。
- 搜索覆盖标题、完整正文和标签；标签筛选支持“包含全部”和“包含任一”。
- 每页可选择 30、50 或 100 条，并可跨页选择或全选当前筛选结果。

### 数据限制与一致性

- 标题必填，最多 200 个 Unicode 字符。
- 正文必填，每篇最多 `5,242,880` UTF-8 bytes（5 MiB）。本项目 bundled SQLite 的默认单值理论上限是 `1,000,000,000` bytes（约 953.7 MiB）；应用主动采用更小的产品上限，以控制读取、索引、编辑和导出的风险。
- 每篇最多关联 20 个标签；标签名最多 50 个字符，并按 trim、Unicode NFC 和大小写不敏感规则去重。
- 编辑、置顶和删除都使用单篇 `revision` 检测陈旧操作；“全选当前筛选结果”额外使用全库 revision 检测集合漂移。

### 导出与迁移

- 单篇导出是 UTF-8 无 BOM 的 `.md`，YAML front matter 记录公开 ID、标题、标签、置顶与时间；正文保持原样。
- 批量导出是 `.zip`，内部 Markdown 文件名经过路径字符清洗、截断和去重，且拒绝目录穿越。
- 导出文件使用 `Skill-repo-tracker提示词导出_yyyyMMddHHmmss_<unique>` 命名。
- 迁移页未勾选提示词时仍输出兼容的 v1 JSON；勾选后输出 v2 `.srtmigration`。v2 在导入前校验大小、引用、摘要和冲突，并默认保留本机不同内容。
- 应用托管的 GitHub token、Keychain 数据、本地源码、源码 ZIP 和任务日志不会进入提示词导出或迁移包。提示词正文会逐字、明文导出；如果用户把密码或凭证粘贴进正文，它也会随正文导出，因此勾选提示词迁移时会显示明确警示和二次确认。

## English

Skill Repo Tracker v1.2.0 adds a prompt library backed by the app's local SQLite database. Prompts, tags, and their relationships stay on the Mac; the app does not upload them to a cloud service.

### Workflow

- Prompt Library sits between Skills and Plugins.
- Cards show the title, up to three tags, a body excerpt, pin state, update time, and copy action.
- Opening a card shows safe GFM Markdown in a read-only right drawer. Editing starts only after the explicit Edit action and operates on the original Markdown.
- Search covers titles, complete bodies, and tags. Tag filters support matching all or any selected tags.
- Pages contain 30, 50, or 100 items. Selection can span pages or cover the current filtered result set.

### Limits and consistency

- Titles are required and limited to 200 Unicode characters.
- Bodies are required and limited to `5,242,880` UTF-8 bytes (5 MiB) each. The bundled SQLite build's default theoretical single-value limit is `1,000,000,000` bytes (about 953.7 MiB); the app enforces a much smaller product limit to bound load, indexing, editing, and export costs.
- A prompt can have up to 20 tags. Tag names are limited to 50 characters and deduplicated after trimming, Unicode NFC normalization, and case-insensitive comparison.
- Edit, pin, and delete operations use per-prompt revisions. Selecting an entire filtered result also checks a monotonic library revision to detect result-set drift.

### Export and migration

- Single export produces BOM-free UTF-8 `.md` with YAML front matter for the public ID, title, tags, pin state, and timestamps. The body is preserved verbatim.
- Batch export produces a `.zip`; Markdown entry names are sanitized, length-limited, deduplicated, and protected from directory traversal.
- Export artifacts use the base name `Skill-repo-tracker提示词导出_yyyyMMddHHmmss_<unique>`.
- Migration without prompts continues to use the compatible v1 JSON format. Opting into prompts produces a v2 `.srtmigration` package that validates sizes, references, digests, and conflicts before import, defaulting to keeping different local content.
- App-managed GitHub tokens, Keychain data, local source trees, source ZIP files, and task logs are excluded from prompt exports and migration packages. Prompt bodies are exported verbatim and in plaintext; passwords or credentials pasted into a body travel with it, so opting into prompt migration shows an explicit warning and confirmation.
