// A local room as the screen sees it (docs/LOCAL-ROOMS.md §6–§8).
import type { EffortLevel, RoomMode } from './claude.ts';

//
// The room's chats and messages use the replica's own shapes — a local room is
// read the way a synced one is — so what is here is only what a replica room
// has no word for: the directory it is about, and whether Claude is working.

export interface LocalRoomChat {
  id: string;
  /** `default` is the room's shared floor; `public` and `private` are side chats. */
  kind: string;
  name: string | null;
}

export interface LocalRoom {
  id: string;
  name: string;
  /** The directory every chat in the room works in. Chosen by the person, shown in the header. */
  cwd: string;
  /** How Claude may act here without asking. */
  mode: RoomMode;
  /** The model Claude runs on here, or null for DEFAULT_ROOM_MODEL. */
  model: string | null;
  /** How hard it thinks, or null for the model's default. */
  effort: EffortLevel | null;
  chats: LocalRoomChat[];
  /** A reply is being written somewhere in the room. One turn per room at a time (§8.1). */
  busy: boolean;
  lastActivityAt: number;
}

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
