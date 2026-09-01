# 任务与调度 Rules

- 产品仅前台调度，不新增常驻开销、daemon 或系统权限。
- timer 和手工入口共用 single-flight/generation coordinator。
- 上一次任务完成后才设置下一次 timer；慢任务不会按固定间隔重入。
- superseded generation 可以结束，但不能覆盖更新的状态或结果。
- 任务进行中收到新的持久领域快照时必须使旧 generation 失效；React 回灌同一快照引用或
  UI-only optimistic task overlay 不属于持久状态更新，不能误取消当前任务。
- timeout、取消、429、无效 JSON、Keychain/文件系统失败必须成为确定性测试。
