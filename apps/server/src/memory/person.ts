// What an agent remembers about a PERSON, rather than about a place
// (docs/MEMORY.md §5.5).
//
// THE ONE BANK THAT CROSSES A SPACE BOUNDARY, and therefore the one place in
// this design where the guarantee is semantic rather than structural. Saying
// that plainly is more useful than pretending otherwise.
//
// It rests on a distinction no model honours reliably at recall time — "Harsh
// wants terse answers" changes how a reply is written; "Harsh is worried about
// the reorg" is content that must never leave the conversation it was said in.
// So the distinction is enforced at WRITE time, twice over: only an explicit
// `remember` call writes here, and the bank's own extraction mission refuses
// subject matter even when it is handed some.
//
// The accountability that makes that acceptable: a person can read everything
// their bank holds and delete any of it, because it follows them everywhere.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ulid } from '../db/ulid.ts';
import { ensureBank, personBank, PERSON_MISSION } from './banks.ts';
import { factsForDocument, forget, recall, retain, type Fact } from './client.ts';

/** A note is one retain, under an id that identifies the asking rather than the fact. */
const documentIdFor = (runId: string): string => `remember:${runId}`;

/**
 * Write down how this person wants to be worked with.
 *
 * `context` names the speaker as the person themselves, which is what makes
 * extraction file these as facts ABOUT them rather than as the agent's own
 * experiences (§6.3).
 */
export async function remember(
  db: Kysely<DB>, actorId: string, displayName: string, note: string, runId = ulid('run'),
): Promise<string> {
  const bankId = personBank(actorId);
  await ensureBank(bankId, `${displayName} — working preferences`, PERSON_MISSION);
  const documentId = documentIdFor(runId);
  // Recorded BEFORE the retain, the same asymmetry `recordDocument` holds: a row
  // with no note costs a wasted delete, while a note with no row is invisible —
  // and here invisible also means the bank looks empty and is never opened.
  await db.insertInto('memory_person_notes')
    .values({ actor_id: actorId, document_id: documentId, run_id: runId })
    .onConflict((conflict) => conflict.columns(['actor_id', 'document_id']).doNothing())
    .execute();
  await retain({
    bankId,
    content: note,
    context: `${displayName} is describing how they want to be worked with. This memory bank ` +
             'holds their working preferences and nothing else.',
    documentId,
    timestamp: new Date().toISOString(),
    tags: [`person:${actorId}`],
    metadata: { actor_id: actorId },
  });
  return documentId;
}

export interface PersonNote { id: string; text: string; documentId: string | null }

/**
 * Everything this person's bank holds.
 *
 * A broad query rather than a listing call, because what a person wants to see
 * is "what do you know about me" — and `recall` against their own bank with a
 * question shaped like that is the closest thing to it. Nothing is filtered:
 * it is their own bank, and hiding part of it would defeat the point.
 */
export async function notesAbout(actorId: string): Promise<PersonNote[]> {
  const facts = await recall({
    bankId: personBank(actorId),
    query: 'how does this person want to be worked with?',
    tags: [],
    maxTokens: 4_096,
    timeoutMs: 10_000,
  }).catch((): Fact[] => []);
  return facts.map((fact) => ({ id: fact.id, text: fact.text, documentId: fact.documentId }));
}

/** Everything one `remember` call produced, so a person can see what it actually stored. */
export const notesFromCall = (actorId: string, runId: string): Promise<Fact[]> =>
  factsForDocument(personBank(actorId), documentIdFor(runId));

/**
 * Forget one thing they told us to remember.
 *
 * By DOCUMENT, which is one `remember` call — the unit the person actually
 * performed, and the only unit that cascades (§8.1). Forgetting a single
 * extracted fact is not offered, because per-memory deletion is unsupported and
 * pretending otherwise would leave them believing something is gone when it is
 * not.
 */
export async function forgetNote(db: Kysely<DB>, actorId: string, documentId: string): Promise<void> {
  // Hindsight first, then the row — a row removed while the note survives would
  // leave it recallable with nothing recording that it exists.
  await forget(personBank(actorId), documentId);
  await db.deleteFrom('memory_person_notes')
    .where('actor_id', '=', actorId).where('document_id', '=', documentId).execute();
}

/**
 * Has anything ever been remembered about this person?
 *
 * A local question, asked before the network one. A recall against a person
 * bank that was never written costs ~7.5 s to return nothing (028), which is
 * more than twice the deadline the run is working to.
 */
export async function hasNotes(db: Kysely<DB>, actorId: string): Promise<boolean> {
  const row = await db.selectFrom('memory_person_notes').select('document_id')
    .where('actor_id', '=', actorId).limit(1).executeTakeFirst();
  return row !== undefined;
}
