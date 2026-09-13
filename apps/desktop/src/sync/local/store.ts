// Local rooms, on disk (docs/LOCAL-ROOMS.md §6–§8).
//
// One `local-rooms.db` per account, owned by the sync engine like every other
// database: the agent runner never touches it, and reports what Claude did so
// that this file can write it.
//
// Its promise is the opposite of the replica's. Nothing here is evicted or
// rebuilt, because nothing else holds a copy.
import type { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { deriveBody } from '@relayed/genui';
import { readStoredParts, type MessagePart } from '@relayed/protocol';
import { openDatabase } from '../db.ts';
import { migrate } from '../migrate.ts';
import { newId } from '../ids.ts';
import { localMigrations } from '../migrations/local.ts';
import { DEFAULT_ROOM_MODE, type EffortLevel, type PendingApproval, type RoomMode } from '../../shared/claude.ts';
import type { ReplicaMessage } from '../storage.ts';
import type { LocalRoom } from '../../shared/local-rooms.ts';
import { DEFAULT_ROOM_TITLE, type TitleTurn } from './titles.ts';

/** The two actors every local room holds (migrations/local.ts). */
export const LOCAL_ME = 'act_local_me';
export const LOCAL_AGENT = 'act_local_agent';

/** What the runner needs to start or continue a turn in a chat. */
export interface TurnContext {
  spaceId: string;
  chatId: string;
  cwd: string;
  mode: string;
  model: string | null;
  effort: EffortLevel | null;
  sessionId: string | null;
}

export interface LocalDraft {
  chatId: string;
  body: string;
  revision: number;
  updatedAt: number;
}

export class RoomBusyError extends Error {
  constructor() {
    super('Claude is still replying in this room');
    this.name = 'RoomBusyError';
  }
}

export class LocalStore {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Open, migrate, and settle anything a previous run left mid-turn.
   *
   * A `streaming` row at open belonged to a Claude Code child that died with
   * the app. Nothing can finish it, and a row that says "writing…" for ever is
   * a lie the screen would repeat (§8.5), so it is marked failed with what it had.
   */
  static open(file: string): LocalStore {
    const db = openDatabase(file);
    migrate(db, localMigrations);
    const store = new LocalStore(db);
    store.failStreaming('Interrupted when Relayed closed.');
    // Every ask belonged to a child that died with the app.
    db.exec('DELETE FROM approvals');
    return store;
  }

  /**
   * End every reply still being written, keeping what each had. For the moment
   * nothing can finish them: the app opened after a crash, or the runner that
   * held their Claude Code children went away. Returns the chats touched.
   */
  failStreaming(reason: string): string[] {
    const stranded = this.db.prepare("SELECT id, chat_id, parts FROM messages WHERE state = 'streaming'")
      .all() as { id: string; chat_id: string; parts: string | null }[];
    for (const row of stranded) this.finishTurn(row.id, 'failed', parse(row.parts), reason);
    const chats = [...new Set(stranded.map(row => row.chat_id))];
    this.clearApprovals(chats);
    return chats;
  }

  close(): void {
    this.db.close();
  }

  // ── rooms ────────────────────────────────────────────────────────────────

  /**
   * A room about a directory: its space, its default chat, both memberships and
   * the local row, in one transaction (§7).
   *
   * The directory must exist and be a directory NOW. Everything Claude does in
   * this room happens there, and a typo discovered at the first message is a
   * worse place to find out.
   */
  createRoom(input: { name?: string | undefined; cwd: string }, now = Date.now()): { spaceId: string; chatId: string } {
    let isDirectory = false;
    try { isDirectory = statSync(input.cwd).isDirectory(); } catch { /* reported below */ }
    if (!isDirectory) throw new Error(`not a directory: ${input.cwd}`);

    // Named by what is said in it (titles.ts), not by the folder: the folder is
    // already the group it sits under.
    const name = input.name?.trim() || DEFAULT_ROOM_TITLE;
    const spaceId = newId('spc');
    const chatId = newId('cht');

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO spaces (id, workspace_id, kind, name, slug, visibility, membership_policy,
                            lifecycle, created_by_actor_id, last_activity_at, created_at, updated_at)
        VALUES (?, 'local', 'room', ?, NULL, 'private', 'invite', 'active', ?, ?, ?, ?)
      `).run(spaceId, name, LOCAL_ME, now, now, now);
      this.db.prepare(`
        INSERT INTO chats (id, workspace_id, space_id, kind, name, created_by_actor_id, created_at, updated_at)
        VALUES (?, 'local', ?, 'default', NULL, ?, ?, ?)
      `).run(chatId, spaceId, LOCAL_ME, now, now);
      // The same rows a synced room holds, so the shared can() answers the same way.
      const member = this.db.prepare('INSERT INTO memberships VALUES (?, ?, ?, ?, ?, NULL)');
      member.run('space', spaceId, LOCAL_ME, 'admin', now);
      member.run('space', spaceId, LOCAL_AGENT, 'member', now);
      this.db.prepare('INSERT INTO local_rooms (space_id, cwd, mode) VALUES (?, ?, ?)').run(spaceId, input.cwd, DEFAULT_ROOM_MODE);
      // No session yet: Claude Code is not started until the first message.
      this.db.prepare('INSERT INTO chat_sessions (chat_id, updated_at) VALUES (?, ?)').run(chatId, now);
    });
    return { spaceId, chatId };
  }

  rooms(): LocalRoom[] {
    const rooms = this.db.prepare(`
      SELECT s.id, s.name, s.last_activity_at, l.cwd, l.mode, l.model, l.effort,
             EXISTS (SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id
                      WHERE c.space_id = s.id AND m.state = 'streaming') AS busy
        FROM spaces s JOIN local_rooms l ON l.space_id = s.id
       WHERE s.lifecycle = 'active'
       ORDER BY s.last_activity_at DESC
    `).all() as { id: string; name: string; last_activity_at: number; cwd: string; mode: RoomMode; model: string | null; effort: EffortLevel | null; busy: number }[];
    const chats = this.db.prepare(`
      SELECT id, space_id, kind, name FROM chats
       ORDER BY CASE kind WHEN 'default' THEN 0 ELSE 1 END, created_at
    `).all() as { id: string; space_id: string; kind: string; name: string | null }[];

    return rooms.map(room => ({
      id: room.id, name: room.name, cwd: room.cwd, mode: room.mode, model: room.model, effort: room.effort,
      busy: room.busy === 1, lastActivityAt: room.last_activity_at,
      chats: chats.filter(chat => chat.space_id === room.id).map(({ id, kind, name }) => ({ id, kind, name })),
    }));
  }

  room(spaceId: string): { id: string; name: string } | null {
    return (this.db.prepare('SELECT s.id, s.name FROM spaces s JOIN local_rooms l ON l.space_id = s.id WHERE s.id = ?')
      .get(spaceId) as { id: string; name: string } | undefined) ?? null;
  }

  renameRoom(spaceId: string, name: string, now = Date.now()): void {
    const result = this.db.prepare('UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?').run(name, now, spaceId);
    if (result.changes === 0) throw new Error(`no local room ${spaceId}`);
  }

  /**
   * Rename a room only if it is still called one of `expected` — the check and
   * the write in one statement, so a rename by the person between a title being
   * asked for and it arriving is never overwritten.
   */
  replaceRoomName(spaceId: string, name: string, expected: readonly string[], now = Date.now()): boolean {
    if (expected.length === 0) return false;
    const result = this.db.prepare(`
      UPDATE spaces SET name = ?, updated_at = ? WHERE id = ? AND name IN (${expected.map(() => '?').join(', ')})
    `).run(name, now, spaceId, ...expected);
    return result.changes > 0;
  }

  /** How many messages the person has sent in the room, across its chats. */
  sentCount(spaceId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE c.space_id = ? AND m.author_id = ? AND m.deleted = 0
    `).get(spaceId, LOCAL_ME) as { n: number }).n;
  }

  /** The room's conversation, oldest first, as a title reads it: who spoke, and what they said. */
  titleTurns(spaceId: string): TitleTurn[] {
    const rows = this.db.prepare(`
      SELECT m.author_id, m.body FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE c.space_id = ? AND m.deleted = 0 AND m.parent_id IS NULL
       ORDER BY m.created_at, m.ord
    `).all(spaceId) as { author_id: string; body: string }[];
    return rows.map(row => ({ role: row.author_id === LOCAL_ME ? 'user' : 'assistant', text: row.body }));
  }

  /** Set how Claude may act in a room. Returns the room's chats, whose live sessions must hear of it. */
  setMode(spaceId: string, mode: RoomMode): string[] {
    const result = this.db.prepare('UPDATE local_rooms SET mode = ? WHERE space_id = ?').run(mode, spaceId);
    if (result.changes === 0) throw new Error(`no local room ${spaceId}`);
    return (this.db.prepare('SELECT id FROM chats WHERE space_id = ?').all(spaceId) as { id: string }[]).map(row => row.id);
  }

  /** Set a room's model and effort; null is the default. Returns the room's chats. */
  setModel(spaceId: string, model: string | null, effort: EffortLevel | null): string[] {
    const result = this.db.prepare('UPDATE local_rooms SET model = ?, effort = ? WHERE space_id = ?').run(model, effort, spaceId);
    if (result.changes === 0) throw new Error(`no local room ${spaceId}`);
    return (this.db.prepare('SELECT id FROM chats WHERE space_id = ?').all(spaceId) as { id: string }[]).map(row => row.id);
  }

  /**
   * Forget the chat's Claude Code session, so the next message starts a new
   * one (the app's /clear). A note says so in the chat, because the messages
   * above stay on screen while Claude stops seeing them.
   */
  clearSession(chatId: string, note: string, now = Date.now()): string {
    const context = this.turnContext(chatId);
    if (!context) throw new Error(`no local chat ${chatId}`);
    const noteId = newId('msg');
    this.transaction(() => {
      const busy = this.db.prepare(`
        SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.space_id = ? AND m.state = 'streaming' LIMIT 1
      `).get(context.spaceId);
      if (busy) throw new RoomBusyError();
      this.db.prepare('UPDATE chat_sessions SET session_id = NULL, turn_count = 0, updated_at = ? WHERE chat_id = ?').run(now, chatId);
      const { next } = this.db.prepare('SELECT COALESCE(MAX(ord), 0) + 1 AS next FROM messages WHERE chat_id = ?')
        .get(chatId) as { next: number };
      const parts: MessagePart[] = [{ kind: 'markdown', text: note }];
      this.db.prepare(`
        INSERT INTO messages (id, chat_id, parent_id, ord, author_id, body, parts, created_at, state)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'acked')
      `).run(noteId, chatId, next, LOCAL_AGENT, deriveBody(parts), partsJson(parts), now);
    });
    return noteId;
  }

  // ── approvals (§8.5) ─────────────────────────────────────────────────────

  addApproval(approval: PendingApproval): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO approvals (id, chat_id, message_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(approval.id, approval.chatId, approval.messageId, approval.kind, JSON.stringify(approval), approval.createdAt);
  }

  /** Oldest first: the order Claude asked in. */
  approvals(chatId: string): PendingApproval[] {
    return (this.db.prepare('SELECT payload FROM approvals WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as PendingApproval);
  }

  /** The chat it was in, or null if it was already gone. */
  removeApproval(approvalId: string): string | null {
    const row = this.db.prepare('DELETE FROM approvals WHERE id = ? RETURNING chat_id').get(approvalId) as { chat_id: string } | undefined;
    return row?.chat_id ?? null;
  }

  /** Every ask in these chats, or in all of them. */
  clearApprovals(chatIds?: readonly string[]): void {
    if (!chatIds) { this.db.exec('DELETE FROM approvals'); return; }
    const remove = this.db.prepare('DELETE FROM approvals WHERE chat_id = ?');
    for (const chatId of chatIds) remove.run(chatId);
  }

  turnContext(chatId: string): TurnContext | null {
    const row = this.db.prepare(`
      SELECT c.id AS chat_id, c.space_id, l.cwd, l.mode, l.model, l.effort, cs.session_id
        FROM chats c JOIN local_rooms l ON l.space_id = c.space_id
        LEFT JOIN chat_sessions cs ON cs.chat_id = c.id
       WHERE c.id = ?
    `).get(chatId) as {
      chat_id: string; space_id: string; cwd: string; mode: string; model: string | null; effort: EffortLevel | null; session_id: string | null;
    } | undefined;
    return row
      ? { chatId: row.chat_id, spaceId: row.space_id, cwd: row.cwd, mode: row.mode, model: row.model, effort: row.effort, sessionId: row.session_id }
      : null;
  }

  // ── messages ─────────────────────────────────────────────────────────────

  draft(chatId: string): LocalDraft[] {
    const row = this.db.prepare(`
      SELECT chat_id, body, revision, updated_at FROM drafts
       WHERE chat_id = ? AND draft_kind = 'compose' AND context_key = 'root'
    `).get(chatId) as { chat_id: string; body: string; revision: number; updated_at: number } | undefined;
    return row ? [{ chatId: row.chat_id, body: row.body, revision: row.revision, updatedAt: row.updated_at }] : [];
  }

  saveDraft(chatId: string, body: string, revision: number, now = Date.now()): void {
    if (revision < 1) throw new Error('draft revision must be positive');
    if (body.trim().length === 0) {
      this.db.prepare("DELETE FROM drafts WHERE chat_id = ? AND draft_kind = 'compose' AND context_key = 'root'")
        .run(chatId);
      return;
    }
    this.db.prepare(`
      INSERT INTO drafts (chat_id, draft_kind, context_key, body, revision, updated_at)
      VALUES (?, 'compose', 'root', ?, ?, ?)
      ON CONFLICT(chat_id, draft_kind, context_key) DO UPDATE SET
        body = excluded.body, revision = excluded.revision, updated_at = excluded.updated_at
      WHERE excluded.revision >= drafts.revision
    `).run(chatId, body, revision, now);
  }

  /** The same row shape the replica's chat reads, so one message list draws both. */
  messages(chatId: string, limit = 200): ReplicaMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT m.id, m.chat_id, m.parent_id, m.ord, m.author_id, m.body, m.parts,
               m.created_at, m.deleted, m.state, a.display_name, a.handle, a.type
          FROM messages m LEFT JOIN actors a ON a.id = m.author_id
         WHERE m.chat_id = ?
         ORDER BY m.ord DESC
         LIMIT ?
      ) ORDER BY ord
    `).all(chatId, limit) as Record<string, unknown>[];

    return rows.map(row => ({
      id: String(row['id']),
      chatId: String(row['chat_id']),
      parentId: (row['parent_id'] as string | null) ?? null,
      ord: Number(row['ord']),
      authorId: String(row['author_id']),
      authorName: (row['display_name'] as string | null) ?? 'Unknown',
      authorHandle: (row['handle'] as string | null) ?? null,
      authorAvatarBlob: null,
      authorType: (row['type'] as string | null) ?? null,
      body: String(row['body']),
      parts: readStoredParts((row['parts'] as string | null) ?? null),
      createdAt: Number(row['created_at']),
      deleted: Number(row['deleted']) === 1,
      state: String(row['state']),
    }));
  }

  /**
   * The person's message and an empty row for Claude's reply, in one
   * transaction (§8.2).
   *
   * Refused while any chat in the room is mid-reply: every chat works in the
   * same directory, and two sessions editing one working tree at once is a
   * half-applied change (§8.1).
   */
  beginTurn(chatId: string, text: string, draftRevision?: number, now = Date.now()): { messageId: string; replyId: string } {
    const context = this.turnContext(chatId);
    if (!context) throw new Error(`no local chat ${chatId}`);
    const messageId = newId('msg');
    const replyId = newId('msg');

    this.transaction(() => {
      const busy = this.db.prepare(`
        SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE c.space_id = ? AND m.state = 'streaming' LIMIT 1
      `).get(context.spaceId);
      if (busy) throw new RoomBusyError();

      const { next } = this.db.prepare('SELECT COALESCE(MAX(ord), 0) + 1 AS next FROM messages WHERE chat_id = ?')
        .get(chatId) as { next: number };
      const insert = this.db.prepare(`
        INSERT INTO messages (id, chat_id, parent_id, ord, author_id, body, parts, created_at, state)
        VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?)
      `);
      insert.run(messageId, chatId, next, LOCAL_ME, text, now, 'acked');
      insert.run(replyId, chatId, next + 1, LOCAL_AGENT, '', now, 'streaming');
      if (draftRevision !== undefined) {
        this.db.prepare(`
          DELETE FROM drafts WHERE chat_id = ? AND draft_kind = 'compose'
            AND context_key = 'root' AND revision = ?
        `).run(chatId, draftRevision);
      }
      this.db.prepare('UPDATE spaces SET last_activity_at = ? WHERE id = ?').run(now, context.spaceId);
    });
    return { messageId, replyId };
  }

  /**
   * Replace a streaming reply's parts with the runner's latest snapshot.
   *
   * A snapshot rather than an append, so a lost or repeated report cannot leave
   * a tool listed twice or missing: the next one is whole. Ignored once the row
   * is no longer streaming — a report that raced the end of a turn is stale.
   */
  setStreamingParts(replyId: string, parts: readonly MessagePart[]): boolean {
    const result = this.db.prepare("UPDATE messages SET parts = ?, body = ? WHERE id = ? AND state = 'streaming'")
      .run(partsJson(parts), deriveBody(parts), replyId);
    return result.changes > 0;
  }

  /**
   * End a turn. `body` is derived from the parts, as it is for every message
   * with parts (AGENT-RESPONSES.md §3.2), and a failure says why beneath them.
   */
  finishTurn(replyId: string, outcome: 'acked' | 'failed', parts: readonly MessagePart[], reason?: string): boolean {
    const shown: MessagePart[] = outcome === 'failed' && reason
      ? [...parts, { kind: 'markdown', text: `_${reason}_` }]
      : [...parts];
    const body = deriveBody(shown);
    const result = this.db.prepare("UPDATE messages SET parts = ?, body = ?, state = ? WHERE id = ? AND state = 'streaming'")
      .run(partsJson(shown), body, outcome, replyId);
    return result.changes > 0;
  }

  /** Adopt the session a chat's Claude Code is running as, once it is known. */
  setSession(chatId: string, sessionId: string, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO chat_sessions (chat_id, session_id, turn_count, updated_at) VALUES (?, ?, 0, ?)
      ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(chatId, sessionId, now);
  }

  countTurn(chatId: string, now = Date.now()): void {
    this.db.prepare('UPDATE chat_sessions SET turn_count = turn_count + 1, updated_at = ? WHERE chat_id = ?').run(now, chatId);
  }

  /** The chat a message is in, for routing a runner report to its topics. */
  chatOf(messageId: string): string | null {
    const row = this.db.prepare('SELECT chat_id FROM messages WHERE id = ?').get(messageId) as { chat_id: string } | undefined;
    return row?.chat_id ?? null;
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const partsJson = (parts: readonly MessagePart[]): string | null => (parts.length > 0 ? JSON.stringify(parts) : null);

/** Parts this store wrote itself, read back for a restart's recovery. */
const parse = (json: string | null): MessagePart[] => (readStoredParts(json) ?? []) as MessagePart[];
