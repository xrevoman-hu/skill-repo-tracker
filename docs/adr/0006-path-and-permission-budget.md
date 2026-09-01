# ADR 0006：路径与权限预算

- 状态：Accepted
- 决策：打开、删除、覆盖等特权操作只接收稳定 ID 或有限意图，后端重新解析并
  canonicalize 实际路径。只有导入、目录选择等用户显式选定路径的流程可以传 path，且
  后端仍须重新校验类型、范围和访问边界。command、外部 host、目录、capability、
  entitlement 都列入权限预算，未使用项必须移除。
- 原因：让前端提交任意路径会把 UI 漏洞升级为本地文件系统能力。
- 后果：打开备份目录只能以 repository ID/备份根意图请求。新增网络 host、目录或系统
  权限必须在 PR 模板中声明、补负向测试并更新 `docs/rules/permissions.md`。
