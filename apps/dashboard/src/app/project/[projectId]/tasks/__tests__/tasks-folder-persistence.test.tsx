/**
 * Scene tests: the Tasks page remembers which folders the user closed.
 *
 * 1. Folders default to open; closing one persists it under the
 *    project-scoped key, reopening removes the key again.
 * 2. A stored collapsed set keeps those folders closed on the next visit,
 *    and folders absent from it (e.g. newly added) arrive open.
 * 3. Expand all / Collapse all persist too.
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import type { AgentTaskSummary } from "@/lib/agent-task-api";
import type { ProjectTaskSource } from "@/lib/projects-api";

// This vitest jsdom exposes an inert localStorage (no methods at all), so
// the persistence tests run against an in-memory Storage instead.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

beforeAll(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});
afterAll(() => vi.unstubAllGlobals());

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return {
    ...actual,
    createAgentTaskBatchRun: vi.fn(),
    getConnectedExecutorStatus: vi.fn().mockResolvedValue({ state: "ready" }),
  };
});

vi.mock("@/lib/agent-task-view-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-view-api")>(
    "@/lib/agent-task-view-api",
  );
  return {
    ...actual,
    fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
    fetchTaskViewStats: vi.fn().mockResolvedValue({}),
    fetchSavedViews: vi.fn().mockResolvedValue([]),
    fetchTaskHostFacets: vi.fn().mockResolvedValue([]),
    createTaskViewComparison: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "acme-evals" }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme-evals",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const STORAGE_KEY = "apo:collapsed-task-folders:acme-evals";

function task(overrides: Partial<AgentTaskSummary> = {}): AgentTaskSummary {
  return {
    id: "support/refund",
    task_path: "tasks/support/refund",
    folder_path: "support",
    display_name: "refund",
    adapter_name: "claude-code",
    has_checks: false,
    tags: [],
    run_stats: null,
    ...overrides,
  };
}

const tasks = [
  task({ id: "support/refund" }),
  task({ id: "billing/invoice", folder_path: "billing", display_name: "invoice" }),
];

const taskSource: ProjectTaskSource = {
  project: "acme-evals",
  source_type: "published",
  display_name: "Published catalog",
  repository_url: null,
  git_ref: null,
  subpath: null,
  filesystem_path: null,
  demo_seed_id: null,
  status: "ready",
  last_synced_at: null,
  last_resolved_commit_sha: null,
  last_error: null,
  inventory_stale: false,
};

function renderTasks() {
  return render(
    <AgentTasksClient tasks={tasks} error={null} taskSource={taskSource} isDemo={false} />,
  );
}

const isShown = (taskName: string) =>
  screen.queryByRole("checkbox", { name: `Select ${taskName}` }) !== null;

function storedFolders(): string[] | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === null ? null : JSON.parse(stored);
}

describe("Tasks page — remembered folder state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists a closed folder and forgets it when reopened", async () => {
    const user = userEvent.setup();
    renderTasks();
    expect(isShown("invoice")).toBe(true);

    await user.click(screen.getByRole("button", { name: /^billing/ }));
    expect(isShown("invoice")).toBe(false);
    await waitFor(() =>
      expect(storedFolders()).toEqual(["billing"]),
    );

    await user.click(screen.getByRole("button", { name: /^billing/ }));
    expect(isShown("invoice")).toBe(true);
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
  });

  it("keeps stored folders closed on the next visit; others arrive open", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["billing"]));
    renderTasks();

    await waitFor(() => expect(isShown("invoice")).toBe(false));
    expect(isShown("refund")).toBe(true);
  });

  it("persists Collapse all and Expand all", async () => {
    const user = userEvent.setup();
    renderTasks();

    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    await waitFor(() =>
      expect(new Set(storedFolders() ?? [])).toEqual(
        new Set(["billing", "support"]),
      ),
    );
    expect(isShown("refund")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(isShown("refund")).toBe(true);
  });

  it("changes only folders visible through search", async () => {
    const user = userEvent.setup();
    renderTasks();

    await user.type(screen.getByRole("textbox", { name: "Search" }), "invoice");
    await user.click(screen.getByRole("button", { name: "Collapse all" }));

    await waitFor(() => expect(storedFolders()).toEqual(["billing"]));
    await user.clear(screen.getByRole("textbox", { name: "Search" }));
    expect(isShown("invoice")).toBe(false);
    expect(isShown("refund")).toBe(true);
  });
});
