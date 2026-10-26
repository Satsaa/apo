import { describe, expect, it } from "vitest";
import {
  centreKeeping,
  isInView,
  isOffscreen,
  MIN_READABLE_SCALE,
  openingCamera,
  zoomedScale,
} from "../graph/graph-camera";

const viewport = { width: 400, height: 500 };

describe("openingCamera", () => {
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
  it("is true when any edge of the box is outside the viewport less the margin", () => {
    expect(isOffscreen({ left: 20, top: 20, right: 380, bottom: 480 }, viewport)).toBe(false);
    expect(isOffscreen({ left: 10, top: 20, right: 100, bottom: 60 }, viewport)).toBe(true);
    expect(isOffscreen({ left: 300, top: 20, right: 390, bottom: 60 }, viewport)).toBe(true);
    expect(isOffscreen({ left: 20, top: 10, right: 100, bottom: 60 }, viewport)).toBe(true);
    expect(isOffscreen({ left: 20, top: 440, right: 100, bottom: 490 }, viewport)).toBe(true);
  });
});

describe("isInView", () => {
  it("is true while any part of the box is inside the viewport", () => {
    expect(isInView({ left: 380, top: 20, right: 440, bottom: 60 }, viewport)).toBe(true);
    expect(isInView({ left: 400, top: 20, right: 460, bottom: 60 }, viewport)).toBe(false);
    expect(isInView({ left: 20, top: -40, right: 100, bottom: 0 }, viewport)).toBe(false);
    expect(isInView({ left: 20, top: 500, right: 100, bottom: 540 }, viewport)).toBe(false);
  });
});

describe("centreKeeping", () => {
  it("returns the centre that shows the anchor at the given screen point", () => {
    const centre = centreKeeping({ x: 1000, y: 300 }, { x: 260, y: 100 }, 0.5, viewport);
    // screen = (anchor - centre) * scale + viewport / 2
    expect((1000 - centre.x) * 0.5 + 200).toBeCloseTo(260);
    expect((300 - centre.y) * 0.5 + 250).toBeCloseTo(100);
  });
});

describe("zoomedScale", () => {
  it("steps within the zoom limits and never in the wrong direction past them", () => {
    expect(zoomedScale(0.6, 1.25)).toBeCloseTo(0.75);
    expect(zoomedScale(2.8, 1.25)).toBe(3);
    expect(zoomedScale(0.06, 0.5)).toBe(0.05);
    expect(zoomedScale(0.013, 0.8)).toBe(0.013);
    expect(zoomedScale(5, 1.25)).toBe(5);
  });
});
