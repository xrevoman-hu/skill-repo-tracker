# ADR 0004：仅前台调度

- 状态：Accepted
- 决策：不引入 daemon、LaunchAgent 或常驻后台权限。调度状态只在前端生命周期内存在，
  每次任务完成后再安排下一次，并与手工执行共用 single-flight/generation coordinator。
- 原因：当前产品价值不足以承担后台常驻、权限、唤醒和恢复语义的维护成本。
- 后果：应用退出后不继续运行；设置页面必须如实说明。不得写入无人读取的 schedules
  状态。改变此边界需要新 ADR 和用户价值证据。
