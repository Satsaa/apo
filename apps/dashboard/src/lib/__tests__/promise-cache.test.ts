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

  it("refreshes a kept value on a fresh get, and keeps it if the refresh fails", async () => {
    const cache = createPromiseCache<string>();
    const load = vi
      .fn()
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2")
      .mockRejectedValueOnce(new Error("503"));
    await cache.get("k", load).promise;
    expect(await cache.get("k", load, { fresh: true }).promise).toBe("v2");
    expect(cache.peek("k")).toBe("v2");
    await expect(cache.get("k", load, { fresh: true }).promise).rejects.toThrow("503");
    expect(cache.peek("k")).toBe("v2");
  });

  it("keeps a kept value when an in-flight refresh is released", async () => {
    const cache = createPromiseCache<string>();
    await cache.get("k", async () => "v1").promise;
    const signals: AbortSignal[] = [];
    const refresh = cache.get("k", (signal) => {
      signals.push(signal);
      return pending<string>().promise;
    }, { fresh: true });
    refresh.release();
    expect(signals[0].aborted).toBe(true);
    expect(cache.peek("k")).toBe("v1");
  });

  it("answers a plain get from the kept value while a refresh is in flight", async () => {
    const cache = createPromiseCache<string>();
    await cache.get("k", async () => "v1").promise;
    const refresh = cache.get("k", () => Promise.reject(new Error("503")), { fresh: true });
    expect(await cache.get("k", async () => "unused").promise).toBe("v1");
    await expect(refresh.promise).rejects.toThrow("503");
  });

  it("keeps the kept value when keep refuses a refresh", async () => {
    const cache = createPromiseCache<string>({ keep: (value) => value !== "" });
    await cache.get("k", async () => "v1").promise;
    expect(await cache.get("k", async () => "", { fresh: true }).promise).toBe("");
    expect(cache.peek("k")).toBe("v1");
  });

  it("holds at most maxEntries values, dropping the least recently used", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 2 });
    await cache.get("a", async () => "A").promise;
    await cache.get("b", async () => "B").promise;
    await cache.get("a", async () => "A").promise;
    await cache.get("c", async () => "C").promise;
    expect(cache.peek("a")).toBe("A");
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("c")).toBe("C");
  });
});
