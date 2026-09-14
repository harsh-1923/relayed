// Creating, editing, deactivating and maintaining workspace agents
// (docs/WORKSPACE-AGENTS.md §4).
//
// Plain functions over the database, like `sync/ops.ts`: routes put HTTPS in
// front of them, and every rule below is testable without a request. Each
// returns the events it appended, and the caller delivers them after the
// commit — an agent created in Settings should reach every client's
// autocomplete now, not at their next heartbeat.
//
// Every permission is asked of `can()` against tuples. "The creator may edit"
// is a membership row on the agent, never `owner_actor_id === me` (§4.4).
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  can, agent as agentTarget, space as spaceTarget, workspace as workspaceTarget,
} from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { loadGrants, Forbidden } from '../authz/can.ts';
import { agentPlacement, spacePlacement } from '../sync/placement.ts';
import { recordActor } from '../sync/directory.ts';
import { addMember } from '../sync/spaces.ts';
import type { AppendedEvent } from '../sync/events.ts';
import { validateHandle, type HandleError } from '../provisioning/handle.ts';
import { agentSummaries } from './summary.ts';

// ─── Limits, and the errors a caller can act on ─────────────────────────────

export const LIMITS = {
  nameChars: 80,
  descriptionChars: 200,
  /** Bytes, as the database counts them (`agent_instructions_size`). */
  instructionsBytes: 32_768,
  modelChars: 120,
  spaces: 20,
  maintainers: 20,
} as const;

export type AgentField = 'name' | 'handle' | 'description' | 'instructions' | 'model'
  | 'space_ids' | 'actor_ids';

/** A field that cannot be written, and why — for the editor to put beside it. */
export class AgentInvalidError extends Error {
  readonly field: AgentField;
  readonly reason: string;
  constructor(field: AgentField, reason: string) {
    super(`${field}: ${reason}`);
    this.name = 'AgentInvalidError';
    this.field = field;
    this.reason = reason;
  }
}

/** One namespace with people (PHASE-1-IDENTITY.md §10): taken by either is taken. */
export class HandleTakenError extends Error {
  readonly handle: string;
  constructor(handle: string) {
    super(`handle taken: ${handle}`);
    this.name = 'HandleTakenError';
    this.handle = handle;
  }
}

/**
 * No agent by that id in the caller's workspace. The same answer for an id that
 * does not exist, a person's id, and another workspace's agent — the difference
 * would tell a caller something about a tenant they are not in.
 */
export class AgentNotFoundError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`no agent ${agentId}`);
    this.name = 'AgentNotFoundError';
    this.agentId = agentId;
  }
}

/** Deactivated is final in v1: the actor is a tombstone, as for a person. */
export class AgentDeactivatedError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`agent ${agentId} is deactivated`);
    this.name = 'AgentDeactivatedError';
    this.agentId = agentId;
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface AgentFields {
  name: string;
  handle: string;
  description: string;
  instructions: string;
  /** `provider/model` from the runtime's table, or null for its fallback. */
  model: string | null;
}

/**
 * A model is named, not chosen from a list, until the server knows the
 * runtime's provider table (the plan's step 3): the shape `provider/model` is
 * all that can be checked here, and a wrong name fails the run, loudly, rather
 * than the save.
 */
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/** Normalise and check the fields present. Throws the first problem found. */
export function validateFields<T extends Partial<AgentFields>>(fields: T): T {
  const out: Partial<AgentFields> = {};
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (name.length === 0) throw new AgentInvalidError('name', 'required');
    if (name.length > LIMITS.nameChars) throw new AgentInvalidError('name', 'too_long');
    if (/[\r\n]/.test(name)) throw new AgentInvalidError('name', 'one_line');
    out.name = name;
  }
  if (fields.handle !== undefined) {
    const handle = fields.handle.trim().toLowerCase();
    const bad: HandleError | null = validateHandle(handle);
    if (bad) throw new AgentInvalidError('handle', bad);
    out.handle = handle;
  }
  if (fields.description !== undefined) {
    const description = fields.description.trim();
    if (description.length > LIMITS.descriptionChars) throw new AgentInvalidError('description', 'too_long');
    // One line, because it is drawn in one: in autocomplete and on a card.
    if (/[\r\n]/.test(description)) throw new AgentInvalidError('description', 'one_line');
    out.description = description;
  }
  if (fields.instructions !== undefined) {
    if (fields.instructions.trim().length === 0) throw new AgentInvalidError('instructions', 'required');
    if (Buffer.byteLength(fields.instructions, 'utf8') > LIMITS.instructionsBytes) {
      throw new AgentInvalidError('instructions', 'too_long');
    }
    out.instructions = fields.instructions;
  }
  if (fields.model !== undefined) {
    const model = fields.model === null ? '' : fields.model.trim();
    if (model === '') out.model = null;
    else if (model.length > LIMITS.modelChars || !MODEL.test(model)) {
      throw new AgentInvalidError('model', 'provider_slash_model');
    } else out.model = model;
  }
  return { ...fields, ...out };
}

