# ADR 0015：两项表面积历史用途文案的精确更正

- 状态：Accepted
- 日期：2026-10-23

## 历史事实与决定

表面积逐父边检查发现真实登记错误：两项文件操作从 active 进入 retiring 时，
除新增 retirementReason 外，还把迁移说明写进了应冻结的 purpose。
新操作已从 active 登记，生命周期顺序本身合法；用途字段改写仍然违规，不能解释成检查器误报。
此前端点比较没有揭示这两个中间差异，不能据此宣称每个历史提交都已通过累计验证。

保留原提交与候选 tag，以本决策接受以下唯一旧父边的两项用途文案错误，不改写历史：

- 父提交：`cd9c09bb82ff848f8ff2d0bd8d8eb3f435af6a9e`
- 子提交：`d2cb71239eb930e882ce5717a86a1a5fe2f3b5a1`
- 固定文件：`docs/engineering/surface-budget.json`
- 固定类别：`rustPathSites`

| 完整记录 ID | 完整旧记录 SHA-256 | 完整新记录 SHA-256 |
| --- | --- | --- |
| `src-tauri/src/credential_backup.rs:fs::rename:commit#1` | `1d12172b0b8e229b0953fbd4ee2e83af24cd515eb8efc7058c8e2a0aae2a6f9e` | `8837e26c2eeb3d427166f106c59689aa46fcf210959aaf955bbb2f966e0cfc48` |
| `src-tauri/src/credential_backup.rs:Path::exists:commit#1` | `81ee35dacb7b4cab96062979b8564355304cd224e9ddf8d5c63aec900f1af7fe` | `844b130dc6f33a11d7785bf73511102b76452c1bec259b6776ffbd174f77acec` |

摘要基于完整记录：顶层键按 JavaScript `.sort()` 码点序排序，再对 `JSON.stringify`
结果的 UTF-8 bytes 计算 SHA-256。此处所有记录值均为字符串；不忽略字段、空白或字符差异。

## 机器边界

唯一固定更正数据在 `scripts/surface-history-correction.mjs` 的深冻结
`SURFACE_HISTORY_CORRECTION`，保存上述锚点及两项完整前后记录、摘要，并绑定本 Accepted ADR
的原始字节摘要。catalog 登记本 ADR；其他文档只链接本决策，不另设豁免账本。

校验器只读固定 Git 对象，必须核对完整父子关系、类别、ID、前后记录和摘要全部匹配，
才允许该旧边的两个 purpose 差异。历史脚本不执行，历史对象和当前表面积文件不改写。
不接受通配符、环境变量、CLI 忽略开关、用户传入的新更正项或仅按错误文本过滤结果。

其余比较继续由原 `compareSurfaceBudgets` 执行。新增 active、retiring 后才能删除、
禁止反向激活、用途后续改写和退出原因改写均保持严格；任一额外字段差异不受本决策授权。
相同 ID 或文案出现在新提交、不同父边或工作树末边时，不能复用此更正。
缺对象、非法 schema、merge、浅克隆、1,000 条边上限以及当前源码实际登记检查不变。

## 验收与寿命

回归须重放完整旧 Git JSON，证明精确旧边通过，而 SHA、父、ID、前后字段任一不符仍失败；
并证明更正不允许直接删除、首次 retiring、反向激活、工作树绕过或当前源码漏登记。
原九实体的合成结构测试继续保留，但不冒充上述真实历史重放。
实施后仍以原 bootstrap S `6051bb0b31defe0343bb160aa886ec4f23388ace` 执行完整累计验证，
不能用仅候选增量或本更正测试替代 `npm run verify` 与后续发布门禁。

本决策不修改 ADR 0014、main-only policyRemovals 计划、四实体或五处 drop，不放宽其他历史错误、
产品行为、权限或预算。未来错误须另行评审；不向本数据追加记录或重写本 Accepted ADR。
