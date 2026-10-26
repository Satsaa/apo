import { cn } from "@/lib/utils";
import type { RowVerdict } from "./trace-evaluation";

const VERDICT_BADGES: Record<
  RowVerdict | "unknown",
  { text: string; className: string; title?: string; srText?: string }
> = {
  pass: { text: "pass", className: "bg-success/15 text-success" },
  fail: { text: "fail", className: "bg-destructive/15 text-destructive" },
  "no-verdict": {
    text: "no verdict",
    className: "bg-warning/15 text-warning",
    title: "Ended without a verdict (judge errored or evidence unsupported) — quality unknown, not failed",
  },
  unknown: { text: "—", className: "bg-muted text-muted-foreground", srText: "verdict unknown" },
};

/** The pass / fail / no verdict badge of a check or judgment. */
export function VerdictBadge({
  state,
  className,
}: {
  state: RowVerdict | undefined;
  className?: string;
}) {
  const badge = VERDICT_BADGES[state ?? "unknown"];
  return (
    <span
      data-verdict={state ?? "unknown"}
      title={badge.title}
      className={cn("shrink-0 rounded-sm px-1 py-0.5 text-[10px] font-semibold uppercase leading-none", badge.className, className)}
    >
      {badge.srText ? (
        <>
          <span aria-hidden>{badge.text}</span>
          <span className="sr-only">{badge.srText}</span>
        </>
      ) : (
        badge.text
      )}
    </span>
  );
}
