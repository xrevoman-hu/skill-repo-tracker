import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { DemoAppService, TauriAppService } from "./appService";
import type { AppService, WorkspaceSnapshot } from "./appService";
import type { UiTask } from "./api";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn().mockResolvedValue(() => undefined),
  }),
}));

describe("application bootstrap", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.history.replaceState(null, "", "/?tab=repositories&lang=zh");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("fails closed when one persisted desktop domain cannot be loaded", async () => {
    const listPlugins = vi.fn().mockRejectedValue(new Error("plugin bootstrap failed"));
    const service = new TauriAppService({
      checkRepositories: vi.fn().mockResolvedValue([]),
      backupRepositories: vi.fn().mockResolvedValue([]),
      retryTask: vi.fn().mockResolvedValue([]),
      addRepository: vi.fn().mockResolvedValue([]),
      updateSettings: vi.fn(async (settings) => settings),
      refreshGithubRepositories: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue(null),
      listRepositories: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      listPlugins,
      listTasks: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue(null),
      listGithubAccounts: vi.fn().mockResolvedValue([]),
      listGithubRepositoryCatalog: vi.fn().mockResolvedValue([]),
      getAppMetadata: vi.fn().mockResolvedValue(null),
      checkAppUpdate: vi.fn().mockResolvedValue({
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateAvailable: false,
      }),
      openBackupFolder: vi.fn().mockResolvedValue(undefined),
    });

    render(<App appService={service} />);

    await waitFor(() => expect(listPlugins).toHaveBeenCalledOnce());
    expect(await screen.findByText("plugin bootstrap failed")).toBeInTheDocument();
    expect(screen.queryByText("example-org/content-skill-kit")).not.toBeInTheDocument();
    expect(screen.queryByText("demo-user")).not.toBeInTheDocument();
  });

  it("retries through the foreground coordinator and publishes the refreshed workspace", async () => {
    const user = userEvent.setup();
    const failedTask: UiTask = {
      id: "failed-1",
      kind: "Backup repositories",
      target: "repo-1",
      progress: "0 / 1",
      status: "failed",
      summary: "network failed",
      retryable: true,
      log: ["network failed"],
    };
    const initial: WorkspaceSnapshot = {
      repositories: [],
      skills: [],
      plugins: [],
      tasks: [failedTask],
    };
    const refreshed: WorkspaceSnapshot = {
      repositories: [{
        id: "fresh-repo",
        name: "example/fresh-repo",
        type: "skill repo",
        ref: "main",
        skills: 0,
        remoteSha: "abc",
        lastBackupSha: "none",
        backupStatus: "never-backed-up",
        checkStatus: "success",
      }],
      skills: [],
      plugins: [],
      tasks: [{ ...failedTask, id: "retry-1", status: "queued", retryable: false }],
    };
    const retryTask = vi.fn().mockResolvedValue(refreshed);
    const service: AppService = {
      runtime: "tauri",
      promptTransport: new DemoAppService().promptTransport,
      bootstrap: vi.fn().mockResolvedValue({
        workspace: initial,
        settings: null,
        githubAccounts: [],
        githubRepositories: [],
        appMetadata: null,
      }),
      checkRepositories: vi.fn(),
      backupRepositories: vi.fn(),
      retryTask,
      addRepository: vi.fn(),
      updateSettings: vi.fn(),
      refreshGithubCatalog: vi.fn(),
      chooseLocalRepository: vi.fn().mockResolvedValue(null),
      openBackupFolder: vi.fn(),
      checkForUpdates: vi.fn().mockResolvedValue({
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateAvailable: false,
      }),
    };
    window.history.replaceState(null, "", "/?tab=tasks&lang=zh");

    render(<App appService={service} />);
    await user.click((await screen.findAllByRole("button", { name: "重试: repo-1" }))[0]);

    await waitFor(() => expect(retryTask).toHaveBeenCalledWith("failed-1", initial));
    await user.click(screen.getByRole("button", { name: "仓库" }));
    expect(await screen.findByText("example/fresh-repo")).toBeInTheDocument();
  });

  it("checks releases through AppService without browser network access", async () => {
    const user = userEvent.setup();
    const browserFetch = vi.fn();
    const browserOpen = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("fetch", browserFetch);
    const checkForUpdates = vi.fn().mockResolvedValue({
      currentVersion: "1.2.2",
      latestVersion: "1.2.3",
      updateAvailable: true,
    });
    const service: AppService = {
      runtime: "demo",
      promptTransport: new DemoAppService().promptTransport,
      bootstrap: vi.fn().mockResolvedValue({
        workspace: { repositories: [], skills: [], plugins: [], tasks: [] },
        settings: null,
        githubAccounts: [],
        githubRepositories: [],
        appMetadata: {
          name: "Skill Repo Tracker",
          version: "1.2.2",
          projectGithubUrl: "https://github.com/example/project",
          openSource: true,
        },
      }),
      checkRepositories: vi.fn(),
      backupRepositories: vi.fn(),
      retryTask: vi.fn(),
      addRepository: vi.fn(),
      updateSettings: vi.fn(),
      refreshGithubCatalog: vi.fn(),
      chooseLocalRepository: vi.fn().mockResolvedValue(null),
      openBackupFolder: vi.fn(),
      checkForUpdates,
    };
    window.history.replaceState(null, "", "/?tab=settings&lang=zh");

    render(<App appService={service} />);
    await user.click(await screen.findByRole("button", { name: "检查更新" }));

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledWith("1.2.2"));
    expect(browserFetch).not.toHaveBeenCalled();
    expect((await screen.findAllByText("发现新版本 v1.2.3")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "进入 GitHub" }));
    expect(browserOpen).toHaveBeenCalledWith(
      "https://github.com/example/project",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
