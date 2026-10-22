# macOS Release Checklist

本清单是人工验收视图，不是第二套发布脚本。唯一可执行合同、local/remote phase 和 manifest
交接命令只维护在 [testing-release Rule](rules/testing-release.md)；这里不得复制命令。

本清单准备 [v1.4.0](releases/v1.4.0.md)：应用版本 `1.4.0`，候选标识 `v1.4.0-rc.1`。
候选构建/tag 不代表正式发布；正式 `v1.4.0` 须在以下门禁通过后按既有合同生成。
当前公开下载仍为 [`Skill.Repo.Tracker_1.3.0_aarch64.dmg`](https://github.com/xrevoman-hu/skill-repo-tracker/releases/download/v1.3.0/Skill.Repo.Tracker_1.3.0_aarch64.dmg)，不预先创建 1.4.0 下载链接。
以下条目是验收要求，不代表已通过；每层结果以对应执行记录为准。

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

### 凭据功能专项

- 使用隔离的合成记录和文件验收创建、锁定、重开后手动解锁，以及新增、筛选、编辑、删除。
- 验证小眼睛、复制、导出和文件检查的主密码门槛；覆盖失焦、关闭详情、切记录、锁库及迟到响应。
- 原生文件框失焦后重新验证；取消不导出，陈旧票据不能越过记录版本或锁库边界。
- 核对钥匙串首次/跨签名授权、共享开关、访问码重置、撤权后拒读及受管文件清理失败提示。
- 各 Agent 分别记录实际版本、握手、四工具发现、指定字段读取、租约文件消费和释放结果；
  Codex CLI/桌面分别记录。不得用配置生成、SDK smoke 或历史 E0 结果替代当前候选实测。
- 核对上传/租约/导出的原字节与权限；PEM 解析/配对不替代真实 SSH 消费或证书部署验收。
- 覆盖备份、错误密码/损坏备份、取消、同库/不同库恢复和主密码修改；确认设备访问码不进备份。
- 浏览器演示仅证明界面行为；不得输入真实凭据或将其标成原生功能验收。
- Windows 保持 **BLOCKED**，单独列明恢复、权限和文件消费缺口。公开产物不附本机资料、
  客户端配置、凭据备份、真实账号、日志或未脱敏截图。

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
