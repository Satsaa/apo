# PROTOTYPE NOTES — t.agent judge loop (wayfinder #261)

**Question:** does a minimal agentic-judge tool loop over real apo evidence
work in practice — tool schemas, budgets, transcripts, failure modes,
cost/latency vs single-shot `t.judge`, and at least one rubric single-shot
fumbles but the loop nails?

**Verdict: YES — and it produced the exact demo the ticket wanted.** This
directory is throwaway evidence; the answer below is the keepable part.

## How to run

```
cd packages/sdk/prototypes/agent-judge
npm i
node single-shot.mjs [run_id] [model]     # baseline mimicking today's t.judge
node run.mjs [run_id] [model]             # agentic session
```

Uses `~/.apo/credentials` (local backend) + `OPENROUTER_API_KEY`.
Judge subject: real backend run `run_4179efedd2b601a1a8a6672d` — a FAILED
dabstep task (`lowest-fee-aci-january`) whose only failing check was
`answer-matches-benchmark` (expected `E:13.57`, agent submitted `All:39.17`).

## Headline result (the rubric single-shot fumbles, the loop nails)

Same rubric, same judge family, same model where possible:

| | single-shot (glm-5.3-flash) | agentic glm-5.3-flash | agentic deepseek-v4-flash |
|---|---|---|---|
| verdict | **PASS (wrong)** | **FAIL (correct)** | **FAIL (correct)** |
| cost | $0.0031 | $0.0042 | $0.0033 |
| latency | 86 s | 253 s | 220 s |
| steps | 1 | 8 | 8 |

- **Single-shot hallucinated a verification**: with only the task description
  and the answer value, it *invented* a fee-schedule fact ("ACI is not a fee
  determinant — all ACIs are fee-equivalent, total stays 39.17") to rationalize
  the wrong answer into a PASS. It has no data access; the "fact" is false
  (ground truth E:13.57 proves a cheaper ACI exists).
- **The agentic sessions did real forensics**: traced the agent's own python in
  `tool_log` (94 fraud txns isolated, fees.json rule filters enumerated),
  diagnosed the actual bug (glm: excluded capture_delay + hard-coded filters;
  deepseek: permissive aci=None/empty rules → degenerate tie across ACIs →
  "All"), distinguished "wrong answer to right question" from "right answer to
  wrong question", and — unprompted — cross-referenced prior runs via
  `get_run_checks` to confirm the benchmark expectation. History tools earned
  their place in v1 in the very first session.

## Failure modes observed (and the fixes that worked)

1. **Model answers in prose instead of calling tools** → text-only step ends
   the loop, no verdict. Fix: `toolChoice: "required"` — every step calls a
   tool; exits become finish_verdict or the cap only.
2. **Weak model reads forever** (gemini-2.5-flash-lite: 7× same
   read_deliverable) → step cap → fail-closed null verdict. Model floor is
   real: tool discipline is a capability, not a given.
3. **Pagination trap** (glm first attempt): 3 KB read windows meant a 27 KB
   tool_log cost 9 steps; budget died before verdict. Fixes that worked:
   bigger windows (12 KB max), a `search_deliverable` regex tool (locate the
   computation instead of reading everything), and an evidence-efficiency nudge
   in the briefing. After the fix: 8 steps, verdict, on both models.
4. **Capability honesty exercised for real**: every dabstep trace projection
   is `pending`; the `trace` tool answered `unsupported` and both models
   proceeded on deliverables/history without breaking.

## Tool-shape lessons for the real implementation

- `list_evidence` first is right — both models opened with it (+ task
  definition) and planned from the catalog.
- Parallel tool calls in one step are natural and cheap — models batched
  reads; the recorder must handle multi-call steps (AI SDK does).
- Read tools need: generous max windows, offset/limit, AND a search variant.
  Search-over-read is the difference between 3 and 9 steps on medium blobs.
- History tools (`list_runs`, `get_run_checks`, `get_corrections`) were used
  immediately and responsibly by both models. `get_run_checks` on a PRIOR run
  was the key move confirming the benchmark value.
- The done-tool `finish_verdict` (schema, no execute) worked exactly as
  designed on both models; `stopWhen: [stepCountIs(N)]` is the hard backstop.

## Budgets & cost profile (from real sessions)

- 8 steps ≈ $0.003–0.004 with cheap 2026 models — 1.1–1.4× the single-shot
  call, NOT the feared 2–10×. Prompt-cache economics still matter for
  `--samples` (transformRequestBody injection verified in the engine spike).
- **Latency is the real cost**: 220–253 s per session (reasoning-heavy cheap
  models). Fine for Phase-2/rejudge batch evaluation; rules out interactive
  use. A faster non-reasoning judge model would halve it if verdict quality
  holds — untested.
- Steps are a stable budget axis (both models: 8). Token-budget stop
  conditions exist in the engine but went untested.

## What this prototype did NOT answer

- The `unknown` verdict path (insufficient evidence WITH tools available) —
  never triggered; needs a dedicated fixture.
- Injection hardening — untrusted tool_log content flowed through both models
  without incident here, but that's one sample, not a claim.
- Multi-sample stability of agentic sessions (feeds the validation ticket).
- Recording caps — transcripts here were printed, not compacted (feeds the
  recording-schema ticket).

## Disposition

Answer captured here + ticket #261 resolution + `project/design-agent-as-judge.md`.
Directory stays until the real `t.agent` lands, then delete or absorb.
