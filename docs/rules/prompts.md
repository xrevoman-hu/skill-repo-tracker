# Prompt Rules

- Prompt ZIP 与 `.srtmigration` 是两个职责和版本域，不合并。
- 每篇正文 UTF-8 上限、压缩包总量、entry 数、路径穿越和 checksum 都必须在信任前验证。
- 导入先解析/校验全部输入，再以事务提交；失败不得留下部分标签或正文。
- 公开 API 不用 `any`；schema 变化必须补旧版本 fixture、升级和失败回滚测试。
- 10,000 条/100 MiB 测试属于 weekly 与 Release gate，不放进每次本地快速测试。
