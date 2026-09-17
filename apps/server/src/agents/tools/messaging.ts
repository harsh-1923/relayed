// An agent talking to people the way a person does (docs/WORKSPACE-AGENTS.md
// §5.5): posting in a room or channel it is in, sending a DM or group message,
// adding people to a room. App tools — answered here, never through Composio.
//
// Every message is written as the AGENT, on behalf of the person who asked,
// with the run as its delegation — the same attribution its reply carries. And
// like a person's message, one that mentions an agent starts it: for the same
// person, one step further down the chain (`startMentionedRuns`).
import type { Kysely } from 'kysely';
import { can, chat as chatTarget } from '@relayed/authz';
import type { DB } from '../../db/schema.ts';
import type { AppendedEvent } from '../../sync/events.ts';
import type { FanoutResult } from '../../sync/fanout.ts';
import { loadGrants, Forbidden } from '../../authz/can.ts';
import { chatPlacement } from '../../sync/placement.ts';
import { applyOnce } from '../../sync/allocate.ts';
import { writeMessage } from '../../sync/ops.ts';
import {
  addToSpace, openDm, InvalidDmMembersError, SealedSpaceError, SpaceMemberUnavailableError, DM_MAX_MEMBERS,
} from '../../sync/spaces.ts';
import { ulid } from '../../db/ulid.ts';
import { startMentionedRuns } from '../checkpoints.ts';
import type { AppTool } from './contract.ts';

/** Longer than any message a person would write to someone; a model that goes past it is dumping, not messaging. */
export const AGENT_MESSAGE_MAX = 8_000;

export interface MessagingDeps {
  db: Kysely<DB>;
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
  dispatcher?: { wake(): void };
}

/** Everything a messaging tool needs about the run, all of it from the grant and our row — none from the model. */
export interface RunContext {
  runId: string;
  toolCallId: string;
  /** The chat the run is in, which fixes its workspace. */
  chatId: string;
  invokerActorId: string;
  agentActorId: string;
  chainDepth: number;
}

type Reply = { result: string; data?: unknown; message?: string };

const failed = (message: string): Reply => ({ result: 'failed', message });

/** Actor ids, as the model passed them: a non-empty list of strings, or null. */
function actorIdsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(id => typeof id === 'string' && id.length > 0) ? [...new Set(value as string[])] : null;
}

function textFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= AGENT_MESSAGE_MAX ? text : null;
}

async function workspaceOf(db: Kysely<DB>, chatId: string): Promise<string | null> {
  const row = await db.selectFrom('chats').select('workspace_id').where('id', '=', chatId).executeTakeFirst();
  return row?.workspace_id ?? null;
}

/** A space in the run's workspace, and the chat a message to it goes into — its `sole` or `default` chat. */
async function spaceInWorkspace(db: Kysely<DB>, spaceId: string, workspaceId: string) {
  return db.selectFrom('spaces')
    .innerJoin('chats', join => join.onRef('chats.space_id', '=', 'spaces.id').on('chats.kind', 'in', ['sole', 'default']))
    .select(['spaces.id as spaceId', 'spaces.kind as kind', 'spaces.name as name', 'chats.id as chatId'])
    .where('spaces.id', '=', spaceId).where('spaces.workspace_id', '=', workspaceId)
    .executeTakeFirst();
}

/**
 * Post as the agent. Refused unless the agent itself may post there — it is a
 * member — so an agent never speaks in a place its member list does not show
 * it in. Once per tool call: a runtime that retries the same call gets the
 * first message back rather than a second.
 */
export async function postAs(deps: MessagingDeps, run: RunContext, chatId: string, text: string): Promise<{ messageId: string } | null> {
  const [grants, placement] = await Promise.all([loadGrants(deps.db, run.agentActorId), chatPlacement(deps.db, chatId)]);
  if (!can(grants, 'post', chatTarget(chatId), placement)) return null;

  let event: AppendedEvent | undefined;
  let runIds: string[] = [];
  const messageId = ulid('msg');
  const applied = await applyOnce(deps.db, {
    opId: `op_${run.runId}_${run.toolCallId}`, actorId: run.agentActorId, chatId, kind: 'send',
  }, async (trx) => {
    const written = await writeMessage(trx, {
      kind: 'actor', chatId, messageId, authorId: run.agentActorId, parentId: null,
      audience: { kind: 'stream' }, onBehalfOfActorId: run.invokerActorId, delegationId: run.runId, body: text,
    });
    event = written.event;
    runIds = await startMentionedRuns(trx, {
      chatId, messageId, authorId: run.agentActorId, body: (written.event.payload as { body: string }).body,
      invokerActorId: run.invokerActorId, depth: run.chainDepth + 1,
    });
    return written.ack;
  });
  if (!applied.replayed && event) await deps.deliver(event);
  if (runIds.length > 0) deps.dispatcher?.wake();
  return { messageId: applied.result.messageId };
}

