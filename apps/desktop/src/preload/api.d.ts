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
  body: string;
  createdAt: number;
  deleted: boolean;
  state: string;
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
  query(op: "spaces.list"): Promise<ReplicaSpace[]>;
  query(
    op: "messages.list",
    params: { chatId: string },
  ): Promise<ReplicaMessage[]>;
  /**
   * Queue a message. Returns as soon as it is on disk, NOT when it is sent —
   * the outbox is durable and the socket is not, so waiting on the network here
   * would make composing fail when offline (DESIGN.md §10).
   */
  query(
    op: "messages.send",
    params: { chatId: string; body: string },
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
  subscribe(channel: "app:state", fn: (s: AppState) => void): () => void;
  /**
   * Something in the replica changed. Carries the topics affected and NOT
   * the rows — the renderer re-reads what it holds (DESIGN.md §11.2).
   */
  subscribe(
    channel: "invalidate",
    fn: (change: { invalidation: number; topics: string[] }) => void,
  ): () => void;
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
