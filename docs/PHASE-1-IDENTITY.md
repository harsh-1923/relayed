# Phase 1 — Identity

Tenancy, human sign-in, and the actor model. Carries the identity nuances from
[`DESIGN.md`](DESIGN.md) §6 and §13.1 into an actionable phase, scoped down to
social login.

Architecture of record is [`DESIGN.md`](DESIGN.md); the phase sequence is §15.

**Last updated:** 2026-09-08 · client half built and working against WorkOS staging

---

## 1. Goal

**A human can sign in with a social provider, land in a workspace, and have an
actor record — and the sync socket can authenticate.**

Nothing about the sync protocol works until this exists: the WebSocket carries an
access token in `hello`, and every message needs an `author_id` pointing at an
actor. That is why identity comes before the sync core rather than after.

## 2. Scope

### In

- **Social login only** — Google, GitHub, Microsoft, via WorkOS AuthKit
- System-browser OAuth with PKCE and the `relayed://` callback
- Token storage in `safeStorage`; the in-band `reauth` refresh path (§9.7)
- `actors` table, org/workspace scoping, the handle namespace
- The two-session model and boot-from-local ordering
- Invite-based org membership

### Explicitly out

| Deferred | Why it is safe to defer |
|---|---|
| **SSO / SAML / OIDC connections** | AuthKit adds these without changing our schema — an SSO user is still a WorkOS `User` with an `OrganizationMembership`. |
| **Directory Sync (SCIM)** | Adds a provisioning source and a deactivation trigger. `provisioned_by` and the actor state machine already have room. |
| **MFA** | An AuthKit setting, not a schema concern. |
| **Agent identity** (M2M, delegation) | Phase 6. `identity_kind` is polymorphic from day one so agents slot in without a migration. |
| **Multi-workspace UI** | §6.1 — schema carries `workspace_id`, v1 ships one workspace per org. |

### What "social login only" actually changes

Less than expected in the schema, and one thing a lot in the product.

**The system-browser requirement gets *stronger*, not weaker.** The RFC 8252
argument in §13.1 was framed around enterprise SSO, but Google and Microsoft
refuse OAuth inside embedded webviews **for consumer accounts too**. Social login
in a `BrowserWindow` fails immediately, not eventually. §13.1's flow is
unchanged and non-negotiable.

**Social login verifies an email, not an organizational relationship.** This is
the important one. SSO tells you *this person belongs to this company*, because
the company's IdP said so. Google OAuth tells you only *this person controls this
mailbox*.

So domain-based auto-join is unsafe here: `@gmail.com` is not an organization,
and even a real company domain proves nothing without a verified connection.
**Org membership in Phase 1 must be invite-based.** Domain auto-join becomes
reasonable once SSO exists and the domain is verified — which is a good reason to
keep the invite path as the primary one rather than a stopgap.

**Provisioning collapses.** `provisioned_by ∈ ('self_signup', 'invite')` for now,
with `'sso_jit'` and `'scim'` reserved. Deactivation is manual rather than
IdP-driven, but the state machine and the tombstone rule are identical.

---

## 3. Tenancy

```
Organization                 ← WorkOS Organization
  └── Workspace              ← ours; WorkOS has no such concept
       ├── Channels
       └── Rooms → Chats
```

**v1 ships exactly one workspace per organization, and the client is
single-workspace** (§6.1). The schema carries `workspace_id` anyway, because
adding the layer later is a migration and carrying an unused column is free.

The reason not to *use* it yet is specific to local-first: **the workspace is the
natural sync boundary — one workspace = one SQLite file = one cursor space.**
Multi-workspace means N sync engines and N databases, or `workspace_id` threaded
through every cursor, query and catch-up path.

That also fixes the unit of local storage: **one database file per
`(account, workspace)` pair.**

## 4. What WorkOS owns

| Concept | WorkOS | Owner |
|---|---|---|
| Organization | `Organization` | **WorkOS** |
| Account, one per email | `User` — email unique per environment | **WorkOS** |
| Org membership + role | `OrganizationMembership` (many-to-many, `role_slug`) | **WorkOS** |
| Human authentication | AuthKit (social now; SSO and MFA later) | **WorkOS** |
| Invitations | Invitations API | **WorkOS** |
| **Workspace** | — nothing — | **Us** |
| **Actor** | — nothing — | **Us** |

