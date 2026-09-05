# trust report

2026-09-06 使用 Yao trust 对隔离副本扫描：secret findings 为 0，附带 executable scripts 为 0，network/file-write scripts 为 0。
依赖/lock file 缺失的 warning 保留：本 Skill 包仅含说明和评测数据，不携带运行依赖。

security/permission_policy.json 的空 capabilities 表示没有包内脚本能力需要审批，不授权代理的 Git、网络、文件写入或发布调用。
实际操作受用户授权、仓库 Rule、宿主 sandbox 与 Environment 人工审批约束。OpenAI adapter 的权限信息为 metadata-only；missing evidence：客户端原生强制执行。
