import { api } from "./api";
import type {
  AppMetadata,
  AppSettings,
  AppUpdateCheck,
  CreatePromptRequest,
  GitHubAccount,
  GitHubRepository,
  PromptDetail,
  PromptExportSummary,
  PromptListRequest,
  PromptPage,
  PromptSelection,
  PromptSummary,
  PromptTag,
  PromptZipImportPreview,
  PromptZipImportRequest,
  PromptZipImportResult,
  ReorderPromptRequest,
  ReorderPromptResult,
  UiPlugin,
  UiRepository,
  UiSkill,
  UiTask,
  UpdatePromptRequest,
} from "./api";
import {
  initialGithubAccounts,
  initialGithubRepositories,
  initialPlugins,
  initialRepos,
  initialSkills,
  initialTasks,
} from "./demoFixtures";

export type WorkspaceSnapshot = {
  repositories: UiRepository[];
  skills: UiSkill[];
  plugins: UiPlugin[];
  tasks: UiTask[];
};

export type BackupRequest = WorkspaceSnapshot & {
  mode: string;
  repositoryIds: string[];
  backupRoot: string;
};

export type BackupResult = Pick<WorkspaceSnapshot, "repositories" | "tasks">;

export type AppBootstrapSnapshot = {
  workspace: WorkspaceSnapshot;
  settings: AppSettings | null;
  githubAccounts: GitHubAccount[];
  githubRepositories: GitHubRepository[];
  appMetadata: AppMetadata | null;
};

export type AddRepositoryRequest = {
  url: string;
  refName: string;
  note: string;
};

export type RepositoryMutationResult = {
  workspace: WorkspaceSnapshot;
  repositoryId: string;
};

export type GithubCatalogSnapshot = {
  accounts: GitHubAccount[];
  repositories: GitHubRepository[];
};

export type PromptTransport = Pick<
  typeof api,
  | "listPrompts"
  | "getPromptDetail"
  | "createPrompt"
  | "updatePrompt"
  | "deletePrompt"
  | "setPromptPinned"
  | "reorderPrompt"
  | "listPromptTags"
  | "createPromptTag"
  | "renamePromptTag"
  | "mergePromptTags"
  | "deletePromptTag"
  | "exportPromptMarkdown"
  | "exportPromptsZip"
  | "previewPromptsZipImport"
  | "importPromptsZip"
>;

export interface AppService {
  readonly runtime: "tauri" | "demo";
  readonly promptTransport: PromptTransport;
  bootstrap(): Promise<AppBootstrapSnapshot>;
  checkRepositories(current: WorkspaceSnapshot): Promise<WorkspaceSnapshot>;
  backupRepositories(request: BackupRequest): Promise<BackupResult>;
  retryTask(taskId: string, current: WorkspaceSnapshot): Promise<WorkspaceSnapshot>;
  addRepository(
    request: AddRepositoryRequest,
    current: WorkspaceSnapshot,
  ): Promise<RepositoryMutationResult>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  refreshGithubCatalog(
    accountId: string | undefined,
    current: GithubCatalogSnapshot,
  ): Promise<GithubCatalogSnapshot>;
  chooseLocalRepository(): Promise<string | null>;
  openBackupFolder(repositoryId?: string): Promise<void>;
  checkForUpdates(currentVersion: string): Promise<AppUpdateCheck>;
}

type TauriTransport = Pick<
  typeof api,
  | "checkRepositories"
  | "backupRepositories"
  | "retryTask"
  | "addRepository"
  | "updateSettings"
  | "refreshGithubRepositories"
  | "pickDirectory"
  | "listRepositories"
  | "listSkills"
  | "listPlugins"
  | "listTasks"
  | "getSettings"
  | "listGithubAccounts"
  | "listGithubRepositoryCatalog"
  | "getAppMetadata"
  | "checkAppUpdate"
  | "openBackupFolder"
>;

export class TauriAppService implements AppService {
  readonly runtime = "tauri" as const;
  readonly promptTransport: PromptTransport = api;

  constructor(private readonly transport: TauriTransport = api) {}

  async bootstrap(): Promise<AppBootstrapSnapshot> {
    const [
      repositories,
      skills,
      plugins,
      tasks,
      settings,
      githubAccounts,
      githubRepositories,
      appMetadata,
    ] = await Promise.all([
      this.transport.listRepositories(),
      this.transport.listSkills(),
      this.transport.listPlugins(),
      this.transport.listTasks(),
      this.transport.getSettings(),
      this.transport.listGithubAccounts(),
      this.transport.listGithubRepositoryCatalog(),
      this.transport.getAppMetadata(),
    ]);
    return {
      workspace: { repositories, skills, plugins, tasks },
      settings,
      githubAccounts,
      githubRepositories,
      appMetadata,
    };
  }

