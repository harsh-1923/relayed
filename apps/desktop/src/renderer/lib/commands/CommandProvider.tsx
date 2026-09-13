// The renderer's command bus and its one keyboard listener (SHORTCUTS.md §6.2).
//
// Mounted inside AppStateProvider and above SidebarProvider, so a command's
// lifetime is the window's rather than whichever sidebar or route is showing.
// Feature code registers handlers with `useCommandHandler` and invokes with
// `useCommand`; it never adds a document keydown listener of its own.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react';
import { definitionOf, type CommandId, type CommandLayer } from '../../../shared/shortcuts/catalogue.ts';
import { resolveBindings, type BindingOverrides, type EffectiveBinding } from '../../../shared/shortcuts/resolve.ts';
import { ariaChord, displayChord, platformOf, type Platform } from '../../../shared/shortcuts/tanstack-driver.ts';
import { buildIndex, decide } from './dispatch.ts';
import { isEditableEvent } from './editable.ts';
import { CommandRegistry, type ExecuteOutcome } from './registry.ts';
import { bridge } from '@/lib/ipc';

interface CommandBus {
  readonly registry: CommandRegistry;
  readonly platform: Platform;
  /** Catalogue order. The one state matching, labels, ARIA and settings all read. */
  readonly effective: readonly EffectiveBinding[];
  readonly bindings: ReadonlyMap<CommandId, EffectiveBinding>;
  readonly setSessionOverride: (id: CommandId, raw: unknown) => void;
}

const Ctx = createContext<CommandBus | null>(null);

function reportAmbiguous(id: CommandId, layer: CommandLayer, owners: readonly string[]) {
  const message = 'two eligible handlers for one command in one layer';
  if (import.meta.env.DEV) throw new Error(`${message}: ${id} in ${layer} (${owners.join(', ')})`);
  console.error(message, { id, layer, owners });
}

