// Who is in a chat, as far as this device can tell — for the faces beside a
// side chat on the new-panel screen (docs/SIDE-CHATS.md).
//
// A public chat has no member list: everyone in the room may read it. So its
// people are the ones it was started with — the `chat.started` row names them —
// and whoever has written in it since, in the order they first did. A private
// chat's members are its members; a local room's are the person and Claude.
import type { DatabaseSync } from 'node:sqlite';

/** Every actor a link in a body names, mention or reference, in order. */
const linkedActors = (body: string): string[] =>
  [...body.matchAll(/\]\(actor(?:-ref)?:(act_[A-Za-z0-9_-]+)\)/g)].flatMap(match => match[1] ?? []);

const authorsOf = (db: DatabaseSync, chatId: string, onlyPeople: string): string[] =>
  (db.prepare(`
    SELECT author_id FROM messages
     WHERE chat_id = ? AND deleted = 0 ${onlyPeople}
     GROUP BY author_id ORDER BY MIN(COALESCE(ord, 9e18)), MIN(created_at)
  `).all(chatId) as { author_id: string }[]).map(row => row.author_id);

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** A synced room's chat: who started it and with whom, then who has written. */
export function replicaChatParticipants(db: DatabaseSync, chatId: string): string[] {
  const started = db.prepare(`SELECT subject_actor_id, body FROM messages
                               WHERE chat_id = ? AND system_kind = 'chat.started' LIMIT 1`).get(chatId) as
    { subject_actor_id: string | null; body: string } | undefined;
  const members = (db.prepare(`SELECT actor_id FROM memberships
                                WHERE scope_type = 'chat' AND scope_id = ? AND left_at IS NULL`).all(chatId) as
    { actor_id: string }[]).map(row => row.actor_id);
  return unique([
    ...(started?.subject_actor_id ? [started.subject_actor_id] : []),
    ...(started ? linkedActors(started.body) : []),
    ...members,
    ...authorsOf(db, chatId, `AND message_kind = 'actor'`),
  ]);
}

/** A local room's chat: its members if private, then who has written; the person and Claude otherwise. */
export function localChatParticipants(db: DatabaseSync, chatId: string, fallback: readonly string[]): string[] {
  const members = (db.prepare(`SELECT actor_id FROM memberships
                                WHERE scope_type = 'chat' AND scope_id = ? AND left_at IS NULL`).all(chatId) as
    { actor_id: string }[]).map(row => row.actor_id);
  const found = unique([...members, ...authorsOf(db, chatId, '')]);
  return found.length > 0 ? found : [...fallback];
}
