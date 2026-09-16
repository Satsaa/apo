"use client";

import Image from "next/image";
import { useMemo, useRef, useCallback, useState } from "react";
import { ToolDefinitionsSection } from "./ToolDefinitionsSection";
import { extractTools, countToolInvocations } from "./tool-utils";
import { ThinkingBlock } from "./ThinkingBlock";
import { extractThinkingContent } from "./thinking-utils";
import { CollapsibleHistory } from "./CollapsibleHistory";
import { Markdown } from "./Markdown";
import { formatJsonMessageText, parseJsonPayload, extractPayloadBody, type PayloadBodyView } from "./message-content-utils";

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
  tool_calls?: Array<{
    function?: {
      name: string;
      arguments: string;
    };
  }>;
  name?: string;
  thinking?: string;
  reasoning_content?: string;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url?: { url: string } }
  | { type: "input_audio"; input_audio?: { url: string } }
  | { type: string; [key: string]: unknown };

interface ChatMessagePreviewProps {
  data: unknown;
  /**
   * "history" (default): show the first 3 + last 3 messages with a collapsible
   * middle. "last": show ONLY the newest message by default (the delta — e.g.
   * the tool result that triggered this generation) with a "Show full prompt"
   * toggle that expands the whole accumulated prompt. Used for generation
   * inputs so each step shows what's new that round, not the entire repeated
   * conversation history.
   */
  preview?: "history" | "last";
}

export function ChatMessagePreview({ data, preview = "history" }: ChatMessagePreviewProps) {
  const messages = useMemo(() => parseMessages(data), [data]);
  const tools = useMemo(() => extractTools(data), [data]);
  const invocationCounts = useMemo(
    () => countToolInvocations(messages),
    [messages],
  );
  const toolCallCounter = useRef(0);
  const [showFullPrompt, setShowFullPrompt] = useState(false);

  const getNextToolCallNumber = useCallback(() => {
    toolCallCounter.current += 1;
    return toolCallCounter.current;
  }, []);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center border border-dashed border-border/60 bg-muted/30 p-8">
        <p className="text-sm text-muted-foreground">No messages to display</p>
      </div>
    );
  }

  // Delta mode: a generation's input is the whole accumulated prompt, but
  // re-displaying it in every node is noise. Show only the newest message
  // (the turn that triggered this generation) by default; the full prompt is
  // one click away. Falls back to full view when there's only one message.
  if (preview === "last" && messages.length > 1 && !showFullPrompt) {
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    return (
      <div className="space-y-3">
        {tools.length > 0 && (
          <ToolDefinitionsSection
            tools={tools}
            invocationCounts={invocationCounts}
          />
        )}
        <MessageBubble
          key={messageKey(last, lastIndex)}
          message={last}
          getNextToolCallNumber={getNextToolCallNumber}
        />
        <button
          type="button"
          onClick={() => setShowFullPrompt(true)}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Show full prompt ({messages.length} messages)
        </button>
      </div>
    );
  }

  const firstThree = messages.slice(0, 3);
  const lastThree = messages.length > 6 ? messages.slice(-3) : [];
  const middleMessages = messages.length > 6 ? messages.slice(3, -3) : [];

  return (
    <div className="space-y-3">
      {tools.length > 0 && (
        <ToolDefinitionsSection
          tools={tools}
          invocationCounts={invocationCounts}
        />
      )}
      {preview === "last" && showFullPrompt && (
        <button
          type="button"
          onClick={() => setShowFullPrompt(false)}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Collapse to latest message
        </button>
      )}
      <CollapsibleHistory
        totalMessages={messages.length}
        visibleStart={firstThree.map((msg, i) => (
          <MessageBubble
            key={messageKey(msg, i)}
            message={msg}
            getNextToolCallNumber={getNextToolCallNumber}
          />
        ))}
        hiddenMiddle={middleMessages.map((msg, i) => (
          <MessageBubble
            key={messageKey(msg, i + 3)}
            message={msg}
            getNextToolCallNumber={getNextToolCallNumber}
          />
        ))}
        visibleEnd={lastThree.map((msg, i) => (
          <MessageBubble
            key={messageKey(msg, messages.length - lastThree.length + i)}
            message={msg}
            getNextToolCallNumber={getNextToolCallNumber}
          />
        ))}
      />
    </div>
  );
}

/** Stable React key for a message bubble. Same scheme the previous inline
 *  render function used (index-key warning intentionally left as-is). */
function messageKey(msg: ChatMessage, idx: number): string {
  return `${msg.role === "user" ? "user" : "msg"}-${idx}-${msg.content.slice(0, 24)}`;
}

