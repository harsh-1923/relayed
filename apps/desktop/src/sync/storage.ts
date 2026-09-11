// The storage tier (STORAGE.md §5–§7). Owns every database handle in the sync
// process and the rule that governs them:
//
//   Exactly ONE workspace is active — subscribed, rendering, catching up.
//   Zero or more may be open DRAIN-ONLY, touching only the outbox (§7).
//
// Deliberately not a singleton (§15.3). Workspaces are opened by id and the
// active one is a field, not a global — which is what keeps the deferred
// outbox drainer (§16.1) an addition rather than an untangling.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emit, count, histogram } from '@relayed/telemetry';
import type { Role } from '@relayed/authz';
import { openDatabase } from './db.ts';
import { migrate } from './migrate.ts';
import { accountMigrations } from './migrations/account.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import { newId } from './ids.ts';
import * as p from './paths.ts';

/**
 * Two subjects in one row — the workspace, and me in it — so every field says
 * whose it is. See account migration v4 for what unqualified names cost.
 */
export interface WorkspaceRow {
  workspaceId: string;
  orgId: string;
  name: string;
  slug: string;
  /** The workspace's own image. Null is ordinary: the UI derives a colour. */
  workspaceAvatarUrl: string | null;
  workspaceAvatarBlob: string | null;
  actorId: string;
  actorHandle: string;
  actorDisplayName: string;
  actorAvatarUrl: string | null;
  /** sha256 of the bytes we hold locally. null until fetched (§13.3). */
  actorAvatarBlob: string | null;
  /** My role here — the grant the client's can() reads (AUTHZ.md §3). */
  actorRole: Role;
  lastOpenedAt: number | null;
  unreadHint: number;
  mentionHint: number;
  outboxHint: number;
  state: 'active' | 'removed';
}

/**
 * An actor as the client holds it — narrower than the server's row.
 *
 * No identity_kind/identity_id: those are Layer 1 references (§6.3) and nothing
 * on the client addresses an actor by anything but its id.
 */
export interface ReplicaActor {
  id: string;
  workspaceId: string;
  type: 'human' | 'agent';
  handle: string;
  displayName: string;
  /** Where the picture came from. The renderer never sees this (invariant 46). */
  avatarUrl: string | null;
  /** sha256 of the bytes we hold, or null. This is what the renderer renders. */
  avatarBlob: string | null;
  ownerActorId: string | null;
  state: string;
  updatedAt: number;
}

/** One chat in the sidebar. `name` is null for a space's sole chat. */
export interface ReplicaChat {
  id: string;
  spaceId: string;
  kind: string;
  name: string | null;
  unread: number;
  mentions: number;
}

/** A space and the chats inside it — the sidebar, as the replica holds it. */
export interface ReplicaSpace {
  id: string;
  kind: string;
  name: string | null;
  slug: string | null;
  visibility: string;
  chats: ReplicaChat[];
}

/**
 * A message, joined to its author.
 *
 * `state` is the one field a surface must not ignore: `pending` is optimistic
 * and unacknowledged, `failed` is refused, and rendering the three identically
 * is how a message that never sent looks exactly like one that did.
 *
 * The author is joined in rather than looked up per row. A message whose author
 * is not in the directory yet still renders — with their handle — because the
 * alternative is a chat that goes blank while the directory pages in.
 */
export interface ReplicaMessage {
  id: string;
  chatId: string;
  parentId: string | null;
  /** Null while pending: the server has not assigned one yet. */
  ord: number | null;
  authorId: string;
  authorName: string;
  authorHandle: string | null;
  authorAvatarBlob: string | null;
  body: string;
  createdAt: number;
  deleted: boolean;
  state: string;
}

/**
 * A directory row as the SERVER sends it.
 *
 * `avatarBlob` names bytes on this device, so it cannot come off the wire and
 * is deliberately absent here. `syncActors` preserves whatever we already hold
 * rather than asking the caller for a null it could only guess at.
 */
export type DirectoryRow = Omit<ReplicaActor, 'avatarBlob'>;

export interface AccountSummary {
  accountId: string;
  deviceId: string;
  lastActiveAt: number;
  lastWorkspace: string | null;
  workspaces: WorkspaceRow[];
}

/** What /auth/session and /auth/refresh return in `memberships` (§10.1). */
export interface Membership {
  workspaceId: string;
  orgId: string;
  name: string;
  slug: string;
  workspaceAvatarUrl: string | null;
  actorId: string;
  actorHandle: string;
  actorDisplayName: string;
  actorAvatarUrl: string | null;
  actorRole: Role;
}

