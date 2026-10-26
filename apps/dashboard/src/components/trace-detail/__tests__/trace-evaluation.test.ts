import { describe, expect, it } from "vitest";
import type { TraceObservation } from "../contexts";
import {
  evaluationCounts,
  evaluationSubtreeRows,
  findEvaluationGroup,
  isEvaluationRoot,
  judgmentFacts,
  parseCheckSpanVerdict,
  parseJudgeSpanVerdict,
  parsePhaseSummary,
  partitionEvaluation,
  rowVerdict,
  verdictFetchTargets,
  verdictRowLabel,
  type PartitionableRow,
  type PhaseSummary,
  type RowVerdict,
} from "../trace-evaluation";

function call(id: string, name: string, parent: string | null = null): TraceObservation {
  return {
    id,
    step_name: name,
    parent_call_id: parent,
  } as TraceObservation;
}

function row(id: string, name: string, parent: string | null = null): PartitionableRow {
  return { node: { id, call: call(id, name, parent) } };
}

describe("isEvaluationRoot", () => {
  it("matches judge and t.agent prefixes only", () => {
    expect(isEvaluationRoot("judge:summary-reads-well")).toBe(true);
    expect(isEvaluationRoot("t.agent:figures-supported-by-work")).toBe(true);
    expect(isEvaluationRoot("agent.generate")).toBe(false);
    expect(isEvaluationRoot("")).toBe(false);
  });
});

describe("findEvaluationGroup", () => {
  it("returns null when the trace has no judges", () => {
    const calls = [call("a", "task.turn"), call("b", "agent.generate", "a")];
    expect(findEvaluationGroup(calls)).toBeNull();
  });

  it("collects roots and their descendants transitively", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("gen", "agent.generate", "run"),
      call("j1", "judge:reads-well", "run"),
      call("ag", "t.agent:figures", "run"),
      call("t1", "tool read", "ag"),
      call("t2", "tool search", "t1"),
    ]);
    expect(group).not.toBeNull();
    expect(group!.roots.map((c) => c.id)).toEqual(["j1", "ag"]);
    expect([...group!.memberIds].sort()).toEqual(["ag", "j1", "t1", "t2"]);
  });

  it("does not absorb unrelated calls sharing a parent with a judge", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("gen", "agent.generate", "run"),
      call("j1", "judge:reads-well", "run"),
    ]);
    expect(group!.memberIds.has("gen")).toBe(false);
    expect(group!.memberIds.has("j1")).toBe(true);
  });

  it("groups under the checks.run span and counts it as a member", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("gen", "agent.generate", "run"),
      call("cr", "checks.run", "run"),
      call("j1", "judge:reads-well", "cr"),
      call("ag", "t.agent:figures", "cr"),
      call("t1", "tool read", "ag"),
    ]);
    expect(group).not.toBeNull();
    expect(group!.checksRun!.id).toBe("cr");
    expect(group!.roots.map((c) => c.id)).toEqual(["j1", "ag"]);
    // The group row represents the span itself, so it must leave the kept
    // rows — otherwise the tree shows both a raw checks.run row and the
    // synthetic Evaluation row.
    expect(group!.memberIds.has("cr")).toBe(true);
    expect([...group!.memberIds].sort()).toEqual(["ag", "cr", "j1", "t1"]);
    expect(group!.memberIds.has("gen")).toBe(false);
  });

  it("still groups by name prefix when judges parent to the root (legacy traces)", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("j1", "judge:reads-well", "run"),
    ]);
    expect(group!.checksRun).toBeNull();
    expect(group!.roots.map((c) => c.id)).toEqual(["j1"]);
    expect(group!.memberIds.has("j1")).toBe(true);
  });

  it("returns a group for a checks.run span with no judges (sync-only checks)", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("cr", "checks.run", "run"),
    ]);
    expect(group).not.toBeNull();
    expect(group!.checksRun!.id).toBe("cr");
    expect(group!.roots).toEqual([]);
    expect(group!.memberIds.has("cr")).toBe(true);
  });

  it("collects the per-check spans and the judges nested in them", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("cr", "checks.run", "run"),
      call("c1", "check:reply is short", "cr"),
      call("c2", "check:ticket describes the problem", "cr"),
      call("j2", "judge:ticket describes the problem", "c2"),
    ]);
    expect(group!.checks.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(group!.roots.map((c) => c.id)).toEqual(["j2"]);
    expect([...group!.memberIds].sort()).toEqual(["c1", "c2", "cr", "j2"]);
  });

  it("leaves a check:-named span outside checks.run in the agent's tree", () => {
    const calls = [
      call("run", "apo.task.run"),
      call("turn", "task.turn", "run"),
      call("lint", "check:lint", "turn"),
      call("cr", "checks.run", "run"),
      call("c1", "check:reply is short", "cr"),
    ];
    const group = findEvaluationGroup(calls)!;
    expect(group.checks.map((c) => c.id)).toEqual(["c1"]);
    expect(group.memberIds.has("lint")).toBe(false);
    // Without an evaluation phase there is no group to pull it into.
    expect(findEvaluationGroup(calls.slice(0, 3))).toBeNull();
  });
});

