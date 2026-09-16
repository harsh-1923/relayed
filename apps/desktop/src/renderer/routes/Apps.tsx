// The workspace's connector store (WORKSPACE-AGENTS.md, where the connector
// store lives §7.1): every toolkit Relayed offers, with this actor's own
// connection status beside it.
//
// Not yet built: the toolkit detail page (§7.2, its tools grouped by effect,
// the auth guide link) and the "Agents you allowed" section (§7.4) — this is
// the flat list alone, enough to connect and disconnect by hand.
import { useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { SearchDefault } from '@relayed/icons';
import type { ConnectionRow, ToolkitLogo as HeldLogo, ToolkitSummary } from '../../preload/api';
import { blobSrc, call, initials } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { createToolkitSearch } from '@/features/apps/search.ts';
import { useToolkits } from '@/features/apps/useToolkits';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const STATUS_LABEL: Record<ConnectionRow['status'], string> = {
  connecting: 'Connecting…',
  active: 'Connected',
  needs_reauth: 'Needs reconnecting',
  failed: 'Failed to connect',
  disconnected: 'Not connected',
};

const NO_TOOLKITS: readonly ToolkitSummary[] = [];
const TOOLKIT_GRID_CLASS_NAME = 'grid gap-x-16 gap-y-7 [grid-template-columns:repeat(auto-fit,minmax(min(100%,30rem),1fr))]';

function ToolkitLogo({ toolkit, logo, size = 'size-10' }: {
  toolkit: ToolkitSummary;
  logo: HeldLogo | undefined;
  size?: 'size-10' | 'size-12';
}) {
  const source = logo ? blobSrc(logo.logoBlob, logo.logoMediaType) : undefined;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <div
      className={`relative flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-sm font-semibold text-muted-foreground after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-border after:mix-blend-darken dark:after:mix-blend-lighten`}
    >
      <span aria-hidden="true">{initials(toolkit.name).slice(0, 1)}</span>
      {source && source !== failedSource ? (
        <img
          src={source}
          alt=""
          className="absolute inset-0 size-full bg-background object-contain p-1.5"
          onError={() => { setFailedSource(source); }}
        />
      ) : null}
    </div>
  );
}

function ToolkitRow({ toolkit, logo, connection, onChanged }: {
  toolkit: ToolkitSummary;
  logo: HeldLogo | undefined;
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
    <li className="flex items-center gap-4 py-4">
      <ToolkitLogo toolkit={toolkit} logo={logo} />
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
        ? <Button variant="destructive" disabled={busy} onClick={() => { void onDisconnect(); }}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        : <Button disabled={busy} onClick={() => { void onConnect(); }}>
            {busy ? 'Connecting…' : status === 'failed' ? 'Try again' : 'Connect'}
          </Button>}
    </li>
  );
}

function AppsContent({ installed }: { installed: boolean }) {
  const navigate = useNavigate();
  const { state, reload } = useToolkits();
  const { rows: connections } = useQuery('connections.list');
  const { rows: logos } = useQuery('toolkits.logos');
  const [search, setSearch] = useState('');
  const offeredToolkits = state.status === 'ready' ? state.toolkits : NO_TOOLKITS;
  const connectionsByToolkit = useMemo(
    () => new Map(connections?.map(connection => [connection.toolkit, connection])),
    [connections],
  );
  const logoFor = (slug: string) => logos?.find(logo => logo.slug === slug);
  const connectionFor = (slug: string) => connectionsByToolkit.get(slug);
  const connectedToolkits = useMemo(
    () => offeredToolkits.filter(toolkit => connectionsByToolkit.get(toolkit.slug)?.status === 'active'),
    [connectionsByToolkit, offeredToolkits],
  );
  const searchToolkits = useMemo(
    () => createToolkitSearch(offeredToolkits),
    [offeredToolkits],
  );
  const toolkits = useMemo(
    () => searchToolkits(search),
    [search, searchToolkits],
  );
  const catalogueToolkits = useMemo(
    () => toolkits.filter(toolkit => connectionsByToolkit.get(toolkit.slug)?.status !== 'active'),
    [connectionsByToolkit, toolkits],
  );

  return (
    <div className="space-y-8">
      {installed ? (
        <section className="space-y-3" aria-labelledby="installed-apps-heading">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 id="installed-apps-heading" className="text-sm font-medium">Installed apps</h2>
              <p className="text-sm text-muted-foreground">Apps your agents can use.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => { void navigate('..', { relative: 'path' }); }}>
              Back to apps
            </Button>
          </div>
          {connectedToolkits.length > 0 ? (
            <ul className={TOOLKIT_GRID_CLASS_NAME}>
              {connectedToolkits.map(toolkit => (
                <ToolkitRow
                  key={toolkit.slug}
                  toolkit={toolkit}
                  logo={logoFor(toolkit.slug)}
                  connection={connectionFor(toolkit.slug)}
                  onChanged={() => { void reload(); }}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No apps are installed yet.</p>
          )}
        </section>
      ) : connectedToolkits.length > 0 && (
        <section className="space-y-3" aria-labelledby="connected-apps-heading">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 id="connected-apps-heading" className="text-sm font-medium">Connected apps</h2>
              <p className="text-sm text-muted-foreground">Ready for your agents to use.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { void navigate('installed'); }}
            >
              Manage
            </Button>
          </div>
          <ul className="flex gap-4 overflow-x-auto pb-1">
            {connectedToolkits.map(toolkit => (
              <li key={toolkit.slug} className="shrink-0" title={toolkit.name} aria-label={toolkit.name}>
                <ToolkitLogo toolkit={toolkit} logo={logoFor(toolkit.slug)} size="size-12" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {!installed && <div className="space-y-4">
        <div className="relative">
          <SearchDefault className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="pl-8"
          />
        </div>
      </div>}

      {!installed && <div className="space-y-4">
        {state.status === 'offline' && (
          <Alert variant="destructive"><AlertDescription>
            The catalogue needs a connection. Try again when you are online.
          </AlertDescription></Alert>
        )}
        {state.status === 'loading' && <p className="text-sm text-muted-foreground">Reading…</p>}
        {state.status === 'ready' && state.toolkits.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing is offered here yet.</p>
        )}
        {state.status === 'ready' && state.toolkits.length > 0 && toolkits.length === 0 && (
          <p className="text-sm text-muted-foreground">No apps match your search.</p>
        )}

        {state.status === 'ready' && catalogueToolkits.length > 0 && (
          <ul className={TOOLKIT_GRID_CLASS_NAME}>
            {catalogueToolkits.map(toolkit => (
              <ToolkitRow key={toolkit.slug} toolkit={toolkit} logo={logoFor(toolkit.slug)} connection={connectionFor(toolkit.slug)} onChanged={() => { void reload(); }} />
            ))}
          </ul>
        )}
      </div>}
    </div>
  );
}

export function Apps() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Apps</h1>
        <p className="text-sm text-muted-foreground">
          Connect an account here once, then allow individual agents to use it through your apps or from
          the card an agent raises when it needs access.
        </p>
      </div>
      <Outlet />
    </div>
  );
}

export function AppsCatalogue() {
  return <AppsContent installed={false} />;
}

export function InstalledApps() {
  return <AppsContent installed />;
}
