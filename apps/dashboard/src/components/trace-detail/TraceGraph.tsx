"use client";

import { useEffect, useRef, useState, useCallback, useSyncExternalStore, type ReactNode } from "react";
import { Network } from "vis-network/standalone";
import type { DataSet } from "vis-data/peer";
import type { LoggedCall } from "./contexts";
import { useSelection } from "./contexts/SelectionContext";
import { useGraphData, type GraphNode } from "./graph/useGraphData";
import { isOffscreen, openingCamera, zoomedScale, ZOOM_STEP } from "./graph/graph-camera";
import { Maximize2, Minimize2, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TraceGraphProps {
  calls: LoggedCall[];
}

const ROOT_ID = "root";
// Never animate: vis-network breaks zoom and pan for good when an animated
// move is interrupted before its first frame.
const INSTANT = { animation: false } as const;

function getThemeColors() {
  if (typeof document === "undefined") {
    return { bg: "#ffffff", fg: "#1e293b", border: "#e2e8f0" };
  }
  const root = document.documentElement;
  const bg = getComputedStyle(root).getPropertyValue("--background").trim();
  const fg = getComputedStyle(root).getPropertyValue("--foreground").trim();
  const border = getComputedStyle(root).getPropertyValue("--border").trim();
  return {
    bg: bg || "#ffffff",
    fg: fg || "#1e293b",
    border: border || "#e2e8f0",
  };
}

function subscribeToDarkMode(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function useIsDarkMode() {
  // useSyncExternalStore keeps the server/hydration snapshot neutral (false)
  // and re-renders when the theme class flips — no mount effect initializing
  // state from a browser global. Same pattern as hooks/use-mobile.tsx.
  return useSyncExternalStore(
    subscribeToDarkMode,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}

function viewportOf(container: HTMLElement) {
  return { width: container.clientWidth, height: container.clientHeight };
}

function hasNode(nodes: DataSet<GraphNode>, id: string | null): id is string {
  return id !== null && nodes.get(id) !== null;
}

function placeOpeningView(
  network: Network,
  container: HTMLElement,
  nodes: DataSet<GraphNode>,
  selectedCallId: string | null,
) {
  network.fit(INSTANT);
  const targetId = hasNode(nodes, selectedCallId) ? selectedCallId : ROOT_ID;
  const camera = openingCamera({
    fitScale: network.getScale(),
    target: network.getPosition(targetId),
    targetIsRoot: targetId === ROOT_ID,
    viewport: viewportOf(container),
  });
  if (camera) network.moveTo({ ...camera, ...INSTANT });
}

function GraphControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      className="h-7 w-7 p-0"
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}

export function TraceGraph({ calls }: TraceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  // Restored when new spans or a theme flip rebuild the network, so the view does not jump back.
  const savedViewRef = useRef<{ position: { x: number; y: number }; scale: number } | null>(null);
  const isDark = useIsDarkMode();
  const { nodes, edges } = useGraphData(calls, isDark);
  const { selectCall, selectedCallId } = useSelection();
  const selectedCallIdRef = useRef(selectedCallId);
  const [isExpanded, setIsExpanded] = useState(false);

  const getNetworkOptions = useCallback(() => {
    const theme = getThemeColors();
    return {
      nodes: {
        shape: "box",
        font: {
          size: 20,
          face: "Inter, system-ui, sans-serif",
          color: theme.fg,
        },
        margin: {
          top: 16,
          right: 20,
          bottom: 16,
          left: 20,
        },
        color: {
          background: theme.bg,
          border: theme.border,
          highlight: {
            background: isDark ? "#1e3a5f" : "#eff6ff",
            border: "#3b82f6",
          },
          hover: {
            background: isDark ? "#1e293b" : "#f8fafc",
            border: isDark ? "#475569" : "#cbd5e1",
          },
        },
      },
      edges: {
        smooth: {
          enabled: true,
          type: "cubicBezier",
          forceDirection: "horizontal",
          roundness: 0.4,
        },
        arrows: {
          to: {
            enabled: true,
            scaleFactor: 1.2,
          },
        },
        color: {
          color: "#94a3b8",
          highlight: "#3b82f6",
          hover: "#64748b",
        },
        width: 2,
      },
      layout: {
        hierarchical: {
          enabled: true,
          direction: "LR",
          sortMethod: "directed",
          levelSeparation: 420,
          nodeSpacing: 70,
          treeSpacing: 70,
        },
      },
      physics: false,
      interaction: {
        hover: true,
        tooltipDelay: 200,
        navigationButtons: false,
        keyboard: true,
      },
    };
  }, [isDark]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (calls.length === 0) return;

    const network = new Network(container, { nodes, edges }, getNetworkOptions());

    network.on("click", (params: { nodes: string[] }) => {
      if (params.nodes.length === 0) return;
      const nodeId = params.nodes[0];
      selectCall(nodeId === ROOT_ID ? null : nodeId);
    });

    // The expanded view hides the details pane; double-clicking a node collapses it to show them.
    network.on("doubleClick", (params: { nodes: string[] }) => {
      if (params.nodes.length > 0) setIsExpanded(false);
    });

    network.on("hoverNode", () => {
      container.style.cursor = "pointer";
    });

    network.on("blurNode", () => {
      container.style.cursor = "default";
    });

    const savedView = savedViewRef.current;
    if (savedView) {
      network.moveTo({ ...savedView, ...INSTANT });
    } else {
      placeOpeningView(network, container, nodes, selectedCallIdRef.current);
    }
    if (hasNode(nodes, selectedCallIdRef.current)) {
      network.selectNodes([selectedCallIdRef.current]);
    }

    // vis-network rescales the view with its container; keep the zoom so a bigger panel shows more.
    network.on("resize", () => {
      const scale = network.getScale();
      queueMicrotask(() => {
        if (networkRef.current === network) network.moveTo({ scale, ...INSTANT });
      });
    });

    networkRef.current = network;

    return () => {
      savedViewRef.current = { position: network.getViewPosition(), scale: network.getScale() };
      networkRef.current = null;
      network.destroy();
    };
  }, [calls.length, nodes, edges, selectCall, getNetworkOptions]);

  useEffect(() => {
    selectedCallIdRef.current = selectedCallId;
    const network = networkRef.current;
    const container = containerRef.current;
    if (!network || !container) return;

    if (!hasNode(nodes, selectedCallId)) {
      network.unselectAll();
      return;
    }
    network.selectNodes([selectedCallId]);
    const position = network.getPosition(selectedCallId);
    if (isOffscreen(network.canvasToDOM(position), viewportOf(container))) {
      network.moveTo({ position, ...INSTANT });
    }
  }, [selectedCallId, nodes]);

  useEffect(() => {
    if (!isExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isExpanded]);

  const zoomBy = (factor: number) => {
    const network = networkRef.current;
    if (!network) return;
    network.moveTo({ scale: zoomedScale(network.getScale(), factor), ...INSTANT });
  };

  const fitAll = () => {
    networkRef.current?.fit(INSTANT);
  };

  if (calls.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="text-center text-sm text-muted-foreground">
          <p className="mb-2 font-medium">No calls</p>
          <p>This run has no logged calls to visualize.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col bg-background",
        isExpanded ? "fixed inset-0 z-[60]" : "relative h-full w-full",
      )}
      data-testid="trace-graph"
      data-expanded={isExpanded}
    >
      {isExpanded && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-sm">
          <span className="font-medium">Trace graph</span>
          <span className="text-xs text-muted-foreground">
            Double-click a node to open its details · Esc to close
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div className="absolute top-2 right-2 z-10 flex gap-1">
          <GraphControlButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
            <ZoomIn className="h-3.5 w-3.5" />
          </GraphControlButton>
          <GraphControlButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <ZoomOut className="h-3.5 w-3.5" />
          </GraphControlButton>
          <GraphControlButton label="Fit whole graph" onClick={fitAll}>
            <Scan className="h-3.5 w-3.5" />
          </GraphControlButton>
          <GraphControlButton
            label={isExpanded ? "Close expanded graph" : "Expand graph"}
            onClick={() => setIsExpanded((expanded) => !expanded)}
          >
            {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </GraphControlButton>
        </div>

        <div
          ref={containerRef}
          className={cn(
            "h-full w-full",
            !isExpanded && "min-h-[400px]",
          )}
        />
      </div>
    </div>
  );
}
