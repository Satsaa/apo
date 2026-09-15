// PROTOTYPE (throwaway) — single-shot judge baseline, mimicking today's
// callJudge: one OpenAI-compatible completion, temp 0, json_object,
// reasoning-first contract. The author passes the deliverable value the way
// the demo eval's Layer 3 does — the answer only.
// Usage: node single-shot.mjs [run_id] [model]
import { loadEvidence } from "./evidence.mjs";

const RUN_ID = process.argv[2] ?? "run_4179efedd2b601a1a8a6672d";
const MODEL = process.argv[3] ?? "z-ai/glm-5.3-flash";

const evidence = await loadEvidence(RUN_ID);
const run = evidence.runUnderJudgment;
const task = { description: run.task_description };
const answer = run.deliverables.answer?.content ?? "(missing)";

// What the author hands the judge today: task description + the judged value.
const system =
  "You are an evaluation judge. Evaluate the given value(s) against the instruction. " +
  'Respond with JSON: {"reasoning": "...", "pass": true|false}.';
const user = [
  `Task description: ${task.description ?? "(unavailable)"}`,
  "",
  "Values to evaluate:",
  `  answer: ${answer}`,
  "",
  "Instruction:",
  "PASS if the submitted final answer responds to the question the task actually asked,",
  "as evidenced by the run's own work. FAIL if the answer computes a plausible but DIFFERENT",
  "quantity than the task asked for, or is unsupported by the work shown.",
  "Explicitly adjudicate: an answer that is numerically plausible but answers a different",
  "slice/variant of the question is a FAIL.",
].join("\n");

const t0 = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }),
}).then((r) => r.json());

const text = res.choices?.[0]?.message?.content ?? "";
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { parsed = JSON.parse(m[0]); } catch {}
}

console.log(JSON.stringify({
  run_under_judgment: RUN_ID,
  model: MODEL,
  latency_ms: Date.now() - t0,
  cost_usd: res.usage?.cost ?? null,
  verdict: parsed ? { reasoning: parsed.reasoning, pass: parsed.pass } : "UNPARSEABLE — fail closed",
  raw: parsed ? undefined : text.slice(0, 300),
}, null, 2));
