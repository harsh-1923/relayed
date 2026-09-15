// The contiguity frontier — step 8 of the sync build plan.
//
// The most expensive failure mode in the system lives here, and it is silent:
// a frontier that advances past an event whose effect never landed leaves a
// permanent hole with nothing to indicate it. The client believes it is caught
// up, no error is raised, and the missing message is noticed weeks later by a
// person, if at all.
//
// So the first test in this file is the bug, reproduced against the old design
// before the new one is trusted. A test that has never failed has proved
// nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import {
  applyEvent, applyBatch, frontierOf, headOf, behind,
  type Effect, type Envelope, type Stream,
} from './apply.ts';
import { replicaEffect } from './effects.ts';

const CHAT: Stream = { kind: 'chat', id: 'cht_eng' };

function replica(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, workspaceMigrations);
  return db;
}

/** A message event, in the shape the wire carries. */
const created = (rev: number, id: string, ord: number): Envelope => ({
  rev, type: 'message.created',
  payload: {
    id, ord, parent_id: null, author_id: 'act_1', body: `body ${id}`,
    created_at: '2026-09-10T16:04:11.238Z',
  },
});
const edited = (rev: number, id: string, body: string): Envelope => ({
  rev, type: 'message.edited', payload: { id, body },
});
const deleted = (rev: number, id: string): Envelope => ({
  rev, type: 'message.deleted', payload: { id },
});

/** Records what reached the domain, so a test can see what was actually run. */
function recorder(): { effect: Effect; seen: { rev: number; type: string }[] } {
  const seen: { rev: number; type: string }[] = [];
  const inner = replicaEffect();
  return {
    seen,
    effect: (db, stream, event) => {
      seen.push({ rev: event.rev, type: event.type });
      // `message.edited` has no handler yet — edits are Phase 4 — so it takes
      // the unknown path. That is deliberate here: this file is about the
      // FRONTIER, and an event with no local effect is the hardest case for it.
      if (event.type === 'message.edited') {
        db.prepare('UPDATE messages SET body = ? WHERE id = ?')
          .run((event.payload as { body: string }).body,
               (event.payload as { id: string }).id);
        return [];
      }
      return inner(db, stream, event);
    },
  };
}

const bodyOf = (db: DatabaseSync, id: string): string | undefined =>
  (db.prepare('SELECT body FROM messages WHERE id = ?').get(id) as
    { body: string } | undefined)?.body;

// ─── the bug, reproduced against the design it replaced ─────────────────────

test('THE LOST EDIT: a rev-only staging table drops an event permanently', () => {
  // The old shape, rebuilt here on purpose: `pending_revs(chat_id, rev)` — "I
  // saw rev N". Both of its rules are individually mandatory. Duplicate
  // suppression is required under at-least-once delivery; recording the rev is
  // what keeps the frontier moving past events with no local effect. TOGETHER
  // they lose data, and this is the trace (docs/SYNC-FLOWS.md §11.1).
  const db = replica();
  db.exec(`CREATE TABLE pending_revs (chat_id TEXT, rev INTEGER,
           PRIMARY KEY (chat_id, rev))`);

  let frontier = 5;
  const seen: number[] = [];
  const applyOldWay = (event: Envelope): void => {
    if (event.rev <= frontier) return;                       // duplicate: dropped
    if (event.rev > frontier + 1) {                          // a hole: rev only
      db.prepare('INSERT OR IGNORE INTO pending_revs VALUES (?, ?)')
        .run(CHAT.id, event.rev);
      return;
    }
    seen.push(event.rev);
    if (event.type === 'message.created') {
      const p = event.payload as { id: string; body: string };
      db.prepare(`INSERT INTO messages (id, chat_id, author_id, body, created_at, state)
                  VALUES (?, ?, 'act_1', ?, 0, 'acked')`).run(p.id, CHAT.id, p.body);
    }
    if (event.type === 'message.edited') {
      const p = event.payload as { id: string; body: string };
      db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(p.body, p.id);
    }
    frontier = event.rev;
    // Drain: the rev is present, so the frontier moves — but the EVENT is not,
    // so nothing is applied. This is the line the whole bug turns on.
    while ((db.prepare('SELECT 1 FROM pending_revs WHERE chat_id = ? AND rev = ?')
      .get(CHAT.id, frontier + 1))) frontier += 1;
  };

  // Message M was created at rev 7, which this client does not hold.
  applyOldWay(edited(9, 'msg_M', 'edited body'));   // live, above the frontier
  assert.equal(frontier, 5, 'the frontier correctly did not move');

  // Catch-up returns 6, 7, 8, 9 — including the edit, again.
  applyOldWay(created(6, 'msg_A', 1));
  applyOldWay(created(7, 'msg_M', 2));
  applyOldWay(created(8, 'msg_B', 3));
  assert.equal(frontier, 9, 'rev 9 was recorded, so the drain jumped to it');

  applyOldWay(edited(9, 'msg_M', 'edited body'));

  assert.equal(bodyOf(db, 'msg_M'), 'body msg_M',
    'THE EDIT IS GONE — dropped as a duplicate of a revision that was counted '
    + 'but never applied, with no error and nothing to indicate it');
  assert.equal(seen.includes(9), false, 'rev 9 never reached the domain at all');
  db.close();
});

