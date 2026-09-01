# ADR 0001：SQLite 与 Keychain 的敏感数据边界

- 状态：Accepted
- 决策：SQLite 仅保存仓库、Skills、插件、设置、任务、备注和用户明确导出的提示词；
  GitHub token 只通过 macOS Keychain 读写，不能进入数据库、日志、迁移包或文档。
- 原因：迁移包和 SQLite 易被复制，Keychain 提供操作系统级访问边界。
- 跨存储原子性：保存或删除账号时，SQLite 变更必须处于单一事务；如果 statement 或
  commit 失败，服务必须用调用前读取到的状态补偿 Keychain。补偿失败必须同时保留数据库
  错误和补偿错误，但不得把 token 写入错误、日志或响应。
- 并发边界：所有账号凭据变更使用 data-dir 内独立的 `skill-credentials.lock` 跨进程
  `flock`，锁覆盖“读取旧凭据 -> 修改 Keychain -> SQLite transaction/commit -> 必要补偿”
  的完整窗口。锁文件只用于互斥，不写 token，也不与耗时的备份文件锁共用。
- 已知限制：Keychain 与 SQLite 不支持共同事务，进程在两次写入之间硬崩溃仍存在极小
  不一致窗口；正常错误路径必须由确定性测试证明可补偿，后续可用不含秘密的恢复标记缩短
  崩溃恢复时间，但不能因此把 token 写入 SQLite。
- 后果：测试通过注入 adapter 模拟 Keychain；不得为了测试读取真实账号凭据。提示词正文
  可能含用户粘贴的秘密，明文导出必须警示并二次确认。