There is no workspace primitive in WorkOS. That layer and everything hanging off
it is ours.

**Never key anything on email.** WorkOS user IDs are stable; emails are not.
Email is a display attribute, never a join key — and agents have none at all, so
no unique-email constraint belongs anywhere near `actors`.

## 5. The actor model

```
LAYER 1 — IDENTITY                                    (WorkOS owns)
   humans → WorkOS User        (email, social provider, later SSO/MFA)
   agents → WorkOS M2M app     (Phase 6)

LAYER 2 — ACTOR                                       (we own)
   actors(id, org_id, workspace_id, type, handle, display_name,
          identity_kind, identity_id, provisioned_by, state, ...)

LAYER 3 — PARTICIPATION                               (we own)
   memberships / messages.author_id / reactions.actor_id  → actor_id
```

**Polymorphic identity reference.** `identity_kind ∈ ('workos_user',
'workos_agent', 'system')` plus `identity_id` — not a nullable `workos_user_id`
beside a nullable agent column. Phase 1 only ever writes `'workos_user'`, but the
shape is what lets agents arrive in Phase 6 without a migration.

**No identity reference may appear below Layer 2.** `messages.author_id` points
at `actors.id`, always. The moment a `workos_user_id` reaches a message, a
reaction or a membership row, agents become second-class and the schema grows
nullable columns forever. **This single rule is most of what "agents are just
users" means in practice** — and it is enforceable now, while there is only one
identity kind and no pressure to bend it.

**One handle namespace.** A unique index on `(workspace_id, handle)` covers
humans and agents together, so `@harsh` and `@deploy-bot` cannot collide. Handle
assignment on first join needs a disambiguation path — two people named Harsh is
the common case, not the edge case.

**Deactivation never deletes.** Messages persist and the actor is tombstoned; a
deactivated author still renders correctly offline, because the actor set is
replicated eagerly and completely (§8.3).

## 6. The desktop auth flow — as built

```
1. shell.openExternal(authkit_url)        ← SYSTEM browser, PKCE challenge
2. user authenticates with Google / GitHub / Microsoft / Apple
3. redirect → http://127.0.0.1:<ephemeral>/auth/callback?code=…
4. a single-use loopback listener receives it and verifies `state`
5. exchange code + verifier — in the sync process, never the renderer
```

**Loopback is the primary path, not a fallback.** The design originally led with
`relayed://`. That does not work, and the way it fails is worth recording:

> On macOS, `app.setAsDefaultProtocolClient('relayed')` writes a Launch Services
> *handler preference* that binds to nothing, because no unpackaged bundle
> declares the scheme in `CFBundleURLTypes`. `open relayed://…` then exits 0 and
> silently does nothing — **and `isDefaultProtocolClient()` returns `true`**,
> because it reads back the preference it just wrote.
>
> Verified via `lsregister -dump`: `handlerpref id: relayed` → `unknown: relayed`.

A custom scheme would therefore work only in packaged builds, which means the
auth flow would differ between development and production — and a dev/prod
divergence in auth is precisely where bugs hide. Loopback behaves identically in
both, so it is the single path.

WorkOS supports this: `http://127.0.0.1:*/auth/callback` is permitted for RFC
8252 native clients, and `http://127.0.0.1` is the one HTTP redirect allowed in
production. **Both a fixed-port default and the wildcard must be registered** —
their docs disallow a wildcard as the *default* URI.

`deep-link.ts` is kept: it is correct once packaged, and deep links have other
uses ("open this message").

### Mechanics

- **PKCE is mandatory.** A desktop app is a public client; a secret in an
  Electron bundle is extractable from the asar. Confirmed against staging: the
  token endpoint accepts `client_id` + `code_verifier` with **no API key**, so
  the application must be configured **Public** in the WorkOS dashboard.
- **Never a `BrowserWindow`.** §2 — this fails immediately with social providers.
- **Ephemeral ports.** The listener binds `127.0.0.1:0`, so nothing breaks when
  something else holds a fixed port. It binds the loopback interface only, is
  single-use, and verifies `state` **before** touching the code.
- **The single-instance lock is still required**, for the packaged custom-scheme
  path and to stop two sync engines writing one SQLite file.
- **Tokens never reach the renderer.** The renderer sees only auth *state*,
  pushed over the MessagePort.

### `safeStorage` is not available in a utilityProcess

