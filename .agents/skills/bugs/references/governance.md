# 仓库适配与治理

owner: xrevoman-hu。review cadence: per-release；受保护路径变化时提前复审。
output contract: 简明中文裁定与可追溯证据，保留实际base/head及未验证项。
rollback boundary: 当前PR分支普通提交回退Skill，不覆盖用户工作或改写历史发布。

本包绑定Skill Repo Tracker仓库，安装目录不等于执行cwd。先在用户指定仓库定位
CONTRIBUTING.md、SECURITY.md、docs/engineering/architecture.md与owning Rules；
缺少仓库合同就报告缺口，不能把安装根目录当产品仓库或自行创建替代仓库。

参考取舍：skill-creator提供独立输出评测与盲比较；仓库architecture提供依赖及证据分层；
testing-release Rule提供唯一验收入口与发布边界。不复制第二套脚本，不引入通用自治发布。

初评有/无Skill各2例，均为只读代理输出；用户委托独立代理盲审后确认继续。
这不是用户逐页盲审。修订稿只修正操作顺序与报告密度，未宣称原初评已重新执行。
missing evidence: 目标客户端原生权限强制、完整token遥测、实际修复及发布执行评测。
历史评测输入是合成案例；若后续引入input_files须标注file-backed fixture，不能借此改写
产品published fixtures。trust report与reports/output_quality_scorecard.md分别保存供应链
和输出评测边界；通过结构门禁不等于这些缺失证据已补齐。
