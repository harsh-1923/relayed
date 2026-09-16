// The broker (docs/WORKSPACE-AGENTS.md §5.5) as step 7 changed it — a run's
// `find_tools` and `call_tool` — through Fastify's `inject`, against Postgres,
// with Composio stubbed so nothing here reaches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { env } from '../env.ts';
import { createChannel, createRoom, joinSpace } from '../sync/spaces.ts';
import type { AppendedEvent } from '../sync/events.ts';
import { send } from '../sync/ops.ts';
import { signGrant } from './grant.ts';
import { brokerRoutes, type BrokerComposio } from './broker.ts';
import type { SearchResult } from './composio.ts';

const up = await reachable();
const opts = up && env.agentGrantSecret ? {}
  : { skip: 'postgres not reachable, or AGENT_GRANT_SECRET unset — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');
const triage = ulid('act');
const review = ulid('act');

// Toolkits of this file's own, so nothing depends on what the dev catalogue holds.
const suffix = ulid('t').slice(-8).toLowerCase();
const HUB = `hub${suffix}`;
const OFF = `off${suffix}`;
const READ_TOOL = `HUB${suffix}_GET_AN_ISSUE`.toUpperCase();
const WRITE_TOOL = `HUB${suffix}_CREATE_A_REVIEW`.toUpperCase();
const DESTRUCTIVE_TOOL = `HUB${suffix}_DELETE_A_REPOSITORY`.toUpperCase();
const DEPRECATED_TOOL = `HUB${suffix}_OLD_THING`.toUpperCase();
const OFF_TOOL = `OFF${suffix}_ANYTHING`.toUpperCase();
const CATALOGUE_SCHEMA = { type: 'object', properties: { from: { type: 'string', const: 'catalogue' } } };

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Broker' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Broker', slug: `b-${wsp.slice(-6).toLowerCase()}` }).execute();
  for (const [id, type, name] of [[alice, 'human', 'Alice'], [triage, 'agent', 'Triage'], [review, 'agent', 'Review']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type,
      handle: `b-${id.slice(-6).toLowerCase()}`, display_name: name,
      avatar_url: null, identity_kind: type === 'agent' ? 'system' : 'workos_user',
      identity_id: type === 'agent' ? null : `wu_${id}`,
      owner_actor_id: type === 'agent' ? alice : null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
  for (const [slug, enabled] of [[HUB, true], [OFF, false]] as const) {
    await db.insertInto('toolkits').values({
      slug, name: slug === HUB ? 'Hub' : 'Off', description: '', logo_url: null, auth_scheme: 'OAUTH2',
      auth_config_id: `ac_${slug}`, auth_managed_by: 'composio', auth_guide_url: null, enabled, refreshed_at: sql`now()`,
    }).execute();
  }
  const tool = (toolkit: string, slug: string, effect: 'read' | 'write' | 'destructive', deprecated = false) => ({
    toolkit, slug, name: slug, description: `does ${slug}`, effect_derived: effect, effect_override: null,
    deprecated, input_schema: sql`${JSON.stringify(CATALOGUE_SCHEMA)}::jsonb`,
  });
  await db.insertInto('toolkit_tools').values([
    tool(HUB, READ_TOOL, 'read'), tool(HUB, WRITE_TOOL, 'write'), tool(HUB, DESTRUCTIVE_TOOL, 'destructive'),
    tool(HUB, DEPRECATED_TOOL, 'read', true), tool(OFF, OFF_TOOL, 'read'),
  ] as never).execute();
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await db.deleteFrom('toolkits').where('slug', 'in', [HUB, OFF]).execute();
  await pool.end();
});

interface Recorded { searches: string[]; executions: { tool: string; args: Record<string, unknown> }[]; delivered: AppendedEvent[] }

async function server(searchResult: SearchResult = { toolSlugs: [], schemas: {} }) {
  const recorded: Recorded = { searches: [], executions: [], delivered: [] };
  const composio: BrokerComposio = {
    session: async () => 'trs_test',
    search: async (_sessionId, useCase) => { recorded.searches.push(useCase); return searchResult; },
    execute: async (_sessionId, tool, args) => { recorded.executions.push({ tool, args }); return { ok: true, data: { number: 445 } }; },
  };
  const app = Fastify();
  await app.register(brokerRoutes({
    db, composio,
    deliver: async (event) => { recorded.delivered.push(event); return { audience: 0, delivered: 0, dropped: 0, withheld: 0 }; },
  }));
  return { app, recorded };
}

