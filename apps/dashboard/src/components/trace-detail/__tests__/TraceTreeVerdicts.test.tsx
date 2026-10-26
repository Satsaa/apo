import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TraceObservation } from "../contexts";

const getCallDetail = vi.fn();

vi.mock("@/lib/traces-api", () => ({
  getCallDetail: (...args: unknown[]) => getCallDetail(...args),
}));

vi.mock("../contexts/TraceDataContext", () => ({
  useTraceData: () => ({
    run: { run: { id: "trace-1", project: "proj" } },
    cumulativeMetrics: new Map(),
    prefetchObservation: () => {},
    isSimplifiedTree: false,
  }),
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

vi.mock("../contexts/SelectionContext", () => ({
  useSelection: () => ({ selectCall: () => {}, selectedCallId: null }),
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

function span(id: string, name: string, parent: string | null, at: number): TraceObservation {
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
  } as TraceObservation;
}

// The shape the SDK emits since #344: one check:<id> span per check under
// checks.run, its judge nested inside.
const calls = [
  span("run", "apo.task.run", null, 0),
  span("turn", "task.turn", "run", 1),
  span("cr", "checks.run", "run", 2),
  span("c1", "check:reply never mentions the note", "cr", 3),
  span("c2", "check:ticket describes the problem", "cr", 4),
  span("j2", "judge:ticket describes the problem", "c2", 5),
  span("c3", "check:judge never answered", "cr", 6),
  span("j3", "judge:judge never answered", "c3", 7),
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

function checkOutput(pass: boolean) {
  return { messages: [{ role: "assistant", content: JSON.stringify({ pass, reasoning: "r" }) }] };
}

/** The badge in the row whose label is `label`. */
function badgeOf(label: string): HTMLElement {
  const name = screen.getByText(label);
  const badge = name.parentElement!.querySelector("[data-verdict]");
  if (!badge) throw new Error(`no verdict badge next to "${label}"`);
  return badge as HTMLElement;
}

describe("TraceTree verdict rows", () => {
  beforeEach(() => {
    getCallDetail.mockReset();
  });

  it("badges every check from the checks.run summary and each judge from its own span", async () => {
    getCallDetail.mockImplementation(async (_trace: string, id: string) => {
      if (id === "cr") return { tool_result: summary };
      if (id === "j2") return { tool_result: { reasoning: "vague", pass: false } };
      if (id === "j3") return { tool_result: { reasoning: "x", pass: null } };
      throw new Error(`unexpected fetch of ${id}`);
    });
    render(<TraceTree calls={calls} />);

    const group = await screen.findByRole("button", { name: /Evaluation/ });
    await waitFor(() => expect(group).toHaveTextContent("1 pass"));
    expect(group).toHaveTextContent("1 fail");
    expect(group).toHaveTextContent("1 no-verdict");
    await userEvent.click(group);

    expect(badgeOf("reply never mentions the note")).toHaveAttribute("data-verdict", "pass");
    expect(badgeOf("ticket describes the problem")).toHaveAttribute("data-verdict", "fail");
    expect(badgeOf("judge never answered")).toHaveAttribute("data-verdict", "no-verdict");
    expect(screen.queryByText(/^check:/)).toBeNull();

    // A judge under its own check is labelled by kind and carries its own verdict.
    await waitFor(() => {
      const judges = screen.getAllByText("judge");
      expect(judges.map((j) => j.parentElement!.querySelector("[data-verdict]")!.getAttribute("data-verdict"))).toEqual([
        "fail",
        "no-verdict",
      ]);
    });
    // Checks never cost a fetch of their own while the summary covers them.
    const fetched = getCallDetail.mock.calls.map((c) => c[1]).sort();
    expect(fetched).toEqual(["cr", "j2", "j3"]);
  });

  it("indents a judge under its check like any nested row", async () => {
    getCallDetail.mockImplementation(async (_trace: string, id: string) =>
      id === "cr" ? { tool_result: summary } : { tool_result: { pass: true } },
    );
    render(<TraceTree calls={calls} />);
    await userEvent.click(await screen.findByRole("button", { name: /Evaluation/ }));

    const indentOf = (el: HTMLElement) => {
      const row = el.closest("[data-index]") as HTMLElement;
      // One w-4 spacer per ancestor level, plus the connector column.
      return row.querySelectorAll(".w-4.relative, .relative.w-4").length;
    };
    const check = screen.getByText("ticket describes the problem");
    const [judge] = screen.getAllByText("judge");
    expect(indentOf(judge)).toBe(indentOf(check) + 1);
  });

  it("falls back to each check span's own verdict when the summary is unusable", async () => {
    getCallDetail.mockImplementation(async (_trace: string, id: string) => {
      if (id === "cr") throw new Error("network");
      if (id === "c1") return { tool_result: null, output: checkOutput(true) };
      if (id === "c2") return { tool_result: null, output: checkOutput(false) };
      if (id === "c3") return { tool_result: null, output: checkOutput(false) };
      return { tool_result: { pass: true } };
    });
    render(<TraceTree calls={calls} />);

    const group = await screen.findByRole("button", { name: /Evaluation/ });
    // Counted over the three checks, not the two judges.
    await waitFor(() => expect(group).toHaveTextContent("1 pass"));
    expect(group).toHaveTextContent("2 fail");
    expect(getCallDetail.mock.calls.map((c) => c[1]).sort()).toEqual(["c1", "c2", "c3", "cr"]);

    await userEvent.click(group);
    expect(badgeOf("reply never mentions the note")).toHaveAttribute("data-verdict", "pass");
    expect(badgeOf("ticket describes the problem")).toHaveAttribute("data-verdict", "fail");
  });

  it("keeps the judge rows of a legacy trace without check spans", async () => {
    const legacy = [
      span("run", "apo.task.run", null, 0),
      span("cr", "checks.run", "run", 1),
      span("j1", "judge:reads well", "cr", 2),
    ];
    getCallDetail.mockImplementation(async (_trace: string, id: string) =>
      id === "cr"
        ? { tool_result: { total: 1, passCount: 1, failCount: 0, results: [{ id: "reads well", pass: true }] } }
        : { tool_result: { pass: true } },
    );
    render(<TraceTree calls={legacy} />);
    await userEvent.click(await screen.findByRole("button", { name: /Evaluation/ }));
    await waitFor(() => expect(badgeOf("judge:reads well")).toHaveAttribute("data-verdict", "pass"));
    const row = screen.getByText("judge:reads well").closest("[data-index]") as HTMLElement;
    expect(within(row).getByText("pass")).toBeTruthy();
  });
});
