// Which bank a fact belongs in, and which banks a run may read
// (docs/MEMORY.md §5.2, §7.1).
//
// THIS FILE IS THE PERMISSION MODEL. Hindsight has no cross-bank query — a
// recall runs inside exactly one bank and cannot name another's memories — so
// choosing the bank IS the access decision, evaluated once here rather than
// re-derived at every call site.
//
// The fork the stage 0 spike settled lives in `bankForSpace` and `banksForRun`
// alone: tags were the alternative and a production leak elsewhere ruled them
// out (§5.3). If that decision is ever revisited, these two functions are the
// only bodies that change.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { applyBankConfig, createBank, readBankConfig, type BankConfig } from './client.ts';

/**
 * What extraction is told to look for.
 *
 * Unsteered defaults produce thin generic facts; a domain mission over a real
 * transcript produced ten times the atomic facts in xyne-spaces' 4-way bank
 * comparison. The last line matters as much as the list: it gives extraction
 * explicit permission to return nothing.
 *
 * "Do not extract questions" is here because the spike's one weak fact was
 * `"Sam Oyelaran is inquiring if the cutover is confirmed"` — a question, not
 * something anyone learned.
 */
export const MEMORY_MISSION = [
  'Extract: decisions and who made them; who owns what work; blockers and their causes;',
  'root causes and fixes; commitments with dates; references to systems, tickets and documents.',
  'Do not extract: greetings, thanks, reactions, scheduling chatter, questions that were not',
  'answered, opinions stated in passing, or anything obvious from the room name.',
  'If nothing here is worth remembering, extract nothing.',
].join(' ');

/**
 * What extraction is told to look for in a PERSON bank — and what to refuse.
 *
 * The person bank is the only bank that crosses a space boundary (§5.5), so it
 * is the only place where the guarantee is semantic rather than structural.
 * That guarantee gets two layers, not one:
 *
 *   1. it is written only by an explicit `remember` call the person asked for,
 *      never by background extraction; and
 *   2. this mission, which refuses subject matter even when it is handed some.
 *
 * The distinction it enforces: *"Harsh wants terse answers and thinks
 * database-first"* changes how a reply is written and is safe anywhere.
 * *"Harsh is worried about the reorg"* is content, and must never leave the
 * conversation it was said in.
 */
export const PERSON_MISSION = [
  'Extract only durable preferences about how this person wants to be worked with:',
  'the format, length and tone they want; how they like to be addressed; conventions and',
  'tools they prefer; what they own or are responsible for; what they want you to do by default.',
  'Do NOT extract: anything about the subject of a conversation, other people, incidents,',
  'decisions, events, tickets, systems, dates, or anything that happened.',
  'If this is not a lasting preference about this person, extract nothing.',
].join(' ');

/**
 * Bank ids.
 *
 * DERIVED FROM A ULID, NEVER FROM A NAME. That is the rule, and it is not the
 * one §5.2 first wrote down. The invariant there said every bank id contains
 * the workspace id, taken from xyne-spaces' bug — `bankIdForAgent(slug)` made
 * same-slug agents in different orgs share one bank. But their ids came from a
 * HUMAN-CHOSEN SLUG, which collides; ours are ULIDs, which do not. A space id
 * alone is globally unique, so the workspace id adds no separation.
 *
 * It also does not fit: `wsp_` and `spc_` ULIDs are 40 characters each, and a
 * bank id is capped near 63 (probed — 63 accepted, with underscores and
 * uppercase). Two would not fit, and truncating a workspace id to make room
 * would take its TIME PREFIX, which two workspaces created in the same
 * millisecond share — turning a permission boundary into a birthday problem.
 *
 * `workspace_id` still rides on every `memory_documents` row, where an admin
 * count and a space sweep actually need it.
 */
export const workspaceBank = (workspaceId: string): string => `mem_w_${workspaceId}`;
export const spaceBank = (spaceId: string): string => `mem_s_${spaceId}`;
export const personBank = (actorId: string): string => `mem_p_${actorId}`;

/** Just enough of a space to place it. Read from `spaces`, never guessed. */
export interface SpacePlacement {
  id: string;
  workspaceId: string;
  visibility: 'public' | 'private' | null;
}

