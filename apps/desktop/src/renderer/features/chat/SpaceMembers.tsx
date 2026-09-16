// Who is in a space: faces and a count in the header, the whole list a click
// away. Read from this device (`useSpaceMembers`); a list not held yet is
// fetched by the read itself, and the dialog says so while it waits.
import { useState } from 'react';
import type { SpaceMember } from '../../../preload/api';
import { ActorAvatar } from '@/components/ActorAvatar';
import { AvatarGroup } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { useActor } from '@/lib/actors';
import { useSpaceMembers } from '@/lib/space-members';

const FACES = 3;

export function SpaceMembers({ spaceId }: { spaceId: string }) {
  const roster = useSpaceMembers(spaceId);
  const [open, setOpen] = useState(false);
  const count = roster.state === 'complete' ? roster.members.length : roster.count;
  const admins = roster.members.filter(member => member.role !== 'member');
  const members = roster.members.filter(member => member.role === 'member');

  return (
    <>
      <Button
        variant="ghost" size="sm"
        title="Members"
        aria-label={count === null ? 'Members' : `${count} ${count === 1 ? 'member' : 'members'}`}
        onClick={() => setOpen(true)}
      >
        {roster.members.length > 0 && (
          <AvatarGroup className="-space-x-1.5">
            {roster.members.slice(0, FACES).map(member => (
              <ActorAvatar key={member.actorId} id={member.actorId} className="size-5" fallbackClassName="text-[9px]" />
            ))}
          </AvatarGroup>
        )}
        <span className="tabular-nums">{count ?? 'Members'}</span>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Members"
        description={count === null ? 'Who is in this space' : `${count} in this space`}
        showCloseButton
      >
        <Command>
          <CommandInput autoFocus placeholder="Search members…" />
          <CommandList>
            {roster.state === 'complete' ? (
              <>
                <CommandEmpty>Nobody matches.</CommandEmpty>
                <MemberGroup heading="Owners and admins" members={admins} />
                <MemberGroup heading="Members" members={members} />
              </>
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {count === null ? 'Loading members…' : `Loading ${count} members…`}
              </p>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

function MemberGroup({ heading, members }: { heading: string; members: SpaceMember[] }) {
  if (members.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {members.map(member => <MemberRow key={member.actorId} member={member} />)}
    </CommandGroup>
  );
}

function MemberRow({ member }: { member: SpaceMember }) {
  const actor = useActor(member.actorId);
  const name = actor?.displayName ?? 'Someone';
  return (
    // Searchable by name and handle; nothing happens on select yet.
    <CommandItem value={`${name} ${actor?.handle ?? ''} ${member.actorId}`}>
      <ActorAvatar id={member.actorId} className="size-7" fallbackClassName="text-xs" profileOnHover />
      <div className="min-w-0 flex-1">
        <div className="truncate">{name}</div>
        {actor && <div className="truncate text-xs text-muted-foreground">@{actor.handle}</div>}
      </div>
      {actor?.type === 'agent' && <Badge variant="outline">agent</Badge>}
      {member.role !== 'member' && <Badge variant="secondary">{member.role}</Badge>}
      {actor && actor.state !== 'active' && <Badge variant="secondary">{actor.state}</Badge>}
    </CommandItem>
  );
}
