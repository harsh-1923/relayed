// What an agent reads (docs/WORKSPACE-AGENTS.md §5.6), against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createChannel, joinSpace } from '../sync/spaces.ts';
import { send, writeMessage } from '../sync/ops.ts';
import { buildTranscript, SIZE_LIMIT_BYTES, type TriggerRef } from './transcript.ts';

// The two blocks, read back the way a reader of the prompt would see them:
// the fence opens, a preamble, a blank line, then the lines themselves.
const all = (text: string) => text.split('\n');
const at = (text: string, head: string) => all(text).findIndex(line => line.startsWith(head));

/** The context block's message lines, without its fence or its preamble. */
function contextLines(text: string): string[] {
  const open = at(text, '── The conversation so far');
  if (open === -1) return [];
  const lines = all(text);
  const blank = lines.indexOf('', open);
  const close = lines.findIndex((line, i) => i > open && /^─+$/.test(line));
  return lines.slice(blank + 1, close);
}

/** Everything the model reads last: the request block's own text. */
function requestText(text: string): string {
  const open = at(text, '── The request');
  if (open === -1) return '';
  const lines = all(text);
  return lines.slice(lines.indexOf('', open) + 1).join('\n');
}

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const invoker = ulid('act');
const agent = ulid('act');   // type='agent', but the transcript's own logic only reads `type`, not membership rules
const other = ulid('act');   // a third person, in the room, who a restricted message may exclude

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Transcript' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Transcript', slug: `t-${wsp.slice(-6).toLowerCase()}` }).execute();
  for (const [id, type] of [[invoker, 'human'], [agent, 'agent'], [other, 'human']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type,
      handle: `t-${id.slice(-6).toLowerCase()}`, display_name: type === 'agent' ? 'Triage' : 'Person',
      avatar_url: null, identity_kind: type === 'agent' ? 'system' : 'workos_user',
      identity_id: type === 'agent' ? null : `wu_${id}`,
      owner_actor_id: type === 'agent' ? invoker : null, provisioned_by: 'api', state: 'active',
    }).execute();
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

/** A channel with the invoker, the agent and the third person all members. */
async function room(): Promise<string> {
  const made = await createChannel(db, { workspaceId: wsp, name: `t-${ulid('x')}`, createdBy: invoker });
  await joinSpace(db, made.spaceId, agent);
  await joinSpace(db, made.spaceId, other);
  return made.chatId;
}

/** A plain top-level send, from `invoker` unless told otherwise. */
async function say(chatId: string, body: string, authorId = invoker, parentId: string | null = null) {
  const r = await send(db, { opId: ulid('op'), chatId, actorId: authorId, messageId: ulid('msg'), body, parentId });
  return { id: r.ack.messageId, ord: r.ack.ord as number };
}

const trigger = (chatId: string, row: { id: string; ord: number }, parentId: string | null = null): TriggerRef =>
  ({ id: row.id, chatId, parentId, ord: row.ord });

test('a top-level trigger reads the chat\'s recent messages, ending at itself', opts, async () => {
  const chatId = await room();
  await say(chatId, 'first');
  await say(chatId, 'second');
  const c = await say(chatId, `[Triage](actor:${agent}) can you help`);
  // Sent AFTER the trigger — must never appear, however soon the dispatcher runs.
  await say(chatId, 'third, after the mention');

  const text = await buildTranscript(db, trigger(chatId, c), agent, invoker);
  const lines = contextLines(text);
  assert.equal(lines.length, 2, 'the two earlier messages are context; the trigger is not one of them');
  assert.ok(lines[0]?.includes('first'));
  assert.ok(lines[1]?.includes('second'));
  assert.equal(requestText(text), 'can you help', 'the request stands alone, with its own mention stripped');
  assert.ok(text.endsWith('can you help'), 'and its words are the last thing in the prompt');
  assert.ok(!lines.every(l => l.includes(c.id)), 'sanity: labels are names, not ids');
  assert.ok(lines[0]?.includes(`, ${invoker}): first`),
    'every author carries the actor id an agent links them by');
});

