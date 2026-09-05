# 测试、修 Bug 与发布 Rules

## 修 Bug 协议

1. 先写一个会让旧实现失败的公开 seam 回归测试。
2. 记录根因，而不只描述症状。
3. 运行治理上下文选择器，按 Invariant protected paths 搜索同类入口、adapter、竞态或数据
   路径并记录结论。
4. 修复最小行为，运行 `npm run verify`。
5. 若暴露新的长期边界，同步更新 Rule/ADR/Invariant；已过时资产先记录替代或退休条件，
   再连同无用状态、兼容分支和测试一起删除。

机器资产图在 `docs/engineering/governance-assets.json`。active Rule/ADR/Invariant 不得直接
失联；published schema fixture 的 checksum 只允许追加新版本，不能随实现重写。新鲜度由
protected path 变化触发，不以日历续期代替真实复审。

生产 TypeScript 禁止显式 `any`。测试代码禁止 `.skip`、`.only`、`.todo`；Rust `#[ignore]`
只白名单 `prompt_library_release_performance_gate`，且 weekly/Release 必须显式运行。确需临时
隔离时只能改到已批准的独立 lane，并在 `docs/engineering/test-waivers.json` 登记最长 30 天的
active `WAIVER-YYYY-NNN`；PR 只引用该 ID，不能用自由文本 issue/owner/date 代替。active scope
不可改写，过期即失败；退出时改为永久不可删除的 retired tombstone。主测试套件仍不得 skip。JS
test/suite callback 禁止 generator/async-generator，第三参数只允许 numeric literal timeout；
`.each` 只接受非空且无 spread/空洞的 literal rows，避免 runner 注册 0 项或 TestOptions 假绿。

## 验证 lane

- 确定性门禁：`npm run verify`。
- 执行范围：`tsconfig.json`、`vitest.config.ts`、`src-tauri/Cargo.toml`、Tauri config 与
  `build.rs` 是精确合同；`vite.config.mjs` 锁定唯一生产入口，`playwright.config.ts` 锁定
  `e2e/`、Chromium 与 DemoAppService web server。禁止 Vitest projects/workspace、
  npm/Cargo workspace、本地 path/link
  package、tracked symlink/submodule 和 npm install lifecycle hook。CI/Release 在运行任何仓库
  npm script 前用 `npm ci --ignore-scripts` 安装依赖，避免门禁被替代执行器或安装脚本抢跑。
  Cargo 的真实 target 由 `cargo metadata` 复核为唯一 lib/bin/build 入口；Cargo manifest 不得
  自定义 lint level，Rust 源码不得 `allow/expect(warnings)`，因此 Clippy `-D warnings` 保持
  最高优先级。
  仓库的 `.github/workflows/` 只允许五个已登记且整份精确校验的 GitHub workflows；新增
  repo-controlled workflow 或本地 Action 会失败，避免普通 push 发布、扩大写权限或用同名
  Check Run 冒充 required check。仅精确登记 GitHub 托管的 Dependabot Updates 动态 workflow，
  并由对应 GitHub 功能的独立设置校验；workflow state 缺失/未知，或 active tuple 字段缺失，
  均 fail closed。所有 workflow 的 `actions/checkout` 与 `actions/setup-node` 必须固定为已审查的
  Node 24-native 完整 commit SHA；普通 CI 明确启用 npm cache，执行 trusted base code 的
  Trusted policy 必须显式设置 `package-manager-cache: false`，不能让 package manager 字段隐式
  创建或读取 cache。Dependabot 每周检查 GitHub Actions，最多保留两个 PR，只分组 minor/patch；
  major 由人工审查和迁移。仓库内
  JavaScript/TypeScript 可执行代码只允许位于 `src/`、`scripts/`、`e2e/` 与三份精确根配置，
  治理工具的本地 module import 也不得逃出 `scripts/` 的预算和 trusted-review 范围。
  治理脚本只允许沿 canonical 顶层静态 import/export 执行图可达；`eval`、`Function`、VM、
  dynamic loader、dead-shell/注释中的路径都不能制造入口或执行未建档 payload。
  Vite `publicDir` 必须关闭，`index.html` 必须保持唯一精确入口；`public/` 和 `src/` 中未登记的
  资产扩展会失败；外部 PostCSS 配置与 package `postcss` 字段被禁止，构建只用精确 inline 空
  plugin 清单。生产前端不得用 `eval`、`Function` 或 `WebAssembly` 执行 raw/URL payload；
  新可执行资产类型必须先纳入 module ownership、coverage、预算和负向测试。
