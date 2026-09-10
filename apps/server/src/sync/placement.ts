// Where a chat sits, for the authorization evaluator.
//
// `can()` is pure — grants and placement in, boolean out — precisely so the
// same function is authoritative on the server and answerable offline on the
// client (AUTHZ.md §7). Purity means somebody has to do the lookup, and this is
// that somebody. It is deliberately the only place chat containment is read, so
// there is one query to get right rather than one per call site.
import type { Kysely } from 'kysely';
import type { Placement } from '@relayed/authz';
import type { DB } from '../db/schema.ts';

/**
 * Load containment for one chat: which space holds it, which workspace holds
 * that, and whether the chat is private.
 *
 * All three are needed, and dropping any one denies rather than permits —
 * `can()` returns false on a missing link rather than assuming. That is the
 * right direction to fail, and it means a chat this returns nothing for is
 * simply inaccessible instead of accidentally public.
 */
export async function chatPlacement(db: Kysely<DB>, chatId: string): Promise<Placement> {
  const row = await db.selectFrom('chats')
    .innerJoin('spaces', 'spaces.id', 'chats.space_id')
    .select(['chats.id as chat_id', 'chats.kind as chat_kind',
             'spaces.id as space_id', 'spaces.workspace_id'])
    .where('chats.id', '=', chatId)
    .executeTakeFirst();

  if (!row) return {};

  return {
    spaceOf: { [row.chat_id]: row.space_id },
    workspaceOf: { [row.space_id]: row.workspace_id },
    // A set rather than a flag on the chat: `can()` takes the same shape for one
    // chat or for a whole sidebar, so a batched loader later needs no new type.
    privateChats: new Set(row.chat_kind === 'private' ? [row.chat_id] : []),
  };
}

/**
 * Load containment for one space: which workspace holds it, and whether anyone
 * in that workspace may join it unasked.
 *
 * `openSpaces` is what lets `can()` answer `join`, which is the one space
 * action whose answer cannot come from the asker's grants — the grant is what
 * joining creates. A private space is simply absent from the set, so the
 * default is "invited only" rather than "open".
 */
export async function spacePlacement(db: Kysely<DB>, spaceId: string): Promise<Placement> {
  const row = await db.selectFrom('spaces')
    .select(['id', 'workspace_id', 'visibility', 'membership_policy'])
    .where('id', '=', spaceId)
    .executeTakeFirst();
  if (!row) return {};

  return {
    workspaceOf: { [row.id]: row.workspace_id },
    // The POLICY, not the visibility. They agree today — public spaces are open
    // — but they are different questions: visibility is who may see that this
    // exists, policy is who may walk in. Reading the one that means "who may
    // walk in" keeps them separable if they ever diverge.
    openSpaces: new Set(row.membership_policy === 'open' ? [row.id] : []),
  };
}

/**
 * Placement for every chat an actor could reach in one workspace.
 *
 * `hello` asks about ~150 chats at once (DESIGN.md §9.1), and asking per chat
 * would be 150 round trips on the one frame that must be a single exchange.
 */
export async function workspacePlacement(
  db: Kysely<DB>, workspaceId: string,
): Promise<Placement> {
  const rows = await db.selectFrom('chats')
    .innerJoin('spaces', 'spaces.id', 'chats.space_id')
    .select(['chats.id as chat_id', 'chats.kind as chat_kind',
             'spaces.id as space_id', 'spaces.workspace_id'])
    .where('chats.workspace_id', '=', workspaceId)
    .execute();

  const spaceOf: Record<string, string> = {};
  const workspaceOf: Record<string, string> = {};
  const privateChats = new Set<string>();
  for (const row of rows) {
    spaceOf[row.chat_id] = row.space_id;
    workspaceOf[row.space_id] = row.workspace_id;
    if (row.chat_kind === 'private') privateChats.add(row.chat_id);
  }
  return { spaceOf, workspaceOf, privateChats };
}
