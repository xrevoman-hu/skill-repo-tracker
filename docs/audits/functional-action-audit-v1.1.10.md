# Skill Repo Tracker 功能按钮闭环审计

日期：2026-07-08

本审计按“前端入口 -> API -> Rust 命令 -> 数据/文件副作用 -> UI 回读”检查当前桌面应用的主要可点击功能。结论分为：已实现、已修复、只改本地 UI、需确认的危险操作、环境依赖。

## 本次已修复

| 问题 | 原行为 | 修复后行为 |
| --- | --- | --- |
| Skill 更新后再次检测仍显示可更新 | 远端来源扫描没有内容 hash，已安装 GitHub Skill 在复检时会被重新标成 `update-available` | 扫描 ZIP 时计算 Skill 目录内容 hash；已安装 hash 相同显示 `installed-latest`，hash 不同才显示 `update-available`，`local-modified` 优先保留 |
| 任务页重试是假成功 | `retry_task` 只插入一条 `Retry task / success`，不重放原动作 | 任务保存 `retryable`、`retry_action`、`retry_payload`；重试只对白名单动作开放，并调用真实命令 |
| 旧任务仍能点重试 | 前端只按状态判断失败/部分成功/中断即可点 | 前端同时检查 `retryable`；旧任务或不可安全重试任务禁用并显示原因 |
| 浏览器预览环境伪造重试成功 | 非 Tauri 环境会添加一条成功任务 | 非 Tauri 环境不再伪造成功任务 |

## GitHub 页面

| 功能 | 前端入口 | 后端/副作用 | 审计结论 |
| --- | --- | --- | --- |
| 添加账号 | `saveGithubAccountToken` | 验证 token，写入系统 Keychain 和账号表 | 已实现；涉及凭据，实际 UI 操作需用户输入 |
| 刷新 GitHub | `refreshGithubRepositories` | 调 GitHub repos/starred API，缓存仓库、Star 时间和 README 搜索文本 | 已实现；网络/token 环境依赖 |
| 账号切换、筛选、排序、行选择 | React state | 无外部副作用 | 已实现 |
| Star / 取消 Star | `setGithubStar` | 调 GitHub starring API 并回写 catalog | 已实现；会修改 GitHub 远端状态，实际操控前需确认 |
| 追踪仓库 | `addRepositoryFromGithub` | 下载 ZIP、扫描 Skill/插件、写入 repositories/skills/plugins，可重试 | 已实现 |
| 取消追踪 | `removeRepository` | 删除本地 repositories 记录及级联本地识别数据 | 已实现；破坏性本地动作，实际操控前需确认 |
| 应用内预览 / 系统浏览器 / 指定浏览器 | `getGithubPreview` / `openUrl` | 读取 GitHub README 或打开 URL | 已实现；打开外部浏览器为环境依赖 |
| 复制仓库链接 | Clipboard | 复制当前仓库 URL | 已实现 |
| 验证账号 / 删除账号 | `validateGithubAccount` / `deleteGithubAccount` | 验证 token；删除 Keychain 凭据和账号缓存 | 已实现；删除账号实际操控前需确认 |
| 保存/清空备注 | `updateItemNote` | 写入 `user_notes` | 已实现 |

## 仓库页面

| 功能 | 前端入口 | 后端/副作用 | 审计结论 |
| --- | --- | --- | --- |
| 检测全部 / 自动检测 | `checkRepositories` | 获取远端 SHA、下载 ZIP、更新仓库/Skill/插件识别状态，可重试 | 已实现；本次修复 Skill 状态回弹 |
| 备份有更新 / 备份选中 / 单仓库备份 | `backupRepositories` | 下载源码 ZIP、写 manifest 和 task-log，更新备份状态，可重试 | 已实现；写本地备份目录 |
| 添加仓库 | `addRepository` | 下载 ZIP、扫描 Skill/插件、写入数据，可重试 | 已实现；网络环境依赖 |
| 添加本地仓库 | `addLocalRepository` | 扫描本地目录并写入本地仓库识别数据，可重试 | 已实现；依赖目录可读写 |
| 筛选、排序、批量选择、行点击 | React state | 无外部副作用 | 已实现 |
| 查看/刷新 README | `getRepositoryReadme` | 本地读取或 GitHub 读取 README | 已实现；GitHub README 依赖网络/token |
| 打开 Skill / 插件管理 | `setActiveTab` | 切换本地 UI | 已实现 |
| 打开备份目录 | `openBackupFolder` | 调系统打开目录 | 已实现；文件管理 UI 副作用较低 |
| 查看 GitHub / 选择浏览器 / 复制链接 | `openUrl` / Clipboard | 打开外部链接或复制 URL | 已实现 |
| 任务历史入口 | `setActiveTab("tasks")` | 切换本地 UI | 已实现 |
| 保存/清空备注 | `updateItemNote` | 写入 `user_notes` | 已实现 |

