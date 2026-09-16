import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CreateAutomationDialog from "../CreateAutomationDialog";
import * as automationsApi from "@/lib/automations-api";

const createAutomation = vi.fn();

vi.mock("@/lib/automations-api", async () => {
  const actual =
    await vi.importActual<typeof automationsApi>("@/lib/automations-api");
  return {
    ...actual,
    createAutomation: (...args: unknown[]) => createAutomation(...args),
  };
});

function renderDialog() {
  return render(
    <CreateAutomationDialog
      projectId="proj-a"
      open
      onOpenChange={() => {}}
      onCreated={() => {}}
      onError={() => {}}
    />,
  );
}

describe("CreateAutomationDialog wizard", () => {
  beforeEach(() => {
    createAutomation.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to schedule-scoped batch failures → GitHub issue", async () => {
    createAutomation.mockResolvedValue({ id: "a1", secret: null });
    renderDialog();

    // Step 0: pick the outcome.
    fireEvent.click(screen.getByRole("button", { name: /Open a GitHub issue/ }));

    // Step 1: the scheduled trigger is preselected; go straight to Next.
    fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    // Step 2: fill the GitHub fields.
    fireEvent.change(screen.getByLabelText("GitHub token"), {
      target: { value: "ghp_test" },
    });
    fireEvent.change(screen.getByLabelText("Repository owner"), {
      target: { value: "acme" },
    });
    fireEvent.change(screen.getByLabelText("Repository name"), {
      target: { value: "agent-harness" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Automation" }));

    await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
    const body = createAutomation.mock.calls[0][0];
    expect(body.event_type).toBe("batch_run.failed");
    expect(body.conditions).toEqual([
      { field: "trigger.source", operator: "eq", value: "schedule" },
    ]);
    expect(body.action_type).toBe("github_issue");
    expect(body.action_config).toEqual({
      owner: "acme",
      repo: "agent-harness",
      labels: null,
      title: null,
      body: null,
    });
    expect(body.github_token).toBe("ghp_test");
  });

  it("maps the specific-task trigger to pass_result false + task_id", async () => {
    createAutomation.mockResolvedValue({ id: "a2", secret: null });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Call a webhook/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /A specific task fails/ }),
    );
    // Next is disabled until the task id is provided.
    const next = screen.getByRole("button", { name: /^Next$/ });
    expect(next.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Task id to watch"), {
      target: { value: "data-extraction" },
    });
    expect(next.hasAttribute("disabled")).toBe(false);
    fireEvent.click(next);
    fireEvent.change(screen.getByLabelText("Webhook URL"), {
      target: { value: "https://example.com/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Automation" }));

    await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
    const body = createAutomation.mock.calls[0][0];
    expect(body.event_type).toBe("task_run.completed");
    expect(body.conditions).toEqual([
      { field: "pass_result", operator: "eq", value: false },
      { field: "task_id", operator: "eq", value: "data-extraction" },
    ]);
    expect(body.action_config).toEqual({ url: "https://example.com/hook" });
    expect(body.github_token).toBeUndefined();
  });

  it("advanced mode overrides the preset with a raw event and conditions", async () => {
    createAutomation.mockResolvedValue({ id: "a3", secret: null });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Call a webhook/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    fireEvent.change(screen.getByLabelText("Raw event type"), {
      target: { value: "batch_run.completed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Condition" }));
    fireEvent.change(
      screen.getByLabelText("Condition 1 field"),
      { target: { value: "failed_tasks" } },
    );
    fireEvent.change(screen.getByLabelText("Condition 1 value"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    fireEvent.change(screen.getByLabelText("Webhook URL"), {
      target: { value: "https://example.com/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Automation" }));

    await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
    const body = createAutomation.mock.calls[0][0];
    expect(body.event_type).toBe("batch_run.completed");
    expect(body.conditions).toEqual([
      { field: "failed_tasks", operator: "eq", value: 2 },
    ]);
  });
});
