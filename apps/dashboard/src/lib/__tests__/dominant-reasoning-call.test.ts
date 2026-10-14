import { describe, expect, it } from "vitest";
import { isDominantReasoningCall } from "../dominant-reasoning-call";

describe("isDominantReasoningCall", () => {
  it("is true when one call holds at least 40% of the reasoning", () => {
    expect(isDominantReasoningCall(10_000, 4_000)).toBe(true);
    expect(isDominantReasoningCall(10_000, 9_000)).toBe(true);
  });

  it("is false when the thinking is spread across calls", () => {
    expect(isDominantReasoningCall(199_300, 19_800)).toBe(false);
  });

  it("is false when one call did all of the reasoning", () => {
    expect(isDominantReasoningCall(5_000, 5_000)).toBe(false);
  });

  it("is false when either number is unknown or the total is zero", () => {
    expect(isDominantReasoningCall(null, 4_000)).toBe(false);
    expect(isDominantReasoningCall(10_000, undefined)).toBe(false);
    expect(isDominantReasoningCall(0, 0)).toBe(false);
  });
});