const NOT_A_MEMBER = 'You are not a member there, so you cannot post in it. Tell the person you could not send the message and why.';

/** `post_message({ space_id, text })`: into a room, channel or conversation the agent is in. */
export async function postMessageFor(deps: MessagingDeps, run: RunContext, args: Record<string, unknown>): Promise<Reply> {
  const text = textFrom(args['text']);
  if (!text) return failed(`post_message needs text of 1 to ${AGENT_MESSAGE_MAX} characters.`);
  const workspaceId = await workspaceOf(deps.db, run.chatId);
  // No space named: the one this run is in, found from its own chat — so
  // "post this in the room" from a side chat reaches the room's main chat.
  const named = typeof args['space_id'] === 'string' && args['space_id'].length > 0 ? args['space_id'] : null;
  const spaceId = named ?? (await deps.db.selectFrom('chats').select('space_id')
    .where('id', '=', run.chatId).executeTakeFirst())?.space_id;
  const target = spaceId && workspaceId ? await spaceInWorkspace(deps.db, spaceId, workspaceId) : undefined;
  if (!target) return failed('There is no such room, channel or conversation in this workspace.');

  const posted = await postAs(deps, run, target.chatId, text);
  if (!posted) return { result: 'not_a_member', message: NOT_A_MEMBER };
  return { result: 'ok', data: { posted: true, message_id: posted.messageId, space_id: target.spaceId, link: link(target.name, target.spaceId) } };
}

/**
 * `send_dm({ people, text })`: one person is a DM with the agent, several are
 * one group message with the agent and all of them. The conversation already
 * there is used — the agent opens it as a person would (`openDm`).
 */
export async function sendDmFor(deps: MessagingDeps, run: RunContext, args: Record<string, unknown>): Promise<Reply> {
  const people = actorIdsFrom(args['people'])?.filter(id => id !== run.agentActorId) ?? null;
  if (!people || people.length === 0) return failed('send_dm needs people: the actor ids of who to message.');
  const text = textFrom(args['text']);
  if (!text) return failed(`send_dm needs text of 1 to ${AGENT_MESSAGE_MAX} characters.`);
  const workspaceId = await workspaceOf(deps.db, run.chatId);
  if (!workspaceId) return { result: 'run_not_running' };

  let opened;
  try {
    opened = await openDm(deps.db, { workspaceId, openedBy: run.agentActorId, withActorIds: people });
  } catch (err) {
    if (err instanceof InvalidDmMembersError) {
      return failed(`A group message holds at most ${DM_MAX_MEMBERS} people, you included.`);
    }
    if (err instanceof SpaceMemberUnavailableError) {
      return failed(`${err.actorId} is not an active member of this workspace, so the message was not sent.`);
    }
    if (err instanceof Forbidden) return failed('You may not start conversations in this workspace.');
    throw err;
  }
  for (const event of opened.events) await deps.deliver(event);

  const posted = await postAs(deps, run, opened.chatId, text);
  if (!posted) return { result: 'not_a_member', message: NOT_A_MEMBER };
  return {
    result: 'ok',
    data: {
      sent: true, space_id: opened.spaceId, kind: people.length === 1 ? 'dm' : 'group_dm',
      new_conversation: opened.created, link: link(people.length === 1 ? 'Direct message' : 'Group message', opened.spaceId),
    },
  };
}

/**
 * `add_to_room({ space_id, people })`: each person added the way a member adds
 * someone, with the marker. The agent must be in the room; a DM takes nobody.
 */
