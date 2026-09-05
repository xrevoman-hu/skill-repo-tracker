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
  service: Pick<AppService, "checkRepositories" | "backupRepositories" | "retryTask">;
  coordinator: TaskCoordinator;
  initial: WorkspaceSnapshot;
  publish: (snapshot: WorkspaceSnapshot) => void | Promise<void>;
}): WorkspaceController {
  let current = options.initial;

  const persistedTasksMatch = (snapshot: WorkspaceSnapshot) => {
    const currentTasks = current.tasks.filter((task) => !task.optimistic);
    const nextTasks = snapshot.tasks.filter((task) => !task.optimistic);
    return currentTasks.length === nextTasks.length
      && currentTasks.every((task, index) => task === nextTasks[index]);
  };

  const hasChangedSnapshot = (snapshot: WorkspaceSnapshot) => (
    snapshot.repositories !== current.repositories
    || snapshot.skills !== current.skills
    || snapshot.plugins !== current.plugins
    || !persistedTasksMatch(snapshot)
  );

  return {
    replaceSnapshot(snapshot) {
      // App reconstructs the snapshot wrapper on every render. Only changed
      // domain references mean state advanced outside this controller. The
      // same references are the controller's own publish feeding back through
      // React. UI-only optimistic task overlays also must not supersede the
      // persisted operation that will replace them when it settles.
      if (options.coordinator.isBusy() && hasChangedSnapshot(snapshot)) {
        options.coordinator.invalidate();
      }
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
