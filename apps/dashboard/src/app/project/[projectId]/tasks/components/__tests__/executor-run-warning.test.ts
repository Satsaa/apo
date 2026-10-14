import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { getConnectedExecutorStatus } from "@/lib/agent-task-api";

import { executorRunWarning, useConnectedExecutorState } from "../executor-run-warning";

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return { ...actual, getConnectedExecutorStatus: vi.fn() };
});

describe("executorRunWarning", () => {
  it("is silent when an executor will claim the run", () => {
    expect(executorRunWarning("ready")).toBeNull();
    expect(executorRunWarning("busy")).toBeNull();
    expect(executorRunWarning(null)).toBeNull();
  });

  it.each([
    ["not_connected", "apo connect"],
    ["offline", "apo connect"],
    ["incompatible", "Update the Apo CLI"],
    ["catalog_mismatch", "Pull the latest tasks"],
  ] as const)("warns for %s and names the fix", (state, fix) => {
    const warning = executorRunWarning(state);
    expect(warning?.detail).toContain(fix);
    expect(warning?.detail).toContain("expire after 24 hours");
  });

  it("does not tell a member with a stale checkout to publish over a newer catalog", () => {
    expect(executorRunWarning("catalog_mismatch")?.detail).toContain(
      "apo task publish if your copy is newer",
    );
  });
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("useConnectedExecutorState", () => {
  beforeEach(() => {
    vi.mocked(getConnectedExecutorStatus).mockReset();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it("drops the previous answer while a new selection reloads", async () => {
    vi.mocked(getConnectedExecutorStatus).mockResolvedValueOnce({ state: "offline" });
    const { result, rerender } = renderHook(
      ({ enabled }) => useConnectedExecutorState("acme", enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current).toBe("offline"));

    vi.mocked(getConnectedExecutorStatus).mockReturnValue(new Promise(() => {}));
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current).toBeNull();
  });

  it("skips polls while the tab is hidden and refetches when it returns", async () => {
    vi.mocked(getConnectedExecutorStatus).mockResolvedValue({ state: "ready" });
    setHidden(true);
    renderHook(() => useConnectedExecutorState("acme", true));
    expect(getConnectedExecutorStatus).not.toHaveBeenCalled();

    setHidden(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(getConnectedExecutorStatus).toHaveBeenCalledTimes(1));
  });

  it("does not start a poll while one is in flight", () => {
    vi.useFakeTimers();
    vi.mocked(getConnectedExecutorStatus).mockReturnValue(new Promise(() => {}));
    renderHook(() => useConnectedExecutorState("acme", true));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getConnectedExecutorStatus).toHaveBeenCalledTimes(1);
  });
});
