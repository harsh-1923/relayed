// The command bus, inspected (SHORTCUTS.md, presentation seam step).
//
// Development builds only, in the top bar beside the offline switch and for the
// same reason: reachable from every screen. It answers the two questions a
// shortcut bug starts with — is anything registered for this command right now,
// and what does the adapter think the key is — and lets a binding be remapped
// for this session, which exercises every label, ARIA token and match from one
// state without a stored preference. Save writes the same list as a real
// `keybindings.<id>` preference through `prefs.set`, so the engine's validation
// and conflict refusal can be tried by hand before the settings page records.
import { useState } from 'react';
import { KeyboardWired } from '@relayed/icons';
import { COMMANDS, isConfigurableCommandId } from '../../../shared/shortcuts/catalogue.ts';
import { keybindingKey } from '../../../shared/prefs.ts';
import { call } from '@/lib/ipc';
import { useSession } from '@/app/state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCommandInspector, type InspectedCommand } from '@/lib/commands/CommandProvider';
import { Shortcut } from '@/lib/commands/Shortcut';

export function CommandInspector() {
  const { state } = useSession();
  if (!state.devTools) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon" variant="ghost" aria-label="Command inspector" title="Command inspector"
            className="no-drag size-7 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <KeyboardWired className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] p-0">
        <InspectorBody />
      </PopoverContent>
    </Popover>
  );
}

function InspectorBody() {
  const { commands, setSessionOverride } = useCommandInspector();
  return (
    <div className="max-h-[70vh] divide-y overflow-y-auto text-xs">
      {commands.map(command => (
        <InspectorRow key={command.binding.id} command={command} setSessionOverride={setSessionOverride} />
      ))}
    </div>
  );
}

function InspectorRow({
  command: { binding, handlers }, setSessionOverride,
}: {
  command: InspectedCommand;
  setSessionOverride: ReturnType<typeof useCommandInspector>['setSessionOverride'];
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const winner = handlers.find(handler => handler.enabled);
  const parsed = () => draft.split(',').map(hotkey => hotkey.trim()).filter(Boolean)
    .map(hotkey => ({ kind: 'chord', hotkey }));
  const remap = () => {
    setSessionOverride(binding.id, parsed());
    setDraft('');
  };
  const persist = async (write: () => Promise<unknown>) => {
    setError(null);
    try {
      await write();
      // The stored value now applies; drop the session layer so it is visible.
      setSessionOverride(binding.id, undefined);
      setDraft('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const configurableId = isConfigurableCommandId(binding.id) ? binding.id : null;

  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{COMMANDS[binding.id].title}</div>
          <div className="truncate font-mono text-muted-foreground">{binding.id}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {binding.hotkeys.map(hotkey => <Shortcut key={hotkey} hotkey={hotkey} />)}
          <span className="text-muted-foreground">{binding.source}</span>
        </div>
      </div>
      <div className="text-muted-foreground">
        {handlers.length === 0
          ? 'No handler mounted'
          : handlers.map(handler => `${handler.layer}${handler.enabled ? '' : ' (disabled)'}`).join(' · ')}
        {handlers.length > 0 && !winner ? ' — nothing would run' : ''}
      </div>
      <form className="flex gap-1.5" onSubmit={event => { event.preventDefault(); remap(); }}>
        <Input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="Mod+Shift+K, Alt+J — empty disables"
          aria-label={`Remap ${binding.id} for this session`}
          className="h-7 font-mono text-xs"
        />
        <Button type="submit" size="sm" variant="secondary" className="h-7 px-2 text-xs">Try</Button>
        {configurableId ? (
          <>
            <Button
              type="button" size="sm" variant="secondary" className="h-7 px-2 text-xs"
              onClick={() => void persist(() => call(api => api.query('prefs.set', { key: keybindingKey(configurableId), value: parsed() })))}
            >
              Save
            </Button>
            <Button
              type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
              title="Remove the session remap and the saved binding"
              onClick={() => void persist(() => call(api => api.query('prefs.clear', { key: keybindingKey(configurableId) })))}
            >
              Reset
            </Button>
          </>
        ) : null}
      </form>
      {error ? <div role="alert" className="text-destructive">{error}</div> : null}
    </div>
  );
}
