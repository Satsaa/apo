"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Clock, GitBranch, GitCompare, Loader2 } from "lucide-react";

import {
  type AgentTaskBatchRunSummary,
  type AgentTaskRunSummary,
  getAgentTaskBatchRun,
} from "@/lib/agent-task-api";
import { conclusionStyle } from "@/components/run-outcome";
import { DeleteRunButton } from "@/components/runs/DeleteRunButton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatCostMicro, formatTokenTotal } from "@/lib/format";
import { formatBatchExecution } from "@/lib/run-configuration";

import { InlineTaskRunRow } from "./InlineTaskRunRow";
import { formatDuration, formatRelative, formatTrigger, getBatchName, getSourceIcon, getTaskPaths } from "./runs-utils";

interface RunsRowProps {
  batch: AgentTaskBatchRunSummary;
  clientNow: number | null;
  projectId: string;
  compareSelected: boolean;
  compareDisabled: boolean;
  onToggleCompare: () => void;
  modelFilter: Set<string>;
  /** Caller's project role allows run deletion (owner/admin). */
  canDelete: boolean;
}

/**
 * One batch run row plus its lazily loaded inline task-run rows. Expansion
 * state and the fetched task runs are local to the row; compare selection and
 * the model filter are owned by the parent.
 */
export function RunsRow({
  batch,
  clientNow,
  projectId,
  compareSelected,
  compareDisabled,
  onToggleCompare,
  modelFilter,
  canDelete,
}: RunsRowProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [taskRuns, setTaskRuns] = useState<AgentTaskRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = conclusionStyle({
    status: batch.status,
    passed: batch.passed_tasks,
    failed: batch.failed_tasks,
    errored: batch.errored_tasks,
    total: batch.total_tasks,
  });
  const checkTotal = Math.max(batch.total_checks, 1);
  const passRate = Math.round((batch.passed_checks / checkTotal) * 100);
  const isRunning = batch.status === "running" || batch.status === "queued";
  const showRate = batch.total_checks > 0 || !isRunning;
  const triggerLabel = formatTrigger(batch.trigger);
  const SourceIcon = getSourceIcon(batch.trigger?.source ?? null);
  const batchName = getBatchName(batch);
  const taskPaths = getTaskPaths(batch);
  const branch = (batch.trigger as Record<string, unknown> | null)?.branch as string | null;
  const commit = (batch.trigger as Record<string, unknown> | null)?.commit_sha as string | null;

  // Only the newest request may write: a live refresh can re-fetch while an
  // earlier load is still in flight, and that older response must not win.
  // A background re-fetch keeps the current rows on screen (no spinner) and
  // leaves them in place if it fails — a live update must not blank them.
  const fetchSeqRef = useRef(0);
  const loadTaskRuns = useCallback(
    async (background: boolean) => {
      const seq = ++fetchSeqRef.current;
      if (!background) {
        setLoading(true);
        setError(null);
      }
      try {
        const detail = await getAgentTaskBatchRun(batch.id);
        if (seq === fetchSeqRef.current) {
          setTaskRuns(detail.task_runs ?? []);
          setError(null);
        }
      } catch (e: unknown) {
        if (seq === fetchSeqRef.current && !background) {
          setError(e instanceof Error ? e.message : "Failed to load task runs");
        }
      } finally {
        if (seq === fetchSeqRef.current) setLoading(false);
      }
    },
    [batch.id],
  );

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && taskRuns === null && !loading) void loadTaskRuns(false);
  }, [expanded, taskRuns, loading, loadTaskRuns]);

  // The list re-renders with a fresh summary whenever a live event lands.
  // While the batch is (or just stopped) running, the task runs cached on
  // first expand are stale: re-fetch them if shown, otherwise drop them so
  // the next expand loads current ones.
  const prevBatchRef = useRef(batch);
  useEffect(() => {
    const prev = prevBatchRef.current;
    if (prev === batch) return;
    prevBatchRef.current = batch;
    const wasPending = prev.status === "running" || prev.status === "queued";
    if (!wasPending && !isRunning) return;
    if (expanded) void loadTaskRuns(true);
    else setTaskRuns(null);
  }, [batch, isRunning, expanded, loadTaskRuns]);

  // Splice the deleted task run out of the expanded rows; deleting the
  // last one also removes the (now empty) batch, so re-fetch the list.
  const handleTaskRunDeleted = useCallback(
    (taskRunId: string) => {
      setTaskRuns((prev) => prev?.filter((run) => run.id !== taskRunId) ?? prev);
      if ((taskRuns?.length ?? 0) <= 1) router.refresh();
    },
    [taskRuns, router],
  );

  return (
    <>
      <TableRow
        data-testid={`runs-row-${batch.id}`}
        className="group cursor-default border-border/60 transition-colors hover:bg-muted/30"
      >
        <TableCell className="px-2">
          {batch.total_tasks > 1 ? (
            <button
              type="button"
              onClick={handleToggle}
              aria-label={expanded ? "Collapse task runs" : "Expand task runs"}
              aria-expanded={expanded}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {loading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded ? "" : "-rotate-90")} />}
            </button>
          ) : null}
        </TableCell>

        <TableCell>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", s.dot)}
                title={s.label}
                aria-hidden
              />
              <span className="sr-only">{s.label}</span>
              <Link
                href={`/project/${projectId}/runs/${batch.id}`}
                className="truncate text-[14px] font-medium text-foreground hover:text-primary"
              >
                {batchName}
              </Link>
            </div>
            <div className="mt-1 flex items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="shrink-0 font-mono text-muted-foreground/60">{batch.id.slice(0, 8)}</span>
              {branch && (
                <>
                  <span className="shrink-0 text-muted-foreground/30">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <GitBranch className="h-3 w-3 text-muted-foreground/50" />
                    <span className="font-mono">{branch}</span>
                    {commit && <span className="font-mono text-muted-foreground/50">@{commit.slice(0, 7)}</span>}
                  </span>
                </>
              )}
              {taskPaths.length > 1 && (
                <>
                  <span className="shrink-0 text-muted-foreground/30">·</span>
                  <span className="shrink-0 truncate text-muted-foreground">
                    {taskPaths.slice(0, 3).join(" · ")}
                    {taskPaths.length > 3 && <span className="ml-1">+{taskPaths.length - 3}</span>}
                  </span>
                </>
              )}
            </div>
          </div>
        </TableCell>

        <TableCell className="hidden xl:table-cell">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded border border-border bg-card">
              <SourceIcon className="h-3 w-3 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {triggerLabel}
              </div>
            </div>
          </div>
        </TableCell>

        <TableCell>
          <span className="truncate font-mono text-[12px] tabular-nums text-muted-foreground" title={formatBatchExecution(batch.configuration)}>
            {formatBatchExecution(batch.configuration)}
          </span>
        </TableCell>

        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-2 font-mono text-[13px] tabular-nums">
            <span className={cn(
              "tabular-nums",
              showRate
                ? (passRate >= 95 ? "text-success" : passRate >= 80 ? "text-foreground" : "text-destructive")
                : "text-muted-foreground",
            )}>{showRate ? `${passRate}%` : "\u2014"}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground text-[12px]">{batch.passed_tasks}/{batch.total_tasks} tasks</span>
          </div>
          <div className="mt-1.5 flex justify-end">
            {isRunning ? (
              <span className="font-mono text-[11px] text-muted-foreground">running...</span>
            ) : (
              <div className="h-1 w-24 overflow-hidden rounded-full bg-border">
                <div
                  className={cn("h-full", passRate >= 95 ? "bg-success" : passRate < 80 ? "bg-destructive" : "bg-foreground/30")}
                  style={{ width: `${passRate}%` }}
                />
              </div>
            )}
          </div>
        </TableCell>

        <TableCell className="text-right">
          <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[13px] tabular-nums text-foreground">
            <Clock className="h-3 w-3 text-muted-foreground/50" />
            {formatDuration(batch.started_at, batch.completed_at, isRunning)}
          </div>
          {batch.total_cost != null && batch.total_cost > 0 && (
            <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatCostMicro(batch.total_cost)}
              {(batch.unpriced_call_count ?? 0) > 0 && (
                <span
                  className="ml-1 text-warning"
                  title={`${batch.unpriced_call_count} call${batch.unpriced_call_count === 1 ? "" : "s"} had no pricing entry — this total is partial`}
                >
                  +{batch.unpriced_call_count} unpriced
                </span>
              )}
            </div>
          )}
          {batch.total_tokens != null && batch.total_tokens > 0 && (
            <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatTokenTotal(batch.total_tokens)}
            </div>
          )}
        </TableCell>

        <TableCell>
          <div className="flex items-center justify-end gap-2">
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
              {formatRelative(batch.created_at, clientNow)}
            </span>
            <button
              type="button"
              onClick={onToggleCompare}
              disabled={compareDisabled}
              aria-pressed={compareSelected}
              aria-label={compareSelected ? "Remove from comparison" : "Add to comparison"}
              title={compareDisabled ? "Clear a selection to compare this run" : compareSelected ? "Selected for comparison" : "Compare this run"}
              className={cn(
                "grid h-6 w-6 place-items-center rounded border transition-colors",
                compareSelected
                  ? "border-foreground bg-foreground text-background"
                  : compareDisabled
                    ? "cursor-not-allowed border-border text-muted-foreground/30"
                    : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground",
              )}
            >
              <GitCompare className="h-3.5 w-3.5" />
            </button>
            <DeleteRunButton
              target={{ kind: "batch", batchRunId: batch.id, taskCount: batch.total_tasks }}
              canDelete={canDelete}
            />
            <Link
              href={`/project/${projectId}/runs/${batch.id}`}
              aria-label="Open batch run"
              className="text-muted-foreground transition-opacity hover:text-foreground"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <>
          {loading && (
            <TableRow className="bg-white/10 hover:bg-transparent">
              <TableCell colSpan={7} className="py-6">
                <div className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading task runs{"\u2026"}
                </div>
              </TableCell>
            </TableRow>
          )}
          {!loading && error && (
            <TableRow className="bg-white/10 hover:bg-transparent">
              <TableCell colSpan={7} className="py-6 text-center text-[12px] text-destructive">{error}</TableCell>
            </TableRow>
          )}
          {!loading && !error && taskRuns !== null && (() => {
            const visible = modelFilter.size > 0
              ? taskRuns.filter((tr) => {
                  const m = tr.run_configuration?.model;
                  return typeof m === "string" && modelFilter.has(m);
                })
              : taskRuns;
            if (visible.length === 0) {
              return (
                <TableRow className="bg-white/10 hover:bg-transparent">
                  <TableCell colSpan={7} className="py-6 text-center text-[12px] text-muted-foreground">
                    {taskRuns.length === 0
                      ? "No task runs were recorded for this run."
                      : "No task runs match the current model filter."}
                  </TableCell>
                </TableRow>
              );
            }
            return visible.map((run) => (
              <InlineTaskRunRow
                key={run.id}
                run={run}
                projectId={projectId}
                clientNow={clientNow}
                canDelete={canDelete}
                onDeleted={() => handleTaskRunDeleted(run.id)}
              />
            ));
          })()}
        </>
      )}
    </>
  );
}
