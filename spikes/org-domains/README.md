# Spike: organizations and company domains

Does [`docs/ORG-DOMAINS.md`](../../docs/ORG-DOMAINS.md) hold up against the code?

```
pnpm services
node --env-file=.env spikes/org-domains/run.ts
```

Runs the **real** server functions — `createWorkspace`, `joinWorkspace`,
`pendingJoins`, `seedWorkspace`, `send`, the WorkOS poller, `catchup`, `welcome`,
`loadGrants`, and `/auth/refresh` through Fastify — against a throwaway database,
`relayed_spike_org_domains`, built from migrations 001–033 plus
[`034_org_domains.sql`](034_org_domains.sql). WorkOS is the only fake: `fetch` is
an in-memory WorkOS that also emits the events the poller reads. The database is
recreated each run and left behind for inspection; the dev database is untouched.

The draft migration lives here rather than in `apps/server/src/db/migrations`
because a running `pnpm dev` applies anything saved there immediately.

## Result (2026-09-26): 15 pass, 12 findings, 0 failures

| # | Check | Result |
|---|---|---|
| 1.1 | §12's `actor_prov` rewrite, as written | **Finding** — drops `'system'` (022); fails on every workspace's system agents |
| 1.2–1.4 | Corrected 034 applies; backfill; `provisioned_by = 'domain'` | Pass |
| 2.1 | Several workspaces per org: memberships, streams kept apart | Pass |
| 2.2 | `pendingJoins` hides `invite_only` workspaces | **Finding** — offers every workspace in the org |
| 2.3 | `joinWorkspace` refuses `invite_only` | **Finding** — any org member can join any workspace |
| 2.4 | An invitation names its workspace | **Finding** — WorkOS invitations are org-level |
| 3.1–3.3 | Shared approval, exclusive verification, approval rules | Pass |
| 3.4 | `fetchProfile` exposes `email_verified` | **Finding** — expected, already in the build plan |
| 4.1 | Domain join through today's `joinWorkspace` | **Finding** — works, but the membership mirror lags one poll |
| 5.1 | Org role as a `memberships` row keyed by actor | Pass — ruled out, as the doc says |
| 5.2 | `org_roles` vs "admin of the default workspace" | Pass — identical on every scenario |
| 5.3 | Org membership stored once | **Finding** — `org_roles` duplicates `workos_memberships` and had drifted after two joins |
| 5.4 | An org always has an admin | Pass for the derived option; `org_roles` needs a guard |
| 6.1 | A claim moves every table referencing `organizations` | **Finding** — misses `spaces.org_id` |
| 6.2 | The claim as §11.3 is written | **Finding** — silent loss of every space and message, by cascade |
| 6.3 | Claim when the workspace slug is taken | **Finding** — `UNIQUE (org_id, slug)` refuses it |
| 6.4 | WorkOS-first ordering (§11.3) | **Finding** — the poller deactivates the person being moved |
| 6.5 | Corrected claim | Pass — nobody deactivated, no org_id drift |
| 6.6 | Sync across a claim | Pass — `welcome` and catch-up on workspace, space and chat streams are identical |
| 6.7 | `/auth/refresh` after a claim | Pass — new org in the token, same workspace |
| 6.8 | A pre-claim access token | Pass — names a deleted org, harmless while nothing reads `orgId` |
| 6.9 | A claimed workspace keeps its icon | **Finding** — it inherits the new org's |
| 7.1 | Removal from the org | Pass — deactivated in every workspace of the org |