  async checkRepositories(_current: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    const repositories = await this.transport.checkRepositories();
    const [skills, plugins, tasks] = await Promise.all([
      this.transport.listSkills(),
      this.transport.listPlugins(),
      this.transport.listTasks(),
    ]);
    return { repositories, skills, plugins, tasks };
  }

  async backupRepositories(request: BackupRequest): Promise<BackupResult> {
    const tasks = request.mode === "selected"
      ? await this.transport.backupRepositories(request.mode, request.repositoryIds)
      : await this.transport.backupRepositories(request.mode);
    const repositories = await this.transport.listRepositories();
    return { repositories, tasks };
  }

  async retryTask(taskId: string, _current: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    await this.transport.retryTask(taskId);
    const [repositories, skills, plugins, tasks] = await Promise.all([
      this.transport.listRepositories(),
      this.transport.listSkills(),
      this.transport.listPlugins(),
      this.transport.listTasks(),
    ]);
    return { repositories, skills, plugins, tasks };
  }

  async addRepository(
    request: AddRepositoryRequest,
    current: WorkspaceSnapshot,
  ): Promise<RepositoryMutationResult> {
    const repositories = await this.transport.addRepository(request);
    const [skills, plugins, tasks] = await Promise.all([
      this.transport.listSkills(),
      this.transport.listPlugins(),
      this.transport.listTasks(),
    ]);
    const previousIds = new Set(current.repositories.map((repository) => repository.id));
    const repositoryId = repositories.find((repository) => !previousIds.has(repository.id))?.id
      ?? repositories[0]?.id
      ?? "";
    return { workspace: { repositories, skills, plugins, tasks }, repositoryId };
  }

  async updateSettings(settings: AppSettings): Promise<AppSettings> {
    return this.transport.updateSettings(settings);
  }

  async refreshGithubCatalog(
    accountId: string | undefined,
    current: GithubCatalogSnapshot,
  ): Promise<GithubCatalogSnapshot> {
    const refreshed = await this.transport.refreshGithubRepositories(accountId);
    const repositories = accountId
      ? [...current.repositories.filter((repository) => repository.accountId !== accountId), ...refreshed]
      : refreshed;
    return { accounts: await this.transport.listGithubAccounts(), repositories };
  }

  chooseLocalRepository() {
    return this.transport.pickDirectory();
  }

  async openBackupFolder(repositoryId?: string) {
    await this.transport.openBackupFolder(repositoryId);
  }

  async checkForUpdates(_currentVersion: string) {
    return this.transport.checkAppUpdate();
  }
}

export type DemoMode = "default" | "empty-plugins" | "retry-race" | "github-rate-limit";

type DemoAppServiceOptions = {
  mode?: DemoMode;
  now?: () => Date;
};

export class DemoAppService implements AppService {
  readonly runtime = "demo" as const;
  readonly promptTransport: PromptTransport;
  private readonly mode: DemoMode;
  private readonly now: () => Date;
  private settings: AppSettings = demoSettings();
  private githubRefreshAttempts = 0;
  private pendingLateRetry: (() => void) | null = null;

  constructor(options: DemoAppServiceOptions = {}) {
    this.mode = options.mode ?? "default";
    this.now = options.now ?? createDeterministicDemoClock();
    this.promptTransport = new DemoPromptTransport(this.now);
  }

  async bootstrap(): Promise<AppBootstrapSnapshot> {
    return clone({
      workspace: {
        repositories: initialRepos,
        skills: initialSkills,
        plugins: this.mode === "empty-plugins" ? [] : initialPlugins,
        tasks: this.mode === "retry-race" ? [demoRetryableTask(), ...initialTasks] : initialTasks,
      },
      settings: this.settings,
      githubAccounts: initialGithubAccounts,
      githubRepositories: initialGithubRepositories,
      appMetadata: null,
    });
  }

