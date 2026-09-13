// What an agent's reply is made of (docs/AGENT-RESPONSES.md, the message contract).
//
// Who controls each part's structure is the point of the split:
//   markdown     the model, as text
//   tool         the runtime, from a tool that really ran — a model cannot fake it
//   ui           the model, but only from @relayed/genui's library
//   reply_to_ui  the person who clicked a Reply, on their own message
// Approvals are deliberately not parts: the system renders those, from their own table.
//
// KEYS ARE snake_case, like every other key on the wire and in storage. Parts
// are JSON that crosses the socket and sits in a column; a camelCase island in a
// snake_case frame is the seam a gap snapshot once broke across (OBSERVABILITY.md,
// "it is also a test").
//
// TWO READINGS, like frames. The server checks parts it is asked to WRITE
// strictly (`Parts`): it is the newest program in the conversation, so a kind it
// does not know is a mistake. A client reading parts it was SENT stores them
// as they are: a kind it does not know was written by a newer build, and the
// message falls back to `body` rather than being refused (DESIGN.md §9.10).
import { z } from 'zod';

/**
 * Bounds on one message's parts, checked on write.
 *
 * `maxSerializedBytes` is the whole array as JSON: a message is replicated to
 * every member's disk, and a reply that ran a hundred tools must not become a
 * megabyte row. Each ui part has its own, smaller limit in @relayed/genui.
 */
export const PART_LIMITS = {
  maxParts: 200,
  maxSerializedBytes: 256_000,
  /** A tool's input, as JSON. Long enough for a command or a small edit. */
  maxToolInputBytes: 8_000,
  /** The start of a tool's output. The rest is not kept. */
  maxOutputPreviewChars: 2_000,
} as const;

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? '').length;

export const MarkdownPart = z.object({
  kind: z.literal('markdown'),
  text: z.string().min(1),
});
export type MarkdownPart = z.infer<typeof MarkdownPart>;

export const ToolPart = z.object({
  kind: z.literal('tool'),
  tool_use_id: z.string().min(1),
  name: z.string().min(1),
  ok: z.boolean(),
  ms: z.number().int().nonnegative(),
  input: z.unknown().refine(input => byteLength(input) <= PART_LIMITS.maxToolInputBytes,
    `tool input exceeds ${PART_LIMITS.maxToolInputBytes} bytes`),
  output_preview: z.string().max(PART_LIMITS.maxOutputPreviewChars).optional(),
  /** The size of the whole output, so a reader knows how much was cut. */
  output_bytes: z.number().int().nonnegative().optional(),
});
export type ToolPart = z.infer<typeof ToolPart>;

export const UiPart = z.object({
  kind: z.literal('ui'),
  /** The language and version the source is written in, e.g. `openui-lang@0.5`. */
  lang: z.string().min(1),
  /** The library version it was validated against, e.g. `relayed-ui@1`. */
  library: z.string().min(1),
  source: z.string().min(1),
});
export type UiPart = z.infer<typeof UiPart>;

export const ReplyToUiPart = z.object({
  kind: z.literal('reply_to_ui'),
  /** The agent message whose Reply button was clicked. */
  message_id: z.string().min(1),
  label: z.string().min(1),
});
export type ReplyToUiPart = z.infer<typeof ReplyToUiPart>;

export const MessagePart = z.discriminatedUnion('kind', [MarkdownPart, ToolPart, UiPart, ReplyToUiPart]);
export type MessagePart = z.infer<typeof MessagePart>;

/** The strict reading: what a server accepts on write. */
export const Parts = z.array(MessagePart)
  .min(1)
  .max(PART_LIMITS.maxParts)
  .refine(parts => byteLength(parts) <= PART_LIMITS.maxSerializedBytes,
    `parts exceed ${PART_LIMITS.maxSerializedBytes} bytes`);

export const PART_KINDS: ReadonlySet<string> = new Set(MessagePart.options.map(option => option.shape.kind.value));

/**
 * Kinds whose structure a person could use to impersonate something.
 *
 * A `tool` part says a tool really ran; only an agent's runtime observes that.
 * A `ui` part draws cards and buttons; on a person's message it is a costume.
 * The server refuses both on anything but an agent's message, and the renderer
 * refuses to draw them there too (docs/AGENT-RESPONSES.md, rules for rooms).
 */
const AGENT_ONLY: ReadonlySet<string> = new Set(['tool', 'ui']);

/** The first kind in `parts` this author may not write, or `null` if all are allowed. */
export function forbiddenPartKind(authorType: string, parts: readonly { kind: string }[]): string | null {
  if (authorType === 'agent') return null;
  return parts.find(part => AGENT_ONLY.has(part.kind))?.kind ?? null;
}

/** A part as a client holds it: a kind, possibly one this build has never heard of. */
export type StoredPart = { kind: string } & Record<string, unknown>;

/**
 * The lenient reading: parts as a client stored them, which may include kinds
 * this build has never heard of. Anything that is not an array of objects with a
 * string `kind` is treated as no parts at all — `body` is always there to show.
 */
export function readStoredParts(json: string | null): StoredPart[] | null {
  if (json === null) return null;
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(value) || value.length === 0) return null;
  const valid = value.every(part =>
    typeof part === 'object' && part !== null && typeof (part as { kind?: unknown }).kind === 'string');
  return valid ? value as StoredPart[] : null;
}
