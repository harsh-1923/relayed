-- Feedback a person gave on something an agent said (docs/AMBIENT-RESPONSES.md,
-- signals §10.2). Today the only kind is `not_helpful`, from "Not helpful here"
-- on an unprompted answer — but nothing here is about ambient answers, so any
-- agent message can be given feedback the same way later.
--
-- SERVER-ONLY, NEVER SYNCED, AND READ BY NOTHING YET. It is a record for people
-- to learn what is not landing; no threshold, backoff or prompt reads it.
-- Which chat and which agent are the message's own, not copied here.
CREATE TABLE agent_feedback (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- Who gave it.
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT agent_feedback_kind CHECK (kind IN ('not_helpful')),
  -- Pressing twice is one piece of feedback; the first is kept.
  PRIMARY KEY (message_id, actor_id, kind)
);
