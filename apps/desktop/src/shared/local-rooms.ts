// A local room as the screen sees it (docs/LOCAL-ROOMS.md §6–§8).
import type { EffortLevel, RoomMode } from './claude.ts';
import type { Space } from './spaces.ts';

//
// A local room IS a space: its space and chats are read in the replica's own
// shape (shared/spaces.ts). What is here is only what a replica room has no
// word for: the directory it is about, and how Claude runs there.

export interface LocalRoomSettings {
  spaceId: string;
  /** The directory every chat in the room works in. Chosen by the person and shown in the room directory. */
  cwd: string;
  /** How Claude may act here without asking. */
  mode: RoomMode;
  /** The model Claude runs on here, or null for DEFAULT_ROOM_MODEL. */
  model: string | null;
  /** How hard it thinks, or null for the model's default. */
  effort: EffortLevel | null;
  /** A reply is being written somewhere in the room. One turn per room at a time (§8.1). */
  busy: boolean;
  lastActivityAt: number;
}

/** A row of the room directory: the space, and its settings beside it. */
export type LocalRoom = Space & Omit<LocalRoomSettings, 'spaceId'>;

/** What Claude is writing now. Ephemeral: never stored (§8.3). */
export interface AgentStream {
  messageId: string;
  /** The text block arriving now, whole so far. */
  text: string;
  /**
   * The source of a UI block arriving now, whole so far, or null. Drawn as a
   * card that fills in; the stored `ui` part replaces it once the block is valid
   * (AGENT-RESPONSES.md §3.4).
   */
  ui: string | null;
}

export const AGENT_STREAM_CHANNEL = 'agent:stream' as const;
