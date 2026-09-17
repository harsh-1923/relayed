// Who is in a room, channel or group conversation, with their roles — for an
// agent asked "who's here?", or working out who to pull into something.
//
// The same access rule as every agent read: both the agent and the person who
// asked are in the space (`place.ts`).
import type { RunTool } from '@relayed/protocol';
import { asText, type AppTool } from './contract.ts';
import { readableSpace, spaceAsked, unreadable } from './place.ts';

export const ROOM_MEMBERS = 'room_members';

/** More than any room; a channel past it is summarised by its count. */
const LIMIT = 200;

const DEFINITION: RunTool = {
  name: ROOM_MEMBERS,
  description: 'List who is in a room, channel or group conversation — people and agents, with their roles and ids. '
    + 'Without a space_id, the one you are in: from a side chat, its room. With one, that space, if both you and '
    + 'the person who asked are in it.',
  parameters: {
    type: 'object',
    properties: {
      space_id: {
        type: 'string',
        description: 'The space, e.g. "spc_01M2…" — from a link [name](space:spc_…) or a tool result. Leave it out '
          + 'for the one you are in.',
      },
    },
  },
};

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 } as const;

export const roomMembers: AppTool = {
  name: ROOM_MEMBERS,
  definition: () => DEFINITION,

  handle: async (deps, run, args) => {
    const spaceId = await spaceAsked(deps, run, asText(args['space_id']));
    if (!spaceId) return { result: 'failed', message: `${ROOM_MEMBERS} needs a space_id: this chat is in no space.` };
    const space = await readableSpace(deps, run, spaceId);
    if (!space) return unreadable('who is in it');

    const rows = await deps.db.selectFrom('memberships')
      .innerJoin('actors', 'actors.id', 'memberships.actor_id')
      .select(['actors.id', 'actors.display_name', 'actors.handle', 'actors.type', 'actors.state', 'memberships.role'])
      .where('memberships.scope_type', '=', 'space').where('memberships.scope_id', '=', spaceId)
      .where('memberships.left_at', 'is', null)
      .execute();
    const members = rows
      .sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.display_name.localeCompare(b.display_name))
      .map(row => ({
        actor_id: row.id, name: row.display_name, handle: row.handle, type: row.type, role: row.role,
        ...(row.state !== 'active' ? { state: row.state } : {}),
        ...(row.id === run.agentActorId ? { you: true } : {}),
      }));

    return {
      result: 'ok',
      data: {
        space_id: space.id, name: space.name, kind: space.kind, count: members.length,
        members: members.slice(0, LIMIT),
        ...(members.length > LIMIT ? { note: `Only the first ${LIMIT} are listed, owners and admins first.` } : {}),
      },
    };
  },
};
