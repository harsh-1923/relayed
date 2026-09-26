// An organization: the workspaces in it, and who may join it by email domain
// (docs/ORG-DOMAINS.md).
//
// Account tier — no replica is read here. Everything on this page is a live
// question to the server (who is in the org, which domains it approved), so it
// is fetched when opened and says so when offline, rather than cached.
//
// Everyone in the org sees the open workspaces and the approved domains. Its
// admins — owners and admins of the default workspace (§6) — also see
// invite-only workspaces, choose each one's join policy and the default, add
// workspaces, and approve domains. The server re-checks every one of those;
// this page only hides what it would refuse (invariant 49).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { OrgDomain, OrgWorkspace } from '../../preload/api';
import { useSession } from '@/app/state';
import { blobSrc, call, hueFor, initials } from '@/lib/ipc';
import { toLogoPng } from '@/lib/logo';
import type { PickedWorkspace } from './JoinWorkspace';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const REFUSALS: Record<string, string> = {
  not_your_domain: 'You can only approve the domain of your own email address.',
  public_domain: 'Public email providers like gmail.com can never be approved — anyone can get an address there.',
  invalid_domain: 'That is not a domain. Enter something like acme.com.',
  email_unverified: 'Your email address is not verified yet.',
  domain_verified_elsewhere: 'Another organization has verified ownership of that domain.',
  default_must_be_open: 'The default workspace is where colleagues land, so it must stay open to the organization.',
  not_admin_of_new_default: 'Only an admin of that workspace can make it the default — its admins become the organization\'s admins.',
  managed_in_workos: 'That domain is verified in WorkOS, so it can only be removed there.',
  forbidden: 'Only organization admins can do that.',
  not_an_org_member: 'You are not a member of this organization.',
  offline: 'You are offline. Organization settings need a connection.',
  storage_unconfigured: 'File storage is not set up on this server yet.',
  too_large: 'That image is too large. Logos are at most 1 MB.',
  unsupported_type: 'Logos must be PNG, JPEG or WebP.',
  bad_dimensions: 'Logos are at most 1024 × 1024 pixels.',
  upload_failed: 'The upload did not go through. Try again.',
  invalid_file: 'That file cannot be used as a logo here.',
};
const explain = (error: string) => REFUSALS[error] ?? error;

