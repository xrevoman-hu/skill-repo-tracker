import { describe, expect, it, vi } from "vitest";

import {
  createForegroundSchedule,
  createTaskCoordinator,
  settleCoordinatedTask,
} from "./taskCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("foreground task coordination", () => {
  it("keeps manual and scheduled work single-flight", async () => {
    const coordinator = createTaskCoordinator();
    const first = deferred<string>();
    const applied: string[] = [];

    const publish = (value: string) => { applied.push(value); };
    const manual = coordinator.run(() => first.promise, publish);
    const timer = await coordinator.run(async () => "timer", publish);
    const backup = await coordinator.run(async () => "backup", publish);

    expect(timer).toEqual({ status: "skipped", reason: "busy" });
    expect(backup).toEqual({ status: "skipped", reason: "busy" });
    first.resolve("manual");
    await expect(manual).resolves.toEqual({ status: "completed", value: "manual" });
    expect(applied).toEqual(["manual"]);
  });

  it("does not publish a late result after its generation is invalidated", async () => {
    const coordinator = createTaskCoordinator();
    const old = deferred<string>();
    const applied: string[] = [];

    const running = coordinator.run(() => old.promise, (value) => { applied.push(value); });
    coordinator.invalidate();
    const current = await coordinator.run(
      async () => "current",
      (value) => { applied.push(value); },
    );
    old.resolve("stale");

    await expect(running).resolves.toEqual({ status: "superseded" });
    expect(current).toEqual({ status: "completed", value: "current" });
    expect(applied).toEqual(["current"]);
  });

  it("cleans optimistic UI when work is superseded without reporting success or failure", () => {
    const cleanup = vi.fn();
    const onCompleted = vi.fn();
    const onFailed = vi.fn();

    settleCoordinatedTask(
      { status: "superseded" },
      { cleanup, onCompleted, onFailed },
    );

    expect(cleanup).toHaveBeenCalledOnce();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("waits for slow work to finish before scheduling the next interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = deferred<void>();
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const nextRuns: number[] = [];
    const schedule = createForegroundSchedule({
      intervalMs: 1_000,
      run,
      onNextRun: (timestamp) => {
        if (timestamp !== null) nextRuns.push(timestamp);
      },
    });

    expect(nextRuns).toEqual([1_000]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(nextRuns.at(-1)).toBe(7_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    schedule.stop();
    vi.useRealTimers();
  });
});
