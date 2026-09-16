// A surface open beside a room's main chat, as the screen sees it (docs/PANELS.md).
import { isStructuralPanel } from './documents.ts';

export const PANEL_TYPES = ['chat', 'web', 'diff', 'file', 'attachment'] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

/** The panel types a local panel may be. A chat always syncs, so never `chat` (§3.4). */
export const CONTENT_PANEL_TYPES = ['web', 'diff', 'file', 'attachment'] as const;
export type ContentPanelType = (typeof CONTENT_PANEL_TYPES)[number];

export const isContentPanelType = (value: unknown): value is ContentPanelType =>
  typeof value === 'string' && (CONTENT_PANEL_TYPES as readonly string[]).includes(value);

export interface Panel {
  id: string;
  spaceId: string;
  /** A type this build does not know is kept and drawn as a placeholder, never dropped (§3.3). */
  type: string;
  /** The chat a chat panel shows; null for every other type. */
  chatId: string | null;
  payload: Record<string, unknown>;
  title: string | null;
  openedFromChatId: string | null;
  /** `local`: only on this device, and shareable. `shared`: everyone entitled to it has it. */
  scope: 'local' | 'shared';
  createdAt: number;
  /**
   * When the room last opened it — moved forward when the same page is opened
   * again. A synced room's panel only; a local one carries its `createdAt`.
   */
  openedAt: number;
  /** Who opened it, and for whom: an agent and the person it acted for. Null for a panel opened on this device. */
  createdByActorId: string | null;
  onBehalfOfActorId: string | null;
}

/**
 * What this device learned about a panel by showing it — never synced. Every
 * field optional: an absent one draws the fallback, and fields a newer build
 * wrote are left alone.
 */
export interface PanelMeta {
  /** The page's own `<title>`, as last seen. */
  pageTitle?: string;
  /** A sha256 in the account's blob store, served as `relayed-blob://`. */
  iconBlob?: string;
}

export interface PanelMetaRow { panelId: string; meta: PanelMeta }

/**
 * Parse `?p=`. Ids in order, duplicates and blanks dropped. Resolving each to a
 * panel — including a bare chat id to that chat's panel — is the reader's job,
 * against what the room actually holds (§8).
 */
export function parsePanelParam(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map(id => id.trim()).filter(Boolean))];
}

export const formatPanelParam = (ids: readonly string[]): string => ids.join(',');

/**
 * The panels `?p=` names, in its order, against what the room holds. An id is
 * a panel id, or a chat id standing for that chat's panel — so a link written
 * before panels existed still opens. Ids that match nothing are dropped: a
 * removed panel, or another device's local one (§8).
 */
export function resolveOpenPanels<P extends Pick<Panel, 'id' | 'chatId'>>(ids: readonly string[], panels: readonly P[]): P[] {
  const open: P[] = [];
  for (const id of ids) {
    const panel = panels.find(candidate => candidate.id === id) ?? panels.find(candidate => candidate.chatId === id);
    if (panel && !open.includes(panel)) open.push(panel);
  }
  return open;
}

/**
 * The tab shown in the panel container: `?pa=` when it names an open tab, else
 * the last one opened. One panel is shown at a time; the rest wait as tabs.
 */
export function activePanelId(ids: readonly string[], requested: string | null): string | null {
  if (requested && ids.includes(requested)) return requested;
  return ids.at(-1) ?? null;
}

/**
 * The tabs after closing one, and which is shown next. Closing a background tab
 * leaves the shown one alone; closing the shown one moves to its right-hand
 * neighbour, or its left when it was last — as a browser does.
 */
export function closePanelTab(ids: readonly string[], active: string | null, closing: string): { ids: string[]; active: string | null } {
  const index = ids.indexOf(closing);
  if (index === -1) return { ids: [...ids], active };
  const next = ids.filter(id => id !== closing);
  if (active !== closing) return { ids: next, active };
  return { ids: next, active: next[index] ?? next[index - 1] ?? null };
}

/** What Toggle room panels does from the current view and configured rows. */
export function panelContainerToggle(
  containerOpen: boolean,
  panels: readonly Pick<Panel, 'id'>[],
): { kind: 'close' } | { kind: 'open'; panelId: string | null } {
  if (containerOpen) return { kind: 'close' };
  return { kind: 'open', panelId: panels.at(-1)?.id ?? null };
}

/** When each shared panel was last opened, as a room view last saw them. */
export type SeenPanels = ReadonlyMap<string, number>;

/**
 * A panel that can ARRIVE: one somebody opened for the room.
 *
 * A structural panel is excluded, and that is the whole of the rule: a room's
 * summary has existed since the room did, so it never arrives, and treating it
 * as an arrival reopens the container somebody just closed — which is what it
 * did before this filter (DOCUMENTS.md §8.1).
 */
const arrivable = (panel: Pick<Panel, 'id' | 'openedAt' | 'scope' | 'type'>): boolean =>
  panel.scope === 'shared' && !isStructuralPanel(panel);

export const seenPanels = (panels: readonly Pick<Panel, 'id' | 'openedAt' | 'scope' | 'type'>[]): Map<string, number> =>
  new Map(panels.filter(arrivable).map(panel => [panel.id, panel.openedAt]));

/**
 * What a synced room's tabs become as its shared panels change (PANELS.md) —
 * or null when nothing should move.
 *
 * - **Arriving in the room** (`seen` is null) with nothing open: the most
 *   recently opened panel is shown, unless this person closed it earlier. The
 *   room looks like what everyone is working beside.
 * - **A panel opened while here** — new, or opened again: it becomes a tab for
 *   everyone present. It is shown only if nothing else was: someone reading
 *   another tab keeps reading it, and the new one waits beside it.
 *
 * Closing is never undone by arriving again: `dismissed` is what this person
 * closed in this room, kept only for as long as the app runs. Opening the page
 * again in the room is new, though, and shows it once more.
 *
 * A STRUCTURAL PANEL IS NOT AN ARRIVAL. The room's summary is always a tab
 * (`withSummaryFirst`) and is never in `?p=`, so this must not reach for it:
 * doing so reopened the container every time somebody closed it, because the
 * two hooks remember a close differently — this one by panel id in `?p=`, the
 * summary's by room — and a panel that is never in `?p=` could never be
 * recorded as dismissed.
 */
export function panelArrivals(input: {
  seen: SeenPanels | null;
  panels: readonly Pick<Panel, 'id' | 'openedAt' | 'scope' | 'type'>[];
  open: { containerOpen: boolean; ids: readonly string[]; active: string | null };
  dismissed: ReadonlySet<string>;
}): { ids: string[]; active: string | null } | null {
  const shared = input.panels.filter(arrivable);

  if (input.seen === null) {
    if (input.open.containerOpen) return null;
    const latest = shared.filter(panel => !input.dismissed.has(panel.id))
      .reduce<typeof shared[number] | null>((best, panel) => (!best || panel.openedAt > best.openedAt ? panel : best), null);
    return latest ? { ids: [latest.id], active: latest.id } : null;
  }

  const seen = input.seen;
  const arrived = shared
    .filter(panel => !seen.has(panel.id) || panel.openedAt > (seen.get(panel.id) ?? 0))
    .sort((a, b) => a.openedAt - b.openedAt);
  if (arrived.length === 0) return null;

  const ids = [...input.open.ids];
  for (const panel of arrived) if (!ids.includes(panel.id)) ids.push(panel.id);
  const lookingAtSomething = input.open.containerOpen && input.open.active !== null && input.open.ids.includes(input.open.active);
  return { ids, active: lookingAtSomething ? input.open.active : arrived.at(-1)!.id };
}
