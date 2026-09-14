// Types for the authz spike, so the server test can import it and prove the
// shipped evaluator matches the validated model (docs/AUTHZ.md §12.1).
//
// Hand-written and deliberately partial: the spike is a JavaScript model, not a
// library, and only the surface a test needs is declared.
export type Scope = 'workspace' | 'space' | 'chat' | 'agent';
export type Role = 'owner' | 'admin' | 'member';

export declare class World {
  workspaces: Map<string, object>;
  spaces: Map<string, { workspaceId: string; visibility: string }>;
  chats: Map<string, { spaceId: string; kind: string }>;
  agents: Map<string, { workspaceId: string }>;
  memberships: { scopeType: Scope; scopeId: string; actorId: string; role: Role; leftAt: number | null }[];

  workspace(id: string): string;
  space(id: string, workspaceId: string, visibility?: string): string;
  chat(id: string, spaceId: string, kind?: string): string;
  agent(id: string, workspaceId: string): string;
  join(scopeType: Scope, scopeId: string, actorId: string, role?: Role): this;
  leave(scopeType: Scope, scopeId: string, actorId: string, at?: number): this;
  promote(scopeType: Scope, scopeId: string, actorId: string, role: Role): { changed: boolean };
  delegate(agentId: string, principalId: string, chatId: string, action: string, expiresAt: number): this;

  can(actorId: string, action: string, objectType: string, objectId: string, now?: number): boolean;
  checkTuple(actorId: string, action: string, objectType: string, objectId: string, now?: number): boolean;
  canAsAgent(agentId: string, principalId: string, action: string, chatId: string, now?: number): boolean;
  tuples(): { subject: string; relation: string; object: string }[];
}

export declare const ROLES: readonly Role[];
export declare const ACTIONS: Record<Scope, readonly string[]>;
