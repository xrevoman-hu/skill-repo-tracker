# Yao 检查记录

日期：2026-09-06。owner：xrevoman-hu。当前状态：experimental，按 governed 风险要求审查；尚未取得 governed 就绪结论。

- 格式校验、Skill IR 导出、OpenAI 适配编译、conformance、ZIP 路径与包校验已运行通过。
- trigger_eval.py：每份 Skill 的 2 个正例、2 个反例、1 个近邻例均按预期分类。这是配置驱动的词法/概念冒烟，不是真实客户端路由准确率。
- Skill Atlas：三份 Skill 的路由冲突、owner 缺失、过期项均为 0；真实使用遥测为 0，不能据此声称无运行故障。
- 临时安装成功解压并读取入口、manifest、interface、overview、Review Studio 和 OpenAI adapter。
  Yao install-simulate 最终仍失败：其 permission-policy-load 使用 bool(capabilities)，将合法的空权限表判为不可读。
  本包无附带脚本；不得添加虚构权限、审批者或到期日来规避此失败。原始失败报告必须保留。
- runtime-permissions 通过适配元数据检查，native enforcement 为 0；不能声称客户端原生权限强制执行已通过。
- 初次版本 0.1.0 尚无已发布 Skill 包，真实 upgrade 对比不适用；未伪造上一版本包。drift 与 waiver 报告已生成，无使用遥测、无人工豁免。
- 官方 Review Studio 已生成，包含未满足的门禁；不得将页面成功生成等同于就绪检查通过。

## 剩余证据

missing evidence：每份 Skill 至少 5 个真实输出案例，包含 file-backed fixture、近邻与边界案例；修订稿重新执行；真实 token 遥测；客户端原生权限验证。

原始 12 份输出只覆盖只读诊断/计划，非产品修复、Safari 操作或实际发布执行。用户委托代理完成匿名裁定后确认进入 Yao，并非人工逐页盲审。当前仅保存实验性仓库助手，不提升为生产就绪认证。