test('...and the same trace, with the envelope retained, keeps the edit', () => {
  // Identical sequence against `staged_events`. The difference is one word:
  // a staged event is APPLIED when the frontier reaches it, rather than counted.
  const db = replica();
  const { effect, seen } = recorder();
  const deps = { db, effect };

  db.prepare(`INSERT INTO stream_state (stream_kind, stream_id, synced_through_rev)
              VALUES (?, ?, 5)`).run(CHAT.kind, CHAT.id);

  const live = applyEvent(deps, CHAT, edited(9, 'msg_M', 'edited body'));
  assert.equal(live.outcome, 'staged');
  assert.equal(frontierOf(db, CHAT), 5, 'the frontier still did not move');
  assert.equal(live.needsCatchup, true, 'and a hole was recorded');

  applyEvent(deps, CHAT, created(6, 'msg_A', 1));
  applyEvent(deps, CHAT, created(7, 'msg_M', 2));
  const result = applyEvent(deps, CHAT, created(8, 'msg_B', 3));

  assert.equal(frontierOf(db, CHAT), 9, 'the drain carried it to 9');
  assert.deepEqual(result.applied, [8, 9], 'and rev 9 was APPLIED, not counted');
  assert.equal(bodyOf(db, 'msg_M'), 'edited body', 'the edit survived');
  assert.ok(seen.some(e => e.rev === 9), 'it reached the domain');
  db.close();
});

// ─── the three cases ────────────────────────────────────────────────────────

test('an event at the frontier applies and advances it', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const result = applyEvent(deps, CHAT, created(1, 'msg_1', 1));

  assert.equal(result.outcome, 'applied');
  assert.equal(frontierOf(db, CHAT), 1);
  assert.deepEqual(result.topics, ['chat:cht_eng:messages', 'chat:cht_eng:state']);
  db.close();
});

test('a duplicate is dropped, with no write and no cursor movement', () => {
  // Expected under at-least-once delivery, and under the live/catch-up overlap
  // that has no synchronisation between the two paths by design.
  const db = replica();
  const { effect, seen } = recorder();
  const deps = { db, effect };
  applyEvent(deps, CHAT, created(1, 'msg_1', 1));

  const again = applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  assert.equal(again.outcome, 'duplicate');
  assert.equal(frontierOf(db, CHAT), 1);
  assert.deepEqual(again.topics, [], 'nothing to refresh — nothing changed');
  assert.equal(seen.filter(e => e.rev === 1).length, 1, 'the domain saw it once');
  db.close();
});

test('an event above the frontier is STAGED, and the frontier does not move', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 'msg_1', 1));

  const ahead = applyEvent(deps, CHAT, created(5, 'msg_5', 5));
  assert.equal(ahead.outcome, 'staged');
  assert.equal(frontierOf(db, CHAT), 1, 'a hole is not crossed');
  assert.equal(headOf(db, CHAT), 5, 'but we now know how far ahead the server is');
  assert.equal(ahead.needsCatchup, true);

  const rows = db.prepare('SELECT COUNT(*) n FROM staged_events').get() as { n: number };
  assert.equal(rows.n, 1, 'held whole, not counted');
  db.close();
});

