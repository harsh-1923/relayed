// Invitations. Rendered only where the local mirror says the action exists.
import { useCallback, useEffect, useState } from 'react';
import type { Invitation } from '../../../preload/api';
import { can, workspace as wsTarget } from '@relayed/authz';
import { useSession } from '@/app/state';
import { call, grantsOf } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Invitations(props: { onError: (m: string | null) => void }) {
  const { state } = useSession();
  const [list, setList] = useState<Invitation[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const wsId = state.workspaceId;
  const { onError } = props;

  const grants = grantsOf(state);
  const mayInvite = wsId ? can(grants, 'invite', wsTarget(wsId)) : false;
  const mayManage = wsId ? can(grants, 'manage_members', wsTarget(wsId)) : false;

  // Guarded, because the effect below fires it with `void` — and an unguarded
  // rejection there is unhandled, not caught by anything downstream. Offline it
  // rejects every time (the invitation list is the one thing on this page that
  // is NOT in the replica), which turned "go offline on the members page" into
  // two uncaught errors in the console.
  const refresh = useCallback(async () => {
    if (!mayManage) return;
    try {
      const v = await call(api => api.query('invite.list'));
      if (v) setList(v.invitations);
      setUnreachable(false);
    } catch {
      // Not an error banner: a pending-invitation list that cannot be fetched
      // is a missing view, not a failed action the person just took.
      setUnreachable(true);
    }
  }, [mayManage]);

  useEffect(() => { void refresh(); }, [refresh, wsId]);

  const send = useCallback(async () => {
    setBusy(true); onError(null);
    try {
      await call(api => api.query('invite.create', { email: email.trim() }));
      setEmail('');
      await refresh();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }, [email, onError, refresh]);

  const revoke = useCallback(async (id: string) => {
    try { await call(api => api.query('invite.revoke', { id })); await refresh(); }
    catch (e) { onError((e as Error).message); }
  }, [onError, refresh]);

  // Hidden, not disabled: an affordance that exists but always fails teaches
  // people the app is broken rather than that they lack a permission.
  if (!mayInvite && !mayManage) return null;

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Invite people</CardTitle>
        <CardDescription>
          They receive an email, sign in, and choose a handle for this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mayInvite && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" type="email" placeholder="person@example.com"
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button onClick={() => void send()} disabled={busy || !email.includes('@')}>
              {busy ? 'Sending…' : 'Invite'}
            </Button>
          </div>
        )}

        {mayManage && list && list.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Pending ({list.length})
            </div>
            {list.map(i => (
              <div key={i.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono text-xs">{i.email}</span>
                <Button size="sm" variant="ghost"
                        onClick={() => void revoke(i.id)}>Revoke</Button>
              </div>
            ))}
          </div>
        )}
        {mayManage && !unreachable && list && list.length === 0 && (
          <p className="text-sm text-muted-foreground">No invitations pending.</p>
        )}
        {/* Says what is true rather than what is convenient: the list lives on
            the server, so offline we do not know it — which is different from
            knowing it is empty (invariant 58's reasoning, applied to a list). */}
        {mayManage && unreachable && (
          <p className="text-sm text-muted-foreground">
            Pending invitations cannot be listed right now — they live on the
            server, not on this device.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
