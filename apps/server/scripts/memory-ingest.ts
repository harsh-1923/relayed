// Stage 2's by-hand check (docs/MEMORY.md §16).
//
//   pnpm --filter @relayed/server run memory-ingest
//
// Runs ONE ingest pass and prints what it did, then reads back the facts each
// retained episode produced — which is the whole question stage 2 asks: are
// these the things a person would have written down?
//
// FORCES A PASS, bypassing MEMORY_INGEST. That flag gates the background
// ticker; an operator typing this has already decided. Hindsight still has to
// be configured, because there is nowhere to put the facts otherwise.
import { db, pool } from '../src/db/client.ts';
import { env } from '../src/env.ts';
import { dueChats, claimChat, ingestChat } from '../src/memory/ingest.ts';
import { bankForSpace } from '../src/memory/banks.ts';
import { memoryConfigured, factsForDocument } from '../src/memory/client.ts';
import { QUIET_MINUTES } from '../src/memory/episode.ts';

if (!memoryConfigured()) {
  console.error('HINDSIGHT_BASE_URL and HINDSIGHT_API_KEY are not set.');
  process.exit(1);
}

const scope = env.memoryIngestSpaces;
console.log(`\nquiet window ${QUIET_MINUTES}m · spaces ${scope ? scope.join(', ') : 'all eligible'}`);

const due = await dueChats(db, 20);
if (due.length === 0) {
  console.log('\nNothing due. Either nothing has been said since the watermark, or the ' +
              'conversation has not gone quiet yet, or Roomkeeping is not in the room.');
  await pool.end();
  process.exit(0);
}

console.log(`${due.length} chat(s) with pending messages\n`);

for (const chat of due) {
  const label = `${chat.spaceName ?? chat.spaceId} · ${chat.chatId}`;
  if (!await claimChat(db, chat)) { console.log(`  ${label} — held by another server`); continue; }

  const outcomes = await ingestChat(db, chat);
  for (const outcome of outcomes) {
    switch (outcome.state) {
      case 'waiting':
        console.log(`  ${label} — still talking, or quiet for under ${QUIET_MINUTES}m`);
        break;
      case 'failed':
        console.log(`  ${label} — FAILED: ${outcome.reason}`);
        break;
      case 'ingested': {
        console.log(`  ${label} — ${outcome.messages} message(s) → ${outcome.documentId}`);
        const bank = bankForSpace({ id: chat.spaceId, workspaceId: chat.workspaceId,
                                    visibility: chat.visibility });
        const facts = await factsForDocument(bank, outcome.documentId);
        if (facts.length === 0) {
          console.log('      no facts — extraction found nothing worth remembering here');
        }
        for (const fact of facts) console.log(`      · ${fact.text}`);

        // The timeline entry the same episode produced (MEMORY.md §14.2) —
        // printed here because the facts above and the prose below are the two
        // halves of the same pass, and reading them apart hides which one is
        // the weak link when an entry comes out wrong.
        const entry = await db.selectFrom('room_timeline_entries')
          .select(['title', 'summary'])
          .where('chat_id', '=', chat.chatId)
          .where('ord_end', '=', outcome.through)
          .executeTakeFirst();
        if (entry) {
          console.log(`\n      ▸ ${entry.title}`);
          if (entry.summary) console.log(`        ${entry.summary}`);
          else console.log('        (no narrative — the runtime was unreachable, so the ' +
                           'entry fell back to its facts)');
        }
        break;
      }
    }
  }
}

console.log('\nRead those as a person would. If they are not what you would have written ' +
            'down, the extraction mission in memory/banks.ts is the thing to change.');
await pool.end();
