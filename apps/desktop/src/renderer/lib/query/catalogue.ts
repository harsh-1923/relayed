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
import type { ReplicaActor } from '../../../preload/api';
import { topic } from '../../../shared/topics.ts';

/** Every read the live-query client owns: its arguments and its row type. */
export interface Queries {
  'actors.list': { args: undefined; rows: ReplicaActor[] };
}

export type QueryName = keyof Queries;

type TopicsFor = { [Name in QueryName]: (args: Queries[Name]['args']) => readonly string[] };

export const TOPICS: TopicsFor = {
  'actors.list': () => [topic.actors()],
};
