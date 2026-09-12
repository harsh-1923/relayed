// The spaces this actor is in, grouped by what kind of space they are.
//
// SPACES, not channels, and the name is load-bearing. `spaces` is one table
// discriminated by `kind` — `channel | dm | group_dm | room` in both schemas —
// and a "room" is one of those four, the one that holds several chats
// (DESIGN.md §7.1). Calling the whole directory a room directory would put the
// code at odds with the schema it reads and the document that settles it.
//
// Read from the replica through the live-query client, so joining a space or
// having a channel created around you repaints without a reload — the loop that
// `chat.created` and `space.member_added` invalidate `spaces` for.
//
// A SECTION WITH NOTHING IN IT DOES NOT RENDER. Phase 2 writes only
// `kind='channel'`, so three of the four are empty today, and four headings
// over one list would describe the schema rather than the person's workspace.
//
// Deliberately flat within a section. Every space is one destination; rooms
// enter through their default chat and keep their other chats inside the room.
import type { ReplicaSpace } from '../../../preload/api';
import { SpaceDirectoryRow } from './SpaceDirectoryRow.tsx';
import { useQuery } from '@/lib/query';
import {
  SidebarGroup, SidebarGroupLabel, SidebarMenu,
} from '@/components/ui/sidebar';

/**
 * The sections, in the order they appear.
 *
 * An array rather than a map, because the ORDER is part of the answer and a map
 * would leave it to whatever the runtime feels like. `kind` values are the
 * schema's, spelled here exactly once.
 */
const SECTIONS = [
  { kind: 'channel', label: 'Channels' },
  { kind: 'room', label: 'Rooms' },
  { kind: 'group_dm', label: 'Group messages' },
  { kind: 'dm', label: 'Direct messages' },
] as const;

