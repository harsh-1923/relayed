// Tests the hypotheses in docs/DESIGN.md §8-§12 against the executable model.
// Run: pnpm spike:sync
import { Server, Client, check, section, results } from './sync-model.mjs';

const msg = (s, chat, n, author = 'a_bob', body = null, parent = null) =>
  s.send({ opId: `op_${chat}_${n}`, chatId: chat, msgId: `m_${chat}_${n}`,
           authorId: author, body: body ?? `message ${n}`, parentId: parent, createdAt: n });

// ── §8.1 the two-counter model ───────────────────────────────────────────────
section('§8.1  ord / rev separation');
{
  const s = new Server(); s.createChat('C');
  const a1 = msg(s, 'C', 1), a2 = msg(s, 'C', 2);
  check('new message bumps both ord and rev', [a1.ord, a1.rev, a2.ord, a2.rev], [1, 1, 2, 2]);

  const e = s.edit({ opId: 'e1', msgId: 'm_C_1', body: 'edited' });
  check('edit bumps rev, assigns NO ord',      [e.ord, e.rev],  [null, 3]);
  check('edit leaves head_ord untouched',      s.head('C').head_ord, 2);

  const r = s.react({ opId: 'r1', msgId: 'm_C_1', emoji: '🚀', actorId: 'a_x', present: true });
  check('reaction bumps rev, assigns NO ord',  [r.ord, r.rev],  [null, 4]);
  check('reaction leaves head_ord untouched',  s.head('C').head_ord, 2);

  const d = s.del({ opId: 'd1', msgId: 'm_C_1' });
  check('delete bumps rev, assigns NO ord',    [d.ord, d.rev],  [null, 5]);
  const a3 = msg(s, 'C', 3);
  check('next message ord is NOT renumbered after a delete', a3.ord, 3);
  check('head after 3 msgs + 3 mutations',     s.head('C'), { head_ord: 3, head_rev: 6 });
}

// ── invariant 1: contiguity ──────────────────────────────────────────────────
section('§8.1  cursor contiguity (invariant 1) — the critical one');
{
  const s = new Server(); s.createChat('C');
  for (let i = 1; i <= 6; i++) msg(s, 'C', i);
  const all = s.catchup('C', 0).events;

  const c = new Client('a_me');
  c.applyEvent({ ...all[0], c: 'C' });                       // rev 1
  c.applyEvent({ ...all[1], c: 'C' });                       // rev 2
  check('contiguous delivery advances cursor', c.state('C').synced_through_rev, 2);

  c.applyEvent({ ...all[4], c: 'C' });                       // rev 5 — HOLE at 3,4
  check('rev above a hole does NOT advance cursor', c.state('C').synced_through_rev, 2);
  check('but the out-of-order message IS stored',   c.msgCount('C'), 3);
  check('server_head_rev tracks what EXISTS',       c.state('C').server_head_rev, 5);

  c.applyEvent({ ...all[5], c: 'C' });                       // rev 6 — still holed
  check('second rev above the hole still blocked',  c.state('C').synced_through_rev, 2);

  c.applyEvent({ ...all[2], c: 'C' });                       // rev 3 — partial fill
  check('filling 3 advances only to 3',             c.state('C').synced_through_rev, 3);

  c.applyEvent({ ...all[3], c: 'C' });                       // rev 4 — hole closed
  check('closing the hole jumps to full frontier',  c.state('C').synced_through_rev, 6);
  check('pending_revs buffer drains to empty',
    c.db.prepare('SELECT COUNT(*) n FROM pending_revs').get().n, 0);
}

// ── invariant 5: idempotency ─────────────────────────────────────────────────
section('§8.5  idempotency on op_id (invariant 5)');
{
  const s = new Server(); s.createChat('C');
  const first  = s.send({ opId: 'dup', chatId: 'C', msgId: 'm1', authorId: 'a', body: 'hi' });
  const retry  = s.send({ opId: 'dup', chatId: 'C', msgId: 'm1', authorId: 'a', body: 'hi' });
  check('retry returns the SAME ord', [first.ord, retry.ord], [1, 1]);
  check('retry returns the SAME rev', [first.rev, retry.rev], [1, 1]);
  check('retry creates no duplicate row',
    s.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 1);
  check('retry does not burn a counter', s.head('C'), { head_ord: 1, head_rev: 1 });
}

