/** Share of a run's reasoning one call must hold before it is worth naming. */
export const DOMINANT_REASONING_SHARE = 0.4;

/**
 * Whether the largest reasoning call stands out from the run's total. A max
 * that is a small slice of the total says nothing the total doesn't, so the
 * views show it only when one call accounts for a large part of the thinking.
 */
export function isDominantReasoningCall(
  totalTokens: number | null | undefined,
  maxCallTokens: number | null | undefined,
): boolean {
  if (totalTokens == null || maxCallTokens == null || totalTokens <= 0) return false;
  return maxCallTokens / totalTokens >= DOMINANT_REASONING_SHARE;
}
