// Settings → Connectors: the connector store's Yours list (WORKSPACE-AGENTS.md
// §7.1) — every toolkit Relayed offers, with this actor's own connection
// status beside it.
//
// Not yet built: the toolkit detail page (§7.2, its tools grouped by effect,
// the auth guide link) and the "Agents you allowed" section (§7.4) — this is
// the flat list alone, enough to connect and disconnect by hand.
import { useState } from 'react';
import type { ConnectionRow, ToolkitSummary } from '../../preload/api';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { useToolkits } from '@/features/connectors/useToolkits';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const STATUS_LABEL: Record<ConnectionRow['status'], string> = {
  connecting: 'Connecting…',
  active: 'Connected',
  needs_reauth: 'Needs reconnecting',
  failed: 'Failed to connect',
  disconnected: 'Not connected',
};

function ToolkitRow({ toolkit, connection, onChanged }: {
  toolkit: ToolkitSummary;
  connection: ConnectionRow | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = connection?.status;
  const connected = status === 'active' || status === 'needs_reauth';

  async function onConnect() {
    setBusy(true); setError(null);
    try {
      const answer = await call(api => api.query('connections.connect', { toolkit: toolkit.slug }));
      if (!answer) return;
      if (!answer.ok) setError(answer.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function onDisconnect() {
    if (!connection) return;
    setBusy(true); setError(null);
    try {
      const answer = await call(api => api.query('connections.disconnect', { connectionId: connection.id }));
      if (!answer) return;
      if (!answer.ok) setError(answer.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{toolkit.name}</span>
          {toolkit.deprecated && <Badge variant="outline">Deprecated</Badge>}
          {status && <Badge variant={connected ? 'secondary' : 'outline'}>{STATUS_LABEL[status]}</Badge>}
        </div>
        <p className="truncate text-sm text-muted-foreground">{toolkit.description}</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      {connected
        ? <Button variant="outline" disabled={busy} onClick={() => { void onDisconnect(); }}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        : <Button disabled={busy} onClick={() => { void onConnect(); }}>
            {busy ? 'Connecting…' : status === 'failed' ? 'Try again' : 'Connect'}
          </Button>}
    </li>
  );
}

export function SettingsConnectors() {
  const { state, reload } = useToolkits();
  const { rows: connections } = useQuery('connections.list');
  const connectionFor = (slug: string) => connections?.find(c => c.toolkit === slug);

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect an account here once, then allow individual agents to use it from your own connector store or from
        the card an agent raises when it needs access.
      </p>

      {state.status === 'offline' && (
        <Alert variant="destructive"><AlertDescription>
          The catalogue needs a connection. Try again when you are online.
        </AlertDescription></Alert>
      )}
      {state.status === 'loading' && <p className="text-sm text-muted-foreground">Reading…</p>}
      {state.status === 'ready' && state.toolkits.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing is offered here yet.</p>
      )}

      {state.status === 'ready' && (
        <ul className="divide-y rounded-lg border">
          {state.toolkits.map(toolkit => (
            <ToolkitRow key={toolkit.slug} toolkit={toolkit} connection={connectionFor(toolkit.slug)} onChanged={() => { void reload(); }} />
          ))}
        </ul>
      )}
    </div>
  );
}
