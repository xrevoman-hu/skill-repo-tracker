---
name: release
description: 执行或审查 Skill Repo Tracker 的 macOS 发布、发布前验收、DMG 签名和 main/tag/manifest/公开资产证据链。Use for release readiness, local/remote release verification, artifact provenance and recovery from uncertain uploads. 只有准备发布的意图时先完成准备；正式发布与 Environment 人工审批按用户授权和仓库合同执行。
---

# macOS 发布证据链

本包的仓库适配、owner、review cadence、output contract、rollback boundary 与评测限制
见 [治理说明](references/governance.md)；`agents/`、`evals/`、`reports/` 分别保存接口、案例和证据。

用简体中文沟通。把准备、local 验收、公开发布和 remote 实物验收分别记录；任何一层
通过都不能代替后续层。本 Skill 不复制发布脚本，也不提供绕过 Environment 的捷径。

## 先核对当前合同

读取 `CONTRIBUTING.md`、`SECURITY.md`、`docs/engineering/architecture.md`、
`docs/rules/testing-release.md`、`docs/macos-release-checklist.md`、目标版本的
`docs/releases/vX.Y.Z.md` 与 `.github/workflows/release-gate.yml`。需要实现变化时先运行
治理上下文选择器，加载 owning Rule/ADR/Invariant。版本号、toolchain、required checks、
产物名与操作顺序以当前 tracked 文件和实时远端为准，不能从历史成功日志继承。

核对发布授权、目标版本、分支/HEAD、dirty 状态、远端 main、目标 tag/Release 是否已存在。
保留未提交工作；所有编辑用 apply_patch，不 reset/stash，不直接 push main、不 force-push，
不修改历史 tag/Release/fixture。仅要求预检或审查时不创建 tag、Release 或上传。

## 准备与 local phase

版本、README、Release notes、发布文档在独立 release 分支保持一致，经 PR required checks、
Security audit 与最终 head 治理审查后合入。正式来源必须是最终干净 main，确认远端没有
前进；已发布同版本或来源不一致时先停止并报告，不能移动旧 tag 解决。

按 Rule 的唯一 `release:verify` 接口执行 local phase，不手工挑子步骤代替它。Environment
要求的人工批准由用户完成，不能用工具自批或改 workflow 跳过；已经存在的授权不重复询问。
云端 local gate 与开发机 local phase 分别保存证据，正式交接来自最终 main 上开发机生成的
不可变 manifest generation。工具缺失或签名/挂载失败应报告具体阻断，不能宣称预检成功。

确认 App 完整签名后单独 staging 重封装并签名 DMG，hdiutil verify 与只读挂载内容、版本、
arm64、bytes/SHA-256 均通过。adhoc 分发不等于 Developer ID 或 notarization；保留中英文
首次打开披露。旧 DMG 不可复用为新版本证据。

## tag、公开资产与 remote phase

用核验过的 commit 创建新 annotated tag；按照用户授权和当前合同创建 final Release。
仅上传目标正式 DMG，不能上传 App、日志、源码、manifest generation、manifest.token 或真实
用户数据。token 是 unsigned artifact-field carrier，不是 local gate 执行证明；不打印内容。

上传结果不明时先只读查询 tag、Release、资产名/size/digest 和下载内容，判断是否已完成、
缺失或冲突；不盲目重传、覆盖或删除重建。冲突留证并报告，不自行重写历史。

按 Rule 执行 remote phase并完成其 Environment 人工批准。使用验证器的隔离非强制 tag ref
核对 annotated type/peel；不能相信 checkout 意外创建的本地 lightweight tag。确认 final
Release 标题、正文与 tracked notes 一致，公开 DMG 下载后的签名、挂载、版本、架构、bytes
与 SHA-256 均与 manifest 一致。

## 完成报告

给出版本、PR、各 lane 的实际 run、local/main/remote/tag peeled/manifest commit、唯一公开
DMG 的名称/bytes/SHA-256 与下载复验结果。最终证明本地 main = origin/main = tag peeled
commit = manifest.commit = 公开 DMG 构建来源。任何缺项写“待完成”并给下一步；不能只凭
Release 页面存在、同名文件或 unsigned token 声称发布已验证。
面向用户默认先用不超过200字说明可否继续、具体阻断和下一步；只有真实缺少的授权或
Environment人工批准才交用户处理。完整证据链放在报告后部或独立文件。
