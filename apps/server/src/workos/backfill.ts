// One-off repair: give every organization that predates the Management API a
// real WorkOS organization, and its members real WorkOS memberships.
//
//   pnpm --filter @relayed/server backfill:orgs        (dry run)
//   pnpm --filter @relayed/server backfill:orgs --apply
//
// Written as a script rather than a migration on purpose. A SQL migration
// cannot make network calls, and one that could would be a migration whose
// success depends on a third party being reachable — the worst possible thing
// to put in a deploy path.
//
// Idempotent: rows already holding a real id are skipped, so a partial run is
// resumed rather than repeated.
import { db, pool } from '../db/client.ts';
import { createOrganization, addMember, WorkOSError } from './management.ts';

const apply = process.argv.includes('--apply');

const pending = await db.selectFrom('organizations')
  .select(['id', 'name', 'workos_org_id'])
  .where('workos_org_id', 'like', 'pending_%')
  .execute();

console.log(`${pending.length} organization(s) still on a placeholder id`);
if (!apply) console.log('DRY RUN — pass --apply to write\n');

for (const org of pending) {
  // Every human actor in the org, so their WorkOS membership is created too.
  const actors = await db.selectFrom('actors')
    .select(['id', 'identity_id', 'handle'])
    .where('org_id', '=', org.id)
    .where('type', '=', 'human')
    .where('identity_kind', '=', 'workos_user')
    .where('state', '<>', 'deactivated')
    .execute();

  console.log(`  ${org.id}  ${org.name}`);
  console.log(`    ${org.workos_org_id} -> (new)   members: ${actors.length}`);
  if (!apply) continue;

  try {
    const created = await createOrganization(org.name);
    await db.updateTable('organizations')
      .set({ workos_org_id: created.id }).where('id', '=', org.id).execute();
    console.log(`    created ${created.id}`);

    for (const a of actors) {
      if (!a.identity_id) continue;
      try {
        await addMember(created.id, a.identity_id);
        console.log(`    member  @${a.handle}`);
      } catch (e) {
        // A membership that already exists is success, not failure.
        const err = e as WorkOSError;
        console.warn(`    member  @${a.handle} FAILED ${err.code}: ${err.message}`);
      }
    }
  } catch (e) {
    const err = e as WorkOSError;
    console.error(`    FAILED ${err.code}: ${err.message}`);
  }
}

await pool.end();
