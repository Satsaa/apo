import { describe, expect, it } from "vitest";
import {
  isOffscreen,
  MIN_READABLE_SCALE,
  openingCamera,
  zoomedScale,
} from "../graph/graph-camera";

const viewport = { width: 400, height: 500 };

describe("openingCamera", () => {
  it("shows the whole graph when fitting it keeps labels readable", () => {
    expect(
      openingCamera({ fitScale: 0.8, target: { x: 10, y: 20 }, targetIsRoot: false, viewport }),
    ).toBeNull();
  });

  it("centres a readable zoom on the selected node when the fit would be too small", () => {
    expect(
      openingCamera({ fitScale: 0.08, target: { x: 10, y: 20 }, targetIsRoot: false, viewport }),
    ).toEqual({ position: { x: 10, y: 20 }, scale: MIN_READABLE_SCALE, offset: { x: 0, y: 0 } });
  });

  it("puts the root at the left edge so the layout runs across the panel", () => {
    const camera = openingCamera({
      fitScale: 0.08,
      target: { x: 0, y: 0 },
      targetIsRoot: true,
      viewport,
    });
    expect(camera?.scale).toBe(MIN_READABLE_SCALE);
    // The node lands at width/2 + offset.x from the left of the viewport.
    expect(viewport.width / 2 + (camera?.offset.x ?? 0)).toBe(80);
    expect(camera?.offset.y).toBe(0);
  });
});

describe("isOffscreen", () => {
  it("is false for a node well inside the viewport", () => {
    expect(isOffscreen({ x: 200, y: 250 }, viewport)).toBe(false);
  });

  it("is true for a node past any edge or hugging it", () => {
    expect(isOffscreen({ x: -300, y: 250 }, viewport)).toBe(true);
    expect(isOffscreen({ x: 390, y: 250 }, viewport)).toBe(true);
    expect(isOffscreen({ x: 200, y: 10 }, viewport)).toBe(true);
    expect(isOffscreen({ x: 200, y: 900 }, viewport)).toBe(true);
  });
});

describe("zoomedScale", () => {
  it("multiplies the scale within the zoom limits", () => {
    expect(zoomedScale(0.6, 1.25)).toBeCloseTo(0.75);
    expect(zoomedScale(2.8, 1.25)).toBe(3);
    expect(zoomedScale(0.06, 0.5)).toBe(0.05);
  });
});
