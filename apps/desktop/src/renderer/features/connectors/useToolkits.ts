// The offered catalogue, read over the socket (WORKSPACE-AGENTS.md §7.1).
// Online-only: never in the replica, so this is the one connector read that
// can be offline instead of merely empty.
import { useCallback, useEffect, useState } from 'react';
import type { ToolkitSummary } from '../../../preload/api';
import { call } from '@/lib/ipc';

export type ToolkitsState =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'ready'; toolkits: ToolkitSummary[] };

export function useToolkits() {
  const [state, setState] = useState<ToolkitsState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const answer = await call(api => api.query('toolkits.list'));
      if (!answer || answer.offline) { setState({ status: 'offline' }); return; }
      setState({ status: 'ready', toolkits: answer.toolkits });
    } catch {
      setState({ status: 'offline' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { state, reload: load };
}
