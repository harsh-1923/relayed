import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import { replicaChatParticipants } from './participants.ts';

function replica(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, workspaceMigrations);
  return db;
}

const message = (db: DatabaseSync, row: { id: string; ord: number; author: string; body?: string; system?: boolean; deleted?: boolean }) =>
  db.prepare(`INSERT INTO messages (id, chat_id, ord, author_id, body, created_at, state, deleted,
                                    message_kind, system_kind, subject_actor_id)
              VALUES (?, 'cht_side', ?, ?, ?, 0, 'acked', ?, ?, ?, ?)`)
    .run(row.id, row.ord, row.author, row.body ?? 'hi', row.deleted ? 1 : 0,
         row.system ? 'system' : 'actor', row.system ? 'chat.started' : null, row.system ? row.author : null);

test('a side chat\'s people: who started it, who it was started with, then who has written', () => {
  const db = replica();
  message(db, { id: 'msg_1', ord: 1, author: 'act_alice', system: true,
    body: 'Alice started this with [Bob](actor-ref:act_bob) and [Triage](actor-ref:act_triage)' });
  message(db, { id: 'msg_2', ord: 2, author: 'act_carol' });
  message(db, { id: 'msg_3', ord: 3, author: 'act_bob' });
  message(db, { id: 'msg_4', ord: 4, author: 'act_dan', deleted: true });

  assert.deepEqual(replicaChatParticipants(db, 'cht_side'), ['act_alice', 'act_bob', 'act_triage', 'act_carol'],
    'each once, a deleted message counting for nobody');
});

test('a chat with nothing held has nobody to show', () => {
  assert.deepEqual(replicaChatParticipants(replica(), 'cht_empty'), []);
});
