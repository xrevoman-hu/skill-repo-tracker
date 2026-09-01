# 数据与安全 Rules

- token 只进 Keychain；禁止写入 SQLite、日志、文档、fixture、ZIP 或迁移包。
- fixture 必须脱敏且虚构，不能复制用户目录或真实 GitHub 返回。
- 导出提示词正文前明确说明明文边界并二次确认。
- SQLite schema 先执行旧幂等升级，再记录编号迁移；已发布迁移只追加不重写。旧应用遇到
  未知的未来 core migration 或更高的 Prompt `user_version`，必须在任何持久 PRAGMA/DDL
  前拒绝打开，不能在更高版本 schema 上继续写入。
- 文件系统或事务在最后一步发生可观察失败时，也必须回滚到调用前可读状态；硬崩溃的
  跨存储残留按 ADR 0003 处理，禁止用递归扫描自动删除未知目录。
- Keychain 与 SQLite 的联合更新必须记录调用前凭据状态；数据库 statement/commit 失败时
  执行补偿并用回归测试覆盖，补偿错误不得泄露 token。
- Keychain 读取失败不能降级成“未配置”；删除失败时不得先清理 SQLite 元数据。底层
  Keychain 错误只映射为稳定错误码和脱敏标签，不把 adapter 原文返回给 UI。
