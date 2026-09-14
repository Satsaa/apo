import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunEvent } from "@/hooks/use-run-events";
import type { AgentTaskBatchRunSummary } from "@/lib/agent-task-api";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

interface CapturedOptions {
  enabled: boolean;
  onEvent: (event: RunEvent) => void;
  onReconnect?: () => void;
}
let hookOptions: CapturedOptions;
vi.mock("@/hooks/use-run-events", () => ({
  useRunEvents: (options: CapturedOptions) => {
    hookOptions = options;
  },
}));

import { RunsListAutoRefresh } from "../runs-list-auto-refresh";

const batch = (id: string, status: string): AgentTaskBatchRunSummary =>
  ({ id, status }) as AgentTaskBatchRunSummary;

const event = (event_type: string, batch_run_id?: string): RunEvent => ({
  event_type,
  project: "proj-1",
  data: batch_run_id === undefined ? {} : { batch_run_id },
  timestamp: "2026-09-14T00:00:00Z",
});

const emit = (e: RunEvent) => act(() => hookOptions.onEvent(e));
const flush = () => act(() => vi.advanceTimersByTime(1_000));

const renderList = (batchRuns: AgentTaskBatchRunSummary[], watchForNewRuns: boolean) =>
  render(
    <RunsListAutoRefresh project="proj-1" batchRuns={batchRuns} watchForNewRuns={watchForNewRuns} />,
  );

describe("RunsListAutoRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("when it listens", () => {
    it("stays off on a later page with nothing running", () => {
      renderList([batch("b1", "completed")], false);
      expect(hookOptions.enabled).toBe(false);
    });

    it("listens on a later page while a listed run is pending", () => {
      renderList([batch("b1", "completed"), batch("b2", "queued")], false);
      expect(hookOptions.enabled).toBe(true);
    });

    it("listens on page 0 even with nothing running, to catch new runs", () => {
      renderList([batch("b1", "completed")], true);
      expect(hookOptions.enabled).toBe(true);
    });
  });

  describe("listed runs", () => {
    it("refreshes when a listed run finishes", () => {
      renderList([batch("b1", "running")], false);
      emit(event("batch_run.completed", "b1"));
      expect(refresh).not.toHaveBeenCalled();
      flush();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it.each(["batch_run.failed", "task_run.started", "task_run.completed", "task_run.error"])(
      "refreshes on %s for a listed run",
      (type) => {
        renderList([batch("b1", "running")], false);
        emit(event(type, "b1"));
        flush();
        expect(refresh).toHaveBeenCalledTimes(1);
      },
    );

    it("coalesces a burst of events into one refresh", () => {
      renderList([batch("b1", "running")], false);
      emit(event("task_run.completed", "b1"));
      emit(event("task_run.completed", "b1"));
      emit(event("batch_run.completed", "b1"));
      flush();
      expect(refresh).toHaveBeenCalledTimes(1);

      emit(event("task_run.completed", "b1"));
      flush();
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("ignores trace claims and events without a batch id", () => {
      renderList([batch("b1", "running")], true);
      emit(event("task_run.trace_claimed", "b1"));
      emit(event("task_run.completed"));
      emit(event("task_run.completed", ""));
      flush();
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe("unlisted runs", () => {
    it("refreshes page 0 once for a run it has never seen", () => {
      renderList([batch("b1", "completed")], true);
      emit(event("task_run.started", "new"));
      flush();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does not keep refreshing for a run that stays unlisted", () => {
      renderList([batch("b1", "completed")], true);
      emit(event("task_run.started", "hidden"));
      flush();
      emit(event("task_run.completed", "hidden"));
      emit(event("task_run.started", "hidden"));
      flush();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("still refreshes when an unlisted run finishes, since it may now match the filters", () => {
      renderList([batch("b1", "completed")], true);
      emit(event("task_run.started", "hidden"));
      flush();
      emit(event("batch_run.failed", "hidden"));
      flush();
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("ignores unlisted runs on a later page", () => {
      renderList([batch("b1", "running")], false);
      emit(event("task_run.started", "other"));
      emit(event("batch_run.completed", "other"));
      flush();
      expect(refresh).not.toHaveBeenCalled();
    });

    it("treats a run as listed once a refresh brings it in", () => {
      const view = renderList([batch("b1", "completed")], true);
      emit(event("task_run.started", "new"));
      flush();
      view.rerender(
        <RunsListAutoRefresh
          project="proj-1"
          batchRuns={[batch("new", "running"), batch("b1", "completed")]}
          watchForNewRuns
        />,
      );
      emit(event("task_run.completed", "new"));
      flush();
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  it("refreshes after a reconnect, since missed events are never replayed", () => {
    renderList([batch("b1", "running")], false);
    act(() => hookOptions.onReconnect?.());
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("drops a pending refresh on unmount", () => {
    const view = renderList([batch("b1", "running")], false);
    emit(event("batch_run.completed", "b1"));
    view.unmount();
    flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
