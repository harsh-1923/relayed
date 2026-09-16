// Space and local-room rows for tests that project them.
import type { LocalRoom } from '../../../../shared/local-rooms.ts';
import type { Space } from '../../../../shared/spaces.ts';

const chat = (spaceId: string, kind: 'sole' | 'default' = 'sole') => ({
  id: `chat-${spaceId}`, spaceId, kind, name: null, unread: 0, mentions: 0,
});

export const space = (
  id: string,
  kind: string,
  options: { name?: string; visibility?: string | null; hydrated?: boolean; slug?: string | null } = {},
): Space => ({
  id,
  kind,
  name: options.name ?? `Space ${id}`,
  slug: options.slug ?? null,
  visibility: options.visibility ?? null,
  createdByActorId: null,
  onBehalfOfActorId: null,
  memberIds: null,
  chats: options.hydrated === false ? [] : [chat(id, kind === 'room' ? 'default' : 'sole')],
});

export const localRoom = (id: string, name: string, cwd: string): LocalRoom => ({
  ...space(id, 'room', { name, visibility: 'private' }),
  cwd,
  mode: 'auto',
  model: null,
  effort: null,
  busy: false,
  lastActivityAt: 0,
});
