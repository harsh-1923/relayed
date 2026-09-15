-- A room's shared panels (docs/PANELS.md §3.2): the surfaces people in a room
-- work beside the conversation — a ticket, a dashboard, a document.
--
-- Built first for what an agent opens for the room (a web page, today), so
-- only `web` is written yet. The other types are reserved in the CHECK now,
-- because adding a value to a CHECK later is a table rebuild on the replica.
CREATE TABLE panels (
  -- pnl_…, a ULID.
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id               TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  type                   TEXT NOT NULL,
  -- A chat panel's chat, reserved: nothing writes one yet.
  chat_id                TEXT REFERENCES chats(id) ON DELETE CASCADE,
  -- Everything else a type needs. A web panel's is { "url": "https://…" }.
  payload                JSONB NOT NULL DEFAULT '{}',
  title                  TEXT,
  -- Where it came from, and who: for drawing "opened by @triage for Alice".
  -- Neither grants anything.
  opened_from_chat_id    TEXT REFERENCES chats(id)  ON DELETE SET NULL,
  created_by_actor_id    TEXT REFERENCES actors(id) ON DELETE SET NULL,
  on_behalf_of_actor_id  TEXT REFERENCES actors(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Moved forward each time the same page is opened again, so the room brings
  -- it forward rather than holding two of it; "the most recent panel" — what
  -- someone entering the room is shown — is the highest of these.
  opened_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A tombstone, like messages and memberships. Nothing sets it yet.
  removed_at             TIMESTAMPTZ,

  CONSTRAINT panel_type CHECK (type IN ('chat', 'web', 'diff', 'file', 'attachment')),
  -- chat_id exactly when type='chat'; the explicit IS NULL is load-bearing,
  -- as for space_visibility (DESIGN.md §13.5).
  CONSTRAINT panel_chat_ref CHECK (
    CASE WHEN type = 'chat' THEN chat_id IS NOT NULL ELSE chat_id IS NULL END)
);

CREATE INDEX panel_space ON panels (space_id, opened_at DESC) WHERE removed_at IS NULL;

-- One live panel per page per room: opening the same URL again brings the
-- existing panel forward instead of adding a second tab for everyone.
CREATE UNIQUE INDEX panel_web_url ON panels (space_id, (payload->>'url'))
  WHERE type = 'web' AND removed_at IS NULL;