/**
 * Is this space readable by anyone in the workspace?
 *
 * `visibility` is NULL for a DM and a group DM (`DESIGN.md` §7.1), and NULL is
 * emphatically not public — so this asks for the positive case rather than
 * negating the private one. `NOT private` would let a NULL through, which is
 * the exact shape of the CHECK-constraint bug in AGENTS.md's table.
 */
export const isPublicSpace = (space: SpacePlacement): boolean => space.visibility === 'public';

/**
 * Where this space's facts are written.
 *
 * Public spaces share the workspace bank because every workspace member may
 * join them, so a wall between them would separate things that are not
 * separated. Everything else gets its own, because everything else is a real
 * boundary.
 */
export const bankForSpace = (space: SpacePlacement): string =>
  isPublicSpace(space) ? workspaceBank(space.workspaceId) : spaceBank(space.id);

/** One bank a run may read, with the tag filter that narrows it. */
export interface ReadableBank {
  id: string;
  /** Empty means no filter. Non-empty is matched `any_strict`, which excludes untagged. */
  tags: string[];
}

/**
 * The banks a run may read, and nothing else.
 *
 * THE TEST IS THE AUDIENCE, NOT THE INVOKER (§5.1). `buildTranscript` uses the
 * agent-and-invoker intersection and is right to: the transcript is the chat's
 * own messages, already visible to everyone in it. A recalled fact comes from
 * elsewhere and is SPOKEN INTO the chat, so it has to be readable by everyone
 * who will see the reply.
 *
 * Each entry below holds because of a structural fact, not a check:
 *
 *   · the workspace bank — every member of the chat is a workspace member, and
 *     a public space is joinable by every workspace member;
 *   · the space's own bank — every member of the chat is a member of the space,
 *     which is the leading conjunct of the access predicate (`DESIGN.md` §7.3);
 *   · the invoker's person bank — the one semantic guarantee (§5.5), which is
 *     why it is written only on an explicit request and never by extraction.
 */
/**
 * What is known, locally, to hold anything — so a bank that holds nothing is
 * never opened.
 *
 * Measured 2026-09-19: a recall against a bank that has never been written to
 * takes **1.8 s for a space bank and 7.5 s for a person bank** to return
 * nothing. Two of the three banks a DM run opens are usually in exactly that
 * state, so a run spent seconds on silence and the 3 s deadline then fell on
 * the one bank with something to say — which is how a working recall came back
 * empty and unexplained.
 */
export interface MemoryPresence {
  /** Spaces in this workspace that have ever been ingested. */
  spacesWithMemory: ReadonlySet<string>;
  /** Whether anything has ever been remembered about the invoker. */
  personHasNotes: boolean;
}

export function banksForRun(
  space: SpacePlacement, invokerActorId: string, publicSpaceIds: readonly string[],
  presence: MemoryPresence,
): ReadableBank[] {
  // The live public list, PLUS THIS SPACE ITSELF — and the second half is not a
  // convenience, it is what makes a conversion survivable.
  //
  // A public room's facts live in the workspace bank tagged `space:<id>`. When
  // that room goes private it drops out of the public list, which is exactly
  // what stops every OTHER space from recalling it. Without this it would also
  // stop the room recalling its own history, and nothing would have moved those
  // facts anywhere else — the room would silently lose its memory at the moment
  // it was made more private.
  //
  // Its own members may read its own history whatever its visibility is now:
  // joining a space discloses the whole backlog (`DESIGN.md` §7.4), so this
  // grants nothing the messages do not already.
  //
  // It is also what makes the document move in §8.2 genuinely optional rather
  // than merely deferred.
  const readable = new Set([...publicSpaceIds, space.id]);

  // Only the readable spaces that actually hold something. An empty tag list
  // here would mean "no filter" to `any_strict`, so the workspace bank is
  // dropped entirely rather than opened unfiltered.
  const tags = [...readable]
    .filter((id) => presence.spacesWithMemory.has(id))
    .map((id) => `space:${id}`);

  const banks: ReadableBank[] = [];
  if (tags.length > 0) banks.push({ id: workspaceBank(space.workspaceId), tags });
  if (!isPublicSpace(space) && presence.spacesWithMemory.has(space.id)) {
    banks.push({ id: spaceBank(space.id), tags: [] });
  }
  if (presence.personHasNotes) banks.push({ id: personBank(invokerActorId), tags: [] });
  return banks;
}

