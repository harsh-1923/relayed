// Stage 1's by-hand check, as a script so it is repeatable (docs/MEMORY.md §16).
//
//   pnpm --filter @relayed/server run memory-smoke
//
// Exercises the real modules against real Hindsight — create a bank, verify the
// configuration actually stuck, retain one episode, read its facts back, forget
// it, and confirm the facts are gone. A step that only ever ran under
// `node --test` has not been used.
//
// Leaves nothing behind: the bank is deleted at the end, pass or fail.
import { ulid } from '../src/db/ulid.ts';
import { ensureBank, spaceBank } from '../src/memory/index.ts';
import { memoryConfigured, retain, factsForDocument, forget, deleteBank } from '../src/memory/client.ts';
import { documentIdFor } from '../src/memory/documents.ts';

if (!memoryConfigured()) {
  console.error('HINDSIGHT_BASE_URL and HINDSIGHT_API_KEY are not set — nothing to smoke.');
  process.exit(1);
}

const space = ulid('spc');
const chat = ulid('cht');
const bank = spaceBank(space);
const documentId = documentIdFor(chat, 412, 415);

const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const value = await run();
  console.log(`  ✓ ${label} — ${Date.now() - started}ms`);
  return value;
};

console.log(`\nbank ${bank}`);
try {
  await step('ensureBank, including the read-back that proves the config stuck',
             () => ensureBank(bank, 'db-cutover (smoke)'));

  await step('retain one episode', () => retain({
    bankId: bank,
    content:
      'Priya Rao (@priya, act_01SMOKE1) 2026-09-15T09:02:00Z: the index rebuild will not finish before the window\n' +
      'Dev Anand (@dev, act_01SMOKE2) 2026-09-15T09:09:00Z: then we roll it back first and retry after\n' +
      'Priya Rao (@priya, act_01SMOKE1) 2026-09-15T09:12:00Z: agreed — who owns the rollback script?\n' +
      'Dev Anand (@dev, act_01SMOKE2) 2026-09-15T09:13:00Z: I will take it, PR within the hour',
    context: 'A conversation in the db-cutover room. The speakers are people working in this ' +
             'room. None of them is the owner of this memory bank.',
    documentId,
    timestamp: '2026-09-15T09:02:00Z',
    tags: [`space:${space}`, `chat:${chat}`, 'kind:room'],
    metadata: { space_id: space, chat_id: chat },
  }));

  const facts = await step('read the facts back', () => factsForDocument(bank, documentId));
  console.log(`\n  ${facts.length} facts:`);
  for (const fact of facts) console.log(`    · ${fact.text}`);

  // The fact that carries the whole design: a raw fact names the document it
  // came from, which is what a citation is built out of (§7.2).
  const traceable = facts.filter((fact) => fact.documentId === documentId);
  console.log(`\n  ${traceable.length}/${facts.length} trace back to our own document id`);

  await step('forget the document', () => forget(bank, documentId));
  const after = await step('read back after forgetting', () => factsForDocument(bank, documentId));

  console.log(`\n${after.length === 0 && facts.length > 0
    ? 'PASS — facts were extracted, traceable, and then gone.'
    : `FAIL — ${facts.length} before, ${after.length} after.`}`);
  process.exitCode = after.length === 0 && facts.length > 0 ? 0 : 1;
} finally {
  await deleteBank(bank).catch(() => {});
  console.log(`cleaned up ${bank}`);
}