// ─── Authorisation ──────────────────────────────────────────────────────────

type AgentAction = 'edit' | 'manage_maintainers' | 'deactivate' | 'read_definition';

/** One grant load and one placement, asked as many questions as needed. */
async function agentGate(db: Kysely<DB>, actorId: string, agentId: string) {
  const [grants, placement] = await Promise.all([loadGrants(db, actorId), agentPlacement(db, agentId)]);
  return {
    placed: placement.workspaceOf?.[agentId] !== undefined,
    may: (action: AgentAction): boolean => can(grants, action, agentTarget(agentId), placement),
  };
}

/**
 * The agent, if the actor may act on it at all. Not-found comes first and is
 * the answer for anything outside the actor's workspace — a member of it may
 * always read the definition, so "may not read" and "does not exist" collapse
 * to the same thing for everyone else.
 */
async function requireAgent(
  db: Kysely<DB>, actorId: string, agentId: string, action: AgentAction,
): Promise<{ workspaceId: string; state: string }> {
  const gate = await agentGate(db, actorId, agentId);
  if (!gate.placed || !gate.may('read_definition')) throw new AgentNotFoundError(agentId);
  if (!gate.may(action)) throw new Forbidden(action, agentTarget(agentId));
  const row = await db.selectFrom('actors').select(['workspace_id', 'state'])
    .where('id', '=', agentId).executeTakeFirstOrThrow();
  return { workspaceId: row.workspace_id, state: row.state };
}

async function handleTaken(
  db: Kysely<DB>, workspaceId: string, handle: string, except?: string,
): Promise<boolean> {
  const clash = await db.selectFrom('actors').select('id')
    .where('workspace_id', '=', workspaceId)
    .where(eb => eb(eb.fn('lower', ['handle']), '=', handle.toLowerCase()))
    .$if(except !== undefined, qb => qb.where('id', '!=', except as string))
    .executeTakeFirst();
  return clash !== undefined;
}

/** Whether a handle is free in this workspace — the editor's live check (§4.1). */
export async function handleAvailability(
  db: Kysely<DB>, workspaceId: string, raw: string, except?: string,
): Promise<{ handle: string; available: boolean; reason: HandleError | 'taken' | null }> {
  const handle = raw.trim().toLowerCase();
  const bad = validateHandle(handle);
  if (bad) return { handle, available: false, reason: bad };
  const taken = await handleTaken(db, workspaceId, handle, except);
  return { handle, available: !taken, reason: taken ? 'taken' : null };
}

/** The unique index lost a race the pre-check won: the same answer, from the database. */
const isHandleClash = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { constraint?: string }).constraint === 'actor_handle';

// ─── Create ─────────────────────────────────────────────────────────────────

export interface CreateAgent extends AgentFields {
  workspaceId: string;
  createdBy: string;
  /** Spaces to add the agent to now. Each needs the creator's `add_member`. */
  spaceIds?: string[];
}

/**
 * Create an agent: the five writes of §4.3, in ONE transaction.
 *
 * 1. the actor, and its `actor.created` directory event;
 * 2. the definition (tools arrive with the connector store);
 * 3. the agent's workspace membership — the leading conjunct of every access
 *    check it will ever pass;
 * 4. the creator's admin row on the agent — maintainership, as a tuple;
 * 5. a space membership per space chosen, each with its `space.member_added`.
 *
 * A failure anywhere leaves none of them: an actor with no definition would
 * reach every client's autocomplete and fail every run.
 */