export async function addToRoomFor(deps: MessagingDeps, run: RunContext, args: Record<string, unknown>): Promise<Reply> {
  const people = actorIdsFrom(args['people']);
  if (!people) return failed('add_to_room needs people: the actor ids of who to add.');
  const workspaceId = await workspaceOf(deps.db, run.chatId);
  const target = typeof args['space_id'] === 'string' && workspaceId
    ? await spaceInWorkspace(deps.db, args['space_id'], workspaceId) : undefined;
  if (!target) return failed('There is no such room or channel in this workspace.');

  const added: string[] = [];
  const already: string[] = [];
  const unavailable: string[] = [];
  for (const actorId of people) {
    try {
      const result = await addToSpace(deps.db, target.spaceId, actorId, run.agentActorId, ulid('msg'));
      if (result.status === 'already_member') { already.push(actorId); continue; }
      await deps.deliver(result.membershipEvent);
      await deps.deliver(result.messageEvent);
      added.push(actorId);
    } catch (err) {
      if (err instanceof Forbidden) return { result: 'not_a_member', message: 'You are not a member of that room, so you cannot add people to it. Tell the person why.', data: { added } };
      if (err instanceof SealedSpaceError) return failed('Nobody can be added to a direct or group message. Send a new one with everyone in it instead.');
      if (err instanceof SpaceMemberUnavailableError) { unavailable.push(actorId); continue; }
      throw err;
    }
  }
  return { result: 'ok', data: { space_id: target.spaceId, added, already_members: already, not_in_workspace: unavailable } };
}

/** An app link the desktop opens as the space (`space:spc_…`). */
const link = (name: string | null, spaceId: string): string =>
  `[${(name ?? 'Conversation').replaceAll(/[[\]]/g, '')}](space:${spaceId})`;

// ─── As tools ───────────────────────────────────────────────────────────────
//
// The definitions sit beside the handlers that answer them, so a schema and the
// code reading its arguments cannot drift apart unnoticed.

export const SEND_DM = 'send_dm';
export const POST_MESSAGE = 'post_message';
export const ADD_TO_ROOM = 'add_to_room';

const PEOPLE = {
  type: 'array', items: { type: 'string' },
  description: 'Actor ids, e.g. "act_01M2…" — as the conversation labels people, Name (@handle, act_…), or from a link to them.',
};

/**
 * Last in the offered list, for the same reason a room is: a stop for access
 * re-runs the whole request, and a message already sent would be sent again.
 */
const MESSAGING_PROMPT = `\n\nPeople in this conversation carry their actor id (act_…); use that id to reach them. `
  + `When the person asks you to message someone, use ${SEND_DM} — a direct message for one person, one group message `
  + `only when they ask for a group. To post in a room or channel, use ${POST_MESSAGE}; to add people to one, `
  + `${ADD_TO_ROOM}. "Post this in the room" means ${POST_MESSAGE} without a space_id. Do these LAST, after everything else the request needs. Never message or add anyone the person `
  + 'did not ask for. If you are not a member where you were asked to post, say you could not, and why. Mentioning an '
  + 'agent in a message you send asks it to act.';

export const sendDm: AppTool = {
  name: SEND_DM,
  definition: () => ({
    name: SEND_DM,
    description: 'Send a direct message. One person: a direct message between you and them. Several people: one group '
      + 'message with you and all of them — only when the person asked for a group. Uses the conversation that already '
      + 'exists with exactly those people. Only when the person asks you to message someone.',
    parameters: {
      type: 'object', required: ['people', 'text'],
      properties: { people: PEOPLE, text: { type: 'string', description: 'The message, in Markdown. Mention someone as [Name](actor:act_…).' } },
    },
  }),
  // One fragment for all three, carried by the first: three near-identical
  // paragraphs would spend context saying the same thing.
  prompt: () => MESSAGING_PROMPT,
  handle: sendDmFor,
};

export const postMessage: AppTool = {
  name: POST_MESSAGE,
  definition: () => ({
    name: POST_MESSAGE,
    description: 'Post a message in a room, channel or conversation you are a member of — in its main conversation. '
      + 'Without a space_id, the one you are in: from a side chat, its room. If you are not a member, this says so: '
      + 'tell the person you could not post there. Only when the person asks you to post somewhere.',
    parameters: {
      type: 'object', required: ['text'],
      properties: {
        space_id: {
          type: 'string',
          description: 'The space, e.g. "spc_01M2…" — from a space link [name](space:spc_…) or a tool result. Leave it '
            + 'out to post in the room you are in.',
        },
        text: { type: 'string', description: 'The message, in Markdown. Mention someone as [Name](actor:act_…).' },
      },
    },
  }),
  handle: postMessageFor,
};

export const addToRoom: AppTool = {
  name: ADD_TO_ROOM,
  definition: () => ({
    name: ADD_TO_ROOM,
    description: 'Add people to a room or channel you are a member of. Not a direct or group message: nobody is added '
      + 'to those. Only when the person asks you to add someone.',
    parameters: {
      type: 'object', required: ['space_id', 'people'],
      properties: { space_id: { type: 'string', description: 'The room or channel, e.g. "spc_01M2…".' }, people: PEOPLE },
    },
  }),
  handle: addToRoomFor,
};
