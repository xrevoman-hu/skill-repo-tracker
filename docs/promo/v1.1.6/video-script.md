# Skill Repo Tracker v1.1.6 Video Script

Format: 1080x1920 vertical short video, about 85-95 seconds.

Tone: calm, precise, useful. The video should feel like a local developer workbench that reduces anxiety, not a hype ad.

## Voiceover

AI Skills 越装越多以后，最先坏掉的不是文件夹。

是你心里的确定感。

这个 Skill 从哪来？现在是哪版？我是不是改过？README 里的插件安装命令，又会动到哪里？

Skill Repo Tracker v1.1.6，就是给这件事做的本地工作台。

它把仓库、Skill、插件安装入口、本地主库、发布目标和备份记录放在一起。

你可以先看来源，再决定要不要行动。

添加 GitHub 仓库后，它会识别 `SKILL.md`，显示路径、版本和安装状态。

新的插件页会收拢常见 marketplace、CLI 和单 Skill 安装入口，关联来源仓库和 Skill，并让你复制命令。

注意，它不是完整插件市场，也不会自动执行安装。

它做的是入口识别：先把“这条命令从哪来、关联什么”说清楚。

真正的 Skill 主库仍然只有一份：`~/SkillRepoTracker/skills`。

Claude Code、Codex 和其他工具目录，只是发布目标。

更新前，它会检查本地改动。

取消同步前，它只处理自己发布过的副本，并先做备份。

v1.1.6 还修正了扫描失败的误导：失败就是失败，不再保存成“0 Skills、0 Plugins”的假空白。

Skill Repo Tracker。

给 AI Skills 一个能看清来源、能备份、能回退的本地工作台。

## Scene Plan

1. Hook, 0-9s
   - Text: "装得越多，越怕看不清"
   - Visual: scattered Skill folders and plugin command chips drifting around a user.

2. Risk, 9-23s
   - Text: "来源 / 版本 / 路径 / 会动哪里"
   - Visual: command chips and Skill files enter an unmarked box; warning labels appear.

3. Product reveal, 23-38s
   - Text: "Skill Repo Tracker v1.1.6"
   - Visual: current v1.1.6 app screenshot, plugins tab highlighted.

4. Plugin entry index, 38-55s
   - Text: "识别入口，不自动安装"
   - Visual: README commands collected into a plugin index with source repository and linked Skills.

5. Local library model, 55-72s
   - Text: "一份主库，多处发布"
   - Visual: `~/SkillRepoTracker/skills` in the center; Claude Code and Codex as publish targets.

6. Safety and close, 72-92s
   - Text: "失败说失败，更新前备份"
   - Visual: failed scan state, backup record, final logo and GitHub URL.

## Captions

- AI Skills 越装越多
- 真正先坏掉的是确定感
- 来源、版本、路径、会动哪里
- Skill Repo Tracker v1.1.6
- 插件入口被收拢成索引
- 识别入口，不自动安装
- 一份主库，多处发布
- 更新前检查
- 删除前备份
- 失败就是失败
- 看清、备份、再行动
