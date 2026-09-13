// Keyboard shortcuts settings (SHORTCUTS.md §13).
//
// Rows come from the command catalogue rather than from preference rows,
// because a missing row is meaningful: it means defaults. Bindings are the
// command bus's effective state — the same one the keyboard adapter matches and
// every button labels itself from — so a change shows here, in every label and
// in matching at once.
//
// No draft state and no Save button: every change is one engine write, and the
// repaint arrives through the live preference read like any other. The engine
// validates again, so what this page checks first is for the message, not for
// safety.
import { useMemo, useState } from 'react';
import { MultipleCrossCancelDefault, SearchDefault } from '@relayed/icons';
import {
  COMMANDS, isConfigurableCommandId, type CommandDefinition, type CommandId,
} from '../../shared/shortcuts/catalogue.ts';
import { keybindingKey } from '../../shared/prefs.ts';
import {
  bindingProblem, findConflicts, resolveBindings,
  type BindingConflict, type EffectiveBinding,
} from '../../shared/shortcuts/resolve.ts';
import { displayChord, normalizeChord, type Platform } from '../../shared/shortcuts/tanstack-driver.ts';
import { useSession } from '@/app/state';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCommandBindings } from '@/lib/commands/CommandProvider';
import { Shortcut } from '@/lib/commands/Shortcut';
import { useShortcutRecorder } from '@/lib/commands/use-shortcut-recorder';
import { call } from '@/lib/ipc';

const CATEGORY_ORDER: readonly CommandDefinition['category'][] = ['Application', 'Navigation', 'View', 'Composer'];

type Change = { op: 'set'; key: string; value: unknown } | { op: 'clear'; key: string };

const chords = (hotkeys: readonly string[]) => hotkeys.map(hotkey => ({ kind: 'chord', hotkey }));

async function applyChanges(changes: Change[]): Promise<void> {
  await call(api => api.query('prefs.apply', { changes }));
}

/** The hard conflicts `id` would be part of if it held `hotkeys`. */
function conflictsIfSet(
  effective: readonly EffectiveBinding[], id: CommandId, hotkeys: readonly string[], platform: Platform,
): BindingConflict[] {
  const proposed = new Map<string, unknown>(effective.map(binding => [binding.id, chords(binding.hotkeys)]));
  proposed.set(id, chords(hotkeys));
  return findConflicts(resolveBindings(proposed, platform))
    .filter(conflict => conflict.kind === 'hard' && conflict.commands.includes(id));
}

const PROBLEM_MESSAGE = {
  reserved: 'is reserved by the system for editing or window control.',
  'character-only': 'needs Control, Alt or Command, or it would fire while typing. In the composer, Return also works.',
} as const;