describe("parsePhaseSummary", () => {
  it("reads counts from the checks.run tool_result", () => {
    expect(parsePhaseSummary({ total: 47, passCount: 45, failCount: 2, noVerdictCount: 0 })).toEqual({
      total: 47,
      passed: 45,
      failed: 2,
      noVerdict: 0,
      checks: new Map(),
    });
  });

  it("keeps no-verdict checks out of the failed count", () => {
    expect(
      parsePhaseSummary({ total: 5, passCount: 2, failCount: 1, noVerdictCount: 2 }),
    ).toEqual({ total: 5, passed: 2, failed: 1, noVerdict: 2, checks: new Map() });
  });

  it("tolerates summaries without a no-verdict count (older SDKs)", () => {
    expect(parsePhaseSummary({ total: 3, passCount: 2, failCount: 1 })).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      noVerdict: 0,
      checks: new Map(),
    });
  });

  it("parses a JSON-string tool_result", () => {
    expect(parsePhaseSummary('{"total":3,"passCount":2,"failCount":1}')).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      noVerdict: 0,
      checks: new Map(),
    });
  });

  it("returns null for missing, malformed, or vacuous summaries", () => {
    expect(parsePhaseSummary(undefined)).toBeNull();
    expect(parsePhaseSummary(null)).toBeNull();
    expect(parsePhaseSummary("not json")).toBeNull();
    expect(parsePhaseSummary({ total: "47" })).toBeNull();
    expect(parsePhaseSummary({ passCount: 1 })).toBeNull();
    // A zero-check run carries no counts worth showing.
    expect(parsePhaseSummary({ total: 0, passCount: 0, failCount: 0 })).toBeNull();
  });

  it("maps each result to its check's verdict", () => {
    const summary = parsePhaseSummary({
      total: 4,
      passCount: 1,
      failCount: 1,
      noVerdictCount: 2,
      results: [
        { id: "reply is short", pass: true, evaluator_type: "code" },
        { id: "ticket describes the problem", pass: false, evaluator_type: "llm" },
        { id: "judge never answered", pass: false, outcome: "error" },
        { id: "no timing evidence", pass: false, outcome: "unsupported" },
        { id: "malformed", pass: "yes" },
        { pass: true },
      ],
    });
    expect(summary!.checks).toEqual(
      new Map<string, RowVerdict>([
        ["reply is short", "pass"],
        ["ticket describes the problem", "fail"],
        ["judge never answered", "no-verdict"],
        ["no timing evidence", "no-verdict"],
      ]),
    );
  });
});

function summaryOf(checks: Array<[string, RowVerdict]>): PhaseSummary {
  const count = (v: RowVerdict) => checks.filter(([, verdict]) => verdict === v).length;
  return {
    total: checks.length,
    passed: count("pass"),
    failed: count("fail"),
    noVerdict: count("no-verdict"),
    checks: new Map(checks),
  };
}

