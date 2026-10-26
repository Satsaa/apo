import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TraceObservation } from "../contexts";
import { SelectionProvider, useSelection } from "../contexts/SelectionContext";

const getCallDetail = vi.fn();

vi.mock("@/lib/traces-api", () => ({
  getCallDetail: (...args: unknown[]) => getCallDetail(...args),
}));

// One object per render pass, like the real provider: a live stream flush
// replaces `run`, which a test simulates by swapping it.
const traceData = vi.hoisted(() => ({
  run: { run: { id: "trace-1", project: "proj" } } as unknown,
  cumulativeMetrics: new Map(),
  prefetchObservation: () => {},
  isSimplifiedTree: false,
}));

vi.mock("../contexts/TraceDataContext", () => ({
  useTraceData: () => traceData,
}));

vi.mock("../contexts/ViewPreferencesContext", () => ({
  useViewPreferences: () => ({
    preferences: {
      showDuration: true,
      showCostTokens: true,
      showScores: false,
      showComments: true,
      colorCodeMetrics: false,
      minObservationLevel: "DEFAULT",
    },
  }),
}));

// jsdom has no layout, so the real virtualizer renders no rows: render them all.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 37 })),
    getTotalSize: () => count * 37,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

import { TraceTree } from "../TraceTree";

function span(
  id: string,
  name: string,
  parent: string | null,
  at: number,
  extra: Partial<TraceObservation> = {},
): TraceObservation {
  return {
    id,
    step_name: name,
    parent_call_id: parent,
    step_index: null,
    created_at: new Date(Date.UTC(2026, 9, 26, 9, 0, at)).toISOString(),
    latency_ms: 100,
    model: "unknown",
    input: null,
    output: null,
    task_id: null,
    observation_type: name.startsWith("judge:") ? "GENERATION" : "SPAN",
    ...extra,
  } as TraceObservation;
}

// The shape the SDK emits since #344: one check:<id> span per check under
// checks.run, its judge nested inside. j3's judge call threw, which the SDK
// records as an ERROR span with no verdict.
const calls = [
  span("run", "apo.task.run", null, 0),
  span("turn", "task.turn", "run", 1),
  span("cr", "checks.run", "run", 2),
  span("c1", "check:reply never mentions the note", "cr", 3),
  span("c2", "check:ticket describes the problem", "cr", 4),
  span("j2", "judge:ticket describes the problem", "c2", 5),
  span("c3", "check:judge never answered", "cr", 6),
  span("j3", "judge:judge never answered", "c3", 7, { level: "ERROR" }),
];

const summary = {
  total: 3,
  passCount: 1,
  failCount: 1,
  noVerdictCount: 1,
  results: [
    { id: "reply never mentions the note", pass: true },
    { id: "ticket describes the problem", pass: false },
    { id: "judge never answered", pass: false, outcome: "error" },
  ],
};

/** A check span's full call as the SDK writes it: the summary as assistant output. */
function checkSpan(body: Record<string, unknown>) {
  return { tool_result: null, output: { messages: [{ role: "assistant", content: JSON.stringify(body) }] } };
}

function detailFor(overrides: Record<string, unknown> = {}) {
  const details: Record<string, unknown> = {
    cr: { tool_result: summary },
    j2: { tool_result: { reasoning: "vague", pass: false } },
    j3: { tool_result: null, level: "ERROR" },
    ...overrides,
  };
  return async (_trace: string, id: string) => {
    const detail = details[id];
    if (detail instanceof Error) throw detail;
    if (detail === undefined) throw new Error(`unexpected fetch of ${id}`);
    return detail;
  };
}

function SelectedId() {
  const { selectedCallId } = useSelection();
  return <output data-testid="selected">{selectedCallId ?? ""}</output>;
}

function renderTree(treeCalls: TraceObservation[] = calls, searchQuery = "") {
  return render(
    <SelectionProvider>
      <TraceTree calls={treeCalls} searchQuery={searchQuery} />
      <SelectedId />
    </SelectionProvider>,
  );
}

async function expandEvaluation() {
  const group = await screen.findByRole("button", { name: /Evaluation/ });
  await userEvent.click(group);
  return group;
}

/** The name element of the row labelled `label`. */
function nameOf(label: string, index = 0): HTMLElement {
  return screen.getAllByText(label)[index]!;
}

