import type {
  AppService,
  BackupRequest,
  BackupResult,
  WorkspaceSnapshot,
} from "./appService";
import type { CoordinatedTaskResult, TaskCoordinator } from "./taskCoordinator";

export type WorkspaceController = {
  replaceSnapshot(snapshot: WorkspaceSnapshot): void;
  snapshot(): WorkspaceSnapshot;
  checkRepositories(): Promise<CoordinatedTaskResult<WorkspaceSnapshot>>;
  backupRepositories(
    request: Omit<BackupRequest, keyof WorkspaceSnapshot>,
  ): Promise<CoordinatedTaskResult<BackupResult>>;
  retryTask(taskId: string): Promise<CoordinatedTaskResult<WorkspaceSnapshot>>;
  invalidate(): void;
  isBusy(): boolean;
};

export function createWorkspaceController(options: {
  service: AppService;
  coordinator: TaskCoordinator;
  initial: WorkspaceSnapshot;
  publish: (snapshot: WorkspaceSnapshot) => void | Promise<void>;
}): WorkspaceController {
  let current = options.initial;

  return {
    replaceSnapshot(snapshot) {
      current = snapshot;
    },
    snapshot() {
      return current;
    },
    checkRepositories() {
      return options.coordinator.run(
        () => options.service.checkRepositories(current),
        async (next) => {
          current = next;
          await options.publish(next);
        },
      );
    },
    backupRepositories(request) {
      return options.coordinator.run(
        () => options.service.backupRepositories({ ...current, ...request }),
        async (next) => {
          current = { ...current, ...next };
          await options.publish(current);
        },
      );
    },
    retryTask(taskId) {
      return options.coordinator.run(
        () => options.service.retryTask(taskId, current),
        async (next) => {
          current = next;
          await options.publish(next);
        },
      );
    },
    invalidate() {
      options.coordinator.invalidate();
    },
    isBusy() {
      return options.coordinator.isBusy();
    },
  };
}
