// Every constraint in 010_agents.sql, one test each, against a real engine —
// the per-constraint style of sync-schema.test.ts, for the reason it gives: a
// CHECK that permits exactly the row it forbids passes every happy-path test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from './client.ts';
import { ulid } from './ulid.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const person = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Agents schema' }).execute();
  await db.insertInto('workspaces')
    .values({ id: wsp, org_id: org, name: 'Agents schema', slug: `a-${wsp.slice(-6).toLowerCase()}` })
    .execute();
  await db.insertInto('actors').values({
    id: person, org_id: org, workspace_id: wsp, type: 'human',
    handle: `a-${person.slice(-6).toLowerCase()}`, display_name: 'Agents Schema',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${person}`,
    owner_actor_id: null, provisioned_by: 'api', state: 'active',
  }).execute();
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

/** An agent actor exactly as WORKSPACE-AGENTS.md §4.2 writes one. */
async function agentActor(): Promise<string> {
  const id = ulid('act');
  await db.insertInto('actors').values({
    id, org_id: org, workspace_id: wsp, type: 'agent',
    handle: `g-${id.slice(-8).toLowerCase()}`, display_name: 'Triage', avatar_url: null,
    identity_kind: 'system', identity_id: null, owner_actor_id: person,
    provisioned_by: 'api', state: 'active',
  }).execute();
  return id;
}

const agentRow = async (over: Record<string, unknown> = {}) => {
  const actorId = await agentActor();
  await db.insertInto('agents').values({
    actor_id: actorId, workspace_id: wsp, instructions: 'File bugs.', model: null,
    thinking_level: null, ...over,
  } as never).execute();
  return actorId;
};

const rejects = async (fn: () => Promise<unknown>, constraint: string) => {
  await assert.rejects(fn, (err: Error) => {
    assert.match(err.message, new RegExp(constraint),
      `expected ${constraint} to reject this row; got: ${err.message}`);
    return true;
  });
};

// ── the actor row (§4.2) — no new constraint, and none needed ───────────────

test('an agent actor inserts exactly as §4.2 writes it: system identity, no identity id, an owner',
  opts, async () => {
  await agentActor();
});

test('any number of agents fit: actor_identity is partial on identity_id IS NOT NULL', opts, async () => {
  await agentActor();
  await agentActor();
});

// ── agents ──────────────────────────────────────────────────────────────────

test('a valid agent definition inserts, with config_rev starting at 1', opts, async () => {
  const id = await agentRow();
  const row = await db.selectFrom('agents').select(['config_rev', 'description'])
    .where('actor_id', '=', id).executeTakeFirstOrThrow();
  assert.deepEqual(row, { config_rev: 1, description: '' });
});

test('agent_instructions_size admits exactly 32768 BYTES and refuses one more', opts, async () => {
  await agentRow({ instructions: 'x'.repeat(32_768) });
  await rejects(() => agentRow({ instructions: 'x'.repeat(32_769) }), 'agent_instructions_size');
});

test('agent_instructions_size counts bytes, not characters', opts, async () => {
  // 11,000 three-byte characters are 33,000 bytes: under a character cap,
  // over the byte cap the model and the frame actually pay.
  await rejects(() => agentRow({ instructions: '€'.repeat(11_000) }), 'agent_instructions_size');
});

test('agent_description_size refuses more than 200 characters', opts, async () => {
  await agentRow({ description: 'd'.repeat(200) });
  await rejects(() => agentRow({ description: 'd'.repeat(201) }), 'agent_description_size');
});

test('agent_config_rev refuses a revision below 1', opts, async () => {
  await rejects(() => agentRow({ config_rev: 0 }), 'agent_config_rev');
});

test('deleting the actor takes the definition with it', opts, async () => {
  const id = await agentRow();
  await db.deleteFrom('actors').where('id', '=', id).execute();
  assert.equal((await db.selectFrom('agents').select('actor_id').where('actor_id', '=', id).execute()).length, 0);
});

// ── tool discovery (016_tool_discovery.sql) ─────────────────────────────────

test('agent_tools is gone: nobody picks an agent\'s tools', opts, async () => {
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'agent_tools'`.execute(db);
  assert.equal(rows[0]?.n, 0);
});

test('a Composio session is one per person: a second for the same person is refused', opts, async () => {
  const owner = await agentActor();
  const row = (sessionId: string) => db.insertInto('composio_sessions').values({
    invoker_actor_id: owner, session_id: sessionId,
    toolkits: sql`ARRAY['github']::text[]`, connected_accounts: sql`'{}'::jsonb`,
  }).execute();
  await row('trs_first');
  await rejects(() => row('trs_second'), 'composio_sessions_pkey');
});

// ── memberships ─────────────────────────────────────────────────────────────

const membership = (over: Record<string, unknown>) =>
  db.insertInto('memberships').values({
    scope_type: 'agent', scope_id: ulid('act'), actor_id: person, role: 'admin', ...over,
  } as never).execute();

test('membership_scope admits agent', opts, async () => {
  await membership({ scope_id: await agentActor() });
});

test('membership_scope still refuses a scope that is not one of the four', opts, async () => {
  await rejects(() => membership({ scope_type: 'planet' }), 'membership_scope');
});

test('membership_agent_role refuses a member row on an agent: a maintainer is an admin', opts, async () => {
  await rejects(() => membership({ role: 'member' }), 'membership_agent_role');
});

test('membership_owner_scope is unchanged: no owner of an agent', opts, async () => {
  // Refused by one of two constraints, and either is right. Owner is
  // workspace-only, and an agent's rows are admins.
  await assert.rejects(() => membership({ role: 'owner' }),
    (err: Error) => /membership_owner_scope|membership_agent_role/.test(err.message));
});

test('membership_agent_role does not touch other scopes: a space member still inserts', opts, async () => {
  await membership({ scope_type: 'space', role: 'member' });
});
