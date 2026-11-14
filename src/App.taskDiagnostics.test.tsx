import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { DemoAppService } from "./appService";

describe("App task failure diagnostics", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.history.replaceState(null, "", "/?tab=tasks&lang=zh");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("copies the task identity, object, status and complete diagnostic log", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const service = new DemoAppService();
    const first = (await service.bootstrap()).workspace.tasks[0];
    render(<App appService={service} />);
    const table = await screen.findByRole("table");
    await user.click(within(table).getAllByRole("button", { name: /^复制:/ })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const report = writeText.mock.calls[0][0];
    expect(report).toContain(first.id);
    expect(report).toContain(first.target);
    expect(report).toContain(first.status);
    for (const line of first.log) expect(report).toContain(line);
    expect(screen.getByRole("status")).toHaveTextContent("任务详情和日志已复制");
  });

  it("does not claim that copying succeeded when clipboard writing fails without an Error object", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(undefined);
    render(<App appService={new DemoAppService()} />);
    const table = await screen.findByRole("table");
    await user.click(within(table).getAllByRole("button", { name: /^复制:/ })[0]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("复制失败"));
    expect(screen.getByRole("status")).not.toHaveTextContent("已复制");
  });

  it("keeps a failed retry and structured details visible after leaving and returning to Tasks", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService({ mode: "retry-race" });
    vi.spyOn(service, "retryTask").mockRejectedValue({
      code: "github_timeout", message: "下载失败", details: "status=504 request=example",
    });
    vi.spyOn(service, "refreshWorkspace").mockRejectedValue(new Error("readback unavailable"));
    render(<App appService={service} />);
    const table = await screen.findByRole("table");
    const retry = within(table).getAllByRole("button", { name: /^重试:/ }).find((button) => !button.hasAttribute("disabled"))!;
    await user.click(retry);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("status=504 request=example"));
    await user.click(screen.getByRole("button", { name: "仓库" }));
    await user.click(screen.getByRole("button", { name: "任务" }));
    const failureRow = within(screen.getByRole("table")).getByText(/下载失败/).closest("tr")!;
    await user.click(failureRow);
    const panel = screen.getByRole("heading", { name: "任务日志" }).closest("aside")!;
    expect(panel).toHaveTextContent("github_timeout");
    expect(panel).toHaveTextContent("status=504 request=example");
    expect(panel).toHaveTextContent("仅保存在本次会话");
  });
});
