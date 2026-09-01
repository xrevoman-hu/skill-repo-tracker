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

export interface AppService {
  readonly runtime: "tauri" | "demo";
  bootstrap(): Promise<AppBootstrapSnapshot>;
  checkRepositories(current: WorkspaceSnapshot): Promise<WorkspaceSnapshot>;
  backupRepositories(request: BackupRequest): Promise<BackupResult>;
  retryTask(taskId: string, current: WorkspaceSnapshot): Promise<WorkspaceSnapshot>;
  openBackupFolder(repositoryId?: string): Promise<void>;
  checkForUpdates(currentVersion: string): Promise<AppUpdateCheck>;
}

type TauriTransport = Pick<
  typeof api,
  | "checkRepositories"
  | "backupRepositories"
  | "retryTask"
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

  async openBackupFolder(repositoryId?: string) {
    await this.transport.openBackupFolder(repositoryId);
  }

  async checkForUpdates(_currentVersion: string) {
    return this.transport.checkAppUpdate();
  }
}

type DemoAppServiceOptions = {
  mode?: "default" | "empty-plugins";
  now?: () => Date;
};

export class DemoAppService implements AppService {
  readonly runtime = "demo" as const;
  private readonly mode: "default" | "empty-plugins";
  private readonly now: () => Date;

  constructor(options: DemoAppServiceOptions = {}) {
    this.mode = options.mode ?? "default";
    this.now = options.now ?? createDeterministicDemoClock();
  }

  async bootstrap(): Promise<AppBootstrapSnapshot> {
    return clone({
      workspace: {
        repositories: initialRepos,
        skills: initialSkills,
        plugins: this.mode === "empty-plugins" ? [] : initialPlugins,
        tasks: initialTasks,
      },
      settings: null,
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
      checkStatus: repository.id === "missing" ? "failed" : "success",
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

  async retryTask(_taskId: string, current: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    return clone(current);
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createDeterministicDemoClock(): () => Date {
  const epoch = Date.parse("2026-06-30T10:00:00.000Z");
  let tick = 0;
  return () => new Date(epoch + tick++);
}
