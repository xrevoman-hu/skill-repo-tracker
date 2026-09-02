# 持续迭代与防腐化系统

这份文档把“AI 写代码、AI 验证代码”的工程理念转换为仓库内可维护的资产链。它不以测试
数量或测试/生产 LOC 为目标，而以关键错误能否被复现、长期边界是否有原因、门禁能否在
干净环境 fail closed 为判断标准。

## 资产链

```text
用户问题 / 产品价值
  -> 产品边界与成本判断
  -> ADR（为什么）
  -> Rule / Invariant（现在必须保持什么）
  -> 回归测试与 fixture（旧行为如何失败）
  -> Gate / Budget（仓库内如何 fail closed）
  -> PR / Release evidence（本次在哪一层得到证明）
  -> Supersede / Retire（边界消失时如何一起删除）
```

资产的机器索引在 `docs/engineering/governance-assets.json`。它只记录稳定 ID、事实源路径、
适用代码范围、执行方式和回归证据，不复制 Rule 或 ADR 的正文。`npm run verify` 会检查：

- 七项原则都有至少一个可执行资产；
- 每个 tracked Rule 和 ADR 都且只登记一次；
- active ADR 的状态、证据 selector、gate、Git commit 和适用路径真实存在；
- 已发布 schema fixture 的 SHA-256 直接基于原始 bytes 计算且未被改写，文本解析不能先吞掉
  invalid UTF-8 差异；
- automated/mixed evidence 的实际 runner 至少能沿 package script、verify plan 或 workflow 的
  执行边到达一个声明 gate，不能把 Vitest/Node/Rust/Playwright selector 虚挂到无关 lane；
- 每个生产文件都有唯一 module、layer 和 owner Rule，禁止依赖边与架构例外可审计；
- settings、Tauri commands、capability/window/permission、entitlement、CSP、外部 host、前台
  recurring schedule 与全部 timer/frame callback 的实际表面积和机器预算一致；
- PR 模板仍保留显式变更类型、轻量 Change Brief、失败复现、根因、同类扫描、权限/状态
  成本、Rule/ADR/Invariant 和验证字段；
- tracked verify plan 的步骤、顺序、`--locked` 与 Clippy `-D warnings` 没有相对 base
  被弱化，运行器执行的正是该计划；
- 生产代码与治理工具预算只能下降。

active context（`CONTEXT.md`、Rules、ADR、maintainability 与
always-load 文档）受 `contextBudgets` 的 `maxLines`/`maxBytes` 约束；always-load 上限必须更紧。
只有登记 reason 的 legacy hotspot 可暂时超出且上限只能下降；已有文件不得借热点扩容，
资产 supersede 或改路径时，替代链须继承或收紧原上限，不得借新 ID/路径扩容。

门禁的“扫描范围”本身也是事实源：TypeScript/Vitest/Tauri/Cargo/build 配置保持精确合同，
禁止 workspace、local path dependency、tracked symlink/submodule 和替代配置把真实执行代码
移出 module map、coverage、测试发现或权限预算。CI/Release 安装依赖使用 `npm ci
--ignore-scripts`，仓库同时禁止 npm install lifecycle hook，避免验证开始前先执行可变代码。
Vite 的 `public/` 被关闭且 `index.html` 精确锁定；`src/` 未登记资产扩展和前端动态代码执行
同样 fail closed，避免把会进入 App/DMG 的 payload 放在 ownership、strict、coverage 与预算之外。
可执行 JS/TS 与治理 module closure 只能位于已建档 source/tooling roots；GitHub automation
也采用五个 workflow 的 exact allowlist。需要新增入口时先扩展资产图、预算、负向测试与 ADR，
不能先把代码或 workflow 放进一个未受治理的路径。

## 开始改动：按范围加载上下文

Rules/ADR 多以后不应全部塞进上下文。先运行：

```bash
npm run governance:context -- --base-ref origin/main
```

也可以直接传入准备修改的路径。命令会输出必须阅读的全局资产、匹配当前路径的 Rule/ADR
和高风险 Invariant ID。它是上下文选择器，不是第二套验证入口；完成实现后仍只运行
`npm run verify`。

`module-map.json` 负责把 changed path 解析到唯一 module、layer、owner Rule 和相关 ADR。
新增生产文件必须先登记归属；模块迁移、依赖策略放宽或临时例外必须有 ADR 和明确退出条件，
不能在同一 PR 里静默重写边界。

## 默认分支治理审查：有限信任，不冒充信任根

普通 `pull_request` 检查会执行 PR 分支里的脚本，因此只靠它不能证明 PR 没有同时削弱门禁。
`Trusted policy / guard` 从默认分支通过 `pull_request_target` 运行，只把 PR 的文件清单和标签
当作数据，不 checkout、import 或执行 PR 代码。它从同一 trusted base 严格解析治理 catalog，
把 active asset 与 active/retiring Invariant 的 evidence 路径动态纳入 critical；catalog 缺失、
非法、路径危险或 evidence 文件被改名/弱化都失败并要求当前 head 上重新发生明确的
`governance-reviewed` label event。原生 job `Trusted policy / guard` 关联 PR head；脚本只读
API，退出码决定 job，且 checkout/执行始终来自 base SHA。CI 也订阅 `pull_request.edited`。

这是仓库内的防篡改加固，不是密码学意义上的独立信任根：共享的 GitHub Actions
integration 不能隔离同仓库内另一份同名 job。手工 POST CheckRun 还可能落入其他已取消
suite，因此被禁止。远端 checker 会要求 required checks 显式绑定 integration，并锁定 job/权限
合同，但不能把 GitHub Actions 自己变成独立安全主体。需要“PR 无法给自己开绿灯”的强边界
时，必须改用凭据隔离的专用 GitHub App，或组织级、从独立受控仓库提供的 required workflow，
再让 ruleset 绑定该专用 integration。远端规则尚未激活时，只能称为机制已实现；在当前
in-repository 方案激活后，也只能称为有限信任的治理审查。

