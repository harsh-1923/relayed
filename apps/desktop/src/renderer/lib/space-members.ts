// Who is in a space, read from this device (SPACE-MEMBERSHIP-MARKERS.md,
// rosters). Reading a list that is not held yet asks for it; the read wakes
// when it lands. Who each member is comes from `useActor`.
import type { SpaceRoster } from '../../preload/api';
import { useQuery } from '@/lib/query';

const WAITING: SpaceRoster = { state: 'loading', count: null, members: [] };

export function useSpaceMembers(spaceId: string | null | undefined): SpaceRoster {
  const { rows } = useQuery('space.members', { spaceId: spaceId ?? '' });
  return rows?.[0] ?? WAITING;
}