/** A running run of `agent`, invoked by Alice in a new channel — or a room — and its grant. */
async function run(agent: string, where: 'channel' | 'room' = 'channel') {
  const create = where === 'room' ? createRoom : createChannel;
  const made = await create(db, { workspaceId: wsp, name: `b-${ulid('x')}`, createdBy: alice });
  await joinSpace(db, made.spaceId, agent);
  const triggered = await send(db, {
    opId: ulid('op'), chatId: made.chatId, actorId: alice, messageId: ulid('msg'),
    body: `[Agent](actor:${agent}) look at issue 445`, parentId: null,
  });
  const runId = triggered.runIds[0];
  assert.ok(runId, 'the mention must have started a run');
  await db.updateTable('agent_runs').set({ state: 'running' }).where('id', '=', runId).execute();
  const grant = await signGrant({ invokerActorId: alice, agentActorId: agent, runId, chatId: made.chatId });
  return { runId, grant, chatId: made.chatId, spaceId: made.spaceId };
}

const call = (app: Awaited<ReturnType<typeof server>>['app'], r: { runId: string; grant: string }, tool: string, args: unknown) =>
  app.inject({
    method: 'POST', url: '/agent/tools', headers: { authorization: `Bearer ${r.grant}` },
    payload: { runId: r.runId, toolCallId: ulid('call'), tool, arguments: args },
  }).then(res => res.json<{ result: string; data?: { tools?: Record<string, unknown>[]; note?: string } }>());

const allow = (agent: string, effect: 'read' | 'write' | 'destructive') =>
  db.insertInto('agent_permissions').values({ invoker_actor_id: alice, agent_actor_id: agent, toolkit: HUB, effect })
    .onConflict(oc => oc.columns(['invoker_actor_id', 'agent_actor_id', 'toolkit']).doUpdateSet({ effect, revoked_at: null }))
    .execute();

async function connect(): Promise<void> {
  const existing = await db.selectFrom('connections').select('id').where('actor_id', '=', alice).where('toolkit', '=', HUB).executeTakeFirst();
  if (existing) return;
  await db.insertInto('connections').values({
    id: ulid('con'), workspace_id: wsp, actor_id: alice, toolkit: HUB, composio_account_id: 'ca_test',
    status: 'active', status_reason: null, label: null, connected_at: sql`now()`, last_used_at: null, disconnected_at: null,
  }).execute();
}

const cardsFor = (runId: string) => db.selectFrom('access_requests').select(['toolkit', 'effect'])
  .where('run_id', '=', runId).execute();

test('find_tools with no permission raises one card and never reaches Composio', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage);

  const answer = await call(app, r, 'find_tools', { toolkit: HUB, use_case: 'read issue 445' });
  assert.equal(answer.result, 'permission_required');
  assert.deepEqual(await cardsFor(r.runId), [{ toolkit: HUB, effect: 'write' }]);
  assert.deepEqual(recorded.searches, []);

  await call(app, r, 'find_tools', { toolkit: HUB, use_case: 'read issue 445 again' });
  assert.equal((await cardsFor(r.runId)).length, 1, 'a second search in the same run raises no second card');
  await app.close();
});

test('permission is per agent: allowing one agent does not let another search', opts, async () => {
  await connect();
  await allow(triage, 'write');
  const { app, recorded } = await server();
  const r = await run(review);

  const answer = await call(app, r, 'find_tools', { toolkit: HUB, use_case: 'review PR 4561' });
  assert.equal(answer.result, 'permission_required');
  assert.deepEqual(recorded.searches, []);
  await app.close();
});

test('find_tools allowed but not connected raises the card as connection_required', opts, async () => {
  const other = ulid('act');
  await db.insertInto('actors').values({
    id: other, org_id: org, workspace_id: wsp, type: 'agent', handle: `b-${other.slice(-6).toLowerCase()}`,
    display_name: 'Other', avatar_url: null, identity_kind: 'system', identity_id: null,
    owner_actor_id: alice, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: other, role: 'member' }).execute();
  await db.deleteFrom('connections').where('actor_id', '=', alice).where('toolkit', '=', HUB).execute();
  await allow(other, 'write');
  const { app } = await server();
  const r = await run(other);

  const answer = await call(app, r, 'find_tools', { toolkit: HUB, use_case: 'read issue 445' });
  assert.equal(answer.result, 'connection_required');
  assert.equal((await cardsFor(r.runId)).length, 1);
  await app.close();
});

