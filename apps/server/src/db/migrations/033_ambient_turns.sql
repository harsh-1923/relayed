-- Ambient answers judged per TURN — what one person said in a row — rather than
-- per quiet spell of the whole chat (docs/AMBIENT-RESPONSES.md, the loop §9.2).
-- Three things the per-turn flow needs that the watermark could not give it.
--
-- WHICH MESSAGES A LOOK HAS JUDGED. Turns interleave: Alice's turn may be judged
-- after Bob's although hers started first, so "the largest ord judged so far"
-- would skip hers. A look writes the messages it judged here, and a message is
-- unjudged until it appears.
CREATE TABLE ambient_judged (
  message_id   TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  decision_id  TEXT NOT NULL REFERENCES ambient_decisions(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ambient_judged_decision ON ambient_judged (decision_id);

-- ONE LOOK AT A TIME PER CHAT. The second of two turns due together must see
-- the first's answer, or the same question from two people gets two answers.
-- The claim is the insert; a second claim in the same chat fails here.
CREATE UNIQUE INDEX ambient_one_look ON ambient_decisions (chat_id) WHERE outcome = 'pending';

-- THE EXCHANGE A FOLLOW-UP CONTINUES: the agent message that started it — an
-- ambient answer, or a mention's reply. Follow-ups are counted per exchange
-- (three, then quiet).
ALTER TABLE ambient_decisions ADD COLUMN exchange_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX ambient_exchange ON ambient_decisions (exchange_message_id) WHERE exchange_message_id IS NOT NULL;

-- A follow-up to the asker's OWN mention is handed to a run, with their tools
-- (§4.2): a new ending, beside the ones a look can come to on its own.
ALTER TABLE ambient_decisions DROP CONSTRAINT ambient_outcome;
ALTER TABLE ambient_decisions ADD CONSTRAINT ambient_outcome CHECK (outcome IN
  ('pending', 'silent', 'declined', 'suppressed', 'gate_error', 'failed',
   'withdrawn', 'stale', 'shadow', 'posted', 'run'));
