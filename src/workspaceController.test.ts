import { describe, expect, it, vi } from "vitest";

import { createTaskCoordinator } from "./taskCoordinator";
import { createWorkspaceController } from "./workspaceController";
import type { AppService, WorkspaceSnapshot } from "./appService";

const empty: WorkspaceSnapshot = {
  repositories: [],
  skills: [],
  plugins: [],
  tasks: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("workspace controller", () => {
  it("feeds each scheduled run the result published by the previous run", async () => {
    const seen: number[] = [];
    const checkRepositories = vi.fn(async (current: WorkspaceSnapshot) => {
      seen.push(current.repositories.length);
      return {
        ...current,
        repositories: [
          ...current.repositories,
          {
            id: `repo-${current.repositories.length + 1}`,
            name: "example/repo",
            type: "skill repo",
            ref: "main",
            skills: 1,
            remoteSha: "abc",
            lastBackupSha: "none",
            backupStatus: "never-backed-up",
            checkStatus: "success",
          },
        ],
      };
    });
    const service: AppService = {
      runtime: "demo",
      bootstrap: vi.fn(),
      checkRepositories,
      backupRepositories: vi.fn(),
      retryTask: vi.fn(),
      openBackupFolder: vi.fn(),
    };
    const published: WorkspaceSnapshot[] = [];
    const controller = createWorkspaceController({
      service,
      coordinator: createTaskCoordinator(),
      initial: empty,
      publish: (snapshot) => { published.push(snapshot); },
    });

    await controller.checkRepositories();
    await controller.checkRepositories();

    expect(seen).toEqual([0, 1]);
    expect(published.at(-1)?.repositories).toHaveLength(2);
  });

  it("prevents a backup from overlapping an in-flight repository check", async () => {
    const pendingCheck = deferred<WorkspaceSnapshot>();
    const backupRepositories = vi.fn(async () => ({ repositories: [], tasks: [] }));
    const service: AppService = {
      runtime: "demo",
      bootstrap: vi.fn(),
      checkRepositories: vi.fn(() => pendingCheck.promise),
      backupRepositories,
      retryTask: vi.fn(),
      openBackupFolder: vi.fn(),
    };
    const controller = createWorkspaceController({
      service,
      coordinator: createTaskCoordinator(),
      initial: empty,
      publish: vi.fn(),
    });

    const checking = controller.checkRepositories();
    await expect(controller.backupRepositories({
      mode: "updated",
      repositoryIds: [],
      backupRoot: "/backups",
    })).resolves.toEqual({ status: "skipped", reason: "busy" });
    expect(backupRepositories).not.toHaveBeenCalled();

    pendingCheck.resolve(empty);
    await expect(checking).resolves.toEqual({ status: "completed", value: empty });
  });

  it("runs task retries in the same single-flight lane as checks and backups", async () => {
    const pendingRetry = deferred<WorkspaceSnapshot>();
    const next = { ...empty, tasks: [{
      id: "retry-1",
      kind: "Backup repositories",
      target: "example/repo",
      progress: "0 / 1",
      status: "queued",
      summary: "retry queued",
      retryable: false,
      log: [],
    }] };
    const service: AppService = {
      runtime: "tauri",
      bootstrap: vi.fn(),
      checkRepositories: vi.fn(async () => empty),
      backupRepositories: vi.fn(async () => ({ repositories: [], tasks: [] })),
      retryTask: vi.fn(() => pendingRetry.promise),
      openBackupFolder: vi.fn(),
    };
    const publish = vi.fn();
    const controller = createWorkspaceController({
      service,
      coordinator: createTaskCoordinator(),
      initial: empty,
      publish,
    });

    const retrying = controller.retryTask("task-1");
    await expect(controller.checkRepositories()).resolves.toEqual({ status: "skipped", reason: "busy" });
    await expect(controller.backupRepositories({
      mode: "updated",
      repositoryIds: [],
      backupRoot: "/backups",
    })).resolves.toEqual({ status: "skipped", reason: "busy" });

    pendingRetry.resolve(next);
    await expect(retrying).resolves.toEqual({ status: "completed", value: next });
    expect(publish).toHaveBeenCalledWith(next);
  });
});