  async checkRepositories(current: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    const checkedAt = this.now().toISOString();
    const repositories = current.repositories.map((repository) => ({
      ...repository,
      lastChecked: checkedAt,
      checkStatus: repository.checkStatus === "failed" ? "failed" : "success",
    }));
    const succeeded = repositories.filter((repository) => repository.checkStatus === "success").length;
    const task = demoTask(this.now(), {
      kind: "Check remote state",
      target: "All repositories",
      progress: `${repositories.length} / ${repositories.length}`,
      status: "success",
      summary: `${succeeded} success, ${repositories.length - succeeded} failed`,
      retryable: false,
      log: ["refresh all remote refs", "preserve failed repository SHA", "recalculate backup states"],
    });
    return clone({ ...current, repositories, tasks: [task, ...current.tasks] });
  }

  async backupRepositories(request: BackupRequest): Promise<BackupResult> {
    const targetIds = new Set(request.repositoryIds);
    const successfulIds = new Set(
      request.repositories
        .filter((repository) => targetIds.has(repository.id) && repository.checkStatus !== "failed")
        .map((repository) => repository.id),
    );
    const repositories = request.repositories.map((repository) => successfulIds.has(repository.id)
      ? {
          ...repository,
          backupStatus: "backed-up-latest",
          lastBackupSha: repository.remoteSha,
          snapshotTime: this.now().toISOString(),
        }
      : repository);
    const failedCount = targetIds.size - successfulIds.size;
    const task = demoTask(this.now(), {
      kind: "Backup repositories",
      target: request.mode === "selected" ? "Selected repositories" : "Updated repositories",
      progress: `${successfulIds.size} / ${targetIds.size}`,
      status: failedCount ? "partial-success" : "success",
      summary: `${successfulIds.size} success, ${failedCount} skipped`,
      retryable: false,
      log: [
        "refresh remote state before backup",
        `create ${request.backupRoot}`,
        "download ZIP files to .partial paths",
        "compute sha256 for successful ZIP files",
        "write manifest.json",
        "update last_backup_sha for successful repositories",
      ],
    });
    return clone({ repositories, tasks: [task, ...request.tasks] });
  }

  async retryTask(taskId: string, current: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    const task = current.tasks.find((candidate) => candidate.id === taskId);
    if (!task?.retryable) return clone(current);
    if (this.mode === "retry-race") {
      return new Promise((resolve) => {
        this.pendingLateRetry = () => resolve(clone({
          ...current,
          tasks: [demoSuccessfulRetry(this.now(), task), ...current.tasks.filter((item) => item.id !== taskId)],
        }));
      });
    }
    return clone({
      ...current,
      tasks: [demoSuccessfulRetry(this.now(), task), ...current.tasks.filter((item) => item.id !== taskId)],
    });
  }

  addRepository(
    request: AddRepositoryRequest,
    current: WorkspaceSnapshot,
  ): Promise<RepositoryMutationResult> {
    const name = normalizeDemoRepositoryName(request.url);
    if (!name || current.repositories.some((repository) => (
      repository.name === name && repository.ref === request.refName
    ))) {
      return Promise.reject(new Error("Repository already exists."));
    }
    const isSkillRepo = name.includes("skill") || name.includes("spec");
    const repositoryId = `demo:${name}@${request.refName}`;
    const repository: UiRepository = {
      id: repositoryId,
      name,
      type: isSkillRepo ? "skill repo" : "generic repo",
      ref: request.refName,
      skills: isSkillRepo ? 1 : 0,
      remoteSha: isSkillRepo ? "9ac12ef" : "3d20a9f",
      lastBackupSha: "none",
      lastChecked: this.now().toISOString(),
      backupStatus: "never-backed-up",
      checkStatus: "success",
      url: `https://github.com/${name}`,
      branch: request.refName,
      backupPath: `~/SkillRepoBackups/${name}`,
      snapshotTime: "Never",
      recognizedSkills: isSkillRepo
        ? [{ name: name.split("/").at(-1) || name, version: "v0.1.0" }]
        : [],
      sourceType: "github",
      note: request.note,
    };
    const task = demoTask(this.now(), {
      kind: "Scan repository",
      target: name,
      progress: "1 / 1",
      status: "success",
      summary: isSkillRepo ? "1 Skill recognized" : "generic repo, 0 Skills",
      retryable: false,
      log: [
        `normalize ${name}`,
        "fetch remote HEAD SHA",
        isSkillRepo ? "found SKILL.md" : "no SKILL.md found; keep as generic repo",
      ],
    });
    const result = clone({
      repositoryId,
      workspace: {
        ...current,
        repositories: [repository, ...current.repositories],
        tasks: [task, ...current.tasks],
      },
    });
    const releaseLateRetry = this.pendingLateRetry;
    this.pendingLateRetry = null;
    if (!releaseLateRetry) return Promise.resolve(result);
    return new Promise((resolve) => {
      resolve(result);
      Promise.resolve().then(releaseLateRetry);
    });
  }

