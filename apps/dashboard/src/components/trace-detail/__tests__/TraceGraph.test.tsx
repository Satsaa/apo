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
  options: { interaction: { keyboard: unknown } };
  fit: Mock<(options?: unknown) => void>;
  moveTo: Mock<(options: MoveOptions) => void>;
  selectNodes: Mock<(ids: string[]) => void>;
  unselectAll: Mock<() => void>;
  emit: (event: string, params?: unknown) => void;
  setView: (centre: Point, scale: number) => void;
}

// vis-network's camera: screen = canvas * scale + translation, with the view
// centre at the middle of graph.viewport (the canvas size). Each network keeps
// the layout graph.positions had when it was built.
vi.mock("vis-network/standalone", () => {
  class FakeNetwork {
    private handlers = new Map<string, Handler[]>();
    private ids: string[];
    private layout: Record<string, Point>;
    private scale = 1;
    private translation: Point = { x: 0, y: 0 };
    options: FakeNetworkShape["options"];
    fit = vi.fn((options?: unknown) => {
      graph.moves.push(options);
      this.setView({ x: 0, y: 0 }, graph.fitScale);
    });
    moveTo = vi.fn((options: MoveOptions) => {
      graph.moves.push(options);
      const centre = options.position ?? this.getViewPosition();
      if (options.scale !== undefined) this.scale = options.scale;
      const offset = options.offset ?? { x: 0, y: 0 };
      this.translation = {
        x: graph.viewport.width / 2 + offset.x - centre.x * this.scale,
        y: graph.viewport.height / 2 + offset.y - centre.y * this.scale,
      };
    });
    selectNodes = vi.fn((_ids: string[]) => {});
    unselectAll = vi.fn(() => {});
    destroy = vi.fn();

    constructor(
      _container: HTMLElement,
      data: { nodes: { getIds(): string[] } },
      options: FakeNetworkShape["options"],
    ) {
      this.ids = data.nodes.getIds();
      this.layout = Object.fromEntries(this.ids.map((id) => [id, { ...graph.positions[id] }]));
      this.options = options;
      graph.instances.push(this);
    }

    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }

    emit(event: string, params: unknown = { nodes: [] }) {
      for (const handler of this.handlers.get(event) ?? []) handler(params as never);
    }

    // What a wheel zoom, a drag or vis's own resize handling does to the camera.
    setView(centre: Point, scale: number) {
      this.scale = scale;
      this.translation = {
        x: graph.viewport.width / 2 - centre.x * scale,
        y: graph.viewport.height / 2 - centre.y * scale,
      };
    }

    getScale() {
      return this.scale;
    }

    getViewPosition() {
      return this.DOMtoCanvas({ x: graph.viewport.width / 2, y: graph.viewport.height / 2 });
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
        x: (point.x - this.translation.x) / this.scale,
        y: (point.y - this.translation.y) / this.scale,
      };
    }

    canvasToDOM(point: Point) {
      return {
        x: point.x * this.scale + this.translation.x,
        y: point.y * this.scale + this.translation.y,
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

const calls = [
  call("agent", null),
  call("near", "agent"),
  call("edge", "agent"),
  call("far", "agent"),
  call("corner", "agent"),
];

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

// vis-network sizes the canvas, emits "resize", then moves its camera to keep
// the old centre at a scale that follows the size.
async function resizeTo(network: FakeNetworkShape, width: number) {
  const old = graph.viewport;
  const centre = { x: 0, y: 0 };
  await act(async () => {
    Object.assign(centre, (network as unknown as { getViewPosition(): Point }).getViewPosition());
    graph.viewport = { width, height: old.height };
    network.emit("resize", { oldWidth: old.width, oldHeight: old.height });
    network.setView(centre, 0.3);
  });
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
      // At 0.6 around "agent", its centre is on screen and its box is not.
      edge: { x: 290, y: 240 },
      far: { x: 4000, y: 240 },
      corner: { x: 3600, y: 30 },
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

  it("opens a big trace zoomed in on the selected observation, then pans only to a node not fully on screen", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId="agent" />);
    const network = latestNetwork();
    expect(network.moveTo).toHaveBeenLastCalledWith({
      position: { x: 0, y: 120 },
      scale: 0.6,
      offset: { x: 0, y: 0 },
      animation: false,
    });
    expect(network.selectNodes).toHaveBeenCalledWith(["agent"]);
    // Bound to the window, vis swallows + - [ ] and the arrows in every input.
    expect(network.options.interaction.keyboard).toMatchObject({
      enabled: true,
      bindToWindow: false,
      autoFocus: false,
    });
    network.moveTo.mockClear();

    rerender(<Graph calls={calls} selectedCallId="near" />);
    expect(network.selectNodes).toHaveBeenLastCalledWith(["near"]);
    expect(network.moveTo).not.toHaveBeenCalled();

    rerender(<Graph calls={calls} selectedCallId="edge" />);
    expect(network.moveTo).toHaveBeenCalledTimes(1);
    expect(network.moveTo).toHaveBeenCalledWith({ position: { x: 290, y: 240 }, animation: false });
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

  it("keeps the node nearest the centre in place when new spans rebuild a re-centred layout, without panning back to the selection", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId="near" />);
    const first = latestNetwork();
    // The user pans away from the selection; "far" ends up 60px right of
    // centre and "corner" near the top-left corner.
    act(() => first.setView({ x: 3900, y: 240 }, 0.6));

    // A rebuilt layout moves nodes by different amounts.
    graph.positions.root.x += 30;
    graph.positions.agent.x += 100;
    graph.positions.near.x += 50;
    graph.positions.far.x += 210;
    rerender(<Graph calls={[...calls, call("late", "agent")]} selectedCallId="near" />);
    const second = latestNetwork();
    expect(second).not.toBe(first);

    expect(second.fit).not.toHaveBeenCalled();
    expect(second.moveTo).toHaveBeenCalledTimes(1);
    expect(second.moveTo).toHaveBeenCalledWith({ position: { x: 4110, y: 240 }, scale: 0.6, animation: false });
    expect(second.selectNodes).toHaveBeenCalledWith(["near"]);
  });

  it("pans to a selected observation that arrives with a later span", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId="late" />);
    expect(latestNetwork().selectNodes).not.toHaveBeenCalled();

    rerender(<Graph calls={[...calls, call("late", "agent")]} selectedCallId="late" />);
    const rebuilt = latestNetwork();
    expect(rebuilt.selectNodes).toHaveBeenCalledWith(["late"]);
    expect(rebuilt.moveTo).toHaveBeenLastCalledWith({ position: { x: 4000, y: 320 }, animation: false });
  });

  it("keeps the zoom and the top-left corner on resize, and a selected node in view only if it was", async () => {
    render(<Graph calls={calls} selectedCallId="near" />);
    const network = latestNetwork();
    // "near" is partly cut off at the right edge of the 400px panel, as a
    // double-clicked node in the expanded view can be.
    act(() => network.setView({ x: -300, y: 240 }, 0.6));
    network.moveTo.mockClear();

    await resizeTo(network, 200);
    // The old top-left corner, (-300 - 200 / 0.6, 240 - 250 / 0.6), stays put.
    expect(network.moveTo.mock.calls).toEqual([
      [{ position: { x: expect.closeTo(-466.67), y: expect.closeTo(240) }, scale: 0.6, animation: false }],
      [{ position: { x: 50, y: 240 }, animation: false }],
    ]);
    network.moveTo.mockClear();

    // Still in view after growing: no re-centring.
    await resizeTo(network, 400);
    expect(network.moveTo).toHaveBeenCalledTimes(1);
    network.moveTo.mockClear();

    // Out of view before the resize: not brought back.
    act(() => network.setView({ x: 2000, y: 240 }, 0.6));
    await resizeTo(network, 200);
    expect(network.moveTo).toHaveBeenCalledTimes(1);
    network.moveTo.mockClear();

    // A sliver still in view after the resize stays where it is.
    act(() => network.setView({ x: 250, y: 240 }, 0.6));
    await resizeTo(network, 400);
    expect(network.moveTo).toHaveBeenCalledTimes(1);
  });

  it("does not pan when a live update lands between a click and its selection", () => {
    // The URL points at a call that has not streamed in yet.
    const { rerender } = render(<Graph calls={calls} selectedCallId="late" />);
    act(() => latestNetwork().setView({ x: 0, y: 120 }, 0.6));
    act(() => latestNetwork().emit("click", { nodes: ["edge"] }));

    // The update brings the old selection in before the click's selection commits.
    const updated = [...calls, call("late", "agent")];
    rerender(<Graph calls={updated} selectedCallId="late" />);
    rerender(<Graph calls={updated} selectedCallId="edge" />);
    const rebuilt = latestNetwork();
    expect(rebuilt.moveTo).toHaveBeenCalledTimes(1);
    expect(rebuilt.selectNodes).toHaveBeenLastCalledWith(["edge"]);
  });

  it("pans to a selection made elsewhere even with a click pending, and after the click is used up", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId={null} />);
    const network = latestNetwork();
    act(() => network.setView({ x: 0, y: 120 }, 0.6));
    act(() => network.emit("click", { nodes: ["near"] }));
    network.moveTo.mockClear();

    rerender(<Graph calls={calls} selectedCallId="far" />);
    expect(network.moveTo).toHaveBeenLastCalledWith({ position: { x: 4000, y: 240 }, animation: false });
    rerender(<Graph calls={calls} selectedCallId="near" />);
    expect(network.moveTo).toHaveBeenLastCalledWith({ position: { x: 50, y: 240 }, animation: false });
  });

  it("brings back a node clicked just before the panel narrows", async () => {
    render(<Graph calls={calls} selectedCallId="agent" />);
    const network = latestNetwork();
    act(() => network.emit("click", { nodes: ["edge"] }));
    network.moveTo.mockClear();

    // The click's selection has not committed when the overlay closes.
    await resizeTo(network, 300);
    expect(network.moveTo).toHaveBeenLastCalledWith({ position: { x: 290, y: 240 }, animation: false });
  });

  it("brings a double-clicked node fully into view when the expanded view closes on it", async () => {
    render(<Graph calls={calls} selectedCallId="agent" />);
    const network = latestNetwork();
    fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    await resizeTo(network, 1600);
    // "far" sits where the collapsed panel's right edge will cut it.
    act(() => network.setView({ x: 4700, y: 240 }, 0.6));
    network.moveTo.mockClear();

    act(() => {
      network.emit("click", { nodes: ["far"] });
      network.emit("doubleClick", { nodes: ["far"] });
    });
    await resizeTo(network, 400);
    expect(network.moveTo).toHaveBeenLastCalledWith({ position: { x: 4000, y: 240 }, animation: false });
    network.moveTo.mockClear();

    // Only that resize: later ones leave a cut-off node where it is, and a
    // close leaves a node that is wholly in view where it is.
    act(() => network.setView({ x: 3700, y: 240 }, 0.6));
    await resizeTo(network, 410);
    expect(network.moveTo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    await resizeTo(network, 1600);
    // "far" is within the part of the overlay that the panel keeps.
    act(() => network.setView({ x: 5000, y: 240 }, 0.6));
    fireEvent.click(screen.getByRole("button", { name: "Close expanded graph" }));
    network.moveTo.mockClear();
    await resizeTo(network, 400);
    expect(network.moveTo).toHaveBeenCalledTimes(1);
  });

  it("selects clicked nodes without moving them, zooms and fits with the buttons, and expands until Escape or a node double-click", () => {
    const { rerender } = render(<Graph calls={calls} selectedCallId="near" />);
    const network = latestNetwork();
    const container = screen.getByTestId("trace-graph");
    act(() => network.setView({ x: 0, y: 120 }, 0.6));
    network.moveTo.mockClear();

    // "edge" is clipped; panning it on click would move it out from under a double-click.
    act(() => network.emit("click", { nodes: ["edge"] }));
    expect(selectCall).toHaveBeenLastCalledWith("edge");
    rerender(<Graph calls={calls} selectedCallId="edge" />);
    expect(network.selectNodes).toHaveBeenLastCalledWith(["edge"]);
    expect(network.moveTo).not.toHaveBeenCalled();
    act(() => network.emit("click", { nodes: ["root"] }));
    expect(selectCall).toHaveBeenLastCalledWith(null);
    rerender(<Graph calls={calls} selectedCallId={null} />);
    expect(network.unselectAll).toHaveBeenCalledTimes(1);
    act(() => network.emit("click", { nodes: [] }));
    expect(selectCall).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(network.moveTo).toHaveBeenLastCalledWith({ scale: expect.closeTo(0.75), animation: false });
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(network.moveTo).toHaveBeenLastCalledWith({ scale: expect.closeTo(0.6), animation: false });
    fireEvent.click(screen.getByRole("button", { name: "Fit whole graph" }));
    expect(network.fit).toHaveBeenCalledTimes(2);

    // The traces-list panel closes on Escape from a window listener; the
    // graph takes Escape only while expanded.
    const panelEscape = vi.fn();
    window.addEventListener("keydown", panelEscape);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(panelEscape).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    expect(container).toHaveAttribute("data-expanded", "true");
    expect(container).toHaveClass("fixed");
    expect(screen.getByRole("dialog", { name: "Trace graph" })).toBe(container);
    expect(container).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", panelEscape);
    expect(container).toHaveAttribute("data-expanded", "false");
    expect(panelEscape).toHaveBeenCalledTimes(1);

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
