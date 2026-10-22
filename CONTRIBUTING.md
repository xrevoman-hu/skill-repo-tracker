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

## main-only 变更与发布

- 开发分支只保留在本地；远端只保留 `main`。提交前完成变更审查与本地验证，仅允许
  main 快进推送；不 force-push、不删除 main、不临时恢复远端开发分支。
- 服务端不再要求 PR 或合并前检查；失败代码可能先进入 main。推送后必须等待同一 SHA
  最新 `CI` run 的最新 attempt 中 `baseline`、`verify`、`coverage`、`msrv` 全部成功，
  才能发布。失败时停止发布，以新提交修复，不能用旧绿灯或改写历史掩盖失败。
- `node scripts/main-push-evidence.mjs local-baseline` 只读解析远端 main 与最近完整成功祖先 V；
  对已提交来源执行验证时，将返回的同一 `validatedBase` 传给 `VERIFY_BASE_REF`、
  `ARCHITECTURE_BASE_REF`、`COVERAGE_BASE_REF`，覆盖 V 以来全部变化，不能选择最近红灯提交。
  实际 GitHub 设置与两阶段迁移见 `docs/engineering/github-governance.md`。
- 变更记录保留用户问题/价值、非目标、实际验收层、owning Rule/ADR 和高风险 Invariant ID。
  Bug 修复还必须写明失败复现、根因、同类扫描及修复证据。策略修改须人工审查；
  main-only 不提供独立默认分支审查者，仓库自身 CI 不是不可绕过的信任根。
- 迁移阶段 A 保留旧 PR 模板与 guard 的历史执行证据，阶段 B 才退休；它们不再是当前
  推送审批入口。Accepted ADR 原文与仍被其 selector 引用的历史回归保留。
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
- 变更记录必须说明独立 lane 已运行并附结果/链接，或说明不适用的原因；同时确认
  diff 没有秘密、真实用户数据、`AGENTS-local.md`、`docs/internal/` 或宣传草稿。门禁只能验证字段、
  stable ID 与 changed paths 的一致性，不能证明填写内容真实；作者和审查者仍要核对实际 run、
  diff 与验收层。
- 不提交 `AGENTS-local.md`、`docs/internal/`、宣传草稿、秘密或用户真实数据。

架构入口：`docs/engineering/architecture.md`。安全边界：`SECURITY.md`。
