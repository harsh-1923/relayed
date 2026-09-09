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
    name: 'replica',
    up: `
      CREATE TABLE meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      INSERT INTO meta(k, v) VALUES ('schema_origin', 'phase1');

      -- Humans and agents in one table (DESIGN.md §8.3). Phase 1 replicates
      -- only type='human', but the shape is what lets agents arrive in Phase 6
      -- without a migration.
      --
      -- This is a REPLICA of what the server holds, and deliberately not all of
      -- it. Two fields the server has are absent:
      --
      --   identity_kind / identity_id — every member's WorkOS user id, on every
      --     member's disk. §6.3 keeps Layer 1 above Layer 2 precisely so that
      --     nothing below needs it, and nothing on the client does: the client
      --     addresses actors by actor_id and always has. Replicating it would
      --     hand each member a directory of everyone else's external
      --     identifiers, for no feature.
      --
      --   provisioned_by — how someone came to be here is an administrative
      --     fact, not a rendering one. It stays server-side until something
      --     needs to display it.
      --
      -- No email column, deliberately: email lives in WorkOS, is never a join
      -- key, and agents have none at all.
      CREATE TABLE actors (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        type           TEXT NOT NULL,
        handle         TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        -- Where the picture came from, and the sha256 of the bytes we hold.
        -- Named apart because a column called avatar_blob that held a URL put a
        -- network fetch in the render path once already (STORAGE.md §14).
        avatar_url     TEXT,
        avatar_blob    TEXT,

        -- An agent records who operates it; a human must not (§6.4).
        owner_actor_id TEXT,
        state          TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,

        CHECK (type IN ('human','agent')),
        CHECK (state IN ('invited','active','suspended','deactivated')),
        CHECK (CASE WHEN type = 'agent' THEN owner_actor_id IS NOT NULL
                                        ELSE owner_actor_id IS NULL END)
      );

      -- One handle namespace for humans AND agents: this index is what stops
      -- @harsh and @deploy-bot colliding regardless of type.
      CREATE UNIQUE INDEX actor_handle ON actors(workspace_id, handle);
    `,
  },
];