test('filling the hole drains everything above it, in one advance', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  for (const rev of [5, 4, 3]) applyEvent(deps, CHAT, created(rev, `msg_${rev}`, rev));
  assert.equal(frontierOf(db, CHAT), 1, 'three holes, no movement');

  const filled = applyEvent(deps, CHAT, created(2, 'msg_2', 2));
  assert.equal(frontierOf(db, CHAT), 5);
  assert.deepEqual(filled.applied, [2, 3, 4, 5], 'one arrival advanced it by four');
  db.close();
});

// ─── events that touch no local row ─────────────────────────────────────────

test('an UNKNOWN event type advances the cursor and a later known event applies', () => {
  // Invariant 32, and the reason the frontier is tracked explicitly rather than
  // derived from MAX(rev) over message rows. A client that stalled here would
  // silently stop receiving that stream for ever — no error, nothing to see.
  const db = replica();
  const unknown: string[] = [];
  const deps = { db, effect: replicaEffect(t => unknown.push(t)) };

  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  const skipped = applyEvent(deps, CHAT, { rev: 2, type: 'reaction.added', payload: {} });

  assert.equal(skipped.outcome, 'applied', 'accounted for, not refused');
  assert.equal(frontierOf(db, CHAT), 2, 'the frontier moved past a feature we lack');
  assert.deepEqual(skipped.topics, [], 'and woke nothing, because nothing changed');
  assert.deepEqual(unknown, ['reaction.added'], 'counted, so it is visible');

  applyEvent(deps, CHAT, created(3, 'msg_3', 3));
  assert.equal(frontierOf(db, CHAT), 3, 'and a later known event still applies');
  db.close();
});

test('a WITHHELD event advances the cursor as a KNOWN type, and moves nothing', () => {
  // WORKSPACE-AGENTS.md §8.4. The revision of a message this reader may not
  // see: the frontier has to pass it — skipped, catch-up could never fill the
  // hole — and nothing else may change, because nothing about it arrived.
  const db = replica();
  const unknown: string[] = [];
  const deps = { db, effect: replicaEffect(t => unknown.push(t)) };

  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  const before = db.prepare('SELECT * FROM messages ORDER BY id').all();
  const hidden = applyEvent(deps, CHAT, { rev: 2, type: 'withheld', payload: {} });

  assert.equal(hidden.outcome, 'applied');
  assert.equal(frontierOf(db, CHAT), 2, 'the frontier passed it');
  assert.deepEqual(hidden.topics, [], 'and woke nothing');
  assert.deepEqual(unknown, [], 'known, so not counted as a feature this build lacks');
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), before,
    'no row, no count, no version moved');

  applyEvent(deps, CHAT, created(3, 'msg_3', 3));
  assert.equal(frontierOf(db, CHAT), 3, 'and the chat keeps updating');
  db.close();
});

test('PARTS ride message.created into the replica, and message.updated replaces or clears them', () => {
  // AGENT-RESPONSES.md §3 on the synced path: stored as sent, replaced whole.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const parts = [{ kind: 'markdown', text: 'Done.' },
                 { kind: 'ui', lang: 'openui-lang@0.5', library: 'relayed-ui@1', source: 'root = Card([])' }];
  applyEvent(deps, CHAT, { rev: 1, type: 'message.created', payload: {
    id: 'msg_reply', ord: 1, parent_id: null, author_id: 'act_agent', body: 'Done.',
    created_at: '2026-09-14T10:00:00.000Z', parts } });
  const stored = () => (db.prepare("SELECT parts FROM messages WHERE id = 'msg_reply'").get() as { parts: string | null }).parts;
  assert.deepEqual(JSON.parse(stored() ?? 'null'), parts);

  applyEvent(deps, CHAT, { rev: 2, type: 'message.updated',
    payload: { id: 'msg_reply', body: 'Resolved.', parts: [{ kind: 'markdown', text: 'Resolved.' }] } });
  assert.deepEqual(JSON.parse(stored() ?? 'null'), [{ kind: 'markdown', text: 'Resolved.' }]);

  applyEvent(deps, CHAT, { rev: 3, type: 'message.updated', payload: { id: 'msg_reply', body: 'Just text.' } });
  assert.equal(stored(), null, 'an update without parts is a message that is its body');
  db.close();
});

