// Which space a tool call is about, and whether it may be read.
//
// Shared by the tools that read a space (`read_room_summary`, `room_members`)
// so the default ("the room you are in", a side chat's room included) and the
// access rule (both the agent and the person who asked are in it) are written
// once.
import { sql, type ExpressionBuilder } from 'kysely';
import type { DB } from '../../db/schema.ts';
import type { ToolContext, ToolDeps } from './contract.ts';

/** An open membership of this space, as an EXISTS subquery — the access rule, written once. */
export const memberOf = (
  eb: ExpressionBuilder<DB, 'spaces'>, spaceId: string, actorId: string,
) => eb.selectFrom('memberships')
  .select(sql`1`.as('one'))
  .where('memberships.scope_type', '=', 'space')
  .where('memberships.scope_id', '=', spaceId)
  .where('memberships.actor_id', '=', actorId)
  .where('memberships.left_at', 'is', null);

/**
 * The space an argument names, or the run's own when it names none.
 *
 * A CHAT id is taken as its space: a model asked about "this room" from a side
 * chat reaches for the chat it can see. Access is not decided here.
 */
export async function spaceAsked(deps: ToolDeps, run: ToolContext, asked: string): Promise<string | undefined> {
  const chatOf = asked.startsWith('cht_') ? asked : asked ? null : run.chatId;
  return chatOf
    ? (await deps.db.selectFrom('chats').select('space_id').where('id', '=', chatOf).executeTakeFirst())?.space_id
    : asked;
}

/** The space, when BOTH the agent and the person who asked are in it; otherwise nothing. */
export function readableSpace(deps: ToolDeps, run: ToolContext, spaceId: string) {
  return deps.db.selectFrom('spaces')
    .select(['spaces.id', 'spaces.name', 'spaces.kind'])
    .where('spaces.id', '=', spaceId)
    .where(eb => eb.exists(memberOf(eb, spaceId, run.agentActorId)))
    .where(eb => eb.exists(memberOf(eb, spaceId, run.invokerActorId)))
    .executeTakeFirst();
}

/**
 * One answer for "no such space", "you are not in it" and "I am not in it":
 * telling them apart would say something about a space the asker may not be
 * entitled to know exists. The way back is offered, so a model that guessed an
 * id retries without one.
 */
export const unreadable = (what: string) => ({
  result: 'failed',
  message: `That room is not one both of you can see, so ${what} cannot be read. `
    + 'For the room you are in, call this again without a space_id.',
});
