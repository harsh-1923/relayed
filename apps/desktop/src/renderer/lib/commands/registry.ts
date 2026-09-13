// The command bus: which mounted handler executes a command ID
// (SHORTCUTS.md §7.1, §8.1).
//
// No React and no DOM, so the precedence rules run under `node --test`. The
// provider owns one instance per window; features reach it through
// `useCommandHandler` and `useCommand`, never directly.
//
// The rule that makes it deterministic: the highest LAYER with an eligible
// handler wins, and registration order never breaks a tie. Two eligible
// handlers in one layer is a defect, reported by name and executed by neither.
import { COMMAND_LAYERS, type CommandId, type CommandLayer } from '../../../shared/shortcuts/catalogue.ts';

export type ExecuteOutcome = 'handled' | 'disabled' | 'unavailable';

export interface HandlerRegistration {
  readonly layer: CommandLayer;
  readonly enabled: boolean;
  /** Read at execution time, so a handler never runs a stale closure. */
  readonly run: () => void;
  /** Names the registration in an ambiguity report. */
  readonly owner: string;
}

export interface HandlerHandle {
  update(next: Partial<Pick<HandlerRegistration, 'enabled' | 'run'>>): void;
  unregister(): void;
}

export type Resolution =
  | { readonly kind: 'winner'; readonly handler: HandlerRegistration }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ambiguous'; readonly layer: CommandLayer; readonly owners: readonly string[] };

export interface CommandRegistryOptions {
  /** Development throws; production reports and executes neither (§7.1). */
  readonly onAmbiguous: (id: CommandId, layer: CommandLayer, owners: readonly string[]) => void;
}

const precedence = (layer: CommandLayer) => COMMAND_LAYERS.indexOf(layer);

export class CommandRegistry {
  readonly #handlers = new Map<CommandId, Set<{ current: HandlerRegistration }>>();
  readonly #listeners = new Set<() => void>();
  readonly #options: CommandRegistryOptions;
  #version = 0;

  constructor(options: CommandRegistryOptions) {
    this.#options = options;
  }

  register(id: CommandId, registration: HandlerRegistration): HandlerHandle {
    const slot = { current: registration };
    const slots = this.#handlers.get(id) ?? new Set();
    slots.add(slot);
    this.#handlers.set(id, slots);
    this.#changed();
    return {
      update: next => {
        const enabledChanged = next.enabled !== undefined && next.enabled !== slot.current.enabled;
        slot.current = { ...slot.current, ...next };
        // A new `run` closure every render is expected and not a state change;
        // only availability is something a button re-renders for.
        if (enabledChanged) this.#changed();
      },
      unregister: () => {
        if (!slots.delete(slot)) return;
        if (slots.size === 0) this.#handlers.delete(id);
        this.#changed();
      },
    };
  }

  resolve(id: CommandId): Resolution {
    const slots = this.#handlers.get(id);
    if (!slots || slots.size === 0) return { kind: 'unavailable' };
    const byLayer = new Map<CommandLayer, HandlerRegistration[]>();
    for (const slot of slots) {
      if (!slot.current.enabled) continue;
      byLayer.set(slot.current.layer, [...(byLayer.get(slot.current.layer) ?? []), slot.current]);
    }
    const layers = [...byLayer.keys()].sort((left, right) => precedence(right) - precedence(left));
    const [top] = layers;
    if (top === undefined) return { kind: 'disabled' };
    const eligible = byLayer.get(top) ?? [];
    if (eligible.length > 1) {
      return { kind: 'ambiguous', layer: top, owners: eligible.map(handler => handler.owner) };
    }
    const [handler] = eligible;
    return handler ? { kind: 'winner', handler } : { kind: 'disabled' };
  }

  /** Execute through the bus. Used by buttons, menus and the keyboard adapter alike. */
  execute(id: CommandId): ExecuteOutcome {
    const resolution = this.resolve(id);
    switch (resolution.kind) {
      case 'winner':
        resolution.handler.run();
        return 'handled';
      case 'ambiguous':
        this.#options.onAmbiguous(id, resolution.layer, resolution.owners);
        return 'unavailable';
      default:
        return resolution.kind;
    }
  }

  /** What is registered for a command, highest layer first. For the development inspector. */
  handlersOf(id: CommandId): Pick<HandlerRegistration, 'layer' | 'enabled' | 'owner'>[] {
    return [...(this.#handlers.get(id) ?? [])]
      .map(({ current }) => ({ layer: current.layer, enabled: current.enabled, owner: current.owner }))
      .sort((left, right) => precedence(right.layer) - precedence(left.layer));
  }

  /** For `useSyncExternalStore`: bumps whenever a command's availability may have changed. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  #changed() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }
}
