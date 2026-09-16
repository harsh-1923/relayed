// The tools a workspace-agent run is given (docs/WORKSPACE-AGENTS-IMPL.md,
// step 7, D21): the two that reach external services through Composio, and the
// app's own — acting in Relayed itself, answered by the broker without
// Composio. The dispatcher offers them; the broker answers them. Defined once
// here so the names the model is told and the names the broker dispatches on
// cannot drift apart.
import type { RunTool } from '@relayed/protocol';

export const FIND_TOOLS = 'find_tools';
export const CALL_TOOL = 'call_tool';
export const OPEN_PANEL = 'open_panel';
export const CREATE_ROOM = 'create_room';
export const SEND_DM = 'send_dm';
export const POST_MESSAGE = 'post_message';
export const ADD_TO_ROOM = 'add_to_room';

export interface OfferedToolkit { slug: string; name: string }

/**
 * `toolkit` is an enum of what this deployment offers, so the model names the
 * service before it searches (D22): Composio's search never answers "nothing
 * fits" — asked to post in Slack with only GitHub enabled, it returns GitHub
 * tools — so the choice of service cannot be left to the search.
 */
export function runTools(toolkits: readonly OfferedToolkit[], where: { inRoom: boolean }): RunTool[] {
  return [
    ...(toolkits.length > 0 ? serviceTools(toolkits) : []),
    ...(where.inRoom ? [OPEN_PANEL_TOOL] : []),
    CREATE_ROOM_TOOL,
    ...MESSAGING_TOOLS,
  ];
}

const PEOPLE = {
  type: 'array', items: { type: 'string' },
  description: 'Actor ids, e.g. "act_01M2…" — from a mention in the conversation, which is written [Name](actor:act_…).',
};

/** Talking to people the way a person does (`messaging.ts`): as you, on behalf of the person who asked. */
const MESSAGING_TOOLS: RunTool[] = [
  {
    name: SEND_DM,
    description: 'Send a direct message. One person: a direct message between you and them. Several people: one group '
      + 'message with you and all of them — only when the person asked for a group. Uses the conversation that already '
      + 'exists with exactly those people. Only when the person asks you to message someone.',
    parameters: {
      type: 'object', required: ['people', 'text'],
      properties: { people: PEOPLE, text: { type: 'string', description: 'The message, in Markdown. Mention someone as [Name](actor:act_…).' } },
    },
  },
  {
    name: POST_MESSAGE,
    description: 'Post a message in a room, channel or conversation you are a member of. If you are not a member, this '
      + 'says so: tell the person you could not post there. Only when the person asks you to post somewhere.',
    parameters: {
      type: 'object', required: ['space_id', 'text'],
      properties: {
        space_id: { type: 'string', description: 'The space, e.g. "spc_01M2…" — from a space link [name](space:spc_…) or a tool result.' },
        text: { type: 'string', description: 'The message, in Markdown. Mention someone as [Name](actor:act_…).' },
      },
    },
  },
  {
    name: ADD_TO_ROOM,
    description: 'Add people to a room or channel you are a member of. Not a direct or group message: nobody is added '
      + 'to those. Only when the person asks you to add someone.',
    parameters: {
      type: 'object', required: ['space_id', 'people'],
      properties: { space_id: { type: 'string', description: 'The room or channel, e.g. "spc_01M2…".' }, people: PEOPLE },
    },
  },
];

/**
 * Makes a room for the person who asked, with this agent in it (every run,
 * wherever it is). The agent is the room's creator; the person joins as an
 * admin beside it, and it is their permission that decides whether a room may
 * be made at all.
 */
const CREATE_ROOM_TOOL: RunTool = {
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
 * Opens a page beside the chat for everyone in the room (PANELS.md). Only in a
 * room: a room is where people gather to get one thing done, and the page the
 * work happens on — the ticket, the dashboard, the document — is what they
 * want in front of them, not a link in a reply.
 */
const OPEN_PANEL_TOOL: RunTool = {
  name: OPEN_PANEL,
  description: 'Open a web page beside the chat for everyone in this room: a ticket, a dashboard, a document, '
    + 'a trace — the page the work is happening on. Use it for pages the people here will want to look at '
    + 'or work in, not for every link. https only. Opening a page the room already has brings it forward.',
  parameters: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The page, as an https URL — from a tool result or the conversation.' },
      title: { type: 'string', description: 'A short tab title, e.g. "LIN-42" or "Checkout errors".' },
    },
  },
};

