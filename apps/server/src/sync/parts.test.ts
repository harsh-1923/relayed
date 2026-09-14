// Messages made of parts, on the synced path (docs/AGENT-RESPONSES.md, the
// message contract §3 and rules for rooms §7), against Postgres.
//
// What phase 3 asks: an agent's message with a `ui` part is stored with its
// parts and a body the server derived, and syncs as both; a person's message
// with one is refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { LANG, LIBRARY_VERSION } from '@relayed/genui';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createChannel, addToSpace } from './spaces.ts';
import {
  send, writeMessage, updateMessage, PartsRefusedError, type MessageContent,
} from './ops.ts';
import { backfill, catchup } from './feed.ts';
import { chatStream } from './events.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const person = ulid('act');
const agent = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Parts' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Parts', slug: `p-${wsp.slice(-8).toLowerCase()}` }).execute();
  await db.insertInto('actors').values([
    { id: person, org_id: org, workspace_id: wsp, type: 'human', handle: `p-${person.slice(-8).toLowerCase()}`,
      display_name: 'Person', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${person}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active' },
    { id: agent, org_id: org, workspace_id: wsp, type: 'agent', handle: `a-${agent.slice(-8).toLowerCase()}`,
      display_name: 'Agent', avatar_url: null, identity_kind: 'system', identity_id: null,
      owner_actor_id: person, provisioned_by: 'api', state: 'active' },
  ]).execute();
  for (const id of [person, agent]) {
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

async function room() {
  const made = await createChannel(db, { workspaceId: wsp, name: `p-${ulid('x')}`, createdBy: person });
  await addToSpace(db, made.spaceId, agent, person);
  return made;
}

const card = {
  kind: 'ui', lang: LANG, library: LIBRARY_VERSION,
  source: 'root = Card([header, stats])\nheader = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")\n'
        + 'stats = Stack([passed, failed], "row")\npassed = Stat("Passed", "17", "success")\n'
        + 'failed = Stat("Failed", "3", "danger")',
};
const reply = [{ kind: 'markdown', text: 'I ran the test 20 times.' }, card];
const derived = 'I ran the test 20 times.\n\ncatchup.test.ts is flaky: 3 of 20 runs failed\nPassed: 17 · Failed: 3';

const write = (chatId: string, authorId: string, content: MessageContent) =>
  db.transaction().execute(trx => writeMessage(trx, {
    chatId, messageId: ulid('msg'), authorId, parentId: null, audience: { kind: 'stream' }, ...content,
  }));

const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return 'written'; }
  catch (e) { if (e instanceof PartsRefusedError) return `${e.reason}:${e.detail}`; throw e; }
};

test('AN AGENT\'S MESSAGE with a ui part is stored with its parts and a body the SERVER derived', opts, async () => {
  const { chatId } = await room();
  const { ack, event } = await write(chatId, agent, { parts: reply });

  const row = await db.selectFrom('messages').select(['body', 'parts']).where('id', '=', ack.messageId).executeTakeFirstOrThrow();
  assert.equal(row.body, derived, 'the data, row by row — what search, previews and old clients read');
  assert.deepEqual(row.parts, reply);
  assert.deepEqual((event.payload as { parts: unknown; body: string }).parts, reply);
  assert.equal((event.payload as { body: string }).body, derived);
});

test('it syncs as both: catch-up carries the parts, and a fetched row does too', opts, async () => {
  const { chatId } = await room();
  const { ack } = await write(chatId, agent, { parts: reply });
  const replay = await catchup(db, person, chatStream(chatId), 0);
  assert.ok(replay.kind === 'replay');
  assert.deepEqual((replay.events.at(-1)?.payload as { parts: unknown }).parts, reply);
  const [row] = await backfill(db, person, chatId, 99, 1);
  assert.equal(row?.id, ack.messageId);
  assert.deepEqual(row?.parts, reply);
  assert.equal(row?.body, derived);
});

test('a message without parts still has NULL parts, and none on its event', opts, async () => {
  const { chatId } = await room();
  const { ack, event } = await write(chatId, person, { body: 'plain' });
  const [row] = await backfill(db, person, chatId, 99, 1);
  assert.equal(row?.id, ack.messageId);
  assert.equal(row?.parts, null);
  assert.equal('parts' in (event.payload as object), false);
});

test('A PERSON\'S MESSAGE with a ui or a tool part is refused, and nothing is written', opts, async () => {
  const { chatId } = await room();
  const before = await db.selectFrom('chats').select('next_ord').where('id', '=', chatId).executeTakeFirstOrThrow();
  assert.equal(await refusal(() => write(chatId, person, { parts: [card] })), 'forbidden_kind:ui');
  assert.equal(await refusal(() => write(chatId, person, { parts: [{
    kind: 'tool', tool_use_id: 't1', name: 'Bash', ok: true, ms: 1, input: {} }] })), 'forbidden_kind:tool');
  const after = await db.selectFrom('chats').select('next_ord').where('id', '=', chatId).executeTakeFirstOrThrow();
  assert.equal(after.next_ord, before.next_ord);
});

