export interface DbInfo {
  file: string; schemaVersion: number; autoVacuum: number; journalMode: string;
  tables: number; sqlite: string; node: string; pid: number;
}
export interface Actor {
  id: string; handle: string; displayName: string; avatarUrl: string | null;
  orgId: string; workspaceId: string;
}
export type AuthState =
  | { status: 'signed_out' }
  | { status: 'authenticating' }
  | { status: 'needs_workspace'; identity: { email: string; displayName: string };
      handleSuggestions: string[] }
  | { status: 'authenticated'; actor: Actor | null; expiresAt: number }
  | { status: 'stale'; actor: Actor | null; reason: string };

export interface RelayedApi {
  query(op: 'ping'): Promise<{ pong: boolean; at: number }>;
  query(op: 'db.info'): Promise<DbInfo>;
  query(op: 'ports.live'): Promise<{ count: number }>;
  query(op: 'auth.state'): Promise<AuthState>;
  query(op: 'auth.signIn'): Promise<AuthState>;
  query(op: 'auth.signOut'): Promise<AuthState>;
  query(op: 'auth.configured'): Promise<{ clientId: string | null }>;
  query(op: 'auth.createWorkspace', params: { workspaceName: string; handle: string }): Promise<AuthState>;
  subscribe(channel: 'auth:state', fn: (s: AuthState) => void): () => void;
}
declare global { interface Window { relayed: RelayedApi } }