test('a thread-reply trigger reads only its own thread, not the rest of the channel', opts, async () => {
  const chatId = await room();
  const root = await say(chatId, 'the thread root');
  await say(chatId, 'an unrelated top-level message');   // must not appear
  const reply1 = await say(chatId, 'a reply in the thread', invoker, root.id);
  const askTriage = await say(chatId, `[Triage](actor:${agent}) look at this`, invoker, root.id);

  const text = await buildTranscript(db, trigger(chatId, askTriage, root.id), agent, invoker);
  assert.ok(!text.includes('unrelated top-level message'));
  assert.ok(text.includes('the thread root'));
  assert.ok(text.includes(reply1.id) === false && text.includes('a reply in the thread'));
  assert.equal(requestText(text), 'look at this');
  assert.ok(text.endsWith('look at this'));
});

test('a message only one of the two may see is excluded from both', opts, async () => {
  const chatId = await room();
  await say(chatId, 'visible to everyone');
  await db.transaction().execute(trx => writeMessage(trx, {
    kind: 'actor',
    chatId, messageId: ulid('msg'), authorId: invoker, parentId: null,
    audience: { kind: 'listed', actors: [invoker, other] },   // the AGENT is not listed
    body: 'a private aside between invoker and other',
  }));
  const ask = await say(chatId, `[Triage](actor:${agent}) go`);

  const text = await buildTranscript(db, trigger(chatId, ask), agent, invoker);
  assert.ok(text.includes('visible to everyone'));
  assert.ok(!text.includes('private aside'), 'the agent cannot see it, so it is excluded even though the invoker can');
});

test('the byte budget drops the oldest lines first, but always keeps the trigger', opts, async () => {
  const chatId = await room();
  // Comfortably over the cap on their own, so at least the earliest is dropped.
  const long = 'x'.repeat(4000);
  for (let i = 0; i < 8; i++) await say(chatId, `${long}-${i}`);
  const ask = await say(chatId, `[Triage](actor:${agent}) status?`);

  const text = await buildTranscript(db, trigger(chatId, ask), agent, invoker);
  assert.ok(Buffer.byteLength(text, 'utf8') <= SIZE_LIMIT_BYTES + 600, 'stays near the cap, not unbounded');
  assert.ok(text.endsWith('status?'), 'the trigger survives regardless of the cap');
  // The whole body, not a bare '-0': a fixture handle is `t-` and random
  // characters, so a label can contain '-0' on its own.
  assert.ok(!text.includes(`${long}-0`), 'the earliest message was dropped to make room');
  assert.ok(text.includes(`${long}-7`), 'the most recent context survives');
});

test('the request is its own block, below the context and last in the prompt', opts, async () => {
  const chatId = await room();
  // The failure this shape exists to stop: a question to somebody else, left
  // open, sitting above a request that has nothing to do with it.
  await say(chatId, 'Bob, can you take the on-call swap this weekend?', other);
  const ask = await say(chatId, `[Triage](actor:${agent}) what is the ticket count`);

  const text = await buildTranscript(db, trigger(chatId, ask), agent, invoker);
  assert.ok(text.indexOf('── The conversation so far') < text.indexOf('── The request'),
    'context first, request after it');
  assert.ok(text.includes('on-call swap'), 'the other question is still readable as background');
  assert.ok(contextLines(text).every(line => !line.includes('what is the ticket count')),
    'and the request is not one of the background lines');
  assert.equal(requestText(text), 'what is the ticket count');
});

test('a bare mention says so, rather than leaving the request block empty', opts, async () => {
  const chatId = await room();
  await say(chatId, 'we should chase the flaky test');
  const ask = await say(chatId, `[Triage](actor:${agent})`);

  const text = await buildTranscript(db, trigger(chatId, ask), agent, invoker);
  assert.match(requestText(text), /mentioned you and wrote nothing else/,
    'the one case where the conversation above IS the request, named as such');
});

test('with nothing before it, the trigger is the whole prompt and no empty fence is drawn', opts, async () => {
  const chatId = await room();
  const ask = await say(chatId, `[Triage](actor:${agent}) go`);

  const text = await buildTranscript(db, trigger(chatId, ask), agent, invoker);
  assert.ok(!text.includes('── The conversation so far'), 'no context block when there is no context');
  assert.equal(requestText(text), 'go');
});
