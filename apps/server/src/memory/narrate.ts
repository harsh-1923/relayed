// A title and two or three sentences for one timeline entry (docs/MEMORY.md §14.2).
//
// WHY THIS EXISTS AT ALL. §14.2 said an entry needs no model — "facts are the
// bullets, entities give the title". That held right up until the surface was
// drawn. Hindsight returns flat statements, one per thing established, and
// nothing titles them or says how they relate; an entry built from them alone
// reads as a changelog. What the timeline is FOR is somebody arriving cold and
// understanding what happened, and that is prose.
//
// SMALL, BECAUSE IT WORKS ON FACTS RATHER THAN MESSAGES. The summariser this
// replaces re-read up to four hundred messages every pass. This is handed the
// five statements extraction already produced. That is the whole reason a
// per-episode model call is affordable where a per-room one was not — and it
// runs ONCE, on a path where nobody is waiting, and is never regenerated.
//
// IT MAY FAIL, AND THE ENTRY STILL STANDS. Losing the record of an episode
// because a runtime was down would be the wrong trade, so every failure falls
// through to `mechanical`, which is the changelog reading — worse, but honest
// and never absent.
import { callRuntime } from '../agents/runtime-client.ts';
import { ulid } from '../db/ulid.ts';
import type { RunRequest } from '@relayed/protocol';

/** The same ceiling the summariser uses: above the runtime's keepalive, with slack. */
const RUNTIME_TIMEOUT_MS = 90_000;

/** Long enough to be a sentence fragment, short enough to sit on one line in the panel. */
const TITLE_LIMIT = 72;

/**
 * Beyond this the entry stops being a glance and becomes something to read.
 *
 * 420 was too tight, found by reading real entries: three substantial sentences
 * about a day of work run past it, and the clamp cut them mid-clause with an
 * ellipsis. The cap is a guard against a model that will not stop, not a length
 * target — the prompt is what asks for two or three sentences.
 */
const SUMMARY_LIMIT = 700;

export interface Narration {
  title: string;
  /** Empty only if even the fallback had nothing — which means there were no facts. */
  summary: string;
}

export interface NarrationInput {
  /** Where this happened, for the voice rather than for the content. */
  roomName: string;
  /** Who was talking. The id matters as much as the name — see `RULES`. */
  people: readonly { id: string; name: string }[];
  /** What extraction established, one statement per line. */
  facts: readonly string[];
}

/** How a person is written: the chip, the face, and nobody notified. */
export const mention = (person: { id: string; name: string }): string =>
  `[${person.name}](actor-ref:${person.id})`;

const RULES = [
  'You are writing one entry in a room\'s timeline: a record of a conversation that has',
  'already finished, for somebody reading back later.',
  '',
  'Answer in exactly this shape:',
  '  line 1: a title, under ten words, naming what this stretch of conversation was ABOUT.',
  '          Sentence case — capitalise the first word and names, nothing else.',
  '          A PHRASE, not a sentence: no full stop, and never a heading with a colon in it.',
  '          Never repeat the room name in it — the reader already knows which room this is.',
  '  line 2: blank.',
  '  line 3+: two or three sentences saying what happened and what it means now.',
  '',
  'Write in the past tense, about the people named, in plain language. Use their names.',
  'Say who decided or owns something when the facts say so.',
  'Use ONLY what the facts below state — never infer a cause, a status or a next step',
  'that is not there. Fewer sentences is better than a padded one.',
  'No markdown, no bullet points, no heading marks, no preamble, no quotes around the title.',
  '',
  // The same form `people.ts` already teaches every agent, and for the same
  // reason: a reader can hover a name to see whose it is and reach what they
  // said. `actor-ref` rather than `actor` — this is a record of a conversation
  // that finished, and nobody should be notified days later for being in one.
  'Write every person named in the SENTENCES as the exact link given beside their name',
  'below — copied character for character, brackets and all. It draws as their name',
  'and face and notifies nobody. A name with no link beside it is written plainly.',
  'NEVER put a link in the title: a title is a phrase, not a sentence with chips in it.',
].join('\n');

export function buildPrompt(input: NarrationInput): string {
  return [
    `Room: ${input.roomName}`,
    'People, and the link to write each of them as:',
    ...(input.people.length > 0
      ? input.people.map((person) => `  ${person.name} → ${mention(person)}`)
      : ['  unknown']),
    '',
    'What was established:',
    ...input.facts.map((fact) => `- ${fact}`),
  ].join('\n');
}

