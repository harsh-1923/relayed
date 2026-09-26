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
import { readStoredParts, type StoredPart } from '@relayed/protocol';
import { openDatabase } from './db.ts';
import { migrate } from './migrate.ts';
import { accountMigrations } from './migrations/account.ts';
import { workspaceMigrations } from './migrations/workspace.ts';
import { newId } from './ids.ts';
import { applyPreferences, readPreferences, writePreference, type PreferenceChange } from './prefs.ts';
import { isKeybindingKey, isPreferenceKey, isWritablePreferenceKey, specOf, type PreferenceRow } from '../shared/prefs.ts';
import { platformOf } from '../shared/shortcuts/tanstack-driver.ts';
import * as p from './paths.ts';
import { spaceName, type Space, type SpaceChat, type SpaceRoster } from '../shared/spaces.ts';
import { readRoster } from './roster.ts';
import { replicaChatParticipants } from './participants.ts';
import type { Panel } from '../shared/panels.ts';
import type { Document } from '../shared/documents.ts';
import type { TimelineEntry, TimelineFact } from '../shared/timeline.ts';
import type { ImageMediaType } from '../shared/blobs.ts';
import { storePanel, storeDocument, type PanelRow, type DocumentRow } from './effects.ts';

/**
 * Two subjects in one row — the workspace, and me in it — so every field says
 * whose it is. See account migration v1 for what unqualified names cost.
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
  /** The organization this workspace is in (ORG-DOMAINS.md); the switcher groups by it. */
  orgName: string;
  /** Am I an admin of that org? Hides controls only — the server decides (invariant 49). */
  orgIsAdmin: boolean;
  /** The org's default workspace. */
  isDefault: boolean;
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
  /**
   * An agent's summary — description, config revision, toolkits — or null for
   * a person. On the actor read rather than a read of its own: it only ever
   * changes with an actor event, so the `actors` topic already wakes it, and
   * autocomplete needs both in one list.
   */
  agent: ReplicaAgentSummary | null;
}

export interface ReplicaAgentSummary {
  description: string;
  configRev: number;
  toolkits: { toolkit: string; effect: string }[];
}

export type CachedAssetKind = 'toolkit_logo';
export type CachedImageMediaType = ImageMediaType;

export interface CachedAsset {
  blobId: string;
  mediaType: CachedImageMediaType;
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
  /**
   * `actors.type`, or null while the author is not in the directory yet. The
   * message view draws an agent's reply differently from a person's.
   */
  authorType: string | null;
  body: string;
  /**
   * The parts an agent's reply is made of, read by the shared message view, or
   * null for a message that is its body. Synced from the server
   * (AGENT-RESPONSES.md §3); local rooms write their own (sync/local/store.ts).
   */
  parts: StoredPart[] | null;
  createdAt: number;
  deleted: boolean;
  state: string;
  /**
   * The actors a restricted message is for — this person among them — or null
   * for the whole chat. For saying so under the message; nothing decides on it.
   */
  visibleTo: string[] | null;
  /**
   * `'system'`: history the server wrote about a successful command, not
   * authored content (SPACE-MEMBERSHIP-MARKERS.md) — rendered as a `Marker`,
   * never a speech bubble. `'actor'` for every message a person or agent sent.
   */
  kind: 'actor' | 'system';
  systemKind: string | null;
  /** Who a system row is about — Alice, for "Alice was added by Bob". */
  subjectActorId: string | null;
}

/**
 * A directory row as the SERVER sends it.
 *
 * `avatarBlob` names bytes on this device, so it cannot come off the wire and
 * is deliberately absent here. `syncActors` preserves whatever we already hold
 * rather than asking the caller for a null it could only guess at.
 */
export type DirectoryRow = Omit<ReplicaActor, 'avatarBlob' | 'agent'>;

