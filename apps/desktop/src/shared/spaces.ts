// A space as the screen sees it, whichever store holds it (DESIGN.md §7.1).
//
// ONE SHAPE FOR BOTH SCOPES. A local room is a space whose rows live in
// `local-rooms.db` rather than the replica; the tables are the same column for
// column, so the read is too. What only a local room has — its folder, how
// Claude runs there — is a separate read (`LocalRoomSettings`), never mixed in.

/** Which store a space is read from: the workspace replica, or `local-rooms.db`. */
export type SpaceScope = 'workspace' | 'local';

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
  /**
   * Who created it, and whose request it was when an agent made it for
   * someone. Null for a local room and for a space synced before either was
   * carried. Neither grants anything.
   */
  createdByActorId: string | null;
  onBehalfOfActorId: string | null;
  /** Who a DM or group DM is between, you included. Null for every other kind. */
  memberIds: string[] | null;
  chats: SpaceChat[];
}

/**
 * The chat a space opens on: its `sole` chat, or a room's `default`. Exactly
 * one per space, by the `chat_singleton` index in both stores.
 */
export const mainChat = (space: Pick<Space, 'chats'>): SpaceChat | null =>
  space.chats.find(chat => chat.kind === 'sole' || chat.kind === 'default') ?? null;

/**
 * The space a message link opens, or null. An agent links a room it made as
 * `[name](space:spc_…)` — an app link rather than a web address, so the room
 * opens in the app and the link means nothing anywhere else.
 */
export function spaceLinkTarget(href: string | undefined): string | null {
  const match = href ? /^space:(spc_[A-Za-z0-9_-]+)$/.exec(href) : null;
  return match?.[1] ?? null;
}

/**
 * What a space is called when it has no name of its own. A DM or group DM is
 * called by the other people in it — `otherNames`, from the directory, in the
 * order they were given — and by its kind until the directory has them.
 */
export function spaceName(
  row: { kind: string; name: string | null; slug: string | null },
  otherNames: readonly string[] = [],
): string {
  if (row.name) return row.name;
  if (row.slug) return row.slug;
  if (row.kind === 'dm' || row.kind === 'group_dm') {
    if (otherNames.length === 1) return otherNames[0]!;
    if (otherNames.length > 1) return `${otherNames.slice(0, -1).join(', ')} and ${otherNames.at(-1)}`;
    return row.kind === 'dm' ? 'Direct message' : 'Group message';
  }
  return 'Untitled';
}

/** The most people in a group DM, you included — the server's limit, repeated so the picker can say so. */
export const DM_MAX_MEMBERS = 9;
