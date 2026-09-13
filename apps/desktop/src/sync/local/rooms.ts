// Local rooms, as the sync engine serves them (docs/LOCAL-ROOMS.md §7–§8).
//
// The handlers the screen calls, and what the sync engine does with each report
// the agent runner sends. Kept out of index.ts so the whole loop — send, stream,
// store, end — can be driven in a test with a fake runner and a real store.
//
// ONE WAY IN. The only thing that starts a Claude Code turn is `local.messages.send`,
// which only a person at this machine can call (§15). Nothing arriving over the
// sync plane reaches it.
import { topic } from '../../shared/topics.ts';
import type { AgentStream } from '../../shared/local-rooms.ts';
import { isEffortLevel, isRoomMode, type ApprovalDecision, type RoomMode, type RunnerEvent } from '../../shared/claude.ts';
import type { RunnerLink } from '../runner.ts';
import { isContentPanelType } from '../../shared/panels.ts';
import type { LocalStore } from './store.ts';

export interface LocalRoomsDeps {
  /** The account's store, or null when no account is open. */
  store: () => LocalStore | null;
  runner: Pick<RunnerLink, 'request'>;
  invalidate: (topics: string[]) => void;
  /** Push the live text of a reply to every window. Dropped when none is attached. */
  stream: (data: AgentStream) => void;
  pickFolder: () => Promise<string | null>;
  /** The person's first message in a room was stored. Naming the room is titles.ts's business. */
  onFirstMessage?: (spaceId: string, text: string) => void;
}

