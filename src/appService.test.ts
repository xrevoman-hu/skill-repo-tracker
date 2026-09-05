import { describe, expect, it, vi } from "vitest";

import { DemoAppService, TauriAppService } from "./appService";
import type {
  AppSettings,
  GitHubAccount,
  GitHubRepository,
  UiPlugin,
  UiRepository,
  UiSkill,
  UiTask,
  UpdateSettingsRequest,
} from "./api";
import { createPromptLibraryApi } from "./promptLibraryAdapter";

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
      addRepository: vi.fn().mockResolvedValue([repository]),
      updateSettings: vi.fn(async (settings) => settings),
      refreshGithubRepositories: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue(null),
      listRepositories: vi.fn().mockResolvedValue([repository]),
      listSkills: vi.fn().mockResolvedValue([]),
      listPlugins: vi.fn().mockResolvedValue([]),
      listTasks: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue(settings),
      listGithubAccounts: vi.fn().mockResolvedValue([]),
      listGithubRepositoryCatalog: vi.fn().mockResolvedValue([]),
      getAppMetadata: vi.fn().mockResolvedValue(metadata),
      checkAppUpdate: vi.fn().mockResolvedValue({
        currentVersion: "1.2.2",
        latestVersion: "1.2.3",
        updateAvailable: true,
      }),
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
      addRepository: vi.fn().mockResolvedValue([repository]),
      updateSettings: vi.fn(async (settings) => settings),
      refreshGithubRepositories: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue(null),
      listRepositories: vi.fn().mockResolvedValue([repository]),
      listSkills: vi.fn().mockResolvedValue([]),
      listPlugins: vi.fn().mockResolvedValue([]),
      listTasks: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue(null),
      listGithubAccounts: vi.fn().mockResolvedValue([]),
      listGithubRepositoryCatalog: vi.fn().mockResolvedValue([]),
      getAppMetadata: vi.fn().mockResolvedValue(null),
      checkAppUpdate: vi.fn().mockResolvedValue({
        currentVersion: "1.2.2",
        latestVersion: "1.2.3",
        updateAvailable: true,
      }),
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
    await expect(service.checkForUpdates("ignored-client-version")).resolves.toEqual({
      currentVersion: "1.2.2",
      latestVersion: "1.2.3",
      updateAvailable: true,
    });

    expect(transport.backupRepositories).toHaveBeenCalledWith("updated");
    expect(transport.backupRepositories).toHaveBeenCalledWith("selected", ["repo-1"]);
    expect(transport.openBackupFolder).toHaveBeenCalledWith("repo-1");
    expect(transport.checkAppUpdate).toHaveBeenCalledOnce();
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
      addRepository: vi.fn().mockResolvedValue([repository]),
      updateSettings: vi.fn(async (settings) => settings),
      refreshGithubRepositories: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue(null),
      listRepositories: vi.fn().mockResolvedValue([repository]),
      listSkills: vi.fn().mockResolvedValue([]),
      listPlugins: vi.fn().mockResolvedValue([]),
      listTasks: vi.fn().mockResolvedValue([retriedTask]),
      getSettings: vi.fn().mockResolvedValue(null),
      listGithubAccounts: vi.fn().mockResolvedValue([]),
      listGithubRepositoryCatalog: vi.fn().mockResolvedValue([]),
      getAppMetadata: vi.fn().mockResolvedValue(null),
      checkAppUpdate: vi.fn().mockResolvedValue({
        currentVersion: "1.2.2",
        latestVersion: "1.2.2",
        updateAvailable: false,
      }),
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

  it("keeps update checks offline and deterministic in demo mode", async () => {
    const service = new DemoAppService();

    await expect(service.checkForUpdates("9.8.7")).resolves.toEqual({
      currentVersion: "9.8.7",
      latestVersion: "9.8.7",
      updateAvailable: false,
    });
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

  it("uses the repository diff for Tauri add results instead of assuming the first row is new", async () => {
    const addedRepository: UiRepository = {
      ...repository,
      id: "repo-new",
      name: "quality/demo-skill",
    };
    const transport = makeTauriTransport();
    transport.addRepository.mockResolvedValue([repository, addedRepository]);
    const service = new TauriAppService(transport);

    await expect(service.addRepository({
      url: "https://github.com/quality/demo-skill",
      refName: "main",
      note: "stable selection",
    }, {
      ...emptyWorkspace(),
      repositories: [repository],
    })).resolves.toEqual({
      repositoryId: "repo-new",
      workspace: {
        repositories: [repository, addedRepository],
        skills: [],
        plugins: [],
        tasks: [],
      },
    });
    expect(transport.addRepository).toHaveBeenCalledWith({
      url: "https://github.com/quality/demo-skill",
      refName: "main",
      note: "stable selection",
    });
  });

  it("focuses the requested repository when another repository is added concurrently", async () => {
    const unrelatedNew = { ...repository, id: "repo-other-new", name: "other/repository" };
    const requestedNew = {
      ...repository,
      id: "repo-requested-new",
      name: "Quality/Demo-Skill",
      ref: "release",
    };
    const transport = makeTauriTransport();
    transport.addRepository.mockResolvedValue([repository, unrelatedNew, requestedNew]);
    const service = new TauriAppService(transport);

    await expect(service.addRepository({
      url: "https://github.com/quality/demo-skill.git",
      refName: "release",
      note: "concurrent addition",
    }, {
      ...emptyWorkspace(),
      repositories: [repository],
    })).resolves.toMatchObject({
      repositoryId: "repo-requested-new",
    });
  });

  it("fails closed when multiple unrelated repositories are added concurrently", async () => {
    const firstNew = { ...repository, id: "repo-first-new", name: "other/first" };
    const secondNew = { ...repository, id: "repo-second-new", name: "other/second" };
    const transport = makeTauriTransport();
    transport.addRepository.mockResolvedValue([repository, firstNew, secondNew]);
    const service = new TauriAppService(transport);

    await expect(service.addRepository({
      url: "https://github.com/quality/missing",
      refName: "main",
      note: "ambiguous additions",
    }, {
      ...emptyWorkspace(),
      repositories: [repository],
    })).resolves.toMatchObject({ repositoryId: "" });
  });

  it("focuses the matching existing repository when a Tauri upsert returns no new id", async () => {
    const unrelated = { ...repository, id: "repo-unrelated", name: "other/repository" };
    const existing = { ...repository, id: "repo-existing", name: "quality/demo-skill", ref: "release" };
    const transport = makeTauriTransport();
    transport.addRepository.mockResolvedValue([unrelated, existing]);
    const service = new TauriAppService(transport);

    await expect(service.addRepository({
      url: "https://github.com/quality/demo-skill.git",
      refName: "release",
      note: "update existing",
    }, {
      ...emptyWorkspace(),
      repositories: [unrelated, existing],
    })).resolves.toMatchObject({
      repositoryId: "repo-existing",
      workspace: { repositories: [unrelated, existing] },
    });
  });

  it("delegates settings and merges scoped GitHub refreshes without retaining stale rows", async () => {
    const accountA = githubAccount("account-a", "alice");
    const accountB = githubAccount("account-b", "bob");
    const staleA = githubRepository(accountA, "old-a");
    const freshA = githubRepository(accountA, "fresh-a");
    const currentB = githubRepository(accountB, "current-b");
    const freshB = githubRepository(accountB, "fresh-b");
    const transport = makeTauriTransport();
    transport.pickDirectory.mockResolvedValue("/repositories/local-skill");
    transport.listGithubAccounts.mockResolvedValue([accountA, accountB]);
    transport.refreshGithubRepositories
      .mockResolvedValueOnce([freshA])
      .mockResolvedValueOnce([freshA, freshB]);
    const service = new TauriAppService(transport);
    const settings = { ...defaultSettings, backupRoot: "/verified-backups" };

    await expect(service.updateSettings(settings)).resolves.toEqual(settings);
    expect(transport.updateSettings).toHaveBeenCalledWith({
      backupRoot: "/verified-backups",
      skillLibraryRoot: "/skills",
      skillsRoot: undefined,
      defaultSyncTargets: [],
      syncBackupKeep: 5,
      autoCheckInterval: 60,
      autoCheckEnabled: false,
      autoBackupEnabled: false,
    });
    await expect(service.chooseLocalRepository()).resolves.toBe("/repositories/local-skill");
    expect(transport.pickDirectory).toHaveBeenCalledOnce();

    await expect(service.refreshGithubCatalog(accountA.id, {
      accounts: [accountA, accountB],
      repositories: [staleA, currentB],
    })).resolves.toEqual({
      accounts: [accountA, accountB],
      repositories: [currentB, freshA],
    });
    expect(transport.refreshGithubRepositories).toHaveBeenNthCalledWith(1, accountA.id);

    await expect(service.refreshGithubCatalog(undefined, {
      accounts: [accountA, accountB],
      repositories: [staleA, currentB],
    })).resolves.toEqual({
      accounts: [accountA, accountB],
      repositories: [freshA, freshB],
    });
    expect(transport.refreshGithubRepositories).toHaveBeenNthCalledWith(2, undefined);
  });

  it("round-trips demo settings and returns a stable id with the complete added workspace", async () => {
    const service = new DemoAppService({ now: () => new Date("2026-09-03T12:00:00Z") });
    const before = await service.bootstrap();
    const settings = {
      ...before.settings!,
      backupRoot: "/verified-backups",
      autoCheckEnabled: true,
    };

    const saved = await service.updateSettings(settings);
    saved.backupRoot = "/caller-mutation";
    const afterSettings = await service.bootstrap();
    expect(afterSettings.settings).toMatchObject({
      backupRoot: "/verified-backups",
      autoCheckEnabled: true,
    });

    const result = await service.addRepository({
      url: "https://github.com/quality/demo-skill.git",
      refName: "main",
      note: "demo repository",
    }, before.workspace);
    expect(result.repositoryId).toBe("demo:quality/demo-skill@main");
    expect(result.workspace.repositories[0]).toMatchObject({
      id: result.repositoryId,
      name: "quality/demo-skill",
      ref: "main",
      type: "skill repo",
      note: "demo repository",
    });
    expect(result.workspace.tasks[0]).toMatchObject({
      kind: "Scan repository",
      target: "quality/demo-skill",
      status: "success",
    });
    await expect(service.addRepository({
      url: "github.com/quality/demo-skill",
      refName: "main",
      note: "duplicate",
    }, result.workspace)).rejects.toThrow("Repository already exists.");
  });

  it("surfaces one structured demo GitHub rate limit and recovers without mutating the catalog", async () => {
    const service = new DemoAppService({ mode: "github-rate-limit" });
    const bootstrap = await service.bootstrap();
    const current = {
      accounts: bootstrap.githubAccounts,
      repositories: bootstrap.githubRepositories,
    };

    await expect(service.refreshGithubCatalog("github:demo", current)).rejects.toEqual({
      code: "github_secondary_rate_limited",
      message: "GitHub request was rate limited.",
      details: "status=429 reset_at=2026-09-03T12:00:00Z",
    });
    const recovered = await service.refreshGithubCatalog("github:demo", current);
    expect(recovered).toEqual(current);
    recovered.repositories[0].note = "caller mutation";
    await expect(service.refreshGithubCatalog(undefined, current)).resolves.toEqual(current);
  });

  it("defers the retry-race result until a newer repository mutation has completed", async () => {
    const service = new DemoAppService({
      mode: "retry-race",
      now: () => new Date("2026-09-03T12:00:00Z"),
    });
    const bootstrap = await service.bootstrap();
    const failed = bootstrap.workspace.tasks.find((task) => task.id === "demo-retry-failed");
    expect(failed).toMatchObject({ retryable: true, status: "failed" });

    let lateRetrySettled = false;
    const lateRetry = service.retryTask(failed!.id, bootstrap.workspace).then((workspace) => {
      lateRetrySettled = true;
      return workspace;
    });
    await Promise.resolve();
    expect(lateRetrySettled).toBe(false);

    const newer = await service.addRepository({
      url: "quality/demo-skill",
      refName: "main",
      note: "wins generation",
    }, bootstrap.workspace);
    expect(newer.workspace.repositories[0].id).toBe("demo:quality/demo-skill@main");
    expect(newer.workspace.tasks).toContainEqual(expect.objectContaining({
      id: "demo-retry-failed",
      status: "failed",
    }));

    const stale = await lateRetry;
    expect(stale.repositories).not.toContainEqual(expect.objectContaining({
      id: "demo:quality/demo-skill@main",
    }));
    expect(stale.tasks[0]).toMatchObject({
      kind: "Backup repositories",
      status: "success",
      summary: "retry completed",
    });
  });

  it("provides an offline prompt library seam for create, tag, search, export, and import", async () => {
    const service = new DemoAppService({ now: () => new Date("2026-09-03T12:00:00Z") });
    const prompts = createPromptLibraryApi(service.promptTransport);
    const tag = await prompts.createTag("质量");
    const created = await prompts.createPrompt({
      title: "发布验证提示词",
      content: "# 发布\n\n先验证公开实物。",
      tagIds: [tag.id],
      pinned: true,
    });

    const page = await prompts.listPrompts({
      query: "公开实物",
      tagIds: [tag.id],
      tagMode: "all",
      sort: "updatedDesc",
      page: 1,
      pageSize: 30,
    });
    expect(page.items).toEqual([
      expect.objectContaining({ id: created.id, title: "发布验证提示词", pinned: true }),
    ]);
    expect(await prompts.listTags()).toContainEqual(expect.objectContaining({
      id: tag.id,
      name: "质量",
      promptCount: 1,
    }));

    await expect(prompts.exportPrompt(created.id)).resolves.toMatchObject({
      path: `/tmp/${created.id}.md`,
      cancelled: false,
      count: 1,
    });
    await expect(prompts.exportPrompts({ mode: "explicit", ids: [created.id] })).resolves.toMatchObject({
      path: "/tmp/prompts.zip",
      count: 1,
      bytes: created.contentBytes,
    });
    await prompts.deletePrompt(created.id, created.revision);

    const preview = await prompts.previewPromptsZipImport();
    expect(preview).toMatchObject({
      fileName: "prompts.zip",
      promptCount: 1,
      newCount: 1,
    });
    await expect(prompts.importPromptsZip({
      path: preview!.path,
      sha256: preview!.sha256,
      sizeBytes: preview!.sizeBytes,
      expectedLibraryRevision: preview!.libraryRevision,
      conflictStrategy: "duplicate",
    })).resolves.toMatchObject({ inserted: 1, skipped: 0, tagsReused: 1 });

    await expect(prompts.listPrompts({
      query: "发布验证提示词",
      tagIds: [],
      tagMode: "any",
      sort: "manual",
      page: 1,
      pageSize: 30,
    })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ title: "发布验证提示词" })],
    });
  });

  it("keeps demo prompt reorder and tag identity stateful across mutations", async () => {
    const service = new DemoAppService({ now: () => new Date("2026-09-03T12:00:00Z") });
    const prompts = createPromptLibraryApi(service.promptTransport);
    const first = await prompts.createPrompt({ title: "第一篇", content: "first", tagIds: [], pinned: false });
    const second = await prompts.createPrompt({ title: "第二篇", content: "second", tagIds: [], pinned: false });
    const before = await prompts.listPrompts({
      query: "",
      tagIds: [],
      tagMode: "any",
      sort: "manual",
      page: 1,
      pageSize: 30,
    });

    await prompts.reorderPrompt({
      id: first.id,
      previousId: null,
      nextId: null,
      boundary: "first",
      expectedRevision: first.revision,
      expectedLibraryRevision: before.libraryRevision,
    });
    const reordered = await prompts.listPrompts({
      query: "",
      tagIds: [],
      tagMode: "any",
      sort: "manual",
      page: 1,
      pageSize: 30,
    });
    expect(reordered.items.findIndex((prompt) => prompt.id === first.id)).toBeLessThan(
      reordered.items.findIndex((prompt) => prompt.id === second.id),
    );

    const removed = await prompts.createTag("临时标签");
    await prompts.deleteTag(removed.id);
    const replacement = await prompts.createTag("替代标签");
    expect(replacement.id).not.toBe(removed.id);
  });
});

