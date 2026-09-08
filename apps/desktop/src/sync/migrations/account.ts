import type { Migration } from '../migrate.ts';

/**
 * `account.db` — one per signed-in account (STORAGE.md §6).
 *
 * Holds what must be readable BEFORE a workspace replica is opened and before
 * any network call: which workspaces this account has, which was last open, and
 * this install's device identity. That is what lets the switcher render offline
 * on a cold boot (§11).
 *
 * Deliberately NOT here: anything per-chat. Cursors, messages and the outbox
 * live in the workspace replica and never cross (§7).
 */
export const accountMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'account',
    up: `
      CREATE TABLE meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );

      -- The membership index. A local cache of the memberships array from
      -- /auth/session, denormalised with MY actor in each workspace so the
      -- switcher can draw a row without opening a replica.
      CREATE TABLE workspaces (
        workspace_id   TEXT PRIMARY KEY,
        org_id         TEXT NOT NULL,
        name           TEXT NOT NULL,
        slug           TEXT NOT NULL,

        actor_id       TEXT NOT NULL,
        -- My handle HERE. Differs per workspace by design: @harsh in one,
        -- @harsh.s in another where the first was taken
        -- (PHASE-1-IDENTITY.md §10).
        handle         TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        avatar_blob    TEXT,   -- renamed in v2; see below

        last_opened_at INTEGER,

        -- Reserved for cross-workspace activity (STORAGE.md §16.2). The socket
        -- is Phase 2; the columns ship now so arriving hints need no migration.
        unread_hint    INTEGER NOT NULL DEFAULT 0,
        mention_hint   INTEGER NOT NULL DEFAULT 0,
        -- Written when a replica is closed, so parked writes are findable
        -- without opening every replica (§15.2).
        outbox_hint    INTEGER NOT NULL DEFAULT 0,

        state          TEXT NOT NULL,
        CHECK (state IN ('active','removed'))
      );

      -- Actor ids are how a sign-in is matched back to an existing account
      -- directory (§5): no WorkOS identifier is ever written to disk.
      CREATE UNIQUE INDEX workspace_actor ON workspaces(actor_id);
    `,
  },
  {
    version: 2,
    name: 'avatar-url',
    // The column held a remote https://workoscdn.com/... URL, which is what the
    // server returns. A name promising a local blob id would have put a network
    // fetch in the render path and left avatars blank offline — the opposite of
    // what §13.3 specifies. Renamed to say what it holds; fetching it into the
    // blob store is Phase 2 work, and this is the column that will feed it.
    up: `ALTER TABLE workspaces RENAME COLUMN avatar_blob TO avatar_url;`,
  },
];
