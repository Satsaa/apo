export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  position: Point;
  scale: number;
  offset: Point;
}

export interface Viewport {
  width: number;
  height: number;
}

// Node labels are 20px, so this keeps them at 12px or larger on screen.
export const MIN_READABLE_SCALE = 0.6;
export const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
// Where the root node's centre lands from the left edge of the viewport.
const ROOT_LEFT_MARGIN = 80;
const REVEAL_MARGIN = 40;

/**
 * Where the graph opens. A trace too big to fit at a readable size opens
 * zoomed in on the selected node (centred) or on
 * the root (at the left edge, where the left-to-right layout starts);
 * otherwise the whole graph is shown (`null`).
 */
export function openingCamera({
  fitScale,
  target,
  targetIsRoot,
  viewport,
}: {
  fitScale: number;
  target: Point;
  targetIsRoot: boolean;
  viewport: Viewport;
}): Camera | null {
  if (fitScale >= MIN_READABLE_SCALE) return null;
  return {
    position: target,
    scale: MIN_READABLE_SCALE,
    offset: { x: targetIsRoot ? ROOT_LEFT_MARGIN - viewport.width / 2 : 0, y: 0 },
  };
}

/** Whether a node's on-screen position is outside (or hugging the edge of) the viewport. */
export function isOffscreen(domPosition: Point, viewport: Viewport): boolean {
  return (
    domPosition.x < REVEAL_MARGIN ||
    domPosition.y < REVEAL_MARGIN ||
    domPosition.x > viewport.width - REVEAL_MARGIN ||
    domPosition.y > viewport.height - REVEAL_MARGIN
  );
}

export function zoomedScale(scale: number, factor: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * factor));
}
