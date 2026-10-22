# ADR 0014：仅 main 推送与明确的 PR 治理退休

- 状态：Accepted
- 日期：2026-10-23

## 决定与保护取舍

仓库仅保留 main，采用普通快进推送。服务器持续禁止删除与非快进更新，不新增 bypass。
取消 PR 前置、PR 正文机器审查及 fresh-label 审查，关闭安全修复自动 PR；保留安全告警。
推送后运行检查并不能阻止不合格提交进入 main，也不具有来自独立基分支代码的审查能力。
新增累计验证和发布阻断防止未验证产物发布，不声称恢复上述保护强度。

ADR 0008 保持 active 与原字节、原校验和。本决策仅改变明确列出的 PR 治理条款，
不是完整或等价的 supersede；资产、预算、不可变 ADR、fixture、waiver 与证据发现合同继续有效。

## 两阶段退休

catalog schema 2 引入唯一计划 main-only-2026-10 / pr-to-main-only-v1。
bootstrapHead 为迁移前现场确认的 main：6051bb0b31defe0343bb160aa886ec4f23388ace。
计划固定决策、四个目标和五项精确 drop；首次登记后整条记录永久冻结，包括数组顺序。

阶段 A 将 trusted-policy、pr-evidence-template、PR-EVIDENCE-001、TRUSTED-SUITE-001
全部标为 retiring，旧字段、文件和可执行测试保留。PR 触发停用不能被描述为旧保护仍生效。
首次 A 从 bootstrap 累计验证；真实 main 上 baseline、verify、coverage、msrv 四 job 成功后，
方可单独推送 B。一次 push 中携带 A/B 两个本地 commit 不能代替这两个成功边界。

阶段 B 将四项同时标为 retired 并应用 catalog 中五项 drop；记录成为不可改删的 tombstone。
两个继续 active 的 owner 仅移除精确列出的值，不能移除 GH-GATE-001 或遗漏其他活跃引用。
旧 base-sourced-policy-review capability 保留在 tombstone，不能复制给新 CI。
退休仅退出 live 文件/证据扫描，不解除历史记录及其来源合同。未来新增退出须另行评审。
PR helper 的历史 selector 仍有活跃 owner 时必须保留真实 helper 与测试，不以空测试占位。

## 累计验证与发布

累计基线 V 只能来自 bootstrap 或精确 main push 的最新 run、最新 attempt 全部必需 job 成功祖先，
失败、取消、缺 job、API 结果不完整或无法确认身份时拒绝采用该提交。只读查询数据，不执行历史代码。
单父链、仓库、workflow、事件、ref、SHA 与运行身份均严格核对，有界扫描超限失败。
目录与 coverage 比较整个 V→HEAD；surface budget 逐父边检查，不能先扩后缩掩盖削弱。

正式发布只接受 retired 阶段；发布目标必须精确对应当前 main 且四 job 成功、远端治理复核通过。
tag、二进制、DMG、校验和及来源绑定仍独立验证。远端状态不明时停止发布，先读回真实状态。
失败采用前向修复；不 force push、不抹除失败历史、不重写已有候选标签。

## 决策寿命

接受后本 ADR 字节冻结。后续修正另写 ADR，不修改本计划或把旧 retired ID 重新激活。
若恢复 PR 能力，使用新的 gate / Invariant ID，明确 reintroduces 的旧 ID 与退出历史，
并证明实际入口、运行器和保护能力；不能借改名宣称等价。
校验器与被校验代码在同一仓库，仅防误扩范围，不是有写权限者无法修改的独立信任根。