// ── §9.3 catch-up below threshold ────────────────────────────────────────────
section('§9.3  catch-up below the gap threshold');
{
  const s = new Server(10); s.createChat('C'); s.join('C', 'a_me');
  for (let i = 1; i <= 8; i++) msg(s, 'C', i);
  const c = new Client('a_me');
  const res = s.catchup('C', 0);
  check('server replays in full',        res.t, 'catchup_ok');
  c.applyCatchup(res);
  check('cursor reaches head',           c.state('C').synced_through_rev, 8);
  check('client holds every message',    c.msgCount('C'), 8);
  check('no gap recorded',               c.state('C').has_gap, 0);
}

// ── §9.3 gap marker above threshold ──────────────────────────────────────────
section('§9.3  gap marker above the threshold');
{
  const s = new Server(50); s.createChat('C'); s.join('C', 'a_me');
  for (let i = 1; i <= 400; i++) msg(s, 'C', i);
  const c = new Client('a_me');
  const res = s.catchup('C', 0);
  check('server returns a gap, not 400 events', res.t, 'gap');
  check('gap carries only a bounded tail',      res.recent.length, 50);
  c.applyGap(res);
  const st = c.state('C');
  check('cursor jumps to head',                 st.synced_through_rev, 400);
  check('has_gap set',                          st.has_gap, 1);
  check('head_ord known despite the gap',       st.head_ord, 400);
  check('client stores only the tail',          c.msgCount('C'), 50);
  check('oldest_local_ord marks the boundary',  st.oldest_local_ord, 351);
}

// ── §12 the R2 claim: correct badges without the messages ────────────────────
section('§12  unread is correct while holding almost no messages (R2)');
{
  const s = new Server(50); s.createChat('C'); s.join('C', 'a_me');
  for (let i = 1; i <= 300; i++) msg(s, 'C', i, 'a_bob');
  s.markRead('C', 'a_me', 100);
  msg(s, 'C', 301, 'a_bob', 'ping @a_me look at this');
  msg(s, 'C', 302, 'a_bob', 'and @a_me again');

  const c = new Client('a_me');
  const w = s.hello('a_me', { C: 0 });
  c.applyCounters({ c: 'C', ...w.chats[0] });
  check('welcome carries head + counters in one frame', w.chats.length, 1);
  check('unread correct with ZERO messages held',
    [c.msgCount('C'), c.state('C').chat_unread], [0, 202]);
  check('mention count correct with zero messages held', c.state('C').mention_count, 2);

  // arithmetic fallback agrees with the server counter
  const st = c.state('C');
  check('head_ord - last_read_ord agrees', st.head_ord - 100, 202);
}

// ── §9.4 backfill paging ─────────────────────────────────────────────────────
section('§9.4  keyset backfill paging');
{
  const s = new Server(50); s.createChat('C'); s.join('C', 'a_me');
  for (let i = 1; i <= 237; i++) msg(s, 'C', i);
  const c = new Client('a_me');
  c.applyGap(s.catchup('C', 0));

  let cursor = c.state('C').oldest_local_ord, pages = 0, seen = [];
  while (cursor > 1) {
    const rows = s.backfill('C', cursor, 50);
    if (!rows.length) break;
    c.applyBackfill('C', rows); seen.push(...rows.map(r => r.ord));
    cursor = Math.min(...rows.map(r => r.ord)); pages++;
  }
  check('paging terminates',                    pages, 4);
  check('no duplicates across pages',           seen.length, new Set(seen).size);
  check('full history reassembled',             c.msgCount('C'), 237);
  const ords = c.ords('C');
  check('ords are complete and in order 1..237',
    [ords[0], ords[ords.length - 1], ords.length], [1, 237, 237]);
  check('backfill reached the beginning',       c.state('C').oldest_local_ord, 1);
}