  async updateSettings(settings: AppSettings): Promise<AppSettings> {
    this.settings = clone(settings);
    return clone(this.settings);
  }

  async refreshGithubCatalog(
    _accountId: string | undefined,
    current: GithubCatalogSnapshot,
  ): Promise<GithubCatalogSnapshot> {
    this.githubRefreshAttempts += 1;
    if (this.mode === "github-rate-limit" && this.githubRefreshAttempts === 1) {
      throw {
        code: "github_secondary_rate_limited",
        message: "GitHub request was rate limited.",
        details: "status=429 reset_at=2026-09-03T12:00:00Z",
      };
    }
    return clone(current);
  }

  async chooseLocalRepository() {
    return null;
  }

  async openBackupFolder(_repositoryId?: string) {}

  async checkForUpdates(currentVersion: string): Promise<AppUpdateCheck> {
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
    };
  }
}

function demoTask(now: Date, task: Omit<UiTask, "id">): UiTask {
  return { id: `${task.kind.toLowerCase().replaceAll(" ", "-")}-${now.getTime()}`, ...task };
}

function demoSettings(): AppSettings {
  return {
    backupRoot: "~/SkillRepoBackups",
    skillLibraryRoot: "~/SkillRepoTracker/skills",
    defaultSyncTargets: [],
    availableSyncTargets: [],
    syncBackupKeep: 5,
    autoCheckInterval: 60,
    autoCheckEnabled: false,
    autoBackupEnabled: false,
    githubTokenConfigured: false,
    githubTokenStatus: "not_configured",
    githubTokenLastVerified: null,
  };
}

function demoRetryableTask(): UiTask {
  return {
    id: "demo-retry-failed",
    kind: "Backup repositories",
    target: "example-org/content-skill-kit",
    progress: "0 / 1",
    status: "failed",
    summary: "network failed before manifest write",
    retryable: true,
    log: ["network failed", "temporary directory removed", "last_backup_sha unchanged"],
  };
}

function demoSuccessfulRetry(now: Date, task: UiTask): UiTask {
  return demoTask(now, {
    kind: task.kind,
    target: task.target,
    progress: "1 / 1",
    status: "success",
    summary: "retry completed",
    retryable: false,
    log: [...task.log, "retry completed without publishing stale state"],
  });
}

