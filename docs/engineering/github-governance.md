# GitHub 远端治理

仓库内 workflow 和 Dependabot 配置不能自动证明 GitHub 远端保护已经启用。首次将本批
治理代码通过 PR 合入、且 `CI / verify`、`CI / coverage`、`CI / msrv` 全绿后，仓库
管理员需要在 GitHub Settings 完成一次显式设置。仓库内文件只能定义候选策略；远端
workflow 状态和 ruleset 才是实际执行层。

## 默认分支治理审查及其信任边界

`.github/workflows/trusted-policy.yml` 使用 `pull_request_target`，但只 checkout
`pull_request.base.sha` 并执行该 base commit 中的 `scripts/trusted-policy-guard.mjs`。PR
head 代码、workflow、脚本、依赖和 artifact 均不 checkout、不执行、也不进入 cache；变更
文件名、rename 的旧文件名、labels、事件 action/label 和 head SHA 只作为 GitHub event/REST
API 数据处理。

普通产品代码 PR 不需要额外 label。guard 会从同一 trusted base checkout 严格读取
`governance-assets.json`，把 active asset 以及 active/retiring Invariant 的全部 evidence 路径动态
加入 critical 集；catalog 缺失、结构非法或含危险路径一律失败。若变更触及这些 evidence、
`scripts/`、workflow、Rules、ADR、测试/编译配置、Tauri 权限或其他治理事实源，只有当前 head
上明确的 `governance-reviewed` labeled event 才通过。测试 selector 即使不变，只要 evidence
文件内容或 rename 前文件名变化也必须复审；guard 始终不读取 PR 文件内容。`synchronize`、
`edited`、`reopened` 与 `unlabeled` 会重新评估并使原生 job 失败，无关 label event 不能代替
复审。guard 同时复核 API 返回的 `head.sha`、base ref 与事件值；CI 另行订阅
`pull_request.edited`，title/body 修改后会重跑 PR evidence。

workflow 的原生 job 精确命名为 `Trusted policy / guard`。Actions 将这个
`pull_request_target` job 的 Check Run 关联到事件中的 PR head，并放入 `Trusted policy`
自己的 Check Suite；checkout 和可执行脚本仍明确来自 `base.sha`。脚本只做 Pull Request API
GET，退出码直接决定原生 job 成败，权限严格为 `contents: read` 与 `pull-requests: read`。
不能恢复手工 POST `/check-runs`：Create Check Run API 不能指定 `check_suite_id`，同一 SHA
有多套 Actions workflow 时，自建 Check Run 可能被归入另一套已取消的 suite，使 ruleset
永久显示 expected。API、输入、catalog 或策略判断异常都以非零退出码失败。

这里仍有不能靠仓库代码消除的边界：Ruleset 将 context 绑定到 GitHub Actions integration，
但不能隔离同仓库内另一份故意使用同名 job 的 workflow。因此这套方案是默认分支代码驱动的
有限信任流程加固，不是密码学意义上的“不可绕过信任根”。需要强信任根时，应使用凭据隔离
的专用 GitHub App，或组织级、从独立受控仓库提供的 required workflow，并把 ruleset 的
`integration_id` 绑定到该独立主体。