export function CommandProvider({
  platform: hostPlatform, overrides, children,
}: {
  platform: string;
  /** Decoded `keybindings.<id>` values; absent until persistent overrides land. */
  overrides?: BindingOverrides;
  children: ReactNode;
}) {
  const registry = useMemo(() => new CommandRegistry({ onAmbiguous: reportAmbiguous }), []);
  const platform = platformOf(hostPlatform);
  // Unsaved remaps from the development inspector. Held here, above every
  // consumer, so a remap is one state change rather than a second authority.
  // `undefined` removes the session value and falls back to `overrides`.
  const [sessionOverrides, setSessionOverrides] = useState<ReadonlyMap<string, unknown>>(new Map());
  const setSessionOverride = useCallback((id: CommandId, raw: unknown) => {
    setSessionOverrides(current => {
      const next = new Map(current);
      if (raw === undefined) next.delete(id);
      else next.set(id, raw);
      return next;
    });
  }, []);
  const effective = useMemo(
    () => resolveBindings(new Map([...(overrides ?? []), ...sessionOverrides]), platform),
    [overrides, sessionOverrides, platform],
  );
  const index = useMemo(() => buildIndex(effective), [effective]);
  const bus = useMemo<CommandBus>(() => ({
    registry,
    platform,
    effective,
    bindings: new Map(effective.map(binding => [binding.id, binding])),
    setSessionOverride,
  }), [registry, platform, effective, setSessionOverride]);

  useEffect(() => {
    // Bubble phase on purpose: an editor, overlay or the shortcut recorder that
    // handles a key first calls preventDefault, and that is guard one.
    const onKeydown = (event: KeyboardEvent) => {
      const decision = decide({
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        defaultPrevented: event.defaultPrevented,
        altGraph: event.getModifierState('AltGraph'),
        editable: isEditableEvent(event),
      }, platform, index, registry);
      if (decision.kind === 'run') {
        // Only now that a real winner exists. Propagation is left alone (§8.2).
        event.preventDefault();
        decision.handler.run();
      } else if (decision.reason === 'ambiguous' && decision.id) {
        registry.execute(decision.id);
      }
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [platform, index, registry]);

  // A menu click executes through the same bus as a key or a button. The key
  // itself never arrives this way: main suppresses the menu's own shortcut
  // handling for Relayed items, so the listener above is the only key owner.
  useEffect(() => bridge()?.onCommand(id => { registry.execute(id); }), [registry]);

  return <Ctx.Provider value={bus}>{children}</Ctx.Provider>;
}

function useBus(): CommandBus {
  const bus = useContext(Ctx);
  if (!bus) throw new Error('command hook outside CommandProvider');
  return bus;
}

export interface CommandHandlerOptions {
  readonly layer: CommandLayer;
  readonly enabled?: boolean;
  readonly run: () => void;
}

/**
 * Register the current implementation of a command for as long as the calling
 * component is mounted. `run` may be a fresh closure every render; the bus
 * always calls the latest one.
 */
export function useCommandHandler(id: CommandId, { layer, enabled = true, run }: CommandHandlerOptions) {
  const { registry } = useBus();
  const runRef = useRef(run);
  runRef.current = run;
  const handleRef = useRef<ReturnType<CommandRegistry['register']> | null>(null);

  useEffect(() => {
    const handle = registry.register(id, {
      layer,
      enabled,
      run: () => runRef.current(),
      owner: `${id}@${layer}`,
    });
    handleRef.current = handle;
    return () => {
      handle.unregister();
      handleRef.current = null;
    };
    // `enabled` is applied by the effect below, so toggling it does not
    // re-register and cannot reorder anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, id, layer]);

  useEffect(() => {
    handleRef.current?.update({ enabled });
  }, [enabled]);
}

/** Every command's effective binding on this platform, in catalogue order. */
export function useCommandBindings(): { platform: Platform; effective: readonly EffectiveBinding[] } {
  const { platform, effective } = useBus();
  return { platform, effective };
}

export interface InspectedCommand {
  readonly binding: EffectiveBinding;
  readonly handlers: readonly { layer: CommandLayer; enabled: boolean; owner: string }[];
}

/** Development inspector state: bindings, mounted handlers, and a session-only remap. */
export function useCommandInspector() {
  const { registry, platform, effective, setSessionOverride } = useBus();
  const version = useSyncExternalStore(registry.subscribe, registry.getVersion);
  const commands = useMemo<InspectedCommand[]>(
    () => effective.map(binding => ({ binding, handlers: registry.handlersOf(binding.id) })),
    // `version` is the registry's signal that a handler mounted, unmounted or toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, effective, version],
  );
  return { platform, commands, setSessionOverride };
}

export interface CommandState {
  /** A handler would run now. A binding's editable-focus policy never affects this. */
  readonly enabled: boolean;
  readonly execute: () => ExecuteOutcome;
  /** The primary binding in this platform's notation, or null when unbound. */
  readonly shortcutLabel: string | null;
  /** Every effective binding as WAI-ARIA tokens, or undefined when unbound. */
  readonly ariaKeyShortcuts: string | undefined;
}

export function useCommand(id: CommandId): CommandState {
  const { registry, platform, bindings } = useBus();
  const version = useSyncExternalStore(registry.subscribe, registry.getVersion);
  return useMemo(() => {
    const hotkeys = definitionOf(id).inputPolicy === 'focused-editor' ? [] : bindings.get(id)?.hotkeys ?? [];
    const [primary] = hotkeys;
    return {
      enabled: registry.resolve(id).kind === 'winner',
      execute: () => registry.execute(id),
      shortcutLabel: primary === undefined ? null : displayChord(primary, platform),
      ariaKeyShortcuts: hotkeys.length === 0 ? undefined : hotkeys.map(hotkey => ariaChord(hotkey, platform)).join(' '),
    };
    // `version` is the external store's signal that availability changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, platform, bindings, id, version]);
}
