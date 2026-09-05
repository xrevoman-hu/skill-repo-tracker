import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { api } from "./api";
import { DemoAppService } from "./appService";

describe("App service seams", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.history.replaceState(null, "", "/?lang=zh");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("persists settings through the injected demo service and reapplies its normalized response", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService();
    const existingSettings = (await service.bootstrap()).settings!;
    const updateSettings = vi.spyOn(service, "updateSettings").mockImplementation(async (settings) => ({
      ...existingSettings,
      ...settings,
      backupRoot: "/normalized/backups",
      skillLibraryRoot: "/normalized/skills",
      skillsRoot: "/normalized/skills",
    }));
    window.history.replaceState(null, "", "/?tab=settings&lang=zh");

    render(<App appService={service} />);

    const backupRoot = await screen.findByRole("textbox", { name: "本地目录" });
    const skillLibraryRoot = screen.getByRole("textbox", { name: "Skill 主库目录" });
    await user.clear(backupRoot);
    await user.type(backupRoot, "/requested/backups");
    await user.clear(skillLibraryRoot);
    await user.type(skillLibraryRoot, "/requested/skills");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    expect(updateSettings).toHaveBeenCalledWith({
      backupRoot: "/requested/backups",
      skillLibraryRoot: "/requested/skills",
      skillsRoot: "/requested/skills",
      defaultSyncTargets: [],
      syncBackupKeep: 5,
      autoCheckInterval: 60,
      autoCheckEnabled: false,
      autoBackupEnabled: false,
    });
    await waitFor(() => {
      expect(backupRoot).toHaveValue("/normalized/backups");
      expect(skillLibraryRoot).toHaveValue("/normalized/skills");
    });
    expect(screen.getByRole("status")).toHaveTextContent("设置已保存。");
  });

  it("shows structured GitHub 429 details and permits a deterministic retry", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService({ mode: "github-rate-limit" });
    const refreshGithubCatalog = vi.spyOn(service, "refreshGithubCatalog");
    const browserFetch = vi.fn();
    vi.stubGlobal("fetch", browserFetch);
    window.history.replaceState(null, "", "/?tab=github&lang=zh");

    render(<App appService={service} />);

    const refresh = await screen.findByRole("button", { name: "刷新 GitHub" });
    await user.click(refresh);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "GitHub request was rate limited. (status=429 reset_at=2026-09-03T12:00:00Z)",
    );
    await waitFor(() => expect(refresh).toBeEnabled());
    await user.click(refresh);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "远端状态已刷新。检测失败仓库保留上次已知 SHA。",
      );
    });
    expect(refreshGithubCatalog).toHaveBeenCalledTimes(2);
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("keeps concurrent account-scoped GitHub refreshes from overwriting each other", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService();
    const base = await service.bootstrap();
    const accountA = { ...base.githubAccounts[0], id: "account-a", login: "alice", displayName: "alice" };
    const accountB = { ...base.githubAccounts[0], id: "account-b", login: "bob", displayName: "bob" };
    const repositoryA = {
      ...base.githubRepositories[0],
      accountId: accountA.id,
      accountLogin: accountA.login,
      owner: accountA.login,
      repo: "old-a",
      fullName: "alice/old-a",
    };
    const repositoryB = {
      ...base.githubRepositories[0],
      accountId: accountB.id,
      accountLogin: accountB.login,
      owner: accountB.login,
      repo: "old-b",
      fullName: "bob/old-b",
    };
    vi.spyOn(service, "bootstrap").mockResolvedValue({
      ...base,
      githubAccounts: [accountA, accountB],
      githubRepositories: [repositoryA, repositoryB],
    });
    type Catalog = Awaited<ReturnType<DemoAppService["refreshGithubCatalog"]>>;
    let resolveA!: (value: Catalog | PromiseLike<Catalog>) => void;
    let resolveB!: (value: Catalog | PromiseLike<Catalog>) => void;
    vi.spyOn(service, "refreshGithubCatalog").mockImplementation((accountId) => new Promise((resolve) => {
      if (accountId === accountA.id) resolveA = resolve;
      if (accountId === accountB.id) resolveB = resolve;
    }));
    window.history.replaceState(null, "", "/?tab=github&lang=zh");

    render(<App appService={service} />);
    await user.click(await screen.findByRole("button", { name: "刷新 GitHub" }));
    await user.click(screen.getByRole("button", { name: /bob/ }));
    await user.click(screen.getByRole("button", { name: "刷新 GitHub" }));

    resolveB({
      accounts: [accountA, accountB],
      repositories: [repositoryA, { ...repositoryB, repo: "fresh-b", fullName: "bob/fresh-b" }],
    });
    await waitFor(() => expect(screen.getByText("bob/fresh-b")).toBeInTheDocument());
    resolveA({
      accounts: [accountA, accountB],
      repositories: [{ ...repositoryA, repo: "fresh-a", fullName: "alice/fresh-a" }, repositoryB],
    });
    await user.click(screen.getByRole("button", { name: /alice/ }));
    await waitFor(() => expect(screen.getByText("alice/fresh-a")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /bob/ }));
    expect(screen.getByText("bob/fresh-b")).toBeInTheDocument();
  });

  it("focuses the stable repository id while superseding a late retry and removing optimistic state", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService({ mode: "retry-race" });
    window.history.replaceState(null, "", "/?tab=tasks&lang=zh");

    const { container } = render(<App appService={service} />);

    const retry = (await screen.findAllByRole("button", {
      name: "重试: example-org/content-skill-kit",
    }))[0];
    await user.click(retry);
    await waitFor(() => expect(retry).toBeDisabled());

    await user.click(screen.getByRole("button", { name: "仓库" }));
    await user.click(await screen.findByRole("button", { name: "添加仓库" }));
    const dialog = await screen.findByRole("dialog", { name: "添加仓库" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "仓库 URL 或 owner/repo" }),
      "aaa/demo-skill",
    );
    await user.click(within(dialog).getByRole("button", { name: "添加并扫描" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加仓库" })).not.toBeInTheDocument());
    const stableId = "demo:aaa/demo-skill@main";
    const row = await waitFor(() => {
      const candidate = container.querySelector<HTMLTableRowElement>(`tr[data-repository-id="${stableId}"]`);
      expect(candidate).toBeInTheDocument();
      return candidate as HTMLTableRowElement;
    });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(within(row).getByRole("checkbox", { name: "仓库: aaa/demo-skill" })).toBeChecked();
    expect(container.querySelector(".inspector-title h2")).toHaveTextContent("aaa/demo-skill");

    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(await screen.findByText("network failed before manifest write")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("retry completed")).not.toBeInTheDocument();
      expect(screen.queryByText("已开始重试任务")).not.toBeInTheDocument();
      expect(screen.getByRole("button", {
        name: "重试: example-org/content-skill-kit",
      })).toBeEnabled();
    });
  });

  it("loads the Prompt tab through appService.promptTransport instead of the global Tauri API", async () => {
    const service = new DemoAppService();
    const serviceListPrompts = vi.spyOn(service.promptTransport, "listPrompts");
    const serviceListTags = vi.spyOn(service.promptTransport, "listPromptTags");
    const globalListPrompts = vi.spyOn(api, "listPrompts").mockRejectedValue(new Error("wrong transport"));
    const globalListTags = vi.spyOn(api, "listPromptTags").mockRejectedValue(new Error("wrong transport"));
    window.history.replaceState(null, "", "/?tab=prompts&lang=zh");

    render(<App appService={service} />);

    expect(await screen.findByRole("heading", { name: "提示词库" })).toBeInTheDocument();
    expect(await screen.findByRole("article", { name: "本地优先检查清单" })).toBeInTheDocument();
    await waitFor(() => {
      expect(serviceListPrompts).toHaveBeenCalled();
      expect(serviceListTags).toHaveBeenCalled();
    });
    expect(globalListPrompts).not.toHaveBeenCalled();
    expect(globalListTags).not.toHaveBeenCalled();
  });
});
