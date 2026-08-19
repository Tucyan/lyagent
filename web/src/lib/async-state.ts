export interface RequestLease {
  isCurrent(): boolean;
}

export class LatestRequestGate {
  private version = 0;

  begin(): RequestLease {
    const version = ++this.version;
    return { isCurrent: () => version === this.version };
  }

  invalidate(): void {
    this.version += 1;
  }
}

export interface SerialPollingOptions<TimerHandle> {
  intervalMs: number;
  onError?: (error: unknown) => void;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

export function startSerialPolling<TimerHandle = number>(
  task: () => Promise<void>,
  options: SerialPollingOptions<TimerHandle>,
): () => void {
  const schedule = options.schedule ??
    ((callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay) as unknown as TimerHandle);
  const cancel = options.cancel ??
    ((handle: TimerHandle) =>
      globalThis.clearTimeout(
        handle as unknown as ReturnType<typeof globalThis.setTimeout>,
      ));
  let stopped = false;
  let handle: TimerHandle | undefined;

  const queueNext = () => {
    if (stopped) return;
    handle = schedule(run, options.intervalMs);
  };
  const run = () => {
    handle = undefined;
    let pending: Promise<void>;
    try {
      pending = task();
    } catch (error) {
      if (!stopped) options.onError?.(error);
      queueNext();
      return;
    }
    void pending
      .catch((error) => {
        if (!stopped) options.onError?.(error);
      })
      .finally(queueNext);
  };

  queueNext();
  return () => {
    stopped = true;
    if (handle !== undefined) cancel(handle);
  };
}
