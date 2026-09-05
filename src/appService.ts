import { api } from "./api";
import type {
  AppMetadata,
  AppSettings,
  AppUpdateCheck,
  GitHubAccount,
  GitHubRepository,
  UiPlugin,
  UiRepository,
  UiSkill,
  UiTask,
  UpdateSettingsRequest,
} from "./api";
import { DemoPromptTransport } from "./demoPromptTransport";
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
  updateSettings(settings: UpdateSettingsRequest): Promise<AppSettings>;
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
    const requestedName = normalizeRepositoryName(request.url).toLocaleLowerCase("en-US");
    const requestedMatches = repositories.filter((repository) => (
      normalizeRepositoryName(repository.name).toLocaleLowerCase("en-US") === requestedName
      && repository.ref === request.refName
    ));
    const newRepositories = repositories.filter((repository) => !previousIds.has(repository.id));
    const repositoryId = requestedMatches.length === 1
      ? requestedMatches[0].id
      : newRepositories.length === 1
        ? newRepositories[0].id
        : "";
    return { workspace: { repositories, skills, plugins, tasks }, repositoryId };
  }

  async updateSettings(settings: UpdateSettingsRequest): Promise<AppSettings> {
    const {
      backupRoot,
      skillLibraryRoot,
      skillsRoot,
      defaultSyncTargets,
      syncBackupKeep,
      autoCheckInterval,
      autoCheckEnabled,
      autoBackupEnabled,
    } = settings;
    return this.transport.updateSettings({
      backupRoot,
      skillLibraryRoot,
      skillsRoot,
      defaultSyncTargets,
      syncBackupKeep,
      autoCheckInterval,
      autoCheckEnabled,
      autoBackupEnabled,
    });
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
    const name = normalizeRepositoryName(request.url);
    if (!name || current.repositories.some((repository) => (
      repository.name === name && repository.ref === request.refName
    ))) {
      return Promise.reject(new Error("Repository already exists."));
    }
    const isSkillRepo = name.includes("skill") || name.includes("spec");
    const nameParts = name.split("/");
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
        ? [{ name: nameParts[nameParts.length - 1] || name, version: "v0.1.0" }]
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

  async updateSettings(settings: UpdateSettingsRequest): Promise<AppSettings> {
    const normalizedBackupRoot = normalizeDirectory(settings.backupRoot);
    const normalizedSkillLibraryRoot = normalizeDirectory(settings.skillLibraryRoot);
    this.settings = {
      ...this.settings,
      ...clone(settings),
      backupRoot: normalizedBackupRoot,
      skillLibraryRoot: normalizedSkillLibraryRoot,
      skillsRoot: settings.skillsRoot ? normalizeDirectory(settings.skillsRoot) : settings.skillsRoot,
    };
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

function normalizeRepositoryName(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeDirectory(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/g, "") : trimmed;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
    ) as T;
  }
  return value;
}

function createDeterministicDemoClock(): () => Date {
  const epoch = Date.parse("2026-06-30T10:00:00.000Z");
  let tick = 0;
  return () => new Date(epoch + tick++);
}
