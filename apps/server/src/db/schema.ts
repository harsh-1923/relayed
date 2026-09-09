// Kysely types for the schema in migrations/. Hand-written to keep the SQL as
// the artifact of record (STACK.md §1) — kysely-codegen can generate these from
// a live database later, but the direction stays SQL → types, never the reverse.
import type { Generated, ColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OrganizationsTable {
  id: string;
  workos_org_id: string;
  name: string;
  avatar_url: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface WorkspacesTable {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  avatar_url: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ActorsTable {
  id: string;
  org_id: string;
  workspace_id: string;
  type: 'human' | 'agent';
  handle: string;
  display_name: string;
  avatar_url: string | null;
  identity_kind: 'workos_user' | 'workos_agent' | 'system' | null;
  identity_id: string | null;
  owner_actor_id: string | null;
  provisioned_by: 'self_signup' | 'invite' | 'sso_jit' | 'scim' | 'api';
  state: Generated<'invited' | 'active' | 'suspended' | 'deactivated'>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * A permission, as a row (docs/AUTHZ.md §4). Read as a triple this is a
 * relationship tuple — (actor_id, role, scope_type:scope_id) — which is what
 * makes the evaluator swappable without touching the data.
 */
export interface MembershipsTable {
  scope_type: 'workspace' | 'space' | 'chat';
  scope_id: string;
  actor_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: Generated<Timestamp>;
  /** Leaving is a tombstone, never a delete. */
  left_at: Timestamp | null;
}

/** Where the WorkOS event poller has read up to. One row. */
export interface WorkosCursorTable {
  id: string;
  after_id: string | null;
  updated_at: Generated<Timestamp>;
}

/** What WorkOS says about org membership — admitted, not permitted. */
export interface WorkosMembershipsTable {
  workos_user_id: string;
  workos_org_id: string;
  role_slug: string | null;
  status: string;
  seen_at: Generated<Timestamp>;
}

export interface SessionsTable {
  id: string;
  actor_id: string;
  device_id: string;
  refresh_hash: string;
  created_at: Generated<Timestamp>;
  last_seen_at: Generated<Timestamp>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

/**
 * A space: channel, DM, group DM or room, in one table discriminated by `kind`
 * (DESIGN.md §7.1). Phase 2 writes only `channel`.
 */
export interface SpacesTable {
  id: string;
  org_id: string;
  workspace_id: string;
  kind: 'channel' | 'dm' | 'group_dm' | 'room';
  /** NULL for dm/group_dm, which derive a name from their members. */
  name: string | null;
  /** Channels only. */
  slug: string | null;
  topic: string | null;
  /** NULL for dm/group_dm; required and checked for everything else. */
  visibility: 'public' | 'private' | null;
  membership_policy: 'open' | 'invite' | 'sealed';
  lifecycle: Generated<'active' | 'dormant' | 'archived'>;
  created_by_actor_id: string | null;
  last_activity_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * The universal message container, and the sync unit (DESIGN.md §7.1).
 *
 * `next_ord` and `next_rev` are the allocation counters and are NOT
 * interchangeable: `ord` advances only when a message is created, `rev` on any
 * mutation (§8.1). Step B is the only code allowed to bump them.
 */
export interface ChatsTable {
  id: string;
  workspace_id: string;
  space_id: string;
  kind: 'sole' | 'default' | 'public' | 'private';
  /** NULL for 'sole' and 'default'. */
  name: string | null;
  next_ord: Generated<number>;
  next_rev: Generated<number>;
  created_by_actor_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface MessagesTable {
  /** Client-generated ULID (DESIGN.md §10.1). Never a server sequence. */
  id: string;
  chat_id: string;
  /** NULL = top-level, else the thread root. Threads are Phase 4. */
  parent_id: string | null;
  ord: number;
  rev: number;
  author_id: string;
  /** Mentions are `<@actor_id>` markup, never a handle. */
  body: string;
  created_at: Generated<Timestamp>;
  edited_at: Timestamp | null;
  /** A tombstone. The row stays and keeps its `ord`. */
  deleted: Generated<boolean>;
  /** Whose authority an agent spent (DESIGN.md §6.4). Phase 6 populates it. */
  on_behalf_of_actor_id: string | null;
  delegation_id: string | null;
}

/**
 * The idempotency ledger (DESIGN.md §8.4). A retried op returns the SAME ack
 * rather than doing the work twice — the fix for the most common offline-sync
 * bug there is.
 */
export interface OpsTable {
  op_id: string;
  /** Compared against the replayer, so one client cannot claim another's ack. */
  actor_id: string;
  chat_id: string;
  kind: 'send' | 'delete';
  /** The original ack, verbatim. Replaying returns this, never a recomputation. */
  result: unknown;
  created_at: Generated<Timestamp>;
}

/**
 * Per-(actor, chat) read cursor and counters (DESIGN.md §12). Server-owned,
 * because mention counts and thread unread cannot be derived by arithmetic.
 */
export interface ChatReadStateTable {
  chat_id: string;
  actor_id: string;
  /** A MAX-register, never LWW (DESIGN.md §4). */
  last_read_ord: Generated<number>;
  chat_unread: Generated<number>;
  thread_unread: Generated<number>;
  mention_count: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface DB {
  organizations: OrganizationsTable;
  workspaces: WorkspacesTable;
  actors: ActorsTable;
  memberships: MembershipsTable;
  workos_cursor: WorkosCursorTable;
  workos_memberships: WorkosMembershipsTable;
  sessions: SessionsTable;
  spaces: SpacesTable;
  chats: ChatsTable;
  messages: MessagesTable;
  ops: OpsTable;
  chat_read_state: ChatReadStateTable;
}
