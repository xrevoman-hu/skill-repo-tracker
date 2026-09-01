# 权限预算 Rules

| 类型 | 当前允许范围 | 变更要求 |
|---|---|---|
| Tauri commands | `src-tauri/src/lib.rs` 注册清单 | 输入校验、负向测试、PR 声明 |
| 网络 host | `api.github.com`、`github.com`、ZIP 重定向 `codeload.github.com` | 仅经 `GithubHttpAdapter`；重定向 host fail-closed；连接 10 秒；普通 API 完整请求 30 秒、源码 ZIP 完整请求 120 秒；用户价值、最小 host、CSP 更新 |
| 文件目录 | 数据库目录、备份根、Skill 主库、用户显式选择的导入/工具目标 | 特权操作用稳定 ID；显式 path 后端重验类型、范围并 canonicalize |
| Keychain | GitHub token service/account | 不落盘；通过 adapter 测试 |
| macOS entitlement | `src-tauri/entitlements.plist` 的现有最小集合 | 新 ADR、人工安全审查 |
| Tauri capability/plugin | 有实际消费者的最小集合 | 无消费者即删除，不保留“以后也许用” |

前端生产模块禁止直接使用 `fetch`、XHR、EventSource、WebSocket 或 `sendBeacon`；网络只能经
`AppService` 和 Rust adapter。`@tauri-apps/api/core` 及 raw `invoke` 只允许出现在
`src/api.ts`，View 不得绕过受治理的 command wrapper。

禁止默认引入遥测、后台 daemon、额外系统权限或扩大自动清理范围。
