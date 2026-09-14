// Tests the claims in docs/WORKSPACE-AGENTS.md §8 (messages only some people
// can see) against spikes/visibility-model.mjs. Plan step 1's spike,
// docs/WORKSPACE-AGENTS-IMPL.md §4.1.
//
//   node spikes/visibility-tests.mjs              the suite, once, against the correct model
//   node spikes/visibility-mutants.mjs            the suite against every mutant; each must be caught
//
// Two kinds of test. Named scenarios pin each rule in §8.3–§8.8, and each rule
// of gap repair (WORKSPACE-AGENTS-IMPL.md §4.1.1: the version rule, complete
// rows, repair on reconnect), to a small, readable trace. The property test then throws random traffic, reordering,
// duplicates, dropped sockets, gaps and membership churn at the same model and
// checks what must hold once everything settles — and it refuses to pass if the
// random worlds never reached a path, because an agreement nobody tested is not
// agreement (AUTHZ.md §12.1, the equivalence test that passed for the wrong reason).
import { performance } from 'node:perf_hooks';
import { Server, World } from './visibility-model.mjs';

export function runSuite({ mutant = null, seeds = 400, steps = 80, quiet = false, findings: runFindings = true } = {}) {
  let pass = 0;
  let fail = 0;
  const fails = [];
  const findings = [];
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const check = (name, actual, expected) => {
    if (same(actual, expected)) { pass++; log(`  ok   ${name}`); return; }
    fail++; fails.push(name);
    log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
  };
  const section = (title) => log(`\n${title}`);
  const world = (options) => new World({ mutant, ...options });
  const threw = (work) => { try { work(); return false; } catch { return true; } };
  /**
   * One named scenario. A scenario that throws is a failed check with its
   * name, not an aborted suite: under a mutant, a trace that crashes because a
   * frame never arrived is a detection, and every scenario after it must still
   * run and report.
   */
  const scenario = (title, body) => {
    section(title);
    try { body(); }
    catch (err) { fail++; fails.push(`${title} — threw`); log(`  FAIL threw: ${err.message}`); }
  };

  /** Deliver an actor's whole inbox, in the order given. */
  const drain = (w, actor, order = 'fifo') => {
    const frames = [...w.inbox.get(actor)];
    w.inbox.set(actor, []);
    for (const frame of order === 'reverse' ? frames.reverse() : frames) w.receive(actor, frame);
  };
  const drainAll = (w) => { for (const actor of w.actors) drain(w, actor); };

  // ── §8.4 live delivery ─────────────────────────────────────────────────────
  scenario('§8.4  live delivery: the listed get the message, everyone else gets the revision', () => {
    const w = world({ actors: ['alice', 'bob', 'carol'], gapThreshold: 1000 });
    w.sendPublic('bob');                                   // rev 1
    w.sendRestricted('bob', ['alice']);                    // rev 2
    w.sendPublic('bob');                                   // rev 3
    const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(actor => w.inbox.get(actor));
    check('every reader is sent something for every revision',
      [alice.length, bob.length, carol.length], [3, 3, 3]);
    check('the listed reader receives the restricted message',
      [alice[1].type, alice[1].rev], ['message.created', 2]);
    check('...with who it is visible to', alice[1].payload.visible_to, ['alice']);
    check('an unlisted reader receives exactly a withheld frame',
      carol[1], { t: 'ev', c: 'C', rev: 2, type: 'withheld', payload: {} });
    check('the author is not special: bob is not listed, so bob is withheld too', bob[1].type, 'withheld');
    check('a public message carries no visible_to', 'visible_to' in alice[0].payload, false);
    drainAll(w);
    check('every frontier reaches the head',
      w.actors.map(actor => w.clients.get(actor).frontier('C')), [3, 3, 3]);
    check('alice holds three messages, carol two',
      [w.clients.get('alice').visibleIds('C').length, w.clients.get('carol').visibleIds('C').length], [3, 2]);
    check('alice\'s replica records who the message is visible to',
      w.clients.get('alice').db.prepare("SELECT visible_to FROM messages WHERE id='m2'").get()?.visible_to ?? null,
      null);
    check('...and the restricted one is recorded as such',
      JSON.parse(w.clients.get('alice').db.prepare("SELECT visible_to FROM messages WHERE ord=2").get().visible_to),
      ['alice']);
    w.audit('live'); check('no frame reached anyone it should not have', w.violations, []);
  });

  // ── §8.3 out of order ──────────────────────────────────────────────────────
  scenario('§8.3  a withheld revision fills a hole exactly like any other event', () => {
    const w = world({ actors: ['alice', 'carol'], gapThreshold: 1000 });
    w.sendPublic('alice');                                 // rev 1
    w.sendRestricted('alice', ['alice']);                  // rev 2 → withheld for carol
    w.sendPublic('alice');                                 // rev 3
    const [first, withheld, third] = w.inbox.get('carol');
    w.inbox.set('carol', []);
    const carol = w.clients.get('carol');
    w.receive('carol', first);
    w.receive('carol', third);
    check('rev 3 above the hole is staged, frontier stays at 1', [carol.frontier('C'), carol.stagedCount('C')], [1, 1]);
    w.receive('carol', withheld);
    check('the withheld rev 2 closes the hole and drains rev 3', [carol.frontier('C'), carol.stagedCount('C')], [3, 0]);
    w.receive('carol', withheld);
    check('a duplicate withheld frame changes nothing', [carol.frontier('C'), carol.visibleIds('C').length], [3, 2]);

    const staged = world({ actors: ['alice', 'carol'], gapThreshold: 1000 });
    staged.sendPublic('alice'); staged.sendRestricted('alice', ['alice']); staged.sendRestricted('alice', ['alice']);
    staged.sendPublic('alice');
    drain(staged, 'carol', 'reverse');
    check('withheld frames staged above a hole drain in order when it closes',
      [staged.clients.get('carol').frontier('C'), staged.clients.get('carol').stagedCount('C')], [4, 0]);
  });

  // ── §8.3 the failure this prevents, executed ───────────────────────────────
  scenario('§8.3  the failure withholding prevents, executed against the naive design', () => {
    const naive = new World({ actors: ['alice', 'carol'], gapThreshold: 1000, mutant: 'drop-not-withhold' });
    naive.sendPublic('alice'); naive.sendRestricted('alice', ['alice']); naive.sendPublic('alice');
    drain(naive, 'carol');
    check('dropping the revision leaves carol staged behind a hole that live traffic never fills',
      [naive.clients.get('carol').frontier('C'), naive.clients.get('carol').stagedCount('C')], [1, 1]);
    naive.reconnect('carol');
    check('...catch-up cannot fill it either, so the chat is stuck for good',
      naive.violations.some(v => v.startsWith('catch-up for carol never reached the head')), true);
    naive.sendPublic('alice'); drain(naive, 'carol');
    check('...and every later message is staged and never shown',
      [naive.clients.get('carol').visibleIds('C').length, naive.clients.get('carol').stagedCount('C')], [1, 2]);
  });

  // ── §8.7 catch-up ──────────────────────────────────────────────────────────
  scenario('§8.7  catch-up redacts per requester, across paged rounds', () => {
    const w = world({ actors: ['alice', 'bob', 'carol'], gapThreshold: 1000, replayLimit: 2 });
    w.drop('carol'); w.drop('alice');
    w.sendRestricted('bob', ['alice']); w.sendPublic('bob'); w.sendRestricted('bob', ['alice']);
    w.sendRestricted('bob', ['alice', 'bob']); w.sendPublic('bob');
    const rounds = w.coverage.catchupRounds;
    w.reconnect('carol');
    check('an unlisted reader reaches the head through paged catch-up', w.clients.get('carol').frontier('C'), 5);
    check('...in more than one round', w.coverage.catchupRounds - rounds >= 3, true);
    check('...holding only the public messages', w.clients.get('carol').visibleIds('C'), ['m2', 'm5']);
    w.reconnect('alice');
    check('a listed reader catches up to everything listing it',
      w.clients.get('alice').visibleIds('C'), ['r1', 'm2', 'r3', 'r4', 'm5']);
    drain(w, 'bob');
    check('bob, listed only on r4, holds r4 and the public ones', w.clients.get('bob').visibleIds('C'), ['m2', 'r4', 'm5']);
    w.audit('catchup'); check('no catch-up frame leaked', w.violations, []);
  });

  // ── §8.7 gap tail and backfill, with ordinal 1 hidden ──────────────────────
  scenario('§8.7  gap tail and backfill — ordinal 1 hidden, and a page holding a hidden row', () => {
    const w = world({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 2, backfillLimit: 3 });
    w.drop('carol');
    w.sendRestricted('alice', ['alice']);                                   // ord 1, hidden from carol
    for (let i = 0; i < 4; i++) w.sendPublic('alice');                      // ords 2–5
    w.sendRestricted('alice', ['alice']);                                   // ord 6, hidden from carol
    for (let i = 0; i < 5; i++) w.sendPublic('alice');                      // ords 7–11
    w.reconnect('carol');
    const carol = w.clients.get('carol');
    check('carol is too far behind, so she takes a gap', [w.coverage.gaps, carol.hasGap('C')], [1, true]);
    check('the gap tail holds only messages she may see', carol.visibleIds('C').length, 2);
    w.backfillToTop('carol');
    check('backfill closes the gap although ordinal 1 is hidden from her', carol.hasGap('C'), false);
    check('carol holds every public message, in order, with holes where the hidden ones are',
      carol.db.prepare("SELECT ord FROM messages WHERE chat_id='C' ORDER BY ord").all().map(row => row.ord),
      [2, 3, 4, 5, 7, 8, 9, 10, 11]);
    check('nothing is missing and nothing extra is held', w.violations, []);
    w.drop('alice'); w.reconnect('alice'); w.backfillToTop('alice');
    check('alice, listed on both, holds all eleven', w.clients.get('alice').visibleIds('C').length, 11);
    w.audit('gap'); check('no gap or backfill row leaked', w.violations, []);
  });

  // ── §8.7 unread badges ─────────────────────────────────────────────────────
  scenario('§8.7  a restricted message never becomes a badge that cannot clear', () => {
    const w = world({ actors: ['alice', 'bob', 'carol'], gapThreshold: 1000 });
    for (let i = 0; i < 3; i++) w.sendPublic('bob');
    w.sendRestricted('bob', ['alice']);                                     // the newest, hidden from carol
    drainAll(w);
    const server = w.server;
    check('carol\'s unread counts only what she can see', server.counters('C', 'carol').chat_unread, 3);
    check('...and agrees with ground truth', server.counters('C', 'carol').chat_unread, server.truthUnread('C', 'carol'));
    check('alice\'s unread includes the message listing her', server.counters('C', 'alice').chat_unread, 4);
    server.markRead('C', 'carol', w.clients.get('carol').highestHeldOrd('C'));
    check('carol reads up to the newest message she holds, and the badge clears', server.counters('C', 'carol').chat_unread, 0);
    server.markRead('C', 'alice', w.clients.get('alice').highestHeldOrd('C'));
    check('alice reads hers, and her badge clears too', server.counters('C', 'alice').chat_unread, 0);
    const mention = world({ actors: ['alice', 'carol'], gapThreshold: 1000 });
    mention.server.send({ opId: 'op_x', chatId: 'C', messageId: 'x', authorId: 'alice', body: 'ping @carol', listed: ['alice'] });
    check('a hidden message that mentions carol is not a mention for carol',
      mention.server.counters('C', 'carol'), { chat_unread: 0, mention_count: 0 });
  });

  // ── §8.4 edits and deletes ─────────────────────────────────────────────────
  scenario('§8.4  every event about a restricted message is withheld the same way', () => {
    const w = world({ actors: ['alice', 'bob', 'carol'], gapThreshold: 1000 });
    w.sendRestricted('bob', ['alice']);                                     // rev 1
    const { event: edited } = w.server.edit({ opId: 'e1', actorId: 'bob', messageId: 'r1', body: 'new body' });
    for (const [actor, frame] of w.server.deliver(edited)) w.inbox.get(actor).push(frame);   // rev 2
    const { event: deleted } = w.server.del({ opId: 'd1', actorId: 'bob', messageId: 'r1' });
    for (const [actor, frame] of w.server.deliver(deleted)) w.inbox.get(actor).push(frame);  // rev 3
    w.sendPublic('bob');                                                    // rev 4
    check('carol is told nothing about the edit or the delete but their revisions',
      w.inbox.get('carol').map(frame => [frame.type, frame.payload]),
      [['withheld', {}], ['withheld', {}], ['withheld', {}], ['message.created', w.inbox.get('carol')[3].payload]]);
    check('alice receives the creation, the edit and the delete',
      w.inbox.get('alice').slice(0, 3).map(frame => frame.type), ['message.created', 'message.edited', 'message.deleted']);
    drainAll(w);
    check('all three frontiers reach the head', w.actors.map(actor => w.clients.get(actor).frontier('C')), [4, 4, 4]);
    check('alice\'s tombstone applied', w.clients.get('alice').visibleIds('C'), ['m2']);
    w.audit('mutations'); check('no mutation leaked', w.violations, []);
  });

  // ── §8.6 the leading conjunct ──────────────────────────────────────────────
  scenario('§8.6  being listed never outlives being able to read the chat', () => {
    const w = world({ actors: ['alice', 'bob', 'carol'], gapThreshold: 2, gapTail: 5, backfillLimit: 2 });
    w.sendRestricted('bob', ['alice', 'carol']);                            // rev 1, ord 1
    drainAll(w);
    w.server.leave('C', 'alice');
    const { event } = w.server.edit({ opId: 'e1', actorId: 'bob', messageId: 'r1', body: 'changed' });
    const recipients = w.server.deliver(event).map(([actor, frame]) => [actor, frame.type]).sort();
    check('alice, listed but gone, is sent nothing', recipients.some(([actor]) => actor === 'alice'), false);
    check('carol, listed and present, gets the edit; bob gets the revision',
      recipients, [['bob', 'withheld'], ['carol', 'message.edited']]);
    w.server.leave('C', 'carol');
    for (let i = 0; i < 4; i++) w.sendPublic('bob');
    w.drop('bob'); w.reconnect('bob'); w.backfillToTop('bob');
    check('with every listed actor gone, the message is visible to nobody still in the chat',
      w.clients.get('bob').visibleIds('C').includes('r1'), false);
    check('...not in bob\'s unread either', w.server.counters('C', 'bob').chat_unread, w.server.truthUnread('C', 'bob'));
    w.audit('conjunct'); check('no frame reached a listed actor who had left, or bob', w.violations, []);
  });

  // ── §8.5 and §8.8 writes ───────────────────────────────────────────────────
  scenario('§8.5 §8.8  what a restricted write may and may not be', () => {
    const server = new Server({ mutant });
    server.createChat('C'); server.join('C', 'alice'); server.join('C', 'carol');
    check('an empty list is refused, never read as the whole chat',
      threw(() => server.send({ opId: 'o1', chatId: 'C', messageId: 'x1', authorId: 'alice', body: 'b', listed: [] })), true);
    check('listing someone who cannot read the chat is refused',
      threw(() => server.send({ opId: 'o2', chatId: 'C', messageId: 'x2', authorId: 'alice', body: 'b', listed: ['mallory'] })), true);
    check('a refused write allocates no revision', server.head('C'), { head_ord: 0, head_rev: 0 });

    const first = server.send({ opId: 'o3', chatId: 'C', messageId: 'x3', authorId: 'alice', body: 'b', listed: ['carol', 'carol'] });
    const replay = server.send({ opId: 'o3', chatId: 'C', messageId: 'x3', authorId: 'alice', body: 'b', listed: ['carol'] });
    check('a replayed restricted write returns the stored ack', replay.ack, first.ack);
    check('...and produces no second event to fan out', replay.event, undefined);
    check('a duplicated name is listed once', server.listedFor('x3'), ['carol']);
    check('one log row, one audience row',
      [server.db.prepare('SELECT COUNT(*) n FROM sync_events').get().n,
       server.db.prepare('SELECT COUNT(*) n FROM message_audience').get().n], [1, 1]);

    server.send({ opId: 'o4', chatId: 'C', messageId: 'x4', authorId: 'alice', body: 'b' });
    check('a public message bumps room activity; a restricted one does not', server.activityBumps('C'), 1);

    const insert = (audience, listed) => threw(() => server.db.prepare(
      "INSERT INTO sync_events VALUES('C', ?, 'x', '{}', ?, ?)").run(Math.floor(Math.random() * 1e9) + 1000, audience, listed));
    check('the log refuses listed with no list, an empty list, and a stream with a list',
      [insert('listed', null), insert('listed', '[]'), insert('stream', '["a"]')], [true, true, true]);
    check('the log admits a stream event and a listed one', [insert('stream', null), insert('listed', '["a"]')], [false, false]);
    const trap = new Server();
    trap.db.exec(`CREATE TABLE trap(audience TEXT, listed TEXT, CHECK (
      (audience = 'stream' AND listed IS NULL) OR (audience = 'listed' AND json_array_length(listed) >= 1)))`);
    check('without IS NOT NULL, SQLite admits listed with a NULL list — the same trap as Postgres',
      threw(() => trap.db.prepare("INSERT INTO trap VALUES('listed', NULL)").run()), false);
  });

  // ── invariant 32: clients built before this ────────────────────────────────
  scenario('invariant 32  a client that has never heard of `withheld` still converges', () => {
    const w = world({ actors: ['alice', 'carol'], oldClients: ['carol'], gapThreshold: 1000 });
    w.sendRestricted('alice', ['alice']); w.sendPublic('alice'); w.sendRestricted('alice', ['alice']);
    w.sendRestricted('alice', ['alice']); w.sendPublic('alice');
    drain(w, 'carol', 'reverse');
    const carol = w.clients.get('carol');
    check('the old client reaches the head', carol.frontier('C'), 5);
    check('...counting three unknown events rather than stalling on them', carol.unknownTypes, 3);
    check('...and holds the two public messages', carol.visibleIds('C'), ['m2', 'm5']);
  });

  // ── findings: behaviour of today's gap path, executed, not pass/fail ───────
  // None of these involve visibility. They are recorded because this model is
  // the first to exercise gaps under random traffic, and it found them.
  // ── gap repair: a held message changed while the client was past the threshold ──
  /** Carol holds 1–10; while she is far behind, four of them change and 40 more arrive. */
  const carolsWeek = (options = {}) => {
    const w = world({ actors: ['alice', 'bob', 'carol'], gapThreshold: 5, gapTail: 3, backfillLimit: 4, ...options });
    for (let i = 0; i < 10; i++) w.sendPublic('alice');                    // m1..m10
    drainAll(w);
    w.drop('carol');
    w.server.edit({ opId: 'e', actorId: 'alice', messageId: 'm3', body: 'm3 corrected' });
    w.server.send({ opId: 'p1', chatId: 'C', messageId: 'reply1', authorId: 'bob', body: 'reply1 reply', parentId: 'm5' });
    w.server.send({ opId: 'p2', chatId: 'C', messageId: 'reply2', authorId: 'bob', body: 'reply2 reply', parentId: 'm5' });
    w.server.del({ opId: 'd', actorId: 'bob', messageId: 'm7' });
    w.server.react({ opId: 'x', actorId: 'alice', messageId: 'm9', emoji: '🎉', present: true });
    for (let i = 0; i < 40; i++) w.sendPublic('alice');
    return w;
  };

  scenario('version rule  what changed while carol was away is repaired at reconnect', () => {
    const w = carolsWeek();
    const carol = w.clients.get('carol');
    w.reconnect('carol');
    check('carol took a gap, and the repair ran to completion', [w.coverage.gaps, carol.repairPending('C')], [1, null]);
    const shown = carol.rendered('C');
    check('the deleted message is gone from her view', shown.m7.deleted, true);
    check('the edited message shows its new body, marked edited', [shown.m3.body, shown.m3.edited], ['m3 corrected', true]);
    check('the message that gained replies shows their count', shown.m5.reply_count, 2);
    check('the reacted message shows the reaction', shown.m9.reactions, ['🎉:alice']);
    check('unchanged held messages are untouched', [shown.m1.body, shown.m10.reply_count], ['m1 from alice', 0]);
    check('repair is about held rows: nothing above what carol held was in it',
      w.server.emitted.filter(e => e.path === 'repair' && e.actorId === 'carol').every(e => e.frame.row.ord <= 10), true);
    w.backfillToTop('carol');
    w.openThread('carol', 'm5');
    const have = carol.rendered('C'); const want = w.server.truthRendered('C', 'carol');
    check('after scrolling up and opening the thread, everything matches ground truth',
      Object.keys(want).filter(id => JSON.stringify(have[id]) !== JSON.stringify(want[id])), []);
    w.audit('repair'); check('no repair or thread row leaked', w.violations, []);
  });

  scenario('version rule  a reply bumps its parent; deleting a reply lowers the count, held or not', () => {
    const w = world({ actors: ['alice', 'bob'], gapThreshold: 1000 });
    w.sendPublic('alice');                                                  // m1
    drainAll(w);
    const parentRev = () => w.server.message('m1').rev;
    const before = parentRev();
    w.drop('bob');                                                          // bob misses the reply's creation
    const created = w.server.send({ opId: 'p1', chatId: 'C', messageId: 'p2', authorId: 'alice', body: 'p2 reply', parentId: 'm1' });
    for (const [actor, frame] of w.server.deliver(created.event)) if (actor === 'alice') w.receive('alice', frame);
    check('the parent\'s version moved with the reply', parentRev() > before, true);
    w.reconnect('bob');
    const bob = w.clients.get('bob');
    check('bob learned the count from the parent row, without holding the reply',
      [bob.rendered('C').m1.reply_count, bob.heldReplies('C', 'm1').length], [1, 1]);
    const { event } = w.server.del({ opId: 'd', actorId: 'alice', messageId: 'p2' });
    for (const [actor, frame] of w.server.deliver(event)) w.receive(actor, frame);
    check('the delete event names the parent, so every count moves',
      [bob.rendered('C').m1.reply_count, w.clients.get('alice').rendered('C').m1.reply_count], [0, 0]);
    check('alice, who held the reply, shows it deleted', w.clients.get('alice').rendered('C').p2.deleted, true);
    check('an event type that declares nothing it touches is refused', threw(() => w.server.touches('space.renamed', {})), true);
  });

  scenario('version rule  a count learned from a row, then a live delete of a reply never held', () => {
    const w = world({ actors: ['alice', 'bob'], gapThreshold: 3, gapTail: 2, backfillLimit: 5 });
    w.sendPublic('alice');                                                  // m1
    drainAll(w);
    w.drop('bob');
    w.server.send({ opId: 'p1', chatId: 'C', messageId: 'p2', authorId: 'alice', body: 'p2 reply', parentId: 'm1' });
    for (let i = 0; i < 6; i++) w.sendPublic('alice');
    w.reconnect('bob');                                                     // a gap: bob gets m1's row with count 1, not p2
    const bob = w.clients.get('bob');
    check('bob counts the reply he does not hold', [bob.rendered('C').m1.reply_count, bob.heldReplies('C', 'm1').length], [1, 0]);
    const { event } = w.server.del({ opId: 'd', actorId: 'alice', messageId: 'p2' });
    for (const [actor, frame] of w.server.deliver(event)) w.receive(actor, frame);
    check('the live delete carries the parent id, so his count moves anyway', bob.rendered('C').m1.reply_count, 0);
  });

  scenario('version rule  the client applies a fetched row only if it is not older than what it holds', () => {
    const w = carolsWeek();
    const carol = w.clients.get('carol');
    // Reconnect by hand: catch up (a gap), then fetch ONE repair page and, before
    // applying it, receive a live reaction on a message that page also carries.
    w.online.set('carol', true); w.inbox.set('carol', []);
    carol.applyGap('C', w.server.catchup('C', 'carol', carol.frontier('C')));
    const pending = carol.repairPending('C');
    const page = w.server.repair('C', 'carol', pending.sinceRev, pending.maxOrd, null, 10);
    check('the page carries m9 with one reaction', page.rows.find(r => r.id === 'm9').reactions, ['🎉:alice']);
    const { event } = w.server.react({ opId: 'x2', actorId: 'bob', messageId: 'm9', emoji: '👍', present: true });
    for (const [actor, frame] of w.server.deliver(event)) if (actor === 'carol') w.receive('carol', frame);
    check('the live reaction landed first', carol.rendered('C').m9.reactions, ['👍:bob']);
    const { rejected } = carol.applyRepair('C', page);
    check('the page\'s older copy of m9 was rejected, the untouched rows applied',
      [rejected, carol.rendered('C').m7.deleted], [1, true]);
    check('a rejection keeps the repair open even though the page said complete', carol.repairPending('C') !== null, true);
    w.repairPending('carol');
    check('paging on by version serves m9 again, complete, and nothing was lost',
      [carol.rendered('C').m9.reactions, carol.repairPending('C')], [['🎉:alice', '👍:bob'], null]);
  });

  scenario('version rule  a quit mid-repair resumes from the persisted cursor', () => {
    const w = carolsWeek({ backfillLimit: 1 });
    const carol = w.clients.get('carol');
    w.online.set('carol', true); w.inbox.set('carol', []);
    carol.applyGap('C', w.server.catchup('C', 'carol', carol.frontier('C')));
    const first = carol.repairPending('C');
    carol.applyRepair('C', w.server.repair('C', 'carol', first.sinceRev, first.maxOrd, null, 1));
    const resumed = carol.repairPending('C');
    check('after one page the cursor is persisted, not cleared', [resumed.sinceRev, resumed.maxOrd, resumed.after !== null],
      [first.sinceRev, first.maxOrd, true]);
    w.drop('carol');                                                        // the app quits
    w.reconnect('carol');
    check('the next reconnect resumed it and finished', [w.coverage.repairResumed, carol.repairPending('C')], [1, null]);
    check('and the result is complete', [carol.rendered('C').m7.deleted, carol.rendered('C').m5.reply_count], [true, 2]);
  });

  scenario('version rule  a second gap while a repair is pending widens it rather than replacing it', () => {
    const w = carolsWeek({ backfillLimit: 1 });
    const carol = w.clients.get('carol');
    w.online.set('carol', true); w.inbox.set('carol', []);
    carol.applyGap('C', w.server.catchup('C', 'carol', carol.frontier('C')));
    const first = carol.repairPending('C');
    carol.applyRepair('C', w.server.repair('C', 'carol', first.sinceRev, first.maxOrd, null, 1));  // one page, then gone
    w.drop('carol');
    w.server.del({ opId: 'd2', actorId: 'alice', messageId: 'm2' });        // a held message changes again
    for (let i = 0; i < 20; i++) w.sendPublic('alice');
    w.online.set('carol', true); w.inbox.set('carol', []);
    carol.applyGap('C', w.server.catchup('C', 'carol', carol.frontier('C')));
    const widened = carol.repairPending('C');
    check('since stays at the OLDER frontier, the bound grows to the newest held row, paging restarts',
      [widened.sinceRev, widened.maxOrd > first.maxOrd, widened.after], [first.sinceRev, true, null]);
    w.repairPending('carol');
    check('both gaps\' changes are repaired', [carol.rendered('C').m7.deleted, carol.rendered('C').m2.deleted], [true, true]);
  });

  scenario('version rule  reply counts are per reader: a restricted reply is not counted for the unlisted', () => {
    const w = world({ actors: ['alice', 'bob'], gapThreshold: 3, gapTail: 2, backfillLimit: 5 });
    w.sendPublic('alice');                                                  // m1
    drainAll(w);
    w.drop('alice'); w.drop('bob');
    w.server.send({ opId: 'c', chatId: 'C', messageId: 'card', authorId: 'alice', body: 'card reply', parentId: 'm1', listed: ['alice'] });
    w.server.send({ opId: 'p', chatId: 'C', messageId: 'p3', authorId: 'bob', body: 'p3 reply', parentId: 'm1' });
    for (let i = 0; i < 6; i++) w.sendPublic('alice');
    w.reconnect('alice'); w.reconnect('bob');
    check('alice, listed on the card, counts two replies', w.clients.get('alice').rendered('C').m1.reply_count, 2);
    check('bob counts one', w.clients.get('bob').rendered('C').m1.reply_count, 1);
    w.openThread('alice', 'm1'); w.openThread('bob', 'm1');
    check('opening the thread gives each exactly the replies they may see',
      [w.clients.get('alice').heldReplies('C', 'm1').map(r => r.id), w.clients.get('bob').heldReplies('C', 'm1').map(r => r.id)],
      [['card', 'p3'], ['p3']]);
    w.audit('threads'); check('the card never reached bob on any path', w.violations, []);
  });

  scenario('version rule  a deleted root keeps its replies; a held reply deleted meanwhile is marked', () => {
    const w = world({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 2, backfillLimit: 5 });
    w.sendPublic('alice');                                                  // m1
    for (const id of ['p2', 'p3']) {
      const { event } = w.server.send({ opId: `op_${id}`, chatId: 'C', messageId: id, authorId: 'alice', body: `${id} reply`, parentId: 'm1' });
      for (const [actor, frame] of w.server.deliver(event)) w.inbox.get(actor).push(frame);
    }
    drainAll(w);
    const carol = w.clients.get('carol');
    check('carol holds the root and both replies', [carol.heldReplies('C', 'm1').length, carol.rendered('C').m1.reply_count], [2, 2]);
    w.drop('carol');
    w.server.del({ opId: 'd1', actorId: 'alice', messageId: 'm1' });        // the root goes
    w.server.del({ opId: 'd2', actorId: 'alice', messageId: 'p2' });        // and one reply
    for (let i = 0; i < 6; i++) w.sendPublic('alice');
    w.reconnect('carol'); w.openThread('carol', 'm1');
    const shown = carol.rendered('C');
    check('the root is marked deleted and still carries its live reply count', [shown.m1.deleted, shown.m1.reply_count], [true, 1]);
    check('the deleted reply is marked, the other kept', [shown.p2.deleted, shown.p3.deleted], [true, false]);
  });

  scenario('version rule  a root created and deleted while away, whose replies survive, arrives as a tombstone', () => {
    const w = world({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 4, backfillLimit: 5 });
    w.sendPublic('alice');                                                  // m1, so carol holds something
    drainAll(w);
    w.drop('carol');
    w.sendPublic('alice');                                                  // m2: the root, created while carol is away
    w.server.send({ opId: 'p', chatId: 'C', messageId: 'p3', authorId: 'alice', body: 'p3 reply', parentId: 'm2' });
    w.server.del({ opId: 'd', actorId: 'alice', messageId: 'm2' });        // ...and deleted, its reply surviving
    for (let i = 0; i < 3; i++) w.sendPublic('alice');
    w.reconnect('carol');
    const carol = w.clients.get('carol');
    check('the gap tail brought the deleted root, so the thread can be reached',
      [carol.rendered('C').m2?.deleted, carol.rendered('C').m2?.reply_count], [true, 1]);
    w.openThread('carol', 'm2');
    check('opening it shows the surviving reply', carol.heldReplies('C', 'm2').map(r => r.id), ['p3']);
  });

  scenario('version rule  a reader who can see none of a chat\'s recent history still closes the gap', () => {
    const w = world({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 10, backfillLimit: 3 });
    for (let i = 0; i < 5; i++) w.sendRestricted('alice', ['alice']);
    w.drop('carol'); w.reconnect('carol'); w.backfillToTop('carol');
    check('an empty visible tail leaves no gap behind', [w.clients.get('carol').hasGap('C'), w.clients.get('carol').visibleIds('C')], [false, []]);
  });

  if (runFindings) {
  // ── findings: behaviour of today's gap path, executed, not pass/fail ───────
  // These run the gap path AS BUILT (gapRule 'production': the MIN floor, no
  // backfill below a floor of 1 or null, no repair, tombstones filtered out of
  // the tail and backfill) beside the corrected model, on the same traces.
  // They are recorded because this model is the first to exercise gaps under
  // random traffic, and it found them. None involve restricted messages.
  scenario('finding  a message deleted while a client is past the gap threshold', () => {
    for (const gapRule of ['production', 'corrected']) {
      const w = new World({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 2, backfillLimit: 3, gapRule });
      for (let i = 0; i < 5; i++) w.sendPublic('alice');
      drainAll(w);
      w.drop('carol');
      w.server.del({ opId: 'd', actorId: 'alice', messageId: 'm3' });
      for (let i = 0; i < 6; i++) w.sendPublic('alice');
      w.reconnect('carol'); w.backfillToTop('carol');
      const stale = w.clients.get('carol').visibleIds('C').includes('m3');
      log(`  ${stale ? 'NOTE' : 'note'} ${gapRule.padEnd(10)} carol ${stale ? 'still shows' : 'no longer shows'} m3, deleted during her gap`);
      if (stale) findings.push('deleted-during-gap');
    }
    log('       as built, the tail and backfill filter deleted rows and nothing repairs a held row;\n'
      + '       with the version rule the repair at reconnect delivers the tombstone.');
  });

  scenario('finding  a gap after the client has already scrolled to the top (production gap rule)', () => {
    const w = new World({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 2, backfillLimit: 3, gapRule: 'production' });
    for (let i = 0; i < 6; i++) w.sendPublic('alice');
    w.drop('carol'); w.reconnect('carol'); w.backfillToTop('carol');
    const carol = w.clients.get('carol');
    const before = { floor: carol.floor('C'), gap: carol.hasGap('C'), held: carol.visibleIds('C').length };
    w.drop('carol');
    for (let i = 0; i < 8; i++) w.sendPublic('alice');
    w.reconnect('carol'); w.backfillToTop('carol');
    const after = { floor: carol.floor('C'), gap: carol.hasGap('C'), held: carol.visibleIds('C').length };
    const lost = after.held < 14;
    log(`  ${lost ? 'NOTE' : 'note'} before the second gap ${JSON.stringify(before)}; after it ${JSON.stringify(after)} of 14 messages`);
    if (lost) {
      log('       applyGap keeps MIN(old floor, tail) = 1, and link.ts never backfills below a floor of 1,\n'
        + '       so the messages the second gap jumped over are never fetched and has_gap never clears.');
      findings.push('second-gap-keeps-old-floor');
    }
  });

  scenario('finding  a gap whose tail already reaches ordinal 1 (production gap rule)', () => {
    const w = new World({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 10, backfillLimit: 3, gapRule: 'production' });
    w.sendPublic('alice'); w.sendPublic('alice');
    for (let i = 0; i < 5; i++) w.server.edit({ opId: `e${i}`, actorId: 'alice', messageId: 'm1', body: `v${i}` });
    w.drop('carol'); w.reconnect('carol'); w.backfillToTop('carol');
    const stuck = w.clients.get('carol').hasGap('C');
    log(`  ${stuck ? 'NOTE' : 'note'} has_gap after taking the whole chat as the tail: ${stuck}`);
    if (stuck) {
      log('       the tail holds ordinal 1, so the floor is 1 and backfill is never asked; nothing closes has_gap.');
      findings.push('gap-tail-at-ord-1-never-clears');
    }
    const hidden = new World({ actors: ['alice', 'carol'], gapThreshold: 3, gapTail: 10, backfillLimit: 3, gapRule: 'production' });
    for (let i = 0; i < 5; i++) hidden.sendRestricted('alice', ['alice']);
    hidden.drop('carol'); hidden.reconnect('carol'); hidden.backfillToTop('carol');
    const stuckEmpty = hidden.clients.get('carol').hasGap('C');
    log(`  ${stuckEmpty ? 'NOTE' : 'note'} has_gap for a reader who can see none of the chat: ${stuckEmpty}`);
    if (stuckEmpty) {
      log('       VISIBILITY MAKES THIS REACHABLE: carol\'s visible tail is empty, so her floor is null and\n'
        + '       backfill is never asked. The corrected rule asks from head_ord + 1 and gets `complete`.');
      findings.push('empty-visible-tail-never-clears');
    }
  });

  scenario('finding  how often the production gap rule loses history under random traffic', () => {
    // A controlled comparison: the same seeds and parameters that pass with the
    // corrected rule, differing only in the rule — once with restricted messages
    // and once without, to show the loss does not depend on them.
    for (const restricted of [true, false]) {
      let worlds = 0; let affected = 0; const kinds = {};
      for (let seed = 1; seed <= Math.min(seeds, 100); seed++) {
        const w = new World({ seed, restricted, gapRule: 'production', gapThreshold: 4 + (seed % 9),
                              replayLimit: 1 + (seed % 4), gapTail: 1 + (seed % 3), backfillLimit: 1 + (seed % 3) });
        for (let i = 0; i < steps; i++) w.step();
        w.settle({ strictState: false });
        worlds++;
        if (w.violations.length) affected++;
        for (const violation of w.violations) {
          const kind = violation.replace(/\b[mr]\d+\b/g, '<id>').replace(/\d+/g, '<n>').replace(/^[a-z]+ /, '<actor> ');
          kinds[kind] = (kinds[kind] ?? 0) + 1;
        }
      }
      log(`  note ${restricted ? 'with' : 'WITHOUT'} restricted messages: ${affected} of ${worlds} random worlds lose history or keep a stuck gap`);
      for (const [kind, count] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 3)) log(`       ${count} × ${kind}`);
      if (affected) findings.push(`production-gap-rule-random${restricted ? '' : '-without-restricted'}`);
    }
  });
  }

  // ── the property test ──────────────────────────────────────────────────────
  scenario(`property  ${seeds} random worlds × ${steps} steps: sends, replies, reactions, edits, deletes, reordering, duplicates, drops, gaps, repair, churn`, () => {
    const coverage = {};
    const violations = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const w = new World({
        seed, mutant, repairDisorder: true,
        oldClients: seed % 3 === 0 ? ['dave'] : [],
        gapThreshold: 4 + (seed % 9),
        replayLimit: 1 + (seed % 4),
        gapTail: 1 + (seed % 3),
        backfillLimit: 1 + (seed % 3),
      });
      for (let i = 0; i < steps; i++) w.step();
      w.settle();
      for (const [key, value] of Object.entries(w.coverage)) coverage[key] = (coverage[key] ?? 0) + value;
      for (const violation of w.violations) violations.push(`seed ${seed}: ${violation}`);
    }
    check('no violation in any random world', violations.slice(0, 5), []);
    if (violations.length) log(`         ${violations.length} violations in total`);
    const unreached = Object.entries(coverage).filter(([, value]) => value === 0).map(([key]) => key);
    check('coverage: the random worlds reached every path at least once', unreached, []);
    log(`         coverage ${JSON.stringify(coverage)}`);
  });

  return { pass, fail, fails, findings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = performance.now();
  const result = runSuite();
  console.log(`\n${'─'.repeat(58)}\n${result.pass} passed, ${result.fail} failed in ${Math.round(performance.now() - started)} ms`);
  if (result.findings.length) console.log(`findings: ${result.findings.join(', ')}`);
  if (result.fail) { console.log('FAILED:', result.fails.join(', ')); process.exit(1); }
}