describe("verdictFetchTargets", () => {
  const checkGroup = findEvaluationGroup([
    call("run", "apo.task.run"),
    call("cr", "checks.run", "run"),
    call("c1", "check:reply is short", "cr"),
    call("c2", "check:ticket describes the problem", "cr"),
    call("j2", "judge:ticket describes the problem", "c2"),
  ])!;
  const covering = summaryOf([
    ["reply is short", "pass"],
    ["ticket describes the problem", "fail"],
  ]);
  const ids = (targets: { id: string }[]) => targets.map((c) => c.id);

  it("fetches nothing while the rows are hidden and the summary is usable or pending", () => {
    expect(verdictFetchTargets({ group: checkGroup, phaseSummary: covering, rowsVisible: false })).toEqual([]);
    // Pending: wait for the one summary fetch instead of racing N span ones.
    expect(verdictFetchTargets({ group: checkGroup, phaseSummary: undefined, rowsVisible: false })).toEqual([]);
  });

  it("fetches only the judges while visible rows' checks are covered by the summary", () => {
    expect(
      ids(verdictFetchTargets({ group: checkGroup, phaseSummary: covering, rowsVisible: true })),
    ).toEqual(["j2"]);
    // Search suspends grouping, so the rows are visible while pending too.
    expect(
      ids(verdictFetchTargets({ group: checkGroup, phaseSummary: undefined, rowsVisible: true })),
    ).toEqual(["j2"]);
  });

  it("fetches a visible check the summary does not list", () => {
    const partial = summaryOf([["reply is short", "pass"]]);
    expect(
      ids(verdictFetchTargets({ group: checkGroup, phaseSummary: partial, rowsVisible: true })),
    ).toEqual(["c2", "j2"]);
    expect(verdictFetchTargets({ group: checkGroup, phaseSummary: partial, rowsVisible: false })).toEqual([]);
  });

  it("never fetches a check span under a second checks.run span", () => {
    const group = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("cr", "checks.run", "run"),
      call("c1", "check:reply is short", "cr"),
      call("cr2", "checks.run", "run"),
      call("c1b", "check:reply is short", "cr2"),
    ])!;
    expect(verdictFetchTargets({ group, phaseSummary: null, rowsVisible: true }).map((c) => c.id)).toEqual(["c1"]);
  });

  it("fetches every check, not the judges, for the counts when the summary is unusable", () => {
    expect(
      ids(verdictFetchTargets({ group: checkGroup, phaseSummary: null, rowsVisible: false })),
    ).toEqual(["c1", "c2"]);
    expect(
      ids(verdictFetchTargets({ group: checkGroup, phaseSummary: null, rowsVisible: true })),
    ).toEqual(["c1", "c2", "j2"]);
  });

  it("fetches the judges for the counts on traces without check spans", () => {
    const legacy = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("j1", "judge:reads-well", "run"),
    ])!;
    expect(ids(verdictFetchTargets({ group: legacy, phaseSummary: undefined, rowsVisible: false }))).toEqual(["j1"]);
    const unusable = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("cr", "checks.run", "run"),
      call("j1", "judge:reads-well", "cr"),
    ])!;
    expect(ids(verdictFetchTargets({ group: unusable, phaseSummary: null, rowsVisible: false }))).toEqual(["j1"]);
    expect(verdictFetchTargets({ group: unusable, phaseSummary: undefined, rowsVisible: false })).toEqual([]);
  });
});

describe("rowVerdict", () => {
  const group = findEvaluationGroup([
    call("run", "apo.task.run"),
    call("cr", "checks.run", "run"),
    call("c1", "check:reply is short", "cr"),
    call("c2", "check:ticket describes the problem", "cr"),
    call("j2", "judge:ticket describes the problem", "c2"),
  ])!;
  const byId = (id: string) => [...group.checks, ...group.roots].find((c) => c.id === id)!;

  it("reads a check's verdict from the summary", () => {
    const summary = summaryOf([
      ["reply is short", "no-verdict"],
      ["ticket describes the problem", "fail"],
    ]);
    expect(rowVerdict(byId("c1"), group, summary, {})).toBe("no-verdict");
    // The summary wins over a fetched value for the checks it covers.
    expect(rowVerdict(byId("c2"), group, summary, { c2: "pass" })).toBe("fail");
  });

  it("falls back to the fetched verdict when the summary cannot answer", () => {
    expect(rowVerdict(byId("c1"), group, null, { c1: "pass" })).toBe("pass");
    expect(rowVerdict(byId("c1"), group, summaryOf([["other", "fail"]]), { c1: "fail" })).toBe("fail");
    expect(rowVerdict(byId("c1"), group, undefined, {})).toBeUndefined();
  });

  it("reads a judge's verdict from its own fetch, never the check's summary entry", () => {
    const summary = summaryOf([["ticket describes the problem", "fail"]]);
    expect(rowVerdict(byId("j2"), group, summary, { j2: "pass" })).toBe("pass");
    expect(rowVerdict(byId("j2"), group, summary, {})).toBeUndefined();
  });

  it("keeps a judge directly under checks.run on its own verdict (traces before per-check spans)", () => {
    // judge:<id> and check:<id> share a prefix length, so a name-only lookup
    // would hand the judge its check's summary verdict.
    const legacy = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("cr", "checks.run", "run"),
      call("j1", "judge:quality", "cr"),
    ])!;
    const summary = summaryOf([["quality", "fail"]]);
    expect(rowVerdict(legacy.roots[0]!, legacy, summary, { j1: "pass" })).toBe("pass");
  });
});

