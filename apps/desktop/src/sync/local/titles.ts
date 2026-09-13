// A local room's name (docs/LOCAL-ROOMS.md §7.1).
//
// The folder is already the group a room sits under in the sidebar, so the
// room's own name says what the conversation is about. It moves through three
// steps, each its own function so that each can be switched off on its own —
// the `TitlePolicy` below is the one place a setting will plug in:
//
//   1. seed       On the first message, the message itself, cut short. Free and
//                 instant, so the room never sits as "New room" while a reply
//                 streams.
//   2. generate   In the background, a small model names it from that first
//                 message. Replaces the seed unless the person renamed the room
//                 in the meantime.
//   3. regenerate On request, from the whole conversation and the old name.
//
// And `rename`, which always wins: a generated title only ever replaces the
// default name or the seed, checked again at the moment it is written.
//
// The shape follows t3code's thread titles (apps/server/src/orchestration,
// textGeneration): seed from the first message, title in the background, guard
// on replace, regenerate from the transcript.
import { topic } from '../../shared/topics.ts';
import type { RunnerOps } from '../../shared/claude.ts';
import type { LocalStore } from './store.ts';

/** What a room is called before anyone has said anything in it. */
export const DEFAULT_ROOM_TITLE = 'New room';

/** Longest name kept. Past it, the end is replaced with an ellipsis. */
export const TITLE_MAX_CHARS = 50;

/** The model titles are asked of: small, fast, and on every plan. */
export const TITLE_MODEL = 'claude-haiku-4-5';

/** How much of a conversation a regenerated title reads, and how much of the first message is always kept. */
const CONTEXT_MAX_CHARS = 8_000;
const FIRST_MESSAGE_MAX_CHARS = 2_000;
const TRUNCATED = '[Earlier messages left out]';

/** Retries after a failed generation, and the wait before the first. */
const RETRIES = 2;
const RETRY_BASE_MS = 2_000;

/**
 * Which steps run. Every step is on today; a setting reads into this, and a
 * step that is off simply does not happen — rename and regenerate stay
 * available, because the person asked for them.
 */
export interface TitlePolicy {
  seedFromFirstMessage: boolean;
  generateFromFirstMessage: boolean;
}

export const DEFAULT_TITLE_POLICY: TitlePolicy = { seedFromFirstMessage: true, generateFromFirstMessage: true };

// ── pure ────────────────────────────────────────────────────────────────────

