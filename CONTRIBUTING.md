# 贡献指南

## 环境与唯一门禁

使用 `.node-version`/`.nvmrc` 指定的 Node 22.23.1、npm 10.9.8，以及
`rust-toolchain.toml` 指定的 Rust 1.95.0。安装依赖后只需运行：

```bash
npm ci
npm run verify
```

不要在文档或 PR 中复制一套可分叉的子命令。`CI / verify` 在确定性入口后追加 E2E；
MSRV 1.88.0、coverage、网络审计、性能与 Release 是独立 CI lane，见
`docs/rules/testing-release.md`。默认 Rust 是 1.95.0；
固定 nightly 只用于 LLVM branch coverage，不参与产品构建。

开始修改前可运行 `npm run governance:context -- --base-ref origin/main`，按 changed paths
只加载相关 Rule、ADR 和高风险 Invariant；这只是上下文选择器，不是新的验证入口。共同
词汇见 `CONTEXT.md`，资产链与生命周期见 `docs/engineering/maintainability-system.md`。

## PR 规则

- 从分支发 PR；`main` 必须保持最新并通过 `CI / verify`、`CI / coverage`、`CI / msrv` 与
  `Trusted policy / guard`。后者从默认分支审查治理路径，不能执行 PR 分支代码。
- 不 force-push/删除 main。单维护者阶段不强制他人审批，但不能绕过检查。
- 修改 `.github/workflows/`、治理脚本或机器事实源时，必须经过治理审查并添加
  `governance-reviewed` 标签；标签只表示人工完成了策略审查，不能替代其余检查，也不是独立
  信任根。GitHub Checks 的同-head撤销与 integration 隔离边界见
  `docs/engineering/github-governance.md`。
- 每个 PR 必须且只能勾选一种变更类型。选择“Bug 修复”时按“失败复现 -> 根因 ->
  同类扫描 -> 修复 -> Rule/ADR/Invariant”提交证据；标题包含 `fix`、`bug`、`hotfix` 或
  “修复”时不能选择“非 Bug 变更”。PR 必须写出 changed paths 选择器要求复审的全部 owning
  Rule/ADR asset ID 和高风险 Invariant ID；路径或自由文本不能替代稳定 ID。`CI / verify`
  检查完整性，审查者判断内容是否真实。
- PR 模板就是轻量 Change Brief：必须写明用户问题/产品价值、非目标和实际验收层。`docs`/
  `chore` 也直接填写模板，不为满足流程另建一份简报文档。
- 新功能说明是否新增设置、权限、后台状态或常驻开销；所有变化同步更新
  `docs/engineering/surface-budget.json`，如无必要勿增实体。
- 新生产模块和新治理工具最多 800 行；热点预算只能下降。新增生产文件必须在
  `docs/engineering/module-map.json` 登记唯一 module、layer 和 owner Rule；放宽依赖策略或
  迁移归属必须关联 ADR。不得用 workspace、local path package、symlink/submodule、替代
  Vitest/Tauri config 或压缩成超长单行把可执行代码移出上述治理范围。
- 生产 TypeScript 不使用显式 `any`；测试不提交 `.skip`、`.only`、`.todo` 或未白名单
  `#[ignore]`。
- 临时 skip/flaky 债务只允许隔离到独立 lane，并引用
  `docs/engineering/test-waivers.json` 中未过期的 active `WAIVER-YYYY-NNN`；字段与生命周期以
  `docs/rules/testing-release.md` 为准，主测试仍不得 skip。
- PR 必须在“独立 lane 已运行并附结果/链接”和“不适用并说明原因”中且只能选择一项，并确认
  diff 没有秘密、真实用户数据、`AGENTS.md`、`docs/internal/` 或宣传草稿。门禁只能验证字段、
  stable ID 与 changed paths 的一致性，不能证明填写内容真实；作者和审查者仍要核对实际 run、
  diff 与验收层。
- 不提交 `AGENTS.md`、`docs/internal/`、宣传草稿、秘密或用户真实数据。

架构入口：`docs/engineering/architecture.md`。安全边界：`SECURITY.md`。
