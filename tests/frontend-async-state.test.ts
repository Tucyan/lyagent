import { describe, expect, it, vi } from "vitest";
import {
  LatestRequestGate,
  startSerialPolling,
} from "../web/src/lib/async-state.js";

describe("frontend async state coordination", () => {
  it("invalidates older request leases when a newer request begins", () => {
    const gate = new LatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    gate.invalidate();
    expect(second.isCurrent()).toBe(false);
  });

  it("schedules the next poll only after the current poll settles", async () => {
    let release!: () => void;
    const task = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const scheduled: Array<() => void> = [];
    const stop = startSerialPolling(task, {
      intervalMs: 800,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: vi.fn(),
    });

    expect(scheduled).toHaveLength(1);
    const firstPoll = scheduled.shift()!;
    firstPoll();
    expect(task).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(0);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);

    stop();
  });

  it("continues polling after a recoverable task failure", async () => {
    const errors: unknown[] = [];
    const scheduled: Array<() => void> = [];
    const stop = startSerialPolling(
      async () => {
        throw new Error("temporary network failure");
      },
      {
        intervalMs: 800,
        onError: (error) => errors.push(error),
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: vi.fn(),
      },
    );

    scheduled.shift()!();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    stop();
  });

  it("does not publish an in-flight error after polling is stopped", async () => {
    let reject!: (error: Error) => void;
    const errors: unknown[] = [];
    const scheduled: Array<() => void> = [];
    const stop = startSerialPolling(
      () => new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
      {
        intervalMs: 800,
        onError: (error) => errors.push(error),
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: vi.fn(),
      },
    );

    scheduled.shift()!();
    stop();
    reject(new Error("old page failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });
});
