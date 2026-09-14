// Executable model of messages only some people can see, over the sync
// engine as it is BUILT (docs/WORKSPACE-AGENTS.md §8; plan step 1,
// docs/WORKSPACE-AGENTS-IMPL.md).
//
// WHY A SECOND MODEL rather than an extension of sync-model.mjs. That model
// derives catch-up from message rows, which is the pre-log design SYNC-FLOWS.md
// §12.1 calls unsound once anything but a send exists. Withholding is a property
// of the LOG — what each recipient is sent for each revision — so this models
// the production shape instead: a `sync_events` log carrying an audience, a
// fanout that narrows it, catch-up that redacts per requester, a client that
// stages whole envelopes above its frontier (apps/desktop/src/sync/apply.ts),
// and backfill whose `complete` is `rows.length < limit`
// (apps/server/src/sync/socket.ts).
//
// MUTANTS. Every class takes a `mutant` name. Each one is a specific,
// plausible implementation mistake from the proposal's §8.3–§8.7, switched on
// at the exact line it would be made. spikes/visibility-mutants.mjs runs the
// whole suite against each and fails if any survives: a check that cannot
// detect the bug it names is not a check.
import { DatabaseSync } from 'node:sqlite';

export const MUTANTS = {
  'drop-not-withhold':
    'Unlisted readers are simply not sent the revision (live), and catch-up omits it (§8.3)',
  'live-leak':
    'Fanout sends the full event to every reader of the chat (§8.6)',
  'catchup-leak':
    'Catch-up replays log rows without redacting them (§8.7, catch-up)',
  'withheld-carries-id':
    'The withheld frame carries the message id (§8.4)',
  'gap-tail-unfiltered':
    'The gap snapshot selects the newest messages without the visibility clause (§8.7, gap tail)',
  'backfill-filter-after-limit':
    'Backfill applies LIMIT in SQL and filters visibility afterwards in JavaScript (§8.7, backfill)',
  'counters-unfiltered':
    'Unread and mention counters count messages the reader cannot see (§8.7, unread)',
  'empty-means-everyone':
    'Visibility is a list narrowed to current members, and an empty list means the whole chat (§8.5)',
  'listed-bypasses-membership':
    'Fanout entitles every listed actor, whether or not they can still read the chat (§8.6)',
  'mutation-not-withheld':
    'Edits and deletes of a restricted message are logged for the whole stream (§8.4)',
  'activity-bumped-by-restricted':
    'A restricted message bumps the room\'s activity clock (§8.7, room activity)',
  'accept-empty-list':
    'A restricted write with an empty list is accepted, as a message for the whole chat (§8.5)',
  'accept-non-member-listed':
    'A restricted write may list someone who cannot read the chat (§8.8)',
  'client-withheld-ignored':
    'The client drops a withheld frame without accounting for its revision (§8.4)',
  'gap-clears-on-floor-only':
    'The client clears has_gap only when it holds ordinal 1, ignoring `complete` (§8.7, has_gap)',
  'unknown-type-stalls':
    'An event type the client does not know does not advance its frontier (invariant 32)',
  // ── gap repair: a held message changed while the client was past the threshold ──
  'no-repair':
    'The client takes a gap and never asks which held messages changed meanwhile',
  'repair-since-new-frontier':
    'Repair asks for changes since the frontier AFTER the gap, so it finds nothing',
  'repair-ord-bound-wrong':
    'Repair asks for changes to messages above the highest held ordinal instead of at or below it',
  'repair-drops-tombstones':
    'Repair returns only undeleted rows, so a deletion during the gap is never learned',
  'tail-drops-tombstones':
    'The gap tail leaves out deleted messages, so a held message deleted meanwhile keeps rendering',
  'backfill-drops-tombstones':
    'Backfill leaves out deleted messages, so a held message deleted meanwhile keeps rendering',
  'edit-does-not-bump':
    'An edit leaves the message\'s rev alone, so repair never returns the new body',
  'reaction-does-not-bump':
    'A reaction leaves the message\'s rev alone, so repair never returns the new reactions',
  'reply-does-not-bump-parent':
    'A reply leaves its parent\'s rev alone, so the parent\'s reply count goes stale',
  'delete-reply-does-not-bump-parent':
    'Deleting a reply leaves its parent\'s rev alone, so the parent\'s reply count goes stale',
  'reply-count-unfiltered':
    'A reply count includes replies the reader cannot see (a restricted reply, e.g. an access card)',
  'row-missing-reply-count':
    'Rows returned by the tail, backfill and repair carry no reply count',
  'delete-event-no-parent':
    'A delete event carries only the id, so a client holding the parent but not the reply cannot adjust the count',
  'row-overwrites-newer-state':
    'The client applies a fetched row without checking its version, so a live change that landed meanwhile is undone',
};

const json = (value) => JSON.stringify(value);

