# GitHub 远端治理

仓库内 workflow 和 Dependabot 配置不能自动证明 GitHub 远端保护已经启用。首次将本批
治理代码通过 PR 合入、且 `CI / verify`、`CI / coverage`、`CI / msrv` 全绿后，仓库
管理员需要在 GitHub Settings 完成一次显式设置。

## 人工应用步骤

1. 在 Settings -> Rules -> Rulesets 新建 target 为 Branch、作用于 `main` 的 active
   ruleset；可显式选择 `main`，或仅在仓库真实 default branch 就是 `main` 时选择
   default branch。
2. 启用 Require a pull request before merging；单维护者阶段 required approvals 设为 0。
3. 启用 Require status checks，并选择 `CI / verify`、`CI / coverage`、`CI / msrv`。
4. 启用 Require branches to be up to date before merging。
5. 阻止 force push 和 branch deletion；确认 ruleset API 中 `bypass_actors` 字段存在且为
   空数组，不允许任何 bypass actor。
6. 在 Settings -> Security / Code security and analysis 启用 Dependabot alerts 和
   Dependabot security updates。
7. 在 Settings -> Environments 创建 `release`，配置 required reviewer，并关闭管理员
   bypass（API 中 `can_admins_bypass` 必须明确为 `false`），供仅 `workflow_dispatch` 可
   触发的 `Release gate` 使用。

本计划不在本地工作树阶段修改远端；管理员必须在首次 CI 全绿后执行以上步骤。

## 只读验收

登录能够读取完整 ruleset/Environment 细节的 GitHub CLI 后运行；GitHub 仅向具有仓库写
权限的调用者返回 ruleset `bypass_actors`，因此只读账号会按“无法核验”失败，但脚本自身
仍只执行读取操作：

```bash
npm run github:governance:check
```

脚本只调用只读 `gh repo view`/`gh api`，先读取真实 default branch，再核对 target=Branch
的 active main ruleset、明确为空的 `bypass_actors`、PR 必经、三个 required checks、
strict/up-to-date、force/delete 禁用、两项 Dependabot 设置、active `CI`、`Release gate`、
`Security audit`、`Weekly resilience` workflows，以及 `release` Environment 至少一个 required reviewer 且
`can_admins_bypass=false`。字段缺失、权限不足或无法核验都失败，不会把未知状态当成通过。