test('message.updated REPLACES the content, and never winds back a newer fetched row', () => {
  // WORKSPACE-AGENTS.md §7.4: an access card changing state for everyone in
  // the thread. The guard is the case that matters: repair can store a row at
  // a newer version while an older update is still on its way.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 'msg_card', 1));

  const updated = applyEvent(deps, CHAT, {
    rev: 2, type: 'message.updated', payload: { id: 'msg_card', body: 'Alice gave @triage access' },
  });
  assert.deepEqual(updated.topics, [`chat:${CHAT.id}:messages`]);
  const row = () => db.prepare("SELECT body, rev, edited_at FROM messages WHERE id = 'msg_card'").get();
  assert.deepEqual({ ...row() }, { body: 'Alice gave @triage access', rev: 2, edited_at: null },
    'replaced, versioned, and NOT marked edited');

  // A repair page landed the card at version 5 before update 3 arrived.
  db.prepare("UPDATE messages SET body = 'expired', rev = 5 WHERE id = 'msg_card'").run();
  const stale = applyEvent(deps, CHAT, {
    rev: 3, type: 'message.updated', payload: { id: 'msg_card', body: 'waiting again' },
  });
  assert.equal(frontierOf(db, CHAT), 3, 'the revision is still accounted for');
  assert.deepEqual(stale.topics, []);
  assert.deepEqual({ ...row() }, { body: 'expired', rev: 5, edited_at: null }, 'the newer row stands');
  db.close();
});

test('message.updated for a tombstone or a message never held writes nothing and still counts', () => {
  const db = replica();
  const unknown: string[] = [];
  const deps = { db, effect: replicaEffect(t => unknown.push(t)) };
  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  applyEvent(deps, CHAT, { rev: 2, type: 'message.deleted', payload: { id: 'msg_1', parent_id: null } });
  applyEvent(deps, CHAT, { rev: 3, type: 'message.updated', payload: { id: 'msg_1', body: 'back?' } });
  applyEvent(deps, CHAT, { rev: 4, type: 'message.updated', payload: { id: 'msg_never', body: 'x' } });

  assert.equal(frontierOf(db, CHAT), 4);
  assert.deepEqual(unknown, [], 'a known type');
  const row = db.prepare("SELECT body, deleted FROM messages WHERE id = 'msg_1'").get();
  assert.deepEqual({ ...row }, { body: '', deleted: 1 }, 'a tombstone is not updated back to life');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 1);
  db.close();
});

test('a restricted message this reader IS on keeps its list, for the label', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, {
    rev: 1, type: 'message.created',
    payload: { id: 'msg_notice', ord: 1, parent_id: null, author_id: 'act_triage',
               body: 'a private notice', created_at: '2026-09-14T10:00:00.000Z',
               visible_to: ['act_me'] },
  });
  applyEvent(deps, CHAT, created(2, 'msg_2', 2));
  const rows = db.prepare('SELECT id, visible_to FROM messages ORDER BY id').all();
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { id: 'msg_2', visible_to: null },
    { id: 'msg_notice', visible_to: '["act_me"]' },
  ]);
  db.close();
});

test('a delete for a message never held writes nothing and still counts', () => {
  // The sharpest case, and the reason `delete` was pulled into this phase. It
  // touches no row at all — so a client that inferred its cursor from message
  // rows would have no evidence the revision ever existed.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 'msg_1', 1));

  const gone = applyEvent(deps, CHAT, deleted(2, 'msg_never_backfilled'));
  assert.equal(gone.outcome, 'applied');
  assert.equal(frontierOf(db, CHAT), 2, 'the revision is accounted for');
  assert.deepEqual(gone.topics, [], 'and no surface is woken for a no-op');
  db.close();
});

test('a delete for a message we DO hold tombstones it and keeps the ordinal', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  applyEvent(deps, CHAT, deleted(2, 'msg_1'));

  const row = db.prepare('SELECT ord, deleted, body FROM messages WHERE id = ?')
    .get('msg_1') as { ord: number; deleted: number; body: string };
  assert.equal(row.deleted, 1);
  assert.equal(row.body, '', 'the body is cleared');
  assert.equal(row.ord, 1, 'and the ordinal is KEPT — never renumbered or reused');
  db.close();
});

