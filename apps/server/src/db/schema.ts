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

export interface DB {
  organizations: OrganizationsTable;
  workspaces: WorkspacesTable;
  actors: ActorsTable;
  memberships: MembershipsTable;
  workos_cursor: WorkosCursorTable;
  workos_memberships: WorkosMembershipsTable;
  sessions: SessionsTable;
}
