// Named reads, and the topics each one depends on.
//
// The dependency is declared HERE, next to the query, rather than at the call
// site. Two reasons: the registry can route an invalidation without inspecting
// arguments, and a surface cannot get its own dependencies wrong — there is
// one answer per query, not one per component that happens to mount it.
//
// The boundary rule `renderer/no-direct-query` reads the keys of TOPICS as its
// source of truth, so adding a read here is what makes it enforceable
// everywhere else. Nothing to remember.
import type {
  ClaudeCommand, ClaudeStatus, ComposerDraft, LocalRoom, LocalRoomSettings, PendingApproval, ReplicaActor, ReplicaMessage, Panel, PreferenceRow, Space,
} from '../../../preload/api';
import { topic } from '../../../shared/topics.ts';

/** Every read the live-query client owns: its arguments and its row type. */
export interface Queries {
  'actors.list': { args: undefined; rows: ReplicaActor[] };
  'spaces.list': { args: undefined; rows: Space[] };
  'space.get': { args: { spaceId: string }; rows: Space[] };
  'messages.list': { args: { chatId: string }; rows: ReplicaMessage[] };
  'prefs.list': { args: undefined; rows: PreferenceRow[] };
  'claude.status': { args: undefined; rows: ClaudeStatus[] };
  'local.rooms.list': { args: undefined; rows: LocalRoom[] };
  'local.space.get': { args: { spaceId: string }; rows: Space[] };
  'local.rooms.get': { args: { spaceId: string }; rows: LocalRoomSettings[] };
  'local.panels.list': { args: { spaceId: string }; rows: Panel[] };
  'local.messages.list': { args: { chatId: string }; rows: ReplicaMessage[] };
  'local.approvals.list': { args: { chatId: string }; rows: PendingApproval[] };
  'local.commands.list': { args: { chatId: string }; rows: ClaudeCommand[] };
  'drafts.get': { args: { chatId: string }; rows: ComposerDraft[] };
  'local.drafts.get': { args: { chatId: string }; rows: ComposerDraft[] };
}

export type QueryName = keyof Queries;

type TopicsFor = { [Name in QueryName]: (args: Queries[Name]['args']) => readonly string[] };

export const TOPICS: TopicsFor = {
  'actors.list': () => [topic.actors()],
  // `spaces` for joining or leaving one; `space:<id>` is deliberately absent —
  // a space topic is per-space and this read spans all of them, so it depends
  // on the coarse one. A chat arriving in a space I am in wakes it through
  // `spaces`, which is what `chat.created` invalidates alongside.
  'spaces.list': () => [topic.spaces()],
  // `spaces` as well as the space's own topic: a rename or a new chat arrives
  // on the space stream, which invalidates both.
  'space.get': ({ spaceId }) => [topic.space(spaceId), topic.spaces()],
  // Only this chat's messages. `chatState` is NOT here: a read cursor moving
  // changes a badge, not the list, and waking the message pane for it would
  // refetch a hundred rows to repaint a number.
  'messages.list': ({ chatId }) => [topic.messages(chatId)],
  // The COARSE topic, against writes that name a single key. `topicsIntersect`
  // matches them because one is a prefix of the other, so this wakes on any
  // preference while a future per-key subscription stays possible
  // (PREFERENCES.md §8).
  'prefs.list': () => [topic.prefs()],
  // Not replica data, and not per workspace: a fact about this machine, woken
  // when a probe finishes.
  'claude.status': () => [topic.claude()],
  'local.rooms.list': () => [topic.localRooms()],
  // Every write to a local room — a rename, a new chat, a mode, a reply starting
  // or ending — already wakes `local:rooms`, so both single-room reads ride it.
  'local.space.get': () => [topic.localRooms()],
  'local.rooms.get': () => [topic.localRooms()],
  'local.panels.list': ({ spaceId }) => [topic.localPanels(spaceId)],
  'local.messages.list': ({ chatId }) => [topic.localMessages(chatId)],
  'local.approvals.list': ({ chatId }) => [topic.localApprovals(chatId)],
  'local.commands.list': () => [topic.localCommands()],
  'drafts.get': ({ chatId }) => [topic.draft(chatId)],
  'local.drafts.get': ({ chatId }) => [topic.localDraft(chatId)],
};