test('find_tools returns only that toolkit\'s real tools, in our own shape', opts, async () => {
  await connect();
  await allow(triage, 'write');
  const { app, recorded } = await server({
    toolSlugs: [READ_TOOL, OFF_TOOL, 'HUB_NOT_IN_OUR_CATALOGUE', DEPRECATED_TOOL, WRITE_TOOL],
    schemas: { [READ_TOOL]: { type: 'object', properties: { from: { type: 'string', const: 'composio' } } } },
  });
  const r = await run(triage);

  const answer = await call(app, r, 'find_tools', { toolkit: HUB, use_case: 'read issue 445' });
  assert.equal(answer.result, 'ok');
  assert.deepEqual(answer.data?.tools?.map(t => t['name']), [READ_TOOL, WRITE_TOOL],
    'a tool of another toolkit, one we do not list, and a deprecated one are all left out');
  assert.deepEqual(Object.keys(answer.data?.tools?.[0] ?? {}).sort(), ['description', 'name', 'parameters']);
  assert.equal(JSON.stringify(answer.data?.tools?.[0]?.['parameters']).includes('composio'), true, 'Composio\'s schema when it sent one');
  assert.equal(JSON.stringify(answer.data?.tools?.[1]?.['parameters']).includes('catalogue'), true, 'ours when it did not');
  assert.deepEqual(recorded.searches, ['Hub: read issue 445']);
  await app.close();
});

test('find_tools refuses a toolkit that is not enabled, without searching', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage);
  assert.equal((await call(app, r, 'find_tools', { toolkit: OFF, use_case: 'anything' })).result, 'tool_not_allowed');
  assert.equal((await call(app, r, 'find_tools', { toolkit: 'slack', use_case: 'post a message' })).result, 'tool_not_allowed');
  assert.deepEqual(recorded.searches, []);
  await app.close();
});

test('call_tool checks the name against the catalogue before Composio sees it', opts, async () => {
  await connect();
  await allow(triage, 'destructive');
  const { app, recorded } = await server();
  const r = await run(triage);

  assert.equal((await call(app, r, 'call_tool', { tool: 'HUB_MADE_UP', arguments: {} })).result, 'tool_not_allowed');
  assert.equal((await call(app, r, 'call_tool', { tool: OFF_TOOL, arguments: {} })).result, 'tool_not_allowed');
  assert.equal((await call(app, r, 'call_tool', { tool: DEPRECATED_TOOL, arguments: {} })).result, 'tool_deprecated');
  assert.equal((await call(app, r, 'some_other_tool', {})).result, 'tool_not_allowed');
  assert.deepEqual(recorded.executions, []);
  await app.close();
});

test('call_tool takes the effect from the catalogue: a destructive tool with write access raises a second card', opts, async () => {
  await connect();
  await allow(triage, 'write');
  const { app, recorded } = await server();
  const r = await run(triage);

  const answer = await call(app, r, 'call_tool', { tool: DESTRUCTIVE_TOOL, arguments: { repo: 'web' } });
  assert.equal(answer.result, 'permission_required');
  assert.deepEqual(await cardsFor(r.runId), [{ toolkit: HUB, effect: 'destructive' }]);
  assert.deepEqual(recorded.executions, []);
  await app.close();
});

test('call_tool runs a tool the model never searched for, and records it', opts, async () => {
  await connect();
  await allow(triage, 'write');
  const { app, recorded } = await server();
  const r = await run(triage);

  const answer = await call(app, r, 'call_tool', { tool: READ_TOOL, arguments: { issue_number: 445 } });
  assert.equal(answer.result, 'ok');
  assert.deepEqual(recorded.executions, [{ tool: READ_TOOL, args: { issue_number: 445 } }]);
  const audit = await db.selectFrom('agent_tool_calls').select(['toolkit', 'tool', 'effect', 'outcome'])
    .where('run_id', '=', r.runId).execute();
  assert.deepEqual(audit, [{ toolkit: HUB, tool: READ_TOOL, effect: 'read', outcome: 'ok' }]);
  await app.close();
});

