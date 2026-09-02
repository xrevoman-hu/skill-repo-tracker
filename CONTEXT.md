# 项目治理词汇表

- **产品边界（Product boundary）**：产品明确承诺做或不做的范围；改变它通常会增加长期
  状态、权限、兼容性或运维成本。
- **不变量（Invariant）**：无论内部实现如何变化，都必须持续成立、且可以被反例破坏的
  产品或工程事实。
- **Rule**：当前实现必须遵守的模块级行为边界，回答“现在不能破坏什么”。
- **ADR（Architecture Decision Record）**：记录难以逆转且存在真实取舍的决策，回答
  “为什么选择这条路、放弃了什么”。
- **回归证据（Regression evidence）**：能在旧错误行为上失败、在当前正确行为上通过的
  公开 seam 测试或确定性 fixture。
- **Gate**：自动执行并在证据不足或边界被破坏时失败的验证入口。
- **预算（Budget）**：只能保持或收紧的结构、包体、覆盖率、权限或状态上限。
- **验收层（Acceptance layer）**：结论实际被证明的位置，例如 source、static、browser、
  database/filesystem、remote ref、artifact 或 human acceptance；不同层不能互相替代。
- **PR evidence**：本次变更留下的失败复现、根因、同类扫描、成本变化和验证层记录。
- **Supersede / Retire**：用新决策替代旧决策，或在产品边界消失后同时移除旧 Rule、测试、
  状态与兼容分支；不是把过时资产永久保留。
