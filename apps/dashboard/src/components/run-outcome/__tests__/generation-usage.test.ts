import { describe, expect, it } from "vitest";
import type { GenerationUsageSummary } from "@/lib/agent-task-api";
import { generationUsageMetadata } from "../generation-usage";

const TRACE = "/project/p/traces/t1";

function usage(overrides: Partial<GenerationUsageSummary> = {}): GenerationUsageSummary {
  return {
    generations: 21,
    model_time_ms: 58_538,
    slowest_call_ms: 7_419,
    slowest_call_id: "8c68d098872c5aab",
    reasoning_tokens: 5_492,
    reasoning_calls: 21,
    max_call_reasoning_tokens: 1_054,
    max_reasoning_call_id: "2e1e24fa23cfff6c",
    ...overrides,
  };
}

describe("generationUsageMetadata", () => {
  it("returns nothing for a run with no usage summary", () => {
    expect(generationUsageMetadata(null, TRACE)).toEqual([]);
    expect(generationUsageMetadata(undefined, TRACE)).toEqual([]);
  });

  it("shows totals and links the slowest and largest-reasoning calls", () => {
    const items = generationUsageMetadata(usage(), TRACE).map(({ value, label, href }) => ({ value, label, href }));
    expect(items).toEqual([
      { value: "58.54s", label: "model time · 21 calls", href: undefined },
      { value: "7.42s", label: "slowest call", href: `${TRACE}?observation=8c68d098872c5aab` },
      { value: "5.5k tok", label: "reasoning", href: undefined },
      { value: "1.1k tok", label: "largest reasoning call", href: `${TRACE}?observation=2e1e24fa23cfff6c` },
    ]);
  });

  it("marks reasoning partial when some generations did not report it", () => {
    const labels = generationUsageMetadata(usage({ reasoning_calls: 15 }), TRACE).map((i) => i.label);
    expect(labels).toContain("reasoning partial");
  });

  it("omits reasoning when no generation reported it", () => {
    const labels = generationUsageMetadata(
      usage({ reasoning_tokens: null, reasoning_calls: 0, max_call_reasoning_tokens: null, max_reasoning_call_id: null }),
      TRACE,
    ).map((i) => i.label);
    expect(labels).toEqual(["model time · 21 calls", "slowest call"]);
  });

  it("skips the per-call item when there is only one call, and links nothing without a trace", () => {
    const items = generationUsageMetadata(usage({ generations: 1, reasoning_calls: 1 }), null);
    expect(items.map((i) => i.label)).toEqual(["model time · 1 call", "reasoning"]);
    expect(items.every((i) => i.href === undefined)).toBe(true);
  });
});