test('open_panel in a room opens the page for the room and delivers it to everyone', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage, 'room');

  const answer = await call(app, r, 'open_panel', { url: 'https://linear.app/acme/issue/LIN-42', title: 'LIN-42' });
  assert.equal(answer.result, 'ok');
  const panels = await db.selectFrom('panels').select(['space_id', 'title', 'created_by_actor_id', 'on_behalf_of_actor_id'])
    .where('space_id', '=', r.spaceId).where('type', '=', 'web').execute();
  assert.deepEqual(panels, [{ space_id: r.spaceId, title: 'LIN-42', created_by_actor_id: triage, on_behalf_of_actor_id: alice }]);
  assert.deepEqual(recorded.delivered.map(event => event.type), ['panel.opened']);
  assert.deepEqual(recorded.executions, [], 'nothing of anyone\'s account is spent');
  await app.close();
});

test('open_panel refuses a page that is not public https, saying why, and writes nothing', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage, 'room');

  const local = await call(app, r, 'open_panel', { url: 'https://localhost:5173' }) as { result: string; message?: string };
  assert.equal(local.result, 'failed');
  assert.match(local.message ?? '', /local or private/);
  const insecure = await call(app, r, 'open_panel', { url: 'http://linear.app/acme' }) as { result: string; message?: string };
  assert.match(insecure.message ?? '', /https/);
  assert.equal((await db.selectFrom('panels').select('id')
    .where('space_id', '=', r.spaceId).where('type', '=', 'web').execute()).length, 0, 'no page opened');
  assert.deepEqual(recorded.delivered, []);
  await app.close();
});

test('open_panel outside a room is not allowed', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage, 'channel');
  assert.equal((await call(app, r, 'open_panel', { url: 'https://linear.app/acme' })).result, 'tool_not_allowed');
  assert.deepEqual(recorded.delivered, []);
  await app.close();
});

// ── create_room ─────────────────────────────────────────────────────────────

type RoomAnswer = { result: string; message?: string; data?: { space_id: string; chat_id: string; link: string; visibility: string } };

test('create_room makes a private room: the agent creates it, the person it was for joins as admin', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage);

  const answer = await call(app, r, 'create_room', { name: '  HAR-21 agents act like humans  ' }) as RoomAnswer;
  assert.equal(answer.result, 'ok');
  const spaceId = answer.data!.space_id;
  assert.equal(answer.data!.link, `[HAR-21 agents act like humans](space:${spaceId})`);

  const space = await db.selectFrom('spaces')
    .select(['kind', 'name', 'visibility', 'workspace_id', 'created_by_actor_id', 'on_behalf_of_actor_id'])
    .where('id', '=', spaceId).executeTakeFirstOrThrow();
  assert.deepEqual(space, {
    kind: 'room', name: 'HAR-21 agents act like humans', visibility: 'private', workspace_id: wsp,
    created_by_actor_id: triage, on_behalf_of_actor_id: alice,
  });
  const members = await db.selectFrom('memberships').select(['actor_id', 'role'])
    .where('scope_type', '=', 'space').where('scope_id', '=', spaceId).orderBy('actor_id').execute();
  assert.deepEqual(members, [{ actor_id: triage, role: 'admin' }, { actor_id: alice, role: 'admin' }]
    .sort((a, b) => a.actor_id.localeCompare(b.actor_id)));

  // The person arrives on the ordinary add path: their own member_added, and the marker in the chat.
  assert.deepEqual(recorded.delivered.map(event => event.type),
    ['space.created', 'chat.created', 'space.member_added', 'space.member_added', 'message.created']);
  const created = recorded.delivered[0]!.payload as { created_by_actor_id: string; on_behalf_of_actor_id: string };
  assert.deepEqual([created.created_by_actor_id, created.on_behalf_of_actor_id], [triage, alice]);
  const added = recorded.delivered[3]!.payload as { actor_id: string; by_actor_id: string; hydration: { space: { on_behalf_of_actor_id: string } } };
  assert.deepEqual([added.actor_id, added.by_actor_id, added.hydration.space.on_behalf_of_actor_id], [alice, triage, alice]);
  assert.deepEqual(recorded.executions, [], 'nothing of anyone\'s account is spent');
  await app.close();
});

