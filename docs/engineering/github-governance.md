# GitHub 远端治理

本文定义 main-only 目标合同，实际是否启用以只读远端检查和执行记录为准。
仓库文件已修改不等于服务器规则已迁移。决策与精确退休范围见
[ADR 0014](../adr/0014-main-only-governance.md)。

## 推送与发布边界

开发分支仅存在于本地；远端默认分支必须为 `main`，最终只保留这一分支。
先审查与本地验证，再快进推送 main；不强推、不删除 main、不创建临时远端分支。
服务器移除 PR 必经与合并前 required checks，因此失败代码可能先进入 main。
普通 push 永不发布；Release 必须等待同一 SHA 最新 CI run 的最新 attempt 中
`baseline`、`verify`、`coverage`、`msrv` 四个 job 全部成功，再通过既有 local/remote 实物门禁。

同仓库脚本与 workflow 可以同时改变，main-only CI 不能充当独立信任根。人工策略审查、
精确合同、累计基线、禁止历史改写和发布门禁分别承担有限保护，不宣称恢复 PR 的前置拦截。
失败时保留红灯记录并以新提交修复；不能使用同 SHA 较早成功的 run/attempt。

## 累计验证基线

CI 仅订阅 main 的 push，不取消正在运行的同分支 CI。`baseline` job 使用完整 Git 历史，
只读解析 GitHub API；其余三个 job 复核同一个 `validated_base`，分别传入
`VERIFY_BASE_REF`、`ARCHITECTURE_BASE_REF`、`COVERAGE_BASE_REF`。

V 是本次 before 到冻结 bootstrap S 范围内最近的合格祖先：同仓库、ci.yml、push/main、
最新 run 的最新 attempt 四个 job 完整成功，且 catalog 已有合法迁移计划。
无合格祖先时回到 S，不能选择最近红灯或本次 HEAD。事件、SHA、祖先关系、单父链、
catalog、ADR 摘要和分页任一无法核验则失败。搜索最多 1,000 个提交，每 SHA 最多 10 页、
全局最多 200 次 API 请求；超限失败，不截断后报绿。

本地 `node scripts/main-push-evidence.mjs local-baseline` 返回同一算法的基线与远端 head，
仅用于准备验证环境，不自动推送。Release 在构建前、manifest 生成前、remote phase 开始
分别复核最终阶段、来源 SHA 与最新四 job 结果；阶段 A 不得发布。

表面积历史单独按 V→HEAD 的真实逐提交边验证 active→retiring→删除，再验证工作树末边；
拒绝浅克隆、merge、缺对象、超过 1,000 条边与非法中间状态。历史只读取固定
surface-budget.json，不执行历史脚本；当前源代码发现与登记仍须匹配。catalog、架构、
coverage 继续用同一个 V 累计比较。

[ADR 0015](../adr/0015-surface-history-correction.md) 单独接受一个已固定旧父边的两项 purpose
文案错误；完整前后记录与摘要必须匹配，不改写历史、不变更累计 V，也不放宽其他父边或当前源码登记。

## 两阶段迁移

1. A：schema 2 catalog 登记不可变 main-only-2026-10 计划；旧 PR template asset、Trusted
   gate、两个 PR 专属 Invariant 改为 retiring，旧五份 workflow 与证据保留。启用 main-only
   CI，Dependabot 版本更新限额置零，关闭安全修复 PR，保留安全告警。
2. A 快进 main 后等该提交完整 CI 成功。A/B 两个本地提交一次推送不能代替两阶段。
3. B：以成功 A 为累计基线，四实体转永久 retired tombstone，仅应用计划声明的五处精确
   关系删除；删除失效 PR workflow/template 和入口。Accepted ADR 原文不变；仍被 ADR
   selector 引用的 pr-evidence.mjs 及真实回归保留，不再作为活动 CI 审批门禁。
4. B 本地验证、main 快进和同提交完整 CI 成功后，才进入正式发布。

计划、bootstrap 和决策摘要不可重写；非计划字段继续遵守原生命周期合同。失败则停止
发布并向前修复，不回写历史 ADR、tag 或整个 catalog。

## 远端设置与恢复材料

变更前保存仓库、规则集、workflow、分支及开放 PR 的完整分页快照，为待清理的精确非 main
SHA 建立可验证恢复载体。旧分支不自动合并；删除前核对当前 SHA 和关联 PR，保留 PR 历史。
旧 Dependabot YAML 活动时先暂停更新维护，再清理和切换规则。

在同一 active Branch ruleset 内使用 include=[~ALL]、exclude=[]、bypass_actors=[]，
仅保留 creation、deletion、non_fast_forward 三项规则；不加入 update restriction 或 bypass。
既有 main 可快进，新远端分支创建被阻止。结果不明先 GET，不盲目重复修改。

Dependabot 三类版本更新限额为零，security updates 关闭，alerts 开启；保留 dependency
graph、现有 secret scanning/push protection、Security audit 与 Weekly resilience。
关闭自动修复 PR 不代表漏洞解决，后续修复从本地走同一流程。
release Environment 唯一 required reviewer 仍为 xrevoman-hu，can_admins_bypass=false；
两个发布 phase 的人工审批不因 main-only 而取消。

## 工作流与只读验收

最终活动 workflow 精确为 CI、Release gate、Security audit、Weekly resilience；A 还保留
Trusted policy，B 拒绝它继续活动。仅另允许已登记的 GitHub 托管 Dependabot Updates
动态 workflow，并校验其实际功能设置。未知 workflow/state、额外规则集或 bypass 均失败。

checkout/setup-node 固定已审查的 Node 24-native 完整 commit SHA。普通 CI/Release/
Security/Weekly 显式声明 npm cache；baseline 不安装仓库依赖且 package-manager-cache=false。
阶段 A 的 Trusted workflow 同样禁用 package cache。Action pin、权限与新增入口需同步负向合同。

登录有权读取完整规则集和 Environment 的 GitHub CLI 后运行：

```bash
npm run github:governance:check
```

检查器只读并完整分页，核对真实 default branch、唯一规则集精确规则、无非 main 分支、
Dependabot 设置、阶段 workflow 清单和 release Environment。未知或权限不足不能算通过。
不以破坏性试强推、试删除 main 验收保护。

API 语义参考 [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)、
[规则集 REST](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28) 与
[workflow runs REST](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28)。
