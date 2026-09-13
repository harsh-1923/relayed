// A space as the screen sees it, whichever store holds it (DESIGN.md §7.1).
//
// ONE SHAPE FOR BOTH SCOPES. A local room is a space whose rows live in
// `local-rooms.db` rather than the replica; the tables are the same column for
// column, so the read is too. What only a local room has — its folder, how
// Claude runs there — is a separate read (`LocalRoomSettings`), never mixed in.

export interface SpaceChat {
  id: string;
  spaceId: string;
  /** `sole` for a channel or DM, `default` for a room's floor, `public`/`private` for a room's side chats. */
  kind: string;
  /** Null for a `sole` or `default` chat: it is the space, and has the space's name. */
  name: string | null;
  unread: number;
  mentions: number;
}

export interface Space {
  id: string;
  kind: string;
  /** Always something to show. A DM has no name of its own, and is given one when read. */
  name: string;
  slug: string | null;
  /** Null for a DM or group DM, which are neither public nor private. */
  visibility: string | null;
  chats: SpaceChat[];
}

/**
 * The chat a space opens on: its `sole` chat, or a room's `default`. Exactly
 * one per space, by the `chat_singleton` index in both stores.
 */
export const mainChat = (space: Pick<Space, 'chats'>): SpaceChat | null =>
  space.chats.find(chat => chat.kind === 'sole' || chat.kind === 'default') ?? null;

/** What a space is called when it has no name of its own. */
export function spaceName(row: { kind: string; name: string | null; slug: string | null }): string {
  if (row.name) return row.name;
  if (row.slug) return row.slug;
  // Deriving a DM's name from its members needs the member list, which the
  // replica does not hold yet: it replicates only the caller's own memberships.
  if (row.kind === 'dm') return 'Direct message';
  if (row.kind === 'group_dm') return 'Group message';
  return 'Untitled';
}
