// Where one episode ends, and whether it is worth sending (docs/MEMORY.md §6.1).
//
// Pure, so the two decisions that shape every retain can be tested without a
// database, a clock or a network.
import { personLabel } from '../agents/people.ts';

/** A conversation has ended when nobody has spoken for this long. */
export const QUIET_MINUTES = 10;
/** A chat that never goes quiet is still cut, or it would never be ingested at all. */
export const MAX_EPISODE = 60;

export interface EpisodeMessage {
  id: string;
  ord: number;
  /** The version rule's counter. The highest in an episode is its staleness mark (027). */
  rev: number;
  body: string;
  createdAt: Date;
  authorId: string;
  authorDisplayName: string;
  authorHandle: string;
  authorType: string;
}

/**
 * The first episode in `messages`, which are in ordinal order from the watermark.
 *
 * Cut at the FIRST internal quiet gap, not at the last one. A chat that talked
 * at 09:00, again at 14:00, and only fell quiet at 14:30 has had two
 * conversations, and merging them into one retain would ask extraction to find
 * the relation between things that have none. The remainder is not lost — the
 * watermark advances only over what was taken, so the next tick sees it.
 */
export function firstEpisode(messages: readonly EpisodeMessage[]): EpisodeMessage[] {
  const episode: EpisodeMessage[] = [];
  for (const message of messages) {
    const previous = episode.at(-1);
    if (previous) {
      const quietFor = (message.createdAt.getTime() - previous.createdAt.getTime()) / 60_000;
      if (quietFor > QUIET_MINUTES) break;
      if (episode.length >= MAX_EPISODE) break;
    }
    episode.push(message);
  }
  return episode;
}

/** Has the conversation finished, or grown long enough to cut anyway? */
export function readyToIngest(episode: readonly EpisodeMessage[], now: Date): boolean {
  if (episode.length === 0) return false;
  if (episode.length >= MAX_EPISODE) return true;
  const last = episode.at(-1)!;
  return (now.getTime() - last.createdAt.getTime()) / 60_000 > QUIET_MINUTES;
}

/**
 * The transcript one retain is built from.
 *
 * RAW CONVERSATION, never a summary of one. xyne-spaces killed a whole pipeline
 * over this: their curator distilled a session and Hindsight's extraction then
 * distilled the distillation, and switching to the transcript itself gave ten
 * times the yield. Nothing is filtered or shortened on the way in — extraction
 * is the only thing that decides what is worth keeping.
 *
 * Labelled with `personLabel` so an actor reads identically here and in a
 * transcript, plus a timestamp — extraction needs speaker and time to place a
 * fact in time, and the stage 0 spike confirmed the time it is given is the time
 * it stores.
 */
export const buildEpisodeText = (episode: readonly EpisodeMessage[]): string =>
  episode.map((message) => {
    const author = {
      id: message.authorId,
      displayName: message.authorDisplayName,
      handle: message.authorHandle,
    };
    const who = personLabel(author, message.authorType === 'agent' ? 'agent' : undefined);
    return `${who} ${message.createdAt.toISOString()}: ${message.body}`;
  }).join('\n');

/** The mark that says whether this episode has changed since it was retained (027). */
export const revMax = (episode: readonly EpisodeMessage[]): number =>
  episode.reduce((highest, message) => Math.max(highest, message.rev), 0);
