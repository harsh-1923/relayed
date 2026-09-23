// What an agent's reply is made of (docs/AGENT-RESPONSES.md, the message contract).
//
// Who controls each part's structure is the point of the split:
//   markdown     the model, as text
//   tool         the runtime, from a tool that really ran — a model cannot fake it
//   ui           the model, but only from @relayed/genui's library
//   reply_to_ui  the person who clicked a Reply, on their own message
//   memory       the SERVER, from what it actually recalled — see MemoryPart
//   ambient      the SERVER, from its own record that nobody asked — see AmbientPart
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
  /** Facts one reply may be handed. Recall returns at most six; twice that is slack, not a target. */
  maxMemoriesRecalled: 12,
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

/**
 * The card a missing connection or permission raises (WORKSPACE-AGENTS.md
 * §7.4). One kind covers all three states; which applies is read from the
 * ACTOR's own `connections`/`agent_permissions` at render time — this part
 * only ever carries the public, coarse `state`.
 *
 * A system part the model cannot write, and — unlike `tool`/`ui` — not even
 * an agent may write one on the ordinary path (`SERVER_ONLY`, below):
 * `broker.ts` is the only caller, through `writeMessage`'s `trustedParts`.
 */
export const AccessRequestPart = z.object({
  kind: z.literal('access_request'),
  request_id: z.string().min(1),
  run_id: z.string().min(1),
  /** The one person who may act (§7.4) — compared against the viewer's own actor, never trusted from anywhere else. */
  actor_id: z.string().min(1),
  agent_id: z.string().min(1),
  toolkit: z.string().min(1),
  effect: z.enum(['read', 'write', 'destructive']),
  state: z.enum(['pending', 'resolved', 'expired']),
});
export type AccessRequestPart = z.infer<typeof AccessRequestPart>;

/**
 * What this reply actually drew on from memory (docs/MEMORY.md §7.2).
 *
 * BUILT BY THE SERVER, from the facts it injected intersected with the
 * citations the reply kept — never from anything the model emits. A model
 * produces text; parts are assembled in `reply.ts` from our own data, which is
 * why this can be trusted the way a `tool` part can.
 *
 * NOT `SERVER_ONLY`, and the reason is worth writing down because the
 * definition there fits it. `SERVER_ONLY` is enforced by refusing the ordinary
 * write path, and its one user (`access.ts`) writes through `trustedParts`
 * instead — which skips `Parts` validation and the `ui` check entirely. An
 * agent's reply routinely carries `ui` parts, so moving every reply onto the
 * trusted path to admit this one kind would trade a real validation for a
 * theoretical write nothing performs. `AGENT_ONLY` blocks the case that
 * actually matters: a PERSON's message claiming to have cited memory.
 *
 * What is NEVER inferred is `used`: it is set from the citation link the reply
 * kept, not from a fact resembling something the model wrote. A footer that
 * over-claims is worse than one that stays quiet.
 */
export const MemoryPart = z.object({
  kind: z.literal('memory'),
  /**
   * Everything the run was handed, each marked with whether the reply cited it.
   *
   * ONE LIST WITH A FLAG rather than two lists: `used` is a subset of
   * `offered`, and storing both would duplicate every fact's text in a row
   * replicated to every member's disk.
   *
   * SHOWING THE UNUSED ONES IS TEMPORARY. While this is being built, seeing
   * what was offered and ignored is the fastest way to tell a bad recall from a
   * model that did not need it — a distinction nothing else surfaces yet. Once
   * `memory.facts.cited` exists (§14.6) the unused ones become noise under
   * every reply, and the renderer should stop drawing them.
   */
  recalled: z.array(z.object({
    /** The fact, as it was injected — not the model's paraphrase of it. */
    text: z.string().min(1),
    /** The message its episode starts at, so the reader can go and check. */
    message_id: z.string().min(1),
    /** What the citation read as, e.g. `db-cutover, 19 Sep`. */
    label: z.string().min(1),
    /** The reply kept this one's citation link. */
    used: z.boolean(),
  })).min(1).max(PART_LIMITS.maxMemoriesRecalled),
});
export type MemoryPart = z.infer<typeof MemoryPart>;

/**
 * An agent answering a message that did not mention it (docs/AMBIENT-RESPONSES.md).
 *
 * SERVER-ONLY, like an access card. Whether a message was unprompted is decided
 * by the server from its own record (`ambient_decisions`), never claimed by a
 * model or a person: on a person's message it is a costume, and on an agent's
 * reply to a mention it would be a lie about who asked.
 *
 * It carries the reference to the question the answer is about, written by the
 * server rather than the model — a model asked to cite will sometimes forget,
 * and the answer can land under someone else's message when people post while
 * it works (§6). `asker` is the name as it read when the answer was written; a
 * reader resolves `answering` for anything current.
 */
export const AmbientPart = z.object({
  kind: z.literal('ambient'),
  /** The message this answers. */
  answering: z.string().min(1),
  /** How the reference reads: the asker's name at the time. */
  asker: z.string().min(1).max(200),
});
export type AmbientPart = z.infer<typeof AmbientPart>;

export const MessagePart = z.discriminatedUnion('kind',
  [MarkdownPart, ToolPart, UiPart, ReplyToUiPart, AccessRequestPart, MemoryPart, AmbientPart]);
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
 * A `memory` part says the reply drew on something remembered; on a person's
 * message it is a claim about provenance they did not earn.
 * The server refuses both on anything but an agent's message, and the renderer
 * refuses to draw them there too (docs/AGENT-RESPONSES.md, rules for rooms).
 */
const AGENT_ONLY: ReadonlySet<string> = new Set(['tool', 'ui', 'memory']);

/**
 * Structure ONLY the server may write — decided from its own state
 * (`access_requests`), never a model's or a person's input. Refused for
 * every author, agents included, on the ordinary write path: the one caller
 * allowed to produce one (`broker.ts`) never goes through this check at all,
 * because it writes through `writeMessage`'s `trustedParts` instead of
 * untrusted `parts` (`sync/ops.ts`'s `contentOf`).
 */
const SERVER_ONLY: ReadonlySet<string> = new Set(['access_request', 'ambient']);

/** The first kind in `parts` this author may not write, or `null` if all are allowed. */
export function forbiddenPartKind(authorType: string, parts: readonly { kind: string }[]): string | null {
  const serverOnly = parts.find(part => SERVER_ONLY.has(part.kind));
  if (serverOnly) return serverOnly.kind;
  if (authorType === 'agent') return null;
  return parts.find(part => AGENT_ONLY.has(part.kind))?.kind ?? null;
}

/**
 * The first kind in a STORED message's `parts` the renderer must not draw for
 * this author, or `null` if all may be drawn.
 *
 * Not `forbiddenPartKind`, and the difference is the whole point: that one asks
 * whether an author may WRITE a part on the ordinary path, and refuses an
 * access card for everyone, agents included, because only the broker writes
 * one. A card that reached a replica was written by the broker, as the agent
 * (\`access.ts\`), so on an agent's message it is drawn. Reusing the write rule
 * here drew every access card as its public sentence, for everyone — the
 * person who could act on it included.
 *
 * On anyone but an agent, tool, ui and access-request parts are all a costume.
 */
export function undrawablePartKind(authorType: string, parts: readonly { kind: string }[]): string | null {
  if (authorType === 'agent') return null;
  return parts.find(part => AGENT_ONLY.has(part.kind) || SERVER_ONLY.has(part.kind))?.kind ?? null;
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
