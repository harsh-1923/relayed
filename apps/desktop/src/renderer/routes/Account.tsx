// Account tier: the account that is open on this device (STORAGE.md §5).
// Sign-out lives here because it is an account-level act — one identity holds
// every workspace, and signing it out takes all of them.
//
// IT SIGNS OUT ONE ACCOUNT, and the page says which. The button used to read
// "Sign out of all 2", counting this account's workspaces, which read as two
// ACCOUNTS once a device could hold several. Other accounts on the device are
// untouched and the next one opens (STORAGE.md §12.5).
//
// The replica ids that used to sit here are in Settings → Developers: they
// describe the machinery, not the account, and nobody signing out needs them.
import { useCallback, useState } from 'react';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SettingsPanel } from '@/features/settings/SettingsPanel';

export function Account() {
  const { state, apply } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const me = state.workspaces.find(w => w.workspaceId === state.workspaceId)
    ?? state.workspaces.find(w => w.state === 'active');
  const others = state.accounts.filter(a => a.accountId !== state.accountId).length;

  // The reply is the authoritative post-sign-out state. The push that fires
  // partway through describes a HALF-finished sign-out, so relying on the push
  // alone leaves the UI showing a workspace that is already gone.
  const signOut = useCallback(async () => {
    setError(null);
    setSigningOut(true);
    try { apply(await call(api => api.query('auth.signOut'))); }
    catch (e) { setError((e as Error).message); }
    finally { setSigningOut(false); }
  }, [apply]);

  const name = me?.actorDisplayName || me?.actorHandle || 'this account';

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive" className="mx-auto max-w-2xl">
          <AlertTitle>Could not sign out</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <SettingsPanel
        title="Account"
        description={`Signed in as ${name} on this device.`}
        items={[{
          label: 'Sign out',
          description: others === 0
            ? `Sign ${name} out of Relayed on this device.`
            : `Sign ${name} out on this device. ${others === 1
                ? 'Your other account stays signed in.'
                : `Your ${others} other accounts stay signed in.`}`,
          value: (
            <Button variant="outline" disabled={signingOut} onClick={() => void signOut()}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          ),
        }]}
      />
    </div>
  );
}
