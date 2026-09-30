# Skill Repo Tracker Agent Guide

本文件保存与开发机器无关的项目规则入口，随 Git 版本演进。开始工作时，如存在
`AGENTS-local.md`，同时读取其中的本机叠加约定；该文件不得进入 Git。

## 项目事实源

开始修改前按改动范围读取以下文档，不在本文件复制另一套治理合同：

- 共同词汇：`CONTEXT.md`
- 架构、依赖方向与预算：`docs/engineering/architecture.md`
- 贡献、PR 与唯一验证入口：`CONTRIBUTING.md`
- 安全披露与敏感数据边界：`SECURITY.md`
- 当前模块行为边界：`docs/rules/`
- 历史决策与不可随意改变的边界：`docs/adr/`
- 资产关系与生命周期：`docs/engineering/maintainability-system.md`

可用 `npm run governance:context -- --base-ref origin/main` 按 changed paths 选择相关
Rule、ADR 与高风险 Invariant；该命令是上下文选择器，不是验证入口。

本地和 CI 的确定性验证只调用 `npm run verify`。新增生产文件、设置、命令、权限、网络
host 或定时任务时，按上述事实源同步登记模块归属与表面积预算。
