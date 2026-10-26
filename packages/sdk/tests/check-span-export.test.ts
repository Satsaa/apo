/**
 * A `check:<id>` span exported through the real OTel trace client. The
 * verdict must reach the backend as structured JSON on
 * `gen_ai.tool.call.result` (its tool_result, which the trace view renders as
 * a JSON tree), with the assistant-message channel carrying only the
 * reasoning. Exported as a bare object it became an assistant message whose
 * text was the verdict's JSON, and the trace view printed it as chat text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { createOtelAgentTaskTraceClient } from "../src/agent-task/otel-trace-client.ts";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { includes, satisfies } from "../src/agent-task/checks/matchers.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

const captured = vi.hoisted(() => ({ exporter: undefined as InMemorySpanExporter | undefined }));

vi.mock("../src/otel/index.ts", async () => {
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
    "@opentelemetry/sdk-trace-base"
  );
  return {
    configureApoTelemetry: async () => {
      const exporter = new InMemorySpanExporter();
      captured.exporter = exporter;
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      return {
        tracer: provider.getTracer("test"),
        forceFlush: async () => {},
        shutdown: async () => {},
      };
    },
  };
});

const emptySnapshot: TraceProjectionSnapshot = {
  schemaVersion: 1,
  projectionVersion: 1,
  source: "local",
  trace: { traceId: "test", complete: true },
  capabilities: {
    messages: "unavailable",
    tools: "unavailable",
    errors: "available",
    timing: "available",
    skills: "unavailable",
    subagents: "unavailable",
  },
  observations: [],
};

afterEach(() => {
  resetFlowChecks();
});

async function exportedCheckSpan(checkId: string) {
  const client = createOtelAgentTaskTraceClient({
    endpoint: "http://127.0.0.1:9",
    project: "check-span-export",
  });
  await client.traceRun({ project: "check-span-export", flow_name: "checks" }, (trace) =>
    runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeTracer: trace }),
  );
  const span = captured.exporter?.getFinishedSpans().find((s) => s.name === `check:${checkId}`);
  if (!span) throw new Error(`no check:${checkId} span exported`);
  return span.attributes;
}

describe("check span export", () => {
  it("exports the verdict as a JSON tool result and the reasoning as the message text", async () => {
    const ticket = `Ticket body\n${"x".repeat(5 * 1024)}`;
    defineCheck("ticket-is-anonymized", (t) => {
      t.check(ticket, includes("Ticket body"));
      t.check(
        ticket,
        satisfies((s: string) => !s.includes("Harrowgate"), 'no "Harrowgate"'),
      );
    });

    const attributes = await exportedCheckSpan("ticket-is-anonymized");

    const verdict = JSON.parse(String(attributes["gen_ai.tool.call.result"])) as unknown;
    expect(verdict).toMatchObject({
      pass: true,
      reasoning: "passed",
      evaluator_type: "code",
      assertions: [
        { id: "check", pass: true, received: { kind: "truncated" } },
        { id: "check", pass: true, expected: 'no "Harrowgate"', received: { kind: "truncated" } },
      ],
    });
    expect(JSON.parse(String(attributes["gen_ai.output.messages"]))).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "passed" }] },
    ]);
  });

  it("carries a failing check's reasoning as the message text", async () => {
    defineCheck("names-the-tool", (t) => {
      t.check("a ticket without the tool name", includes("docxApplyEdits"));
    });

    const attributes = await exportedCheckSpan("names-the-tool");

    const verdict = JSON.parse(String(attributes["gen_ai.tool.call.result"])) as {
      pass: boolean;
      reasoning: string;
    };
    expect(verdict.pass).toBe(false);
    expect(attributes["gen_ai.response.text"]).toBe(verdict.reasoning);
  });
});
