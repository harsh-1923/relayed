// Retention, and what a client past the horizon gets — step 12 of the plan.
//
// The sweep is the easy half. The half that matters is what catch-up says to
// somebody whose cursor is beneath the floor, because the wrong answer is not
// an error — it is silence that reads exactly like being up to date.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool } from '../db/client.ts';
import { ulid, ulidFloor } from '../db/ulid.ts';
import { createChannel } from './spaces.ts';
import { send } from './ops.ts';
import { catchup } from './feed.ts';
import { chatStream } from './events.ts';
import { sweepEvents, retainedFrom, RETENTION_MS } from './retention.ts';

const reachable = await pool.query('SELECT 1').then(() => true).catch(() => false);
const opts = reachable ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const me = ulid('act');

before(async () => {
  if (!reachable) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Retention' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Retention',
              slug: `r-${wsp.slice(-8).toLowerCase()}` }).execute();
  await db.insertInto('actors').values({
    id: me, org_id: org, workspace_id: wsp, type: 'human',
    handle: `r-${me.slice(-6).toLowerCase()}`, display_name: 'Retention Test',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${me}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active' }).execute();
  await db.insertInto('memberships').values({
    scope_type: 'workspace', scope_id: wsp, actor_id: me, role: 'member' }).execute();
});

