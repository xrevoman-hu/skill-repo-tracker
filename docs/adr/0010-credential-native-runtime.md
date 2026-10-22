# ADR 0010：凭据库原生引擎与本机 MCP 的 E0 实现

- 状态：Accepted
- 本决策仅接受引擎选型与实现边界；客户端、安装包、Windows 与运行时验收需各自证据，不能由本状态推定通过。
- 加密引擎固定 SQLCipher 4.19.0 / SQLite 3.53.4，macOS 使用 CommonCrypto，静态链接；
  官方源归档 SHA-256 固定为 `7075f96cbabe45b4ecfc2e6b1745a625f856f695b0827a5506ce9ed85b906aa0`。
  构建入口校验源和产物，只使用项目 `src-tauri/target/credential-native/` 缓存，不使用 Homebrew
  动态库、不修改 Cargo 缓存、不增加 path/patch/workspace。测试和正常构建使用同一个 SQLite FFI provider。
- 唯一确定性入口仍为 `npm run verify`。它与正常 Tauri 构建、coverage、MSRV、性能和发布
  编排共用原生构建准备函数；直接 Cargo 缺少已验证原生环境时明确失败，不能退回普通 SQLite。
  `build.rs` 只校验固定构建产物并声明原生链接，不执行下载或任意外部脚本。
  所有 Cargo 入口强制关闭 SQLCipher pkg-config 探测，继承环境不能覆盖静态库路径和选择器；
  否则 libsqlite3-sys 即使看到 `SQLCIPHER_LIB_DIR`，仍可能先采用系统 sqlcipher.pc。
  clean clone 首次运行需系统 Xcode Command Line Tools，并下载经摘要固定的官方源；后续复用
  已验证的本机产物。工具链/SDK/编译参数改变时拒绝旧缓存，明确重建对应版本和 target。
- 保留原 lib/main/build 三个 Cargo target。现有 main 在创建 Tauri/AppState 之前分流
  `--credential-e0-host` 与 `--credential-bridge`；两者必须指定隔离 `--root` 与 `--vault-id`。
  E0 宿主只处理自有标记目录和虚构资料，不能引用用户现有应用数据库；普通 GUI 启动语义保持。
- MCP 使用有界 STDIO JSON-RPC 与本机 Unix socket；不新增 TCP、远程服务、后台 daemon
  或自动解锁。socket 目录 0700、文件 0600；确认同 UID 与对端可执行文件身份后才能交付认证材料。
  Darwin socket 路径长度有限，端点仅放在 `/private/tmp/srt-credential-e0-<uid>-<root+vault摘要>/`；
  锁文件与 socket 不含凭据，库和租约文件仍留在显式隔离根目录。只有持有单例锁才清理旧端点。
  只在集中 IPC 模块允许确切 Unix socket 与 peer 身份调用点，其他网络旁路继续拒绝。
- Agent 共用码与主密码分开；固定独立 Keychain service/account 派生，只有明确创建/重置
  操作可生成随机值。安全存储读取失败必须拒绝，不重建，不回显原文，不绕过系统确认。
  原 GitHub token 的既有 service/account 与单一 adapter seam 不变。
- 凭据、敏感元数据与原字节附件只进独立加密库。普通 SQLite、提示词导出与 `.srtmigration`
  继续不含凭据。锁定/撤权/重置使当前交付失效；秘密只能在已认证读取响应中返回，不进入诊断。
- 受管明文文件只写到自有 lease 目录，先登记后以排他创建和 no-follow 落盘；有限租约，退出、
  撤权和到期清理只针对登记条目。不能声称删除文件能追回已打开句柄或外部副本。
- 工程参数通过同一 Rust 合同约束，新增操作均有大小/时间/路径界限；原型 UI 和正式业务
  集成仍在 E0 之后。Windows 缺环境保留阻断，不用 macOS 原语实验冒充跨平台结果。
- 模块归属、依赖、运行输入、Keychain、路径、进程/线程和原生构建入口逐项登记；新增
  精确例外必须有拒绝扩大 namespace、任意路径、网络旁路和替代构建的负向测试。
