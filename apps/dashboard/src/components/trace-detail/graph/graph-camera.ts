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

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Node labels are 20px, so this keeps them at 12px or larger on screen.
export const MIN_READABLE_SCALE = 0.6;
export const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
const ROOT_LEFT_MARGIN = 80;
// Selecting a node bolds its label after the check below, widening its box.
const REVEAL_MARGIN = 16;

/** Readable zoom on the target (root at the left edge, others centred); `null` keeps the fit. */
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

/** Whether any part of a node's on-screen box is outside the viewport (less a margin). */
export function isOffscreen(box: Box, viewport: Viewport): boolean {
  return (
    box.left < REVEAL_MARGIN ||
    box.top < REVEAL_MARGIN ||
    box.right > viewport.width - REVEAL_MARGIN ||
    box.bottom > viewport.height - REVEAL_MARGIN
  );
}

/** Whether any part of a node's on-screen box is inside the viewport. */
export function isInView(box: Box, viewport: Viewport): boolean {
  return box.right > 0 && box.bottom > 0 && box.left < viewport.width && box.top < viewport.height;
}

/** The view centre that shows the canvas point `anchor` at `onScreen` (viewport pixels). */
export function centreKeeping(anchor: Point, onScreen: Point, scale: number, viewport: Viewport): Point {
  return {
    x: anchor.x - (onScreen.x - viewport.width / 2) / scale,
    y: anchor.y - (onScreen.y - viewport.height / 2) / scale,
  };
}

// Wheel zoom and "fit" can leave the scale outside these limits; a button
// press then holds the scale rather than stepping the wrong way.
export function zoomedScale(scale: number, factor: number): number {
  const next = scale * factor;
  return factor > 1
    ? Math.max(scale, Math.min(MAX_ZOOM, next))
    : Math.min(scale, Math.max(MIN_ZOOM, next));
}
