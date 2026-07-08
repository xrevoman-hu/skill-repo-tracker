import { useEffect, useMemo, useRef, useState } from "react";
import { api, isDesktopRuntime } from "./api";
import type { GitHubAccount, GitHubRepository } from "./api";
import { GitHubWorkbench } from "./GitHubWorkbench";
import { shouldIgnoreInspectorDismiss } from "./inspectorDismiss";
import { PluginInspector, PluginsView } from "./PluginsView";

const initialRepos = [
  {
    id: "content",
    name: "example-org/content-skill-kit",
    type: "skill repo",
    ref: "main",
    skills: 3,
    remoteSha: "a1b2c3d",
    lastBackupSha: "7f8e9ab",
    lastChecked: "Jun 14 09:32",
    backupStatus: "updated-not-backed-up",
    checkStatus: "success",
    url: "https://github.com/example-org/content-skill-kit",
    branch: "main",
    backupPath: "~/SkillRepoBackups/example-org/content-skill-kit",
    snapshotTime: "2026-06-12 18:03",
    recognizedSkills: [
      { name: "content-skill-core", version: "v1.2.0" },
      { name: "content-skill-plugins", version: "v1.1.1" },
      { name: "content-skill-utils", version: "v0.9.3" },
    ],
    recognizedPlugins: [
      {
        id: "plugin-content-marketplace",
        name: "content-skill-kit",
        kind: "codex-marketplace",
        installCommand: "/plugin install content-skill-kit@content-skill-kit",
        skillCount: 1,
      },
      {
        id: "plugin-content-clawhub",
        name: "content-skill-core",
        kind: "clawhub-skill",
        installCommand: "clawhub install content-skill-core",
        skillCount: 1,
      },
    ],
  },
  {
    id: "cookbook",
    name: "openai/openai-cookbook",
    type: "generic repo",
    ref: "main",
    skills: 0,
    remoteSha: "e4f5g6h",
    lastBackupSha: "e4f5g6h",
    lastChecked: "Jun 14 09:31",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/openai/openai-cookbook",
    branch: "main",
    backupPath: "~/SkillRepoBackups/openai/openai-cookbook",
    snapshotTime: "2026-06-14 09:05",
    recognizedSkills: [],
  },
  {
    id: "missing",
    name: "example-org/missing-skill",
    type: "unknown",
    ref: "main",
    skills: 0,
    remoteSha: "unknown",
    lastBackupSha: "none",
    lastChecked: "Jun 14 09:30",
    backupStatus: "check-failed",
    checkStatus: "failed",
    url: "https://github.com/example-org/missing-skill",
    branch: "main",
    backupPath: "Unavailable",
    snapshotTime: "Never",
    recognizedSkills: [],
  },
  {
    id: "langchain",
    name: "langchain-ai/langchain",
    type: "skill repo",
    ref: "main",
    skills: 5,
    remoteSha: "5aa7bb1",
    lastBackupSha: "1122abc",
    lastChecked: "Jun 14 09:28",
    backupStatus: "updated-not-backed-up",
    checkStatus: "success",
    url: "https://github.com/langchain-ai/langchain",
    branch: "main",
    backupPath: "~/SkillRepoBackups/langchain-ai/langchain",
    snapshotTime: "2026-06-10 12:22",
    recognizedSkills: [
      { name: "prompt-tooling", version: "v0.8.2" },
      { name: "agent-recipes", version: "v0.4.0" },
    ],
  },
  {
    id: "vscode",
    name: "microsoft/vscode",
    type: "generic repo",
    ref: "main",
    skills: 0,
    remoteSha: "0f1e2d3",
    lastBackupSha: "0f1e2d3",
    lastChecked: "Jun 14 09:27",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/microsoft/vscode",
    branch: "main",
    backupPath: "~/SkillRepoBackups/microsoft/vscode",
    snapshotTime: "2026-06-14 08:11",
    recognizedSkills: [],
  },
  {
    id: "spec",
    name: "example-org/spec-writer-skill",
    type: "skill repo",
    ref: "main",
    skills: 1,
    remoteSha: "08ff12a",
    lastBackupSha: "none",
    lastChecked: "Jun 14 09:24",
    backupStatus: "never-backed-up",
    checkStatus: "success",
    url: "https://github.com/example-org/spec-writer-skill",
    branch: "main",
    backupPath: "~/SkillRepoBackups/example-org/spec-writer-skill",
    snapshotTime: "Never",
    recognizedSkills: [{ name: "spec-writer-skill", version: "v0.2.1" }],
  },
  {
    id: "linux",
    name: "torvalds/linux",
    type: "generic repo",
    ref: "master",
    skills: 0,
    remoteSha: "9abc8de",
    lastBackupSha: "9abc8de",
    lastChecked: "Jun 14 09:21",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/torvalds/linux",
    branch: "master",
    backupPath: "~/SkillRepoBackups/torvalds/linux",
    snapshotTime: "2026-06-14 07:30",
    recognizedSkills: [],
  },
  {
    id: "anthropic",
    name: "example-org/research-cookbook",
    type: "generic repo",
    ref: "main",
    skills: 0,
    remoteSha: "c0ffee1",
    lastBackupSha: "c0ffee1",
    lastChecked: "Jun 14 09:20",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/example-org/research-cookbook",
    branch: "main",
    backupPath: "~/SkillRepoBackups/example-org/research-cookbook",
    snapshotTime: "2026-06-13 16:44",
    recognizedSkills: [],
  },
  {
    id: "flask",
    name: "pallets/flask",
    type: "skill repo",
    ref: "main",
    skills: 1,
    remoteSha: "12ab34c",
    lastBackupSha: "0a9b111",
    lastChecked: "Jun 14 09:19",
    backupStatus: "updated-not-backed-up",
    checkStatus: "success",
    url: "https://github.com/pallets/flask",
    branch: "main",
    backupPath: "~/SkillRepoBackups/pallets/flask",
    snapshotTime: "2026-06-09 12:30",
    recognizedSkills: [{ name: "flask-helper", version: "v0.3.1" }],
  },
  {
    id: "fastapi",
    name: "fastapi/fastapi",
    type: "skill repo",
    ref: "main",
    skills: 2,
    remoteSha: "89de012",
    lastBackupSha: "89de012",
    lastChecked: "Jun 14 09:18",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/fastapi/fastapi",
    branch: "main",
    backupPath: "~/SkillRepoBackups/fastapi/fastapi",
    snapshotTime: "2026-06-14 06:18",
    recognizedSkills: [
      { name: "api-docs-skill", version: "v1.0.0" },
      { name: "routing-helper", version: "v0.4.5" },
    ],
  },
  {
    id: "requests",
    name: "psf/requests",
    type: "generic repo",
    ref: "main",
    skills: 0,
    remoteSha: "345f678",
    lastBackupSha: "345f678",
    lastChecked: "Jun 14 09:17",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/psf/requests",
    branch: "main",
    backupPath: "~/SkillRepoBackups/psf/requests",
    snapshotTime: "2026-06-13 19:10",
    recognizedSkills: [],
  },
  {
    id: "django",
    name: "example-org/cache-maintenance-skill",
    type: "skill repo",
    ref: "main",
    skills: 1,
    remoteSha: "6b7c8d9",
    lastBackupSha: "2255aee",
    lastChecked: "Jun 14 09:16",
    backupStatus: "updated-not-backed-up",
    checkStatus: "success",
    url: "https://github.com/example-org/cache-maintenance-skill",
    branch: "main",
    backupPath: "~/SkillRepoBackups/example-org/cache-maintenance-skill",
    snapshotTime: "2026-06-11 10:42",
    recognizedSkills: [{ name: "redis-maintenance", version: "v0.1.8" }],
  },
  {
    id: "postgresql",
    name: "example-org/api-stack-skills",
    type: "skill repo",
    ref: "main",
    skills: 4,
    remoteSha: "abcd123",
    lastBackupSha: "abcd123",
    lastChecked: "Jun 14 09:15",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/example-org/api-stack-skills",
    branch: "main",
    backupPath: "~/SkillRepoBackups/example-org/api-stack-skills",
    snapshotTime: "2026-06-14 03:11",
    recognizedSkills: [{ name: "postgres-stack", version: "v0.7.2" }],
  },
  {
    id: "hello",
    name: "octocat/Hello-World",
    type: "generic repo",
    ref: "master",
    skills: 0,
    remoteSha: "1a2b3c4",
    lastBackupSha: "1a2b3c4",
    lastChecked: "Jun 14 09:14",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/octocat/Hello-World",
    branch: "master",
    backupPath: "~/SkillRepoBackups/octocat/Hello-World",
    snapshotTime: "2026-06-10 21:00",
    recognizedSkills: [],
  },
  {
    id: "awesome",
    name: "sindresorhus/awesome",
    type: "generic repo",
    ref: "main",
    skills: 0,
    remoteSha: "7f8e9ab",
    lastBackupSha: "7f8e9ab",
    lastChecked: "Jun 14 09:13",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/sindresorhus/awesome",
    branch: "main",
    backupPath: "~/SkillRepoBackups/sindresorhus/awesome",
    snapshotTime: "2026-06-13 14:02",
    recognizedSkills: [],
  },
  {
    id: "local-example",
    name: "example-org/local-skill-playground",
    type: "skill repo",
    ref: "main",
    skills: 2,
    remoteSha: "deaf999",
    lastBackupSha: "001abba",
    lastChecked: "Jun 14 09:12",
    backupStatus: "updated-not-backed-up",
    checkStatus: "success",
    url: "https://github.com/example-org/local-skill-playground",
    branch: "main",
    backupPath: "~/SkillRepoBackups/example-org/local-skill-playground",
    snapshotTime: "2026-06-07 11:58",
    recognizedSkills: [{ name: "example-skill", version: "v0.1.0" }],
  },
  {
    id: "archived-example",
    name: "example-org/archived-skill-repo",
    type: "unknown",
    ref: "main",
    skills: 0,
    remoteSha: "unknown",
    lastBackupSha: "none",
    lastChecked: "Jun 14 09:11",
    backupStatus: "check-failed",
    checkStatus: "failed",
    url: "https://github.com/example-org/archived-skill-repo",
    branch: "main",
    backupPath: "Unavailable",
    snapshotTime: "Never",
    recognizedSkills: [],
  },
  {
    id: "ml-notes",
    name: "example-org/ml-notes-skill",
    type: "skill repo",
    ref: "main",
    skills: 3,
    remoteSha: "b16b00b",
    lastBackupSha: "b16b00b",
    lastChecked: "Jun 14 09:10",
    backupStatus: "backed-up-latest",
    checkStatus: "success",
    url: "https://github.com/example-org/ml-notes-skill",
    branch: "main",
    backupPath: "~/SkillRepoBackups/example-org/ml-notes-skill",
    snapshotTime: "2026-06-14 05:46",
    recognizedSkills: [{ name: "ml-notes-reader", version: "v2.0.0" }],
  },
];

const initialSkills = [
  {
    id: "prd",
    repoId: "spec",
    name: "spec-writer-skill",
    description: "Generate AI-implementable product specification documents.",
    repo: "example-org/spec-writer-skill",
    path: "skills/spec-writer-skill",
    ref: "main",
    localVersion: "08aa901",
    remoteVersion: "08ff12a",
    status: "local-modified",
    installed: true,
    updatedAt: "2026-06-10 18:20",
  },
  {
    id: "source",
    repoId: "source",
    name: "source-reviewer-skill",
    description: "Review source credibility and evidence quality.",
    repo: "example-org/source-reviewer-skill",
    path: ".",
    ref: "main",
    localVersion: "61cc2bd",
    remoteVersion: "61cc2bd",
    status: "installed-latest",
    installed: true,
    updatedAt: "2026-06-14 08:21",
  },
  {
    id: "content-core",
    repoId: "content",
    name: "content-skill-core",
    description: "Core content studio workflow Skill.",
    repo: "example-org/content-skill-kit",
    path: "skills/content-skill-core",
    ref: "main",
    localVersion: "7f8e9ab",
    remoteVersion: "a1b2c3d",
    status: "update-available",
    installed: true,
    updatedAt: "2026-06-12 09:00",
    plugins: [
      {
        id: "plugin-content-marketplace",
        name: "content-skill-kit",
        kind: "codex-marketplace",
        installCommand: "/plugin install content-skill-kit@content-skill-kit",
      },
      {
        id: "plugin-content-clawhub",
        name: "content-skill-core",
        kind: "clawhub-skill",
        installCommand: "clawhub install content-skill-core",
      },
    ],
  },
  {
    id: "scene",
    repoId: "scene",
    name: "scene-director-skill",
    description: "Stage scene design prompts and direction notes.",
    repo: "example-org/scene-director-skill",
    path: ".",
    ref: "main",
    localVersion: "not installed",
    remoteVersion: "e4f9912",
    status: "not-installed",
    installed: false,
    updatedAt: "Never",
  },
  {
    id: "broken",
    repoId: "missing",
    name: "missing-skill",
    description: "Source repository cannot be reached.",
    repo: "example-org/missing-skill",
    path: "skills/missing",
    ref: "main",
    localVersion: "2bba019",
    remoteVersion: "unknown",
    status: "source-unavailable",
    installed: true,
    updatedAt: "2026-06-01 11:34",
  },
];

const initialPlugins = [
  {
    id: "plugin-content-marketplace",
    repoId: "content",
    repoName: "example-org/content-skill-kit",
    name: "content-skill-kit",
    description: "Codex plugin marketplace entry for the content skill kit.",
    kind: "codex-marketplace",
    installCommand: "/plugin install content-skill-kit@content-skill-kit",
    updateCommand: null,
    sourcePath: "README.md",
    sourceExcerpt: "/plugin marketplace add example-org/content-skill-kit\n/plugin install content-skill-kit@content-skill-kit",
    status: "detected",
    skillCount: 1,
    detectedSha: "a1b2c3d",
    createdAt: "2026-06-14 10:18",
    updatedAt: "2026-06-14 10:18",
    linkedSkills: [
      {
        id: "content-core",
        name: "content-skill-core",
        path: "skills/content-skill-core",
        version: "a1b2c3d",
        status: "update-available",
      },
    ],
  },
  {
    id: "plugin-content-clawhub",
    repoId: "content",
    repoName: "example-org/content-skill-kit",
    name: "content-skill-core",
    description: "ClawHub single-Skill install entry.",
    kind: "clawhub-skill",
    installCommand: "clawhub install content-skill-core",
    updateCommand: null,
    sourcePath: "README.md",
    sourceExcerpt: "clawhub install content-skill-core",
    status: "detected",
    skillCount: 1,
    detectedSha: "a1b2c3d",
    createdAt: "2026-06-14 10:18",
    updatedAt: "2026-06-14 10:18",
    linkedSkills: [
      {
        id: "content-core",
        name: "content-skill-core",
        path: "skills/content-skill-core",
        version: "a1b2c3d",
        status: "update-available",
      },
    ],
  },
];

const initialTasks = [
  {
    id: "backup-213012",
    kind: "Backup repositories",
    target: "Updated repositories",
    progress: "7 / 12",
    status: "partial-success",
    summary: "7 success, 1 failed, 4 queued",
    log: [
      "refresh remote state for 17 repositories",
      "skip example-org/missing-skill because check failed",
      "download example-org__content-skill-kit__main__a1b2c3d.zip",
      "compute sha256: 19a6...4de1",
      "write manifest.json",
      "update last_backup_sha for successful items",
    ],
  },
  {
    id: "check-0932",
    kind: "Check remote state",
    target: "All repositories",
    progress: "17 / 17",
    status: "success",
    summary: "15 success, 2 failed",
    log: [
      "resolve default refs",
      "record remote_head_sha for public repositories",
      "keep previous SHA for failed repositories",
    ],
  },
  {
    id: "skill-0831",
    kind: "Update Skill",
    target: "spec-writer-skill",
    progress: "0 / 1",
    status: "failed",
    summary: "blocked by local modifications",
    log: [
      "calculate installed_skill_hash",
      "local content differs from installation record",
      "waiting for user choice: skip, backup overwrite, force overwrite",
    ],
  },
  {
    id: "interrupted",
    kind: "Backup repositories",
    target: "Previous session",
    progress: "4 / 9",
    status: "interrupted",
    summary: "app closed during ZIP download",
    log: ["task interrupted before manifest write", "last_backup_sha not updated"],
  },
];

const initialGithubAccounts: GitHubAccount[] = [
  {
    id: "github:demo",
    login: "demo-user",
    displayName: "Demo user",
    avatarUrl: null,
    status: "verified",
    scopes: "repo, user, starring",
    lastVerified: "2026-06-30 10:00",
  },
];

const initialGithubRepositories: GitHubRepository[] = [
  {
    accountId: "github:demo",
    accountLogin: "demo-user",
    owner: "example-org",
    repo: "private-skill-kit",
    fullName: "example-org/private-skill-kit",
    htmlUrl: "https://github.com/example-org/private-skill-kit",
    description: "Private Skill source repository with installable workflows.",
    visibility: "private",
    private: true,
    fork: false,
    archived: false,
    defaultBranch: "main",
    language: "TypeScript",
    stargazersCount: 12,
    starred: true,
    trackedRepoId: null,
    pushedAt: "2026-06-29 18:00",
    updatedAt: "2026-06-29 18:00",
    lastRefreshed: "2026-06-30 10:00",
    permissions: "pull, push",
    note: "",
  },
  {
    accountId: "github:demo",
    accountLogin: "demo-user",
    owner: "openai",
    repo: "openai-cookbook",
    fullName: "openai/openai-cookbook",
    htmlUrl: "https://github.com/openai/openai-cookbook",
    description: "Examples and guides for building with OpenAI.",
    visibility: "public",
    private: false,
    fork: false,
    archived: false,
    defaultBranch: "main",
    language: "MDX",
    stargazersCount: 72000,
    starred: true,
    trackedRepoId: "cookbook",
    pushedAt: "2026-06-28 11:00",
    updatedAt: "2026-06-28 11:00",
    lastRefreshed: "2026-06-30 10:00",
    permissions: "pull",
    note: "",
  },
];

const navItems = [
  { id: "github", labelKey: "nav.github" },
  { id: "repositories", labelKey: "nav.repositories" },
  { id: "skills", labelKey: "nav.skills" },
  { id: "plugins", labelKey: "nav.plugins" },
  { id: "tasks", labelKey: "nav.tasks" },
  { id: "settings", labelKey: "nav.settings" },
];

const APP_METADATA = {
  name: "Skill Repo Tracker",
  version: "1.1.8",
  projectGithubUrl: "https://github.com/xrevoman-hu/skill-repo-tracker",
  openSource: true,
};

