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
active `WAIVER-YYYY-NNN`；变更记录只引用该 ID，不能用自由文本 issue/owner/date 代替。active scope
不可改写，过期即失败；退出时改为永久不可删除的 retired tombstone。主测试套件仍不得 skip。JS
test/suite callback 禁止 generator/async-generator，第三参数只允许 numeric literal timeout；
`.each` 只接受非空且无 spread/空洞的 literal rows，避免 runner 注册 0 项或 TestOptions 假绿。

## 验证 lane

- 确定性门禁：`npm run verify`。
- Vitest 固定 `maxWorkers: 2`；测试范围、超时和断言不变。
- 执行范围：`tsconfig.json`、`vitest.config.ts`、`src-tauri/Cargo.toml`、Tauri config 与
  `build.rs` 是精确合同；`vite.config.mjs` 锁定唯一生产入口，`playwright.config.ts` 锁定
  `e2e/`、Chromium 与 DemoAppService web server。禁止 Vitest projects/workspace、
  npm/Cargo workspace、本地 path/link
  package、tracked symlink/submodule 和 npm install lifecycle hook。CI/Release 在运行任何仓库
  npm script 前用 `npm ci --ignore-scripts` 安装依赖，避免门禁被替代执行器或安装脚本抢跑。
  Cargo 的真实 target 由 `cargo metadata` 复核为唯一 lib/bin/build 入口；Cargo manifest 不得
  自定义 lint level，Rust 源码不得 `allow/expect(warnings)`，因此 Clippy `-D warnings` 保持
  最高优先级。
  仓库 workflow 采用阶段化精确清单：main-only 阶段 A 保留五份，阶段 B 只保留 CI、Release gate、
  Security audit、Weekly resilience。未知 workflow 或本地 Action 失败；普通 push 永不发布。
  GitHub 托管的 Dependabot Updates 动态 workflow 单独登记，功能设置另行校验；状态缺失/未知
  均失败。checkout/setup-node 固定已审查的 Node 24-native 完整 SHA；普通 CI 显式 npm cache，
  baseline 和 A 阶段 Trusted policy 禁用 package-manager-cache。Dependabot 三类版本更新限额
  均为零，安全修复 PR 关闭但告警保留；修复通过本地分支验证后快进 main。
  JavaScript/TypeScript 可执行代码只允许位于 `src/`、`scripts/`、`e2e/` 与三份精确根配置，
  治理工具的本地 module import 也不得逃出 `scripts/` 的预算和 trusted-review 范围。
  治理脚本只允许沿 canonical 顶层静态 import/export 执行图可达；`eval`、`Function`、VM、
  dynamic loader 与 dead-shell/注释不得制造入口或执行未建档 payload。
  Vite `publicDir` 必须关闭，`index.html` 是唯一精确入口；`public/`/`src/` 未登记资产失败；
  外部 PostCSS 配置及 package `postcss` 字段禁用，构建仅用精确 inline 空 plugin。JS/CSS
  目标 `safari15` 不含 polyfill；Safari 15.4 API 必须替换或由入口兼容层先安装；CSS
  渐进增强须保留 Safari 15 focus fallback。sourcemap 关闭；bundle gate 拒绝 map、
  远程/内联脚本、meta refresh/CSP 冲突。生产禁用 eval/Function/WebAssembly 执行 raw/URL payload；
  新可执行资产类型必须先纳入 module ownership、coverage、预算和负向测试。
- Coverage：`npm run coverage:check`；基线只能上调，累计变更生产代码 changed lines >=80%、
  branches >=70%；测试文件和 coverage 配置明确排除的入口不计入 changed-lines 分母。
  前端覆盖率采集固定使用单一 test-file 执行上下文和单一报告合并线程；普通 Vitest 仍可并行。
  同次详细 JSON 与 LCOV 的语句起始行、函数、分支命中状态对账后，可用命中语句范围和函数
  声明补足多行证据；缺失 DA 仍入原分母，零命中语句、嵌套分支/函数优先否决，已有零 DA 不可
  覆盖。缺失/无效/不一致证据不能算覆盖。这是语句覆盖，不保证语句抛错后的表达式已完成。
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
  首次治理引入只 bootstrap “整体基线不得下降”的历史比较；只要有有效 base commit，
  本次生产代码仍必须执行 80%/70% changed threshold。基线进入 `main` 后不得下调。
  无效 base ref 会失败，已跟踪基线的读取错误、无效 JSON 或缺失指标也会失败，不会被
  当成 bootstrap。
  `docs/engineering/coverage-baseline.json` 仅能在干净 commit 运行
  `node scripts/check-coverage.mjs baseline --write` 更新：连续两轮前端/Rust coverage，各轮前后
  核对同一 clean HEAD 和新生成实物 mtime，拒绝外部 snapshot。按原始 covered/total 比较，
  漂移最多 0.01 个百分点；取两轮较低值向下保留两位，且不得低于历史基线。禁止手改、单次采样
  或四舍五入抬高指标。历史 `ec4162…` 是编排上线前两次 clean-main 测量并经双轴人工审查的
  一次性 `reviewed-bootstrap-v1`；后续仅写 `orchestrated-two-run-v1`、完整 SHA 和严格字段，
  旧格式只兼容读取比较。
- E2E：`npm run test:e2e`，只用 `DemoAppService` 和虚构数据；CI 将它作为
  `CI / verify` 中确定性入口之后的浏览器验收步骤。浏览器流必须在导航前拦截全部请求，
  只允许当前 `127.0.0.1` 预览服务，并在测试结束时断言没有尝试访问外部地址。当前最小验收
  覆盖检测、备份、新增远端仓库、取消本地目录选择、retry 晚回流、设置回灌、GitHub 429
  恢复及 Prompt 创建/tag/search/ZIP 导入导出；不得用无动作按钮或任意 sleep 制造假绿。
- main-only：CI 仅响应 main push；baseline job 只读选择最近成功祖先 V，verify/coverage/msrv
  复核并共用 V 的三个 BASE_REF。最新 run 的最新 attempt 四 job 全部成功才能发布；失败提交
  不能截断累计 diff。bootstrap S、schema 2 精确退休与两次真实推送按 ADR 0014。
  A 保留旧 PR/Trusted 执行证据且禁止发布；B 才退休。Accepted ADR 原文和仍引用的历史测试
  不改写。服务器移除 PR/check 前置拦截后，失败代码可能先进入 main；不声称保护等价。
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

本地 phase 先确认政策已完成阶段 B，并校验同一 SHA 最新 CI attempt 的四个 job 全部成功；
随后从固定的官方 GitHub Git URL 以隔离、精确 refspec 获取最新 `origin/main`，确认 `HEAD` 与其完全一致且
远端尚不存在本次版本 tag；在生成 manifest 前还要重新执行同一检查，防止验证期间远端
状态漂移；同时重新核对最新 CI。remote phase 开始也复核阶段与同提交 CI。
三个 BASE_REF 都绑定同一成功祖先 V，不能以 HEAD 充当基线。随后跑全部门禁和性能测试，再构建 `.app`/DMG。ad-hoc 顺序固定为：完整
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
GitHub API、Release 查询/下载与 tag 抓取绑定同一官方仓库，不接受 `GH_REPO`/`GH_HOST`
替换来源；官方 main SHA 在发布证据查询前后核对。GitHub Release 标题必须精确为 `Skill Repo Tracker vX.Y.Z`，正文须与 tracked
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