上述设计依据 GitHub 官方说明：[`pull_request_target` 在默认分支上下文运行且不能执行不可信
head](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)、
[不可信 checkout 的安全风险](https://docs.github.com/en/actions/reference/security/secure-use)、
[required check 必须成功于最新 commit SHA](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)、
[Check Suite 由 GitHub App 与 commit 组织](https://docs.github.com/en/rest/checks/suites?apiVersion=2022-11-28)、
[required check 可选择预期 GitHub App 来源](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)，
以及 [Rulesets REST 的 `integration_id` 字段](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)。

## 人工应用步骤

1. 在 Settings -> Rules -> Rulesets 新建 target 为 Branch、作用于 `main` 的 active
   ruleset；可显式选择 `main`，或仅在仓库真实 default branch 就是 `main` 时选择
   default branch。
2. 启用 Require a pull request before merging；单维护者阶段 required approvals 设为 0。
3. 启用 Require status checks，并选择 `CI / verify`、`CI / coverage`、`CI / msrv` 和
   `Trusted policy / guard`；每一项都通过 GitHub 的来源选择器绑定到产生该检查的明确
   integration。本仓库已从成功的 `verify`、`coverage`、`msrv` Check Run 只读核对 GitHub
   Actions App ID 为 `15368`；远端 checker 要求四项 `integration_id` 都精确等于 `15368`，
   缺失或任意其他正整数都失败。
   GitHub Rulesets REST payload 中对应的 Check Run context 分别是 `verify`、`coverage`、
   `msrv`、`Trusted policy / guard`；前三个 `CI / ...` 是界面显示标签，不能写进 API 的
   `context` 字段。最后一个是 `pull_request_target` 原生 job 在 PR head 上产生的精确名称。
4. 启用 Require branches to be up to date before merging。
5. 阻止 force push 和 branch deletion；确认 ruleset API 中 `bypass_actors` 字段存在且为
   空数组，不允许任何 bypass actor；单维护者阶段还必须明确设置
   `require_extra_approval_for_unattributed_changes=false`，避免 GitHub 新增默认字段使零审批
   规则漂移。
6. 在 Settings -> Security / Code security and analysis 启用 Dependabot alerts 和
   Dependabot security updates。
7. 在 Settings -> Environments 创建 `release`，将唯一 required reviewer 配置为
   `xrevoman-hu`，并关闭管理员
   bypass（API 中 `can_admins_bypass` 必须明确为 `false`），供仅 `workflow_dispatch` 可
   触发的 `Release gate` 使用。

本计划不在本地工作树阶段修改远端；管理员必须在首次 CI 全绿后执行以上步骤。

## 首次启用顺序

`pull_request_target` workflow 只有存在于 default branch 后才会运行，因此不能在它
首次合入前就把 `Trusted policy / guard` 设为 required，否则当前 PR 会永久等待一个尚不可能
产生的 context。正确顺序是：

1. 用现有三个 required checks 将 workflow、base guard 和测试合入 default branch。
2. 确认 GitHub API 报告 `Trusted policy` workflow 为 active。
3. 创建一个普通、不合并的 probe PR，确认原生 job `Trusted policy / guard` 出现在该 PR
   最新 head SHA，且它的 Check Suite 属于 `Trusted policy` run、不同于同 SHA 的 CI suite；
   再触及 critical path，确认无 label 失败、添加 `governance-reviewed` 后成功；记录实际
   App/integration。
4. 将精确 context `Trusted policy / guard` 加入 main ruleset并绑定上一步验证的 integration，
   再运行
   `npm run github:governance:check`。

第 4 步完成前，本地脚本与 workflow 只能称为“已实现”，不能称为保护已激活；远端
governance checker 预期失败是正确结果。即使激活，若绑定的是 GitHub Actions 而非独立主体，
也只属于有限信任的治理审查。

## 只读验收

登录能够读取完整 ruleset/Environment 细节的 GitHub CLI 后运行；GitHub 仅向具有仓库写
权限的调用者返回 ruleset `bypass_actors`，因此只读账号会按“无法核验”失败，但脚本自身
仍只执行读取操作：

```bash
npm run github:governance:check
```

脚本只调用只读 `gh repo view`/`gh api`；Rulesets 与 workflows 均使用 GitHub pagination 读取
全部页面，不把第一页冒充完整远端状态。随后确认真实 default branch 精确为 `main`（Trusted
policy 的 `pull_request_target` 必须从受保护的默认分支加载），再核对仓库只有一个
target=Branch 的 active ruleset，且该 ruleset 保护 `main`、`bypass_actors` 明确为空、PR 必经、approvals 精确为 0、
`require_extra_approval_for_unattributed_changes` 明确为 `false`、四个且仅
四个 required checks及其精确
`integration_id=15368`。第二个 active branch ruleset 会叠加 GitHub 的有效规则，可能暗中加入
陈旧 context，因此即使它表面只针对其他分支也必须先合并进唯一事实源或停用。检查器还要求
strict/up-to-date、force/delete 禁用、两项 Dependabot 设置、active `CI`、`Release gate`、
`Security audit`、`Weekly resilience`、`Trusted policy` workflows，以及 main ruleset 中
精确 required context `Trusted policy / guard`。任何额外 active repo workflow、未知
`dynamic/` workflow、缺失/未知 workflow state、重复 context 或永不产生的 required context
都会失败，避免旁路发布、冒充检查或把单维护者永久锁死；仅精确登记 GitHub 托管的
Dependabot Updates 动态 workflow，其功能状态仍由独立远端设置校验。最后再核对
`release` Environment 的唯一 required
reviewer 为 `xrevoman-hu` 且
`can_admins_bypass=false`。字段缺失、权限不足或无法核验都失败，不会把未知状态当成通过。