// ─── the transaction ────────────────────────────────────────────────────────

test('a handler that throws advances nothing', () => {
  // The event and the cursor advance are one transaction. Advancing past an
  // event whose effect did not land is the silent permanent hole this whole
  // file exists to prevent.
  const db = replica();
  const exploding: Effect = () => { throw new Error('handler blew up'); };
  applyEvent({ db, effect: replicaEffect() }, CHAT, created(1, 'msg_1', 1));

  assert.throws(() => applyEvent({ db, effect: exploding }, CHAT, created(2, 'msg_2', 2)));
  assert.equal(frontierOf(db, CHAT), 1, 'the frontier stayed where it was');
  assert.equal(bodyOf(db, 'msg_2'), undefined, 'and nothing was written');
  db.close();
});

test('a drain that throws halfway rolls the WHOLE advance back', () => {
  // Twenty-one events applying or none. Half a drain would leave the frontier
  // claiming revisions whose effects were rolled back — the same hole, arrived
  // at by a different route.
  const db = replica();
  const inner = replicaEffect();
  const boom: Effect = (d, s, e) => {
    if (e.rev === 4) throw new Error('the fourth one');
    return inner(d, s, e);
  };
  const deps = { db, effect: boom };

  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  applyEvent(deps, CHAT, created(3, 'msg_3', 3));
  applyEvent(deps, CHAT, created(4, 'msg_4', 4));
  assert.equal(frontierOf(db, CHAT), 1);

  assert.throws(() => applyEvent(deps, CHAT, created(2, 'msg_2', 2)));
  assert.equal(frontierOf(db, CHAT), 1, 'not 3 — the partial advance rolled back');
  assert.equal(bodyOf(db, 'msg_2'), undefined);
  assert.equal(bodyOf(db, 'msg_3'), undefined);
  db.close();
});

// ─── staging stays bounded ──────────────────────────────────────────────────

test('staged_events is EMPTY whenever the client is caught up', () => {
  // It holds only what is above the frontier, so it collapses to nothing rather
  // than accumulating. A staging table that never drains is a slow leak whose
  // only symptom is disk, months later.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const staged = () =>
    (db.prepare('SELECT COUNT(*) n FROM staged_events').get() as { n: number }).n;

  for (const rev of [7, 3, 9, 5, 2, 8, 4, 6]) {
    applyEvent(deps, CHAT, created(rev, `msg_${rev}`, rev));
  }
  assert.ok(staged() > 0, 'holes accumulated while the first was missing');

  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  assert.equal(frontierOf(db, CHAT), 9);
  assert.equal(staged(), 0, 'and emptied the moment the run became contiguous');
  db.close();
});

test('a staged event arriving twice is stored once', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  applyEvent(deps, CHAT, created(4, 'msg_4', 4));
  applyEvent(deps, CHAT, created(4, 'msg_4', 4));

  const rows = db.prepare('SELECT COUNT(*) n FROM staged_events').get() as { n: number };
  assert.equal(rows.n, 1);
  db.close();
});

// ─── batches ────────────────────────────────────────────────────────────────

test('out-of-order events during catch-up leave the frontier correct', () => {
  // A batch is not a special case — it is a sequence of ordinary arrivals, and
  // it is sorted before applying so that a server free to return them in any
  // order cannot produce a different result.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const result = applyBatch(deps, CHAT, [
    created(3, 'msg_3', 3), created(1, 'msg_1', 1), created(2, 'msg_2', 2),
  ]);

  assert.equal(frontierOf(db, CHAT), 3);
  assert.deepEqual(result.applied, [1, 2, 3]);
  assert.equal(result.needsCatchup, false);
  db.close();
});

test('a batch with a hole in it advances to the hole and asks for more', () => {
  // A short batch — truncated by the read limit, or thinned by retention. The
  // stream still owes a catch-up, and forgetting that is how a client sits one
  // event behind for ever.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const result = applyBatch(deps, CHAT, [
    created(1, 'msg_1', 1), created(2, 'msg_2', 2), created(9, 'msg_9', 9),
  ]);

  assert.equal(frontierOf(db, CHAT), 2, 'stopped at the hole');
  assert.equal(result.needsCatchup, true, 'and said so');
  assert.equal(headOf(db, CHAT), 9);
  db.close();
});