describe("evaluationCounts", () => {
  const group = findEvaluationGroup([
    call("run", "apo.task.run"),
    call("cr", "checks.run", "run"),
    call("c1", "check:a", "cr"),
    call("c2", "check:b", "cr"),
    call("c3", "check:c", "cr"),
    call("j3", "judge:c", "c3"),
  ])!;

  it("uses the summary when it is usable", () => {
    const summary = summaryOf([["a", "pass"], ["b", "fail"], ["c", "no-verdict"]]);
    expect(evaluationCounts(group, summary, {})).toMatchObject({ passed: 1, failed: 1, noVerdict: 1 });
  });

  it("counts the checks' fetched verdicts, not the judges', without a summary", () => {
    expect(
      evaluationCounts(group, null, { c1: "pass", c2: "pass", c3: "fail", j3: "pass" }),
    ).toEqual({ passed: 2, failed: 1, noVerdict: 0 });
  });

  it("counts the judges on traces without check spans", () => {
    const legacy = findEvaluationGroup([
      call("run", "apo.task.run"),
      call("j1", "judge:a", "run"),
      call("j2", "judge:b", "run"),
      call("j3", "judge:c", "run"),
    ])!;
    expect(evaluationCounts(legacy, undefined, { j1: "pass", j2: "fail", j3: "no-verdict" })).toEqual({
      passed: 1,
      failed: 1,
      noVerdict: 1,
    });
  });
});

describe("verdictRowLabel", () => {
  const calls = [
    call("run", "apo.task.run"),
    call("cr", "checks.run", "run"),
    call("c1", "check:ticket describes the problem", "cr"),
    call("j1", "judge:ticket describes the problem", "c1"),
    call("a1", "t.agent:ticket describes the problem", "c1"),
    call("c2", "check:another check", "cr"),
    call("j2", "judge:reads-well", "c2"),
    call("j3", "judge:legacy", "cr"),
    call("lint", "check:lint", "run"),
    call("gen", "agent.generate", "run"),
  ];
  const group = findEvaluationGroup(calls)!;
  const byId = new Map(calls.map((c) => [c.id, c]));
  const label = (id: string) => {
    const c = byId.get(id)!;
    return verdictRowLabel(c, group, c.parent_call_id ? byId.get(c.parent_call_id) : undefined);
  };

  it("drops the check: prefix", () => {
    expect(label("c1")).toBe("ticket describes the problem");
  });

  it("names a judge by its kind under the check it judges", () => {
    expect(label("j1")).toBe("judge");
    expect(label("a1")).toBe("t.agent");
  });

  it("keeps a judge's full name anywhere else", () => {
    expect(label("j2")).toBe("judge:reads-well");
    expect(label("j3")).toBe("judge:legacy");
  });

  it("returns null for any other call, check:-named agent spans included", () => {
    expect(label("gen")).toBeNull();
    expect(label("cr")).toBeNull();
    expect(label("lint")).toBeNull();
  });
});

