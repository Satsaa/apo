import { describe, expect, it } from "vitest";

import { executorRunWarning } from "../executor-run-warning";

describe("executorRunWarning", () => {
  it("is silent when an executor will claim the run", () => {
    expect(executorRunWarning("ready")).toBeNull();
    expect(executorRunWarning("busy")).toBeNull();
    expect(executorRunWarning(null)).toBeNull();
  });

  it.each([
    ["not_connected", "apo connect"],
    ["offline", "apo connect"],
    ["incompatible", "Update the Apo CLI"],
    ["catalog_mismatch", "apo task publish"],
  ] as const)("warns for %s and names the fix", (state, fix) => {
    const warning = executorRunWarning(state);
    expect(warning?.detail).toContain(fix);
    expect(warning?.detail).toContain("expire after 24 hours");
  });
});
