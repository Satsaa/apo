"use client";

import { useEffect, useState } from "react";

import {
  getConnectedExecutorStatus,
  type ConnectedEnvironmentState,
} from "@/lib/agent-task-api";

const POLL_MS = 15_000;

export interface ExecutorRunWarning {
  title: string;
  detail: string;
}

/**
 * Why a dashboard run would sit in the queue, or null when an Executor will
 * claim it. Dashboard Batches target the member's own Connected Executors, so
 * a teammate's `apo connect` does not help; the copy says "your".
 */
export function executorRunWarning(
  state: ConnectedEnvironmentState | null,
): ExecutorRunWarning | null {
  const expiry = "Runs wait in the queue and expire after 24 hours if nothing claims them.";
  switch (state) {
    case "not_connected":
      return {
        title: "No connected environment",
        detail: `Run apo connect in this Task workspace to execute dashboard runs. ${expiry}`,
      };
    case "offline":
      return {
        title: "Your connected environment is offline",
        detail: `Start apo connect again in this Task workspace. ${expiry}`,
      };
    case "incompatible":
      return {
        title: "Your connected environment is incompatible",
        detail: `Update the Apo CLI, then restart apo connect. ${expiry}`,
      };
    case "catalog_mismatch":
      return {
        title: "Your published catalog is out of date",
        detail: `Run apo task publish from this Task workspace; apo connect resumes automatically. ${expiry}`,
      };
    default:
      return null;
  }
}

/** Polls the member's Connected Executor state; null until known or on error. */
export function useConnectedExecutorState(
  projectId: string,
  enabled: boolean,
): ConnectedEnvironmentState | null {
  const [state, setState] = useState<ConnectedEnvironmentState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      getConnectedExecutorStatus(projectId)
        .then((res) => {
          if (!cancelled) setState(res.state);
        })
        .catch(() => {
          // Status is advisory: an unreachable endpoint must not warn or block.
          if (!cancelled) setState(null);
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, enabled]);

  return enabled ? state : null;
}
