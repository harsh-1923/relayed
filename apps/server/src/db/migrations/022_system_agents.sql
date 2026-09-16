-- Agents the app provisions, not a person (docs/DOCUMENTS.md §9.1).
--
-- Relay and Relay Roomkeeping are ordinary actors — that is what makes them
-- mentionable and visible in the directory like anything else — but two rules
-- written for people-made agents do not fit them, and both are relaxed here
-- rather than worked around in code.
--
-- 1. `provisioned_by` gains 'system'. The existing values all name a way a
--    HUMAN arrived; these arrived because the server started.
-- 2. `actor_owner` required an owner for every agent. Relay has none: it is the
--    root of the ownership chain, and every system agent after it is owned by
--    Relay (which is why the exemption is for `provisioned_by = 'system'` and
--    not for agents generally — a column that is null wherever it matters has
--    stopped meaning anything).
--
-- Ownership here records provenance and nothing else. That system agents cannot
-- be edited or deactivated is a SEPARATE rule enforced in the agent routes
-- (§9.2), because owner is an edit grant elsewhere and inheriting it through
-- Relay would let any member edit Roomkeeping by asking Relay to.

ALTER TABLE actors DROP CONSTRAINT actor_prov;
ALTER TABLE actors ADD  CONSTRAINT actor_prov
  CHECK (provisioned_by IN ('self_signup','invite','sso_jit','scim','api','system'));

ALTER TABLE actors DROP CONSTRAINT actor_owner;
ALTER TABLE actors ADD  CONSTRAINT actor_owner CHECK (
  CASE WHEN type = 'agent' THEN owner_actor_id IS NOT NULL OR provisioned_by = 'system'
                           ELSE owner_actor_id IS NULL END);
