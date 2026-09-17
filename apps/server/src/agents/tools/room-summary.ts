// Reading and writing a room's running summary (docs/DOCUMENTS.md §4.8).
//
// Two tools in one file because they are two halves of one thing, and the
// asymmetry between them only reads as deliberate when they sit together:
// ANYONE may read a summary, and only Roomkeeping may write one. Reading is
// reading what the asker could already open; writing is speaking for the room.
import type { RunTool } from '@relayed/protocol';
import { writeDocumentRevision } from '../../sync/documents.ts';
import { ROOMKEEPER_HANDLE } from '../../provisioning/system-agents.ts';
import { asText, iso, type AppTool } from './contract.ts';
import { readableSpace, spaceAsked, unreadable } from './place.ts';
import { SUMMARY_SHAPE } from '../writing.ts';

export const READ_ROOM_SUMMARY = 'read_room_summary';
export const WRITE_ROOM_SUMMARY = 'write_room_summary';

const READ_DEFINITION: RunTool = {
  name: READ_ROOM_SUMMARY,
  description: 'Read the running summary of a room — what is going on in it, who is doing what, and what is open. '
    + 'Without a space_id, the room you are in — a side chat\'s room included. With one, that room, if both you and '
    + 'the person who asked are in it. '
    + 'Use it to answer questions about what a room has covered, and to check what is happening elsewhere before '
    + 'answering.',
  parameters: {
    type: 'object',
    properties: {
      space_id: {
        type: 'string',
        description: 'The room, e.g. "spc_01M2…" — from a room mention written [name](space:spc_…) in the '
          + 'conversation, or a tool result. Leave it out for the room you are in.',
      },
    },
  },
};

/**
 * Read a room's summary — this room's, or another the asker names.
 *
 * ACCESS IS THE INTERSECTION, and it is the rule every agent read already
 * follows (WORKSPACE-AGENTS.md §5.6): the summary comes back only if BOTH the
 * agent and the person who asked are members of that space. Nothing new is
 * invented for cross-room reads, which is what makes them safe to offer at all
 * — an agent can never surface a room the person could not have opened.
 *
 * Roomkeeping is in every room, so for IT the intersection collapses to "the
 * rooms this person is in". That is the useful shape, and the correct one.
 *
 * A dormant or archived room still reads: its summary is kept precisely so
 * somebody can find out what happened there (§4.4).
 */
export const readRoomSummary: AppTool = {
  name: READ_ROOM_SUMMARY,
  definition: () => READ_DEFINITION,
  prompt: () => '\n\nEvery room keeps a running summary of what is happening in it. Call '
    + `${READ_ROOM_SUMMARY} to read one: with no arguments for the room you are in, or with a space_id for another `
    + 'room — a room mention in the conversation is written [name](space:spc_…), and that id is what to pass. Read '
    + 'before answering a question about what a room has covered or what is happening elsewhere, rather than guessing. '
    + 'A room you or the person cannot see is not readable, and saying so is the right answer.',

  handle: async (deps, run, args) => {
    const spaceId = await spaceAsked(deps, run, asText(args['space_id']));
    if (!spaceId) {
      return { result: 'failed', message: `${READ_ROOM_SUMMARY} needs a space_id: this chat is not in a room.` };
    }
    const readable = await readableSpace(deps, run, spaceId);
    if (!readable) return unreadable('its summary');

    const document = await deps.db.selectFrom('documents')
      .select(['body', 'rev', 'updated_at'])
      .where('space_id', '=', spaceId).where('kind', '=', 'room_summary')
      .executeTakeFirst();
    if (!document || document.rev === 0 || document.body.trim().length === 0) {
      return {
        result: 'ok',
        data: {
          space_id: spaceId, name: readable.name, summary: null,
          note: 'This room has no summary yet — nobody has said enough in it.',
        },
      };
    }

    return {
      result: 'ok',
      data: {
        space_id: spaceId, name: readable.name, kind: readable.kind,
        summary: document.body, updated_at: iso(document.updated_at),
      },
    };
  },
};

