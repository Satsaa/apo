import { cn } from "@/lib/utils";

export type FlatEntry = [string, string | number | boolean | null];

/**
 * A small object of scalars — a tool call's arguments, typically — as its
 * entries, or `null` when the payload needs a tree instead.
 */
export function getFlatKeyValueEntries(data: unknown): FlatEntry[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const entries = Object.entries(data).filter(([, value]) =>
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean",
  ) as FlatEntry[];

  if (entries.length === 0 || entries.length !== Object.keys(data).length || entries.length > 8) {
    return null;
  }

  return entries;
}

export function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function FlatKeyValuePreview({ entries }: { entries: FlatEntry[] }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/10">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="flex items-start justify-between gap-4 border-b border-border/60 px-3 py-2.5 last:border-b-0"
        >
          <span className="shrink-0 text-xs text-muted-foreground">
            {humanizeKey(key)}
          </span>
          {/* Multi-line values (code, stdout) keep their line breaks — the
              default white-space collapsing renders them as one run-on line.
              Paths and ids have no spaces to wrap at, so they may break anywhere. */}
          <span
            className={cn(
              "min-w-0 font-mono text-sm text-foreground [overflow-wrap:anywhere]",
              typeof value === "string" && value.includes("\n") && "whitespace-pre-wrap",
            )}
          >
            {String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}
