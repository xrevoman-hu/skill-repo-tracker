import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TasksView } from "./App";
import type { UiTask } from "./api";

const failedTask: UiTask = {
  id: "failed-1",
  kind: "Backup repositories",
  target: "repo-1",
  progress: "0 / 1",
  status: "failed",
  summary: "network failed",
  retryable: true,
  log: ["attempt", "network failed"],
};

const successfulTask: UiTask = {
  ...failedTask,
  id: "success-1",
  target: "repo-2",
  status: "success",
  summary: "completed",
};

describe("TasksView retry boundary", () => {
  it("opens another task with a keyboard-accessible details button and explains missing historical logs", async () => {
    const user = userEvent.setup();
    render(
      <TasksView tasks={[successfulTask, { ...failedTask, log: [] }]} taskFilter="all"
        setTaskFilter={vi.fn()} retryTask={vi.fn()} copyTaskSummary={vi.fn()}
        hasTasks isPending={() => false} language="en" t={(key) => key} />,
    );
    const details = screen.getByRole("button", { name: "taskDetails: repo-1" });
    details.focus();
    await user.keyboard("{Enter}");
    const panel = screen.getByRole("heading", { name: "taskLog" }).closest("aside")!;
    expect(panel).toHaveTextContent("repo-1");
    expect(panel).toHaveTextContent("taskLogUnavailable");
    expect(details).toHaveAttribute("aria-pressed", "true");
  });

  it("surfaces the exact failure line ahead of a long batch log", () => {
    const error = "example/repo failed: download timed out [github_timeout] details: status=504";
    render(
      <TasksView tasks={[{ ...failedTask, status: "partial-success", log: ["other repo completed", error, "last repo completed"] }]}
        taskFilter="all" setTaskFilter={vi.fn()} retryTask={vi.fn()} copyTaskSummary={vi.fn()}
        hasTasks isPending={() => false} language="en" t={(key) => key} />,
    );
    const failures = screen.getByRole("region", { name: "taskFailures" });
    expect(failures).toHaveTextContent(error);
    expect(failures).not.toHaveTextContent("other repo completed");
  });

  it("retries only retryable failure states and copies the selected task", async () => {
    const user = userEvent.setup();
    const retryTask = vi.fn().mockResolvedValue(undefined);
    const copyTaskSummary = vi.fn().mockResolvedValue(undefined);

    render(
      <TasksView
        tasks={[failedTask, successfulTask]}
        taskFilter="all"
        setTaskFilter={vi.fn()}
        retryTask={retryTask}
        copyTaskSummary={copyTaskSummary}
        hasTasks
        isPending={() => false}
        language="en"
        t={(key) => key}
      />,
    );

    const table = screen.getByRole("table");
    const failedRetry = within(table).getByRole("button", { name: "retry: repo-1" });
    const successfulRetry = within(table).getByRole("button", { name: "retry: repo-2" });
    expect(failedRetry).toBeEnabled();
    expect(successfulRetry).toBeDisabled();

    await user.click(failedRetry);
    expect(retryTask).toHaveBeenCalledWith(failedTask);
    await user.click(within(table).getByRole("button", { name: "copy: repo-1" }));
    expect(copyTaskSummary).toHaveBeenCalledWith(failedTask);
    expect(screen.getByRole("heading", { name: "taskLog" }).closest("aside"))
      .toHaveTextContent("network failed");
  });
});
