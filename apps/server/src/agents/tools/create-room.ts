// Making a room for the person who asked (docs/DESIGN.md §7.1).
import type { RunTool } from '@relayed/protocol';
import { Forbidden } from '../../authz/can.ts';
import { createRoom, spaceNameFrom } from '../../sync/spaces.ts';
import type { AppTool } from './contract.ts';

export const CREATE_ROOM = 'create_room';

const DEFINITION: RunTool = {
  name: CREATE_ROOM,
  description: 'Create a new room in this workspace for the person who asked, with you and them in it. '
    + 'Only when they explicitly ask for a room to be created or started — never on your own initiative. '
    + 'Private unless they ask for a public one. Returns a link to the room: put it in your reply exactly as given.',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The room name, short and specific — e.g. "HAR-21 agents act like humans".' },
      visibility: {
        type: 'string', enum: ['private', 'public'],
        description: 'private (the default): only people added can see it. public: anyone in the workspace can find and join it. Use public only when the person asks for it.',
      },
    },
  },
};

/**
 * The agent is the room's creator; the person joins as an admin beside it, and
 * it is THEIR permission that decides whether a room may be made at all — so
 * the room stays theirs to manage if the agent is later deactivated.
 */
export const createRoomFor: AppTool = {
  name: CREATE_ROOM,
  definition: () => DEFINITION,
  // Last, because a service may stop the run to ask the person for access — and
  // the request is then run again once they allow it. A room made before that
  // stop would be made a second time on the rerun; made after everything else,
  // it is only made by a run that got that far.
  prompt: () => `\n\nIf the person asks you to create or start a room, use ${CREATE_ROOM}, and call it `
    + 'LAST: do everything else the request needs first — reading from services, and anything else asked for — '
    + `and only then create the room. Never create a room nobody asked for. Put the link ${CREATE_ROOM} returns in `
    + 'your reply, exactly as given.',

  handle: async (deps, run, args) => {
    const chat = await deps.db.selectFrom('chats').select('workspace_id')
      .where('id', '=', run.chatId).executeTakeFirst();
    if (!chat) return { result: 'run_not_running' };

    const name = spaceNameFrom(args['name']);
    if (!name) return { result: 'failed', message: `${CREATE_ROOM} needs a name of 1 to 100 characters.` };
    const visibility = args['visibility'] === 'public' ? 'public' : 'private';

    try {
      const created = await createRoom(deps.db, {
        workspaceId: chat.workspace_id, name, visibility,
        createdBy: run.agentActorId, onBehalfOf: run.invokerActorId,
      });
      for (const event of created.events) await deps.deliver(event);
      return {
        result: 'ok',
        data: {
          space_id: created.spaceId, chat_id: created.chatId, name, visibility,
          // An app link, not a web address: the desktop opens the room itself.
          link: `[${name.replaceAll(/[[\]]/g, '')}](space:${created.spaceId})`,
        },
      };
    } catch (err) {
      if (err instanceof Forbidden) {
        return { result: 'failed', message: 'The person who asked is not allowed to create rooms in this workspace.' };
      }
      throw err;
    }
  },
};
