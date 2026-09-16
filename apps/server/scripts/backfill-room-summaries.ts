// Give every room that predates documents its summary (docs/DOCUMENTS.md §4.1).
//
// New rooms get theirs in `createRoom`, inside the same transaction as the room
// itself. Rooms that already existed get theirs here — the same two writes, one
// transaction per room, and idempotent: a room that already has a summary is
// skipped, so running this twice writes nothing the second time.
//
// No events are appended. A backfilled document and its panel reach clients on
// their next `welcome`, which carries both completely — and every client gets a
// `welcome` on its next reconnect anyway. Appending events for rooms nobody is
// waiting on would buy a revision per room and cost the same result.
//
//   pnpm --filter @relayed/server backfill-room-summaries          # what it would do
//   pnpm --filter @relayed/server backfill-room-summaries --write  # do it
import { db, pool } from '../src/db/client.ts';
import { createRoomSummary } from '../src/sync/documents.ts';

const write = process.argv.includes('--write');

const rooms = await db.selectFrom('spaces')
  .leftJoin('documents', join => join
    .onRef('documents.space_id', '=', 'spaces.id')
    .on('documents.kind', '=', 'room_summary'))
  .select(['spaces.id as spaceId', 'spaces.workspace_id as workspaceId', 'spaces.name as name'])
  .where('spaces.kind', '=', 'room')
  .where('documents.id', 'is', null)
  .orderBy('spaces.created_at')
  .execute();

if (rooms.length === 0) {
  console.log('every room already has a summary — nothing to do');
} else if (!write) {
  console.log(`${rooms.length} room(s) would get a summary:`);
  for (const room of rooms) console.log(`  ${room.spaceId}  ${room.name ?? '(unnamed)'}`);
  console.log('\nre-run with --write to do it');
} else {
  let done = 0;
  for (const room of rooms) {
    // One transaction per room rather than one for all of them: a single bad
    // row must not roll back a thousand good ones, and this is resumable.
    await db.transaction().execute(trx =>
      createRoomSummary(trx, { workspaceId: room.workspaceId, spaceId: room.spaceId }));
    done += 1;
  }
  console.log(`${done} room(s) given a summary. Clients pick it up on their next welcome.`);
}

await pool.end();
