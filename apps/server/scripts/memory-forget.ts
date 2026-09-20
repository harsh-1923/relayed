// Stage 4's by-hand check (docs/MEMORY.md §16).
//
//   pnpm --filter @relayed/server run memory-forget          # show what is stale
//   pnpm --filter @relayed/server run memory-forget --sweep  # and rebuild it
//
// A document is stale when the highest `messages.rev` inside its ordinal range
// is above the mark taken when it was retained — which is true after a delete,
// an edit, or an audience narrowing, and false again once rebuilt.
import { db, pool } from '../src/db/client.ts';
import { memoryConfigured } from '../src/memory/client.ts';
import { staleDocuments, forgetSweep } from '../src/memory/forget.ts';

if (!memoryConfigured()) { console.error('Hindsight is not configured.'); process.exit(1); }

const stale = await staleDocuments(db, 50);
if (stale.length === 0) {
  console.log('\nNothing stale — every document matches the messages behind it.');
  await pool.end();
  process.exit(0);
}

console.log(`\n${stale.length} document(s) changed since they were retained:\n`);
for (const document of stale) {
  console.log(`  ${document.spaceName ?? document.spaceId} · ${document.documentId}`);
  console.log(`     mark ${document.sourceRevMax} → ${document.currentRevMax}`);
}

if (!process.argv.includes('--sweep')) {
  console.log('\nPass --sweep to rebuild them.');
  await pool.end();
  process.exit(0);
}

console.log('\nsweeping…');
for (const result of await forgetSweep(db, 50)) {
  console.log(`  ${result.outcome.padEnd(8)} ${result.documentId}${result.reason ? ` — ${result.reason}` : ''}`);
}
console.log('\n"dropped" means every message behind it is gone, so there was nothing left to remember.');
await pool.end();
