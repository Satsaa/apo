/**
 * An in-memory cache of async loads for the life of the page, bounded to the
 * most recently used entries. Concurrent callers share one in-flight load. A
 * kept value can be read synchronously with `peek`, so a view that remounts (a
 * collapsed row opened again) renders it on its first frame instead of
 * flashing a loading state, and then asks for a `fresh` load to pick up
 * anything that changed meanwhile.
 *
 * Each `get` returns a `release` for a caller that stops waiting. When every
 * caller of an in-flight load has released it, the load is aborted. A load
 * that fails, or whose value `keep` refuses, changes nothing: a kept value
 * stays, and with none the next caller tries again. A plain `get` is answered
 * from a kept value even while a refresh of it is in flight.
 */
export interface PromiseCache<T> {
  get: (
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    options?: { fresh?: boolean },
  ) => { promise: Promise<T>; release: () => void };
  peek: (key: string) => T | undefined;
}

interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  done: boolean;
}

interface Entry<T> {
  value?: { current: T };
  flight?: Flight<T>;
}

const NO_RELEASE = () => {};

export function createPromiseCache<T>({
  keep = () => true,
  maxEntries = 32,
}: {
  /** Whether a loaded value may be reused. */
  keep?: (value: T) => boolean;
  /** How many keys to hold; the least recently used kept value goes first. */
  maxEntries?: number;
} = {}): PromiseCache<T> {
  const entries = new Map<string, Entry<T>>();

  const touch = (key: string, entry: Entry<T>) => {
    entries.delete(key);
    entries.set(key, entry);
  };
  const dropIfEmpty = (key: string, entry: Entry<T>) => {
    if (!entry.value && !entry.flight && entries.get(key) === entry) entries.delete(key);
  };
  const evict = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) return;
      if (!entry.flight) entries.delete(key);
    }
  };

  return {
    get(key, load, { fresh = false } = {}) {
      let entry = entries.get(key);
      if (!entry) {
        entry = {};
        entries.set(key, entry);
      } else {
        touch(key, entry);
      }
      const held = entry;
      if (held.value && !fresh) {
        return { promise: Promise.resolve(held.value.current), release: NO_RELEASE };
      }
      if (!held.flight) {
        const controller = new AbortController();
        const flight: Flight<T> = { controller, waiters: 0, done: false, promise: Promise.resolve(undefined as T) };
        const finish = () => {
          flight.done = true;
          if (held.flight === flight) held.flight = undefined;
        };
        flight.promise = load(controller.signal).then(
          (value) => {
            finish();
            if (keep(value)) {
              held.value = { current: value };
              if (entries.get(key) === held) touch(key, held);
              evict();
            } else {
              dropIfEmpty(key, held);
            }
            return value;
          },
          (error: unknown) => {
            finish();
            dropIfEmpty(key, held);
            throw error;
          },
        );
        held.flight = flight;
      }
      const flight = held.flight;
      flight.waiters += 1;
      let released = false;
      return {
        promise: flight.promise,
        release: () => {
          if (released || flight.done) return;
          released = true;
          flight.waiters -= 1;
          if (flight.waiters === 0) {
            if (held.flight === flight) held.flight = undefined;
            flight.controller.abort();
            dropIfEmpty(key, held);
          }
        },
      };
    },
    peek(key) {
      return entries.get(key)?.value?.current;
    },
  };
}
