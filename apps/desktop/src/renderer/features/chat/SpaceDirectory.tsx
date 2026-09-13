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

export function SpaceDirectory() {
  const { rows: spaces, status } = useQuery('spaces.list');

  if (status === 'loading') {
    return <p className="px-4 py-2 text-sm text-muted-foreground">Reading…</p>;
  }

  // Distinct from `loading` on purpose: a workspace genuinely without spaces is
  // a different fact from one whose first read has not landed, and the copy has
  // to say which (FRONTEND.md §6.2).
  if (status === 'empty') {
    return <p className="px-4 py-2 text-sm text-muted-foreground">Nothing here yet.</p>;
  }

  return (
    <>
      {SECTIONS.map(section => {
        const mine = (spaces ?? []).filter(space => space.kind === section.kind);
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