const toRow = (r: Record<string, unknown>): WorkspaceRow => ({
  workspaceId: String(r['workspace_id']),
  orgId: String(r['org_id']),
  name: String(r['name']),
  slug: String(r['slug']),
  workspaceAvatarUrl: (r['workspace_avatar_url'] as string | null) ?? null,
  workspaceAvatarBlob: (r['workspace_avatar_blob'] as string | null) ?? null,
  actorId: String(r['actor_id']),
  actorHandle: String(r['actor_handle']),
  actorDisplayName: String(r['actor_display_name']),
  actorAvatarUrl: (r['actor_avatar_url'] as string | null) ?? null,
  actorAvatarBlob: (r['actor_avatar_blob'] as string | null) ?? null,
  actorRole: ((r['actor_role'] as string | null) ?? 'member') as Role,
  lastOpenedAt: (r['last_opened_at'] as number | null) ?? null,
  unreadHint: Number(r['unread_hint'] ?? 0),
  mentionHint: Number(r['mention_hint'] ?? 0),
  outboxHint: Number(r['outbox_hint'] ?? 0),
  state: r['state'] === 'removed' ? 'removed' : 'active',
});

const getMeta = (db: DatabaseSync, k: string): string | null => {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
  return row?.v ?? null;
};

const setMeta = (db: DatabaseSync, k: string, v: string): void => {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
};

function readSummary(db: DatabaseSync, accountId: string): AccountSummary {
  const rows = db.prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC NULLS LAST')
    .all() as Record<string, unknown>[];
  return {
    accountId,
    deviceId: getMeta(db, 'device_id') ?? '',
    lastActiveAt: Number(getMeta(db, 'last_active_at') ?? 0),
    lastWorkspace: getMeta(db, 'last_workspace'),
    workspaces: rows.map(toRow),
  };
}

/**
 * Everything on disk, for the debug inspector (§17.3).
 *
 * Reads EVERY replica, not just the active one, because the question it exists
 * to answer is whether cleanup actually happened — and a workspace that should
 * have been deleted is invisible from the active handle alone. Read-only and
 * transient: the active-workspace rule (§7) is about who may write.
 */
export interface FileNode {
  name: string;
  /** null for a directory. */
  bytes: number | null;
  children: FileNode[];
}

export interface DebugSnapshot {
  root: string;
  installId: string;
  epoch: number;
  /** Our layout only, as a tree. See OURS. */
  tree: FileNode[];
  /** How many Chromium runtime files were left out, so the filter is visible. */
  hiddenFiles: number;
  databases: { name: string; path: string; userVersion: number; autoVacuum: number;
               tables: { name: string; rows: Record<string, unknown>[]; total: number }[] }[];
  /** Names only. A vault slot's contents are never read, let alone rendered. */
  vaultSlots: string[];
}

export interface BootState {
  installId: string;
  accounts: AccountSummary[];
  accountId: string | null;
  workspaceId: string | null;
  epoch: number;
}

/** What `welcome` carried, in the client's own shape. */
export interface WelcomePayload {
  actorId: string;
  spaces: {
    id: string; kind: string; name: string | null; slug: string | null;
    visibility: string | null; membershipPolicy: string; lifecycle: string;
    rev: number;
  }[];
  chats: {
    id: string; spaceId: string; kind: string; name: string | null;
    headOrd: number; headRev: number;
    chatUnread: number; threadUnread: number; mentionCount: number;
  }[];
  memberships: { scopeType: string; scopeId: string; role: string }[];
}

export class Storage {
  readonly root: string;
  readonly installId: string;

  #accountId: string | null = null;
  #account: DatabaseSync | null = null;
  #workspaceId: string | null = null;
  #workspace: DatabaseSync | null = null;
  #epoch = 0;

  constructor(root: string) {
    this.root = root;
    mkdirSync(p.accountsDir(root), { recursive: true });
    this.installId = readInstallId(root);
    this.#epoch = readEpoch(root);
  }

  // ── active handles ──────────────────────────────────────────────────────

