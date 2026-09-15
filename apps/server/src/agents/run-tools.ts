// The two tools every workspace-agent run is given, instead of a list someone
// picked (docs/WORKSPACE-AGENTS-IMPL.md, step 7, D21). The dispatcher offers
// them; the broker answers them. Defined once here so the names the model is
// told and the names the broker dispatches on cannot drift apart.
import type { RunTool } from '@relayed/protocol';

export const FIND_TOOLS = 'find_tools';
export const CALL_TOOL = 'call_tool';
export const OPEN_PANEL = 'open_panel';

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
  ];
}

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
  return servicesPrompt(toolkits) + (where.inRoom ? ROOM_PROMPT : '');
}

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