const COPY = {
  zh: {
    "nav.repositories": "仓库",
    "nav.github": "GitHub",
    "nav.skills": "技能",
    "nav.plugins": "插件",
    "nav.tasks": "任务",
    "nav.settings": "设置",
    localCare: "本地仓库管理",
    summary: "概览",
    totalRepositories: "仓库总数",
    skillRepositories: "技能仓库",
    genericRepositories: "普通仓库",
    unknownType: "未知类型",
    backupStatus: "备份状态",
    backedLatest: "已备份最新",
    updatedNotBacked: "有更新未备份",
    checkFailed: "检测失败",
    unknown: "未知",
    checkAll: "检测全部",
    backupUpdated: "备份有更新",
    backupSelected: "备份选中",
    addRepository: "添加仓库",
    settings: "设置",
    needBackup: "需要备份",
    search: "搜索",
    searchRepositories: "搜索仓库、备注、README...",
    searchSkills: "搜索 Skill、备注、README...",
    searchPlugins: "搜索插件、备注、README...",
    sourceRepositoryFilter: "来源仓库",
    allRepositories: "全部仓库",
    searchRepository: "搜索仓库",
    taskStarted: "任务已开始，可在任务页查看进度。",
    scanning: "扫描中…",
    checking: "检测中…",
    backingUp: "备份中…",
    adding: "添加中…",
    installing: "安装中…",
    updating: "更新中…",
    deleting: "删除中…",
    restoring: "恢复中…",
    retrying: "重试中…",
    saving: "保存中…",
    validating: "验证中…",
    clearing: "清除中…",
    repositoriesTitle: "仓库",
    repositoriesSubtitle: "分别追踪远端 SHA、备份状态和 Skill 识别结果。",
    all: "全部",
    skillRepos: "技能仓库",
    generic: "普通仓库",
    updated: "有更新",
    neverBacked: "从未备份",
    repository: "仓库",
    type: "类型",
    ref: "Ref",
    skills: "技能",
    remoteSha: "远端 SHA",
    lastChecked: "最后检测",
    addedAt: "添加时间",
    createdAt: "添加时间",
    starredAt: "Star 时间",
    checkStatusLabel: "检测状态",
    lastBackup: "最后备份",
    actions: "操作",
    backup: "备份",
    more: "详情",
    close: "关闭",
    source: "来源",
    sourceUrl: "来源 URL",
    defaultBranch: "默认分支",
    remoteRevision: "远端版本",
    backupSnapshot: "备份快照",
    lastBackupSha: "最后备份 SHA",
    backupPath: "备份路径",
    snapshotTime: "快照时间",
    backupAudit: "备份审计",
    latestManifest: "最近 manifest 摘要",
    noManifest: "尚无 manifest 记录。完成一次备份后会显示 ZIP、sha256 和 manifest 路径。",
    zipPath: "ZIP 路径",
    sha256: "sha256",
    manifestPath: "manifest 路径",
    backupHistory: "查看备份历史",
    recognizedSkills: "已识别技能",
    recognizedPlugins: "已识别插件",
    noPluginsFound: "未发现插件安装入口。",
    openPluginsManager: "在插件视图中打开",
    noSkillsFound: "未发现 Skill。该仓库仍可作为普通仓库备份。",
    openSkillsManager: "在技能管理器中打开",
    quickActions: "快捷操作",
    backupNow: "立即备份",
    openBackupFolder: "打开备份目录",
    viewGithub: "查看 GitHub",
    chooseBrowser: "选择浏览器",
    copyLink: "复制链接",
    openGithub: "打开 GitHub",
    previewInApp: "应用内预览",
    systemBrowser: "系统浏览器",
    openUrlFailed: "无法打开链接。",
    urlCopied: "链接已复制。",
    installCommandCopied: "安装入口命令已复制。",
    copyUnavailable: "当前环境无法复制到剪贴板。",
    githubPreviewTitle: "GitHub 预览",
    githubPreviewSubtitle: "应用内预览仓库信息和 README；完整页面可用系统浏览器打开。",
    githubPreviewLoading: "正在读取 GitHub 仓库信息...",
    githubPreviewFailed: "GitHub 预览加载失败。",
    githubPreviewReadmeMissing: "未读取到 README，可以改用系统浏览器查看完整仓库。",
    retryOpen: "重试",
    viewReadme: "查看 README",
    refreshReadme: "刷新 README",
    readmeUnavailable: "README 暂不可用。",
    loading: "加载中...",
    version: "版本",
    skillOverview: "技能概览",
    description: "介绍",
    noDescription: "暂无介绍。",
    noSkillMarkdown: "未找到 SKILL.md 内容。",
    skillDetailUnavailable: "Skill 详情暂不可用。",
    pluginDetailUnavailable: "插件详情暂不可用。",
    extractSkills: "提取技能",
    recheckRepository: "重新检测仓库",
    manifestPreview: "Manifest 摘要",
    skillsTitle: "技能",
    skillsSubtitle: "安装和更新已识别 Skill，不会触发仓库备份。",
    pluginsTitle: "插件",
    pluginsSubtitle: "查看仓库暴露的 marketplace、CLI 和单 Skill 安装入口；这里负责识别入口，不执行安装。",
    pluginInstallEntryHint: "这是安装入口识别记录，不代表已执行安装或安全审计通过。",
    plugin: "插件",
    plugins: "插件",
    pluginKind: "插件类型",
    installCommand: "安装命令",
    updateCommand: "更新命令",
    sourceExcerpt: "来源片段",
    linkedSkills: "关联技能",
    pluginOverview: "插件概览",
    pluginInstallEntries: "插件安装入口",
    pluginSource: "插件来源",
    skillSources: "Skill 来源",
    rescanSources: "重新检测来源",
    scanLocalSkills: "扫描本地 Skills",
    addLocalRepository: "添加本地仓库",
    deleteSkill: "删除",
    deleteSkillTitle: "删除已安装 Skill",
    deleteSkillText: "删除会先把本地目录移动到应用数据目录的 deleted-skills 备份区，然后从已安装列表移除。",
    confirmDeleteSkill: "备份后删除",
    restoreSkill: "恢复",
    deletedSkills: "已删除",
    restoredSkill: "Skill 已恢复。",
    localSource: "本地来源",
    localRepository: "本地仓库",
    installedLocal: "本地已安装",
    notInstalled: "未安装",
    latest: "最新",
    updateAvailable: "可更新",
    localModified: "本地有修改",
    sourceUnavailable: "来源不可用",
    skill: "技能",
    sourceRepository: "来源仓库",
    path: "路径",
    local: "本地",
    remote: "远端",
    status: "状态",
    update: "更新",
    install: "安装",
    recheckSource: "重检来源",
    noActionNeeded: "已是最新",
    actionUnavailable: "不可更新",
    tasksTitle: "任务",
    tasksSubtitle: "检查检测、备份和 Skill 更新任务，不隐藏失败项。",
    success: "成功",
    partial: "部分成功",
    failed: "失败",
    interrupted: "已中断",
    target: "对象",
    progress: "进度",
    taskSummary: "摘要",
    retry: "重试",
    copy: "复制",
    taskLog: "任务日志",
    taskAudit: "任务审计",
    taskDetails: "任务详情",
    taskOperations: "任务操作",
    settingsTitle: "设置",
    settingsSubtitle: "配置主题、语言、备份任务和本地覆盖保护。",
    settingsHelp: "这些设置都保存在本地。",
    appearanceLanguage: "外观与语言",
    theme: "主题",
    lightTheme: "浅色主题",
    darkTheme: "黑色主题",
    language: "语言",
    chinese: "中文",
    english: "英文",
    density: "界面密度",
    comfortable: "舒适",
    compact: "紧凑",
    backupRoot: "备份根目录",
    skillsRoot: "Skill 主库目录",
    skillLibraryRoot: "Skill 主库目录",
    defaultSyncTargets: "默认同步到",
    defaultSyncTargetsHelp: "默认只发布到 Claude Code 和 Codex。取消勾选并保存后，不会立刻删除文件；后续安装、更新和恢复会按新目标发布。",
    defaultSyncTargetsApplyHelp: "要把新的默认目标应用到已安装 Skills，请点击“应用同步设置到已安装 Skills”。主库不会被改动；被取消的已发布副本会先备份，再从对应工具目录移除，并写入任务日志。",
    syncBackupKeep: "同步备份保留",
    syncInstalledSkills: "应用同步设置到已安装 Skills",
    syncingSkills: "同步中",
    syncTargets: "同步目标",
    syncTargetsInherited: "继承默认目标",
    syncTargetsCustom: "自定义目标",
    skillCustomTargetsHelp: "自定义目标会立即应用到当前 Skill。取消某个已发布目标时，会先备份该副本，再从工具目录移除；不会删除 Skill 主库。",
    syncTargetsNone: "仅保留在主库",
    publishedTargets: "已发布到",
    inheritDefaults: "继承默认",
    customTargets: "自定义",
    syncTargetsSaved: "同步目标已保存。",
    installedSkillsSynced: "已应用同步设置到已安装 Skills。",
    localFolder: "本地目录",
    saveRoot: "保存目录",
    chooseFolder: "选择文件夹",
    backupRootHelp: "用于保存源码 ZIP、manifest.json 和 task-log.jsonl。",
    skillsRootHelp: "用于安装、扫描和管理本地 Skills；工具目录只是可选发布目标。",
    helpBackupRoot: "源码 ZIP、manifest.json 和 task-log.jsonl 会写入这个目录。",
    helpSkillsRoot: "安装、扫描和管理本地 Skills 的独立主库目录。",
    helpMetadataConcurrency: "同时检测远端仓库元数据的数量。数值越高越快，也更容易触发限流。",
    helpRetryCount: "检测、备份或更新失败后自动重试的次数。",
    helpAutoCheckInterval: "应用打开期间自动检测远端 SHA 的间隔。",
    helpOverwriteProtection: "更新 Skill 前检查本地内容是否被改动，避免静默覆盖。",
    helpRequireConfirmation: "备份全部、强制覆盖等高风险操作会要求二次确认。",
    helpScheduleForegroundOnly: "定时任务只在 App 打开时运行，关闭后不会后台常驻。",
    helpAutoBackupUpdatedOnly: "启用后只备份“有更新未备份”的仓库，不会备份所有仓库。",
    helpCleanupKeep: "保留最近多少份备份历史，后续清理策略会按这个数值执行。",
    helpGithubTokenStorage: "Token 只保存到系统安全存储，不写 SQLite、manifest 或任务日志。",
    directoryReady: "目录可用",
    directoryInvalid: "目录不可用",
    taskBehavior: "任务行为",
    metadataConcurrency: "元数据并发",
    retryCount: "失败重试次数",
    autoCheckInterval: "自动检测间隔",
    safetyDefaults: "安全默认项",
    overwriteProtection: "本地 Skill 覆盖保护",
    overwriteProtectionText: "更新前检测本地改动，默认要求确认。",
    requireConfirmation: "高风险操作二次确认",
    requireConfirmationText: "备份全部、强制覆盖等操作需要确认。",
    githubAuthentication: "GitHub 认证",
    p1Disabled: "P1 未启用",
    authP1Text: "Token 仅保存到系统安全存储，不写入 SQLite、manifest 或任务日志。",
    githubWorkbenchSettingsText: "账号、验证、刷新仓库、Star 和追踪操作都在 GitHub 工作台完成。这里保留安全状态，避免把 token 当成孤立设置项。",
    openGithubWorkbench: "打开 GitHub 工作台",
    tokenStatus: "Token 状态",
    tokenConfigured: "已配置",
    tokenNotConfigured: "未配置",
    tokenSavedUnverified: "已保存待验证",
    tokenVerified: "已验证",
    tokenInvalid: "验证失败",
    lastVerified: "上次验证",
    neverVerified: "从未验证",
    configureToken: "配置 Token",
    tokenPlaceholder: "粘贴 GitHub token",
    validateToken: "验证 Token",
    clearToken: "清除 Token",
    tokenSaved: "GitHub token 已保存。",
    tokenSavedButValidationFailed: "GitHub token 已保存，但验证失败。请检查权限或网络后重试。",
    tokenValidated: "GitHub token 验证成功。",
    tokenCleared: "GitHub token 已清除。",
    schedule: "定时任务",
    autoCheckEnabled: "启用定时检测",
    autoBackupEnabled: "启用定时备份",
    scheduleSavedOnly: "应用打开期间按计划执行；关闭 App 后不会后台常驻运行。",
    nextRun: "下次执行",
    autoCheckForeground: "自动检测：应用打开时每",
    cleanupKeep: "备份历史保留数量",
    aboutTitle: "关于",
    aboutVersion: "版本",
    checkForUpdates: "检查更新",
    checkingForUpdates: "检查中…",
    updateCheckReady: "可通过 GitHub Release 检查最新版本。",
    updateUnavailableInternalBuild: "仓库 URL 未配置，暂不可检查更新。",
    updateUpToDate: "当前已是最新版本。",
    updateCheckFailed: "检查更新失败。",
    openProjectGithub: "进入 GitHub",
    projectGithubComingSoon: "当前构建尚未配置项目 GitHub URL。",
    allSystems: "系统运行正常",
    localBackupRoot: "本地备份根目录：",
    change: "更改",
    autoCheckDisabled: "自动检测：未启用",
    runningTasks: "运行中任务",
    details: "详情",
    addAndScan: "添加并扫描",
    cancel: "取消",
    repositoryInput: "仓库 URL 或 owner/repo",
    note: "备注",
    optionalNote: "可选本地备注",
    notePlaceholder: "记录用途、场景、安装注意事项或迁移说明。",
    saveNote: "保存备注",
    clearNote: "清空备注",
    noteSaved: "备注已保存。",
    noteSaveFailed: "备注保存失败。",
    notesCount: "条备注",
    dataMigration: "数据迁移",
    dataMigrationHelp: "导出 GitHub 元数据、仓库、技能、插件和备注，用于不同机器之间迁移或分享。",
    exportData: "导出数据",
    importData: "导入数据",
    exporting: "导出中…",
    importing: "导入中…",
    migrationTokenNote: "迁移包不包含 GitHub token、Keychain 密钥、本地 Skill 文件、源码 ZIP 或任务日志；新机器需要重新添加 token。",
    migrationExported: "迁移包已导出。",
    migrationImported: "迁移包已导入。",
    migrationFailed: "迁移操作失败。",
    detectionPreview: "检测预览",
    detectionPreviewText: "公开仓库，main ref；只有检测到 SKILL.md 时才会识别为技能仓库。",
    firstRepositoryTitle: "添加第一个仓库开始追踪",
    firstRepositoryText: "先添加 GitHub 仓库。普通仓库也可以备份，检测到 SKILL.md 后才会出现在技能页。",
    noFilteredRepositoriesTitle: "没有匹配的仓库",
    noFilteredRepositoriesText: "调整搜索词或筛选条件，或添加新的仓库。",
    firstSkillTitle: "还没有识别到 Skill",
    firstSkillText: "从仓库扫描到 SKILL.md 后，这里会展示安装、更新和本地修改风险。",
    noFilteredSkillsTitle: "没有匹配的 Skill",
    noFilteredSkillsText: "切换状态筛选或重新检测来源仓库。",
    firstPluginTitle: "还没有发现插件安装入口",
    firstPluginText: "重新检测仓库后，README 或插件清单里的常见安装入口会集中显示在这里。",
    noFilteredPluginsTitle: "没有匹配的插件入口",
    noFilteredPluginsText: "调整搜索词，或回到仓库页重新检测来源。",
    firstTaskTitle: "还没有任务记录",
    firstTaskText: "检测远端、备份源码 ZIP、安装或更新 Skill 后，任务日志会出现在这里。",
    noFilteredTasksTitle: "没有匹配的任务",
    noFilteredTasksText: "切换任务状态筛选查看历史记录。",
    backupSelectedTitle: "备份选中仓库",
    backupUpdatedTitle: "备份有更新仓库",
    willBeBackedUp: "将被备份",
    targetRepositories: "目标仓库",
    checkFailedSkipped: "检测失败将跳过",
    outputDirectory: "输出目录",
    outputDirectoryText: "将生成 ZIP 文件和 manifest.json。Token 不会被写入。",
    confirmBackup: "确认备份",
    localSkillModified: "本地 Skill 有修改",
    localSkillModifiedText: "本地内容不同于上次安装 hash。继续更新可能覆盖用户改动。",
    recommendedDefault: "推荐默认",
    recommendedOverwriteText: "先备份本地 Skill，再用远端版本覆盖。",
    skipUpdate: "跳过更新",
    backupThenOverwrite: "备份后覆盖",
    forceOverwrite: "强制覆盖",
    backupCreated: "备份任务已创建。manifest 写入完成后会更新成功项。",
    remoteRefreshed: "远端状态已刷新。检测失败仓库保留上次已知 SHA。",
    repoExists: "该仓库和 ref 已经被追踪。",
    repoAddedSkill: "已作为技能仓库添加。",
    repoAddedGeneric: "已作为普通仓库添加。",
    installedSkill: "已安装到 Skill 主库。",
    sourceUnavailableToast: "来源不可用。请先重新检测仓库。",
    skillUpdated: "已更新本地 Skill。不会触发仓库备份。",
    updateSkipped: "已跳过更新，本地改动已保留。",
    localBackupDone: "已先备份本地副本再覆盖。",
    forceOverwriteDone: "已用远端版本强制覆盖 Skill。",
    retryAdded: "已添加重试任务。",
    taskCopied: "任务摘要已复制。",
    rootSaved: "备份根目录已保存。",
    settingsSaved: "设置已保存。",
    saveSettings: "保存设置",
    localSkillsScanned: "本地 Skills 已扫描。",
    localRepositoryAdded: "本地仓库已添加并扫描。",
    skillDeleted: "Skill 已移动到 deleted-skills。",
    noRunningTasks: "当前没有运行中任务。",
    githubTitle: "GitHub",
    githubSubtitle: "浏览当前账号可访问仓库、私仓和 Star 项目，并把需要的仓库加入追踪。",
    refreshGithub: "刷新 GitHub",
    refreshing: "刷新中…",
    githubNoAccountTitle: "添加 GitHub 账号",
    githubNoAccountText: "粘贴具备仓库读取权限的 token 后，可以查看私仓、Star 项目并加入追踪。",
    addGithubAccountTitle: "添加 GitHub 账号",
    githubTokenSecurityNote: "Token 只会保存到系统安全存储，不会写入 SQLite、manifest 或任务日志。",
    addAccount: "添加账号",
    githubAll: "全部",
    githubPersonalPublic: "个人公开",
    githubPersonalPrivate: "个人私有",
    githubPrivate: "私有",
    githubPublic: "公开",
    githubStarred: "Starred",
    githubTracked: "已追踪",
    visibility: "可见性",
    stars: "Stars",
    languageLabel: "语言",
    tracked: "已追踪",
    notTracked: "未追踪",
    star: "Star",
    unstar: "取消 Star",
    track: "追踪",
    untrack: "取消追踪",
    notStarred: "未 Star",
    githubNoReposTitle: "还没有仓库目录",
    githubNoReposText: "刷新 GitHub 后会列出该账号可访问的仓库和 Star 项目。",
    githubAccount: "GitHub 账号",
    account: "账号",
    permissions: "权限",
    deleteAccount: "删除账号",
  },
  en: {
    "nav.repositories": "Repositories",
    "nav.github": "GitHub",
    "nav.skills": "Skills",
    "nav.plugins": "Plugins",
    "nav.tasks": "Tasks",
    "nav.settings": "Settings",
    localCare: "Local repository care",
    summary: "Summary",
    totalRepositories: "Total repositories",
    skillRepositories: "Skill repositories",
    genericRepositories: "Generic repositories",
    unknownType: "Unknown type",
    backupStatus: "Backup status",
    backedLatest: "Backed up latest",
    updatedNotBacked: "Updated, not backed up",
    checkFailed: "Check failed",
    unknown: "Unknown",
    checkAll: "Check All",
    backupUpdated: "Backup Updated",
    backupSelected: "Backup Selected",
    addRepository: "Add Repository",
    settings: "Settings",
    needBackup: "need backup",
    search: "Search",
    searchRepositories: "Search repositories, notes, README...",
    searchSkills: "Search Skills, notes, README...",
    searchPlugins: "Search plugins, notes, README...",
    sourceRepositoryFilter: "Source repository",
    allRepositories: "All repositories",
    searchRepository: "Search repositories",
    taskStarted: "Task started. Open Tasks to inspect progress.",
    scanning: "Scanning...",
    checking: "Checking...",
    backingUp: "Backing up...",
    adding: "Adding...",
    installing: "Installing...",
    updating: "Updating...",
    deleting: "Deleting...",
    restoring: "Restoring...",
    retrying: "Retrying...",
    saving: "Saving...",
    validating: "Validating...",
    clearing: "Clearing...",
    repositoriesTitle: "Repositories",
    repositoriesSubtitle: "Track remote SHA, backup status, and Skill recognition separately.",
    all: "All",
    skillRepos: "Skill repos",
    generic: "Generic",
    updated: "Updated",
    neverBacked: "Never backed up",
    repository: "Repository",
    type: "Type",
    ref: "Ref",
    skills: "Skills",
    remoteSha: "Remote SHA",
    lastChecked: "Last Checked",
    addedAt: "Added",
    createdAt: "Added",
    starredAt: "Starred at",
    checkStatusLabel: "Check status",
    lastBackup: "Last backup",
    actions: "Actions",
    backup: "Backup",
    more: "Details",
    close: "Close",
    source: "Source",
    sourceUrl: "Source URL",
    defaultBranch: "Default branch",
    remoteRevision: "Remote revision",
    backupSnapshot: "Backup snapshot",
    lastBackupSha: "Last backup SHA",
    backupPath: "Backup path",
    snapshotTime: "Snapshot time",
    backupAudit: "Backup audit",
    latestManifest: "Latest manifest summary",
    noManifest: "No manifest record yet. ZIP, sha256, and manifest path appear after a backup completes.",
    zipPath: "ZIP path",
    sha256: "sha256",
    manifestPath: "Manifest path",
    backupHistory: "View backup history",
    recognizedSkills: "Recognized Skills",
    recognizedPlugins: "Recognized Plugins",
    noPluginsFound: "No plugin install entries found.",
    openPluginsManager: "Open in Plugins",
    noSkillsFound: "No Skills found. This repository remains backup eligible.",
    openSkillsManager: "Open in Skills Manager",
    quickActions: "Quick actions",
    backupNow: "Backup Now",
    openBackupFolder: "Open Backup Folder",
    viewGithub: "View on GitHub",
    chooseBrowser: "Choose Browser",
    copyLink: "Copy Link",
    openGithub: "Open GitHub",
    previewInApp: "Preview in App",
    systemBrowser: "System Browser",
    openUrlFailed: "Could not open link.",
    urlCopied: "Link copied.",
    installCommandCopied: "Install entry command copied.",
    copyUnavailable: "Clipboard copy is unavailable in this environment.",
    githubPreviewTitle: "GitHub Preview",
    githubPreviewSubtitle: "Preview repository metadata and README in app; open the full page in a browser.",
    githubPreviewLoading: "Loading GitHub repository information...",
    githubPreviewFailed: "GitHub preview failed to load.",
    githubPreviewReadmeMissing: "README could not be loaded. Open the full repository in a browser.",
    retryOpen: "Retry",
    viewReadme: "View README",
    refreshReadme: "Refresh README",
    readmeUnavailable: "README is unavailable.",
    loading: "Loading...",
    version: "Version",
    skillOverview: "Skill overview",
    description: "Description",
    noDescription: "No description.",
    noSkillMarkdown: "SKILL.md content not found.",
    skillDetailUnavailable: "Skill detail is unavailable.",
    pluginDetailUnavailable: "Plugin detail is unavailable.",
    extractSkills: "Extract Skills",
    recheckRepository: "Re-check Repository",
    manifestPreview: "Manifest summary",
    skillsTitle: "Skills",
    skillsSubtitle: "Install and update extracted Skills without triggering repository backups.",
    pluginsTitle: "Plugins",
    pluginsSubtitle: "Inspect marketplace, CLI, and single-Skill install entries exposed by repositories. This identifies entries; it does not install them.",
    pluginInstallEntryHint: "This is an install-entry recognition record, not proof that installation ran or passed a security review.",
    plugin: "Plugin",
    plugins: "Plugins",
    pluginKind: "Plugin type",
    installCommand: "Install command",
    updateCommand: "Update command",
    sourceExcerpt: "Source excerpt",
    linkedSkills: "Linked Skills",
    pluginOverview: "Plugin overview",
    pluginInstallEntries: "Plugin install entries",
    pluginSource: "Plugin source",
    skillSources: "Skill sources",
    rescanSources: "Re-check sources",
    scanLocalSkills: "Scan Local Skills",
    addLocalRepository: "Add Local Repository",
    deleteSkill: "Delete",
    deleteSkillTitle: "Delete Installed Skill",
    deleteSkillText: "Deletion first moves the local directory into the app data deleted-skills backup area, then removes it from installed Skills.",
    confirmDeleteSkill: "Backup and Delete",
    restoreSkill: "Restore",
    deletedSkills: "Deleted",
    restoredSkill: "Skill restored.",
    localSource: "Local source",
    localRepository: "Local repository",
    installedLocal: "Installed local",
    notInstalled: "Not installed",
    latest: "Latest",
    updateAvailable: "Update available",
    localModified: "Local modified",
    sourceUnavailable: "Source unavailable",
    skill: "Skill",
    sourceRepository: "Source repository",
    path: "Path",
    local: "Local",
    remote: "Remote",
    status: "Status",
    update: "Update",
    install: "Install",
    recheckSource: "Re-check source",
    noActionNeeded: "Up to date",
    actionUnavailable: "Unavailable",
    tasksTitle: "Tasks",
    tasksSubtitle: "Inspect detection, backup, and Skill update work without hiding failures.",
    success: "Success",
    partial: "Partial",
    failed: "Failed",
    interrupted: "Interrupted",
    target: "Target",
    progress: "Progress",
    taskSummary: "Summary",
    retry: "Retry",
    copy: "Copy",
    taskLog: "Task log",
    taskAudit: "Task audit",
    taskDetails: "Task details",
    taskOperations: "Task actions",
    settingsTitle: "Settings",
    settingsSubtitle: "Configure theme, language, backup tasks, and local overwrite protection.",
    settingsHelp: "These settings are stored locally.",
    appearanceLanguage: "Appearance and language",
    theme: "Theme",
    lightTheme: "Light theme",
    darkTheme: "Dark theme",
    language: "Language",
    chinese: "Chinese",
    english: "English",
    density: "Interface density",
    comfortable: "Comfortable",
    compact: "Compact",
    backupRoot: "Backup root",
    skillsRoot: "Skill library root",
    skillLibraryRoot: "Skill library root",
    defaultSyncTargets: "Default sync targets",
    defaultSyncTargetsHelp: "By default, Skills publish only to Claude Code and Codex. Unchecking a target and saving does not immediately remove files; future installs, updates, and restores use the new targets.",
    defaultSyncTargetsApplyHelp: "To apply the new defaults to installed Skills, click “Apply sync settings to installed Skills”. The library is not changed; removed published copies are backed up, removed from tool directories, and recorded in the task log.",
    syncBackupKeep: "Sync backups to keep",
    syncInstalledSkills: "Apply sync settings to installed Skills",
    syncingSkills: "Syncing",
    syncTargets: "Sync targets",
    syncTargetsInherited: "Inherited targets",
    syncTargetsCustom: "Custom targets",
    skillCustomTargetsHelp: "Custom targets apply immediately to this Skill. Removing a published target backs up that copy, removes it from the tool directory, and leaves the Skill library untouched.",
    syncTargetsNone: "Library only",
    publishedTargets: "Published to",
    inheritDefaults: "Inherit defaults",
    customTargets: "Custom",
    syncTargetsSaved: "Sync targets saved.",
    installedSkillsSynced: "Sync settings applied to installed Skills.",
    localFolder: "Local folder",
    saveRoot: "Save root",
    chooseFolder: "Choose Folder",
    backupRootHelp: "Stores source ZIP files, manifest.json, and task-log.jsonl.",
    skillsRootHelp: "Installs, scans, and manages local Skills; tool directories are optional publish targets.",
    helpBackupRoot: "Source ZIP files, manifest.json, and task-log.jsonl are written here.",
    helpSkillsRoot: "Independent library folder for installing, scanning, and managing local Skills.",
    helpMetadataConcurrency: "Number of remote repository metadata checks to run at once. Higher is faster but can hit rate limits.",
    helpRetryCount: "Automatic retry count after detection, backup, or update failures.",
    helpAutoCheckInterval: "Interval for checking remote SHA while the app is open.",
    helpOverwriteProtection: "Checks whether local Skill content changed before updating to avoid silent overwrites.",
    helpRequireConfirmation: "Risky actions such as backup-all and force-overwrite require a second confirmation.",
    helpScheduleForegroundOnly: "Schedules run only while the app is open; they do not continue after quitting.",
    helpAutoBackupUpdatedOnly: "When enabled, only repositories with unbacked updates are backed up.",
    helpCleanupKeep: "Number of recent backup history items to keep for future cleanup.",
    helpGithubTokenStorage: "Tokens are stored only in the secure system store, never in SQLite, manifests, or task logs.",
    directoryReady: "Directory ready",
    directoryInvalid: "Directory unavailable",
    taskBehavior: "Task behavior",
    metadataConcurrency: "Metadata concurrency",
    retryCount: "Retry count",
    autoCheckInterval: "Auto-check interval",
    safetyDefaults: "Safety defaults",
    overwriteProtection: "Local Skill overwrite protection",
    overwriteProtectionText: "Detect local changes before update and require confirmation by default.",
    requireConfirmation: "Confirm risky operations",
    requireConfirmationText: "Backup-all and force-overwrite actions require confirmation.",
    githubAuthentication: "GitHub authentication",
    p1Disabled: "P1 disabled",
    authP1Text: "Tokens are stored only in the secure system store, never in SQLite, manifests, or task logs.",
    githubWorkbenchSettingsText: "Account validation, repository refresh, Star actions, and tracking now happen in the GitHub workbench. Settings keep the security status without turning the token into a dead-end field.",
    openGithubWorkbench: "Open GitHub Workbench",
    tokenStatus: "Token status",
    tokenConfigured: "Configured",
    tokenNotConfigured: "Not configured",
    tokenSavedUnverified: "Saved, unverified",
    tokenVerified: "Verified",
    tokenInvalid: "Validation failed",
    lastVerified: "Last verified",
    neverVerified: "Never verified",
    configureToken: "Configure token",
    tokenPlaceholder: "Paste GitHub token",
    validateToken: "Validate token",
    clearToken: "Clear token",
    tokenSaved: "GitHub token saved.",
    tokenSavedButValidationFailed: "GitHub token saved, but validation failed. Check permissions or network and retry.",
    tokenValidated: "GitHub token validated.",
    tokenCleared: "GitHub token cleared.",
    schedule: "Schedules",
    autoCheckEnabled: "Enable scheduled checks",
    autoBackupEnabled: "Enable scheduled backups",
    scheduleSavedOnly: "Runs while the app is open. It does not continue after the app is closed.",
    nextRun: "Next run",
    autoCheckForeground: "Auto-check: while open every",
    cleanupKeep: "Backup history retention",
    aboutTitle: "About",
    aboutVersion: "Version",
    checkForUpdates: "Check for Updates",
    checkingForUpdates: "Checking...",
    updateCheckReady: "GitHub Release update checks are available.",
    updateUnavailableInternalBuild: "Repository URL is not configured. Update checks are unavailable.",
    updateUpToDate: "You are on the latest version.",
    updateCheckFailed: "Update check failed.",
    openProjectGithub: "Open GitHub",
    projectGithubComingSoon: "Project GitHub URL is not configured in this build.",
    allSystems: "All systems operational",
    localBackupRoot: "Local backup root:",
    change: "Change",
    autoCheckDisabled: "Auto-check: disabled",
    runningTasks: "Running Tasks",
    details: "Details",
    addAndScan: "Add and Scan",
    cancel: "Cancel",
    repositoryInput: "Repository URL or owner/repo",
    note: "Note",
    optionalNote: "Optional local note",
    notePlaceholder: "Record purpose, context, install notes, or migration notes.",
    saveNote: "Save Note",
    clearNote: "Clear Note",
    noteSaved: "Note saved.",
    noteSaveFailed: "Could not save note.",
    notesCount: "notes",
    dataMigration: "Data Migration",
    dataMigrationHelp: "Export GitHub metadata, repositories, Skills, plugins, and notes for machine migration or sharing.",
    exportData: "Export Data",
    importData: "Import Data",
    exporting: "Exporting...",
    importing: "Importing...",
    migrationTokenNote: "Migration packages do not include GitHub tokens, Keychain secrets, local Skill files, source ZIPs, or task logs. Add tokens again on the new machine.",
    migrationExported: "Migration package exported.",
    migrationImported: "Migration package imported.",
    migrationFailed: "Migration operation failed.",
    detectionPreview: "Detection preview",
    detectionPreviewText: "Public repository, ref main, no Skill found unless SKILL.md is detected.",
    firstRepositoryTitle: "Add your first repository",
    firstRepositoryText: "Start with a GitHub repository. Generic repositories can be backed up, and Skills appear only after SKILL.md is detected.",
    noFilteredRepositoriesTitle: "No matching repositories",
    noFilteredRepositoriesText: "Adjust the search or filter, or add another repository.",
    firstSkillTitle: "No Skills recognized yet",
    firstSkillText: "When a repository scan finds SKILL.md, install, update, and local-change risk controls appear here.",
    noFilteredSkillsTitle: "No matching Skills",
    noFilteredSkillsText: "Change the status filter or re-check source repositories.",
    firstPluginTitle: "No plugin install entries yet",
    firstPluginText: "After a repository re-check, common README or plugin-manifest install entries appear here.",
    noFilteredPluginsTitle: "No matching plugin entries",
    noFilteredPluginsText: "Adjust the search or return to repositories to re-check sources.",
    firstTaskTitle: "No task records yet",
    firstTaskText: "Remote checks, ZIP backups, and Skill installs or updates will be logged here.",
    noFilteredTasksTitle: "No matching tasks",
    noFilteredTasksText: "Change the task status filter to inspect history.",
    backupSelectedTitle: "Backup Selected",
    backupUpdatedTitle: "Backup Updated",
    willBeBackedUp: "will be backed up",
    targetRepositories: "Target repositories",
    checkFailedSkipped: "check failed skipped",
    outputDirectory: "Output directory",
    outputDirectoryText: "ZIP files and manifest.json will be generated. Token values are never written.",
    confirmBackup: "Confirm Backup",
    localSkillModified: "Local Skill Modified",
    localSkillModifiedText: "Local content differs from the last installed hash. Updating it can overwrite user edits.",
    recommendedDefault: "Recommended default",
    recommendedOverwriteText: "Back up the local Skill first, then overwrite with the remote version.",
    skipUpdate: "Skip Update",
    backupThenOverwrite: "Backup Then Overwrite",
    forceOverwrite: "Force Overwrite",
    backupCreated: "Backup task created. Successful items update after manifest writing completes.",
    remoteRefreshed: "Remote state refreshed. Failed repositories kept their last known SHA.",
    repoExists: "This repository and ref are already tracked.",
    repoAddedSkill: "added as a skill repo.",
    repoAddedGeneric: "added as a generic repo.",
    installedSkill: "installed to the Skill library.",
    sourceUnavailableToast: "Source unavailable. Re-check the repository before updating this Skill.",
    skillUpdated: "updated locally. Repository backup was not triggered.",
    updateSkipped: "Update skipped. Local changes were preserved.",
    localBackupDone: "Local copy backed up before overwrite.",
    forceOverwriteDone: "Skill force overwritten with remote version.",
    retryAdded: "Retry task added.",
    taskCopied: "Task summary copied.",
    rootSaved: "Backup root saved.",
    settingsSaved: "Settings saved.",
    saveSettings: "Save Settings",
    localSkillsScanned: "Local Skills scanned.",
    localRepositoryAdded: "Local repository added and scanned.",
    skillDeleted: "Skill moved to deleted-skills.",
    noRunningTasks: "No tasks are currently running.",
    githubTitle: "GitHub",
    githubSubtitle: "Browse accessible repositories, private repositories, and starred projects, then track what matters.",
    refreshGithub: "Refresh GitHub",
    refreshing: "Refreshing...",
    githubNoAccountTitle: "Add GitHub account",
    githubNoAccountText: "Paste a token with repository read access to browse private repos, starred projects, and tracked sources.",
    addGithubAccountTitle: "Add GitHub account",
    githubTokenSecurityNote: "Tokens are stored only in the secure system store, never in SQLite, manifests, or task logs.",
    addAccount: "Add account",
    githubAll: "All",
    githubPersonalPublic: "Personal public",
    githubPersonalPrivate: "Personal private",
    githubPrivate: "Private",
    githubPublic: "Public",
    githubStarred: "Starred",
    githubTracked: "Tracked",
    visibility: "Visibility",
    stars: "Stars",
    languageLabel: "Language",
    tracked: "Tracked",
    notTracked: "Not tracked",
    star: "Star",
    unstar: "Unstar",
    track: "Track",
    untrack: "Untrack",
    notStarred: "Not starred",
    githubNoReposTitle: "No GitHub catalog yet",
    githubNoReposText: "Refresh GitHub to list accessible repositories and starred projects.",
    githubAccount: "GitHub account",
    account: "Account",
    permissions: "Permissions",
    deleteAccount: "Delete account",
  },
};

