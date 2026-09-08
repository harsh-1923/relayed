// Executable model of the Relayed sync protocol (docs/DESIGN.md §8-§12).
// Validates the ord/rev two-counter model, cursor contiguity, gap markers,
// catch-up, backfill paging, idempotency, and outbox coalescing.
//   node spikes/sync-model.mjs
import { DatabaseSync } from 'node:sqlite';

// ─── tiny test harness ───────────────────────────────────────────────────────
let pass = 0, fail = 0; const fails = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, actual, expected) {
  if (eq(actual, expected)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; fails.push(name);
    console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`); }
}
const section = s => console.log(`\n${s}`);

// ─── SERVER ──────────────────────────────────────────────────────────────────
class Server {
  constructor(gapThreshold = 500) {
    this.gapThreshold = gapThreshold;
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE chats(id TEXT PRIMARY KEY, next_ord INTEGER DEFAULT 0, next_rev INTEGER DEFAULT 0);
      CREATE TABLE messages(
        id TEXT PRIMARY KEY, chat_id TEXT, parent_id TEXT, ord INTEGER, rev INTEGER,
        author_id TEXT, body TEXT, deleted INTEGER DEFAULT 0, created_at INTEGER);
      CREATE TABLE reactions(message_id TEXT, emoji TEXT, actor_id TEXT, present INTEGER,
        rev INTEGER, PRIMARY KEY(message_id, emoji, actor_id));
      CREATE TABLE ops(op_id TEXT PRIMARY KEY, result TEXT);   -- idempotency ledger
      CREATE TABLE members(chat_id TEXT, actor_id TEXT, left_at INTEGER,
        PRIMARY KEY(chat_id, actor_id));
      CREATE TABLE reads(chat_id TEXT, actor_id TEXT, last_read_ord INTEGER DEFAULT 0,
        PRIMARY KEY(chat_id, actor_id));
    `);
  }
  createChat(id) { this.db.prepare('INSERT INTO chats(id) VALUES(?)').run(id); }
  join(chatId, actorId) {
    this.db.prepare('INSERT OR REPLACE INTO members VALUES(?,?,NULL)').run(chatId, actorId);
    this.db.prepare('INSERT OR IGNORE INTO reads VALUES(?,?,0)').run(chatId, actorId);
  }
  remove(chatId, actorId, at) {
    this.db.prepare('UPDATE members SET left_at=? WHERE chat_id=? AND actor_id=?').run(at, chatId, actorId);
  }
  isMember(chatId, actorId) {
    const r = this.db.prepare('SELECT left_at FROM members WHERE chat_id=? AND actor_id=?').get(chatId, actorId);
    return !!r && r.left_at === null;
  }
  // atomic per-chat counter bump. `withOrd` false = mutation only (edit/react/delete)
  #bump(chatId, withOrd) {
    const c = this.db.prepare('SELECT next_ord, next_rev FROM chats WHERE id=?').get(chatId);
    const rev = c.next_rev + 1;
    const ord = withOrd ? c.next_ord + 1 : null;
    this.db.prepare('UPDATE chats SET next_ord=?, next_rev=? WHERE id=?')
      .run(withOrd ? ord : c.next_ord, rev, chatId);
    return { ord, rev };
  }
  #idem(opId) {
    const r = this.db.prepare('SELECT result FROM ops WHERE op_id=?').get(opId);
    return r ? JSON.parse(r.result) : null;
  }
  #record(opId, result) {
    this.db.prepare('INSERT INTO ops VALUES(?,?)').run(opId, JSON.stringify(result));
    return result;
  }
  send({ opId, chatId, msgId, authorId, body, parentId = null, createdAt = 0 }) {
    const prior = this.#idem(opId); if (prior) return prior;              // invariant 5
    const { ord, rev } = this.#bump(chatId, true);
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,0,?)')
      .run(msgId, chatId, parentId, ord, rev, authorId, body, createdAt);
    return this.#record(opId, { t: 'ack', opId, id: msgId, c: chatId, ord, rev });
  }
  edit({ opId, msgId, body }) {
    const prior = this.#idem(opId); if (prior) return prior;
    const m = this.db.prepare('SELECT chat_id FROM messages WHERE id=?').get(msgId);
    const { rev } = this.#bump(m.chat_id, false);                          // rev only
    this.db.prepare('UPDATE messages SET body=?, rev=? WHERE id=?').run(body, rev, msgId);
    return this.#record(opId, { t: 'ack', opId, id: msgId, c: m.chat_id, ord: null, rev });
  }
  react({ opId, msgId, emoji, actorId, present }) {
    const prior = this.#idem(opId); if (prior) return prior;
    const m = this.db.prepare('SELECT chat_id FROM messages WHERE id=?').get(msgId);
    const { rev } = this.#bump(m.chat_id, false);                          // rev only
    this.db.prepare('INSERT OR REPLACE INTO reactions VALUES(?,?,?,?,?)')
      .run(msgId, emoji, actorId, present ? 1 : 0, rev);
    return this.#record(opId, { t: 'ack', opId, c: m.chat_id, ord: null, rev });
  }
  del({ opId, msgId }) {
    const prior = this.#idem(opId); if (prior) return prior;
    const m = this.db.prepare('SELECT chat_id FROM messages WHERE id=?').get(msgId);
    const { rev } = this.#bump(m.chat_id, false);                          // ord preserved
    this.db.prepare("UPDATE messages SET deleted=1, body='', rev=? WHERE id=?").run(rev, msgId);
    return this.#record(opId, { t: 'ack', opId, id: msgId, c: m.chat_id, ord: null, rev });
  }
  head(chatId) {
    const c = this.db.prepare('SELECT next_ord, next_rev FROM chats WHERE id=?').get(chatId);
    return { head_ord: c.next_ord, head_rev: c.next_rev };
  }
  // every change with rev in (fromRev, toRev], in rev order
  #eventsSince(chatId, fromRev, limit) {
    const msgs = this.db.prepare(
      'SELECT id,ord,rev,author_id,body,deleted,parent_id FROM messages WHERE chat_id=? AND rev>?').all(chatId, fromRev);
    const rx = this.db.prepare(
      `SELECT r.message_id,r.emoji,r.actor_id,r.present,r.rev FROM reactions r
         JOIN messages m ON m.id=r.message_id WHERE m.chat_id=? AND r.rev>?`).all(chatId, fromRev);
    const evs = [
      ...msgs.map(m => ({ rev: m.rev, op: m.deleted ? 'del' : (m.ord !== null ? 'msg' : 'edit'), m })),
      ...rx.map(r => ({ rev: r.rev, op: 'react', r })),
    ].sort((a, b) => a.rev - b.rev);
    return limit ? evs.slice(0, limit) : evs;
  }
  catchup(chatId, fromRev) {
    const { head_rev, head_ord } = this.head(chatId);
    if (head_rev - fromRev > this.gapThreshold) {
      const recent = this.db.prepare(
        'SELECT id,ord,rev,author_id,body FROM messages WHERE chat_id=? AND deleted=0 ORDER BY ord DESC LIMIT 50'
      ).all(chatId).reverse();
      return { t: 'gap', c: chatId, head_rev, head_ord, recent };
    }
    return { t: 'catchup_ok', c: chatId, from_rev: fromRev, to_rev: head_rev,
             events: this.#eventsSince(chatId, fromRev) };
  }
  backfill(chatId, beforeOrd, limit) {           // keyset paging, newest→oldest
    return this.db.prepare(
      `SELECT id,ord,rev,author_id,body FROM messages
        WHERE chat_id=? AND deleted=0 AND ord < ? AND parent_id IS NULL
        ORDER BY ord DESC LIMIT ?`).all(chatId, beforeOrd, limit);
  }
  markRead(chatId, actorId, ord) {               // MAX-register, never overwrite
    this.db.prepare('UPDATE reads SET last_read_ord=MAX(last_read_ord,?) WHERE chat_id=? AND actor_id=?')
      .run(ord, chatId, actorId);
  }
  counters(chatId, actorId) {                    // server-side truth (§12)
    const r = this.db.prepare('SELECT last_read_ord FROM reads WHERE chat_id=? AND actor_id=?').get(chatId, actorId);
    const lr = r ? r.last_read_ord : 0;
    const row = this.db.prepare(
      `SELECT COUNT(*) n, SUM(CASE WHEN body LIKE ? THEN 1 ELSE 0 END) mentions
         FROM messages WHERE chat_id=? AND ord>? AND deleted=0 AND author_id<>?`
    ).get(`%@${actorId}%`, chatId, lr, actorId);
    return { chat_unread: row.n, mention_count: row.mentions ?? 0 };
  }
  hello(actorId, cursors) {
    return { t: 'welcome', chats: Object.entries(cursors)
      .filter(([c]) => this.isMember(c, actorId))
      .map(([c]) => ({ c, ...this.head(c), ...this.counters(c, actorId) })) };
  }
}

