import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, getCopy } from "./App";
import { api } from "./api";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("App prompt library integration", () => {
  it("places the prompt library tab between Skills and Plugins", () => {
    const { container } = render(<App />);
    const labels = Array.from(container.querySelectorAll(".nav-list .nav-item"), (item) =>
      item.textContent?.trim(),
    );

    expect(labels).toEqual(["GitHub", "仓库", "技能", "提示词库", "插件", "任务", "设置"]);
  });

  it("opens a prompt-specific workspace without reusing another tab inspector", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "提示词库" }));

    expect(await screen.findByRole("heading", { name: "提示词库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建提示词" })).toBeInTheDocument();
    expect(document.querySelector(".inspector")).not.toBeInTheDocument();
  });

  it("keeps v1 migration as the default while exposing prompt v2 and conflict choices", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));

    const includePrompts = screen.getByRole("checkbox", {
      name: "同时导出提示词库（v2 .srtmigration）",
    });
    expect(includePrompts).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "提示词 ID 冲突处理" })).toHaveValue("keep-local");

    await user.click(includePrompts);
    expect(screen.getByRole("alert")).toHaveTextContent("你粘贴在正文里的密码或凭证会随正文一起导出");
  });

  it("provides bilingual plaintext-secret confirmations for MD and ZIP prompt exports", () => {
    expect(getCopy("zh", "promptExportPlaintextConfirmSingle")).toContain("逐字、明文导出为 MD");
    expect(getCopy("zh", "promptExportPlaintextConfirmBatch")).toContain("密码或凭证也会随之导出");
    expect(getCopy("en", "promptExportPlaintextConfirmSingle")).toContain("verbatim and in plaintext");
    expect(getCopy("en", "promptExportPlaintextConfirmBatch")).toContain("passwords or credentials");
  });

  it("uses an English cancellation message instead of the backend Chinese text", async () => {
    const exportMigration = vi.spyOn(api, "exportMigrationPackage").mockResolvedValue({
      path: null,
      cancelled: true,
      githubAccounts: 0,
      githubRepositories: 0,
      repositories: 0,
      skills: 0,
      plugins: 0,
      userNotes: 0,
      message: "导出已取消。",
    });
    const previewMigration = vi.spyOn(api, "previewPromptMigrationPackage").mockResolvedValue({
      path: null,
      cancelled: true,
      format: "v1",
      packageSizeBytes: 0,
      prompts: 0,
      tags: 0,
      totalBytes: 0,
      conflicts: [],
      differentConflictCount: 0,
      hasDifferentConflicts: false,
      valid: true,
      message: "导入已取消。",
    });
    window.history.pushState({}, "", "?lang=en");
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Export Data" }));
    expect((await screen.findAllByText("Migration cancelled.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/导出已取消/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import Data" }));
    expect((await screen.findAllByText("Migration cancelled.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/导入已取消/)).not.toBeInTheDocument();

    expect(exportMigration).toHaveBeenCalledTimes(1);
    expect(previewMigration).toHaveBeenCalledTimes(1);
  });

  it("clears the host dirty flag after a confirmed tab switch", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "提示词库" }));
    await user.click(await screen.findByRole("button", { name: "新建提示词" }));
    await user.type(screen.getByRole("textbox", { name: "标题" }), "未保存标题");
    await user.click(screen.getByRole("button", { name: "插件" }));

    expect(confirm).toHaveBeenCalledWith("有未保存的提示词修改，确定放弃吗？");
    expect(screen.queryByRole("dialog", { name: "创建提示词" })).not.toBeInTheDocument();
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(false);
    confirm.mockRestore();
  });
});
