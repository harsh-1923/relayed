// Draw the timeline for episodes ingested before the timeline existed
// (docs/MEMORY.md §14.4).
//
//   pnpm --filter @relayed/server run memory-backfill-timeline           # show what is missing
//   pnpm --filter @relayed/server run memory-backfill-timeline --write   # and write it
//   …--write --limit 5        # a few first, to read before spending on the rest
//   …--write --space spc_…    # one room
//   …--write --redraw         # entries already drawn, again — after a prompt change
//
// NO RE-RETAIN, and that is the whole reason this is cheap. The facts already
// exist in the bank; this reads them back, narrates them, and writes the row.
// So the bill is one list call and one small narration per episode — no
// extraction, which is the expensive half (retain bills per input token).
//
// ROOMS ONLY. The panel a timeline is read in is structural to a room, so an
// entry for a channel or a DM is a row, an event and a narration nobody can
// ever see (`spaceHasTimeline`).
//
// IDEMPOTENT. An episode that already has an entry is skipped, and writing one
// is an upsert keyed on the episode — so a run interrupted halfway costs
// nothing to repeat.
//
// `--redraw` is the exception, and it is here because the NARRATION improves
// while the facts do not: a rule added to the prompt leaves every entry written
// before it stale, and re-extracting to fix prose would be absurd. It upserts
// the same rows, so ids hold and `rev` climbs — nothing is orphaned.
//
// NO FANOUT: a script holds no socket registry. The events are durable, and
// each client picks them up on its next heartbeat when the head comparison
// shows it is behind (`Pong`) — which is the same path a missed event already
// takes.
import { sql } from 'kysely';
import { db, pool } from '../src/db/client.ts';
import { memoryConfigured, factsForDocument } from '../src/memory/client.ts';
import { cleanFactText } from '../src/memory/recall.ts';
import { narrate } from '../src/memory/narrate.ts';
import { entryFor, type DueChat } from '../src/memory/ingest.ts';
import { writeTimelineEntry } from '../src/sync/timeline.ts';
import type { EpisodeMessage } from '../src/memory/episode.ts';

const when = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const args = process.argv.slice(2);
const write = args.includes('--write');
const redraw = args.includes('--redraw');
const spaceArg = args[args.indexOf('--space') + 1];
const onlySpace = args.includes('--space') && spaceArg ? spaceArg : null;
const limitArg = Number(args[args.indexOf('--limit') + 1]);
const limit = args.includes('--limit') && Number.isFinite(limitArg) ? limitArg : 500;

if (!memoryConfigured()) { console.error('Hindsight is not configured.'); process.exit(1); }

/**
 * Episodes in rooms with no entry yet, oldest first.
 *
 * Oldest first so an interrupted run leaves a CONTIGUOUS timeline from the
 * beginning rather than islands — a half-filled timeline with holes in the
 * middle reads as data loss, and one that simply stops reads as a backfill in
 * progress.
 */
const pending = await sql<{
  bank_id: string; document_id: string; chat_id: string; space_id: string;
  workspace_id: string; space_name: string | null; space_kind: string;
  visibility: 'public' | 'private' | null; ord_start: number; ord_end: number;
}>`
  SELECT d.bank_id, d.document_id, d.chat_id, d.space_id, d.workspace_id,
         s.name AS space_name, s.kind AS space_kind, s.visibility,
         d.ord_start, d.ord_end
    FROM memory_documents d
    JOIN spaces s ON s.id = d.space_id
   WHERE s.kind = 'room'
     AND ${onlySpace ? sql`d.space_id = ${onlySpace}` : sql`TRUE`}
     AND ${redraw ? sql`TRUE` : sql`NOT EXISTS (
           SELECT 1 FROM room_timeline_entries t
            WHERE t.chat_id = d.chat_id
              AND t.ord_start = d.ord_start
              AND t.ord_end = d.ord_end)`}
   ORDER BY d.ord_start
   LIMIT ${limit}`.execute(db);

if (pending.rows.length === 0) {
  console.log('\nNothing to draw — every room episode already has its entry.');
  await pool.end();
  process.exit(0);
}

const rooms = new Set(pending.rows.map((row) => row.space_name ?? row.space_id));
console.log(`\n${pending.rows.length} episode(s) ${redraw ? 'to redraw' : 'with no timeline entry'}, ` +
            `across ${rooms.size} room(s):`);
