## 变更目的

<!-- 用户问题/产品价值；如无必要勿增实体。 -->

## 可复现证据

- [ ] 新增了能让旧实现失败的回归测试，位置/测试名：
- 若不能先写自动化失败测试，原因与替代证据：

## 根因与同类扫描

- 根因（不要只复述症状）：
- 已扫描的同类入口、adapter、竞态或数据路径：
- 扫描结论/一并修复项：

## 状态与权限预算

- [ ] 不新增设置项；如新增，说明为什么合理默认值不能解决：
- [ ] 不新增/扩大 Tauri command、capability、entitlement、目录或网络 host；如有变化：
- [ ] 不新增后台状态、timer、daemon 或常驻开销；如有变化：
- [ ] 数据库/导出/迁移兼容性已说明并测试：

## Rule / ADR

- 对应或更新的 Rule/ADR：
- [ ] 本变更未产生新的长期边界，因此无需更新 Rule/ADR。

## Skip / flaky 债务

- [ ] 没有新增 skip/only/flaky 宽限。
- 如确需临时隔离到独立 lane（主测试内仍不得 skip）：关联 issue、owner、最晚删除日期：

## 验证

- [ ] `npm run verify`
- [ ] 与本变更相关的独立 lane（coverage/E2E/MSRV/性能/Release）已运行或说明不适用。
- [ ] 没有秘密、真实用户数据、`AGENTS.md`、`docs/internal/` 或宣传草稿进入 diff。
