/**
 * Detection for message text that is really a JSON payload.
 *
 * A model answering with structured output puts the JSON in an ordinary text
 * message — `{"gist":"…","notes":[…]}` arrives as `content`, with nothing on
 * the wire marking it as JSON (the OTel gen_ai semconv carries message content
 * as a string whatever its shape). Rendered as markdown it collapses into one
 * unreadable paragraph.
 *
 * The single home for that decision, so the surfaces that render these
 * messages agree on what counts — each still presents it in its own idiom
 * (a compact code block in a trace message bubble, `ExpandableJson` where
 * there is room for a tree).
 */

/**
 * The JSON payload a message's text carries, or `null` when it isn't one.
 *
 * Deliberately narrow: only an object or array counts. `42`, `true`, `null`
 * and `"quoted"` are all valid JSON documents that read as prose, and treating
 * them as payloads would be a regression.
 *
 * Trimmed first because `String.trim` strips more than JSON's own whitespace
 * — a BOM, a non-breaking space — and a payload carrying one of those is
 * still a payload.
 */
export function parseJsonPayload(text: string): unknown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  return parsed;
}

/** {@link parseJsonPayload}, indented for display, or `null`. */
export function formatJsonMessageText(text: string): string | null {
  const payload = parseJsonPayload(text);
  if (payload === null) return null;
  return JSON.stringify(payload, null, 2);
}

/** One scalar sibling of a payload body, formatted for display. */
export interface PayloadMetaEntry {
  key: string;
  value: string;
}

/** The readable rendering of a JSON payload message: body field + scalar meta. */
export interface PayloadBodyView {
  /** The field carrying the payload's text, with real newlines. */
  body: { label: string; text: string };
  /** Scalar siblings worth showing beside the body (`exit_code`, `timed_out`…). */
  meta: PayloadMetaEntry[];
}

const BODY_MAX_KEYS = 8;
const META_STRING_MAX = 80;

/**
 * The body of a JSON payload message, when one field carries its text.
 *
 * A tool result recorded as message content arrives as e.g.
 * `{"stdout":"…","exit_code":0}`. Pretty-printed JSON keeps the payload's
 * structure but escapes every newline inside the string values, so code and
 * terminal output read as one long `\n`-separated wall. When one string field
 * is multi-line and the object is small, that field IS the message — render it
 * directly and keep the remaining scalars as context.
 *
 * Returns `null` for payloads without a multi-line string field (structured
 * answers like `{gist, notes}` keep the pretty-printed JSON treatment).
 */
export function extractPayloadBody(payload: object): PayloadBodyView | null {
  if (Array.isArray(payload)) return null;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0 || entries.length > BODY_MAX_KEYS) return null;

  let body: { key: string; text: string } | null = null;
  for (const [key, value] of entries) {
    if (typeof value !== "string" || !value.includes("\n")) continue;
    if (body === null || value.length > body.text.length) {
      body = { key, text: value };
    }
  }
  if (body === null) return null;

  const meta: PayloadMetaEntry[] = [];
  for (const [key, value] of entries) {
    if (key === body.key) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      meta.push({ key, value: String(value) });
    } else if (typeof value === "string" && value.length > 0 && !value.includes("\n")) {
      meta.push({
        key,
        value: value.length > META_STRING_MAX ? `${value.slice(0, META_STRING_MAX)}…` : value,
      });
    }
  }

  return { body: { label: body.key, text: body.text }, meta };
}