function serviceTools(toolkits: readonly OfferedToolkit[]): RunTool[] {
  return [
    {
      name: FIND_TOOLS,
      description: 'Find the tools for one task in one service, on behalf of the person who asked. '
        + 'Only for a service the request itself needs — never to look around another service for background. '
        + `Call this before ${CALL_TOOL}. Returns tool names with the arguments each takes. `
        + 'If the person has not given you access to that service yet, a card asking them for it is '
        + 'posted in the chat and this returns an error saying so.',
      parameters: {
        type: 'object',
        required: ['toolkit', 'use_case'],
        properties: {
          toolkit: {
            type: 'string',
            enum: toolkits.map(toolkit => toolkit.slug),
            description: `The service: ${toolkits.map(toolkit => `${toolkit.slug} (${toolkit.name})`).join(', ')}.`,
          },
          use_case: {
            type: 'string',
            description: 'What you need to do, in plain words, with the specifics you know — '
              + 'for example "read issue #445 in acme/web".',
          },
        },
      },
    },
    {
      name: CALL_TOOL,
      description: `Run one tool that ${FIND_TOOLS} returned, with arguments matching that tool's parameters.`,
      parameters: {
        type: 'object',
        required: ['tool', 'arguments'],
        properties: {
          tool: { type: 'string', description: `A tool name exactly as ${FIND_TOOLS} returned it.` },
          arguments: { type: 'object', description: "The tool's arguments.", additionalProperties: true },
        },
      },
    },
  ];
}

/** Appended to the agent's own instructions. Empty when nothing is offered. */
export function toolsPrompt(toolkits: readonly OfferedToolkit[], where: { inRoom: boolean }): string {
  return servicesPrompt(toolkits) + (where.inRoom ? ROOM_PROMPT : '') + CREATE_ROOM_PROMPT + MESSAGING_PROMPT;
}

// Last, for the same reason a room is: a stop for access re-runs the whole
// request, and a message already sent would be sent again.
const MESSAGING_PROMPT = `\n\nPeople in this conversation are written [Name](actor:act_…); use that id to reach them. `
  + `When the person asks you to message someone, use ${SEND_DM} — a direct message for one person, one group message `
  + `only when they ask for a group. To post in a room or channel, use ${POST_MESSAGE}; to add people to one, `
  + `${ADD_TO_ROOM}. Do these LAST, after everything else the request needs. Never message or add anyone the person `
  + 'did not ask for. If you are not a member where you were asked to post, say you could not, and why. Mentioning an '
  + 'agent in a message you send asks it to act.';

// Last, because a service may stop the run to ask the person for access — and
// the request is then run again once they allow it. A room made before that
// stop would be made a second time on the rerun; made after everything else,
// it is only made by a run that got that far.
const CREATE_ROOM_PROMPT = `\n\nIf the person asks you to create or start a room, use ${CREATE_ROOM}, and call it `
  + 'LAST: do everything else the request needs first — reading from services, and anything else asked for — '
  + `and only then create the room. Never create a room nobody asked for. Put the link ${CREATE_ROOM} returns in `
  + 'your reply, exactly as given.';

const ROOM_PROMPT = `\n\nThis chat is in a room, where people work on one thing together. When you create, `
  + `find or change something that lives on a web page — a ticket, a dashboard, a trace, a document — open that `
  + `page with ${OPEN_PANEL} so everyone in the room sees it beside the conversation. Open only the pages the `
  + 'work is about, and say in your reply what you opened.';

function servicesPrompt(toolkits: readonly OfferedToolkit[]): string {
  if (toolkits.length === 0) return '';
  return `\n\nYou can use these services on behalf of the person who asked: `
    + `${toolkits.map(toolkit => toolkit.name).join(', ')}. To use one, call ${FIND_TOOLS} for that service, `
    + `then ${CALL_TOOL} with a tool it returned. Use a service only when the request needs something from it `
    + 'or asks you to act in it; when the person names a service, use that one alone. Never open another '
    + 'service to gather background — use what you already know, since each service you open may ask the '
    + 'person for access. If the request needs a service that is not in this list, say you cannot reach it '
    + `— never use a different service in its place. Call ${FIND_TOOLS} for every request that needs a service, `
    + 'even if earlier messages show access being asked for: only the call can tell whether access has been '
    + 'given since, and only a call ties this request to a card. If a tool says access is needed, a card asking '
    + 'for it has already been posted: tell the person in one short sentence and stop.';
}