/** `[Harsh](actor-ref:act_1)` back to `Harsh`. */
const stripLinks = (text: string): string =>
  text.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1');

/** Trim to a word boundary, so a title never ends mid-word. */
function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  const trimmed = (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd();
  // A cut that lands INSIDE `[Harsh](actor-ref:act_…)` leaves markup a reader
  // sees raw. Backing up to before the opening bracket costs a few characters
  // of a summary that was already being truncated.
  const open = trimmed.lastIndexOf('[');
  const closed = trimmed.lastIndexOf(')');
  return `${(open > closed ? trimmed.slice(0, open).trimEnd() : trimmed)}…`;
}

/** Strip what the rules asked for and the model sometimes sends anyway. */
const clean = (line: string): string =>
  line.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s+/, '').replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^["'](.*)["']$/, '$1').trim();

/**
 * A title is a phrase, so it keeps no trailing full stop — and drops a room
 * name the model prefixed it with, which the rules forbid and it does anyway.
 *
 * MECHANICAL ONLY WHERE IT IS SAFE. The colon split takes the tail only when
 * what precedes it is the room's own name, never on a colon generally: "Postgres
 * 16: the upgrade window" is a title somebody meant to write.
 */
function titleOf(line: string, roomName: string): string {
  const room = roomName.replace(/^#/, '').trim().toLowerCase();
  const [head, ...tail] = line.split(': ');
  const withoutRoom = tail.length > 0 && head!.trim().toLowerCase() === room
    ? tail.join(': ').trim()
    : line;
  // One full stop at the end, never an ellipsis or a question mark, both of
  // which a title may legitimately carry.
  return withoutRoom.replace(/(?<!\.)\.$/, '').trim();
}

/**
 * Split the answer into its two parts.
 *
 * LENIENTLY, because the cost of being strict is losing prose we have already
 * paid for. A model that skipped the blank line still gives a usable title on
 * its first line, and one that wrote only a title gives a title.
 */
export function parseNarration(text: string, roomName = ''): Narration | null {
  const lines = text.split('\n').map(clean).filter((line) => line.length > 0);
  const first = lines[0];
  if (!first) return null;
  // Flattened rather than trusted: the rules forbid a link in the title and a
  // model puts one there anyway, and a chip in a heading is not a heading.
  const title = titleOf(stripLinks(first), roomName);
  if (title.length === 0) return null;
  return {
    title: clamp(title, TITLE_LIMIT),
    summary: clamp(lines.slice(1).join(' ').trim(), SUMMARY_LIMIT),
  };
}

/**
 * The entry with no model: the first fact as a title, the facts as the body.
 *
 * What the timeline looked like before this file existed, kept as the floor
 * rather than as an option — it is reached only when narration could not run.
 */
export function mechanical(facts: readonly string[]): Narration {
  const first = facts[0];
  if (!first) return { title: 'A conversation', summary: '' };
  return { title: clamp(first, TITLE_LIMIT), summary: clamp(facts.join(' '), SUMMARY_LIMIT) };
}

/**
 * A title and a summary for this episode, falling back rather than throwing.
 *
 * No `model` is named: narration is the deployment's runtime default, which is
 * already where a deployment says what it wants to spend. No tools and so no
 * grant, which is what lets a job call the runtime at all (§4.2).
 */
export async function narrate(input: NarrationInput): Promise<Narration> {
  if (input.facts.length === 0) return { title: 'A conversation', summary: '' };

  const body: RunRequest = {
    runId: ulid('job'),
    prompt: buildPrompt(input),
    systemPrompt: RULES,
    palette: 'none',
    tools: [],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);
  try {
    for await (const frame of callRuntime(body, controller.signal)) {
      if (frame.kind !== 'done') continue;
      if (frame.result.status !== 'completed') break;
      const parsed = parseNarration(frame.result.text, input.roomName);
      if (parsed) return parsed;
      break;
    }
  } catch {
    // Unreachable runtime, a timeout, a refusal: all the same answer. The
    // failure is not swallowed silently — the entry that lands carries the
    // mechanical reading, which is visibly worse in the panel.
  } finally {
    clearTimeout(timer);
  }
  return mechanical(input.facts);
}
