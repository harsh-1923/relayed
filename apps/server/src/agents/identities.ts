// Who a person is in a service they connected — their Linear user, their GitHub
// login — kept so an agent assigning or mentioning someone there uses the
// service's own id rather than guessing by name.
//
// LEARNED ONLY FROM THE PERSON'S OWN SESSION. A Composio search answers for the
// account its session is pinned to, and a session belongs to one person
// (`sessions.ts`). Nothing here spends anyone else's account to find out who
// they are: someone who has never used the service through Relayed is simply
// not known yet.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import type { BrokerComposio } from './composio-broker.ts';
import type { SessionIdentity } from './composio.ts';

/**
 * Keep what a person's own search said about them. Only for accounts that are
 * theirs by our records: an identity for an account `connections` does not
 * list as this person's active one is not written.
 */
export async function rememberIdentities(
  db: Kysely<DB>, actorId: string, identities: readonly SessionIdentity[] | undefined,
): Promise<void> {
  if (!identities || identities.length === 0) return;
  const theirs = await db.selectFrom('connections').select(['toolkit', 'composio_account_id'])
    .where('actor_id', '=', actorId).where('status', '=', 'active').execute();
  for (const identity of identities) {
    const owned = theirs.some(row => row.toolkit === identity.toolkit && row.composio_account_id === identity.connectedAccountId);
    if (!owned) continue;
    const row = {
      connected_account_id: identity.connectedAccountId, external_id: identity.externalId,
      name: identity.name, username: identity.username,
    };
    await db.insertInto('external_identities')
      .values({ actor_id: actorId, toolkit: identity.toolkit, ...row })
      .onConflict(oc => oc.columns(['actor_id', 'toolkit']).doUpdateSet({ ...row, seen_at: sql`now()` }))
      .execute();
  }
}

/**
 * Ask a person's own session who they are, and keep the answer. Called when
 * they finish connecting a service — their own action, on their own account.
 * Never fails the caller: an identity is a convenience, learned again on their
 * next search if this one does not land.
 */
export async function learnIdentity(
  db: Kysely<DB>, composio: Pick<BrokerComposio, 'session' | 'search'>, actorId: string, toolkitName: string,
): Promise<void> {
  try {
    const sessionId = await composio.session(db, actorId);
    const found = await composio.search(sessionId, `${toolkitName}: who am I`);
    await rememberIdentities(db, actorId, found.identities);
  } catch { /* learned on their next search instead */ }
}

export type IdentityAnswer =
  | { actor_id: string; found: true; external_id: string; name: string | null; username: string | null }
  | { actor_id: string; found: false; reason: 'not_connected' | 'not_known_yet' | 'not_in_workspace' };

/**
 * These people's identities in one service, as far as we know them. A row is
 * trusted only while it was read from the account the person has connected
 * now — a reconnect to another account makes an older row wrong.
 */
export async function identitiesOf(
  db: Kysely<DB>, workspaceId: string, toolkit: string, actorIds: readonly string[],
): Promise<IdentityAnswer[]> {
  if (actorIds.length === 0) return [];
  const [actors, connections, known] = await Promise.all([
    db.selectFrom('actors').select('id').where('id', 'in', [...actorIds]).where('workspace_id', '=', workspaceId).execute(),
    db.selectFrom('connections').select(['actor_id', 'composio_account_id'])
      .where('actor_id', 'in', [...actorIds]).where('toolkit', '=', toolkit).where('status', '=', 'active').execute(),
    db.selectFrom('external_identities').selectAll()
      .where('actor_id', 'in', [...actorIds]).where('toolkit', '=', toolkit).execute(),
  ]);
  return actorIds.map((actorId): IdentityAnswer => {
    if (!actors.some(row => row.id === actorId)) return { actor_id: actorId, found: false, reason: 'not_in_workspace' };
    const account = connections.find(row => row.actor_id === actorId)?.composio_account_id;
    if (!account) return { actor_id: actorId, found: false, reason: 'not_connected' };
    const row = known.find(each => each.actor_id === actorId && each.connected_account_id === account);
    if (!row) return { actor_id: actorId, found: false, reason: 'not_known_yet' };
    return { actor_id: actorId, found: true, external_id: row.external_id, name: row.name, username: row.username };
  });
}