describe("parseCheckSpanVerdict", () => {
  const assistant = (content: string) => ({ messages: [{ role: "assistant", content }] });

  it("reads the verdict from the assistant output the SDK writes", () => {
    const output = assistant('{"pass":false,"reasoning":"missing field","evaluator_type":"code","assertions":[]}');
    expect(parseCheckSpanVerdict({ tool_result: null, output })).toBe("fail");
    expect(parseCheckSpanVerdict({ tool_result: null, output: assistant('{"pass":true}') })).toBe("pass");
  });

  it("reads a verdictless check as no verdict from its outcome", () => {
    expect(
      parseCheckSpanVerdict({ tool_result: null, output: assistant('{"pass":false,"outcome":"error"}') }),
    ).toBe("no-verdict");
    expect(
      parseCheckSpanVerdict({ tool_result: null, output: assistant('{"pass":false,"outcome":"unsupported"}') }),
    ).toBe("no-verdict");
  });

  it("prefers a tool_result verdict", () => {
    expect(parseCheckSpanVerdict({ tool_result: { pass: true }, output: assistant('{"pass":false}') })).toBe("pass");
  });

  it("returns undefined when no output carries a verdict", () => {
    expect(parseCheckSpanVerdict({ tool_result: null, output: null })).toBeUndefined();
    expect(parseCheckSpanVerdict({ tool_result: null, output: { messages: "x" } })).toBeUndefined();
    expect(
      parseCheckSpanVerdict({ tool_result: null, output: { messages: [{ role: "user", content: '{"pass":true}' }] } }),
    ).toBeUndefined();
    expect(parseCheckSpanVerdict({ tool_result: null, output: assistant("check threw") })).toBeUndefined();
    expect(parseCheckSpanVerdict({ tool_result: { pass: null }, output: null })).toBeUndefined();
  });
});

describe("parseJudgeSpanVerdict", () => {
  // Older payloads carry tool_result as a JSON string, outside its declared type.
  const jsonString = (json: string) => json as unknown as TraceObservation["tool_result"];

  it("reads pass and fail", () => {
    expect(parseJudgeSpanVerdict({ tool_result: { reasoning: "ok", pass: true } })).toBe("pass");
    expect(parseJudgeSpanVerdict({ tool_result: jsonString('{"pass":false}') })).toBe("fail");
  });

  it("reads no verdict from an outcome, a null pass, or a judge call that threw", () => {
    expect(parseJudgeSpanVerdict({ tool_result: { pass: false, outcome: "error" } })).toBe("no-verdict");
    expect(parseJudgeSpanVerdict({ tool_result: { reasoning: "x", pass: null } })).toBe("no-verdict");
    expect(parseJudgeSpanVerdict({ tool_result: jsonString('{"pass":null}') })).toBe("no-verdict");
    expect(parseJudgeSpanVerdict({ tool_result: null, level: "ERROR" })).toBe("no-verdict");
  });

  it("leaves a judge without a recorded verdict unknown", () => {
    expect(parseJudgeSpanVerdict({ tool_result: null })).toBeUndefined();
    expect(parseJudgeSpanVerdict({ tool_result: { reasoning: "no flag" }, level: "DEFAULT" })).toBeUndefined();
    expect(parseJudgeSpanVerdict({ tool_result: jsonString("not json") })).toBeUndefined();
    expect(parseJudgeSpanVerdict({ tool_result: { pass: "yes" } })).toBeUndefined();
  });
});

describe("partitionEvaluation", () => {
  const group = findEvaluationGroup([
    call("run", "apo.task.run"),
    call("load", "task.load", "run"),
    call("j1", "judge:reads-well", "run"),
    call("ag", "t.agent:figures", "run"),
    call("t1", "tool read", "ag"),
  ])!;

  it("returns null when no member rows are present", () => {
    expect(partitionEvaluation([row("run", "apo.task.run")], group)).toBeNull();
  });

  it("places the group at the first judge's position (judges last)", () => {
    const rows = [row("run", "apo.task.run"), row("load", "task.load", "run"), row("j1", "judge:reads-well", "run"), row("ag", "t.agent:figures", "run"), row("t1", "tool read", "ag")];
    const split = partitionEvaluation(rows, group)!;
    expect(split.kept.map((r) => r.node.id)).toEqual(["run", "load"]);
    expect(split.insertAt).toBe(2);
  });

  it("keeps order when judges sit mid-tree", () => {
    const rows = [row("run", "apo.task.run"), row("j1", "judge:reads-well", "run"), row("load", "task.load", "run")];
    const split = partitionEvaluation(rows, group)!;
    expect(split.kept.map((r) => r.node.id)).toEqual(["run", "load"]);
    expect(split.insertAt).toBe(1);
  });

  it("handles rows without a call (the synthetic run header)", () => {
    const rows: PartitionableRow[] = [
      { node: { id: "root-run", call: null } },
      row("j1", "judge:reads-well", "run"),
    ];
    const split = partitionEvaluation(rows, group)!;
    expect(split.kept.map((r) => r.node.id)).toEqual(["root-run"]);
    expect(split.insertAt).toBe(1);
  });

  it("places the group where the checks.run span sat", () => {
    const calls = [
      call("run", "apo.task.run"),
      call("load", "task.load", "run"),
      call("cr", "checks.run", "run"),
      call("j1", "judge:reads-well", "cr"),
    ];
    const spanGroup = findEvaluationGroup(calls)!;
    const rows = calls.map((c) => row(c.id, c.step_name!, c.parent_call_id));
    const split = partitionEvaluation(rows, spanGroup)!;
    expect(split.kept.map((r) => r.node.id)).toEqual(["run", "load"]);
    expect(split.insertAt).toBe(2);
  });
});