// ─── CLIENT ──────────────────────────────────────────────────────────────────
class Client {
  constructor(actorId) {
    this.actorId = actorId;
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE messages(id TEXT PRIMARY KEY, chat_id TEXT, parent_id TEXT, ord INTEGER,
        rev INTEGER, author_id TEXT, body TEXT, deleted INTEGER DEFAULT 0,
        state TEXT, created_at INTEGER);
      CREATE TABLE chat_state(chat_id TEXT PRIMARY KEY, synced_through_rev INTEGER DEFAULT 0,
        server_head_rev INTEGER DEFAULT 0, head_ord INTEGER DEFAULT 0,
        last_read_ord INTEGER DEFAULT 0, chat_unread INTEGER DEFAULT 0,
        mention_count INTEGER DEFAULT 0, has_gap INTEGER DEFAULT 0,
        oldest_local_ord INTEGER, frozen INTEGER DEFAULT 0);
      -- Holds ONLY revs received above the contiguous frontier. Collapses into
      -- synced_through_rev as holes fill, so it stays tiny.
      CREATE TABLE pending_revs(chat_id TEXT, rev INTEGER, PRIMARY KEY(chat_id, rev));
      CREATE TABLE outbox(op_id TEXT PRIMARY KEY, seq INTEGER, kind TEXT,
        chat_id TEXT, target_id TEXT, body TEXT);
    `);
    this.seq = 0;
  }
  ensure(chatId) {
    this.db.prepare('INSERT OR IGNORE INTO chat_state(chat_id) VALUES(?)').run(chatId);
    return this.db.prepare('SELECT * FROM chat_state WHERE chat_id=?').get(chatId);
  }
  // THE contiguity invariant (§8.1, invariant 1): advance only across an
  // unbroken run. A rev above a hole is stored but must NOT move the frontier.
  #advance(chatId) {
    let cur = this.ensure(chatId).synced_through_rev;
    const has = this.db.prepare('SELECT 1 FROM pending_revs WHERE chat_id=? AND rev=?');
    while (has.get(chatId, cur + 1)) cur++;
    this.db.prepare('UPDATE chat_state SET synced_through_rev=? WHERE chat_id=?').run(cur, chatId);
    this.db.prepare('DELETE FROM pending_revs WHERE chat_id=? AND rev<=?').run(chatId, cur);
    return cur;
  }
  applyEvent(ev) {
    const chatId = ev.c;
    this.ensure(chatId);
    if (this.db.prepare('SELECT frozen f FROM chat_state WHERE chat_id=?').get(chatId).f) return;
    if (ev.op === 'msg') {
      const m = ev.m;
      this.db.prepare(`INSERT OR REPLACE INTO messages
        VALUES(?,?,?,?,?,?,?,0,'acked',?)`).run(m.id, chatId, m.parent_id ?? null, m.ord, ev.rev, m.author_id, m.body, m.ord);
      this.db.prepare('UPDATE chat_state SET head_ord=MAX(head_ord,?) WHERE chat_id=?').run(m.ord, chatId);
    } else if (ev.op === 'edit') {
      this.db.prepare('UPDATE messages SET body=?, rev=? WHERE id=?').run(ev.m.body, ev.rev, ev.m.id);
    } else if (ev.op === 'del') {
      this.db.prepare("UPDATE messages SET deleted=1, body='', rev=? WHERE id=?").run(ev.rev, ev.m.id);
    }
    this.db.prepare('INSERT OR IGNORE INTO pending_revs VALUES(?,?)').run(chatId, ev.rev);
    this.db.prepare('UPDATE chat_state SET server_head_rev=MAX(server_head_rev,?) WHERE chat_id=?').run(ev.rev, chatId);
    this.#advance(chatId);
  }
  applyCatchup(res) {
    for (const ev of res.events) this.applyEvent({ ...ev, c: res.c });
    this.db.prepare('UPDATE chat_state SET server_head_rev=MAX(server_head_rev,?) WHERE chat_id=?')
      .run(res.to_rev, res.c);
    return this.#advance(res.c);
  }
  applyGap(g) {
    this.ensure(g.c);
    for (const m of g.recent) {
      this.db.prepare(`INSERT OR REPLACE INTO messages VALUES(?,?,NULL,?,?,?,?,0,'acked',?)`)
        .run(m.id, g.c, m.ord, m.rev, m.author_id, m.body, m.ord);
    }
    const oldest = g.recent.length ? g.recent[0].ord : null;
    this.db.prepare(`UPDATE chat_state SET synced_through_rev=?, server_head_rev=?,
      head_ord=?, has_gap=1, oldest_local_ord=? WHERE chat_id=?`)
      .run(g.head_rev, g.head_rev, g.head_ord, oldest, g.c);
    this.db.prepare('DELETE FROM pending_revs WHERE chat_id=?').run(g.c);
  }
  applyCounters(c) {
    this.ensure(c.c);
    this.db.prepare(`UPDATE chat_state SET server_head_rev=MAX(server_head_rev,?), head_ord=MAX(head_ord,?),
      chat_unread=?, mention_count=? WHERE chat_id=?`).run(c.head_rev, c.head_ord, c.chat_unread, c.mention_count, c.c);
  }
  applyBackfill(chatId, rows) {
    for (const m of rows)
      this.db.prepare(`INSERT OR REPLACE INTO messages VALUES(?,?,NULL,?,?,?,?,0,'acked',?)`)
        .run(m.id, chatId, m.ord, m.rev, m.author_id, m.body, m.ord);
    if (rows.length) {
      const oldest = Math.min(...rows.map(r => r.ord));
      this.db.prepare('UPDATE chat_state SET oldest_local_ord=? WHERE chat_id=?').run(oldest, chatId);
    }
  }
  state(chatId) { return this.db.prepare('SELECT * FROM chat_state WHERE chat_id=?').get(chatId); }
  msgCount(chatId) { return this.db.prepare('SELECT COUNT(*) n FROM messages WHERE chat_id=?').get(chatId).n; }
  ords(chatId) { return this.db.prepare(
    'SELECT ord FROM messages WHERE chat_id=? AND parent_id IS NULL ORDER BY ord').all(chatId).map(r => r.ord); }
  body(id) { const r = this.db.prepare('SELECT body FROM messages WHERE id=?').get(id); return r?.body; }
  freeze(chatId, on = 1) { this.db.prepare('UPDATE chat_state SET frozen=? WHERE chat_id=?').run(on, chatId); }

  // ─── outbox with coalescing (§10.4, invariant 6) ──────────────────────────
  enqueue(op) {
    const q = this.db;
    const existing = q.prepare('SELECT * FROM outbox WHERE target_id=? ORDER BY seq').all(op.targetId);
    const hasSend = existing.find(o => o.kind === 'send');
    if (op.kind === 'edit' && hasSend) {                       // send + edit → one send
      q.prepare('UPDATE outbox SET body=? WHERE op_id=?').run(op.body, hasSend.op_id); return;
    }
    if (op.kind === 'delete' && hasSend) {                     // send + delete → drop both
      q.prepare('DELETE FROM outbox WHERE target_id=?').run(op.targetId); return;
    }
    if (op.kind === 'edit') {                                  // edit + edit → keep last
      const prevEdit = existing.find(o => o.kind === 'edit');
      if (prevEdit) { q.prepare('UPDATE outbox SET body=? WHERE op_id=?').run(op.body, prevEdit.op_id); return; }
    }
    if (op.kind === 'delete') q.prepare("DELETE FROM outbox WHERE target_id=? AND kind='edit'").run(op.targetId);
    q.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)')
      .run(op.opId, ++this.seq, op.kind, op.chatId, op.targetId, op.body ?? null);
  }
  outbox() { return this.db.prepare('SELECT kind,target_id,body FROM outbox ORDER BY seq').all(); }
}

export { Server, Client, check, section };
export const results = () => ({ pass, fail, fails });
