// The live-query registry: the client half of the read path (DESIGN.md §11).
//
// The renderer holds no authoritative state. It asks the sync engine for rows,
// renders them, and waits to be told that what it read is no longer known-good.
// The registry is the thing that knows which mounted reads a given change
// affects, so an invalidation refetches what is on screen and nothing else.
//
// Deliberately free of React and of the bridge, both injected: this file is the
// part with the ordering hazards in it, and it is worth being able to test the
// hazards directly rather than through a component tree. `node --test` runs .ts
// but not .tsx, so that is not only a preference.
import { topicsTouched } from '../../../shared/topics.ts';

/** Issues one read against the sync engine. Null means "no usable answer". */
export type RunQuery = (name: string, args: unknown) => Promise<unknown>;

/** What caused a read. `epoch` is a workspace switch replacing the replica. */
export type Trigger = 'mount' | 'invalidate' | 'epoch';

/**
 * Where this reports to, injected for the same reason the runner is: the
 * registry stays testable without a bridge or an SDK behind it.
 *
 * `invalidation` is 0 for a mount, so a non-zero value on a read is exactly the
 * set of reads the live-query loop caused — which is the number that says the
 * loop is working at all.
 */
export interface RegistryReport {
  read(info: {
    invalidation: number; name: string; topic: string;
    trigger: Trigger; rows: number; ms: number; ok: boolean;
  }): void;
  delivered(info: { invalidation: number; mounted: number; matched: number }): void;
}

const SILENT: RegistryReport = { read: () => {}, delivered: () => {} };

export interface Snapshot {
  /** Null until the first read completes — NOT an empty result. */
  rows: unknown;
  loaded: boolean;
  error: string | null;
}

const NOTHING: Snapshot = { rows: null, loaded: false, error: null };

interface Entry {
  name: string;
  args: unknown;
  topics: readonly string[];
  /** Replaced, never mutated: useSyncExternalStore compares by identity. */
  snapshot: Snapshot;
  /** How many mounted components share this entry. */
  refs: number;
  /**
   * Bumped by every refetch AND by teardown, and captured by each read.
   *
   * It is what makes a reply drop when it is no longer the answer to the
   * current question — the component unmounted, or a second invalidation
   * overtook the first. Without it two invalidations in quick succession
   * resolve to whichever reply the port happened to return last.
   */
  generation: number;
  listeners: Set<() => void>;
}

export interface Registry {
  /** Mount a read. Returns the teardown; call it exactly once. */
  subscribe(
    name: string, args: unknown, topics: readonly string[], onChange: () => void,
  ): () => void;
  snapshot(name: string, args: unknown): Snapshot;
  /** The write side told us something changed. Refetch what reads it. */
  invalidate(topics: readonly string[], invalidation?: number): void;
  /** Everything is suspect — the replica underneath us was replaced. */
  invalidateAll(): void;
  /** Mounted entry count. For tests and, later, for a metric. */
  readonly size: number;
}

export function createRegistry(run: RunQuery, report: RegistryReport = SILENT): Registry {
  const entries = new Map<string, Entry>();

  function load(key: string, trigger: Trigger, invalidation: number): void {
    const entry = entries.get(key);
    if (!entry) return;
    const generation = entry.generation;
    const started = performance.now();

    const done = (rows: unknown, error: string | null): void => {
      report.read({
        invalidation, name: entry.name,
        // The first declared topic. A read with several is rare and the leading
        // one is the one that identifies it; carrying a list would need a field
        // type the catalogue does not have.
        topic: entry.topics[0] ?? '',
        trigger,
        rows: Array.isArray(rows) ? rows.length : 0,
        ms: performance.now() - started,
        ok: error === null,
      });
      settle(key, generation, rows, error);
    };

    void run(entry.name, entry.args).then(
      rows => done(rows, null),
      (err: unknown) => done(undefined, message(err)),
    );
  }

  function settle(key: string, generation: number, rows: unknown, error: string | null): void {
    const entry = entries.get(key);
    // Three ways a reply stops being wanted, and all three are ordinary:
    // the entry was torn down while it was in flight, a later refetch
    // superseded it, or it belongs to the workspace we just left — which the
    // bridge reports as null rather than as a failure (STORAGE.md §12.1).
    if (!entry || entry.generation !== generation) return;
    if (error === null && rows === null) return;

    entry.snapshot = error === null
      ? { rows, loaded: true, error: null }
      // Keep whatever we last read. Reporting a failed read as an empty result
      // would render "nothing here" over a populated replica, which is the one
      // failure a local-first app must never produce (FRONTEND.md §6.2).
      : { rows: entry.snapshot.rows, loaded: entry.snapshot.loaded, error };
    for (const listener of entry.listeners) listener();
  }

  return {
    subscribe(name, args, topics, onChange) {
      const key = keyOf(name, args);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          name, args, topics, snapshot: NOTHING,
          refs: 0, generation: 0, listeners: new Set(),
        };
        entries.set(key, entry);
        load(key, 'mount', 0);
      }
      const mounted = entry;
      mounted.refs += 1;
      mounted.listeners.add(onChange);

      return () => {
        mounted.listeners.delete(onChange);
        mounted.refs -= 1;
        if (mounted.refs > 0) return;
        // Dropped outright, with no retention window. A local read is about a
        // millisecond, so holding rows for a component that may come back buys
        // nothing and costs a "how stale is this?" question with no good answer.
        mounted.generation += 1;
        entries.delete(key);
      };
    },

    snapshot(name, args) {
      return entries.get(keyOf(name, args))?.snapshot ?? NOTHING;
    },

    invalidate(topics, invalidation = 0) {
      if (topics.length === 0) return;
      let matched = 0;
      for (const [key, entry] of entries) {
        if (!topicsTouched(entry.topics, topics)) continue;
        matched += 1;
        entry.generation += 1;
        load(key, 'invalidate', invalidation);
      }
      // Reported even when nothing matched — ESPECIALLY then. A push that woke
      // nothing is the signature of a topic the write side and the read side
      // disagree about, and it is otherwise completely silent.
      report.delivered({ invalidation, mounted: entries.size, matched });
    },

    invalidateAll() {
      for (const [key, entry] of entries) {
        entry.generation += 1;
        load(key, 'epoch', 0);
      }
    },

    get size() { return entries.size; },
  };
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * One entry per (name, args). Keys are order-independent, so `{a:1,b:2}` and
 * `{b:2,a:1}` are the same read rather than two — otherwise a component that
 * builds its arguments in a different order silently gets its own entry, its
 * own fetch, and its own chance to go stale.
 */
function keyOf(name: string, args: unknown): string {
  return `${name}::${stable(args)}`;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`;
}