for (const room of rooms) console.log(`  · ${room}`);

if (!write) {
  console.log('\nThis was a dry run. Each episode costs one list call and one small ' +
              'narration — no retain, so no extraction.\n' +
              'Add --write to draw them.');
  await pool.end();
  process.exit(0);
}

console.log('');
let drawn = 0;
let empty = 0;
let failed = 0;

for (const row of pending.rows) {
  const where = `${row.space_name ?? row.space_id} ${row.ord_start}-${row.ord_end}`;
  try {
    const facts = (await factsForDocument(row.bank_id, row.document_id))
      .map((fact) => ({ text: cleanFactText(fact.text), message_id: null, kind: null }));
    if (facts.length === 0) {
      // Extraction was handed this conversation and decided there was nothing
      // to remember. A gap is the honest answer, not a failure (§14.6).
      console.log(`  ${where} — no facts, nothing to draw`);
      empty++;
      continue;
    }

    const episode = await messagesOf(row.chat_id, row.ord_start, row.ord_end);
    if (episode.length === 0) {
      // Every message in the range has since been deleted. The facts survive
      // in the bank until the forget sweep reaches them; an entry with no
      // conversation behind it would point at nothing.
      console.log(`  ${where} — every message gone, skipped`);
      empty++;
      continue;
    }

    const narration = await narrate({
      roomName: row.space_name ?? 'a room',
      people: [...new Map(episode.map((one) =>
        [one.authorId, { id: one.authorId, name: one.authorDisplayName }])).values()],
      facts: facts.map((fact) => fact.text),
    });

    const due = {
      chatId: row.chat_id, spaceId: row.space_id, workspaceId: row.workspace_id,
      spaceName: row.space_name, spaceKind: row.space_kind, workspaceName: null,
      visibility: row.visibility, writerActorId: '', watermark: 0,
    } satisfies DueChat;

    const { entry } = await writeTimelineEntry(db, entryFor(due, episode, facts, narration));
    console.log(`  ${when(entry.occurred_start)}  ▸ ${entry.title}`);
    if (entry.summary) console.log(`            ${entry.summary}`);
    // NOT "the runtime was unreachable", which this cannot know: a model that
    // answered with a title and no body lands here too, and on a one-fact
    // episode that is the honest answer rather than a failure. The panel draws
    // the facts instead.
    else console.log('            (no narrative — the entry falls back to its facts)');
    drawn++;
  } catch (error) {
    // One episode that cannot be drawn must not end the run: the rest are
    // independent, and re-running skips everything already written.
    console.log(`  ${where} — FAILED: ${(error as Error).message}`);
    failed++;
  }
}

console.log(`\n${drawn} drawn · ${empty} with nothing to say · ${failed} failed`);
console.log('Open a room’s Summary panel and switch to Timeline. Read a day of it and ask ' +
            'whether somebody arriving cold would understand what happened — that judgement ' +
            'is the point of the stage, not the count above.');
await pool.end();

/** The episode's own messages, as ingestion read them. */
async function messagesOf(chatId: string, from: number, to: number): Promise<EpisodeMessage[]> {
  const rows = await db.selectFrom('messages as m')
    .innerJoin('actors as a', 'a.id', 'm.author_id')
    .select(['m.id', 'm.ord', 'm.rev', 'm.body', 'm.created_at', 'm.author_id',
             'a.display_name as author_display_name', 'a.handle as author_handle',
             'a.type as author_type'])
    .where('m.chat_id', '=', chatId)
    .where('m.ord', '>=', from).where('m.ord', '<=', to)
    .where('m.deleted', '=', false)
    // The same two filters the episode was cut with, so the entry describes
    // what was actually ingested rather than what is in the range now.
    .where('m.message_kind', '=', 'actor')
    .orderBy('m.ord')
    .execute();

  return rows.map((row) => ({
    id: row.id, ord: row.ord, rev: row.rev, body: row.body,
    createdAt: new Date(row.created_at as unknown as string),
    authorId: row.author_id, authorDisplayName: row.author_display_name,
    authorHandle: row.author_handle, authorType: row.author_type,
  }));
}
