export interface DbInfo {
  open: boolean;
  accountId?: string | null; workspaceId?: string | null;
  schemaVersion?: number; autoVacuum?: number; journalMode?: string;
  tables?: number; sqlite?: string; node?: string; pid?: number;
}
export interface Actor {
  id: string; handle: string; displayName: string; avatarUrl: string | null;
  orgId: string; workspaceId: string;
}
export interface PendingJoin {
  workspaceId: string; orgId: string; name: string; handleSuggestions: string[];
}

export interface Invitation { id: string; email: string; state: string; expires_at: string }

export type AuthState =
  | { status: 'signed_out' }
  | { status: 'authenticating' }
  | { status: 'needs_workspace'; identity: { email: string; displayName: string };
      handleSuggestions: string[]; pendingJoins: PendingJoin[] }
  | { status: 'authenticated'; actor: Actor | null; expiresAt: number }
  | { status: 'stale'; actor: Actor | null; reason: string };

/**
 * A row of the switcher. Cached in account.db, so it renders offline
 * (STORAGE.md §6).
 *
 * Two subjects — the workspace, and me in it — so every field says whose it is.
 */
export interface WorkspaceRow {
  workspaceId: string; orgId: string; name: string; slug: string;
  workspaceAvatarUrl: string | null; workspaceAvatarBlob: string | null;
  actorId: string; actorHandle: string; actorDisplayName: string;
  actorAvatarUrl: string | null; actorAvatarBlob: string | null;
  actorRole: 'owner' | 'admin' | 'member';
  lastOpenedAt: number | null;
  unreadHint: number; mentionHint: number; outboxHint: number;
  state: 'active' | 'removed';
}

export interface AppState {
  /**
   * My grants in the ACTIVE workspace, as `scope:id -> role` pairs — the shape
   * the shared can() takes (AUTHZ.md §3). An array rather than a Map because a
   * Map does not survive structured cloning.
   */
  grants: [string, 'owner' | 'admin' | 'member'][];
  installId: string;
  /** Bumped on every workspace switch; stale replies are dropped (§12.1). */
  epoch: number;
  accountId: string | null;
  accounts: { accountId: string; workspaces: number; lastActiveAt: number }[];
  workspaceId: string | null;
  workspaces: WorkspaceRow[];
  auth: AuthState;
  /** A sign-in is waiting on a browser, and can be cancelled or re-opened. */
  awaitingBrowser: boolean;
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
  databases: { name: string; path: string; userVersion: number; autoVacuum: number;
               tables: { name: string; rows: Record<string, unknown>[]; total: number }[] }[];
  vaultSlots: string[];
}

export interface RelayedApi {
  query(op: 'ping'): Promise<{ pong: boolean; at: number }>;
  query(op: 'db.info'): Promise<DbInfo>;
  query(op: 'ports.live'): Promise<{ count: number }>;
  query(op: 'app.state'): Promise<AppState>;
  query(op: 'auth.state'): Promise<AuthState>;
  query(op: 'auth.signIn'): Promise<AppState>;
  query(op: 'auth.cancelSignIn'): Promise<AppState>;
  query(op: 'auth.reopenBrowser'): Promise<{ reopened: boolean }>;
  query(op: 'auth.signOut'): Promise<AppState>;
  query(op: 'auth.configured'): Promise<{ clientId: string | null }>;
  query(op: 'auth.createWorkspace', params: { workspaceName: string; handle: string }): Promise<AppState>;
  query(op: 'workspace.switch', params: { workspaceId: string }): Promise<AppState>;
  query(op: 'debug.snapshot'): Promise<DebugSnapshot>;
  query(op: 'invite.list'): Promise<{ invitations: Invitation[]; offline: boolean }>;
  query(op: 'invite.create', params: { email: string }): Promise<{ invitation: Invitation }>;
  query(op: 'invite.revoke', params: { id: string }): Promise<{ invitation: Invitation }>;
  query(op: 'auth.join', params: { workspaceId: string; handle: string }): Promise<AppState>;
  subscribe(channel: 'app:state', fn: (s: AppState) => void): () => void;
  /**
   * Property name marking a reply superseded by a workspace switch. Present on
   * the RESOLVED value — contextBridge drops custom properties from Errors.
   */
  readonly STALE: string;
}
declare global { interface Window { relayed: RelayedApi } }