export async function createAgent(
  db: Kysely<DB>, input: CreateAgent,
): Promise<{ agentId: string; events: AppendedEvent[] }> {
  const fields = validateFields({
    name: input.name, handle: input.handle, description: input.description,
    instructions: input.instructions, model: input.model,
  });
  const spaceIds = [...new Set(input.spaceIds ?? [])];
  if (spaceIds.length > LIMITS.spaces) throw new AgentInvalidError('space_ids', 'too_many');

  const grants = await loadGrants(db, input.createdBy);
  if (!can(grants, 'create_agent', workspaceTarget(input.workspaceId))) {
    throw new Forbidden('create_agent', workspaceTarget(input.workspaceId));
  }
  // Checked before anything is written, each against the space's own placement
  // — which is also what refuses a space in another workspace.
  for (const spaceId of spaceIds) {
    if (!can(grants, 'add_member', spaceTarget(spaceId), await spacePlacement(db, spaceId))) {
      throw new Forbidden('add_member', spaceTarget(spaceId));
    }
  }
  if (await handleTaken(db, input.workspaceId, fields.handle)) throw new HandleTakenError(fields.handle);

  const workspace = await db.selectFrom('workspaces').select('org_id')
    .where('id', '=', input.workspaceId).executeTakeFirstOrThrow();
  const agentId = ulid('act');

  try {
    const events = await db.transaction().execute(async (trx) => {
      await trx.insertInto('actors').values({
        id: agentId, org_id: workspace.org_id, workspace_id: input.workspaceId, type: 'agent',
        handle: fields.handle, display_name: fields.name, avatar_url: null,
        // `system`: it runs inside our own service and presents no credential
        // from outside. Not a WorkOS M2M application (§4.2).
        identity_kind: 'system', identity_id: null,
        owner_actor_id: input.createdBy, provisioned_by: 'api', state: 'active',
      }).execute();

      await trx.insertInto('agents').values({
        actor_id: agentId, workspace_id: input.workspaceId, description: fields.description,
        instructions: fields.instructions, model: fields.model, thinking_level: null,
      }).execute();

      await trx.insertInto('memberships').values([
        { scope_type: 'workspace', scope_id: input.workspaceId, actor_id: agentId, role: 'member', left_at: null },
        { scope_type: 'agent', scope_id: agentId, actor_id: input.createdBy, role: 'admin', left_at: null },
      ]).execute();

      const out: AppendedEvent[] = [await recordActor(trx, 'actor.created', {
        id: agentId, workspaceId: input.workspaceId, type: 'agent', handle: fields.handle,
        displayName: fields.name, avatarUrl: null, ownerActorId: input.createdBy, state: 'active',
        agent: { description: fields.description, config_rev: 1, toolkits: [] },
      })];
      for (const spaceId of spaceIds) out.push(await addMember(trx, spaceId, agentId, 'member'));
      return out;
    });
    return { agentId, events };
  } catch (err) {
    if (isHandleClash(err)) throw new HandleTakenError(fields.handle);
    throw err;
  }
}

// ─── Update ─────────────────────────────────────────────────────────────────

export interface UpdateAgent {
  agentId: string;
  by: string;
  patch: Partial<AgentFields>;
}

/**
 * Edit an agent. `config_rev` moves when what a run would be given moves —
 * instructions or model — and not for a name or a description, so a run's
 * recorded revision still answers "what was it told".
 */
