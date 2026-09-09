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
  invalidate(topics: readonly string[]): void;
  /** Everything is suspect — the replica underneath us was replaced. */
  invalidateAll(): void;
  /** Mounted entry count. For tests and, later, for a metric. */
  readonly size: number;
}

export function createRegistry(run: RunQuery): Registry {
  const entries = new Map<string, Entry>();

  function load(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    const generation = entry.generation;

    void run(entry.name, entry.args).then(
      rows => settle(key, generation, rows, null),
      (err: unknown) => settle(key, generation, undefined, message(err)),
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
        load(key);
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

    invalidate(topics) {
      if (topics.length === 0) return;
      for (const [key, entry] of entries) {
        if (!topicsTouched(entry.topics, topics)) continue;
        entry.generation += 1;
        load(key);
      }
    },

    invalidateAll() {
      for (const [key, entry] of entries) {
        entry.generation += 1;
        load(key);
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