describe("evaluationSubtreeRows", () => {
  it("renders members when expanded but never the phase span's own row", () => {
    const calls = [
      call("run", "apo.task.run"),
      call("cr", "checks.run", "run"),
      call("j1", "judge:reads-well", "cr"),
      call("ag", "t.agent:figures", "cr"),
      call("t1", "tool read", "ag"),
    ];
    const group = findEvaluationGroup(calls)!;
    const rows = calls.map((c) => row(c.id, c.step_name!, c.parent_call_id));
    // The group header already represents the checks.run span — rendering its
    // raw row inside the expanded group duplicates it.
    expect(evaluationSubtreeRows(rows, group).map((r) => r.node.id)).toEqual([
      "j1",
      "ag",
      "t1",
    ]);
  });

  it("keeps every member row on legacy traces (no span to suppress)", () => {
    const calls = [
      call("run", "apo.task.run"),
      call("j1", "judge:reads-well", "run"),
    ];
    const group = findEvaluationGroup(calls)!;
    const rows = calls.map((c) => row(c.id, c.step_name!, c.parent_call_id));
    expect(evaluationSubtreeRows(rows, group).map((r) => r.node.id)).toEqual(["j1"]);
  });
});

describe("judgmentFacts", () => {
  function judgeCall(overrides: Partial<TraceObservation> = {}): TraceObservation {
    return {
      id: "j1",
      step_name: "t.agent:figures-supported-by-work",
      parent_call_id: "run",
      input: {
        messages: [
          {
            role: "system",
            content:
              '{"model":"deepseek/deepseek-v4.1-flash","instruction":"PASS if figures are supported."}',
          },
        ],
      },
      tool_result: { reasoning: "All figures match.", pass: true },
      latency_ms: 7862,
      ...overrides,
    } as TraceObservation;
  }

  it("returns null for non-judgment calls", () => {
    expect(judgmentFacts(call("gen", "agent.generate"), [])).toBeNull();
  });

  it("extracts instruction, model, verdict, kind, and latency", () => {
    const facts = judgmentFacts(judgeCall(), [call("t1", "tool read", "j1"), call("t2", "tool search", "j1"), call("x", "other", "run")]);
    expect(facts).toEqual({
      name: "figures-supported-by-work",
      kind: "t.agent",
      model: "deepseek/deepseek-v4.1-flash",
      instruction: "PASS if figures are supported.",
      reasoning: "All figures match.",
      verdict: "pass",
      toolChildren: 2,
      latencyMs: 7862,
    });
  });

  it("strips the judge: prefix and keeps kind t.judge", () => {
    const facts = judgmentFacts(judgeCall({ step_name: "judge:summary-reads-well", tool_result: null }) as TraceObservation, []);
    expect(facts!.name).toBe("summary-reads-well");
    expect(facts!.kind).toBe("t.judge");
    expect(facts!.verdict).toBeUndefined();
    expect(facts!.reasoning).toBeUndefined();
  });

  it("reads the verdict the tree row shows: no verdict is not a fail", () => {
    const unavailable = judgmentFacts(
      judgeCall({ step_name: "judge:a", tool_result: { reasoning: "no flag", pass: false, outcome: "error" } }),
      [],
    );
    expect(unavailable!.verdict).toBe("no-verdict");
    const threw = judgmentFacts(judgeCall({ step_name: "judge:a", tool_result: null, level: "ERROR" }), []);
    expect(threw!.verdict).toBe("no-verdict");
  });

  it("tolerates a non-JSON system message", () => {
    const facts = judgmentFacts(
      judgeCall({ input: { messages: [{ role: "system", content: "free-form briefing" }] } }) as TraceObservation,
      [],
    );
    expect(facts).not.toBeNull();
    expect(facts!.model).toBeUndefined();
    expect(facts!.instruction).toBeUndefined();
  });
});
