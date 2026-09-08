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
  {
    version: 3,
    name: 'avatar-blob',
    // Both columns, deliberately. `avatar_url` is what the server said;
    // `avatar_blob` is the sha256 of the bytes we actually hold. Keeping the
    // source URL is what lets a changed avatar be noticed and re-fetched, and
    // what makes the blob re-derivable if the file is ever lost.
    up: `ALTER TABLE workspaces ADD COLUMN avatar_blob TEXT;`,
  },
  {
    version: 4,
    name: 'name-the-subject',
    // A membership row has TWO subjects: the workspace, and me in it. Nothing
    // in the old names said which was which, so `avatar_url` — the member's
    // WorkOS picture — got rendered as the workspace's icon, painting the same
    // face on every entry in the switcher.
    //
    // Same class of defect as v2's column named for a blob that held a URL, and
    // in both cases the code was type-correct and the tests passed. Names are
    // the only thing that would have caught either.
    up: `
      ALTER TABLE workspaces RENAME COLUMN handle       TO actor_handle;
      ALTER TABLE workspaces RENAME COLUMN display_name TO actor_display_name;
      ALTER TABLE workspaces RENAME COLUMN avatar_url   TO actor_avatar_url;
      ALTER TABLE workspaces RENAME COLUMN avatar_blob  TO actor_avatar_blob;

      -- The workspace's OWN image, resolved server-side from the workspace or
      -- its organization. Null is the ordinary case and renders as initials on
      -- a colour derived from the workspace id — no schema, and it cannot
      -- disagree between devices.
      ALTER TABLE workspaces ADD COLUMN workspace_avatar_url  TEXT;
      ALTER TABLE workspaces ADD COLUMN workspace_avatar_blob TEXT;
    `,
  },
];