test('…but a person may send markdown parts, and gets a derived body', opts, async () => {
  const { chatId } = await room();
  assert.equal(await refusal(() => write(chatId, person, { parts: [{ kind: 'markdown', text: 'hi' }] })), 'written');
});

test('THROUGH A CLIENT OP too: the send path checks the SENDER, not a claim in the frame', opts, async () => {
  const { chatId } = await room();
  await assert.rejects(() => send(db, {
    opId: ulid('op'), chatId, actorId: person, messageId: ulid('msg'), body: 'a card', parts: [card],
  }), (err: Error) => err instanceof PartsRefusedError && err.detail === 'ui');
});

test('an invalid block, an unknown kind, a newer library and an empty list are each refused', opts, async () => {
  const { chatId } = await room();
  assert.equal(await refusal(() => write(chatId, agent, { parts: [{ ...card, source: 'root = Nope()' }] })),
    'invalid_ui:unknown-component');
  assert.equal(await refusal(() => write(chatId, agent, { parts: [{ kind: 'hologram' }] })), 'invalid:null');
  assert.equal(await refusal(() => write(chatId, agent, { parts: [{ ...card, library: 'relayed-ui@99' }] })),
    'invalid_ui:unknown-library', 'the server must be able to derive body from every block it stores');
  assert.equal(await refusal(() => write(chatId, agent, { parts: [] })), 'invalid:null');
});

test('stored parts keep only what the contract declares', opts, async () => {
  const { chatId } = await room();
  const { ack } = await write(chatId, agent, { parts: [{ kind: 'markdown', text: 'hi', secret: 'x' }] });
  const row = await db.selectFrom('messages').select('parts').where('id', '=', ack.messageId).executeTakeFirstOrThrow();
  assert.deepEqual(row.parts, [{ kind: 'markdown', text: 'hi' }]);
});

test('UPDATE replaces the parts whole and re-derives body — checked against the message\'s author', opts, async () => {
  const { chatId } = await room();
  const { ack } = await write(chatId, agent, { parts: reply });

  const event = await db.transaction().execute(trx => updateMessage(trx, {
    chatId, messageId: ack.messageId, parts: [{ kind: 'markdown', text: 'Resolved.' }] }));
  assert.deepEqual(event.payload, { id: ack.messageId, body: 'Resolved.', parts: [{ kind: 'markdown', text: 'Resolved.' }] });

  const cleared = await db.transaction().execute(trx => updateMessage(trx, { chatId, messageId: ack.messageId, body: 'Just text.' }));
  assert.equal('parts' in (cleared.payload as object), false);
  const row = await db.selectFrom('messages').select(['body', 'parts']).where('id', '=', ack.messageId).executeTakeFirstOrThrow();
  assert.deepEqual(row, { body: 'Just text.', parts: null });

  const { ack: mine } = await write(chatId, person, { body: 'mine' });
  assert.equal(await refusal(() => db.transaction().execute(trx =>
    updateMessage(trx, { chatId, messageId: mine.messageId, parts: [card] }))), 'forbidden_kind:ui',
    'a ui part cannot be put on a person\'s message by updating it either');
});

// ── the constraints (011_message_parts.sql), one each ──────────────────────

let rawOrd = 1000;
const rawParts = async (chatId: string, value: ReturnType<typeof sql>) => {
  const ord = ++rawOrd;
  await db.insertInto('messages').values({
    id: ulid('msg'), chat_id: chatId, parent_id: null, ord, rev: ord, author_id: agent, body: 'x',
    parts: value as never,
  } as never).execute();
};

test('message_parts_shape: NULL and a non-empty array insert; an object, a scalar and [] do not', opts, async () => {
  const { chatId } = await room();
  await rawParts(chatId, sql`NULL`);
  await rawParts(chatId, sql`'[{"kind":"markdown","text":"x"}]'::jsonb`);
  for (const bad of [sql`'{}'::jsonb`, sql`'"text"'::jsonb`, sql`'[]'::jsonb`]) {
    await assert.rejects(() => rawParts(chatId, bad), /message_parts_shape/);
  }
});

test('message_parts_size: a backstop at 512 KB of stored text', opts, async () => {
  const { chatId } = await room();
  const big = JSON.stringify([{ kind: 'markdown', text: 'x'.repeat(530_000) }]);
  await assert.rejects(() => rawParts(chatId, sql`${big}::jsonb`), /message_parts_size/);
});