/** The badge in the row labelled `label`. */
function badgeOf(label: string, index = 0): HTMLElement {
  const badge = nameOf(label, index).parentElement!.querySelector("[data-verdict]");
  if (!badge) throw new Error(`no verdict badge next to "${label}"`);
  return badge as HTMLElement;
}

/** What the badge shows on screen (screen-reader-only text excluded). */
function visibleText(badge: HTMLElement): string {
  const copy = badge.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".sr-only").forEach((el) => el.remove());
  return copy.textContent ?? "";
}

describe("TraceTree verdict rows", () => {
  beforeEach(() => {
    getCallDetail.mockReset();
    traceData.run = { run: { id: "trace-1", project: "proj" } };
  });

  it("badges every check from the checks.run summary and each judge from its own span", async () => {
    getCallDetail.mockImplementation(detailFor());
    renderTree();

    const group = await screen.findByRole("button", { name: /Evaluation/ });
    await waitFor(() => expect(group).toHaveTextContent("1 pass"));
    expect(group).toHaveTextContent("1 fail");
    expect(group).toHaveTextContent("1 no-verdict");
    await expandEvaluation();

    expect(badgeOf("reply never mentions the note")).toHaveAttribute("data-verdict", "pass");
    expect(badgeOf("ticket describes the problem")).toHaveAttribute("data-verdict", "fail");
    expect(badgeOf("judge never answered")).toHaveAttribute("data-verdict", "no-verdict");
    expect(screen.queryByText(/^check:/)).toBeNull();

    // A judge under its own check is labelled by kind and carries its own verdict.
    await waitFor(() => expect(badgeOf("judge", 0)).toHaveAttribute("data-verdict", "fail"));
    expect(badgeOf("judge", 1)).toHaveAttribute("data-verdict", "no-verdict");
    // Checks never cost a fetch of their own while the summary covers them.
    expect(getCallDetail.mock.calls.map((c) => c[1]).sort()).toEqual(["cr", "j2", "j3"]);
  });

  it("shows the verdict as text and colours a failed row's name", async () => {
    getCallDetail.mockImplementation(detailFor({ j2: new Error("network") }));
    renderTree();
    await expandEvaluation();

    expect(visibleText(badgeOf("reply never mentions the note"))).toBe("pass");
    expect(badgeOf("reply never mentions the note")).toHaveClass("text-success");
    expect(badgeOf("ticket describes the problem")).toHaveClass("text-destructive");
    expect(badgeOf("judge never answered")).toHaveClass("text-warning");
    expect(visibleText(badgeOf("ticket describes the problem"))).toBe("fail");
    expect(visibleText(badgeOf("judge never answered"))).toBe("no verdict");
    expect(badgeOf("judge never answered")).toHaveAttribute("title", expect.stringMatching(/without a verdict/));
    await waitFor(() => expect(badgeOf("judge", 0)).toHaveAttribute("data-verdict", "unknown"));
    expect(visibleText(badgeOf("judge", 0))).toBe("—");
    expect(badgeOf("judge", 0)).toHaveTextContent("verdict unknown");

    expect(nameOf("ticket describes the problem")).toHaveClass("text-destructive");
    expect(nameOf("reply never mentions the note")).not.toHaveClass("text-destructive");

    // A row is announced by its short verdict, then its name (jsdom joins
    // inline text without a space).
    expect(screen.getByRole("button", { name: /^no verdict ?judge never answered/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^fail ?ticket describes the problem/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^verdict unknown ?judge/ })).toHaveLength(1);
  });

  it("indents a judge under its check and collapses it with the check's chevron", async () => {
    getCallDetail.mockImplementation(detailFor());
    renderTree();
    await expandEvaluation();

    const indentOf = (el: HTMLElement) => {
      const row = el.closest("[data-index]") as HTMLElement;
      // One w-4 spacer per ancestor level, plus the connector column.
      return row.querySelectorAll(".relative.w-4").length;
    };
    expect(indentOf(nameOf("judge"))).toBe(indentOf(nameOf("ticket describes the problem")) + 1);

    const checkRow = nameOf("ticket describes the problem").closest("[data-index]") as HTMLElement;
    const chevron = checkRow.querySelector("[data-expand-button]") as HTMLElement;
    expect(screen.getAllByText("judge")).toHaveLength(2);
    await userEvent.click(chevron);
    expect(screen.getAllByText("judge")).toHaveLength(1);
  });

  it("falls back to each check span's own verdict when the summary is unusable", async () => {
    getCallDetail.mockImplementation(
      detailFor({
        cr: new Error("network"),
        c1: checkSpan({ pass: true }),
        c2: checkSpan({ pass: false }),
        c3: checkSpan({ pass: false, outcome: "error" }),
      }),
    );
    renderTree();

    const group = await screen.findByRole("button", { name: /Evaluation/ });
    // Counted over the three checks, not the two judges; the verdictless
    // check is not a failure.
    await waitFor(() => expect(group).toHaveTextContent("1 pass"));
    expect(group).toHaveTextContent("1 fail");
    expect(group).toHaveTextContent("1 no-verdict");
    expect(getCallDetail.mock.calls.map((c) => c[1]).sort()).toEqual(["c1", "c2", "c3", "cr"]);

    await userEvent.click(group);
    expect(badgeOf("reply never mentions the note")).toHaveAttribute("data-verdict", "pass");
    expect(badgeOf("ticket describes the problem")).toHaveAttribute("data-verdict", "fail");
    expect(badgeOf("judge never answered")).toHaveAttribute("data-verdict", "no-verdict");
  });

  it("badges and highlights the rows search surfaces while the group is collapsed", async () => {
    getCallDetail.mockImplementation(detailFor());
    renderTree(calls, "describes");

    await waitFor(() => expect(badgeOf("judge")).toHaveAttribute("data-verdict", "fail"));
    // The match splits the label, so find the check's name by its whole text.
    const name = screen.getByText(
      (_, el) => el?.classList.contains("truncate") === true && el.textContent === "ticket describes the problem",
    );
    expect(name.parentElement!.querySelector("[data-verdict]")).toHaveAttribute("data-verdict", "fail");
    expect(name.querySelector("span")).toHaveTextContent(/^describes$/);
  });

  it("keeps an agent span named check:… in the agent's tree", async () => {
    getCallDetail.mockImplementation(detailFor());
    renderTree([...calls, span("lint", "check:lint", "turn", 1.5)]);
    await screen.findByRole("button", { name: /Evaluation/ });

    // Visible while the Evaluation group is still collapsed, under its own name.
    expect(screen.getByText("check:lint").parentElement!.querySelector("[data-verdict]")).toBeNull();
  });

  it("keeps a judge directly under checks.run on its own verdict (traces before per-check spans)", async () => {
    const legacy = [
      span("run", "apo.task.run", null, 0),
      span("cr", "checks.run", "run", 1),
      span("j1", "judge:reads well", "cr", 2),
    ];
    getCallDetail.mockImplementation(
      detailFor({
        // The check failed on a deterministic assertion; its judge passed.
        cr: { tool_result: { total: 1, passCount: 0, failCount: 1, results: [{ id: "reads well", pass: false }] } },
        j1: { tool_result: { pass: true } },
      }),
    );
    renderTree(legacy);
    await expandEvaluation();
    await waitFor(() => expect(badgeOf("judge:reads well")).toHaveAttribute("data-verdict", "pass"));
  });

  it("walks every evaluation row with the arrow keys", async () => {
    getCallDetail.mockImplementation(detailFor());
    renderTree();
    await expandEvaluation();
    await userEvent.click(screen.getByText("task.turn"));

    const visited: string[] = [];
    for (let i = 0; i < 7; i++) {
      fireEvent.keyDown(window, { key: "ArrowDown" });
      visited.push(screen.getByTestId("selected").textContent ?? "");
    }
    // The group row stands for checks.run; every check and judge follows once.
    expect(visited).toEqual(["cr", "c1", "c2", "j2", "c3", "j3", "j3"]);
  });

  it("toggles the group with aria-expanded and auto-expands for a deep-linked judge", async () => {
    getCallDetail.mockImplementation(detailFor());
    function DeepLink({ id }: { id: string }) {
      const { selectCall } = useSelection();
      return (
        <button type="button" onClick={() => selectCall(id)}>
          open {id}
        </button>
      );
    }
    render(
      <SelectionProvider>
        <TraceTree calls={calls} />
        <DeepLink id="j2" />
      </SelectionProvider>,
    );

    const group = await screen.findByRole("button", { name: /Evaluation/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("judge")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "open j2" }));
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("judge")).toHaveLength(2);
  });

  it("highlights the group row when keyboard nav selects it", async () => {
    getCallDetail.mockImplementation(detailFor());
    renderTree();
    const group = await screen.findByRole("button", { name: /Evaluation/ });
    await userEvent.click(screen.getByText("task.turn"));
    expect(group).not.toHaveClass("bg-muted/30");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByTestId("selected")).toHaveTextContent("cr");
    expect(group).toHaveClass("bg-muted/30");
  });

  it("walks past the Evaluation row of a trace without checks.run in both directions", async () => {
    const legacy = [
      span("run", "apo.task.run", null, 0),
      span("turn", "task.turn", "run", 1),
      span("j1", "judge:reads well", "run", 2),
      span("j2", "judge:is short", "run", 3),
    ];
    getCallDetail.mockImplementation(async () => ({ tool_result: { pass: true } }));
    renderTree(legacy);
    await expandEvaluation();
    await userEvent.click(screen.getByText("task.turn"));

    const press = (key: string) => {
      fireEvent.keyDown(window, { key });
      return screen.getByTestId("selected").textContent ?? "";
    };
    // The group row carries j1, so j1 is selected once for it and its own row.
    expect([press("ArrowDown"), press("ArrowDown"), press("ArrowDown")]).toEqual(["j1", "j2", "j2"]);
    expect([press("ArrowUp"), press("ArrowUp")]).toEqual(["j1", "turn"]);
  });

  it("reaches a legacy judge that renders first in the group but comes later in the calls", async () => {
    // jA is first in call order, but j1 sits under task.turn, which renders before it.
    const legacy = [
      span("run", "apo.task.run", null, 0),
      span("turn", "task.turn", "run", 1),
      span("jA", "judge:a", "run", 3),
      span("j1", "judge:nested", "turn", 2),
      span("p1", "adapter.cleanup", "run", 4),
    ];
    getCallDetail.mockImplementation(async () => ({ tool_result: { pass: true } }));
    renderTree(legacy);
    await expandEvaluation();
    await userEvent.click(screen.getByText("apo.task.run"));

    const press = (key: string) => {
      fireEvent.keyDown(window, { key });
      return screen.getByTestId("selected").textContent ?? "";
    };
    const down = Array.from({ length: 5 }, () => press("ArrowDown"));
    expect(down).toContain("j1");
    expect(down).toContain("jA");
  });

  it("refetches verdicts a live stream flush aborted instead of caching them as unknown", async () => {
    const details = detailFor();
    const inFlight: Array<{ id: string; settle: () => void }> = [];
    getCallDetail.mockImplementation(
      (trace: string, id: string, _project: string, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          inFlight.push({ id, settle: () => void details(trace, id).then(resolve, reject) });
        }),
    );
    const { rerender } = renderTree();
    await expandEvaluation();
    await waitFor(() => expect(inFlight.map((f) => f.id).sort()).toEqual(["cr", "j2", "j3"]));

    // A flush: a new run object and fresh call objects abort every fetch in flight.
    traceData.run = { run: { id: "trace-1", project: "proj" } };
    rerender(
      <SelectionProvider>
        <TraceTree calls={calls.map((c) => ({ ...c }))} />
        <SelectedId />
      </SelectionProvider>,
    );
    // Let the aborted fetches unwind before the new ones answer: an aborted
    // fetch that still wrote its (empty) result would cache it and stop the
    // refetch.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(inFlight.map((f) => f.id).sort()).toEqual(["cr", "cr", "j2", "j2", "j3", "j3"]);
    for (const fetch of inFlight.splice(0)) fetch.settle();

    const group = screen.getByRole("button", { name: /Evaluation/ });
    await waitFor(() => expect(group).toHaveTextContent("1 no-verdict"));
    await waitFor(() => expect(badgeOf("judge", 0)).toHaveAttribute("data-verdict", "fail"));
    expect(badgeOf("judge", 1)).toHaveAttribute("data-verdict", "no-verdict");
    // The summary answered for every check: none was fetched on its own.
    expect(getCallDetail.mock.calls.map((c) => c[1])).not.toContain("c2");
  });
});
