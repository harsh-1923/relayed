// The Composio session behind one PERSON — created once, reused by every agent
// they invoke (docs/WORKSPACE-AGENTS-IMPL.md, step 7, D24).
//
// Composio asks for a new session per user or per "materially different tool
// policy" and warns that creating one per request leaves thousands behind. Tools
// are found at run time, so the only policy left is which toolkits the
// deployment offers: the session is recreated when that set changes, and
// re-pinned (not recreated) when the person's own connections change.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { ComposioError, createSession, patchSessionAccounts } from './composio.ts';

/**
 * The toolkits Composio refused when a session named them, or none. Its words:
 * "Invalid toolkit slugs: a, b. Please provide valid toolkit slugs."
 */
export function rejectedToolkits(err: unknown): string[] {
  if (!(err instanceof ComposioError)) return [];
  const match = /invalid toolkit slugs?:\s*([^.]+)/i.exec(err.message);
  return match?.[1] ? match[1].split(',').map(slug => slug.trim()).filter(Boolean) : [];
}

/**
 * Create a session, and once more without the toolkits Composio refused.
 *
 * ONE BAD ROW MUST NOT TAKE EVERY SERVICE DOWN. Every enabled toolkit goes into
 * every session, so a toolkit Composio does not have — seen for real: rows a
 * test run left enabled in a shared database — failed every search and every
 * call, for everyone. The refused ones are left out of this session only; the
 * catalogue is not changed here, since a refusal is not ours to act on beyond
 * this request. Keyed by the full list (`sessionFor`), so the next call reuses
 * the session rather than being refused again.
 */
export async function createWithoutRejected(
  userId: string, toolkits: string[], accounts: Record<string, string>,
  create: typeof createSession = createSession,
): Promise<{ sessionId: string }> {
  try {
    return await create(userId, { toolkits, connectedAccounts: accounts });
  } catch (err) {
    const rejected = new Set(rejectedToolkits(err));
    if (rejected.size === 0 || ![...rejected].every(slug => toolkits.includes(slug))) throw err;
    const kept = toolkits.filter(slug => !rejected.has(slug));
    const pinned = Object.fromEntries(Object.entries(accounts).filter(([slug]) => !rejected.has(slug)));
    return create(userId, { toolkits: kept, connectedAccounts: pinned });
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const held = new Set(a);
  return held.size === new Set(b).size && b.every(value => held.has(value));
}

function sameAccounts(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
}

/** The toolkits a run may use: every enabled toolkit, deployment-wide (§6.6, D10). */
export async function enabledToolkits(db: Kysely<DB>): Promise<{ slug: string; name: string }[]> {
  return db.selectFrom('toolkits').select(['slug', 'name'])
    .where('enabled', '=', true).orderBy('slug').execute();
}

/**
 * This person's session id, pinned to exactly the accounts `connections` says
 * are active. Search needs no connection at all; executing uses the pin.
 */
export async function sessionFor(db: Kysely<DB>, invokerActorId: string): Promise<string> {
  const toolkits = (await enabledToolkits(db)).map(t => t.slug);

  const connections = await db.selectFrom('connections')
    .select(['toolkit', 'composio_account_id'])
    .where('actor_id', '=', invokerActorId)
    .where('status', '=', 'active')
    .execute();
  const accounts: Record<string, string> = {};
  for (const connection of connections) {
    if (connection.composio_account_id && toolkits.includes(connection.toolkit)) {
      accounts[connection.toolkit] = connection.composio_account_id;
    }
  }

  const cached = await db.selectFrom('composio_sessions')
    .select(['session_id', 'toolkits', 'connected_accounts'])
    .where('invoker_actor_id', '=', invokerActorId)
    .executeTakeFirst();

  if (cached && sameSet(cached.toolkits, toolkits)) {
    if (!sameAccounts(cached.connected_accounts as Record<string, string>, accounts)) {
      await patchSessionAccounts(cached.session_id, accounts);
      await db.updateTable('composio_sessions')
        .set({ connected_accounts: sql`${JSON.stringify(accounts)}::jsonb` })
        .where('invoker_actor_id', '=', invokerActorId).execute();
    }
    return cached.session_id;
  }

  const created = await createWithoutRejected(invokerActorId, toolkits, accounts);
  await db.insertInto('composio_sessions').values({
    invoker_actor_id: invokerActorId, session_id: created.sessionId,
    toolkits: sql`${toolkits}::text[]`, connected_accounts: sql`${JSON.stringify(accounts)}::jsonb`,
  })
    .onConflict(oc => oc.column('invoker_actor_id').doUpdateSet({
      session_id: created.sessionId, toolkits: sql`${toolkits}::text[]`,
      connected_accounts: sql`${JSON.stringify(accounts)}::jsonb`, created_at: sql`now()`,
    }))
    .execute();
  return created.sessionId;
}