// ── §6.6 removal freezes; re-add is a gap ────────────────────────────────────
section('§6.6  removal freezes local history; re-add heals via the gap path');
{
  const s = new Server(20); s.createChat('C'); s.join('C', 'a_me');
  for (let i = 1; i <= 10; i++) msg(s, 'C', i);
  const c = new Client('a_me');
  c.applyCatchup(s.catchup('C', 0));
  check('member synced normally', c.msgCount('C'), 10);

  s.remove('C', 'a_me', 99); c.freeze('C');
  for (let i = 11; i <= 60; i++) msg(s, 'C', i);              // 50 messages while away
  const evs = s.catchup('C', 10);
  for (const ev of evs.events ?? []) c.applyEvent({ ...ev, c: 'C' });
  check('removed member receives nothing new',   c.msgCount('C'), 10);
  check('local history is retained, not recalled', c.ords('C').length, 10);
  check('cursor frozen at removal point',        c.state('C').synced_through_rev, 10);

  s.join('C', 'a_me'); c.freeze('C', 0);                      // re-added
  const res = s.catchup('C', c.state('C').synced_through_rev);
  check('re-add is exactly the gap case',        res.t, 'gap');
  c.applyGap(res);
  check('badges correct immediately after re-add', c.state('C').head_ord, 60);
  check('no special-case code path needed',      c.state('C').has_gap, 1);
}

// ── invariant 6: outbox coalescing ───────────────────────────────────────────
section('§10.4  outbox coalescing (invariant 6)');
{
  let c = new Client('a_me');
  c.enqueue({ opId: 'o1', kind: 'send', chatId: 'C', targetId: 'm1', body: 'draft' });
  c.enqueue({ opId: 'o2', kind: 'edit', chatId: 'C', targetId: 'm1', body: 'revised' });
  check('send + edit collapses to one send',
    c.outbox(), [{ kind: 'send', target_id: 'm1', body: 'revised' }]);

  c = new Client('a_me');
  c.enqueue({ opId: 'o1', kind: 'send',   chatId: 'C', targetId: 'm1', body: 'oops' });
  c.enqueue({ opId: 'o2', kind: 'delete', chatId: 'C', targetId: 'm1' });
  check('send + delete never touches the network', c.outbox(), []);

  c = new Client('a_me');
  c.enqueue({ opId: 'o1', kind: 'edit', chatId: 'C', targetId: 'm9', body: 'v1' });
  c.enqueue({ opId: 'o2', kind: 'edit', chatId: 'C', targetId: 'm9', body: 'v2' });
  check('edit + edit keeps only the last',
    c.outbox(), [{ kind: 'edit', target_id: 'm9', body: 'v2' }]);

  c = new Client('a_me');
  c.enqueue({ opId: 'o1', kind: 'edit',   chatId: 'C', targetId: 'm9', body: 'v1' });
  c.enqueue({ opId: 'o2', kind: 'delete', chatId: 'C', targetId: 'm9' });
  check('edit + delete drops the edit',
    c.outbox(), [{ kind: 'delete', target_id: 'm9', body: null }]);
}

// ── §8.2 threads share the ord space ─────────────────────────────────────────
section('§8.2  threads share the chat ord space');
{
  const s = new Server(); s.createChat('C');
  const root = msg(s, 'C', 1);
  const r1 = s.send({ opId: 'p1', chatId: 'C', msgId: 'r1', authorId: 'a', body: 'reply', parentId: root.id });
  const top = msg(s, 'C', 2);
  check('replies consume ord from the same space', [root.ord, r1.ord, top.ord], [1, 2, 3]);
  check('one cursor still covers everything',      s.head('C').head_rev, 3);
  const topOnly = s.backfill('C', 999, 50).map(r => r.ord).sort((a, b) => a - b);
  check('chat view excludes thread replies',       topOnly, [1, 3]);
}

