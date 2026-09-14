// Creating and maintaining workspace agents, against Postgres
// (docs/WORKSPACE-AGENTS.md §4).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { Forbidden } from '../authz/can.ts';
import { createChannel, addToSpace, spaceMembers } from '../sync/spaces.ts';
import { directoryPage, eventsSince } from '../sync/feed.ts';
import { workspaceStream, spaceStream } from '../sync/events.ts';
import {
  createAgent, updateAgent, deactivateAgent, setMaintainers, agentDefinition, handleAvailability,
  validateFields, AgentInvalidError, HandleTakenError, AgentNotFoundError, AgentDeactivatedError,
  type CreateAgent,
} from './definitions.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const other = ulid('wsp');
const alice = ulid('act');     // a member, and the creator
const bob = ulid('act');       // a member
const admin = ulid('act');     // a workspace admin
const stranger = ulid('act');  // an admin of the OTHER workspace

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Agents' }).execute();
  for (const id of [wsp, other]) {
    await db.insertInto('workspaces').values({ id, org_id: org, name: 'Agents', slug: `g-${id.slice(-8).toLowerCase()}` }).execute();
  }
  const people: [string, string, 'member' | 'admin'][] = [
    [alice, wsp, 'member'], [bob, wsp, 'member'], [admin, wsp, 'admin'], [stranger, other, 'admin'],
  ];
  for (const [id, ws, role] of people) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: ws, type: 'human', handle: `p-${id.slice(-8).toLowerCase()}`,
      display_name: 'Person', avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`,
      owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: ws, actor_id: id, role }).execute();
  }
});

after(async () => {
  if (!up) return;
  for (const id of [wsp, other]) {
    await db.deleteFrom('sync_events').where('workspace_id', '=', id).execute();
    await db.deleteFrom('spaces').where('workspace_id', '=', id).execute();
    await db.deleteFrom('memberships').where('scope_id', '=', id).execute();
  }
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

const handle = () => `triage-${ulid('h').slice(-6).toLowerCase()}`;

const create = (over: Partial<CreateAgent> = {}) => createAgent(db, {
  workspaceId: wsp, createdBy: alice, name: 'Triage', handle: handle(),
  description: 'Files and triages bugs', instructions: 'File every bug in Linear.', model: null,
  ...over,
});

const directoryLog = () => eventsSince(db, alice, workspaceStream(wsp), 0);

// ─── creating ───────────────────────────────────────────────────────────────

test('CREATE writes the five things of §4.3: actor, definition, two memberships, the directory event',
  opts, async () => {
  const h = handle();
  const { agentId, events } = await create({ handle: h });

  const actor = await db.selectFrom('actors')
    .select(['type', 'handle', 'identity_kind', 'identity_id', 'owner_actor_id', 'provisioned_by', 'state'])
    .where('id', '=', agentId).executeTakeFirstOrThrow();
  assert.deepEqual(actor, { type: 'agent', handle: h, identity_kind: 'system', identity_id: null,
                            owner_actor_id: alice, provisioned_by: 'api', state: 'active' });

  const agent = await db.selectFrom('agents').select(['description', 'instructions', 'model', 'config_rev'])
    .where('actor_id', '=', agentId).executeTakeFirstOrThrow();
  assert.deepEqual(agent, { description: 'Files and triages bugs', instructions: 'File every bug in Linear.',
                            model: null, config_rev: 1 });

  const rows = await db.selectFrom('memberships').select(['scope_type', 'scope_id', 'actor_id', 'role'])
    .where(eb => eb.or([eb('actor_id', '=', agentId), eb('scope_id', '=', agentId)]))
    .orderBy('scope_type').execute();
  assert.deepEqual(rows, [
    { scope_type: 'agent', scope_id: agentId, actor_id: alice, role: 'admin' },
    { scope_type: 'workspace', scope_id: wsp, actor_id: agentId, role: 'member' },
  ], 'maintainership is a tuple, not the owner column (§4.4)');

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'actor.created');
  assert.deepEqual(events[0]?.payload, {
    id: agentId, type: 'agent', handle: h, display_name: 'Triage', avatar_url: null,
    owner_actor_id: alice, state: 'active',
    agent: { description: 'Files and triages bugs', config_rev: 1, toolkits: [] },
  }, 'the owner rides along, or every client refuses the row');
});

test('creating into spaces adds the agent to each, with its space event', opts, async () => {
  const { spaceId } = await createChannel(db, { workspaceId: wsp, name: `g-${ulid('x')}`, createdBy: alice });
  const { agentId, events } = await create({ spaceIds: [spaceId] });
  assert.ok((await spaceMembers(db, spaceId)).includes(agentId));
  assert.deepEqual(events.map(e => [e.type, e.stream.kind]), [['actor.created', 'workspace'], ['space.member_added', 'space']]);
  const log = await eventsSince(db, alice, spaceStream(spaceId), 0);
  assert.equal(log.at(-1)?.type, 'space.member_added');
});

test('a FAILURE after the directory event leaves no actor, no definition, no membership and no event',
  opts, async () => {
  // A real failure inside the transaction, after steps 1–4 have run: the space
  // membership insert — the last write — raises. An actor that survived it
  // would reach every client's autocomplete with no definition behind it.
  const { spaceId } = await createChannel(db, { workspaceId: wsp, name: `g-${ulid('x')}`, createdBy: alice });
  const fn = `fail_${ulid('f').toLowerCase()}`;
  await sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected failure'; END $$`).execute(db);
  await sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON memberships FOR EACH ROW
    WHEN (NEW.scope_type = 'space' AND NEW.scope_id = '${spaceId}' AND NEW.actor_id LIKE 'act_%'
          AND NEW.role = 'member') EXECUTE FUNCTION ${fn}()`).execute(db);
  const eventsBefore = (await directoryLog()).length;
  const h = handle();
  try {
    await assert.rejects(() => create({ handle: h, spaceIds: [spaceId] }), /injected failure/);
  } finally {
    await sql.raw(`DROP TRIGGER ${fn} ON memberships; DROP FUNCTION ${fn}();`).execute(db);
  }

  assert.equal((await db.selectFrom('actors').select('id').where('handle', '=', h).execute()).length, 0, 'no actor');
  assert.equal((await db.selectFrom('agents').innerJoin('actors', 'actors.id', 'agents.actor_id')
    .select('actor_id').where('actors.handle', '=', h).execute()).length, 0, 'no definition');
  assert.equal((await directoryLog()).length, eventsBefore, 'no directory event');
  assert.equal((await handleAvailability(db, wsp, h)).available, true, 'and the handle is free again');
});

test('a space the creator may not add to is refused before anything is written', opts, async () => {
  const { spaceId } = await createChannel(db, {
    workspaceId: wsp, name: `g-${ulid('x')}`, visibility: 'private', createdBy: bob });
  const h = handle();
  await assert.rejects(() => create({ handle: h, spaceIds: [spaceId] }),
    (err: Error) => err instanceof Forbidden && err.action === 'add_member');
  assert.equal((await handleAvailability(db, wsp, h)).available, true);
});

test('someone outside the workspace cannot create an agent in it', opts, async () => {
  await assert.rejects(() => create({ createdBy: stranger }),
    (err: Error) => err instanceof Forbidden && err.action === 'create_agent');
});

test('ONE HANDLE NAMESPACE: an agent cannot take a person\'s handle, in any case', opts, async () => {
  const person = await db.selectFrom('actors').select('handle').where('id', '=', bob).executeTakeFirstOrThrow();
  await assert.rejects(() => create({ handle: person.handle.toUpperCase() }),
    (err: Error) => err instanceof HandleTakenError);
});

test('…nor a person an agent\'s: the same unique index refuses the reverse', opts, async () => {
  const h = handle();
  await create({ handle: h });
  const id = ulid('act');
  await assert.rejects(() => db.insertInto('actors').values({
    id, org_id: org, workspace_id: wsp, type: 'human', handle: h.toUpperCase(), display_name: 'Clash',
    avatar_url: null, identity_kind: 'workos_user', identity_id: `wu_${id}`, owner_actor_id: null,
    provisioned_by: 'api', state: 'active',
  }).execute(), /actor_handle/);
});

test('the same handle is free in ANOTHER workspace', opts, async () => {
  const h = handle();
  await create({ handle: h });
  assert.deepEqual(await handleAvailability(db, other, h), { handle: h, available: true, reason: null });
});

test('validation: the handle policy for people, one-line fields, byte-capped instructions, a model shape',
  () => {
  const reason = (fields: Parameters<typeof validateFields>[0]) => {
    try { validateFields(fields); return null; }
    catch (e) { return e instanceof AgentInvalidError ? `${e.field}:${e.reason}` : String(e); }
  };
  assert.equal(reason({ handle: 'everyone' }), 'handle:reserved');
  assert.equal(reason({ handle: '9lives' }), 'handle:bad_start');
  assert.equal(reason({ name: '  ' }), 'name:required');
  assert.equal(reason({ description: 'two\nlines' }), 'description:one_line');
  assert.equal(reason({ instructions: '€'.repeat(11_000) }), 'instructions:too_long');
  assert.equal(reason({ model: 'claude-opus-5' }), 'model:provider_slash_model');
  assert.equal(reason({ model: 'anthropic/claude-opus-5' }), null);
  assert.deepEqual(validateFields({ model: '  ', handle: ' Triage ' }), { model: null, handle: 'triage' },
    'blank is the fallback; a handle is stored lowercase');
});

// ─── editing ────────────────────────────────────────────────────────────────

test('a maintainer edits; config_rev moves for instructions and model, not for a description', opts, async () => {
  const { agentId } = await create();
  const rev = async () => (await db.selectFrom('agents').select('config_rev')
    .where('actor_id', '=', agentId).executeTakeFirstOrThrow()).config_rev;

  await updateAgent(db, { agentId, by: alice, patch: { description: 'Now also dedupes' } });
  assert.equal(await rev(), 1);
  const event = await updateAgent(db, { agentId, by: alice, patch: { instructions: 'Dedupe, then file.' } });
  assert.equal(await rev(), 2);
  assert.equal(event.type, 'actor.updated');
  assert.deepEqual((event.payload as { agent: unknown }).agent,
    { description: 'Now also dedupes', config_rev: 2, toolkits: [] });
  await updateAgent(db, { agentId, by: alice, patch: { instructions: 'Dedupe, then file.' } });
  assert.equal(await rev(), 2, 'an unchanged value is not a change');
});

test('ANOTHER MEMBER cannot edit; a workspace admin can, holding no row on the agent', opts, async () => {
  const { agentId } = await create();
  await assert.rejects(() => updateAgent(db, { agentId, by: bob, patch: { name: 'Mine now' } }),
    (err: Error) => err instanceof Forbidden && err.action === 'edit');
  await updateAgent(db, { agentId, by: admin, patch: { name: 'Renamed by an admin' } });
  const row = await db.selectFrom('actors').select('display_name').where('id', '=', agentId).executeTakeFirstOrThrow();
  assert.equal(row.display_name, 'Renamed by an admin');
});

test('an agent in another workspace, or a person\'s id, is not found — never forbidden', opts, async () => {
  const { agentId } = await create();
  await assert.rejects(() => updateAgent(db, { agentId, by: stranger, patch: { name: 'x' } }),
    (err: Error) => err instanceof AgentNotFoundError);
  await assert.rejects(() => updateAgent(db, { agentId: bob, by: admin, patch: { name: 'x' } }),
    (err: Error) => err instanceof AgentNotFoundError);
});

test('renaming the handle to one that is taken is refused', opts, async () => {
  const first = handle();
  await create({ handle: first });
  const { agentId } = await create();
  await assert.rejects(() => updateAgent(db, { agentId, by: alice, patch: { handle: first } }),
    (err: Error) => err instanceof HandleTakenError);
});

// ─── deactivating ───────────────────────────────────────────────────────────

test('a WORKSPACE ADMIN deactivates someone else\'s agent; it is final, and a second time is a no-op',
  opts, async () => {
  const { agentId } = await create();
  const event = await deactivateAgent(db, { agentId, by: admin });
  assert.equal((event?.payload as { state: string }).state, 'deactivated');
  assert.equal(await deactivateAgent(db, { agentId, by: admin }), null);
  await assert.rejects(() => updateAgent(db, { agentId, by: alice, patch: { name: 'Back' } }),
    (err: Error) => err instanceof AgentDeactivatedError);
  await assert.rejects(() => deactivateAgent(db, { agentId, by: bob }),
    (err: Error) => err instanceof Forbidden, 'still asked of can() first');
});

// ─── maintainers ────────────────────────────────────────────────────────────

test('MAINTAINERS are replaced as tuples: added can edit, removed cannot, rows are tombstoned', opts, async () => {
  const { agentId } = await create();
  assert.deepEqual(await setMaintainers(db, { agentId, by: alice, actorIds: [bob] }), [bob]);

  await updateAgent(db, { agentId, by: bob, patch: { description: 'Bob maintains this now' } });
  await assert.rejects(() => updateAgent(db, { agentId, by: alice, patch: { name: 'x' } }),
    (err: Error) => err instanceof Forbidden, 'the creator is not special once removed');

  const tomb = await db.selectFrom('memberships').select('left_at')
    .where('scope_type', '=', 'agent').where('scope_id', '=', agentId).where('actor_id', '=', alice)
    .executeTakeFirstOrThrow();
  assert.ok(tomb.left_at, 'tombstoned, not deleted');

  await setMaintainers(db, { agentId, by: bob, actorIds: [alice, bob] });
  await updateAgent(db, { agentId, by: alice, patch: { name: 'Welcome back' } });
});

test('maintainers must be active people in the workspace, and the list cannot be emptied', opts, async () => {
  const { agentId } = await create();
  await assert.rejects(() => setMaintainers(db, { agentId, by: alice, actorIds: [stranger] }),
    (err: Error) => err instanceof AgentInvalidError && err.reason === 'not_a_workspace_member');
  await assert.rejects(() => setMaintainers(db, { agentId, by: alice, actorIds: [agentId] }),
    (err: Error) => err instanceof AgentInvalidError, 'an agent does not maintain an agent');
  await assert.rejects(() => setMaintainers(db, { agentId, by: alice, actorIds: [] }),
    (err: Error) => err instanceof AgentInvalidError && err.reason === 'required');
});

// ─── reading ────────────────────────────────────────────────────────────────

test('ANY MEMBER reads the instructions; `you` says what they may do; another workspace reads nothing',
  opts, async () => {
  const { spaceId } = await createChannel(db, { workspaceId: wsp, name: `g-${ulid('x')}`, createdBy: alice });
  const { spaceId: privateSpace } = await createChannel(db, {
    workspaceId: wsp, name: `g-${ulid('x')}`, visibility: 'private', createdBy: alice });
  const { agentId } = await create({ spaceIds: [spaceId, privateSpace] });
  await addToSpace(db, spaceId, bob, alice);

  const bobs = await agentDefinition(db, bob, agentId);
  assert.equal(bobs?.instructions, 'File every bug in Linear.', 'no secret prompts (§4.1)');
  assert.deepEqual(bobs?.you, { edit: false, manageMaintainers: false, deactivate: false });
  assert.deepEqual(bobs?.maintainers, [alice]);
  assert.deepEqual(bobs?.spaceIds, [spaceId], 'only the spaces bob is in too');

  assert.deepEqual((await agentDefinition(db, alice, agentId))?.you,
    { edit: true, manageMaintainers: true, deactivate: true });
  assert.equal(await agentDefinition(db, stranger, agentId), null);
  assert.equal(await agentDefinition(db, alice, bob), null, 'a person has no definition');
});

// ─── the rest of the system, meeting an agent ───────────────────────────────

test('a DIRECTORY PAGE carries the summary, with each toolkit at its highest effect', opts, async () => {
  const { agentId } = await create();
  await db.insertInto('agent_tools').values([
    { agent_actor_id: agentId, toolkit: 'linear', tool: 'LINEAR_LIST_ISSUES', effect: 'read' },
    { agent_actor_id: agentId, toolkit: 'linear', tool: 'LINEAR_CREATE_LINEAR_ISSUE', effect: 'write' },
    { agent_actor_id: agentId, toolkit: 'github', tool: 'GITHUB_GET_REPO', effect: 'read' },
  ]).execute();

  const rows = (await directoryPage(db, wsp, null, 1000)).rows;
  const row = rows.find(r => r.id === agentId);
  assert.equal(row?.ownerActorId, alice);
  assert.deepEqual(row?.agent, {
    description: 'Files and triages bugs', config_rev: 1,
    toolkits: [{ toolkit: 'github', effect: 'read' }, { toolkit: 'linear', effect: 'write' }],
  });
  assert.equal(rows.find(r => r.id === bob)?.agent, undefined, 'a person has none');
});

test('addToSpace takes an agent like anyone else: nothing there assumes a person', opts, async () => {
  const { spaceId } = await createChannel(db, { workspaceId: wsp, name: `g-${ulid('x')}`, createdBy: bob });
  const { agentId } = await create();
  await addToSpace(db, spaceId, agentId, bob);
  assert.ok((await spaceMembers(db, spaceId)).includes(agentId));
});