export function Org() {
  // Reached from a workspace (`/w/:wsId/organization`): the org is that
  // workspace's, read from account.db.
  const { wsId = '' } = useParams();
  const { state } = useSession();
  const navigate = useNavigate();
  const orgId = state.workspaces.find(w => w.workspaceId === wsId)?.orgId ?? '';
  const mine = state.workspaces.filter(w => w.orgId === orgId && w.state === 'active');
  const orgName = mine[0]?.orgName ?? 'Organization';

  const [org, setOrg] = useState<{ name: string; isAdmin: boolean } | null>(null);
  const [workspaces, setWorkspaces] = useState<OrgWorkspace[]>([]);
  const [domains, setDomains] = useState<OrgDomain[]>([]);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [ws, ds] = await Promise.all([
      call(api => api.query('org.workspaces', { orgId })),
      call(api => api.query('org.domains.list', { orgId })),
    ]);
    if (ws?.ok) { setOrg({ name: ws.org.name, isAdmin: ws.org.isAdmin }); setWorkspaces(ws.workspaces); }
    else if (ws) setError(explain(ws.error));
    if (ds?.ok) setDomains(ds.domains);
  }, [orgId]);
  useEffect(() => { void load().catch(e => setError((e as Error).message)); }, [load]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string } | null>) => {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      if (r && !r.ok) setError(explain(r.error ?? 'failed'));
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const join = (w: OrgWorkspace) => {
    const pick: PickedWorkspace = {
      workspaceId: w.workspaceId, name: w.name, orgName: org?.name ?? orgName, memberCount: w.memberCount,
      ...(mine[0] ? { handle: mine[0].actorHandle } : {}),
    };
    void navigate('/onboarding/join', { state: { pick } });
  };

  const isAdmin = org?.isAdmin ?? mine.some(w => w.orgIsAdmin);

  // What the org's logo looks like today: the default workspace's image, which
  // IS the org's unless that workspace has one of its own (FILES.md §5). A
  // just-uploaded logo shows from its local bytes until the refresh fetches it.
  const defaultRow = mine.find(w => w.isDefault) ?? mine[0];
  const [preview, setPreview] = useState<Record<string, string>>({});
  const setLogo = (target: 'org' | 'workspace', id: string, file: File | null) => void act(async () => {
    const bytes = file ? await toLogoPng(file) : null;
    const r = await call(api => api.query('logo.set', { target, id, bytes, mediaType: 'image/png' }));
    if (r?.ok) {
      setPreview(v => {
        const next = { ...v };
        if (bytes) next[`${target}:${id}`] = URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/png' }));
        else delete next[`${target}:${id}`];
        return next;
      });
    }
    return r;
  });
  const faceOf = (workspaceId: string) => {
    const row = mine.find(w => w.workspaceId === workspaceId);
    return preview[`workspace:${workspaceId}`] ?? blobSrc(row?.workspaceAvatarBlob);
  };
  const openDomains = domains.map(d => `@${d.domain}`).join(', ');

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo src={preview[`org:${orgId}`] ?? blobSrc(defaultRow?.workspaceAvatarBlob)}
                name={org?.name ?? orgName} seed={defaultRow?.workspaceId ?? orgId} size="size-11" />
          <div>
          <h1 className="text-lg font-semibold">{org?.name ?? orgName}</h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin ? 'You are an admin of this organization.' : 'Workspaces you can find and join.'}
          </p>
          </div>
        </div>
        {isAdmin && (
          <Link to={`/onboarding/create?org=${encodeURIComponent(orgId)}`}
                className={buttonVariants({ size: 'sm' })}>
            New workspace
          </Link>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Logo</CardTitle>
            <CardDescription>
              Shown for every workspace in {org?.name ?? orgName} that has no logo of its own — in the
              switcher, and to colleagues deciding whether to join. Any image works; it is saved as a
              512 px PNG. Needs a connection.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <Logo src={preview[`org:${orgId}`] ?? blobSrc(defaultRow?.workspaceAvatarBlob)}
                  name={org?.name ?? orgName} seed={defaultRow?.workspaceId ?? orgId} size="size-16" />
            <PickImage label="Upload logo" disabled={busy} onPick={f => setLogo('org', orgId, f)} />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setLogo('org', orgId, null)}>
              Remove
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>
            {isAdmin
              ? 'Open workspaces can be joined by anyone in the organization. Invite-only ones are hidden from everyone who is not in them.'
              : 'Open workspaces anyone in the organization can join.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {workspaces.map(w => (
            <div key={w.workspaceId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <Logo src={faceOf(w.workspaceId)} name={w.name} seed={w.workspaceId} size="size-8" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{w.name}</span>
                  {w.isDefault && <Badge variant="secondary">Default</Badge>}
                  {w.joinPolicy === 'invite_only' && <Badge variant="outline">Invite only</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {w.memberCount} {w.memberCount === 1 ? 'member' : 'members'}
                  {w.isDefault ? ' · colleagues joining by email domain land here' : ''}
                </p>
              </div>
              {isAdmin && (
                <PickImage label="Logo" variant="ghost" disabled={busy}
                           onPick={f => setLogo('workspace', w.workspaceId, f)} />
              )}
              {isAdmin && !w.isDefault && (
                <>
                  <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => void act(() => call(api => api.query('org.workspace.update', {
                            workspaceId: w.workspaceId,
                            joinPolicy: w.joinPolicy === 'org_open' ? 'invite_only' : 'org_open',
                          })))}>
                    {w.joinPolicy === 'org_open' ? 'Make invite-only' : 'Open to org'}
                  </Button>
                  {w.joined && (
                    <Button size="sm" variant="ghost" disabled={busy}
                            onClick={() => void act(() => call(api => api.query('org.workspace.update', {
                              workspaceId: w.workspaceId, makeDefault: true,
                            })))}>
                      Make default
                    </Button>
                  )}
                </>
              )}
              {w.joined
                ? <Link to={`/w/${w.workspaceId}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })}>Open</Link>
                : w.joinPolicy === 'org_open'
                  ? <Button size="sm" onClick={() => join(w)}>Join</Button>
                  : null}
            </div>
          ))}
          {workspaces.length === 0 && !error && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Join by email domain</CardTitle>
          <CardDescription>
            {domains.length > 0
              ? `Anyone with a verified ${openDomains} address can join this organization's default workspace without an invitation.`
              : 'Nobody can join without an invitation.'}
            {isAdmin && ' You can approve your own company\'s domain; public providers like gmail.com are never allowed. Other organizations may approve the same domain — people choose which to join.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {domains.map(d => (
            <div key={d.domain} className="flex items-center gap-2 text-sm">
              <span className="flex-1 font-medium">@{d.domain}</span>
              {d.verified && <Badge variant="secondary">Verified</Badge>}
              {d.source === 'workos' && (
                <span className="text-xs text-muted-foreground">managed in WorkOS</span>
              )}
              {isAdmin && d.source !== 'workos' && (
                <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => void act(() => call(api => api.query('org.domains.remove', { orgId, domain: d.domain })))}>
                  Remove
                </Button>
              )}
            </div>
          ))}
          {isAdmin && (
            <div className="flex gap-2">
              <Input placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
              <Button disabled={busy || !domain.trim()}
                      onClick={() => void act(async () => {
                        const r = await call(api => api.query('org.domains.add', { orgId, domain: domain.trim() }));
                        if (r?.ok) setDomain('');
                        return r;
                      })}>
                Approve
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** A square mark: the image if there is one, else initials on a colour derived from the id. */
function Logo({ src, name, seed, size }: { src: string | undefined; name: string; seed: string; size: string }) {
  return (
    <div className={`grid shrink-0 place-items-center overflow-hidden rounded-lg text-sm font-medium
                     text-foreground/90 ${size}`}
         style={src ? undefined : { backgroundColor: `oklch(0.34 0.07 ${hueFor(seed)})` }}>
      {src ? <img src={src} alt="" className="size-full object-contain" /> : initials(name)}
    </div>
  );
}

/** A button that opens the file picker for one image. */
function PickImage({ label, onPick, disabled, variant = 'outline' }: {
  label: string; onPick: (f: File) => void; disabled: boolean; variant?: 'outline' | 'ghost';
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept="image/*" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
      <Button size="sm" variant={variant} disabled={disabled} onClick={() => input.current?.click()}>{label}</Button>
    </>
  );
}

