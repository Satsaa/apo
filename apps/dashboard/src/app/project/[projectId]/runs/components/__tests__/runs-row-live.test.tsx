/**
 * A runs-list row whose summary is replaced by a live refresh must not keep
 * showing the task runs it cached on first expand.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTaskBatchRunDetail, AgentTaskBatchRunSummary, AgentTaskRunSummary } from "@/lib/agent-task-api";

const getAgentTaskBatchRun = vi.fn<(id: string) => Promise<AgentTaskBatchRunDetail>>();
vi.mock("@/lib/agent-task-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-task-api")>()),
  getAgentTaskBatchRun: (id: string) => getAgentTaskBatchRun(id),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/runs/DeleteRunButton", () => ({ DeleteRunButton: () => null }));

import { RunsRow } from "../RunsRow";

const summary = (status: string, passed = 0): AgentTaskBatchRunSummary =>
  ({
    id: "batch-1",
    project: "acme",
    selection_type: "all",
    selection_query: null,
    task_root: null,
    grep: null,
    environment: "local",
    status,
    total_tasks: 2,
    passed_tasks: passed,
    failed_tasks: 0,
    errored_tasks: 0,
    total_checks: 0,
    passed_checks: 0,
    created_at: "2026-09-14T00:00:00Z",
    started_at: "2026-09-14T00:00:00Z",
    completed_at: null,
    trigger: null,
    trace_persistence_status: "complete",
    trace_error_message: null,
    total_cost: null,
    total_tokens: null,
    configuration: { state: "unknown", configurations: [], reported_task_runs: 0, total_task_runs: 2 },
  }) as unknown as AgentTaskBatchRunSummary;

const taskRun = (id: string, status: string): AgentTaskRunSummary =>
  ({ id, task_id: id, status, adapter_name: "demo", run_configuration: null }) as unknown as AgentTaskRunSummary;

const detail = (...runs: AgentTaskRunSummary[]): AgentTaskBatchRunDetail =>
  ({ task_runs: runs }) as unknown as AgentTaskBatchRunDetail;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

function Row({ batch }: { batch: AgentTaskBatchRunSummary }) {
  return (
    <table>
      <tbody>
        <RunsRow
          batch={batch}
          clientNow={null}
          projectId="acme"
          compareSelected={false}
          compareDisabled={false}
          onToggleCompare={() => {}}
          modelFilter={new Set()}
          canDelete={false}
        />
      </tbody>
    </table>
  );
}

describe("RunsRow under live refresh", () => {
  beforeEach(() => {
    getAgentTaskBatchRun.mockReset();
  });

  it("re-fetches expanded task runs when a running batch's summary changes", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running"), taskRun("task-b", "queued")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    expect(await screen.findByRole("link", { name: "task-a" })).toBeInTheDocument();

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "passed"), taskRun("task-c", "running")));
    view.rerender(<Row batch={summary("running", 1)} />);

    expect(await screen.findByRole("link", { name: "task-c" })).toBeInTheDocument();
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(2);
  });

  it("keeps the expanded rows on screen while a live re-fetch is in flight", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    const pending = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(pending.promise);
    view.rerender(<Row batch={summary("running", 1)} />);
    await act(async () => {});

    expect(screen.getByRole("link", { name: "task-a" })).toBeInTheDocument();
    expect(screen.queryByText(/Loading task runs/)).toBeNull();

    await act(async () => pending.resolve(detail(taskRun("task-b", "running"))));
    expect(screen.getByRole("link", { name: "task-b" })).toBeInTheDocument();
  });

  it("keeps the current rows when a live re-fetch fails", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    getAgentTaskBatchRun.mockRejectedValueOnce(new Error("backend blip"));
    view.rerender(<Row batch={summary("running", 1)} />);
    await act(async () => {});

    expect(screen.getByRole("link", { name: "task-a" })).toBeInTheDocument();
    expect(screen.queryByText("backend blip")).toBeNull();
  });

  it("re-fetches once more when the batch finishes", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-done", "passed")));
    view.rerender(<Row batch={summary("completed", 2)} />);
    expect(await screen.findByRole("link", { name: "task-done" })).toBeInTheDocument();
  });

  it("does not re-fetch a finished batch whose summary is re-rendered", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "passed")));
    const view = render(<Row batch={summary("completed", 2)} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    view.rerender(<Row batch={summary("completed", 2)} />);
    await act(async () => {});
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(1);
  });

  it("drops the cached task runs of a collapsed row so the next expand loads fresh ones", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("stale", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "stale" });
    await userEvent.click(screen.getByRole("button", { name: "Collapse task runs" }));

    view.rerender(<Row batch={summary("completed", 2)} />);
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(1);

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("fresh", "passed")));
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    expect(await screen.findByRole("link", { name: "fresh" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "stale" })).toBeNull();
  });

  it("never lets an older response overwrite a newer one", async () => {
    const first = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(first.promise);
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("newer", "passed")));
    view.rerender(<Row batch={summary("completed", 2)} />);
    expect(await screen.findByRole("link", { name: "newer" })).toBeInTheDocument();

    await act(async () => first.resolve(detail(taskRun("older", "running"))));
    expect(screen.queryByRole("link", { name: "older" })).toBeNull();
    expect(screen.getByRole("link", { name: "newer" })).toBeInTheDocument();
  });
});