// ── §4 read state is a MAX-register, not LWW ─────────────────────────────────
section('§4  last_read_ord is a MAX-register (not LWW)');
{
  const s = new Server(); s.createChat('C'); s.join('C', 'a_me');
  for (let i = 1; i <= 20; i++) msg(s, 'C', i);
  s.markRead('C', 'a_me', 15);                       // laptop reads to 15
  check('read advances normally', s.counters('C', 'a_me').chat_unread, 5);
  s.markRead('C', 'a_me', 4);                        // stale phone syncs an OLD value
  check('a stale device does NOT un-read the chat',
    s.counters('C', 'a_me').chat_unread, 5);
  s.markRead('C', 'a_me', 20);
  check('a newer value still advances', s.counters('C', 'a_me').chat_unread, 0);
}

// ── §10.6 pending messages reorder on ack ────────────────────────────────────
section('§10.6  a pending message takes its true position on ack');
{
  const s = new Server(20); s.createChat('C'); s.join('C', 'a_me');
  const c = new Client('a_me');
  msg(s, 'C', 1); c.applyCatchup(s.catchup('C', 0));

  // compose offline: no ord yet, sorts after everything known
  c.db.prepare(`INSERT INTO messages VALUES('mine','C',NULL,NULL,NULL,'a_me','mine',0,'pending',999)`).run();
  const order = () => c.db.prepare(
    `SELECT id FROM messages WHERE chat_id='C' ORDER BY (ord IS NULL), ord, created_at`).all().map(r => r.id);
  check('pending message sorts to the bottom', order(), ['m_C_1', 'mine']);

  // two other messages land while ours is in flight
  msg(s, 'C', 2); msg(s, 'C', 3);
  const ack = s.send({ opId: 'mine', chatId: 'C', msgId: 'mine', authorId: 'a_me', body: 'mine' });
  c.applyCatchup(s.catchup('C', c.state('C').synced_through_rev));
  c.db.prepare("UPDATE messages SET ord=?, rev=?, state='acked' WHERE id='mine'").run(ack.ord, ack.rev);

  check('ack assigns an ord AFTER the interleaved messages', ack.ord, 4);
  check('final order matches every other client', order(), ['m_C_1', 'm_C_2', 'm_C_3', 'mine']);
  check('cursor still contiguous after the interleave',
    c.state('C').synced_through_rev, s.head('C').head_rev);
}

// ── why pending_revs must exist as its own table ─────────────────────────────
section('§8.3  received-rev tracking is NOT derivable from message rows');
{
  const s = new Server(); s.createChat('C');
  for (let i = 1; i <= 3; i++) msg(s, 'C', i);
  const c = new Client('a_me');
  c.applyCatchup(s.catchup('C', 0));                     // cursor = 3

  // rev 5 deletes a message this client never held (evicted, or below its
  // window after a gap). NOTHING lands in `messages` — the row does not exist.
  c.applyEvent({ c: 'C', rev: 5, op: 'del', m: { id: 'm_never_had' } });
  check('a delete for an unheld message writes no message row',
    c.db.prepare("SELECT COUNT(*) n FROM messages WHERE id='m_never_had'").get().n, 0);
  check('...but pending_revs still records that rev 5 arrived',
    c.db.prepare("SELECT COUNT(*) n FROM pending_revs WHERE rev=5").get().n, 1);
  check('cursor correctly stays behind the hole at rev 4',
    c.state('C').synced_through_rev, 3);

  c.applyEvent({ c: 'C', rev: 4, op: 'edit', m: { id: 'm_C_1', body: 'edited' } });
  check('filling rev 4 advances across BOTH 4 and the unheld delete at 5',
    c.state('C').synced_through_rev, 5);

  // Without the table, MAX(rev) over messages would be the only signal — and it
  // cannot see rev 5 at all, so the cursor would stall at 4 forever.
  const maxFromRows = c.db.prepare('SELECT MAX(rev) m FROM messages WHERE chat_id=?').get('C').m;
  check('MAX(rev) over message rows alone would have stalled at 4', maxFromRows, 4);
}

const r = results();
console.log(`\n${'─'.repeat(58)}\n${r.pass} passed, ${r.fail} failed`);
if (r.fail) { console.log('FAILED:', r.fails.join(', ')); process.exit(1); }
