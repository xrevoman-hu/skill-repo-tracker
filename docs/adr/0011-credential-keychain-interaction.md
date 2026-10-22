# ADR 0011：凭据共用授权的非交互读取与显式恢复

- 状态：Accepted
- 本决策补充 ADR 0010 的 Keychain 交互边界，不改写其选型和历史验收。系统身份、
  持久授权与跨版本升级仍须独立真实证据，Accepted 不等于这些验收已经通过。
- macOS 直接依赖现有锁定的 security-framework，只允许 `credential_auth` 中两处
  `SecKeychain::disable_user_interaction` RAII guard 与原生错误类型判别；不开放任意
  安全存储操作、ACL 修改或系统确认自动接受。该依赖只在 macOS target 启用。
- Keychain 交互策略仅在独立凭据 host/bridge 进程内生效。进程内 mutex 串行覆盖普通
  读取、创建/重置、删除及显式恢复；普通路径在 RAII guard 存续期间禁止系统弹窗。
  原 GitHub token adapter、namespace 与普通 AppState 不使用该交互策略。
- 读取访问码失败时保留共享意图，宿主仍 ready 且锁定，以 authorizationError 拒绝
  Agent 读取。缺项、需授权、拒绝、取消和不可用分别处理，不把失败当作缺项而生成新码。
- 仅本地主密码已解锁后的显式 `authorize_access` 可请求系统授权读取已有访问码。
  操作先使旧交付失效，即使取消也不恢复旧会话；不建立/重置码、不扩 ACL、不自动解锁。
  共享已关闭时仍可恢复系统访问，解决重置失败后的恢复入口，但操作不得打开共享或改写
  持久共享意图；共享关闭时 MCP 继续拒绝读取。
- 显式读取后在同一 mutex 下禁止交互并复读比对，保证没有更换访问码。此复读只证明
  当前进程可用，持久授权必须由独立新 bridge/重启实测，不能仅凭一次性 Allow 宣称成立。
- 显式交互入口不得由 MCP、自动重连或启动失败路径调用。只允许精确 API、函数和
  本地控制动作，负向测试拒绝移除 guard/串行化、额外 API/别名、跳过解锁、重建访问码、
  自动开启共享及额外调用方；不以新增 crate 为理由放开整个 security-framework。
- 文件路径表面积仅把原隔离目录 `sharing.json` 查询从 `open` 移至 `open_with_access`。
  安全存储 namespace 不变，无第二份访问码、网络入口或新的后台任务。
