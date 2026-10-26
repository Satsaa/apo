import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LoggedCall } from "../contexts";
import { JudgmentBrief } from "../JudgmentBrief";

function judge(overrides: Partial<LoggedCall>): LoggedCall {
  return {
    id: "j1",
    step_name: "judge:ticket describes the problem",
    parent_call_id: "c1",
    input: { messages: [{ role: "system", content: '{"model":"stub-judge","instruction":"PASS if it does."}' }] },
    output: null,
    ...overrides,
  } as LoggedCall;
}

function brief(call: LoggedCall) {
  render(<JudgmentBrief call={call} allCalls={[call]} loading={false} />);
  return {
    badge: document.querySelector("[data-verdict]")!,
    reasoning: screen.getByText("Why it ruled this way").nextElementSibling!,
  };
}

describe("JudgmentBrief", () => {
  it("shows a pass in green", () => {
    const { badge, reasoning } = brief(judge({ tool_result: { reasoning: "states the problem", pass: true } }));
    expect(badge).toHaveAttribute("data-verdict", "pass");
    expect(badge).toHaveClass("text-success", "px-1.5", "tracking-wide");
    expect(reasoning).not.toHaveClass("text-destructive");
  });

  it("shows a judge without a recorded verdict as unknown", () => {
    const { badge, reasoning } = brief(judge({ tool_result: null }));
    expect(badge).toHaveAttribute("data-verdict", "unknown");
    expect(reasoning).not.toHaveClass("text-destructive");
  });

  it("shows a fail in red", () => {
    const { badge, reasoning } = brief(judge({ tool_result: { reasoning: "too vague", pass: false } }));
    expect(badge).toHaveAttribute("data-verdict", "fail");
    expect(badge).toHaveClass("text-destructive");
    expect(reasoning).toHaveClass("text-destructive");
  });

  it("shows a judge that gave no verdict the way the tree row does, not as a fail", () => {
    const { badge, reasoning } = brief(
      judge({ tool_result: { reasoning: "Judge reply carried no verdict", pass: false, outcome: "error" } }),
    );
    expect(badge).toHaveAttribute("data-verdict", "no-verdict");
    expect(reasoning).not.toHaveClass("text-destructive");
  });
});
