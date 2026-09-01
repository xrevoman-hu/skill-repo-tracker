# Security Policy

## Supported version

安全修复面向最新 GitHub Release；历史 ad-hoc 测试包不承诺单独维护。

## Reporting

请不要在公开 issue 中粘贴 token、数据库、迁移包、真实路径或 Prompt 正文。优先使用
GitHub Security Advisory 私密报告；若不可用，只提交不含敏感数据的最小复现并请求维护者
提供私密渠道。

## Security boundaries

- GitHub token 仅存 macOS Keychain。
- SQLite/导出包不主动包含凭据、本地源码、源码 ZIP 或任务日志。
- 打开备份目录只接受稳定 ID/根目录意图，由后端重建并 canonicalize；导入、目录选择等
  明确由用户选定路径的 command 仍必须在后端重新校验类型、范围和访问边界。
- Skill 删除仅限本应用已登记的同步副本。
- 本项目当前 Release 是 ad-hoc 测试分发，不声称 Developer ID 或 notarization。

详细不变量见 `docs/adr/` 与 `docs/rules/data-security.md`。
