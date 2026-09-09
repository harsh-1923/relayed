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
      --
      -- TWO SUBJECTS in one row — the workspace, and me in it — so every field
      -- says whose it is. That prefix is not decoration. While it was absent,
      -- an unqualified avatar_url -- the member's WorkOS picture -- was rendered
      -- as the workspace's icon, painting the same face on every entry in the
      -- switcher; and before that, a column named for a blob held a remote URL,
      -- which put a network fetch in the render path. Both were type-correct
      -- with passing tests, and only looking at the screen caught either.
      CREATE TABLE workspaces (
        workspace_id           TEXT PRIMARY KEY,
        org_id                 TEXT NOT NULL,
        name                   TEXT NOT NULL,
        slug                   TEXT NOT NULL,
        -- The workspace's own image, resolved server-side from the workspace or
        -- its organization. Null is ordinary and not degraded: the rail draws
        -- initials on a colour derived from the id.
        workspace_avatar_url   TEXT,
        -- sha256 of bytes we actually hold. The URL above is where they came
        -- from; this is what the renderer may load (DESIGN.md §13.3).
        workspace_avatar_blob  TEXT,

        actor_id               TEXT NOT NULL,
        -- My handle HERE. Differs per workspace by design: @harsh in one,
        -- @harsh.s in another where the first was taken
        -- (PHASE-1-IDENTITY.md §10).
        actor_handle           TEXT NOT NULL,
        actor_display_name     TEXT NOT NULL,
        actor_avatar_url       TEXT,
        actor_avatar_blob      TEXT,
        -- My role here — the grant the client's can() reads (AUTHZ.md §3).
        -- A projection, never the authority: the client may HIDE an action it
        -- believes is denied and may never permit one (invariant 49). Defaulted
        -- to the LEAST privilege so an unfilled row grants nothing.
        actor_role             TEXT NOT NULL DEFAULT 'member',

        last_opened_at         INTEGER,

        -- Reserved for cross-workspace activity (STORAGE.md §16.2). The socket
        -- is Phase 2; the columns ship now so arriving hints need no migration.
        unread_hint            INTEGER NOT NULL DEFAULT 0,
        mention_hint           INTEGER NOT NULL DEFAULT 0,
        -- Written when a replica is closed, so parked writes are findable
        -- without opening every replica (§15.2).
        outbox_hint            INTEGER NOT NULL DEFAULT 0,

        state                  TEXT NOT NULL,
        CHECK (state IN ('active','removed')),
        CHECK (actor_role IN ('owner','admin','member'))
      );

      -- Actor ids are how a sign-in is matched back to an existing account
      -- directory (§5): no WorkOS identifier is ever written to disk.
      CREATE UNIQUE INDEX workspace_actor ON workspaces(actor_id);
    `,
  },
];