test('a batch entirely below the frontier is all duplicates', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  applyBatch(deps, CHAT, [created(1, 'msg_1', 1), created(2, 'msg_2', 2)]);

  const again = applyBatch(deps, CHAT, [created(1, 'msg_1', 1), created(2, 'msg_2', 2)]);
  assert.equal(again.outcome, 'duplicate');
  assert.deepEqual(again.applied, []);
  assert.equal(frontierOf(db, CHAT), 2);
  db.close();
});

// ─── every stream, not just chats ───────────────────────────────────────────

test('a space stream has its own frontier, independent of any chat', () => {
  // Revisions are per stream. One home for every cursor is what lets the apply
  // loop stay uniform — it never has to ask which table holds this one.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const space: Stream = { kind: 'space', id: 'spc_eng' };

  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  const joined = applyEvent(deps, space, {
    rev: 1, type: 'space.member_added', payload: { actor_id: 'act_2', role: 'member' },
  });

  assert.equal(frontierOf(db, space), 1);
  assert.equal(frontierOf(db, CHAT), 1, 'and the chat is untouched');
  assert.deepEqual(joined.topics, ['space:spc_eng', 'spaces']);
  db.close();
});

test('the same revision on two streams does not collide', () => {
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const other: Stream = { kind: 'chat', id: 'cht_random' };

  applyEvent(deps, CHAT, created(1, 'msg_a', 1));
  applyEvent(deps, other, created(1, 'msg_b', 1));
  assert.equal(frontierOf(db, CHAT), 1);
  assert.equal(frontierOf(db, other), 1);
  db.close();
});

test('`behind` lists exactly the streams that owe a catch-up', () => {
  // What the scheduler works through. Derived from the two watermarks rather
  // than from a flag somebody has to remember to set.
  const db = replica();
  const deps = { db, effect: replicaEffect() };
  const space: Stream = { kind: 'space', id: 'spc_eng' };

  applyEvent(deps, CHAT, created(1, 'msg_1', 1));
  applyEvent(deps, CHAT, created(7, 'msg_7', 7));          // a hole
  applyEvent(deps, space, { rev: 1, type: 'space.created', payload: {} });

  assert.deepEqual(behind(db), [{ stream: CHAT, from: 1, to: 7 }],
    'the caught-up space is absent');
  db.close();
});

// ── space.member_added hydration (SPACE-MEMBERSHIP-MARKERS.md) ─────────────

/** A `space.member_added` envelope carrying the hydration block every add now sends. */
const memberAdded = (rev: number, actorId: string, role = 'member'): Envelope => ({
  rev, type: 'space.member_added',
  payload: {
    actor_id: actorId, role, by_actor_id: 'act_inviter',
    hydration: {
      space: {
        id: 'spc_new', kind: 'channel', name: 'general', slug: 'general',
        visibility: 'public', membership_policy: 'open', lifecycle: 'active', rev: 3,
      },
      chats: [{ id: 'cht_new', space_id: 'spc_new', kind: 'sole', name: null, head_ord: 5, head_rev: 5 }],
    },
  },
});