export async function updateAgent(db: Kysely<DB>, input: UpdateAgent): Promise<AppendedEvent> {
  const current = await requireAgent(db, input.by, input.agentId, 'edit');
  if (current.state === 'deactivated') throw new AgentDeactivatedError(input.agentId);
  const patch = validateFields(input.patch);
  if (patch.handle !== undefined && await handleTaken(db, current.workspaceId, patch.handle, input.agentId)) {
    throw new HandleTakenError(patch.handle);
  }

  try {
    return await db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('agents').select(['instructions', 'model'])
        .where('actor_id', '=', input.agentId).executeTakeFirstOrThrow();
      const configChanged = (patch.instructions !== undefined && patch.instructions !== before.instructions)
        || (patch.model !== undefined && patch.model !== before.model);

      const actor = await trx.updateTable('actors')
        .set({
          ...(patch.name !== undefined ? { display_name: patch.name } : {}),
          ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', input.agentId)
        .returning(['handle', 'display_name', 'avatar_url', 'owner_actor_id', 'state'])
        .executeTakeFirstOrThrow();

      await trx.updateTable('agents')
        .set({
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(configChanged ? { config_rev: sql`config_rev + 1` } : {}),
          updated_at: sql`now()`,
        })
        .where('actor_id', '=', input.agentId)
        .execute();

      return announce(trx, input.agentId, current.workspaceId, actor);
    });
  } catch (err) {
    if (isHandleClash(err)) throw new HandleTakenError(patch.handle ?? '');
    throw err;
  }
}

/** `actor.updated` with the summary as it now stands, read inside the same transaction. */
async function announce(
  trx: Transaction<DB>, agentId: string, workspaceId: string,
  actor: { handle: string; display_name: string; avatar_url: string | null;
           owner_actor_id: string | null; state: 'invited' | 'active' | 'suspended' | 'deactivated' },
): Promise<AppendedEvent> {
  const summary = (await agentSummaries(trx, [agentId])).get(agentId);
  return recordActor(trx, 'actor.updated', {
    id: agentId, workspaceId, type: 'agent', handle: actor.handle,
    displayName: actor.display_name, avatarUrl: actor.avatar_url,
    ownerActorId: actor.owner_actor_id, state: actor.state,
    ...(summary ? { agent: summary } : {}),
  });
}

// ─── Deactivate ─────────────────────────────────────────────────────────────

/**
 * Deactivate replaces delete, as for people (§4.1): the actor is tombstoned, its
 * past messages keep rendering, it leaves autocomplete, and every new run is
 * refused. Its memberships are kept — nothing can use them while the actor is
 * not active, and they say where it was.
 *
 * Deactivating a deactivated agent changes nothing and appends nothing.
 */
export async function deactivateAgent(
  db: Kysely<DB>, input: { agentId: string; by: string },
): Promise<AppendedEvent | null> {
  const current = await requireAgent(db, input.by, input.agentId, 'deactivate');
  if (current.state === 'deactivated') return null;
  return db.transaction().execute(async (trx) => {
    const actor = await trx.updateTable('actors')
      .set({ state: 'deactivated', updated_at: sql`now()` })
      .where('id', '=', input.agentId)
      .returning(['handle', 'display_name', 'avatar_url', 'owner_actor_id', 'state'])
      .executeTakeFirstOrThrow();
    return announce(trx, input.agentId, current.workspaceId, actor);
  });
}

// ─── Maintainers ────────────────────────────────────────────────────────────

/**
 * Replace an agent's maintainers — its admin rows — with exactly these people.
 *
 * Each must be an active person in the agent's workspace. An empty list is
 * refused: a maintainer clearing the list by accident would leave the agent to
 * workspace admins alone, which is a state for when every maintainer has left,
 * not one to reach with one click. Removed rows are tombstoned, never deleted
 * (AUTHZ.md §4).
 */