function MessageBubble({
  message,
  getNextToolCallNumber,
}: {
  message: ChatMessage;
  getNextToolCallNumber: () => number;
}) {
  const roleInfo = getRoleInfo(message.role);
  const thinkingContent = extractThinkingContent(message);
  const contentParts = parseContentParts(message.content);

  return (
    <div className="hover:bg-muted/20">
      <div className={`px-3 py-1.5 text-xs font-medium ${roleInfo.headerClass}`}>
        {roleInfo.label}
        {message.name && <span className="ml-1 opacity-60">({message.name})</span>}
      </div>

      <div className="space-y-2 px-3 pb-3">
        {hasContent(message.content) && (
          <div className="text-sm">
            <MessageContent parts={contentParts} />
          </div>
        )}

        {message.tool_calls && message.tool_calls.length > 0 && (
          <div className="space-y-2">
            {message.tool_calls.map((call) => {
              const callNumber = getNextToolCallNumber();
              return (
                <div
                  key={`tc-${call.function?.name ?? callNumber}`}
                  className="rounded border border-border/60 bg-muted/30 px-3 py-2"
                >
                  <div className="mb-1 text-xs font-mono text-muted-foreground">
                    {call.function?.name || "unknown"}
                  </div>
                  {call.function?.arguments && (
                    <ToolCallArguments arguments={call.function.arguments} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {thinkingContent && <ThinkingBlock thinking={thinkingContent} />}
      </div>
    </div>
  );
}

function MessageContent({ parts }: { parts: ContentPart[] }) {
  return (
    <div className="max-w-none space-y-2 text-sm text-foreground">
      {parts.map((part) => {
        if (part.type === "image_url") {
          const url = (part as { type: "image_url"; image_url?: { url: string } }).image_url?.url ?? "";
          return <ImageReference key={`img-${url}`} url={url} />;
        }
        if (part.type === "input_audio") {
          const url = (part as { type: "input_audio"; input_audio?: { url: string } }).input_audio?.url ?? "";
          return <AudioReference key={`audio-${url}`} url={url} />;
        }
        if (part.type === "text") {
          const text = (part as { type: "text"; text: string }).text;
          return <TextContent key={`text-${text}`} text={text} />;
        }
        return null;
      })}
    </div>
  );
}

/**
 * One text part. A model answering with structured output sends its JSON as
 * plain message text, which markdown renders as a single unreadable paragraph,
 * so JSON gets special treatment; everything else stays markdown.
 */
function TextContent({ text }: { text: string }) {
  const payload = useMemo(() => parseJsonPayload(text), [text]);
  const body = useMemo(
    () =>
      payload !== null && typeof payload === "object"
        ? extractPayloadBody(payload)
        : null,
    [payload],
  );
  if (body) return <PayloadBodyBlock view={body} />;
  if (payload !== null) {
    const json = formatJsonMessageText(text);
    if (json !== null) return <CodeBlock body={json} variant="content" />;
  }
  return <Markdown>{text}</Markdown>;
}

/**
 * A JSON payload whose substance is one multi-line string field — e.g. a tool
 * result like `{stdout, stderr, exit_code}` recorded as message content. The
 * body renders with real newlines (pretty-printed JSON would escape them into
 * a wall of `\n`); scalar siblings stay visible as context chips.
 */
function PayloadBodyBlock({ view }: { view: PayloadBodyView }) {
  return (
    <div className="my-1 max-w-full">
      {view.meta.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          {view.meta.map(({ key, value }) => (
            <span key={key}>
              <span className="text-foreground/60">{key}</span> {value}
            </span>
          ))}
        </div>
      )}
      <CodeBlock body={view.body.text} label={view.body.label} variant="content" />
    </div>
  );
}

function ImageReference({ url }: { url: string }) {
  if (!url || url.startsWith("/")) {
    return (
      <span className="inline-flex items-center gap-1.5 border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
        <span className="text-xs">[Image]</span>
        {url && <span className="font-mono">{url}</span>}
      </span>
    );
  }

  return (
    <div className="my-1">
      <Image
        src={url}
        alt="Content"
        unoptimized
        className="max-h-64 max-w-full border border-border/60 object-contain"
        onError={(e) => {
          const target = e.currentTarget;
          target.style.display = "none";
          const placeholder = document.createElement("span");
          placeholder.className = "inline-flex items-center gap-1.5 border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground";
          placeholder.textContent = "[Image: failed to load]";
          target.parentNode?.appendChild(placeholder);
        }}
      />
    </div>
  );
}

function AudioReference({ url }: { url: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
      <span className="text-xs">[Audio]</span>
      {url && <span className="font-mono">{url}</span>}
    </span>
  );
}

function parseContentParts(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

const CHROME_COLLAPSE_CHARS = 400;

/**
 * A monospace block, in one of two registers.
 *
 * `chrome` is for tool-call arguments — the machinery around a message rather
 * than the message. Dimmed, broken anywhere so a long path or token can't
 * force a horizontal scroll, and collapsed past
 * {@link CHROME_COLLAPSE_CHARS} so it can't swallow the conversation.
 *
 * `content` is the message itself. Shown whole at full contrast, because the
 * markdown branch beside it truncates nothing either — hiding a structured
 * answer behind a click while the same answer in prose renders in full would
 * be the very asymmetry this rendering exists to remove. Wrapped on word
 * boundaries, since a payload's string values are usually prose.
 */
function CodeBlock({
  body,
  label,
  variant,
}: {
  body: string;
  label?: string;
  variant: "content" | "chrome";
}) {
  const [expanded, setExpanded] = useState(false);

  const collapsible = variant === "chrome" && body.length > CHROME_COLLAPSE_CHARS;
  const visible =
    collapsible && !expanded ? body.slice(0, CHROME_COLLAPSE_CHARS) : body;

  return (
    <div className="mt-1 max-w-full">
      {label ? (
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
      ) : null}
      <pre
        className={`max-w-full overflow-x-auto whitespace-pre-wrap text-xs font-mono ${
          variant === "chrome"
            ? "break-all text-muted-foreground"
            : "break-words text-foreground"
        }`}
      >
        {visible}
        {collapsible && !expanded ? "…" : ""}
      </pre>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          {expanded ? "Collapse" : `Expand (${body.length} chars)`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Render a tool call's arguments readably. The raw value is a JSON string whose
 * inner text has escaped newlines (e.g. {"text":"import json\\ndef …"}), which
 * otherwise renders as a single unbroken wall. Parse it: if the argument is an
 * object carrying a text-like field, show that field with real newlines; fall
 * back to pretty-printed JSON, then raw text.
 */
function ToolCallArguments({ arguments: args }: { arguments: string }) {
  const rendered = useMemo(() => {
    let parsed: unknown = args;
    try {
      parsed = JSON.parse(args);
    } catch {
      return args;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const textField = ["text", "content", "source", "code", "input"].find(
        (k) => typeof obj[k] === "string",
      );
      if (textField) {
        return { label: textField, body: obj[textField] as string };
      }
    }
    try {
      return JSON.stringify(parsed, null, 2);
    } catch {
      return args;
    }
  }, [args]);

  const label =
    typeof rendered === "object" && rendered !== null
      ? (rendered as { label?: string }).label
      : undefined;
  const body =
    typeof rendered === "object" && rendered !== null
      ? (rendered as { body?: string }).body ?? ""
      : (rendered as string);

  return <CodeBlock body={body} label={label} variant="chrome" />;
}

function hasContent(content: string | ContentPart[]): boolean {
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

function parseMessages(data: unknown): ChatMessage[] {
  if (!data) return [];

  let obj = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data);
    } catch {
      return [];
    }
  }

  if (obj && typeof obj === "object" && "messages" in obj && Array.isArray((obj as Record<string, unknown>).messages)) {
    return (obj as { messages: ChatMessage[] }).messages;
  }

  if (
    obj &&
    typeof obj === "object" &&
    "choices" in obj &&
    Array.isArray((obj as Record<string, unknown>).choices) &&
    ((obj as { choices: unknown[] }).choices.length as number) > 0
  ) {
    const choice = (obj as { choices: Array<{ message?: ChatMessage }> }).choices[0];
    if (choice.message && typeof choice.message === "object") {
      return [choice.message];
    }
  }

  return [];
}

function getRoleInfo(role: string) {
  const roleMap: Record<string, { label: string; headerClass: string }> = {
    system: {
      label: "System",
      headerClass: "bg-violet-500/10 text-violet-400",
    },
    user: {
      label: "User",
      headerClass: "bg-blue-500/10 text-blue-400",
    },
    assistant: {
      label: "Assistant",
      headerClass: "bg-emerald-500/10 text-emerald-400",
    },
    tool: {
      label: "Tool",
      headerClass: "bg-amber-500/10 text-amber-400",
    },
  };

  return (
    roleMap[role] || {
      label: role.charAt(0).toUpperCase() + role.slice(1),
      headerClass: "bg-muted text-foreground",
    }
  );
}
