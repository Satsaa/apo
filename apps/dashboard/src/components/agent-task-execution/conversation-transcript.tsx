"use client";

import { useState, useCallback, useMemo } from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import {
  Wrench,
  Terminal,
  Copy,
  Check,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ExpandableJson } from "@/components/ExpandableJson";
import { Markdown } from "@/components/trace-detail/Markdown";
import { parseJsonPayload } from "@/components/trace-detail/message-content-utils";
import {
  FlatKeyValuePreview,
  getFlatKeyValueEntries,
} from "@/components/trace-detail/FlatKeyValuePreview";
import { TraceHomeLink } from "@/components/trace-detail";
import type { ChatMessage } from "@/lib/conversation-from-trace";

interface ConversationTranscriptProps {
  /** Conversation messages derived from the linked trace. */
  conversation: ChatMessage[];
  /** Trace id, used to link out to the full viewer from the empty state. */
  traceRunId?: string | null;
}

interface ToolCallInfo {
  id?: string;
  name: string;
  arguments: string;
}

interface ToolResultInfo {
  id: string;
  output: string;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * One line naming what a call did, `path: /a/b.docx` rather than the raw
 * `{"path":"/a/b.docx"}` — the values are what tell calls apart.
 */
function summarizeArguments(args: string): string {
  const entries = getFlatKeyValueEntries(tryParseJson(args));
  const text = entries
    ? entries.map(([key, value]) => `${key}: ${String(value)}`).join("  ")
    : args;
  return text.replace(/\s+/g, " ");
}

/**
 * A tool call's arguments the way the trace viewer's Formatted view shows
 * them: a few scalars as labelled rows with their values whole, anything
 * deeper as a fully open tree. Arguments are the call itself, so nothing is
 * elided behind a click.
 */
function ToolArguments({ args }: { args: string }) {
  const parsed = useMemo(() => tryParseJson(args), [args]);
  const entries = getFlatKeyValueEntries(parsed);
  if (entries) return <FlatKeyValuePreview entries={entries} />;
  if (typeof parsed === "string") return <PlainOutput text={parsed} />;
  return <ExpandableJson data={parsed} initialDetail="full" />;
}

/** Tool output: a JSON payload as a tree, anything else (stdout, file text) verbatim. */
function ToolOutput({ output }: { output: string }) {
  const payload = useMemo(() => parseJsonPayload(output), [output]);
  if (payload !== null) return <ExpandableJson data={payload} />;
  return <PlainOutput text={output} />;
}

function PlainOutput({ text }: { text: string }) {
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-xs text-foreground/80 [overflow-wrap:anywhere]">
      {text}
    </pre>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); handleCopy(); }}
      className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground/40 hover:text-muted-foreground cursor-pointer rounded transition-colors hover:bg-muted/50"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// Open on arrival: the message row around a block is already the click that
// asked to see it, so a second click per call only hid what was asked for.
function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
  const [isOpen, setIsOpen] = useState(true);
  const summary = useMemo(() => summarizeArguments(toolCall.arguments), [toolCall.arguments]);

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="flex items-center gap-3 px-3 py-2.5 w-full cursor-pointer hover:bg-muted/40 transition-colors text-left"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <Wrench className="h-4 w-4 text-muted-foreground/60 shrink-0" />
        <span className="text-sm font-mono text-foreground">{toolCall.name}</span>
        <span className="text-sm text-muted-foreground/50 flex-1 truncate font-mono">
          {!isOpen && summary}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">
            Tool Call
          </span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground/40 transition-transform", !isOpen && "-rotate-90")} />
        </div>
      </button>
      {isOpen && (
        <div className="border-t border-border/40 bg-background/30">
          <ToolArguments args={toolCall.arguments} />
        </div>
      )}
    </div>
  );
}

function ToolOutputBlock({ result }: { result: ToolResultInfo }) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="flex items-center gap-3 px-3 py-2.5 w-full cursor-pointer hover:bg-muted/40 transition-colors text-left"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <Terminal className="h-4 w-4 text-success shrink-0" />
        <span className="text-sm font-mono text-foreground">{result.id}</span>
        <span className="text-sm text-muted-foreground/50 flex-1 truncate font-mono">
          {!isOpen && result.output.slice(0, 200)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-success px-2 py-0.5 bg-success/10 rounded">
            Tool Output
          </span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground/40 transition-transform", !isOpen && "-rotate-90")} />
        </div>
      </button>
      {isOpen && (
        <div className="border-t border-border/40 bg-background/30">
          <ToolOutput output={result.output} />
        </div>
      )}
    </div>
  );
}

/** Pull OpenAI-shape tool_calls off an assistant message into a flat list. */
function extractToolCalls(message: ChatMessage): ToolCallInfo[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((call) => ({
    id: call.id,
    name: call.function?.name ?? "unknown",
    arguments: call.function?.arguments ?? "",
  }));
}

function AssistantMessageContent({ message }: { message: ChatMessage }) {
  const toolCalls = extractToolCalls(message);
  return (
    <div className="space-y-1.5">
      {message.content && <MessageText text={message.content} />}
      {toolCalls.map((tc) => (
        <ToolCallBlock
          key={`tc-${tc.id ?? tc.name}-${tc.arguments.slice(0, 32)}`}
          toolCall={tc}
        />
      ))}
    </div>
  );
}

