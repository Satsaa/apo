"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Bell,
  Calendar,
  CheckCircle2,
  Plus,
  Search,
  XCircle,
} from "lucide-react";
import { type AgentTaskSummary } from "@/lib/agent-task-api";
import { type ProjectTaskSource } from "@/lib/projects-api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type Filter, useScheduleActions } from "./useScheduleActions";
import ScheduleCard from "./ScheduleCard";
import CreateScheduleDialog from "./CreateScheduleDialog";
import { useProjectId } from "@/lib/project-router";
import { useClientNow } from "@/hooks/use-client-now";
import { ScheduleListAutoRefresh } from "@/components/agent-task-execution/schedule-list-auto-refresh";
import type { ExecutorPoolSummary } from "@/lib/executor-api";

interface AgentTaskSchedulesClientProps {
  /** Failure-notification rules that watch these schedules. */
  automations: import("@/lib/automations-api").AutomationSummary[];
  tasks: AgentTaskSummary[];
  schedules: import("@/lib/agent-task-api").AgentTaskScheduleSummary[];
  initialTaskIds: string[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
  executorPools: ExecutorPoolSummary[];
  /** Admin-tier controls render only for roles that can manage them. */
  canManage?: boolean;
}

export function AgentTaskSchedulesClient({
  automations,
  tasks,
  schedules: initialSchedules,
  initialTaskIds,
  error: serverError,
  taskSource,
  executorPools,
  canManage = true,
}: AgentTaskSchedulesClientProps) {
  const projectId = useProjectId();
  const {
    schedules,
    filtered,
    stats,
    filter,
    setFilter,
    search,
    setSearch,
    actionError,
    clearError,
    handleToggleEnabled,
    handleDelete,
    handleTrigger,
    addSchedule,
    refreshSchedule,
  } = useScheduleActions(initialSchedules, serverError);
  const clientNow = useClientNow();
  const [showCreate, setShowCreate] = useState(false);
  const sourceUnavailable =
    (taskSource === null || taskSource.inventory_stale) &&
    initialSchedules.length === 0;

  if (sourceUnavailable) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-center gap-2 mb-8">
          <Calendar size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold">Schedules</h1>
        </div>
        <div className="px-6 py-10 text-center text-sm text-neutral-400">
          Run <code className="text-neutral-200">apo task publish</code> to publish your task catalog before scheduling.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <ScheduleListAutoRefresh
        project={projectId}
        schedules={schedules}
        onRefresh={refreshSchedule}
      />
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-primary" />
            <h1 className="text-[18px] font-semibold">Schedules</h1>
          </div>
        </div>
        {canManage ? (
        <Button
          size="sm"
          onClick={() => setShowCreate(true)}
          disabled={projectId === "demo" || taskSource?.inventory_stale === true}
        >
          <Plus size={14} className="mr-1.5" />
          New Schedule
        </Button>
        ) : null}
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-2 border border-border bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Bell size={14} className="shrink-0 text-primary" />
          {automations.length > 0 ? (
            <span>
              <span className="font-medium">
                {automations.length} automation{automations.length === 1 ? "" : "s"}
              </span>{" "}
              get notified when scheduled runs fail
            </span>
          ) : (
            <span className="text-muted-foreground">
              No failure notifications — get told when a scheduled run fails
            </span>
          )}
        </div>
        <Link
          href={`/project/${projectId}/automations`}
          className="shrink-0 border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Manage Automations →
        </Link>
      </div>

      {actionError && (
        <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-6">
          {actionError}
          <button type="button" onClick={clearError} className="ml-3 text-destructive/60 hover:text-destructive">
            dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 mb-6 sm:gap-3">
        {[
          { label: "Total", value: stats.total, icon: <Calendar size={14} className="text-muted-foreground" /> },
          { label: "Active", value: stats.enabled, icon: <CheckCircle2 size={14} className="text-success" /> },
          { label: "Paused", value: stats.disabled, icon: <XCircle size={14} className="text-muted-foreground" /> },
        ].map((stat) => (
          <div key={stat.label} className="flex items-center gap-2 border border-border/60 bg-card/75 px-2.5 py-3 sm:gap-3 sm:px-4">
            {stat.icon}
            <div>
              <div className="text-[18px] font-semibold font-mono">{stat.value}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by name..." className="pl-8" />
        </div>
        <div className="flex items-center gap-1 border border-border/60 bg-card/75 p-1">
          {(["all", "enabled", "disabled"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-all ${
                filter === f ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-12 h-12 rounded-full border border-border/60 flex items-center justify-center">
            <Calendar size={20} className="text-muted-foreground/50" />
          </div>
          <div className="text-center">
            <p className="text-sm">{search || filter !== "all" ? "No schedules match your filters" : "No schedules yet"}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {!search && filter === "all" && "Create a schedule to automate recurring task validation."}
            </p>
          </div>
          {!search && filter === "all" && canManage ? (
            <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={13} className="mr-1.5" />
              New Schedule
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              manageable={canManage}
              schedule={schedule}
              executorPoolName={
                executorPools.find((pool) => pool.id === schedule.executor_pool_id)?.name ?? null
              }
              clientNow={clientNow}
              onToggle={handleToggleEnabled}
              onDelete={handleDelete}
              onTrigger={handleTrigger}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateScheduleDialog
          tasks={tasks}
          initialTaskIds={initialTaskIds}
          onClose={() => setShowCreate(false)}
          onCreated={(newSchedule) => {
            addSchedule(newSchedule);
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}