Measured: a `utilityProcess` sees only `net` and `systemPreferences` from the
`electron` module. `safeStorage` is main-only.

So the vault lives in **main**, and the sync engine asks main to persist and
retrieve. That does not weaken the rule in §13.1 — the rule is that tokens never
reach the **renderer**, which is the boundary that matters because it runs a
swappable UI bundle (`RELEASE.md` §4). Main is trusted.

The vault **refuses to write a token when the keychain is unavailable** rather
than falling back to plaintext. Re-authenticating is a better outcome than a
bearer credential readable by anything on the machine.

## 7. Sessions and boot ordering

Two independent sessions. Keeping them separate is what makes R3 hold:

| Session | Purpose | Storage | On expiry |
|---|---|---|---|
| **Local** | Unlocks the local DB and UI | `meta` table | Long-lived. Cleared **only** on explicit sign-out. |
| **WorkOS** | Authenticates the sync socket | Refresh token in `safeStorage`, access token in memory | Degrades **sync only**. |

```
1. Open SQLite, run migrations.
2. Read local session from meta.
3. Render the full UI from local data.      ← user is productive HERE
4. THEN start the sync engine.
5. Sync authenticates; on failure, a non-blocking banner.
```

**If step 3 ever depends on step 4, R3 is broken.** This ordering needs a test
that runs with the network disabled — it is the single most regressible property
in the phase, because every auth library wants to gate the app on a token check.

**Auth failure never clears local data.** A token expiring is not a sign-out.
Only an explicit sign-out wipes the database and blob directory.

## 8. Schema for this phase

`actors` is already specified in §8.3 and needs no change. Phase 1 adds only what
identity requires:

```sql
-- Local session and device identity live in `meta` (already migrated):
--   local_session   long-lived, gates local reads
--   device_id       generated at first run; scopes outbox dedupe
--   workos_user_id  which account this database belongs to

-- actors rows written in this phase:
--   type            = 'human'
--   identity_kind   = 'workos_user'
--   identity_id     = WorkOS user id  (stable; never the email)
--   provisioned_by  ∈ ('self_signup', 'invite')
--   state           ∈ ('invited', 'active', 'suspended', 'deactivated')
```

Server-side, the org/workspace/actor records and the invitation flow. WorkOS
holds `User` and `OrganizationMembership`; we hold `workspaces` and `actors` and
join on `identity_id`.

---

## 9. Org and workspace structure — settled

**1. Organizations are created on demand, never on signup.**

- Arriving **via invite** → land directly in that workspace. **No personal org
  is created, ever.**
- Signing in **with no org** → a one-click "create your workspace", pre-filled.

Auto-creating on every signup was considered and rejected. It reads as
frictionless but has three costs, the first of which is structural:

- **It makes multi-org the default.** The moment anyone is invited anywhere they
  hold two workspaces — so the switcher, two SQLite files and "which workspace am
  I in?" all become day-one problems instead of deferred ones (decision 3).
- **It breaks the commonest onboarding path.** Alice invites Bob, who has never
  signed up. Bob accepts, signs in, and lands in his own empty workspace rather
  than Alice's — so the invite looks broken. Auto-creation is worst precisely
  where it matters most.
- **Orphan sprawl.** Every drive-by signup leaves an empty tenant in metrics,
  billing, quotas and abuse surface.

The prompt is not really friction: a workspace name and a handle have to be
collected anyway, so it is the setup step rather than an extra one. And "me plus
my agents" still works — those users create deliberately and get a named
workspace instead of "Harsh's Workspace (1)".

**2. Joining an org is by invite.** WorkOS Invitations API. Domain auto-join
stays unsafe until SSO exists (§2) — social login proves mailbox control, not
organizational membership. Slack takes the same position: it will not let an
admin approve a public domain like `gmail.com`.

**3. Multiple orgs per account: allowed in the data model, not built.** WorkOS
supports it natively and `actors` is already scoped by `org_id`/`workspace_id`.
The client stays single-workspace, and no switcher ships until someone actually
has two. Decision 1 is what keeps that realistic — most users will hold exactly
one workspace.

**4. No personal org on signup.** Falls out of decision 1.

**5. Handles.** See §10.

---

## 10. Handles

The handle question looks load-bearing because mentions appear to depend on it.
**One decision removes that.**

### Mentions store `actor_id`, not the handle

```
stored:    hey <@actor_01JABC> can you look at this
rendered:  hey @Harsh can you look at this
```

