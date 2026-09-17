// An agent starting a side chat for the person who asked (docs/SIDE-CHATS.md):
// "take Bob into a side chat about the flaky test". Public only, like the ones
// people start, and only from a room.
//
// The same write a person's form makes (`createSideChat`), with the agent as
// its starter and the asker recorded on its panel — so the tab opens for the
// person who asked, not for the agent, which has no screen. Then the agent's
// opening message, which is what tells the people it was started with.
import { createHash } from 'node:crypto';
import type { RunTool } from '@relayed/protocol';
import { Forbidden } from '../../authz/can.ts';
import { NotARoomError } from '../../sync/panels.ts';
import { SpaceMemberUnavailableError } from '../../sync/spaces.ts';
import { createSideChat, InvalidSideChatError, SIDE_CHAT_NAME_MAX } from '../../sync/side-chats.ts';
import { AGENT_MESSAGE_MAX, postAs } from './messaging.ts';
import { asText, type AppTool } from './contract.ts';

export const START_SIDE_CHAT = 'start_side_chat';

const DEFINITION: RunTool = {
  name: START_SIDE_CHAT,
  description: 'Start a side chat in this room with the people the person asked for, and post the opening message '
    + 'in it. Everyone in the room can see a side chat; it opens for the person who asked. Only when the person '
    + 'asks for a side chat or a separate conversation with someone here.',
  parameters: {
    type: 'object',
    required: ['name', 'people', 'message'],
    properties: {
      name: { type: 'string', description: `A short name for it, up to ${SIDE_CHAT_NAME_MAX} characters — the topic, e.g. "Flaky login test".` },
      people: {
        type: 'array', items: { type: 'string' },
        description: 'Actor ids of who to start it with, e.g. "act_01M2…" — people or agents in this room. You are in it '
          + 'already. Include the person who asked only if they want to be part of it.',
      },
      message: {
        type: 'string',
        description: 'The opening message, in Markdown: what the side chat is for. Mention the people with '
          + '[Name](actor:act_…) so they are told.',
      },
    },
  },
};

/** The same ids for the same tool call, so a runtime that retries it gets the chat it already made. */
function idFor(prefix: string, run: { runId: string; toolCallId: string }): string {
  const hash = createHash('sha256').update(`${prefix}:${run.runId}:${run.toolCallId}`).digest('hex');
  return `${prefix}_${hash.slice(0, 26).toUpperCase()}`;
}

const failed = (message: string) => ({ result: 'failed', message });

export const startSideChat: AppTool = {
  name: START_SIDE_CHAT,
  definition: where => (where.inRoom ? DEFINITION : null),
  prompt: () => `\n\nWhen the person asks you to take someone into a side chat, or to discuss something with them `
    + `separately, call ${START_SIDE_CHAT} with those people, a short topic as its name, and an opening message that `
    + 'mentions them and says what it is about. Then say in your reply that you started it, and with whom.',

  handle: async (deps, run, args) => {
    const people = Array.isArray(args['people'])
      ? args['people'].filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    const message = asText(args['message']);
    if (!message || message.length > AGENT_MESSAGE_MAX) {
      return failed(`${START_SIDE_CHAT} needs an opening message of 1 to ${AGENT_MESSAGE_MAX} characters.`);
    }

    const place = await deps.db.selectFrom('chats').select('space_id').where('id', '=', run.chatId).executeTakeFirst();
    if (!place) return { result: 'run_not_running' };

    const chatId = idFor('cht', run);
    try {
      await createSideChat(deps.db, {
        spaceId: place.space_id, chatId, panelId: idFor('pnl', run), messageId: idFor('msg', run),
        name: asText(args['name']), kind: 'public', withActorIds: people,
        createdBy: run.agentActorId, onBehalfOf: run.invokerActorId,
      }).then(async created => { for (const event of created.events) await deps.deliver(event); });
    } catch (err) {
      if (err instanceof InvalidSideChatError) {
        return failed(err.field === 'name'
          ? `Give it a name of 1 to ${SIDE_CHAT_NAME_MAX} characters.`
          : 'Name at least one person to start it with, other than yourself.');
      }
      if (err instanceof SpaceMemberUnavailableError) {
        return failed(`${err.actorId} is not in this room, so the side chat was not started. `
          + 'Only people already in the room can be in its side chats.');
      }
      if (err instanceof Forbidden) return failed('You may not start side chats in this room.');
      if (err instanceof NotARoomError) return { result: 'tool_not_allowed' };
      throw err;
    }

    // Posted as the agent, for the person who asked, like any message it sends:
    // mentioning someone here is what tells them.
    const posted = await postAs(deps, run, chatId, message);
    if (!posted) return failed('The side chat was started, but the opening message could not be posted in it.');
    return {
      result: 'ok',
      data: { started: true, chat_id: chatId, name: asText(args['name']), people, message_id: posted.messageId },
    };
  },
};
