// The wire format: what a frame is, and how one is read.
//
// This package exists for the same reason `@relayed/authz` does — the client
// and the server must not be able to disagree. A protocol version asserted in
// two places is a protocol version that will eventually differ by one, and the
// symptom is a handshake that fails with no message anybody wrote.
//
// Sharing the code at BUILD time does not make the two sides one program at
// RUN time: a shipped desktop binary carries its own copy, so a server that
// updates this file is talking to clients that have not. That is the normal
// state of affairs (updates are opt-in, `RELEASE.md`), and it is exactly what
// the leniency rules below exist for.
import { z } from 'zod';

/**
 * The protocol version a client announces in `hello`.
 *
 * Bumped only for a change an older client cannot survive — which, given the
 * rules below, should be close to never. Adding a frame type or a field is not
 * such a change.
 */
export const PROTOCOL = 1;

/**
 * The oldest version this server will still talk to. Equal to `PROTOCOL` until
 * something is genuinely retired, at which point older clients get `too_old`
 * rather than a confusing failure four frames later.
 */
export const MIN_PROTOCOL = 1;

/**
 * Close codes. 4000–4999 is the application-defined range.
 *
 * A close code rather than a frame, because these all end the connection — and
 * a frame the client must parse before it may act on it is a frame that arrives
 * after the client has already decided what to do about the close.
 */
export const CLOSE = {
  /** Bad or expired token. The client should refresh, then reconnect. */
  unauthenticated: 4001,
  /** Connected and never said `hello`. Not a client we can do anything with. */
  helloTimeout: 4002,
  /** Preceded by a `too_old` frame carrying the minimum. */
  tooOld: 4003,
  /** The server is going away — deploy, restart. Reconnect with jitter. */
  goingAway: 4004,
} as const;

// ─── The envelope ───────────────────────────────────────────────────────────

/**
 * Frames are FLAT: `{ "t": "hello", "protocol": 1, … }`, not `{ t, body }`.
 *
 * `FRONTEND.md` §8.2 sketched the nested shape before the flows document
 * existed. Flat won because it is what `SYNC-FLOWS.md` §8 documents in detail
 * with worked examples for every frame, because it is smaller on a wire whose
 * frame size we have measured and care about, and because it matches the
 * short-key exception the naming rule already carves out for the protocol.
 *
 * The cost of flatness is that envelope keys and body keys share one namespace,
 * so `t` and `traceparent` are RESERVED: no body may use them. That is a rule
 * worth stating once here rather than rediscovering when a body field shadows
 * the discriminator.
 */
const Envelope = z.object({
  t: z.string(),
  /** W3C trace context, so a client span links to the server's (OBSERVABILITY §4). */
  traceparent: z.string().optional(),
});

/**
 * What reading a frame produced.
 *
 * Four outcomes rather than a boolean, because "we do not know this frame" and
 * "this frame is broken" call for opposite responses: the first is routine and
 * must not disturb the connection, the second is worth counting and may
 * eventually be worth closing over.
 */
export type FrameRead =
  | { kind: 'frame'; t: string; body: unknown; traceparent: string | undefined }
  | { kind: 'ignored'; t: string }
  | { kind: 'malformed'; reason: string };

/** A table of body schemas, keyed by `t`. */
export type Bodies = Record<string, z.ZodType>;

/**
 * Parse one inbound frame, permissively.
 *
 * The shape here is load-bearing and easy to get backwards. The obvious move is
 * `z.discriminatedUnion('t', […])` over every frame type — and that would break
 * the rule that an unknown top-level frame is ignored rather than fatal
 * (invariant 43), because a union REJECTS what it does not recognise. Adding a
 * frame type would then break every client already in the field, which is the
 * one thing the protocol may not do (`DESIGN.md` §9.10).
 *
 * So: parse the envelope, look the body up by `t`, and count-and-skip when
 * there is no entry. Unknown FIELDS are handled by Zod itself — a plain
 * `z.object` strips what it does not declare rather than rejecting it, which is
 * the field-level half of the same rule (invariant 66).
 */
