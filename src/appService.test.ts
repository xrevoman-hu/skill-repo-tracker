import { describe, expect, it, vi } from "vitest";

import { DemoAppService, TauriAppService } from "./appService";
import type { UiPlugin, UiRepository, UiSkill, UiTask } from "./api";

const repository: UiRepository = {
  id: "repo-1",
  name: "example/repo",
  type: "skill repo",
  ref: "main",
  skills: 1,
  remoteSha: "abc",
  lastBackupSha: "none",
  backupStatus: "never-backed-up",
  checkStatus: "success",
};

describe("AppService adapters", () => {
  it("owns the demo bootstrap snapshot and keeps the empty-plugins scenario explicit", async () => {
    const populated = await new DemoAppService().bootstrap();
    const emptyPlugins = await new DemoAppService({ mode: "empty-plugins" }).bootstrap();

    expect(populated.workspace.repositories[0]?.name).toBe("example-org/content-skill-kit");
    expect(populated.githubAccounts[0]?.login).toBe("demo-user");
    expect(populated.workspace.plugins.length).toBeGreaterThan(0);
    expect(emptyPlugins.workspace.repositories[0]?.name).toBe("example-org/content-skill-kit");
    expect(emptyPlugins.workspace.plugins).toEqual([]);
  });

  it("returns one complete Tauri bootstrap snapshot across all persisted domains", async () => {
    const settings = {
      backupRoot: "/backups",
      skillLibraryRoot: "/skills",
      defaultSyncTargets: [],
      availableSyncTargets: [],
      syncBackupKeep: 5,
      autoCheckInterval: 60,
      autoCheckEnabled: false,
      autoBackupEnabled: false,
      githubTokenConfigured: false,
      githubTokenStatus: "not_configured",
    };
    const metadata = {
      name: "Skill Repo Tracker",
      version: "1.2.2",
      projectGithubUrl: "https://github.com/example/project",
      openSource: true,
    };
    const transport = {
      checkRepositories: vi.fn().mockResolvedValue([repository]),
      backupRepositories: vi.fn().mockResolvedValue([]),
      retryTask: vi.fn().mockResolvedValue([]),
      listRepositories: vi.fn().mockResolvedValue([repository]),
      listSkills: vi.fn().mockResolvedValue([]),
      listPlugins: vi.fn().mockResolvedValue([]),
      listTasks: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue(settings),
      listGithubAccounts: vi.fn().mockResolvedValue([]),
      listGithubRepositoryCatalog: vi.fn().mockResolvedValue([]),
      getAppMetadata: vi.fn().mockResolvedValue(metadata),
      openBackupFolder: vi.fn().mockResolvedValue("/backups/repo-1"),
    };

    await expect(new TauriAppService(transport).bootstrap()).resolves.toEqual({
      workspace: {
        repositories: [repository],
        skills: [],
        plugins: [],
        tasks: [],
      },
      settings,
      githubAccounts: [],
      githubRepositories: [],
      appMetadata: metadata,
    });
  });

  it("keeps Tauri transport outside product controllers", async () => {
    const transport = {
      checkRepositories: vi.fn().mockResolvedValue([repository]),
      backupRepositories: vi.fn().mockResolvedValue([]),
      retryTask: vi.fn().mockResolvedValue([]),
      listRepositories: vi.fn().mockResolvedValue([repository]),
      listSkills: vi.fn().mockResolvedValue([]),
      listPlugins: vi.fn().mockResolvedValue([]),
      listTasks: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue(null),
      listGithubAccounts: vi.fn().mockResolvedValue([]),
      listGithubRepositoryCatalog: vi.fn().mockResolvedValue([]),
      getAppMetadata: vi.fn().mockResolvedValue(null),
      openBackupFolder: vi.fn().mockResolvedValue("/backups/repo-1"),
    };
    const service = new TauriAppService(transport);

    await expect(service.checkRepositories(emptyWorkspace())).resolves.toEqual({
      repositories: [repository],
      skills: [],
      plugins: [],
      tasks: [],
    });
    await expect(service.backupRepositories({
      ...emptyWorkspace(),
      mode: "updated",
      repositoryIds: ["repo-1"],
      backupRoot: "/backups",
    })).resolves.toEqual({ repositories: [repository], tasks: [] });
    await expect(service.backupRepositories({
      ...emptyWorkspace(),
      mode: "selected",
      repositoryIds: ["repo-1"],
      backupRoot: "/backups",
    })).resolves.toEqual({ repositories: [repository], tasks: [] });
    await service.openBackupFolder("repo-1");

    expect(transport.backupRepositories).toHaveBeenCalledWith("updated");
    expect(transport.backupRepositories).toHaveBeenCalledWith("selected", ["repo-1"]);
    expect(transport.openBackupFolder).toHaveBeenCalledWith("repo-1");
  });

  it("refreshes the complete workspace after a persisted task retry", async () => {
    const retriedTask: UiTask = {
      id: "retry-1",
      kind: "Backup repositories",
      target: "example/repo",
      progress: "0 / 1",
      status: "queued",
      summary: "retry queued",
      retryable: false,
      log: [],
    };
    const transport = {
      checkRepositories: vi.fn().mockResolvedValue([]),
      backupRepositories: vi.fn().mockResolvedValue([]),
      retryTask: vi.fn().mockResolvedValue([retriedTask]),
      listRepositories: vi.fn().mockResolvedValue([repository]),
      listSkills: vi.fn().mockResolvedValue([]),
      listPlugins: vi.fn().mockResolvedValue([]),
      listTasks: vi.fn().mockResolvedValue([retriedTask]),
      getSettings: vi.fn().mockResolvedValue(null),
      listGithubAccounts: vi.fn().mockResolvedValue([]),
      listGithubRepositoryCatalog: vi.fn().mockResolvedValue([]),
      getAppMetadata: vi.fn().mockResolvedValue(null),
      openBackupFolder: vi.fn().mockResolvedValue(undefined),
    };

    await expect(new TauriAppService(transport).retryTask("task-1", emptyWorkspace())).resolves.toEqual({
      repositories: [repository],
      skills: [],
      plugins: [],
      tasks: [retriedTask],
    });
    expect(transport.retryTask).toHaveBeenCalledWith("task-1");
  });

  it("keeps demo data local and deterministic", async () => {
    const task: UiTask = {
      id: "task-1",
      kind: "Check remote state",
      target: "All repositories",
      progress: "1 / 1",
      status: "success",
      summary: "1 success",
      retryable: false,
      log: [],
    };
    const service = new DemoAppService({ now: () => new Date("2026-08-31T12:00:00Z") });
    const workspace = { ...emptyWorkspace(), repositories: [repository], tasks: [task] };

    const first = await service.checkRepositories(workspace);
    first.repositories[0].name = "mutated by caller";
    const second = await service.checkRepositories(workspace);

    expect(second.repositories[0].name).toBe("example/repo");
    expect(second.repositories[0].lastChecked).toBe("2026-08-31T12:00:00.000Z");
    await expect(service.openBackupFolder("repo-1")).resolves.toBeUndefined();
  });

  it("uses the same deterministic logical clock in every default demo runtime", async () => {
    const first = await new DemoAppService().checkRepositories({
      ...emptyWorkspace(),
      repositories: [repository],
    });
    const second = await new DemoAppService().checkRepositories({
      ...emptyWorkspace(),
      repositories: [repository],
    });

    expect(first.repositories[0].lastChecked).toBe("2026-06-30T10:00:00.000Z");
    expect(second.repositories[0].lastChecked).toBe(first.repositories[0].lastChecked);
    expect(second.tasks[0].id).toBe(first.tasks[0].id);
  });

  it("backs up only successful stable ids and preserves failed repositories", async () => {
    const failedRepository: UiRepository = {
      ...repository,
      id: "repo-failed",
      name: "example/failed",
      checkStatus: "failed",
    };
    const service = new DemoAppService({ now: () => new Date("2026-08-31T12:00:00Z") });
    const result = await service.backupRepositories({
      ...emptyWorkspace(),
      repositories: [repository, failedRepository],
      mode: "selected",
      repositoryIds: [repository.id, failedRepository.id],
      backupRoot: "/backups",
    });

    expect(result.repositories[0]).toMatchObject({
      id: repository.id,
      backupStatus: "backed-up-latest",
      lastBackupSha: repository.remoteSha,
    });
    expect(result.repositories[1]).toEqual(failedRepository);
    expect(result.tasks[0]).toMatchObject({
      status: "partial-success",
      summary: "1 success, 1 skipped",
    });
  });
});

function emptyWorkspace(): {
  repositories: UiRepository[];
  skills: UiSkill[];
  plugins: UiPlugin[];
  tasks: UiTask[];
} {
  return { repositories: [], skills: [], plugins: [], tasks: [] };
}
