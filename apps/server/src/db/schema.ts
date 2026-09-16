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
  /** `system` is an agent the app provisions, and the only kind allowed no owner (022). */
  provisioned_by: 'self_signup' | 'invite' | 'sso_jit' | 'scim' | 'api' | 'system';
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
  /** `agent` rows are an agent's maintainers, always `admin` (010_agents.sql). */
  scope_type: 'workspace' | 'space' | 'chat' | 'agent';
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
  /** The person whose request an agent created this for. NULL when a person created it themselves. */
  on_behalf_of_actor_id: Generated<string | null>;
  /** A DM's or group DM's founding participants, sorted and comma-joined. NULL for every other kind. */
  dm_key: Generated<string | null>;
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
  /**
   * The ordered parts an agent's reply is made of (AGENT-RESPONSES.md §3), or
   * NULL for a message that is its body. JSONB; written only through
   * `writeMessage` / `updateMessage`, which derive `body` from it.
   */
  parts: unknown;
  /**
   * A system row is history the server wrote about a successful command, not
   * authored content (docs/SPACE-MEMBERSHIP-MARKERS.md). `'actor'` for every
   * message a person or agent wrote; `'system'` only ever written by the
   * domain layer itself, never from a client op.
   */
  message_kind: Generated<'actor' | 'system'>;
  /** NULL for `'actor'`; the kind of system row otherwise. */
  system_kind: 'space.member_added' | null;
  /** NULL for `'actor'`; who the system row is about otherwise (Alice, for "Alice was added by Bob"). */
  subject_actor_id: string | null;
}