/** Whitespace collapsed, and cut to TITLE_MAX_CHARS with an ellipsis. */
export function clampTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_MAX_CHARS ? flat : `${flat.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** The first message as a name: its text, flattened and cut. Null when there is nothing to use. */
export function seedTitle(message: string): string | null {
  const title = clampTitle(message);
  return title.length > 0 ? title : null;
}

/**
 * Whether an automatic title may replace what a room is called now: only the
 * default, or the seed it was given. Anything else was typed by the person.
 */
export function canReplaceTitle(current: string, seed: string | null): boolean {
  const name = current.trim();
  return name === DEFAULT_ROOM_TITLE || (seed !== null && name === seed.trim());
}

/**
 * A model's answer as a name: the `title` of a JSON answer or the text itself,
 * first line only, without wrapping quotes, clamped. Null when nothing is left.
 */
export function sanitizeTitle(output: unknown): string | null {
  let raw = typeof output === 'object' && output !== null ? (output as { title?: unknown }).title : output;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { raw = (JSON.parse(raw) as { title?: unknown }).title; } catch { /* not JSON: use it as text */ }
  }
  if (typeof raw !== 'string') return null;
  const line = raw.trim().split(/\r?\n/)[0] ?? '';
  const title = clampTitle(line.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').replace(/[.!]+$/, ''));
  return title.length > 0 && title !== DEFAULT_ROOM_TITLE ? title : null;
}

/** One turn of a conversation, as a title reads it. */
export interface TitleTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * A conversation as a regenerated title reads it: the most recent
 * CONTEXT_MAX_CHARS, and — if that leaves the start out — the first message
 * pinned ahead of it, since it usually says what the room is for.
 */
export function titleContext(turns: readonly TitleTurn[]): string {
  const sections = turns
    .map(turn => ({ role: turn.role, body: turn.text.trim() }))
    .filter(section => section.body.length > 0)
    .map(section => `${section.role.toUpperCase()}:\n${section.body}`);

  const recent = takeRecent(sections, CONTEXT_MAX_CHARS);
  if (!recent.truncated) return recent.text;

  const first = sections.find(section => section.startsWith('USER:'));
  if (!first) return `${TRUNCATED}\n\n${recent.text}`;
  const pinned = first.length > FIRST_MESSAGE_MAX_CHARS ? `${first.slice(0, FIRST_MESSAGE_MAX_CHARS - 1)}…` : first;
  const rest = takeRecent(sections, CONTEXT_MAX_CHARS - pinned.length - TRUNCATED.length - 4);
  return `${pinned}\n\n${TRUNCATED}\n\n${rest.text}`;
}

function takeRecent(sections: readonly string[], budget: number): { text: string; truncated: boolean } {
  let text = '';
  for (let index = sections.length - 1; index >= 0; index--) {
    const section = sections[index]!;
    const joined = text ? `${section}\n\n${text}` : section;
    if (joined.length > budget) {
      const room = budget - text.length - (text ? 2 : 0);
      return { text: room > 0 ? `${section.slice(-room)}${text ? `\n\n${text}` : ''}` : text, truncated: true };
    }
    text = joined;
  }
  return { text, truncated: false };
}

const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string', description: 'The room name, 3 to 8 words.' } },
  required: ['title'],
  additionalProperties: false,
} as const;

const EDITORIAL_RULES = `Rules:
- 3 to 8 words, under 40 characters.
- A short noun phrase or plain action phrase, in sentence case.
- Name the subject and the outcome wanted. Leave out how the work should be done: which tools, models, formats or steps.
- When the request lists several symptoms or steps, name the goal they share.
- Do not copy or cut down the person's words.
- Do not say the work is done.
- No folder or project name (the app already shows it), no quotes, no labels, no trailing punctuation.`;

/** Instructions for naming a room from its first message. */
export function firstMessagePrompt(): string {
  return `You name conversations in Relayed, a chat app where a person talks to Claude about the code in one folder.
Name this conversation from the person's first message, so they can find it again weeks later.
Answer with JSON containing only "title".

${EDITORIAL_RULES}`;
}

/** Instructions for renaming a room from its conversation so far. */
export function regeneratePrompt(previous: string): string {
  return `You name conversations in Relayed, a chat app where a person talks to Claude about the code in one folder.
This conversation is currently called ${JSON.stringify(previous)}. Give it a better name, so the person can find it again weeks later.
Answer with JSON containing only "title".

Work it out in this order:
1. Read what the PERSON (USER) asked. Its subject stays the subject until they clearly change what the conversation is about.
2. Use CLAUDE's replies (ASSISTANT) only to make vague references concrete, never to replace the subject with one finding.
3. Keep what is accurate in the current name; replace it when it is generic, just the first message cut short, or no longer true.

