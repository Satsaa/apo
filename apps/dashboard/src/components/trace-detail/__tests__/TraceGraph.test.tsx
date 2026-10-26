import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LoggedCall } from "../contexts";
import { SelectionContext } from "../contexts/SelectionContext";
import { TraceGraph } from "../TraceGraph";
import { graphLabel } from "../graph/useGraphData";

type Point = { x: number; y: number };
type Handler = (params: { nodes: string[] }) => void;

const graph = vi.hoisted(() => ({
  instances: [] as FakeNetworkShape[],
  // The scale vis-network's fit lands on: a big trace in a narrow panel.
  fitScale: 0.08,
  positions: {} as Record<string, Point>,
}));

interface FakeNetworkShape {
  fit: Mock<() => void>;
  moveTo: Mock<(options: { position?: Point; scale?: number }) => void>;
  selectNodes: Mock<(ids: string[]) => void>;
  emit: (event: string, params?: { nodes: string[] }) => void;
}

vi.mock("vis-network/standalone", () => {
  class FakeNetwork {
    private handlers = new Map<string, Handler[]>();
    private scale = 1;
    private position: Point = { x: 0, y: 0 };
    fit = vi.fn(() => {
      this.scale = graph.fitScale;
      this.position = { x: 0, y: 0 };
    });
    moveTo = vi.fn((options: { position?: Point; scale?: number }) => {
      if (options.scale !== undefined) this.scale = options.scale;
      if (options.position) this.position = options.position;
    });
    selectNodes = vi.fn((_ids: string[]) => {});
    unselectAll = vi.fn();
    destroy = vi.fn();

    constructor() {
      graph.instances.push(this);
    }

    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }

    emit(event: string, params: { nodes: string[] } = { nodes: [] }) {
      for (const handler of this.handlers.get(event) ?? []) handler(params);
    }

    getScale() {
      return this.scale;
    }

    getViewPosition() {
      return this.position;
    }

    getPosition(id: string) {
      return graph.positions[id];
    }

    // A 400x500 viewport centred on the view position.
    canvasToDOM(point: Point) {
      return {
        x: (point.x - this.position.x) * this.scale + 200,
        y: (point.y - this.position.y) * this.scale + 250,
      };
    }
  }
  return { Network: FakeNetwork };
});

function call(id: string, parent: string | null): LoggedCall {
  return {
    id,
    parent_call_id: parent,
    step_index: null,
    step_name: id,
    model: "",
    created_at: "2026-10-26T09:37:00Z",
    input: null,
    output: null,
    task_id: null,
  };
}

const calls = [call("agent", null), call("near", "agent"), call("far", "agent")];

// Stable like the real providers' callbacks: a new selectCall rebuilds the network.
const noop = () => {};

function Graph({ calls: graphCalls, selectedCallId }: { calls: LoggedCall[]; selectedCallId: string | null }) {
  return (
    <SelectionContext.Provider
      value={{
        selectedRunId: "run",
        projectId: null,
        selectedCallId,
        selectRun: noop,
        selectCall: noop,
        clearSelection: noop,
        view: "graph",
        setView: noop,
        detailTab: "",
        setDetailTab: noop,
      }}
    >
      <TraceGraph calls={graphCalls} />
    </SelectionContext.Provider>
  );
}

function latestNetwork() {
  return graph.instances[graph.instances.length - 1];
}

describe("TraceGraph camera", () => {
  beforeEach(() => {
    graph.instances.length = 0;
    graph.fitScale = 0.08;
    graph.positions = {
      root: { x: 0, y: 0 },
      agent: { x: 0, y: 120 },
      near: { x: 50, y: 240 },
      far: { x: 4000, y: 240 },
    };
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a big trace zoomed in on the selected observation, then keeps the zoom and pans only to an off-screen node", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId="agent" />);
    const network = latestNetwork();
    expect(network.moveTo).toHaveBeenLastCalledWith({
      position: { x: 0, y: 120 },
      scale: 0.6,
      offset: { x: 0, y: 0 },
      animation: false,
    });
    expect(network.selectNodes).toHaveBeenCalledWith(["agent"]);
    network.moveTo.mockClear();

    rerender(<Graph calls={calls} selectedCallId="near" />);
    expect(network.moveTo).not.toHaveBeenCalled();

    rerender(<Graph calls={calls} selectedCallId="far" />);
    expect(network.moveTo).toHaveBeenCalledTimes(1);
    expect(network.moveTo.mock.calls[0][0]).toMatchObject({ position: { x: 4000, y: 240 } });
    expect(network.moveTo.mock.calls[0][0]).not.toHaveProperty("scale");
    expect(network.fit).toHaveBeenCalledTimes(1);
  });

  it("shows the whole graph when it fits at a readable size and keeps the user's view when new spans rebuild it", () => {
    graph.fitScale = 0.9;
    const { rerender } = render(<Graph calls={calls} selectedCallId={null} />);
    const first = latestNetwork();
    expect(first.fit).toHaveBeenCalledTimes(1);
    expect(first.moveTo).not.toHaveBeenCalled();
    act(() => first.moveTo({ position: { x: 900, y: 300 }, scale: 1.2 }));

    rerender(<Graph calls={[...calls, call("late", "agent")]} selectedCallId={null} />);
    const second = latestNetwork();
    expect(second).not.toBe(first);

    expect(second.fit).not.toHaveBeenCalled();
    expect(second.moveTo).toHaveBeenCalledWith({
      position: { x: 900, y: 300 },
      scale: 1.2,
      animation: false,
    });
  });

  it("zooms with the buttons and expands to fill the window until Escape or a node double-click", () => {
    render(<Graph calls={calls} selectedCallId={null} />);
    const network = latestNetwork();
    const container = screen.getByTestId("trace-graph");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(network.moveTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ scale: expect.closeTo(0.75) }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    expect(container).toHaveAttribute("data-expanded", "true");
    expect(container).toHaveClass("fixed");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(container).toHaveAttribute("data-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    act(() => network.emit("doubleClick", { nodes: ["near"] }));
    expect(container).toHaveAttribute("data-expanded", "false");
  });
});

describe("graphLabel", () => {
  it("keeps short names and cuts long ones to one line", () => {
    expect(graphLabel("pi.turn")).toBe("pi.turn");
    const label = graphLabel("check:the reply never mentions the internal ticket");
    expect(label).toHaveLength(32);
    expect(label.endsWith("…")).toBe(true);
  });
});
