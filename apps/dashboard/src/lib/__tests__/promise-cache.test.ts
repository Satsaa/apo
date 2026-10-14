import { describe, expect, it, vi } from "vitest";
import { createPromiseCache } from "../promise-cache";

const pending = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("createPromiseCache", () => {
  it("loads once and serves later callers from memory", async () => {
    const cache = createPromiseCache<string>();
    const load = vi.fn().mockResolvedValue("source");
    expect(cache.peek("k")).toBeUndefined();
    const [a, b] = await Promise.all([cache.get("k", load).promise, cache.get("k", load).promise]);
    expect([a, b]).toEqual(["source", "source"]);
    expect(await cache.get("k", load).promise).toBe("source");
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.peek("k")).toBe("source");
  });

  it("drops a failed load so the next caller retries", async () => {
    const cache = createPromiseCache<string>();
    const load = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce("source");
    await expect(cache.get("k", load).promise).rejects.toThrow("503");
    expect(cache.peek("k")).toBeUndefined();
    expect(await cache.get("k", load).promise).toBe("source");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not keep a value the keep rule refuses", async () => {
    const cache = createPromiseCache<{ status: string }>({ keep: (run) => run.status !== "running" });
    const load = vi.fn().mockResolvedValueOnce({ status: "running" }).mockResolvedValueOnce({ status: "passed" });
    expect(await cache.get("k", load).promise).toEqual({ status: "running" });
    expect(cache.peek("k")).toBeUndefined();
    expect(await cache.get("k", load).promise).toEqual({ status: "passed" });
    expect(await cache.get("k", load).promise).toEqual({ status: "passed" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight load once every caller has released it", () => {
    const cache = createPromiseCache<string>();
    const signals: AbortSignal[] = [];
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return pending<string>().promise;
    });
    const first = cache.get("k", load);
    const second = cache.get("k", load);
    first.release();
    expect(signals[0].aborted).toBe(false);
    second.release();
    expect(signals[0].aborted).toBe(true);
    cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps a settled load when its caller releases it", async () => {
    const cache = createPromiseCache<string>();
    const { promise, resolve } = pending<string>();
    const load = vi.fn(() => promise);
    const held = cache.get("k", load);
    resolve("source");
    await held.promise;
    held.release();
    expect(cache.peek("k")).toBe("source");
  });
});
