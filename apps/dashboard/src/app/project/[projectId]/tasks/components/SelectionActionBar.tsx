"use client";

import { AlertTriangle, ChevronDown, GitCompare, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { ExecutorRunWarning } from "./executor-run-warning";

export function SelectionActionBar({
  selectedCount,
  runRunning,
  comparing,
  isDemoProject,
  canRunTasks = true,
  runWarning = null,
  compareOptions,
  onClear,
  onRun,
  onCompare,
}: {
  selectedCount: number;
  runRunning: boolean;
  comparing: boolean;
  isDemoProject: boolean;
  /** Hide write actions for read-only visitors. */
  canRunTasks?: boolean;
  /** Why a run would sit unclaimed in the queue; shown above the bar. */
  runWarning?: ExecutorRunWarning | null;
  compareOptions: { model: string | null; label: string }[];
  onClear: () => void;
  onRun: () => void;
  onCompare: (bModel: string | null) => void;
}) {
  return (
    <div className="sticky bottom-4 z-20 mx-auto mb-4 w-fit max-w-[calc(100%-1rem)]">
      {canRunTasks && !isDemoProject && runWarning ? (
        <div
          role="status"
          data-testid="executor-run-warning"
          className="mb-2 flex max-w-xl items-start gap-2 border border-warning/40 bg-card px-3 py-2 text-[12px] shadow-2xl shadow-black/60"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <div>
            <p className="font-medium text-foreground">{runWarning.title}</p>
            <p className="text-muted-foreground">{runWarning.detail}</p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border border-border bg-card px-3 py-2 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="grid h-5 min-w-5 place-items-center bg-white px-1 font-mono text-[11px] font-semibold text-black">
            {selectedCount}
          </span>
          <span className="text-muted-foreground">
            task{selectedCount > 1 ? "s" : ""} selected
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground/70" onClick={onClear}>
          Clear
        </Button>
        {canRunTasks ? (
          <Button type="button" size="sm" className="h-7 gap-1.5 px-3 text-[12px] font-medium" onClick={onRun} disabled={runRunning || isDemoProject} title={isDemoProject ? "Demo workspace is read-only" : undefined}>
            <Play className="h-3 w-3 fill-current" />
            {runRunning ? "Starting..." : "Run selection"}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 px-3 text-[12px] font-medium"
              disabled={comparing || isDemoProject || compareOptions.length === 0}
              title={isDemoProject ? "Demo workspace is read-only" : "Compare the selection against another view"}
            >
              <GitCompare className="h-3 w-3" />
              {comparing ? "Building…" : "Compare"}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <p className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-foreground/60">
              Compare against
            </p>
            {compareOptions.map((opt) => (
              <DropdownMenuItem
                key={opt.model ?? "__all__"}
                onClick={() => onCompare(opt.model)}
                className="text-[13px] text-foreground/80"
              >
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
