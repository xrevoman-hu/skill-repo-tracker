## 变更类型

<!-- 必须且只能勾选一项；生产代码变更不能只靠标题推断。 -->
- [ ] Bug 修复
- [ ] 非 Bug 变更

## 变更目的

<!-- 这是本 PR 的轻量 Change Brief；docs/chore 也直接填写，不另建独立简报文档。 -->
- 用户问题/产品价值：
- 非目标：
- 验收层（source/static/browser/database/remote/artifact/human；只写实际验证）：

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

## Rule / ADR / Invariant

- 已阅读/更新的 owning Rule/ADR asset ID：
- 已复审资产/高风险不变量 ID：
<!-- 以 `npm run governance:context -- --base-ref origin/main` 的输出为准，不能漏项。 -->
- [ ] 本变更未产生新的长期边界，因此无需更新 Rule/ADR。

## Skip / flaky 债务

- [ ] 没有引用独立 lane test waiver。
- 如确需临时隔离到独立 lane（主测试内仍不得 skip），填写 `docs/engineering/test-waivers.json` 中唯一 active ledger ID：

## 验证

- [ ] `npm run verify`
- [ ] 与本变更相关的独立 lane（coverage/E2E/MSRV/性能/Release）已运行，结果/链接：
- [ ] 独立 lane 不适用，原因：
- [ ] 没有秘密、真实用户数据、`AGENTS.md`、`docs/internal/` 或宣传草稿进入 diff。
