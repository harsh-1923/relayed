import type { StoredPart } from '@relayed/protocol';
import type { ApprovalDecision, ClaudeCommand, ClaudeStatus, EffortLevel, PendingApproval, RoomMode } from '../shared/claude.ts';
import type { AgentStream, LocalRoom, LocalRoomSettings } from '../shared/local-rooms.ts';
import type { AgentActivity } from '../shared/agent-activity.ts';
import type { Space, SpaceRoster } from '../shared/spaces.ts';
import type { NativeCommandId } from '../shared/shortcuts/catalogue.ts';
import type { ContentPanelType, Panel, PanelMetaRow } from '../shared/panels.ts';
import type { Document } from '../shared/documents.ts';
import type { ImageMediaType } from '../shared/blobs.ts';
import type { BrowserImportResult, BrowserImportSource, BrowserImportSourceId } from '../shared/browser-import.ts';

export type {
  ApprovalDecision, ApprovalQuestion, ClaudeAccount, ClaudeCommand, ClaudeModel, ClaudeStatus, EffortLevel, PendingApproval, RoomMode,
} from '../shared/claude.ts';
export type { AgentStream, LocalRoom, LocalRoomSettings } from '../shared/local-rooms.ts';
export type { AgentActivity } from '../shared/agent-activity.ts';
export type { Space, SpaceChat, SpaceMember, SpaceRoster, SpaceScope } from '../shared/spaces.ts';
export type { ContentPanelType, Panel, PanelMeta, PanelMetaRow } from '../shared/panels.ts';
export type { Document } from '../shared/documents.ts';
export type { BrowserImportResult, BrowserImportSource, BrowserImportSourceId } from '../shared/browser-import.ts';

export interface DbInfo {
  open: boolean;
  accountId?: string | null;
  workspaceId?: string | null;
  schemaVersion?: number;
  autoVacuum?: number;
  journalMode?: string;
  tables?: number;
  sqlite?: string;
  node?: string;
  pid?: number;
}
export interface Actor {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  orgId: string;
  workspaceId: string;
}
export interface PendingJoin {
  workspaceId: string;
  orgId: string;
  name: string;
  handleSuggestions: string[];
}

export interface Invitation {
  id: string;
  email: string;
  state: string;
  expires_at: string;
}

/**
 * An online command's answer. A refusal is an answer, not an exception, so the
 * surface can put it beside the field or actor it names.
 */
export type CommandAnswer<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; field?: string; reason?: string; action?: string };

export type AgentAnswer<T> = CommandAnswer<T>;

/** The agent editor's fields, as the server names them. */
export interface AgentInput {
  name?: string;
  handle?: string;
  description?: string;
  instructions?: string;
  /** `provider/model`, or null for the runtime's fallback. */
  model?: string | null;
  space_ids?: string[];
}

/** What an agent was told — an online read, never in the replica. */
export interface AgentDefinition {
  agent_id: string;
  found: boolean;
  definition?: {
    description: string;
    instructions: string;
    model: string | null;
    thinking_level: string | null;
    config_rev: number;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    maintainers: string[];
    space_ids: string[];
    /** What the server says this person may do. For hiding controls, never for permitting. */
    you: { edit: boolean; manage_maintainers: boolean; deactivate: boolean };
  };
}

/** An actor as the client holds it — no Layer 1 identifiers (DESIGN.md §6.3). */
export interface ReplicaActor {
  id: string;
  workspaceId: string;
  type: "human" | "agent";
  handle: string;
  displayName: string;
  /** Where it came from. Never rendered — the CSP blocks it (invariant 46). */
  avatarUrl: string | null;
  /** sha256 of bytes held locally, served over relayed-blob:. What to render. */
  avatarBlob: string | null;
  ownerActorId: string | null;
  state: string;
  updatedAt: number;
  /** An agent's summary, or null for a person. Instructions are an online read. */
  agent: ReplicaAgentSummary | null;
}

export interface ReplicaAgentSummary {
  description: string;
  /** Bumped when instructions or model change. */
  configRev: number;
  /** Always empty since agents find their own tools (WORKSPACE-AGENTS-IMPL.md step 7). */
  toolkits: { toolkit: string; effect: string }[];
}

