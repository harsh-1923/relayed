// Give every existing workspace its system agents, and every existing room its
// Roomkeeping membership (docs/DOCUMENTS.md §12, step 3).
//
// New workspaces get the agents in `seedWorkspace` and new rooms get the
// membership in `createRoom`. This is the same two things for everything that
// already exists, and it is idempotent both ways: an agent already provisioned
// is left exactly as it is — instructions included — and a room Roomkeeping is
// already in is skipped.
//
// Unlike the documents backfill, this one DOES append events: `actor.created`
// on the workspace stream and `space.member_added` on each room's. They are
// what puts Roomkeeping in a connected client's mention autocomplete and member
// list without a reconnect, and both streams are ones every recipient reads in
// full anyway.
//
//   pnpm --filter @relayed/server backfill-system-agents               # what it would do
//   pnpm --filter @relayed/server backfill-system-agents --write       # do it
//   pnpm --filter @relayed/server backfill-system-agents --workspace wsp_… [--write]
//
// A development database accumulates workspaces from test runs, so
// `--workspace` exists to do one rather than all of them.
import { db, pool } from '../src/db/client.ts';
import {
  provisionSystemAgents, roomsWithoutRoomkeeper, systemAgentId, ROOMKEEPER_HANDLE,
} from '../src/provisioning/system-agents.ts';
import { addRoomkeeper } from '../src/sync/spaces.ts';

const write = process.argv.includes('--write');
const only = process.argv[process.argv.indexOf('--workspace') + 1];

const workspaces = await db.selectFrom('workspaces').select(['id', 'name'])
  .$if(process.argv.includes('--workspace'), qb => qb.where('id', '=', only ?? ''))
  .orderBy('created_at').execute();
if (workspaces.length === 0) {
  console.log(only ? `no workspace ${only}` : 'no workspaces');
  await pool.end();
  process.exit(0);
}

let agentsAdded = 0;
let roomsJoined = 0;

for (const workspace of workspaces) {
  const before = await systemAgentId(db, workspace.id, ROOMKEEPER_HANDLE);
  if (write) {
    const events = await provisionSystemAgents(db, workspace.id);
    agentsAdded += events.length;
    if (events.length > 0) console.log(`${workspace.name}: provisioned ${events.length} system agent(s)`);
  } else if (!before) {
    console.log(`${workspace.name}: would provision @relay and @${ROOMKEEPER_HANDLE}`);
    agentsAdded += 2;
  }

  // Read after provisioning, so a workspace that just got Roomkeeping has its
  // rooms done in the same pass rather than needing a second run.
  const roomkeeperId = await systemAgentId(db, workspace.id, ROOMKEEPER_HANDLE);
  // On a dry run there is no Roomkeeping to be missing from anything yet, so
  // the worklist is every active room — which is what --write would produce
  // once the agent it just reported exists.
  const rooms = roomkeeperId
    ? await roomsWithoutRoomkeeper(db, roomkeeperId, workspace.id)
    : await db.selectFrom('spaces').select(['id', 'name'])
      .where('workspace_id', '=', workspace.id).where('kind', '=', 'room')
      .where('lifecycle', '=', 'active').orderBy('created_at').execute();
  for (const room of rooms) {
    if (!write) {
      console.log(`${workspace.name}: would add @${ROOMKEEPER_HANDLE} to ${room.name ?? room.id}`);
      roomsJoined += 1;
      continue;
    }
    // One transaction per room: a single bad row must not roll back the rest,
    // and this is resumable.
    await db.transaction().execute(trx => addRoomkeeper(trx, workspace.id, room.id));
    roomsJoined += 1;
  }
  if (write && rooms.length > 0) {
    console.log(`${workspace.name}: added @${ROOMKEEPER_HANDLE} to ${rooms.length} room(s)`);
  }
}

if (agentsAdded === 0 && roomsJoined === 0) console.log('nothing to do — every workspace and room is already set up');
else if (!write) console.log('\nre-run with --write to do it');

await pool.end();
