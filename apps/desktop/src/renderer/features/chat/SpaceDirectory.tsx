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
// Deliberately flat within a section. A space with one chat renders as a single
// row named after the space, because "engineering › engineering" is a hierarchy
// the data has and a person does not. The nesting only appears once a space
// holds more than one chat, which is the point at which it starts meaning
// something — and that is exactly what `kind='room'` is.
import { NavLink, useParams } from 'react-router';
import { ChevronRight, Hash, Lock, MessageCircle, Users } from 'lucide-react';
import type { ReplicaSpace } from '../../../preload/api';
import { useQuery } from '@/lib/query';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton,
  SidebarMenuSubItem,
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
        const mine = (spaces ?? []).filter(s => s.kind === section.kind);
        if (mine.length === 0) return null;
        return (
          <SidebarGroup key={section.kind}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarMenu>
              {mine.map(space => <SpaceRow key={space.id} space={space} />)}
            </SidebarMenu>
          </SidebarGroup>
        );
      })}
    </>
  );
}

function SpaceRow({ space }: { space: ReplicaSpace }) {
  // `chatId` from the URL rather than NavLink's own active state: the sidebar
  // component styles its rows off `data-active`, which `isActive` sets, and two
  // sources of "this row is selected" is one too many.
  const { wsId, chatId } = useParams();
  const label = space.name ?? space.slug ?? 'space';
  const Icon = iconFor(space);

  // One chat: the space IS the conversation, so it gets the space's name. The
  // chat's own `name` is null in that case, which is how the schema says the
  // same thing (migration 1, `chat_singleton`).
  const sole = space.chats.length === 1 ? space.chats[0] : undefined;
  if (sole) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          render={<NavLink to={`/w/${wsId}/c/${sole.id}`} />}
          isActive={chatId === sole.id}
          // Unread is weight, not colour: a bold row reads as "new" at a glance
          // and survives being colour-blind, which a dot does not.
          className={sole.unread > 0 ? 'font-medium' : undefined}
        >
          <Icon className="text-muted-foreground" />
          <span className="truncate">{label}</span>
        </SidebarMenuButton>
        {/* A mention is a different fact from an unread and outranks it — you
            can be behind on a hundred messages and none of them about you. */}
        {sole.mentions > 0 && (
          <SidebarMenuBadge className="bg-destructive text-white">
            {sole.mentions}
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    );
  }

  const mentions = space.chats.reduce((sum, c) => sum + c.mentions, 0);
  const unread = space.chats.reduce((sum, c) => sum + c.unread, 0);
  const holdsOpenChat = space.chats.some(c => c.id === chatId);

  return (
    // Open if you are reading something inside it, or if something inside it is
    // about you. A room that collapses over the chat you are in is a room that
    // hides where you are.
    <Collapsible defaultOpen={holdsOpenChat || mentions > 0} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger
          render={
            <SidebarMenuButton className={unread > 0 ? 'font-medium' : undefined} />
          }
        >
          <Icon className="text-muted-foreground" />
          <span className="truncate">{label}</span>
          <ChevronRight className="ml-auto transition-transform
                                   group-data-open/collapsible:rotate-90" />
        </CollapsibleTrigger>
        {/* On the collapsed row the count is the only sign that something inside
            wants you, so it stays whether the section is open or not. */}
        {mentions > 0 && (
          <SidebarMenuBadge className="bg-destructive text-white">{mentions}</SidebarMenuBadge>
        )}
        <CollapsibleContent>
          <SidebarMenuSub>
            {space.chats.map(chat => (
              <SidebarMenuSubItem key={chat.id}>
                <SidebarMenuSubButton
                  render={<NavLink to={`/w/${wsId}/c/${chat.id}`} />}
                  isActive={chatId === chat.id}
                  className={chat.unread > 0 ? 'font-medium' : undefined}
                >
                  <span className="truncate">{chat.name ?? 'chat'}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** Private is a padlock regardless of kind; the rest say what they are. */
function iconFor(space: ReplicaSpace) {
  if (space.kind === 'dm') return MessageCircle;
  if (space.kind === 'group_dm') return Users;
  return space.visibility === 'public' ? Hash : Lock;
}