test('create_room makes a public room only when asked for one', opts, async () => {
  const { app } = await server();
  const r = await run(triage);
  const answer = await call(app, r, 'create_room', { name: 'Open room', visibility: 'public' }) as RoomAnswer;
  assert.equal(answer.data?.visibility, 'public');
  const oddly = await call(app, r, 'create_room', { name: 'Odd room', visibility: 'everyone' }) as RoomAnswer;
  assert.equal(oddly.data?.visibility, 'private', 'anything but "public" is private');
  await app.close();
});

test('create_room takes nothing but name and visibility from the model', opts, async () => {
  const { app } = await server();
  const r = await run(triage);
  const answer = await call(app, r, 'create_room', {
    name: 'Forged', workspace_id: 'wsp_other', created_by: review, on_behalf_of: review, invoker_actor_id: review,
  }) as RoomAnswer;
  assert.equal(answer.result, 'ok');
  const space = await db.selectFrom('spaces').select(['workspace_id', 'created_by_actor_id', 'on_behalf_of_actor_id'])
    .where('id', '=', answer.data!.space_id).executeTakeFirstOrThrow();
  assert.deepEqual(space, { workspace_id: wsp, created_by_actor_id: triage, on_behalf_of_actor_id: alice });
  await app.close();
});

test('create_room spends the person\'s permission: when they may not create a space, nothing is written', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage);
  const before = await db.selectFrom('spaces').select('id').where('workspace_id', '=', wsp).execute();

  await db.updateTable('memberships').set({ left_at: sql`now()` })
    .where('scope_type', '=', 'workspace').where('scope_id', '=', wsp).where('actor_id', '=', alice).execute();
  try {
    const answer = await call(app, r, 'create_room', { name: 'Not allowed' }) as RoomAnswer;
    assert.equal(answer.result, 'failed');
    assert.match(answer.message ?? '', /not allowed to create rooms/);
  } finally {
    await db.updateTable('memberships').set({ left_at: null })
      .where('scope_type', '=', 'workspace').where('scope_id', '=', wsp).where('actor_id', '=', alice).execute();
  }
  assert.equal((await db.selectFrom('spaces').select('id').where('workspace_id', '=', wsp).execute()).length, before.length);
  assert.deepEqual(recorded.delivered, []);
  await app.close();
});

test('create_room refuses a bad name, an inactive agent, and a run that is not running', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage);

  const unnamed = await call(app, r, 'create_room', { name: '   ' }) as RoomAnswer;
  assert.equal(unnamed.result, 'failed');
  assert.equal((await call(app, r, 'create_room', { name: 'x'.repeat(101) })).result, 'failed');

  await db.updateTable('actors').set({ state: 'deactivated' }).where('id', '=', triage).execute();
  try {
    assert.equal((await call(app, r, 'create_room', { name: 'Agent gone' })).result, 'agent_inactive');
  } finally {
    await db.updateTable('actors').set({ state: 'active' }).where('id', '=', triage).execute();
  }

  await db.updateTable('agent_runs').set({ state: 'completed' }).where('id', '=', r.runId).execute();
  assert.equal((await call(app, r, 'create_room', { name: 'Too late' })).result, 'run_not_running');
  assert.deepEqual(recorded.delivered, []);
  await app.close();
});

test('a room a person creates themselves is unchanged: no on_behalf_of, one admin', opts, async () => {
  const made = await createRoom(db, { workspaceId: wsp, name: `p-${ulid('x')}`, createdBy: alice });
  const space = await db.selectFrom('spaces').select(['created_by_actor_id', 'on_behalf_of_actor_id'])
    .where('id', '=', made.spaceId).executeTakeFirstOrThrow();
  assert.deepEqual(space, { created_by_actor_id: alice, on_behalf_of_actor_id: null });
  const members = await db.selectFrom('memberships').select(['actor_id', 'role'])
    .where('scope_type', '=', 'space').where('scope_id', '=', made.spaceId).execute();
  assert.deepEqual(members, [{ actor_id: alice, role: 'admin' }]);
  assert.deepEqual(made.events.map(event => event.type), ['space.created', 'chat.created', 'space.member_added']);
});

// ── send_dm, post_message, add_to_room ─────────────────────────────────────

