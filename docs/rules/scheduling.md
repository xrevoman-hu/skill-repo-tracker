# 任务与调度 Rules

- 产品仅前台调度，不新增常驻开销、daemon 或系统权限。
- 当前禁止 Web Worker、SharedWorker、Service Worker 与 Tauri event IPC；跨线程或跨 WebView
  的新执行/通信入口必须先建立独立 surface、退出协议、ADR 和确定性竞态测试。
- Rust `spawn`/`spawn_blocking`、thread、Tauri plugin 与 setup/event hook 都属于执行面；只允许
  `docs/engineering/surface-budget.json` 已登记且有明确用户价值的一次性调用。禁止用 import
  alias、wrapper、method spawn 或动态 plugin factory 绕过清单。
- 现有 Rust blocking task 必须由发起 command await；搜索 watchdog 必须可终止并 join。新增
  recurring worker、fire-and-forget task 或 plugin 后台行为必须先用新 ADR 改变“仅前台”边界。
- timer 和手工入口共用 single-flight/generation coordinator。
- 上一次任务完成后才设置下一次 timer；慢任务不会按固定间隔重入。
- `queueMicrotask`、`scheduler.postTask`、`MessageChannel`/`MessagePort` 与 `postMessage`
  不能作为未登记的调度旁路；新增异步入口必须进入同一前台调度与 surface budget。
- 生产代码禁止通过 `Reflect`、`Proxy`、Object prototype/descriptor、`constructor`、
  `__proto__` 或 `document.defaultView` 取回 timer、worker、网络、动态执行或 Tauri API；
  这些反射面无法形成稳定、可审计的调用点。
- superseded generation 可以结束，但不能覆盖更新的状态或结果。
- 任务进行中收到新的持久领域快照时必须使旧 generation 失效；React 回灌同一快照引用或
  UI-only optimistic task overlay 不属于持久状态更新，不能误取消当前任务。
- 持久变更取代进行中的任务后，任务结束须在新 generation 中读回已提交状态；读取同样受
  single-flight 与 generation 保护，不能遗漏其他仓库已完成的结果或覆盖更新的用户选择。
- timeout、取消、429、无效 JSON、Keychain/文件系统失败必须成为确定性测试。
- 失败任务保留对象、错误码、原因和可用详情；批量操作零成功且有失败时标记为失败。
  Skill 安装/更新在共同命令边界记录早期失败，不能只审计提交阶段。
- 请求失败后的任务读回继续受 generation 保护；读回失败不能替换原始错误。无法读回的
  客户端诊断明确标注仅在当前会话保留，不冒充持久记录或可重试任务。
- 复制任务包含身份、状态和完整日志，剪贴板不可用或拒绝时不得提示成功；旧记录未保存的
  详情明确说明缺失，不推测补写。
