# ADR 0016：修复 SQLite 原生引擎与配套 Rust 依赖

- 状态：Accepted
- 日期：2026-11-14
- 继承 ADR 0010 的引擎、静态链接、同一 FFI provider、缓存完整性、隔离验证与凭据边界；仅替代其中的固定版本与源摘要，不改写历史决策。

## 原因

RUSTSEC-2026-0459 / CVE-2026-119375 影响 SQLite 3.54.0 之前版本：打开攻击者提供的数据库及不匹配页大小的 WAL 时可能读出未初始化内存。原 SQLCipher 4.19.0 实际链接 SQLite 3.53.4，因此不能只修改 Rust wrapper 或忽略审计告警。

## 决定

- 原生源固定为官方 SQLCipher 4.20.0，SQLite 3.54.1；归档为 `https://codeload.github.com/sqlcipher/sqlcipher/tar.gz/refs/tags/v4.20.0`，SHA-256 `38705f51b61ac0636a5fd064f9a77fafabc7227b2aa2513f1b14c8bb1102affc`。
- 继续使用 CommonCrypto 和项目内静态构建；生产与测试共用已核验的原生库，禁止回退系统 SQLite、pkg-config 或动态库。按新版本创建缓存，旧缓存不冒用新身份。
- 使用 rusqlite 0.41.1 及 libsqlite3-sys 0.39.1。0.41.1 修复 SQLCipher 特殊 PRAGMA 的兼容性；不启用 `extra_check`，保留现有先提供 key 再验证库的顺序。
- 显式启用 `fallible_uint`，保留原有 u64/usize 与 SQLite 有符号整数间的受检转换，不把既有数据库字段转为截断转换。
- MSRV 随 rusqlite 最低要求升至 1.89.0；日常工具链仍为 1.95.0，branch coverage 仍使用既有固定 nightly。CI、发布、共用原生入口及精确政策同步，不新增执行入口。
- 同时定点修复当前审计命中的 Tokio、Quinn、rustix 与前端测试依赖 undici，保留既有直接依赖范围；不新增漏洞豁免，不改风险账本来掩盖漏洞。

## 验证与边界

必须通过唯一确定性入口、覆盖率、独立 MSRV 及在线依赖审计，并验证加密文件不能被无 key 或错误 key 读取、正确 key 能重开、备份/恢复与锁定边界继续有效。版本声明不代替实际链接库的 cipher_version/sqlite_version 验证。

本变更不增加数据库 schema migration，不授权打开或迁移真实用户数据库；本机候选安装、原生 GUI、正式发布和跨平台验收仍分别取证。

## 依据

- [RustSec：SQLite/WAL 内存暴露](https://rustsec.org/advisories/RUSTSEC-2026-0459.html)
- [SQLCipher 4.20.0 官方发布](https://github.com/sqlcipher/sqlcipher/releases/tag/v4.20.0)
- [rusqlite 0.41.1 SQLCipher PRAGMA 修复](https://github.com/rusqlite/rusqlite/releases/tag/v0.41.1)
