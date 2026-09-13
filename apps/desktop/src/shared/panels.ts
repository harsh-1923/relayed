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
