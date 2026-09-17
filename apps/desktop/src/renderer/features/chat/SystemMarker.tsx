// A durable chat marker for a successful command — "Alice was added by Bob",
// "Alice started this with Bob" — never a speech bubble
// (docs/SPACE-MEMBERSHIP-MARKERS.md, docs/SIDE-CHATS.md).
import type { ReplicaMessage } from '../../../preload/api';
import { ChatPlus, UserPlus } from '@relayed/icons';
import { MarkdownText } from './MarkdownText';
import { useActor } from '@/lib/actors';
import { Marker, MarkerIcon, MarkerContent } from '@/components/ui/marker';
import { MessageScrollerItem } from '@/components/ui/message-scroller';

export function SystemMarker({ message }: { message: ReplicaMessage }) {
  // Who a side chat was started with is in the body, as references: drawn as
  // the chips they are, not as a sentence rebuilt here.
  if (message.systemKind === 'chat.started') {
    return (
      <MessageScrollerItem messageId={message.id}>
        <Marker variant="separator">
          <MarkerIcon><ChatPlus /></MarkerIcon>
          <MarkerContent><MarkdownText text={message.body} className="inline" /></MarkerContent>
        </Marker>
      </MessageScrollerItem>
    );
  }
  return <MemberAdded message={message} />;
}

function MemberAdded({ message }: { message: ReplicaMessage }) {
  // Resolved locally by id, current names over the stored compatibility
  // string. Either directory row may not have arrived yet — the stored body
  // is the fallback for exactly that gap, not an error state.
  const subject = useActor(message.subjectActorId)?.displayName;
  const by = useActor(message.authorId)?.displayName;
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
