import { afterEach, describe, expect, it, vi } from "vitest";
import { run as batchShow } from "../src/commands/batch-show.ts";
import { stripAnsi } from "../src/lib/format.ts";

const ID = "bch_0123456789abcdef01234567";

function batch(overrides: Record<string, unknown> = {}): Response {
  const body = {
    id: ID,
    project: "p",
    status: "completed",
    total_tasks: 0,
    passed_tasks: 0,
    failed_tasks: 0,
    errored_tasks: 0,
    total_cost: null,
    created_at: "2026-06-29T10:00:00Z",
    started_at: null,
    completed_at: null,
    trigger: { source: "dashboard", actor: null, hostname: null, entrypoint: "/tasks" },
    task_runs: [],
    ...overrides,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function show(response: Response): Promise<string> {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    await batchShow([ID, "--backend", "http://backend.test"]);
  } finally {
    console.log = log;
  }
  return stripAnsi(lines.join("\n"));
}

describe("batch show requester", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints who requested the batch", async () => {
    const out = await show(batch({ requested_by_label: "runner@test.com" }));
    expect(out).toContain("Requested by: runner@test.com");
  });

  it("omits the line for a batch with no recorded requester", async () => {
    const out = await show(batch({ requested_by_label: null }));
    expect(out).not.toContain("Requested by");
  });
});
