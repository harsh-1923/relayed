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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emit, count, histogram } from '@relayed/telemetry';
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
  lastOpenedAt: number | null;
  unreadHint: number;
  mentionHint: number;
  outboxHint: number;
  state: 'active' | 'removed';
}

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
    moveLegacyAside(root);
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
                                actor_avatar_url, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(workspace_id) DO UPDATE SET
          org_id = excluded.org_id, name = excluded.name, slug = excluded.slug,
          workspace_avatar_url = excluded.workspace_avatar_url,
          actor_id = excluded.actor_id, actor_handle = excluded.actor_handle,
          actor_display_name = excluded.actor_display_name,
          actor_avatar_url = excluded.actor_avatar_url,
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
                   m.actorId, m.actorHandle, m.actorDisplayName, m.actorAvatarUrl);
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
 * Seeded from the highest per-account value the pre-device-tier layout wrote,
 * so an install that already switched a few times does not start below what a
 * live renderer remembers.
 */
function readEpoch(root: string): number {
  const file = p.epochFile(root);
  if (existsSync(file)) return Number(readFileSync(file, 'utf8').trim()) || 0;

  let seed = 0;
  const dir = p.accountsDir(root);
  if (existsSync(dir)) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(p.accountDb(root, e.name))) continue;
      const db = openDatabase(p.accountDb(root, e.name));
      try {
        const row = db.prepare("SELECT v FROM meta WHERE k = 'epoch'").get() as { v: string } | undefined;
        seed = Math.max(seed, Number(row?.v ?? 0) || 0);
      } catch { /* a database too old to have meta cannot have an epoch */ }
      finally { db.close(); }
    }
  }
  writeFileSync(file, String(seed) + '\n', { mode: 0o600 });
  return seed;
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

/**
 * The pre-split layout put one flat `relayed.db` and a single unkeyed vault
 * slot directly in userData. Neither can be carried forward — the vault is now
 * keyed per workspace, so the session has to be re-established either way.
 *
 * Moved aside rather than deleted. The database is a replica holding no
 * unrecoverable state, but silently deleting anything under a user's
 * Application Support directory is not a habit worth having.
 */
function moveLegacyAside(root: string): void {
  for (const file of [p.legacyDb(root), p.legacyVault(root)]) {
    if (!existsSync(file)) continue;
    const target = `${file}.pre-split`;
    if (existsSync(target)) { rmSync(file, { force: true }); continue; }
    renameSync(file, target);
    console.warn(`[storage] moved pre-split ${file} aside -> ${target}`);
  }
  for (const suffix of ['-wal', '-shm']) rmSync(p.legacyDb(root) + suffix, { force: true });
}
