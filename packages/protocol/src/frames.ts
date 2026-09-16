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
  /**
   * This connection stopped reading and its backlog outgrew the limit.
   *
   * Dropping rather than buffering is only safe because durable catch-up
   * exists: everything the client missed is still in the log, so reconnecting
   * replays it. A system without that would have to choose between unbounded
   * memory and a silent permanent hole.
   */
  slowConsumer: 4005,
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
  /**
   * What this client can decompress. Absent means "text only".
   *
   * NEGOTIATED rather than versioned, because compression is a property of a
   * client build and not of the protocol: bumping the version would make every
   * older client too old for a change that costs them nothing. An unknown
   * algorithm in this list is ignored, so adding one later needs no coordination.
   */
  compression: z.array(z.string()).optional(),
});
export type Hello = z.infer<typeof Hello>;

/**
 * The heartbeat, carrying where this client thinks each stream has got to.
 *
 * Cursors ride along so the reply can say what the server thinks instead —
 * which is what closes the one hole in delivering fanout in-process. See `Pong`.
 */
export const Ping = z.object({
  cursors: z.array(z.object({
    kind: z.string(),
    id: z.string(),
    rev: z.number().int().nonnegative(),
  })).optional(),
});
export type Ping = z.infer<typeof Ping>;

/** A stream reference, as it appears in both directions. */
const StreamRef = z.object({ kind: z.string(), id: z.string() });

/**
 * "What durable changes did I miss after my contiguous cursor?"
 *
 * `from_rev` is the client's FRONTIER, not its head — the point below which it
 * holds an unbroken run. Sending the head instead would ask the server to skip
 * exactly the events sitting in a hole.
 *
 * The server never infers the stream from the cursor: a modified client can put
 * any id here, so the answer is gated on `can()` like every other read.
 */
export const CatchupRequest = z.object({
  stream: StreamRef,
  from_rev: z.number().int().nonnegative(),
});
export type CatchupRequest = z.infer<typeof CatchupRequest>;

/**
 * "Give me history below this ordinal."
 *
 * A DIFFERENT QUESTION from catch-up, keyed differently. Catch-up replays what
 * CHANGED, by revision; backfill hydrates what the partial replica chose not to
 * hold, by ordinal. Conflating them is how a client ends up replaying a
 * thousand deletions to render a scrollback.
 */
export const BackfillRequest = z.object({
  c: z.string(),
  before_ord: z.number().int().positive(),
  limit: z.number().int().positive().max(200).optional(),
});
export type BackfillRequest = z.infer<typeof BackfillRequest>;

/**
 * "Which of the messages I hold changed while I was past the gap threshold?"
 *
 * The other half of taking a gap. A gap replaces the log with a partial
 * snapshot, and a message the client already held that the snapshot did not
 * re-send is otherwise never corrected — a delete during the gap leaves the
 * message on that device for good. `since_rev` is the frontier the gap jumped
 * FROM, `max_ord` the highest ordinal held before the tail landed; the answer
 * is every message that changed after the one and sits at or below the other,
 * as complete rows, paged by (rev, id).
 */