- Coverage：`npm run coverage:check`；基线只能上调，PR 生产代码 changed lines >=80%、
  branches >=70%；测试文件和 coverage 配置明确排除的入口不计入 changed-lines 分母。
  前端覆盖率采集固定使用单一 test-file 执行上下文和单一报告合并线程；普通 Vitest 仍可并行。
  这样避免 V8 在多 worker 或并行报告合并时产生不稳定的 branch inventory，确保两轮基线
  比较的是同一计量口径。
  生产前端禁止 `v8 ignore`、`c8 ignore`、`istanbul ignore` 注释指令，不能用 instrumentation
  pragma 把未测试分支从 LCOV 中删除。
  Rust 的 production-only 口径同时剔除独立 `*_tests.rs` 和生产文件内由精确
  `#[cfg(test)]` 保护的字段、helper、语句与 inline test module；整体指标也从过滤后的
  LCOV 重算，测试体命中不能抬高生产基线。生产 Rust 禁止 raw identifier、`include!` /
  `include_str!` / `include_bytes!` 及其导入别名；`#[path]` 只允许 `#[cfg(test)]` 的独立
  `*_tests.rs`，避免把可执行代码藏到库存之外。foreign ABI、`#[link]`、`asm!` /
  `global_asm!` 也在建立 ADR 与精确权限预算前 fail closed。
  非 test `cfg`/`cfg_attr` item 若被当前 feature/profile 省略，其 changed executable lines
  仍按未覆盖计入分母；生产源码禁止 `coverage(off)` 与 `feature(coverage_attribute)`，不能让
  release-only 或 feature-dependent 逻辑从 LCOV 消失。
  默认 Rust 仍为 1.95.0；仅 Rust branch coverage 固定使用
  `nightly-2026-08-01` + `llvm-tools-preview` + `cargo-llvm-cov 0.9.0`，不得缺失后
  静默降为 0。
  首次治理 PR 只 bootstrap “整体基线不得下降”的历史比较；只要有有效 base commit，
  本次生产代码仍必须执行 80%/70% changed threshold。基线进入 `main` 后不得下调。
  无效 base ref 会失败，已跟踪基线的读取错误、无效 JSON 或缺失指标也会失败，不会被
  当成 bootstrap。
  `docs/engineering/coverage-baseline.json` 的唯一更新协议是在干净 commit 上运行
  `node scripts/check-coverage.mjs baseline --write`。该命令自身连续执行两轮前端与 Rust coverage，
  每轮前后都核对同一个 clean HEAD，并要求两类实物的 mtime 都由该轮重新生成；不接受外部
  snapshot JSON 作为写入证据。两轮每项使用原始 covered/total 精度比较，漂移不超过 0.01 个百分点。
  只有通过漂移检查后，基线才取两次较低值并统一向下保留两位，且不得低于历史基线。禁止直接手改数字、用单次结果或用
  四舍五入把临界值抬过门槛；当前 `ec4162…` 数值是在编排命令进入仓库前完成两次 clean-main
  测量并经双轴人工复审的一次性 `reviewed-bootstrap-v1`，以后写入只能升级为
  `orchestrated-two-run-v1`。文件使用完整 commit SHA 和严格字段，读取已进入历史的旧格式时
  只保留兼容比较能力。
