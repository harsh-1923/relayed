// A surface open beside a room's main chat, as the screen sees it (docs/PANELS.md).

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
}

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