export const RepairRequest = z.object({
  c: z.string(),
  since_rev: z.number().int().nonnegative(),
  max_ord: z.number().int().nonnegative(),
  /** Where the previous page ended. Absent for the first page. */
  after: z.object({ rev: z.number().int().nonnegative(), id: z.string() }).nullable().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type RepairRequest = z.infer<typeof RepairRequest>;

/**
 * One page of a thread, by ordinal (`DESIGN.md` §8.2). Replies share the chat's
 * ordinal space and can sit anywhere in it, so they cannot come from backfill's
 * ordinal range; this is the parent-keyed read that must exist from day one.
 */
export const ThreadRequest = z.object({
  c: z.string(),
  root: z.string(),
  after_ord: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ThreadRequest = z.infer<typeof ThreadRequest>;

/**
 * One page of the actor directory.
 *
 * KEYSET ON ACTOR ID, not an offset and not a revision. Actors have no ordinal,
 * but ULIDs sort — so "everyone after this id" is a seek on the primary key and
 * pages cannot skip or repeat when somebody joins mid-fetch, which is exactly
 * what OFFSET does.
 *
 * This is a SNAPSHOT read, not catch-up. Catch-up over the workspace stream
 * carries the deltas; this exists for the case where there are too many to be
 * worth replaying — a fresh device, or a cursor past the retention horizon.
 */
export const DirectoryRequest = z.object({
  /** Absent for the first page. */
  after_id: z.string().nullable().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
export type DirectoryRequest = z.infer<typeof DirectoryRequest>;

/**
 * A write. The only frame that changes anything.
 *
 * `op_id` is CLIENT-generated and is what makes a retry safe: the server's
 * ledger returns the stored ack rather than doing the work twice, so a client
 * that sends, loses the connection before the ack, and retries produces one
 * message rather than two (invariant 5). That is the single most common
 * offline-sync bug there is.
 *
 * Writes ride the socket rather than HTTPS: one ordered connection, one
 * authentication, and an ack that correlates to an outbox row (`DESIGN.md` §9.5).
 */
export const OpFrame = z.object({
  op_id: z.string().min(1),
  kind: z.enum(['send', 'delete']),
  /** The chat. Short, because bytes on a socket are a different concern. */
  c: z.string().min(1),
  /** The message this acts on — client-generated for a send (§10.1). */
  target: z.string().min(1),
  /** Present for a send. A delete needs nothing but its target. */
  m: z.object({
    parent_id: z.string().nullable().optional(),
    /** What the client drew while it waited. With parts, the server derives its own. */
    body: z.string(),
    /**
     * Parts, checked strictly by the server — not here, where an unknown kind
     * from a newer client must not make the whole frame malformed.
     */
    parts: z.array(z.unknown()).optional(),
  }).optional(),
});
export type OpFrame = z.infer<typeof OpFrame>;

/**
 * What an agent was told, asked for by its id (WORKSPACE-AGENTS.md §4.5).
 *
 * An ONLINE-ONLY read: at 32 KB each, instructions would put a workspace's
 * prompts into directory pages sized by the company (invariant 71), so the
 * profile and the editor fetch one when they open.
 */
export const AgentDefinitionRequest = z.object({
  agent_id: z.string().min(1),
});
export type AgentDefinitionRequest = z.infer<typeof AgentDefinitionRequest>;

/**
 * Who is in some spaces, as a paged snapshot (SPACE-MEMBERSHIP-MARKERS.md,
 * rosters).
 *
 * The same shape as the directory: a snapshot read once per space, kept
 * current afterwards by the membership events on each space's own stream. Only
 * ids and roles — who an actor IS comes from the directory the client already
 * holds.
 *
 * Several spaces at once, because the spaces a client fetches eagerly (rooms,
 * group messages) are small and many. Keyset on (space, actor): pages cannot
 * skip or repeat when somebody joins mid-fetch.
 */
export const RosterRequest = z.object({
  space_ids: z.array(z.string().min(1)).min(1).max(50),
  /** Absent for the first page; the last page's `next_after` afterwards. */
  after: z.object({ space_id: z.string(), actor_id: z.string() }).nullable().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
export type RosterRequest = z.infer<typeof RosterRequest>;

/** Every frame this server accepts. The table `readFrame` is given. */
export const INBOUND: Bodies = {
  hello: Hello, ping: Ping,
  catchup: CatchupRequest, backfill: BackfillRequest,
  repair: RepairRequest, thread: ThreadRequest,
  directory: DirectoryRequest, op: OpFrame,
  agent_definition: AgentDefinitionRequest, roster: RosterRequest,
};

// ─── Server → client ────────────────────────────────────────────────────────

/**
 * The answer to `hello`, and the frame that carries the most.
 *
 * `now` is not decoration: a client compares it with its own clock to compute
 * skew, and a badly wrong clock otherwise produces confusing timestamps
 * everywhere with no clue as to why (`DESIGN.md` §13.7).
 *
 * WHICH FIELDS ARE OPTIONAL, and why it is not a shrug. `protocol`, `now` and
 * `actor` are required — a welcome without them is not a welcome, and accepting
 * one would be inventing what we were not sent. The four collections are
 * optional because **absent and empty mean the same thing**: an actor in no
 * spaces genuinely has no spaces, so a server that omits an empty array must
 * not break a client. That is the line between the two leniency rules — tolerate
 * what carries no information, refuse what is missing.
 */
/**
 * One connected account, as `welcome` or a `connections` push carries it
 * (WORKSPACE-AGENTS.md §6.3). Never the Composio account id — that is ours to
 * mirror, not the client's to hold.
 */
export const ConnectionRow = z.object({
  id: z.string(),
  toolkit: z.string(),
  status: z.enum(['connecting', 'active', 'needs_reauth', 'failed', 'disconnected']),
  status_reason: z.enum(['expired', 'revoked_upstream', 'scopes_changed', 'failed']).nullable(),
  label: z.string().nullable(),
});
export type ConnectionRow = z.infer<typeof ConnectionRow>;

/** One agent's grant, as `welcome` or an `agent_permissions` push carries it (WORKSPACE-AGENTS.md §6.4). `invoker_actor_id` is never sent — every row here is the caller's own. */
export const AgentPermissionRow = z.object({
  agent_actor_id: z.string(),
  toolkit: z.string(),
  effect: z.enum(['read', 'write', 'destructive']),
  revoked: z.boolean(),
});
export type AgentPermissionRow = z.infer<typeof AgentPermissionRow>;

/**
 * A delivery-address push, not a `sync_event` (WORKSPACE-AGENTS.md §6.3): one
 * row changed, replaced idempotently by its own id — never merged, and never
 * the whole table. A missed push is repaired by the next `welcome`.
 */
export const ConnectionsPush = z.object({ rows: z.array(ConnectionRow) });
export type ConnectionsPush = z.infer<typeof ConnectionsPush>;

export const AgentPermissionsPush = z.object({ rows: z.array(AgentPermissionRow) });
export type AgentPermissionsPush = z.infer<typeof AgentPermissionsPush>;

/**
 * A room's shared panel (PANELS.md), as `welcome`, `panel.opened` and a newly
 * added member's hydration all carry it. `type` stays a string: a newer server
 * may send a type this client keeps without knowing how to draw (§3.3).
 */
export const PanelRow = z.object({
  id: z.string(),
  space_id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  title: z.string().nullable(),
  opened_from_chat_id: z.string().nullable(),
  created_by_actor_id: z.string().nullable(),
  on_behalf_of_actor_id: z.string().nullable(),
  created_at: z.string(),
  opened_at: z.string(),
});
export type PanelRow = z.infer<typeof PanelRow>;

/**
 * A space's document (DOCUMENTS.md §3), as `welcome`, `document.updated` and a
 * newly added member's hydration all carry it — the complete row, so applying
 * it is one upsert and a client that missed an earlier one is corrected by
 * this. `kind` and `format` stay strings for the reason `PanelRow.type` does:
 * a newer server may send one this client keeps without knowing how to draw it.
 */
export const DocumentRow = z.object({
  id: z.string(),
  space_id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  format: z.string(),
  rev: z.number().int().nonnegative(),
  updated_by_actor_id: z.string().nullable(),
  covered_through: z.record(z.string(), z.number()).nullable(),
  updated_at: z.string(),
});
export type DocumentRow = z.infer<typeof DocumentRow>;

export const Welcome = z.object({
  protocol: z.number().int(),
  now: z.number().int(),
  actor: z.object({
    id: z.string(),
    handle: z.string(),
    display_name: z.string(),
  }),

  /**
   * Spaces the actor has JOINED. Not every space they could see.
   *
   * Public means discoverable, not synced. A workspace with three hundred
   * public channels where this actor belongs to forty sends forty; browsing the
   * rest is a query against the directory, made when somebody opens the browser
   * (DESIGN.md §7.4).
   */
  spaces: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    slug: z.string().nullable(),
    visibility: z.string().nullable(),
    membership_policy: z.string(),
    lifecycle: z.string(),
    /** Who created it, and whose request it was when an agent did. Absent from a server that predates them. */
    created_by_actor_id: z.string().nullable().optional(),
    on_behalf_of_actor_id: z.string().nullable().optional(),
    /** Who a DM or group DM is between — what a client names it by. Null for every other kind; absent from an older server. */
    member_ids: z.array(z.string()).nullable().optional(),
    /**
     * How many people and agents are in it. One number per joined space, so
     * the frame still grows with the actor rather than the workspace
     * (invariant 71) — and a client can say "128 members", and decide whether
     * to fetch the list, without holding it. Absent from an older server.
     */
    member_count: z.number().int().nonnegative().optional(),
    rev: z.number().int().nonnegative(),
  })).optional(),

  /**
   * Head state and counters, per chat. THE POINT OF THE WHOLE FRAME.
   *
   * After this arrives every badge in the sidebar is correct, with the message
   * tables still empty — which is R2, satisfied in one round trip. "I have it"
   * and "I know it exists" are different facts, and keeping them apart is what
   * makes a badge cheap for a chat holding nothing at all.
   */
  chats: z.array(z.object({
    id: z.string(),
    space_id: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    head_ord: z.number().int().nonnegative(),
    head_rev: z.number().int().nonnegative(),
    chat_unread: z.number().int().nonnegative(),
    thread_unread: z.number().int().nonnegative(),
    mention_count: z.number().int().nonnegative(),
  })).optional(),

  /**
   * The CALLER's own memberships, not everyone's.
   *
   * These are the grants `can()` evaluates for their own affordances. "Who else
   * is in this space" is a view concern, answered per space when a surface asks
   * — sending every membership in the workspace would be members × spaces in
   * the worst case, which is the shape invariant 71 forbids.
   */
  memberships: z.array(z.object({
    scope_type: z.string(),
    scope_id: z.string(),
    role: z.string(),
  })).optional(),

  /** Cursors for the streams that are not chats. */
  streams: z.array(z.object({
    kind: z.string(),
    id: z.string(),
    rev: z.number().int().nonnegative(),
  })).optional(),

  /**
   * The CALLER's own connected accounts (WORKSPACE-AGENTS.md §6.3) — never
   * everyone's, the same sizing rule `memberships` holds. Every status is
   * sent, disconnected and failed included: the client's table mirrors the
   * server's exactly, so a push later replaces a row rather than merging into
   * one that never existed locally.
   */
  connections: z.array(ConnectionRow).optional(),
  /** The CALLER's own grants to agents (WORKSPACE-AGENTS.md §6.4) — revoked rows included, for the same reason. */
  agent_permissions: z.array(AgentPermissionRow).optional(),
  /**
   * The open panels of every room the caller has joined, complete: a panel
   * absent here is one the room no longer has.
   */
  panels: z.array(PanelRow).optional(),
  /**
   * The documents of every space the caller has joined, complete — a room's
   * running summary. Absent from a server that predates them.
   */
  documents: z.array(DocumentRow).optional(),
});
export type Welcome = z.infer<typeof Welcome>;

/**
 * The heartbeat reply, carrying the heads of any stream the client is behind on.
 *
 * THIS IS WHAT CLOSES THE COMMIT-TO-SOCKET RESIDUE. Fanout happens in-process
 * after the transaction commits, so a server that dies between `COMMIT` and the
 * socket write leaves an event durable and undelivered. It mostly self-repairs
 * — the next event in that stream arrives above the client's frontier and
 * triggers catch-up — but the LAST event before a silence has nothing after it
 * to expose it, and a quiet channel could sit one message behind indefinitely.
 *
 * Comparing heads on every heartbeat bounds that to one interval. Only streams
 * where the server is ahead are listed, so a caught-up client gets an empty
 * reply and the frame stays small — which matters at one per connection per
 * twenty-five seconds.
 */
export const Pong = z.object({
  behind: z.array(z.object({
    kind: z.string(),
    id: z.string(),
    rev: z.number().int().nonnegative(),
  })).optional(),
});
export type Pong = z.infer<typeof Pong>;

/**
 * One event from a stream — the frame the whole sync engine exists to deliver.
 *
 * `payload` is `unknown` on purpose. Its shape depends on `type`, and the client
 * is required to tolerate a `type` it has never heard of by accounting for the
 * revision and skipping the effect (invariant 32). Validating the payload here
 * would make an unrecognised event MALFORMED rather than merely unfamiliar,
 * which is the frontier-stalling bug that rule exists to prevent.
 */
export const Ev = z.object({
  stream: z.object({ kind: z.string(), id: z.string() }),
  rev: z.number().int().positive(),
  type: z.string(),
  payload: z.unknown(),
});
export type Ev = z.infer<typeof Ev>;

/**
 * The event type an unlisted reader receives in place of any event about a
 * message it may not see — its creation, its deletion, and edits once they
 * exist (WORKSPACE-AGENTS.md §8.4). The payload is `{}`.
 *
 * The REVISION WITHOUT THE CONTENT, and the revision is the part that matters:
 * a reader simply not sent the event would find a hole at that revision, ask
 * catch-up for it, and could never be given it — its frontier would stop there
 * and every later message in the chat would be staged and never shown.
 *
 * No id, no original type, no author, no ordinal: the id would let a recipient
 * match a later delete to the same hidden message, and the type would say
 * whether it was a creation or an edit. A client built before this type existed
 * handles it correctly without knowing it — an unknown type still advances the
 * cursor (invariant 32).
 */
export const WITHHELD_EVENT = 'withheld';

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

/**
 * A replay: the events between a client's frontier and where it can reach.
 *
 * The events are the SAME envelope as a live `ev` frame, so the client feeds
 * them into one apply path rather than two. That is what removes the class of
 * bug where an event behaves differently depending on which door it came
 * through — the class that only shows up under a reconnect.
 */
export const CatchupOk = z.object({
  stream: StreamRef,
  from_rev: z.number().int().nonnegative(),
  /** What the frontier becomes once this batch applies contiguously. */
  to_rev: z.number().int().nonnegative(),
  /** False when the batch was capped and another round is owed. */
  complete: z.boolean(),
  events: z.array(z.object({
    rev: z.number().int().positive(),
    type: z.string(),
    payload: z.unknown(),
  })),
});
export type CatchupOk = z.infer<typeof CatchupOk>;

/**
 * Too far behind to replay: current state instead of history.
 *
 * This is what bounds a reconnect to O(streams) rather than O(messages) — a
 * person away for a week across 150 chats gets one small frame each, not a
 * hundred thousand messages.
 *
 * `snapshot` is discriminated by stream kind because "what do I render while
 * behind" has a different answer for each: a chat's newest messages, a space's
 * current shape, and for the directory nothing at all — it is paged separately,
 * being the one collection sized by the workspace (invariant 71).
 */
export const Gap = z.object({
  stream: StreamRef,
  head_rev: z.number().int().nonnegative(),
  snapshot: z.object({ kind: z.string() }).loose(),
});
export type Gap = z.infer<typeof Gap>;

/**
 * A message as every row-returning frame carries it: COMPLETE CURRENT STATE.
 *
 * The body as it stands now, tombstone status, when it was edited, how many
 * replies it has. That is what makes "account for the revision, skip the
 * effect" safe for an edit below the window — when the row finally arrives it
 * already carries the edited body — and what makes overwriting a held row with
 * a fetched one safe at all (invariant 85).
 *
 * The newer fields are optional on the wire because a server that predates
 * them omits them, and a client must read such a row as "not deleted, never
 * edited, no replies known, visible to the chat" rather than refuse it.
 *
 * `visible_to` is the list for a message only some people can see, and a
 * reader is only ever sent a row it is on (WORKSPACE-AGENTS.md §8.7) — so it is
 * for DRAWING "only visible to you", never for deciding who may read.
 */
const MessageRowFrame = z.object({
  id: z.string(),
  ord: z.number().int().positive(),
  rev: z.number().int().nonnegative(),
  author_id: z.string(),
  body: z.string(),
  parent_id: z.string().nullable(),
  deleted: z.boolean().optional(),
  edited_at: z.string().nullable().optional(),
  reply_count: z.number().int().nonnegative().optional(),
  visible_to: z.array(z.string()).nullable().optional(),
  /**
   * The parts the body was derived from, or null. Read LENIENTLY: a kind this
   * build does not know was written by a newer one, and the message falls back
   * to `body` rather than the frame being refused (AGENT-RESPONSES.md §3.1).
   */
  parts: z.array(z.unknown()).nullable().optional(),
});
export type MessageRowFrame = z.infer<typeof MessageRowFrame>;

/** One page of history, newest first. */
export const BackfillOk = z.object({
  c: z.string(),
  rows: z.array(MessageRowFrame),
  /** True when the beginning of history was reached. */
  complete: z.boolean(),
});
export type BackfillOk = z.infer<typeof BackfillOk>;

/**
 * One page of repair: held messages that changed while the client was away.
 *
 * `after` is where the NEXT page starts — the last row's (rev, id), never the
 * head. A row that changes again after this page was computed moves past that
 * cursor and is served again, complete, which is how a client that applied a
 * live change over a stale row is put right (SYNC-FLOWS.md, the repair flow).
 */
export const RepairOk = z.object({
  c: z.string(),
  rows: z.array(MessageRowFrame),
  complete: z.boolean(),
  after: z.object({ rev: z.number().int().nonnegative(), id: z.string() }).nullable(),
});
export type RepairOk = z.infer<typeof RepairOk>;

/** One page of a thread, oldest first. */
export const ThreadOk = z.object({
  c: z.string(),
  root: z.string(),
  rows: z.array(MessageRowFrame),
  complete: z.boolean(),
});
export type ThreadOk = z.infer<typeof ThreadOk>;

/** What every member's client holds about an agent. */
export const AgentSummaryFrame = z.object({
  description: z.string(),
  config_rev: z.number().int().positive(),
  /** Always empty since agents find their own tools (WORKSPACE-AGENTS-IMPL.md step 7); sent because older clients require it. */
  toolkits: z.array(z.object({ toolkit: z.string(), effect: z.string() })),
});
export type AgentSummaryFrame = z.infer<typeof AgentSummaryFrame>;

/**
 * One page of the directory, plus where the stream was when the page was taken.
 *
 * `head_rev` is what makes a paged snapshot safe to jump a cursor to. The client
 * adopts it only after the LAST page: at that point it holds current state for
 * the whole workspace, so advancing past the revisions it never replayed is the
 * same trade the gap makes — and safe for the same reason.
 *
 * Deactivated actors are INCLUDED. A tombstoned author still has to render on
 * the messages they wrote, and a client that dropped them would show an empty
 * name where a greyed one belongs (DESIGN.md §6.3).
 */
export const DirectoryOk = z.object({
  rows: z.array(z.object({
    id: z.string(),
    type: z.string(),
    handle: z.string(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
    owner_actor_id: z.string().nullable(),
    state: z.string(),
    updated_at: z.number().int(),
    /**
     * An agent's summary — enough for autocomplete and a profile offline, and
     * NOT its instructions, which are an `agent_definition` read
     * (WORKSPACE-AGENTS.md §4.5). Optional: a person has none, and a server
     * that predates agents sends none.
     */
    agent: AgentSummaryFrame.optional(),
  })),
  /** Pass back as `after_id` for the next page. Null on the last. */
  next_after_id: z.string().nullable(),
  complete: z.boolean(),
  head_rev: z.number().int().nonnegative(),
});
export type DirectoryOk = z.infer<typeof DirectoryOk>;

/**
 * The write succeeded, and here is what the server decided.
 *
 * Delivered to the sender IN ADDITION to the `ev` frame everyone else gets —
 * including the sender. The ack reconciles the outbox row; the event travels
 * the same apply path as on every other device, so there is one convergence
 * mechanism rather than a special case for "mine".
 *
 * `ord` is null for a delete, which is the two-counter model reaching the wire:
 * a delete takes a revision and no ordinal, so nothing is renumbered and the
 * gap it leaves is normal rather than something to repair.
 */
export const AckFrame = z.object({
  op_id: z.string(),
  id: z.string(),
  c: z.string(),
  ord: z.number().int().nullable(),
  rev: z.number().int().nonnegative(),
  created_at: z.string(),
});
export type AckFrame = z.infer<typeof AckFrame>;

/**
 * The write was refused.
 *
 * `retryable` is the field that matters, and the distinction is not cosmetic. A
 * send into a chat somebody was removed from will NEVER succeed — retrying it
 * silently for ever is worse than an error, because they see a message that
 * looks queued and never learn it will not go. A terminal failure is surfaced
 * with retry and discard, which are the only two things anyone can do about it.
 */
export const NackFrame = z.object({
  op_id: z.string(),
  code: z.string(),
  retryable: z.boolean(),
  message: z.string(),
});
export type NackFrame = z.infer<typeof NackFrame>;

/**
 * The answer to `agent_definition`. `found: false` for an agent that does not
 * exist, is not an agent, or is in another workspace — one answer for all
 * three, because the difference would tell a caller about a tenant they are not
 * in. An answer rather than silence, because a person is waiting on this one.
 */
export const AgentDefinitionOk = z.object({
  agent_id: z.string(),
  found: z.boolean(),
  definition: z.object({
    description: z.string(),
    instructions: z.string(),
    model: z.string().nullable(),
    thinking_level: z.string().nullable(),
    config_rev: z.number().int().positive(),
    created_by: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    maintainers: z.array(z.string()),
    /** Always empty since agents find their own tools (WORKSPACE-AGENTS-IMPL.md step 7); sent because older clients require it. */
    tools: z.array(z.object({ toolkit: z.string(), tool: z.string(), effect: z.string() })),
    /** Spaces the agent is in that the reader is in too. */
    space_ids: z.array(z.string()),
    /**
     * What the reader may do, decided by the server now. A creator's own grant
     * on a new agent reaches their client only with the next `welcome`; asking
     * here keeps Edit from being hidden from the person who just made it.
     * Hiding is all a client may do with it (invariant 49).
     */
    you: z.object({ edit: z.boolean(), manage_maintainers: z.boolean(), deactivate: z.boolean() }),
  }).optional(),
});
export type AgentDefinitionOk = z.infer<typeof AgentDefinitionOk>;

/** Every frame this client accepts. */
/**
 * The working indicator (WORKSPACE-AGENTS.md §5.7). A delivery-address push,
 * not a `sync_event` — it takes no revision, and a lost one is cosmetic: the
 * reply arrives regardless.
 *
 * `seq` rises per run; a client drops anything with a lower `seq` than it
 * holds, or anything arriving after `ended`, so a push crossing the answer on
 * the wire cannot leave the indicator stuck on "working" under a finished reply.
 */
export const AgentActivity = z.object({
  chat_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  run_id: z.string(),
  seq: z.number().int().nonnegative(),
  state: z.enum(['queued', 'running', 'waiting', 'ended']),
  /** The current tool's name, from the catalogue; absent while queued or waiting. */
  label: z.string().optional(),
});
export type AgentActivity = z.infer<typeof AgentActivity>;

/**
 * One page of rosters, for the spaces the request named that the caller may
 * read — `space_ids` echoes exactly those, so a space missing from it was
 * refused and its request should not be repeated.
 *
 * Rows are ordered by (space, actor). A space whose id is below
 * `next_after.space_id` is complete, and every space is complete once
 * `complete` is true — the client needs no count to know.
 */
export const RosterOk = z.object({
  space_ids: z.array(z.string()),
  rows: z.array(z.object({
    space_id: z.string(),
    actor_id: z.string(),
    role: z.string(),
    joined_at: z.number().int(),
  })),
  next_after: z.object({ space_id: z.string(), actor_id: z.string() }).nullable(),
  complete: z.boolean(),
});
export type RosterOk = z.infer<typeof RosterOk>;

export const OUTBOUND: Bodies = {
  welcome: Welcome, pong: Pong, too_old: TooOld, ev: Ev,
  catchup_ok: CatchupOk, gap: Gap, backfill_ok: BackfillOk,
  repair_ok: RepairOk, thread_ok: ThreadOk,
  directory_ok: DirectoryOk, ack: AckFrame, nack: NackFrame,
  agent_definition_ok: AgentDefinitionOk, agent_activity: AgentActivity,
  connections: ConnectionsPush, agent_permissions: AgentPermissionsPush,
  roster_ok: RosterOk,
};

/**
 * Serialise a frame. The one place `t` is attached, so it cannot be forgotten.
 *
 * `traceparent` is attached here too, and omitted entirely when there is no
 * active span — an `undefined` would serialise to nothing useful and a literal
 * `null` would be a field every receiver has to know to ignore. The body is
 * spread FIRST so a body that wrongly carries a reserved key loses to the
 * envelope rather than shadowing it (the reserved-key rule, above).
 */
export function frame(
  t: string, body: Record<string, unknown> = {}, traceparent?: string | undefined,
): string {
  return JSON.stringify(
    traceparent === undefined ? { ...body, t } : { ...body, t, traceparent });
}
