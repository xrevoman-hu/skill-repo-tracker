# 测试、修 Bug 与发布 Rules

## 修 Bug 协议

1. 先写一个会让旧实现失败的公开 seam 回归测试。
2. 记录根因，而不只描述症状。
3. 搜索同类入口、adapter、竞态或数据路径并记录结论。
4. 修复最小行为，运行 `npm run verify`。
5. 若暴露新的长期边界，同步更新 Rule/ADR；已过时规则必须删除。

生产 TypeScript 禁止显式 `any`。测试代码禁止 `.skip`、`.only`、`.todo`；Rust `#[ignore]`
只白名单 `prompt_library_release_performance_gate`，且 weekly/Release 必须显式运行。确需临时
隔离时改到独立 lane，并记录 issue、负责人和删除日期，不能在主测试套件内静默跳过。

## 验证 lane

- 确定性门禁：`npm run verify`。
- Coverage：`npm run coverage:check`；基线只能上调，PR 生产代码 changed lines >=80%、
  branches >=70%；测试文件和 coverage 配置明确排除的入口不计入 changed-lines 分母。
  Rust 的 production-only 口径同时剔除独立 `*_tests.rs` 和生产文件内由精确
  `#[cfg(test)]` 保护的字段、helper、语句与 inline test module；整体指标也从过滤后的
  LCOV 重算，测试体命中不能抬高生产基线。生产 Rust 禁止 `include!`，`#[path]` 只允许
  `#[cfg(test)]` 的独立 `*_tests.rs`，避免把可执行代码藏到库存之外。
  默认 Rust 仍为 1.95.0；仅 Rust branch coverage 固定使用
  `nightly-2026-08-01` + `llvm-tools-preview` + `cargo-llvm-cov 0.9.0`，不得缺失后
  静默降为 0。
  首次治理 PR 只 bootstrap “整体基线不得下降”的历史比较；只要有有效 base commit，
  本次生产代码仍必须执行 80%/70% changed threshold。基线进入 `main` 后不得下调。
  无效 base ref 会失败，已跟踪基线的读取错误、无效 JSON 或缺失指标也会失败，不会被
  当成 bootstrap。
- E2E：`npm run test:e2e`，只用 `DemoAppService` 和虚构数据；CI 将它作为
  `CI / verify` 中确定性入口之后的浏览器验收步骤。
- MSRV：CI 用 Rust 1.88.0 `cargo check --locked`。
- 性能：weekly 与 Release 跑 10,000 prompts / 100 MiB ignored test。
- 安全审计：独立 schedule，网络失败不改变本地确定性结果。

## 发布

普通 push 永不发布。唯一接口是：

```bash
npm run release:verify -- --lane adhoc --version X.Y.Z --phase local
(
  set -euo pipefail
  set +x
  RELEASE_MANIFEST_TOKEN="$(<"/absolute/path/Skill Repo Tracker_X.Y.Z_aarch64.release-<MANIFEST-ID>/manifest.token")"
  npm run --silent release:verify -- \
    --lane adhoc --version X.Y.Z --phase remote \
    --manifest-token "$RELEASE_MANIFEST_TOKEN"
)
```

本地 phase 会先跑全部门禁和性能测试，再构建 `.app`/DMG。ad-hoc 顺序固定为：完整
签名 `.app` -> 把该 App 单独复制到临时 staging -> 从 staging 重新封装 DMG -> 签名 DMG
-> 只读挂载复验。staging 顶层只能有正式 App；挂载顶层只允许正式 App、指向
`/Applications` 的精确软链和 Finder 的 `.DS_Store`，出现其他文件即失败。local phase 在
生成清单前再次检查工作树干净，然后输出 SHA-256，并在 DMG 旁通过单次目录 rename 原子
发布不可变的 `Skill Repo Tracker_X.Y.Z_aarch64.release-<MANIFEST-ID>/` generation 目录。
目录权限为 `0700`，只包含权限均为 `0600` 的 `manifest.json`、`manifest.token`；不得把
token 内容打印到终端或 CI 日志。同名 generation 只有在目录结构、权限与内容完全一致时
才可复用，否则必须 fail closed，不得原地改写。token 是把操作者交接的
version/commit/name/bytes/SHA 字段放在同一载体中的 unsigned artifact-field carrier，
避免逐字段混用；它不是凭据，没有签名，不能证明是谁生成，也不能单独证明 local gate
确实执行过。generation 目录及其文件不得上传为 Release 资产或写入 Release notes。远端
phase 必须从该目录内 `0600` 的 `manifest.token` 读取并显式接收 token，再独立核对
main/tag/Release/digest 并下载复验，且 release refs、下载实物和服务端元数据必须与
manifest 字段一致；
上传结果不明时先查询，禁止盲目重试。
远端 phase 获取 refs 时必须使用 `git fetch --no-tags`，并把正式远端 tag 非强制地拉到
verifier 自有的 `refs/tags/_srt-release-remote/vX.Y.Z`；后续 annotated type 与 peel
检查只读取该隔离 ref，不读取 `actions/checkout` 可能在正式本地 `vX.Y.Z` 上创建的
lightweight tag。隔离 ref 必须仍在 `refs/tags/` 下且 refspec 不得加 `+`：不能改放
`refs/remotes/` 或任意自定义 namespace，因为 Git 对 `refs/{tags,heads}/*` 之外的 fetch
更新不提供同等的 tag 不可改写拒绝语义，远端 tag object 被改写时验证器必须 fail closed。
GitHub `Release gate` workflow 在 GitHub 当前明确为 Apple Silicon 的 `macos-15` hosted runner 上运行 local/remote
phase，并绑定 `release` Environment 人工批准；开发机也必须是 Apple Silicon 才能运行
local phase 的 arm64 实物校验。云端 local gate 不上传或导出 token artifact；供正式发布
交接的 token 只能来自最终干净 `main` 上本地 local phase 原子发布的 generation 目录。
