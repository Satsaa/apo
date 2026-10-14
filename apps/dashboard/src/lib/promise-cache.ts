/**
 * An in-memory cache of async loads for the life of the page. Concurrent
 * callers share one in-flight load; a settled value can be read synchronously
 * with `peek`, so a view that remounts (a collapsed row opened again) renders
 * it on its first frame instead of flashing a loading state.
 *
 * Each `get` returns a `release` for a caller that stops waiting. When every
 * caller of a load still in flight has released it, the load is aborted and
 * forgotten, so closing a row mid-load still cancels its request. A load that
 * failed is forgotten too, and the next caller retries.
 */
export interface PromiseCache<T> {
  get: (key: string, load: (signal: AbortSignal) => Promise<T>) => { promise: Promise<T>; release: () => void };
  peek: (key: string) => T | undefined;
}

interface Entry<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  value?: T;
}

export function createPromiseCache<T>({
  keep = () => true,
}: {
  /** Whether a loaded value may be reused; false drops it after delivery. */
  keep?: (value: T) => boolean;
} = {}): PromiseCache<T> {
  const entries = new Map<string, Entry<T>>();
  const forget = (key: string, entry: Entry<T>) => {
    if (entries.get(key) === entry) entries.delete(key);
  };
  return {
    get(key, load) {
      let entry = entries.get(key);
      if (!entry) {
        const controller = new AbortController();
        const created: Entry<T> = { controller, waiters: 0, settled: false, promise: undefined! };
        created.promise = load(controller.signal).then(
          (value) => {
            if (keep(value)) Object.assign(created, { settled: true, value });
            else forget(key, created);
            return value;
          },
          (error: unknown) => {
            forget(key, created);
            throw error;
          },
        );
        entries.set(key, created);
        entry = created;
      }
      const held = entry;
      held.waiters += 1;
      let released = false;
      return {
        promise: held.promise,
        release: () => {
          if (released || held.settled) return;
          released = true;
          held.waiters -= 1;
          if (held.waiters === 0) {
            forget(key, held);
            held.controller.abort();
          }
        },
      };
    },
    peek(key) {
      const entry = entries.get(key);
      return entry?.settled ? entry.value : undefined;
    },
  };
}
