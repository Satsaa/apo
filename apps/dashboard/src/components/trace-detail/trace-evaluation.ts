import type { TraceObservation } from "./contexts";

// Judge spans (judge:* / t.agent:*) form a distinct evaluation phase at the
// end of a trace. The tree collapses them into one Evaluation row so agent
// work stays readable when a suite carries many judgments (#302). Search is
// the escape hatch: while filtering, judge rows render like any other row.
//
// The SDK groups the phase under a `checks.run` CHAIN span every judge nests
// under; when that span is present it anchors the group (and its summary
// carries the collapsed-row counts). Traces recorded before that emission —
// or by other producers — fall back to the judge:/t.agent: name prefix.
//
// Since #344 every check also gets its own `check:<id>` span under
// checks.run, with its judge/t.agent spans nested inside. Check rows and
// judge rows both carry a verdict badge; a check's verdict comes from the
// checks.run summary, so one fetch covers every check row.

/** A call is an evaluation root when its step name says so. */
export function isEvaluationRoot(name: string): boolean {
  return name.startsWith("judge:") || name.startsWith("t.agent:");
}

const CHECK_PREFIX = "check:";

/** A per-check span: `check:<id>`. */
function isCheckSpan(name: string): boolean {
  return name.startsWith(CHECK_PREFIX);
}

/** The check id a `check:<id>` span names. */
function checkIdOf(name: string): string {
  return name.slice(CHECK_PREFIX.length);
}

export interface EvaluationGroup {
  /** The checks.run phase span, when the producer emitted one. */
  checksRun: TraceObservation | null;
  /** Root judge spans, in call order. */
  roots: TraceObservation[];
  /** The `check:<id>` spans directly under checks.run, in call order. */
  checks: TraceObservation[];
  /** Phase span + root ids plus every descendant span (the checks, their
   * tool calls, sub-spans). */
  memberIds: Set<string>;
}

/** Collect the evaluation phase of a trace, or null when it has neither a
 * checks.run span nor judge roots. */
export function findEvaluationGroup(calls: TraceObservation[]): EvaluationGroup | null {
  const roots = calls.filter((c) => isEvaluationRoot(c.step_name ?? ""));
  const checksRun =
    calls.find((c) => c.step_name === "checks.run") ?? null;
  if (roots.length === 0 && !checksRun) return null;
  // Only the SDK's per-check spans: an agent span that happens to be named
  // `check:…` stays in the agent's tree.
  const checks = checksRun
    ? calls.filter((c) => c.parent_call_id === checksRun.id && isCheckSpan(c.step_name ?? ""))
    : [];
  const memberIds = new Set(roots.map((c) => c.id));
  if (checksRun) memberIds.add(checksRun.id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of calls) {
      if (!memberIds.has(c.id) && c.parent_call_id && memberIds.has(c.parent_call_id)) {
        memberIds.add(c.id);
        grew = true;
      }
    }
  }
  return { checksRun, roots, checks, memberIds };
}

/** What a verdict row's badge says. `no-verdict` is a check whose judge
 * errored or whose evidence was unsupported (issue #323). */
export type RowVerdict = "pass" | "fail" | "no-verdict";

/** A check verdict from its pass flag and outcome. */
function checkVerdict(pass: boolean, outcome: unknown): RowVerdict {
  if (pass) return "pass";
  return outcome === "error" || outcome === "unsupported" ? "no-verdict" : "fail";
}

