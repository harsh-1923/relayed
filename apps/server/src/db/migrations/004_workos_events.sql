-- A local mirror of what WorkOS knows, kept current by polling its Events API
-- (docs/AUTHZ.md §8, PHASE-1-IDENTITY.md §9).
--
-- Polled rather than pushed, deliberately. Webhooks are at-least-once,
-- unordered, and lost if the endpoint is down during delivery — so a
-- webhook-only design needs a reconciliation pass anyway and you build both.
-- A cursor over a durable log IS the consistency mechanism, and it is
-- replayable: rewind the cursor and the world is rebuilt. The same reason
-- `synced_through_rev` advances across contiguous runs rather than trusting
-- each event to arrive (DESIGN.md §8.1).

-- Where the poller has read up to. One row, forever.
CREATE TABLE workos_cursor (
  id          TEXT PRIMARY KEY,
  -- The last event id successfully APPLIED. Advanced in the same transaction
  -- as the effects, so a crash re-reads rather than skips: at-least-once, and
  -- every handler below is idempotent to make that safe.
  after_id    TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO workos_cursor (id, after_id) VALUES ('events', NULL);

-- What WorkOS says about org membership. NOT the authority on what anyone may
-- do — that is `memberships` (AUTHZ.md §8) — but the authority on who has been
-- ADMITTED, which is a question only WorkOS can answer because invitations are
-- accepted on its hosted page.
CREATE TABLE workos_memberships (
  workos_user_id  TEXT NOT NULL,
  workos_org_id   TEXT NOT NULL,
  -- Mirrored, never consulted at check time (invariant 52). Kept so a future
  -- SSO or SCIM role can be reconciled against ours rather than guessed at.
  role_slug       TEXT,
  status          TEXT NOT NULL,
  seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workos_user_id, workos_org_id)
);

CREATE INDEX workos_membership_user ON workos_memberships (workos_user_id)
  WHERE status = 'active';