// ─── SERVER ──────────────────────────────────────────────────────────────────
export class Server {
  constructor({ gapThreshold = 500, replayLimit = 500, gapTail = 50, mutant = null, asBuilt = false } = {}) {
    if (mutant !== null && !(mutant in MUTANTS)) throw new Error(`unknown mutant ${mutant}`);
    /** The gap path as apps/server has it today: tail and backfill filter `deleted = false`. Findings only. */
    this.asBuilt = asBuilt;
    this.gapThreshold = gapThreshold;
    this.replayLimit = replayLimit;
    this.gapTail = gapTail;
    this.mutant = mutant;
    /** Every frame the server decided to send, and to whom. */
    this.emitted = [];
    /**
     * Frames that should never have been sent, judged AT THE MOMENT OF SENDING
     * from ground truth (membership and listing rows), never from the predicate
     * under test. Judged later, a frame legitimately sent before someone left
     * would read as a leak.
     */
    this.leaks = [];
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE chats(id TEXT PRIMARY KEY, next_ord INTEGER NOT NULL DEFAULT 0,
        next_rev INTEGER NOT NULL DEFAULT 0, activity_bumps INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE members(chat_id TEXT, actor_id TEXT, left_at INTEGER,
        PRIMARY KEY(chat_id, actor_id));
      CREATE TABLE messages(
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, parent_id TEXT, ord INTEGER NOT NULL,
        -- rev is the message's VERSION: the revision of the last change to how it
        -- renders. Bumped by the event catalogue (TOUCHES), never by hand.
        rev INTEGER NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0,
        audience TEXT NOT NULL CHECK (audience IN ('chat','listed')));
      CREATE INDEX msg_rev ON messages(chat_id, rev);
      CREATE TABLE reactions(message_id TEXT NOT NULL, emoji TEXT NOT NULL, actor_id TEXT NOT NULL,
        PRIMARY KEY(message_id, emoji, actor_id));
      CREATE TABLE message_audience(message_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        PRIMARY KEY(message_id, actor_id));
      -- The same constraint as migration 009, in SQLite's words. SQLite's
      -- json_array_length is NULL for NULL and 0 for '[]', which is exactly the
      -- shape of the Postgres trap, so the IS NOT NULL matters here too.
      CREATE TABLE sync_events(
        chat_id TEXT NOT NULL, rev INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        audience TEXT NOT NULL, listed TEXT,
        PRIMARY KEY(chat_id, rev),
        CONSTRAINT sync_event_audience CHECK (
             (audience = 'stream' AND listed IS NULL)
          OR (audience = 'listed' AND listed IS NOT NULL AND json_array_length(listed) >= 1)));
      CREATE TABLE ops(op_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE reads(chat_id TEXT, actor_id TEXT, last_read_ord INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(chat_id, actor_id));
    `);
  }

  createChat(chatId) { this.db.prepare('INSERT INTO chats(id) VALUES(?)').run(chatId); }

  join(chatId, actorId) {
    this.db.prepare(`INSERT INTO members VALUES(?,?,NULL)
      ON CONFLICT(chat_id, actor_id) DO UPDATE SET left_at = NULL`).run(chatId, actorId);
    this.db.prepare('INSERT OR IGNORE INTO reads VALUES(?,?,0)').run(chatId, actorId);
  }

  leave(chatId, actorId) {
    this.db.prepare('UPDATE members SET left_at = 1 WHERE chat_id=? AND actor_id=?').run(chatId, actorId);
  }

  isMember(chatId, actorId) {
    const row = this.db.prepare('SELECT left_at FROM members WHERE chat_id=? AND actor_id=?').get(chatId, actorId);
    return Boolean(row) && row.left_at === null;
  }

  /** audienceFor(chat event): who may read the chat. Unchanged by restricted messages (§8.6). */
  readers(chatId) {
    return this.db.prepare('SELECT actor_id FROM members WHERE chat_id=? AND left_at IS NULL ORDER BY actor_id')
      .all(chatId).map(row => row.actor_id);
  }

  listedFor(messageId) {
    return this.db.prepare('SELECT actor_id FROM message_audience WHERE message_id=? ORDER BY actor_id')
      .all(messageId).map(row => row.actor_id);
  }

  /**
   * The read predicate, in JavaScript, for the paths that decide per event
   * rather than per query. MUST agree with `visibleSql` — the property test
   * compares both against an independent ground truth.
   */
  canSee(actorId, message) {
    if (!this.isMember(message.chat_id, actorId)) return false;          // the leading conjunct
    if (message.audience === 'chat') return true;
    const listed = this.listedFor(message.id);
    if (this.mutant === 'empty-means-everyone') {
      const stillHere = listed.filter(actor => this.isMember(message.chat_id, actor));
      return stillHere.length === 0 || stillHere.includes(actorId);
    }
    return listed.includes(actorId);
  }

  /** The SQL clause every message-reading query adds before its LIMIT (§8.7). */
  visibleSql(alias = 'm') {
    if (this.mutant === 'empty-means-everyone') {
      return `(${alias}.audience = 'chat'
        OR NOT EXISTS (SELECT 1 FROM message_audience a JOIN members mm
                         ON mm.chat_id = ${alias}.chat_id AND mm.actor_id = a.actor_id AND mm.left_at IS NULL
                       WHERE a.message_id = ${alias}.id)
        OR EXISTS (SELECT 1 FROM message_audience a WHERE a.message_id = ${alias}.id AND a.actor_id = ?))`;
    }
    return `(${alias}.audience = 'chat'
      OR EXISTS (SELECT 1 FROM message_audience a WHERE a.message_id = ${alias}.id AND a.actor_id = ?))`;
  }

  #allocate(chatId, withOrd) {
    const chat = this.db.prepare('SELECT next_ord, next_rev FROM chats WHERE id=?').get(chatId);
    const rev = chat.next_rev + 1;
    const ord = withOrd ? chat.next_ord + 1 : null;
    this.db.prepare('UPDATE chats SET next_ord=?, next_rev=? WHERE id=?')
      .run(withOrd ? ord : chat.next_ord, rev, chatId);
    return { ord, rev };
  }

  /**
   * THE VERSION RULE, declared once per event type: which messages this event
   * changes the rendering of. `#append` bumps every one of them to the event's
   * revision in the same transaction as the log row, so a message's `rev` is
   * always the revision of its last visible change — which is what lets repair
   * (below) find "everything that changed while I was away" with one range scan.
   *
   * A reply touches its PARENT: the parent's reply count changed. Deleting a
   * reply touches both. In production this table is the event catalogue in
   * apps/server/src/sync/events.ts, and a type with no entry does not compile.
   */
  touches(type, payload) {
    switch (type) {
      case 'message.created':
        return this.mutant === 'reply-does-not-bump-parent' || !payload.parent_id
          ? [payload.id] : [payload.id, payload.parent_id];
      case 'message.edited':
        return this.mutant === 'edit-does-not-bump' ? [] : [payload.id];
      case 'message.deleted': {
        const parent = this.db.prepare('SELECT parent_id FROM messages WHERE id=?').get(payload.id)?.parent_id;
        return parent && this.mutant !== 'delete-reply-does-not-bump-parent' ? [payload.id, parent] : [payload.id];
      }
      case 'message.reacted':
        return this.mutant === 'reaction-does-not-bump' ? [] : [payload.id];
      default: throw new Error(`event type ${type} declares nothing it touches`);
    }
  }

  #append(chatId, rev, type, payload, audience) {
    this.db.prepare('INSERT INTO sync_events VALUES(?,?,?,?,?,?)').run(
      chatId, rev, type, json(payload),
      audience.kind === 'listed' ? 'listed' : 'stream',
      audience.kind === 'listed' ? json(audience.actors) : null);
    for (const messageId of this.touches(type, payload)) {
      this.db.prepare('UPDATE messages SET rev=? WHERE id=?').run(rev, messageId);
    }
    return { chat_id: chatId, rev, type, payload, audience };
  }

  #replay(opId, actorId) {
    const prior = this.db.prepare('SELECT actor_id, result FROM ops WHERE op_id=?').get(opId);
    if (!prior) return null;
    if (prior.actor_id !== actorId) throw new Error(`op ${opId} belongs to another actor`);
    return JSON.parse(prior.result);
  }

  #transaction(work) {
    this.db.exec('BEGIN');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /**
   * writeMessage (plan step 1). `listed` null is a message for the chat; an
   * array is a restricted message. Returns `{ ack, event }`, with no event on a
   * replay — the same contract as apps/server/src/sync/ops.ts.
   */
  send({ opId, chatId, messageId, authorId, body, parentId = null, listed = null }) {
    return this.#transaction(() => {
      const prior = this.#replay(opId, authorId);
      if (prior) return { ack: prior };

      let restricted = listed !== null;
      if (restricted && listed.length === 0) {
        if (this.mutant !== 'accept-empty-list') throw new Error('a restricted message must list at least one actor');
        restricted = false;
      }
      if (restricted && this.mutant !== 'accept-non-member-listed') {
        for (const actor of listed) {
          if (!this.isMember(chatId, actor)) throw new Error(`${actor} cannot read ${chatId}`);
        }
      }

      const { ord, rev } = this.#allocate(chatId, true);
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,0,0,?)').run(
        messageId, chatId, parentId, ord, rev, authorId, body, restricted ? 'listed' : 'chat');
      if (restricted) {
        for (const actor of new Set(listed)) {
          this.db.prepare('INSERT INTO message_audience VALUES(?,?)').run(messageId, actor);
        }
      }
      if (!restricted || this.mutant === 'activity-bumped-by-restricted') {
        this.db.prepare('UPDATE chats SET activity_bumps = activity_bumps + 1 WHERE id=?').run(chatId);
      }

