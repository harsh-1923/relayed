// The sidebar: the spaces this actor is in, and the chats inside them.
//
// Read from the replica through the live-query client, so joining a space or
// having a channel created around you repaints without a reload — the loop that
// `chat.created` and `space.member_added` invalidate `spaces` for.
//
// Deliberately flat. A space with one chat renders as a single row named after
// the space, because "engineering › engineering" is a hierarchy the data has
// and a person does not. The nesting only appears once a space holds more than
// one chat, which is the point at which it starts meaning something.
import { NavLink, useParams } from 'react-router';
import { useQuery } from '@/lib/query';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Hash, Lock } from 'lucide-react';

export function ChannelList() {
  const { wsId } = useParams();
  const { rows: spaces, status } = useQuery('chats.list');

  return (
    <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-border/60 p-3">
      <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground">
        Channels
      </p>

      {status === 'loading' && (
        <p className="px-2 text-sm text-muted-foreground">Reading…</p>
      )}

      {/* Distinct from `loading` on purpose: a workspace genuinely without
          channels is a different fact from one whose first read has not landed,
          and the copy has to say which (FRONTEND.md §6.2). */}
      {status === 'empty' && (
        <p className="px-2 text-sm text-muted-foreground">
          No channels yet.
        </p>
      )}

      {(spaces ?? []).map(space => {
        // One chat: the space IS the channel, so it gets the space's name. The
        // chat's own `name` is null in that case, which is how the schema says
        // the same thing (migration 1, `chat_singleton`).
        const sole = space.chats.length === 1 ? space.chats[0] : undefined;
        if (sole) {
          return (
            <ChannelRow
              key={sole.id} wsId={wsId} chatId={sole.id}
              label={space.name ?? space.slug ?? 'channel'}
              privateSpace={space.visibility !== 'public'}
              unread={sole.unread} mentions={sole.mentions}
            />
          );
        }
        return (
          <div key={space.id} className="pt-2">
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              {space.name ?? space.slug}
            </p>
            {space.chats.map(chat => (
              <ChannelRow
                key={chat.id} wsId={wsId} chatId={chat.id}
                label={chat.name ?? 'chat'}
                privateSpace={space.visibility !== 'public'}
                unread={chat.unread} mentions={chat.mentions}
              />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

function ChannelRow({
  wsId, chatId, label, privateSpace, unread, mentions,
}: {
  wsId: string | undefined;
  chatId: string;
  label: string;
  privateSpace: boolean;
  unread: number;
  mentions: number;
}) {
  const Icon = privateSpace ? Lock : Hash;
  return (
    <NavLink
      to={`/w/${wsId}/c/${chatId}`}
      className={({ isActive }) => cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        'hover:bg-accent hover:text-accent-foreground',
        isActive && 'bg-accent text-accent-foreground',
        // Unread is weight, not colour: a bold row reads as "new" at a glance
        // and survives being colour-blind, which a blue dot does not.
        unread > 0 && 'font-medium',
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* A mention is a different fact from an unread and outranks it — you can
          be behind on a hundred messages and none of them are about you. */}
      {mentions > 0 && (
        <Badge variant="destructive" className="h-5 px-1.5 text-[11px]">
          {mentions}
        </Badge>
      )}
    </NavLink>
  );
}