  get accountId(): string | null { return this.#accountId; }
  get workspaceId(): string | null { return this.#workspaceId; }
  /** Monotonic across restarts. Stamped on every IPC reply (§12.1). */
  get epoch(): number { return this.#epoch; }

  get account(): DatabaseSync {
    if (!this.#account) throw new Error('no account is open');
    return this.#account;
  }
  /** The ACTIVE workspace replica. Drain-only handles are opened separately. */
  get workspace(): DatabaseSync {
    if (!this.#workspace) throw new Error('no workspace is open');
    return this.#workspace;
  }
  get hasWorkspace(): boolean { return this.#workspace !== null; }

  /**
   * Per (install, account) — NOT per install and NOT per workspace (§8).
   * Every use of it is already account-scoped, so an install-wide value would
   * only add server-side linkability between two accounts on one machine.
   */
  get deviceId(): string {
    const id = getMeta(this.account, 'device_id');
    if (!id) throw new Error('account has no device_id');
    return id;
  }

  // ── discovery and boot ──────────────────────────────────────────────────

  listAccountIds(): string[] {
    return readdirSync(p.accountsDir(this.root), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('acc_'))
      .map(e => e.name)
      .filter(id => existsSync(p.accountDb(this.root, id)));
  }

  /** Reads every account's summary. Cheap: ~1 ms per handle (§3). */
  accounts(): AccountSummary[] {
    return this.listAccountIds()
      .map(id => this.#withAccount(id, db => readSummary(db, id)))
      .toSorted((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Steps 1–5 of §11. Pure local I/O — no network, no auth. Whatever this
   * returns is enough to paint the full UI, which is what R3 requires.
   */
  boot(): BootState {
    const accounts = this.accounts();
    const chosen = accounts[0];
    if (!chosen) return { installId: this.installId, accounts, accountId: null, workspaceId: null, epoch: 0 };

    this.openAccount(chosen.accountId);
    const active = chosen.workspaces.filter(w => w.state === 'active');
    const target = active.find(w => w.workspaceId === chosen.lastWorkspace) ?? active[0];
    if (target) this.#openWorkspace(target.workspaceId);

    return {
      installId: this.installId,
      accounts,
      accountId: this.#accountId,
      workspaceId: this.#workspaceId,
      epoch: this.#epoch,
    };
  }

  // ── accounts ────────────────────────────────────────────────────────────

  /**
   * `deviceId` is supplied rather than generated here: sign-in has to send one
   * to the server before it knows which account it will land in, and the value
   * the server recorded is the one this account must keep (STORAGE.md §8).
   */
  createAccount(deviceId: string): string {
    const id = newId('acc');
    mkdirSync(p.workspacesDir(this.root, id), { recursive: true });
    mkdirSync(p.authDir(this.root, id), { recursive: true });
    mkdirSync(p.accountBlobsDir(this.root, id), { recursive: true });
    const db = openDatabase(p.accountDb(this.root, id));
    migrate(db, accountMigrations);
    setMeta(db, 'device_id', deviceId);
    setMeta(db, 'last_active_at', String(Date.now()));
    db.close();
    return id;
  }

  openAccount(accountId: string): void {
    if (this.#accountId === accountId) return;
    this.closeWorkspace();
    this.#account?.close();
    this.#account = openDatabase(p.accountDb(this.root, accountId));
    migrateTimed(this.#account, accountMigrations, 'account');
    this.#accountId = accountId;
    setMeta(this.#account, 'last_active_at', String(Date.now()));

    const rows = this.workspaces();
    emit('account.opened', {
      account: accountId, device: this.deviceId,
      workspaces: rows.length, epoch: this.#epoch,
    });
  }

  /**
   * Which local account directory does this sign-in belong to?
   *
   * Matched on actor-id intersection, never on a WorkOS identifier (§5).
   * Actor ids are Layer 2, and two emails can never share one, so this cannot
   * false-positive.
   */
  findAccountByActors(actorIds: readonly string[]): string | null {
    if (actorIds.length === 0) return null;
    const placeholders = actorIds.map(() => '?').join(',');
    for (const id of this.listAccountIds()) {
      const hit = this.#withAccount(id, db =>
        db.prepare(`SELECT 1 FROM workspaces WHERE actor_id IN (${placeholders}) LIMIT 1`)
          .get(...actorIds));
      if (hit) return id;
    }
    return null;
  }

  /** Sign-out. One directory delete takes the replicas, blobs and vault (§13). */
  deleteAccount(accountId: string): void {
    if (this.#accountId === accountId) {
      this.closeWorkspace();
      this.#account?.close();
      this.#account = null;
      this.#accountId = null;
      this.#workspaceId = null;
      // The epoch is NOT reset: a renderer still holding the old value would
      // otherwise reject every reply that follows the next sign-in.
    }
    rmSync(p.accountDir(this.root, accountId), { recursive: true, force: true });
    count('account.deleted');
  }

  // ── memberships ─────────────────────────────────────────────────────────

  /**
   * Reconcile the workspace index against the server's membership list.
   * A workspace that has disappeared is marked `removed` rather than deleted,
   * so the caller decides when its replica goes (§13).
   */
  syncMemberships(memberships: readonly Membership[]): void {
    const db = this.account;
    db.exec('BEGIN');
    try {
      const upsert = db.prepare(`
        INSERT INTO workspaces (workspace_id, org_id, name, slug,
                                workspace_avatar_url,
                                actor_id, actor_handle, actor_display_name,
                                actor_avatar_url, actor_role, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(workspace_id) DO UPDATE SET
          org_id = excluded.org_id, name = excluded.name, slug = excluded.slug,
          workspace_avatar_url = excluded.workspace_avatar_url,
          actor_id = excluded.actor_id, actor_handle = excluded.actor_handle,
          actor_display_name = excluded.actor_display_name,
          actor_avatar_url = excluded.actor_avatar_url,
          actor_role = excluded.actor_role,
          -- Drop a local blob only when its source URL actually changed;
          -- otherwise every membership refresh re-downloads every image.
          actor_avatar_blob = CASE
            WHEN workspaces.actor_avatar_url IS NOT DISTINCT FROM excluded.actor_avatar_url
            THEN workspaces.actor_avatar_blob ELSE NULL END,
          workspace_avatar_blob = CASE
            WHEN workspaces.workspace_avatar_url IS NOT DISTINCT FROM excluded.workspace_avatar_url
            THEN workspaces.workspace_avatar_blob ELSE NULL END,
          state = 'active'
      `);
      for (const m of memberships) {
        upsert.run(m.workspaceId, m.orgId, m.name, m.slug, m.workspaceAvatarUrl,
                   m.actorId, m.actorHandle, m.actorDisplayName, m.actorAvatarUrl,
                   m.actorRole);
      }
      if (memberships.length > 0) {
        const keep = memberships.map(() => '?').join(',');
        db.prepare(`UPDATE workspaces SET state = 'removed' WHERE workspace_id NOT IN (${keep})`)
          .run(...memberships.map(m => m.workspaceId));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  workspaces(): WorkspaceRow[] {
    return (this.account.prepare(
      "SELECT * FROM workspaces WHERE state = 'active' ORDER BY last_opened_at DESC NULLS LAST")
      .all() as Record<string, unknown>[]).map(toRow);
  }

  workspaceRow(workspaceId: string): WorkspaceRow | null {
    const r = this.account.prepare('SELECT * FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as Record<string, unknown> | undefined;
    return r ? toRow(r) : null;
  }

  /** Drop a workspace we are no longer a member of: replica, blobs and vault. */
  forgetWorkspace(workspaceId: string): void {
    if (this.#workspaceId === workspaceId) this.closeWorkspace();
    const acc = this.#accountId;
    if (!acc) return;
    this.account.prepare('DELETE FROM workspaces WHERE workspace_id = ?').run(workspaceId);
    rmSync(p.workspaceDir(this.root, acc, workspaceId), { recursive: true, force: true });
    rmSync(p.vaultFile(this.root, acc, workspaceId), { force: true });
  }

  // ── the switch (§12.2) ──────────────────────────────────────────────────

  /**
   * Steps 2, 4 and 5 of the switch. The caller closes the socket first (step 3)
   * and repaints afterwards (step 6) — this owns only what must be durable and
   * correctly ordered.
   *
   * `last_workspace` is committed BEFORE any handle work (invariant 42), so a
   * crash mid-switch reopens the workspace the user was moving TO, never the
   * one they just left.
   */
  switchWorkspace(workspaceId: string): number {
    const t0 = performance.now();
    const row = this.workspaceRow(workspaceId);
    if (!row) throw new Error(`unknown workspace: ${workspaceId}`);
    if (row.state !== 'active') throw new Error(`workspace is ${row.state}: ${workspaceId}`);

    const db = this.account;
    db.exec('BEGIN');
    try {
      setMeta(db, 'last_workspace', workspaceId);
      db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE workspace_id = ?')
        .run(Date.now(), workspaceId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // Advanced AFTER the durable write and outside the account, so signing out
    // cannot wind it back.
    this.#epoch = bumpEpoch(this.root, this.#epoch);

    const from = this.#workspaceId;
    this.closeWorkspace();
    this.#openWorkspace(workspaceId);

    emit('workspace.switched', {
      account: this.#accountId ?? '', from: from ?? '', to: workspaceId,
      local: Math.round(performance.now() - t0), epoch: this.#epoch,
    });
    return this.#epoch;
  }

  #openWorkspace(workspaceId: string): void {
    const acc = this.#accountId;
    if (!acc) throw new Error('no account is open');
    mkdirSync(p.blobsDir(this.root, acc, workspaceId), { recursive: true });
    const db = openDatabase(p.workspaceDb(this.root, acc, workspaceId));
    migrateTimed(db, workspaceMigrations, 'workspace');
    this.#workspace = db;
    this.#workspaceId = workspaceId;
  }

  /**
   * Records how many writes are parked here before letting go of the handle
   * (§15.2), so they are findable later without opening every replica. The
   * outbox table arrives with the Phase 2 write path; until then the count is
   * legitimately zero.
   */
  closeWorkspace(): void {
    const db = this.#workspace;
    const wsp = this.#workspaceId;
    if (!db || !wsp) return;
    try {
      const pending = countOutbox(db);
      if (this.#account) {
        this.#account.prepare('UPDATE workspaces SET outbox_hint = ? WHERE workspace_id = ?')
          .run(pending, wsp);
      }
      // Fold the WAL back in, or every workspace leaves a -wal and -shm behind.
      const t0 = performance.now();
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      histogram('workspace.close', Math.round(performance.now() - t0));
    } catch { /* a close must not fail a switch */ }
    db.close();
    this.#workspace = null;
    this.#workspaceId = null;
  }

  close(): void {
    this.closeWorkspace();
    this.#account?.close();
    this.#account = null;
    this.#accountId = null;
  }

  /**
   * Replace the workspace directory with what the server holds.
   *
   * A full replace rather than a diff: the list is small — actors, not
   * messages — and reconciling additions, renames, deactivations and departures
   * separately is four ways to be subtly wrong about a table that can be
   * rewritten in one statement. Phase 2's incremental path replaces this along
   * with the transport.
   *
   * Deactivated actors are KEPT, deliberately. A tombstoned author still has to
   * render on the messages they wrote (§6.3); dropping them would leave an
   * empty name where a greyed one belongs.
   */
  /**
   * Write everything `welcome` carried, in one transaction.
   *
   * THIS IS WHAT MAKES R2 CHEAP. Every badge in the sidebar becomes correct
   * here, with `messages` still completely empty — because "I have it" and
   * "I know it exists" are different facts, and only the second is needed to
   * render a number.
   *
   * `synced_through_rev` IS DELIBERATELY NOT TOUCHED. It means "I hold every
   * change up to here, contiguously", and receiving a head is not receiving the
   * changes below it. Advancing it from this frame would jump the frontier past
   * events that were never applied — a silent permanent hole, which is the one
   * thing the contiguity rule exists to prevent (invariant 1). What moves is
   * `server_head_rev`: the gap between the two is precisely the catch-up that
   * is owed.
   */
  applyWelcome(payload: WelcomePayload): void {
    const db = this.workspace;
    const workspaceId = this.workspaceId;
    if (!workspaceId) throw new Error('applyWelcome with no workspace open');
    db.exec('BEGIN');
    try {
      // `created_at` is required and is NOT carried on the wire: it is a local
      // "when did this replica first hear of it", not the server's clock, and a
      // client that invented one would be inventing history. On conflict it is
      // left alone for the same reason.
      const now = Date.now();
      const space = db.prepare(`
        INSERT INTO spaces (id, workspace_id, kind, name, slug, visibility,
                            membership_policy, lifecycle, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind, name = excluded.name, slug = excluded.slug,
          visibility = excluded.visibility,
          membership_policy = excluded.membership_policy,
          lifecycle = excluded.lifecycle,
          updated_at = excluded.updated_at
      `);
      for (const row of payload.spaces) {
        space.run(row.id, workspaceId, row.kind, row.name, row.slug,
                  row.visibility, row.membershipPolicy, row.lifecycle, now, now);
      }

      const chat = db.prepare(`
        INSERT INTO chats (id, workspace_id, space_id, kind, name,
                           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          space_id = excluded.space_id, kind = excluded.kind,
          name = excluded.name, updated_at = excluded.updated_at
      `);
      // Counters and the ordinal head, which are chat-specific.
      const state = db.prepare(`
        INSERT INTO chat_state (chat_id, head_ord,
                                chat_unread, thread_unread, mention_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          head_ord        = excluded.head_ord,
          chat_unread     = excluded.chat_unread,
          thread_unread   = excluded.thread_unread,
          mention_count   = excluded.mention_count
      `);

      // The CURSOR, which is not. Every stream's frontier lives in one table so
      // the apply loop never has to ask which one holds this stream's — and
      // `synced_through_rev` is conspicuously absent from this statement, which
      // is the whole point of the comment above.
      const cursor = db.prepare(`
        INSERT INTO stream_state (stream_kind, stream_id, server_head_rev)
        VALUES ('chat', ?, ?)
        ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
          server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev)
      `);

      for (const row of payload.chats) {
        chat.run(row.id, workspaceId, row.spaceId, row.kind, row.name, now, now);
        state.run(row.id, row.headOrd,
                  row.chatUnread, row.threadUnread, row.mentionCount);
        cursor.run(row.id, row.headRev);
      }

      // Space cursors, so a reconnect knows how far behind each space stream is.
      const spaceCursor = db.prepare(`
        INSERT INTO stream_state (stream_kind, stream_id, server_head_rev)
        VALUES ('space', ?, ?)
        ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
          server_head_rev = MAX(stream_state.server_head_rev, excluded.server_head_rev)
      `);
      for (const row of payload.spaces) spaceCursor.run(row.id, row.rev);

      // The caller's OWN memberships — the grants can() evaluates for their own
      // affordances. Replaced wholesale, because a membership absent from this
      // frame is one they no longer hold, and a stale row would let the UI
      // offer an action the server will refuse.
      db.prepare('DELETE FROM memberships WHERE actor_id = ?').run(payload.actorId);
      const membership = db.prepare(`
        INSERT INTO memberships (scope_type, scope_id, actor_id, role,
                                 joined_at, left_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(scope_type, scope_id, actor_id) DO UPDATE SET
          role = excluded.role, left_at = NULL
      `);
      for (const row of payload.memberships) {
        membership.run(row.scopeType, row.scopeId, payload.actorId, row.role, now);
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  syncActors(actors: readonly DirectoryRow[]): void {
    const db = this.workspace;
    db.exec('BEGIN');
    try {
      // Upsert rather than DELETE-then-INSERT. The delete was wiping
      // `avatar_blob` on every sync, which made prefetching directory avatars
      // pointless: whatever the prefetch wrote, the next refresh removed.
      const upsert = db.prepare(`
        INSERT INTO actors (id, workspace_id, type, handle, display_name,
                            avatar_url, owner_actor_id, state, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id   = excluded.workspace_id,
          type           = excluded.type,
          handle         = excluded.handle,
          display_name   = excluded.display_name,
          avatar_url     = excluded.avatar_url,
          owner_actor_id = excluded.owner_actor_id,
          state          = excluded.state,
          updated_at     = excluded.updated_at,
          -- The bytes we hold are the OLD url's. Keep the pointer only while the
          -- url is unchanged; otherwise drop it and let the prefetch refill.
          -- Same rule as syncMemberships, for the same reason.
          avatar_blob = CASE
            WHEN actors.avatar_url IS NOT DISTINCT FROM excluded.avatar_url
            THEN actors.avatar_blob ELSE NULL END
      `);
      for (const a of actors) {
        upsert.run(a.id, a.workspaceId, a.type, a.handle, a.displayName,
                   a.avatarUrl, a.ownerActorId, a.state, a.updatedAt);
      }
      // The directory is a full snapshot, so an actor absent from it is gone.
      // Deactivated actors are NOT absent — they arrive with state='deactivated'
      // precisely so a tombstoned author still renders (§6.3).
      const ids = actors.map(a => a.id);
      db.prepare(
        `DELETE FROM actors WHERE id NOT IN (${ids.map(() => '?').join(',') || "''"})`,
      ).run(...ids);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * The sidebar: every space this actor is in, with its chats.
   *
   * TWO QUERIES, NOT A JOIN, and not one per space. A join would return the
   * space columns once per chat and the caller would have to un-flatten them;
   * a query per space is the N+1 that `welcome` was rebuilt to avoid
   * (SYNC-FLOWS.md §4). Both are small and indexed, and the shape the surface
   * wants is a tree.
   */
  spaces(): ReplicaSpace[] {
    const spaces = this.workspace.prepare(`
      SELECT id, kind, name, slug, visibility, lifecycle
        FROM spaces WHERE lifecycle = 'active' ORDER BY name
    `).all() as Record<string, unknown>[];

    const chats = this.workspace.prepare(`
      SELECT c.id, c.space_id, c.kind, c.name,
             COALESCE(s.chat_unread, 0)   AS unread,
             COALESCE(s.mention_count, 0) AS mentions
        FROM chats c LEFT JOIN chat_state s ON s.chat_id = c.id
       ORDER BY c.id
    `).all() as Record<string, unknown>[];

    return spaces.map(space => ({
      id: String(space['id']),
      kind: String(space['kind']),
      name: (space['name'] as string | null) ?? null,
      slug: (space['slug'] as string | null) ?? null,
      visibility: String(space['visibility'] ?? 'public'),
      chats: chats
        .filter(chat => chat['space_id'] === space['id'])
        .map(chat => ({
          id: String(chat['id']),
          spaceId: String(chat['space_id']),
          kind: String(chat['kind']),
          name: (chat['name'] as string | null) ?? null,
          unread: Number(chat['unread'] ?? 0),
          mentions: Number(chat['mentions'] ?? 0),
        })),
    }));
  }

  /**
   * One chat's messages, oldest first.
   *
   * BOUNDED, because a chat is unbounded. The tail is what a surface opens on;
   * everything below it is backfill's job, and asking for all of it here would
   * make opening a busy chat slower the longer it has existed.
   *
   * Tombstones are kept and marked rather than filtered out. A deleted message
   * still occupies its ordinal — ordinals are never renumbered or reused — and
   * a gap the UI cannot explain reads as data loss.
   */
  messages(chatId: string, limit = 200): ReplicaMessage[] {
    const rows = this.workspace.prepare(`
      SELECT m.id, m.chat_id, m.parent_id, m.ord, m.author_id, m.body,
             m.created_at, m.deleted, m.state,
             a.display_name, a.handle, a.avatar_blob
        FROM messages m
        LEFT JOIN actors a ON a.id = m.author_id
       WHERE m.chat_id = ?
       -- Pending rows have no ordinal yet, so they sort last by construction:
       -- a message you just typed belongs at the bottom until the ack says
       -- exactly where.
       ORDER BY COALESCE(m.ord, 1e15), m.created_at
       LIMIT ?
    `).all(chatId, limit) as Record<string, unknown>[];

    return rows.map(row => ({
      id: String(row['id']),
      chatId: String(row['chat_id']),
      parentId: (row['parent_id'] as string | null) ?? null,
      ord: row['ord'] === null ? null : Number(row['ord']),
      authorId: String(row['author_id']),
      authorName: (row['display_name'] as string | null)
        ?? `@${String(row['handle'] ?? 'unknown')}`,
      authorHandle: (row['handle'] as string | null) ?? null,
      authorAvatarBlob: (row['avatar_blob'] as string | null) ?? null,
      body: String(row['body']),
      createdAt: Number(row['created_at'] ?? 0),
      deleted: Number(row['deleted'] ?? 0) === 1,
      state: String(row['state']),
    }));
  }

  actors(): ReplicaActor[] {
    return (this.workspace.prepare('SELECT * FROM actors ORDER BY handle')
      .all() as Record<string, unknown>[]).map(r => ({
        id: String(r['id']),
        workspaceId: String(r['workspace_id']),
        type: r['type'] === 'agent' ? 'agent' : 'human',
        handle: String(r['handle']),
        displayName: String(r['display_name']),
        avatarUrl: (r['avatar_url'] as string | null) ?? null,
        avatarBlob: (r['avatar_blob'] as string | null) ?? null,
        ownerActorId: (r['owner_actor_id'] as string | null) ?? null,
        state: String(r['state']),
        updatedAt: Number(r['updated_at'] ?? 0),
      }));
  }

  // ── blobs (§13.3) ───────────────────────────────────────────────────────

  /** Content-addressed, so the same bytes are stored once however they arrive. */
  hasBlob(id: string): boolean {
    const acc = this.#accountId;
    return acc !== null && existsSync(p.accountBlob(this.root, acc, id));
  }

  putBlob(id: string, bytes: Uint8Array, kind: 'avatar' | 'attachment' = 'avatar'): void {
    const acc = this.#accountId;
    if (!acc) throw new Error('no account is open');
    const file = p.accountBlob(this.root, acc, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes, { mode: 0o600 });
    histogram('blob.bytes', bytes.byteLength, { kind });
  }

  /** `which` names the subject, so the two images cannot be crossed. */
  setAvatarBlob(workspaceId: string, which: 'actor' | 'workspace', blobId: string): void {
    const column = which === 'actor' ? 'actor_avatar_blob' : 'workspace_avatar_blob';
    this.account.prepare(`UPDATE workspaces SET ${column} = ? WHERE workspace_id = ?`)
      .run(blobId, workspaceId);
  }

  /** A directory row's picture. Lives in the workspace replica, not account.db. */
  setActorAvatarBlob(actorId: string, blobId: string): void {
    this.workspace.prepare('UPDATE actors SET avatar_blob = ? WHERE id = ?')
      .run(blobId, actorId);
  }

  /**
   * Have we already fetched this exact URL, under any row?
   *
   * Content addressing means the same bytes are one file however they arrive,
   * so the same face in two workspaces — or the same person appearing both as
   * "you" in account.db and as a directory row — needs no second download.
   *
   * Keyed on the URL rather than on the hash because the hash is only knowable
   * after fetching, which is the cost being avoided. Safe for the same reason
   * `syncMemberships` clears a blob when its URL changes: this codebase treats
   * URL identity as byte identity, and invalidates on URL change.
   *
   * Returns null unless the bytes are genuinely still on disk — a pointer to a
   * file that has been evicted is worse than no pointer, because it renders as
   * a broken image rather than a monogram.
   */
  blobForUrl(url: string): string | null {
    const seen = (id: unknown): string | null =>
      typeof id === 'string' && this.hasBlob(id) ? id : null;

    const acc = this.account.prepare(`
      SELECT actor_avatar_blob AS b FROM workspaces
       WHERE actor_avatar_url = ? AND actor_avatar_blob IS NOT NULL
      UNION ALL
      SELECT workspace_avatar_blob FROM workspaces
       WHERE workspace_avatar_url = ? AND workspace_avatar_blob IS NOT NULL
      LIMIT 1
    `).get(url, url) as Record<string, unknown> | undefined;
    const fromAccount = seen(acc?.['b']);
    if (fromAccount) return fromAccount;

    if (!this.#workspace) return null;
    const row = this.#workspace.prepare(
      'SELECT avatar_blob AS b FROM actors WHERE avatar_url = ? AND avatar_blob IS NOT NULL LIMIT 1',
    ).get(url) as Record<string, unknown> | undefined;
    return seen(row?.['b']);
  }

  /** See DebugSnapshot. Never used by the app itself. */
  debug(): DebugSnapshot {
    const { tree, hidden } = ourTree(this.root);
    const databases: DebugSnapshot['databases'] = [];

    for (const acc of this.listAccountIds()) {
      this.#withAccount(acc, db =>
        databases.push(dump(`${acc}/account.db`, p.accountDb(this.root, acc), db)));

      const wspRoot = p.workspacesDir(this.root, acc);
      const dirs = existsSync(wspRoot)
        ? readdirSync(wspRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        : [];
      for (const wsp of dirs) {
        const file = p.workspaceDb(this.root, acc, wsp);
        if (!existsSync(file)) continue;
        if (wsp === this.#workspaceId && this.#workspace) {
          databases.push(dump(`${acc}/${wsp} (active)`, file, this.#workspace));
        } else {
          const db = openDatabase(file);
          try { databases.push(dump(`${acc}/${wsp}`, file, db)); } finally { db.close(); }
        }
      }
    }

    const vaultSlots: string[] = [];
    for (const acc of this.listAccountIds()) {
      const dir = p.authDir(this.root, acc);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) vaultSlots.push(`${acc}/${f}`);
    }

    return { root: this.root, installId: this.installId, epoch: this.#epoch,
             tree, hiddenFiles: hidden, databases, vaultSlots };
  }

  // ── internals ───────────────────────────────────────────────────────────

  #withAccount<T>(accountId: string, fn: (db: DatabaseSync) => T): T {
    if (accountId === this.#accountId && this.#account) return fn(this.#account);
    const db = openDatabase(p.accountDb(this.root, accountId));
    try {
      migrate(db, accountMigrations);
      return fn(db);
    } finally {
      db.close();
    }
  }
}

const MAX_ROWS = 50;

function dump(name: string, path: string, db: DatabaseSync) {
  const uv = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  const av = Object.values(db.prepare('SELECT * FROM pragma_auto_vacuum()')
    .get() as Record<string, number>)[0] ?? -1;
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map(t => {
      const total = (db.prepare(`SELECT count(*) c FROM "${t.name}"`).get() as { c: number }).c;
      const rows = db.prepare(`SELECT * FROM "${t.name}" LIMIT ${MAX_ROWS}`)
        .all() as Record<string, unknown>[];
      // node:sqlite returns null-prototype objects, which do not survive
      // structured cloning to the renderer intact.
      return { name: t.name, total, rows: rows.map(r => ({ ...r })) };
    });
  return { name, path, userVersion: uv, autoVacuum: av, tables };
}

/**
 * userData is shared with Chromium, which keeps a couple of hundred files there
 * — Cache, Code Cache, GPUCache, Local Storage and friends. Listing them buries
 * the six that are ours.
 *
 * Allow-listed rather than block-listed: the set below IS the layout in
 * STORAGE.md §5, so anything Chromium adds later stays out by default, and
 * anything WE add has to be named here deliberately.
 */
const OURS = new Set(['accounts', 'auth', 'install-id', 'epoch']);
const isOurs = (name: string) => OURS.has(name) || name.endsWith('.pre-split');

function ourTree(root: string): { tree: FileNode[]; hidden: number } {
  let hidden = 0;
  const entries = readdirSync(root, { withFileTypes: true });
  const tree: FileNode[] = [];
  for (const e of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!isOurs(e.name)) { hidden += e.isDirectory() ? countFiles(join(root, e.name)) : 1; continue; }
    const node = toNode(root, e.name);
    if (node) tree.push(node);
  }
  return { tree, hidden };
}

function toNode(parent: string, name: string): FileNode | null {
  const full = join(parent, name);
  let st;
  try { st = statSync(full); }
  catch { return null; }   // raced with a delete — which is itself the answer
  if (!st.isDirectory()) return { name, bytes: st.size, children: [] };
  const children = readdirSync(full, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(e => toNode(full, e.name))
    .filter((n): n is FileNode => n !== null);
  return { name, bytes: null, children };
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1), 0);
  } catch { return 0; }
}

/**
 * Migration cost is paid on the path to first paint, and the two databases
 * advance on independent version lines — so the tier label is what makes the
 * number actionable rather than an average of two unrelated things.
 */
function migrateTimed(db: DatabaseSync, list: Parameters<typeof migrate>[1],
                      tier: 'account' | 'workspace'): void {
  const t0 = performance.now();
  const result = migrate(db, list);
  const duration = Math.round(performance.now() - t0);
  histogram('db.migrate', duration, { tier });
  // Only when something actually ran: a no-op migration on every boot would
  // drown the signal that a real one is slow.
  if (result.applied.length > 0) {
    emit('db.migrated', { tier, from: result.from, to: result.to, duration });
  }
}

/** Zero until the Phase 2 write path creates the table (§16.1). */
function countOutbox(db: DatabaseSync): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT count(*) c FROM outbox WHERE state != 'failed'").get() as { c: number };
  return row.c;
}

/**
 * Monotonic across sign-out, account deletion and restart — the whole point.
 *
 * Device tier, not per account: sign-out deletes the account directory, and a
 * counter that reset while a renderer still remembered the old value made every
 * later reply look stale (invariant 41).
 */
function readEpoch(root: string): number {
  const file = p.epochFile(root);
  if (existsSync(file)) return Number(readFileSync(file, 'utf8').trim()) || 0;
  writeFileSync(file, '0\n', { mode: 0o600 });
  return 0;
}

function bumpEpoch(root: string, current: number): number {
  const next = current + 1;
  writeFileSync(p.epochFile(root), String(next) + '\n', { mode: 0o600 });
  return next;
}

/** Per install, telemetry and crash reports only. NEVER enters a token (§8). */
function readInstallId(root: string): string {
  const file = p.installIdFile(root);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const id = newId('ins');
  writeFileSync(file, id + '\n', { mode: 0o600 });
  return id;
}
