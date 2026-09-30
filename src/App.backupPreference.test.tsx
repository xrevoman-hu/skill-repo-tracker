import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, getCopy } from "./App";
import * as scheduling from "./taskCoordinator";
import type { UiRepository } from "./api";
import { DemoAppService } from "./appService";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function fixture(count = 2) {
  const service = new DemoAppService();
  const base = await service.bootstrap();
  const repositories = Array.from({ length: count }, (_, index) => ({
    ...base.workspace.repositories[0], id: `repo-${index}`, name: `example/repo-${String(index).padStart(2, "0")}`,
  }));
  const workspace = { ...base.workspace, repositories, tasks: [] };
  vi.spyOn(service, "bootstrap").mockResolvedValue({ ...base, workspace });
  return { service, workspace, repositories };
}

async function openFirstRepository() {
  await userEvent.click(await screen.findByRole("button", { name: "详情: example/repo-00" }));
  return screen.getByRole("checkbox", { name: "允许备份" });
}

describe("repository backup preference", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.history.replaceState(null, "", "/?lang=zh&tab=repositories");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("retains cross-page selections and clear action while every selected row is watch-only", async () => {
    const user = userEvent.setup();
    const { service } = await fixture(16);
    render(<App appService={service} />);
    const preference = await openFirstRepository();
    expect(preference).toBeChecked();
    await user.click(preference);
    await waitFor(() => expect(preference).not.toBeChecked());
    expect(screen.getByRole("checkbox", { name: "仓库: example/repo-00" })).toBeChecked();
    expect(screen.getByRole("button", { name: "备份选中（0）" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "备份: example/repo-00" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即备份" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开备份目录" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("其他页 1 条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空选择" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    await user.click(screen.getByRole("button", { name: "首页" }));
    expect(screen.getByRole("checkbox", { name: "仓库: example/repo-00" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "无需备份" }));
    expect(screen.getByRole("checkbox", { name: "仓库: example/repo-00" })).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: "仓库: example/repo-01" })).not.toBeInTheDocument();
  });

  it("filters selected and updated backups, keeps update observation, and permits re-enabling", async () => {
    const user = userEvent.setup();
    const { service, repositories } = await fixture();
    const backup = vi.spyOn(service, "backupRepositories");
    render(<App appService={service} />);
    await user.click(await openFirstRepository());
    await user.click(screen.getByRole("checkbox", { name: "仓库: example/repo-01" }));
    expect(screen.getByText("1 需要备份")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "有更新" }));
    expect(screen.getByRole("checkbox", { name: "仓库: example/repo-00" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "备份选中（1）" }));
    const dialog = screen.getByRole("dialog", { name: "备份选中仓库" });
    expect(within(dialog).queryByText("example/repo-00")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认备份" }));
    await waitFor(() => expect(backup).toHaveBeenCalledOnce());
    expect(backup.mock.calls[0][0].repositoryIds).toEqual([repositories[1].id]);
    expect(screen.getByRole("button", { name: "备份有更新" })).toBeDisabled();
    await user.click(await openFirstRepository());
    await waitFor(() => expect(screen.getByRole("button", { name: "备份有更新" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "备份有更新" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认备份" }));
    await waitFor(() => expect(backup).toHaveBeenCalledTimes(2));
    expect(backup.mock.calls[1][0]).toMatchObject({ mode: "updated", repositoryIds: [repositories[0].id] });
  });

  it("keeps the saved checkbox state on failure, releases pending, and prevents duplicate writes", async () => {
    const { service } = await fixture();
    const save = vi.spyOn(service, "updateRepositoryBackupEnabled").mockRejectedValueOnce(new Error("preference write failed"));
    render(<App appService={service} />);
    const checkbox = await openFirstRepository();
    await userEvent.click(checkbox);
    expect(await screen.findByText("preference write failed")).toBeInTheDocument();
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    const pending = deferred<UiRepository>();
    save.mockImplementationOnce(() => pending.promise);
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    await userEvent.click(checkbox);
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ...save.mock.calls[1][2].repositories[0], backupEnabled: false }));
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
  });

  it("refreshes committed B results after disabling A while a backup response is delayed", async () => {
    const user = userEvent.setup();
    const { service } = await fixture();
    const pending = deferred<void>();
    const executeBackup = service.backupRepositories.bind(service);
    const backup = vi.spyOn(service, "backupRepositories").mockImplementationOnce(async (request) => {
      const committed = await executeBackup(request);
      await pending.promise;
      return committed;
    });
    render(<App appService={service} />);
    await openFirstRepository();
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    await user.click(screen.getByRole("checkbox", { name: "仓库: example/repo-01" }));
    await user.click(screen.getByRole("button", { name: "备份选中（1）" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认备份" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("checkbox", { name: "允许备份" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "允许备份" })).not.toBeChecked());
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.getByRole("row", { name: /example\/repo-01/ })).toHaveTextContent("已备份"));
    expect(screen.getByRole("checkbox", { name: "允许备份" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByRole("row", { name: /备份仓库.*选中仓库.*1 \/ 1.*成功/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "仓库" }));
    await user.click(screen.getByRole("button", { name: "备份选中（1）" }));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "确认备份" })).toBeEnabled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认备份" }));
    await waitFor(() => expect(backup).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses current preferences in an already armed schedule and creates no empty backup task", async () => {
    const { service } = await fixture(1);
    const base = await service.bootstrap();
    vi.mocked(service.bootstrap).mockResolvedValue({
      ...base, settings: { ...base.settings!, autoBackupEnabled: true },
    });
    const runs: Array<() => Promise<unknown>> = [];
    vi.spyOn(scheduling, "createForegroundSchedule").mockImplementation((options) => {
      runs.push(options.run);
      return { stop: vi.fn() };
    });
    const backup = vi.spyOn(service, "backupRepositories");
    render(<App appService={service} />);
    await userEvent.click(await openFirstRepository());
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "允许备份" })).not.toBeChecked());
    expect(runs).toHaveLength(1);
    await act(async () => { await runs[0](); });
    expect(backup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: "允许备份" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "允许备份" })).toBeChecked());
    await act(async () => { await runs[0](); });
    expect(backup).toHaveBeenCalledOnce();
    expect(backup.mock.calls[0][0]).toMatchObject({ mode: "updated", repositoryIds: ["repo-0"] });
  });

  it("provides equivalent checkbox labels in both languages", () => {
    expect(getCopy("zh", "backupAllowed")).toBe("允许备份");
    expect(getCopy("en", "backupAllowed")).toBe("Allow backups");
    expect(getCopy("en", "backupExcluded")).toBe("No backup needed");
  });
});
