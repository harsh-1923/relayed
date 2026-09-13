// The header of a space: its name, whichever store holds it. A channel, a DM
// and a room are all spaces (DESIGN.md §7.1), so there is one header and one
// read, by space id. What a scope adds beside the name — a local room's "Claude
// is working" — is passed in, not looked up here.
import type { ReactNode } from 'react';
import { useQuery } from '@/lib/query';
import type { SpaceScope } from '../../../shared/spaces.ts';

/** The read for one space, by scope. Both return the same `Space` rows. */
const SPACE_READ = { workspace: 'space.get', local: 'local.space.get' } as const;

export function SpaceHeader({ spaceId, scope, details }: { spaceId: string; scope: SpaceScope; details?: ReactNode }) {
  // The cast names one of the two reads for the type checker, which cannot
  // follow a key chosen at runtime; they take the same arguments and rows.
  const { rows } = useQuery(SPACE_READ[scope] as 'space.get', { spaceId });
  const space = rows?.[0];
  if (!space) return null;

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 px-6">
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{space.name}</h1>
      {details}
    </header>
  );
}
