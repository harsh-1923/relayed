// Toolkits a test makes, and how they are cleared (for tests only).
//
// Tests share the database the dev server uses, and every enabled toolkit goes
// into every person's Composio session — so a test toolkit left enabled breaks
// every real agent's services until it is removed. That happened: a run that
// never reached its cleanup left two behind. So every test that makes one also
// clears any an earlier run left, and clears its own before anything else.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from './schema.ts';

/**
 * A test toolkit's signature: its auth config is `ac_` and its own slug. Real
 * ones come from Composio and never look like that.
 */
const madeByATest = sql<boolean>`auth_config_id = 'ac_' || slug`;

/** Remove these toolkits, and everything that names them, whatever else a cleanup does after. */
export async function removeTestToolkits(db: Kysely<DB>, slugs: readonly string[]): Promise<void> {
  if (slugs.length === 0) return;
  await db.deleteFrom('access_requests').where('toolkit', 'in', [...slugs]).execute();
  await db.deleteFrom('agent_permissions').where('toolkit', 'in', [...slugs]).execute();
  await db.deleteFrom('toolkit_tools').where('toolkit', 'in', [...slugs]).execute();
  await db.deleteFrom('toolkits').where('slug', 'in', [...slugs]).execute();
}

/** Remove every toolkit an earlier test run left behind. */
export async function sweepTestToolkits(db: Kysely<DB>): Promise<void> {
  const left = await db.selectFrom('toolkits').select('slug').where(madeByATest).execute();
  await removeTestToolkits(db, left.map(row => row.slug));
}
