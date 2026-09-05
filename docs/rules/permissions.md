# 权限预算 Rules

| 类型 | 当前允许范围 | 变更要求 |
|---|---|---|
| Tauri commands | `src-tauri/src/lib.rs` 注册清单 | 输入校验、负向测试、PR 声明 |
| 网络 host | `api.github.com`、`github.com`、ZIP 重定向 `codeload.github.com` | 仅经唯一 hardened `ReqwestGithubHttpAdapter`；只允许 HTTPS，固定连接 10 秒；普通 API 完整请求 30 秒、源码 ZIP 完整请求 120 秒；禁止跳过证书校验、代理或 DNS override；第二个 raw client/send site 直接失败；禁止 `std`/Tokio socket、其他 HTTP transport 与 `curl` 等网络 CLI 绕过；重定向 host/次数 fail-closed；用户价值、最小 host、CSP 更新 |
| 文件目录 | 数据库目录、备份根、Skill 主库、用户显式选择的导入/工具目标 | 特权操作用稳定 ID；显式 path 后端重验类型、范围并 canonicalize；生产 Rust 的 `std::fs`、`File`、`OpenOptions`、`DirBuilder::create`、`rusqlite::Connection::{open,open_with_flags}`、`libc` 文件原语和 `Command` path intent 必须逐调用点登记，新增点同时说明目录归属、失败回滚与用户价值；`DirBuilder` 只接受静态绑定的 `new → recursive(true) → create(path)`，`open_in_memory` 不访问目录、不占 path surface |
| Keychain | service 固定为 `Skill Repo Tracker`；account 仅 `github-token` 与 `github-account-token:github:<slug>` | 不落盘；只能经 `SystemKeychain` 的单一构造 seam，service、account 派生和字符集由 surface budget 精确校验 |
| macOS entitlement | `src-tauri/entitlements.plist` 的现有最小集合，按完整 canonical key/value 登记 | boolean、array、nested dict 任一值变化都视为权限面变化；新 ADR、人工安全审查 |
| Tauri capability/plugin | 有实际消费者的最小集合；主窗口只授予关闭保护实际需要的 `core:event:allow-listen`、`core:event:allow-unlisten` 与 `core:window:allow-destroy`。锁定的 `@tauri-apps/api` 在 `onCloseRequested` 未阻止时通过 `destroy()` 完成关闭，因此三项缺一即拒绝构建；`allow-destroy` 是窗口内部 IPC capability，不是新增 macOS entitlement 或系统权限。目录选择仅由 Rust dialog plugin 执行，不向 WebView 授予 dialog API；capability 只允许独立 tracked JSON，且只接受预算内的顶层字段；`app.security` 只接受预算内字段；asset protocol 默认关闭且 scope 为空；Tauri CSP 注入保持开启；唯一 Builder 链固定为 plugin → setup → invoke_handler → run → expect | 禁止 `core:default`、`dialog:default`、`tauri.conf.json` inline capability 和自动加载的 `src-tauri/permissions/**` 自定义 ACL；禁止 capability 的 `remote`、`local`、`webviews`、`platforms` 或未知字段；禁止未建模的 `devCsp`、`freezePrototype`、isolation `pattern`、response `headers`，以及自定义 URI scheme、初始化脚本、动态/第二 invoke handler、event IPC、boxed plugin、navigation hook 或额外 managed state；无消费者即删除，不保留“以后也许用” |
| Tauri build/bundle | 固定本地 Vite dev URL、仓库 `dist` 构建输出和 npm build/dev 入口；`app` 与唯一主窗口全部 key/value 采用 exact contract，窗口只加载 bundled frontend；macOS 固定 hardened runtime、tracked `entitlements.plist`、12.0 deployment floor，以及仓库内 icon 和 app/DMG targets | bundle、`bundle.macOS`、`app` 与 `app.windows` 采用 exact allowed-key/value 合同；禁止 `beforeBundleCommand`、`externalBin`、`resources`、`files`、`frameworks`、alternate `infoPlist`/entitlements、exception domain、签名/provider override、window remote URL、devtools/proxy/browser args/incognito/data directory 与 `withGlobalTauri`；确需新增必须先做 threat model、ADR 和负向 mutation 测试 |

