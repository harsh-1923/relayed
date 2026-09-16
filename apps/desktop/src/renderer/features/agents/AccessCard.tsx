// The card a missing connection or permission raises in a chat
// (WORKSPACE-AGENTS.md §7.4).
//
// Which view is chosen by comparing `actor_id` with the signed-in actor —
// presentation only, exactly as the design insists: `POST
// /access-requests/:id/allow` refuses unless the session's own actor is the
// request's, so nothing here is a permission check, only a choice of button.
//
// EVERYONE ELSE sees the plain public sentence the server already wrote —
// `body` is that sentence, and it is reused verbatim rather than re-derived,
// so the actor's own client and everybody else's can never disagree about
// the words. Only the actor gets the interactive version below.
import { useState } from 'react';
import type { AccessRequestPart } from '@relayed/protocol';
import { useSession } from '@/app/state';
import { useQuery } from '@/lib/query';
import { useActor } from '@/lib/actors';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { MarkdownText } from '../chat/MarkdownText';

const EFFECT_WORDS: Record<AccessRequestPart['effect'], string> = {
  read: 'to read your',
  write: 'to make changes in your',
  destructive: 'to delete or overwrite things in your',
};

/** A toolkit slug, shown until the connector store's own catalogue is cached locally for offline rendering — see `ToolkitPage.tsx` (not yet built). */
const toolkitName = (slug: string): string => slug.length > 0 ? slug[0]!.toUpperCase() + slug.slice(1) : slug;

function useMyActorId(): string | null {
  const { state } = useSession();
  return state.workspaces.find(w => w.workspaceId === state.workspaceId)?.actorId ?? null;
}

export function AccessCard({ part, body, onOpenLink }: {
  part: AccessRequestPart;
  /** The message's own body — the public sentence, for every viewer who is not the actor. */
  body: string;
  onOpenLink?: (href: string) => void;
}) {
  const myActorId = useMyActorId();
  const agentHandle = useActor(part.agent_id)?.handle ?? 'agent';
  const { rows: connections } = useQuery('connections.list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (part.actor_id !== myActorId) return <MarkdownText text={body} onOpenLink={onOpenLink} />;

  const toolkit = toolkitName(part.toolkit);

  if (part.state === 'expired') {
    return <p className="text-sm text-muted-foreground">This request expired.</p>;
  }

  // Resolving re-runs the request on the server (WORKSPACE-AGENTS-IMPL.md
  // step 7) — there is nothing left for the person to press.
  if (part.state === 'resolved') {
    return <p className="text-sm text-muted-foreground">{toolkit} is ready. @{agentHandle} is running again.</p>;
  }

  // state === 'pending'. Which is missing — the connection, the permission,
  // or both — is read from local state purely to choose the button's words;
  // `onAct` below does not need the answer, because fixing a connection
  // never skips Allow (allowing is always safe to call again) and there is
  // nothing else this card's one button could possibly be for.
  const connection = connections?.find(c => c.toolkit === part.toolkit);
  const hasConnection = connection?.status === 'active';
  const needsReauth = connection?.status === 'needs_reauth';

  const label = needsReauth ? `Reconnect ${toolkit}`
    : !hasConnection ? `Connect ${toolkit} and allow @${agentHandle}`
    : `Allow @${agentHandle} ${EFFECT_WORDS[part.effect]} ${toolkit}`;

  async function onAct() {
    setBusy(true); setError(null);
    try {
      // "Connect Linear and allow — in one go" (§7.4): a missing connection
      // is fixed first, and Allow always follows — harmless when permission
      // was already sufficient (it re-upserts the same effect and resolves
      // any card still open), and the only step needed otherwise.
      if (!hasConnection) {
        const connected = await call(api => api.query('connections.connect', {
          toolkit: part.toolkit, accessRequestId: part.request_id,
        }));
        if (!connected) return;
        if (!connected.ok) { setError(connected.error); return; }
      }
      const allowed = await call(api => api.query('access.allow', { requestId: part.request_id }));
      if (!allowed) return;
      if (!allowed.ok) setError(allowed.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => { void onAct(); }}>
          {busy ? 'Working…' : label}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
