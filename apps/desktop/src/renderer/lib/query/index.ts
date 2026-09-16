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
import { emit, count, histogram } from '@/lib/telemetry';
import { useSession } from '@/app/state';
import { INVALIDATE_CHANNEL } from '../../../shared/topics.ts';
import { createRegistry, type Registry, type RegistryReport } from './registry.ts';
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
 * What the read path reports (OBSERVABILITY.md §10b).
 *
 * The event carries ids and the metric carries the aggregate, because they
 * answer different questions under different constraints. `ui.query.read`
 * reconstructs one user's loop and is gone in 14 days; `ui.query.duration` is
 * how we know a local read is still about a millisecond, which not adopting a
 * server-state cache and refetching coarsely both rest on.
 */
const report: RegistryReport = {
  read: (info) => {
    const ms = Math.round(info.ms * 100) / 100;
    histogram('ui.query.duration', ms,
              { trigger: info.trigger, result: info.ok ? 'ok' : 'error' });
    emit('ui.query.read', {
      invalidation: info.invalidation, query: info.name, topic: info.topic,
      trigger: info.trigger, rows: info.rows, ms,
    });
  },
  delivered: (info) => {
    histogram('ui.query.woken', info.matched);
    emit('ui.invalidation.received', info);
  },
};

/**
 * The registry, wired to the bridge.
 *
 * `api.query` is overloaded per op and this is the one place that calls it
 * dynamically — which is exactly the call `renderer/no-direct-query` exists to
 * keep confined here.
 */
const registry: Registry = (import.meta.hot?.data['registry'] as Registry | undefined) ?? createRegistry(
  (name, args) =>
    call(api => (api.query as (op: string, params?: unknown) => Promise<unknown>)(name, args)),
  report,
);

// ONE REGISTRY ACROSS HOT RELOADS, development only. Editing this module or the
// catalogue re-runs it, and a fresh registry here is a split brain: remounted
// reads subscribe to the new one while the shell's `useQueryInvalidation` —
// whose effect does not re-run — keeps delivering pushes to the old one, now
// empty. Every write then lands and nothing repaints (`ui.invalidation.received`
// reads `mounted=0`). Seen when a local room was created and sent to after a
// catalogue edit. Editing registry.ts itself still needs a window reload.
if (import.meta.hot) import.meta.hot.data['registry'] = registry;

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
      ({ invalidation, topics }) => { registry.invalidate(topics, invalidation); });
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

  // The two suppressions below are that same decision, stated. `args` IS a
  // dependency and IS deliberately excluded: `argsKey` is its serialisation and
  // the only stable form of it. Listing `args` would restore the exact bug the
  // key exists to prevent — so the rule is right about the shape and wrong about
  // this case, which is what a suppression with a reason is for.
  const subscribe = useCallback(
    (onChange: () => void) => registry.subscribe(name, args, TOPICS[name](args), onChange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, argsKey],
  );
  const getSnapshot = useCallback(
    () => registry.snapshot(name, args),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, argsKey],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const rows = snapshot.rows as Queries[Name]['rows'] | null;
  const status = statusOf(snapshot.loaded, rows, state.offline, state.auth.status);

  // Counted on TRANSITION, not per render — React renders far too often for the
  // latter to mean anything. It answers a product question nothing else can:
  // how often is anyone actually offline with data, which is the state this
  // whole architecture exists to make ordinary.
  const seenStatus = useRef<QueryStatus | null>(null);
  useEffect(() => {
    if (seenStatus.current === status) return;
    seenStatus.current = status;
    count('ui.surface.state', { surface: status });
  }, [status]);

  return { rows, error: snapshot.error, status };
}

/**
 * `useQuery`, narrowed to one derived value: the component re-renders only when
 * `select` returns something that is not `Object.is` the last answer. Every
 * caller still shares the one entry per (name, args).
 *
 * `select` must be pure and return a STABLE value for unchanged input — an
 * object built fresh on every call re-renders every time, which is exactly
 * what this exists to avoid.
 */
export function useQuerySelect<Name extends QueryName, Value>(
  name: Name,
  args: Queries[Name]['args'],
  select: (rows: Queries[Name]['rows'] | null) => Value,
): Value {
  const argsKey = useMemo(() => JSON.stringify(args ?? null), [args]);
  const subscribe = useCallback(
    (onChange: () => void) => registry.subscribe(name, args, TOPICS[name](args), onChange),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on argsKey, as in useQuery
    [name, argsKey],
  );
  const getSnapshot = useCallback(
    () => select(registry.snapshot(name, args).rows as Queries[Name]['rows'] | null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on argsKey, as in useQuery
    [name, argsKey, select],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
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