const STATUS_LABELS = {
  zh: {
    "updated-not-backed-up": "需备份",
    "backed-up-latest": "已备份",
    "never-backed-up": "未备份",
    "local-only": "本地",
    "check-failed": "检测失败",
    "local-modified": "本地修改",
    "source-unavailable": "来源不可用",
    "update-available": "可更新",
    "installed-latest": "最新",
    "not-installed": "未安装",
    deleted: "已删除",
    "partial-success": "部分成功",
    success: "成功",
    failed: "失败",
    interrupted: "已中断",
    unknown: "未知",
    "skill repo": "技能仓库",
    "generic repo": "普通仓库",
    detected: "已识别",
    "codex-marketplace": "Codex 插件市场",
    "skills-cli": "Skills CLI",
    "clawhub-skill": "ClawHub 单技能",
    "structured-plugin": "结构化插件",
    local: "本地",
  },
  en: {
    "updated-not-backed-up": "needs backup",
    "backed-up-latest": "backed latest",
    "never-backed-up": "never backed",
    "local-only": "local",
    "check-failed": "check failed",
    "local-modified": "local modified",
    "source-unavailable": "source unavailable",
    "update-available": "update available",
    "installed-latest": "latest",
    "not-installed": "not installed",
    deleted: "deleted",
    "partial-success": "partial success",
    success: "success",
    failed: "failed",
    interrupted: "interrupted",
    unknown: "unknown",
    "skill repo": "skill repo",
    "generic repo": "generic repo",
    detected: "detected",
    "codex-marketplace": "Codex marketplace",
    "skills-cli": "Skills CLI",
    "clawhub-skill": "ClawHub single Skill",
    "structured-plugin": "structured plugin",
    local: "local",
  },
};

function getCopy(language, key) {
  return COPY[language]?.[key] || COPY.en[key] || key;
}

function statusLabel(value, language = "zh") {
  return STATUS_LABELS[language]?.[value] || value.replaceAll("-", " ");
}

const SKILL_DESCRIPTION_ZH = {
  prd: "生成 AI 可执行产品需求文档。",
  source: "审查信源可信度与证据质量。",
  "content-core": "内容工作室核心流程 Skill。",
  scene: "生成场景设计提示词和导演说明。",
  broken: "来源仓库当前不可访问。",
};

const TASK_TEXT_ZH = {
  "Backup repositories": "备份仓库",
  "Check remote state": "检测远端状态",
  "Update Skill": "更新 Skill",
  "Scan repository": "扫描仓库",
  "Scan local Skills": "扫描本地 Skills",
  "Scan local repository": "扫描本地仓库",
  "Delete Skill": "删除 Skill",
  "Restore Skill": "恢复 Skill",
  "Retry task": "重试任务",
  "Install Skill": "安装 Skill",
  "Updated repositories": "有更新仓库",
  "All repositories": "全部仓库",
  "Selected repositories": "选中仓库",
  "Previous session": "上次会话",
  "7 success, 1 failed, 4 queued": "7 个成功、1 个失败、4 个排队",
  "15 success, 2 failed": "15 个成功、2 个失败",
  "blocked by local modifications": "被本地修改阻止",
  "app closed during ZIP download": "ZIP 下载时应用关闭",
  "retry completed": "重试已完成",
  "remote check started": "已开始检测远端状态",
  "local Skills scan started": "已开始扫描本地 Skills",
  "local repository scan started": "已开始扫描本地仓库",
  "repository scan started": "已开始扫描仓库",
  "backup started": "已开始备份",
  "Skill update started": "已开始更新 Skill",
  "Skill install started": "已开始安装 Skill",
  "delete Skill started": "已开始删除 Skill",
  "restore Skill started": "已开始恢复 Skill",
  "local conflict resolution started": "已开始处理本地冲突",
  "retry task started": "已开始重试任务",
  "local Skill updated": "本地 Skill 已更新",
  "skipped to preserve local modifications": "已跳过以保留本地修改",
  "local copy backed up, then overwritten": "已备份本地副本后覆盖",
  "force overwritten": "已强制覆盖",
  "1 Skill recognized": "识别到 1 个 Skill",
  "generic repo, 0 Skills": "普通仓库，0 个 Skill",
  "refresh remote state for 17 repositories": "刷新 17 个仓库的远端状态",
  "skip example-org/missing-skill because check failed": "跳过 example-org/missing-skill，因为检测失败",
  "download example-org__content-skill-kit__main__a1b2c3d.zip": "下载 example-org__content-skill-kit__main__a1b2c3d.zip",
  "compute sha256: 19a6...4de1": "计算 sha256：19a6...4de1",
  "write manifest.json": "写入 manifest.json",
  "update last_backup_sha for successful items": "更新成功项的 last_backup_sha",
  "resolve default refs": "解析默认 ref",
  "record remote_head_sha for public repositories": "记录公开仓库的 remote_head_sha",
  "keep previous SHA for failed repositories": "检测失败仓库保留上次 SHA",
  "calculate installed_skill_hash": "计算 installed_skill_hash",
  "local content differs from installation record": "本地内容不同于安装记录",
  "waiting for user choice: skip, backup overwrite, force overwrite": "等待用户选择：跳过、备份后覆盖、强制覆盖",
  "task interrupted before manifest write": "manifest 写入前任务中断",
  "last_backup_sha not updated": "last_backup_sha 未更新",
  "refresh all remote refs": "刷新全部远端 ref",
  "preserve failed repository SHA": "保留失败仓库 SHA",
  "recalculate backup states": "重新计算备份状态",
  "fetch remote HEAD SHA": "获取远端 HEAD SHA",
  "found SKILL.md": "发现 SKILL.md",
  "no SKILL.md found; keep as generic repo": "未发现 SKILL.md，保留为普通仓库",
  "refresh remote state before backup": "备份前刷新远端状态",
  "download ZIP files to .partial paths": "将 ZIP 下载到 .partial 路径",
  "compute sha256 for successful ZIP files": "为成功 ZIP 计算 sha256",
  "update last_backup_sha for successful repositories": "更新成功仓库的 last_backup_sha",
  "download remote Skill directory": "下载远端 Skill 目录",
  "replace local files": "替换本地文件",
  "record installed_skill_hash": "记录 installed_skill_hash",
  "local hash differs from installed_skill_hash": "本地 hash 不同于 installed_skill_hash",
  "user chose skip update": "用户选择跳过更新",
  "backup local Skill before overwrite": "覆盖前备份本地 Skill",
  "force overwrite local Skill": "强制覆盖本地 Skill",
  "record new installed_skill_hash": "记录新的 installed_skill_hash",
  "retry failed item": "重试失败项",
  "complete without changing unrelated state": "完成且不改变无关状态",
};

function skillDescription(skill, language) {
  return language === "zh" ? SKILL_DESCRIPTION_ZH[skill.id] || skill.description : skill.description;
}

function taskText(text, language) {
  if (language !== "zh" || !text) return text;
  const successSkipped = text.match(/^(\d+) success, (\d+) skipped$/);
  if (successSkipped) return `${successSkipped[1]} 个成功、${successSkipped[2]} 个跳过`;
  const successFailed = text.match(/^(\d+) success, (\d+) failed$/);
  if (successFailed) return `${successFailed[1]} 个成功、${successFailed[2]} 个失败`;
  if (text.endsWith(" retry")) return `${taskText(text.slice(0, -6), language)}重试`;
  if (text.startsWith("create ")) return text.replace(/^create /, "创建 ");
  if (text.startsWith("normalize ")) return text.replace(/^normalize /, "规范化 ");
  return TASK_TEXT_ZH[text] || text;
}

function displayValue(value, language) {
  if (typeof value !== "string") return value;
  const maps = {
    zh: {
      "Local Skills Library": "本地 Skills 库",
      "本地 Skills 库": "本地 Skills 库",
      Never: "从未",
      Unavailable: "不可用",
      none: "无",
      unknown: "未知",
      "not installed": "未安装",
      local: "本地",
      "local-only": "本地",
      installed_local: "本地已安装",
      local_repo: "本地仓库",
      github_repo: "GitHub",
    },
    en: {
      "本地 Skills 库": "Local Skills Library",
      "Local Skills Library": "Local Skills Library",
      local: "local",
      "local-only": "local",
      installed_local: "installed local",
      local_repo: "local repository",
      github_repo: "GitHub",
    },
  };
  const mapped = maps[language]?.[value];
  if (mapped) return mapped;
  if (language === "zh") return value.replace(/^Jun (\d{1,2}) /, "6月$1日 ");
  return value;
}

const fallbackSyncTargets = [
  { id: "claude", label: "Claude Code", path: "~/.claude/skills", exists: false },
  { id: "codex", label: "Codex", path: "~/.codex/skills", exists: false },
  { id: "gemini", label: "Gemini", path: "~/.gemini/skills", exists: false },
  { id: "opencode", label: "OpenCode", path: "~/.config/opencode/skills", exists: false },
  { id: "openclaw", label: "OpenClaw", path: "~/.openclaw/skills", exists: false },
  { id: "hermes", label: "Hermes", path: "~/.hermes/skills", exists: false },
];

function syncTargetLabel(targetId, targets = fallbackSyncTargets) {
  return targets.find((target) => target.id === targetId)?.label || targetId;
}

function syncTargetSummary(targetIds = [], targets = fallbackSyncTargets, language = "zh") {
  if (!targetIds.length) return getCopy(language, "syncTargetsNone");
  return targetIds.map((id) => syncTargetLabel(id, targets)).join(", ");
}

function displayRepoName(value, language = "zh") {
  if (value === "Local Skills Library" || value === "本地 Skills 库") {
    return language === "zh" ? "本地 Skills 库" : "Local Skills Library";
  }
  return value;
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function fuzzyMatch(values, query) {
  const term = normalizeSearch(query);
  if (!term) return true;
  return values.some((value) => normalizeSearch(displayValue(value, "zh")).includes(term) || normalizeSearch(value).includes(term));
}

function compareNames(left, right) {
  return String(left || "").localeCompare(String(right || ""), "en", {
    caseFirst: "upper",
    sensitivity: "variant",
  });
}

function sortableDate(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== "Never" && normalized !== "-" ? normalized : "";
}

function compareDates(left, right, direction = "asc") {
  const leftDate = sortableDate(left);
  const rightDate = sortableDate(right);
  if (!leftDate && rightDate) return 1;
  if (leftDate && !rightDate) return -1;
  const compared = leftDate.localeCompare(rightDate);
  return direction === "asc" ? compared : -compared;
}

function sortIndicator(active, direction) {
  if (!active) return "";
  return direction === "asc" ? " ↑" : " ↓";
}

function repositorySearchValues(repo, language = "zh") {
  return [
    repo.name,
    displayRepoName(repo.name, language),
    repo.ref,
    repo.branch,
    repo.url,
    repo.localPath,
    repo.type,
    repo.sourceType,
    repo.readmeSearchText,
    repo.note,
  ];
}

function githubRepositoryNoteKey(repo) {
  return `github:${String(repo.owner || "").toLowerCase()}/${String(repo.repo || "").toLowerCase()}`;
}

function trackedRepositoryNoteKey(repo) {
  if (repo?.sourceType === "github" && typeof repo.name === "string" && repo.name.includes("/")) {
    return `github:${repo.name.toLowerCase()}`;
  }
  return `local:${repo?.id || ""}`;
}

function noteActionKey(target, item) {
  if (target === "githubRepository") return `note:githubRepository:${item.accountId}:${item.fullName}`;
  if (target === "repository") return `note:repository:${item.id}`;
  if (target === "skill") return `note:skill:${item.id}`;
  if (target === "plugin") return `note:plugin:${item.id}`;
  return `note:${target}`;
}

function skillRepoId(skill) {
  return skill.repoId || skill.repositoryId || "";
}

function sourceLabel(skill, language = "zh") {
  if (skill.sourceType === "installed_local") return language === "zh" ? "本地" : "Local";
  if (skill.sourceType === "local_repo") return language === "zh" ? "本地仓库" : "Local repo";
  return language === "zh" ? "GitHub" : "GitHub";
}

function versionSummary(skill, language = "zh") {
  const localVersion = displayValue(skill.localVersion, language);
  const remoteVersion = displayValue(skill.remoteVersion, language);
  if (localVersion === remoteVersion) return localVersion;
  return `${localVersion} / ${remoteVersion}`;
}

function tokenStatusLabel(status, configured, language = "zh", t) {
  if (!configured || status === "not_configured") return t("tokenNotConfigured");
  const keyByStatus = {
    saved_unverified: "tokenSavedUnverified",
    verified: "tokenVerified",
    invalid: "tokenInvalid",
  };
  return t(keyByStatus[status] || "tokenConfigured");
}

function formatNextRun(value, language = "zh") {
  if (!value) return language === "zh" ? "未启用" : "disabled";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function manifestShaPreview(seed) {
  if (!seed || seed === "none" || seed === "unknown") return "unknown";
  return `${seed.padEnd(12, "0").slice(0, 12)}...${seed.padStart(8, "0").slice(-8)}`;
}

function initialParam(name, fallback, allowed) {
  if (typeof window === "undefined") return fallback;
  const value = new URLSearchParams(window.location.search).get(name);
  return allowed.includes(value) ? value : fallback;
}

function initialFreeParam(name, fallback = "") {
  if (typeof window === "undefined") return fallback;
  return new URLSearchParams(window.location.search).get(name) || fallback;
}

function parseRepoName(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "example/new-repository";
  const cleaned = trimmed
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/^github\.com\//, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return cleaned.includes("/") ? cleaned : `example-org/${cleaned}`;
}

function Button({
  children,
  variant = "secondary",
  onClick,
  disabled = false,
  className = "",
  pending = false,
  pendingLabel,
  type = "button",
  ...buttonProps
}: any) {
  return (
    <button
      {...buttonProps}
      className={`button ${variant} ${className} ${pending ? "is-pending" : ""}`}
      onClick={onClick}
      disabled={disabled || pending}
      type={type}
    >
      {pending ? pendingLabel || children : children}
    </button>
  );
}

function Tag({ value, tone, language = "zh" }: any) {
  return <span className={`tag ${tone || value}`}>{statusLabel(value, language)}</span>;
}

function Modal({ title, children, footer, onClose, closeLabel = "Close" }: any) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} type="button">
            {closeLabel}
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-footer">{footer}</footer>
      </section>
    </div>
  );
}

