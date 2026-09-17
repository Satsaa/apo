import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EditAutomationDialog from "../EditAutomationDialog";
import { ruleFromAutomation } from "../automation-presets";
import * as automationsApi from "@/lib/automations-api";

const updateAutomation = vi.fn();

vi.mock("@/lib/automations-api", async () => {
  const actual =
    await vi.importActual<typeof automationsApi>("@/lib/automations-api");
  return {
    ...actual,
    updateAutomation: (...args: unknown[]) => updateAutomation(...args),
  };
});

function makeAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    project_id: "proj-a",
    name: "Nightly failures → GitHub issue",
    description: null,
    event_type: "batch_run.failed",
    conditions: [
      { field: "trigger.source", operator: "eq", value: "schedule" },
    ],
    action_type: "github_issue",
    action_config: { owner: "acme", repo: "agent-harness" },
    enabled: true,
    consecutive_failures: 0,
    last_delivery_at: null,
    last_delivery_status: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  } as unknown as automationsApi.AutomationSummary;
}

describe("ruleFromAutomation reverse mapping", () => {
  it("recognizes the scheduled preset", () => {
    const source = ruleFromAutomation(makeAutomation());
    expect(source).toEqual({
      mode: "preset",
      trigger: "scheduled",
      taskFilter: "",
    });
  });

  it("recognizes the task preset regardless of condition order", () => {
    const source = ruleFromAutomation(
      makeAutomation({
        event_type: "task_run.completed",
        conditions: [
          { field: "task_id", operator: "eq", value: "data-extraction" },
          { field: "pass_result", operator: "eq", value: false },
        ],
      }),
    );
    expect(source).toEqual({
      mode: "preset",
      trigger: "task",
      taskFilter: "data-extraction",
    });
  });

  it("never claims a numeric task_id rule as the task preset", () => {
    const source = ruleFromAutomation(
      makeAutomation({
        event_type: "task_run.completed",
        conditions: [
          { field: "pass_result", operator: "eq", value: false },
          { field: "task_id", operator: "eq", value: 2 },
        ],
      }),
    );
    // strict backend typing means number 2 never matches the string preset
    expect(source.mode).toBe("advanced");
  });

  it("falls back to advanced for custom conditions — never reinterprets", () => {
    const source = ruleFromAutomation(
      makeAutomation({
        conditions: [
          { field: "failed_tasks", operator: "gte", value: 2 },
        ],
      }),
    );
    expect(source.mode).toBe("advanced");
    if (source.mode === "advanced") {
      expect(source.conditions[0].value).toBe("2");
    }
  });
});

describe("EditAutomationDialog", () => {
  beforeEach(() => {
    updateAutomation.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads current values and PATCHes without the token when left empty", async () => {
    updateAutomation.mockResolvedValue(makeAutomation());
    render(
      <EditAutomationDialog
        automation={makeAutomation()}
        open
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onError={() => {}}
      />,
    );

    // Preset preselected, fields prefilled from the stored rule.
    expect(
      screen.getByRole("button", { name: /A scheduled batch fails/ }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(screen.getByLabelText("Repository owner")).toHaveValue("acme");
    expect(screen.getByLabelText("Repository name")).toHaveValue("agent-harness");

    fireEvent.change(screen.getByLabelText("Repository name"), {
      target: { value: "agent-harness-v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    await waitFor(() => expect(updateAutomation).toHaveBeenCalledTimes(1));
    const [id, patch] = updateAutomation.mock.calls[0];
    expect(id).toBe("a1");
    expect(patch.event_type).toBe("batch_run.failed");
    expect(patch.conditions).toEqual([
      { field: "trigger.source", operator: "eq", value: "schedule" },
    ]);
    expect(patch.action_config).toEqual({
      owner: "acme",
      repo: "agent-harness-v2",
    });
    // Token left empty → not sent → the stored token is kept.
    expect(patch.github_token).toBeUndefined();
  });

  it("allows saving a slack automation with the URL left empty (keep)", async () => {
    updateAutomation.mockResolvedValue(
      makeAutomation({
        name: "failures → slack",
        action_type: "slack",
        action_config: { url_display: "hooks.slack.com/services/…/ret" },
        conditions: [],
        event_type: "batch_run.failed",
      }),
    );
    render(
      <EditAutomationDialog
        automation={makeAutomation({
          name: "failures → slack",
          action_type: "slack",
          action_config: { url_display: "hooks.slack.com/services/…/ret" },
          conditions: [],
          event_type: "batch_run.failed",
        })}
        open
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onError={() => {}}
      />,
    );
    // rename only, URL untouched — Save must be enabled
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "failures → slack v2" },
    });
    const save = screen.getByRole("button", { name: /Save Changes/ });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(updateAutomation).toHaveBeenCalledTimes(1));
    const patch = updateAutomation.mock.calls[0][1];
    expect(patch.name).toBe("failures → slack v2");
    expect(patch.action_config).toBeUndefined();
  });

  it("sends the token only when the user types a replacement", async () => {
    updateAutomation.mockResolvedValue(makeAutomation());
    render(
      <EditAutomationDialog
        automation={makeAutomation()}
        open
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onError={() => {}}
      />,
    );

    fireEvent.change(
      screen.getByLabelText("GitHub token (optional replacement)"),
      { target: { value: "ghp_new" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    await waitFor(() => expect(updateAutomation).toHaveBeenCalledTimes(1));
    expect(updateAutomation.mock.calls[0][1].github_token).toBe("ghp_new");
  });
});
