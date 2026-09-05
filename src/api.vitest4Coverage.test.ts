import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("complete public Tauri API wire contract", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ ok: true, data: { accepted: true } });
  });

  it("fails closed outside Tauri before attempting IPC", async () => {
    const { api, isDesktopRuntime } = await import("./api");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    expect(isDesktopRuntime()).toBe(false);
    await expect(api.listRepositories()).rejects.toThrow(
      "Tauri backend is not available in browser preview.",
    );
    expect(invoke).not.toHaveBeenCalled();

    Object.assign(window, { __TAURI_INTERNALS__: {} });
    expect(isDesktopRuntime()).toBe(true);
  });

  it("returns successful data and preserves typed backend errors", async () => {
    const { api } = await import("./api");
    const repositories = [{ id: "repo-1" }];
    invoke.mockResolvedValueOnce({ ok: true, data: repositories });

    await expect(api.listRepositories()).resolves.toBe(repositories);

    invoke.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "github_rate_limited",
        message: "Too many requests",
        details: "retry-after=60",
      },
    });
    await expect(api.listRepositories()).rejects.toMatchObject({
      message: "Too many requests",
      code: "github_rate_limited",
      details: "retry-after=60",
    });

    invoke.mockResolvedValueOnce({ ok: false });
    await expect(api.listRepositories()).rejects.toMatchObject({
      message: "Command failed",
      code: undefined,
      details: undefined,
    });
  });

  it("maps every public capability to its exact command and request envelope", async () => {
    const { api } = await import("./api");
    const noteRequest = { target: "repository", id: "repo-1", note: "kept" };
    const settings = {
      backupRoot: "/backups",
      skillLibraryRoot: "/skills",
      skillsRoot: "/skills",
      defaultSyncTargets: ["codex"],
      syncBackupKeep: 5,
      autoCheckInterval: 60,
      autoCheckEnabled: true,
      autoBackupEnabled: false,
    };
    const promptList = {
      page: 1,
      pageSize: 30 as const,
      query: "治理",
      tagIds: ["tag-1"],
      tagMode: "any" as const,
      sort: "manual" as const,
    };
    const createPrompt = { title: "Title", content: "Body", tagIds: ["tag-1"] };
    const updatePrompt = { id: "prompt-1", ...createPrompt, expectedRevision: 2 };
    const reorderPrompt = {
      id: "prompt-1",
      previousId: null,
      nextId: "prompt-2",
      expectedRevision: 2,
      expectedLibraryRevision: 9,
    };
    const promptSelection = { mode: "explicit" as const, ids: ["prompt-1"] };
    const zipImport = {
      path: "/tmp/prompts.zip",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      expectedLibraryRevision: 9,
      conflictStrategy: "duplicate" as const,
    };
    const cases: Array<{
      call: () => Promise<unknown>;
      name: string;
      args?: Record<string, unknown>;
    }> = [
      { call: () => api.listRepositories(), name: "list_repositories" },
      { call: () => api.listSkills(), name: "list_skills" },
      { call: () => api.listPlugins(), name: "list_plugins" },
      { call: () => api.updateItemNote(noteRequest), name: "update_item_note", args: { request: noteRequest } },
      { call: () => api.getSkillDetail("skill-1"), name: "get_skill_detail", args: { request: { skillId: "skill-1" } } },
      { call: () => api.getPluginDetail("plugin-1"), name: "get_plugin_detail", args: { request: { pluginId: "plugin-1" } } },
      { call: () => api.getRepositoryReadme("repo-1"), name: "get_repository_readme", args: { request: { repoId: "repo-1" } } },
      { call: () => api.getGithubPreview("https://github.com/acme/demo"), name: "get_github_preview", args: { request: { url: "https://github.com/acme/demo" } } },
      { call: () => api.listTasks(), name: "list_tasks" },
      { call: () => api.getAppMetadata(), name: "get_app_metadata" },
      { call: () => api.checkAppUpdate(), name: "check_app_update" },
      { call: () => api.getSettings(), name: "get_settings" },
      { call: () => api.pickDirectory("/tmp"), name: "pick_directory", args: { defaultPath: "/tmp" } },
      { call: () => api.validateDirectory("backup", "/tmp"), name: "validate_directory", args: { request: { kind: "backup", path: "/tmp" } } },
      { call: () => api.updateSettings(settings), name: "update_settings", args: { request: settings } },
      { call: () => api.addRepository({ url: "https://github.com/acme/demo", refName: "main" }), name: "add_repository", args: { request: { url: "https://github.com/acme/demo", refName: "main" } } },
      { call: () => api.addLocalRepository("/tmp/repo"), name: "add_local_repository", args: { request: { path: "/tmp/repo" } } },
      { call: () => api.checkRepositories(["repo-1"]), name: "check_repositories", args: { request: { repoIds: ["repo-1"] } } },
      { call: () => api.backupRepositories("selected", ["repo-1"]), name: "backup_repositories", args: { request: { mode: "selected", repoIds: ["repo-1"] } } },
      { call: () => api.scanLocalSkills("/tmp/skills"), name: "scan_local_skills", args: { request: { root: "/tmp/skills" } } },
      { call: () => api.installSkill("skill-1"), name: "install_skill", args: { request: { skillId: "skill-1" } } },
      { call: () => api.updateSkill("skill-1"), name: "update_skill", args: { request: { skillId: "skill-1" } } },
      { call: () => api.getSkillUpdateConflict("skill-1"), name: "get_skill_update_conflict", args: { request: { skillId: "skill-1" } } },
      { call: () => api.verifySkillUpdateConflict("conflict-1"), name: "verify_skill_update_conflict", args: { request: { conflictId: "conflict-1" } } },
      { call: () => api.confirmSkillUpdateConflict("conflict-1"), name: "confirm_skill_update_conflict", args: { request: { conflictId: "conflict-1" } } },
      { call: () => api.openSkillFolder("skill-1"), name: "open_skill_folder", args: { request: { skillId: "skill-1" } } },
      { call: () => api.deleteSkill("skill-1"), name: "delete_skill", args: { request: { skillId: "skill-1", mode: "backup_then_remove" } } },
      { call: () => api.restoreSkill("skill-1"), name: "restore_skill", args: { request: { skillId: "skill-1" } } },
      { call: () => api.syncInstalledSkills(), name: "sync_installed_skills" },
      { call: () => api.updateSkillSyncTargets("skill-1", "custom", ["codex"]), name: "update_skill_sync_targets", args: { request: { skillId: "skill-1", mode: "custom", targets: ["codex"] } } },
      { call: () => api.retryTask("task-1"), name: "retry_task", args: { request: { taskId: "task-1" } } },
      { call: () => api.cancelTask("task-1"), name: "cancel_task", args: { request: { taskId: "task-1" } } },
      { call: () => api.copyTaskSummary("task-1"), name: "copy_task_summary", args: { request: { taskId: "task-1" } } },
      { call: () => api.removeRepository("repo-1"), name: "remove_repository", args: { id: "repo-1" } },
      { call: () => api.listGithubAccounts(), name: "list_github_accounts" },
      { call: () => api.saveGithubAccountToken("token"), name: "save_github_account_token", args: { request: { token: "token" } } },
      { call: () => api.deleteGithubAccount("account-1"), name: "delete_github_account", args: { request: { accountId: "account-1" } } },
      { call: () => api.validateGithubAccount("account-1"), name: "validate_github_account", args: { request: { accountId: "account-1" } } },
      { call: () => api.refreshGithubRepositories("account-1"), name: "refresh_github_repositories", args: { request: { accountId: "account-1" } } },
      { call: () => api.listGithubRepositoryCatalog("account-1"), name: "list_github_repository_catalog", args: { request: { accountId: "account-1" } } },
      { call: () => api.setGithubStar("account-1", "acme", "demo", true), name: "set_github_star", args: { request: { accountId: "account-1", owner: "acme", repo: "demo", starred: true } } },
      { call: () => api.addRepositoryFromGithub("account-1", "acme", "demo", "main"), name: "add_repository_from_github", args: { request: { accountId: "account-1", owner: "acme", repo: "demo", refName: "main" } } },
      { call: () => api.setGithubToken("token"), name: "set_github_token", args: { request: { token: "token" } } },
      { call: () => api.clearGithubToken(), name: "clear_github_token" },
      { call: () => api.validateGithubToken(), name: "validate_github_token" },
      { call: () => api.listBackupHistory(), name: "list_backup_history" },
      { call: () => api.listPrompts(promptList), name: "list_prompts", args: { request: promptList } },
      { call: () => api.getPromptDetail("prompt-1"), name: "get_prompt_detail", args: { request: { id: "prompt-1" } } },
      { call: () => api.createPrompt(createPrompt), name: "create_prompt", args: { request: createPrompt } },
      { call: () => api.updatePrompt(updatePrompt), name: "update_prompt", args: { request: updatePrompt } },
      { call: () => api.deletePrompt("prompt-1", 2), name: "delete_prompt", args: { request: { id: "prompt-1", expectedRevision: 2 } } },
      { call: () => api.setPromptPinned("prompt-1", true, 2), name: "set_prompt_pinned", args: { request: { id: "prompt-1", pinned: true, expectedRevision: 2 } } },
      { call: () => api.reorderPrompt(reorderPrompt), name: "reorder_prompt", args: { request: reorderPrompt } },
      { call: () => api.listPromptTags(), name: "list_prompt_tags" },
      { call: () => api.createPromptTag("new tag"), name: "create_prompt_tag", args: { request: { name: "new tag" } } },
      { call: () => api.renamePromptTag("tag-1", "renamed"), name: "rename_prompt_tag", args: { request: { tagId: "tag-1", name: "renamed" } } },
      { call: () => api.mergePromptTags("tag-1", "tag-2"), name: "merge_prompt_tags", args: { request: { sourceTagId: "tag-1", targetTagId: "tag-2" } } },
      { call: () => api.deletePromptTag("tag-1"), name: "delete_prompt_tag", args: { request: { tagId: "tag-1" } } },
      { call: () => api.exportPromptMarkdown("prompt-1"), name: "export_prompt_markdown", args: { request: { id: "prompt-1" } } },
      { call: () => api.exportPromptsZip(promptSelection), name: "export_prompts_zip", args: { request: { selection: promptSelection } } },
      { call: () => api.previewPromptsZipImport(), name: "preview_prompts_zip_import" },
      { call: () => api.importPromptsZip(zipImport), name: "import_prompts_zip", args: { request: zipImport } },
      { call: () => api.previewPromptMigrationPackage(), name: "preview_prompt_migration_package" },
      { call: () => api.exportMigrationPackage(true), name: "export_migration_package", args: { request: { includePrompts: true } } },
      { call: () => api.importMigrationPackage("/tmp/library.srtmigration", "overwrite", "b".repeat(64), 2048), name: "import_migration_package", args: { request: { path: "/tmp/library.srtmigration", conflictStrategy: "overwrite", expectedPackageSha256: "b".repeat(64), expectedPackageSizeBytes: 2048 } } },
      { call: () => api.openBackupFolder("repo-1"), name: "open_backup_folder", args: { request: { repositoryId: "repo-1" } } },
      { call: () => api.openUrl("https://github.com/acme/demo", "system", "browser-1"), name: "open_url", args: { request: { url: "https://github.com/acme/demo", mode: "system", browserId: "browser-1" } } },
      { call: () => api.openExternalUrl("https://github.com/acme/demo"), name: "open_external_url", args: { request: { url: "https://github.com/acme/demo" } } },
      { call: () => api.listSystemBrowsers(), name: "list_system_browsers" },
    ];

    for (const [index, item] of cases.entries()) {
      invoke.mockClear();
      await item.call();
      expect(invoke, `${index}: ${item.name}`).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith(item.name, item.args ?? {});
    }
  });

  it("localizes unknown, Chinese, fallback, and duplicate-detail errors without data loss", async () => {
    const { localizedApiErrorMessage } = await import("./api");

    expect(localizedApiErrorMessage("plain failure", "en", "fallback")).toBe("plain failure");
    expect(localizedApiErrorMessage(null, "en", "fallback")).toBe("fallback");
    expect(localizedApiErrorMessage({ message: "object failure" }, "zh", "fallback")).toBe("object failure");
    expect(localizedApiErrorMessage({ code: 42, message: 7 }, "en", "fallback")).toBe("fallback");
    expect(localizedApiErrorMessage({
      code: "prompt_not_found",
      message: "本地消息",
      details: "id=prompt-1",
    }, "en", "fallback")).toBe("This prompt no longer exists. (id=prompt-1)");
    expect(localizedApiErrorMessage(new Error("failure (same-detail)"), "zh", "fallback")).toBe(
      "failure (same-detail)",
    );
  });
});
