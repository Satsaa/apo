"use client";

import { type Header } from "@tanstack/react-table";
import { cn } from "@/lib/utils";

export interface ColumnResizeHandleProps<TData> {
  header: Header<TData, unknown>;
}

/**
 * Drag handle rendered at the right edge of a resizable table header.
 *
 * Binds TanStack's `header.getResizeHandler()` to `onMouseDown` AND
 * `onTouchStart`: the handler decides which follow-up events to track
 * (`mousemove`/`mouseup` vs `touchmove`/`touchend`) from the event type it
 * receives, so a `pointerdown`-only binding leaves touch drags dead — a
 * pointerdown from a finger still says "pointerdown", and the mouse
 * listeners it installs never fire.
 *
 * The button is wider than the 2px line it shows and straddles the column
 * edge (`-right-2`), so the boundary is grabbable; on touch pointers
 * (`pointer: coarse`) it grows further because a fingertip cannot aim at
 * pixels, and the line stays faintly visible — there is no hover to reveal
 * it.
 *
 * Must be rendered inside a `position: relative` container (e.g. TableHead).
 *
 * @example
 * <TableHead style={{ position: "relative" }}>
 *   {flexRender(header.column.columnDef.header, header.getContext())}
 *   {header.column.getCanResize() && (
 *     <ColumnResizeHandle header={header} />
 *   )}
 * </TableHead>
 */
export function ColumnResizeHandle<TData>({
  header,
}: ColumnResizeHandleProps<TData>) {
  const isResizing = header.column.getIsResizing();

  return (
    <button
      type="button"
      aria-label="Resize column (double-click or press Enter to reset)"
      onMouseDown={header.getResizeHandler()}
      onTouchStart={header.getResizeHandler()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => header.column.resetSize()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          header.column.resetSize();
        }
      }}
      className={cn(
        "absolute top-0 z-20 h-full w-4 -right-2 cursor-col-resize touch-none select-none",
        "flex items-center justify-center",
        "[@media(pointer:coarse)]:w-7 [@media(pointer:coarse)]:-right-3.5",
        "transition-colors duration-100",
        isResizing
          ? "bg-primary"
          : "bg-transparent hover:bg-primary/40",
      )}
    >
      <span
        className={cn(
          "pointer-events-none h-full w-[2px] rounded-full",
          "[@media(pointer:coarse)]:opacity-40",
          isResizing ? "bg-primary opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}
