// Signing web panels in from a browser already on this Mac (docs/PANELS.md,
// browser import).
//
// Each browser is one row that says what to do next, and nothing is imported
// until the person presses Import: a Chromium browser's Keychain prompt follows,
// and that prompt is the consent. The copy is one-time, and the screen says so,
// so a later sign-out in Chrome is not a surprise here.
import { useEffect, useState } from 'react';
import type { BrowserImportResult, BrowserImportSource } from '../../preload/api';
import { BROWSER_IMPORT_FAILURE_COPY } from '../../shared/browser-import.ts';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { call } from '@/lib/ipc';

const DESCRIPTION = 'Copy the sites you are signed in to from another browser, so pages opened in panels are already signed in. '
  + 'A one-time copy of cookies only — no passwords — kept on this Mac for this account.';

type RowState =
  | { step: 'idle' }
  | { step: 'importing' }
  | { step: 'done'; result: Extract<BrowserImportResult, { ok: true }> }
  | { step: 'failed'; reason: Extract<BrowserImportResult, { ok: false }>['reason'] };

export function AccountSettingsBrowsers() {
  const [sources, setSources] = useState<BrowserImportSource[] | null>(null);
  const [checking, setChecking] = useState(false);

  const load = async () => {
    setChecking(true);
    try { setSources((await call(api => api.query('browserImport.sources'))) ?? []); } catch { setSources([]); } finally { setChecking(false); }
  };
  useEffect(() => { void load(); }, []);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsPanel
        title="Browser sign-ins"
        description={DESCRIPTION}
        items={sources === null
          ? [{ label: 'Browsers', description: 'Looking for browsers on this Mac.', value: 'Checking…' }]
          : sources.length === 0
            ? [{ label: 'No browsers found', description: 'Chrome, Arc, Brave, Edge, Vivaldi, Opera, Helium, Firefox and Safari can be imported from.', value: '' }]
            : sources.map(source => ({
              label: source.name,
              description: describe(source),
              value: <SourceAction source={source} onRecheck={() => void load()} checking={checking} />,
            }))}
      />
      <SignOutEverywhere />
    </div>
  );
}

function describe(source: BrowserImportSource): string {
  if (source.unavailable) return BROWSER_IMPORT_FAILURE_COPY[source.unavailable];
  const total = source.profiles.reduce((sum, profile) => sum + (profile.cookieCount ?? 0), 0);
  const profiles = source.profiles.length === 1 ? '1 profile' : `${source.profiles.length} profiles`;
  return total > 0 ? `${profiles} · ${total.toLocaleString()} cookies` : profiles;
}

/**
 * A profile as the picker shows it. Browsers let two profiles share a name —
 * two called after the same work domain is common — so a repeated name carries
 * its cookie count, which is what tells the busy one from the empty one.
 */
function profileLabel(profile: BrowserImportSource['profiles'][number], all: BrowserImportSource['profiles']): string {
  const repeated = all.filter(other => other.name === profile.name).length > 1;
  if (!repeated) return profile.name;
  return profile.cookieCount === undefined ? `${profile.name} — ${profile.directory}` : `${profile.name} — ${profile.cookieCount.toLocaleString()} cookies`;
}

function SourceAction({ source, onRecheck, checking }: { source: BrowserImportSource; onRecheck: () => void; checking: boolean }) {
  const [directory, setDirectory] = useState(source.profiles[0]?.directory ?? '');
  const [state, setState] = useState<RowState>({ step: 'idle' });

  if (source.unavailable === 'browserRunning' || source.unavailable === 'needsFullDiskAccess') {
    return (
      <div className="flex items-center gap-2">
        {source.unavailable === 'needsFullDiskAccess' && (
          <Button variant="outline" size="sm" onClick={() => void call(api => api.query('browserImport.openFullDiskAccess'))}>
            Open System Settings
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={checking} onClick={onRecheck}>{checking ? 'Checking…' : 'Check again'}</Button>
      </div>
    );
  }
  if (source.unavailable) return <span className="text-sm text-muted-foreground">Unavailable</span>;

  const run = () => {
    setState({ step: 'importing' });
    void (async () => {
      try {
        const result = await call(api => api.query('browserImport.run', { sourceId: source.id, directory }));
        if (!result) { setState({ step: 'failed', reason: 'readFailed' }); return; }
        if (result.ok) { setState({ step: 'done', result }); return; }
        setState({ step: 'failed', reason: result.reason });
        // A browser opened meanwhile is found by listing again, not by guessing.
        if (result.reason === 'browserRunning' || result.reason === 'needsFullDiskAccess') onRecheck();
      } catch {
        setState({ step: 'failed', reason: 'readFailed' });
      }
    })();
  };

  return (
    <div className="flex max-w-72 flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {source.profiles.length > 1 && (
          <NativeSelect size="sm" aria-label={`${source.name} profile`} value={directory} disabled={state.step === 'importing'}
            onChange={event => { setDirectory(event.target.value); setState({ step: 'idle' }); }}>
            {source.profiles.map(profile => (
              <NativeSelectOption key={profile.directory} value={profile.directory}>{profileLabel(profile, source.profiles)}</NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <Button variant="outline" size="sm" disabled={state.step === 'importing' || !directory} onClick={run}>
          {state.step === 'importing' ? 'Importing…' : state.step === 'done' ? 'Import again' : 'Import'}
        </Button>
      </div>
      {state.step === 'done' && (
        <p className="text-right text-xs text-muted-foreground" title={state.result.skippedSites.join(', ') || undefined}>
          Imported {state.result.imported.toLocaleString()}
          {state.result.skipped > 0 && ` · ${state.result.skipped.toLocaleString()} skipped`}
        </p>
      )}
      {state.step === 'failed' && <p className="text-right text-xs text-destructive">{BROWSER_IMPORT_FAILURE_COPY[state.reason]}</p>}
    </div>
  );
}

/** The way back: panels signed out of every site, whether the sign-in was imported or typed. */
function SignOutEverywhere() {
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState(false);
  const signOut = () => {
    void call(api => api.query('browserImport.clear')).then(() => { setArmed(false); setDone(true); });
  };
  return (
    <SettingsPanel
      title="Signed-in sites"
      description="What pages in panels are signed in to, on this Mac, for this account."
      items={[{
        label: 'Sign out of every site',
        description: done ? 'Panels are signed out of every site.' : 'Removes every cookie panels hold, imported or not. Your other browsers are not touched.',
        value: armed ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={signOut}>Sign out</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => { setArmed(true); setDone(false); }}>Sign out…</Button>
        ),
      }]}
    />
  );
}
