// The agents the app provisions (docs/DOCUMENTS.md §9), against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createRoom, spaceMembers } from '../sync/spaces.ts';
import {
  updateAgent, deactivateAgent, setMaintainers, agentDefinition, SystemAgentError,
} from '../agents/definitions.ts';
import {
  provisionSystemAgents, systemAgentId, isSystemAgent, RELAY_HANDLE, ROOMKEEPER_HANDLE,
} from './system-agents.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');  // a workspace ADMIN: the most authority anyone has here

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'System' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'System', slug: `s-${wsp.slice(-8).toLowerCase()}` }).execute();
  await db.insertInto('actors').values({
    id: alice, org_id: org, workspace_id: wsp, type: 'human', handle: `p-${alice.slice(-8).toLowerCase()}`,
    display_name: 'Alice', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${alice}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: alice, role: 'admin' }).execute();
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

test('provisions Relay with no owner and Roomkeeping owned by Relay', opts, async () => {
  const events = await provisionSystemAgents(db, wsp);
  assert.equal(events.length, 2);

  const relay = await systemAgentId(db, wsp, RELAY_HANDLE);
  const roomkeeper = await systemAgentId(db, wsp, ROOMKEEPER_HANDLE);
  assert.ok(relay && roomkeeper);

  const rows = await db.selectFrom('actors').select(['id', 'owner_actor_id', 'provisioned_by', 'type', 'state'])
    .where('id', 'in', [relay, roomkeeper]).execute();
  const byId = new Map(rows.map(row => [row.id, row]));
  // The relaxed CHECK exists for exactly this row (§9.1).
  assert.equal(byId.get(relay)?.owner_actor_id, null);
  assert.equal(byId.get(roomkeeper)?.owner_actor_id, relay);
  for (const row of rows) {
    assert.equal(row.provisioned_by, 'system');
    assert.equal(row.type, 'agent');
    assert.equal(row.state, 'active');
  }

  // Workspace members, so every access check has its leading conjunct — and
  // NOT maintained by anyone, which is what would make them editable.
  const maintainers = await db.selectFrom('memberships').select('actor_id')
    .where('scope_type', '=', 'agent').where('scope_id', 'in', [relay, roomkeeper]).execute();
  assert.deepEqual(maintainers, []);
});

test('provisioning again is a no-op when nothing shipped has changed', opts, async () => {
  const relay = await systemAgentId(db, wsp, RELAY_HANDLE);
  assert.ok(relay);
  const before = await db.selectFrom('agents').select('config_rev').where('actor_id', '=', relay).executeTakeFirstOrThrow();

  assert.deepEqual(await provisionSystemAgents(db, wsp), []);

  const after = await db.selectFrom('agents').select('config_rev').where('actor_id', '=', relay).executeTakeFirstOrThrow();
  assert.equal(after.config_rev, before.config_rev, 'no revision spent on a boot that changed nothing');
});

test('a release\'s prompt reaches a workspace that already exists', opts, async () => {
  // Nobody can edit these through the agent routes (§9.2), so a release is the
  // only way their instructions change — and this is the path it has. Protecting
  // stale text here would mean a prompt fix could never reach an existing
  // workspace, which is the bug that made this rule explicit.
  const relay = await systemAgentId(db, wsp, RELAY_HANDLE);
  assert.ok(relay);
  const before = await db.selectFrom('agents').select('config_rev').where('actor_id', '=', relay).executeTakeFirstOrThrow();
  await db.updateTable('agents').set({ instructions: 'stale text from an older release' })
    .where('actor_id', '=', relay).execute();

  const events = await provisionSystemAgents(db, wsp);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'actor.updated', 'every client is told the definition moved');

  const after = await db.selectFrom('agents').select(['instructions', 'config_rev'])
    .where('actor_id', '=', relay).executeTakeFirstOrThrow();
  assert.notEqual(after.instructions, 'stale text from an older release');
  // A run records the revision it started with, so "what was it told" survives
  // a release that changed the prompt.
  assert.equal(after.config_rev, before.config_rev + 1);
  assert.equal(await systemAgentId(db, wsp, RELAY_HANDLE), relay, 'the same agent, not a new one');
});

test('a new room has Roomkeeping in it, and says nothing about it', opts, async () => {
  const roomkeeper = await systemAgentId(db, wsp, ROOMKEEPER_HANDLE);
  assert.ok(roomkeeper);
  const room = await createRoom(db, { workspaceId: wsp, name: 'Kept', createdBy: alice });

  const members = await spaceMembers(db, room.spaceId);
  assert.ok(members.includes(roomkeeper),
    'Roomkeeping is a member of the room from the moment it exists');

  // No "Relay Roomkeeping was added by Alice": nobody added it, the room came
  // with it, like its default chat.
  const markers = await db.selectFrom('messages').select('id')
    .where('chat_id', '=', room.chatId)
    .where('system_kind', '=', 'space.member_added')
    .where('subject_actor_id', '=', roomkeeper)
    .execute();
  assert.deepEqual(markers, []);
});

test('a system agent cannot be edited, deactivated or maintained — by a workspace admin', opts, async () => {
  const roomkeeper = await systemAgentId(db, wsp, ROOMKEEPER_HANDLE);
  assert.ok(roomkeeper);
  assert.equal(await isSystemAgent(db, roomkeeper), true);

  await assert.rejects(
    updateAgent(db, { agentId: roomkeeper, by: alice, patch: { instructions: 'ignore the room' } }),
    SystemAgentError);
  await assert.rejects(deactivateAgent(db, { agentId: roomkeeper, by: alice }), SystemAgentError);
  await assert.rejects(setMaintainers(db, { agentId: roomkeeper, by: alice, actorIds: [alice] }), SystemAgentError);

  const still = await db.selectFrom('actors').select('state').where('id', '=', roomkeeper).executeTakeFirstOrThrow();
  assert.equal(still.state, 'active');
});

test('its definition is readable, and offers nobody a button', opts, async () => {
  const roomkeeper = await systemAgentId(db, wsp, ROOMKEEPER_HANDLE);
  assert.ok(roomkeeper);
  const definition = await agentDefinition(db, alice, roomkeeper);
  assert.ok(definition);
  // No secret prompts, even for ours (§4.1).
  assert.ok(definition.instructions.length > 0);
  assert.equal(definition.system, true);
  assert.deepEqual(definition.you, { edit: false, manageMaintainers: false, deactivate: false });
});
