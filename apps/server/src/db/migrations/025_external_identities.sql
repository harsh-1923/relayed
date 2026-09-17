-- Who a person is in a service they connected (docs/WORKSPACE-AGENTS.md §6):
-- their Linear user, their GitHub login. Learned from THEIR OWN session — a
-- Composio search answers for the account it is pinned to — and never by
-- spending anyone else's account.
--
-- For an agent assigning or mentioning someone in that service: without it,
-- the only way from a Relayed person to a Linear user was guessing by name, and
-- two people called Harsh sent a ticket to the wrong one.
--
-- No email, deliberately: what an agent needs is the service's id for the
-- person, and email is kept away from models (DESIGN.md §6.3).
CREATE TABLE external_identities (
  actor_id              TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  toolkit               TEXT NOT NULL,
  -- The account it was read from. A reconnect to a different account makes
  -- this row stale, and the next sighting replaces it.
  connected_account_id  TEXT NOT NULL,
  external_id           TEXT NOT NULL,
  name                  TEXT,
  username              TEXT,
  seen_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, toolkit)
);
