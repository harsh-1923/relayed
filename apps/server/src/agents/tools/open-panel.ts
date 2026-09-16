// Opening a page beside the chat, for everyone in the room (docs/PANELS.md).
import type { RunTool } from '@relayed/protocol';
import {
  openRoomPanel, roomPanelUrl, NotARoomError, PrivateChatError, type UrlRefusal,
} from '../../sync/panels.ts';
import { asText, type AppTool } from './contract.ts';

export const OPEN_PANEL = 'open_panel';

/** Why a URL was refused, said the way the model should repeat it to a person. */
const URL_REFUSALS: Record<UrlRefusal, string> = {
  not_a_url: 'That is not a URL.',
  not_https: 'Only https pages can be opened for the room.',
  private_address: 'That address is local or private, so it would not open the same page for everyone — it cannot be opened for the room.',
  credentials: 'A URL carrying a username or password cannot be opened for the room.',
  too_long: 'That URL is too long to open.',
};

/**
 * Only in a room: a room is where people gather to get one thing done, and the
 * page the work happens on — the ticket, the dashboard, the document — is what
 * they want in front of them, not a link in a reply.
 */
const DEFINITION: RunTool = {
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

/**
 * Nothing of the invoker's account is spent, so there is no permission or
 * connection check — only that the page is one every member's app may safely
 * load, and that the chat belongs to a room.
 */
export const openPanel: AppTool = {
  name: OPEN_PANEL,
  definition: where => (where.inRoom ? DEFINITION : null),
  prompt: () => `\n\nThis chat is in a room, where people work on one thing together. When you create, `
    + `find or change something that lives on a web page — a ticket, a dashboard, a trace, a document — open that `
    + `page with ${OPEN_PANEL} so everyone in the room sees it beside the conversation. Open only the pages the `
    + 'work is about, and say in your reply what you opened.',

  handle: async (deps, run, args) => {
    const checked = roomPanelUrl(asText(args['url']));
    if (!checked.ok) return { result: 'failed', message: URL_REFUSALS[checked.reason] };
    const rawTitle = asText(args['title']);

    try {
      const { panel, event } = await openRoomPanel(deps.db, {
        chatId: run.chatId, url: checked.url, title: rawTitle ? rawTitle.slice(0, 80) : null,
        createdBy: run.agentActorId, onBehalfOf: run.invokerActorId,
      });
      await deps.deliver(event);
      const opened = 'url' in panel.payload ? panel.payload.url : checked.url;
      return { result: 'ok', data: { opened: true, url: opened, title: panel.title } };
    } catch (err) {
      if (err instanceof NotARoomError || err instanceof PrivateChatError) return { result: 'tool_not_allowed' };
      throw err;
    }
  },
};