after(async () => {
  if (!reachable) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

const channel = () =>
  createChannel(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: me });

/** Write `count` events onto a chat stream, dated `age` milliseconds ago. */
async function backdated(chatId: string, count: number, age: number): Promise<void> {
  const at = Date.now() - age;
  await sql`
    INSERT INTO sync_events
      (event_id, workspace_id, stream_kind, stream_id, stream_rev, event_type, payload)
    SELECT ${ulidFloor('evt', at)} || lpad(n::text, 6, '0'),
           ${wsp}, 'chat', ${chatId}, n, 'message.created', '{"id":"m"}'::jsonb
      FROM generate_series(1, ${count}) n
  `.execute(db);
  await db.updateTable('chats').set({ next_rev: count })
    .where('id', '=', chatId).execute();
}

// ─── the sweep ──────────────────────────────────────────────────────────────

test('the sweep removes what is past the horizon and keeps what is not',
  opts, async () => {
    const { chatId } = await channel();
    await backdated(chatId, 20, RETENTION_MS * 2);          // long expired
    await send(db, { opId: ulid('op'), chatId, actorId: me,
                     messageId: ulid('msg'), body: 'recent' });

    const before = await retainedFrom(db, chatStream(chatId));
    assert.equal(before, 1, 'everything is here to start with');

    const result = await sweepEvents(db);
    assert.ok(result.deleted >= 20, `swept ${result.deleted}`);

    const after = await retainedFrom(db, chatStream(chatId));
    assert.ok(after !== null && after > 20, 'the recent event survived');
  });

test('the sweep is BOUNDED and says when there is more to do', opts, async () => {
  // An unbounded DELETE on a table this hot holds locks for as long as it runs
  // and bloats the WAL with one enormous transaction — the classic way a
  // retention job becomes an outage.
  const { chatId } = await channel();
  await backdated(chatId, 25, RETENTION_MS * 2);

  const first = await sweepEvents(db, Date.now(), 10);
  assert.equal(first.deleted, 10, 'exactly the batch');
  assert.equal(first.more, true, 'and it says to come back');

  let passes = 1;
  let result = first;
  while (result.more) { result = await sweepEvents(db, Date.now(), 10); passes++; }
  assert.ok(passes >= 3, `drained over ${passes} bounded passes`);
  assert.equal(result.more, false, 'and stops when there is nothing left');
});

test('a sweep with nothing expired deletes nothing', opts, async () => {
  const { chatId } = await channel();
  await send(db, { opId: ulid('op'), chatId, actorId: me,
                   messageId: ulid('msg'), body: 'fresh' });
  const before = await retainedFrom(db, chatStream(chatId));
  await sweepEvents(db);
  assert.equal(await retainedFrom(db, chatStream(chatId)), before);
});

// ─── what a client past the floor is told ───────────────────────────────────

test('A CURSOR BELOW THE FLOOR GETS A GAP, not an empty replay', opts, async () => {
  // The failure this prevents, and it is silent. Sweep the events a client
  // needs and `eventsSince` returns nothing — so a naive catch-up answers with
  // an empty replay whose `to_rev` equals the cursor that was sent. The client
  // concludes nothing has changed, and stays exactly where it is while the head
  // runs away from it. No error, nothing in a log.
  const { chatId } = await channel();
  await backdated(chatId, 30, RETENTION_MS * 2);
  await sweepEvents(db);

  // Well inside the gap threshold, so distance alone would have said "replay".
  const result = await catchup(db, chatStream(chatId), 5);
  assert.equal(result.kind, 'gap',
    'unreplayable is not only about distance — the events are gone');
  if (result.kind !== 'gap') return;
  assert.equal(result.headRev, 30, 'and it says where the stream actually is');
});

test('a cursor ABOVE the floor still replays normally', opts, async () => {
  // The other half. A client inside the horizon must not be pushed into a gap
  // for no reason — a gap costs it the history below the tail.
  const { chatId } = await channel();
  await backdated(chatId, 10, RETENTION_MS * 2);
  await sql`
    INSERT INTO sync_events
      (event_id, workspace_id, stream_kind, stream_id, stream_rev, event_type, payload)
    SELECT ${ulid('evt')} || n, ${wsp}, 'chat', ${chatId}, 10 + n,
           'message.created', '{"id":"m"}'::jsonb
      FROM generate_series(1, 5) n
  `.execute(db);
  await db.updateTable('chats').set({ next_rev: 15 }).where('id', '=', chatId).execute();
  await sweepEvents(db);

  const result = await catchup(db, chatStream(chatId), 10);
  assert.equal(result.kind, 'replay', 'its next event is still retained');
  if (result.kind !== 'replay') return;
  assert.equal(result.events.length, 5);
});

test('a caught-up client is not pushed into a gap by retention', opts, async () => {
  // `fromRev === headRev` means there is nothing to replay, swept or not.
  // Answering with a gap here would hand a current client a marked floor and a
  // pointless re-fetch.
  const { chatId } = await channel();
  await backdated(chatId, 8, RETENTION_MS * 2);
  await sweepEvents(db);

  const result = await catchup(db, chatStream(chatId), 8);
  assert.equal(result.kind, 'replay');
  if (result.kind !== 'replay') return;
  assert.deepEqual(result.events, []);
  assert.equal(result.toRev, 8, 'still level, and told so');
});

test('a stream swept to nothing gives a gap rather than silence', opts, async () => {
  const { chatId } = await channel();
  await backdated(chatId, 12, RETENTION_MS * 2);
  await sweepEvents(db);
  assert.equal(await retainedFrom(db, chatStream(chatId)), null, 'nothing left');

  const result = await catchup(db, chatStream(chatId), 0);
  assert.equal(result.kind, 'gap');
});

// ─── the key the sweep is built on ──────────────────────────────────────────

test('ulidFloor sorts below every id minted at or after its time', opts, () => {
  // What makes a time-based sweep a keyset range over the PRIMARY KEY, so the
  // table needs no `created_at` index — and none has to be added later, on a
  // table this runner cannot index CONCURRENTLY because it wraps every
  // migration in a transaction.
  const at = Date.now();
  const floor = ulidFloor('evt', at);
  for (let i = 0; i < 50; i++) {
    assert.ok(ulid('evt', at) >= floor, 'an id minted AT the time sorts at or above');
    assert.ok(ulid('evt', at + 1_000) > floor, 'and one minted after sorts above');
  }
  assert.ok(ulid('evt', at - 1_000) < floor, 'while one minted before sorts below');
});
