/**
 * The task page's run history: the delete icon opens its confirmation
 * instead of the row navigating to the run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TaskRunRow } from "@/components/task-run-list";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";

const push = vi.fn();

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  };
});

vi.mock("@/lib/project-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-router")>();
  return { ...actual, useIsDemo: () => false };
});

const run = {
  id: "run_abc",
  batch_run_id: "batch_1",
  task_id: "support/refund",
  task_path: "support/refund",
  adapter_name: "claude-code",
  status: "passed",
  pass_result: true,
  started_at: null,
  completed_at: null,
  total_cost: null,
  total_tokens: null,
  total_checks: 1,
  passed_checks: 1,
  failed_checks: 0,
  errored_checks: 0,
  error_message: null,
  trigger: null,
} as unknown as AgentTaskRunSummary;

function renderRow() {
  return render(
    <table>
      <tbody>
        <TaskRunRow run={run} projectId="acme" canDelete onDelete={() => {}} />
      </tbody>
    </table>,
  );
}

beforeEach(() => {
  push.mockClear();
});

describe("TaskRunRow delete", () => {
  it("opens the confirmation when the trash icon itself is clicked", () => {
    renderRow();
    const icon = screen.getByRole("button", { name: "Delete this task run" }).querySelector("svg");
    fireEvent.click(icon!);

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("does not navigate on clicks inside the open dialog", () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Delete this task run" }));
    fireEvent.click(screen.getByText(/permanently deletes the task run/));

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("still navigates on a plain row click", () => {
    renderRow();
    fireEvent.click(screen.getByText("run_abc"));

    expect(push).toHaveBeenCalledWith("/project/acme/runs/task/run_abc");
  });
});
