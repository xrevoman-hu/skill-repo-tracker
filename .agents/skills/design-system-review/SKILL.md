---
name: design-system-review
description: 审查 Skill Repo Tracker 的界面、design tokens、组件复用、主题、可访问性和 Safari 15 兼容性。Use for design-system reviews, UI consistency audits, keyboard/focus behavior and visual regression review in this repository, even when phrased as 看看界面是否一致. 不把审查请求扩成重设计或未经授权的实现。
---

# 设计系统审查

以用户完成任务的行为和仓库现有视觉语言为依据。默认只读；用户授权修复时再做最小编辑。
用简体中文报告，区分源代码推断、浏览器实测和 macOS 原生实测。

## 读取事实源

确认工作树、HEAD/base、diff 和审查范围，保留未提交工作。读取 `CONTRIBUTING.md`、
`SECURITY.md`、`docs/engineering/architecture.md`，通过 `npm run governance:context`
选择 owning Rule/ADR/Invariant；不要仅凭组件名字判断职责。

从当前 `src/styles.css`、`src/prompts.css`、`src/browserCompatibility.css` 读取 token、主题
覆盖与兼容 fallback，再追到实际组件、共享按钮属性、i18n、controller/AppService。
这是现有系统审查，不凭外部潮流引入新字体库、组件框架、主题设置或动画后台状态。

## 审查顺序

1. 看主要任务流：信息优先级、动作语义、空/加载/失败/成功状态、重试和取消。
2. 检查同类控件是否复用现有 token、间距、字重、边框、图标与状态表达。对不一致说明
   用户代价和最小修复；不要把主观风格偏好升为高优先级缺陷。
3. 检查键盘可达性、可见 focus、accessible name、disabled/pending 防重复行为、modal
   焦点进入/退出/恢复，以及错误信息是否仅依赖颜色。检查浅色/深色、长文本和窄窗口。
4. 对 CSS/资源遵守当前 browser contract：Safari 15 是下限，编译 target 不等于 polyfill。
   渐进 CSS 保留基础 fallback；不能引入 `:has()`、无回退 focus-visible、CSS URL/image-set
   或远端资源绕过 bundle inventory/CSP。不要弱化门禁来接受设计稿。
5. 动态复验只用 DemoAppService 合成数据。按真实运行环境报告结果，Chromium、jsdom 和
   静态扫描不能证明 Safari 15 或原生 WKWebView。缺少目标运行时就列明待验证项。

报告问题前追踪 selector/组件绑定和可达路径，避免只按搜索命中判 Bug。对比度要使用实际
前景/背景及透明叠加；没有计算或实测就不声称满足 WCAG。截图可支持视觉判断，不能证明
按钮点击、焦点恢复、取消或异步竞态正确。

## 修复与输出

如授权修复，使用 apply_patch，沿现有组件/port 边界改动，保留显式 props 与生产资源合同。
实际行为变化才补有意义的回归；执行 `npm run verify`，按范围补浏览器/目标平台验收，
不复制另一套综合验证脚本，不新增设置/权限/常驻开销来解决局部样式问题。

输出按影响排序的少量可行动 findings：P0–P2、路径/行号、触发状态、用户影响、证据层、
最小建议和验收动作。无可证实问题就写“未发现”，另列证据缺口；不要补凑问题数量。
总结实际审查范围、已验证状态和未验证平台，不把静态通过写成视觉或交互验收完成。
面向用户默认先用不超过200字说明是否通过、最重要的用户影响和下一步；源码细节及完整
状态矩阵放在报告后部或独立文件，不让技术细节淹没需要用户决定的事项。