// Temporary design fixtures. They follow the real replica rows so the spaces a
// person can actually visit remain first, while every directory shape is still
// available to design against. Keeping them development-only means a packaged
// app always renders the replica's answer, including its genuine empty state.
const DUMMY_SPACES: ReplicaSpace[] = [
  {
    id: 'dummy-channel-announcements',
    kind: 'channel',
    name: 'announcements',
    slug: 'announcements',
    visibility: 'public',
    chats: [{
      id: 'dummy-chat-announcements',
      spaceId: 'dummy-channel-announcements',
      kind: 'main',
      name: null,
      unread: 4,
      mentions: 1,
    }],
  },
  {
    id: 'dummy-channel-design',
    kind: 'channel',
    name: 'design',
    slug: 'design',
    visibility: 'public',
    chats: [{
      id: 'dummy-chat-design',
      spaceId: 'dummy-channel-design',
      kind: 'main',
      name: null,
      unread: 12,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-channel-engineering',
    kind: 'channel',
    name: 'engineering',
    slug: 'engineering',
    visibility: 'public',
    chats: [{
      id: 'dummy-chat-engineering',
      spaceId: 'dummy-channel-engineering',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-channel-leadership',
    kind: 'channel',
    name: 'leadership',
    slug: 'leadership',
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-leadership',
      spaceId: 'dummy-channel-leadership',
      kind: 'main',
      name: null,
      unread: 2,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-channel-customer-feedback',
    kind: 'channel',
    name: 'customer-feedback',
    slug: 'customer-feedback',
    visibility: 'public',
    chats: [{
      id: 'dummy-chat-customer-feedback',
      spaceId: 'dummy-channel-customer-feedback',
      kind: 'main',
      name: null,
      unread: 9,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-channel-marketing',
    kind: 'channel',
    name: 'marketing',
    slug: 'marketing',
    visibility: 'public',
    chats: [{
      id: 'dummy-chat-marketing',
      spaceId: 'dummy-channel-marketing',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-channel-random',
    kind: 'channel',
    name: 'random',
    slug: 'random',
    visibility: 'public',
    chats: [{
      id: 'dummy-chat-random',
      spaceId: 'dummy-channel-random',
      kind: 'main',
      name: null,
      unread: 24,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-channel-research',
    kind: 'channel',
    name: 'research',
    slug: 'research',
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-research',
      spaceId: 'dummy-channel-research',
      kind: 'main',
      name: null,
      unread: 3,
      mentions: 1,
    }],
  },
  {
    id: 'dummy-channel-support',
    kind: 'channel',
    name: 'support',
    slug: 'support',
    visibility: 'public',
    chats: [{
      id: 'dummy-chat-support',
      spaceId: 'dummy-channel-support',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-room-product-launch',
    kind: 'room',
    name: 'Product launch',
    slug: 'product-launch',
    visibility: 'public',
    chats: [
      {
        id: 'dummy-chat-launch-general',
        spaceId: 'dummy-room-product-launch',
        kind: 'default',
        name: 'General',
        unread: 6,
        mentions: 0,
      },
      {
        id: 'dummy-chat-launch-copy',
        spaceId: 'dummy-room-product-launch',
        kind: 'public',
        name: 'Launch copy',
        unread: 3,
        mentions: 2,
      },
      {
        id: 'dummy-chat-launch-rollout',
        spaceId: 'dummy-room-product-launch',
        kind: 'public',
        name: 'Rollout plan',
        unread: 0,
        mentions: 0,
      },
    ],
  },
  {
    id: 'dummy-room-mobile-app',
    kind: 'room',
    name: 'Mobile app',
    slug: 'mobile-app',
    visibility: 'private',
    chats: [
      {
        id: 'dummy-chat-mobile-general',
        spaceId: 'dummy-room-mobile-app',
        kind: 'default',
        name: 'General',
        unread: 0,
        mentions: 0,
      },
      {
        id: 'dummy-chat-mobile-bugs',
        spaceId: 'dummy-room-mobile-app',
        kind: 'public',
        name: 'Bug reports',
        unread: 5,
        mentions: 0,
      },
      {
        id: 'dummy-chat-mobile-releases',
        spaceId: 'dummy-room-mobile-app',
        kind: 'public',
        name: 'Release planning',
        unread: 0,
        mentions: 0,
      },
    ],
  },
  {
    id: 'dummy-group-design-critique',
    kind: 'group_dm',
    name: 'Design critique',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-design-critique',
      spaceId: 'dummy-group-design-critique',
      kind: 'main',
      name: null,
      unread: 7,
      mentions: 1,
    }],
  },
  {
    id: 'dummy-group-weekend-plans',
    kind: 'group_dm',
    name: 'Weekend plans',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-weekend-plans',
      spaceId: 'dummy-group-weekend-plans',
      kind: 'main',
      name: null,
      unread: 16,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-group-hiring-panel',
    kind: 'group_dm',
    name: 'Hiring panel',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-hiring-panel',
      spaceId: 'dummy-group-hiring-panel',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-maya',
    kind: 'dm',
    name: 'Maya Chen',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-maya',
      spaceId: 'dummy-dm-maya',
      kind: 'main',
      name: null,
      unread: 2,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-jordan',
    kind: 'dm',
    name: 'Jordan Lee',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-jordan',
      spaceId: 'dummy-dm-jordan',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-priya',
    kind: 'dm',
    name: 'Priya Kapoor',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-priya',
      spaceId: 'dummy-dm-priya',
      kind: 'main',
      name: null,
      unread: 5,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-alex',
    kind: 'dm',
    name: 'Alex Morgan',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-alex',
      spaceId: 'dummy-dm-alex',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-sam',
    kind: 'dm',
    name: 'Sam Rivera',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-sam',
      spaceId: 'dummy-dm-sam',
      kind: 'main',
      name: null,
      unread: 1,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-noah',
    kind: 'dm',
    name: 'Noah Williams',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-noah',
      spaceId: 'dummy-dm-noah',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-elena',
    kind: 'dm',
    name: 'Elena García',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-elena',
      spaceId: 'dummy-dm-elena',
      kind: 'main',
      name: null,
      unread: 8,
      mentions: 0,
    }],
  },
  {
    id: 'dummy-dm-omar',
    kind: 'dm',
    name: 'Omar Hassan',
    slug: null,
    visibility: 'private',
    chats: [{
      id: 'dummy-chat-omar',
      spaceId: 'dummy-dm-omar',
      kind: 'main',
      name: null,
      unread: 0,
      mentions: 0,
    }],
  },
];

export function SpaceDirectory() {
  const { rows: spaces, status } = useQuery('spaces.list');
  const visibleSpaces = import.meta.env.DEV
    ? [...(spaces ?? []), ...DUMMY_SPACES]
    : spaces;

  if (!import.meta.env.DEV && status === 'loading') {
    return <p className="px-4 py-2 text-sm text-muted-foreground">Reading…</p>;
  }

  // Distinct from `loading` on purpose: a workspace genuinely without spaces is
  // a different fact from one whose first read has not landed, and the copy has
  // to say which (FRONTEND.md §6.2).
  if (!import.meta.env.DEV && status === 'empty') {
    return <p className="px-4 py-2 text-sm text-muted-foreground">Nothing here yet.</p>;
  }

  return (
    <>
      {SECTIONS.map(section => {
        const mine = (visibleSpaces ?? []).filter(space => space.kind === section.kind);
        if (mine.length === 0) return null;
        return (
          <SidebarGroup key={section.kind}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarMenu className="space-y-0.5">
              {mine.map(space => (
                <SpaceDirectoryRow key={space.id} space={space} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        );
      })}
    </>
  );
}
