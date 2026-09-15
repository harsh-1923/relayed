// A durable chat marker for a successful command — "Alice was added by Bob" —
// never a speech bubble (docs/SPACE-MEMBERSHIP-MARKERS.md).
import type { ReplicaMessage } from '../../../preload/api';
import { UserPlus } from '@relayed/icons';
import { useQuery } from '@/lib/query';
import { Marker, MarkerIcon, MarkerContent } from '@/components/ui/marker';
import { MessageScrollerItem } from '@/components/ui/message-scroller';

export function SystemMarker({ message }: { message: ReplicaMessage }) {
  const { rows: actors } = useQuery('actors.list');
  // Resolved locally by id, current names over the stored compatibility
  // string. Either directory row may not have arrived yet — the stored body
  // is the fallback for exactly that gap, not an error state.
  const subject = actors?.find(actor => actor.id === message.subjectActorId)?.displayName;
  const by = actors?.find(actor => actor.id === message.authorId)?.displayName;
  const text = subject && by ? `${subject} was added by ${by}` : message.body;

  return (
    <MessageScrollerItem messageId={message.id}>
      <Marker variant="separator">
        <MarkerIcon><UserPlus /></MarkerIcon>
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    </MessageScrollerItem>
  );
}
