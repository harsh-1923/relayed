// Reading and writing a preference from a surface (PREFERENCES.md §8).
//
// A thin layer over the live-query client rather than a second mechanism: the
// read is `useQuery('prefs.list')` like any other, and every preference on
// screen shares that one subscription.
//
// Why this is not just `useQuery`: a preference is a VALUE, not a list, and
// `QueryStatus` is built for lists. `empty` would be the ordinary case here —
// everything sitting at its default, with nothing ever written — and a surface
// that renders "nothing here" for that is wrong. So this returns the decoded
// value and a plain `loaded`, with the default standing in until the first
// read lands.
import { useCallback, useState } from 'react';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { useSession } from '@/app/state';
import {
  decode, type PreferenceKey, type PreferenceValue,
} from '../../shared/prefs.ts';

export interface PreferenceHandle<K extends PreferenceKey> {
  value: PreferenceValue<K>;
  /** False until the first read lands. `value` is the default until then. */
  loaded: boolean;
  /** True while a write is in flight. */
  saving: boolean;
  /**
   * Whether there is anywhere to store this.
   *
   * False signed out, and that is not a corner case: Account Settings is
   * reachable without an account — the shell has no guard on it — so the
   * surface a preference is changed on renders before there is an `account.db`
   * to change it in. Every key is account-tier today (PREFERENCES.md §4), so
   * one condition covers all of them; a workspace-tier key would add its own.
   *
   * Reading still works and still answers: with no rows, every key is at its
   * default, which is exactly what the window is showing.
   */
  writable: boolean;
  set: (next: PreferenceValue<K>) => void;
}

export function usePreference<K extends PreferenceKey>(key: K): PreferenceHandle<K> {
  const { rows, status } = useQuery('prefs.list');
  const { state } = useSession();
  const [saving, setSaving] = useState(false);

  // No optimistic local copy, deliberately. The write is a local UPSERT and an
  // invalidation — about a millisecond — and the repaint comes back through the
  // registry like any other change, which is what makes a second window agree.
  // A `useState` mirror here would be exactly the renderer-side authoritative
  // state the read path exists to remove (DESIGN.md §11.2).
  const set = useCallback((next: PreferenceValue<K>) => {
    setSaving(true);
    void (async () => {
      try {
        await call(api => api.query('prefs.set', { key, value: next }));
      } catch {
        // A local IPC call against a value the catalogue already allows, so
        // this should not happen — but an unhandled rejection out of a
        // `void`-invoked handler is the trap this codebase has walked into
        // before (invariant 54). The next read re-paints whatever is actually
        // stored, so there is nothing to roll back.
      } finally {
        setSaving(false);
      }
    })();
  }, [key]);

  return {
    value: decode(key, rows),
    loaded: status !== 'loading',
    saving,
    writable: state.accountId !== null,
    set,
  };
}
