// `body`, derived from a message's parts (docs/AGENT-RESPONSES.md, body is derived).
//
// Search, notifications, previews and every client that predates parts read
// `body` and nothing else, so it has to say what the parts say. It lives here
// rather than in @relayed/protocol because a ui part's text comes from the
// library's own `text()` functions.
//
// The server derives it on write and stores that; a client derives it too, for
// the moment between composing and the server's event arriving. Same function,
// same answer.
import type { MessagePart } from '@relayed/protocol';
import { validateUi } from './validate.ts';

/** The input keys, in order, that say what a tool acted on. */
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query'] as const;

/** One line naming what a tool acted on — the command, the file, the pattern. Empty when nothing fits. */
export function summariseTool(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const fields = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = fields[key];
    if (typeof value === 'string' && value.length > 0) return value.split('\n')[0] ?? '';
  }
  return '';
}

/** A code span that survives backticks inside it (CommonMark: a longer fence, padded). */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

function partText(part: MessagePart): string {
  switch (part.kind) {
    case 'markdown':
      return part.text;
    case 'tool': {
      const summary = summariseTool(part.input);
      return summary ? `▸ ${part.name} ${codeSpan(summary)}` : `▸ ${part.name}`;
    }
    case 'ui':
      return validateUi(part.source).text;
    case 'reply_to_ui':
      // Drawn as "Chose …"; the words the person sent are the markdown part beside it.
      return '';
  }
}

export function deriveBody(parts: readonly MessagePart[]): string {
  return parts.map(partText).filter(text => text.length > 0).join('\n\n');
}
