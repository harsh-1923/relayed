-- Where an org's domain came from (docs/ORG-DOMAINS.md §11).
--
--   app     approved by an org admin in Relayed — shared, never exclusive
--   workos  verified on the org in WorkOS, by us in its dashboard or by the
--           customer's IT through its Admin Portal. WorkOS then adds every
--           matching sign-in to the org by itself; this row is our copy of
--           that, so Relayed can show it and never contradict it. Only WorkOS
--           can remove it.
ALTER TABLE organization_domains ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE organization_domains ADD CONSTRAINT organization_domain_source
  CHECK (source IN ('app', 'workos'));
-- A domain from WorkOS is verified by definition; an app approval never is.
ALTER TABLE organization_domains ADD CONSTRAINT organization_domain_workos_verified
  CHECK ((source = 'workos') = (verified_at IS NOT NULL));