test('a member_added naming the active actor hydrates the space, its chat, and the membership', () => {
  const db = replica();
  const space: Stream = { kind: 'space', id: 'spc_new' };
  const deps = { db, effect: replicaEffect(undefined, () => 'act_me') };

  applyEvent(deps, space, memberAdded(1, 'act_me', 'admin'));

  const spaceRow = db.prepare('SELECT * FROM spaces WHERE id = ?').get('spc_new') as
    { id: string; kind: string; name: string; membership_policy: string } | undefined;
  assert.equal(spaceRow?.id, 'spc_new');
  assert.equal(spaceRow?.kind, 'channel');
  assert.equal(spaceRow?.name, 'general');

  const chatRow = db.prepare('SELECT * FROM chats WHERE id = ?').get('cht_new') as
    { space_id: string; kind: string } | undefined;
  assert.equal(chatRow?.space_id, 'spc_new');
  assert.equal(chatRow?.kind, 'sole');

  const chatState = db.prepare('SELECT head_ord FROM chat_state WHERE chat_id = ?').get('cht_new') as
    { head_ord: number } | undefined;
  assert.equal(chatState?.head_ord, 5);

  const chatCursor = db.prepare(
    "SELECT server_head_rev FROM stream_state WHERE stream_kind = 'chat' AND stream_id = ?",
  ).get('cht_new') as { server_head_rev: number } | undefined;
  assert.equal(chatCursor?.server_head_rev, 5);

  const membership = db.prepare(
    "SELECT role, left_at FROM memberships WHERE scope_type = 'space' AND scope_id = ? AND actor_id = ?",
  ).get('spc_new', 'act_me') as { role: string; left_at: number | null } | undefined;
  assert.equal(membership?.role, 'admin');
  assert.equal(membership?.left_at, null);
  db.close();
});

test('a member_added for someone else stays topology invalidation only — nothing is written', () => {
  const db = replica();
  const space: Stream = { kind: 'space', id: 'spc_new' };
  const deps = { db, effect: replicaEffect(undefined, () => 'act_me') };

  const result = applyEvent(deps, space, memberAdded(1, 'act_someone_else'));

  assert.deepEqual(result.topics, ['space:spc_new', 'spaces']);
  assert.equal(db.prepare('SELECT id FROM spaces WHERE id = ?').get('spc_new'), undefined,
    'existing members never store a space from this event — only the caller-only projection');
  assert.equal(
    db.prepare("SELECT 1 FROM memberships WHERE actor_id = 'act_someone_else'").get(), undefined);
  db.close();
});

test('a member_added with no active actor configured behaves exactly as before', () => {
  const db = replica();
  const space: Stream = { kind: 'space', id: 'spc_new' };
  // No `activeActorId` passed at all — the pre-existing call shape.
  const deps = { db, effect: replicaEffect() };

  const result = applyEvent(deps, space, memberAdded(1, 'act_me'));

  assert.deepEqual(result.topics, ['space:spc_new', 'spaces']);
  assert.equal(db.prepare('SELECT id FROM spaces WHERE id = ?').get('spc_new'), undefined);
  db.close();
});

for (const kind of ['channel', 'room'] as const) {
  test(`creation events hydrate a new ${kind} and its structural chat without reconnecting`, () => {
    const db = replica();
    try {
      const stream: Stream = { kind: 'space', id: 'spc_created' };
      const deps = { db, effect: replicaEffect(undefined, () => 'act_me') };
      const chatKind = kind === 'channel' ? 'sole' : 'default';
      applyEvent(deps, stream, { rev: 1, type: 'space.created', payload: { id: stream.id, kind } });
      applyEvent(deps, stream, { rev: 2, type: 'chat.created', payload: { id: 'cht_created', kind: chatKind } });
      const applied = applyEvent(deps, stream, {
        rev: 3, type: 'space.member_added', payload: {
          actor_id: 'act_me', role: 'admin', by_actor_id: 'act_me',
          hydration: {
            space: { id: stream.id, kind, name: 'Created', slug: null, visibility: 'private',
              membership_policy: 'invite', lifecycle: 'active', rev: 3 },
            chats: [{ id: 'cht_created', space_id: stream.id, kind: chatKind, name: null, head_ord: 0, head_rev: 0 }],
          },
        },
      });
      assert.ok(applied.topics.includes('spaces'));
      assert.equal(frontierOf(db, stream), 3);
      assert.equal(db.prepare('SELECT kind FROM spaces WHERE id = ?').get(stream.id)?.kind, kind);
      assert.equal(db.prepare('SELECT kind FROM chats WHERE id = ?').get('cht_created')?.kind, chatKind);
      assert.equal(db.prepare('SELECT head_ord FROM chat_state WHERE chat_id = ?').get('cht_created')?.head_ord, 0);
      assert.equal(db.prepare("SELECT role FROM memberships WHERE scope_id = ? AND actor_id = 'act_me'").get(stream.id)?.role, 'admin');
    } finally {
      db.close();
    }
  });
}
