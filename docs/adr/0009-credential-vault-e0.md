# ADR 0009：凭据库 E0 实验边界

- 状态：Accepted
- 决策：在现有 Cargo 测试根内登记隔离 E0 实验，通过 `npm run verify` 运行；
  不增加独立 Cargo 项目、可跳过验证入口或未登记的生产 bridge。
- SQLCipher 仅作为 `rusqlite` 的显式 dev dependency feature 进入测试构建，使用 vendored
  OpenSSL。Cargo 测试构建会合并此 feature，现有普通 SQLite 回归也在同一引擎下运行；
  生产 dependency 的 `bundled/chrono` 保持不变，不能宣称生产已切换或 E0 已全部通过。
- 实验只使用临时隔离库、虚构字段和当场生成的测试 SSH 文件，不启动 `AppState`，不读取
  用户应用数据、真实凭据或真实 SSH 目录。Keychain 实机实验只创建唯一测试命名空间的
  自有条目，读取、替换并清理该条目；拒绝访问时失败，不绕过系统确认或伪造成功。
- SSH 与本机 IPC 仅验证实际平台原语，不据此宣称完整租约、撤权或 MCP 客户端已实现。
  Windows、真实客户端、MSRV、版本安全审查和生产安装包必须另留证据。
- 后续生产实现必须追加独立加密库、认证、IPC、bridge/打包及文件生命周期的精确合同，
  按 module map 和 surface budget 登记；此 ADR 不放开现有普通 SQLite、GitHub token、
  TCP/UDP、任意路径和任意命令边界，也不允许从私有实验目录加载生产代码。
- 退出条件：实现方案定型后，保留仍能保护跨实现不变量的回归；实验依赖如需退休，按表面积
  生命周期处理，不直接删测试或把实验结果等同于客户端/跨平台验收。
