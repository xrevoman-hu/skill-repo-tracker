# ADR 0008：可执行治理资产图与治理工具预算

- 状态：Accepted
- 决策：用机器可读 catalog 连接七项工程原则、tracked Rule/ADR、高风险 Invariant、适用
  路径、回归 selector、gate 与退休条件；`npm run verify` 校验该图和自身执行计划。治理脚本
  与产品代码一样接受 800 行新模块上限，既有热点只能下降。
- 原因：Markdown 能保存“为什么”，测试能保存输入/结果，但二者没有稳定关联时，AI 无法
  知道改动一个路径必须加载和复审哪些边界；门禁本身不受预算时也会成为新的腐化热点。
- 取舍：catalog 只保存关系和稳定 ID，不复制正文；新鲜度由 protected path 变更触发，
  不按日历强制续期。CI 会校验 PR 字段完整和所需 Invariant ID，但正文真实性仍需要审查；
  自动化不伪装成人工判断。
- 生命周期：active Rule/ADR/Invariant 不能静默失联。替代时先记录 Superseded、替代资产和
  退休条件；功能及全部入口消失或有更高层契约完整替代后，才删除旧 Rule/测试/状态。
- 后果：开始修改前可按 changed paths 只加载相关上下文；已发布 schema fixture 通过 SHA-256
  锁定为只追加资产；settings、commands、capability、entitlement、CSP/host 与 timer 使用精确
  表面积预算。verify 计划从 tracked 文档执行，并在 PR 上与 base 比较；证据、gate identity、
  范围或预算弱化会 fail closed。退休通过显式状态推进，不让删除和预算互相死锁。
