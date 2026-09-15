// PROTOTYPE (throwaway) — evidence loader for the t.agent judge prototype.
// Pulls a real run's evidence from the local apo backend and freezes it into
// an in-memory store, the way Phase 2 would hand it to a judge session.
// Run under judgment comes in as frozen data; history is a frozen list with
// lazy per-run detail fetches (still read-only API reads).
import { readFileSync } from "node:fs";

const creds = JSON.parse(readFileSync(`${process.env.HOME}/.apo/credentials`, "utf8"));
const BASE = creds.backend_url;
const KEY = creds.api_key;

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export async function loadEvidence(runId) {
  const detail = await api(`/v1/agent-task-runs/${runId}`);
  const checks = typeof detail.checks_json === "string" ? JSON.parse(detail.checks_json) : detail.checks_json;

  // The human-readable task question lives in the pinned definition source
  // (the .eval.ts), not the run row. Extract its `description:` literal.
  let task_description = null;
  let task_source = null;
  try {
    const src = await api(`/v1/agent-task-runs/${runId}/definition-source`);
    const evalFile = src.files?.find((f) => f.path.endsWith(".eval.ts"));
    if (evalFile) {
      task_source = evalFile.content;
      const m = evalFile.content.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) task_description = m[1].replaceAll('\\"', '"');
    }
  } catch {
    // definition source unavailable — judges see null and must cope
  }

  const deliverables = {};
  const dl = await api(`/v1/agent-task-runs/${runId}/deliverables`);
  for (const item of dl.items) {
    const body = await fetch(`${BASE}${item.download_url}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    }).then((r) => r.text());
    deliverables[item.name] = { ...item, content: body, bytes: body.length };
  }

  // Frozen history snapshot: every run of the same task, newest first.
  const history = await api(`/v1/agent-task-runs?task_id=${encodeURIComponent(detail.task_id)}&limit=50`);

  return {
    runUnderJudgment: {
      id: detail.id,
      task_id: detail.task_id,
      task_definition: detail.task_definition ?? null,
      task_description,
      task_source,
      primary_model: detail.primary_model,
      status: detail.status,
      started_at: detail.started_at,
      total_cost: detail.total_cost,
      checks,
      corrected_tests: detail.corrected_tests ?? [],
      deliverables,
    },
    history: history.map((r) => ({
      id: r.id,
      status: r.status,
      passed: r.pass_result,
      started_at: r.started_at,
      passed_checks: r.passed_checks,
      failed_checks: r.failed_checks,
      primary_model: r.primary_model,
      corrected_tests: r.corrected_tests ?? [],
    })),
  };
}

// Lazy detail fetch for a history run (judge tool, read-only).
export async function fetchHistoryRunChecks(runId) {
  const detail = await api(`/v1/agent-task-runs/${runId}`);
  return typeof detail.checks_json === "string" ? JSON.parse(detail.checks_json) : detail.checks_json;
}

export const backendInfo = { BASE };
