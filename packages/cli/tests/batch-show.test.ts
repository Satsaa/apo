import { describe, expect, it } from "vitest";
import { formatNeverStarted } from "../src/commands/batch-show.ts";

type Run = Parameters<typeof formatNeverStarted>[0]["task_runs"][number];

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    task_id: "chat/a",
    task_path: "chat/a",
    adapter_name: null,
    status: "passed",
    pass_result: true,
    error_message: null,
    total_cost: null,
    trace_run_id: null,
    started_at: "2026-10-09T12:00:00Z",
    completed_at: "2026-10-09T12:01:00Z",
    total_checks: 0,
    passed_checks: 0,
    failed_checks: 0,
    ...overrides,
  };
}

const TTL = "queue TTL expired before an executor claimed the task";

describe("formatNeverStarted", () => {
  it("prints nothing when every run started", () => {
    expect(formatNeverStarted({ task_runs: [makeRun(), makeRun({ status: "error", error_message: "boom" })] })).toEqual([]);
  });

  it("counts never-started runs and names the recorded reason", () => {
    const runs = [
      makeRun({ status: "error", error_message: "Failed query: select" }),
      makeRun({ status: "error", started_at: null, error_message: TTL }),
      makeRun({ status: "error", started_at: null, error_message: TTL }),
    ];
    expect(formatNeverStarted({ task_runs: runs })).toEqual([`  2 of 3 never started: ${TTL}`]);
  });

  it("groups by reason when they differ, and does not invent one", () => {
    const runs = [
      makeRun({ status: "error", started_at: null, error_message: TTL }),
      makeRun({ status: "error", started_at: null, error_message: null }),
    ];
    expect(formatNeverStarted({ task_runs: runs })).toEqual([
      "  2 of 2 never started:",
      `    1× ${TTL}`,
      "    1× no reason recorded",
    ]);
  });

  it("ignores runs still waiting in the queue", () => {
    expect(formatNeverStarted({ task_runs: [makeRun({ status: "pending", started_at: null })] })).toEqual([]);
  });
});
