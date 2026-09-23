import { Brain, Cpu } from "lucide-react";
import type { GenerationUsageSummary } from "@/lib/agent-task-api";
import { formatInterval, formatTokenTotal } from "@/lib/format";
import type { OutcomeMetadataItem } from "./outcome-summary";

/**
 * Header items for a run's model time and reasoning. The total says how much;
 * the slowest / largest call says whether one call is responsible, and links
 * to it so a reader lands on that generation in the trace.
 */
export function generationUsageMetadata(
  usage: GenerationUsageSummary | null | undefined,
  traceHref: string | null,
): OutcomeMetadataItem[] {
  if (!usage) return [];
  const callHref = (callId: string | null): string | undefined =>
    traceHref && callId ? `${traceHref}?observation=${encodeURIComponent(callId)}` : undefined;
  const items: OutcomeMetadataItem[] = [];

  if (usage.model_time_ms != null) {
    items.push({
      icon: Cpu,
      value: formatInterval(usage.model_time_ms),
      label: `model time · ${usage.generations} ${usage.generations === 1 ? "call" : "calls"}`,
    });
    if (usage.slowest_call_ms != null && usage.generations > 1) {
      items.push({
        value: formatInterval(usage.slowest_call_ms),
        label: "slowest call",
        href: callHref(usage.slowest_call_id),
      });
    }
  }

  if (usage.reasoning_tokens != null) {
    const partial = usage.reasoning_calls < usage.generations ? " partial" : "";
    items.push({
      icon: Brain,
      value: formatTokenTotal(usage.reasoning_tokens),
      label: `reasoning${partial}`,
    });
    if (usage.max_call_reasoning_tokens != null && usage.reasoning_calls > 1) {
      items.push({
        value: formatTokenTotal(usage.max_call_reasoning_tokens),
        label: "largest reasoning call",
        href: callHref(usage.max_reasoning_call_id),
      });
    }
  }

  return items;
}
