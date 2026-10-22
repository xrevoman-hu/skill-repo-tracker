# Security Policy

## Supported version

安全修复面向最新 GitHub Release；历史 ad-hoc 测试包不承诺单独维护。

## Reporting

请不要在公开 issue 中粘贴 token、数据库、迁移包、真实路径或 Prompt 正文。优先使用
GitHub Security Advisory 私密报告；若不可用，只提交不含敏感数据的最小复现并请求维护者
提供私密渠道。

## Security boundaries

- GitHub token 仅存 macOS Keychain。
- v1.4.0 凭据模块将记录与附件原字节保存在独立 SQLCipher 库中；主密码不持久保存。
  普通 SQLite、普通迁移包及仓库源码备份不纳入凭据库。凭据专用备份保持加密，
  不携带本机 Agent 访问码。E0 与自动化验收只使用隔离的虚构资料。
- 人工查看、复制、导出与文件检查绑定主密码验证后的记录、版本和会话。
  失焦、关详情、切记录或锁库后，后端不继续交付旧会话的秘密；文件选择框导致失焦时，返回后重新验证。
- Agent 访问码与主密码分开，只保存在本机 Keychain。共享覆盖已有和以后新增的全部凭据，
  没有逐 Agent 或逐记录隔离；只面向同一电脑、同一系统用户。它不提供同一用户下恶意程序
  的全面隔离。访问码不能解锁库，每次重开应用仍须人工解锁。
- 锁库、关闭共享或重置访问码停止后续 Agent 读取；已交付到 Agent 上下文、历史、剪贴板
  或导出文件的秘密不能追回。应用不执行 Agent 随后对外部服务器、数据库或邮箱的操作。
- SSH/TLS 原件保存在加密库内；Agent 使用时创建最长 15 分钟的受管文件租约，完成后应主动释放。
  锁库或撤权提前清理；清理失败会阻止继续读取，并提供重试。只清理已登记文件，不扫描删除未知目录。
  用户显式导出的文件不受租约清理管理；清理不是对存储介质的安全擦除承诺。
- 本地 PEM 解析、证书与私钥配对及所提供链的检查不证明目标可连接、证书受公共信任或可部署，
  不检查主机名和吊销状态。格式头识别不代表文件可用；原文件字节不被转换。
- 凭据库不包含远程凭据服务。Windows 恢复、文件权限和原生消费仍为 BLOCKED，不声称跨平台验收完成。
- 打开备份目录只接受稳定 ID/根目录意图，由后端重建并 canonicalize；导入、目录选择等
  明确由用户选定路径的 command 仍必须在后端重新校验类型、范围和访问边界。
- Skill 删除仅限本应用已登记的同步副本。
- 本项目当前 Release 是 ad-hoc 测试分发，不声称 Developer ID 或 notarization。

详细不变量见 `docs/adr/` 与 `docs/rules/data-security.md`。

For v1.4.0, vault records and original attachments use a separate SQLCipher database; the master
password is not persisted. The shared Agent code is stored in macOS Keychain and cannot unlock
the vault. Sharing covers every existing and future record for configured local Agents under
the same OS user; it is not per-Agent isolation. Authorized reads can put secrets into Agent
context or history, and delivered copies cannot be recalled. Exported files remain user-managed.
Windows acceptance remains blocked. See the [credential vault guide](docs/credential-vault.md).
