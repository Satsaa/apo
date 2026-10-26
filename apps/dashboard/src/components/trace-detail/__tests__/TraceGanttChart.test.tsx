import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { TraceGanttChart } from "../TraceGanttChart";
import { SelectionProvider } from "../contexts/SelectionContext";
import { TraceDataProvider, type LoggedCall, type TraceDetail } from "../contexts/TraceDataContext";
import { ViewPreferencesProvider } from "../contexts/ViewPreferencesContext";

const T0 = Date.parse("2026-10-26T09:35:00Z");

function call(id: string, parent: string | null, startS: number, durS: number): LoggedCall {
  return {
    id,
    step_index: null,
    step_name: id,
    model: "",
    created_at: new Date(T0 + startS * 1000).toISOString(),
    latency_ms: durS * 1000,
    input: null,
    output: null,
    task_id: null,
    parent_call_id: parent,
    call_type: "SPAN",
  };
}

const calls = [
  call("apo.task.run", null, 0, 137),
  call("task.turn", "apo.task.run", 12, 80),
  call("pi.turn", "task.turn", 13, 75),
];

function renderGantt() {
  const run: TraceDetail = {
    run: { id: "t1", project: "p", scopeKey: null, created_at: new Date(T0).toISOString(), call_count: calls.length },
    metrics: [],
    calls,
  };
  return render(
    <ViewPreferencesProvider>
      <SelectionProvider>
        <TraceDataProvider run={run} isLoading={false} error={null}>
          <TraceGanttChart calls={calls} />
        </TraceDataProvider>
      </SelectionProvider>
    </ViewPreferencesProvider>,
  );
}

beforeEach(() => {
  // jsdom has no layout; report an element height so the virtualizer renders rows.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TraceGanttChart scrolling", () => {
  it("never sets scrollLeft when any part of the chart scrolls", () => {
    const { container } = renderGantt();
    expect(screen.getAllByRole("button", { name: "Select trace node" }).length).toBeGreaterThan(1);
    const scrollLeftSet = vi.spyOn(Element.prototype, "scrollLeft", "set");

    for (const el of container.querySelectorAll("*")) {
      fireEvent.scroll(el);
    }

    expect(scrollLeftSet).not.toHaveBeenCalled();
  });

  it("pins the time scale inside the scroller that holds the rows", () => {
    renderGantt();

    const scroller = screen.getByTestId("trace-gantt-scroller");
    const scale = screen.getByTestId("trace-gantt-scale");
    expect(scale).toHaveClass("sticky", "top-0");
    expect(scale).toContainElement(screen.getByText("0ms"));
    expect(scroller).toContainElement(scale);
    expect(scroller).toContainElement(screen.getAllByRole("button", { name: "Select trace node" })[0]!);
  });
});
