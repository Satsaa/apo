import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/automations-list.ts";
import { stripAnsi } from "../src/lib/format.ts";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

const AUTOMATION = {
  id: "b3f1abc",
  name: "Nightly failures",
  event_type: "batch_run.failed",
  action_type: "github_issue",
  action_config: { owner: "acme", repo: "agent-harness" },
  enabled: true,
  consecutive_failures: 0,
  last_delivery_status: "success",
};

describe("automations list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a table of automations", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse([AUTOMATION]));
    const { logs, restore } = captureLog();
    try {
      const code = await run([
        "--backend",
        "http://localhost:8000",
        "--project",
        "proj-a",
        "--api-key",
        "apo_test",
      ]);
      expect(code).toBe(0);
      const out = stripAnsi(logs.join("\n"));
      expect(out).toContain("Nightly failures");
      expect(out).toContain("batch_run.failed");
      expect(out).toContain("acme/agent-harness");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/v1/automations?project_id=proj-a"),
        expect.anything(),
      );
    } finally {
      restore();
    }
  });

  it("emits JSON with --json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse([AUTOMATION]));
    const { logs, restore } = captureLog();
    try {
      const code = await run([
        "--backend",
        "http://localhost:8000",
        "--project",
        "proj-a",
        "--api-key",
        "apo_test",
        "--json",
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed[0].name).toBe("Nightly failures");
    } finally {
      restore();
    }
  });

  it("reports empty state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse([]));
    const { logs, restore } = captureLog();
    try {
      const code = await run([
        "--backend",
        "http://localhost:8000",
        "--project",
        "proj-a",
        "--api-key",
        "apo_test",
      ]);
      expect(code).toBe(0);
      expect(stripAnsi(logs.join("\n"))).toContain("No automations found");
    } finally {
      restore();
    }
  });

  it("reports backend errors with a non-zero exit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ detail: "boom" }, 500),
    );
    const code = await run([
      "--backend",
      "http://localhost:8000",
      "--project",
      "proj-a",
      "--api-key",
      "apo_test",
    ]);
    expect(code).not.toBe(0);
  });
});
