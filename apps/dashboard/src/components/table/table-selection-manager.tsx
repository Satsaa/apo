"use client";

import { useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { type ColumnDef, type Row, type RowSelectionState, type Table } from "@tanstack/react-table";
import { useTableSelection } from "@/hooks/use-table-selection";

interface TableSelectionManagerProps {
  projectId: string;
  tableName: string;
  setSelectedRows: (rows: RowSelectionState) => void;
  disabled?: boolean;
}

/**
 * TanStack column with per-row checkboxes, a header select-all (with
 * indeterminate state), and Shift+click range selection anchored to the
 * last clicked row.
 */
export function useTableSelectionManager<TData>({
  projectId,
  tableName,
  setSelectedRows,
  disabled = false,
}: TableSelectionManagerProps) {
  const { setSelectAll } = useTableSelection({ projectId, tableName });

  // Track the last selected row ID for Shift+click range selection
  const lastSelectedRowId = useRef<string | null>(null);

  const handleCheckboxChange = (
    row: Row<TData>,
    checked: boolean | string,
    table: Table<TData>
  ) => {
    const isChecked = !!checked;
    const currentRowId = row.id;
    const rows = table.getRowModel().rows;
    const currentIndex = rows.findIndex((r) => r.id === currentRowId);

    // Radix's onCheckedChange passes no event object, so the shift key has
    // to be read from the global native event.
    const event = window.event as MouseEvent | undefined;
    const isShiftClick = event?.shiftKey;

    if (isShiftClick && lastSelectedRowId.current) {
      const lastIndex = rows.findIndex((r) => r.id === lastSelectedRowId.current);

      if (lastIndex !== -1) {
        const [start, end] = [
          Math.min(lastIndex, currentIndex),
          Math.max(lastIndex, currentIndex),
        ];

        const newSelection: RowSelectionState = { ...table.getState().rowSelection };

        for (let i = start; i <= end; i++) {
          const targetRow = rows[i];
          if (isChecked) {
            newSelection[targetRow.id] = true;
          } else {
            delete newSelection[targetRow.id];
          }
        }

        setSelectedRows(newSelection);
        // Don't update lastSelectedRowId on Shift+click - keep the original anchor
        return;
      }
    }

    row.toggleSelected(isChecked);

    if (isChecked) {
      lastSelectedRowId.current = currentRowId;
    } else {
      // Only clear if we're deselecting the same row that was last selected
      if (lastSelectedRowId.current === currentRowId) {
        lastSelectedRowId.current = null;
      }
    }

    if (!isChecked) setSelectAll(false);
  };

  return {
    selectActionColumn: {
      id: "select",
      accessorKey: "select",
      size: 35,
      minSize: 35,
      maxSize: 35,
      enableResizing: false,
      header: ({ table }: { table: Table<TData> }) => (
        <div className="flex h-full items-center">
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected()
                ? true
                : table.getIsSomePageRowsSelected()
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(value) => {
              table.toggleAllPageRowsSelected(!!value);
              if (!value) {
                setSelectedRows({});
                setSelectAll(false);
              }
            }}
            aria-label="Select all"
            className="opacity-60"
            disabled={disabled}
          />
        </div>
      ),
      cell: ({ row, table }: { row: Row<TData>; table: Table<TData> }) => (
        <div
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => handleCheckboxChange(row, value, table)}
            aria-label="Select row"
            className="opacity-60"
            disabled={disabled}
          />
        </div>
      ),
    } as ColumnDef<TData, unknown>,
  };
}
