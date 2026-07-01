# Skill Repo Tracker v1.1.6 Publishing Checklist

## Article

- Title: `我给 AI Skills 做了一个能看清来源的本地工作台：Skill Repo Tracker v1.1.6`
- Main promise: 看清来源、备份、再行动。
- Required boundary: 插件页识别常见安装入口，不执行安装，不保证第三方入口安全，不是完整插件市场。
- Images:
  - `article-assets/01-skill-maze-stickman.png`
  - `article-assets/02-software-workbench.png`
  - `article-assets/05-plugin-entry-index-stickman.png`
  - `article-assets/03-master-library-publishing-stickman.png`
  - `article-assets/04-safe-update-stickman.png`
  - `article-assets/06-system-calls-stickman.png`

## Screenshots

- Do not reuse v1.1.5 screenshots as v1.1.6 evidence.
- Required current screenshots:
  - Plugin list
  - Plugin detail
  - Repository detail with clickable plugin entry
  - Skill detail with clickable plugin entry
  - Plugin empty state: no entries
  - Plugin empty state: filtered out
  - Keyboard focus state
  - Dark mode readability

## Video

- Shared script: `video-script.md`
- HyperFrames output: `video/skill-repo-tracker-v1.1.6-hyperframes.mp4`
- Remotion output: `video-remotion/out/skill-repo-tracker-v1.1.6-remotion.mp4`
- Comparison notes: `video-comparison.md`
- HyperFrames validation: `lint`, `inspect`, `render`
- Remotion validation: still frame layout check, then `render`

## Release Language

- Say: recognizes common plugin install entries and links them to repository/Skill sources.
- Do not say: complete marketplace, one-click install, guaranteed safety, automatic dependency understanding.
- Mention: local validation DMG is not notarized; public DMG release requires Developer ID signing and Apple notarization.