const defaultSettings: AppSettings = {
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
  githubTokenLastVerified: null,
};

function makeTauriTransport() {
  return {
    checkRepositories: vi.fn().mockResolvedValue([] as UiRepository[]),
    backupRepositories: vi.fn().mockResolvedValue([] as UiTask[]),
    retryTask: vi.fn().mockResolvedValue([] as UiTask[]),
    addRepository: vi.fn().mockResolvedValue([] as UiRepository[]),
    updateSettings: vi.fn(async (settings: UpdateSettingsRequest): Promise<AppSettings> => ({
      ...defaultSettings,
      ...settings,
    })),
    refreshGithubRepositories: vi.fn().mockResolvedValue([] as GitHubRepository[]),
    pickDirectory: vi.fn().mockResolvedValue(null),
    listRepositories: vi.fn().mockResolvedValue([] as UiRepository[]),
    listSkills: vi.fn().mockResolvedValue([] as UiSkill[]),
    listPlugins: vi.fn().mockResolvedValue([] as UiPlugin[]),
    listTasks: vi.fn().mockResolvedValue([] as UiTask[]),
    getSettings: vi.fn().mockResolvedValue(defaultSettings),
    listGithubAccounts: vi.fn().mockResolvedValue([] as GitHubAccount[]),
    listGithubRepositoryCatalog: vi.fn().mockResolvedValue([] as GitHubRepository[]),
    getAppMetadata: vi.fn().mockResolvedValue(null),
    checkAppUpdate: vi.fn().mockResolvedValue({
      currentVersion: "1.2.2",
      latestVersion: "1.2.2",
      updateAvailable: false,
    }),
    openBackupFolder: vi.fn().mockResolvedValue(undefined),
  };
}

function githubAccount(id: string, login: string): GitHubAccount {
  return {
    id,
    login,
    displayName: login,
    status: "verified",
    scopes: "repo",
  };
}

function githubRepository(account: GitHubAccount, repo: string): GitHubRepository {
  return {
    accountId: account.id,
    accountLogin: account.login,
    owner: account.login,
    repo,
    fullName: `${account.login}/${repo}`,
    htmlUrl: `https://github.com/${account.login}/${repo}`,
    description: "fixture",
    visibility: "private",
    private: true,
    fork: false,
    archived: false,
    defaultBranch: "main",
    language: "TypeScript",
    stargazersCount: 0,
    starred: false,
    permissions: "pull",
    note: "",
  };
}

function emptyWorkspace(): {
  repositories: UiRepository[];
  skills: UiSkill[];
  plugins: UiPlugin[];
  tasks: UiTask[];
} {
  return { repositories: [], skills: [], plugins: [], tasks: [] };
}
