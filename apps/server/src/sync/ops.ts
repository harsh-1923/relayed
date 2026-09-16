// The write path's domain layer: send, delete, and marking a chat read.
// Phase 2 step C (PHASE-2-SYNC.md §3).
//
// Plain functions over the database, callable without a socket in sight. Step D
// puts frames in front of them; nothing here knows a socket exists, which is
// what lets every rule below be tested without one.
//
// Shapes are camelCase and domain-shaped, not wire-shaped. The wire format is
// settled in step D and mapped there — keeping the two apart means the ledger
// stores a result the transport can reshape, rather than pinning the protocol
// to whatever this file happened to return first.
import { sql, type Kysely, type Transaction } from 'kysely';
import { can, chat as chatTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { loadGrants, Forbidden } from '../authz/can.ts';
import { chatPlacement } from './placement.ts';
import { allocateChat, applyOnce } from './allocate.ts';
import { appendEvent, type AppendedEvent } from './events.ts';
import {
  AudienceError, toColumn, fromColumn, receives, type Audience,
} from './visibility.ts';
import { Parts, forbiddenPartKind, type MessagePart } from '@relayed/protocol';
import { deriveBody, uiPartRefusal } from '@relayed/genui';
import { startSpan, annotate, mark, count } from '@relayed/telemetry';
import { startMentionedRuns } from '../agents/checkpoints.ts';

/** The message named by an op does not exist. */
export class MessageNotFoundError extends Error {
  readonly messageId: string;
  constructor(messageId: string) {
    super(`no message ${messageId}`);
    this.name = 'MessageNotFoundError';
    this.messageId = messageId;
  }
}

/**
 * What the server tells the sender happened.
 *
 * `ord` is null for a delete, and that is the two-counter model reaching the
 * caller: a delete takes a revision and no ordinal, so the message does not
 * move and nothing else is renumbered (DESIGN.md §8.1).
 */
export interface Ack {
  messageId: string;
  chatId: string;
  ord: number | null;
  rev: number;
  /** Server time, which wins. The client's optimistic value is overwritten. */
  createdAt: string;
}

/**
 * What an op produced: what to tell the sender, and what happened.
 *
 * Two outputs for two audiences. The ack reconciles the sender's outbox row;
 * the event is what everybody else learns, and the caller decides who that is —
 * which is how `ops.ts` still knows nothing about sockets.
 *
 * `event` IS ABSENT ON A REPLAY, and that absence is load-bearing. A retried op
 * returns the stored ack without running the work, so nothing new happened —
 * fanning out here would deliver a duplicate message to every other device
 * while the sender's own ack correctly reported one.
 */
export interface Applied {
  ack: Ack;
  event?: AppendedEvent;
  /** Runs a mention in this send just admitted (WORKSPACE-AGENTS.md §5.2). Empty on a replay. */
  runIds: string[];
}

export interface SendInput {
  opId: string;
  chatId: string;
  actorId: string;
  /** Client-generated ULID, chosen before any network contact (§10.1). */
  messageId: string;
  body: string;
  parentId?: string | null;
  /**
   * Parts, when the message is made of them. The server then derives `body`
   * and the one sent is only what the client drew while it waited. A person's
   * send may carry `markdown` and `reply_to_ui`; `tool` and `ui` are refused.
   */
  parts?: readonly unknown[];
}

/**
 * Append a message.
 *
 * Deliberately takes no client timestamp. Client clocks are skewed, adjusted
 * mid-session and occasionally years wrong, so anything cross-device is stamped
 * here (DESIGN.md §13.7). The client's own clock renders its pending row and is
 * replaced by the value in this ack.
 */
export async function send(db: Kysely<DB>, input: SendInput): Promise<Applied> {
  return startSpan('ops.send', () => sendInner(db, input),
                   { attributes: { chat_id: input.chatId, op_id: input.opId } });
}

async function sendInner(db: Kysely<DB>, input: SendInput): Promise<Applied> {
  const authorize = await chatGate(db, input.actorId, input.chatId);
  mark('authorized');
  authorize('post');

  // Captured from the closure rather than returned through the ledger, because
  // the ledger stores the ACK verbatim and hands it back on a replay. Putting
  // the event in there too would make a replay hand back an event as well, and
  // the caller would fan out a message that was already delivered.
  let event: AppendedEvent | undefined;
  // Same reasoning as `event`: a replay must not start a second run for a
  // mention that already ran once (invariant 76's sibling).
  let runIds: string[] = [];

  const applied = await applyOnce(db, {
    opId: input.opId, actorId: input.actorId, chatId: input.chatId, kind: 'send',
  }, async (trx) => {
    // A client's message is for the whole chat, always. There is no field on
    // the op a client could put an audience in (the op schema declares none, so
    // parsing drops one), and this is the only place a client send reaches
    // the writer (WORKSPACE-AGENTS.md §8.8).
    const written = await writeMessage(trx, {
      kind: 'actor',
      chatId: input.chatId, messageId: input.messageId, authorId: input.actorId,
      parentId: input.parentId ?? null, audience: { kind: 'stream' },
      ...(input.parts !== undefined ? { parts: input.parts } : { body: input.body }),
    });
    event = written.event;

    // THE HANDOFF, INSIDE THE SAME TRANSACTION as the message and its event
    // (WORKSPACE-AGENTS.md §5.2). `send()` is reached only from a client op —
    // every actor here is a person, and a client send is always for the whole
    // chat — so §5.1's other two conditions (a person, the op is `send`) hold
    // by construction; only "does it mention a member agent" is asked.
    const body = (written.event.payload as { body: string }).body;
    runIds = await startMentionedRuns(trx, {
      chatId: input.chatId, messageId: input.messageId, authorId: input.actorId, body,
      invokerActorId: input.actorId, depth: 1,
    });

    return written.ack;
  });

  // Narrowed rather than cast: `event` is always set when the work ran, but the
  // compiler cannot see that through a closure, and a cast here would be the one
  // place a genuine bug could hide behind an assertion.
  // `replayed` on the span rather than only in the return value: from the
  // outside a replay and a fresh write look identical, and the idempotency
  // ledger doing its job is exactly what somebody chasing a duplicate needs to
  // see (invariant 5).
  // `?? undefined` rather than `?? 0`: a delete genuinely has no ordinal, and
  // an attribute that is absent reads as absent, while a zero reads as one.
  annotate({ replayed: applied.replayed, ord: applied.result.ord ?? undefined,
             rev: applied.result.rev });
  if (applied.replayed || !event) return { ack: applied.result, runIds: [] };
  return { ack: applied.result, event, runIds };
}

/**
 * What a message says: a body, or parts it is derived from — never both.
 *
 * "Both" would be two sources for what a reader sees, and the rule is that
 * `body` is Relayed's, derived from the parts, and never a model's or a
 * client's (AGENT-RESPONSES.md, decisions §1). The union makes passing both a
 * compile error rather than a body silently ignored.
 */
export type MessageContent =
  | { body: string; parts?: never; trustedParts?: never }
  | { parts: readonly unknown[]; body?: never; trustedParts?: never }
  /**
   * Server-authored parts, already `MessagePart`s, with the body to store
   * beside them — never a model's or a client's input, so none of
   * `contentOf`'s untrusted-input checks apply, and `trustedBody` is required
   * rather than derived: an `access_request` part carries only ids, and a
   * sentence needs names `@relayed/genui` has no way to look up. The access
   * card (`access.ts`) is the one caller today; its part is `SERVER_ONLY`
   * (`@relayed/protocol`) and would be refused by the ordinary `parts` path
   * regardless of author.
   */
  | { trustedParts: readonly MessagePart[]; trustedBody: string; body?: never; parts?: never };

/** Parts a writer may not store, and why — for a nack, never carrying the source. */
export class PartsRefusedError extends Error {
  /** `invalid` shape, a kind this author may not write, or a `ui` block that does not validate. */
  readonly reason: 'invalid' | 'forbidden_kind' | 'invalid_ui';
  /** The forbidden kind, or the ui error code — a closed set, safe to report. */
  readonly detail: string | null;
  constructor(reason: 'invalid' | 'forbidden_kind' | 'invalid_ui', detail: string | null = null) {
    super(detail ? `parts refused: ${reason} (${detail})` : `parts refused: ${reason}`);
    this.name = 'PartsRefusedError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The body and parts to store, from what a writer gave — checked as
 * AGENT-RESPONSES.md's rules for rooms (§7) require:
 *
 * 1. the shape, strictly: known kinds, the part limits, nothing extra kept;
 * 2. `tool` and `ui` parts only on an AGENT's message — on a person's they are
 *    a costume (`forbiddenPartKind`; the renderer's `undrawablePartKind` is the
 *    same rule except for access cards, which only the broker writes);
 * 3. every `ui` block validates, against a library this build can read —
 *    because the server must be able to derive `body` from every block it
 *    stores.
 *
 * The author's type is read only when there are parts, so a plain send costs
 * no statement.
 */
async function contentOf(
  trx: Transaction<DB>, authorId: string, content: MessageContent,
): Promise<{ body: string; parts: MessagePart[] | null }> {
  if (content.trustedParts !== undefined) {
    return { body: content.trustedBody, parts: content.trustedParts as MessagePart[] };
  }
  if (content.parts === undefined) return { body: content.body, parts: null };

  const refuse = (reason: 'invalid' | 'forbidden_kind' | 'invalid_ui', detail: string | null = null): never => {
    count('sync.parts.refused', { parts_refusal: reason });
    throw new PartsRefusedError(reason, detail);
  };

  const validated = Parts.safeParse(content.parts);
  if (!validated.success) {
    // A direct throw, not through `refuse`: a helper called for its side
    // effect does not narrow a discriminated union the way an inline
    // `if (!x.success) throw` does, and `validated.data` is used below.
    count('sync.parts.refused', { parts_refusal: 'invalid' });
    throw new PartsRefusedError('invalid');
  }
  const parts = validated.data;

  const author = await trx.selectFrom('actors').select('type')
    .where('id', '=', authorId).executeTakeFirst();
  const forbidden = forbiddenPartKind(author?.type ?? 'human', parts);
  if (forbidden !== null) refuse('forbidden_kind', forbidden);

  for (const part of parts) {
    if (part.kind !== 'ui') continue;
    const refusal = uiPartRefusal(part);
    if (refusal !== null) refuse('invalid_ui', refusal);
  }
  return { body: deriveBody(parts), parts };
}

/** A JSONB value, serialised here: node-postgres would send an array as a Postgres array. */
const jsonb = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

interface MessageWriteCommon {
  chatId: string;
  messageId: string;
  authorId: string;
  /** Required, with no default: a writer that forgets must not compile (§8.5). */
  audience: Audience;
}

/**
 * A system row's write, discriminated from an ordinary one by `kind` rather
 * than a second insertion path (SPACE-MEMBERSHIP-MARKERS.md — `writeMessage`
 * stays the only function that inserts a message). No parent, no parts, no
 * delegation: a system row is never a reply, is never made of parts, and is
 * never spending anyone's authority — it is the server recording its own
 * successful command.
 */
export type MessageWrite = MessageWriteCommon & (
  | ({
      kind: 'actor';
      parentId: string | null;
      /**
       * Delegation attribution (§5.7, `DESIGN.md` §6.4): whose authority the
       * author spent, and the run that spent it. Absent for an ordinary
       * message — a person's send never sets these, and neither does a card
       * in v1.
       */
      onBehalfOfActorId?: string;
      delegationId?: string;
    } & MessageContent)
  | {
      kind: 'system';
      systemKind: 'space.member_added';
      subjectActorId: string;
      /** The compatibility rendering, captured at write time. */
      body: string;
    }
);

/**
 * Write one message and its event, inside a transaction the caller owns.
 *
 * THE ONLY FUNCTION THAT INSERTS A MESSAGE (a boundary rule holds it), which is
 * what makes the column's NULL safe to mean "the whole chat": the audience is a
 * required argument here, so no writer reaches the table without stating one.
 * A client's send and an agent run's reply and public cards call this with
 * `stream`; the dev route, the only writer of a restricted message while those
 * are dormant, calls it with a list.
 *
 * Authorising the AUTHOR is the caller's job, because the callers differ: a
 * client send checks `post` against the sender's grants before its op is
 * ledgered, and an agent's reply is authorised by its run. What is checked here
 * is what no caller may skip — the audience itself.
 */
export async function writeMessage(
  trx: Transaction<DB>, input: MessageWrite,
): Promise<{ ack: Ack; event: AppendedEvent }> {
  const visibleTo = toColumn(input.audience);

  // EVERY LISTED ACTOR MUST BE ABLE TO READ THE CHAT when it is written
  // (§8.8). A message addressed to somebody outside the room would sit in the log
  // naming them, delivered to nobody and implying a relationship that does not
  // exist. One placement, a grant load per listed actor — a list is a handful.
  if (visibleTo !== null) {
    const placement = await chatPlacement(trx, input.chatId);
    for (const actorId of visibleTo) {
      const grants = await loadGrants(trx, actorId);
      if (!can(grants, 'read', chatTarget(input.chatId), placement)) {
        throw new AudienceError('cannot_read', actorId);
      }
    }
  }

  // A system row is never a reply — the parent-check below is for `kind:
  // 'actor'` alone, and reads as a no-op (its guard is `parentId !== null`).
  const parentId = input.kind === 'actor' ? input.parentId : null;

  // NOTHING REPLIES TO A RESTRICTED MESSAGE in v1 (§8.8): a thread under one
  // would need every reply restricted too, and nothing needs it. Read only for
  // a reply, so a top-level send costs no statement. Refused as NOT FOUND to an
  // author who cannot see the parent — the answer they would get for an id that
  // does not exist — and as forbidden to one who can.
  if (parentId !== null) {
    const parent = await trx.selectFrom('messages').select('visible_to')
      .where('id', '=', parentId).where('chat_id', '=', input.chatId)
      .executeTakeFirst();
    if (parent && parent.visible_to !== null) {
      if (!parent.visible_to.includes(input.authorId)) {
        throw new MessageNotFoundError(parentId);
      }
      throw new Forbidden('reply', chatTarget(input.chatId));
    }
  }

  // A system row skips shape/forbidden-kind/UI validation entirely — its body
  // is the server's own compatibility rendering, never a client's or a
  // model's input to distrust.
  const { body, parts } = input.kind === 'system'
    ? { body: input.body, parts: null }
    : await contentOf(trx, input.authorId, input);

  const allocated = await allocateChat(trx, input.chatId, true);
  const row = await trx.insertInto('messages').values({
    id: input.messageId, chat_id: input.chatId, parent_id: parentId,
    ord: allocated.ord as number, rev: allocated.rev,
    author_id: input.authorId, body, visible_to: visibleTo,
    parts: parts === null ? null : jsonb(parts),
    on_behalf_of_actor_id: input.kind === 'actor' ? (input.onBehalfOfActorId ?? null) : null,
    delegation_id: input.kind === 'actor' ? (input.delegationId ?? null) : null,
    message_kind: input.kind,
    system_kind: input.kind === 'system' ? input.systemKind : null,
    subject_actor_id: input.kind === 'system' ? input.subjectActorId : null,
  }).returning('created_at').executeTakeFirstOrThrow();

  // The space's activity clock, which drives auto-dormancy and sidebar order.
  // Bumped here and not in the allocator, because a delete is activity for the
  // sync cursor but not a reason to keep a space out of the "inactive" list.
  //
  // NOT for a restricted message, for the same reason as a system row: a
  // system row is administrative history, not something that should bump the
  // space to the top of the sidebar as if new conversation happened (§8.7,
  // SPACE-MEMBERSHIP-MARKERS.md).
  if (visibleTo === null && input.kind !== 'system') {
    await trx.updateTable('spaces')
      .set({ last_activity_at: sql`now()` })
      .where('id', 'in', eb => eb.selectFrom('chats').select('space_id')
        .where('id', '=', input.chatId))
      .execute();
  }

  const ack = ackOf(input.messageId, input.chatId,
                    allocated.ord, allocated.rev, row.created_at);

  // The event carries the ack's OWN timestamp, not a second reading of the
  // clock. The sender applies the ack and every other device applies the
  // event; if the two disagreed, one message would render at two different
  // times depending on which device you looked at.
  const event = await appendEvent(trx, allocated, 'message.created', {
    id: ack.messageId,
    ord: allocated.ord as number,
    parent_id: parentId,
    author_id: input.authorId,
    body,
    created_at: ack.createdAt,
    ...(visibleTo !== null ? { visible_to: visibleTo } : {}),
    ...(parts !== null ? { parts } : {}),
    ...(input.kind === 'actor' && input.onBehalfOfActorId ? { on_behalf_of_actor_id: input.onBehalfOfActorId } : {}),
    ...(input.kind === 'actor' && input.delegationId ? { delegation_id: input.delegationId } : {}),
    ...(input.kind === 'system'
      ? { message_kind: 'system' as const, system_kind: input.systemKind, subject_actor_id: input.subjectActorId }
      : {}),
  }, fromColumn(visibleTo));

  return { ack, event };
}

export interface DeleteInput {
  opId: string;
  chatId: string;
  actorId: string;
  messageId: string;
}

/**
 * Tombstone a message.
 *
 * The row stays and keeps its ordinal; only the body is cleared. A gap in the
 * ordinal sequence is normal and permanent — `ord` is never renumbered or
 * reused, or read cursors and scroll positions corrupt across every client that
 * already saw the original.
 *
 * Deleting an already-deleted message still allocates a revision rather than
 * short-circuiting. Two people deleting the same message is not an error, the
 * event is idempotent where it lands, and the special case would earn nothing
 * but a branch.
 */
export async function deleteMessage(db: Kysely<DB>, input: DeleteInput): Promise<Applied> {
  return startSpan('ops.delete', () => deleteInner(db, input),
                   { attributes: { chat_id: input.chatId, op_id: input.opId } });
}

async function deleteInner(db: Kysely<DB>, input: DeleteInput): Promise<Applied> {
  // ONE snapshot of grants and placement, asked TWO questions. Loading twice
  // was two wasted round trips and, worse, two chances to disagree: a
  // membership revoked between the reads would have let the first check pass
  // against grants the second no longer had. can() is pure, so a second
  // question against the same snapshot costs nothing.
  const authorize = await chatGate(db, input.actorId, input.chatId);

  // Chat access FIRST, before the message is read. Reading it to discover its
  // author would tell a non-member whether the message exists.
  authorize('read');

  const message = await db.selectFrom('messages')
    .select(['id', 'chat_id', 'author_id', 'parent_id', 'visible_to'])
    .where('id', '=', input.messageId)
    .executeTakeFirst();
  // A message the actor may not see does not exist, as far as they are told —
  // checked before the author is compared, for the same reason chat access is:
  // `forbidden` would confirm there is something there.
  const audience = fromColumn(message?.visible_to ?? null);
  if (!message || message.chat_id !== input.chatId || !receives(audience, input.actorId)) {
    throw new MessageNotFoundError(input.messageId);
  }

  // Deleting your own needs membership; deleting somebody else's is moderation,
  // and moderation is an admin power held at the SPACE rather than at the chat.
  // Both questions go to can(), which is where that distinction is written down.
  authorize(message.author_id === input.actorId ? 'delete_own' : 'delete_any');

  let event: AppendedEvent | undefined;

  const applied = await applyOnce(db, {
    opId: input.opId, actorId: input.actorId, chatId: input.chatId, kind: 'delete',
  }, async (trx) => {
    const allocated = await allocateChat(trx, input.chatId, false);
    // `rev` is NOT set here. The event catalogue bumps the version of every
    // message an event touches — this one and, for a reply, its parent — so a
    // change to what a message looks like cannot be made without its version
    // moving (the version rule, events.ts).
    const row = await trx.updateTable('messages')
      .set({ deleted: true, body: '' })
      .where('id', '=', input.messageId)
      .returning('created_at')
      .executeTakeFirstOrThrow();

    // The id and the parent. A recipient that never held this message writes
    // nothing at all and merely accounts for the revision — which is the case
    // that forces the frontier to be tracked explicitly rather than derived
    // from rows, and the reason `delete` is in this phase at all
    // (PHASE-2-SYNC.md §1).
    //
    // The delete of a restricted message is restricted to the same people:
    // everyone else receives its revision as `withheld`, exactly as they did
    // its creation, so nothing about it — not even that the hidden message was
    // deleted — reaches them (§8.4).
    event = await appendEvent(trx, allocated, 'message.deleted',
      { id: input.messageId, parent_id: message.parent_id }, audience);

    return ackOf(input.messageId, input.chatId, null, allocated.rev, row.created_at);
  });

  annotate({ replayed: applied.replayed, rev: applied.result.rev });
  // Narrowed rather than cast: `event` is always set when the work ran, but the
  // compiler cannot see that through a closure, and a cast here would be the one
  // place a genuine bug could hide behind an assertion.
  if (applied.replayed || !event) return { ack: applied.result, runIds: [] };
  return { ack: applied.result, event, runIds: [] };
}

export type MessageUpdate = {
  chatId: string;
  messageId: string;
} & MessageContent;

/**
 * Replace a message's content, as the server — `message.updated`.
 *
 * For server writers only, inside a transaction the caller owns: an access
 * card's state changing is the first (WORKSPACE-AGENTS.md §7.4). NOT a person's
 * edit, which is a client op with its own rules and its own event
 * (`message.edited`), and so this marks nothing edited. Authorising the change
 * is the caller's job, as it is for `writeMessage`.
 *
 * ALLOCATES FIRST, then reads. The allocation locks the chat's row, so a delete
 * of the same message — which allocates on the same row — either committed
 * before this read or waits until after this transaction; a message cannot be
 * deleted between the check and the update. A refusal after allocating costs
 * nothing, because it throws inside the caller's transaction and rolls the
 * revision back with it.
 *
 * The event goes to the message's own audience, so a restricted message's
 * update is withheld from everyone its creation was (§8.4).
 */
export async function updateMessage(
  trx: Transaction<DB>, input: MessageUpdate,
): Promise<AppendedEvent> {
  const allocated = await allocateChat(trx, input.chatId, false);
  const message = await trx.selectFrom('messages').select(['visible_to', 'author_id'])
    .where('id', '=', input.messageId).where('chat_id', '=', input.chatId)
    .where('deleted', '=', false)
    .executeTakeFirst();
  // A tombstone is not updated back to life, and an id from another chat is not
  // this chat's message: both are simply not found.
  if (!message) throw new MessageNotFoundError(input.messageId);

  // Checked against the message's AUTHOR, not whoever is updating it: a card
  // is an agent's message, and stays one.
  const { body, parts } = await contentOf(trx, message.author_id, input);

  // `rev` is not set here: the version rule bumps it (events.ts). Parts are
  // replaced whole — NULL when the new content is a body alone.
  await trx.updateTable('messages').set({ body, parts: parts === null ? null : jsonb(parts) })
    .where('id', '=', input.messageId).where('chat_id', '=', input.chatId)
    .execute();

  return appendEvent(trx, allocated, 'message.updated',
    { id: input.messageId, body, ...(parts !== null ? { parts } : {}) }, fromColumn(message.visible_to));
}

/**
 * Advance an actor's read cursor.
 *
 * A MAX-register, applied as `GREATEST`, never a blind overwrite (DESIGN.md §4).
 * The failure that prevents: someone reads on their laptop, then their phone —
 * asleep for an hour with stale state — reconnects and syncs. Under
 * last-write-wins the phone's older value wins and the chat goes unread again.
 *
 * No ledger entry and no revision. Read state is not part of the log: it is
 * per-actor, it converges by taking a maximum, and replaying the same value is
 * already a no-op — so idempotency here is a property of the operation rather
 * than something a ledger has to provide.
 */
export async function markRead(
  db: Kysely<DB>, actorId: string, chatId: string, ord: number,
): Promise<void> {
  (await chatGate(db, actorId, chatId))('read');
  await db.insertInto('chat_read_state')
    .values({ chat_id: chatId, actor_id: actorId, last_read_ord: ord })
    .onConflict(oc => oc.columns(['chat_id', 'actor_id']).doUpdateSet({
      // GREATEST, not SQLite's MAX(a,b) — the same register, a different
      // engine's spelling of it.
      last_read_ord: sql`GREATEST(chat_read_state.last_read_ord, EXCLUDED.last_read_ord)`,
      updated_at: sql`now()`,
    }))
    .execute();
}

/**
 * Read an actor's grants and a chat's placement once, and return something that
 * can be asked as many questions as an operation needs.
 *
 * Two round trips, whatever follows. `can()` is pure by design — grants and
 * placement in, boolean out — so every question after the first is free, and
 * every question is answered against the SAME snapshot. That second property is
 * the one that matters: an operation asking twice and loading twice could see a
 * membership change between the two and authorise a state that never existed.
 */
async function chatGate(
  db: Kysely<DB>, actorId: string, chatId: string,
): Promise<(action: string) => void> {
  const [grants, placement] = await Promise.all([
    loadGrants(db, actorId), chatPlacement(db, chatId),
  ]);
  return (action: string): void => {
    if (!can(grants, action, chatTarget(chatId), placement)) {
      throw new Forbidden(action, chatTarget(chatId));
    }
  };
}

const ackOf = (
  messageId: string, chatId: string, ord: number | null, rev: number, createdAt: unknown,
): Ack => ({
  messageId, chatId, ord, rev,
  // Normalised to an ISO string here rather than left as a Date, because this
  // value is stored in the ledger as JSON and replayed verbatim — a Date would
  // come back as a string on the replay and differ from the original ack.
  createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
});
