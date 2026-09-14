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
  /**
   * Revision counter for the `workspace:<id>` stream, which carries the actor
   * directory and nothing else (DESIGN.md §9.9, the `welcome` ceiling).
   */
  next_rev: Generated<number>;
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
  /**
   * Revision counter for the `space:<id>` stream — renames, membership changes,
   * chats appearing and disappearing. None of these live in `messages`, which
   * is why they had no catch-up path before the event log existed.
   */
  next_rev: Generated<number>;
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
  /** Canonical Relayed Markdown; actor links carry durable ids (COMPOSER.md). */
  body: string;
  created_at: Generated<Timestamp>;
  edited_at: Timestamp | null;
  /** A tombstone. The row stays and keeps its `ord`. */
  deleted: Generated<boolean>;
  /** Whose authority an agent spent (DESIGN.md §6.4). Phase 6 populates it. */
  on_behalf_of_actor_id: string | null;
  delegation_id: string | null;
  /**
   * NULL: everyone who can read the chat. A list: only those actors, and never
   * empty (`message_visible_to`). Written only by `writeMessage`, whose
   * audience argument is required (WORKSPACE-AGENTS.md §8.5).
   */
  visible_to: string[] | null;
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

/**
 * The event log — what happened, in order, per stream (docs/SYNC-FLOWS.md §5).
 *
 * The domain tables answer "what is true now"; this one answers "what changed".
 * They are not redundant: a row cannot record its own history, because every
 * mutation overwrites the evidence of the previous one.
 */
export interface SyncEventsTable {
  event_id: string;
  workspace_id: string;
  /** No `actor`: an actor stream is a delivery address, not an ordered stream. */
  stream_kind: 'chat' | 'space' | 'workspace';
  stream_id: string;
  /** 1-based. A counter starts at 0, so rev 0 can never name an event. */
  stream_rev: number;
  event_type: string;
  /** A wire shape, never a row dump. */
  payload: unknown;
  /**
   * NULL: every reader of the stream receives the payload. A list: only those
   * actors do, and every other reader receives the revision as a `withheld`
   * event. A copy of the message's audience taken when the row was written,
   * never a live permission.
   */
  visible_to: string[] | null;
  created_at: Generated<Timestamp>;
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
  sync_events: SyncEventsTable;
}
