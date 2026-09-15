// PROTOTYPE (throwaway) — the t.agent tool surface over the frozen evidence.
// All tools are read-only functions; finish_verdict is a done-tool (no execute)
// so the ONLY exits are the verdict or the step cap.
import { tool } from "ai";
import { z } from "zod";
import { fetchHistoryRunChecks } from "./evidence.mjs";

const MAX_READ_BYTES = 6000;

function truncate(text, max = MAX_READ_BYTES) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} more bytes; use offset/limit]`;
}

export function buildToolkit(evidence) {
  const { runUnderJudgment: run, history } = evidence;

  return {
    list_evidence: tool({
      description: "Catalog of available evidence: deliverables, checks, task definition, trace status, and this task's run history.",
      inputSchema: z.object({}),
      execute: async () => ({
        deliverables: Object.values(run.deliverables).map((d) => ({ name: d.name, kind: d.kind, bytes: d.bytes })),
        checks: run.checks.map((c) => ({ id: c.id, pass: c.pass, evaluator: c.evaluator_type })),
        task_definition_available: !!run.task_definition,
        trace: { status: "pending", note: "trace projection not materialized for this run" },
        history_runs: history.map((h) => ({ id: h.id, status: h.status, passed: h.passed })),
      }),
    }),

    read_deliverable: tool({
      description: "Read a deliverable's content by name, with optional offset/limit for pagination (max 12000 bytes per call).",
      inputSchema: z.object({
        name: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(12000).default(6000),
      }),
      execute: async ({ name, offset, limit }) => {
        const d = run.deliverables[name];
        if (!d) return { error: `unknown deliverable: ${name}` };
        const slice = d.content.slice(offset, offset + limit);
        return { name, total_bytes: d.bytes, offset, returned: slice.length, content: slice };
      },
    }),

    search_deliverable: tool({
      description:
        "Regex-search a deliverable for a pattern; returns up to 8 matches with 400 chars of surrounding context each. " +
        "Cheaper than reading a large deliverable end to end — use it to locate the relevant computation.",
      inputSchema: z.object({
        name: z.string(),
        pattern: z.string().describe("JavaScript regex, e.g. 'aci|fee' or '39\\\\.17'"),
      }),
      execute: async ({ name, pattern }) => {
        const d = run.deliverables[name];
        if (!d) return { error: `unknown deliverable: ${name}` };
        let re;
        try {
          re = new RegExp(pattern, "gi");
        } catch (e) {
          return { error: `invalid regex: ${e.message}` };
        }
        const hits = [];
        let m;
        while ((m = re.exec(d.content)) && hits.length < 8) {
          const start = Math.max(0, m.index - 400);
          hits.push({ at_byte: m.index, context: d.content.slice(start, m.index + m[0].length + 400) });
          if (m.index === re.lastIndex) re.lastIndex++;
        }
        return { total_bytes: d.bytes, match_count: hits.length, matches: hits };
      },
    }),

    get_task_definition: tool({
      description: "The task definition this run executed: description, deliverable names, metadata.",
      inputSchema: z.object({}),
      execute: async () => run.task_definition ?? { error: "task definition not available" },
    }),

    trace: tool({
      description: "Query the run's execution trace (tool calls, messages). Answers honestly when the trace is unavailable.",
      inputSchema: z.object({ query: z.string().describe("what you want from the trace") }),
      execute: async () => ({
        status: "unsupported",
        detail: "trace projection is 'pending' for this run — no tool-call or message evidence exists. Judge on deliverables, checks, and history instead.",
      }),
    }),

    list_runs: tool({
      description: "Previous attempts of THIS task (frozen at session start): status, pass/fail, model, timing.",
      inputSchema: z.object({}),
      execute: async () => history,
    }),

    get_run_checks: tool({
      description: "Full check report of a previous run: per-check pass/fail with reasoning, expected/received.",
      inputSchema: z.object({ run_id: z.string() }),
      execute: async ({ run_id }) => {
        const known = history.find((h) => h.id === run_id);
        if (!known) return { error: "run not in this task's history" };
        const checks = await fetchHistoryRunChecks(run_id);
        return checks.map((c) => ({
          id: c.id, pass: c.pass, evaluator: c.evaluator_type,
          reasoning: truncate(c.reasoning ?? "", 500),
          assertions: (c.assertions ?? []).map((a) => ({
            pass: a.pass, expected: truncate(String(a.expected ?? ""), 200), received: truncate(String(a.received ?? ""), 200),
          })),
        }));
      },
    }),

    get_corrections: tool({
      description: "Human corrections to verdicts on this task's runs: which tests were flipped, by whom.",
      inputSchema: z.object({}),
      execute: async () => {
        const corrections = history.flatMap((h) =>
          (h.corrected_tests ?? []).map((c) => ({ run_id: h.id, ...c })),
        );
        return corrections.length
          ? corrections
          : { status: "none", detail: "no human corrections recorded on this task's runs" };
      },
    }),

    // Done-tool pattern: schema, NO execute — termination signal.
    finish_verdict: tool({
      description: "End the session with your final verdict. reasoning must cite the evidence you relied on.",
      inputSchema: z.object({
        reasoning: z.string(),
        pass: z.boolean(),
      }),
    }),
  };
}

export { truncate };
