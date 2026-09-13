// How much Claude may do in a local room without asking (docs/LOCAL-ROOMS.md
// §3.4), chosen in the composer, where the person is about to ask it something.
//
// A change takes effect on Claude's next tool call, including in a reply already
// being written — so tightening it mid-turn reins Claude in without stopping it.
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ShieldCheck } from '@relayed/icons';
import { ROOM_MODES } from '../../../shared/claude.ts';
import type { RoomMode } from '../../../preload/api';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { cn } from '@/lib/utils';

/** `className` styles the trigger, so it can sit among the composer's own buttons. */
export function RoomModePicker({ spaceId, className }: { spaceId: string; className?: string }) {
  const { rows } = useQuery('local.rooms.get', { spaceId });
  const room = rows?.[0];
  const [error, setError] = useState<string | null>(null);
  if (!room) return null;

  const current = ROOM_MODES.find(entry => entry.mode === room.mode) ?? ROOM_MODES[0]!;
  const unguarded = room.mode === 'full-access';

  const choose = (mode: RoomMode) => {
    if (mode === room.mode) return;
    setError(null);
    void call(api => api.query('local.rooms.setMode', { spaceId, mode }))
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Approval mode: ${current.label}`}
        title={error ?? current.description}
        className={cn(className, unguarded && 'text-warning', error && 'text-destructive')}
      >
        {unguarded ? <AlertTriangle /> : <ShieldCheck />}
        <span>{current.label}</span>
        <ChevronDown className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>What Claude may do without asking</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={room.mode} onValueChange={value => choose(value as RoomMode)}>
            {ROOM_MODES.map(entry => (
              <DropdownMenuRadioItem key={entry.mode} value={entry.mode} className="items-start py-1.5">
                <span className="flex flex-col gap-0.5">
                  <span className={cn('font-medium', entry.mode === 'full-access' && 'text-warning')}>{entry.label}</span>
                  <span className="text-xs text-muted-foreground">{entry.description}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