## Skill 页面

| 功能 | 前端入口 | 后端/副作用 | 审计结论 |
| --- | --- | --- | --- |
| 重新检测来源 | `checkRepositories` | 重新扫描远端来源，可重试 | 已实现；本次修复可更新误报 |
| 扫描本地 Skills | `scanLocalSkills` | 扫描 Skill 主库，可重试 | 已实现 |
| 添加本地仓库 / 添加仓库 | `addLocalRepository` / `addRepository` | 扫描本地或远端来源，可重试 | 已实现 |
| 名称搜索、内容搜索、来源仓库筛选、状态筛选、排序 | React state | 无外部副作用 | 已实现 |
| 安装 / 更新 | `installSkill` / `updateSkill` | 下载远端 Skill，替换主库目录，按同步目标发布副本，可重试 | 已修复；更新前仍保留本地改动保护 |
| 本地冲突处理 | `resolveSkillLocalConflict` | 跳过、备份后覆盖或强制覆盖 | 已实现；覆盖类实际操控前需确认 |
| 删除 / 恢复 Skill | `deleteSkill` / `restoreSkill` | 删除会先移到应用数据目录；恢复会移回安装路径 | 已实现；删除实际操控前需确认，不自动重试 |
| 来源跳转、关联插件跳转 | React state | 切换详情/页面 | 已实现 |
| 同步目标设置 | `updateSkillSyncTargets` | 更新 Skill 同步目标并同步文件，可重试 | 已实现；会改本地工具目录副本 |
| 保存/清空备注 | `updateItemNote` | 写入 `user_notes` | 已实现 |

## 插件页面

| 功能 | 前端入口 | 后端/副作用 | 审计结论 |
| --- | --- | --- | --- |
| 重新检测来源 | 顶部动作复用来源检测 | 更新插件识别结果 | 已实现；网络环境依赖 |
| 名称搜索、内容搜索、排序、行详情 | React state | 无外部副作用 | 已实现 |
| 详情 / 来源仓库 | `getPluginDetail` / 页面跳转 | 读取插件详情或切换仓库详情 | 已实现 |
| 复制安装命令 | Clipboard | 复制插件入口命令，不执行安装 | 已实现 |
| 跳转关联 Skill | React state | 打开 Skill 详情 | 已实现 |
| 保存/清空备注 | `updateItemNote` | 写入 `user_notes` | 已实现 |

## 任务页面

| 功能 | 前端入口 | 后端/副作用 | 审计结论 |
| --- | --- | --- | --- |
| 状态筛选、行展开 | React state | 无外部副作用 | 已实现 |
| 重试 | `retryTask` | 只对白名单任务调用真实后端命令 | 已修复；旧任务和危险任务禁用 |
| 复制摘要 | `copyTaskSummary` + Clipboard | 读取后端摘要并复制 | 已实现 |

## 设置页面

| 功能 | 前端入口 | 后端/副作用 | 审计结论 |
| --- | --- | --- | --- |
| 保存设置 | `updateSettings` / `configureSchedule` | 写本地 settings/schedules | 已实现 |
| 选择/校验目录 | `pickDirectory` / `validateDirectory` | 原生目录选择和可写性校验 | 已实现 |
| 应用同步设置到已安装 Skills | `syncInstalledSkills` | 对已安装 Skill 重新应用同步目标，可重试 | 已实现；会改本地工具目录副本 |
| 主题、语言、密度 | React state + settings | 本地配置 | 已实现 |
| 打开 GitHub 工作台 | React state | 切换页面 | 已实现 |
| 导出/导入迁移包 | `exportMigrationPackage` / `importMigrationPackage` | 读写非敏感迁移 JSON，不包含 token 或本地源码 | 已实现；文件选择需要用户操作 |
| 检查项目更新 / 打开项目 GitHub | GitHub releases API / `openUrl` | 读取 latest release 或打开浏览器 | 已实现；网络环境依赖 |

## 实际操控边界

- 已使用代码审计确认高优先级问题并修复；危险操作不在自动验证中点击。
- 后续实际 UI 验证只执行可逆动作：读取页面状态、更新一个可更新 Skill、重新检测来源、查看任务页禁用状态。
- 不自动执行删除 Skill、取消追踪、删除 GitHub 账号、Star/取消 Star、强制覆盖本地修改等动作。

## 本轮验证记录

- 已备份当前应用 SQLite 和 `yao-meta-skill` 目录到 `/private/tmp/skill-repo-tracker-functional-audit-20260708/`。
- Computer Use 读屏确认 `/Applications/Skill Repo Tracker.app` 仍是旧安装包实例；为避免误点旧代码，本轮未在旧包上执行更新或重试点击。
- 新代码行为已由源码构建和 Rust 回归测试验证；完整新包 UI 点击回归应在关闭旧实例并启动当前构建后执行。