/** What this workspace and this person actually hold — one query each, both local. */
export async function memoryPresence(
  db: Kysely<DB>, workspaceId: string, invokerActorId: string,
): Promise<MemoryPresence> {
  const [spaces, note] = await Promise.all([
    db.selectFrom('memory_documents').select('space_id').distinct()
      .where('workspace_id', '=', workspaceId).execute(),
    db.selectFrom('memory_person_notes').select('document_id')
      .where('actor_id', '=', invokerActorId).limit(1).executeTakeFirst(),
  ]);
  return {
    spacesWithMemory: new Set(spaces.map((row) => row.space_id)),
    personHasNotes: note !== undefined,
  };
}

/**
 * Spaces any workspace member may read, right now.
 *
 * Read on every recall rather than cached, and that is the whole enforcement
 * mechanism for a public room going private (§8.2). Moving documents between
 * banks would take minutes of re-extraction, and every minute in which the
 * facts stayed reachable would be a permanent leak — whatever the agent says
 * gets read and repeated.
 *
 * Archived spaces stay in the list: their facts remain readable to everyone who
 * could read them, and only ingestion stops (§5.4).
 */
export async function publicSpaceIds(db: Kysely<DB>, workspaceId: string): Promise<string[]> {
  const rows = await db.selectFrom('spaces').select('id')
    .where('workspace_id', '=', workspaceId)
    .where('visibility', '=', 'public')
    .execute();
  return rows.map((row) => row.id);
}

/**
 * The re-filter, and it is the enforcement rather than hardening.
 *
 * Banks separate spaces from each other. But every public space shares the
 * workspace bank, separated only by a `space:<id>` tag — so INSIDE that bank a
 * tag is carrying a permission boundary, which is the configuration that
 * over-matched for xyne-spaces on 2026-05-25 and left every read path in their
 * repo re-filtering in JavaScript.
 *
 * The stage 0 spike found `any_strict` behaving correctly here, and that is not
 * a reason to drop this: a filter that behaves today is not a boundary. "We
 * already filter by tag" is the plausible argument for deleting these four
 * lines, and it would be wrong.
 *
 * It is possible at all because every recalled fact carries its tags — the
 * spike's first assertion, and the one that could have split the bank map.
 */
export function refilter<T extends { tags: string[] }>(
  facts: readonly T[], allowed: ReadableBank,
): T[] {
  if (allowed.tags.length === 0) return [...facts];
  const permitted = new Set(allowed.tags);
  return facts.filter((fact) => fact.tags.some((tag) => permitted.has(tag)));
}

/**
 * Create the bank if absent, apply the config, and VERIFY IT STUCK.
 *
 * The verify is the point. Hindsight materialises a bank row lazily, and a
 * config write before that returns 200 while persisting nothing — which is how
 * xyne-spaces ran production banks on defaults for months with no error
 * anywhere. The stage 0 spike found it no longer reproducing on client 0.10.0,
 * so the warmup-retain repair they needed is not built. The read-back stays:
 * one cheap call against a failure mode that is otherwise completely silent.
 */
export async function ensureBank(bankId: string, name: string,
                                 instructions = MEMORY_MISSION): Promise<void> {
  const config: BankConfig = { name, instructions };
  await createBank(bankId, config);
  if (await configStuck(bankId, instructions)) return;

  await applyBankConfig(bankId, config);
  if (await configStuck(bankId, instructions)) return;

  throw new Error(
    `memory: bank ${bankId} did not keep its configuration after two attempts. ` +
    'It would silently run Hindsight defaults — see MEMORY.md §6.4.');
}

/**
 * A marker from the mission, not the whole string: the resolved config nests
 * differently across versions, and a deep-equality check would fail on a shape
 * change rather than on the thing it is guarding.
 */
async function configStuck(bankId: string, instructions: string): Promise<boolean> {
  const resolved = await readBankConfig(bankId);
  // A marker from the instructions, not the whole string: the resolved config
  // nests differently across versions, and a deep-equality check would fail on
  // a shape change rather than on the thing it is guarding.
  return JSON.stringify(resolved ?? {}).includes(instructions.slice(0, 40));
}
