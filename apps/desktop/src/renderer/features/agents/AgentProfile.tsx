// An agent's profile: what anyone in the workspace sees (WORKSPACE-AGENTS.md
// §4.1) — name, handle, description, creator, maintainers, the instructions,
// readable, and the tools with their effects.
//
// The instructions are an online read. Everything else is from the replica,
// so offline the profile still says who the agent is and who maintains it
// through the summary, and says plainly that its instructions need a connection.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@/lib/query';
import { blobSrc, call, initials } from '@/lib/ipc';
import { MarkdownText } from '@/features/chat/MarkdownText';
import { describeRefusal, useAgentDefinition } from './definition';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

export function AgentProfile() {
  const { agentId } = useParams();
  const { rows: actors } = useQuery('actors.list');
  const agent = actors?.find(a => a.id === agentId && a.type === 'agent');
  const { state: loaded, reload } = useAgentDefinition(agentId, agent?.agent?.configRev);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');

  const person = (id: string | null) => actors?.find(a => a.id === id);
  const definition = loaded.status === 'ready' ? loaded.definition : null;
  const you = definition?.you;
  const active = agent?.state === 'active';

  if (!agent) {
    return <p className="text-sm text-muted-foreground">{actors ? 'This agent is not in this workspace.' : 'Reading…'}</p>;
  }

  async function act(fn: () => Promise<{ ok: boolean; error?: string; field?: string; reason?: string } | null>) {
    setBusy(true); setFailure(null);
    try {
      const answer = await fn();
      if (answer && !answer.ok) setFailure(describeRefusal(answer.field, answer.reason, answer.error ?? 'error'));
      else await reload();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setMaintainers = (actorIds: string[]) =>
    act(() => call(api => api.query('agents.setMaintainers', { agentId: agent.id, actorIds })));
  const candidates = (actors ?? []).filter(a =>
    a.type === 'human' && a.state === 'active' && !definition?.maintainers.includes(a.id));

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-start gap-4">
        <Avatar className="size-12">
          <AvatarImage src={blobSrc(agent.avatarBlob) ?? undefined} />
          <AvatarFallback>{initials(agent.displayName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{agent.displayName}</h2>
            <Badge variant="secondary">Agent</Badge>
            {!active && <Badge variant="outline">{agent.state}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">@{agent.handle}</p>
          <p className="mt-1 text-sm">{agent.agent?.description || 'No description.'}</p>
        </div>
        {active && you?.edit && <Link to="edit" className={buttonVariants({ variant: 'outline' })}>Edit</Link>}
      </div>

      {failure && <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert>}

      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Created by</dt>
        <dd>{person(agent.ownerActorId)?.displayName ?? 'Someone no longer here'}</dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="font-mono">{definition ? (definition.model ?? 'The runtime default') : '—'}</dd>
        <dt className="text-muted-foreground">Tools</dt>
        <dd>
          {(agent.agent?.toolkits.length ?? 0) === 0
            ? 'None'
            : agent.agent?.toolkits.map(t => <Badge key={t.toolkit} variant="secondary" className="mr-1">{t.toolkit} · {t.effect}</Badge>)}
        </dd>
      </dl>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Maintainers</h3>
        {definition ? (
          <ul className="space-y-1 text-sm">
            {definition.maintainers.map(id => (
              <li key={id} className="flex items-center justify-between gap-2">
                <span>{person(id)?.displayName ?? id}</span>
                {active && you?.manage_maintainers && definition.maintainers.length > 1 && (
                  <Button variant="ghost" size="xs" disabled={busy}
                          onClick={() => { void setMaintainers(definition.maintainers.filter(m => m !== id)); }}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">—</p>}
        {active && you?.manage_maintainers && definition && candidates.length > 0 && (
          <div className="flex gap-2">
            <NativeSelect value={adding} onChange={e => { setAdding(e.target.value); }} aria-label="Add a maintainer">
              <NativeSelectOption value="">Add a maintainer…</NativeSelectOption>
              {candidates.map(c => <NativeSelectOption key={c.id} value={c.id}>{c.displayName}</NativeSelectOption>)}
            </NativeSelect>
            <Button variant="outline" disabled={busy || adding === ''}
                    onClick={() => { void setMaintainers([...definition.maintainers, adding]).then(() => { setAdding(''); }); }}>
              Add
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Instructions</h3>
        {loaded.status === 'loading' && <p className="text-sm text-muted-foreground">Reading…</p>}
        {loaded.status === 'unreachable' && (
          <p className="text-sm text-muted-foreground">The instructions are read from the server, and it cannot be reached right now.</p>
        )}
        {loaded.status === 'not_found' && <p className="text-sm text-muted-foreground">This agent is not in this workspace.</p>}
        {definition && (
          <div className="rounded-lg border bg-muted/30 p-4">
            <MarkdownText text={definition.instructions} />
          </div>
        )}
      </section>

      {active && you?.deactivate && (
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Deactivate</h3>
          <p className="text-sm text-muted-foreground">
            It leaves autocomplete and nothing can start it. Its past messages stay. This cannot be undone.
          </p>
          <Button variant="destructive" disabled={busy}
                  onClick={() => { void act(() => call(api => api.query('agents.deactivate', { agentId: agent.id }))); }}>
            Deactivate @{agent.handle}
          </Button>
        </section>
      )}
    </div>
  );
}
