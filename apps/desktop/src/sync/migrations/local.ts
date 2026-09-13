import type { Migration } from '../migrate.ts';

/**
 * `local-rooms.db` — one per account, beside `account.db` (LOCAL-ROOMS.md §4, §6).
 *
 * NOT A REPLICA. It is the only copy of every local room: nothing evicts it,
 * nothing rebuilds it, and only a person deletes it. The room tables are the
 * replica's, column for column (migrations/workspace.ts, versions 2 and 7), so
 * one room view reads either store without a translation layer. Where they
 * differ, the difference is named at the column.
 */
export const localMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'local-rooms',
    up: `
      -- ─── Copied from the replica ───────────────────────────────────────────
      -- workspace_id holds the constant 'local' until a publish fills in a real
      -- one; it is here because the columns are copied, not because it varies.

      CREATE TABLE actors (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        type           TEXT NOT NULL,
        handle         TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        avatar_url     TEXT,
        avatar_blob    TEXT,
        owner_actor_id TEXT,
        state          TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,
        CHECK (type IN ('human','agent')),
        CHECK (state IN ('invited','active','suspended','deactivated')),
        CHECK (CASE WHEN type = 'agent' THEN owner_actor_id IS NOT NULL
                                        ELSE owner_actor_id IS NULL END)
      );
      CREATE UNIQUE INDEX actor_handle ON actors(workspace_id, handle);

      -- The only two actors a local room can hold: the person and their agent.
      -- Fixed ids, mapped to real actors in a workspace when a room is published
      -- (§12.5).
      INSERT INTO actors VALUES
        ('act_local_me',    'local', 'human', 'me',    'You',          NULL, NULL, NULL,           'active', 0),
        ('act_local_agent', 'local', 'agent', 'agent', 'Claude Agent', NULL, NULL, 'act_local_me', 'active', 0);

      CREATE TABLE spaces (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        kind                TEXT NOT NULL,
        name                TEXT,
        slug                TEXT,
        topic               TEXT,
        visibility          TEXT,
        membership_policy   TEXT NOT NULL,
        lifecycle           TEXT NOT NULL DEFAULT 'active',
        created_by_actor_id TEXT,
        last_activity_at    INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        CHECK (kind IN ('channel','dm','group_dm','room')),
        CHECK (membership_policy IN ('open','invite','sealed')),
        CHECK (lifecycle IN ('active','dormant','archived')),
        CHECK (kind NOT IN ('dm','group_dm') OR membership_policy = 'sealed'),
        CHECK (kind NOT IN ('dm','group_dm') OR lifecycle <> 'archived'),
        CHECK (CASE WHEN kind IN ('dm','group_dm')
                    THEN visibility IS NULL
                    ELSE visibility IS NOT NULL
                         AND visibility IN ('public','private') END),
        CHECK (CASE WHEN kind IN ('dm','group_dm') THEN 1
                                                   ELSE name IS NOT NULL END)
      );
      CREATE INDEX space_workspace ON spaces(workspace_id, kind);

      CREATE TABLE chats (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        space_id            TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        kind                TEXT NOT NULL,
        name                TEXT,
        created_by_actor_id TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        CHECK (kind IN ('sole','default','public','private'))
      );
      CREATE INDEX chat_space ON chats(space_id);
      CREATE UNIQUE INDEX chat_singleton ON chats(space_id)
        WHERE kind IN ('sole','default');

      CREATE TABLE memberships (
        scope_type TEXT    NOT NULL,
        scope_id   TEXT    NOT NULL,
        actor_id   TEXT    NOT NULL,
        role       TEXT    NOT NULL,
        joined_at  INTEGER NOT NULL,
        left_at    INTEGER,
        PRIMARY KEY (scope_type, scope_id, actor_id),
        CHECK (scope_type IN ('space','chat'))
      );

      CREATE TABLE messages (
        id          TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        parent_id   TEXT,
        -- NOT NULL, unlike the replica: there is no "pending" in a local room.
        -- The sync engine assigns the ordinal on insert, and it is never reused.
        ord         INTEGER NOT NULL,
        rev         INTEGER,
        author_id   TEXT NOT NULL,
        body        TEXT NOT NULL,
        parts       TEXT,
        created_at  INTEGER NOT NULL,
        edited_at   INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        -- 'streaming' in place of 'pending': the row Claude is still writing (§8.3).
        state       TEXT    NOT NULL DEFAULT 'acked',
        local_only  INTEGER NOT NULL DEFAULT 1,
        on_behalf_of_actor_id TEXT,
        delegation_id         TEXT,
        CHECK (state IN ('streaming','acked','failed'))
      );
      CREATE UNIQUE INDEX msg_ord ON messages(chat_id, ord);
      CREATE INDEX msg_chat_view ON messages(chat_id, ord DESC) WHERE parent_id IS NULL;
      CREATE INDEX msg_streaming ON messages(chat_id) WHERE state = 'streaming';

      -- ─── Local only ────────────────────────────────────────────────────────

      -- What makes a space a LOCAL room: the directory, and how Claude may act in it.
      CREATE TABLE local_rooms (
        space_id      TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
        cwd           TEXT NOT NULL,
        mode          TEXT NOT NULL DEFAULT 'accept-edits',
        publish_state TEXT NOT NULL DEFAULT 'local',
        workspace_id  TEXT,
        published_at  INTEGER,
        CHECK (mode IN ('supervised','accept-edits','auto','full-access')),
        CHECK (publish_state IN ('local','publishing','published','publish_failed'))
      );

      -- One Claude Code session per chat (§8.1): the resume cursor.
      CREATE TABLE chat_sessions (
        chat_id     TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        session_id  TEXT,
        turn_count  INTEGER NOT NULL DEFAULT 0,
        forked_from TEXT,
        updated_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'drafts',
    up: `
      CREATE TABLE drafts (
        chat_id     TEXT    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        draft_kind  TEXT    NOT NULL DEFAULT 'compose',
        context_key TEXT    NOT NULL DEFAULT 'root',
        body        TEXT    NOT NULL,
        revision    INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (chat_id, draft_kind, context_key),
        CHECK (draft_kind IN ('compose','edit')),
        CHECK (revision >= 1)
      );
    `,
  },
  {
    version: 3,
    name: 'rooms-default-to-auto',
    // New rooms are written with DEFAULT_ROOM_MODE by the store; the column
    // default from version 1 is left alone rather than rebuilding the table.
    // Rooms still on the old default move too: nobody could have chosen it,
    // there is no mode picker yet.
    up: `
      UPDATE local_rooms SET mode = 'auto' WHERE mode = 'accept-edits';
    `,
  },
  {
    version: 4,
    name: 'approvals',
    // What a paused turn is waiting on the person for (LOCAL-ROOMS.md §8.5).
    // Only ever as old as the Claude Code child that asked: the store empties it
    // on open, and the sync engine when the runner goes away. `payload` is the
    // whole PendingApproval (shared/claude.ts), which only this app reads.
    up: `
      CREATE TABLE approvals (
        id          TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        CHECK (kind IN ('tool','question','plan'))
      );
      CREATE INDEX approvals_by_chat ON approvals (chat_id, created_at);
    `,
  },
  {
    version: 5,
    name: 'room-model',
    // NULL is "the default": DEFAULT_ROOM_MODEL for the model, the model's own
    // for effort. Validated by the ops, not here, because the list of models is
    // Claude Code's and changes under us.
    up: `
      ALTER TABLE local_rooms ADD COLUMN model TEXT;
      ALTER TABLE local_rooms ADD COLUMN effort TEXT;
    `,
  },
  {
    version: 6,
    name: 'panels',
    // Surfaces open beside a room's main chat (PANELS.md §3).
    up: `
      -- What a synced room will hold, column for column: chat panels, and
      -- content panels once shared. One table discriminated by type, as spaces
      -- are by kind. diff, file and attachment are reserved now because SQLite
      -- cannot alter a CHECK (see workspace.ts version 6).
      CREATE TABLE panels (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        space_id            TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        type                TEXT NOT NULL,
        chat_id             TEXT REFERENCES chats(id) ON DELETE CASCADE,
        payload             TEXT NOT NULL DEFAULT '{}',
        title               TEXT,
        opened_from_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        created_by_actor_id TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        removed_at          INTEGER,
        CHECK (type IN ('chat','web','diff','file','attachment')),
        -- The explicit IS NOT NULL / IS NULL is load-bearing (DESIGN.md §13.5).
        CHECK (CASE WHEN type = 'chat' THEN chat_id IS NOT NULL
                                       ELSE chat_id IS NULL END)
      );
      CREATE INDEX panel_space ON panels(space_id) WHERE removed_at IS NULL;
      CREATE UNIQUE INDEX panel_chat ON panels(chat_id) WHERE type = 'chat';

      -- Content panels that exist only on this device (PANELS.md §3.4). Never
      -- a chat panel: chats always sync. No foreign keys, because a synced
      -- room's space is in the workspace replica, another file.
      CREATE TABLE local_panels (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT,
        space_id            TEXT NOT NULL,
        type                TEXT NOT NULL,
        payload             TEXT NOT NULL DEFAULT '{}',
        title               TEXT,
        opened_from_chat_id TEXT,
        share_op_id         TEXT,
        created_at          INTEGER NOT NULL,
        last_opened_at      INTEGER NOT NULL,
        CHECK (type IN ('web','diff','file','attachment'))
      );
      CREATE INDEX local_panel_space ON local_panels(space_id, last_opened_at DESC);

      -- Every non-default chat already here gets its panel (§4.1).
      INSERT INTO panels (id, workspace_id, space_id, type, chat_id, created_by_actor_id, created_at, updated_at)
        SELECT 'pnl_' || upper(hex(randomblob(16))), workspace_id, space_id, 'chat', id, created_by_actor_id, created_at, updated_at
          FROM chats WHERE kind IN ('public','private');
    `,
  },
];
