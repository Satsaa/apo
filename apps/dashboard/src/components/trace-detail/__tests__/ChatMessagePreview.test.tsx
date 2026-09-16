import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessagePreview } from "../ChatMessagePreview";

/** The shape a worker sub-agent's structured answer arrives in: JSON as text. */
const structuredAnswer = JSON.stringify({
  gist: "Termination, confidentiality, and general provisions.",
  notes: [{ sev: "high", what: "Exhibits are incorporated but absent." }],
});

/** The message body, excluding any tool-call block rendered beside it. */
function contentBlock(container: HTMLElement): HTMLElement {
  const bubble = container.querySelector(".text-sm");
  expect(bubble).not.toBeNull();
  return bubble as HTMLElement;
}

describe("ChatMessagePreview message content", () => {
  it("indents an assistant message that is a JSON payload", () => {
    const { container } = render(
      <ChatMessagePreview
        data={{ messages: [{ role: "assistant", content: structuredAnswer }] }}
      />,
    );

    const pre = within(contentBlock(container)).getByText(/"gist"/);
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toContain('"gist": "Termination');
    expect(pre.textContent).toContain('    "sev": "high"');
  });

  it("renders the payload as content, not as dimmed chrome", () => {
    const { container } = render(
      <ChatMessagePreview
        data={{ messages: [{ role: "assistant", content: structuredAnswer }] }}
      />,
    );

    const pre = within(contentBlock(container)).getByText(/"gist"/);
    expect(pre.className).toContain("text-foreground");
    expect(pre.className).not.toContain("text-muted-foreground");
    // Payload values are prose; breaking mid-word would merge the wrap with
    // the structural lines.
    expect(pre.className).toContain("break-words");
    expect(pre.className).not.toContain("break-all");
  });

  it("indents a tool result that is a JSON payload", () => {
    const { container } = render(
      <ChatMessagePreview
        data={{ messages: [{ role: "tool", content: '{"ok":true,"rows":2}' }] }}
      />,
    );

    expect(within(contentBlock(container)).getByText(/"rows"/).textContent).toContain(
      '"rows": 2',
    );
  });

  it("renders prose as markdown, not as a code block", () => {
    const { container } = render(
      <ChatMessagePreview
        data={{
          messages: [
            { role: "assistant", content: "## Findings\n\nThe term is **five** years." },
          ],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getByText("five").tagName).toBe("STRONG");
    expect(contentBlock(container).querySelector("pre")).toBeNull();
  });

  it("shows a large payload whole — content is never hidden behind a click", () => {
    const long = JSON.stringify({
      notes: Array.from({ length: 40 }, (_, i) => ({ id: i, what: "finding" })),
    });
    const { container } = render(
      <ChatMessagePreview data={{ messages: [{ role: "assistant", content: long }] }} />,
    );

    const pre = contentBlock(container).querySelector("pre")!;
    expect(pre.textContent).toBe(JSON.stringify(JSON.parse(long), null, 2));
    expect(pre.textContent).not.toContain("…");
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
  });
});

describe("ChatMessagePreview payload bodies (tool I/O recorded as message content)", () => {
  // How the DABstep-style harnesses log code execution: a message whose
  // content is the JSON-stringified tool envelope.
  const codeMessage = JSON.stringify({
    code: "import json\nwith open('fees.json') as f:\n    fees = json.load(f)",
  });
  const resultMessage = JSON.stringify({
    stdout: "total gc: 257\nCounter({False: 257})",
    stderr: "",
    exit_code: 0,
    timed_out: false,
  });

  it("renders a {code} payload as a code body with real newlines", () => {
    render(
      <ChatMessagePreview
        data={{ messages: [{ role: "system", content: codeMessage }] }}
      />,
    );

    // The body shows the code itself, not JSON with escaped \n sequences.
    expect(screen.getByText(/import json/).textContent).toBe(
      "import json\nwith open('fees.json') as f:\n    fees = json.load(f)",
    );
    expect(screen.getByText(/import json/).tagName).toBe("PRE");
    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("shows a tool result body with its scalar siblings as context", () => {
    render(
      <ChatMessagePreview
        data={{ messages: [{ role: "assistant", content: resultMessage }] }}
      />,
    );

    expect(screen.getByText(/total gc/).textContent).toBe(
      "total gc: 257\nCounter({False: 257})",
    );
    // Scalar siblings render as context chips, not inside the body block.
    const chips = screen.getByText("exit_code").closest("div")!;
    expect(chips.textContent).toContain("exit_code 0");
    expect(chips.textContent).toContain("timed_out false");
    // Empty stderr contributes nothing.
    expect(chips.textContent).not.toContain("stderr");
  });
});

describe("ChatMessagePreview tool-call arguments", () => {
  const withToolCall = (args: string) => ({
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "docxExtractMarkdown", arguments: args } }],
      },
    ],
  });

  // Every field the unwrap recognizes: a payload whose body is one of these is
  // shown with real newlines rather than as escaped JSON.
  it.each(["text", "content", "source", "code", "input"])(
    "unwraps a %s argument field under its label",
    (field) => {
      render(
        <ChatMessagePreview
          data={withToolCall(JSON.stringify({ [field]: "line one\nline two" }))}
        />,
      );

      expect(screen.getByText(field)).toBeInTheDocument();
      expect(screen.getByText(/line one/).textContent).toBe("line one\nline two");
    },
  );

  it("pretty-prints arguments that carry no text-like field", () => {
    render(<ChatMessagePreview data={withToolCall('{"contractId":"abc","page":2}')} />);

    expect(screen.getByText(/contractId/).textContent).toContain('"page": 2');
  });

  it("renders arguments dimmed and break-anywhere, as chrome around the message", () => {
    render(<ChatMessagePreview data={withToolCall('{"contractId":"abc"}')} />);

    const pre = screen.getByText(/contractId/);
    expect(pre.className).toContain("text-muted-foreground");
    expect(pre.className).toContain("break-all");
  });

  it("collapses long arguments at 400 chars behind an expand toggle", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({ ids: Array.from({ length: 60 }, (_, i) => `id-${i}`) });
    const full = JSON.stringify(JSON.parse(args), null, 2);

    render(<ChatMessagePreview data={withToolCall(args)} />);

    const collapsed = screen.getByText(/"ids"/);
    expect(collapsed.textContent).toBe(full.slice(0, 400) + "…");

    await user.click(
      screen.getByRole("button", { name: `Expand (${full.length} chars)` }),
    );

    expect(screen.getByText(/"ids"/).textContent).toBe(full);
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
  });
});