export function App() {
  const demoMode = initialParam("demo", "default", ["default", "empty-plugins"]);
  const demoFocus = initialParam("focus", "none", ["none", "plugin-row"]);
  const initialTab = initialParam("tab", "repositories", navItems.map((item) => item.id));
  const [activeTab, setActiveTab] = useState(initialTab);
  const [language, setLanguage] = useState(() => initialParam("lang", "zh", ["zh", "en"]));
  const [theme, setTheme] = useState(() => initialParam("theme", "light", ["light", "dark"]));
  const [density, setDensity] = useState("comfortable");
  const [repositories, setRepositories] = useState(initialRepos);
  const [skills, setSkills] = useState(initialSkills);
  const [plugins, setPlugins] = useState(() => (demoMode === "empty-plugins" ? [] : initialPlugins));
  const [tasks, setTasks] = useState(initialTasks);
  const [selectedRepoId, setSelectedRepoId] = useState("content");
  const [inspectorRepoId, setInspectorRepoId] = useState(() => initialFreeParam("inspectorRepo"));
  const [selectedSkillId, setSelectedSkillId] = useState(() => initialFreeParam("selectedSkill"));
  const [skillDetail, setSkillDetail] = useState(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState("");
  const skillDetailRequestRef = useRef("");
  const [selectedPluginId, setSelectedPluginId] = useState(() => initialFreeParam("selectedPlugin"));
  const [pluginDetail, setPluginDetail] = useState(null);
  const [pluginDetailLoading, setPluginDetailLoading] = useState(false);
  const [pluginDetailError, setPluginDetailError] = useState("");
  const pluginDetailRequestRef = useRef("");
  const [selectedRows, setSelectedRows] = useState(["content"]);
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSort, setRepoSort] = useState({ key: "name", direction: "asc" });
  const [skillFilter, setSkillFilter] = useState("all");
  const [skillSort, setSkillSort] = useState({ key: "name", direction: "asc" });
  const [skillRepoQuery, setSkillRepoQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState("all");
  const [pluginSort, setPluginSort] = useState({ key: "name", direction: "asc" });
  const [search, setSearch] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const [pluginSearch, setPluginSearch] = useState(() => initialFreeParam("pluginSearch"));
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef<number | undefined>(undefined);
  const [pendingActions, setPendingActions] = useState({});
  const [backupRoot, setBackupRoot] = useState("~/SkillRepoBackups");
  const [skillsRoot, setSkillsRoot] = useState("~/SkillRepoTracker/skills");
  const [defaultSyncTargets, setDefaultSyncTargets] = useState([]);
  const [availableSyncTargets, setAvailableSyncTargets] = useState(fallbackSyncTargets);
  const [syncBackupKeep, setSyncBackupKeep] = useState(5);
  const [directoryStatus, setDirectoryStatus] = useState({});
  const [concurrency, setConcurrency] = useState(5);
  const [retryCount, setRetryCount] = useState(2);
  const [autoCheckInterval, setAutoCheckInterval] = useState(60);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(false);
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(false);
  const [cleanupKeep, setCleanupKeep] = useState(20);
  const [overwriteProtection, setOverwriteProtection] = useState(true);
  const [requireConfirmation, setRequireConfirmation] = useState(true);
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [githubTokenStatus, setGithubTokenStatus] = useState("not_configured");
  const [githubTokenLastVerified, setGithubTokenLastVerified] = useState(null);
  const [githubAccounts, setGithubAccounts] = useState<GitHubAccount[]>(initialGithubAccounts);
  const [githubRepositories, setGithubRepositories] = useState<GitHubRepository[]>(initialGithubRepositories);
  const [activeGithubAccountId, setActiveGithubAccountId] = useState("github:demo");
  const [isAddingRepo, setIsAddingRepo] = useState(false);
  const addRepoRequestRef = useRef(0);
  const [migrationStatus, setMigrationStatus] = useState("");
  const [nextAutoCheckAt, setNextAutoCheckAt] = useState(null);
  const [nextAutoBackupAt, setNextAutoBackupAt] = useState(null);
  const [newRepo, setNewRepo] = useState({
    url: "",
    ref: "main",
    note: "",
  });
  const t = (key) => getCopy(language, key);
  const desktopRuntime = isDesktopRuntime();

  function isPending(key) {
    return Boolean(pendingActions[key]);
  }

  function setActionPending(key, pending) {
    setPendingActions((items) => {
      const next = { ...items };
      if (pending) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return next;
    });
  }

  function beginOptimisticTask(actionKey, task) {
    setActionPending(actionKey, true);
    const id = `pending-${actionKey}-${Date.now()}`;
    const optimisticTask = {
      id,
      kind: task.kind,
      target: task.target,
      progress: task.progress || "…",
      status: "running",
      summary: task.summary || "task started",
      log: task.log || ["task started"],
      optimistic: true,
    };
    setTasks((items) => [optimisticTask, ...items.filter((item) => item.id !== id)]);
    showToast(t("taskStarted"));
    return id;
  }

  function finishOptimisticTask(actionKey, taskId) {
    setActionPending(actionKey, false);
    if (taskId) {
      setTasks((items) => items.filter((item) => item.id !== taskId));
    }
  }

  function applySettings(settings) {
    if (!settings) return;
    setBackupRoot(settings.backupRoot || "~/SkillRepoBackups");
    setSkillsRoot(settings.skillLibraryRoot || settings.skillsRoot || "~/SkillRepoTracker/skills");
    setDefaultSyncTargets(settings.defaultSyncTargets || []);
    setAvailableSyncTargets(settings.availableSyncTargets?.length ? settings.availableSyncTargets : fallbackSyncTargets);
    setSyncBackupKeep(settings.syncBackupKeep || 5);
    setConcurrency(settings.concurrency || 5);
    setRetryCount(settings.retryCount ?? 2);
    setAutoCheckInterval(settings.autoCheckInterval || 60);
    setAutoCheckEnabled(Boolean(settings.autoCheckEnabled));
    setAutoBackupEnabled(Boolean(settings.autoBackupEnabled));
    setCleanupKeep(settings.cleanupKeep || 20);
    setGithubTokenConfigured(Boolean(settings.githubTokenConfigured));
    setGithubTokenStatus(settings.githubTokenStatus || (settings.githubTokenConfigured ? "saved_unverified" : "not_configured"));
    setGithubTokenLastVerified(settings.githubTokenLastVerified || null);
  }

  async function refreshDesktopState() {
    if (!desktopRuntime) return;
    try {
      const [
        nextRepos,
        nextSkills,
        nextPlugins,
        nextTasks,
        nextSettings,
        nextGithubAccounts,
        nextGithubRepositories,
      ] = await Promise.all([
        api.listRepositories(),
        api.listSkills(),
        api.listPlugins(),
        api.listTasks(),
        api.getSettings(),
        api.listGithubAccounts(),
        api.listGithubRepositoryCatalog(),
      ]);
      setRepositories(nextRepos);
      setSkills(nextSkills);
      setPlugins(nextPlugins);
      setTasks(nextTasks);
      setGithubAccounts(nextGithubAccounts);
      setGithubRepositories(nextGithubRepositories);
      setActiveGithubAccountId((id) =>
        id && nextGithubAccounts.some((account) => account.id === id)
          ? id
          : nextGithubAccounts[0]?.id || "",
      );
      applySettings(nextSettings);
      if (!nextRepos.length) {
        setSelectedRepoId("");
        setInspectorRepoId("");
        setSelectedRows([]);
      } else if (!nextRepos.some((repo) => repo.id === selectedRepoId)) {
        setSelectedRepoId(nextRepos[0].id);
        setSelectedRows([nextRepos[0].id]);
        setInspectorRepoId((id) => (nextRepos.some((repo) => repo.id === id) ? id : ""));
      } else {
        setSelectedRows((rows) => rows.filter((id) => nextRepos.some((repo) => repo.id === id)));
        setInspectorRepoId((id) => (nextRepos.some((repo) => repo.id === id) ? id : ""));
      }
    } catch (error) {
      showToast(error.message || "后端状态读取失败。");
    }
  }

  useEffect(() => {
    refreshDesktopState();
  }, []);

  const settingsProps = {
    language,
    setLanguage,
    theme,
    setTheme,
    density,
    setDensity,
    backupRoot,
    setBackupRoot,
    skillsRoot,
    setSkillsRoot,
    defaultSyncTargets,
    setDefaultSyncTargets,
    availableSyncTargets,
    syncBackupKeep,
    setSyncBackupKeep,
    concurrency,
    setConcurrency,
    retryCount,
    setRetryCount,
    autoCheckInterval,
    setAutoCheckInterval,
    autoCheckEnabled,
    setAutoCheckEnabled,
    autoBackupEnabled,
    setAutoBackupEnabled,
    cleanupKeep,
    setCleanupKeep,
    overwriteProtection,
    setOverwriteProtection,
    requireConfirmation,
    setRequireConfirmation,
    githubTokenConfigured,
    githubTokenStatus,
    githubTokenLastVerified,
    nextAutoCheckAt,
    nextAutoBackupAt,
    directoryStatus,
    migrationStatus,
    isPending,
    desktopRuntime,
    refreshDesktopState,
    chooseDirectory,
    validateDirectory,
    syncInstalledSkills,
    persistSettings,
    updateSkillSyncTargets,
    showToast,
    exportMigrationPackage,
    importMigrationPackage,
    openGitHubWorkbench: () => setActiveTab("github"),
    t,
  };

  const inspectorRepo = repositories.find((repo) => repo.id === inspectorRepoId);
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId);

  const counts = useMemo(() => {
    return {
      total: repositories.length,
      skill: repositories.filter((repo) => repo.type === "skill repo").length,
      generic: repositories.filter((repo) => repo.type === "generic repo").length,
      unknown: repositories.filter((repo) => repo.type === "unknown").length,
      backed: repositories.filter((repo) => repo.backupStatus === "backed-up-latest").length,
      updated: repositories.filter((repo) => repo.backupStatus === "updated-not-backed-up").length,
      failed: repositories.filter((repo) => repo.backupStatus === "check-failed").length,
    };
  }, [repositories]);

  const filteredRepos = useMemo(() => {
    const visible = repositories.filter((repo) => {
      const matchesSearch = fuzzyMatch(repositorySearchValues(repo, language), search);
      const matchesFilter =
        repoFilter === "all" ||
        (repoFilter === "skill" && repo.type === "skill repo") ||
        (repoFilter === "generic" && repo.type === "generic repo") ||
        (repoFilter === "updated" && repo.backupStatus === "updated-not-backed-up") ||
        (repoFilter === "failed" && repo.backupStatus === "check-failed") ||
        (repoFilter === "never" && repo.backupStatus === "never-backed-up");
      return matchesSearch && matchesFilter;
    });
    return [...visible].sort((left, right) => {
      if (repoSort.key === "addedAt") {
        const compared = compareDates(left.addedAt, right.addedAt, repoSort.direction);
        if (compared !== 0) return compared;
      }
      const compared = compareNames(displayRepoName(left.name, language), displayRepoName(right.name, language));
      return repoSort.key === "name" && repoSort.direction === "desc" ? -compared : compared;
    });
  }, [repositories, language, search, repoFilter, repoSort]);

  const filteredSkills = useMemo(() => {
    const visible = skills.filter((skill) => {
      const matchesSearch = fuzzyMatch(
        [
          skill.name,
          skill.description,
          skill.repo,
          displayRepoName(skill.repo, language),
          skill.path,
          skill.sourceType,
          skill.localPath,
          skill.installPath,
          skill.searchText,
          skill.note,
        ],
        skillSearch,
      );
      const sourceRepo = repositories.find((repo) => repo.id === skillRepoId(skill));
      const matchesAllRepositories = fuzzyMatch([t("allRepositories"), "all", "全部仓库"], skillRepoQuery);
      const matchesRepo = matchesAllRepositories || fuzzyMatch(
        [
          skill.repo,
          displayRepoName(skill.repo, language),
          skill.path,
          skill.sourceType,
          skill.localPath,
          skill.installPath,
          sourceRepo?.name,
          sourceRepo ? displayRepoName(sourceRepo.name, language) : "",
          sourceRepo?.ref,
          sourceRepo?.url,
          sourceRepo?.localPath,
          sourceRepo?.type,
          sourceRepo ? statusLabel(sourceRepo.type, language) : "",
          sourceRepo?.sourceType,
          sourceRepo?.readmeSearchText,
          sourceRepo?.note,
        ],
        skillRepoQuery,
      );
      const visibleByFilter =
        skillFilter === "deleted"
          ? skill.status === "deleted"
          : skill.status !== "deleted" && (skillFilter === "all" || skill.status === skillFilter);
      return matchesSearch && matchesRepo && visibleByFilter;
    });
    return [...visible].sort((left, right) => {
      if (skillSort.key === "createdAt") {
        const compared = compareDates(left.createdAt, right.createdAt, skillSort.direction);
        if (compared !== 0) return compared;
      }
      const compared = compareNames(left.name, right.name);
      return skillSort.key === "name" && skillSort.direction === "desc" ? -compared : compared;
    });
  }, [skills, repositories, language, skillSearch, skillRepoQuery, skillFilter, skillSort]);

  const filteredPlugins = useMemo(() => {
    const visible = plugins.filter((plugin) =>
      fuzzyMatch(
        [
          plugin.name,
          plugin.description,
          plugin.kind,
          statusLabel(plugin.kind, language),
          plugin.repoName,
          displayRepoName(plugin.repoName, language),
          plugin.installCommand,
          plugin.updateCommand,
          plugin.sourcePath,
          plugin.sourceExcerpt,
          plugin.status,
          plugin.note,
        ],
        pluginSearch,
      ),
    );
    return [...visible].sort((left, right) => {
      if (pluginSort.key === "createdAt") {
        const compared = compareDates(left.createdAt, right.createdAt, pluginSort.direction);
        if (compared !== 0) return compared;
      }
      const compared = compareNames(left.name, right.name);
      return pluginSort.key === "name" && pluginSort.direction === "desc" ? -compared : compared;
    });
  }, [plugins, language, pluginSearch, pluginSort]);

  const filteredTasks = tasks.filter((task) => {
    return taskFilter === "all" || task.status === taskFilter;
  });

  useEffect(() => {
    if (!selectedSkillId) return;
    if (!filteredSkills.some((skill) => skill.id === selectedSkillId)) {
      setSelectedSkillId("");
      skillDetailRequestRef.current = "";
      setSkillDetail(null);
      setSkillDetailError("");
      setSkillDetailLoading(false);
    }
  }, [filteredSkills, selectedSkillId]);

  useEffect(() => {
    if (!selectedPluginId) return;
    if (!filteredPlugins.some((plugin) => plugin.id === selectedPluginId)) {
      setSelectedPluginId("");
      pluginDetailRequestRef.current = "";
      setPluginDetail(null);
      setPluginDetailError("");
      setPluginDetailLoading(false);
    }
  }, [filteredPlugins, selectedPluginId]);

  function backupTargetRepos(mode = "updated", repoIds = []) {
    if (mode === "selected") {
      const targetIds = repoIds.length ? repoIds : selectedRows;
      return repositories.filter((repo) => targetIds.includes(repo.id) && repo.sourceType !== "local");
    }
    return repositories.filter((repo) =>
      repo.sourceType !== "local" &&
      ["updated-not-backed-up", "never-backed-up", "check-failed"].includes(repo.backupStatus),
    );
  }

  function resetNewRepo() {
    setNewRepo({ url: "", ref: "main", note: "" });
  }

  function openAddRepoModal() {
    resetNewRepo();
    setIsAddingRepo(false);
    setModal({ type: "add" });
  }

  function closeAddRepoModal() {
    if (isAddingRepo) return;
    resetNewRepo();
    setIsAddingRepo(false);
    setModal(null);
  }

  function closeActiveInspector() {
    setInspectorRepoId("");
    setSelectedRepoId("");
    setSelectedSkillId("");
    skillDetailRequestRef.current = "";
    setSkillDetail(null);
    setSkillDetailError("");
    setSkillDetailLoading(false);
    setSelectedPluginId("");
    pluginDetailRequestRef.current = "";
    setPluginDetail(null);
    setPluginDetailError("");
    setPluginDetailLoading(false);
  }

  function toggleRow(repoId) {
    setSelectedRows((rows) =>
      rows.includes(repoId) ? rows.filter((id) => id !== repoId) : [...rows, repoId],
    );
  }

  function selectAllVisible() {
    const visibleIds = filteredRepos.map((repo) => repo.id);
    const allSelected = visibleIds.every((id) => selectedRows.includes(id));
    setSelectedRows(allSelected ? [] : visibleIds);
  }

  async function checkAllRepos() {
    const actionKey = "checkAllRepos";
    if (isPending(actionKey)) return;
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Check remote state",
      target: "All repositories",
      summary: "remote check started",
      log: ["remote check started"],
    });
    if (desktopRuntime) {
      try {
        const nextRepos = await api.checkRepositories();
        const [nextSkills, nextPlugins, nextTasks] = await Promise.all([
          api.listSkills(),
          api.listPlugins(),
          api.listTasks(),
        ]);
        setRepositories(nextRepos);
        setSkills(nextSkills);
        setPlugins(nextPlugins);
        setTasks(nextTasks);
        showToast(t("remoteRefreshed"));
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("sourceUnavailableToast"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    setRepositories((repos) =>
      repos.map((repo) => ({
        ...repo,
        lastChecked: "Jun 14 10:04",
        checkStatus: repo.id === "missing" ? "failed" : "success",
      })),
    );
    addTask({
      kind: "Check remote state",
      target: "All repositories",
      progress: `${repositories.length} / ${repositories.length}`,
      status: "success",
      summary: `${repositories.length - 1} success, 1 failed`,
      log: ["refresh all remote refs", "preserve failed repository SHA", "recalculate backup states"],
    });
    showToast(t("remoteRefreshed"));
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  function addTask(task) {
    const id = `${task.kind.toLowerCase().replaceAll(" ", "-")}-${Date.now()}`;
    setTasks((items) => [{ id, ...task }, ...items]);
  }

  function showToast(message) {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 3200);
  }

  async function validateDirectory(kind, path) {
    if (!desktopRuntime || !path) return;
    try {
      const validation = await api.validateDirectory(kind, path);
      setDirectoryStatus((items) => ({ ...items, [kind]: validation }));
      if (!validation.writable) {
        showToast(validation.message || t("directoryInvalid"));
      }
    } catch (error) {
      showToast(error.message || t("directoryInvalid"));
    }
  }

  async function chooseDirectory(kind) {
    if (!desktopRuntime) return;
    try {
      const currentPath = kind === "backupRoot" ? backupRoot : skillsRoot;
      const selected = await api.pickDirectory(currentPath);
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      if (kind === "backupRoot") {
        setBackupRoot(path);
      } else if (kind === "skillsRoot") {
        setSkillsRoot(path);
      }
      await validateDirectory(kind, path);
    } catch (error) {
      showToast(error.message || t("directoryInvalid"));
    }
  }

  async function scanLocalSkills() {
    const actionKey = "scanLocalSkills";
    if (isPending(actionKey)) return;
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Scan local Skills",
      target: skillsRoot,
      summary: "local Skills scan started",
      log: [`scan ${skillsRoot}`],
    });
    if (desktopRuntime) {
      try {
        const nextSkills = await api.scanLocalSkills(skillsRoot);
        const [nextRepos, nextPlugins, nextTasks] = await Promise.all([
          api.listRepositories(),
          api.listPlugins(),
          api.listTasks(),
        ]);
        setSkills(nextSkills);
        setPlugins(nextPlugins);
        setRepositories(nextRepos);
        setTasks(nextTasks);
        showToast(t("localSkillsScanned"));
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("directoryInvalid"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    showToast(t("localSkillsScanned"));
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function syncInstalledSkills() {
    const actionKey = "syncInstalledSkills";
    if (isPending(actionKey)) return;
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Apply Skill sync settings",
      target: "Installed Skills",
      summary: "apply Skill sync settings started",
      log: ["apply Skill sync settings"],
    });
    if (desktopRuntime) {
      try {
        const nextSkills = await api.syncInstalledSkills();
        const nextTasks = await api.listTasks();
        setSkills(nextSkills);
        setTasks(nextTasks);
        showToast(t("installedSkillsSynced"));
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("directoryInvalid"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    showToast(t("installedSkillsSynced"));
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function updateSkillSyncTargets(skillId, mode, targets) {
    const actionKey = `syncTargets:${skillId}`;
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const nextSkills = await api.updateSkillSyncTargets(skillId, mode, targets);
        const nextTasks = await api.listTasks();
        setSkills(nextSkills);
        setTasks(nextTasks);
        if (selectedSkillId === skillId) {
          const detail = await api.getSkillDetail(skillId);
          setSkillDetail(detail);
        }
        showToast(t("syncTargetsSaved"));
      } catch (error) {
        showToast(error.message || t("directoryInvalid"));
      } finally {
        setActionPending(actionKey, false);
      }
      return;
    }
    setSkills((items) =>
      items.map((item) =>
        item.id === skillId
          ? {
              ...item,
              syncTargetsMode: mode,
              syncTargets: targets,
              resolvedSyncTargets: mode === "custom" ? targets : defaultSyncTargets,
            }
          : item,
      ),
    );
    showToast(t("syncTargetsSaved"));
    setActionPending(actionKey, false);
  }

  function applyNoteUpdate(target, entityKey, note, id) {
    if (target === "repository" || target === "githubRepository") {
      setRepositories((items) =>
        items.map((item) =>
          trackedRepositoryNoteKey(item) === entityKey ? { ...item, note } : item,
        ),
      );
      setGithubRepositories((items) =>
        items.map((item) =>
          githubRepositoryNoteKey(item) === entityKey ? { ...item, note } : item,
        ),
      );
      return;
    }
    if (target === "skill") {
      setSkills((items) => items.map((item) => (item.id === id ? { ...item, note } : item)));
      setSkillDetail((detail) => (detail && detail.id === id ? { ...detail, note } : detail));
      return;
    }
    if (target === "plugin") {
      setPlugins((items) => items.map((item) => (item.id === id ? { ...item, note } : item)));
      setPluginDetail((detail) => (detail && detail.id === id ? { ...detail, note } : detail));
    }
  }

  async function saveItemNote(target, item, note) {
    const actionKey = noteActionKey(target, item);
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    const request =
      target === "githubRepository"
        ? {
            target,
            accountId: item.accountId,
            fullName: item.fullName,
            note,
          }
        : {
            target,
            id: item.id,
            note,
          };
    try {
      const result = desktopRuntime
        ? await api.updateItemNote(request)
        : {
            entityKey:
              target === "githubRepository"
                ? githubRepositoryNoteKey(item)
                : target === "repository"
                  ? trackedRepositoryNoteKey(item)
                  : item.id,
            note,
          };
      applyNoteUpdate(target, result.entityKey, result.note, item.id);
      showToast(t("noteSaved"));
    } catch (error) {
      showToast(error.message || t("noteSaveFailed"));
    } finally {
      setActionPending(actionKey, false);
    }
  }

  function migrationSummaryText(summary, actionLabel) {
    if (!summary || summary.cancelled) return summary?.message || "";
    return `${actionLabel}: ${summary.repositories} ${t("repositoriesTitle")}, ${summary.skills} ${t("skillsTitle")}, ${summary.plugins} ${t("pluginsTitle")}, ${summary.userNotes} ${t("notesCount")}`;
  }

  async function exportMigrationPackage() {
    const actionKey = "exportMigrationPackage";
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    try {
      const summary = await api.exportMigrationPackage();
      const message = migrationSummaryText(summary, t("exportData")) || summary.message;
      setMigrationStatus(message);
      showToast(summary.cancelled ? summary.message : t("migrationExported"));
    } catch (error) {
      showToast(error.message || t("migrationFailed"));
    } finally {
      setActionPending(actionKey, false);
    }
  }

  async function importMigrationPackage() {
    const actionKey = "importMigrationPackage";
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    try {
      const summary = await api.importMigrationPackage();
      if (!summary.cancelled) {
        await refreshDesktopState();
      }
      const message = migrationSummaryText(summary, t("importData")) || summary.message;
      setMigrationStatus(message);
      showToast(summary.cancelled ? summary.message : t("migrationImported"));
    } catch (error) {
      showToast(error.message || t("migrationFailed"));
    } finally {
      setActionPending(actionKey, false);
    }
  }

  async function addLocalRepositoryFromPicker() {
    if (!desktopRuntime) return;
    const actionKey = "addLocalRepository";
    if (isPending(actionKey)) return;
    let optimisticTaskId = "";
    try {
      const selected = await api.pickDirectory();
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      optimisticTaskId = beginOptimisticTask(actionKey, {
        kind: "Scan local repository",
        target: path,
        summary: "local repository scan started",
        log: [`scan ${path}`],
      });
      const nextRepos = await api.addLocalRepository(path);
      const [nextSkills, nextPlugins, nextTasks] = await Promise.all([
        api.listSkills(),
        api.listPlugins(),
        api.listTasks(),
      ]);
      setRepositories(nextRepos);
      setSkills(nextSkills);
      setPlugins(nextPlugins);
      setTasks(nextTasks);
      const added = nextRepos.find((repo) => repo.localPath === path) || nextRepos[0];
      if (added) {
        setSelectedRepoId(added.id);
        setInspectorRepoId(added.id);
      }
      showToast(t("localRepositoryAdded"));
      setActionPending(actionKey, false);
    } catch (error) {
      finishOptimisticTask(actionKey, optimisticTaskId);
      showToast(error.message || t("directoryInvalid"));
    }
  }

  async function confirmDeleteSkill() {
    if (!modal?.skillId) return;
    const actionKey = `deleteSkill:${modal.skillId}`;
    if (isPending(actionKey)) return;
    const skill = skills.find((item) => item.id === modal.skillId);
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Delete Skill",
      target: skill?.name || modal.skillId,
      summary: "delete Skill started",
      log: ["delete Skill started"],
    });
    if (desktopRuntime) {
      try {
        const nextSkills = await api.deleteSkill(modal.skillId);
        const nextTasks = await api.listTasks();
        setSkills(nextSkills);
        setTasks(nextTasks);
        setModal(null);
        showToast(t("skillDeleted"));
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("directoryInvalid"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    setSkills((items) => items.filter((item) => item.id !== modal.skillId));
    setModal(null);
    showToast(t("skillDeleted"));
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function restoreSkill(skillId) {
    const actionKey = `restoreSkill:${skillId}`;
    if (isPending(actionKey)) return;
    const skill = skills.find((item) => item.id === skillId);
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Restore Skill",
      target: skill?.name || skillId,
      summary: "restore Skill started",
      log: ["restore Skill started"],
    });
    if (desktopRuntime) {
      try {
        const nextSkills = await api.restoreSkill(skillId);
        const nextTasks = await api.listTasks();
        setSkills(nextSkills);
        setTasks(nextTasks);
        showToast(t("restoredSkill"));
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("directoryInvalid"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    setSkills((items) =>
      items.map((item) =>
        item.id === skillId
          ? { ...item, status: "installed-latest", installed: true, canRestore: false, canDelete: true }
          : item,
      ),
    );
    showToast(t("restoredSkill"));
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function persistSettings() {
    const actionKey = "persistSettings";
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const nextSettings = await api.updateSettings({
          backupRoot,
          skillLibraryRoot: skillsRoot,
          skillsRoot,
          defaultSyncTargets,
          syncBackupKeep,
          concurrency,
          retryCount,
          autoCheckInterval,
          autoCheckEnabled,
          autoBackupEnabled,
          cleanupKeep,
        });
        await Promise.all([
          api.configureSchedule("check", autoCheckEnabled, autoCheckInterval),
          api.configureSchedule("backup", autoBackupEnabled, Math.max(autoCheckInterval, 60)),
        ]);
        applySettings(nextSettings);
        showToast(t("settingsSaved"));
      } catch (error) {
        showToast(error.message || t("rootSaved"));
      } finally {
        setActionPending(actionKey, false);
      }
      return;
    }
    showToast(t("settingsSaved"));
    setActionPending(actionKey, false);
  }

  function githubRepoActionKey(repo) {
    return `${repo.accountId}:${repo.fullName}`;
  }

  async function saveGithubAccountToken(token) {
    const actionKey = "githubSaveToken";
    if (isPending(actionKey)) return false;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const accounts = await api.saveGithubAccountToken(token);
        setGithubAccounts(accounts);
        setActiveGithubAccountId(accounts[0]?.id || "");
        showToast(t("tokenValidated"));
        return true;
      } catch (error) {
        showToast(error.message || t("tokenSavedButValidationFailed"));
        return false;
      } finally {
        setActionPending(actionKey, false);
      }
    }
    showToast(t("tokenValidated"));
    setActionPending(actionKey, false);
    return true;
  }

  async function refreshGithubCatalog(accountId) {
    const actionKey = `githubRefresh:${accountId || "all"}`;
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const repos = await api.refreshGithubRepositories(accountId);
        if (accountId) {
          setGithubRepositories((items) => [
            ...items.filter((item) => item.accountId !== accountId),
            ...repos,
          ]);
        } else {
          setGithubRepositories(repos);
        }
        const accounts = await api.listGithubAccounts();
        setGithubAccounts(accounts);
        showToast(t("remoteRefreshed"));
      } catch (error) {
        showToast(error.message || t("sourceUnavailableToast"));
      } finally {
        setActionPending(actionKey, false);
      }
      return;
    }
    showToast(t("remoteRefreshed"));
    setActionPending(actionKey, false);
  }

  async function validateGithubAccount(accountId) {
    const actionKey = `githubValidate:${accountId}`;
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const accounts = await api.validateGithubAccount(accountId);
        setGithubAccounts(accounts);
        showToast(t("tokenValidated"));
      } catch (error) {
        showToast(error.message || t("tokenSavedButValidationFailed"));
      } finally {
        setActionPending(actionKey, false);
      }
      return;
    }
    showToast(t("tokenValidated"));
    setActionPending(actionKey, false);
  }

  async function deleteGithubAccount(accountId) {
    const account = githubAccounts.find((item) => item.id === accountId);
    if (!window.confirm(`${t("deleteAccount")}: ${account?.login || accountId}?`)) return;
    if (desktopRuntime) {
      try {
        const accounts = await api.deleteGithubAccount(accountId);
        setGithubAccounts(accounts);
        setGithubRepositories((items) => items.filter((item) => item.accountId !== accountId));
        setActiveGithubAccountId(accounts[0]?.id || "");
        showToast(t("tokenCleared"));
      } catch (error) {
        showToast(error.message || t("sourceUnavailableToast"));
      }
      return;
    }
    setGithubAccounts((items) => items.filter((item) => item.id !== accountId));
    setGithubRepositories((items) => items.filter((item) => item.accountId !== accountId));
  }

  async function toggleGithubStar(repo) {
    const actionKey = `githubStar:${githubRepoActionKey(repo)}`;
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const repos = await api.setGithubStar(repo.accountId, repo.owner, repo.repo, !repo.starred);
        setGithubRepositories((items) => [
          ...items.filter((item) => item.accountId !== repo.accountId),
          ...repos,
        ]);
        showToast(!repo.starred ? t("star") : t("unstar"));
      } catch (error) {
        showToast(error.message || t("sourceUnavailableToast"));
      } finally {
        setActionPending(actionKey, false);
      }
      return;
    }
    setGithubRepositories((items) =>
      items.map((item) =>
        githubRepoActionKey(item) === githubRepoActionKey(repo)
          ? { ...item, starred: !item.starred }
          : item,
      ),
    );
    setActionPending(actionKey, false);
  }

  async function trackGithubRepository(repo) {
    const actionKey = `githubTrack:${githubRepoActionKey(repo)}`;
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const nextRepos = await api.addRepositoryFromGithub(
          repo.accountId,
          repo.owner,
          repo.repo,
          repo.defaultBranch || "main",
        );
        const [nextSkills, nextPlugins, nextTasks, nextCatalog] = await Promise.all([
          api.listSkills(),
          api.listPlugins(),
          api.listTasks(),
          api.listGithubRepositoryCatalog(repo.accountId),
        ]);
        setRepositories(nextRepos);
        setSkills(nextSkills);
        setPlugins(nextPlugins);
        setTasks(nextTasks);
        setGithubRepositories((items) => [
          ...items.filter((item) => item.accountId !== repo.accountId),
          ...nextCatalog,
        ]);
        showToast(t("repoAddedGeneric"));
      } catch (error) {
        showToast(error.message || t("repoExists"));
      } finally {
        setActionPending(actionKey, false);
      }
      return;
    }
    setGithubRepositories((items) =>
      items.map((item) =>
        githubRepoActionKey(item) === githubRepoActionKey(repo)
          ? { ...item, trackedRepoId: `github:${item.fullName}:${item.defaultBranch || "main"}` }
          : item,
      ),
    );
    setActionPending(actionKey, false);
  }

  async function untrackGithubRepository(repo) {
    if (!repo.trackedRepoId) return;
    if (!window.confirm(`${t("untrack")}: ${repo.fullName}?`)) return;
    const actionKey = `githubTrack:${githubRepoActionKey(repo)}`;
    if (isPending(actionKey)) return;
    setActionPending(actionKey, true);
    if (desktopRuntime) {
      try {
        const nextRepos = await api.removeRepository(repo.trackedRepoId);
        const [nextSkills, nextPlugins, nextTasks, nextCatalog] = await Promise.all([
          api.listSkills(),
          api.listPlugins(),
          api.listTasks(),
          api.listGithubRepositoryCatalog(repo.accountId),
        ]);
        setRepositories(nextRepos);
        setSkills(nextSkills);
        setPlugins(nextPlugins);
        setTasks(nextTasks);
        setGithubRepositories((items) => [
          ...items.filter((item) => item.accountId !== repo.accountId),
          ...nextCatalog,
        ]);
        showToast(t("settingsSaved"));
      } catch (error) {
        showToast(error.message || t("sourceUnavailableToast"));
      } finally {
        setActionPending(actionKey, false);
      }
      return;
    }
    setGithubRepositories((items) =>
      items.map((item) =>
        githubRepoActionKey(item) === githubRepoActionKey(repo)
          ? { ...item, trackedRepoId: null }
          : item,
      ),
    );
    setActionPending(actionKey, false);
  }

  async function confirmAddRepo() {
    if (!newRepo.url.trim() || isAddingRepo) return;
    const actionKey = "addRepository";
    if (isPending(actionKey)) return;
    const requestId = Date.now();
    addRepoRequestRef.current = requestId;
    setIsAddingRepo(true);
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Scan repository",
      target: parseRepoName(newRepo.url),
      summary: "repository scan started",
      log: ["repository scan started"],
    });
    if (desktopRuntime) {
      try {
        const nextRepos = await api.addRepository({
          url: newRepo.url,
          refName: newRepo.ref || "main",
          note: newRepo.note,
        });
        const [nextSkills, nextPlugins, nextTasks] = await Promise.all([
          api.listSkills(),
          api.listPlugins(),
          api.listTasks(),
        ]);
        setRepositories(nextRepos);
        setSkills(nextSkills);
        setPlugins(nextPlugins);
        setTasks(nextTasks);
        const added = nextRepos[0];
        if (added) {
          setSelectedRepoId(added.id);
          setSelectedRows([added.id]);
        }
        if (addRepoRequestRef.current === requestId) {
          setIsAddingRepo(false);
          resetNewRepo();
          setModal(null);
          showToast(t("repoAddedGeneric"));
        }
      } catch (error) {
        if (addRepoRequestRef.current === requestId) {
          finishOptimisticTask(actionKey, optimisticTaskId);
          showToast(error.message || t("repoExists"));
          setIsAddingRepo(false);
        }
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    const name = parseRepoName(newRepo.url);
    const exists = repositories.some((repo) => repo.name === name && repo.ref === newRepo.ref);
    if (exists) {
      showToast(t("repoExists"));
      setIsAddingRepo(false);
      finishOptimisticTask(actionKey, optimisticTaskId);
      return;
    }

    const id = `repo-${Date.now()}`;
    const isSkillRepo = name.includes("skill") || name.includes("spec");
    const repo = {
      id,
      name,
      type: isSkillRepo ? "skill repo" : "generic repo",
      ref: newRepo.ref || "main",
      skills: isSkillRepo ? 1 : 0,
      remoteSha: isSkillRepo ? "9ac12ef" : "3d20a9f",
      lastBackupSha: "none",
      lastChecked: "Jun 14 10:08",
      backupStatus: "never-backed-up",
      checkStatus: "success",
      url: `https://github.com/${name}`,
      branch: newRepo.ref || "main",
      backupPath: `${backupRoot}/${name}`,
      snapshotTime: "Never",
      recognizedSkills: isSkillRepo ? [{ name: name.split("/")[1], version: "v0.1.0" }] : [],
      note: newRepo.note,
    };
    setRepositories((repos) => [repo, ...repos]);
    setSelectedRepoId(id);
    setSelectedRows([id]);
    addTask({
      kind: "Scan repository",
      target: name,
      progress: "1 / 1",
      status: "success",
      summary: isSkillRepo ? "1 Skill recognized" : "generic repo, 0 Skills",
      log: [
        `normalize ${name}`,
        "fetch remote HEAD SHA",
        isSkillRepo ? "found SKILL.md" : "no SKILL.md found; keep as generic repo",
      ],
    });
    if (addRepoRequestRef.current === requestId) {
      setIsAddingRepo(false);
      resetNewRepo();
      setModal(null);
      showToast(`${name} ${isSkillRepo ? t("repoAddedSkill") : t("repoAddedGeneric")}`);
    }
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function confirmBackup(mode, repoIds = []) {
    const actionKey = `backup:${mode}`;
    if (isPending(actionKey)) return;
    const targetRepos = backupTargetRepos(mode, repoIds);
    const targetIds = targetRepos.map((repo) => repo.id);
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Backup repositories",
      target: mode === "selected" ? "Selected repositories" : "Updated repositories",
      summary: "backup started",
      log: ["backup started"],
    });
    if (desktopRuntime) {
      try {
        const nextTasks = await api.backupRepositories(mode, mode === "selected" ? targetIds : undefined);
        const nextRepos = await api.listRepositories();
        setTasks(nextTasks);
        setRepositories(nextRepos);
        setModal(null);
        showToast(t("backupCreated"));
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("backupCreated"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    const successRepos = targetRepos.filter((repo) => repo.backupStatus !== "check-failed");
    const failedCount = targetRepos.length - successRepos.length;

    setRepositories((repos) =>
      repos.map((repo) =>
        successRepos.some((item) => item.id === repo.id)
          ? {
              ...repo,
              backupStatus: "backed-up-latest",
              lastBackupSha: repo.remoteSha,
              snapshotTime: "2026-06-14 10:12",
            }
          : repo,
      ),
    );

    addTask({
      kind: "Backup repositories",
      target: mode === "selected" ? "Selected repositories" : "Updated repositories",
      progress: `${successRepos.length} / ${targetRepos.length}`,
      status: failedCount ? "partial-success" : "success",
      summary: `${successRepos.length} success, ${failedCount} skipped`,
      log: [
        "refresh remote state before backup",
        `create ${backupRoot}/2026-06-14_101212`,
        "download ZIP files to .partial paths",
        "compute sha256 for successful ZIP files",
        "write manifest.json",
        "update last_backup_sha for successful repositories",
      ],
    });
    setModal(null);
    showToast(t("backupCreated"));
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function handleSkillAction(skill) {
    if (skill.status === "installed-latest") {
      showToast(t("noActionNeeded"));
      return;
    }
    if (skill.status === "source-unavailable") {
      showToast(t("sourceUnavailableToast"));
      return;
    }
    const actionKey = `skillAction:${skill.id}`;
    if (isPending(actionKey)) return;
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: skill.installed ? "Update Skill" : "Install Skill",
      target: skill.name,
      summary: skill.installed ? "Skill update started" : "Skill install started",
      log: [skill.installed ? "Skill update started" : "Skill install started"],
    });
    if (desktopRuntime) {
      try {
        const nextSkills = skill.installed
          ? await api.updateSkill(skill.id)
          : await api.installSkill(skill.id);
        const nextTasks = await api.listTasks();
        setSkills(nextSkills);
        setTasks(nextTasks);
        showToast(skill.installed ? `${skill.name} ${t("skillUpdated")}` : `${skill.name} ${t("installedSkill")}`);
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        if (error.code === "local_skill_modified") {
          setModal({ type: "skill-risk", skillId: skill.id });
        } else {
          showToast(error.message || t("sourceUnavailableToast"));
        }
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    if (!skill.installed) {
      setSkills((items) =>
        items.map((item) =>
          item.id === skill.id
            ? {
                ...item,
                installed: true,
                status: "installed-latest",
                localVersion: item.remoteVersion,
                updatedAt: "2026-06-14 10:18",
              }
            : item,
        ),
      );
      showToast(`${skill.name} ${t("installedSkill")}`);
      finishOptimisticTask(actionKey, optimisticTaskId);
      return;
    }
    if (skill.status === "local-modified") {
      finishOptimisticTask(actionKey, optimisticTaskId);
      setModal({ type: "skill-risk", skillId: skill.id });
      return;
    }
    setSkills((items) =>
      items.map((item) =>
        item.id === skill.id
          ? {
              ...item,
              status: "installed-latest",
              localVersion: item.remoteVersion,
              updatedAt: "2026-06-14 10:18",
            }
          : item,
      ),
    );
    addTask({
      kind: "Update Skill",
      target: skill.name,
      progress: "1 / 1",
      status: "success",
      summary: "local Skill updated",
      log: ["download remote Skill directory", "replace local files", "record installed_skill_hash"],
    });
    showToast(`${skill.name} ${t("skillUpdated")}`);
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function resolveSkillRisk(choice) {
    const skillId = modal?.skillId;
    const actionKey = `resolveSkill:${skillId}:${choice}`;
    if (!skillId || isPending(actionKey)) return;
    const skillForTask = skills.find((item) => item.id === skillId);
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Update Skill",
      target: skillForTask?.name || skillId,
      summary: "local conflict resolution started",
      log: ["local conflict resolution started"],
    });
    if (desktopRuntime) {
      try {
        const nextSkills = await api.resolveSkillLocalConflict(skillId, choice);
        const nextTasks = await api.listTasks();
        setSkills(nextSkills);
        setTasks(nextTasks);
        setModal(null);
        showToast(
          choice === "skip"
            ? t("updateSkipped")
            : choice === "backup"
              ? t("localBackupDone")
            : t("forceOverwriteDone"),
        );
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("sourceUnavailableToast"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) {
      finishOptimisticTask(actionKey, optimisticTaskId);
      return;
    }
    if (choice === "skip") {
      addTask({
        kind: "Update Skill",
        target: skill.name,
        progress: "0 / 1",
        status: "failed",
        summary: "skipped to preserve local modifications",
        log: ["local hash differs from installed_skill_hash", "user chose skip update"],
      });
      setModal(null);
      showToast(t("updateSkipped"));
      finishOptimisticTask(actionKey, optimisticTaskId);
      return;
    }
    setSkills((items) =>
      items.map((item) =>
        item.id === skill.id
          ? {
              ...item,
              status: "installed-latest",
              localVersion: item.remoteVersion,
              updatedAt: "2026-06-14 10:20",
            }
          : item,
      ),
    );
    addTask({
      kind: "Update Skill",
      target: skill.name,
      progress: "1 / 1",
      status: "success",
      summary: choice === "backup" ? "local copy backed up, then overwritten" : "force overwritten",
      log: [
        "local hash differs from installed_skill_hash",
        choice === "backup" ? "backup local Skill before overwrite" : "force overwrite local Skill",
        "record new installed_skill_hash",
      ],
    });
    setModal(null);
    showToast(
      choice === "backup"
        ? t("localBackupDone")
        : t("forceOverwriteDone"),
    );
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function retryTask(task) {
    const actionKey = `retryTask:${task.id}`;
    if (isPending(actionKey)) return;
    const optimisticTaskId = beginOptimisticTask(actionKey, {
      kind: "Retry task",
      target: task.target,
      summary: "retry task started",
      log: ["retry task started"],
    });
    if (desktopRuntime) {
      try {
        const nextTasks = await api.retryTask(task.id);
        setTasks(nextTasks);
        showToast(t("retryAdded"));
      } catch (error) {
        finishOptimisticTask(actionKey, optimisticTaskId);
        showToast(error.message || t("retryAdded"));
        return;
      }
      setActionPending(actionKey, false);
      return;
    }
    addTask({
      kind: task.kind,
      target: `${task.target} retry`,
      progress: "1 / 1",
      status: "success",
      summary: "retry completed",
      log: ["retry failed item", "complete without changing unrelated state"],
    });
    showToast(t("retryAdded"));
    finishOptimisticTask(actionKey, optimisticTaskId);
  }

  async function copyTaskSummary(task) {
    const summary = `${taskText(task.kind, language)}: ${taskText(task.summary, language)}`;
    if (desktopRuntime) {
      try {
        const backendSummary = await api.copyTaskSummary(task.id);
        await navigator.clipboard?.writeText(backendSummary);
        showToast(t("taskCopied"));
        return;
      } catch (error) {
        showToast(error.message || t("taskCopied"));
        return;
      }
    }
    await navigator.clipboard?.writeText(summary);
    showToast(t("taskCopied"));
  }

  async function openBackupFolder(path) {
    if (desktopRuntime) {
      try {
        await api.openBackupFolder(path);
        return;
      } catch (error) {
        showToast(error.message || t("sourceUnavailableToast"));
        return;
      }
    }
    showToast(t("openBackupFolder"));
  }

  async function openSkillDetail(skill) {
    const requestedSkillId = skill.id;
    skillDetailRequestRef.current = requestedSkillId;
    setSelectedSkillId(skill.id);
    setSkillDetail(null);
    setSkillDetailError("");
    if (!desktopRuntime) {
      setSkillDetail({
        ...skill,
        skillMd: `# ${skill.name}\n\n${skillDescription(skill, language) || t("noSkillMarkdown")}`,
        filePath: skill.installPath || skill.localPath || skill.path,
      });
      return;
    }
    setSkillDetailLoading(true);
    try {
      const detail = await api.getSkillDetail(skill.id);
      if (skillDetailRequestRef.current === requestedSkillId) {
        setSkillDetail(detail);
      }
    } catch (error) {
      if (skillDetailRequestRef.current === requestedSkillId) {
        setSkillDetailError(error.message || t("skillDetailUnavailable"));
      }
    } finally {
      if (skillDetailRequestRef.current === requestedSkillId) {
        setSkillDetailLoading(false);
      }
    }
  }

  async function openPluginDetail(plugin) {
    const requestedPluginId = plugin.id;
    pluginDetailRequestRef.current = requestedPluginId;
    setSelectedPluginId(plugin.id);
    setPluginDetail(null);
    setPluginDetailError("");
    if (!desktopRuntime) {
      setPluginDetail({
        ...plugin,
        linkedSkills: plugin.linkedSkills || skills.filter((skill) => skill.repoId === plugin.repoId),
      });
      return;
    }
    setPluginDetailLoading(true);
    try {
      const detail = await api.getPluginDetail(plugin.id);
      if (pluginDetailRequestRef.current === requestedPluginId) {
        setPluginDetail(detail);
      }
    } catch (error) {
      if (pluginDetailRequestRef.current === requestedPluginId) {
        setPluginDetailError(error.message || t("pluginDetailUnavailable"));
      }
    } finally {
      if (pluginDetailRequestRef.current === requestedPluginId) {
        setPluginDetailLoading(false);
      }
    }
  }

  function openPluginEntry(plugin) {
    const fullPlugin = plugins.find((item) => item.id === plugin.id) || plugin;
    setActiveTab("plugins");
    openPluginDetail(fullPlugin);
  }

  async function openGithubUrl(url: string, mode = "embedded", browserId?: string) {
    if (!url) return;
    if (mode === "embedded") {
      setModal({ type: "github-preview", url });
      return;
    }
    if (desktopRuntime) {
      try {
        await api.openUrl(url, mode, browserId);
        return;
      } catch (error) {
        showToast(error.message || t("openUrlFailed"));
        return;
      }
    }
    window.open(url, "_blank");
  }

  async function chooseBrowserForUrl(url) {
    if (!desktopRuntime) {
      window.open(url, "_blank");
      return;
    }
    try {
      const browsers = await api.listSystemBrowsers();
      setModal({ type: "browser-choice", url, browsers });
    } catch (error) {
      showToast(error.message || t("openUrlFailed"));
    }
  }

  async function copyUrl(url) {
    await navigator.clipboard?.writeText(url);
    showToast(t("urlCopied"));
  }

  async function copyInstallCommand(command) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(command);
      showToast(t("installCommandCopied"));
    } catch {
      showToast(t("copyUnavailable"));
    }
  }

  async function runScheduledCheck() {
    if (desktopRuntime) {
      try {
        const nextRepos = await api.checkRepositories();
        const [nextSkills, nextPlugins, nextTasks] = await Promise.all([
          api.listSkills(),
          api.listPlugins(),
          api.listTasks(),
        ]);
        setRepositories(nextRepos);
        setSkills(nextSkills);
        setPlugins(nextPlugins);
        setTasks(nextTasks);
      } catch (error) {
        showToast(error.message || t("sourceUnavailableToast"));
      }
      return;
    }
    await checkAllRepos();
  }

  async function runScheduledBackup() {
    if (desktopRuntime) {
      try {
        const nextTasks = await api.backupRepositories("updated");
        const nextRepos = await api.listRepositories();
        setTasks(nextTasks);
        setRepositories(nextRepos);
      } catch (error) {
        showToast(error.message || t("backupCreated"));
      }
      return;
    }
    await confirmBackup("updated");
  }

  useEffect(() => {
    if (!autoCheckEnabled) {
      setNextAutoCheckAt(null);
      return undefined;
    }
    const intervalMs = Math.max(autoCheckInterval, 15) * 60 * 1000;
    const setNextRun = () => setNextAutoCheckAt(new Date(Date.now() + intervalMs));
    setNextRun();
    const timer = window.setInterval(async () => {
      await runScheduledCheck();
      setNextRun();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoCheckEnabled, autoCheckInterval, desktopRuntime]);

  useEffect(() => {
    if (!autoBackupEnabled) {
      setNextAutoBackupAt(null);
      return undefined;
    }
    const intervalMs = Math.max(autoCheckInterval, 60) * 60 * 1000;
    const setNextRun = () => setNextAutoBackupAt(new Date(Date.now() + intervalMs));
    setNextRun();
    const timer = window.setInterval(async () => {
      await runScheduledBackup();
      setNextRun();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoBackupEnabled, autoCheckInterval, desktopRuntime]);

  useEffect(() => {
    function handleEscape(event) {
      if (event.key === "Escape" && !modal) {
        closeActiveInspector();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [modal]);

  function handleWorkspaceMouseDown(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (shouldIgnoreInspectorDismiss(target)) return;
    closeActiveInspector();
  }

  return (
    <main className="app-shell" data-theme={theme} data-density={density}>
      <aside className="sidebar">
        <div className="brand">
          <strong>Skill Repo Tracker</strong>
          <span>{t("localCare")}</span>
        </div>
        <nav className="nav-list" aria-label="Primary">
          {navItems.map((item) => (
            <button
              className={`nav-item ${activeTab === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              type="button"
            >
              <span className={`nav-mark nav-mark-${item.id}`} />
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        <section className="sidebar-section">
          <h3>{t("summary")}</h3>
          <Metric label={t("totalRepositories")} value={counts.total} />
          <Metric label={t("skillRepositories")} value={counts.skill} />
          <Metric label={t("genericRepositories")} value={counts.generic} />
          <Metric label={t("unknownType")} value={counts.unknown} />
        </section>

        <section className="sidebar-section">
          <h3>{t("backupStatus")}</h3>
          <Legend tone="green" label={t("backedLatest")} value={counts.backed} />
          <Legend tone="orange" label={t("updatedNotBacked")} value={counts.updated} />
          <Legend tone="red" label={t("checkFailed")} value={counts.failed} />
          <Legend tone="gray" label={t("unknown")} value={counts.unknown} />
        </section>

      </aside>

      <section
        className={`workspace ${activeTab === "settings" || activeTab === "github" ? "settings-workspace" : ""}`}
        onMouseDown={
          activeTab === "repositories" || activeTab === "skills" || activeTab === "plugins"
            ? handleWorkspaceMouseDown
            : undefined
        }
      >
        {activeTab !== "settings" && activeTab !== "github" && (
          <Toolbar
            activeTab={activeTab}
            search={search}
            setSearch={setSearch}
            skillSearch={skillSearch}
            setSkillSearch={setSkillSearch}
            pluginSearch={pluginSearch}
            setPluginSearch={setPluginSearch}
            checkAllRepos={checkAllRepos}
            setModal={setModal}
            openAddRepoModal={openAddRepoModal}
            selectedRows={selectedRows}
            repositories={repositories}
            skills={skills}
            plugins={plugins}
            tasks={tasks}
            scanLocalSkills={scanLocalSkills}
            addLocalRepositoryFromPicker={addLocalRepositoryFromPicker}
            isPending={isPending}
            language={language}
            t={t}
          />
        )}

        <div
          className={`content-grid ${
            (activeTab === "repositories" && inspectorRepo) ||
            (activeTab === "skills" && selectedSkill) ||
            (activeTab === "plugins" && selectedPlugin)
              ? ""
              : "no-inspector"
          }`}
        >
          {activeTab === "repositories" && (
            <RepositoriesView
              repos={filteredRepos}
              selectedRepo={inspectorRepo}
              selectedRows={selectedRows}
              selectAllVisible={selectAllVisible}
              toggleRow={toggleRow}
              setSelectedRepoId={setSelectedRepoId}
              setInspectorRepoId={setInspectorRepoId}
              repoFilter={repoFilter}
              setRepoFilter={setRepoFilter}
              repoSort={repoSort}
              setRepoSort={setRepoSort}
              setModal={setModal}
              openAddRepoModal={openAddRepoModal}
              hasRepositories={repositories.length > 0}
              language={language}
              t={t}
            />
          )}

          {activeTab === "github" && (
            <GitHubWorkbench
              accounts={githubAccounts}
              repositories={githubRepositories}
              activeAccountId={activeGithubAccountId}
              setActiveAccountId={setActiveGithubAccountId}
              isPending={isPending}
              onOpenAddAccount={() => setModal({ type: "github-account-token" })}
              onRefresh={refreshGithubCatalog}
              onValidateAccount={validateGithubAccount}
              onDeleteAccount={deleteGithubAccount}
              onToggleStar={toggleGithubStar}
              onTrackRepository={trackGithubRepository}
              onUntrackRepository={untrackGithubRepository}
              onOpenUrl={openGithubUrl}
              onCopyUrl={copyUrl}
              onSaveNote={(repo, note) => saveItemNote("githubRepository", repo, note)}
              t={t}
            />
          )}

          {activeTab === "skills" && (
            <SkillsView
              skills={filteredSkills}
              skillFilter={skillFilter}
              setSkillFilter={setSkillFilter}
              skillSort={skillSort}
              setSkillSort={setSkillSort}
              handleSkillAction={handleSkillAction}
              openSkillDetail={openSkillDetail}
              setActiveTab={setActiveTab}
              setSelectedRepoId={setSelectedRepoId}
              setInspectorRepoId={setInspectorRepoId}
              setModal={setModal}
              restoreSkill={restoreSkill}
              repositories={repositories}
              availableSyncTargets={availableSyncTargets}
              hasSkills={skills.length > 0}
              hasInspector={Boolean(selectedSkill)}
              selectedSkillId={selectedSkillId}
              skillRepoQuery={skillRepoQuery}
              setSkillRepoQuery={setSkillRepoQuery}
              isPending={isPending}
              language={language}
              t={t}
            />
          )}

          {activeTab === "plugins" && (
            <PluginsView
              plugins={filteredPlugins}
              openPluginDetail={openPluginDetail}
              setActiveTab={setActiveTab}
              setSelectedRepoId={setSelectedRepoId}
              setInspectorRepoId={setInspectorRepoId}
              hasPlugins={plugins.length > 0}
              hasInspector={Boolean(selectedPlugin)}
              selectedPluginId={selectedPluginId}
              focusPluginRow={demoFocus === "plugin-row"}
              pluginSort={pluginSort}
              setPluginSort={setPluginSort}
              language={language}
              t={t}
              Tag={Tag}
              EmptyState={EmptyState}
              displayRepoName={displayRepoName}
              displayValue={displayValue}
              manifestShaPreview={manifestShaPreview}
            />
          )}

          {activeTab === "tasks" && (
            <TasksView
              tasks={filteredTasks}
              taskFilter={taskFilter}
              setTaskFilter={setTaskFilter}
              retryTask={retryTask}
              copyTaskSummary={copyTaskSummary}
              isPending={isPending}
              hasTasks={tasks.length > 0}
              language={language}
              t={t}
            />
          )}

          {activeTab === "settings" && (
            <SettingsView
              {...settingsProps}
            />
          )}

          {activeTab === "repositories" && inspectorRepo && (
            <Inspector
              key={inspectorRepo.id}
              repo={inspectorRepo}
              setActiveTab={setActiveTab}
              setModal={setModal}
              onClose={closeActiveInspector}
              desktopRuntime={desktopRuntime}
              openBackupFolder={openBackupFolder}
              openGithubUrl={openGithubUrl}
              chooseBrowserForUrl={chooseBrowserForUrl}
              copyUrl={copyUrl}
              openPluginDetail={openPluginEntry}
              onSaveNote={(repo, note) => saveItemNote("repository", repo, note)}
              isPending={isPending}
              language={language}
              t={t}
            />
          )}
          {activeTab === "skills" && selectedSkill && (
            <SkillInspector
              skill={selectedSkill}
              detail={skillDetail}
              loading={skillDetailLoading}
              error={skillDetailError}
              onClose={closeActiveInspector}
              setActiveTab={setActiveTab}
              setSelectedRepoId={setSelectedRepoId}
              setInspectorRepoId={setInspectorRepoId}
              repositories={repositories}
              availableSyncTargets={availableSyncTargets}
              defaultSyncTargets={defaultSyncTargets}
              updateSkillSyncTargets={updateSkillSyncTargets}
              isPending={isPending}
              openPluginDetail={openPluginEntry}
              onSaveNote={(skill, note) => saveItemNote("skill", skill, note)}
              language={language}
              t={t}
            />
          )}
          {activeTab === "plugins" && selectedPlugin && (
            <PluginInspector
              plugin={selectedPlugin}
              detail={pluginDetail}
              loading={pluginDetailLoading}
              error={pluginDetailError}
              onClose={closeActiveInspector}
              setActiveTab={setActiveTab}
              setSelectedRepoId={setSelectedRepoId}
              setInspectorRepoId={setInspectorRepoId}
              openSkillDetail={openSkillDetail}
              copyInstallCommand={copyInstallCommand}
              onSaveNote={(plugin, note) => saveItemNote("plugin", plugin, note)}
              isPending={isPending}
              skills={skills}
              repositories={repositories}
              language={language}
              t={t}
              Tag={Tag}
              Button={Button}
              Section={Section}
              Detail={Detail}
              displayRepoName={displayRepoName}
              displayValue={displayValue}
              statusLabel={statusLabel}
            />
          )}
        </div>

        {activeTab !== "settings" && activeTab !== "github" && (
          <RunningTask tasks={tasks} setActiveTab={setActiveTab} language={language} t={t} />
        )}
      </section>

      <footer className="statusbar">
        <span className="system-ok" />
        <span>{t("allSystems")}</span>
        <span className="status-divider" />
        <span>{t("localBackupRoot")}</span>
        <strong>{backupRoot}</strong>
        <Button variant="flat" onClick={() => setActiveTab("settings")}>
          {t("change")}
        </Button>
        <span className="status-spacer" />
        <span>{t("lastChecked")}: 2026-06-14 10:04</span>
        <span className="status-divider" />
        <span>
          {autoCheckEnabled
            ? language === "zh"
              ? `${t("autoCheckForeground")} ${autoCheckInterval} 分钟`
              : `${t("autoCheckForeground")} ${autoCheckInterval} min`
            : t("autoCheckDisabled")}
        </span>
        {(nextAutoCheckAt || nextAutoBackupAt) && (
          <span>
            {t("nextRun")}: {formatNextRun(nextAutoCheckAt || nextAutoBackupAt, language)}
          </span>
        )}
      </footer>

      {modal?.type === "add" && (
        <AddRepoModal
          newRepo={newRepo}
          setNewRepo={setNewRepo}
          onClose={closeAddRepoModal}
          onConfirm={confirmAddRepo}
          loading={isAddingRepo}
          t={t}
        />
      )}

      {modal?.type === "backup" && (
        <BackupModal
          targetRepos={backupTargetRepos(modal.mode || "updated", modal.repoIds || [])}
          backupRoot={backupRoot}
          onClose={() => setModal(null)}
          onConfirm={() => confirmBackup(modal.mode || "updated", modal.repoIds || [])}
          mode={modal.mode || "updated"}
          pending={isPending(`backup:${modal.mode || "updated"}`)}
          language={language}
          t={t}
        />
      )}

      {modal?.type === "github-account-token" && (
        <GitHubAccountTokenModal
          onClose={() => setModal(null)}
          onSaveToken={saveGithubAccountToken}
          pending={isPending("githubSaveToken")}
          t={t}
        />
      )}

      {modal?.type === "skill-risk" && (
        <SkillRiskModal
          skill={skills.find((item) => item.id === modal.skillId)}
          onClose={() => setModal(null)}
          onResolve={resolveSkillRisk}
          isPending={isPending}
          t={t}
        />
      )}

      {modal?.type === "delete-skill" && (
        <DeleteSkillModal
          skill={skills.find((item) => item.id === modal.skillId)}
          onClose={() => setModal(null)}
          onConfirm={confirmDeleteSkill}
          isPending={isPending}
          t={t}
        />
      )}

      {modal?.type === "settings" && (
        <PreferencesModal onClose={() => setModal(null)} {...settingsProps} />
      )}

      {modal?.type === "browser-choice" && (
        <BrowserChoiceModal
          browsers={modal.browsers || []}
          url={modal.url}
          onClose={() => setModal(null)}
          onOpen={async (mode, browserId) => {
            const url = modal.url;
            setModal(null);
            await openGithubUrl(url, mode, browserId);
          }}
          onCopy={copyUrl}
          t={t}
        />
      )}

      {modal?.type === "github-preview" && (
        <GithubPreviewModal
          url={modal.url}
          onClose={() => setModal(null)}
          onCopy={copyUrl}
          onOpenExternal={openGithubUrl}
          onChooseBrowser={chooseBrowserForUrl}
          t={t}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Legend({ tone, label, value }) {
  return (
    <div className="legend-row">
      <span className={`legend-dot ${tone}`} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyState({ title, body, actionLabel, onAction }: any) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">+</div>
      <h2>{title}</h2>
      <p>{body}</p>
      {actionLabel && onAction && (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

function Toolbar({
  activeTab,
  search,
  setSearch,
  skillSearch,
  setSkillSearch,
  pluginSearch,
  setPluginSearch,
  checkAllRepos,
  setModal,
  openAddRepoModal,
  selectedRows,
  repositories,
  skills,
  plugins,
  tasks,
  scanLocalSkills,
  addLocalRepositoryFromPicker,
  isPending,
  language,
  t,
}: any) {
  const titleKey = navItems.find((item) => item.id === activeTab)?.labelKey || "nav.repositories";
  const needsBackup = repositories.filter((repo) =>
    repo.sourceType !== "local" && ["updated-not-backed-up", "never-backed-up"].includes(repo.backupStatus),
  ).length;
  const selectedBackupable = repositories.some((repo) => selectedRows.includes(repo.id) && repo.sourceType !== "local");
  const updatedSkills = skills.filter((skill) =>
    ["update-available", "local-modified", "source-unavailable"].includes(skill.status),
  ).length;
  const detectedPlugins = plugins.filter((plugin) => plugin.status === "detected").length;
  const failedTasks = tasks.filter((task) => ["failed", "interrupted", "partial-success"].includes(task.status)).length;

  return (
    <header className="toolbar">
      {activeTab === "repositories" && (
        <div className="toolbar-group">
          <Button
            onClick={checkAllRepos}
            pending={isPending("checkAllRepos")}
            pendingLabel={t("checking")}
          >
            {t("checkAll")}
          </Button>
          <Button onClick={() => setModal({ type: "backup", mode: "updated" })} disabled={!needsBackup}>
            {t("backupUpdated")}
          </Button>
          <Button
            onClick={() => setModal({ type: "backup", mode: "selected", repoIds: selectedRows })}
            disabled={!selectedBackupable}
          >
            {t("backupSelected")}
          </Button>
          <Button variant="primary" onClick={openAddRepoModal}>
            {t("addRepository")}
          </Button>
        </div>
      )}
      {activeTab === "skills" && (
        <div className="toolbar-group">
          <Button
            onClick={checkAllRepos}
            pending={isPending("checkAllRepos")}
            pendingLabel={t("checking")}
          >
            {t("rescanSources")}
          </Button>
          <Button
            onClick={scanLocalSkills}
            pending={isPending("scanLocalSkills")}
            pendingLabel={t("scanning")}
          >
            {t("scanLocalSkills")}
          </Button>
          <Button
            onClick={addLocalRepositoryFromPicker}
            pending={isPending("addLocalRepository")}
            pendingLabel={t("adding")}
          >
            {t("addLocalRepository")}
          </Button>
          <Button onClick={openAddRepoModal}>{t("addRepository")}</Button>
        </div>
      )}
      {activeTab === "plugins" && (
        <div className="toolbar-group">
          <Button
            onClick={checkAllRepos}
            pending={isPending("checkAllRepos")}
            pendingLabel={t("checking")}
          >
            {t("rescanSources")}
          </Button>
        </div>
      )}
      {activeTab === "tasks" && (
        <div className="toolbar-group muted-toolbar">
          <span>{t("taskAudit")}</span>
        </div>
      )}
      {activeTab === "settings" && <div className="toolbar-group muted-toolbar" />}
      <div className="toolbar-meta">
        {activeTab !== "settings" && <span>{t(titleKey)}</span>}
        {activeTab === "repositories" && <span>{needsBackup} {t("needBackup")}</span>}
        {activeTab === "skills" && (
          <span>
            {isPending("scanLocalSkills") ? t("scanning") : `${updatedSkills} ${t("updateAvailable")}`}
          </span>
        )}
        {activeTab === "plugins" && <span>{detectedPlugins} {t("pluginInstallEntries")}</span>}
        {activeTab === "tasks" && <span>{failedTasks} {t("failed")}</span>}
      </div>
      {activeTab === "repositories" && (
        <label className="search-field">
          <span>{t("search")}</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchRepositories")}
          />
        </label>
      )}
      {activeTab === "skills" && (
        <label className="search-field">
          <span>{t("search")}</span>
          <input
            value={skillSearch}
            onChange={(event) => setSkillSearch(event.target.value)}
            placeholder={t("searchSkills")}
          />
        </label>
      )}
      {activeTab === "plugins" && (
        <label className="search-field">
          <span>{t("search")}</span>
          <input
            value={pluginSearch}
            onChange={(event) => setPluginSearch(event.target.value)}
            placeholder={t("searchPlugins")}
          />
        </label>
      )}
    </header>
  );
}

function RepositoriesView({
  repos,
  selectedRepo,
  selectedRows,
  selectAllVisible,
  toggleRow,
  setSelectedRepoId,
  setInspectorRepoId,
  repoFilter,
  setRepoFilter,
  repoSort,
  setRepoSort,
  setModal,
  openAddRepoModal,
  hasRepositories,
  language,
  t,
}: any) {
  const filters = [
    ["all", t("all")],
    ["skill", t("skillRepos")],
    ["generic", t("generic")],
    ["updated", t("updated")],
    ["never", t("neverBacked")],
    ["failed", t("checkFailed")],
  ];

  function toggleSort(key) {
    setRepoSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
    <section className="main-pane">
      <div className="pane-header">
        <div>
          <h1>{t("repositoriesTitle")}</h1>
          <p>{t("repositoriesSubtitle")}</p>
        </div>
        <div className="segmented" role="group" aria-label={t("repositoriesTitle")}>
          {filters.map(([id, label]) => (
            <button
              aria-pressed={repoFilter === id}
              className={repoFilter === id ? "selected" : ""}
              key={id}
              onClick={() => setRepoFilter(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="table-frame">
        {repos.length ? (
          <table className="data-table repositories-table">
            <thead>
              <tr>
                <th className="select-cell">
                  <input
                    aria-label={t("allRepositories")}
                    checked={repos.length > 0 && repos.every((repo) => selectedRows.includes(repo.id))}
                    onChange={selectAllVisible}
                    type="checkbox"
                  />
                </th>
                <th>
                  <button className="table-sort-button" onClick={() => toggleSort("name")} type="button">
                    {t("repository")}{sortIndicator(repoSort.key === "name", repoSort.direction)}
                  </button>
                </th>
                <th>{t("type")}</th>
                <th>
                  <button className="table-sort-button" onClick={() => toggleSort("addedAt")} type="button">
                    {t("addedAt")}{sortIndicator(repoSort.key === "addedAt", repoSort.direction)}
                  </button>
                </th>
                <th>{t("ref")}</th>
                <th>{t("skills")}</th>
                <th>{t("remoteSha")}</th>
                <th>{t("lastBackup")}</th>
                <th>{t("checkStatusLabel")}</th>
                <th>{t("backupStatus")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => {
                const repoName = displayRepoName(repo.name, language);
                const rowActive = selectedRepo?.id === repo.id;
                const rowChecked = selectedRows.includes(repo.id);
                const remoteSha = displayValue(repo.remoteSha, language);
                const lastBackupSha = displayValue(repo.lastBackupSha, language);
                return (
                  <tr
                    aria-selected={rowActive}
                    className={`${rowActive ? "active-row" : ""} ${rowChecked ? "checked-row" : ""}`.trim()}
                    key={repo.id}
                    onClick={() => {
                      setSelectedRepoId(repo.id);
                      setInspectorRepoId(repo.id);
                    }}
                  >
                    <td className="select-cell" onClick={(event) => event.stopPropagation()}>
                      <input
                        aria-label={`${t("repository")}: ${repoName}`}
                        checked={rowChecked}
                        onChange={() => toggleRow(repo.id)}
                        type="checkbox"
                      />
                    </td>
                    <td title={repoName}>
                      <strong>{repoName}</strong>
                      {repo.note && <span className="subtext note-preview">{repo.note}</span>}
                    </td>
                    <td>
                      <Tag value={repo.type} language={language} />
                    </td>
                    <td className="mono">{repo.addedAt || "-"}</td>
                    <td>{repo.ref}</td>
                    <td>{repo.skills}</td>
                    <td className="mono" title={remoteSha}>{remoteSha}</td>
                    <td className="mono" title={lastBackupSha}>{lastBackupSha}</td>
                    <td>
                      <Tag value={repo.checkStatus || "unknown"} language={language} />
                    </td>
                    <td>
                      <Tag value={repo.backupStatus} language={language} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          aria-label={`${t("backup")}: ${repoName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedRepoId(repo.id);
                            setModal({ type: "backup", mode: "selected", repoIds: [repo.id] });
                          }}
                          disabled={repo.sourceType === "local"}
                          title={`${t("backup")}: ${repoName}`}
                          type="button"
                        >
                          {t("backup")}
                        </button>
                        <button
                          aria-label={`${t("more")}: ${repoName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedRepoId(repo.id);
                            setInspectorRepoId(repo.id);
                          }}
                          title={`${t("more")}: ${repoName}`}
                          type="button"
                        >
                          {t("more")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title={hasRepositories ? t("noFilteredRepositoriesTitle") : t("firstRepositoryTitle")}
            body={hasRepositories ? t("noFilteredRepositoriesText") : t("firstRepositoryText")}
            actionLabel={t("addRepository")}
            onAction={openAddRepoModal}
          />
        )}
      </div>
    </section>
  );
}

function Inspector({
  repo,
  setActiveTab,
  setModal,
  onClose,
  openBackupFolder,
  openGithubUrl,
  chooseBrowserForUrl,
  copyUrl,
  openPluginDetail,
  onSaveNote,
  isPending,
  language,
  t,
}: any) {
  if (!repo) return null;
  const [readmeOpen, setReadmeOpen] = useState(false);
  const [readme, setReadme] = useState(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [readmeError, setReadmeError] = useState("");
  const [noteDraft, setNoteDraft] = useState(repo.note || "");
  const hasManifest =
    repo.lastBackupSha &&
    !["none", "unknown"].includes(repo.lastBackupSha) &&
    repo.backupPath &&
    repo.backupPath !== "Unavailable";
  const zipPath = hasManifest
    ? `${repo.backupPath}/${repo.ref}-${repo.lastBackupSha}.zip`
    : "";
  const manifestPath = hasManifest ? `${repo.backupPath}/manifest.json` : "";

  useEffect(() => {
    setReadmeOpen(false);
    setReadme(null);
    setReadmeError("");
    setNoteDraft(repo.note || "");
  }, [repo.id]);

  useEffect(() => {
    setNoteDraft(repo.note || "");
  }, [repo.note]);

  async function loadReadme() {
    setReadmeOpen(true);
    if (readme || readmeLoading) return;
    setReadmeError("");
    setReadmeLoading(true);
    try {
      const nextReadme = await api.getRepositoryReadme(repo.id);
      setReadme(nextReadme);
    } catch (error) {
      setReadmeError(error.message || t("readmeUnavailable"));
    } finally {
      setReadmeLoading(false);
    }
  }

  return (
    <aside className="inspector">
      <header className="inspector-title">
        <div>
          <h2>{displayRepoName(repo.name, language)}</h2>
          <Tag value={repo.type} language={language} />
        </div>
        <button className="icon-button" onClick={onClose} type="button" aria-label={t("close")}>
          x
        </button>
      </header>

      <Section title={t("source")}>
        <Detail label={repo.sourceType === "local" ? t("localSource") : t("sourceUrl")} value={repo.localPath || repo.url} link={repo.sourceType !== "local"} />
        <Detail label={t("defaultBranch")} value={repo.branch} />
        <Detail label={t("remoteRevision")} value={displayValue(repo.remoteSha, language)} mono />
        <div className="inline-action-row">
          <Button onClick={loadReadme}>{readmeOpen ? t("refreshReadme") : t("viewReadme")}</Button>
        </div>
        {readmeOpen && (
          <div className="markdown-preview-block">
            {readmeLoading && <p className="empty-note">{t("loading")}</p>}
            {readmeError && <p className="empty-note error-note">{readmeError}</p>}
            {readme && (
              <>
                <div className="preview-meta mono">{readme.sourcePath}</div>
                <pre>{readme.readme}</pre>
              </>
            )}
          </div>
        )}
      </Section>

      <Section title={t("backupSnapshot")}>
        <Detail label={t("lastBackupSha")} value={displayValue(repo.lastBackupSha, language)} mono />
        <Detail label={t("remoteSha")} value={displayValue(repo.remoteSha, language)} mono />
        <Detail label={t("checkStatusLabel")} value={<Tag value={repo.checkStatus || "unknown"} language={language} />} />
        <Detail
          label={t("backupStatus")}
          value={<Tag value={repo.backupStatus} language={language} />}
        />
        <Detail label={t("backupPath")} value={displayValue(repo.backupPath, language)} />
        <Detail label={t("snapshotTime")} value={displayValue(repo.snapshotTime, language)} />
      </Section>

      <Section title={`${t("recognizedSkills")} (${repo.recognizedSkills.length})`}>
        {repo.recognizedSkills.length ? (
          <div className="skill-list-mini">
            {repo.recognizedSkills.map((skill, index) => (
              <div className="mini-skill" key={`${repo.id}:${skill.id || skill.path || `${skill.name}:${skill.version}:${index}`}`}>
                <span className="health-dot" />
                <span>{skill.name}</span>
                <code>{skill.version}</code>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-note">{t("noSkillsFound")}</p>
        )}
        <Button variant="wide" onClick={() => setActiveTab("skills")}>
          {t("openSkillsManager")}
        </Button>
      </Section>

      <Section title={t("note")}>
        <NoteEditor
          actionKey={`note:repository:${repo.id}`}
          isPending={isPending}
          note={noteDraft}
          onChange={setNoteDraft}
          onClear={() => {
            setNoteDraft("");
            onSaveNote(repo, "");
          }}
          onSave={() => onSaveNote(repo, noteDraft)}
          t={t}
        />
      </Section>

      <Section title={`${t("recognizedPlugins")} (${(repo.recognizedPlugins || []).length})`}>
        {(repo.recognizedPlugins || []).length ? (
          <div className="skill-list-mini">
            {(repo.recognizedPlugins || []).map((plugin) => (
              <button
                className="mini-skill mini-skill-button"
                key={plugin.id}
                onClick={() => openPluginDetail(plugin)}
                type="button"
              >
                <span className="health-dot" />
                <span>{plugin.name}</span>
                <code>{statusLabel(plugin.kind, language)}</code>
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-note">{t("noPluginsFound")}</p>
        )}
        <Button variant="wide" onClick={() => setActiveTab("plugins")}>
          {t("openPluginsManager")}
        </Button>
      </Section>

      <Section title={t("quickActions")}>
        <div className="action-grid">
          <Button onClick={() => setModal({ type: "backup", mode: "selected", repoIds: [repo.id] })} disabled={repo.sourceType === "local"}>
            {t("backupNow")}
          </Button>
          <Button onClick={() => openBackupFolder(repo.backupPath)} disabled={!hasManifest}>{t("openBackupFolder")}</Button>
          {repo.sourceType !== "local" && (
            <Button onClick={() => openGithubUrl(repo.url, "embedded")}>{t("viewGithub")}</Button>
          )}
          {repo.sourceType !== "local" && (
            <Button onClick={() => chooseBrowserForUrl(repo.url)}>{t("chooseBrowser")}</Button>
          )}
          <Button onClick={() => setActiveTab("skills")}>{t("openSkillsManager")}</Button>
          {repo.sourceType !== "local" && (
            <Button onClick={() => copyUrl(repo.url)}>{t("copyLink")}</Button>
          )}
          <Button className="full" onClick={() => setActiveTab("tasks")}>
            {t("backupHistory")}
          </Button>
        </div>
      </Section>

      <Section title={t("backupAudit")}>
        {hasManifest ? (
          <div className="manifest-summary">
            <Detail label={t("latestManifest")} value={repo.snapshotTime} />
            <Detail label={t("zipPath")} value={zipPath} mono />
            <Detail label={t("sha256")} value={manifestShaPreview(repo.lastBackupSha)} mono />
            <Detail label={t("manifestPath")} value={manifestPath} mono />
          </div>
        ) : (
          <p className="empty-note">{t("noManifest")}</p>
        )}
      </Section>
    </aside>
  );
}

function Section({ title, children }: any) {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Detail({ label, value, mono, link }: any) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      {typeof value === "string" ? (
        <strong className={mono ? "mono" : ""}>{link ? <a href="#source">{value}</a> : value}</strong>
      ) : (
        <strong>{value}</strong>
      )}
    </div>
  );
}

function NoteEditor({ actionKey, isPending, note, onChange, onClear, onSave, t }: any) {
  const pending = isPending?.(actionKey);
  return (
    <div className="note-editor">
      <textarea
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("notePlaceholder")}
        value={note}
      />
      <div className="inline-action-row">
        <Button disabled={pending} onClick={onSave} variant="primary">
          {pending ? t("saving") : t("saveNote")}
        </Button>
        <Button disabled={!note || pending} onClick={onClear}>
          {t("clearNote")}
        </Button>
      </div>
    </div>
  );
}

function SkillsView({
  skills,
  skillFilter,
  setSkillFilter,
  skillSort,
  setSkillSort,
  skillRepoQuery,
  setSkillRepoQuery,
  handleSkillAction,
  openSkillDetail,
  setActiveTab,
  setSelectedRepoId,
  setInspectorRepoId,
  setModal,
  restoreSkill,
  repositories,
  availableSyncTargets,
  hasSkills,
  hasInspector,
  selectedSkillId,
  isPending,
  language,
  t,
}: any) {
  const filters = [
    ["all", t("all")],
    ["not-installed", t("notInstalled")],
    ["installed-latest", t("latest")],
    ["update-available", t("updateAvailable")],
    ["local-modified", t("localModified")],
    ["source-unavailable", t("sourceUnavailable")],
    ["deleted", t("deletedSkills")],
  ];

  function toggleSort(key) {
    setSkillSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  function jumpToRepo(skill) {
    const repo = repositories.find((item) => displayRepoName(item.name, language) === displayRepoName(skill.repo, language));
    if (repo) {
      setSelectedRepoId(repo.id);
      setInspectorRepoId(repo.id);
    }
    setActiveTab("repositories");
  }

  function skillPrimaryAction(skill) {
    if (skill.status === "deleted") {
      return {
        label: t("restoreSkill"),
        disabled: !skill.canRestore,
        handler: () => restoreSkill(skill.id),
      };
    }
    if (skill.status === "installed-latest") {
      return { label: t("noActionNeeded"), disabled: true, handler: null };
    }
    if (skill.status === "source-unavailable") {
      return { label: t("recheckSource"), disabled: false, handler: () => jumpToRepo(skill) };
    }
    return {
      label: skill.installed ? t("update") : t("install"),
      disabled: false,
      handler: () => handleSkillAction(skill),
    };
  }

  return (
    <section className={`main-pane has-subfilter ${hasInspector ? "" : "single"}`}>
      <div className="pane-header">
        <div>
          <h1>{t("skillsTitle")}</h1>
          <p>{t("skillsSubtitle")}</p>
        </div>
        <div className="segmented" role="group" aria-label={t("skillsTitle")}>
          {filters.map(([id, label]) => (
            <button
              aria-pressed={skillFilter === id}
              className={skillFilter === id ? "selected" : ""}
              key={id}
              onClick={() => setSkillFilter(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="skill-source-filter">
        <label className="mini-search-field">
          <span>{t("sourceRepositoryFilter")}</span>
          <input
            value={skillRepoQuery}
            onChange={(event) => setSkillRepoQuery(event.target.value)}
            placeholder={t("searchRepository")}
          />
        </label>
      </div>

      <div className="table-frame">
        {skills.length ? (
          <table className="data-table skills-table">
            <thead>
              <tr>
                <th>
                  <button className="table-sort-button" onClick={() => toggleSort("name")} type="button">
                    {t("skill")}{sortIndicator(skillSort.key === "name", skillSort.direction)}
                  </button>
                </th>
                <th>{t("source")}</th>
                <th>{t("sourceRepository")}</th>
                <th>
                  <button className="table-sort-button" onClick={() => toggleSort("createdAt")} type="button">
                    {t("createdAt")}{sortIndicator(skillSort.key === "createdAt", skillSort.direction)}
                  </button>
                </th>
                <th>{t("path")}</th>
                <th>{t("version")}</th>
                <th>{t("status")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => {
                const primaryAction = skillPrimaryAction(skill);
                return (
                  <tr
                    className={skill.id === selectedSkillId ? "active-row" : ""}
                    key={skill.id}
                    onClick={() => openSkillDetail(skill)}
                  >
                    <td>
                      <strong>{skill.name}</strong>
                      <span className="subtext">{skillDescription(skill, language)}</span>
                      {skill.note && <span className="subtext note-preview">{skill.note}</span>}
                      <span className="subtext">
                        {t("syncTargets")}: {syncTargetSummary(skill.resolvedSyncTargets || [], availableSyncTargets, language)}
                      </span>
                    </td>
                    <td>
                      <Tag value={sourceLabel(skill, language)} tone="source-chip" language={language} />
                    </td>
                    <td className="source-repo-cell" title={displayRepoName(skill.repo, language)}>
                      {displayRepoName(skill.repo, language)}
                    </td>
                    <td className="mono">{skill.createdAt || "-"}</td>
                    <td className="mono" title={skill.path}>{skill.path}</td>
                    <td className="mono" title={versionSummary(skill, language)}>{versionSummary(skill, language)}</td>
                    <td>
                      <Tag value={skill.status} language={language} />
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <div className="row-actions">
                        <button
                          aria-label={`${primaryAction.label}: ${skill.name}`}
                          disabled={
                            primaryAction.disabled ||
                            isPending(`skillAction:${skill.id}`) ||
                            isPending(`restoreSkill:${skill.id}`)
                          }
                          onClick={primaryAction.handler || undefined}
                          title={`${primaryAction.label}: ${skill.name}`}
                          type="button"
                        >
                          {isPending(`skillAction:${skill.id}`)
                            ? skill.installed
                              ? t("updating")
                              : t("installing")
                            : isPending(`restoreSkill:${skill.id}`)
                              ? t("restoring")
                              : primaryAction.label}
                        </button>
                        <button
                          aria-label={`${t("source")}: ${skill.name}`}
                          onClick={() => jumpToRepo(skill)}
                          title={`${t("source")}: ${skill.name}`}
                          type="button"
                        >
                          {t("source")}
                        </button>
                        {skill.canDelete && (
                          <button
                            aria-label={`${t("deleteSkill")}: ${skill.name}`}
                            disabled={isPending(`deleteSkill:${skill.id}`)}
                            onClick={() => setModal({ type: "delete-skill", skillId: skill.id })}
                            title={`${t("deleteSkill")}: ${skill.name}`}
                            type="button"
                          >
                            {isPending(`deleteSkill:${skill.id}`) ? t("deleting") : t("deleteSkill")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title={hasSkills ? t("noFilteredSkillsTitle") : t("firstSkillTitle")}
            body={hasSkills ? t("noFilteredSkillsText") : t("firstSkillText")}
            actionLabel={t("rescanSources")}
            onAction={() => setActiveTab("repositories")}
          />
        )}
      </div>
    </section>
  );
}

function SkillInspector({
  skill,
  detail,
  loading,
  error,
  onClose,
  setActiveTab,
  setSelectedRepoId,
  setInspectorRepoId,
  repositories,
  availableSyncTargets,
  defaultSyncTargets,
  updateSkillSyncTargets,
  isPending,
  openPluginDetail,
  onSaveNote,
  language,
  t,
}: any) {
  const activeDetail = detail || skill;
  const syncMode = activeDetail.syncTargetsMode || "inherit";
  const customTargets = activeDetail.syncTargets || [];
  const resolvedTargets = activeDetail.resolvedSyncTargets || skill.resolvedSyncTargets || [];
  const publishedTargets = activeDetail.publishedTargets || skill.publishedTargets || [];
  const syncPending = isPending?.(`syncTargets:${skill.id}`);
  const [noteDraft, setNoteDraft] = useState(activeDetail.note || "");

  useEffect(() => {
    setNoteDraft(activeDetail.note || "");
  }, [activeDetail.id, activeDetail.note]);
  function jumpToRepo() {
    const repo = repositories.find(
      (item) => displayRepoName(item.name, language) === displayRepoName(skill.repo, language),
    );
    if (repo) {
      setSelectedRepoId(repo.id);
      setInspectorRepoId(repo.id);
    }
    setActiveTab("repositories");
  }

  function setSyncMode(nextMode) {
    const nextTargets = nextMode === "custom" ? resolvedTargets : defaultSyncTargets;
    updateSkillSyncTargets(skill.id, nextMode, nextTargets);
  }

  function toggleCustomTarget(targetId, checked) {
    const nextTargets = checked
      ? [...customTargets, targetId]
      : customTargets.filter((id) => id !== targetId);
    updateSkillSyncTargets(skill.id, "custom", nextTargets);
  }

  return (
    <aside className="inspector skill-inspector">
      <header className="inspector-title">
        <div>
          <h2>{skill.name}</h2>
          <Tag value={skill.status} language={language} />
        </div>
        <button className="icon-button" onClick={onClose} type="button" aria-label={t("close")}>
          x
        </button>
      </header>

      <Section title={t("skillOverview")}>
        <Detail label={t("source")} value={sourceLabel(skill, language)} />
        <Detail label={t("sourceRepository")} value={displayRepoName(skill.repo, language)} />
        <Detail label={t("path")} value={skill.path} mono />
        <Detail label={t("version")} value={versionSummary(skill, language)} mono />
        <Detail label={t("localSource")} value={displayValue(skill.installPath || skill.localPath || "unknown", language)} />
        <Detail label={t("publishedTargets")} value={syncTargetSummary(publishedTargets, availableSyncTargets, language)} />
        <div className="inline-action-row">
          <Button onClick={jumpToRepo}>{t("source")}</Button>
        </div>
      </Section>

      <Section title={t("syncTargets")}>
        <div className="segmented compact-segmented" role="group" aria-label={t("syncTargets")}>
          <button
            aria-pressed={syncMode !== "custom"}
            className={syncMode !== "custom" ? "selected" : ""}
            disabled={syncPending}
            onClick={() => setSyncMode("inherit")}
            type="button"
          >
            {t("inheritDefaults")}
          </button>
          <button
            aria-pressed={syncMode === "custom"}
            className={syncMode === "custom" ? "selected" : ""}
            disabled={syncPending}
            onClick={() => setSyncMode("custom")}
            type="button"
          >
            {t("customTargets")}
          </button>
        </div>
        <p className="detail-copy">
          {syncMode === "custom" ? t("syncTargetsCustom") : t("syncTargetsInherited")}:{" "}
          {syncTargetSummary(resolvedTargets, availableSyncTargets, language)}
        </p>
        <p className="detail-copy muted-copy">{t("skillCustomTargetsHelp")}</p>
        <div className="target-toggle-grid compact-target-grid">
          {availableSyncTargets.map((target) => {
            const checked = (syncMode === "custom" ? customTargets : defaultSyncTargets).includes(target.id);
            return (
              <label className="check-pill" key={target.id} title={target.path}>
                <input
                  checked={checked}
                  disabled={syncPending || syncMode !== "custom"}
                  onChange={(event) => toggleCustomTarget(target.id, event.target.checked)}
                  type="checkbox"
                />
                <span>{target.label}</span>
              </label>
            );
          })}
        </div>
      </Section>

      <Section title={t("description")}>
        <p className="detail-copy">{skillDescription(activeDetail, language) || t("noDescription")}</p>
      </Section>

      <Section title={t("note")}>
        <NoteEditor
          actionKey={`note:skill:${skill.id}`}
          isPending={isPending}
          note={noteDraft}
          onChange={setNoteDraft}
          onClear={() => {
            setNoteDraft("");
            onSaveNote(skill, "");
          }}
          onSave={() => onSaveNote(skill, noteDraft)}
          t={t}
        />
      </Section>

      <Section title={`${t("pluginInstallEntries")} (${(activeDetail.plugins || []).length})`}>
        {(activeDetail.plugins || []).length ? (
          <div className="skill-list-mini">
            {(activeDetail.plugins || []).map((plugin) => (
              <button
                className="mini-skill mini-skill-button"
                key={plugin.id}
                onClick={() => openPluginDetail(plugin)}
                type="button"
              >
                <span className="health-dot" />
                <span>{plugin.name}</span>
                <code>{statusLabel(plugin.kind, language)}</code>
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-note">{t("noPluginsFound")}</p>
        )}
      </Section>

      <Section title="SKILL.md">
        {loading && <p className="empty-note">{t("loading")}</p>}
        {error && <p className="empty-note error-note">{error}</p>}
        {!loading && !error && (
          <div className="markdown-preview-block">
            {activeDetail.filePath && <div className="preview-meta mono">{activeDetail.filePath}</div>}
            <pre>{activeDetail.skillMd || t("noSkillMarkdown")}</pre>
          </div>
        )}
      </Section>
    </aside>
  );
}

function TasksView({ tasks, taskFilter, setTaskFilter, retryTask, copyTaskSummary, hasTasks, isPending, language, t }: any) {
  const filters = [
    ["all", t("all")],
    ["success", t("success")],
    ["partial-success", t("partial")],
    ["failed", t("failed")],
    ["interrupted", t("interrupted")],
  ];
  const [expanded, setExpanded] = useState(tasks[0]?.id);
  const expandedTask = tasks.find((task) => task.id === expanded) || tasks[0];

  useEffect(() => {
    if (!tasks.length) {
      setExpanded(undefined);
    } else if (!tasks.some((task) => task.id === expanded)) {
      setExpanded(tasks[0].id);
    }
  }, [tasks, expanded]);

  return (
    <section className="main-pane single">
      <div className="pane-header">
        <div>
          <h1>{t("tasksTitle")}</h1>
          <p>{t("tasksSubtitle")}</p>
        </div>
        <div className="segmented" role="group" aria-label={t("tasksTitle")}>
          {filters.map(([id, label]) => (
            <button
              aria-pressed={taskFilter === id}
              className={taskFilter === id ? "selected" : ""}
              key={id}
              onClick={() => setTaskFilter(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="task-layout">
        <div className="table-frame">
          {tasks.length ? (
            <table className="data-table task-table">
              <thead>
                <tr>
                  <th>{t("type")}</th>
                  <th>{t("target")}</th>
                  <th>{t("progress")}</th>
                  <th>{t("status")}</th>
                  <th>{t("taskSummary")}</th>
                  <th>{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr
                    className={expanded === task.id ? "active-row" : ""}
                    key={task.id}
                    onClick={() => setExpanded(task.id)}
                  >
                    <td>{taskText(task.kind, language)}</td>
                    <td title={taskText(task.target, language)}>{taskText(task.target, language)}</td>
                    <td>{task.progress}</td>
                    <td>
                      <Tag value={task.status} language={language} />
                    </td>
                    <td className="task-summary-cell" title={taskText(task.summary, language)}>
                      {taskText(task.summary, language)}
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <div className="row-actions">
                        <button
                          aria-label={`${t("retry")}: ${taskText(task.target, language)}`}
                          disabled={
                            !["failed", "interrupted", "partial-success"].includes(task.status) ||
                            isPending(`retryTask:${task.id}`)
                          }
                          onClick={() => retryTask(task)}
                          title={`${t("retry")}: ${taskText(task.target, language)}`}
                          type="button"
                        >
                          {isPending(`retryTask:${task.id}`) ? t("retrying") : t("retry")}
                        </button>
                        <button
                          aria-label={`${t("copy")}: ${taskText(task.target, language)}`}
                          onClick={() => copyTaskSummary(task)}
                          title={`${t("copy")}: ${taskText(task.target, language)}`}
                          type="button"
                        >
                          {t("copy")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title={hasTasks ? t("noFilteredTasksTitle") : t("firstTaskTitle")}
              body={hasTasks ? t("noFilteredTasksText") : t("firstTaskText")}
            />
          )}
        </div>

        {expandedTask ? (
          <aside className="log-panel">
            <div className="task-detail-card">
              <div>
                <span>{t("taskDetails")}</span>
                <strong>{taskText(expandedTask.kind, language)}</strong>
              </div>
              <Tag value={expandedTask.status} language={language} />
              <Detail label={t("target")} value={taskText(expandedTask.target, language)} />
              <Detail label={t("progress")} value={expandedTask.progress} />
              <Detail label={t("taskSummary")} value={taskText(expandedTask.summary, language)} />
            </div>
            <div className="log-actions">
              <h2>{t("taskLog")}</h2>
              <div className="row-actions">
                <button
                  aria-label={`${t("retry")}: ${taskText(expandedTask.target, language)}`}
                  disabled={
                    !["failed", "interrupted", "partial-success"].includes(expandedTask.status) ||
                    isPending(`retryTask:${expandedTask.id}`)
                  }
                  onClick={() => retryTask(expandedTask)}
                  title={`${t("retry")}: ${taskText(expandedTask.target, language)}`}
                  type="button"
                >
                  {isPending(`retryTask:${expandedTask.id}`) ? t("retrying") : t("retry")}
                </button>
                <button
                  aria-label={`${t("copy")}: ${taskText(expandedTask.target, language)}`}
                  onClick={() => copyTaskSummary(expandedTask)}
                  title={`${t("copy")}: ${taskText(expandedTask.target, language)}`}
                  type="button"
                >
                  {t("copy")}
                </button>
              </div>
            </div>
            <pre>
              {expandedTask.log
                .map((line, index) => `${String(index + 1).padStart(2, "0")}  ${taskText(line, language)}`)
                .join("\n")}
            </pre>
          </aside>
        ) : (
          <aside className="log-panel empty-log">
            <h2>{t("taskLog")}</h2>
            <p>{t("firstTaskText")}</p>
          </aside>
        )}
      </div>
    </section>
  );
}

function SettingsView(props: any) {
  const { t, persistSettings, isPending } = props;
  return (
    <section className="main-pane single">
      <div className="pane-header">
        <div>
          <h1>{t("settingsTitle")}</h1>
          <p>{t("settingsSubtitle")}</p>
        </div>
        <div className="settings-actions">
          <Button
            variant="primary"
            onClick={persistSettings}
            pending={isPending("persistSettings")}
            pendingLabel={t("saving")}
          >
            {t("saveSettings")}
          </Button>
        </div>
      </div>

      <PreferencesPanel {...props} />
    </section>
  );
}

function PreferencesModal({ onClose, ...props }: any) {
  const { t, persistSettings, isPending } = props;
  return (
    <Modal
      title={t("settings")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={onClose}>{t("close")}</Button>
          <Button
            variant="primary"
            onClick={async () => {
              await persistSettings();
              onClose();
            }}
            pending={isPending("persistSettings")}
            pendingLabel={t("saving")}
          >
            {t("saveSettings")}
          </Button>
        </>
      }
    >
      <PreferencesPanel compact {...props} />
    </Modal>
  );
}

function PreferencesPanel({
  language,
  setLanguage,
  theme,
  setTheme,
  density,
  setDensity,
  backupRoot,
  setBackupRoot,
  skillsRoot,
  setSkillsRoot,
  defaultSyncTargets,
  setDefaultSyncTargets,
  availableSyncTargets,
  syncBackupKeep,
  setSyncBackupKeep,
  concurrency,
  setConcurrency,
  retryCount,
  setRetryCount,
  autoCheckInterval,
  setAutoCheckInterval,
  autoCheckEnabled,
  setAutoCheckEnabled,
  autoBackupEnabled,
  setAutoBackupEnabled,
  cleanupKeep,
  setCleanupKeep,
  overwriteProtection,
  setOverwriteProtection,
  requireConfirmation,
  setRequireConfirmation,
  githubTokenConfigured,
  githubTokenStatus,
  githubTokenLastVerified,
  nextAutoCheckAt,
  nextAutoBackupAt,
  directoryStatus,
  migrationStatus,
  chooseDirectory,
  validateDirectory,
  syncInstalledSkills,
  persistSettings,
  showToast,
  exportMigrationPackage,
  importMigrationPackage,
  openGitHubWorkbench,
  desktopRuntime,
  compact,
  isPending,
  t,
}: any) {
  return (
    <div className={`settings-layout ${compact ? "compact-settings" : ""}`}>
      <div className="settings-main-column">
        <SettingsSection title={t("appearanceLanguage")}>
          <SettingRow label={t("theme")}>
            <div className="choice-row">
              <button
                aria-pressed={theme === "light"}
                className={theme === "light" ? "selected" : ""}
                onClick={() => setTheme("light")}
                type="button"
              >
                {t("lightTheme")}
              </button>
              <button
                aria-pressed={theme === "dark"}
                className={theme === "dark" ? "selected" : ""}
                onClick={() => setTheme("dark")}
                type="button"
              >
                {t("darkTheme")}
              </button>
            </div>
          </SettingRow>
          <SettingRow label={t("language")}>
            <div className="choice-row">
              <button
                aria-pressed={language === "zh"}
                className={language === "zh" ? "selected" : ""}
                onClick={() => setLanguage("zh")}
                type="button"
              >
                {t("chinese")}
              </button>
              <button
                aria-pressed={language === "en"}
                className={language === "en" ? "selected" : ""}
                onClick={() => setLanguage("en")}
                type="button"
              >
                {t("english")}
              </button>
            </div>
          </SettingRow>
          <SettingRow label={t("density")}>
            <div className="choice-row">
              <button
                aria-pressed={density === "comfortable"}
                className={density === "comfortable" ? "selected" : ""}
                onClick={() => setDensity("comfortable")}
                type="button"
              >
                {t("comfortable")}
              </button>
              <button
                aria-pressed={density === "compact"}
                className={density === "compact" ? "selected" : ""}
                onClick={() => setDensity("compact")}
                type="button"
              >
                {t("compact")}
              </button>
            </div>
          </SettingRow>
        </SettingsSection>

        <SettingsSection title={t("taskBehavior")}>
          <SettingRow controlId="metadata-concurrency-input" label={t("metadataConcurrency")}>
            <div className="range-row">
              <input
                id="metadata-concurrency-input"
                max="10"
                min="1"
                onChange={(event) => setConcurrency(Number(event.target.value))}
                type="range"
                value={concurrency}
              />
              <strong>{concurrency}</strong>
            </div>
          </SettingRow>
          <SettingRow controlId="retry-count-input" label={t("retryCount")}>
            <div className="range-row">
              <input
                id="retry-count-input"
                max="5"
                min="0"
                onChange={(event) => setRetryCount(Number(event.target.value))}
                type="range"
                value={retryCount}
              />
              <strong>{retryCount}</strong>
            </div>
          </SettingRow>
          <SettingRow controlId="auto-check-interval-input" label={t("autoCheckInterval")}>
            <div className="range-row">
              <input
                id="auto-check-interval-input"
                max="180"
                min="15"
                onChange={(event) => setAutoCheckInterval(Number(event.target.value))}
                step="15"
                type="range"
                value={autoCheckInterval}
              />
              <strong>{language === "zh" ? `${autoCheckInterval} 分钟` : `${autoCheckInterval} min`}</strong>
            </div>
          </SettingRow>
        </SettingsSection>

        {/* Pair half-width cards before wide cards so CSS Grid cannot leave a row hole. */}
        <SettingsSection title={t("backupRoot")} wide>
          <SettingRow
            controlId="backup-root-input"
            description={t("backupRootHelp")}
            label={t("localFolder")}
            stacked
          >
            <div className="folder-picker-row">
              <input
                id="backup-root-input"
                aria-label={t("localFolder")}
                onBlur={() => validateDirectory("backupRoot", backupRoot)}
                onChange={(event) => setBackupRoot(event.target.value)}
                title={backupRoot}
                value={backupRoot}
              />
              <button onClick={() => chooseDirectory("backupRoot")} type="button">
                {t("chooseFolder")}
              </button>
            </div>
          </SettingRow>
          <SettingRow
            controlId="skills-root-input"
            description={t("skillsRootHelp")}
            label={t("skillsRoot")}
            stacked
          >
            <div className="folder-picker-row">
              <input
                id="skills-root-input"
                aria-label={t("skillsRoot")}
                onBlur={() => validateDirectory("skillLibraryRoot", skillsRoot)}
                onChange={(event) => setSkillsRoot(event.target.value)}
                title={skillsRoot}
                value={skillsRoot}
              />
              <button onClick={() => chooseDirectory("skillsRoot")} type="button">
                {t("chooseFolder")}
              </button>
            </div>
          </SettingRow>
          <SettingRow
            description={t("defaultSyncTargetsHelp")}
            label={t("defaultSyncTargets")}
            stacked
          >
            <div className="target-toggle-grid">
              {availableSyncTargets.map((target) => {
                const checked = defaultSyncTargets.includes(target.id);
                return (
                  <label className="check-pill" key={target.id} title={target.path}>
                    <input
                      checked={checked}
                      onChange={(event) => {
                        setDefaultSyncTargets((items) =>
                          event.target.checked
                            ? [...items, target.id]
                            : items.filter((id) => id !== target.id),
                        );
                      }}
                      type="checkbox"
                    />
                    <span>{target.label}</span>
                  </label>
                );
              })}
            </div>
            <p className="settings-note">{t("defaultSyncTargetsApplyHelp")}</p>
          </SettingRow>
          <SettingRow label={t("syncBackupKeep")}>
            <div className="range-row">
              <input
                max="20"
                min="1"
                onChange={(event) => setSyncBackupKeep(Number(event.target.value))}
                step="1"
                type="range"
                value={syncBackupKeep}
              />
              <strong>{syncBackupKeep}</strong>
            </div>
          </SettingRow>
          <div className="settings-actions inline-actions">
            <Button
              onClick={syncInstalledSkills}
              pending={isPending("syncInstalledSkills")}
              pendingLabel={t("syncingSkills")}
            >
              {t("syncInstalledSkills")}
            </Button>
          </div>
          <p
            className={
              directoryStatus?.backupRoot?.writable === false ||
              directoryStatus?.skillsRoot?.writable === false ||
              directoryStatus?.skillLibraryRoot?.writable === false
                ? "settings-note warning"
                : "settings-note"
            }
          >
            {directoryStatus?.backupRoot?.message ||
              directoryStatus?.skillsRoot?.message ||
              directoryStatus?.skillLibraryRoot?.message ||
              t("directoryReady")}
          </p>
        </SettingsSection>

        <SettingsSection title={t("safetyDefaults")}>
          <SettingRow label={t("overwriteProtection")}>
            <label className="switch-row compact-switch">
              <input
                checked={overwriteProtection}
                onChange={(event) => setOverwriteProtection(event.target.checked)}
                type="checkbox"
              />
              <span>{t("overwriteProtectionText")}</span>
            </label>
          </SettingRow>
          <SettingRow label={t("requireConfirmation")}>
            <label className="switch-row compact-switch">
              <input
                checked={requireConfirmation}
                onChange={(event) => setRequireConfirmation(event.target.checked)}
                type="checkbox"
              />
              <span>{t("requireConfirmationText")}</span>
            </label>
          </SettingRow>
        </SettingsSection>

        <SettingsSection title={t("schedule")} note={t("scheduleSavedOnly")}>
          <SettingRow label={t("autoCheckEnabled")}>
            <label className="switch-row compact-switch">
              <input
                checked={autoCheckEnabled}
                onChange={(event) => setAutoCheckEnabled(event.target.checked)}
                type="checkbox"
              />
              <span>{language === "zh" ? `每 ${autoCheckInterval} 分钟检测一次` : `Every ${autoCheckInterval} minutes`}</span>
            </label>
          </SettingRow>
          <SettingRow label={t("autoBackupEnabled")}>
            <label className="switch-row compact-switch">
              <input
                checked={autoBackupEnabled}
                onChange={(event) => setAutoBackupEnabled(event.target.checked)}
                type="checkbox"
              />
              <span>{language === "zh" ? "仅备份有更新仓库" : "Updated repositories only"}</span>
            </label>
          </SettingRow>
          <div className="status-card compact-status">
            <span>{t("nextRun")}</span>
            <strong>
              {autoCheckEnabled
                ? formatNextRun(nextAutoCheckAt, language)
                : autoBackupEnabled
                  ? formatNextRun(nextAutoBackupAt, language)
                  : t("autoCheckDisabled")}
            </strong>
          </div>
          <SettingRow controlId="cleanup-keep-input" label={t("cleanupKeep")}>
            <div className="range-row">
              <input
                id="cleanup-keep-input"
                max="200"
                min="1"
                onChange={(event) => setCleanupKeep(Number(event.target.value))}
                type="range"
                value={cleanupKeep}
              />
              <strong>{cleanupKeep}</strong>
            </div>
          </SettingRow>
        </SettingsSection>
      </div>

      <aside className="settings-side-column">
        <SettingsSection title={t("githubAuthentication")} note={t("authP1Text")}>
          <div className="status-card compact-status">
            <span>{t("tokenStatus")}</span>
            <strong>{tokenStatusLabel(githubTokenStatus, githubTokenConfigured, language, t)}</strong>
          </div>
          <div className="status-card compact-status">
            <span>{t("lastVerified")}</span>
            <strong>{githubTokenLastVerified || t("neverVerified")}</strong>
          </div>
          <p className="settings-note">{t("githubWorkbenchSettingsText")}</p>
          <div className="row-actions settings-token-actions">
            <button onClick={openGitHubWorkbench} type="button">
              {t("openGithubWorkbench")}
            </button>
          </div>
        </SettingsSection>

        <SettingsSection title={t("dataMigration")} note={t("dataMigrationHelp")}>
          <div className="action-grid">
            <Button
              onClick={exportMigrationPackage}
              pending={isPending("exportMigrationPackage")}
              pendingLabel={t("exporting")}
            >
              {t("exportData")}
            </Button>
            <Button
              onClick={importMigrationPackage}
              pending={isPending("importMigrationPackage")}
              pendingLabel={t("importing")}
            >
              {t("importData")}
            </Button>
          </div>
          <p className="settings-note">{t("migrationTokenNote")}</p>
          {migrationStatus && <p className="settings-note migration-status">{migrationStatus}</p>}
        </SettingsSection>

        <AboutPanel
          desktopRuntime={desktopRuntime}
          language={language}
          showToast={showToast}
          t={t}
        />
      </aside>
    </div>
  );
}

function SettingsSection({ title, note, wide = false, children }: any) {
  return (
    <section className={`settings-section ${wide ? "wide" : ""}`}>
      <div className="settings-section-header">
        <h2>{title}</h2>
      </div>
      {note && <p className="settings-note section-note">{note}</p>}
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

function SettingRow({ label, description, controlId, stacked = false, children }: any) {
  return (
    <div className={`setting-row ${stacked ? "stacked" : ""}`}>
      <div className="setting-label">
        {controlId ? <label htmlFor={controlId}>{label}</label> : <span>{label}</span>}
        {description && <p className="setting-description">{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function AboutPanel({ desktopRuntime, language, showToast, t }: any) {
  const [checking, setChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const defaultUpdateStatus = APP_METADATA.openSource && APP_METADATA.projectGithubUrl
    ? t("updateCheckReady")
    : t("updateUnavailableInternalBuild");

  async function checkForUpdates() {
    if (!APP_METADATA.openSource || !APP_METADATA.projectGithubUrl) {
      setUpdateStatus(t("updateUnavailableInternalBuild"));
      showToast(t("updateUnavailableInternalBuild"));
      return;
    }

    const match = APP_METADATA.projectGithubUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!match) {
      setUpdateStatus(t("updateCheckFailed"));
      showToast(t("updateCheckFailed"));
      return;
    }

    setChecking(true);
    setUpdateStatus(t("checkingForUpdates"));
    try {
      const response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`);
      if (!response.ok) {
        throw new Error(`GitHub release check failed: ${response.status}`);
      }
      const release = await response.json();
      const latest = String(release.tag_name || "").replace(/^v/i, "");
      const current = APP_METADATA.version.replace(/^v/i, "");
      const message = latest && latest !== current
        ? `${language === "zh" ? "发现新版本" : "New version"} v${latest}`
        : t("updateUpToDate");
      setUpdateStatus(message);
      showToast(message);
    } catch (error) {
      setUpdateStatus(t("updateCheckFailed"));
      showToast(error.message || t("updateCheckFailed"));
    } finally {
      setChecking(false);
    }
  }

  async function openProjectGithub() {
    if (!APP_METADATA.openSource || !APP_METADATA.projectGithubUrl) {
      showToast(t("projectGithubComingSoon"));
      return;
    }
    try {
      if (desktopRuntime) {
        await api.openUrl(APP_METADATA.projectGithubUrl, "systemDefault");
      } else {
        window.open(APP_METADATA.projectGithubUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      showToast(error.message || t("openUrlFailed"));
    }
  }

  return (
    <SettingsSection title={t("aboutTitle")}>
      <div className="about-card">
        <div>
          <strong>{APP_METADATA.name}</strong>
          <span>{t("settingsHelp")}</span>
        </div>
        <div className="status-card compact-status">
          <span>{t("aboutVersion")}</span>
          <strong>v{APP_METADATA.version}</strong>
        </div>
        <p className="settings-note">{updateStatus || defaultUpdateStatus}</p>
        <div className="about-actions">
          <Button
            onClick={checkForUpdates}
            pending={checking}
            pendingLabel={t("checkingForUpdates")}
          >
            {t("checkForUpdates")}
          </Button>
          <Button
            disabled={!APP_METADATA.openSource || !APP_METADATA.projectGithubUrl}
            onClick={openProjectGithub}
          >
            {t("openProjectGithub")}
          </Button>
        </div>
        {(!APP_METADATA.openSource || !APP_METADATA.projectGithubUrl) && (
          <p className="settings-note">{t("projectGithubComingSoon")}</p>
        )}
      </div>
    </SettingsSection>
  );
}

function RunningTask({ tasks, setActiveTab, language, t }: any) {
  const task = tasks.find((item) => ["queued", "running"].includes(item.status));
  if (!task) return null;
  const indeterminate = task.optimistic || task.progress === "…";
  return (
    <section className="running-task">
      <div>
        <h2>{t("runningTasks")}</h2>
        <p>{taskText(task.kind, language)}: {taskText(task.summary, language)}</p>
      </div>
      <div className="progress-track">
        <span className={indeterminate ? "indeterminate" : ""} style={indeterminate ? undefined : { width: "42%" }} />
      </div>
      <strong>{task.progress}</strong>
      <Button onClick={() => setActiveTab("tasks")}>{t("details")}</Button>
    </section>
  );
}

function AddRepoModal({ newRepo, setNewRepo, onClose, onConfirm, loading, t }: any) {
  return (
    <Modal
      title={t("addRepository")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={loading || !newRepo.url.trim()}
          >
            {loading ? t("adding") : t("addAndScan")}
          </Button>
        </>
      }
    >
      <label className="form-row">
        {t("repositoryInput")}
        <input
          autoFocus
          onChange={(event) => setNewRepo({ ...newRepo, url: event.target.value })}
          placeholder="github.com/owner/repo"
          value={newRepo.url}
        />
      </label>
      <label className="form-row">
        {t("ref")}
        <input
          onChange={(event) => setNewRepo({ ...newRepo, ref: event.target.value })}
          value={newRepo.ref}
        />
      </label>
      <label className="form-row">
        {t("note")}
        <input
          onChange={(event) => setNewRepo({ ...newRepo, note: event.target.value })}
          placeholder={t("optionalNote")}
          value={newRepo.note}
        />
      </label>
      <div className="result-box">
        <strong>{t("detectionPreview")}</strong>
        <p>{t("detectionPreviewText")}</p>
      </div>
    </Modal>
  );
}

function GitHubAccountTokenModal({ onClose, onSaveToken, pending, t }: any) {
  const [token, setToken] = useState("");

  async function submitToken() {
    const value = token.trim();
    if (!value || pending) return;
    const saved = await onSaveToken(value);
    if (saved !== false) {
      setToken("");
      onClose();
    }
  }

  return (
    <Modal
      title={t("addGithubAccountTitle")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            onClick={submitToken}
            disabled={pending || !token.trim()}
          >
            {pending ? t("saving") : t("addAccount")}
          </Button>
        </>
      }
    >
      <label className="form-row">
        {t("tokenPlaceholder")}
        <input
          autoFocus
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitToken();
            }
          }}
          placeholder="github_pat_..."
          type="password"
          value={token}
        />
      </label>
      <div className="result-box github-token-note">
        <strong>{t("githubAuthentication")}</strong>
        <p>{t("githubTokenSecurityNote")}</p>
      </div>
    </Modal>
  );
}

function BackupModal({
  targetRepos,
  backupRoot,
  onClose,
  onConfirm,
  mode,
  pending,
  language,
  t,
}: any) {
  const backupableRepos = targetRepos.filter((repo) => repo.backupStatus !== "check-failed");
  const skippedRepos = targetRepos.filter((repo) => repo.backupStatus === "check-failed");
  const neverBackedCount = backupableRepos.filter((repo) => repo.backupStatus === "never-backed-up").length;
  const updatedCount = backupableRepos.filter((repo) => repo.backupStatus === "updated-not-backed-up").length;
  return (
    <Modal
      title={mode === "selected" ? t("backupSelectedTitle") : t("backupUpdatedTitle")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={!backupableRepos.length}
            pending={pending}
            pendingLabel={t("backingUp")}
          >
            {t("confirmBackup")}
          </Button>
        </>
      }
    >
      <div className="backup-summary">
        <div>
          <strong>{backupableRepos.length}</strong>
          <span>{t("willBeBackedUp")}</span>
        </div>
        <div>
          <strong>{neverBackedCount}</strong>
          <span>{t("neverBacked")}</span>
        </div>
        <div>
          <strong>{updatedCount}</strong>
          <span>{t("updated")}</span>
        </div>
        <div>
          <strong>{skippedRepos.length}</strong>
          <span>{t("checkFailedSkipped")}</span>
        </div>
      </div>
      <div className="result-box">
        <strong>{t("outputDirectory")}</strong>
        <p>{backupRoot}/2026-06-14_101212</p>
        <p>{t("outputDirectoryText")}</p>
      </div>
      <div className="result-box">
        <strong>{t("targetRepositories")}</strong>
        {targetRepos.length ? (
          <ul className="target-list">
            {targetRepos.slice(0, 8).map((repo) => (
              <li key={repo.id}>
                <span>{repo.name}</span>
                <Tag value={repo.backupStatus} language={language} />
              </li>
            ))}
            {targetRepos.length > 8 && <li>+ {targetRepos.length - 8}</li>}
          </ul>
        ) : (
          <p>{t("noFilteredRepositoriesText")}</p>
        )}
      </div>
    </Modal>
  );
}

function SkillRiskModal({ skill, onClose, onResolve, isPending, t }: any) {
  const skipPending = isPending(`resolveSkill:${skill?.id}:skip`);
  const backupPending = isPending(`resolveSkill:${skill?.id}:backup`);
  const forcePending = isPending(`resolveSkill:${skill?.id}:force`);
  const anyPending = skipPending || backupPending || forcePending;
  return (
    <Modal
      title={t("localSkillModified")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button
            onClick={() => onResolve("skip")}
            disabled={anyPending}
            pending={skipPending}
            pendingLabel={t("updating")}
          >
            {t("skipUpdate")}
          </Button>
          <Button
            onClick={() => onResolve("backup")}
            disabled={anyPending}
            pending={backupPending}
            pendingLabel={t("updating")}
          >
            {t("backupThenOverwrite")}
          </Button>
          <Button
            variant="danger"
            onClick={() => onResolve("force")}
            disabled={anyPending}
            pending={forcePending}
            pendingLabel={t("updating")}
          >
            {t("forceOverwrite")}
          </Button>
        </>
      }
    >
      <p className="modal-copy">
        {skill?.name} {t("localSkillModifiedText")}
      </p>
      <div className="result-box warning">
        <strong>{t("recommendedDefault")}</strong>
        <p>{t("recommendedOverwriteText")}</p>
      </div>
    </Modal>
  );
}

function DeleteSkillModal({ skill, onClose, onConfirm, isPending, t }: any) {
  const pending = isPending(`deleteSkill:${skill?.id}`);
  return (
    <Modal
      title={t("deleteSkillTitle")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            pending={pending}
            pendingLabel={t("deleting")}
          >
            {t("confirmDeleteSkill")}
          </Button>
        </>
      }
    >
      <p className="modal-copy">
        {skill?.name} - {t("deleteSkillText")}
      </p>
      <div className="result-box warning">
        <strong>{t("localSource")}</strong>
        <p>{skill?.installPath || skill?.localPath || skill?.path}</p>
      </div>
    </Modal>
  );
}

function GithubPreviewModal({ url, onClose, onCopy, onOpenExternal, onChooseBrowser, t }: any) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadPreview() {
      setLoading(true);
      setError("");
      setPreview(null);
      if (!isDesktopRuntime()) {
        setPreview({
          title: url.replace(/^https:\/\/github\.com\//, ""),
          url,
          defaultBranch: "main",
          resolvedRef: "main",
          sha: "",
          readme: "",
          readmeError: t("githubPreviewReadmeMissing"),
        });
        setLoading(false);
        return;
      }
      try {
        const nextPreview = await api.getGithubPreview(url);
        if (active) setPreview(nextPreview);
      } catch (loadError) {
        if (active) setError(loadError.message || t("githubPreviewFailed"));
      } finally {
        if (active) setLoading(false);
      }
    }
    loadPreview();
    return () => {
      active = false;
    };
  }, [url, reloadKey]);

  return (
    <Modal
      title={t("githubPreviewTitle")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={() => onCopy(url)}>{t("copyLink")}</Button>
          <Button onClick={() => onOpenExternal(url, "systemDefault")}>{t("systemBrowser")}</Button>
          <Button onClick={() => onChooseBrowser(url)}>{t("chooseBrowser")}</Button>
        </>
      }
    >
      <div className="github-preview">
        <p className="detail-copy">{t("githubPreviewSubtitle")}</p>
        <p className="mono preview-url">{url}</p>
        {loading && (
          <div className="loading-state">
            <span className="spinner" />
            <strong>{t("githubPreviewLoading")}</strong>
          </div>
        )}
        {!loading && error && (
          <div className="result-box warning">
            <strong>{t("githubPreviewFailed")}</strong>
            <p>{error}</p>
            <Button onClick={() => setReloadKey((value) => value + 1)}>{t("retryOpen")}</Button>
          </div>
        )}
        {!loading && preview && (
          <>
            <div className="preview-summary-grid">
              <Detail label={t("repository")} value={preview.title || url} />
              <Detail label={t("defaultBranch")} value={preview.defaultBranch || "main"} />
              <Detail label={t("ref")} value={preview.resolvedRef || preview.defaultBranch || "main"} />
              <Detail label={t("remoteSha")} value={preview.sha || "unknown"} mono />
            </div>
            <div className="markdown-preview-block">
              <div className="preview-meta mono">{preview.readmeSource || "README.md"}</div>
              {preview.readme ? (
                <pre>{preview.readme}</pre>
              ) : (
                <p className="empty-note">{preview.readmeError || t("githubPreviewReadmeMissing")}</p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function BrowserChoiceModal({ browsers, url, onClose, onOpen, onCopy, t }: any) {
  return (
    <Modal
      title={t("openGithub")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={() => onCopy(url)}>{t("copyLink")}</Button>
          <Button onClick={onClose}>{t("close")}</Button>
        </>
      }
    >
      <div className="browser-choice">
        <p className="mono">{url}</p>
        <div className="browser-grid">
          <Button variant="primary" onClick={() => onOpen("embedded")}>
            {t("previewInApp")}
          </Button>
          <Button onClick={() => onOpen("systemDefault")}>{t("systemBrowser")}</Button>
          {browsers.map((browser) => (
            <Button key={browser.id} onClick={() => onOpen("browserApp", browser.id)}>
              {browser.name}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
