import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { Header } from "@tanstack/react-table";
import { ColumnResizeHandle } from "../column-resize-handle";

// The handler TanStack returns decides which follow-up events to track from
// the event type it receives: touchstart installs touchmove/touchend
// listeners, anything else installs mousemove/mouseup. These tests pin the
// wiring so the button always feeds it both native event types.
function renderHandle() {
  const resizeHandler = vi.fn();
  const resetSize = vi.fn();
  const header = {
    getResizeHandler: vi.fn(() => resizeHandler),
    column: {
      getIsResizing: () => false,
      resetSize,
    },
  } as unknown as Header<unknown, unknown>;
  const utils = render(<ColumnResizeHandle header={header} />);
  return { ...utils, resizeHandler, resetSize };
}

describe("ColumnResizeHandle", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it("starts resize on touchstart so finger drags are tracked", () => {
    const { resizeHandler, getByRole } = renderHandle();
    fireEvent.touchStart(getByRole("button"), {
      touches: [{ clientX: 100 }],
    });
    expect(resizeHandler).toHaveBeenCalledTimes(1);
  });

  it("starts resize on mousedown", () => {
    const { resizeHandler, getByRole } = renderHandle();
    fireEvent.mouseDown(getByRole("button"), { clientX: 100 });
    expect(resizeHandler).toHaveBeenCalledTimes(1);
  });

  it("resets the column size on Enter", () => {
    const { resetSize, getByRole } = renderHandle();
    fireEvent.keyDown(getByRole("button"), { key: "Enter" });
    expect(resetSize).toHaveBeenCalledTimes(1);
  });
});