/** One connected account, as the replica holds it (WORKSPACE-AGENTS.md §6.3). Always the signed-in actor's own. */
export interface ConnectionRow {
  id: string;
  toolkit: string;
  status: "connecting" | "active" | "needs_reauth" | "failed" | "disconnected";
  statusReason: "expired" | "revoked_upstream" | "scopes_changed" | "failed" | null;
  label: string | null;
}

/** One agent's grant, as the replica holds it (WORKSPACE-AGENTS.md §6.4). Always the signed-in actor's own. */
export interface AgentPermissionRow {
  agentActorId: string;
  toolkit: string;
  effect: "read" | "write" | "destructive";
  revoked: boolean;
}

/** A toolkit's mark as this account holds it: a content address, never the remote URL. */
export interface ToolkitLogo {
  slug: string;
  logoBlob: string;
  logoMediaType: ImageMediaType;
}

/** One offered toolkit (§7.1) — online-only, not replicated. Its mark is `toolkits.logos`. */
export interface ToolkitSummary {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  authScheme: string;
  deprecated: boolean;
}

/**
 * A message, joined to its author.
 *
 * `state` is the one field the surface must not ignore: `pending` is an
 * optimistic row the server has not acknowledged, `failed` is one it refused,
 * and rendering the three identically is how a message that never sent looks
 * exactly like one that did (DESIGN.md §10.2).
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
   * `actors.type`, or null while the author is not in the directory yet. Tool
   * and ui parts are drawn only for an agent, so an unknown author's render as
   * body until the directory arrives.
   */
  authorType: string | null;
  /** Always present, and derived from `parts` when there are any: search, previews and fallbacks read it. */
  body: string;
  /** As the server sent them, possibly holding kinds this build does not know. Null for none. */
  parts: StoredPart[] | null;
  createdAt: number;
  deleted: boolean;
  state: string;
  /** A restricted message's actors, this person among them; null for the whole chat. */
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

export interface ComposerDraft {
  chatId: string;
  body: string;
  revision: number;
  updatedAt: number;
}

/**
 * One preference row, exactly as stored (PREFERENCES.md §6).
 *
 * `value` is JSON TEXT and deliberately not decoded here: decoding needs the
 * shared catalogue's fallback for anything this build cannot parse, so it
 * happens in `usePreference` rather than on the wire.
 */
export interface PreferenceRow {
  key: string;
  value: string;
  reach: "local" | "synced";
}

export type AuthState =
  | { status: "signed_out" }
  /** Binding the loopback socket. Nothing to cancel yet, and no link to open. */
  | { status: "authenticating" }
  /** The browser is open and we are waiting on the person in it. */
  | { status: "awaiting_browser" }
  | {
      status: "needs_workspace";
      identity: { email: string; displayName: string };
      handleSuggestions: string[];
      pendingJoins: PendingJoin[];
    }
  | { status: "authenticated"; actor: Actor | null; expiresAt: number }
  | { status: "stale"; actor: Actor | null; reason: string };

/**
 * A row of the switcher. Cached in account.db, so it renders offline
 * (STORAGE.md §6).
 *
 * Two subjects — the workspace, and me in it — so every field says whose it is.
 */
export interface WorkspaceRow {
  workspaceId: string;
  orgId: string;
  name: string;
  slug: string;
  workspaceAvatarUrl: string | null;
  workspaceAvatarBlob: string | null;
  actorId: string;
  actorHandle: string;
  actorDisplayName: string;
  actorAvatarUrl: string | null;
  actorAvatarBlob: string | null;
  actorRole: "owner" | "admin" | "member";
  lastOpenedAt: number | null;
  unreadHint: number;
  mentionHint: number;
  outboxHint: number;
  state: "active" | "removed";
}

export interface AppState {
  /**
   * My grants in the ACTIVE workspace, as `scope:id -> role` pairs — the shape
   * the shared can() takes (AUTHZ.md §3). An array rather than a Map because a
   * Map does not survive structured cloning.
   */
  grants: [string, "owner" | "admin" | "member"][];
  installId: string;
  /** Bumped on every workspace switch; stale replies are dropped (§12.1). */
  epoch: number;
  accountId: string | null;
  accounts: { accountId: string; workspaces: number; lastActiveAt: number }[];
  workspaceId: string | null;
  workspaces: WorkspaceRow[];
  auth: AuthState;
  /** Development build. False in a packaged app, where the controls do not exist. */
  devTools: boolean;
  /** The network is cut for the sync process — simulated aeroplane. */
  offline: boolean;
  /** This build can simulate offline. False in production, where the code is absent. */
  canGoOffline: boolean;
  /**
   * The host platform, as `process.platform` reports it.
   *
   * The renderer needs it for chrome that genuinely differs by OS — the macOS
   * traffic lights sit inside our top bar and the left of that bar has to be
   * left empty for them. Read from the process rather than sniffed from the
   * user agent, because a string parsed out of a UA is a guess about a fact we
   * already hold.
   */
  platform: string;
}

