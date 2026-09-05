# 输出质量证据

日期：2026-09-06。最终 SKILL.md SHA-256：144d04bd56c59a4aad09455aa7deff3c9ceae91a3d9d0cf36025710e91b05ace。

每份 Skill 的 canonical evals/evals.json 包含五例：两项原始场景与文件输入、近邻、边界各一例。
最终有/无 Skill 各执行五份真实代理回答；条件隔离、同条件复用上下文、每例一次，不宣称每例全新上下文。
三份最终对照各为有 Skill 一胜、基线一胜、三平；最终有 Skill 回答未发现实质错误，不外推统计显著提升。

初评的十二份输出与后续失败回答均另行保留。重跑发现两边都把 invalidate 错当释放 busy 通道；
bugs 增加 API 准入/失效/完成语义核对要求后，由新的代理重跑全部五例，独立匿名比较确认修正。
其余两份 Skill 没有同类指令改动。评测只验证只读诊断/计划，不是产品修复或实际发布执行。

Yao Output Lab 对最终回答做 recorded_fixture 词法回放：bugs 两组均 100%，design-system-review
有 Skill 100%、基线 90%，release 两组均 90%。词法路径/术语命中不能替代上述语义审查；
release 的 sha256 字面断言未命中，不改写成全绿，也不单凭字面评分判断来源链建议正确。

用户委托代理进行匿名裁定后确认进入 Yao；本轮使用官方 generate_review.py 生成十五组/三十份
输出 viewer。代理裁定不冒充人工逐页盲审。missing evidence：真实 token 遥测、客户端原生权限、
端到端产品执行、统计提升；不估算 token，不伪造人工审批或模型调用元数据。