Three properties follow:

- **Renaming a handle never breaks an old mention.** With text handles, every
  historical `@harsh` silently points at nobody — or worse, at whoever claims the
  name next.
- **A collision cannot misdirect a mention.** Two people named Harsh is a
  *display* problem, solved with an avatar and an email in the autocomplete, not
  an identity problem.
- **Handle policy becomes convenience, not correctness.**

This matters more here than in Slack: a misdirected mention between humans is
awkward, but **a misdirected agent mention is an agent doing work in the wrong
context** — potentially with someone else's delegated authority (§6.4).

### Policy

| | |
|---|---|
| **Scope** | Unique per workspace. Global handles create a landgrab where a stranger holds `@harsh` and a colleague cannot use their own name at work. |
| **Namespace** | Shared with agents — a unique index on `(workspace_id, handle)` covers both, so nothing can be named `@harsh` twice regardless of type. |
| **Format** | Lowercase, `a–z 0–9 . - _`, 3–30 chars, must start with a letter. |
| **Reserved** | `everyone`, `here`, `channel`, `all`, `admin`, `system`, `relayed` — claimed before anyone else can. |
| **Assignment** | Derived from the email local-part, availability-checked, presented as a **pre-filled editable field** during onboarding. The person chooses; they just do not start from blank. |
| **Changing** | Allowed. A released handle is **not immediately reusable** — a freed `@harsh` going to someone else next week is confusing even with ID-based mentions. |

**Never auto-suffix.** `@harsh2` is a poor first impression and is exactly what a
flow produces when it declines to ask.

## 11. Done criteria

**Client — done**

- [x] Sign in with a social provider in the **system browser**; the loopback
      callback returns to the app. Verified end to end against WorkOS staging.
- [x] Refresh token in `safeStorage`; **no token observable in the renderer** —
      the renderer's only auth surface is the pushed state object.
- [x] Token refresh failure shows a banner and leaves local data untouched;
      `signOut` is the only path that clears the vault (tested).
- [x] `actors` and `workspaces` tables exist, with the handle uniqueness index
      and the CHECK constraints.
- [x] One replica per `(account, workspace)`, one `account.db` per account,
      switching between them ([`STORAGE.md`](STORAGE.md)).
- [x] Explicit sign-out wipes the database **and** the blob directory — one
      directory delete, verified against a real install.
- [x] Avatars are fetched into a content-addressed blob store and served over a
      custom scheme; nothing remote is ever in the render path (§13.3).

**Server — done**

- [x] An `actors` row is written on first sign-in
- [x] Org / workspace creation on demand (§9 decision 1), and the same endpoint
      creates additional workspaces for a signed-in identity
- [x] Handle assignment UI — pre-filled, editable, never auto-suffixed (§10)
- [x] `/auth/session` returns every membership; `/auth/switch` mints a session
      for a sibling actor without revoking the source

**Server — done**

- [x] An `actors` row is written on first sign-in
- [x] Org / workspace creation on demand (§9 decision 1), and the same endpoint
      creates additional workspaces for a signed-in identity
- [x] Handle assignment UI — pre-filled, editable, never auto-suffixed (§10)
- [x] `/auth/session` returns every membership; `/auth/switch` mints a session
      for a sibling actor without revoking the source
- [x] **Real WorkOS organizations**, created during onboarding — before our own
      transaction, since holding one open across a network call makes the
      slowest external service the lock duration — with the founder added as an
      OrganizationMembership, which is the step easiest to miss: an organization
      with no members is one invitations cannot be addressed to
- [x] **Invitations** — create, list, revoke, each gated on
      `can(actor, 'invite', workspace)` (see [`AUTHZ.md`](AUTHZ.md))
- [x] **Joining**, with a handle chosen in that workspace — the first point in
      the product where a collision is reachable
- [x] **Authorization** exists at all: a `memberships` table, one `can()`, and
      a role we own rather than one WorkOS lends us

**Deactivation — closed, but not the way this document expected**

§7 recorded a deactivation *webhook* as the accepted cost of minting our own
tokens. It is closed by **polling WorkOS's Events API** instead, and the
difference is not cosmetic: a cursor over a durable log cannot miss an event,
needs no public endpoint, and is replayable, where a webhook is at-least-once,
unordered and lost if the endpoint is down. `user.deleted` and
`organization_membership.deleted` now tombstone the actor, tombstone its
membership row and revoke its sessions within a poll interval rather than within
an access-token TTL. Reasoning in [`AUTHZ.md`](AUTHZ.md) §10.1.