export function readFrame(raw: unknown, bodies: Bodies): FrameRead {
  let json: unknown;
  if (typeof raw === 'string') {
    try { json = JSON.parse(raw); }
    catch { return { kind: 'malformed', reason: 'not_json' }; }
  } else {
    json = raw;
  }

  const envelope = Envelope.safeParse(json);
  if (!envelope.success) return { kind: 'malformed', reason: 'no_frame_type' };

  const schema = bodies[envelope.data.t];
  // Not an error, and deliberately not counted here: counting belongs to the
  // caller, which knows whether it is a client or a server and therefore which
  // metric this is.
  if (!schema) return { kind: 'ignored', t: envelope.data.t };

  // The whole frame, not a nested body — flatness, above. Zod strips `t` and
  // `traceparent` back out because the body schema does not declare them.
  const body = schema.safeParse(json);
  if (!body.success) return { kind: 'malformed', reason: `bad_body:${envelope.data.t}` };

  return {
    kind: 'frame', t: envelope.data.t, body: body.data,
    traceparent: envelope.data.traceparent,
  };
}

// ─── Client → server ────────────────────────────────────────────────────────

/**
 * The first frame on every connection.
 *
 * It carries NO actor, workspace or device id, and that is the point: all three
 * are claims in the verified token, and a field that is present but ignored is
 * an invitation to trust it one day. `SYNC-FLOWS.md` §8 showed `workspace_id`
 * and `device_id` here; they are removed rather than accepted-and-discarded.
 *
 * `cursors` is where the client says how far it has got, per stream. Empty on a
 * fresh device. Nothing reads it until the step that answers with real head
 * state, so it is optional here rather than absent — a client written against
 * this version keeps working when it starts being read.
 */
export const Hello = z.object({
  protocol: z.number().int(),
  access_token: z.string().min(1),
  cursors: z.array(z.object({
    kind: z.string(),
    id: z.string(),
    rev: z.number().int().nonnegative(),
  })).optional(),
});
export type Hello = z.infer<typeof Hello>;

export const Ping = z.object({});
export type Ping = z.infer<typeof Ping>;

/** Every frame this server accepts. The table `readFrame` is given. */
export const INBOUND: Bodies = { hello: Hello, ping: Ping };

// ─── Server → client ────────────────────────────────────────────────────────

/**
 * The answer to `hello`, and the frame that will grow most.
 *
 * Today it carries only what the CONNECTION knows: who you are, what the server
 * thinks the time is, and which protocol it spoke. The step that makes badges
 * correct adds spaces, chats, the caller's own memberships and stream cursors —
 * as ADDED FIELDS on this same frame, not a second one, because a client that
 * predates them drops what it does not know rather than failing.
 *
 * `now` is not decoration: a client compares it with its own clock to compute
 * skew, and a badly wrong clock otherwise produces confusing timestamps
 * everywhere with no clue as to why (`DESIGN.md` §13.7).
 */
export const Welcome = z.object({
  protocol: z.number().int(),
  now: z.number().int(),
  actor: z.object({
    id: z.string(),
    handle: z.string(),
    display_name: z.string(),
  }),
});
export type Welcome = z.infer<typeof Welcome>;

export const Pong = z.object({});
export type Pong = z.infer<typeof Pong>;

/**
 * Sent immediately before closing a connection whose client is too old.
 *
 * Built now, a year before anything can trigger it, because the moment it is
 * needed is the moment it cannot be shipped: the clients that would need to
 * understand it are precisely the old ones.
 */
export const TooOld = z.object({
  min_protocol: z.number().int(),
  message: z.string(),
});
export type TooOld = z.infer<typeof TooOld>;

/** Every frame this client accepts. */
export const OUTBOUND: Bodies = { welcome: Welcome, pong: Pong, too_old: TooOld };

/** Serialise a frame. The one place `t` is attached, so it cannot be forgotten. */
export function frame(t: string, body: Record<string, unknown> = {}): string {
  return JSON.stringify({ t, ...body });
}
