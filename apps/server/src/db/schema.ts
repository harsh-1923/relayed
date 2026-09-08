// Kysely types for the schema in migrations/. Hand-written to keep the SQL as
// the artifact of record (STACK.md §1) — kysely-codegen can generate these from
// a live database later, but the direction stays SQL → types, never the reverse.
import type { Generated, ColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OrganizationsTable {
  id: string;
  workos_org_id: string;
  name: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface WorkspacesTable {
  id: string;
  org_id: string;
  name: string;
  slug: string;
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
  sessions: SessionsTable;
}
