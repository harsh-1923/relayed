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
import type { ReplicaActor, ReplicaSpace, ReplicaMessage } from '../../../preload/api';
import { topic } from '../../../shared/topics.ts';

/** Every read the live-query client owns: its arguments and its row type. */
export interface Queries {
  'actors.list': { args: undefined; rows: ReplicaActor[] };
  'chats.list': { args: undefined; rows: ReplicaSpace[] };
  'messages.list': { args: { chatId: string }; rows: ReplicaMessage[] };
}

export type QueryName = keyof Queries;

type TopicsFor = { [Name in QueryName]: (args: Queries[Name]['args']) => readonly string[] };

export const TOPICS: TopicsFor = {
  'actors.list': () => [topic.actors()],
  // `spaces` for joining or leaving one; `space:<id>` is deliberately absent —
  // a space topic is per-space and this read spans all of them, so it depends
  // on the coarse one. A chat arriving in a space I am in wakes it through
  // `spaces`, which is what `chat.created` invalidates alongside.
  'chats.list': () => [topic.spaces()],
  // Only this chat's messages. `chatState` is NOT here: a read cursor moving
  // changes a badge, not the list, and waking the message pane for it would
  // refetch a hundred rows to repaint a number.
  'messages.list': ({ chatId }) => [topic.messages(chatId)],
};
