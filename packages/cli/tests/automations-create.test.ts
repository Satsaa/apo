import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/automations-create.ts";

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

const BASE = ["--backend", "http://localhost:8000", "--api-key", "apo_test"];

describe("automations create", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a webhook automation and prints the one-time secret", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        mockResponse({ id: "a1", name: "hook", secret: "whsec_abc" }),
      );
    const { logs, restore } = captureLog();
    try {
      const code = await run([
        ...BASE,
        "--project",
        "proj-a",
        "--name",
        "hook",
        "--event",
        "task_run.completed",
        "--action",
        "webhook",
        "--url",
        "https://example.com/hook",
      ]);
      expect(code).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("Created automation hook");
      expect(out).toContain("whsec_abc");
      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(String(init.body));
      expect(body.action_type).toBe("webhook");
      expect(body.action_config.url).toBe("https://example.com/hook");
    } finally {
      restore();
    }
  });

  it("passes parsed conditions through", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse({ id: "a2", name: "n" }));
    const code = await run([
      ...BASE,
      "--project",
      "proj-a",
      "--name",
      "n",
      "--event",
      "batch_run.failed",
      "--condition",
      '{"field":"trigger.source","operator":"eq","value":"schedule"}',
      "--url",
      "https://example.com/hook",
    ]);
    expect(code).toBe(0);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.conditions).toEqual([
      { field: "trigger.source", operator: "eq", value: "schedule" },
    ]);
  });

  it("rejects malformed --condition JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const code = await run([
      ...BASE,
      "--project",
      "proj-a",
      "--name",
      "n",
      "--event",
      "batch_run.failed",
      "--condition",
      "not-json",
      "--url",
      "https://example.com/hook",
    ]);
    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a github token for github_issue actions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const code = await run([
      ...BASE,
      "--project",
      "proj-a",
      "--name",
      "n",
      "--event",
      "batch_run.failed",
      "--action",
      "github_issue",
      "--owner",
      "acme",
      "--repo",
      "harness",
    ]);
    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
