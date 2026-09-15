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
  {
    version: 2,
    name: 'preferences',
    up: `
      -- What the PERSON chose, as opposed to what the engine knows
      -- (PREFERENCES.md).
      --
      -- NOT in \`meta\`. That table holds engine-owned singletons — device_id,
      -- last_workspace, schema_origin — written by this process and meaningless
      -- to a user. Sharing one table makes "reset my settings" one careless
      -- DELETE away from discarding this install's device identity.
      --
      -- ROW PER KEY, not one JSON document, and the reason is the release model
      -- rather than ergonomics. A reinstall leaves userData intact and updates
      -- cannot be forced (RELEASE.md §6.1, §6.4), so two versions of this app
      -- read this file for months. Meeting a key it does not know, a client
      -- with one document read-modify-writes and DELETES it — silently, and for
      -- good. With a row per key it reads what it knows, writes what it knows,
      -- and leaves the rest alone. That is invariant 32's rule for unknown
      -- events, applied to settings.
      CREATE TABLE preferences (
        -- Dotted namespace: 'appearance.theme'. Dots and not colons, so a key
        -- is never mistaken for a topic; topic.pref() does that conversion.
        key        TEXT    PRIMARY KEY,

        -- JSON text, always — '"dark"' and not 'dark'. One codec covers every
        -- key that way, and a value that grows from a string into an object
        -- needs no column change. The CHECK below rejects the bare spelling,
        -- which is the single mistake the codec can make.
        value      TEXT    NOT NULL,

        -- How far this setting is ALLOWED to travel. Nothing syncs today and
        -- nothing reads this column yet; it ships now for the reason
        -- unread_hint did (STORAGE.md §16.2) — it must be on rows written
        -- BEFORE the feature exists, or the first release that syncs cannot
        -- interpret what it finds.
        --
        -- On the ROW and not only in the shared catalogue, because a client
        -- that does not recognise a key must still route it correctly.
        -- Otherwise the first sync-capable release silently skips every key a
        -- newer client introduced. Same argument as staged_events retaining the
        -- envelope rather than a shredded shape.
        --
        -- Defaulted to the LEAST travel, so a row written by something that
        -- forgot to set it goes nowhere.
        reach      TEXT    NOT NULL DEFAULT 'local',

        -- Local today; the per-key merge input when sync arrives.
        updated_at INTEGER NOT NULL,

        CHECK (json_valid(value)),
        -- The NOT NULL above is what rejects a null reach, and this CHECK is
        -- NOT a substitute for it: NULL IN (...) is NULL, a CHECK rejects only
        -- FALSE, so on its own this permits exactly the row it appears to
        -- forbid (DESIGN.md §13.5). Asserted in both spellings in
        -- account-schema.test.ts rather than trusted.
        CHECK (reach IN ('local','synced'))
      );

      -- No index, deliberately. The PRIMARY KEY serves point reads, and a
      -- missing row IS the default, so the table holds only what somebody
      -- actually changed — the scan behind a settings panel is a handful of
      -- rows.
    `,
  },
  {
    version: 3,
    name: 'cached-assets',
    up: `
      -- Remote catalogue metadata is useful only while online. Keep the bytes
      -- account-local, like avatars, and retain only the source-to-content
      -- address needed to avoid fetching the same immutable logo each time the
      -- connector store opens (STORAGE.md, blob placement §14).
      CREATE TABLE cached_assets (
        source_url  TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        blob_id     TEXT    NOT NULL,
        media_type  TEXT    NOT NULL,
        cached_at   INTEGER NOT NULL,

        PRIMARY KEY (source_url, kind),
        CHECK (kind IN ('toolkit_logo')),
        CHECK (length(blob_id) = 64 AND blob_id NOT GLOB '*[^0-9a-f]*'),
        CHECK (media_type IN (
          'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
          'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml'
        ))
      );
    `,
  },
];