      const sortedListed = restricted ? [...new Set(listed)].sort() : null;
      const event = this.#append(chatId, rev, 'message.created',
        { id: messageId, ord, parent_id: parentId, author_id: authorId, body },
        restricted ? { kind: 'listed', actors: sortedListed } : { kind: 'stream' });
      const ack = { id: messageId, chat_id: chatId, ord, rev };
      this.db.prepare('INSERT INTO ops VALUES(?,?,?)').run(opId, authorId, json(ack));
      return { ack, event };
    });
  }

  #mutate({ opId, actorId, messageId }, type, apply) {
    return this.#transaction(() => {
      const prior = this.#replay(opId, actorId);
      if (prior) return { ack: prior };
      const message = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      if (!message) throw new Error(`no message ${messageId}`);
      const { rev } = this.#allocate(message.chat_id, false);
      const payload = apply(message, rev);
      const audience = message.audience === 'listed' && this.mutant !== 'mutation-not-withheld'
        ? { kind: 'listed', actors: this.listedFor(messageId) }
        : { kind: 'stream' };
      const event = this.#append(message.chat_id, rev, type, payload, audience);
      const ack = { id: messageId, chat_id: message.chat_id, ord: null, rev };
      this.db.prepare('INSERT INTO ops VALUES(?,?,?)').run(opId, actorId, json(ack));
      return { ack, event };
    });
  }

  edit({ opId, actorId, messageId, body }) {
    return this.#mutate({ opId, actorId, messageId }, 'message.edited', () => {
      this.db.prepare('UPDATE messages SET body=?, edited=1 WHERE id=?').run(body, messageId);
      return { id: messageId, body };
    });
  }

  react({ opId, actorId, messageId, emoji, present }) {
    return this.#mutate({ opId, actorId, messageId }, 'message.reacted', () => {
      if (present) this.db.prepare('INSERT OR IGNORE INTO reactions VALUES(?,?,?)').run(messageId, emoji, actorId);
      else this.db.prepare('DELETE FROM reactions WHERE message_id=? AND emoji=? AND actor_id=?').run(messageId, emoji, actorId);
      return { id: messageId, emoji, actor_id: actorId, present };
    });
  }

  del({ opId, actorId, messageId }) {
    return this.#mutate({ opId, actorId, messageId }, 'message.deleted', (message) => {
      this.db.prepare("UPDATE messages SET deleted=1, body='' WHERE id=?").run(messageId);
      // The parent rides along so a client holding the parent but not the reply
      // can still adjust the count it shows.
      return this.mutant === 'delete-event-no-parent' || !message.parent_id
        ? { id: messageId } : { id: messageId, parent_id: message.parent_id };
    });
  }

  reactionsOf(messageId) {
    return this.db.prepare('SELECT emoji, actor_id FROM reactions WHERE message_id=? ORDER BY emoji, actor_id')
      .all(messageId).map(row => `${row.emoji}:${row.actor_id}`);
  }

  /**
   * Replies to `rootId` this reader may see — the reply count is PER READER,
   * because a reply can be restricted (an access card is one, §7.4) and a count
   * that included it would tell the reader something exists that they cannot open.
   */
  replyCountFor(rootId, actorId) {
    const clause = this.mutant === 'reply-count-unfiltered' ? '1=1' : this.visibleSql('m');
    const params = this.mutant === 'reply-count-unfiltered' ? [rootId] : [rootId, actorId];
    return this.db.prepare(
      `SELECT COUNT(*) AS n FROM messages m WHERE m.parent_id=? AND m.deleted=0 AND ${clause}`).get(...params).n;
  }

  #withheld(chatId, rev, payload) {
    const frame = { t: 'ev', c: chatId, rev, type: 'withheld', payload: {} };
    if (this.mutant === 'withheld-carries-id') frame.payload = { id: payload.id };
    return frame;
  }

  #full(chatId, rev, type, payload, audience, actorId) {
    const body = { ...payload };
    if (audience.kind === 'listed' && type === 'message.created') body.visible_to = audience.actors;
    return { t: 'ev', c: chatId, rev, type, payload: body };
  }

  #emit(path, actorId, frame) {
    this.emitted.push({ path, actorId, frame });
    if (frame.type === 'withheld') {
      const keys = Object.keys(frame).sort().join(',');
      if (keys !== 'c,payload,rev,t,type' || Object.keys(frame.payload).length !== 0) {
        this.leaks.push(`${path}: withheld frame to ${actorId} carries data ${json(frame)}`);
      }
      return frame;
    }
    const messageId = frame.t === 'row' ? frame.row.id : frame.payload?.id;
    if (messageId) {
      const message = this.db.prepare('SELECT chat_id, audience FROM messages WHERE id=?').get(messageId);
      const member = this.db.prepare('SELECT 1 FROM members WHERE chat_id=? AND actor_id=? AND left_at IS NULL')
        .get(message.chat_id, actorId);
      const listed = this.db.prepare('SELECT 1 FROM message_audience WHERE message_id=? AND actor_id=?')
        .get(messageId, actorId);
      if (!member || (message.audience === 'listed' && !listed)) {
        this.leaks.push(`${path}: sent ${frame.type ?? 'row'} of ${messageId} to ${actorId}`);
      }
    }
    return frame;
  }

  /**
   * Fanout (apps/server/src/sync/fanout.ts), narrowed as §8.6 orders it:
   * readers first, the listed intersected INTO them.
   * Returns `[actorId, frame]` pairs.
   */
  deliver(event) {
    const readers = this.readers(event.chat_id);
    const out = [];
    if (event.audience.kind === 'stream' || this.mutant === 'live-leak') {
      for (const actor of readers) {
        out.push([actor, this.#emit('live', actor,
          this.#full(event.chat_id, event.rev, event.type, event.payload, event.audience, actor))]);
      }
      return out;
    }
    const listed = event.audience.actors;
    const entitled = this.mutant === 'listed-bypasses-membership'
      ? listed
      : readers.filter(actor => listed.includes(actor));
    for (const actor of entitled) {
      out.push([actor, this.#emit('live', actor,
        this.#full(event.chat_id, event.rev, event.type, event.payload, event.audience, actor))]);
    }
    if (this.mutant === 'drop-not-withhold') return out;
    for (const actor of readers.filter(reader => !entitled.includes(reader))) {
      out.push([actor, this.#emit('live', actor, this.#withheld(event.chat_id, event.rev, event.payload))]);
    }
    return out;
  }

  head(chatId) {
    const chat = this.db.prepare('SELECT next_ord, next_rev FROM chats WHERE id=?').get(chatId);
    return { head_ord: chat.next_ord, head_rev: chat.next_rev };
  }

  /** feed.ts `catchup`: gap-or-replay, replay from the LOG, redacted per requester. */
  catchup(chatId, actorId, fromRev) {
    if (!this.isMember(chatId, actorId)) return { t: 'denied' };
    const { head_rev, head_ord } = this.head(chatId);
    if (head_rev - fromRev > this.gapThreshold) {
      const clause = this.mutant === 'gap-tail-unfiltered' ? '1=1' : this.visibleSql('m');
      const params = this.mutant === 'gap-tail-unfiltered' ? [chatId, this.gapTail] : [chatId, actorId, this.gapTail];
      // Tombstoned ROOTS INCLUDED. Not for the client's own held rows — repair
      // corrects those — but because a deleted root still has a thread: a root
      // created and deleted while the client was away, with replies that
      // survive, is reachable only through its tombstone. Top-level only, as
      // the production tail is; replies come through the thread page.
      const deletedClause = this.mutant === 'tail-drops-tombstones' || this.asBuilt ? 'm.deleted = 0' : '1=1';
      const recent = this.db.prepare(
        `SELECT * FROM messages m
          WHERE m.chat_id = ? AND m.parent_id IS NULL AND ${deletedClause} AND ${clause}
          ORDER BY m.ord DESC LIMIT ?`).all(...params).reverse()
        .map(row => this.#rowFor(row, actorId));
      for (const row of recent) this.#emit('gap', actorId, { t: 'row', c: chatId, row });
      return { t: 'gap', c: chatId, head_rev, head_ord, recent };
    }
    const rows = this.db.prepare(
      'SELECT rev, type, payload, audience, listed FROM sync_events WHERE chat_id=? AND rev>? ORDER BY rev LIMIT ?')
      .all(chatId, fromRev, this.replayLimit);
    const events = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      const listed = row.listed ? JSON.parse(row.listed) : null;
      const audience = row.audience === 'listed' ? { kind: 'listed', actors: listed } : { kind: 'stream' };
      const entitled = row.audience === 'stream' || listed.includes(actorId) || this.mutant === 'catchup-leak';
      if (entitled) {
        events.push(this.#emit('catchup', actorId, this.#full(chatId, row.rev, row.type, payload, audience, actorId)));
      } else if (this.mutant !== 'drop-not-withhold') {
        events.push(this.#emit('catchup', actorId, this.#withheld(chatId, row.rev, payload)));
      }
    }
    // `to_rev` is derived from what was DELIVERED, never from the head — the
    // guard feed.ts documents. A mutant that drops rows still advances it past
    // them, which is precisely how dropping produces a permanent hole.
    const toRev = rows.length ? rows[rows.length - 1].rev : fromRev;
    return { t: 'catchup_ok', c: chatId, from_rev: fromRev, to_rev: toRev, events };
  }

  /**
   * A row as every row-returning path sends it: COMPLETE CURRENT STATE. Body as
   * it stands, tombstone status, edited flag, reactions, the reader's reply
   * count, and who it is visible to. SYNC-FLOWS.md §14 promises this of backfill;
   * the gap tail, the thread page and repair make the same promise.
   */
  #rowFor(row, actorId) {
    const out = { id: row.id, ord: row.ord, rev: row.rev, author_id: row.author_id, body: row.body,
                  parent_id: row.parent_id, deleted: row.deleted === 1, edited: row.edited === 1,
                  reactions: this.reactionsOf(row.id) };
    if (this.mutant !== 'row-missing-reply-count' && !row.parent_id) out.reply_count = this.replyCountFor(row.id, actorId);
    if (row.audience === 'listed') out.visible_to = this.listedFor(row.id);
    return out;
  }

  /** feed.ts `backfill` + socket.ts `complete: rows.length < limit`. */
  backfill(chatId, actorId, beforeOrd, limit) {
    if (!this.isMember(chatId, actorId)) return { t: 'denied' };
    const deletedClause = this.mutant === 'backfill-drops-tombstones' || this.asBuilt ? 'm.deleted = 0' : '1=1';
    let rows;
    if (this.mutant === 'backfill-filter-after-limit') {
      rows = this.db.prepare(
        `SELECT * FROM messages m WHERE m.chat_id=? AND ${deletedClause} AND m.parent_id IS NULL AND m.ord < ?
          ORDER BY m.ord DESC LIMIT ?`).all(chatId, beforeOrd, limit)
        .filter(row => this.canSee(actorId, row));
    } else {
      rows = this.db.prepare(
        `SELECT * FROM messages m WHERE m.chat_id=? AND ${deletedClause} AND m.parent_id IS NULL AND m.ord < ?
          AND ${this.visibleSql('m')} ORDER BY m.ord DESC LIMIT ?`).all(chatId, beforeOrd, actorId, limit);
    }
    const out = rows.map(row => this.#rowFor(row, actorId));
    for (const row of out) this.#emit('backfill', actorId, { t: 'row', c: chatId, row });
    return { t: 'backfill_ok', c: chatId, rows: out, complete: rows.length < limit };
  }

  /**
   * One page of a thread, by ordinal — the parent-keyed endpoint DESIGN.md §8.2
   * says must exist from day one, because replies share the chat's ord space
   * and so cannot be fetched by the chat's ordinal range.
   *
   * Undeleted replies only. A tombstone is owed only for a row the client
   * holds, and a held reply deleted meanwhile is corrected by repair; a reply
   * has no thread of its own, so — unlike a deleted ROOT in the tail and
   * backfill — nothing hangs off a deleted reply that the client would need
   * the row to reach. (A mutant that dropped them here survived every check,
   * which is how this was established rather than assumed.)
   */
  thread(chatId, actorId, rootId, afterOrd, limit) {
    if (!this.isMember(chatId, actorId)) return { t: 'denied' };
    const rows = this.db.prepare(
      `SELECT * FROM messages m WHERE m.chat_id=? AND m.parent_id=? AND m.ord > ? AND m.deleted = 0
        AND ${this.visibleSql('m')} ORDER BY m.ord LIMIT ?`).all(chatId, rootId, afterOrd, actorId, limit);
    const out = rows.map(row => this.#rowFor(row, actorId));
    for (const row of out) this.#emit('thread', actorId, { t: 'row', c: chatId, row });
    return { t: 'thread_ok', c: chatId, root: rootId, rows: out, complete: rows.length < limit };
  }

  /**
   * REPAIR: everything that changed after `sinceRev` among messages the client
   * could already hold (ord <= maxOrd), as complete rows, keyset-paged by
   * (rev, id). A gap replaced the log with a partial snapshot; this is what
   * corrects the rows the snapshot did not re-send. Cost is proportional to what
   * CHANGED, not to history and not to events.
   */
  repair(chatId, actorId, sinceRev, maxOrd, after, limit) {
    if (!this.isMember(chatId, actorId)) return { t: 'denied' };
    const deletedClause = this.mutant === 'repair-drops-tombstones' ? 'm.deleted = 0' : '1=1';
    const ordClause = this.mutant === 'repair-ord-bound-wrong' ? 'm.ord > ?' : 'm.ord <= ?';
    const rows = this.db.prepare(
      `SELECT * FROM messages m WHERE m.chat_id=? AND m.rev > ? AND ${ordClause} AND ${deletedClause}
        AND (m.rev > ? OR (m.rev = ? AND m.id > ?)) AND ${this.visibleSql('m')}
        ORDER BY m.rev, m.id LIMIT ?`)
      .all(chatId, sinceRev, maxOrd, after?.rev ?? 0, after?.rev ?? 0, after?.id ?? '', actorId, limit);
    const out = rows.map(row => this.#rowFor(row, actorId));
    for (const row of out) this.#emit('repair', actorId, { t: 'row', c: chatId, row });
    const last = rows.length ? { rev: rows[rows.length - 1].rev, id: rows[rows.length - 1].id } : after;
    return { t: 'repair_ok', c: chatId, rows: out, complete: rows.length < limit, after: last };
  }

  markRead(chatId, actorId, ord) {
    this.db.prepare('UPDATE reads SET last_read_ord = MAX(last_read_ord, ?) WHERE chat_id=? AND actor_id=?')
      .run(ord, chatId, actorId);
  }

  /** feed.ts `counters` and the per-chat half of `welcomeChats`. */
  counters(chatId, actorId) {
    const read = this.db.prepare('SELECT last_read_ord FROM reads WHERE chat_id=? AND actor_id=?').get(chatId, actorId);
    const lastRead = read ? read.last_read_ord : 0;
    const clause = this.mutant === 'counters-unfiltered' ? '1=1' : this.visibleSql('m');
    const params = this.mutant === 'counters-unfiltered'
      ? [`%@${actorId}%`, chatId, lastRead, actorId]
      : [`%@${actorId}%`, chatId, lastRead, actorId, actorId];
    // Top-level only: chat unread and thread unread are separate counters
    // (DESIGN.md §12), and this model carries only the first.
    const row = this.db.prepare(
      `SELECT COUNT(*) AS unread, COALESCE(SUM(CASE WHEN body LIKE ? THEN 1 ELSE 0 END), 0) AS mentions
         FROM messages m WHERE m.chat_id=? AND m.ord > ? AND m.deleted = 0 AND m.author_id <> ?
          AND m.parent_id IS NULL AND ${clause}`).get(...params);
    return { chat_unread: row.unread, mention_count: row.mentions };
  }

  activityBumps(chatId) {
    return this.db.prepare('SELECT activity_bumps AS n FROM chats WHERE id=?').get(chatId).n;
  }

  /**
   * Ground truth, computed WITHOUT the model's own SQL: which top-level,
   * undeleted messages this actor may see now. The property test compares the
   * client and the counters against this, so a bug shared by `visibleSql` and
   * `canSee` cannot agree with itself.
   */
  truthVisible(chatId, actorId) {
    if (!this.isMember(chatId, actorId)) return [];
    const all = this.db.prepare('SELECT * FROM messages WHERE chat_id=? AND deleted=0 AND parent_id IS NULL ORDER BY ord')
      .all(chatId);
    const audience = this.db.prepare('SELECT message_id, actor_id FROM message_audience').all();
    return all.filter(message => message.audience === 'chat'
      || audience.some(row => row.message_id === message.id && row.actor_id === actorId))
      .map(message => message.id);
  }

  truthUnread(chatId, actorId) {
    if (!this.isMember(chatId, actorId)) return 0;
    const lastRead = this.db.prepare('SELECT last_read_ord FROM reads WHERE chat_id=? AND actor_id=?').get(chatId, actorId)
      ?.last_read_ord ?? 0;
    const visible = new Set(this.truthVisible(chatId, actorId));
    return this.db.prepare('SELECT id, ord, author_id FROM messages WHERE chat_id=? AND deleted=0 AND parent_id IS NULL')
      .all(chatId)
      .filter(message => visible.has(message.id) && message.ord > lastRead && message.author_id !== actorId)
      .length;
  }

  /**
   * Ground truth of what a reader should SEE for every message they may see,
   * top-level and replies: body, deleted, edited, reactions, and the reply
   * count over replies they may see. Computed with plain scans, not the
   * model's own clauses.
   */
  truthRendered(chatId, actorId) {
    const out = {};
    if (!this.isMember(chatId, actorId)) return out;
    const all = this.db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY ord').all(chatId);
    const audience = this.db.prepare('SELECT message_id, actor_id FROM message_audience').all();
    const sees = (message) => message.audience === 'chat'
      || audience.some(row => row.message_id === message.id && row.actor_id === actorId);
    for (const message of all) {
      if (!sees(message)) continue;
      const entry = { deleted: message.deleted === 1, body: message.body, edited: message.edited === 1,
                      reactions: this.reactionsOf(message.id) };
      if (!message.parent_id) {
        entry.reply_count = all.filter(reply => reply.parent_id === message.id && reply.deleted === 0 && sees(reply)).length;
      }
      out[message.id] = entry;
    }
    return out;
  }

  message(messageId) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId); }
}

// ─── CLIENT ──────────────────────────────────────────────────────────────────
// apps/desktop/src/sync/apply.ts (the three-case rule, staged envelopes),
// effects.ts (per-type effects, unknown types accounted), catchup.ts (gap and
// backfill, has_gap closing on `complete || floor === 1`).
export class Client {
  /**
   * `gapRule` chooses between two floors after a gap.
   *
   *   'production'  what apps/desktop/src/sync/catchup.ts does today: the floor
   *                 is MIN(existing floor, the tail's oldest), and a floor that
   *                 is null or at 1 is never backfilled below (link.ts).
   *   'corrected'   the floor becomes the tail's oldest ordinal — a gap jumps
   *                 over history the client never held, so nothing above an old
   *                 floor can be assumed held any more — and backfill is asked
   *                 for while has_gap is set, from head_ord + 1 when the tail
   *                 was empty.
   *
   * The property test runs 'corrected' so that only visibility is under test;
   * the findings in visibility-tests.mjs execute 'production' and show what it
   * loses. Neither rule is about restricted messages.
   */
  constructor(actorId, { knowsWithheld = true, mutant = null, gapRule = 'corrected' } = {}) {
    this.actorId = actorId;
    this.gapRule = gapRule;
    this.knowsWithheld = knowsWithheld;
    this.mutant = mutant;
    this.unknownTypes = 0;
    /** Revisions whose effect ran, and revisions jumped by a gap — for the no-silent-skip check. */
    this.accounted = new Set();
    this.gapJumped = new Set();
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE chat_state(chat_id TEXT PRIMARY KEY, synced_through_rev INTEGER NOT NULL DEFAULT 0,
        server_head_rev INTEGER NOT NULL DEFAULT 0, head_ord INTEGER NOT NULL DEFAULT 0,
        has_gap INTEGER NOT NULL DEFAULT 0, oldest_local_ord INTEGER,
        -- A repair owed after a gap, PERSISTED so a quit mid-repair resumes it:
        -- changes since this revision, to messages at or below this ordinal,
        -- paged by (rev, id). NULL when none is owed.
        repair_since_rev INTEGER, repair_max_ord INTEGER, repair_after_rev INTEGER, repair_after_id TEXT);
      CREATE TABLE staged_events(chat_id TEXT, rev INTEGER, type TEXT, payload TEXT,
        PRIMARY KEY(chat_id, rev));
      CREATE TABLE messages(id TEXT PRIMARY KEY, chat_id TEXT, parent_id TEXT, ord INTEGER,
        -- The message's VERSION as last seen. A fetched row applies only when it
        -- is not older than this (the version rule, client side).
        rev INTEGER,
        author_id TEXT, body TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0,
        reactions TEXT NOT NULL DEFAULT '[]', reply_count INTEGER NOT NULL DEFAULT 0, visible_to TEXT);
    `);
  }

  #state(chatId) {
    this.db.prepare('INSERT OR IGNORE INTO chat_state(chat_id) VALUES(?)').run(chatId);
    return this.db.prepare('SELECT * FROM chat_state WHERE chat_id=?').get(chatId);
  }

  frontier(chatId) { return this.#state(chatId).synced_through_rev; }
  hasGap(chatId) { return this.#state(chatId).has_gap === 1; }
  floor(chatId) { return this.#state(chatId).oldest_local_ord; }
  headOrd(chatId) { return this.#state(chatId).head_ord; }
  stagedCount(chatId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM staged_events WHERE chat_id=?').get(chatId).n;
  }

  /** What the person sees: undeleted top-level messages held. */
  visibleIds(chatId) {
    return this.db.prepare('SELECT id FROM messages WHERE chat_id=? AND deleted=0 AND parent_id IS NULL ORDER BY ord')
      .all(chatId).map(row => row.id);
  }

  highestHeldOrd(chatId) {
    return this.db.prepare('SELECT MAX(ord) AS o FROM messages WHERE chat_id=? AND deleted=0').get(chatId).o ?? 0;
  }

  /** Every held row, deleted or not: the bound on what a repair can be about. */
  highestHeldOrdIncludingDeleted(chatId) {
    return this.db.prepare('SELECT MAX(ord) AS o FROM messages WHERE chat_id=?').get(chatId).o ?? 0;
  }

  repairPending(chatId) {
    const state = this.#state(chatId);
    return state.repair_since_rev === null ? null
      : { sinceRev: state.repair_since_rev, maxOrd: state.repair_max_ord,
          after: state.repair_after_rev === null ? null : { rev: state.repair_after_rev, id: state.repair_after_id } };
  }

  /** What the person sees, per held message: the rendered state the property test compares with truth. */
  rendered(chatId) {
    const out = {};
    for (const row of this.db.prepare('SELECT * FROM messages WHERE chat_id=?').all(chatId)) {
      const entry = { deleted: row.deleted === 1, body: row.body, edited: row.edited === 1,
                      reactions: JSON.parse(row.reactions) };
      if (!row.parent_id) entry.reply_count = row.reply_count;
      out[row.id] = entry;
    }
    return out;
  }

  heldTopLevelIds(chatId) {
    return this.db.prepare('SELECT id FROM messages WHERE chat_id=? AND parent_id IS NULL ORDER BY ord')
      .all(chatId).map(row => row.id);
  }

  heldReplies(chatId, rootId) {
    return this.db.prepare('SELECT id, ord, deleted FROM messages WHERE chat_id=? AND parent_id=? ORDER BY ord').all(chatId, rootId);
  }

  /**
   * Apply a COMPLETE row from the tail, backfill, thread or repair. The version
   * guard is what makes fetched state safe beside live events: a row computed
   * before a live change landed carries an older rev and must not undo it.
   * `insert` false updates only rows already held — repair corrects what the
   * client has and leaves history it never held to backfill.
   */
  #applyRow(chatId, row, { insert }) {
    const guard = this.mutant === 'row-overwrites-newer-state' ? '' : 'WHERE excluded.rev >= messages.rev';
    const values = [row.id, chatId, row.parent_id ?? null, row.ord, row.rev, row.author_id, row.body,
      row.deleted ? 1 : 0, row.edited ? 1 : 0, json(row.reactions ?? []), row.reply_count ?? 0,
      row.visible_to ? json(row.visible_to) : null];
    if (insert) {
      this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, body=excluded.body, deleted=excluded.deleted,
          edited=excluded.edited, reactions=excluded.reactions, reply_count=excluded.reply_count,
          visible_to=excluded.visible_to ${guard}`).run(...values);
      return 'applied';
    }
    const held = this.db.prepare('SELECT rev FROM messages WHERE id=? AND chat_id=?').get(row.id, chatId);
    if (!held) return 'not-held';
    if (guard && row.rev < held.rev) return 'older';
    this.db.prepare(`UPDATE messages SET rev=?, body=?, deleted=?, edited=?, reactions=?, reply_count=? WHERE id=?`)
      .run(row.rev, row.body, row.deleted ? 1 : 0, row.edited ? 1 : 0, json(row.reactions ?? []), row.reply_count ?? 0, row.id);
    return 'applied';
  }

  #effect(chatId, event) {
    this.accounted.add(event.rev);
    switch (event.type) {
      case 'message.created': {
        const body = event.payload;
        this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,0,0,'[]',0,?)
          ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, rev=excluded.rev, body=excluded.body,
            visible_to=excluded.visible_to WHERE excluded.rev >= messages.rev`)
          .run(body.id, chatId, body.parent_id ?? null, body.ord, event.rev, body.author_id, body.body,
               body.visible_to ? json(body.visible_to) : null);
        this.db.prepare('UPDATE chat_state SET head_ord = MAX(head_ord, ?) WHERE chat_id=?').run(body.ord, chatId);
        // A reply this client was sent is a reply it may see: the parent's count moves.
        if (body.parent_id) {
          this.db.prepare('UPDATE messages SET reply_count = reply_count + 1, rev=? WHERE id=? AND chat_id=?')
            .run(event.rev, body.parent_id, chatId);
        }
        return;
      }
      case 'message.edited':
        this.db.prepare('UPDATE messages SET body=?, edited=1, rev=? WHERE id=? AND chat_id=?')
          .run(event.payload.body, event.rev, event.payload.id, chatId);
        return;
      case 'message.reacted': {
        const held = this.db.prepare('SELECT reactions FROM messages WHERE id=? AND chat_id=?').get(event.payload.id, chatId);
        if (!held) return;
        const key = `${event.payload.emoji}:${event.payload.actor_id}`;
        const set = new Set(JSON.parse(held.reactions));
        if (event.payload.present) set.add(key); else set.delete(key);
        this.db.prepare('UPDATE messages SET reactions=?, rev=? WHERE id=?').run(json([...set].sort()), event.rev, event.payload.id);
        return;
      }
      case 'message.deleted': {
        const wasUndeleted = this.db.prepare('SELECT deleted FROM messages WHERE id=? AND chat_id=?').get(event.payload.id, chatId);
        this.db.prepare("UPDATE messages SET deleted=1, body='', rev=? WHERE id=? AND chat_id=?")
          .run(event.rev, event.payload.id, chatId);
        // Decrement the parent's count once: for a held, still-undeleted reply,
        // or for a reply never held (created during a gap, counted by repair).
        if (event.payload.parent_id && (!wasUndeleted || wasUndeleted.deleted === 0)) {
          this.db.prepare('UPDATE messages SET reply_count = MAX(reply_count - 1, 0), rev=? WHERE id=? AND chat_id=?')
            .run(event.rev, event.payload.parent_id, chatId);
        }
        return;
      }
      case 'withheld':
        if (this.knowsWithheld) return;
        this.unknownTypes++;
        return;
      default:
        this.unknownTypes++;
    }
  }

  /** The three-case rule, one function, as apply.ts has it. */
  applyEvent(chatId, event) {
    if (event.type === 'withheld' && this.mutant === 'client-withheld-ignored') return 'ignored';
    if (this.mutant === 'unknown-type-stalls' && !this.knowsWithheld && event.type === 'withheld') return 'ignored';

    const frontier = this.#state(chatId).synced_through_rev;
    if (event.rev <= frontier) return 'duplicate';

    if (event.rev > frontier + 1) {
      this.db.prepare('INSERT OR REPLACE INTO staged_events VALUES(?,?,?,?)')
        .run(chatId, event.rev, event.type, json(event.payload));
      this.db.prepare('UPDATE chat_state SET server_head_rev = MAX(server_head_rev, ?) WHERE chat_id=?')
        .run(event.rev, chatId);
      return 'staged';
    }

    this.db.exec('BEGIN');
    try {
      let next = event;
      let at = frontier;
      while (next) {
        if (next.type === 'withheld' && this.mutant === 'client-withheld-ignored') break;
        if (this.mutant === 'unknown-type-stalls' && !this.knowsWithheld && next.type === 'withheld') break;
        this.#effect(chatId, next);
        at = next.rev;
        const staged = this.db.prepare('SELECT * FROM staged_events WHERE chat_id=? AND rev=?').get(chatId, at + 1);
        next = staged ? { rev: staged.rev, type: staged.type, payload: JSON.parse(staged.payload) } : null;
      }
      this.db.prepare(`UPDATE chat_state SET synced_through_rev=?, server_head_rev = MAX(server_head_rev, ?)
        WHERE chat_id=?`).run(at, at, chatId);
      this.db.prepare('DELETE FROM staged_events WHERE chat_id=? AND rev<=?').run(chatId, at);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return 'applied';
  }

  applyCatchup(chatId, response) {
    for (const event of response.events) this.applyEvent(chatId, event);
    this.db.prepare('UPDATE chat_state SET server_head_rev = MAX(server_head_rev, ?) WHERE chat_id=?')
      .run(response.to_rev, chatId);
  }

  /** catchup.ts `applyGap`, including the MIN(…) floor that only goes down. */
  applyGap(chatId, gap) {
    const before = this.#state(chatId).synced_through_rev;
    for (let rev = before + 1; rev <= gap.head_rev; rev++) this.gapJumped.add(rev);
    // What a repair must cover: changes since the frontier the gap jumps FROM,
    // to any message held BEFORE the tail lands. A repair still pending from an
    // earlier gap widens to cover both and starts its paging over.
    const heldBefore = this.highestHeldOrdIncludingDeleted(chatId);
    const pending = this.repairPending(chatId);
    let since = this.mutant === 'repair-since-new-frontier' ? gap.head_rev : before;
    let maxOrd = heldBefore;
    if (pending) { since = Math.min(since, pending.sinceRev); maxOrd = Math.max(maxOrd, pending.maxOrd); }
    this.db.exec('BEGIN');
    try {
      let oldest = null;
      for (const row of gap.recent) {
        this.#applyRow(chatId, row, { insert: true });
        oldest = oldest === null ? row.ord : Math.min(oldest, row.ord);
      }
      if (this.mutant !== 'no-repair' && this.gapRule !== 'production' && heldBefore > 0) {
        this.db.prepare(`UPDATE chat_state SET repair_since_rev=?, repair_max_ord=?, repair_after_rev=NULL,
          repair_after_id=NULL WHERE chat_id=?`).run(since, maxOrd, chatId);
      }
      if (this.gapRule === 'production') {
        this.db.prepare(`UPDATE chat_state SET head_ord = MAX(head_ord, ?),
          oldest_local_ord = MIN(COALESCE(oldest_local_ord, ?), ?) WHERE chat_id=?`)
          .run(gap.head_ord, oldest, oldest, chatId);
      } else {
        this.db.prepare('UPDATE chat_state SET head_ord = MAX(head_ord, ?), oldest_local_ord = ? WHERE chat_id=?')
          .run(gap.head_ord, oldest, chatId);
      }
      this.db.prepare(`UPDATE chat_state SET synced_through_rev=?, server_head_rev = MAX(server_head_rev, ?),
        has_gap=1 WHERE chat_id=?`).run(gap.head_rev, gap.head_rev, chatId);
      this.db.prepare('DELETE FROM staged_events WHERE chat_id=?').run(chatId);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** catchup.ts `applyBackfill`: the gap closes on `complete || floor === 1`. */
  applyBackfill(chatId, rows, complete) {
    if (rows.length === 0 && !complete) return;
    for (const row of rows) this.#applyRow(chatId, row, { insert: true });
    if (rows.length) {
      const oldest = Math.min(...rows.map(row => row.ord));
      this.db.prepare('UPDATE chat_state SET oldest_local_ord = MIN(COALESCE(oldest_local_ord, ?), ?) WHERE chat_id=?')
        .run(oldest, oldest, chatId);
    }
    const floor = this.#state(chatId).oldest_local_ord;
    const closes = this.mutant === 'gap-clears-on-floor-only' ? floor === 1 : (complete || floor === 1);
    if (closes) this.db.prepare('UPDATE chat_state SET has_gap=0 WHERE chat_id=?').run(chatId);
  }

  /** A thread page: replies the client may see, tombstones included. */
  applyThread(chatId, rows) {
    for (const row of rows) this.#applyRow(chatId, row, { insert: true });
  }

  /**
   * A repair page: correct rows already held; advance or clear the persisted cursor.
   *
   * A row REJECTED AS OLDER is not a row to forget. It means a live event
   * touched that message after the page was computed — and a live event is a
   * delta applied over a local row that was still stale, so the local row is
   * now wrong in a way nothing else will fix. The version rule makes the
   * remedy fall out of the paging: the live event bumped the server row past
   * this page's cursor, so continuing to page by (rev, id) serves it again,
   * complete, at its new version. Repair is therefore complete only on a page
   * that applied with nothing rejected.
   */
  applyRepair(chatId, response) {
    this.db.exec('BEGIN');
    try {
      let rejected = 0;
      for (const row of response.rows) if (this.#applyRow(chatId, row, { insert: false }) === 'older') rejected++;
      if (response.complete && rejected === 0) {
        this.db.prepare(`UPDATE chat_state SET repair_since_rev=NULL, repair_max_ord=NULL,
          repair_after_rev=NULL, repair_after_id=NULL WHERE chat_id=?`).run(chatId);
      } else if (response.after) {
        this.db.prepare('UPDATE chat_state SET repair_after_rev=?, repair_after_id=? WHERE chat_id=?')
          .run(response.after.rev, response.after.id, chatId);
      }
      this.db.exec('COMMIT');
      return { rejected };
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
}

// ─── A WORLD: one server, several clients, an unreliable network ─────────────
/** Mulberry32 — small, seedable, and the same sequence on every machine. */
export function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  constructor({ seed = 1, actors = ['alice', 'bob', 'carol', 'dave'], initialMembers = null,
                oldClients = [], gapThreshold = 12, replayLimit = 5, gapTail = 4, backfillLimit = 3,
                mutant = null, gapRule = 'corrected', restricted = true, repairDisorder = false } = {}) {
    /** Live traffic and quits inside the repair loop — the property test's disorder, off for named traces. */
    this.repairDisorder = repairDisorder;
    this.random = prng(seed);
    /** False sends every restricted message as a public one — the control for the gap findings. */
    this.restricted = restricted;
    this.chat = 'C';
    this.backfillLimit = backfillLimit;
    this.server = new Server({ gapThreshold, replayLimit, gapTail, mutant, asBuilt: gapRule === 'production' });
    this.server.createChat(this.chat);
    this.actors = actors;
    this.clients = new Map(actors.map(actor => [actor,
      new Client(actor, { knowsWithheld: !oldClients.includes(actor), mutant, gapRule })]));
    this.online = new Map(actors.map(actor => [actor, true]));
    this.inbox = new Map(actors.map(actor => [actor, []]));
    this.delivered = new Map(actors.map(actor => [actor, []]));
    for (const actor of initialMembers ?? actors) this.server.join(this.chat, actor);
    this.nextMessage = 0;
    this.nextOp = 0;
    this.violations = [];
    this.coverage = { publicSends: 0, restrictedSends: 0, restrictedMutations: 0, withheldLive: 0,
      withheldCatchup: 0, staged: 0, gaps: 0, backfillPages: 0, catchupRounds: 0, duplicates: 0,
      drops: 0, leaves: 0, joins: 0, oldClientUnknown: 0, hiddenFirstOrd: 0, reads: 0,
      replies: 0, restrictedReplies: 0, reactions: 0, repairPages: 0, repairRows: 0, repairResumed: 0,
      repairWidened: 0, threadPages: 0, liveDuringRepair: 0 };
    this.auditFrom = 0;
    this.quiet = false;
  }

  pick(list) { return list[Math.floor(this.random() * list.length)]; }
  members() { return this.actors.filter(actor => this.server.isMember(this.chat, actor)); }
  /** Message ids share one counter so `m2` is the second message whatever its kind; ops count apart. */
  id(prefix) {
    if (prefix === 'op') { this.nextOp++; return `op${this.nextOp}`; }
    this.nextMessage++;
    return `${prefix}${this.nextMessage}`;
  }

  /** Collect the server's send-time leak judgements (Server#emit) since the last audit. */
  audit(label) {
    const { leaks } = this.server;
    for (let index = this.auditFrom; index < leaks.length; index++) this.violations.push(`${label}: ${leaks[index]}`);
    this.auditFrom = leaks.length;
  }

  #fanout(event) {
    if (!event) return;
    for (const [actor, frame] of this.server.deliver(event)) {
      if (!this.online.get(actor)) continue;
      if (!this.clients.has(actor)) continue;
      this.inbox.get(actor).push(frame);
    }
  }

  sendPublic(author = this.pick(this.members())) {
    if (!author) return;
    const id = this.id('m');
    const { event } = this.server.send({ opId: this.id('op'), chatId: this.chat, messageId: id,
      authorId: author, body: `${id} from ${author}` });
    this.coverage.publicSends++;
    this.#fanout(event);
  }

  sendRestricted(author = this.pick(this.members()), listed = null) {
    const members = this.members();
    if (!author || members.length === 0) return;
    const chosen = listed ?? members.filter(() => this.random() < 0.4);
    if (chosen.length === 0) chosen.push(this.pick(members));
    const id = this.id('r');
    const { ack, event } = this.server.send({ opId: this.id('op'), chatId: this.chat, messageId: id,
      authorId: author, body: `${id} for ${chosen.join('+')}`, listed: chosen });
    if (ack.ord === 1) this.coverage.hiddenFirstOrd++;
    this.coverage.restrictedSends++;
    this.#fanout(event);
  }

  #anyMessage() {
    const rows = this.server.db.prepare('SELECT id, audience FROM messages WHERE chat_id=? AND deleted=0').all(this.chat);
    return rows.length ? this.pick(rows) : null;
  }

  /** A reply to a public top-level message; restricted itself a third of the time (an access card is one). */
  replySome() {
    const roots = this.server.db.prepare(
      "SELECT id FROM messages WHERE chat_id=? AND deleted=0 AND parent_id IS NULL AND audience='chat'").all(this.chat);
    const author = this.pick(this.members());
    if (!roots.length || !author) return;
    const root = this.pick(roots);
    const restricted = this.restricted && this.random() < 0.33;
    const listed = restricted ? [author, this.pick(this.members())] : null;
    const id = this.id(restricted ? 'q' : 'p');
    const { event } = this.server.send({ opId: this.id('op'), chatId: this.chat, messageId: id, authorId: author,
      body: `${id} reply`, parentId: root.id, listed });
    this.coverage.replies++;
    if (restricted) this.coverage.restrictedReplies++;
    this.#fanout(event);
  }

  reactSome() {
    const message = this.#anyMessage();
    const actor = this.pick(this.members());
    if (!message || !actor) return;
    const emoji = this.pick(['👍', '🎉']);
    const present = !this.server.reactionsOf(message.id).includes(`${emoji}:${actor}`);
    const { event } = this.server.react({ opId: this.id('op'), actorId: actor, messageId: message.id, emoji, present });
    this.coverage.reactions++;
    this.#fanout(event);
  }

  editSome() {
    const message = this.#anyMessage();
    const actor = this.pick(this.members());
    if (!message || !actor) return;
    const { event } = this.server.edit({ opId: this.id('op'), actorId: actor, messageId: message.id, body: 'edited' });
    if (message.audience === 'listed') this.coverage.restrictedMutations++;
    this.#fanout(event);
  }

  deleteSome() {
    const message = this.#anyMessage();
    const actor = this.pick(this.members());
    if (!message || !actor) return;
    const { event } = this.server.del({ opId: this.id('op'), actorId: actor, messageId: message.id });
    if (message.audience === 'listed') this.coverage.restrictedMutations++;
    this.#fanout(event);
  }

  /** Deliver one in-flight frame, chosen at random from anyone's inbox — out of order on purpose. */
  deliverOne() {
    const ready = this.actors.filter(actor => this.online.get(actor) && this.inbox.get(actor).length);
    if (!ready.length) return false;
    const actor = this.pick(ready);
    const queue = this.inbox.get(actor);
    const [frame] = queue.splice(Math.floor(this.random() * queue.length), 1);
    this.receive(actor, frame);
    this.delivered.get(actor).push(frame);
    return true;
  }

  /** One frame reaching one client, counted for coverage. */
  receive(actor, frame) {
    const client = this.clients.get(actor);
    const before = client.unknownTypes;
    const outcome = client.applyEvent(this.chat, frame);
    if (outcome === 'staged') this.coverage.staged++;
    if (frame.type === 'withheld') this.coverage.withheldLive++;
    if (client.unknownTypes > before) this.coverage.oldClientUnknown++;
  }

  duplicateOne() {
    const withHistory = this.actors.filter(actor => this.online.get(actor) && this.delivered.get(actor).length);
    if (!withHistory.length) return;
    const actor = this.pick(withHistory);
    this.receive(actor, this.pick(this.delivered.get(actor)));
    this.coverage.duplicates++;
  }

  /** The socket drops: everything in flight is lost, and the client is offline until it reconnects. */
  drop(actor = this.pick(this.actors)) {
    this.online.set(actor, false);
    this.inbox.set(actor, []);
    this.coverage.drops++;
  }

  /** Reconnect: a new socket, then catch-up rounds until the frontier reaches the head. */
  reconnect(actor = this.pick(this.actors)) {
    this.online.set(actor, true);
    this.inbox.set(actor, []);
    const client = this.clients.get(actor);
    for (let round = 0; round < 200; round++) {
      const response = this.server.catchup(this.chat, actor, client.frontier(this.chat));
      if (response.t === 'denied') return;
      this.coverage.catchupRounds++;
      if (response.t === 'gap') {
        if (client.repairPending(this.chat)) this.coverage.repairWidened++;
        client.applyGap(this.chat, response); this.coverage.gaps++;
      }
      else {
        for (const event of response.events) if (event.type === 'withheld') this.coverage.withheldCatchup++;
        client.applyCatchup(this.chat, response);
        if (response.events.length === 0) break;
      }
      if (client.frontier(this.chat) >= this.server.head(this.chat).head_rev) break;
    }
    if (client.frontier(this.chat) < this.server.head(this.chat).head_rev) {
      this.violations.push(`catch-up for ${actor} never reached the head: frontier ${client.frontier(this.chat)}, head ${this.server.head(this.chat).head_rev}`);
    }
    this.repairPending(actor);
  }

  /**
   * ON RECONNECT, once caught up: page the repair owed until the server says
   * it is complete. Live frames are delivered between fetching a page and
   * applying it, which is the race the version guard exists for.
   */
  repairPending(actor) {
    const client = this.clients.get(actor);
    if (client.repairPending(this.chat)?.after) this.coverage.repairResumed++;
    for (let page = 0; page < 500; page++) {
      const pending = client.repairPending(this.chat);
      if (!pending) return;
      const response = this.server.repair(this.chat, actor, pending.sinceRev, pending.maxOrd, pending.after, this.backfillLimit);
      if (response.t === 'denied') return;
      // Between the server computing a page and the client applying it, the
      // world moves: new replies and reactions land live on this very client.
      if (this.repairDisorder && !this.quiet && this.random() < 0.5 && this.server.isMember(this.chat, actor)) {
        this.replySome(); this.reactSome();
        const mine = this.inbox.get(actor);
        while (mine.length) { this.coverage.liveDuringRepair++; this.receive(actor, mine.shift()); }
      }
      client.applyRepair(this.chat, response);
      this.coverage.repairPages++;
      this.coverage.repairRows += response.rows.length;
      // A quit mid-repair: the cursor is persisted, and the next reconnect resumes it.
      if (this.repairDisorder && !this.quiet && !response.complete && this.random() < 0.15) { this.drop(actor); return; }
    }
    this.violations.push(`repair for ${actor} never completed`);
  }

  /**
   * Open a thread: when the replies held disagree with the parent's count,
   * page the whole thread from the start. Replies share the chat's ordinal
   * space and can sit anywhere in it, so there is no floor to page from.
   */
  openThread(actor, rootId) {
    const client = this.clients.get(actor);
    const parent = client.db.prepare('SELECT reply_count FROM messages WHERE id=? AND chat_id=?').get(rootId, this.chat);
    if (!parent) return;
    const held = client.heldReplies(this.chat, rootId).filter(reply => reply.deleted === 0).length;
    if (held === parent.reply_count) return;
    let after = 0;
    for (let page = 0; page < 500; page++) {
      const response = this.server.thread(this.chat, actor, rootId, after, this.backfillLimit);
      if (response.t === 'denied') return;
      client.applyThread(this.chat, response.rows);
      this.coverage.threadPages++;
      if (response.complete) return;
      after = response.rows[response.rows.length - 1].ord;
    }
  }

  /** Scroll to the top: backfill pages until the gap closes. */
  backfillToTop(actor) {
    const client = this.clients.get(actor);
    for (let page = 0; page < 500 && client.hasGap(this.chat); page++) {
      const floor = client.floor(this.chat);
      // link.ts `backfill`: no request for a floor that is null or at 1.
      if (client.gapRule === 'production' && (floor === null || floor <= 1)) break;
      const before = floor ?? this.server.head(this.chat).head_ord + 1;
      const response = this.server.backfill(this.chat, actor, before, this.backfillLimit);
      if (response.t === 'denied') return;
      client.applyBackfill(this.chat, response.rows, response.complete);
      this.coverage.backfillPages++;
      if (response.rows.length === 0 && !response.complete) break;
    }
    if (client.hasGap(this.chat)) this.violations.push(`backfill for ${actor} never closed the gap`);
  }

  leaveSome() {
    const members = this.members();
    if (members.length <= 1) return;
    const actor = this.pick(members);
    this.server.leave(this.chat, actor);
    this.coverage.leaves++;
  }

  joinSome() {
    const outside = this.actors.filter(actor => !this.server.isMember(this.chat, actor));
    if (!outside.length) return;
    const actor = this.pick(outside);
    this.server.join(this.chat, actor);
    this.coverage.joins++;
    this.reconnect(actor);
  }

  readSome() {
    const actor = this.pick(this.members());
    if (!actor) return;
    this.server.markRead(this.chat, actor, this.clients.get(actor).highestHeldOrd(this.chat));
    this.coverage.reads++;
  }

  /** One random step. Weights favour traffic and delivery, with enough disorder to reach every path. */
  step() {
    const roll = this.random();
    if (roll < 0.14) this.sendPublic();
    else if (roll < 0.26) { if (this.restricted) this.sendRestricted(); else this.sendPublic(); }
    else if (roll < 0.33) this.replySome();
    else if (roll < 0.38) this.reactSome();
    else if (roll < 0.42) this.editSome();
    else if (roll < 0.47) this.deleteSome();
    else if (roll < 0.70) { for (let i = 0; i < 3; i++) this.deliverOne(); }
    else if (roll < 0.73) this.duplicateOne();
    else if (roll < 0.78) this.drop();
    else if (roll < 0.86) this.reconnect();
    else if (roll < 0.89) this.leaveSome();
    else if (roll < 0.92) this.joinSome();
    else this.readSome();
    this.audit('step');
    this.#stepInvariants();
  }

  #stepInvariants() {
    const { head_rev } = this.server.head(this.chat);
    for (const [actor, client] of this.clients) {
      const frontier = client.frontier(this.chat);
      if (frontier > head_rev) this.violations.push(`${actor} frontier ${frontier} beyond head ${head_rev}`);
      const stagedBelow = client.db.prepare('SELECT COUNT(*) AS n FROM staged_events WHERE chat_id=? AND rev<=?')
        .get(this.chat, frontier).n;
      if (stagedBelow) this.violations.push(`${actor} holds staged events at or below its frontier`);
    }
  }

  /**
   * Quiesce, then check what must be true of a converged system. Everyone is
   * re-added, reconnects, drains, catches up and scrolls to the top; every
   * difference left after that is a violation.
   *
   * With `strictState` (the default) every held message's rendered state —
   * body, deleted, edited, reactions, reply count — and every thread's replies
   * must match ground truth. Off, only the visible SET is compared, and the
   * ids a client still shows although the server deleted them are returned
   * instead: that is how the production gap rule's findings are reported.
   */
  settle({ strictState = true } = {}) {
    // Nothing new happens from here: the world must come to rest before it is judged.
    this.quiet = true;
    for (const actor of this.actors) if (!this.server.isMember(this.chat, actor)) { this.server.join(this.chat, actor); }
    for (const actor of this.actors) this.reconnect(actor);
    while (this.deliverOne()) { /* drain */ }
    for (const actor of this.actors) this.reconnect(actor);
    for (const actor of this.actors) this.backfillToTop(actor);
    if (strictState) {
      for (const actor of this.actors) {
        for (const id of this.clients.get(actor).heldTopLevelIds(this.chat)) this.openThread(actor, id);
      }
    }
    this.audit('settle');

    const staleDeleted = [];
    const { head_rev } = this.server.head(this.chat);
    for (const [actor, client] of this.clients) {
      const frontier = client.frontier(this.chat);
      if (frontier !== head_rev) this.violations.push(`${actor} frontier ${frontier} != head ${head_rev}`);
      if (client.stagedCount(this.chat)) this.violations.push(`${actor} still stages ${client.stagedCount(this.chat)} events`);
      if (client.hasGap(this.chat)) this.violations.push(`${actor} still has a gap after backfilling to the top`);

      for (let rev = 1; rev <= frontier; rev++) {
        if (!client.accounted.has(rev) && !client.gapJumped.has(rev)) {
          this.violations.push(`${actor} passed rev ${rev} without applying or gap-marking it`);
          break;
        }
      }

      const truth = this.server.truthVisible(this.chat, actor);
      const truthSet = new Set(truth);
      const held = client.visibleIds(this.chat);
      for (const id of truth) if (!held.includes(id)) this.violations.push(`${actor} is missing visible message ${id}`);
      for (const id of held) {
        if (truthSet.has(id)) continue;
        const message = this.server.message(id);
        if (message && message.deleted === 1) { staleDeleted.push({ actor, id }); if (!strictState) continue; }
        this.violations.push(`${actor} holds ${id}, which it may not see`);
      }

      if (strictState) {
        // Rendered state, message by message, replies included. `rev` is not
        // compared: it is the client's guard, not something the person sees.
        const rendered = client.rendered(this.chat);
        const expected = this.server.truthRendered(this.chat, actor);
        for (const [id, want] of Object.entries(expected)) {
          const have = rendered[id];
          // A message deleted before this client ever held it owes no tombstone;
          // one the client does hold must be marked. Absence is only wrong for
          // something the person should be seeing.
          if (!have) { if (!want.deleted) this.violations.push(`${actor} holds no row for ${id}`); continue; }
          if (JSON.stringify(have) !== JSON.stringify(want)) {
            this.violations.push(`${actor} renders ${id} as ${JSON.stringify(have)}, truth ${JSON.stringify(want)}`);
          }
        }
        for (const id of Object.keys(rendered)) {
          if (!(id in expected)) this.violations.push(`${actor} holds ${id}, which truth does not show it`);
        }
      }

      const counted = this.server.counters(this.chat, actor).chat_unread;
      const expected = this.server.truthUnread(this.chat, actor);
      if (counted !== expected) this.violations.push(`${actor} unread ${counted}, ground truth ${expected}`);

      this.server.markRead(this.chat, actor, client.highestHeldOrd(this.chat));
      const after = this.server.counters(this.chat, actor).chat_unread;
      if (after !== 0) this.violations.push(`${actor} read everything it holds and still has ${after} unread`);
    }
    return { staleDeleted };
  }
}
