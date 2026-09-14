"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRunEvents, type RunEvent } from "@/hooks/use-run-events";
import type { AgentTaskBatchRunSummary } from "@/lib/agent-task-api";

/**
 * Coalesce SSE-triggered refreshes: a busy batch emits bursts (concurrent
 * task completions, plus one replayed `task_run.started` per running task on
 * every stream (re)connect), and each refresh re-runs the whole server page.
 */
const REFRESH_COALESCE_MS = 1000;

const BATCH_TERMINAL_EVENTS = new Set(["batch_run.completed", "batch_run.failed"]);
const TASK_PROGRESS_EVENTS = new Set([
  "task_run.started",
  "task_run.completed",
  "task_run.error",
]);

const isPending = (b: AgentTaskBatchRunSummary): boolean =>
  b.status === "running" || b.status === "queued";

interface RunsListAutoRefreshProps {
  project: string;
  batchRuns: AgentTaskBatchRunSummary[];
  /**
   * Listen for runs that are not listed yet. The list is newest-first, so a
   * run started elsewhere (CLI, schedule, another tab) only lands on page 0.
   */
  watchForNewRuns: boolean;
}

export function RunsListAutoRefresh({
  project,
  batchRuns,
  watchForNewRuns,
}: RunsListAutoRefreshProps) {
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Unlisted batches already refreshed for once. One that is still unlisted
  // after that refresh is filtered out or on a later page, so its remaining
  // task events must not keep re-fetching a list it will never appear in.
  const refreshedForUnlistedRef = useRef(new Set<string>());

  const listedIds = useMemo(() => new Set(batchRuns.map((b) => b.id)), [batchRuns]);
  const hasPending = batchRuns.some(isPending);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      router.refresh();
    }, REFRESH_COALESCE_MS);
  }, [router]);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      const isTerminal = BATCH_TERMINAL_EVENTS.has(event.event_type);
      if (!isTerminal && !TASK_PROGRESS_EVENTS.has(event.event_type)) return;
      const batchRunId = event.data.batch_run_id;
      if (typeof batchRunId !== "string" || !batchRunId) return;

      if (listedIds.has(batchRunId)) {
        scheduleRefresh();
        return;
      }
      if (!watchForNewRuns) return;
      // A terminal event always gets its refresh: a run hidden while running
      // (e.g. a status filter for failed runs) may match the list once it ends.
      const seen = refreshedForUnlistedRef.current;
      if (isTerminal || !seen.has(batchRunId)) {
        seen.add(batchRunId);
        scheduleRefresh();
      }
    },
    [listedIds, watchForNewRuns, scheduleRefresh],
  );

  useRunEvents({
    project,
    enabled: hasPending || watchForNewRuns,
    onEvent: handleEvent,
    // Events published while the stream was down are never replayed.
    onReconnect: scheduleRefresh,
  });

  return null;
}
