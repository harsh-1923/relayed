// Stage 3's by-hand check (docs/MEMORY.md §16).
//
//   pnpm --filter @relayed/server run memory-recall <space-id> "<question>"
//
// Prints exactly what a run in that space would have injected above its
// transcript, for that question — the banks it read, and the block itself.
//
// The check is two-sided and the second half matters more: ask a question in
// the room whose answer is only in memory, THEN ask the same question somewhere
// else and confirm nothing from the first room appears.
import { db, pool } from '../src/db/client.ts';
import { banksForRun, memoryPresence, publicSpaceIds } from '../src/memory/banks.ts';
import { memoryConfigured } from '../src/memory/client.ts';
import { recallForRun, memoryBlock, personPrompt, queryFrom } from '../src/memory/recall.ts';

const [spaceId, ...rest] = process.argv.slice(2);
const question = rest.join(' ');

if (!memoryConfigured()) { console.error('Hindsight is not configured.'); process.exit(1); }
if (!spaceId || !question) {
  console.error('usage: memory-recall <space-id> "<question>"');
  process.exit(1);
}

const space = await db.selectFrom('spaces')
  .select(['id', 'workspace_id', 'name', 'visibility', 'kind'])
  .where('id', '=', spaceId).executeTakeFirst();
if (!space) { console.error(`no such space: ${spaceId}`); process.exit(1); }

// Any member will do: which person asked changes only their own person bank,
// and the point here is what the SPACE makes readable.
const invoker = await db.selectFrom('memberships')
  .innerJoin('actors', 'actors.id', 'memberships.actor_id')
  .select('actors.id as id')
  .where('memberships.scope_type', '=', 'space')
  .where('memberships.scope_id', '=', spaceId)
  .where('memberships.left_at', 'is', null)
  .where('actors.type', '=', 'human')
  .executeTakeFirst();

const placement = { id: space.id, workspaceId: space.workspace_id, visibility: space.visibility };
const presence = await memoryPresence(db, space.workspace_id, invoker?.id ?? 'act_none');
const banks = banksForRun(placement, invoker?.id ?? 'act_none',
                          await publicSpaceIds(db, space.workspace_id), presence);

console.log(`\n${space.kind} ${space.name ?? space.id} · ${space.visibility ?? 'sealed'}`);
// No agent in this script, so nothing to strip — the id cannot match.
console.log(`question: ${queryFrom(question, 'act_none')}`);
console.log('\nbanks this run may read:');
for (const bank of banks) {
  console.log(`  ${bank.id}${bank.tags.length > 0 ? `  (${bank.tags.length} space tag(s), any_strict)` : ''}`);
}

const started = Date.now();
const remembered = await recallForRun(db, {
  workspaceId: space.workspace_id, spaceId: space.id, visibility: space.visibility,
  invokerActorId: invoker?.id ?? 'act_none', query: question,
});
console.log(`\nrecalled ${remembered.facts.length} fact(s) in ${Date.now() - started}ms\n`);

const block = memoryBlock(remembered.facts);
console.log(block.length > 0 ? block : '(nothing — the run would see only its transcript)');

// The person slot is printed separately because that is how the run receives
// it: instructions about how to write, never recollections about this room.
const about = personPrompt(remembered.aboutPerson);
if (about.length > 0) console.log(`\n[a separate slot in the system prompt]${about}`);
await pool.end();
