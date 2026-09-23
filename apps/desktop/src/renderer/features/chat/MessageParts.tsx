// The body of a message, part by part (docs/AGENT-RESPONSES.md, the message contract).
//
// A message with no parts is its `body`, as Markdown — every message today, and
// every message from a person. A message with parts is drawn in the order the
// parts happened.
//
// A part this build does not know means the message was written by a NEWER
// client. The whole message then falls back to `body`, which the writer derived
// from all of its parts: drawing the parts we know and silently skipping the
// rest would show a reply with a hole in it and no sign that anything is missing.
import { undrawablePartKind, PART_KINDS, type MessagePart, type StoredPart, type ToolPart } from '@relayed/protocol';
import { MarkdownText } from './MarkdownText';
import { ToolCalls } from './ToolCard';
import { UiBlock, type UiBlockHandlers } from './UiBlock/UiBlock';
import { AccessCard } from '../agents/AccessCard';

export function MessageParts({
  body, parts, authorType, streaming = false, ...handlers
}: {
  body: string;
  /** As stored: may hold kinds this build has never heard of. */
  parts?: readonly StoredPart[] | null;
  /** `actors.type` of the author. Tool and ui parts on anyone but an agent are not drawn. */
  authorType: string;
  streaming?: boolean;
} & UiBlockHandlers) {
  // The server refuses these on a person's message; a replica that holds one
  // anyway got it from somewhere else, and drawing cards under a person's name
  // is exactly the costume that rule exists to stop (docs/AGENT-RESPONSES.md, rules for rooms).
  // The DRAW rule, not the write rule: an access card is refused for every
  // author on the write path, yet drawn on the agent message the broker wrote.
  if (!parts || parts.length === 0 || undrawablePartKind(authorType, parts) !== null) {
    return <MarkdownText text={body} onOpenLink={handlers.onOpenLink} />;
  }

  if (!isKnown(parts)) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">Part of this message needs a newer version of Relayed to display.</p>
        <MarkdownText text={body} onOpenLink={handlers.onOpenLink} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {runs(parts).map(({ part, index, tools }) => {
        // A run of tools is one block of markers, however many ran.
        if (tools) {
          // While a reply streams, a tool that has not reported back has ms 0.
          return <ToolCalls key={index} parts={tools} running={tool => streaming && tool.ms === 0} />;
        }
        switch (part.kind) {
          case 'markdown':
            return <MarkdownText key={index} text={part.text} onOpenLink={handlers.onOpenLink} />;
          case 'tool':
            return null;
          case 'ui':
            // Only the LAST part can still be arriving; everything before it is whole.
            return <UiBlock key={index} part={part} streaming={streaming && index === parts.length - 1} {...handlers} />;
          case 'reply_to_ui':
            return (
              <p key={index} className="text-xs text-muted-foreground">
                Chose <span className="font-medium text-foreground">{part.label}</span>
              </p>
            );
          case 'memory':
            // Drawn in the footer as a hover card, not in the reply
            // (`MemoryHoverCard`). Provenance is reached for when an answer is
            // doubted; under every answer it competes with the answer.
            return null;
          case 'access_request':
            return <AccessCard key={index} part={part} body={body} onOpenLink={handlers.onOpenLink} />;
          case 'ambient':
            // Drawn in the header, as "unprompted · ↪ who asked" (`AmbientReference`),
            // not in the answer: it says why the answer is here, not what it says.
            return null;
        }
      })}
    </div>
  );
}

/** Parts in order, with each run of consecutive tool parts folded into one entry. */
function runs(parts: readonly MessagePart[]) {
  const out: { part: MessagePart; index: number; tools: ToolPart[] | null }[] = [];
  parts.forEach((part, index) => {
    const last = out.at(-1);
    if (part.kind !== 'tool') out.push({ part, index, tools: null });
    else if (last?.tools) last.tools.push(part);
    else out.push({ part, index, tools: [part] });
  });
  return out;
}

/** Known kinds only. The shape of each was checked by the server that stored it. */
function isKnown(parts: readonly StoredPart[]): parts is readonly MessagePart[] {
  return parts.every(part => PART_KINDS.has(part.kind));
}