${EDITORIAL_RULES}
- A conversation moving from questions to changes to testing is still about the same thing.
- Return a name that is meaningfully better, not a reworded copy of the current one.`;
}

// ── the steps ───────────────────────────────────────────────────────────────

export interface RoomTitlesDeps {
  store: () => LocalStore | null;
  runner: { request: (op: 'text.generate', params: RunnerOps['text.generate']['params']) => Promise<RunnerOps['text.generate']['result']> };
  invalidate: (topics: string[]) => void;
  policy?: () => TitlePolicy;
  sleep?: (ms: number) => Promise<void>;
  /** Reports a title that could not be generated. Never the message or the title. */
  onError?: (step: 'generate' | 'regenerate', error: unknown) => void;
}

export function createRoomTitles(deps: RoomTitlesDeps) {
  const policy = deps.policy ?? (() => DEFAULT_TITLE_POLICY);
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const changed = () => deps.invalidate([topic.localRooms()]);

  const ask = async (instructions: string, input: string): Promise<string | null> => {
    const { output } = await deps.runner.request('text.generate', { instructions, input, model: TITLE_MODEL, schema: TITLE_SCHEMA });
    return sanitizeTitle(output);
  };

  /** Step 1: name the room after its first message, if it still has the default name. */
  function seed(spaceId: string, message: string): string | null {
    const store = deps.store();
    const room = store?.room(spaceId);
    const title = seedTitle(message);
    if (!store || !room || !title || !canReplaceTitle(room.name, null)) return null;
    if (store.replaceRoomName(spaceId, title, [DEFAULT_ROOM_TITLE])) changed();
    return title;
  }

  /**
   * Step 2: a model names the room from its first message, retried with
   * backoff. Written only if the room is still called what it was when this
   * began — the default or the seed — so a rename in the meantime stands.
   */
  async function generate(spaceId: string, message: string, seeded: string | null): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const title = await ask(firstMessagePrompt(), message.slice(0, CONTEXT_MAX_CHARS));
        if (!title) return null;
        const store = deps.store();
        const keep = [DEFAULT_ROOM_TITLE, ...(seeded ? [seeded] : [])];
        if (store?.replaceRoomName(spaceId, title, keep)) { changed(); return title; }
        return null;
      } catch (error) {
        if (attempt >= RETRIES) { deps.onError?.('generate', error); return null; }
        await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }

  /** The first message in a room: seed, then generate, as the policy allows. Returns once the seed is written. */
  function onFirstMessage(spaceId: string, message: string): Promise<string | null> {
    const current = policy();
    const seeded = current.seedFromFirstMessage ? seed(spaceId, message) : null;
    if (!current.generateFromFirstMessage) return Promise.resolve(seeded);
    return generate(spaceId, message, seeded);
  }

  /**
   * Step 3: name the room again from its conversation. Resolves with the new
   * name, or null when the model had nothing better — the same name, or none.
   * The person asked, so it replaces whatever the room is called, unless they
   * renamed it while this ran.
   */
  async function regenerate(spaceId: string): Promise<string | null> {
    const store = deps.store();
    const room = store?.room(spaceId);
    if (!store || !room) throw new Error(`no local room ${spaceId}`);
    const context = titleContext(store.titleTurns(spaceId));
    if (!context) return null;
    let title: string | null;
    try {
      title = await ask(regeneratePrompt(room.name), context);
    } catch (error) {
      deps.onError?.('regenerate', error);
      throw error;
    }
    if (!title || title === room.name) return null;
    if (!deps.store()?.replaceRoomName(spaceId, title, [room.name])) return null;
    changed();
    return title;
  }

  /** What the person typed. Always wins. */
  function rename(spaceId: string, name: string): string {
    const title = clampTitle(name);
    if (!title) throw new Error('A room name cannot be empty.');
    const store = deps.store();
    if (!store) throw new Error('local rooms need a signed-in account');
    store.renameRoom(spaceId, title);
    changed();
    return title;
  }

  const handlers = {
    'local.rooms.rename': (params: unknown) => {
      const { spaceId, name } = (params ?? {}) as { spaceId?: string; name?: unknown };
      if (!spaceId || typeof name !== 'string') throw new Error('spaceId and name required');
      return { name: rename(spaceId, name) };
    },
    'local.rooms.regenerateTitle': async (params: unknown) => {
      const spaceId = (params as { spaceId?: string } | undefined)?.spaceId;
      if (!spaceId) throw new Error('spaceId required');
      return { name: await regenerate(spaceId) };
    },
  };

  return { seed, generate, onFirstMessage, regenerate, rename, handlers };
}