const WRITE_DEFINITION: RunTool = {
  name: WRITE_ROOM_SUMMARY,
  description: 'Replace this room\'s summary with the text you give. The whole summary, in Markdown — it replaces '
    + 'what is there, so include everything that should remain. Only when the person asks you to change, correct or '
    + 'add to the summary.',
  parameters: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string', description: 'The complete new summary, in Markdown. No preamble, no sign-off.' },
    },
  },
};

/**
 * Replace this room's summary, asked for by a person (§4.8).
 *
 * Through the SAME write path the job uses: `rev`, the revision, the prune and
 * the event. `updated_by_actor_id` stays the agent, and the watermark does not
 * move — a person's request is not a pass over the messages, so the next
 * scheduled refresh still covers what it would have.
 *
 * Re-checked here rather than trusted from the offer: the tool was offered
 * because the dispatcher decided this agent and this room qualify, and a call
 * that arrives anyway must be refused on its own merits.
 */
export const writeRoomSummary: AppTool = {
  name: WRITE_ROOM_SUMMARY,
  definition: where => (where.inRoom && where.isRoomkeeper ? WRITE_DEFINITION : null),
  prompt: () => `\n\nYou keep this room's summary, and it is shown to you below. When the person asks you to `
    + `add something to it, change it, or fix something wrong in it, you MUST call ${WRITE_ROOM_SUMMARY}. Your reply `
    + 'does not change the summary — only that tool does, so putting the new text in your reply instead leaves the '
    + `panel exactly as it was. Give ${WRITE_ROOM_SUMMARY} the COMPLETE new summary: it replaces what is there, so `
    + 'anything you leave out is gone. Edit what is there rather than writing it again from nothing — keep the parts '
    + 'nobody asked you to change, word for word — and keep its shape (below). If they ask you to fold in something '
    + 'from elsewhere — a ticket, a '
    + 'page — read it first with the tools you have, then write. Then reply in one or two sentences saying what you '
    + 'changed, without repeating the summary back. Never rewrite the summary on your own initiative, and never when '
    + `the person only asked you a question about it.\n\n${SUMMARY_SHAPE}`,

  handle: async (deps, run, args) => {
    const agent = await deps.db.selectFrom('actors').select(['handle', 'provisioned_by'])
      .where('id', '=', run.agentActorId).executeTakeFirst();
    if (agent?.handle !== ROOMKEEPER_HANDLE || agent.provisioned_by !== 'system') {
      return { result: 'tool_not_allowed' };
    }

    const place = await deps.db.selectFrom('chats')
      .innerJoin('spaces', 'spaces.id', 'chats.space_id')
      .innerJoin('documents', join => join
        .onRef('documents.space_id', '=', 'spaces.id')
        .on('documents.kind', '=', 'room_summary'))
      .innerJoin('memberships', join => join
        .on('memberships.scope_type', '=', 'space')
        .onRef('memberships.scope_id', '=', 'spaces.id')
        .on('memberships.actor_id', '=', run.agentActorId)
        .on('memberships.left_at', 'is', null))
      .select(['documents.id as document_id'])
      .where('chats.id', '=', run.chatId)
      .where('chats.kind', '!=', 'private')
      .where('spaces.kind', '=', 'room')
      .executeTakeFirst();
    if (!place) return { result: 'tool_not_allowed' };

    const body = asText(args['body']);
    if (body.length === 0) {
      // Refused rather than written: an empty body would blank the panel, and
      // "clear the summary" is not a thing anybody has asked for.
      return { result: 'failed', message: `${WRITE_ROOM_SUMMARY} needs the complete new summary in \`body\`.` };
    }

    const written = await writeDocumentRevision(deps.db, {
      documentId: place.document_id, body, authorActorId: run.agentActorId,
    });
    await deps.deliver(written.event);
    return { result: 'ok', data: { written: true, rev: written.rev } };
  },
};