/** A tool_result as an object: JSON strings parsed, unparseable ones null. */
function parseToolResult(toolResult: unknown): unknown {
  if (typeof toolResult !== "string") return toolResult;
  try {
    return JSON.parse(toolResult) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read a check span's own verdict from its full call. Current SDKs export the
 * check summary ({pass, outcome, reasoning, assertions}) as the tool result;
 * older SDKs serialized the summary into an assistant message, so read both
 * channels. Spans that predate `outcome` read a verdictless check as a fail.
 */
export function parseCheckSpanVerdict(
  call: Pick<TraceObservation, "tool_result" | "output">,
): RowVerdict | undefined {
  const messages = (call.output as { messages?: unknown } | null)?.messages;
  const assistant = Array.isArray(messages)
    ? (messages.findLast(
        (m) => (m as { role?: unknown } | null)?.role === "assistant",
      ) as { content?: unknown } | undefined)
    : undefined;
  for (const candidate of [call.tool_result, assistant?.content]) {
    const summary = parseToolResult(candidate) as { pass?: unknown; outcome?: unknown } | null;
    if (typeof summary?.pass === "boolean") return checkVerdict(summary.pass, summary.outcome);
  }
  return undefined;
}

/**
 * A judge or t.agent span's own verdict from its full call, which rides its
 * tool_result as {reasoning, pass, outcome?}. No verdict is either an
 * `outcome` saying so, a null `pass` (a t.agent session that ended without
 * one), or a judge call that threw: an ERROR span with no verdict recorded.
 * The verdict JSON is not in slim trace payloads, so the tree fetches each
 * judge's full call on demand.
 */
export function parseJudgeSpanVerdict(
  call: Pick<TraceObservation, "tool_result" | "level">,
): RowVerdict | undefined {
  const verdict = parseToolResult(call.tool_result) as
    | { pass?: unknown; outcome?: unknown }
    | null
    | undefined;
  if (typeof verdict?.pass === "boolean") return checkVerdict(verdict.pass, verdict.outcome);
  if (verdict?.pass === null || call.level?.toUpperCase() === "ERROR") return "no-verdict";
  return undefined;
}

/** Collapsed-row counts read from the checks.run span's tool_result. */
export interface PhaseSummary {
  total: number;
  passed: number;
  failed: number;
  /** Checks that ended without a verdict (judge errored / evidence
   * unsupported) — unknown quality, not failures (issue #323). */
  noVerdict: number;
  /** Each check's verdict, keyed by check id. */
  checks: Map<string, RowVerdict>;
}

/**
 * Parse the checks.run span's phase summary — the SDK's
 * `{total, passCount, failCount, noVerdictCount, results}` verdict payload —
 * or null when absent, malformed, or vacuous (total 0 carries no counts worth
 * showing). One fetch of the phase span replaces N per-check fetches for the
 * collapsed row's counts and the check rows' badges.
 */
export function parsePhaseSummary(toolResult: unknown): PhaseSummary | null {
  const summary = parseToolResult(toolResult) as
    | {
        total?: unknown;
        passCount?: unknown;
        failCount?: unknown;
        noVerdictCount?: unknown;
        results?: unknown;
      }
    | null;
  if (
    typeof summary?.total !== "number" ||
    summary.total <= 0 ||
    typeof summary?.passCount !== "number" ||
    typeof summary?.failCount !== "number"
  ) {
    return null;
  }
  const noVerdict =
    typeof summary.noVerdictCount === "number" ? summary.noVerdictCount : 0;
  const checks = new Map<string, RowVerdict>();
  for (const result of Array.isArray(summary.results) ? summary.results : []) {
    const r = result as { id?: unknown; pass?: unknown; outcome?: unknown } | null;
    if (typeof r?.id !== "string" || typeof r.pass !== "boolean") continue;
    checks.set(r.id, checkVerdict(r.pass, r.outcome));
  }
  return {
    total: summary.total,
    passed: summary.passCount,
    failed: summary.failCount,
    noVerdict,
    checks,
  };
}

/** Whether the checks.run summary holds this call's verdict: only a check
 * span of the group can be in it. */
function summaryCovers(
  call: TraceObservation,
  group: EvaluationGroup,
  phaseSummary: PhaseSummary,
): boolean {
  return (
    group.checks.includes(call) &&
    phaseSummary.checks.has(checkIdOf(call.step_name ?? ""))
  );
}

/**
 * The spans whose full call must be fetched for a verdict right now.
 *
 * A check row reads its verdict from the checks.run summary, so a check is
 * fetched on its own only when the summary cannot answer for it: no
 * checks.run span, a summary that resolved unusable, or a check missing
 * from it. A pending summary fetches nothing yet (one fetch in flight beats
 * N). Judge verdicts live only on the judge spans, so judges are fetched
 * while their rows are visible, and for the counts on a trace that has no
 * check spans and no usable summary.
 */
export function verdictFetchTargets(state: {
  group: EvaluationGroup;
  phaseSummary: PhaseSummary | null | undefined;
  /** Group expanded, or search surfacing its rows. */
  rowsVisible: boolean;
}): TraceObservation[] {
  const { group, phaseSummary, rowsVisible } = state;
  const pending = group.checksRun !== null && phaseSummary === undefined;
  const unusable = group.checksRun === null || phaseSummary === null;
  const checks =
    pending || (!rowsVisible && !unusable)
      ? []
      : group.checks.filter((c) => !phaseSummary || !summaryCovers(c, group, phaseSummary));
  const judges =
    rowsVisible || (unusable && group.checks.length === 0) ? group.roots : [];
  return [...checks, ...judges];
}

/** A verdict row's badge state: a check from the summary when it covers the
 * check, otherwise the span's own fetched verdict. undefined = not known
 * (yet). */
export function rowVerdict(
  call: TraceObservation,
  group: EvaluationGroup,
  phaseSummary: PhaseSummary | null | undefined,
  fetched: Record<string, RowVerdict | undefined>,
): RowVerdict | undefined {
  if (phaseSummary && summaryCovers(call, group, phaseSummary)) {
    return phaseSummary.checks.get(checkIdOf(call.step_name ?? ""));
  }
  return fetched[call.id];
}

/** The collapsed Evaluation row's counts: the checks.run summary when usable,
 * otherwise the fetched verdicts of the check spans (or, on a trace without
 * them, of the judge spans). */
export function evaluationCounts(
  group: EvaluationGroup,
  phaseSummary: PhaseSummary | null | undefined,
  fetched: Record<string, RowVerdict | undefined>,
): { passed: number; failed: number; noVerdict: number } {
  if (phaseSummary) return phaseSummary;
  const rows = group.checks.length > 0 ? group.checks : group.roots;
  const count = (verdict: RowVerdict) => rows.filter((r) => fetched[r.id] === verdict).length;
  return { passed: count("pass"), failed: count("fail"), noVerdict: count("no-verdict") };
}

/**
 * The tree label of a verdict row — a check or judge span of the group — or
 * null for any other call. A check row drops its `check:` prefix; a judge
 * nested in the check it judges shows only its kind, because the check row
 * above already names the check.
 */
export function verdictRowLabel(
  call: TraceObservation,
  group: EvaluationGroup,
  parent: TraceObservation | undefined,
): string | null {
  const name = call.step_name ?? "";
  if (group.checks.includes(call)) return checkIdOf(name);
  if (!group.roots.includes(call)) return null;
  const kind = name.startsWith("t.agent:") ? "t.agent" : "judge";
  const parentIsItsCheck =
    parent !== undefined &&
    group.checks.includes(parent) &&
    checkIdOf(parent.step_name ?? "") === name.slice(kind.length + 1);
  return parentIsItsCheck ? kind : name;
}

/**
 * Rows to render inside the expanded group: every member row except the
 * checks.run span's own — the group header already represents that span, so
 * rendering it again would duplicate the phase as a raw row.
 */
export function evaluationSubtreeRows<T extends PartitionableRow>(
  rows: T[],
  group: EvaluationGroup,
): T[] {
  const spanId = group.checksRun?.id ?? null;
  return rows.filter(
    (row) =>
      row.node.call !== null &&
      group.memberIds.has(row.node.call.id) &&
      row.node.call.id !== spanId,
  );
}

/** Minimal flat-tree row shape — structural, so the tree component's row
 * type satisfies it without importing the component. */
export interface PartitionableRow {
  node: { id: string; call: TraceObservation | null };
}

// ── Judgment facts ─────────────────────────────────────────────────────────
// The judgment brief (detail pane) shows what was judged, by what, and why
// it ruled — extracted from the full call payload, not raw JSON tabs.

export interface JudgmentFacts {
  /** Check name without the judge:/t.agent: prefix. */
  name: string;
  kind: "t.judge" | "t.agent";
  model?: string;
  instruction?: string;
  reasoning?: string;
  verdict?: RowVerdict;
  /** Direct child calls — a t.agent session's tool calls. */
  toolChildren: number;
  latencyMs?: number | null;
}

/**
 * Extract the judgment story from a judge/t.agent root call, or null for any
 * other call. The instruction and model ride the system message as
 * `{"model","instruction"}` JSON; the verdict ({"reasoning","pass"}) rides
 * tool_result.
 */
export function judgmentFacts(
  call: TraceObservation,
  allCalls: TraceObservation[],
): JudgmentFacts | null {
  const step = call.step_name ?? "";
  if (!isEvaluationRoot(step)) return null;
  const sys = (call.input as { messages?: Array<{ role: string; content: unknown }> } | null)
    ?.messages?.find((m) => m.role === "system")?.content;
  let model: string | undefined;
  let instruction: string | undefined;
  if (typeof sys === "string") {
    try {
      const parsed = JSON.parse(sys) as { model?: string; instruction?: string };
      model = parsed.model;
      instruction = parsed.instruction;
    } catch {
      // system prompt isn't the {model, instruction} JSON — leave undefined
    }
  }
  const verdict = call.tool_result as { reasoning?: string } | null;
  return {
    name: step.replace(/^(judge|t\.agent):/, ""),
    kind: step.startsWith("t.agent") ? "t.agent" : "t.judge",
    model,
    instruction,
    reasoning: verdict?.reasoning,
    verdict: parseJudgeSpanVerdict(call),
    toolChildren: allCalls.filter((c) => c.parent_call_id === call.id).length,
    latencyMs: call.latency_ms,
  };
}

export interface EvaluationPartition<T extends PartitionableRow> {
  /** Rows outside the evaluation phase, original order. */
  kept: T[];
  /** Index into `kept` where the Evaluation row belongs: the position the
   * first judge row occupied in the unpartitioned tree. */
  insertAt: number;
  /** The first member row in tree order (the checks.run span's, when it
   * has one) — the row the Evaluation row stands in for. */
  first: T;
}

/**
 * Split a flattened tree into agent-work rows and the evaluation phase.
 * Returns null when no member row is present (e.g. filters removed them).
 */
export function partitionEvaluation<T extends PartitionableRow>(
  rows: T[],
  group: EvaluationGroup,
): EvaluationPartition<T> | null {
  const isMember = (row: T) => row.node.call !== null && group.memberIds.has(row.node.call.id);
  const firstMember = rows.findIndex(isMember);
  if (firstMember === -1) return null;
  const kept = rows.filter((row) => !isMember(row));
  const insertAt = rows.slice(0, firstMember).filter((row) => !isMember(row)).length;
  return { kept, insertAt, first: rows[firstMember]! };
}
