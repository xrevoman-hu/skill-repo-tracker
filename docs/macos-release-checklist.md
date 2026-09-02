# macOS Release Checklist

本清单是人工验收视图，不是第二套发布脚本。唯一可执行合同、local/remote phase 和 manifest
交接命令只维护在 [testing-release Rule](rules/testing-release.md)；这里不得复制命令。

## 1. 授权与来源

- 只有用户明确要求发布时才进入正式发布；普通 push 不发布。
- 发布必须来自受保护 PR 合入后的最终干净 `main`，tag 为 annotated tag。
- GitHub `release` Environment 必须人工批准；上传结果不明时先查询，禁止盲目重试。

## 2. 本地实物验收

- 使用 Rule 中唯一接口，不拆分、不替换步骤。
- 证明测试、coverage、MSRV、E2E、性能门以及版本/仓库/架构治理全部通过。
- 完整签名 App 后重新封装并签名 DMG；旧 DMG 不得复用。
- 证明只读挂载内 App 的签名、版本、arm64、bytes 与 SHA-256。
- manifest generation 目录只用于操作者交接，不是凭据或 Release 资产，不进入日志。

## 3. 远端实物验收

- 证明 `HEAD == origin/main == annotated tag commit == manifest.commit`。
- Release 必须 final，标题与 tracked `docs/releases/vX.Y.Z.md` 正文精确一致。
- 公开资产名、GitHub digest/size、下载后 bytes/SHA-256 与 manifest 一致。
- 下载后的 DMG 再做签名、`hdiutil verify`、只读挂载、版本与 arm64 检查。
- 只有 remote phase 通过，才可声称用户实际收到的线上文件已验证。

## 4. 分发边界与停止条件

当前只支持 Apple Silicon ad-hoc 测试包：不是 Developer ID signed，也未 notarized。Release notes
必须中英文说明首次打开需 Control-click Open 或 Privacy & Security -> Open Anyway。任一门禁、
签名、挂载、版本、架构、digest、远端 ref 或正文不一致都必须停止。若未来引入 Developer ID、
notarization 或新系统权限，须另立 ADR，不能把 ad-hoc lane 改名冒充。
