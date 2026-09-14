// Every branch of the two constraints in 009_restricted_messages.sql, against a
// real engine — one test each, in the style of sync-schema.test.ts.
//
// The trap these exist for is specific: a CHECK rejects a row only when it
// evaluates to FALSE, and the natural spelling of "a list must not be empty" —
// `array_length(visible_to, 1) >= 1` — is NULL on `'{}'`, so it PERMITS exactly
// the row it looks like it forbids. A test that only inserts valid rows passes
// against that constraint and the correct one alike.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from './client.ts';
import { ulid } from './ulid.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const actor = ulid('act');
const space = ulid('spc');
const chat = ulid('cht');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Restricted schema' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Restricted schema', slug: `r-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  await db.insertInto('actors').values({
    id: actor, org_id: org, workspace_id: wsp, type: 'human',
    handle: `r-${actor.slice(-6).toLowerCase()}`, display_name: 'Restricted Schema',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${actor}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('spaces').values({
    id: space, org_id: org, workspace_id: wsp, kind: 'channel', name: 'general',
    slug: null, topic: null, visibility: 'public', membership_policy: 'open',
    created_by_actor_id: actor } as never).execute();
  await db.insertInto('chats').values({
    id: chat, workspace_id: wsp, space_id: space, kind: 'sole', name: null,
    created_by_actor_id: actor } as never).execute();
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

let ord = 0;
/** A message with `visible_to` set to exactly the SQL under test. */
const message = (visibleTo: ReturnType<typeof sql>) => {
  ord += 1;
  return db.insertInto('messages').values({
    id: ulid('msg'), chat_id: chat, parent_id: null, ord, rev: ord,
    author_id: actor, body: 'x', visible_to: visibleTo as never,
  } as never).execute();
};

let rev = 0;
/** A log row with `visible_to` set to exactly the SQL under test. */
const logRow = (visibleTo: ReturnType<typeof sql>) => {
  rev += 1;
  return db.insertInto('sync_events').values({
    event_id: ulid('evt'), workspace_id: wsp, stream_kind: 'chat', stream_id: chat,
    stream_rev: rev, event_type: 'message.created', payload: sql`'{}'::jsonb`,
    visible_to: visibleTo as never,
  } as never).execute();
};

const rejects = async (fn: () => Promise<unknown>, constraint: string) => {
  await assert.rejects(fn, (err: Error) => {
    assert.match(err.message, new RegExp(constraint),
      `expected ${constraint} to reject this row; got: ${err.message}`);
    return true;
  });
};

// ── messages.visible_to ─────────────────────────────────────────────────────

test('a message with NO list is for the whole chat, and inserts', opts, async () => {
  await message(sql`NULL`);
});

test('a message listing one actor inserts', opts, async () => {
  await message(sql`ARRAY[${actor}]::text[]`);
});

test('THE EMPTY-ARRAY TRAP: message_visible_to rejects an empty list', opts, async () => {
  // With `array_length(visible_to, 1) >= 1` this row PASSES. An empty list must
  // be neither everyone nor no one — it must be an error somebody sees.
  await rejects(() => message(sql`'{}'::text[]`), 'message_visible_to');
});

// ── sync_events.visible_to ──────────────────────────────────────────────────

test('a log row with NO list is for every reader of the stream, and inserts', opts, async () => {
  await logRow(sql`NULL`);
});

test('a log row listing one actor inserts', opts, async () => {
  await logRow(sql`ARRAY[${actor}]::text[]`);
});

test('THE EMPTY-ARRAY TRAP: sync_event_visible_to rejects an empty list', opts, async () => {
  await rejects(() => logRow(sql`'{}'::text[]`), 'sync_event_visible_to');
});

test('the trap is real on this engine, which is why the constraint does not use it',
  opts, async () => {
  // Asserted rather than remembered: if a future Postgres made this FALSE, the
  // comment in the migration would be wrong, and this is where it would show.
  const row = await sql<{ n: number | null }>`SELECT array_length('{}'::text[], 1) AS n`.execute(db);
  assert.equal(row.rows[0]?.n, null);
});
