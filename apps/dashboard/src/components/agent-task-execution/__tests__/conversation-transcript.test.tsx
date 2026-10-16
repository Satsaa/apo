import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConversationTranscript } from "../conversation-transcript";
import type { ChatMessage } from "@/lib/conversation-from-trace";

/**
 * Like a real structured answer: leaves two levels down, and substance in
 * string values well past the tree's 120-char truncation point.
 */
const LONG_FINDING =
  "The agreement is a three-year master services agreement with a mutual " +
  "termination-for-convenience right on 90 days notice, and the exhibits it " +
  "incorporates are expressly absent.";

const structuredAnswer = JSON.stringify({
  gist: LONG_FINDING,
  exhibits_missing: true,
  notes: [
    { sev: "high", what: "Exhibits are incorporated but absent." },
    { sev: "medium", what: "Transition costs are open-ended." },
  ],
});

function transcript(messages: ChatMessage[]) {
  return render(<ConversationTranscript conversation={messages} />);
}

/** ExpandableJson's filter box — present only when a tree was rendered. */
function jsonTree(): HTMLElement | null {
  return screen.queryByLabelText("Filter JSON content");
}

/** Markdown puts the whole message in one paragraph; a tree never does. */
function paragraphWith(text: string): boolean {
  return Array.from(document.querySelectorAll("p")).some((p) =>
    p.textContent?.includes(text),
  );
}

describe("ConversationTranscript message content", () => {
  it("renders an assistant answer that is a JSON payload as a tree", () => {
    transcript([{ role: "assistant", content: structuredAnswer }]);

    expect(jsonTree()).toBeInTheDocument();
    expect(paragraphWith("exhibits_missing")).toBe(false);
  });

  it("shows every finding without a click — the answer is not reference material", () => {
    transcript([{ role: "assistant", content: structuredAnswer }]);

    // Both notes are at depth 2, which the tree's default policy would collapse.
    expect(screen.getByText(/Exhibits are incorporated/)).toBeInTheDocument();
    expect(screen.getByText(/Transition costs are open-ended/)).toBeInTheDocument();
  });

  it("shows long string values whole — the substance lives in exactly those", () => {
    transcript([{ role: "assistant", content: structuredAnswer }]);

    // The default policy elides a string past 120 chars and marks the rest.
    expect(screen.getByText(new RegExp(LONG_FINDING.slice(-40)))).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+ chars\)/)).toBeNull();
  });

  it("renders a prose answer as markdown", () => {
    transcript([
      { role: "assistant", content: "## Findings\n\nThe term is **five** years." },
    ]);

    expect(jsonTree()).toBeNull();
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getByText("five").tagName).toBe("STRONG");
  });

  it("renders a user message that is a JSON payload as a tree", () => {
    transcript([{ role: "user", content: '{"task":"review","paragraphs":"116-190"}' }]);

    expect(jsonTree()).toBeInTheDocument();
    expect(paragraphWith("paragraphs")).toBe(false);
  });
});

const LONG_COMMAND =
  "ls -la /home/user/workspace/contracts/__uploads__user_3DzHNaS4vNmSqtYzQjm57s8lxcT__/" +
  "nordlys-employment-contract-laura-niemi._JHgBJ7wuBqt7OA6vcT_W/";

function toolCall(name: string, args: unknown): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

describe("ConversationTranscript tool calls", () => {
  it("shows a call's scalar arguments as labelled rows, whole, without a click", () => {
    transcript([toolCall("bash", { command: LONG_COMMAND, timeout: 30 })]);

    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText(LONG_COMMAND)).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+ chars\)/)).toBeNull();
  });

  it("opens nested arguments as a full tree", () => {
    transcript([
      toolCall("edit", { path: "/a.docx", edits: [{ find: "five years", replace: "three years" }] }),
    ]);

    expect(screen.getByText("edit path: /a.docx +1 more")).toBeInTheDocument();
    // The row inside the edits array, depth 2, which the summary policy collapses.
    expect(jsonTree()).toBeInTheDocument();
    const inBody = screen.getAllByText(/three years/).filter((el) => !el.closest("button"));
    expect(inBody.length).toBeGreaterThan(0);
  });

  it("keeps very large nested arguments collapsed instead of mounting every row", () => {
    const edits = Array.from({ length: 1_001 }, (_, index) => ({
      find: `before-${index}`,
      replace: `after-${index}`,
    }));
    transcript([toolCall("edit", { path: "/a.docx", edits })]);

    expect(jsonTree()).toBeInTheDocument();
    expect(screen.queryByText("after-1000")).toBeNull();
    expect(screen.getByText("Array(1001)")).toBeInTheDocument();
  });

  it("summarizes the call by its values on the message row", () => {
    transcript([toolCall("read", { path: "/home/user/a.docx" })]);

    expect(screen.getByText("read path: /home/user/a.docx")).toBeInTheDocument();
  });

  it("keeps plain-text tool output verbatim, line breaks included", () => {
    const stdout = "total 20\ndrwxr-xr-x 2 user user 4096 .\n-rw-r--r-- 1 user user 512 a.docx";
    transcript([{ role: "tool", content: stdout }]);

    const pre = Array.from(document.querySelectorAll("pre")).find((el) =>
      el.textContent === stdout,
    );
    expect(pre).toBeDefined();
    expect(jsonTree()).toBeNull();
  });
});