- E2E：`npm run test:e2e`，只用 `DemoAppService` 和虚构数据；CI 将它作为
  `CI / verify` 中确定性入口之后的浏览器验收步骤。浏览器流必须在导航前拦截全部请求，
  只允许当前 `127.0.0.1` 预览服务，并在测试结束时断言没有尝试访问外部地址。当前最小验收
  覆盖检测、备份、新增远端仓库、取消本地目录选择、retry 晚回流、设置回灌、GitHub 429
  恢复及 Prompt 创建/tag/search/ZIP 导入导出；不得用无动作按钮或任意 sleep 制造假绿。
- Trusted policy：`pull_request_target` 只执行 default-branch/base SHA 中的 trusted guard，
  通过 GitHub API读取 changed filenames、rename 旧路径与 labels；绝不 checkout 或执行 PR
  head。所有 `scripts/`、workflow 和机器治理事实源的变更必须带
  `governance-reviewed`。原生 job 精确命名 `Trusted policy / guard` 并关联 PR head，脚本只有
  `contents: read`、`pull-requests: read`，以退出码决定 job；不得通过 `/check-runs` 自建同名
  检查，因为其 suite 归属不可控。critical PR 的 `synchronize`、`edited`、`reopened` 与
  `unlabeled` 都会重新评估；只有 API 复核过的当前 head 上精确
  `governance-reviewed` labeled event 才成功，无关 label 不能代替复审。它是独立远端
  lane，不属于本地 `npm run verify`；首次合入后还要让 ruleset 把 context 绑定到明确
  integration。GitHub Actions integration 不是隔离同仓恶意同名 workflow 的独立身份，因此
  当前机制是有限信任的流程加固，不能称为不可绕过的信任根。强边界需要专用 GitHub App 或
  独立受控的组织级 required
  workflow，并将 ruleset 绑定到那个隔离 integration。
- MSRV：CI 用 Rust 1.88.0 `cargo check --locked`。
- 性能：weekly 与 Release 跑 10,000 prompts / 100 MiB ignored test。
- Test waiver：`npm run verify` 与 weekly 都执行 tracked ledger checker；active selector 必须指向
  仓库中真实测试文本，过期、幽灵 selector、主 lane waiver 或 tombstone 改写都会失败。
- 依赖风险：`npm run verify` 校验 `dependency-risk-ledger.json` 的 schema、90 天复查期限与
  append-only 生命周期；active scope 不可延期或改写，只能先退休旧 ID 再建立新 ID。
- 安全审计：独立 schedule 固定 `cargo-audit` 版本，并用三个 audited target 的
  `cargo metadata --filter-platform` resolve graph 对账。vulnerability、yanked、未知类别及未登记
  或失联的 unsound warning 均失败；unmaintained 只完整报告，不冒充已接受或已解决。数据库、
  命令、JSON 或 target graph 解析失败同样失败；禁止 `--ignore`、`--no-yanked`、`|| true` 或用
  raw `cargo audit` 绕过账本。网络失败只影响独立 Security audit，不改变本地确定性验证结论。

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

本地 phase 会先以隔离、精确 refspec 获取最新 `origin/main`，确认 `HEAD` 与其完全一致且
远端尚不存在本次版本 tag；在生成 manifest 前还要重新执行同一检查，防止验证期间远端
状态漂移。随后跑全部门禁和性能测试，再构建 `.app`/DMG。ad-hoc 顺序固定为：完整
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
GitHub Release 标题必须精确为 `Skill Repo Tracker vX.Y.Z`，正文须与 tracked
`docs/releases/vX.Y.Z.md` 规范化后完全相同，并保留中英文 ad-hoc/首次打开披露；不能只核对
tag 和资产。上传结果不明时先查询，禁止盲目重试。
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
Playwright 在 CI 允许一次重试以收集 trace，但启用 `failOnFlakyTests`；首次失败、重试成功仍然
判为失败，不能把 flaky 当成绿色证据。
