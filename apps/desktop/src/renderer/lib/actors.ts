// Who an actor id is, for anything that draws one (a mention, an avatar, "by
// Alice"). Read from the local directory, which the shell keeps live for the
// whole session, so resolving an id never waits and never refetches on mount.
//
//   useActor(id)       one actor; re-renders only when THAT actor changes
//   useActorLookup()   a lookup function, for code resolving many ids at once
//
// Components that need the whole list — pickers, the composer's autocomplete —
// keep calling `useQuery('actors.list')`; it is the same shared read.
import { useCallback } from 'react';
import type { ReplicaActor } from '../../preload/api';
import { useQuery, useQuerySelect } from '@/lib/query';

/**
 * A local room's two actors. They are not in any workspace directory, so they
 * are part of every index rather than special-cased where they are drawn.
 */
export const LOCAL_ACTORS: readonly ReplicaActor[] = [
  { id: 'act_local_me', workspaceId: 'local', type: 'human', handle: 'me', displayName: 'You', avatarUrl: null, avatarBlob: null, ownerActorId: null, state: 'active', updatedAt: 0, agent: null },
  { id: 'act_local_agent', workspaceId: 'local', type: 'agent', handle: 'agent', displayName: 'Claude Agent', avatarUrl: null, avatarBlob: null, ownerActorId: 'act_local_me', state: 'active', updatedAt: 0,
    agent: { description: 'Your Claude Code, in this room', configRev: 1, toolkits: [] } },
];

type ActorIndex = ReadonlyMap<string, ReplicaActor>;

const LOCAL_INDEX: ActorIndex = new Map(LOCAL_ACTORS.map(actor => [actor.id, actor]));
const indexes = new WeakMap<readonly ReplicaActor[], ActorIndex>();
let previous: ActorIndex = LOCAL_INDEX;

/**
 * Every read of the directory returns fresh objects. An actor whose fields did
 * not change keeps the object it had, so `useActor` for everyone else sees the
 * same value and does not re-render when one avatar arrives.
 */
const same = (a: ReplicaActor, b: ReplicaActor): boolean =>
  a.updatedAt === b.updatedAt && a.displayName === b.displayName && a.handle === b.handle
  && a.avatarBlob === b.avatarBlob && a.avatarUrl === b.avatarUrl && a.state === b.state
  && a.type === b.type && a.ownerActorId === b.ownerActorId && a.workspaceId === b.workspaceId
  && JSON.stringify(a.agent) === JSON.stringify(b.agent);

function indexOf(rows: readonly ReplicaActor[] | null): ActorIndex {
  if (!rows) return previous;
  const known = indexes.get(rows);
  if (known) return known;
  const next = new Map(LOCAL_INDEX);
  for (const row of rows) {
    const before = previous.get(row.id);
    next.set(row.id, before && same(before, row) ? before : row);
  }
  indexes.set(rows, next);
  previous = next;
  return next;
}

/** Called once, by the shell: the directory read stays mounted for the whole session. */
export function useActorDirectory(): void {
  useQuery('actors.list');
}

/** One actor, or undefined while the directory has not got them yet. */
export function useActor(id: string | null | undefined): ReplicaActor | undefined {
  const select = useCallback(
    (rows: readonly ReplicaActor[] | null) => (id ? indexOf(rows).get(id) : undefined),
    [id],
  );
  return useQuerySelect('actors.list', undefined, select);
}

/** Resolve many ids. Re-renders when any actor changes, so prefer `useActor` for one. */
export function useActorLookup(): (id: string | null | undefined) => ReplicaActor | undefined {
  const index = useQuerySelect('actors.list', undefined, indexOf);
  return useCallback(id => (id ? index.get(id) : undefined), [index]);
}
