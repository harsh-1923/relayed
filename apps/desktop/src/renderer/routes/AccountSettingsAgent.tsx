// The person's own Claude Code, as this Mac sees it (docs/LOCAL-ROOMS.md §13.2,
// step 1).
//
// Three states that must never look alike — not installed, signed out, ready —
// plus the probe failing. Relayed never signs Claude Code in: the CLI holds its
// own login, and this screen only reports what the CLI says.
//
// The resolved binary path is on screen in every state that has one, so that a
// "it says not installed" conversation is one screenshot (§3.6). The product
// name on screens is "Claude Agent" (§3.7).
import { useState } from 'react';
import type { ClaudeStatus } from '../../preload/api';
import { Button } from '@/components/ui/button';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { cn } from '@/lib/utils';

const DESCRIPTION = 'Local rooms run the claude command-line tool installed on this Mac, signed in '
  + 'with your own account. Relayed starts it and never sees a credential.';

export function AccountSettingsAgent() {
  const { rows } = useQuery('claude.status');
  const [checking, setChecking] = useState(false);
  const status = rows?.[0] ?? null;

  const checkAgain = () => {
    setChecking(true);
    void (async () => {
      // A failed probe comes back as an `error` status, not a rejection; this
      // only catches the bridge itself going away mid-call.
      try { await call(api => api.query('claude.refresh')); } catch { /* the next read repaints */ }
      finally { setChecking(false); }
    })();
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <SettingsPanel title="Claude Agent" description={DESCRIPTION} items={status ? rowsFor(status) : CHECKING} />
      <div className="flex items-center justify-end gap-3">
        {status && (
          <span className="text-xs text-muted-foreground">Checked {new Date(status.checkedAt).toLocaleTimeString()}</span>
        )}
        <Button variant="outline" size="sm" onClick={checkAgain} disabled={checking || !status}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </div>
  );
}

const CHECKING = [{ label: 'Status', description: 'Starting the claude command to ask who is signed in.', value: 'Checking…' }];

function rowsFor(status: ClaudeStatus) {
  switch (status.state) {
    case 'ready':
      return [
        { label: 'Status', description: 'Local rooms can use it.', value: <State tone="ready">Ready</State> },
        { label: 'Signed in as', description: status.account.organization ?? 'Your account', value: status.account.email ?? 'No email reported' },
        { label: 'Plan', description: `Signed in with ${status.account.authSource ?? 'an unknown method'}.`, value: status.account.plan ?? 'None reported' },
        ...binaryRows(status.binary, status.version),
      ];
    case 'signed_out':
      return [
        { label: 'Status', description: 'Installed, but not signed in.', value: <State tone="warning">Signed out</State> },
        { label: 'Sign in', description: 'Run this in a terminal, sign in, then check again.', value: <Command>claude /login</Command> },
        ...binaryRows(status.binary, status.version),
      ];
    case 'not_installed':
      return [
        { label: 'Status', description: 'The claude command was not found on this Mac.', value: <State tone="warning">Not installed</State> },
        { label: 'Install', description: 'Run this in a terminal, then check again.', value: <Command>curl -fsSL https://claude.ai/install.sh | bash</Command> },
        { label: 'Looked in', description: status.searched.join('\n'), value: '' },
      ];
    case 'error':
      return [
        { label: 'Status', description: status.reason, value: <State tone="error">Could not check</State> },
        ...(status.binary ? binaryRows(status.binary, status.version) : []),
      ];
  }
}

function binaryRows(binary: string, version: string | null) {
  return [
    { label: 'Version', description: 'As reported by claude --version.', value: version ?? 'Unknown' },
    { label: 'Binary', description: 'The file Relayed runs.', value: <Command>{binary}</Command> },
  ];
}

function State({ tone, children }: { tone: 'ready' | 'warning' | 'error'; children: string }) {
  return (
    <span className={cn('text-sm font-medium', {
      ready: 'text-success', warning: 'text-warning', error: 'text-destructive',
    }[tone])}>
      {children}
    </span>
  );
}

function Command({ children }: { children: string }) {
  return (
    <code className="max-w-72 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs select-all" title={children}>
      {children}
    </code>
  );
}