export async function setMaintainers(
  db: Kysely<DB>, input: { agentId: string; by: string; actorIds: string[] },
): Promise<string[]> {
  const current = await requireAgent(db, input.by, input.agentId, 'manage_maintainers');
  if (current.state === 'deactivated') throw new AgentDeactivatedError(input.agentId);
  const wanted = [...new Set(input.actorIds)].sort();
  if (wanted.length === 0) throw new AgentInvalidError('actor_ids', 'required');
  if (wanted.length > LIMITS.maintainers) throw new AgentInvalidError('actor_ids', 'too_many');

  const eligible = await db.selectFrom('actors')
    .innerJoin('memberships', join => join
      .onRef('memberships.actor_id', '=', 'actors.id')
      .on('memberships.scope_type', '=', 'workspace')
      .on('memberships.scope_id', '=', current.workspaceId)
      .on('memberships.left_at', 'is', null))
    .select('actors.id')
    .where('actors.id', 'in', wanted)
    .where('actors.type', '=', 'human')
    .where('actors.state', '=', 'active')
    .execute();
  if (eligible.length !== wanted.length) throw new AgentInvalidError('actor_ids', 'not_a_workspace_member');

  await db.transaction().execute(async (trx) => {
    await trx.updateTable('memberships').set({ left_at: sql`now()` })
      .where('scope_type', '=', 'agent').where('scope_id', '=', input.agentId)
      .where('actor_id', 'not in', wanted).where('left_at', 'is', null)
      .execute();
    await trx.insertInto('memberships')
      .values(wanted.map(actorId => ({
        scope_type: 'agent' as const, scope_id: input.agentId, actor_id: actorId,
        role: 'admin' as const, left_at: null,
      })))
      .onConflict(oc => oc.columns(['scope_type', 'scope_id', 'actor_id']).doUpdateSet({
        role: 'admin', left_at: null,
        joined_at: sql`CASE WHEN memberships.left_at IS NULL THEN memberships.joined_at ELSE now() END`,
      }))
      .execute();
  });
  return wanted;
}

// ─── The definition, read ───────────────────────────────────────────────────

export interface AgentDefinition {
  agentId: string;
  description: string;
  instructions: string;
  model: string | null;
  thinkingLevel: string | null;
  configRev: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  maintainers: string[];
  tools: { toolkit: string; tool: string; effect: string }[];
  /** Spaces the agent is in that the READER is in too — no more than they could see. */
  spaceIds: string[];
  /**
   * What the reader may do to it, answered now by the server. The client's own
   * grants for an agent created a minute ago arrive only with its next
   * `welcome`, so the editor asks here rather than hiding Edit from its creator.
   */
  you: { edit: boolean; manageMaintainers: boolean; deactivate: boolean };
}

/**
 * What an agent was told, for anyone in its workspace (§4.1: no secret prompts).
 * Null for anything the reader may not read — which, for an agent, means it is
 * not in their workspace, or it is not an agent.
 */
export async function agentDefinition(
  db: Kysely<DB>, readerId: string, agentId: string,
): Promise<AgentDefinition | null> {
  const gate = await agentGate(db, readerId, agentId);
  if (!gate.placed || !gate.may('read_definition')) return null;

  const [row, maintainers, tools, spaces] = await Promise.all([
    db.selectFrom('agents').innerJoin('actors', 'actors.id', 'agents.actor_id')
      .select(['agents.description', 'agents.instructions', 'agents.model', 'agents.thinking_level',
               'agents.config_rev', 'agents.created_at', 'agents.updated_at', 'actors.owner_actor_id'])
      .where('agents.actor_id', '=', agentId).executeTakeFirst(),
    db.selectFrom('memberships').select('actor_id')
      .where('scope_type', '=', 'agent').where('scope_id', '=', agentId)
      .where('left_at', 'is', null).orderBy('joined_at').execute(),
    db.selectFrom('agent_tools').select(['toolkit', 'tool', 'effect'])
      .where('agent_actor_id', '=', agentId).orderBy('toolkit').orderBy('tool').execute(),
    db.selectFrom('memberships as a').select('a.scope_id')
      .where('a.scope_type', '=', 'space').where('a.actor_id', '=', agentId)
      .where('a.left_at', 'is', null)
      .where('a.scope_id', 'in', eb => eb.selectFrom('memberships as r').select('r.scope_id')
        .where('r.scope_type', '=', 'space').where('r.actor_id', '=', readerId)
        .where('r.left_at', 'is', null))
      .execute(),
  ]);
  // An agent actor with no definition is a state createAgent's transaction
  // exists to prevent; if one appears anyway, it has nothing to show.
  if (!row) return null;

  const iso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);
  return {
    agentId,
    description: row.description,
    instructions: row.instructions,
    model: row.model,
    thinkingLevel: row.thinking_level,
    configRev: row.config_rev,
    createdBy: row.owner_actor_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    maintainers: maintainers.map(m => m.actor_id),
    tools,
    spaceIds: spaces.map(s => s.scope_id),
    you: {
      edit: gate.may('edit'),
      manageMaintainers: gate.may('manage_maintainers'),
      deactivate: gate.may('deactivate'),
    },
  };
}
