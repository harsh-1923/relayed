// The agents the app brings with it (docs/DOCUMENTS.md §9).
//
// Relay and Relay Roomkeeping are provisioned per workspace, never by a person.
// They are ordinary `actors` rows of type `agent` with ordinary `agents`
// definitions — which is the whole point: they are mentionable, addressable and
// in the directory like anything else, and a run started by mentioning one is
// an ordinary run spending the asker's authority.
//
// Written here rather than through `createAgent` because every one of that
// function's premises is about a person: it asks `can(createdBy, 'create_agent')`,
// it makes the creator the owner, and it writes the creator an admin row on the
// agent. There is no creator here, ownership is provenance (§9.2), and a
// maintainer row is exactly the thing these must not have.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { recordActor } from '../sync/directory.ts';
import type { AppendedEvent } from '../sync/events.ts';

/** Reserved by the unique handle index the moment these rows exist (§9.3). */
export const RELAY_HANDLE = 'relay';
export const ROOMKEEPER_HANDLE = 'roomkeeping';

interface SystemAgent {
  handle: string;
  name: string;
  description: string;
  instructions: string;
  /** The handle of the system agent that owns this one; null for the root. */
  ownedBy: string | null;
}

/**
 * Relay first: it is the root of the ownership chain, so the order of this
 * array is also the order they must be written in.
 *
 * Instructions change the way the rest of the app changes — in a release
 * (§9.2). They are deliberately short: teaching Relay the app properly is its
 * own piece of work, and a long prompt written now would mostly be guesses.
 */
const SYSTEM_AGENTS: readonly SystemAgent[] = [
  {
    handle: RELAY_HANDLE,
    name: 'Relay',
    description: 'The app’s own agent. Ask it about Relayed, or about the other agents.',
    ownedBy: null,
    instructions: [
      'You are Relay, the agent that ships with Relayed itself.',
      '',
      'Relayed is a workspace where people and agents talk in the same places.',
      'People work in **spaces**: channels for the whole workspace, rooms for a',
      'piece of work, and DMs. A room keeps a running **summary** of what is',
      'happening in it, written by @roomkeeping and read in a panel beside the',
      'chat. Anyone can mention an agent by handle to start a run; a run acts',
      'with the authority of whoever mentioned it, never more.',
      '',
      'Help people use Relayed: how to do something here, what a part of the app',
      'is for, which agent to ask. When somebody wants a room summarised, edited',
      'or corrected, tell them to ask @roomkeeping in that room — it is the one',
      'that can write it.',
      '',
      'Be brief and concrete. If you do not know how something in Relayed works,',
      'say so rather than inventing a feature.',
    ].join('\n'),
  },
  {
    handle: ROOMKEEPER_HANDLE,
    name: 'Relay Roomkeeping',
    description: 'Keeps each room’s summary up to date. Ask it to add or correct something.',
    ownedBy: RELAY_HANDLE,
    instructions: [
      'You are Relay Roomkeeping. You are in every room, and you keep each',
      'room’s running summary — the document people read in the panel beside',
      'the chat.',
      '',
      'THE SUMMARY IS A DOCUMENT, NOT SOMETHING YOU SAY. When you produce it —',
      'however you were asked to — it is the finished text and nothing else:',
      'no preamble explaining what you are about to write, no meta-commentary',
      'about the summary, no sign-off after it. Telling somebody you have',
      'updated it when the document itself has not changed is a lie they will',
      'believe.',
      '',
      'A good summary tells somebody arriving what is going on: what is being',
      'worked on, what was decided, what is open and who is doing what. It is',
      'about the work, not about the conversation — no transcript, no',
      'play-by-play, no “Alice said, then Bob said”. Write it in Markdown, with',
      'short sections, and keep it short enough to read in under a minute.',
      '',
      'You only ever write the summary of the room you are asked in, and you',
      'only use what you can see in that room. When somebody asks you to fold',
      'something in from elsewhere — a ticket, a page — read it with the tools',
      'you are given and put the relevant part in. When somebody tells you the',
      'summary is wrong, believe them and fix that part; leave the rest alone.',
    ].join('\n'),
  },
];