/** A run of an agent, from a mention to its reply (WORKSPACE-AGENTS.md §5.2). */
export interface AgentRunsTable {
  id: string;
  workspace_id: string;
  agent_actor_id: string;
  invoker_actor_id: string;
  chat_id: string;
  trigger_message_id: string;
  attempt: Generated<number>;
  /** 1 for a person's mention; a run started by an agent's message is its run's depth + 1, never past 3. */
  chain_depth: Generated<number>;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'
    | 'refused' | 'interrupted';
  refusal: string | null;
  /** The definition this run used, captured at claim (§5.3): instructions, model, tools, config_rev. */
  config: unknown;
  reply_message_id: string | null;
  not_before: Timestamp | null;
  defer_reason: string | null;
  stopped_by: string | null;
  lease_until: Timestamp | null;
  created_at: Generated<Timestamp>;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

/** An agent's definition, beside its actor row (WORKSPACE-AGENTS.md §4.3). */
export interface AgentsTable {
  actor_id: string;
  workspace_id: string;
  description: Generated<string>;
  /** Markdown, at most 32 KB. Readable by every member of the workspace. */
  instructions: string;
  /** A runtime provider-table key; NULL is the runtime's fallback. */
  model: string | null;
  thinking_level: string | null;
  /** Bumped on every change to instructions, model or tools. */
  config_rev: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/** One tool an agent may call. Never a wildcard (WORKSPACE-AGENTS.md §4.3). */
/** What Relayed offers, deployment-wide (WORKSPACE-AGENTS.md §6.6). Refreshed daily from Composio's catalogue. */
export interface ToolkitsTable {
  slug: string;
  name: string;
  description: string;
  logo_url: string | null;
  categories: Generated<string[]>;
  auth_scheme: string;
  auth_config_id: string;
  auth_managed_by: 'composio' | 'relayed';
  auth_guide_url: string | null;
  enabled: Generated<boolean>;
  deprecated: Generated<boolean>;
  refreshed_at: Timestamp;
}

/** One tool the catalogue knows about, and the effect derived from its hints (WORKSPACE-AGENTS.md §6.6). */
export interface ToolkitToolsTable {
  toolkit: string;
  slug: string;
  name: string;
  description: string;
  hints: Generated<string[]>;
  effect_derived: 'read' | 'write' | 'destructive';
  effect_override: 'read' | 'write' | 'destructive' | null;
  important: Generated<boolean>;
  deprecated: Generated<boolean>;
  /** JSON Schema, exactly as Composio returns it (WORKSPACE-AGENTS.md §6.6, §6.7) — what `dispatcher.ts` hands the runtime as `RunTool.parameters`. */
  input_schema: Generated<unknown>;
}

/** Our mirror of a connected account (WORKSPACE-AGENTS.md §6.3) — a mirror, never a second authority. */
export interface ConnectionsTable {
  id: string;
  workspace_id: string;
  actor_id: string;
  toolkit: string;
  composio_account_id: string | null;
  status: 'connecting' | 'active' | 'needs_reauth' | 'failed' | 'disconnected';
  status_reason: 'expired' | 'revoked_upstream' | 'scopes_changed' | 'failed' | null;
  label: string | null;
  created_at: Generated<Timestamp>;
  connected_at: Timestamp | null;
  last_used_at: Timestamp | null;
  disconnected_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

/** One connect attempt, from the loopback listener to completion (WORKSPACE-AGENTS.md §6.5). */
export interface ConnectionAttemptsTable {
  id: string;
  connection_id: string;
  actor_id: string;
  start_token_hash: string;
  redirect_url: string;
  port: number;
  state: string;
  access_request_id: string | null;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
}

/** Which agents may spend which of a person's connections, and at what effect (WORKSPACE-AGENTS.md §6.4). */
export interface AgentPermissionsTable {
  invoker_actor_id: string;
  agent_actor_id: string;
  toolkit: string;
  effect: 'read' | 'write' | 'destructive';
  granted_at: Generated<Timestamp>;
  revoked_at: Timestamp | null;
}

/** Webhook idempotency (WORKSPACE-AGENTS.md §6.9, D8). */
export interface ComposioWebhookDeliveriesTable {
  webhook_id: string;
  received_at: Generated<Timestamp>;
}

/** The audit trail, and the only table that tells the truth (WORKSPACE-AGENTS.md §5.5). */
export interface AgentToolCallsTable {
  run_id: string;
  tool_call_id: string;
  toolkit: string;
  tool: string;
  effect: 'read' | 'write' | 'destructive';
  connection_id: string | null;
  outcome: 'pending' | 'ok' | 'duplicate_call' | 'permission_required' | 'connection_required'
    | 'needs_reauth' | 'failed' | 'refused' | 'tool_deprecated' | 'rate_limited'
    | 'provider_forbidden' | 'provider_unavailable';
  error_code: string | null;
  arguments: unknown;
  duration_ms: number | null;
  created_at: Generated<Timestamp>;
}

/** One toolkit-per-run access card, once a maintainer's tool needs it (WORKSPACE-AGENTS.md §7.4). Not written until `access.ts` exists. */
export interface AccessRequestsTable {
  id: string;
  run_id: string;
  actor_id: string;
  agent_actor_id: string;
  toolkit: string;
  effect: 'read' | 'write' | 'destructive';
  message_id: string;
  created_at: Generated<Timestamp>;
  resolved_at: Timestamp | null;
  expired_at: Timestamp | null;
}

/** The Composio session behind one (agent, invoker, config_rev) (WORKSPACE-AGENTS.md §6.7). */
/** A room's shared panel (PANELS.md §3.2): a surface everyone in the room works beside. */
export interface PanelsTable {
  id: string;
  workspace_id: string;
  space_id: string;
  type: 'chat' | 'web' | 'diff' | 'file' | 'attachment' | 'doc';
  chat_id: string | null;
  payload: Generated<unknown>;
  title: string | null;
  opened_from_chat_id: string | null;
  created_by_actor_id: string | null;
  on_behalf_of_actor_id: string | null;
  created_at: Generated<Timestamp>;
  opened_at: Generated<Timestamp>;
  removed_at: Timestamp | null;
}

/**
 * Text that belongs to a space and changes over time (DOCUMENTS.md §3) — as
 * opposed to a message, which is an event that happened. A room's summary is
 * the first kind.
 */
export interface DocumentsTable {
  id: string;
  workspace_id: string;
  space_id: string;
  kind: 'room_summary' | 'note';
  title: string | null;
  body: Generated<string>;
  format: Generated<'markdown'>;
  /** Monotonic per document; a reader keeps the highest it has seen (§7.2). */
  rev: Generated<number>;
  updated_by_actor_id: string | null;
  /** `{ [chatId]: ord }` — how far its writer had read (§4.5). */
  covered_through: unknown | null;
  refresh_lease_until: Timestamp | null;
  refresh_failures: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/** Every revision of a document, as a full snapshot (§3.3). */
export interface DocumentRevisionsTable {
  document_id: string;
  rev: number;
  body: string;
  author_actor_id: string | null;
  covered_through: unknown | null;
  created_at: Generated<Timestamp>;
}

/** One Composio session per person (WORKSPACE-AGENTS-IMPL.md step 7, D24), shared by every agent they invoke. */
export interface ComposioSessionsTable {
  invoker_actor_id: string;
  session_id: string;
  /** The enabled toolkits it was created for — when that set changes, it is recreated. */
  toolkits: string[];
  /** toolkit -> composio_account_id, what it is pinned to now. */
  connected_accounts: unknown;
  created_at: Generated<Timestamp>;
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
  agents: AgentsTable;
  agent_runs: AgentRunsTable;
  toolkits: ToolkitsTable;
  toolkit_tools: ToolkitToolsTable;
  connections: ConnectionsTable;
  connection_attempts: ConnectionAttemptsTable;
  documents: DocumentsTable;
  document_revisions: DocumentRevisionsTable;
  agent_permissions: AgentPermissionsTable;
  composio_webhook_deliveries: ComposioWebhookDeliveriesTable;
  agent_tool_calls: AgentToolCallsTable;
  access_requests: AccessRequestsTable;
  composio_sessions: ComposioSessionsTable;
  panels: PanelsTable;
}