export interface FileNode {
  name: string;
  /** null for a directory. */
  bytes: number | null;
  children: FileNode[];
}

/** Everything on disk. Debug only. */
export interface DebugSnapshot {
  root: string;
  installId: string;
  epoch: number;
  tree: FileNode[];
  hiddenFiles: number;
  databases: {
    name: string;
    path: string;
    userVersion: number;
    autoVacuum: number;
    tables: { name: string; rows: Record<string, unknown>[]; total: number }[];
  }[];
  vaultSlots: string[];
}

export interface RelayedApi {
  query(op: "ping"): Promise<{ pong: boolean; at: number }>;
  query(op: "db.info"): Promise<DbInfo>;
  query(op: "ports.live"): Promise<{ count: number }>;
  query(op: "app.state"): Promise<AppState>;
  query(op: "auth.state"): Promise<AuthState>;
  query(op: "auth.signIn"): Promise<AppState>;
  query(op: "auth.cancelSignIn"): Promise<AppState>;
  query(op: "auth.reopenBrowser"): Promise<{ reopened: boolean }>;
  query(op: "dev.setOffline", params: { offline: boolean }): Promise<AppState>;
  query(op: "actors.list"): Promise<ReplicaActor[]>;
  query(op: "spaces.list"): Promise<Space[]>;
  /** One space and its chats: one row, or none when this replica does not hold it. */
  query(op: "space.get", params: { spaceId: string }): Promise<Space[]>;
  /**
   * Who is in a space, as this device holds it — one row. A list not held yet
   * is asked for by the read itself, and the read wakes when it lands.
   */
  query(op: "space.members", params: { spaceId: string }): Promise<SpaceRoster[]>;
  /** Who is in a chat, as far as this device can tell: actor ids, starter first. */
  query(op: "chat.participants", params: { chatId: string }): Promise<string[]>;
  /** The same, for a local room's chat. */
  query(op: "local.chat.participants", params: { chatId: string }): Promise<string[]>;
  /** One synced room's shared panels (PANELS.md). */
  query(op: "panels.list", params: { spaceId: string }): Promise<Panel[]>;
  /** One space's documents — a room's running summary (DOCUMENTS.md). */
  query(op: "documents.list", params: { spaceId: string }): Promise<Document[]>;
  /**
   * Refresh this room's summary now (DOCUMENTS.md §4.4). Online only, and rate
   * limited: `too_soon` means one was written within the last minute.
   */
  query(op: "documents.refreshSummary", params: { spaceId: string }):
    Promise<AgentAnswer<{ space_id: string; outcome: string }>>;
  query(op: "prefs.list"): Promise<PreferenceRow[]>;
  /** The person's own Claude Code, as one row (LOCAL-ROOMS.md §3.2). Probes once, then answers from memory. */
  query(op: "claude.status"): Promise<ClaudeStatus[]>;
  /** Probe Claude Code again. Resolves when the new status is in; `claude.status` readers are woken. */
  query(op: "claude.refresh"): Promise<null>;
  /** Local rooms: the account's, most recently active first (LOCAL-ROOMS.md §7). */
  query(op: "local.rooms.list"): Promise<LocalRoom[]>;
  /** One local room as a space, in the replica's shape: one row, or none. */
  query(op: "local.space.get", params: { spaceId: string }): Promise<Space[]>;
  /** What only a local room has: its folder, how Claude runs there, whether it is replying. One row, or none. */
  query(op: "local.rooms.get", params: { spaceId: string }): Promise<LocalRoomSettings[]>;
  /** Create a room about a folder. Without `cwd` the person picks one; cancelling returns null. */
  query(
    op: "local.rooms.create",
    params?: { name?: string; cwd?: string },
  ): Promise<{ spaceId: string; chatId: string } | null>;
  query(op: "local.messages.list", params: { chatId: string }): Promise<ReplicaMessage[]>;
  query(op: "local.drafts.get", params: { chatId: string }): Promise<ComposerDraft[]>;
  query(op: "local.drafts.save", params: { chatId: string; body: string; revision: number }): Promise<null>;
  /** Send, and start Claude's reply. Resolves once both rows are on disk. */
  query(
    op: "local.messages.send",
    params: { chatId: string; body: string; draftRevision?: number },
  ): Promise<{ id: string; replyId: string }>;
  /** Stop Claude mid-reply in this chat. */
  query(op: "local.turn.stop", params: { chatId: string }): Promise<null>;
  /** A side chat in a local room, created with its panel (PANELS.md §4.1). */
  query(op: "local.chats.create", params: { spaceId: string; name: string; kind: "public" | "private" }): Promise<{ chatId: string; panelId: string }>;
  /** Every panel in a room, shared and local, oldest first. */
  query(op: "local.panels.list", params: { spaceId: string }): Promise<Panel[]>;
  /** Open a content panel on this device only. Opening the same thing again returns the same panel. */
  query(op: "local.panels.open", params: { spaceId: string; workspaceId?: string | null; type: ContentPanelType; payload: Record<string, unknown>; title?: string | null; openedFromChatId?: string | null }): Promise<{ id: string }>;
  /** Open an http(s) address in the system browser. */
  query(op: "web.openExternal", params: { url: string }): Promise<null>;
  /** What this device learned about a room's panels by showing them: last locations, page titles and icons. */
  query(op: "local.panels.meta", params: { spaceId: string }): Promise<PanelMetaRow[]>;
  /** A panel on screen reporting its page. `icon` is a small raster `data:` URL; anything else is ignored. */
  query(op: "local.panels.reportMeta", params: { panelId: string; spaceId: string; currentUrl?: string; pageTitle?: string; icon?: string }): Promise<null>;
  /** Browsers on this Mac that web panels can import signed-in sessions from. */
  query(op: "browserImport.sources"): Promise<BrowserImportSource[]>;
  /** Copy one browser profile's cookies into this account's web panels. Never rejects for an expected failure. */
  query(op: "browserImport.run", params: { sourceId: BrowserImportSourceId; directory: string }): Promise<BrowserImportResult>;
  /** Sign web panels out of every site. */
  query(op: "browserImport.clear"): Promise<null>;
  query(op: "browserImport.openFullDiskAccess"): Promise<null>;
  query(op: "local.panels.touch", params: { panelId: string }): Promise<null>;
  /** Share a local panel into its local room. One-way. */
  query(op: "local.panels.share", params: { panelId: string }): Promise<null>;
  /** Delete a local panel, or tombstone a shared content panel. Chat panels go with their chat. */
  query(op: "local.panels.remove", params: { panelId: string }): Promise<null>;
  /** How Claude may act in a room without asking. Live sessions take it from their next tool call. */
  query(op: "local.rooms.setMode", params: { spaceId: string; mode: RoomMode }): Promise<null>;
  /** The slash commands this chat's folder offers. Empty until Claude Code has been asked; readers are woken when it answers. */
  query(op: "local.commands.list", params: { chatId: string }): Promise<ClaudeCommand[]>;
  /** The app's /clear: the chat's next message starts a new Claude Code session. */
  query(op: "local.chats.clearSession", params: { chatId: string }): Promise<null>;
  /** Rename a room. Always wins over an automatic name. */
  query(op: "local.rooms.rename", params: { spaceId: string; name: string }): Promise<{ name: string }>;
  /** Name a room again from its conversation. `name` is null when nothing better came back. */
  query(op: "local.rooms.regenerateTitle", params: { spaceId: string }): Promise<{ name: string | null }>;
  /** The room's model and effort; null for either is the default. The model switches in place, effort from the next message. */
  query(op: "local.rooms.setModel", params: { spaceId: string; model: string | null; effort: EffortLevel | null }): Promise<null>;
  /** What Claude Code is waiting on the person for in this chat, oldest first (LOCAL-ROOMS.md §8.5). */
  query(op: "local.approvals.list", params: { chatId: string }): Promise<PendingApproval[]>;
  /** Answer one. Rejects if its turn has already ended. */
  query(
    op: "local.approvals.respond",
    params: { chatId: string; approvalId: string; decision: ApprovalDecision },
  ): Promise<null>;
  /**
   * Change one preference. Validated against the shared catalogue in the
   * engine — an unknown key or a value outside its domain rejects.
   */
  query(
    op: "prefs.set",
    params: { key: string; value: unknown },
  ): Promise<null>;
  /** Delete one preference row, returning the key to its default. */
  query(op: "prefs.clear", params: { key: string }): Promise<null>;
  /**
   * Sets and clears committed together or not at all. A hard keybinding
   * conflict rejects the batch with a message starting `keybinding conflict`.
   */
  query(
    op: "prefs.apply",
    params: {
      changes: (
        | { op: "set"; key: string; value: unknown }
        | { op: "clear"; key: string }
      )[];
    },
  ): Promise<null>;
  query(
    op: "messages.list",
    params: { chatId: string },
  ): Promise<ReplicaMessage[]>;
  query(op: "drafts.get", params: { chatId: string }): Promise<ComposerDraft[]>;
  query(op: "drafts.save", params: { chatId: string; body: string; revision: number }): Promise<null>;
  /**
   * Queue a message. Returns as soon as it is on disk, NOT when it is sent —
   * the outbox is durable and the socket is not, so waiting on the network here
   * would make composing fail when offline (DESIGN.md §10).
   */
  query(
    op: "messages.send",
    params: { chatId: string; body: string; draftRevision?: number },
  ): Promise<{ id: string }>;
  query(op: "auth.signOut"): Promise<AppState>;
  query(op: "auth.configured"): Promise<{ clientId: string | null }>;
  query(
    op: "auth.createWorkspace",
    params: { workspaceName: string; handle: string },
  ): Promise<AppState>;
  query(
    op: "workspace.switch",
    params: { workspaceId: string },
  ): Promise<AppState>;
  query(op: "debug.snapshot"): Promise<DebugSnapshot>;
  /**
   * Forward one catalogued record to the sync process, which owns the SDK
   * (OBSERVABILITY.md §3). Typed against the catalogue on the renderer side
   * by `lib/telemetry.ts`; loose here because the bridge carries the wire
   * shape, not the catalogue.
   */
  query(
    op: "telemetry.emit",
    params: {
      kind: "event" | "count" | "histogram";
      name: string;
      value?: number;
      fields?: Record<string, string | number | boolean>;
      labels?: Record<string, string>;
      /** Records the renderer discarded since the last successful post. */
      dropped?: number;
    },
  ): Promise<null>;
  /** The router painted. The duration is computed on the other side. */
  query(op: "telemetry.firstPaint", params: { at: number }): Promise<null>;
  query(
    op: "invite.list",
  ): Promise<{ invitations: Invitation[]; offline: boolean }>;
  query(
    op: "invite.create",
    params: { email: string },
  ): Promise<{ invitation: Invitation }>;
  query(
    op: "invite.revoke",
    params: { id: string },
  ): Promise<{ invitation: Invitation }>;
  query(
    op: "auth.join",
    params: { workspaceId: string; handle: string },
  ): Promise<AppState>;
  query(
    op: "spaces.create",
    params: { workspaceId: string; kind: 'channel' | 'room'; name: string; visibility: 'public' | 'private' },
  ): Promise<CommandAnswer<{ space_id: string; chat_id: string }>>;
  /**
   * Open the DM or group DM with these people — the one already there, or a new
   * one. `actorIds` are the others; you are always in it. `created` is false
   * when it already existed.
   */
  query(
    op: "dms.open",
    params: { workspaceId: string; actorIds: string[] },
  ): Promise<CommandAnswer<{ space_id: string; chat_id: string; created: boolean }>>;
  query(
    op: "spaces.addMember",
    params: { spaceId: string; actorId: string },
  ): Promise<CommandAnswer<{ space_id: string; actor_id: string; message_id: string }>>;
  /** Start a side chat in a synced room (docs/SIDE-CHATS.md). Public only, for now. */
  query(
    op: "spaces.createChat",
    params: { spaceId: string; name: string; kind: "public"; withActorIds: string[] },
  ): Promise<CommandAnswer<{ space_id: string; chat_id: string; panel_id: string; created: boolean }>>;
  query(
    op: "agents.handle",
    params: { handle: string; except?: string },
  ): Promise<AgentAnswer<{ handle: string; available: boolean; reason: string | null }>>;
  query(op: "agents.create", params: AgentInput): Promise<AgentAnswer<{ agent_id: string }>>;
  query(
    op: "agents.update",
    params: AgentInput & { agentId: string },
  ): Promise<AgentAnswer<{ agent_id: string }>>;
  query(
    op: "agents.deactivate",
    params: { agentId: string },
  ): Promise<AgentAnswer<{ agent_id: string; state: string }>>;
  query(
    op: "agents.setMaintainers",
    params: { agentId: string; actorIds: string[] },
  ): Promise<AgentAnswer<{ agent_id: string; maintainers: string[] }>>;
  /** Null when the socket is not live: unreachable, which is not "not found". */
  query(op: "agents.definition", params: { agentId: string }): Promise<AgentDefinition | null>;
  /** Stop a run in flight, invoker-only (WORKSPACE-AGENTS.md §5.8). */
  query(op: "agents.stopRun", params: { runId: string }): Promise<AgentAnswer<{ run_id: string; state: string }>>;

