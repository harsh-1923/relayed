// The agent editor: create, or edit one you maintain (WORKSPACE-AGENTS.md §4.1).
//
// Without Tools, which arrive with the connector store (the plan's D11), and
// without an avatar upload or a model list — the model is named as
// `provider/model` until the server knows the runtime's provider table.
//
// Nothing here is optimistic. Creating an agent needs a handle the server has
// checked, so the editor waits for the answer, and the list updates from the
// directory event the server delivers — not from anything this screen writes.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AgentInput } from '../../preload/api';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { useActor } from '@/lib/actors';
import { describeRefusal, useAgentDefinition } from '@/features/agents/definition';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type FieldName = 'name' | 'handle' | 'description' | 'instructions' | 'model' | 'space_ids';

const INSTRUCTIONS_BYTES = 32_768;

export function SettingsAgentEditor() {
  const { agentId } = useParams();
  const editing = agentId !== undefined;
  const navigate = useNavigate();
  const { rows: spaces } = useQuery('spaces.list');
  const actor = useActor(agentId);
  const { state: loaded } = useAgentDefinition(agentId);

  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [handleCheck, setHandleCheck] = useState<{ handle: string; message: string | null } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filled, setFilled] = useState(!editing);

  // Filled once, from the definition and the replica's actor row, so an edit in
  // progress is not overwritten by a later read.
  useEffect(() => {
    if (filled || loaded.status !== 'ready' || !actor) return;
    setName(actor.displayName);
    setHandle(actor.handle);
    setDescription(loaded.definition.description);
    setInstructions(loaded.definition.instructions);
    setModel(loaded.definition.model ?? '');
    setFilled(true);
  }, [filled, loaded, actor]);

  // The live handle check (§4.1): debounced, and asked of the server, because
  // the namespace is shared with people this replica may not have yet.
  useEffect(() => {
    const wanted = handle.trim().toLowerCase();
    if (!wanted || (editing && wanted === actor?.handle)) { setHandleCheck(null); return; }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const answer = await call(api => api.query('agents.handle', {
            handle: wanted, ...(agentId ? { except: agentId } : {}),
          }));
          if (!answer) return;
          if (!answer.ok) { setHandleCheck(null); return; }
          setHandleCheck({
            handle: wanted,
            message: answer.available ? null
              : describeRefusal('handle', answer.reason ?? undefined, answer.reason === 'taken' ? 'handle_taken' : 'invalid'),
          });
        } catch {
          setHandleCheck(null);   // offline: the save will say so
        }
      })();
    }, 300);
    return () => { clearTimeout(timer); };
  }, [handle, editing, agentId, actor?.handle]);

  const bytes = useMemo(() => new TextEncoder().encode(instructions).length, [instructions]);
  const handleBlocked = handleCheck?.handle === handle.trim().toLowerCase() && handleCheck.message !== null;
  const canSave = !busy && name.trim() !== '' && handle.trim() !== '' && instructions.trim() !== ''
    && bytes <= INSTRUCTIONS_BYTES && !handleBlocked;

  async function save() {
    setBusy(true); setErrors({}); setFailure(null);
    const input: AgentInput = {
      name, handle, description, instructions, model: model.trim() === '' ? null : model.trim(),
      ...(editing ? {} : { space_ids: spaceIds }),
    };
    try {
      const answer = editing
        ? await call(api => api.query('agents.update', { agentId, ...input }))
        : await call(api => api.query('agents.create', input));
      if (!answer) return;
      // Back to the profile: from `agents/new` that is `../<id>`, from `agents/<id>/edit` it is `..`.
      if (answer.ok) { void navigate(editing ? '..' : `../${answer.agent_id}`, { relative: 'path' }); return; }
      const message = describeRefusal(answer.field, answer.reason, answer.error);
      if (answer.field && ['name', 'handle', 'description', 'instructions', 'model', 'space_ids'].includes(answer.field)) {
        setErrors({ [answer.field as FieldName]: message });
      } else {
        setFailure(message);
      }
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editing && loaded.status === 'unreachable') {
    return <p className="text-sm text-muted-foreground">Editing an agent needs a connection. Try again when you are online.</p>;
  }
  if (editing && loaded.status === 'not_found') {
    return <p className="text-sm text-muted-foreground">This agent is not in this workspace.</p>;
  }
  if (editing && loaded.status === 'ready' && !loaded.definition.you.edit) {
    return <p className="text-sm text-muted-foreground">Only this agent's maintainers and workspace admins can edit it.</p>;
  }
  if (editing && !filled) return <p className="text-sm text-muted-foreground">Reading…</p>;

  const channels = (spaces ?? []).filter(space => space.kind === 'channel');

  return (
    <form className="max-w-2xl space-y-6" onSubmit={e => { e.preventDefault(); if (canSave) void save(); }}>
      <div>
        <h2 className="text-base font-semibold">{editing ? `Edit @${actor?.handle ?? ''}` : 'New agent'}</h2>
        <p className="text-sm text-muted-foreground">
          Everyone in this workspace can read these instructions. An agent spends the authority of whoever mentions it.
        </p>
      </div>

      {failure && <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert>}

      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="agent-name">Name</FieldLabel>
          <Input id="agent-name" value={name} maxLength={80} placeholder="Triage"
                 onChange={e => { setName(e.target.value); }} />
          {errors.name && <FieldError>{errors.name}</FieldError>}
        </Field>

        <Field data-invalid={errors.handle || handleBlocked ? true : undefined}>
          <FieldLabel htmlFor="agent-handle">Handle</FieldLabel>
          <Input id="agent-handle" value={handle} maxLength={30} placeholder="triage"
                 onChange={e => { setHandle(e.target.value.toLowerCase()); }} />
          <FieldDescription>How people mention it. Shared with people's handles, so it has to be free.</FieldDescription>
          {(errors.handle ?? (handleBlocked ? handleCheck?.message : null)) && (
            <FieldError>{errors.handle ?? handleCheck?.message}</FieldError>
          )}
        </Field>

        <Field data-invalid={errors.description ? true : undefined}>
          <FieldLabel htmlFor="agent-description">Description</FieldLabel>
          <Input id="agent-description" value={description} maxLength={200} placeholder="Files and triages bugs"
                 onChange={e => { setDescription(e.target.value.replace(/[\r\n]/g, ' ')); }} />
          <FieldDescription>One line, shown when someone mentions it. It is how they decide whether to trust it.</FieldDescription>
          {errors.description && <FieldError>{errors.description}</FieldError>}
        </Field>

        <Field data-invalid={errors.instructions || bytes > INSTRUCTIONS_BYTES ? true : undefined}>
          <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
          <Textarea id="agent-instructions" value={instructions} rows={12} className="font-mono text-sm"
                    placeholder="What this agent is for, and how it should behave. Markdown."
                    onChange={e => { setInstructions(e.target.value); }} />
          <FieldDescription>
            {Math.ceil(bytes / 1024)} of 32 KB.
          </FieldDescription>
          {(errors.instructions ?? (bytes > INSTRUCTIONS_BYTES ? 'Too long.' : null)) && (
            <FieldError>{errors.instructions ?? 'Too long.'}</FieldError>
          )}
        </Field>

        <Field data-invalid={errors.model ? true : undefined}>
          <FieldLabel htmlFor="agent-model">Model</FieldLabel>
          <Input id="agent-model" value={model} placeholder="Default" className="font-mono text-sm"
                 onChange={e => { setModel(e.target.value); }} />
          <FieldDescription>provider/model, as the agent runtime names it. Leave blank for the runtime's default.</FieldDescription>
          {errors.model && <FieldError>{errors.model}</FieldError>}
        </Field>

        {!editing && channels.length > 0 && (
          <Field data-invalid={errors.space_ids ? true : undefined}>
            <FieldLabel>Spaces</FieldLabel>
            <FieldDescription>Optional. Add it to channels you are in now; it can be added anywhere later, like a person.</FieldDescription>
            <div className="grid gap-2 sm:grid-cols-2">
              {channels.map(space => (
                <label key={space.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={spaceIds.includes(space.id)}
                            onCheckedChange={checked => {
                              setSpaceIds(ids => checked ? [...ids, space.id] : ids.filter(id => id !== space.id));
                            }} />
                  #{space.name}
                </label>
              ))}
            </div>
            {errors.space_ids && <FieldError>{errors.space_ids}</FieldError>}
          </Field>
        )}
      </FieldGroup>

      <div className="flex gap-2">
        <Button type="submit" disabled={!canSave}>{busy ? 'Saving…' : editing ? 'Save' : 'Create'}</Button>
        <Link to=".." relative="path" className={buttonVariants({ variant: 'ghost' })}>Cancel</Link>
      </div>
    </form>
  );
}