/**
 * A message's text. An agent answering with structured output sends its JSON
 * as plain text, which markdown flattens into one paragraph and actively
 * corrupts (`snake_case` keys turn to italics), so a payload gets the same
 * tree the tool blocks above already use.
 *
 * Fully expanded, unlike those blocks: a tool result is reference material you
 * drill into, but this is the answer itself, and the default policy would hide
 * every finding under `notes` behind a click.
 */
function MessageText({ text }: { text: string }) {
  const payload = useMemo(() => parseJsonPayload(text), [text]);
  if (payload !== null) return <ExpandableJson data={payload} initialDetail="full" />;
  return (
    <div className="min-w-0 max-w-full overflow-x-auto break-words text-sm text-foreground/80 leading-relaxed">
      <Markdown>{text}</Markdown>
    </div>
  );
}

function ToolMessageContent({ message }: { message: ChatMessage }) {
  const result: ToolResultInfo = {
    // Tool-role messages don't carry an id in OpenAI shape; fall back to name or content hash.
    id: message.name ?? "tool-result",
    output: message.content,
  };
  return <ToolOutputBlock result={result} />;
}

function getPreviewText(message: ChatMessage): string {
  const firstCall = message.tool_calls?.[0]?.function;
  if (firstCall) {
    const calls = message.tool_calls!.length;
    const more = calls > 1 ? ` +${calls - 1} more` : "";
    return `${firstCall.name}  ${summarizeArguments(firstCall.arguments ?? "")}${more}`;
  }
  const text = message.content ?? "";
  return text.length > 120 ? text.slice(0, 120) + "..." : text;
}

function copyTextFor(message: ChatMessage): string {
  if (message.tool_calls && message.tool_calls.length > 0) {
    return JSON.stringify(
      { role: message.role, content: message.content, tool_calls: message.tool_calls },
      null,
      2,
    );
  }
  return message.content ?? "";
}

const roleConfig: Record<string, { label: string }> = {
  user: { label: "user" },
  assistant: { label: "assistant" },
  system: { label: "system" },
  tool: { label: "tool" },
};

// Accordion item ids carry a slice of the message preview (plus the position
// as a uniqueness tiebreaker) so keys stay tied to message content.
function messageItemId(message: ChatMessage, idx: number): string {
  return `msg-${idx}-${getPreviewText(message).slice(0, 24)}`;
}

export function ConversationTranscript({
  conversation,
  traceRunId,
}: ConversationTranscriptProps) {
  if (conversation.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/70 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No conversation messages in this trace.
        </p>
        {traceRunId && (
          <div className="mt-3 flex justify-center">
            <TraceHomeLink
              traceId={traceRunId}
              label="View full trace"
              appearance="button"
              buttonVariant="outline"
              buttonSize="sm"
            />
          </div>
        )}
      </div>
    );
  }

  const defaultOpen = conversation.length > 0
    ? [messageItemId(conversation[0]!, 0)]
    : [];

  return (
    <div className="rounded-lg border border-border/60 bg-card/70 overflow-hidden">
      <div className="flex items-center min-h-[52px] px-4 py-2 border-b border-border/40 shrink-0">
        <h2 className="text-sm font-medium text-foreground">Conversation History</h2>
        <span className="ml-2 text-xs text-muted-foreground">{conversation.length} messages</span>
      </div>

      <div className="overflow-y-auto max-h-[calc(100vh-400px)] min-h-[200px]">
        <AccordionPrimitive.Root type="multiple" defaultValue={defaultOpen}>
          {conversation.map((message, idx) => {
            const config = roleConfig[message.role] ?? { label: message.role };
            const preview = getPreviewText(message);
            const id = messageItemId(message, idx);
            const copy = copyTextFor(message);
            const isTool = message.role === "tool";

            return (
              <AccordionPrimitive.Item key={id} value={id} className="border-b border-border/40 last:border-b-0">
                <AccordionPrimitive.Header className="flex items-center">
                  <AccordionPrimitive.Trigger className="flex flex-1 items-center justify-between py-3 px-4 gap-3 hover:no-underline hover:bg-muted/30 transition-none text-left [&[data-state=open]>svg.accordion-chevron]:rotate-180">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-sm font-medium text-foreground shrink-0 min-w-16">{config.label}</span>
                      <div className="flex-1 w-0 overflow-hidden">
                        <span className="text-sm text-muted-foreground block truncate">{preview}</span>
                      </div>
                    </div>
                    <ChevronDown className="accordion-chevron h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform -rotate-90" />
                  </AccordionPrimitive.Trigger>
                  {/* Sibling (not nested) so we don't put a <button> inside the
                      trigger's <button>, which HTML forbids and React flags as
                      a hydration error. */}
                  <div className="flex items-center pr-4">
                    <CopyButton text={copy} />
                  </div>
                </AccordionPrimitive.Header>
                <AccordionPrimitive.Content className="overflow-hidden text-sm">
                  <div className="pb-4 pt-0 px-4 space-y-1.5 ml-16">
                    {message.role === "assistant" ? (
                      <AssistantMessageContent message={message} />
                    ) : isTool ? (
                      <ToolMessageContent message={message} />
                    ) : (
                      <MessageText text={message.content} />
                    )}
                  </div>
                </AccordionPrimitive.Content>
              </AccordionPrimitive.Item>
            );
          })}
        </AccordionPrimitive.Root>
      </div>
    </div>
  );
}
