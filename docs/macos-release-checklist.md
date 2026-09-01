# macOS Release Checklist

当前唯一支持的发布产物是 Apple Silicon ad-hoc 测试分发包。它不是 Developer ID signed，
也不是 Apple notarized；首次启动可能需要 Control-click Open、Privacy & Security ->
Open Anyway 或 `xattr -cr`。本清单不引入 Developer ID、notarization 或新的系统权限。

## 0. 授权边界

- 只有用户明确要求“发布/发版/GitHub Release”才进入正式发布。
- 普通 push 不发布；GitHub `Release gate` 只允许 `workflow_dispatch`，且绑定
  `release` Environment 人工批准。
- 本地验证包不等于正式发布；不得顺手改版本、tag、push 或创建 Release。
- 上传结果不明时先查询远端，禁止盲目重试。

## 1. 本地实物门

在 Apple Silicon macOS 上运行唯一接口：

```bash
npm run release:verify -- --lane adhoc --version X.Y.Z --phase local
```

该命令不可拆分替代，固定执行：

1. `npm run verify` 的全部确定性门禁；
2. frontend/Rust coverage 与 Rust 1.88.0 MSRV lane，以及 Playwright E2E 浏览器验收；
3. 10,000 prompts / 100 MiB 性能门；
4. 构建 Apple Silicon `.app` 和 DMG；
5. 完整 ad-hoc 签名 `.app`；
6. 删除签名前的旧 DMG，并从已签名 App 重新封装；
7. 签名并校验最终 DMG；
8. `hdiutil verify`、只读挂载、挂载内 App 签名/版本/arm64 校验；
9. 输出 bytes、SHA-256、当前 commit 和承载这些操作者交接字段的单一、无签名
   `manifestToken`，并在 DMG 旁写入权限为 `0600` 的
   `Skill Repo Tracker_X.Y.Z_aarch64.release.json` 交接清单。token 只防止逐字段混用，
   不能证明 local gate 已执行或 token 的生成者身份。

“签名 loose App 后直接签旧 DMG”不是有效流程，因为旧 DMG 内仍是签名前的 App。

## 2. 发布动作

只有用户显式授权后，发布者才可执行以下动作：同步
`package.json`/`package-lock.json`/`Cargo.toml`/`Cargo.lock`/`tauri.conf.json` 的版本，
通过受保护 PR squash merge 进入 `main`，在本地以 fast-forward 同步该最终提交，创建并只推送
annotated `vX.Y.Z` tag，再用 `gh release create` 创建非 draft、非 prerelease Release。发布阶段
不得直接推送 `main`。本仓库中的 gate 只验证，不自动执行这些动作，也不会在未知上传结果下
重试。创建 tag 前必须确认本地 `HEAD == origin/main`；完成后必须由 remote phase 证明
`HEAD == origin/main == tag commit` 和线上资产 digest 一致。

Release notes 必须中英文说明 ad-hoc 边界与首次打开方法。公开资产名固定为
`Skill.Repo.Tracker_X.Y.Z_aarch64.dmg`；本地产物名保留空格形式。

## 3. 远端实物门

发布动作返回明确结果后，把操作者从 local phase 取得的单一 `manifestToken` 作为不可
省略的字段载体传给 remote phase；不要拆开复制 commit/SHA，以免混用不同构建。这个
未签名 token 本身不构成 local gate provenance：

```bash
npm run release:verify -- --lane adhoc --version X.Y.Z --phase remote --manifest-token <LOCAL_MANIFEST_TOKEN>
```

remote phase 从 token 还原并验证 manifest，再只读核对
`manifest.commit == HEAD == origin/main == tag commit`、Release 非 draft/non-prerelease、
资产名和 GitHub digest；随后下载 DMG，重新执行 `hdiutil verify`、只读挂载、签名、版本和
arm64 检查，并要求下载文件的 bytes/SHA-256、GitHub size/digest 与 manifest 完全一致。
只有 remote phase 也通过，才可以说“用户实际收到的线上文件已验证”。

## 4. 停止条件

任一门禁、性能、签名、重封装、挂载、版本、架构、digest 或远端 ref 不一致都必须停止。
若未来需要普通用户无警告分发，应另立 ADR、凭据管理和 notarization 流程，不能把
ad-hoc lane 改名冒充。