/** A person in the workspace who is not in any of the test's spaces. */
async function person(name: string): Promise<string> {
  const id = ulid('act');
  await db.insertInto('actors').values({
    id, org_id: org, workspace_id: wsp, type: 'human', handle: `b-${id.slice(-6).toLowerCase()}`, display_name: name,
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`, owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  return id;
}

type Answer = { result: string; message?: string; data?: Record<string, unknown> };
const callAs = (app: Awaited<ReturnType<typeof server>>['app'], r: { runId: string; grant: string }, tool: string, args: unknown, toolCallId = ulid('call')) =>
  app.inject({
    method: 'POST', url: '/agent/tools', headers: { authorization: `Bearer ${r.grant}` },
    payload: { runId: r.runId, toolCallId, tool, arguments: args },
  }).then(res => res.json<Answer>());

const messagesIn = (spaceId: string) => db.selectFrom('messages')
  .innerJoin('chats', 'chats.id', 'messages.chat_id')
  .select(['messages.author_id', 'messages.body', 'messages.on_behalf_of_actor_id', 'messages.delegation_id', 'messages.message_kind'])
  .where('chats.space_id', '=', spaceId).orderBy('messages.ord').execute();

test('send_dm to one person: a DM between the agent and them, written as the agent for the person who asked', opts, async () => {
  const { app } = await server();
  const bob = await person('Bob');
  const r = await run(triage);

  const answer = await callAs(app, r, 'send_dm', { people: [bob], text: `Reminder about HAR-2314, [Bob](actor:${bob}).` });
  assert.equal(answer.result, 'ok');
  const spaceId = answer.data!['space_id'] as string;
  assert.equal(answer.data!['kind'], 'dm');
  assert.equal(answer.data!['link'], `[Direct message](space:${spaceId})`);
  const space = await db.selectFrom('spaces').select(['kind', 'dm_key']).where('id', '=', spaceId).executeTakeFirstOrThrow();
  assert.deepEqual(space, { kind: 'dm', dm_key: [triage, bob].sort().join(',') });
  assert.deepEqual(await messagesIn(spaceId), [{
    author_id: triage, body: `Reminder about HAR-2314, [Bob](actor:${bob}).`, on_behalf_of_actor_id: alice, delegation_id: r.runId, message_kind: 'actor',
  }]);

  const again = await callAs(app, r, 'send_dm', { people: [bob], text: 'And another.' });
  assert.deepEqual([again.data!['space_id'], again.data!['new_conversation']], [spaceId, false], 'the conversation already there');
  await app.close();
});

test('send_dm to several people is one group message with the agent and all of them', opts, async () => {
  const { app } = await server();
  const [carol, dave] = [await person('Carol'), await person('Dave')];
  const r = await run(triage);
  const answer = await callAs(app, r, 'send_dm', { people: [carol, dave, triage], text: 'Standup moved to 11.' });
  assert.equal(answer.data!['kind'], 'group_dm');
  const space = await db.selectFrom('spaces').select('dm_key').where('id', '=', answer.data!['space_id'] as string).executeTakeFirstOrThrow();
  assert.equal(space.dm_key, [triage, carol, dave].sort().join(','), 'the agent once, however the model listed it');
  await app.close();
});

test('send_dm refuses no people, no text, and someone outside the workspace — sending nothing', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage);
  assert.equal((await callAs(app, r, 'send_dm', { people: [], text: 'hi' })).result, 'failed');
  assert.equal((await callAs(app, r, 'send_dm', { people: [alice], text: '   ' })).result, 'failed');
  const stranger = await callAs(app, r, 'send_dm', { people: ['act_nobody'], text: 'hi' });
  assert.equal(stranger.result, 'failed');
  assert.match(stranger.message ?? '', /not an active member/);
  assert.deepEqual(recorded.delivered, []);
  await app.close();
});

test('post_message posts where the agent is a member, and says it is not where it is not', opts, async () => {
  const { app, recorded } = await server();
  const r = await run(triage);
  const posted = await callAs(app, r, 'post_message', { space_id: r.spaceId, text: 'Summary: all green.' });
  assert.equal(posted.result, 'ok');
  assert.equal((await messagesIn(r.spaceId)).at(-1)?.body, 'Summary: all green.');

  const elsewhere = await createChannel(db, { workspaceId: wsp, name: `x-${ulid('x')}`, createdBy: alice });
  recorded.delivered.length = 0;
  const refused = await callAs(app, r, 'post_message', { space_id: elsewhere.spaceId, text: 'Hello?' });
  assert.equal(refused.result, 'not_a_member');
  assert.match(refused.message ?? '', /not a member/);
  assert.equal((await messagesIn(elsewhere.spaceId)).filter(row => row.message_kind === 'actor').length, 0);
  assert.deepEqual(recorded.delivered, []);
  assert.equal((await callAs(app, r, 'post_message', { space_id: 'spc_nowhere', text: 'hi' })).result, 'failed');
  await app.close();
});

test('the same tool call sent twice posts one message', opts, async () => {
  const { app } = await server();
  const r = await run(triage);
  const id = ulid('call');
  const first = await callAs(app, r, 'post_message', { space_id: r.spaceId, text: 'Only once.' }, id);
  const second = await callAs(app, r, 'post_message', { space_id: r.spaceId, text: 'Only once.' }, id);
  assert.equal(first.data!['message_id'], second.data!['message_id']);
  assert.equal((await messagesIn(r.spaceId)).filter(row => row.body === 'Only once.').length, 1);
  await app.close();
});

test('add_to_room adds people with the marker, and refuses a room the agent is not in and a DM', opts, async () => {
  const { app } = await server();
  const [erin, frank] = [await person('Erin'), await person('Frank')];
  const r = await run(triage, 'room');

  const answer = await callAs(app, r, 'add_to_room', { space_id: r.spaceId, people: [erin, frank, alice, 'act_nobody'] });
  assert.equal(answer.result, 'ok');
  assert.deepEqual(answer.data, { space_id: r.spaceId, added: [erin, frank], already_members: [alice], not_in_workspace: ['act_nobody'] });
  const markers = (await messagesIn(r.spaceId)).filter(row => row.message_kind === 'system');
  assert.equal(markers.length >= 2, true);

  const theirs = await createRoom(db, { workspaceId: wsp, name: `t-${ulid('x')}`, createdBy: alice });
  assert.equal((await callAs(app, r, 'add_to_room', { space_id: theirs.spaceId, people: [erin] })).result, 'not_a_member');

  const dm = await callAs(app, r, 'send_dm', { people: [erin], text: 'hi' });
  const sealed = await callAs(app, r, 'add_to_room', { space_id: dm.data!['space_id'], people: [frank] });
  assert.equal(sealed.result, 'failed');
  assert.match(sealed.message ?? '', /Nobody can be added/);
  await app.close();
});

test('a message the agent sends that mentions another agent starts it for the same person, and stops at depth three', opts, async () => {
  const { app } = await server();
  const r = await run(triage);
  await joinSpace(db, r.spaceId, review).catch(() => { /* already in */ });

  const posted = await callAs(app, r, 'post_message', { space_id: r.spaceId, text: `[Review](actor:${review}) please check this` });
  const chained = await db.selectFrom('agent_runs').select(['agent_actor_id', 'invoker_actor_id', 'chain_depth'])
    .where('trigger_message_id', '=', posted.data!['message_id'] as string).execute();
  assert.deepEqual(chained, [{ agent_actor_id: review, invoker_actor_id: alice, chain_depth: 2 }]);

  await db.updateTable('agent_runs').set({ chain_depth: 3 }).where('id', '=', r.runId).execute();
  const deep = await callAs(app, r, 'post_message', { space_id: r.spaceId, text: `[Review](actor:${review}) again` });
  assert.equal((await db.selectFrom('agent_runs').select('id').where('trigger_message_id', '=', deep.data!['message_id'] as string).execute()).length, 0);
  await app.close();
});

test('an agent\'s message where the person who asked is not a member starts nobody', opts, async () => {
  const { app } = await server();
  const bob = await person('Bob');
  const r = await run(triage);
  const bobs = await createChannel(db, { workspaceId: wsp, name: `bob-${ulid('x')}`, createdBy: bob });
  await joinSpace(db, bobs.spaceId, triage);
  await joinSpace(db, bobs.spaceId, review);

  const posted = await callAs(app, r, 'post_message', { space_id: bobs.spaceId, text: `[Review](actor:${review}) have a look` });
  assert.equal(posted.result, 'ok', 'the agent may post there — it is a member');
  assert.equal((await db.selectFrom('agent_runs').select('id').where('trigger_message_id', '=', posted.data!['message_id'] as string).execute()).length, 0,
    'but Alice cannot read it, so no run is started for her');
  await app.close();
});
