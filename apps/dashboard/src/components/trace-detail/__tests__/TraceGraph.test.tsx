import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LoggedCall } from "../contexts";
import { SelectionContext } from "../contexts/SelectionContext";
import { TraceGraph } from "../TraceGraph";
import { graphLabel } from "../graph/useGraphData";

type Point = { x: number; y: number };
type MoveOptions = { position?: Point; scale?: number; offset?: Point; animation?: unknown };
type Handler = (params: never) => void;

const graph = vi.hoisted(() => ({
  instances: [] as FakeNetworkShape[],
  // The scale vis-network's fit lands on: a big trace in a narrow panel.
  fitScale: 0.08,
  positions: {} as Record<string, Point>,
  viewport: { width: 400, height: 500 },
  // Options of every fit/moveTo the component made, on any network.
  moves: [] as unknown[],
}));

interface FakeNetworkShape {
  fit: Mock<(options?: unknown) => void>;
  moveTo: Mock<(options: MoveOptions) => void>;
  selectNodes: Mock<(ids: string[]) => void>;
  unselectAll: Mock<() => void>;
  emit: (event: string, params?: unknown) => void;
  setView: (centre: Point, scale: number) => void;
}

// A camera over the layout in graph.positions when the network was built: the
// view centre sits at the middle of graph.viewport, as in vis-network.
vi.mock("vis-network/standalone", () => {
  class FakeNetwork {
    private handlers = new Map<string, Handler[]>();
    private ids: string[];
    private layout: Record<string, Point>;
    private scale = 1;
    private centre: Point = { x: 0, y: 0 };
    fit = vi.fn((options?: unknown) => {
      graph.moves.push(options);
      this.setView({ x: 0, y: 0 }, graph.fitScale);
    });
    moveTo = vi.fn((options: MoveOptions) => {
      graph.moves.push(options);
      if (options.scale !== undefined) this.scale = options.scale;
      if (options.position) {
        const offset = options.offset ?? { x: 0, y: 0 };
        this.centre = {
          x: options.position.x - offset.x / this.scale,
          y: options.position.y - offset.y / this.scale,
        };
      }
    });
    selectNodes = vi.fn((_ids: string[]) => {});
    unselectAll = vi.fn(() => {});
    destroy = vi.fn();

    constructor(_container: HTMLElement, data: { nodes: { getIds(): string[] } }) {
      this.ids = data.nodes.getIds();
      this.layout = Object.fromEntries(this.ids.map((id) => [id, { ...graph.positions[id] }]));
      graph.instances.push(this);
    }

    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }

    emit(event: string, params: unknown = { nodes: [] }) {
      for (const handler of this.handlers.get(event) ?? []) handler(params as never);
    }

    // What a user's wheel zoom or drag does, without going through moveTo.
    setView(centre: Point, scale: number) {
      this.centre = centre;
      this.scale = scale;
    }

    getScale() {
      return this.scale;
    }

    getViewPosition() {
      return this.centre;
    }

    // vis-network throws for an id that is not in the graph.
    getPosition(id: string) {
      if (!this.ids.includes(id)) throw new ReferenceError(`No node with id "${id}"`);
      return this.layout[id];
    }

    getPositions() {
      return this.layout;
    }

    getBoundingBox(id: string) {
      const { x, y } = this.getPosition(id);
      return { left: x - 50, right: x + 50, top: y - 20, bottom: y + 20 };
    }

    DOMtoCanvas(point: Point) {
      return {
        x: this.centre.x + (point.x - graph.viewport.width / 2) / this.scale,
        y: this.centre.y + (point.y - graph.viewport.height / 2) / this.scale,
      };
    }

    canvasToDOM(point: Point) {
      return {
        x: (point.x - this.centre.x) * this.scale + graph.viewport.width / 2,
        y: (point.y - this.centre.y) * this.scale + graph.viewport.height / 2,
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
const selectCall = vi.fn();

function Graph({ calls: graphCalls, selectedCallId }: { calls: LoggedCall[]; selectedCallId: string | null }) {
  return (
    <SelectionContext.Provider
      value={{
        selectedRunId: "run",
        projectId: null,
        selectedCallId,
        selectRun: noop,
        selectCall,
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
    graph.moves.length = 0;
    graph.fitScale = 0.08;
    graph.viewport = { width: 400, height: 500 };
    graph.positions = {
      root: { x: 0, y: 0 },
      agent: { x: 0, y: 120 },
      near: { x: 50, y: 240 },
      far: { x: 4000, y: 240 },
      late: { x: 4000, y: 320 },
    };
    selectCall.mockClear();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => graph.viewport.width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => graph.viewport.height);
  });

  afterEach(() => {
    // An animated move started before the previous one drew a frame leaves
    // vis-network's view stuck, so every move must be instant.
    for (const options of graph.moves) expect(options).toMatchObject({ animation: false });
    vi.restoreAllMocks();
  });

  it("opens a big trace zoomed in on the selected observation, then pans only to an off-screen node", () => {
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
    expect(network.selectNodes).toHaveBeenLastCalledWith(["near"]);
    expect(network.moveTo).not.toHaveBeenCalled();

    rerender(<Graph calls={calls} selectedCallId="far" />);
    expect(network.moveTo).toHaveBeenCalledTimes(1);
    expect(network.moveTo).toHaveBeenCalledWith({ position: { x: 4000, y: 240 }, animation: false });
    expect(network.fit).toHaveBeenCalledTimes(1);
  });

  it("opens on the root at the left edge when the selected observation is not in the graph", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId="elsewhere" />);
    const network = latestNetwork();
    expect(network.moveTo).toHaveBeenLastCalledWith({
      position: { x: 0, y: 0 },
      scale: 0.6,
      offset: { x: 80 - 200, y: 0 },
      animation: false,
    });
    expect(network.selectNodes).not.toHaveBeenCalled();

    rerender(<Graph calls={calls} selectedCallId={null} />);
    expect(network.unselectAll).toHaveBeenCalledTimes(1);
  });

  it("shows the whole graph when it fits at a readable size", () => {
    graph.fitScale = 0.9;
    render(<Graph calls={calls} selectedCallId={null} />);
    expect(latestNetwork().fit).toHaveBeenCalledTimes(1);
    expect(latestNetwork().moveTo).not.toHaveBeenCalled();
  });

  it("keeps the node in view where it was when new spans rebuild a re-centred layout, without panning back to the selection", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId="near" />);
    const first = latestNetwork();
    // The user pans away from the selection to "far", 60px right of centre.
    act(() => first.setView({ x: 3900, y: 240 }, 0.6));

    // vis-network re-centres every rebuilt layout, so all nodes shift.
    for (const position of Object.values(graph.positions)) position.x += 210;
    rerender(<Graph calls={[...calls, call("late", "agent")]} selectedCallId="near" />);
    const second = latestNetwork();
    expect(second).not.toBe(first);

    expect(second.fit).not.toHaveBeenCalled();
    expect(second.moveTo).toHaveBeenCalledTimes(1);
    expect(second.moveTo).toHaveBeenCalledWith({ position: { x: 4110, y: 240 }, scale: 0.6, animation: false });
    expect(second.selectNodes).toHaveBeenCalledWith(["near"]);
  });

  it("keeps the zoom, the top-left corner and a selected node in view when the panel narrows", async () => {
    render(<Graph calls={calls} selectedCallId="near" />);
    const network = latestNetwork();
    // "near" sits near the right edge of the 400px panel.
    act(() => network.setView({ x: -200, y: 240 }, 0.6));
    network.moveTo.mockClear();

    // vis-network emits "resize", then applies the new size keeping the
    // centre and scaling the view with it.
    await act(async () => {
      network.emit("resize", { oldWidth: 400, oldHeight: 500 });
      graph.viewport = { width: 200, height: 500 };
      network.setView({ x: -200, y: 240 }, 0.3);
    });

    // The old top-left corner, (-200 - 200 / 0.6, 240 - 250 / 0.6), stays put.
    expect(network.moveTo.mock.calls).toEqual([
      [{ position: { x: expect.closeTo(-366.67), y: expect.closeTo(240) }, scale: 0.6, animation: false }],
      [{ position: { x: 50, y: 240 }, animation: false }],
    ]);
  });

  it("selects clicked nodes, zooms and fits with the buttons, and expands until Escape or a node double-click", () => {
    render(<Graph calls={calls} selectedCallId={null} />);
    const network = latestNetwork();
    const container = screen.getByTestId("trace-graph");

    act(() => network.emit("click", { nodes: ["near"] }));
    expect(selectCall).toHaveBeenLastCalledWith("near");
    act(() => network.emit("click", { nodes: ["root"] }));
    expect(selectCall).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(network.moveTo).toHaveBeenLastCalledWith({ scale: expect.closeTo(0.75), animation: false });
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(network.moveTo).toHaveBeenLastCalledWith({ scale: expect.closeTo(0.6), animation: false });
    fireEvent.click(screen.getByRole("button", { name: "Fit whole graph" }));
    expect(network.fit).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    expect(container).toHaveAttribute("data-expanded", "true");
    expect(container).toHaveClass("fixed");
    expect(screen.getByRole("dialog", { name: "Trace graph" })).toBe(container);

    // The traces-list panel closes on Escape from a window listener.
    const panelEscape = vi.fn();
    window.addEventListener("keydown", panelEscape);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", panelEscape);
    expect(container).toHaveAttribute("data-expanded", "false");
    expect(panelEscape).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    act(() => network.emit("doubleClick", { nodes: [] }));
    expect(container).toHaveAttribute("data-expanded", "true");
    act(() => network.emit("doubleClick", { nodes: ["near"] }));
    expect(container).toHaveAttribute("data-expanded", "false");
  });
});

describe("graphLabel", () => {
  it("keeps short names and cuts long ones to one line without splitting a character", () => {
    expect(graphLabel("pi.turn")).toBe("pi.turn");
    const label = graphLabel("check:the reply never mentions the internal ticket");
    expect(label).toHaveLength(32);
    expect(label.endsWith("…")).toBe(true);
    expect(graphLabel(`${"a".repeat(30)}😀😀😀`)).toBe(`${"a".repeat(30)}😀…`);
  });
});