export interface AccountSummary {
  accountId: string;
  /**
   * The address this account signed in with, for telling accounts apart in
   * the switcher. Display only — never a key, never matched on (§5 matches on
   * actor ids). Null until the account next signs in through the browser.
   */
  email: string | null;
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
  orgName: string;
  orgIsAdmin: boolean;
  isDefault: boolean;
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
  // A row written before migration v4 has an empty org name; its own is the
  // honest stand-in until the next refresh fills it.
  orgName: (r['org_name'] as string | null) || String(r['name']),
  orgIsAdmin: Number(r['org_is_admin'] ?? 0) === 1,
  isDefault: Number(r['is_default'] ?? 0) === 1,
  lastOpenedAt: (r['last_opened_at'] as number | null) ?? null,
  unreadHint: Number(r['unread_hint'] ?? 0),
  mentionHint: Number(r['mention_hint'] ?? 0),
  outboxHint: Number(r['outbox_hint'] ?? 0),
  state: r['state'] === 'removed' ? 'removed' : 'active',
});

/** The membership scopes the replica's CHECK allows — the ones `can()` reasons about. */
const KNOWN_SCOPES: ReadonlySet<string> = new Set(['workspace', 'space', 'chat']);

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
    email: getMeta(db, 'email'),
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
    createdByActorId: string | null; onBehalfOfActorId: string | null;
    memberIds: string[] | null;
    /** Absent from a server that predates it; the stored count is then left alone. */
    memberCount?: number | null;
    rev: number;
  }[];
  chats: {
    id: string; spaceId: string; kind: string; name: string | null;
    headOrd: number; headRev: number;
    chatUnread: number; threadUnread: number; mentionCount: number;
  }[];
  memberships: { scopeType: string; scopeId: string; role: string }[];
  /** Optional, like the wire frame's own fields: absent and empty mean the same thing. */
  connections?: ConnectionRow[];
  agentPermissions?: AgentPermissionRow[];
  /** Every joined room's open panels, complete (PANELS.md). */
  panels?: PanelRow[];
  /** Every joined space's documents, complete (DOCUMENTS.md §7.3). */
  documents?: DocumentRow[];
}

/** One connected account, in the client's own shape (WORKSPACE-AGENTS.md §6.3). */
export interface ConnectionRow {
  id: string;
  toolkit: string;
  status: 'connecting' | 'active' | 'needs_reauth' | 'failed' | 'disconnected';
  statusReason: 'expired' | 'revoked_upstream' | 'scopes_changed' | 'failed' | null;
  label: string | null;
}

/** One agent's grant, in the client's own shape (WORKSPACE-AGENTS.md §6.4). */
export interface AgentPermissionRow {
  agentActorId: string;
  toolkit: string;
  effect: 'read' | 'write' | 'destructive';
  revoked: boolean;
}

/**
 * Stored JSON, read leniently — the rule `documents.coveredThrough` already
 * holds: a shape this build does not recognise is nothing, never a failed read.
 * A malformed row must not be able to blank a whole room's timeline.
 */
function readFacts(raw: string): TimelineFact[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): TimelineFact[] => {
      if (!entry || typeof entry !== 'object') return [];
      const fact = entry as Record<string, unknown>;
      if (typeof fact['text'] !== 'string' || fact['text'].length === 0) return [];
      return [{
        text: fact['text'],
        messageId: typeof fact['message_id'] === 'string' ? fact['message_id'] : null,
        kind: typeof fact['kind'] === 'string' ? fact['kind'] : null,
      }];
    });
  } catch { return []; }
}

