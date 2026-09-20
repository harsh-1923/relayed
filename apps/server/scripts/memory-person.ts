// What memory holds about a person, and removing it (docs/MEMORY.md §5.5).
//
//   pnpm --filter @relayed/server run memory-person <actor-id>
//   pnpm --filter @relayed/server run memory-person <actor-id> --forget <document-id>
//
// The server half of the settings surface stage 6 calls for. A person bank is
// the one bank that follows somebody into every room, so being able to read all
// of it and delete any of it is not a nicety — it is what makes writing to it
// acceptable at all.
//
// The renderer surface is still to build; this is what it will call.
import { db, pool } from '../src/db/client.ts';
import { memoryConfigured } from '../src/memory/client.ts';
import { notesAbout, forgetNote } from '../src/memory/person.ts';

const [actorId, flag, documentId] = process.argv.slice(2);
if (!memoryConfigured()) { console.error('Hindsight is not configured.'); process.exit(1); }
if (!actorId) { console.error('usage: memory-person <actor-id> [--forget <document-id>]'); process.exit(1); }

const person = await db.selectFrom('actors').select(['display_name', 'handle', 'type'])
  .where('id', '=', actorId).executeTakeFirst();
if (!person) { console.error(`no such actor: ${actorId}`); process.exit(1); }
if (person.type !== 'human') { console.error('only people have a person bank.'); process.exit(1); }

if (flag === '--forget') {
  if (!documentId) { console.error('--forget needs a document id, e.g. remember:run_01M2…'); process.exit(1); }
  // By DOCUMENT, which is one `remember` call — the unit the person actually
  // performed, and the only unit that cascades.
  await forgetNote(db, actorId, documentId);
  console.log(`\nforgotten: ${documentId}`);
  await pool.end();
  process.exit(0);
}

const notes = await notesAbout(actorId);
console.log(`\n${person.display_name} (@${person.handle})`);
if (notes.length === 0) {
  console.log('\nNothing. Memory holds no working preferences for this person.');
} else {
  console.log(`\n${notes.length} thing(s) memory applies in every room:\n`);
  for (const note of notes) {
    console.log(`  · ${note.text}`);
    if (note.documentId) console.log(`    --forget ${note.documentId}`);
  }
}
await pool.end();
