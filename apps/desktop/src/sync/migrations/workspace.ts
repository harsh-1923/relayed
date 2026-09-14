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
  {
    version: 2,
    name: 'sync',
    up: `
      -- Phase 2 step A, replica half (PHASE-2-SYNC.md §3). The client's side of
      -- DESIGN.md §8.3.
      --
      -- What this deliberately does NOT create: reactions and the FTS table
      -- (Phase 4), the blobs metadata table (Phase 7 — the store is
      -- content-addressed on the filesystem today and needs no rows), and
      -- drafts (added with the composer in version 7). A table with no writer
      -- has unverified constraints, and FTS's trigger-ordering trap
      -- cannot be exercised until messages actually flow. The replica is a
      -- replica: a later version adds them at no cost.

      -- ─── Spaces ────────────────────────────────────────────────────────────
      -- One table discriminated by kind, mirroring the server (DESIGN.md §7.1).
      -- No org_id: a replica holds exactly one workspace, so the column would
      -- be the same value on every row. Same reasoning as actors above.
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

        -- The explicit IS NOT NULL is load-bearing in both of these. A CHECK
        -- rejects a row only when it evaluates to FALSE, and NULL IN (...) is
        -- NULL — so the natural spelling silently permits exactly the row it
        -- forbids (DESIGN.md §13.5). Asserted per constraint in the test, on
        -- both engines, because this replica and the server hold the same rule.
        CHECK (CASE WHEN kind IN ('dm','group_dm')
                    THEN visibility IS NULL
                    ELSE visibility IS NOT NULL
                         AND visibility IN ('public','private') END),
        CHECK (CASE WHEN kind IN ('dm','group_dm') THEN 1
                                                   ELSE name IS NOT NULL END)
      );
      CREATE INDEX space_workspace ON spaces(workspace_id, kind);
      CREATE UNIQUE INDEX space_slug ON spaces(workspace_id, slug) WHERE slug IS NOT NULL;

      -- ─── Chats: the universal message container ────────────────────────────
      -- No next_ord/next_rev here. Allocation is the server's alone — a client
      -- that could mint an ordinal would be a second authority over order,
      -- which is the whole thing a server-ordered log exists to avoid.
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

      -- ─── Membership (DESIGN.md §7.3) ───────────────────────────────────────
      -- scope_type='chat' rows exist ONLY for private chats; every other chat
      -- derives access from its space. Space membership is the leading conjunct
      -- of the access predicate, which is what makes "who can see this" have
      -- exactly one answer.
      CREATE TABLE memberships (
        scope_type TEXT    NOT NULL,
        scope_id   TEXT    NOT NULL,
        actor_id   TEXT    NOT NULL,
        role       TEXT    NOT NULL,
        joined_at  INTEGER NOT NULL,
        -- Set on removal; the row is KEPT. Removal freezes the local copy
        -- rather than recalling it (DESIGN.md §6.6), and re-adding is then
        -- exactly a gap rather than a special case.
        left_at    INTEGER,
        PRIMARY KEY (scope_type, scope_id, actor_id),
        CHECK (scope_type IN ('space','chat'))
      );
      CREATE INDEX membership_actor ON memberships(actor_id) WHERE left_at IS NULL;

      -- ─── Messages ──────────────────────────────────────────────────────────
      -- No foreign keys on author_id, deliberately. A message may arrive before
      -- the actor who wrote it has replicated — the directory and the log are
      -- separate streams — and an FK would reject the message rather than
      -- render an unknown author. chats.space_id above IS a real key, because
      -- both sides of that pair arrive together in 'welcome'.
      CREATE TABLE messages (
        id          TEXT PRIMARY KEY,   -- ULID, CLIENT-generated (§10.1)
        chat_id     TEXT NOT NULL,
        parent_id   TEXT,               -- NULL = top-level; else the thread root
        -- NULL while pending: the server has not assigned one yet. This is the
        -- difference from the server's schema, where ord is NOT NULL — and the
        -- reason the unique index below is partial.
        ord         INTEGER,
        rev         INTEGER,
        author_id   TEXT NOT NULL,
        body        TEXT NOT NULL,
        -- Server time on ack; client time while pending, and overwritten by the
        -- server's value when the ack lands (§13.7).
        created_at  INTEGER NOT NULL,
        edited_at   INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        state       TEXT    NOT NULL DEFAULT 'pending',
        local_only  INTEGER NOT NULL DEFAULT 0,

        on_behalf_of_actor_id TEXT,
        delegation_id         TEXT,

        CHECK (state IN ('pending','acked','failed'))
      );

      -- Partial, because a pending message has no ordinal yet and several may
      -- be pending at once. The server's equivalent is unconditional.
      CREATE UNIQUE INDEX msg_ord ON messages(chat_id, ord) WHERE ord IS NOT NULL;

      -- The chat view must skip thread replies WITHOUT scanning past them: a
      -- thread with 800 replies would otherwise make "last 50 chat messages"
      -- read 800 rows it discards.
      CREATE INDEX msg_chat_view ON messages(chat_id, ord DESC) WHERE parent_id IS NULL;
      CREATE INDEX msg_thread ON messages(parent_id, ord) WHERE parent_id IS NOT NULL;
      CREATE INDEX msg_pending ON messages(chat_id, created_at) WHERE state = 'pending';

      -- ─── Per-chat sync state (DESIGN.md §8.1) ──────────────────────────────
      CREATE TABLE chat_state (
        chat_id            TEXT PRIMARY KEY,

        -- The two watermarks, and they are different facts. "I have everything
        -- up to here, contiguously" is not "the server says this much exists",
        -- and keeping them apart is what makes R2 cheap: a badge can be correct
        -- for a chat holding no messages at all.
        synced_through_rev INTEGER NOT NULL DEFAULT 0,
        server_head_rev    INTEGER NOT NULL DEFAULT 0,

        head_ord           INTEGER NOT NULL DEFAULT 0,
        -- A MAX-register, never LWW (DESIGN.md §4). A device asleep for an hour
        -- would otherwise un-read a chat when it syncs.
        last_read_ord      INTEGER NOT NULL DEFAULT 0,
        -- The backfill floor and the eviction mark. Without it, eviction is
        -- indistinguishable from data loss to the person looking at it.
        oldest_local_ord   INTEGER,

        chat_unread        INTEGER NOT NULL DEFAULT 0,
        thread_unread      INTEGER NOT NULL DEFAULT 0,
        mention_count      INTEGER NOT NULL DEFAULT 0,

        has_gap            INTEGER NOT NULL DEFAULT 0,
        muted              INTEGER NOT NULL DEFAULT 0,
        last_activity_at   INTEGER
      );

      -- ─── Revs above the contiguous frontier ────────────────────────────────
      -- Required because "have I received rev N?" is NOT derivable from the
      -- message rows (DESIGN.md §8.1): an edit overwrites the rev it replaced,
      -- and a delete for a message this client never held writes nothing at all
      -- — so MAX(rev) under-reports and the cursor stalls behind a rev it
      -- actually received. Holds only revs ABOVE the frontier, so it collapses
      -- to empty whenever the client is caught up.
      CREATE TABLE pending_revs (
        chat_id TEXT    NOT NULL,
        rev     INTEGER NOT NULL,
        PRIMARY KEY (chat_id, rev)
      );

      -- ─── Outbox ────────────────────────────────────────────────────────────
      -- Lives HERE, in the workspace replica, transactional with the optimistic
      -- message it echoes (invariant 40). A crash between the row and the echo
      -- otherwise yields something that looks sent and never sends.
      CREATE TABLE outbox (
        op_id      TEXT PRIMARY KEY,   -- ULID; the server dedupes on this
        seq        INTEGER NOT NULL,   -- local monotonic; replay order
        kind       TEXT NOT NULL,
        chat_id    TEXT,
        target_id  TEXT,               -- the message id the op acts on
        payload    TEXT NOT NULL,      -- JSON
        created_at INTEGER NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        next_at    INTEGER NOT NULL DEFAULT 0,
        state      TEXT NOT NULL DEFAULT 'queued',
        error      TEXT,

        CHECK (state IN ('queued','inflight','failed')),
        -- Phase 2 sends and deletes. Edits and reactions widen this in Phase 4,
        -- deliberately rather than by having left it open.
        CHECK (kind IN ('send','delete','read'))
      );
      CREATE INDEX outbox_ready ON outbox(next_at) WHERE state = 'queued';
      -- Coalescing looks ops up by what they target, on every enqueue (§10.4).
      CREATE INDEX outbox_target ON outbox(target_id);
    `,
  },
  {
    version: 3,
    name: 'frontier',
    up: `
      -- The contiguity frontier, given one home and a memory.
      -- Step 8 of the sync build plan (docs/SYNC-FLOWS.md §2).

      -- ─── staged_events, replacing pending_revs ─────────────────────────────
      --
      -- The old table held (chat_id, rev) — "I saw rev N". That is not enough,
      -- and the failure is silent and permanent. Trace it (SYNC-FLOWS.md §11.1):
      --
      --   frontier 5. Message M was created at rev 7, which we do not hold.
      --   live: rev 9 = message.edited(M) → M absent → apply is a no-op
      --         pending_revs = {9}; frontier stays 5
      --   catchup(from 5) returns 6, 7, 8, 9
      --         apply 6 → 6;  apply 7 → M created → 7
      --         apply 8 → 8, then pending_revs has 9 → frontier jumps to 9
      --         apply 9 → rev 9 <= frontier 9 → DROPPED AS A DUPLICATE
      --
      -- The edit is gone, for good, with nothing to indicate it. Each rule is
      -- individually mandatory: duplicate suppression is required under
      -- at-least-once delivery, and recording the rev is what keeps the frontier
      -- moving past events with no local effect. TOGETHER they lose data.
      --
      -- Retaining the whole envelope is the fix: a staged event is APPLIED when
      -- the frontier reaches it, rather than merely counted.
      DROP TABLE pending_revs;

      CREATE TABLE staged_events (
        stream_kind TEXT    NOT NULL,
        stream_id   TEXT    NOT NULL,
        rev         INTEGER NOT NULL,
        event_type  TEXT    NOT NULL,
        -- The envelope, retained. JSON text rather than a shredded shape,
        -- because an event this client does not understand must survive being
        -- stored and replayed by one that does not know its fields.
        payload     TEXT    NOT NULL,
        PRIMARY KEY (stream_kind, stream_id, rev)
      );

      -- ─── stream_state: ONE home for every frontier ─────────────────────────
      --
      -- Chats had theirs in \`chat_state\`; spaces and the workspace directory had
      -- nowhere at all, which is why they could not be applied. Rather than add
      -- a second cursor table and a branch, every stream's cursor lives here.
      --
      -- The branch is what this is really buying away. The apply loop is where a
      -- silent permanent hole comes from, and "which table holds this stream's
      -- frontier" is a question it should never have to ask.
      CREATE TABLE stream_state (
        stream_kind        TEXT    NOT NULL,
        stream_id          TEXT    NOT NULL,

        -- "I hold every change up to here, CONTIGUOUSLY." Never advanced across
        -- a hole, and never advanced by being told a head exists (invariant 1).
        synced_through_rev INTEGER NOT NULL DEFAULT 0,
        -- "The server says this much exists." The difference between the two is
        -- exactly the catch-up that is owed.
        server_head_rev    INTEGER NOT NULL DEFAULT 0,
        -- Set when the frontier was jumped deliberately, past history that was
        -- never received. Backfill lowers the floor and eventually clears it.
        has_gap            INTEGER NOT NULL DEFAULT 0,

        PRIMARY KEY (stream_kind, stream_id)
      );

      -- Carry the chat cursors across. A replica that already synced keeps its
      -- place rather than re-fetching everything.
      INSERT INTO stream_state (stream_kind, stream_id, synced_through_rev,
                                server_head_rev, has_gap)
        SELECT 'chat', chat_id, synced_through_rev, server_head_rev, has_gap
          FROM chat_state;

      -- ─── chat_state, narrowed to what is CHAT-specific ─────────────────────
      --
      -- Ordinals, counters and read state — the things a stream that carries no
      -- messages has no use for. Rebuilt rather than altered: three columns
      -- leave, and a rebuild is one statement whose result is obvious where a
      -- sequence of drops is three chances to leave a stale column behind.
      CREATE TABLE chat_state_new (
        chat_id          TEXT PRIMARY KEY,
        head_ord         INTEGER NOT NULL DEFAULT 0,
        -- A MAX-register, never LWW (DESIGN.md §4). A device asleep for an hour
        -- would otherwise un-read a chat when it syncs.
        last_read_ord    INTEGER NOT NULL DEFAULT 0,
        -- The backfill floor and the eviction mark. Without it, eviction is
        -- indistinguishable from data loss to the person looking at it.
        oldest_local_ord INTEGER,

        chat_unread      INTEGER NOT NULL DEFAULT 0,
        thread_unread    INTEGER NOT NULL DEFAULT 0,
        mention_count    INTEGER NOT NULL DEFAULT 0,

        muted            INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER
      );
      INSERT INTO chat_state_new
        SELECT chat_id, head_ord, last_read_ord, oldest_local_ord,
               chat_unread, thread_unread, mention_count, muted, last_activity_at
          FROM chat_state;
      DROP TABLE chat_state;
      ALTER TABLE chat_state_new RENAME TO chat_state;
    `,
  },
  {
    version: 4,
    name: 'trace',
    up: `
      -- The trace an op belongs to, so a send survives a restart with its
      -- identity intact. Step 13 of the sync build plan.
      --
      -- WHY THE COLUMN EXISTS AT ALL. "Sending a message" begins when somebody
      -- presses return and ends when an ack comes back, and between those two
      -- moments the app may be closed for a week — the outbox is durable
      -- precisely so that is survivable. An in-memory span cannot bridge it, so
      -- the trace context is stored beside the op it belongs to. Without this,
      -- every message sent offline arrives on the server as the root of its own
      -- trace and the compose end of the path is simply missing.
      --
      -- Nullable, and rows written before this migration stay null: an op with
      -- no trace is sent without a traceparent and the server starts a fresh
      -- trace, which is a missing link rather than an error (invariant 43's
      -- rule applied to telemetry).
      ALTER TABLE outbox ADD COLUMN traceparent TEXT;
    `,
  },
  {
    version: 5,
    name: 'stall',
    up: `
      -- Where the frontier stood at the previous sweep, so "stalled" can mean
      -- something across a reconnect. Step 13 of the sync build plan.
      --
      -- WHY IT CANNOT LIVE IN MEMORY, which is where it started. The catch-up
      -- scheduler is rebuilt per connection — deliberately, because its other
      -- state is "what have I asked for on THIS socket" — so a client that
      -- reconnects more often than it sweeps loses the comparison every time,
      -- and can be permanently stuck while reporting nothing. That is exactly
      -- the client the marker exists for: a laptop on a flaky connection is
      -- both the one most likely to stall and the one least likely to stay
      -- connected long enough to notice.
      --
      -- A stall is a property of the STREAM, not of the socket, so it belongs
      -- beside the frontier it is about.
      ALTER TABLE stream_state ADD COLUMN swept_at_rev INTEGER;
    `,
  },
  {
    version: 6,
    name: 'workspace-membership',
    up: `
      -- Let the replica hold a WORKSPACE membership, which it never could.
      --
      -- THE BUG, and it made the app useless rather than degraded. \`welcome\`
      -- has carried the caller's own memberships since step 7, and a workspace
      -- membership is among them — it is the LEADING conjunct of the access
      -- predicate (invariant 50), so it is the most important one rather than an
      -- unusual one. This table's CHECK was written in version 1, before any of
      -- that existed, and allowed only 'space' and 'chat'.
      --
      -- So every \`welcome\` threw \`CHECK constraint failed\` partway through its
      -- transaction. It rolled back — correctly — taking the spaces, the chats
      -- and every stream cursor with it, and the next statements in the handler
      -- never ran: no catch-up scheduler, no directory hydration, no drain. A
      -- signed-in client with a live socket and a completely empty replica,
      -- whose Directory screen said "sign in once while online".
      --
      -- WHY NOTHING CAUGHT IT. Both sides had tests and both passed, because
      -- each built its own fixtures: the server's welcome tests assert what it
      -- SENDS, the storage tests fed \`applyWelcome\` memberships they had
      -- written themselves — as 'space' rows, which the constraint allows. The
      -- same shape as the gap-snapshot casing bug: a seam where each side
      -- agreed with itself.
      --
      -- SQLite cannot alter a CHECK, so the table is rebuilt. Existing rows are
      -- all 'space' or 'chat' by construction and carry across unchanged.
      CREATE TABLE memberships_new (
        scope_type TEXT    NOT NULL,
        scope_id   TEXT    NOT NULL,
        actor_id   TEXT    NOT NULL,
        role       TEXT    NOT NULL,
        joined_at  INTEGER NOT NULL,
        left_at    INTEGER,
        PRIMARY KEY (scope_type, scope_id, actor_id),
        -- All three the server can produce (003_memberships.sql), and no more:
        -- a scope this client cannot reason about is a grant it must not honour.
        CHECK (scope_type IN ('workspace','space','chat'))
      );
      INSERT INTO memberships_new
        SELECT scope_type, scope_id, actor_id, role, joined_at, left_at
          FROM memberships;
      DROP TABLE memberships;
      ALTER TABLE memberships_new RENAME TO memberships;
      CREATE INDEX membership_actor ON memberships(actor_id) WHERE left_at IS NULL;
    `,
  },
  {
    version: 7,
    name: 'drafts',
    up: `
      -- Drafts are device-local workspace state. Markdown is the one authored
      -- representation; Tiptap is only the editing projection (COMPOSER.md,
      -- canonical body and drafts).
      CREATE TABLE drafts (
        chat_id     TEXT    NOT NULL,
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
    version: 8,
    name: 'drafts-repair',
    up: `
      -- Version 7 again, for replicas that never ran it. During development a
      -- different version 7 (adding messages.parts) was applied and later
      -- replaced by 'drafts' under the same number, so those replicas report
      -- version 7 with no drafts table — every draft read failed, and the
      -- composer waiting on it never appeared. IF NOT EXISTS makes this a no-op
      -- on every replica that is already right.
      CREATE TABLE IF NOT EXISTS drafts (
        chat_id     TEXT    NOT NULL,
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
    version: 9,
    name: 'gap-repair',
    up: `
      -- The gap path, corrected (SYNC-FLOWS.md, the repair flow; found by
      -- spikes/visibility-tests.mjs). A message's \`rev\` is its version and a
      -- fetched row applies only if it is not older than the one held; what a
      -- gap owes is recorded here so a quit mid-repair resumes rather than
      -- forgets.

      -- Undeleted replies, as the server counts them for this reader. Kept on
      -- the row so the chat view needs no join, and moved by live reply events
      -- between the fetches that reset it.
      ALTER TABLE messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;

      -- The repair owed after a gap: changes since this revision, to messages
      -- at or below this ordinal, paged by (rev, id). All NULL when none is.
      ALTER TABLE chat_state ADD COLUMN repair_since_rev INTEGER;
      ALTER TABLE chat_state ADD COLUMN repair_max_ord   INTEGER;
      ALTER TABLE chat_state ADD COLUMN repair_after_rev INTEGER;
      ALTER TABLE chat_state ADD COLUMN repair_after_id  TEXT;
    `,
  },
];