export function createLocalRooms(deps: LocalRoomsDeps) {
  const required = (): LocalStore => {
    const store = deps.store();
    if (!store) throw new Error('local rooms need a signed-in account');
    return store;
  };

  const chatTopics = (chatId: string) => [topic.localMessages(chatId), topic.localRooms()];

  const handlers = {
    'local.rooms.list': () => deps.store()?.rooms() ?? [],

    /** One local room as a space, in the replica's shape. One row, or none. */
    'local.space.get': (params: unknown) => {
      const spaceId = (params as { spaceId?: string } | undefined)?.spaceId;
      const space = spaceId ? deps.store()?.space(spaceId) : null;
      return space ? [space] : [];
    },

    /** What only a local room has: its folder, and how Claude runs there. One row, or none. */
    'local.rooms.get': (params: unknown) => {
      const spaceId = (params as { spaceId?: string } | undefined)?.spaceId;
      const settings = spaceId ? deps.store()?.roomSettings(spaceId) : null;
      return settings ? [settings] : [];
    },

    /**
     * Create a room about a folder. Without a `cwd` the person is asked to
     * choose one; cancelling creates nothing and returns null.
     */
    'local.rooms.create': async (params: unknown) => {
      const store = required();
      const given = params as { name?: string; cwd?: string } | undefined;
      const cwd = given?.cwd ?? await deps.pickFolder();
      if (!cwd) return null;
      const created = store.createRoom({ name: given?.name, cwd });
      deps.invalidate([topic.localRooms()]);
      return created;
    },

    /** A side chat, and its panel (PANELS.md §4.1). */
    'local.chats.create': (params: unknown) => {
      const { spaceId, name, kind } = (params ?? {}) as { spaceId?: string; name?: string; kind?: unknown };
      if (!spaceId || typeof name !== 'string') throw new Error('spaceId and name required');
      if (kind !== 'public' && kind !== 'private') throw new Error('kind must be public or private');
      const created = required().createChat(spaceId, { name, kind });
      deps.invalidate([topic.localRooms(), topic.localPanels(spaceId)]);
      return created;
    },

    'local.panels.list': (params: unknown) => {
      const spaceId = (params as { spaceId?: string } | undefined)?.spaceId;
      return spaceId ? deps.store()?.panels(spaceId) ?? [] : [];
    },

    /**
     * Open a content panel on this device (PANELS.md §5.1). Returns its id; the
     * same thing opened twice in a room is the same panel.
     */
    'local.panels.open': (params: unknown) => {
      const given = (params ?? {}) as {
        spaceId?: string; workspaceId?: string | null; type?: unknown; payload?: unknown; title?: string | null; openedFromChatId?: string | null;
      };
      if (!given.spaceId) throw new Error('spaceId required');
      if (!isContentPanelType(given.type)) throw new Error('type must be a content panel type');
      if (!given.payload || typeof given.payload !== 'object') throw new Error('payload required');
      const id = required().openLocalPanel({
        spaceId: given.spaceId, workspaceId: given.workspaceId ?? null, type: given.type,
        payload: given.payload as Record<string, unknown>, title: given.title ?? null, openedFromChatId: given.openedFromChatId ?? null,
      });
      deps.invalidate([topic.localPanels(given.spaceId)]);
      return { id };
    },

    /** Looked at, so kept from the sweep. Changes nothing a reader shows, so wakes nobody. */
    'local.panels.touch': (params: unknown) => {
      const panelId = (params as { panelId?: string } | undefined)?.panelId;
      if (!panelId) throw new Error('panelId required');
      required().touchLocalPanel(panelId);
      return null;
    },

    /** Share a local panel into its local room, so it goes with the room at publish (§5.2). */
    'local.panels.share': (params: unknown) => {
      const panelId = (params as { panelId?: string } | undefined)?.panelId;
      if (!panelId) throw new Error('panelId required');
      const store = required();
      const spaceId = store.panelSpace(panelId);
      store.sharePanelLocally(panelId);
      if (spaceId) deps.invalidate([topic.localPanels(spaceId)]);
      return null;
    },

    'local.panels.remove': (params: unknown) => {
      const panelId = (params as { panelId?: string } | undefined)?.panelId;
      if (!panelId) throw new Error('panelId required');
      const store = required();
      const spaceId = store.panelSpace(panelId);
      store.removePanel(panelId);
      if (spaceId) deps.invalidate([topic.localPanels(spaceId)]);
      return null;
    },

    'local.messages.list': (params: unknown) => {
      const chatId = (params as { chatId?: string } | undefined)?.chatId;
      return chatId ? deps.store()?.messages(chatId) ?? [] : [];
    },

    'local.drafts.get': (params: unknown) => {
      const chatId = (params as { chatId?: string } | undefined)?.chatId;
      return chatId ? deps.store()?.draft(chatId) ?? [] : [];
    },

    'local.drafts.save': (params: unknown) => {
      const { chatId, body, revision } = (params ?? {}) as { chatId?: string; body?: string; revision?: number };
      if (!chatId || typeof revision !== 'number') throw new Error('chatId and revision required');
      required().saveDraft(chatId, body ?? '', revision);
      deps.invalidate([topic.localDraft(chatId)]);
      return null;
    },

    /**
     * Send, and start Claude's reply (§8.2). Returns once both rows are on disk;
     * the reply arrives as reports from the runner.
     */
    'local.messages.send': async (params: unknown) => {
      const store = required();
      const { chatId, body, draftRevision } = (params ?? {}) as { chatId?: string; body?: string; draftRevision?: number };
      const text = (body ?? '').trim();
      if (!chatId || text.length === 0) throw new Error('chatId and body required');
      const context = store.turnContext(chatId);
      if (!context) throw new Error(`no local chat ${chatId}`);

      const { messageId, replyId } = store.beginTurn(chatId, text, draftRevision);
      deps.invalidate([...chatTopics(chatId), topic.localDraft(chatId)]);
      if (deps.onFirstMessage && store.sentCount(context.spaceId) === 1) deps.onFirstMessage(context.spaceId, text);

      try {
        await deps.runner.request('turn.start', {
          chatId, messageId: replyId, cwd: context.cwd, mode: context.mode as RoomMode,
          model: context.model, effort: context.effort, sessionId: context.sessionId, text,
        });
      } catch (error) {
        // The runner is down or refused: the reply cannot happen, and a row
        // left "writing" would say otherwise.
        store.finishTurn(replyId, 'failed', [], error instanceof Error ? error.message : String(error));
        deps.invalidate(chatTopics(chatId));
      }
      return { id: messageId, replyId };
    },

    /**
     * How Claude may act in a room. Stored first, so the next child starts in
     * it; then told to the runner for the children already running. A runner
     * that is down has none to tell.
     */
    'local.rooms.setMode': async (params: unknown) => {
      const { spaceId, mode } = (params ?? {}) as { spaceId?: string; mode?: unknown };
      if (!spaceId || !isRoomMode(mode)) throw new Error('spaceId and a room mode required');
      const chatIds = required().setMode(spaceId, mode);
      deps.invalidate([topic.localRooms()]);
      await deps.runner.request('room.mode', { chatIds, mode }).catch(() => {});
      return null;
    },

    /**
     * The room's model and effort; null for either is the default. Which models
     * exist is Claude Code's list, so a name it does not know fails at the next
     * message with its own reason rather than here.
     */
    'local.rooms.setModel': async (params: unknown) => {
      const { spaceId, model, effort } = (params ?? {}) as { spaceId?: string; model?: unknown; effort?: unknown };
      if (!spaceId) throw new Error('spaceId required');
      if (model !== null && (typeof model !== 'string' || model.trim() === '')) throw new Error('model must be a name or null');
      if (effort !== null && !isEffortLevel(effort)) throw new Error('effort must be a level or null');
      const chatIds = required().setModel(spaceId, model, effort);
      deps.invalidate([topic.localRooms()]);
      await deps.runner.request('room.model', { chatIds, model, effort }).catch(() => {});
      return null;
    },

    'local.approvals.list': (params: unknown) => {
      const chatId = (params as { chatId?: string } | undefined)?.chatId;
      return chatId ? deps.store()?.approvals(chatId) ?? [] : [];
    },

    /**
     * The person's answer to what Claude is waiting on (§8.5). The row goes as
     * soon as the runner accepts it. One the runner no longer holds — its turn
     * ended in the meantime — goes too, and the refusal is passed on.
     */
    'local.approvals.respond': async (params: unknown) => {
      const store = required();
      const { chatId, approvalId, decision } = (params ?? {}) as { chatId?: string; approvalId?: string; decision?: ApprovalDecision };
      if (!chatId || !approvalId || !decision) throw new Error('chatId, approvalId and decision required');
      try {
        await deps.runner.request('approval.respond', { chatId, approvalId, decision });
      } finally {
        if (store.removeApproval(approvalId)) deps.invalidate([topic.localApprovals(chatId)]);
      }
      return null;
    },

    /**
     * The app's /clear: the chat's next message starts a new Claude Code
     * session. Refused while Claude is replying in the room. The old child is
     * closed so it cannot be resumed by accident.
     */
    'local.chats.clearSession': async (params: unknown) => {
      const chatId = (params as { chatId?: string } | undefined)?.chatId;
      if (!chatId) throw new Error('chatId required');
      required().clearSession(chatId, '_New session. Claude no longer sees the messages above._');
      deps.invalidate(chatTopics(chatId));
      await deps.runner.request('turn.stop', { chatId }).catch(() => {});
      return null;
    },

    /** Stop Claude mid-reply. The turn ends as stopped, keeping what it wrote. */
    'local.turn.stop': async (params: unknown) => {
      const chatId = (params as { chatId?: string } | undefined)?.chatId;
      if (!chatId) throw new Error('chatId required');
      await deps.runner.request('turn.stop', { chatId });
      return null;
    },
  };

  function onEvent(event: RunnerEvent): void {
    const store = deps.store();
    switch (event.event) {
      case 'turn.delta':
        // Never written: the text IS the diff, already computed (§8.3).
        deps.stream({ messageId: event.messageId, text: event.text, ui: event.ui });
        return;
      case 'turn.parts':
        if (store?.setStreamingParts(event.messageId, event.parts)) deps.invalidate([topic.localMessages(event.chatId)]);
        return;
      case 'approval.requested':
        if (!store) return;
        store.addApproval(event.approval);
        deps.invalidate([topic.localApprovals(event.approval.chatId)]);
        return;
      case 'approval.settled':
        if (store?.removeApproval(event.approvalId)) deps.invalidate([topic.localApprovals(event.chatId)]);
        return;
      case 'turn.session':
        store?.setSession(event.chatId, event.sessionId);
        return;
      case 'turn.done': {
        if (!store) return;
        const outcome = event.outcome === 'completed' ? 'acked' : 'failed';
        const reason = event.outcome === 'stopped' ? 'Stopped.' : event.reason ?? undefined;
        if (store.finishTurn(event.messageId, outcome, event.parts, reason) && event.outcome === 'completed') {
          store.countTurn(event.chatId);
        }
        // A settle report lost on the way would leave an ask for a turn that is over.
        store.clearApprovals([event.chatId]);
        deps.stream({ messageId: event.messageId, text: '', ui: null });
        deps.invalidate([...chatTopics(event.chatId), topic.localApprovals(event.chatId)]);
        return;
      }
    }
  }

  /** The runner went away, and with it every Claude Code child: end what they were writing. */
  function onDetach(): void {
    const store = deps.store();
    if (!store) return;
    const chats = store.failStreaming('The agent runner stopped. Send again to continue.');
    store.clearApprovals();
    if (chats.length > 0) {
      deps.invalidate([...chats.map(topic.localMessages), ...chats.map(topic.localApprovals), topic.localRooms()]);
    }
  }

  return { handlers, onEvent, onDetach };
}