export function AccountSettingsShortcuts() {
  const { state } = useSession();
  const { platform, effective } = useCommandBindings();
  const [search, setSearch] = useState('');
  const writable = state.accountId !== null;

  const conflicts = useMemo(() => findConflicts(effective), [effective]);
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (binding: EffectiveBinding) => {
      if (!needle) return true;
      const definition = COMMANDS[binding.id];
      return [definition.title, definition.description, definition.category,
        ...binding.hotkeys.map(hotkey => displayChord(hotkey, platform)), ...binding.hotkeys]
        .some(text => text.toLowerCase().includes(needle));
    };
    return CATEGORY_ORDER
      .map(category => ({
        category,
        bindings: effective.filter(binding => COMMANDS[binding.id].category === category && matches(binding)),
      }))
      .filter(group => group.bindings.length > 0);
  }, [effective, platform, search]);

  const customized = effective.filter(binding => binding.source !== 'default' && isConfigurableCommandId(binding.id));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Keyboard shortcuts</h1>
          <p className="text-sm text-muted-foreground">
            {writable
              ? 'Changes apply immediately on this device, for this account.'
              : 'Sign in to change shortcuts. These are the defaults.'}
          </p>
        </div>
        <ResetAll disabled={!writable || customized.length === 0} customized={customized} />
      </div>

      <div className="relative">
        <SearchDefault className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search commands or keys"
          aria-label="Search shortcuts"
          className="pl-8"
        />
      </div>

      {groups.length === 0 ? <p className="text-sm text-muted-foreground">No shortcuts match.</p> : null}

      {groups.map(group => (
        <section key={group.category} className="space-y-2">
          <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.category}
          </h2>
          <div className="overflow-hidden rounded-xl border bg-card/60">
            <div className="divide-y">
              {group.bindings.map(binding => (
                <ShortcutRow
                  key={binding.id}
                  binding={binding}
                  effective={effective}
                  conflicts={conflicts.filter(conflict => conflict.commands.includes(binding.id))}
                  platform={platform}
                  writable={writable}
                />
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function ResetAll({ disabled, customized }: { disabled: boolean; customized: readonly EffectiveBinding[] }) {
  const [error, setError] = useState<string | null>(null);
  const reset = async () => {
    setError(null);
    try {
      // Explicit clears of known shortcut keys, in one transaction — never a
      // delete of arbitrary preference rows (SHORTCUTS.md §13.1).
      await applyChanges(customized.flatMap(binding =>
        isConfigurableCommandId(binding.id) ? [{ op: 'clear' as const, key: keybindingKey(binding.id) }] : []));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
          Reset all
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all shortcuts?</AlertDialogTitle>
            <AlertDialogDescription>
              {customized.length === 1 ? 'One changed shortcut goes' : `${customized.length} changed shortcuts go`} back
              to its default. Other settings are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reset()}>Reset all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

type Pending = { hotkey: string; takenBy: CommandId };

function ShortcutRow({
  binding, effective, conflicts, platform, writable,
}: {
  binding: EffectiveBinding;
  effective: readonly EffectiveBinding[];
  conflicts: readonly BindingConflict[];
  platform: Platform;
  writable: boolean;
}) {
  const definition = COMMANDS[binding.id];
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const editable = writable && isConfigurableCommandId(binding.id);
  const key = isConfigurableCommandId(binding.id) ? keybindingKey(binding.id) : null;

  const write = async (changes: Change[]) => {
    setMessage(null);
    setPending(null);
    try {
      await applyChanges(changes);
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const recorder = useShortcutRecorder(recorded => {
    setMessage(null);
    setPending(null);
    const hotkey = normalizeChord(recorded, platform);
    if (!hotkey || !key) return;
    const label = displayChord(hotkey, platform);
    if (binding.hotkeys.includes(hotkey)) {
      setMessage(`${label} is already a shortcut for this command.`);
      return;
    }
    const problem = bindingProblem(binding.id, hotkey, platform);
    if (problem) {
      setMessage(`${label} ${PROBLEM_MESSAGE[problem]}`);
      return;
    }
    const next = [...binding.hotkeys, hotkey];
    const [conflict] = conflictsIfSet(effective, binding.id, next, platform);
    const takenBy = conflict?.commands.find(id => id !== binding.id);
    if (takenBy) {
      setPending({ hotkey, takenBy });
      return;
    }
    void write([{ op: 'set', key, value: chords(next) }]);
  });

  const replace = () => {
    if (!pending || !key || !isConfigurableCommandId(pending.takenBy)) return;
    const other = effective.find(candidate => candidate.id === pending.takenBy);
    // Both rows in one transaction: the chord moves, or nothing changes.
    void write([
      { op: 'set', key, value: chords([...binding.hotkeys, pending.hotkey]) },
      { op: 'set', key: keybindingKey(pending.takenBy), value: chords((other?.hotkeys ?? []).filter(hotkey => hotkey !== pending.hotkey)) },
    ]);
  };

  const hard = conflicts.find(conflict => conflict.kind === 'hard');
  const shadow = conflicts.find(conflict => conflict.kind === 'shadow');
  const status = hard ? { label: 'Conflict', variant: 'destructive' as const }
    : binding.source === 'custom' ? { label: 'Custom', variant: 'secondary' as const }
    : binding.source === 'disabled' ? { label: 'Disabled', variant: 'outline' as const }
    : binding.source === 'invalid' ? { label: 'Unreadable, using default', variant: 'outline' as const }
    : null;

  return (
    <div className="space-y-2 px-5 py-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{definition.title}</h3>
            {status ? <Badge variant={status.variant}>{status.label}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">{definition.description}</p>
          {hard ? (
            <p className="text-xs text-destructive">
              {displayChord(hard.hotkey, platform)} is also {otherTitles(hard, binding.id)}; neither can be reached reliably.
            </p>
          ) : null}
          {shadow?.winner && shadow.winner !== binding.id ? (
            <p className="text-xs text-muted-foreground">
              {displayChord(shadow.hotkey, platform)} does {COMMANDS[shadow.winner].title.toLowerCase()} while that has focus.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {binding.hotkeys.length === 0 && !recorder.recording
            ? <span className="text-sm text-muted-foreground">None</span>
            : null}
          {binding.hotkeys.map(hotkey => (
            <span key={hotkey} className="inline-flex items-center gap-0.5 rounded-md border bg-background/60 py-0.5 pr-0.5 pl-1.5">
              <Shortcut hotkey={hotkey} />
              {editable && key ? (
                <Button
                  variant="ghost" size="icon" className="size-5 text-muted-foreground"
                  aria-label={`Remove ${displayChord(hotkey, platform)} from ${definition.title}`}
                  onClick={() => void write([{ op: 'set', key, value: chords(binding.hotkeys.filter(existing => existing !== hotkey)) }])}
                >
                  <MultipleCrossCancelDefault className="size-3" />
                </Button>
              ) : null}
            </span>
          ))}
          {editable ? (
            <Button
              variant={recorder.recording ? 'default' : 'outline'} size="sm"
              aria-live="polite"
              onClick={recorder.recording ? recorder.cancel : recorder.start}
            >
              {recorder.recording ? 'Press keys… Esc to cancel' : binding.hotkeys.length === 0 ? 'Record' : 'Add'}
            </Button>
          ) : null}
        </div>
      </div>

      {editable && key ? (
        <div className="flex flex-wrap justify-end gap-1">
          {binding.hotkeys.length > 0 ? (
            <Button variant="ghost" size="xs" onClick={() => void write([{ op: 'set', key, value: [] }])}>
              Disable
            </Button>
          ) : null}
          {binding.source !== 'default' ? (
            <Button variant="ghost" size="xs" onClick={() => void write([{ op: 'clear', key }])}>
              Reset to default
            </Button>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <div role="alertdialog" aria-label="Shortcut already in use" className="flex flex-wrap items-center justify-end gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <span className="mr-auto">
            {displayChord(pending.hotkey, platform)} is already used by {COMMANDS[pending.takenBy].title}.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
          <Button size="sm" onClick={replace}>Replace existing</Button>
        </div>
      ) : null}
      {message ? <p role="alert" className="text-right text-xs text-destructive">{message}</p> : null}
    </div>
  );
}

function otherTitles(conflict: BindingConflict, self: CommandId): string {
  return conflict.commands.filter(id => id !== self).map(id => COMMANDS[id].title.toLowerCase()).join(' and ');
}