## 新功能：先支付长期成本

新增设置、Tauri command、网络 host、目录能力、capability、entitlement、timer、daemon、
常驻开销或兼容分支前，PR 必须说明为什么合理默认值和现有实体不能解决。改变现有产品
边界时先写 ADR，再更新 `surface-budget.json`、负向测试与 Rule；源代码里出现未登记实体会
直接失败。没有明确用户价值时不增加实体。

## 修 Bug：把一次事故变成资产

1. 在公开 seam 写一个能让旧行为失败的回归测试。
2. 记录根因；症状不是根因。
3. 用 Invariant 的 protected paths 扫描同类入口、adapter、竞态和数据路径。
4. 做最小修复，执行唯一门禁。
5. 新增长期边界时更新 Rule/ADR/Invariant；没有新边界时明确说明。
6. 只有功能和全部入口消失，或已有更高层契约完整替代时，才能退休旧测试和 Rule。

Squash merge 后仓库通常不能重放 red commit，因此 PR evidence 必须写出失败测试的名字和旧
行为；`CI / verify` 会检查字段完整、changed paths 对应的 Invariant ID 都已列出，Bug PR
由模板内必选且互斥的“变更类型”认定，并必须填写根因与同类扫描；标题显式写出 fix/bug/
hotfix/修复却选择非 Bug 会失败。模板同时承担轻量 Change Brief，所有 PR 都写明用户问题、
非目标和实际验收层；docs/chore 不另造一份独立简报。module map 与 governance context 还会
返回 changed paths 对应的 owning Rule/ADR asset ID，PR 必须用稳定 ID 明确列出，不能只贴路径。
独立 lane 必须在“已运行并附结果/链接”和“不适用并说明原因”中且只选择一个，同时显式确认
diff 没有秘密、真实用户数据或本机/内部资料。自动化只能证明字段完整、ID 与 changed paths
一致，不能证明 run、链接或人工声明真实；最终测试负责持续保护，作者和审查者负责核对证据，
也不伪称能够证明历史 commit 当时确实运行过。

## 证据层与完成定义

绿色 source/static check 不能替代浏览器行为，绿色测试不能替代数据库/文件系统回滚，
本地正确 commit 不能替代远端 tag/Release，Release 元数据也不能替代下载后的 DMG 实物。
PR 只声明实际验证过的层；Release 继续通过 local manifest 与 remote download 两阶段复验。

## 生命周期与新鲜度

- Rule 新鲜度由其 protected paths 发生变化时触发复审，不用日历打卡制造形式主义。
- ADR/asset 替换可形成无环 A -> B -> C，终点须 active 并覆盖旧 kind、principles、selectors、
  gates 与 evidence；tombstone 不可改删。路径或证据改名只能由 accepted ADR 的 `migration`
  映射承接。Invariant 先 retiring；gate replacement 须保留旧 capabilities 和实际 runner，所有
  owner 迁移后才能 retired。架构/治理热点与 verify step 同样分阶段退出，不能先删证据和范围。
  retiring -> retired 须有完整 replacement；仅当 protected selector 全消失，才可用 accepted ADR
  声明 `featureRemoved=true`。retired 记录退出 context 但永久冻结。verify step 的 constitution
  capability 还锁定 audited command/args，不能靠自报字符串换门禁。
- 七项原则的 ID 与名称是 exact contract；共同词汇、维护系统、架构事实源和贡献合同是 required
  global assets，必须保持 active 且 `alwaysLoad=true`。已有全局资产不能在后续 base 中降级为
  按需加载。
- published fixture 只允许追加新版本，不重写历史版本。
- 产品表面积按 active -> retiring(reason) -> 后续 PR 删除，新增实体必须从 active 开始。
- 临时 test waiver 只允许 tracked ledger 中最长 30 天的 active ID，并且只能隔离独立 lane；
  active scope 不可改写，过期即失败，retired tombstone 永久保留，主测试仍禁止 skip。
- 删除兼容逻辑时同步删除对应状态、分支、测试和文档；测试若仍保护跨实现不变量则保留。
- 防腐工具也属于代码：新治理模块上限 800 行，既有热点只能拆分和下降。

## 事实源分工

| 问题 | 唯一事实源 |
|---|---|
| 共同语言 | `CONTEXT.md` |
| 产品架构与依赖方向 | `docs/engineering/architecture.md` |
| 生产文件归属与机器依赖策略 | `docs/engineering/module-map.json` |
| 难以逆转的历史取舍 | `docs/adr/` |
| 当前模块行为边界 | `docs/rules/` |
| 数值与不可改写基线 | `docs/engineering/*.json` |
| 确定性 gate 步骤 | `docs/engineering/verify-plan.json` |
| 设置、权限、网络、schedule 与 timer/frame callback 表面积 | `docs/engineering/surface-budget.json` |
| 独立 lane 临时测试豁免与退休记录 | `docs/engineering/test-waivers.json` |
| 贡献/PR 证据格式 | `CONTRIBUTING.md`、PR template |
| 安全披露 | `SECURITY.md` |
| 确定性验证 | `npm run verify` |
| 发布实物合同 | `docs/rules/testing-release.md` |

README 只解释用户需要的安装和使用信息；本机 `AGENTS.md` 只保存私有约束并索引上述 tracked
事实源，二者都不复制一套新的治理合同。