function readParticipants(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
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

  /**
   * Record which address the open account signed in with (§6). Written on a
   * browser sign-in only, since that is the one place it is known.
   */
  setAccountEmail(email: string): void {
    setMeta(this.account, 'email', email);
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
                                actor_avatar_url, actor_role,
                                org_name, org_is_admin, is_default, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(workspace_id) DO UPDATE SET
          org_id = excluded.org_id, name = excluded.name, slug = excluded.slug,
          workspace_avatar_url = excluded.workspace_avatar_url,
          actor_id = excluded.actor_id, actor_handle = excluded.actor_handle,
          actor_display_name = excluded.actor_display_name,
          actor_avatar_url = excluded.actor_avatar_url,
          actor_role = excluded.actor_role,
          org_name = excluded.org_name, org_is_admin = excluded.org_is_admin,
          is_default = excluded.is_default,
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
                   m.actorRole, m.orgName, m.orgIsAdmin ? 1 : 0, m.isDefault ? 1 : 0);
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

  /**
   * Make another account on this device the open one, landing in the workspace
   * it was last in. Returns that workspace's id.
   *
   * The account-tier twin of `switchWorkspace`, with the same ordering: the
   * choice is made durable FIRST — `last_active_at` on the target, which is
   * what boot ranks accounts by — so a crash mid-switch boots into the account
   * the person was moving TO. Only then the epoch, and only then the handles.
   *
   * One epoch bump for the whole move. Going through `switchWorkspace` would
   * need the target account open already, and would bump again.
   */
  switchAccount(accountId: string): string {
    const t0 = performance.now();
    if (accountId === this.#accountId) {
      if (!this.#workspaceId) throw new Error('account has no workspace open');
      return this.#workspaceId;
    }
    if (!this.listAccountIds().includes(accountId)) throw new Error(`unknown account: ${accountId}`);

    const summary = this.#withAccount(accountId, db => readSummary(db, accountId));
    const active = summary.workspaces.filter(w => w.state === 'active');
    const target = active.find(w => w.workspaceId === summary.lastWorkspace) ?? active[0];
    if (!target) throw new Error(`account has no workspace: ${accountId}`);

    this.#withAccount(accountId, db => setMeta(db, 'last_active_at', String(Date.now())));
    this.#epoch = bumpEpoch(this.root, this.#epoch);

    const from = this.#accountId;
    this.openAccount(accountId);
    this.#openWorkspace(target.workspaceId);

    emit('account.switched', {
      from: from ?? '', to: accountId, workspace: target.workspaceId,
      local: Math.round(performance.now() - t0), epoch: this.#epoch,
    });
    return target.workspaceId;
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
                            membership_policy, lifecycle, created_by_actor_id, on_behalf_of_actor_id,
                            member_ids, member_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind, name = excluded.name, slug = excluded.slug,
          visibility = excluded.visibility,
          membership_policy = excluded.membership_policy,
          lifecycle = excluded.lifecycle,
          created_by_actor_id = excluded.created_by_actor_id,
          on_behalf_of_actor_id = excluded.on_behalf_of_actor_id,
          member_ids = excluded.member_ids,
          member_count = COALESCE(excluded.member_count, spaces.member_count),
          updated_at = excluded.updated_at
      `);
      for (const row of payload.spaces) {
        space.run(row.id, workspaceId, row.kind, row.name, row.slug,
                  row.visibility, row.membershipPolicy, row.lifecycle,
                  row.createdByActorId, row.onBehalfOfActorId,
                  row.memberIds ? JSON.stringify(row.memberIds) : null, row.memberCount ?? null, now, now);
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
      // Skipped, not inserted: a scope this client cannot reason about is a
      // grant it must not honour, and inserting one fails the CHECK and rolls
      // back the WHOLE welcome — which leaves the link with no catch-up
      // scheduler, and every stream stalled at its first missed revision.
      for (const row of payload.memberships) {
        if (!KNOWN_SCOPES.has(row.scopeType)) continue;
        membership.run(row.scopeType, row.scopeId, payload.actorId, row.role, now);
      }

      // Full replacement, like `memberships` above: `welcome` carries the
      // caller's COMPLETE current set (§6.3, §6.4), so a row missing from it
      // is one that no longer exists, not one to leave stale.
      db.prepare('DELETE FROM connections WHERE actor_id = ?').run(payload.actorId);
      const connection = db.prepare(`
        INSERT INTO connections (id, actor_id, toolkit, status, status_reason, label)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of payload.connections ?? []) {
        connection.run(row.id, payload.actorId, row.toolkit, row.status, row.statusReason, row.label);
      }

      db.prepare('DELETE FROM agent_permissions WHERE actor_id = ?').run(payload.actorId);
      const permission = db.prepare(`
        INSERT INTO agent_permissions (actor_id, agent_actor_id, toolkit, effect, revoked)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of payload.agentPermissions ?? []) {
        permission.run(payload.actorId, row.agentActorId, row.toolkit, row.effect, row.revoked ? 1 : 0);
      }

      // Complete, like the two above: a panel absent from `welcome` is one no
      // room this actor is in still has.
      db.exec('DELETE FROM panels');
      for (const row of payload.panels ?? []) storePanel(db, row);

      // Documents likewise. Deleted first for the same reason, and `storeDocument`'s
      // revision guard is no obstacle: every row here is newer than nothing.
      db.exec('DELETE FROM documents');
      for (const row of payload.documents ?? []) storeDocument(db, row);

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * A `connections` push (WORKSPACE-AGENTS.md §6.3) — one or more rows,
   * replaced by id. Never a delete: `welcome` is the only thing that knows
   * the complete set, so a push only ever upserts what it names.
   */
  applyConnections(actorId: string, rows: readonly ConnectionRow[]): void {
    const upsert = this.workspace.prepare(`
      INSERT INTO connections (id, actor_id, toolkit, status, status_reason, label)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        toolkit = excluded.toolkit, status = excluded.status,
        status_reason = excluded.status_reason, label = excluded.label
    `);
    for (const row of rows) upsert.run(row.id, actorId, row.toolkit, row.status, row.statusReason, row.label);
  }

  /** An `agent_permissions` push (WORKSPACE-AGENTS.md §6.4) — same idempotent-replace rule as `applyConnections`. */
  applyAgentPermissions(actorId: string, rows: readonly AgentPermissionRow[]): void {
    const upsert = this.workspace.prepare(`
      INSERT INTO agent_permissions (actor_id, agent_actor_id, toolkit, effect, revoked)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(actor_id, agent_actor_id, toolkit) DO UPDATE SET
        effect = excluded.effect, revoked = excluded.revoked
    `);
    for (const row of rows) upsert.run(actorId, row.agentActorId, row.toolkit, row.effect, row.revoked ? 1 : 0);
  }

  /** This actor's connected accounts, for the connector store's Yours list (§7.1). Every status, including `disconnected`. */
  connections(actorId: string): ConnectionRow[] {
    const rows = this.workspace.prepare(`
      SELECT id, toolkit, status, status_reason, label FROM connections WHERE actor_id = ? ORDER BY toolkit
    `).all(actorId) as { id: string; toolkit: string; status: ConnectionRow['status'];
                          status_reason: ConnectionRow['statusReason']; label: string | null }[];
    return rows.map(row => ({
      id: row.id, toolkit: row.toolkit, status: row.status, statusReason: row.status_reason, label: row.label,
    }));
  }

  /** This actor's grants to agents, revoked included — the connector store and the agent profile both need to tell "never allowed" from "allowed, then revoked" (§7.4). */
  /**
   * One space's documents — a room's running summary (DOCUMENTS.md §8.2).
   *
   * `body` comes back whole: a summary is kilobytes, and a panel that renders
   * half a document while it pages the rest would be worse than one that waits.
   */
  /**
   * One room's timeline, newest first (MEMORY.md §14.4).
   *
   * ENTIRELY LOCAL — no Hindsight call, no network, works offline. That is the
   * whole reason the entries are rows we replicate rather than a view we fetch.
   *
   * Tombstones come back too, and `visibleEntries` drops them at the draw. The
   * replica holds them so a late update cannot resurrect one; a reader that
   * filtered them out here would be hiding the row that says an entry is gone.
   */
  timelineEntries(spaceId: string, limit = 200): TimelineEntry[] {
    const rows = this.workspace.prepare(`
      SELECT id, space_id, chat_id, ord_start, ord_end, anchor_message_id,
             occurred_start, occurred_end, title, summary, facts, participants,
             kind, significance, deleted, rev, updated_at
        FROM room_timeline_entries
       WHERE space_id = ?
       ORDER BY occurred_start DESC, id DESC
       LIMIT ?
    `).all(spaceId, limit) as {
      id: string; space_id: string; chat_id: string; ord_start: number; ord_end: number;
      anchor_message_id: string | null; occurred_start: number; occurred_end: number;
      title: string; summary: string; facts: string; participants: string;
      kind: string; significance: number; deleted: number; rev: number; updated_at: number;
    }[];

    return rows.map(row => ({
      id: row.id, spaceId: row.space_id, chatId: row.chat_id,
      ordStart: Number(row.ord_start), ordEnd: Number(row.ord_end),
      anchorMessageId: row.anchor_message_id,
      occurredStart: Number(row.occurred_start), occurredEnd: Number(row.occurred_end),
      title: row.title, summary: row.summary,
      facts: readFacts(row.facts), participants: readParticipants(row.participants),
      kind: row.kind, significance: Number(row.significance),
      deleted: row.deleted === 1, rev: Number(row.rev), updatedAt: Number(row.updated_at),
    }));
  }

  documents(spaceId: string): Document[] {
    const rows = this.workspace.prepare(`
      SELECT id, space_id, kind, title, body, format, rev,
             updated_by_actor_id, covered_through, updated_at
        FROM documents WHERE space_id = ? ORDER BY id
    `).all(spaceId) as {
      id: string; space_id: string; kind: string; title: string | null; body: string;
      format: string; rev: number; updated_by_actor_id: string | null;
      covered_through: string | null; updated_at: number;
    }[];

    return rows.map(row => {
      let coveredThrough: Record<string, number> | null = null;
      try {
        const parsed: unknown = row.covered_through ? JSON.parse(row.covered_through) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          coveredThrough = parsed as Record<string, number>;
        }
      } catch { /* a watermark this build cannot read is no watermark, never a failed read */ }
      return {
        id: row.id, spaceId: row.space_id, kind: row.kind, title: row.title,
        body: row.body, format: row.format, rev: Number(row.rev),
        updatedByActorId: row.updated_by_actor_id,
        coveredThrough, updatedAt: Number(row.updated_at),
      };
    });
  }

  /** One synced room's shared panels, in the shape a local room's panels already have (PANELS.md). */
  panels(spaceId: string): Panel[] {
    const rows = this.workspace.prepare(`
      SELECT id, space_id, type, chat_id, payload, title, opened_from_chat_id,
             created_by_actor_id, on_behalf_of_actor_id, created_at, opened_at
        FROM panels WHERE space_id = ? ORDER BY created_at, id
    `).all(spaceId) as {
      id: string; space_id: string; type: string; chat_id: string | null; payload: string; title: string | null;
      opened_from_chat_id: string | null; created_by_actor_id: string | null; on_behalf_of_actor_id: string | null;
      created_at: number; opened_at: number;
    }[];
    return rows.map(row => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(row.payload);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch { /* drawn as empty, never dropped */ }
      return {
        id: row.id, spaceId: row.space_id, type: row.type, chatId: row.chat_id, payload, title: row.title,
        openedFromChatId: row.opened_from_chat_id, scope: 'shared' as const,
        createdAt: row.created_at, openedAt: row.opened_at,
        createdByActorId: row.created_by_actor_id, onBehalfOfActorId: row.on_behalf_of_actor_id,
      };
    });
  }

  agentPermissions(actorId: string): AgentPermissionRow[] {
    const rows = this.workspace.prepare(`
      SELECT agent_actor_id, toolkit, effect, revoked FROM agent_permissions WHERE actor_id = ? ORDER BY toolkit
    `).all(actorId) as { agent_actor_id: string; toolkit: string; effect: AgentPermissionRow['effect']; revoked: number }[];
    return rows.map(row => ({
      agentActorId: row.agent_actor_id, toolkit: row.toolkit, effect: row.effect, revoked: row.revoked === 1,
    }));
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
  spaces(): Space[] {
    return this.#readSpaces(null);
  }

  /** One space and its chats, or null. The same shape as `spaces()`, and as a local room's. */
  space(spaceId: string): Space | null {
    return this.#readSpaces(spaceId)[0] ?? null;
  }

  /** Who is in a chat, as far as this device can tell (`participants.ts`). */
  chatParticipants(chatId: string): string[] {
    return replicaChatParticipants(this.workspace, chatId);
  }

  /** Who is in a space, as this device holds it (SPACE-MEMBERSHIP-MARKERS.md, rosters). */
  spaceRoster(spaceId: string): SpaceRoster {
    return readRoster(this.workspace, spaceId);
  }

  #readSpaces(spaceId: string | null): Space[] {
    const spaces = this.workspace.prepare(`
      SELECT id, kind, name, slug, visibility, created_by_actor_id, on_behalf_of_actor_id, member_ids, member_count
        FROM spaces WHERE lifecycle = 'active' AND (?1 IS NULL OR id = ?1) ORDER BY name
    `).all(spaceId) as {
      id: string; kind: string; name: string | null; slug: string | null; visibility: string | null;
      created_by_actor_id: string | null; on_behalf_of_actor_id: string | null; member_ids: string | null;
      member_count: number | null;
    }[];

    // A DM is named by the other people in it, from the directory this replica
    // already holds: resolved here, at read, so a rename lands everywhere.
    const me = this.workspaces().find(row => row.workspaceId === this.workspaceId)?.actorId ?? null;
    const membersOf = (row: { member_ids: string | null }): string[] | null => {
      if (!row.member_ids) return null;
      try {
        const parsed: unknown = JSON.parse(row.member_ids);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
      } catch { return null; }
    };
    const mentioned = [...new Set(spaces.flatMap(space => membersOf(space) ?? []))];
    const names = new Map<string, string>();
    if (mentioned.length > 0) {
      const rows = this.workspace.prepare(
        `SELECT id, display_name FROM actors WHERE id IN (${mentioned.map(() => '?').join(',')})`,
      ).all(...mentioned) as { id: string; display_name: string }[];
      for (const row of rows) names.set(row.id, row.display_name);
    }

    const chats = this.workspace.prepare(`
      SELECT c.id, c.space_id, c.kind, c.name,
             COALESCE(s.chat_unread, 0)   AS unread,
             COALESCE(s.mention_count, 0) AS mentions
        FROM chats c LEFT JOIN chat_state s ON s.chat_id = c.id
       WHERE ?1 IS NULL OR c.space_id = ?1
       ORDER BY c.id
    `).all(spaceId) as { id: string; space_id: string; kind: string; name: string | null; unread: number; mentions: number }[];

    return spaces.map(space => ({
      id: space.id,
      kind: space.kind,
      name: spaceName(space, (membersOf(space) ?? [])
        .filter(id => id !== me)
        .flatMap(id => names.get(id) ?? [])),
      slug: space.slug,
      visibility: space.visibility,
      createdByActorId: space.created_by_actor_id,
      onBehalfOfActorId: space.on_behalf_of_actor_id,
      memberIds: membersOf(space),
      memberCount: space.member_count === null ? null : Number(space.member_count),
      chats: chats
        .filter(chat => chat.space_id === space.id)
        .map((chat): SpaceChat => ({
          id: chat.id, spaceId: chat.space_id, kind: chat.kind, name: chat.name,
          unread: Number(chat.unread), mentions: Number(chat.mentions),
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
             m.created_at, m.deleted, m.state, m.visible_to, m.parts,
             m.message_kind, m.system_kind, m.subject_actor_id,
             a.display_name, a.handle, a.avatar_blob, a.type
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
        ?? `@${(row['handle'] as string | null) ?? 'unknown'}`,
      authorHandle: (row['handle'] as string | null) ?? null,
      authorAvatarBlob: (row['avatar_blob'] as string | null) ?? null,
      authorType: (row['type'] as string | null) ?? null,
      body: String(row['body']),
      // Leniently: anything that is not an array of kinds reads as no parts,
      // and the message renders its body.
      parts: readStoredParts((row['parts'] as string | null) ?? null),
      createdAt: Number(row['created_at'] ?? 0),
      deleted: Number(row['deleted'] ?? 0) === 1,
      state: String(row['state']),
      visibleTo: readVisibleTo(row['visible_to']),
      kind: row['message_kind'] === 'system' ? 'system' : 'actor',
      systemKind: (row['system_kind'] as string | null) ?? null,
      subjectActorId: (row['subject_actor_id'] as string | null) ?? null,
    }));
  }

  actors(): ReplicaActor[] {
    return (this.workspace.prepare(`
      SELECT a.*, s.description AS agent_description, s.config_rev AS agent_config_rev,
             s.toolkits AS agent_toolkits
        FROM actors a LEFT JOIN agent_summaries s ON s.actor_id = a.id
       ORDER BY a.handle
    `).all() as Record<string, unknown>[]).map(r => ({
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
        agent: r['agent_config_rev'] === null || r['agent_config_rev'] === undefined ? null : {
          description: typeof r['agent_description'] === 'string' ? r['agent_description'] : '',
          configRev: Number(r['agent_config_rev']),
          toolkits: readToolkits(r['agent_toolkits']),
        },
      }));
  }

  /**
   * The active actor's local authorization projection for this workspace.
   * Workspace, space and private-chat rows share the evaluator's `scope:id`
   * key, so the renderer receives the same input shape as the server.
   */
  grants(actorId: string): [string, 'owner' | 'admin' | 'member'][] {
    const rows = this.workspace.prepare(`
      SELECT scope_type, scope_id, role
        FROM memberships WHERE actor_id = ? AND left_at IS NULL
        ORDER BY scope_type, scope_id
    `).all(actorId) as { scope_type: string; scope_id: string; role: 'owner' | 'admin' | 'member' }[];
    return rows.map(row => [`${row.scope_type}:${row.scope_id}`, row.role]);
  }

  // ── preferences (PREFERENCES.md) ────────────────────────────────────────

  /**
   * Which database a key's row lives in (PREFERENCES.md §4).
   *
   * The workspace tier is designed and deliberately not created: version 2 of
   * the replica states the rule it follows — a table with no writer has
   * constraints nothing has ever exercised — and every key today is
   * account-scoped. The throw is what makes adding the first workspace-tier key
   * name its own migration instead of meeting `no such table` from SQLite.
   */
  #preferenceDb(tier: 'account' | 'workspace'): DatabaseSync {
    if (tier === 'workspace') {
      throw new Error('workspace-tier preferences need the replica table (PREFERENCES.md §4)');
    }
    return this.account;
  }

  /**
   * Every preference, undecoded.
   *
   * Empty rather than throwing when no account is open: signed out there is
   * nothing to read, and every key falls back to its default — which is the
   * ordinary case, not a degraded one.
   */
  preferences(): PreferenceRow[] {
    if (!this.#account) return [];
    return readPreferences(this.#account);
  }

  /** Set one preference. Throws on an unknown key or a value outside its domain. */
  setPreference(key: string, value: unknown): void {
    if (isKeybindingKey(key)) {
      // Account-tier like every key today; the platform is the one this
      // process runs on, which is the one the person recorded on.
      writePreference(this.#preferenceDb('account'), key, value, platformOf(process.platform));
      return;
    }
    if (!isPreferenceKey(key)) throw new Error(`unknown preference: ${key}`);
    writePreference(this.#preferenceDb(specOf(key).tier), key, value);
  }

  /**
   * Return one preference to its default by removing its row. Same key
   * authorization as a set, and a keybinding clear is conflict-checked: the
   * default it falls back to may already be someone else's chord.
   */
  clearPreference(key: string): void {
    this.applyPreferences([{ op: 'clear', key }]);
  }

  /** Sets and clears in one transaction, or none (SHORTCUTS.md §9.2). */
  applyPreferences(changes: readonly PreferenceChange[]): void {
    for (const change of changes) {
      if (!isWritablePreferenceKey(change?.key)) throw new Error(`unknown preference: ${String(change?.key)}`);
      // One database per batch. Every writable key is account-tier today; a
      // workspace-tier key in a batch would need a transaction across two files.
      if (!isKeybindingKey(change.key) && specOf(change.key).tier !== 'account') {
        throw new Error(`${change.key} cannot be applied with account-tier preferences`);
      }
    }
    applyPreferences(this.#preferenceDb('account'), changes, platformOf(process.platform));
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

  /**
   * A catalogue asset is account-tier because it is independent of whichever
   * workspace replica is open. It deliberately does not add a new blob metric
   * label: a missing optional logo has a normal fallback, while actual serving
   * failures already hit `blob.serve` (OBSERVABILITY.md, blob markers §7).
   */
  putCachedAsset(
    sourceUrl: string,
    kind: CachedAssetKind,
    blobId: string,
    mediaType: CachedImageMediaType,
    bytes: Uint8Array,
  ): void {
    const acc = this.#accountId;
    if (!acc) throw new Error('no account is open');
    const file = p.accountBlob(this.root, acc, blobId);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) {
      if (bytes.byteLength === 0) throw new Error('cached asset bytes are empty');
      writeFileSync(file, bytes, { mode: 0o600 });
    }
    this.linkCachedAsset(sourceUrl, kind, blobId, mediaType);
  }

  /** Link another stable source URL to bytes already held in this account. */
  linkCachedAsset(
    sourceUrl: string,
    kind: CachedAssetKind,
    blobId: string,
    mediaType: CachedImageMediaType,
  ): void {
    if (!this.hasBlob(blobId)) throw new Error('cached asset blob is not held');
    this.account.prepare(`
      INSERT INTO cached_assets (source_url, kind, blob_id, media_type, cached_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_url, kind) DO UPDATE SET
        blob_id = excluded.blob_id,
        media_type = excluded.media_type,
        cached_at = excluded.cached_at
    `).run(sourceUrl, kind, blobId, mediaType, Date.now());
  }

  /** A mapping is usable only while its content-addressed bytes still exist. */
  cachedAsset(sourceUrl: string, kind: CachedAssetKind): CachedAsset | null {
    const row = this.account.prepare(`
      SELECT blob_id, media_type FROM cached_assets
      WHERE source_url = ? AND kind = ?
    `).get(sourceUrl, kind) as { blob_id: string; media_type: CachedImageMediaType } | undefined;
    if (!row || !this.hasBlob(row.blob_id)) return null;
    return { blobId: row.blob_id, mediaType: row.media_type };
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

/** A stored toolkit list; anything malformed reads as none rather than throwing a render. */
function readToolkits(raw: unknown): { toolkit: string; effect: string }[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is { toolkit: string; effect: string } =>
          typeof t === 'object' && t !== null
          && typeof (t as { toolkit?: unknown }).toolkit === 'string'
          && typeof (t as { effect?: unknown }).effect === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * A stored `visible_to`: a JSON array of actor ids, or NULL for the whole chat.
 *
 * Anything that is not an array of strings reads as null. That is safe only
 * because this column decides nothing — the server never sends this replica a
 * message it may not see — and a label that goes missing is a smaller fault
 * than a chat that throws while rendering.
 */
function readVisibleTo(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(id => typeof id === 'string') ? parsed : null;
  } catch {
    return null;
  }
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