function normalizeDemoRepositoryName(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

class DemoPromptTransport implements PromptTransport {
  private readonly now: () => Date;
  private prompts: PromptDetail[];
  private tags: PromptTag[];
  private libraryRevision = 1;
  private nextPromptId = 3;

  constructor(now: () => Date) {
    this.now = now;
    this.tags = [
      demoPromptTag("research", "研究"),
      demoPromptTag("release", "发布"),
    ];
    this.prompts = [
      demoPrompt("demo-prompt-1", "本地优先检查清单", "# 检查\n\n验证本地状态与公开实物。", [this.tags[0]], true),
      demoPrompt("demo-prompt-2", "发布异常处置", "# 处置\n\n上传不明时先查询远端。", [this.tags[1]], false),
    ];
  }

  async listPrompts(request: PromptListRequest): Promise<PromptPage> {
    const query = request.query.trim().normalize("NFC").toLocaleLowerCase();
    let prompts = this.prompts.filter((prompt) => {
      const queryMatches = !query
        || `${prompt.title}\n${prompt.content}`.normalize("NFC").toLocaleLowerCase().includes(query);
      const promptTagIds = new Set(prompt.tags.map((tag) => tag.id));
      const tagMatches = request.tagIds.length === 0
        || (request.tagMode === "all"
          ? request.tagIds.every((id) => promptTagIds.has(id))
          : request.tagIds.some((id) => promptTagIds.has(id)));
      return queryMatches && tagMatches;
    });
    if (request.sort === "updatedDesc") {
      prompts = [...prompts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    const totalPages = Math.max(1, Math.ceil(prompts.length / request.pageSize));
    const page = Math.min(Math.max(1, request.page), totalPages);
    const start = (page - 1) * request.pageSize;
    return clone({
      items: prompts.slice(start, start + request.pageSize).map((prompt) => promptSummary(prompt)),
      total: prompts.length,
      page,
      pageSize: request.pageSize,
      totalPages,
      libraryRevision: this.libraryRevision,
    });
  }

  async getPromptDetail(id: string): Promise<PromptDetail> {
    return clone(this.requirePrompt(id));
  }

  async createPrompt(request: CreatePromptRequest): Promise<PromptDetail> {
    const now = this.now().toISOString();
    const prompt = demoPrompt(
      `demo-prompt-${this.nextPromptId++}`,
      request.title,
      request.content,
      this.promptTags(request.tagIds),
      Boolean(request.pinned),
      now,
    );
    this.prompts = [prompt, ...this.prompts];
    this.libraryRevision += 1;
    return clone(prompt);
  }

  async updatePrompt(request: UpdatePromptRequest): Promise<PromptDetail> {
    const current = this.requirePrompt(request.id);
    if (current.revision !== request.expectedRevision) throw new Error("Prompt revision changed.");
    const updated = {
      ...current,
      title: request.title,
      content: request.content,
      excerpt: promptExcerpt(request.content),
      contentBytes: new TextEncoder().encode(request.content).byteLength,
      tags: this.promptTags(request.tagIds),
      pinned: Boolean(request.pinned),
      updatedAt: this.now().toISOString(),
      revision: current.revision + 1,
    };
    this.prompts = this.prompts.map((prompt) => prompt.id === request.id ? updated : prompt);
    this.libraryRevision += 1;
    return clone(updated);
  }

  async deletePrompt(id: string, expectedRevision: number): Promise<void> {
    const current = this.requirePrompt(id);
    if (current.revision !== expectedRevision) throw new Error("Prompt revision changed.");
    this.prompts = this.prompts.filter((prompt) => prompt.id !== id);
    this.libraryRevision += 1;
  }

  async setPromptPinned(id: string, pinned: boolean, expectedRevision: number): Promise<PromptSummary> {
    const current = this.requirePrompt(id);
    if (current.revision !== expectedRevision) throw new Error("Prompt revision changed.");
    const updated = { ...current, pinned, revision: current.revision + 1, updatedAt: this.now().toISOString() };
    this.prompts = this.prompts.map((prompt) => prompt.id === id ? updated : prompt);
    this.libraryRevision += 1;
    return clone(promptSummary(updated));
  }

  async reorderPrompt(_request: ReorderPromptRequest): Promise<ReorderPromptResult> {
    this.libraryRevision += 1;
    return { libraryRevision: this.libraryRevision };
  }

  async listPromptTags(): Promise<PromptTag[]> {
    return clone(this.tags.map((tag) => ({
      ...tag,
      promptCount: this.prompts.filter((prompt) => prompt.tags.some((candidate) => candidate.id === tag.id)).length,
    })));
  }

  async createPromptTag(name: string): Promise<PromptTag> {
    const normalized = name.trim().normalize("NFC");
    const existing = this.tags.find((tag) => tag.name.normalize("NFC") === normalized);
    if (existing) return clone(existing);
    const tag = demoPromptTag(`demo-tag-${this.tags.length + 1}`, normalized, this.now().toISOString());
    this.tags = [...this.tags, tag];
    this.libraryRevision += 1;
    return clone(tag);
  }

  async renamePromptTag(tagId: string, name: string): Promise<PromptTag> {
    const current = this.requireTag(tagId);
    const updated = { ...current, name: name.trim().normalize("NFC"), updatedAt: this.now().toISOString() };
    this.tags = this.tags.map((tag) => tag.id === tagId ? updated : tag);
    this.prompts = this.prompts.map((prompt) => ({
      ...prompt,
      tags: prompt.tags.map((tag) => tag.id === tagId ? updated : tag),
    }));
    this.libraryRevision += 1;
    return clone(updated);
  }

  async mergePromptTags(sourceTagId: string, targetTagId: string): Promise<PromptTag> {
    const target = this.requireTag(targetTagId);
    this.requireTag(sourceTagId);
    this.prompts = this.prompts.map((prompt) => {
      const ids = new Set(prompt.tags.map((tag) => tag.id));
      if (!ids.has(sourceTagId)) return prompt;
      return {
        ...prompt,
        tags: [...prompt.tags.filter((tag) => tag.id !== sourceTagId && tag.id !== targetTagId), target],
      };
    });
    this.tags = this.tags.filter((tag) => tag.id !== sourceTagId);
    this.libraryRevision += 1;
    return clone(target);
  }

  async deletePromptTag(tagId: string): Promise<void> {
    this.requireTag(tagId);
    this.tags = this.tags.filter((tag) => tag.id !== tagId);
    this.prompts = this.prompts.map((prompt) => ({
      ...prompt,
      tags: prompt.tags.filter((tag) => tag.id !== tagId),
    }));
    this.libraryRevision += 1;
  }

  async exportPromptMarkdown(id: string): Promise<PromptExportSummary> {
    const prompt = this.requirePrompt(id);
    return demoExportSummary(`${prompt.id}.md`, 1, prompt.contentBytes);
  }

  async exportPromptsZip(selection: PromptSelection): Promise<PromptExportSummary> {
    const count = selection.mode === "explicit"
      ? selection.ids.filter((id) => this.prompts.some((prompt) => prompt.id === id)).length
      : Math.max(0, this.prompts.length - selection.excludedIds.length);
    return demoExportSummary("prompts.zip", count, this.prompts.reduce((sum, prompt) => sum + prompt.contentBytes, 0));
  }

  async previewPromptsZipImport(): Promise<PromptZipImportPreview> {
    const exists = this.prompts.some((prompt) => prompt.id === "demo-imported-prompt");
    return {
      path: "/tmp/skill-repo-tracker-demo-prompts.zip",
      fileName: "skill-repo-tracker-demo-prompts.zip",
      cancelled: false,
      sha256: "a".repeat(64),
      sizeBytes: 512,
      expectedLibraryRevision: this.libraryRevision,
      prompts: 1,
      totalContentBytes: 48,
      newPrompts: exists ? 0 : 1,
      identicalPrompts: exists ? 1 : 0,
      conflictingPrompts: 0,
      tagsToCreate: 0,
      tagsToReuse: 1,
      conflicts: [],
      valid: true,
      message: "demo import preview",
    };
  }

  async importPromptsZip(request: PromptZipImportRequest): Promise<PromptZipImportResult> {
    if (request.expectedLibraryRevision !== this.libraryRevision) throw new Error("Prompt library changed.");
    const exists = this.prompts.some((prompt) => prompt.id === "demo-imported-prompt");
    if (!exists) {
      this.prompts = [
        demoPrompt(
          "demo-imported-prompt",
          "导入的发布恢复清单",
          "# 恢复\n\n先查询远端状态，再决定是否重试。",
          [this.tags[1]],
          false,
          this.now().toISOString(),
        ),
        ...this.prompts,
      ];
      this.libraryRevision += 1;
    }
    return {
      inserted: exists ? 0 : 1,
      skippedSame: exists ? 1 : 0,
      keptLocal: 0,
      overwritten: 0,
      duplicated: 0,
      createdTags: 0,
      reusedTags: 1,
      libraryRevision: this.libraryRevision,
      message: "demo import complete",
    };
  }

  private requirePrompt(id: string) {
    const prompt = this.prompts.find((candidate) => candidate.id === id);
    if (!prompt) throw new Error("Prompt not found.");
    return prompt;
  }

  private requireTag(id: string) {
    const tag = this.tags.find((candidate) => candidate.id === id);
    if (!tag) throw new Error("Prompt tag not found.");
    return tag;
  }

  private promptTags(ids: string[]) {
    return ids.map((id) => this.requireTag(id));
  }
}

function demoPromptTag(id: string, name: string, timestamp = "2026-06-30T10:00:00.000Z"): PromptTag {
  return { id, name, promptCount: 0, createdAt: timestamp, updatedAt: timestamp };
}

function demoPrompt(
  id: string,
  title: string,
  content: string,
  tags: PromptTag[],
  pinned: boolean,
  timestamp = "2026-06-30T10:00:00.000Z",
): PromptDetail {
  return {
    id,
    title,
    content,
    excerpt: promptExcerpt(content),
    tags,
    pinned,
    contentBytes: new TextEncoder().encode(content).byteLength,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
}

function promptSummary(prompt: PromptDetail): PromptSummary {
  const { content: _content, ...summary } = prompt;
  return summary;
}

function promptExcerpt(content: string) {
  return content.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function demoExportSummary(name: string, count: number, bytes: number): PromptExportSummary {
  return { path: `/tmp/${name}`, cancelled: false, count, bytes, message: "demo export complete" };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createDeterministicDemoClock(): () => Date {
  const epoch = Date.parse("2026-06-30T10:00:00.000Z");
  let tick = 0;
  return () => new Date(epoch + tick++);
}
