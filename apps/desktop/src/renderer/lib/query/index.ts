// `useQuery` — the only way a component reads (invariant 60).
//
// One subscription per (name, args), over useSyncExternalStore rather than
// useState so a push and a render can never disagree about which is newer
// (FRONTEND.md §5.3).
//
// Not TanStack Query, and that was a decision rather than an omission: every
// one of its core features exists to avoid a network round trip, and a local
// read is about a millisecond. We would be switching most of it off to stop it
// fighting our invalidation (FRONTEND.md §5.2).
//
// Two exports, and only one of them is for surfaces:
//
//   useQuery(name)            what a component calls. Reads AND subscribes —
//                             there is no second, more-live version of it.
//   useQueryInvalidation()    plumbing. Called once by the shell to connect the
//                             registry to the engine. Never by a surface.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { bridge, call } from '@/lib/ipc';
import { useSession } from '@/app/state';
import { INVALIDATE_CHANNEL } from '../../../shared/topics.ts';
import { createRegistry, type Registry } from './registry.ts';
import { TOPICS, type Queries, type QueryName } from './catalogue.ts';

export type { QueryName } from './catalogue.ts';

/**
 * The three-state matrix (FRONTEND.md §6.2), plus the transient before the
 * first read lands.
 *
 * `loading` is not in that table and is not decoration: the first local read is
 * sub-millisecond but not free, and a surface rendering its empty copy for that
 * millisecond tells the user "nothing here" about a directory that is about to
 * appear. Telling those two apart is the point of the matrix.
 */
export type QueryStatus = 'loading' | 'empty' | 'offline' | 'live';

export interface QueryResult<Rows> {
  /** Null until the first read completes. Never null to mean "empty". */
  rows: Rows | null;
  status: QueryStatus;
  /** A read that failed. The last good rows are kept alongside it. */
  error: string | null;
}

/**
 * The registry, wired to the bridge.
 *
 * `api.query` is overloaded per op and this is the one place that calls it
 * dynamically — which is exactly the call `renderer/no-direct-query` exists to
 * keep confined here.
 */
const registry: Registry = createRegistry((name, args) =>
  call(api => (api.query as (op: string, params?: unknown) => Promise<unknown>)(name, args)));

/**
 * Connect the registry to the engine's invalidations. Called once, by the shell.
 *
 * NOT a read, and not what makes a read live — `useQuery` is already live on its
 * own. This is the wiring underneath it: without it the pushes arrive and reach
 * nobody, and every mounted read quietly keeps whatever it fetched on mount.
 *
 * A hook rather than a module-load side effect so the subscription has a real
 * teardown — a bare `subscribe()` at import time survives hot reload as a
 * duplicate, and a duplicated invalidation is a double refetch that looks like
 * a registry bug.
 */
export function useQueryInvalidation(): void {
  const { state } = useSession();
  const epoch = state.epoch;

  useEffect(() => {
    const api = bridge();
    return api?.subscribe(INVALIDATE_CHANNEL,
      ({ topics }) => { registry.invalidate(topics); });
  }, []);

  // A workspace switch replaces the replica underneath every mounted read, so
  // all of them are answering about a database we are no longer in. Wired once
  // here rather than by each surface watching `state.epoch` — the version
  // People.tsx used to carry, which worked only because it was the one surface.
  const seenEpoch = useRef(epoch);
  useEffect(() => {
    if (seenEpoch.current === epoch) return;
    seenEpoch.current = epoch;
    registry.invalidateAll();
  }, [epoch]);
}

export function useQuery<Name extends QueryName>(
  name: Name,
  ...rest: Queries[Name]['args'] extends undefined ? [] : [args: Queries[Name]['args']]
): QueryResult<Queries[Name]['rows']> {
  const args = rest[0];
  const { state } = useSession();

  // Keyed on the SERIALISED arguments. useSyncExternalStore resubscribes
  // whenever `subscribe` changes identity, so a caller that rebuilds
  // `{ chatId }` inline every render would otherwise tear down and remount its
  // entry on every render — dropping the rows and refetching each time.
  const argsKey = useMemo(() => JSON.stringify(args ?? null), [args]);

  const subscribe = useCallback(
    (onChange: () => void) => registry.subscribe(name, args, TOPICS[name](args), onChange),
    [name, argsKey],
  );
  const getSnapshot = useCallback(() => registry.snapshot(name, args), [name, argsKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const rows = snapshot.rows as Queries[Name]['rows'] | null;
  return {
    rows,
    error: snapshot.error,
    status: statusOf(snapshot.loaded, rows, state.offline, state.auth.status),
  };
}

function statusOf(
  loaded: boolean, rows: readonly unknown[] | null, offline: boolean, auth: string,
): QueryStatus {
  if (!loaded || rows === null) return 'loading';
  if (rows.length === 0) return 'empty';
  // Phase 1½ has no socket, so `live` is the best available reading of whether
  // sync could be making progress at all: the network is up and the session is
  // good. Phase 2 replaces both halves with the socket's own state.
  return offline || auth !== 'authenticated' ? 'offline' : 'live';
}
