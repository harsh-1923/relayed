import type { Migration } from '../migrate.ts';

/**
 * The workspace replica — one per `(account, workspace)` (STORAGE.md §5).
 *
 * Everything the sync engine treats as replicated state lives here: actors now,
 * and from Phase 2 spaces, chats, messages, cursors, `pending_revs` and the
 * outbox. All of it is workspace-local by construction, which is why switching
 * workspaces touches no cursor state at all (§7).
 */
export const workspaceMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'meta',
    up: `
      CREATE TABLE meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      INSERT INTO meta(k, v) VALUES ('schema_origin', 'phase1');
    `,
  },
  {
    version: 2,
    name: 'actors',
    // DESIGN.md §8.3. Humans and agents in one table; Phase 1 writes only
    // type='human' and identity_kind='workos_user', but the shape is what lets
    // agents arrive in Phase 6 without a migration.
    //
    // No email column, deliberately: email lives in WorkOS and is never a join
    // key here, and agents have none at all.
    up: `
      CREATE TABLE actors (
        id             TEXT PRIMARY KEY,
        org_id         TEXT NOT NULL,
        workspace_id   TEXT NOT NULL,
        type           TEXT NOT NULL,
        handle         TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        avatar_blob    TEXT,

        identity_kind  TEXT,
        identity_id    TEXT,

        owner_actor_id TEXT,
        provisioned_by TEXT NOT NULL,
        state          TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,

        CHECK (type IN ('human','agent')),
        CHECK (provisioned_by IN ('self_signup','invite','sso_jit','scim','api')),
        CHECK (state IN ('invited','active','suspended','deactivated')),
        CHECK (identity_kind IS NULL OR identity_kind IN ('workos_user','workos_agent','system')),
        -- An agent must record who operates it; a human must not.
        CHECK (CASE WHEN type = 'agent' THEN owner_actor_id IS NOT NULL
                                        ELSE owner_actor_id IS NULL END)
      );

      -- One handle namespace for humans AND agents: this index is what stops
      -- @harsh and @deploy-bot colliding regardless of type.
      CREATE UNIQUE INDEX actor_handle   ON actors(workspace_id, handle);
      CREATE INDEX        actor_identity ON actors(identity_kind, identity_id);
    `,
  },
];
