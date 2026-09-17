// A side chat in a synced room (docs/SIDE-CHATS.md): a public or private chat
// beside the room's default one, started with people already in the room.
//
// Created in one transaction — the chat, its panel (PANELS.md §4.1) and a first
// system row naming who it was started with — and only once somebody confirms.
// The client makes the three ids, so a retry is the same chat, not another.
//
// PUBLIC ONLY, for now. A private chat needs chat memberships, and an
// announcement that reaches its members alone, before it can be written
// (SIDE-CHATS.md §4, step 4).
import type { Kysely } from 'kysely';
import { can, space as spaceTarget } from '@relayed/authz';
import type { DB } from '../db/schema.ts';
import { loadGrants, Forbidden } from '../authz/can.ts';
import { spacePlacement } from './placement.ts';
import { allocateStream } from './allocate.ts';
import { appendEvent, spaceStream, type AppendedEvent } from './events.ts';
import { writeMessage } from './ops.ts';
import { insertChatPanel, NotARoomError } from './panels.ts';
import { SpaceMemberUnavailableError } from './spaces.ts';

export const SIDE_CHAT_NAME_MAX = 80;

export interface NewSideChat {
  spaceId: string;
  /** Client-made ids, so asking twice is one chat. */
  chatId: string;
  panelId: string;
  messageId: string;
  name: string;
  kind: 'public';
  /** Who it is started with — room members, people or agents. The creator is implied. */
  withActorIds: readonly string[];
  createdBy: string;
}

export interface CreatedSideChat {
  /** False when this chat already existed: a retry. Nothing was written, and there are no events. */
  created: boolean;
  chatId: string;
  panelId: string;
  events: AppendedEvent[];
}

export class InvalidSideChatError extends Error {
  readonly field: 'name' | 'with_actor_ids';
  readonly reason: string;
  constructor(field: 'name' | 'with_actor_ids', reason: string) {
    super(`invalid side chat: ${field} ${reason}`);
    this.name = 'InvalidSideChatError';
    this.field = field;
    this.reason = reason;
  }
}

/** The chat id is taken by something that is not this request's chat. */
export class SideChatConflictError extends Error {
  constructor(chatId: string) { super(`chat ${chatId} already exists`); this.name = 'SideChatConflictError'; }
}

export async function createSideChat(db: Kysely<DB>, input: NewSideChat): Promise<CreatedSideChat> {
  const name = input.name.trim();
  if (name.length === 0) throw new InvalidSideChatError('name', 'required');
  if (name.length > SIDE_CHAT_NAME_MAX) throw new InvalidSideChatError('name', 'too_long');
  const others = [...new Set(input.withActorIds)].filter(id => id !== input.createdBy);
  if (others.length === 0) throw new InvalidSideChatError('with_actor_ids', 'nobody');

  const [grants, placement] = await Promise.all([
    loadGrants(db, input.createdBy), spacePlacement(db, input.spaceId),
  ]);
  if (!can(grants, 'create_chat', spaceTarget(input.spaceId), placement)) {
    throw new Forbidden('create_chat', spaceTarget(input.spaceId));
  }

  const space = await db.selectFrom('spaces').select(['kind', 'workspace_id', 'lifecycle'])
    .where('id', '=', input.spaceId).executeTakeFirst();
  if (!space || space.kind !== 'room') throw new NotARoomError(input.spaceId);

  return db.transaction().execute(async (trx) => {
    // Allocated first: it locks the room's row, so two creates of the same id
    // serialise here and the second finds the first's chat.
    const allocated = await allocateStream(trx, spaceStream(input.spaceId));

    const existing = await trx.selectFrom('chats').select(['space_id', 'created_by_actor_id'])
      .where('id', '=', input.chatId).executeTakeFirst();
    if (existing) {
      if (existing.space_id !== input.spaceId || existing.created_by_actor_id !== input.createdBy) {
        throw new SideChatConflictError(input.chatId);
      }
      const panel = await trx.selectFrom('panels').select('id')
        .where('chat_id', '=', input.chatId).executeTakeFirstOrThrow();
      // The allocation above is rolled back with this transaction: nothing was written.
      throw new Retry({ created: false, chatId: input.chatId, panelId: panel.id, events: [] });
    }

    // Everyone it is started with is somebody in the room today.
    const members = await trx.selectFrom('memberships')
      .innerJoin('actors', 'actors.id', 'memberships.actor_id')
      .select(['actors.id', 'actors.display_name'])
      .where('memberships.scope_type', '=', 'space').where('memberships.scope_id', '=', input.spaceId)
      .where('memberships.left_at', 'is', null).where('actors.state', '=', 'active')
      .where('actors.id', 'in', [input.createdBy, ...others])
      .execute();
    const nameOf = new Map(members.map(row => [row.id, row.display_name]));
    const missing = others.find(id => !nameOf.has(id));
    if (missing) throw new SpaceMemberUnavailableError(missing);

    const events: AppendedEvent[] = [];
    await trx.insertInto('chats').values({
      id: input.chatId, workspace_id: space.workspace_id, space_id: input.spaceId,
      kind: input.kind, name, created_by_actor_id: input.createdBy,
    }).execute();
    // The chat first, so a client holds it before its panel and its first row arrive.
    events.push(await appendEvent(trx, allocated, 'chat.created',
      { id: input.chatId, space_id: input.spaceId, kind: input.kind, name }, { kind: 'stream' }));

    const panel = await insertChatPanel(trx, {
      panelId: input.panelId, workspaceId: space.workspace_id, spaceId: input.spaceId,
      chatId: input.chatId, createdBy: input.createdBy,
    });
    events.push(await appendEvent(trx, await allocateStream(trx, spaceStream(input.spaceId)),
      'panel.opened', panel, { kind: 'stream' }));

    // The people are REFERENCES, not mentions: naming them notifies nobody
    // (SIDE-CHATS.md §3). Notifying them is a later decision.
    const named = others.map(id => `[${label(nameOf.get(id) ?? 'someone')}](actor-ref:${id})`);
    const written = await writeMessage(trx, {
      kind: 'system', chatId: input.chatId, messageId: input.messageId, authorId: input.createdBy,
      systemKind: 'chat.started', subjectActorId: input.createdBy, audience: { kind: 'stream' },
      body: `${nameOf.get(input.createdBy) ?? 'Someone'} started this with ${list(named)}`,
    });
    events.push(written.event);

    return { created: true, chatId: input.chatId, panelId: input.panelId, events };
  }).catch((error: unknown) => {
    if (error instanceof Retry) return error.result;
    throw error;
  });
}

/** A retry, carried out of the transaction so it rolls back the allocation it took. */
class Retry extends Error {
  readonly result: CreatedSideChat;
  constructor(result: CreatedSideChat) { super('side chat already exists'); this.result = result; }
}

/** A display name as a link label: `]` would end the label early. */
const label = (name: string): string => name.replaceAll(']', '\\]');

/** `a`, `a and b`, `a, b and c`. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