/** The id of a system agent in this workspace, or null if it has not been provisioned. */
export async function systemAgentId(
  db: Kysely<DB> | Transaction<DB>, workspaceId: string, handle: string,
): Promise<string | null> {
  const row = await db.selectFrom('actors').select('id')
    .where('workspace_id', '=', workspaceId)
    .where('handle', '=', handle)
    .where('provisioned_by', '=', 'system')
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Give a workspace its system agents, and bring their definitions up to date.
 *
 * Idempotent, and safe to re-run over every workspace. An agent that is already
 * there keeps its id, its ownership and its memberships; what it does NOT keep
 * is stale text — if the shipped description or instructions differ from what
 * is stored, the shipped ones win and `config_rev` moves.
 *
 * That is §9.2 taken literally: nobody can edit these through the agent routes,
 * so their prompts "change the way the rest of the app changes — in a release",
 * and this is the code path a release has. The alternative, protecting a
 * hand-edit somebody made in psql, would mean a prompt fix could never reach a
 * workspace that already exists — which is exactly the bug this was written to
 * fix.
 *
 * Returns the directory events so the caller can fan them out. In a brand new
 * workspace there is nobody to tell; over a backfill there may be.
 */
export async function provisionSystemAgents(
  db: Kysely<DB>, workspaceId: string,
): Promise<AppendedEvent[]> {
  const workspace = await db.selectFrom('workspaces').select('org_id')
    .where('id', '=', workspaceId).executeTakeFirst();
  if (!workspace) return [];

  const events: AppendedEvent[] = [];
  for (const agent of SYSTEM_AGENTS) {
    // One transaction per agent, and Relay is first: Roomkeeping's owner has to
    // be committed before Roomkeeping's row can reference it.
    const existing = await systemAgentId(db, workspaceId, agent.handle);
    if (existing) {
      const updated = await bringUpToDate(db, workspaceId, existing, agent);
      if (updated) events.push(updated);
      continue;
    }
    const owner = agent.ownedBy === null ? null : await systemAgentId(db, workspaceId, agent.ownedBy);
    // Its owner is missing and could not be created: leave the workspace
    // without this agent rather than writing an orphan.
    if (agent.ownedBy !== null && owner === null) continue;

    const agentId = ulid('act');
    const event = await db.transaction().execute(async (trx) => {
      await trx.insertInto('actors').values({
        id: agentId, org_id: workspace.org_id, workspace_id: workspaceId, type: 'agent',
        handle: agent.handle, display_name: agent.name, avatar_url: null,
        identity_kind: 'system', identity_id: null,
        owner_actor_id: owner, provisioned_by: 'system', state: 'active',
      }).execute();

      await trx.insertInto('agents').values({
        actor_id: agentId, workspace_id: workspaceId, description: agent.description,
        instructions: agent.instructions, model: null, thinking_level: null,
      }).execute();

      // Workspace membership only. No `agent`-scoped admin row: maintainership
      // is what a person gets over an agent they made, and nobody maintains
      // these (§9.2).
      await trx.insertInto('memberships').values({
        scope_type: 'workspace', scope_id: workspaceId, actor_id: agentId,
        role: 'member', left_at: null,
      }).execute();

      return recordActor(trx, 'actor.created', {
        id: agentId, workspaceId, type: 'agent', handle: agent.handle,
        displayName: agent.name, avatarUrl: null, ownerActorId: owner, state: 'active',
        agent: { description: agent.description, config_rev: 1, toolkits: [] },
      });
    });
    events.push(event);
  }
  return events;
}

/**
 * The shipped text, when what is stored differs from it.
 *
 * `config_rev` moves because a run records the revision it started with, and
 * "what was it told when it did that" must keep its answer across a release
 * that changes the prompt. Nothing is written — and no event appended — when
 * the text already matches, so a boot over an up-to-date workspace costs one
 * SELECT per agent.
 */
async function bringUpToDate(
  db: Kysely<DB>, workspaceId: string, agentId: string, shipped: SystemAgent,
): Promise<AppendedEvent | null> {
  const stored = await db.selectFrom('agents').select(['description', 'instructions'])
    .where('actor_id', '=', agentId).executeTakeFirst();
  if (!stored) return null;
  if (stored.description === shipped.description && stored.instructions === shipped.instructions) return null;

  return db.transaction().execute(async (trx) => {
    const row = await trx.updateTable('agents')
      .set({
        description: shipped.description, instructions: shipped.instructions,
        config_rev: sql`config_rev + 1`, updated_at: sql`now()`,
      })
      .where('actor_id', '=', agentId)
      .returning('config_rev')
      .executeTakeFirstOrThrow();
    const actor = await trx.selectFrom('actors')
      .select(['handle', 'display_name', 'avatar_url', 'owner_actor_id', 'state'])
      .where('id', '=', agentId).executeTakeFirstOrThrow();
    return recordActor(trx, 'actor.updated', {
      id: agentId, workspaceId, type: 'agent', handle: actor.handle,
      displayName: actor.display_name, avatarUrl: actor.avatar_url,
      ownerActorId: actor.owner_actor_id, state: actor.state,
      agent: { description: shipped.description, config_rev: Number(row.config_rev), toolkits: [] },
    });
  });
}

/**
 * Whether this actor is one of ours.
 *
 * The one question the agent routes ask before allowing an edit, a
 * deactivation or a maintainer change — for EVERY caller, person or run acting
 * for a person (§9.2). Ownership grants nothing here; this does the refusing.
 */
export async function isSystemAgent(
  db: Kysely<DB> | Transaction<DB>, actorId: string,
): Promise<boolean> {
  const row = await db.selectFrom('actors').select('provisioned_by')
    .where('id', '=', actorId).executeTakeFirst();
  return row?.provisioned_by === 'system';
}

/** Rooms in this workspace that Roomkeeping is not in — the backfill's worklist. */
export async function roomsWithoutRoomkeeper(
  db: Kysely<DB>, roomkeeperId: string, workspaceId: string,
): Promise<{ id: string; name: string | null }[]> {
  return db.selectFrom('spaces')
    .select(['spaces.id', 'spaces.name'])
    .where('spaces.workspace_id', '=', workspaceId)
    .where('spaces.kind', '=', 'room')
    .where('spaces.lifecycle', '=', 'active')
    .where(eb => eb.not(eb.exists(
      eb.selectFrom('memberships')
        .select(sql`1`.as('one'))
        .where('memberships.scope_type', '=', 'space')
        .whereRef('memberships.scope_id', '=', 'spaces.id')
        .where('memberships.actor_id', '=', roomkeeperId)
        .where('memberships.left_at', 'is', null))))
    .orderBy('spaces.created_at')
    .execute();
}