**Closed since**

- [x] **Actors replicate to the client.** `GET /actors` fills the workspace
      replica, so a message author can render offline. It is temporary by
      design: `DESIGN.md` §9.1 puts the directory in the `welcome` frame, and
      the shape here is that shape, so porting is a change of transport.
- [x] **The airplane-mode test exists**, and proves R3 rather than measuring it.
      `boot.test.ts` removes `fetch` from the process entirely — a boot that
      needed the network cannot merely be slow, it throws — which is a stronger
      claim than counting calls and finding zero.
- [x] **The rules we write down are enforced.** `tools/check-boundaries.mjs`,
      wired into `pnpm typecheck`: six rules at the close of this phase, each
      naming the sentence in the document it holds. §11a below is why it
      exists — and the count has grown since, so read the file rather than this
      line for what it holds today.
- [x] Sync [`DESIGN.md`](DESIGN.md) — invariants 37–67 folded in, and the shell
      slotted into §15 as Phase 1½.

**Directory avatars, added later.** The directory arrived with `avatar_url` and
nothing to render: `syncActors` wrote a literal `NULL` into `avatar_blob` and
deleted every row on each sync, so a prefetch could not have stuck even if one
had walked the table. Closed with an upsert that keeps the pointer while the URL
is unchanged, a prefetch pass over the actors table, and a link-before-download
step — content addressing means the same face already held under another row
costs no request at all, and resolves offline where a download cannot.

## 11a. Learnings

Things that cost time and are cheap to know.

**`isDefaultProtocolClient()` lies.** See §6. An API that reports success while
the underlying capability does nothing — the same shape as the WorkOS redirect
probe below.

**Verify a config probe's success condition, not just its output.** My first
redirect-URI check reported all four URIs as ACCEPTED because it treated any
`302` as success — but the redirect was *to* `/redirect-uri-invalid`. It would
have declared a broken configuration healthy.

**Node's strip-only TypeScript forbids syntax that emits code.** Tests run via
`node --test` directly on `.ts`, so constructor parameter properties, `enum`,
`namespace` and decorators all fail at load. Recorded in `AGENTS.md`.

**A promise that can reject before anyone awaits it will kill the process.** The
loopback listener's `result` rejects on a forged `state`; without a handler
attached at construction that is an unhandled rejection, and Node terminates —
so a CSRF attempt would have crashed the sync engine instead of failing the
sign-in. Guarded, and covered by a test.

**Writing that down did not stop me doing it again.** Tests for the sign-in
cancel path attached `.catch()` after an `await`, the rejection fired in the
gap, and the test process died — the same trap, in the same file, by the person
who documented it. Two runs were spent guessing before a twelve-line script that
printed a timestamp per step found it immediately. Two conclusions: prose does
not hold a boundary, which is the argument for the lint rule in §11; and when a
guess has failed twice, stop guessing and print.

**A teardown that does not settle its promise strands every caller.** The
loopback listener's `close()` stopped the server and left `result` pending for
ever — and cleared the five-minute timeout that would otherwise have rescued it.
So an abandoned sign-in had no exit at all, and the UI sat on "waiting for the
browser" until the app was restarted. The visible bug was a missing Cancel
button; adding one without this fix would have been a button that did nothing.
Anything holding a promise others await must settle it on every path out,
including the ones that look like cleanup.

**An API can answer authoritatively about a flow it does not own.**
`accept_invitation_url` is on AuthKit's domain, so WorkOS accepts invitations on
its hosted page and we are never asked. A design built around our own accept
endpoint was wrong before it was written, and only reading the live response
said so.

## 12. What this phase must not preclude

Deferring SSO and SCIM is only safe if the shape stays open. Three things to hold:

1. **`identity_kind` stays polymorphic**, even with one value in use. Collapsing
   it to `workos_user_id` because that is all Phase 1 needs is the migration that
   makes agents second-class later.
2. **`provisioned_by` and the actor state machine keep their full vocabulary.**
   SCIM adds a source and a deactivation trigger, nothing structural.
3. **Org membership stays a first-class relation**, not an implicit "everyone in
   the database is in the org". SSO and multi-org both depend on it.
