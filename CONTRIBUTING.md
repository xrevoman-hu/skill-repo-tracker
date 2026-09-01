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

## PR 规则

- 从分支发 PR；`main` 必须保持最新并通过 `CI / verify`、`CI / coverage`、`CI / msrv`。
- 不 force-push/删除 main。单维护者阶段不强制他人审批，但不能绕过检查。
- 修 Bug 按“失败复现 -> 根因 -> 同类扫描 -> 修复 -> Rule/ADR”提交证据。
- 新功能说明是否新增设置、权限、后台状态或常驻开销；如无必要勿增实体。
- 新生产模块最多 800 行；热点预算只能下降。
- 生产 TypeScript 不使用显式 `any`；测试不提交 `.skip`、`.only`、`.todo` 或未白名单
  `#[ignore]`。
- 不提交 `AGENTS.md`、`docs/internal/`、宣传草稿、秘密或用户真实数据。

架构入口：`docs/engineering/architecture.md`。安全边界：`SECURITY.md`。