  // ── connections, through Composio (WORKSPACE-AGENTS.md §6) ───────────────
  query(op: "connections.list"): Promise<ConnectionRow[]>;
  query(op: "agentPermissions.list"): Promise<AgentPermissionRow[]>;
  /** The offered catalogue, online-only (§7.1). Empty, with `offline: true`, when there is no connection — the same shape `invite.list` uses. */
  query(op: "toolkits.list"): Promise<{ toolkits: ToolkitSummary[]; offline: boolean }>;
  /** Marks for the last catalogue read that are already on disk. Grows as background downloads land. */
  query(op: "toolkits.logos"): Promise<ToolkitLogo[]>;
  /**
   * Listens, asks the server to start a connection, opens the result in the
   * system browser, and resolves once the account is ACTIVE (§6.5). Slow —
   * it waits on the person finishing OAuth or the hosted form — and never a
   * `BrowserWindow`.
   */
  query(
    op: "connections.connect",
    params: { toolkit: string; accessRequestId?: string },
  ): Promise<AgentAnswer<{ connectionId: string; status: string }>>;
  query(
    op: "connections.disconnect",
    params: { connectionId: string },
  ): Promise<AgentAnswer<{ connection_id: string; status: string; revoked: boolean }>>;
  query(
    op: "permissions.grant",
    params: { agentId: string; toolkit: string },
  ): Promise<AgentAnswer<{ agent_id: string; toolkit: string; effect: string }>>;
  query(
    op: "permissions.revoke",
    params: { agentId: string; toolkit: string },
  ): Promise<AgentAnswer<{ agent_id: string; toolkit: string; revoked: boolean }>>;
  /** The card's own Allow (§7.4) — the same grant as `permissions.grant`, reached from the request instead of the connector store. */
  query(
    op: "access.allow",
    params: { requestId: string },
  ): Promise<AgentAnswer<{ request_id: string; state: string; effect?: string }>>;
  subscribe(channel: "app:state", fn: (s: AppState) => void): () => void;
  /** The live text of a reply Claude is writing. Never stored; the parts carry it in the end. */
  subscribe(channel: "agent:stream", fn: (stream: AgentStream) => void): () => void;
  /** The working indicator for a workspace agent's run. Never stored. */
  subscribe(channel: "agent:activity", fn: (activity: AgentActivity) => void): () => void;
  /**
   * Something in the replica changed. Carries the topics affected and NOT
   * the rows — the renderer re-reads what it holds (DESIGN.md §11.2).
   */
  subscribe(
    channel: "invalidate",
    fn: (change: { invalidation: number; topics: string[] }) => void,
  ): () => void;
  /**
   * A command chosen from the application menu. Only IDs on the menu's
   * allow-list arrive; the returned function unsubscribes.
   */
  onCommand(fn: (id: NativeCommandId) => void): () => void;
  /** A link in a web panel that wants a tab. `webContentsId` is the page it was clicked in. */
  onWebPanelOpen(fn: (request: { webContentsId: number; url: string; background: boolean }) => void): () => void;
  /**
   * Property name marking a reply superseded by a workspace switch. Present on
   * the RESOLVED value — contextBridge drops custom properties from Errors.
   */
  readonly STALE: string;
}
declare global {
  interface Window {
    relayed: RelayedApi;
  }
}