前端生产模块禁止直接使用 `fetch`、XHR、EventSource、WebSocket 或 `sendBeacon`；网络只能经
`AppService` 和 Rust adapter；这些 API 的任意 receiver/property 形式同样禁止，不能经 iframe、
Window alias 或原型恢复。`@tauri-apps/api/core` 及 raw `invoke` 只允许出现在
`src/api.ts`，View 不得绕过受治理的 command wrapper。生产前端当前不允许
`localStorage`、`sessionStorage`、`indexedDB` 或 `Storage` API；需要持久化时必须先引入单一
adapter、稳定 key 预算和 ADR，不能以 global alias、computed property 或反射绕过。
`RTCPeerConnection`、`webkitRTCPeerConnection`、`WebTransport`、raw location/form navigation
和 programmatic form submit 同样属于网络旁路并默认禁止；CSP 固定 `form-action 'none'`。Web demo
只有 `src/externalNavigation.ts` 可调用一次 `window.open`：必须把输入解析为无 credentials、无显式
port 的 `https://github.com` URL，并固定 `_blank`、`noopener,noreferrer`。JSX `<a>` 只保留
`App.tsx` 的常量 `#source`，或 `PromptsView` 中同步 `preventDefault` 后交给已校验 external adapter
的 Markdown 链接；其他 raw `href` fail closed。`window.location.search` 只允许经两个 canonical
helper 读取已登记的静态 query key；前端 `import.meta.env`/`process.env` 默认禁止，Rust 环境变量、
平台临时目录与 compile-time env key 按实际调用点登记，新增 hidden runtime input 必须先更新预算。

生产 Rust 禁止 foreign ABI/`#[link]` 和 inline/global assembly，避免绕过已登记的文件、网络、
进程与系统调用表面积；确需引入必须先有 ADR、精确 selector、最小权限预算和负向测试。

CSS 产物禁止所有 `url()`、`image-set()`/`-webkit-image-set()`，含本地及 escaped 形式。
赋值目标识别穿透 TypeScript 类型包装，并覆盖 for-in/of 写入。含变量的 color-mix 增强必须
位于顶层正向 @supports 中，避免旧引擎的 computed-value invalidation 覆盖静态背景。
DOM 终端属性/方法约束与 receiver 无关；禁止直接 React JSX runtime、createFactory 和
Audio/Image/FontFace 构造器恢复。JSX spread 只允许绑定到精确冻结的 Settings 函数和 typed
props 合同；实现变动或同名影子绑定失去例外，禁止向 intrinsic element 继续转发。
JSX 的本地 import 必须解析到受治理 inventory 中直接导出的函数组件；缺源、动态值或
re-export 在建立解析合同前 fail closed。PluginsView 参数只在冻结实现中接受，调用方的
组件 props 必须绑定函数。CSSStyleDeclaration 的 cssText/setProperty 约束不依赖 receiver。
SVG 资源/SMIL 标签及 baseVal/animVal handle 默认禁用，防止动画值间接加载未登记资源。
SVG presentation 引用属性同样拒绝 CSS escape，避免转义 URL 绕过静态字符串检查。

禁止默认引入遥测、后台 daemon、额外系统权限或扩大自动清理范围。
Cargo production、build 与 dev direct dependencies 分域登记 identity、source、default-features 和
features；版本范围允许 Dependabot 正常升级，但新增 crate、切换 git/path/registry 或扩大 feature
必须形成新的 surface，并审查其网络、文件系统、进程、构建脚本和权限影响。当前 direct dependency
只接受一行 string/inline-table 声明，package `[features]` 与 dependency table form 在建立完整
feature graph/metadata 交叉校验前一律 fail-closed。
上述 settings、command、capability/window/permission、entitlement、CSP、外部 host、前台
recurring schedule、全部前端 timer/frame callback、Rust task/thread spawn、Keychain
service/account、frontend query 与 Rust environment input、Tauri
Builder/plugin/setup/event hook、文件系统 primitive 与外部 `Command` 调用点的实际清单由
`docs/engineering/surface-budget.json` 机器校验；新增实体必须登记用户价值，退出时先标记
retiring 和原因，再在后续 PR 删除记录。系统浏览器打开的用户 URL 不算应用自身网络 host，
但仍必须经过 URL scheme/intent 校验；当前唯一直接外部进程调用是结构固定的 macOS
`open -a <validated browser> <validated URL>`。
