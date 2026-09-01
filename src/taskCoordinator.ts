export type CoordinatedTaskResult<T> =
  | { status: "completed"; value: T }
  | { status: "skipped"; reason: "busy" }
  | { status: "superseded" }
  | { status: "failed"; error: unknown };

export type CoordinatedTaskSettlement<T> = {
  cleanup: () => void;
  onCompleted?: (value: T) => void;
  onFailed?: (error: unknown) => void;
};

/**
 * Settles UI bookkeeping for every terminal coordinator result. Superseded and
 * skipped work deliberately stays silent, but must still release optimistic UI.
 */
export function settleCoordinatedTask<T>(
  result: CoordinatedTaskResult<T>,
  handlers: CoordinatedTaskSettlement<T>,
): void {
  handlers.cleanup();
  if (result.status === "completed") handlers.onCompleted?.(result.value);
  if (result.status === "failed") handlers.onFailed?.(result.error);
}

export type TaskCoordinator = {
  run<T>(
    operation: () => Promise<T>,
    publish: (value: T) => void | Promise<void>,
  ): Promise<CoordinatedTaskResult<T>>;
  invalidate(): void;
  isBusy(): boolean;
};

/**
 * Coordinates repository checks and backups through one foreground-only lane.
 * The generation token prevents an operation that outlives its owning view or
 * runtime from publishing stale state.
 */
export function createTaskCoordinator(): TaskCoordinator {
  let activeGeneration: number | null = null;
  let generation = 0;

  return {
    async run(operation, publish) {
      if (activeGeneration !== null) return { status: "skipped", reason: "busy" };

      const taskGeneration = ++generation;
      activeGeneration = taskGeneration;
      try {
        const value = await operation();
        if (generation !== taskGeneration) return { status: "superseded" };
        await publish(value);
        return { status: "completed", value };
      } catch (error: unknown) {
        if (generation !== taskGeneration) return { status: "superseded" };
        return { status: "failed", error };
      } finally {
        if (activeGeneration === taskGeneration) activeGeneration = null;
      }
    },
    invalidate() {
      generation += 1;
      activeGeneration = null;
    },
    isBusy() {
      return activeGeneration !== null;
    },
  };
}

export type ForegroundSchedule = { stop(): void };

export function createForegroundSchedule(options: {
  intervalMs: number;
  run: () => Promise<unknown>;
  onNextRun?: (timestamp: number | null) => void;
}): ForegroundSchedule {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (stopped) return;
    const nextRun = Date.now() + options.intervalMs;
    options.onNextRun?.(nextRun);
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        await options.run();
      } finally {
        arm();
      }
    }, options.intervalMs);
  };

  arm();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      options.onNextRun?.(null);
    },
  };
}
