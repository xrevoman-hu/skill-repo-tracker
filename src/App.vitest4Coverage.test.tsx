import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { api } from "./api";
import type { UiSkill } from "./api";
import { DemoAppService } from "./appService";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn().mockResolvedValue(() => undefined),
  }),
}));

function rowContaining(text: string) {
  const row = screen
    .getAllByText(text)
    .map((node) => node.closest("tr"))
    .find((candidate): candidate is HTMLTableRowElement => candidate !== null);
  expect(row).toBeDefined();
  return row!;
}

function currentInspector() {
  const inspector = document.querySelector<HTMLElement>(".inspector");
  expect(inspector).not.toBeNull();
  return inspector!;
}

describe("App Vitest 4 behavior coverage", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.history.replaceState(null, "", "/?lang=zh");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("backs up a selected repository after inspecting its README, note, and audit actions", async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.spyOn(navigator.clipboard, "writeText");
    const browserOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const service = new DemoAppService({ now: () => new Date("2026-09-05T12:00:00Z") });
    const backupRepositories = vi.spyOn(service, "backupRepositories");
    const openBackupFolder = vi.spyOn(service, "openBackupFolder");
    vi.spyOn(api, "getRepositoryReadme").mockResolvedValue({
      sourcePath: "README.md",
      readme: "# Content Skill Kit\n\nAudited demo content.",
    });

    render(<App appService={service} />);

    await screen.findByText("example-org/content-skill-kit");
    await user.click(rowContaining("example-org/content-skill-kit"));
    const inspector = currentInspector();
    expect(within(inspector).getByRole("heading", { name: "example-org/content-skill-kit" }))
      .toBeInTheDocument();

    await user.click(within(inspector).getByRole("button", { name: "查看 README" }));
    expect(await within(inspector).findByText("# Content Skill Kit", { exact: false }))
      .toBeInTheDocument();

    const note = within(inspector).getByPlaceholderText("记录用途、场景、安装注意事项或迁移说明。");
    await user.type(note, "发布前复核");
    await user.click(within(inspector).getByRole("button", { name: "保存备注" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("备注已保存。"));
    expect(note).toHaveValue("发布前复核");
    await user.click(within(inspector).getByRole("button", { name: "清空备注" }));
    await waitFor(() => expect(note).toHaveValue(""));

    await user.click(within(inspector).getByRole("button", { name: "打开备份目录" }));
    expect(openBackupFolder).toHaveBeenCalledWith("content");
    await user.click(within(inspector).getByRole("button", { name: "复制链接" }));
    expect(clipboardWrite).toHaveBeenCalledWith(
      "https://github.com/example-org/content-skill-kit",
    );

    await user.click(within(inspector).getByRole("button", { name: "查看 GitHub" }));
    const preview = await screen.findByRole("dialog", { name: "GitHub 预览" });
    expect(within(preview).getByText("example-org/content-skill-kit")).toBeInTheDocument();
    await user.click(within(preview).getByRole("button", { name: "系统浏览器" }));
    expect(browserOpen).toHaveBeenCalledWith(
      "https://github.com/example-org/content-skill-kit",
      "_blank",
      "noopener,noreferrer",
    );
    await user.click(within(preview).getByRole("button", { name: "关闭" }));

    await user.click(within(inspector).getByRole("button", { name: "立即备份" }));
    const backupDialog = await screen.findByRole("dialog");
    expect(within(backupDialog).getByText("example-org/content-skill-kit"))
      .toBeInTheDocument();
    await user.click(within(backupDialog).getByRole("button", { name: "确认备份" }));

    await waitFor(() => expect(backupRepositories).toHaveBeenCalledOnce());
    expect(backupRepositories.mock.calls[0][0]).toMatchObject({
      mode: "selected",
      repositoryIds: ["content"],
      backupRoot: "~/SkillRepoBackups",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("备份任务已创建。");
  });

  it("selects a repository page, refreshes it, dismisses the modal, and adds a repository", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService({ now: () => new Date("2026-09-05T12:10:00Z") });
    const base = await service.bootstrap();
    vi.spyOn(service, "bootstrap").mockResolvedValue({
      ...base,
      workspace: {
        ...base.workspace,
        repositories: base.workspace.repositories.map((repository, index) => ({
          ...repository,
          addedAt: index === 0 ? "2026-09-05" : index === 1 ? "Never" : `2026-08-${String(index).padStart(2, "0")}`,
          note: index === 0 ? "release audit" : repository.note,
          readmeSearchText: index === 1 ? "migration handbook" : repository.readmeSearchText,
        })),
      },
    });
    const checkRepositories = vi.spyOn(service, "checkRepositories");
    const addRepository = vi.spyOn(service, "addRepository");

    render(<App appService={service} />);

    const selectPage = await screen.findByRole("checkbox", { name: "全部仓库" });
    await user.click(selectPage);
    expect(selectPage).toBeChecked();
    expect(screen.getByRole("button", { name: /备份选中（\d+）/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    expect(screen.getByRole("button", { name: "备份选中（0）" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /添加时间/ }));
    await user.click(screen.getByRole("button", { name: /添加时间/ }));
    const contentSearch = screen.getByPlaceholderText("搜索备注 / README...");
    await user.type(contentSearch, "release audit");
    expect(screen.getByText("example-org/content-skill-kit")).toBeInTheDocument();
    await user.clear(contentSearch);

    await user.click(screen.getByRole("button", { name: "检测全部" }));
    await waitFor(() => expect(checkRepositories).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent("远端状态已刷新");

    await user.click(screen.getByRole("button", { name: "添加仓库" }));
    let dialog = await screen.findByRole("dialog", { name: "添加仓库" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加仓库" }))
      .not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "添加仓库" }));
    dialog = await screen.findByRole("dialog", { name: "添加仓库" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "仓库 URL 或 owner/repo" }),
      "https://github.com/example/new-skill.git",
    );
    const refInput = within(dialog).getByRole("textbox", { name: "Ref" });
    await user.clear(refInput);
    await user.type(refInput, "release");
    await user.type(within(dialog).getByRole("textbox", { name: "备注" }), "from behavior test");
    await user.click(within(dialog).getByRole("button", { name: "添加并扫描" }));

    await waitFor(() => expect(addRepository).toHaveBeenCalledOnce());
    expect(addRepository.mock.calls[0][0]).toEqual({
      url: "https://github.com/example/new-skill.git",
      refName: "release",
      note: "from behavior test",
    });
    expect(await screen.findByRole("heading", { name: "example/new-skill" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "备份选中（1）" })).toBeEnabled();
  });

  it("installs, updates, deletes, restores, and configures Skills through visible controls", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService({ now: () => new Date("2026-09-05T12:20:00Z") });
    const base = await service.bootstrap();
    const deletedSkill: UiSkill = {
      ...base.workspace.skills[1],
      id: "deleted-source",
      name: "deleted-source-skill",
      status: "deleted",
      installed: false,
      canRestore: true,
      canDelete: false,
    };
    vi.spyOn(service, "bootstrap").mockResolvedValue({
      ...base,
      workspace: {
        ...base.workspace,
        skills: [
          ...base.workspace.skills.map((skill) => ({
            ...skill,
            canDelete: skill.id === "source",
            createdAt: skill.id === "scene" ? "Never" : `2026-09-0${skill.id.length % 8 + 1}`,
            resolvedSyncTargets: skill.id === "content-core" ? ["codex"] : [],
          })),
          deletedSkill,
        ],
      },
      settings: {
        ...base.settings!,
        defaultSyncTargets: ["codex"],
        availableSyncTargets: [
          { id: "codex", label: "Codex", path: "~/.codex/skills", exists: true },
          { id: "claude", label: "Claude Code", path: "~/.claude/skills", exists: true },
        ],
      },
    });
    window.history.replaceState(null, "", "/?tab=skills&lang=zh");

    render(<App appService={service} />);

    const sceneRow = await waitFor(() => rowContaining("scene-director-skill"));
    await user.click(within(sceneRow).getByRole("button", { name: "安装: scene-director-skill" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("scene-director-skill 已安装"));
    expect(within(sceneRow).getByRole("button", { name: /已是最新/ })).toBeDisabled();

    const contentRow = rowContaining("content-skill-core");
    await user.click(within(contentRow).getByRole("button", { name: "更新: content-skill-core" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("content-skill-core 已更新"));

    const sourceRow = rowContaining("source-reviewer-skill");
    await user.click(within(sourceRow).getByRole("button", { name: "删除: source-reviewer-skill" }));
    const deleteDialog = await screen.findByRole("dialog");
    await user.click(within(deleteDialog).getByRole("button", { name: "备份后删除" }));
    await waitFor(() => expect(screen.queryByText("source-reviewer-skill")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "已删除" }));
    const deletedRow = rowContaining("deleted-source-skill");
    await user.click(within(deletedRow).getByRole("button", { name: "恢复: deleted-source-skill" }));
    await waitFor(() => expect(screen.queryByText("deleted-source-skill")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Skill 已恢复。");

    await user.click(screen.getByRole("button", { name: "全部" }));
    await user.click(rowContaining("content-skill-core"));
    let inspector = currentInspector();
    await user.click(within(inspector).getByRole("button", { name: "自定义" }));
    expect(screen.getByRole("status")).toHaveTextContent("同步目标已保存。");
    await user.click(within(inspector).getByRole("button", { name: "关闭" }));
    await user.click(rowContaining("content-skill-core"));
    inspector = currentInspector();
    const claudeTarget = within(inspector).getByRole("checkbox", { name: "Claude Code" });
    expect(claudeTarget).toBeEnabled();
    await user.click(claudeTarget);
    expect(screen.getByRole("status")).toHaveTextContent("同步目标已保存。");
    await user.click(within(currentInspector()).getByRole("button", { name: "关闭" }));
    await user.click(rowContaining("content-skill-core"));
    inspector = currentInspector();
    expect(within(inspector).getByRole("checkbox", { name: "Claude Code" })).toBeChecked();

    const note = within(inspector).getByPlaceholderText("记录用途、场景、安装注意事项或迁移说明。");
    await user.type(note, "sync verified");
    await user.click(within(inspector).getByRole("button", { name: "保存备注" }));
    await waitFor(() => expect(note).toHaveValue("sync verified"));
    await user.click(within(inspector).getByRole("button", { name: /^content-skill-kit/ }));
    expect(await screen.findByRole("heading", { name: "插件", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "content-skill-kit" })).toBeInTheDocument();
  }, 15_000);

  it("resolves a demo Skill conflict only after the visible verification handoff", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService();
    window.history.replaceState(null, "", "/?tab=skills&lang=zh");

    render(<App appService={service} />);

    const conflictRow = await waitFor(() => rowContaining("spec-writer-skill"));
    await user.click(within(conflictRow).getByRole("button", { name: "处理冲突: spec-writer-skill" }));
    let dialog = await screen.findByRole("dialog", { name: "Skill 更新冲突" });
    await user.click(within(dialog).getByRole("button", { name: "打开本地目录" }));
    expect(screen.getByRole("status")).toHaveTextContent("已请求打开 Skill 主库目录。");
    await user.click(within(dialog).getByRole("button", { name: "重新检测" }));

    dialog = await screen.findByRole("dialog", { name: "Skill 更新冲突" });
    expect(within(dialog).getByText(/稳定的本地修改/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认已通过 Agent 完成更新" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Skill 更新冲突" }))
      .not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("已确认保留自定义更新");
    expect(within(rowContaining("spec-writer-skill")).getByText("已更新，含本地定制"))
      .toBeInTheDocument();
  });

  it("manages a GitHub catalog entry, token modal, preview, and account through App callbacks", async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.spyOn(navigator.clipboard, "writeText");
    const browserOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const service = new DemoAppService();
    window.history.replaceState(null, "", "/?tab=github&lang=zh");

    render(<App appService={service} />);

    await screen.findByRole("heading", { name: "GitHub" });
    await user.click(rowContaining("example-org/private-skill-kit"));
    let inspector = currentInspector();
    await user.click(within(inspector).getByRole("button", { name: "验证 Token" }));
    expect(screen.getByRole("status")).toHaveTextContent("GitHub token 验证成功。");

    const note = within(inspector).getByPlaceholderText("记录用途、场景、安装注意事项或迁移说明。");
    await user.type(note, "private catalog review");
    await user.click(within(inspector).getByRole("button", { name: "保存备注" }));
    await waitFor(() => expect(note).toHaveValue("private catalog review"));
    await user.click(within(inspector).getByRole("button", { name: "清空备注" }));
    await waitFor(() => expect(note).toHaveValue(""));

    await user.click(within(inspector).getByRole("button", { name: "取消 Star" }));
    await waitFor(() => expect(within(currentInspector()).getByRole("button", { name: "Star" }))
      .toBeInTheDocument());
    inspector = currentInspector();
    await user.click(within(inspector).getByRole("button", { name: "追踪" }));
    await waitFor(() => expect(within(currentInspector()).getByRole("button", { name: "取消追踪" }))
      .toBeInTheDocument());
    await user.click(within(currentInspector()).getByRole("button", { name: "取消追踪" }));
    expect(confirm).toHaveBeenCalledWith("取消追踪: example-org/private-skill-kit?");

    await user.click(within(currentInspector()).getByRole("button", { name: "复制链接" }));
    expect(clipboardWrite).toHaveBeenCalledWith(
      "https://github.com/example-org/private-skill-kit",
    );
    await user.click(within(currentInspector()).getByRole("button", { name: "应用内预览" }));
    const preview = await screen.findByRole("dialog", { name: "GitHub 预览" });
    await user.click(within(preview).getByRole("button", { name: "系统浏览器" }));
    expect(browserOpen).toHaveBeenCalledWith(
      "https://github.com/example-org/private-skill-kit",
      "_blank",
      "noopener,noreferrer",
    );
    await user.click(within(preview).getByRole("button", { name: "关闭" }));

    await user.click(screen.getByRole("button", { name: "添加账号" }));
    const tokenDialog = await screen.findByRole("dialog", { name: "添加 GitHub 账号" });
    await user.type(within(tokenDialog).getByLabelText("粘贴 GitHub token"), "github_pat_demo");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加 GitHub 账号" }))
      .not.toBeInTheDocument());

    await user.click(rowContaining("example-org/private-skill-kit"));
    await user.click(within(currentInspector()).getByRole("button", { name: "删除账号" }));
    expect(confirm).toHaveBeenCalledWith("删除账号: demo-user?");
    expect(await screen.findByRole("heading", { name: "添加 GitHub 账号" })).toBeInTheDocument();
    expect(screen.queryByText("example-org/private-skill-kit")).not.toBeInTheDocument();
  }, 15_000);

  it("applies sync and schedule settings and completes v2 migration through confirmed UI", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService();
    const base = await service.bootstrap();
    vi.spyOn(service, "bootstrap").mockResolvedValue({
      ...base,
      settings: {
        ...base.settings!,
        availableSyncTargets: [
          { id: "codex", label: "Codex", path: "~/.codex/skills", exists: true },
          { id: "claude", label: "Claude Code", path: "~/.claude/skills", exists: true },
        ],
      },
    });
    const updateSettings = vi.spyOn(service, "updateSettings");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const exportMigration = vi.spyOn(api, "exportMigrationPackage").mockResolvedValue({
      path: "/tmp/export-v2.srtmigration",
      cancelled: false,
      githubAccounts: 1,
      githubRepositories: 2,
      repositories: 3,
      skills: 4,
      plugins: 2,
      userNotes: 5,
      prompts: 6,
      tags: 2,
      message: "exported",
    });
    const previewMigration = vi.spyOn(api, "previewPromptMigrationPackage").mockResolvedValue({
      path: "/tmp/import-v2.srtmigration",
      cancelled: false,
      format: "v2",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 4096,
      prompts: 6,
      tags: 2,
      totalBytes: 1024,
      conflicts: [{ id: "prompt-1", title: "Existing", kind: "different" }],
      differentConflictCount: 1,
      hasDifferentConflicts: true,
      valid: true,
      message: "ready",
    });
    const importMigration = vi.spyOn(api, "importMigrationPackage").mockResolvedValue({
      path: "/tmp/import-v2.srtmigration",
      cancelled: false,
      githubAccounts: 1,
      githubRepositories: 2,
      repositories: 3,
      skills: 4,
      plugins: 2,
      userNotes: 5,
      prompts: 6,
      tags: 2,
      message: "imported",
    });
    window.history.replaceState(null, "", "/?tab=settings&lang=zh");

    render(<App appService={service} />);

    await screen.findByRole("heading", { name: "设置" });
    await user.click(screen.getByRole("button", { name: "黑色主题" }));
    await user.click(screen.getByRole("button", { name: "紧凑" }));
    await user.click(screen.getByRole("checkbox", { name: "Codex" }));
    await user.click(screen.getByRole("button", { name: "应用同步设置到已安装 Skills" }));
    expect(screen.getByRole("status")).toHaveTextContent("已应用同步设置到已安装 Skills。");

    const scheduleSection = screen.getByRole("heading", { name: "定时任务" }).closest("section")!;
    const scheduleToggles = within(scheduleSection).getAllByRole("checkbox");
    await user.click(scheduleToggles[0]);
    await user.click(scheduleToggles[1]);
    expect(scheduleToggles[0]).toBeChecked();
    expect(scheduleToggles[1]).toBeChecked();

    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls.at(-1)?.[0]).toMatchObject({
      defaultSyncTargets: ["codex"],
      autoCheckEnabled: true,
      autoBackupEnabled: true,
    });

    await user.click(screen.getByRole("checkbox", {
      name: "同时导出提示词库（v2 .srtmigration）",
    }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "提示词 ID 冲突处理" }),
      "overwrite",
    );
    await user.click(screen.getByRole("button", { name: "导出数据" }));
    await waitFor(() => expect(exportMigration).toHaveBeenCalledWith(true));
    expect(document.querySelector(".migration-status"))
      .toHaveTextContent("导出数据: 3 仓库, 4 技能, 2 插件, 5 条备注, 6 篇提示词");

    await user.click(screen.getByRole("button", { name: "导入数据" }));
    await waitFor(() => expect(importMigration).toHaveBeenCalledWith(
      "/tmp/import-v2.srtmigration",
      "overwrite",
      "a".repeat(64),
      4096,
    ));
    expect(previewMigration).toHaveBeenCalledOnce();
    expect(document.querySelector(".migration-status"))
      .toHaveTextContent("导入数据: 3 仓库, 4 技能, 2 插件, 5 条备注, 6 篇提示词");
    expect(confirm).toHaveBeenCalledTimes(2);

    expect(document.querySelector(".app-shell")).toHaveAttribute("data-theme", "dark");
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-density", "compact");
  }, 15_000);
});
