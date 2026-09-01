import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { GithubPreview } from "./api";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("governed Tauri API boundary", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ ok: true, data: "/private/backups" });
  });

  it("opens backup locations by stable repository identity, never a frontend path", async () => {
    const { api } = await import("./api");

    await api.openBackupFolder("repo-42");
    await api.openBackupFolder();

    expect(invoke).toHaveBeenNthCalledWith(1, "open_backup_folder", {
      request: { repositoryId: "repo-42" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "open_backup_folder", {
      request: { repositoryId: undefined },
    });
  });

  it("does not expose the removed persistent schedule writer", async () => {
    const { api } = await import("./api");
    expect("configureSchedule" in api).toBe(false);
  });

  it("matches the nullable README field returned by the Rust preview contract", () => {
    expectTypeOf<GithubPreview["readme"]>().toEqualTypeOf<string | null>();
    const response = {
      title: "Example",
      url: "https://github.com/example/repo",
      defaultBranch: "main",
      resolvedRef: "main",
      sha: "abc",
      readme: null,
    } satisfies GithubPreview;

    expect(response.readme).toBeNull();
  });

  it("keeps settings, checks, backups, and retries inside typed request envelopes", async () => {
    const { api } = await import("./api");
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

    await api.updateSettings(settings);
    await api.checkRepositories(["repo-1"]);
    await api.backupRepositories("selected", ["repo-1"]);
    await api.retryTask("task-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "update_settings", { request: settings });
    expect(invoke).toHaveBeenNthCalledWith(2, "check_repositories", {
      request: { repoIds: ["repo-1"] },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "backup_repositories", {
      request: { mode: "selected", repoIds: ["repo-1"] },
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "retry_task", {
      request: { taskId: "task-1" },
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/concurrency|retryCount|cleanupKeep/);
  });
});
