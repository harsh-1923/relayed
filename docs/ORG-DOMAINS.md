# Organizations and company domains

> **Status: v1 built locally, uncommitted (2026-09-26); enterprise tier (§11) and
> guests (§9) not built.** §18 records where the build departed from the text
> below. It lets people from
> the same company land in the same place without an invitation, the way Slack
> does, and puts an organization level above workspaces so only org admins create
> workspaces. It contradicts two settled decisions in
> [`PHASE-1-IDENTITY.md`](PHASE-1-IDENTITY.md) — §2 (*domain auto-join is unsafe*)
> and §3/§9 (*one workspace per organization*) — and adds a scope to
> [`AUTHZ.md`](AUTHZ.md). §14 lists the edits those documents need; until they
> land, they win.
>
> Every claim below about today's code was run against it:
> [`spikes/org-domains/`](../spikes/org-domains/README.md) drives the real
> provisioning, join, poller, sync and refresh code on a throwaway database. §17
> maps each check to the section it backs.
>
> **The recommendation in one line:** approved email domains checked against a
> *verified* email, never a public mail domain, and never exclusive — any org may
> approve its own domain and sign-in lists every match; **no new role table** —
> an org member is a WorkOS org member, an org admin is an admin of the org's
> default workspace; invitations remember their workspace. Exclusive control of a
> domain is the enterprise tier: DNS verification, then claiming the other orgs
> on it (§11).

**Last updated:** 2026-09-26

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **Organization (org)** | The company. A WorkOS `Organization`, mirrored in `organizations`. Owns workspaces. |
| **Workspace** | Ours; WorkOS has no such concept. One sync boundary, one SQLite file per device (`STORAGE.md`). An org holds one or more. |
| **Org member** | An identity with an active WorkOS `OrganizationMembership` — an active row in `workos_memberships`. Not the same as having an actor in any given workspace. §6. |
| **Org admin** | An org member who is `owner` or `admin` of the org's **default workspace**. Derived, not stored. §6. |
| **Approved domain** | A company mail domain an org admin has attached to the org, e.g. `acme.com`. Opens a door; confers no ownership. Several orgs may approve the same one. §4. |
| **Verified domain** | A domain an org has proved it owns through DNS. At most one org per domain. The enterprise tier, §11. |
| **Claim** | A verified org taking in another org on its domain: that org's workspaces move under it. §11.3. |
| **Public mail domain** | A domain anybody can get an address on — `gmail.com`, `outlook.com`, `icloud.com`. Never approvable. §4.3. |
| **Domain join** | Entering an org because your verified email is on one of its approved domains, with no invitation. |
| **Default workspace** | The workspace a domain join lands in, and whose admins govern the org. One per org. |
| **Open workspace** | A workspace any org member may join from the browser without an invite. |
| **Workspace invitation** | Our record of which workspace a WorkOS invitation was sent from. WorkOS invitations are org-level. §5.2. |

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| How do colleagues find each other? | An **approved domain** on the org; a verified email on it admits you. | 4 |
| What proves you work there? | A **verified mailbox** on that domain (`email_verified` from WorkOS). Not DNS. | 4.1 |
| Who may approve a domain? | An org admin **whose own verified email is on that domain**. | 4.2 |
| Can `gmail.com` be approved? | **Never.** A blocklist of public mail domains. | 4.3 |
| Can two orgs approve one domain? | **Yes.** Sign-in lists every match. Only a *verified* domain is exclusive. | 4.4 |
| Is the first person from a company its owner? | **Of their own org only.** Not of the domain, not of anyone else's org. | 4.4 |
| Where does a domain join land? | The org's **default workspace**. Others are browsed, not auto-joined. | 5 |
| Who can enter an invite-only workspace? | **Only people invited to it.** Org membership alone is not enough. | 5.1 |
| How does an invitation name its workspace? | **A row of ours** beside the WorkOS invitation. | 5.2 |
| Who creates a workspace inside an org? | **Org admins only.** | 6, 7 |
| Who creates a new org? | Anyone — until the domain is verified and locked (§11.4). | 7.2 |
| Where do org roles live? | **Nowhere new.** Member = WorkOS membership (mirrored). Admin = admin of the default workspace. | 6 |
| Does anything change for gmail users? | **No.** Invite-only, exactly as today. | 8 |
| Do invitations still work across domains? | **Yes.** A domain is an extra way in, never a restriction. | 8 |
| Contractors who should not see everything? | A **guest** role. Optional, second stage. | 9 |
| How does a company take control? | **Enterprise:** verify by DNS, claim the other orgs, lock the domain, SSO, SCIM. | 11 |
| Can a workspace change org? | **Yes, by claim.** `workspace_id` never changes; `org_id` can. Sync is unaffected. | 11.3 |

---

## 2. Why the Phase 1 decision changes

`PHASE-1-IDENTITY.md` §2 rejected domain auto-join because social login
"verifies an email, not an organizational relationship", and it deferred the idea
until SSO with a verified domain existed.

That was stricter than the industry. The reasoning the products below rely on:
**a company issues its own mail addresses**. Controlling `ravi@acme.com` is
evidence of working at Acme in a way controlling `ravi@gmail.com` is not. §2's
worry is real only for public domains (§4.3) and for *who gets to attach a domain
to an org* (§4.2) — both closed below without DNS.

The other overturned decision, one workspace per org, was only ever deferred
(`PHASE-1-IDENTITY.md` §3: "carrying an unused column is free"). The schema
already allows it — `workspaces` is unique on `(org_id, slug)` — and multi-
workspace clients shipped in 0.0.2. The spike confirms memberships and streams
stay separate with two workspaces in one org (check 2.1) — but also that today's
join path does **not** keep them separate for *entry* (§5.1).

### 2.1 What other products do

Checked against their help centres on 2026-09-26.

| | Approved domain (any plan) | Who may add one | Exclusive? | Company takeover |
|---|---|---|---|---|
| **Slack** | Workspace owners/admins, Free and up: people with approved addresses join from the sign-up link or sign-in page | Workspace owners and admins | No | Enterprise org owners claim the domain (through Slack support) "to prevent people from creating unsanctioned workspaces"; other workspaces lose it from their sign-up mode |
| **Notion** | *Allowed email domains*: matching sign-ins are offered the workspace in onboarding | Admins, and only for domains that workspace members' accounts are on | No | Enterprise org owners verify by DNS, then claim multi-member workspaces, request transfer of single-member ones, see every workspace on the domain, and restrict creation to org owners |
| **Linear** | Anyone on the domain joins without invitation or approval | Admins | No — "does not prevent users from creating new workspaces with that domain email" | SAML and SCIM on Enterprise |
| **Atlassian** | — | — | — | Verifying a domain (DNS or HTML file) claims every account on it as a managed account |

The shared pattern, which this doc follows: **the first person from a company
creates *a* workspace and owns it, and nothing more.** The door their domain
opens is not exclusive. Control of the company's identity is a separate,
deliberate act by the company, proved through DNS.

Sources: Slack — [Manage how people join](https://slack.com/help/articles/115004856503-Manage-how-people-join-your-workspace),
[Claim and verify email domains](https://slack.com/help/articles/5513043606547-Claim-and-verify-email-domains),
[Claim domains for an Enterprise organization](https://slack.com/help/articles/115001379947-Claim-domains-for-an-Enterprise-organization).
Notion — [Workspace settings](https://www.notion.com/help/workspace-settings),
[Domain management](https://www.notion.com/help/domain-management).
Linear — [Invite members](https://linear.app/docs/invite-members).
Atlassian — [Verify a domain to manage accounts](https://support.atlassian.com/user-management/docs/verify-a-domain-to-manage-accounts/).

---

## 3. The flows, as a timeline

**Asha** (asha@acme.com) signs up first. Nobody from acme.com is here, so she
sees today's *Create your workspace*. She creates **Acme**: an org, a default
workspace, and Asha as its owner — which makes her org admin (§6). That makes her
the owner of *this org* — not of `acme.com`, and not of any org another Acme
employee makes.

**Bob** (bob@acme.com) signs in *before* Asha approves the domain. He sees only
*Create your workspace*: an org is invisible until its admin approves the domain.
He waits for an invite, or creates his own org.

**Asha** approves `acme.com` in org settings — allowed, because her own verified
email is on it.

**Ravi** (ravi@acme.com) signs in with Google. `/auth/session` finds no actor,
reads his profile, sees a verified email on an approved domain, and returns Acme as
a match. Onboarding shows *Your team at Acme is on Relayed* above *Create a new
workspace*. He picks a handle and lands in the default workspace with its public
spaces joined. No invitation was sent.

**Carol** (carol@acme.com) creates her own org, **Acme Design**, and approves
`acme.com` too. Nothing stops her (§4.4). The next Acme sign-in sees both:

> **Your team is on Relayed**
> Acme · 80 members → **Join**
> Acme Design · 12 members → **Join**
> *or* Create a new workspace

**Asha** creates **Acme Payments**, open to the org. Ravi sees it under *Browse
workspaces in Acme* in the switcher, and joins with one click and a handle
(pre-filled with his handle in the default workspace). There is no *Create
workspace* entry under Acme for Ravi.

**Kiran** (kiran@acme.com), an admin of the default workspace and so an org admin,
creates a private **Acme Leadership**, invite-only. Ravi does not see it in the
browser, and cannot join it by id either (§5.1).

**Kiran** invites Priya to Acme Leadership. Priya is offered Acme Leadership — the
workspace the invitation came from — and the default workspace, because accepting
made her an org member. Not Acme Payments; that one she can browse to later.

**Meera** (meera@gmail.com) signs up. No match — `gmail.com` is public — so she
sees today's *Create your workspace*, creates **Meera's Studio**, and invites
whoever she likes.

**Dev** (dev@gmail.com), a contractor, is invited to Acme by Asha. Invitations
work regardless of domain. Without §9 he is a full member of the workspace he was
invited to; with §9 he can be a guest.

**Ravi** also signs in as ravi@gmail.com. That is a second WorkOS user (one per
email) and a second account; he switches between them as any two accounts today.

A year later Acme becomes an enterprise customer and brings Acme and Acme Design
under one org. That continues in §11.1.

---

## 4. Approved domains

### 4.1 What admits someone

All four, checked server-side at the moment of joining — never trusted from the
client:

1. The WorkOS profile has `email_verified = true`. `fetchProfile`
   ([`workos-profile.ts`](../apps/server/src/auth/workos-profile.ts)) reads only
   `email` today and must add this — the spike could not tell an unverified
   `eve@acme.com` from a verified one (check 3.4). Google and Microsoft sign-in
   always return verified addresses; email/password sign-up does not until the code
   is entered.
2. The email's domain, lower-cased, **exactly** matches an approved domain.
   `mail.acme.com` does not match `acme.com`; an admin approves subdomains
   separately.
3. The domain is not on the public list (§4.3) — checked again here, not only at
   approval, so a list update closes an already-approved mistake.
4. The target workspace is open to the org (§5).

### 4.2 Who may approve a domain

An org admin, and only for the domain of their own verified email. Notion's rule,
and what stops the obvious attack: someone creating *"Acme"* from a gmail
account and approving `acme.com` to collect every Acme employee who signs up
after them.

An admin at `acme.com` who wants `acme.io` too needs an admin with an `acme.io`
address, or DNS verification (§11).

### 4.3 Public mail domains

A static list in the server, starting from the widely used free-mail lists
(gmail, googlemail, outlook, hotmail, live, yahoo, icloud, me, proton,
protonmail, aol, zoho, yandex, gmx, mail.com, rediffmail…). A static file rather
than a table: it changes with a release, and a stale entry fails closed only in
the direction that matters (a missing entry is the risk, not an extra one).

### 4.4 No lock on a domain

Any number of orgs may approve the same domain. `org_matches` (§10) returns every
one, largest first, and the person chooses. This is what Slack, Notion and Linear
do (§2.1), and it is what keeps "whoever signed up first" from deciding for a whole
company: being first makes Asha the admin of *her* org, and gives her nothing over
Carol's.

The cost is duplicate orgs at one company. That is tolerated here and repaired by
the enterprise claim (§11.3), which is where a company that cares decides which
org is the real one.

A domain stops being shareable only when an org **verifies** it (§11.2). From that
moment it disappears from every other org's approved list, and those orgs return to
invite-only until they are claimed.

---

## 5. Workspaces inside an org

Each workspace gets a join policy:

| Policy | Who sees it in the browser | Who joins |
|---|---|---|
| `org_open` | Every org member | Any org member, one click and a handle |
| `invite_only` | Its members only | Only people invited to **this** workspace (§5.2) |

Every org has exactly one **default workspace**, always `org_open`. A domain join
enters the org *and* a workspace in one step, because an org membership with no
workspace would be a sign-in to nothing.

**Arriving, every open workspace is offered.** Someone with no workspace in an
org yet — by domain, or already an org member — sees all of its open
workspaces on the join screen, the default first and marked as where colleagues
land, and picks one. Invite-only workspaces are never listed. Once they are in
the org, its other open workspaces stop being offered and live under *Browse*,
so the switcher does not count them forever. (Decided 2026-09-26, after testing
showed a second open workspace invisible to a colleague who plainly belonged.)

**Not auto-joining every open workspace** is deliberate, and specific to
local-first: each workspace is another SQLite file and another sync engine on
every device (`STORAGE.md`). Slack's *default workspaces* can be several; ours is
one until someone needs more.

**Discovery follows org membership, not domain.** The domain matters once, at the
door. After that, *Browse workspaces* is "open workspaces in orgs I am a member
of" — which also works for Dev, invited from gmail.

### 5.1 Today's join path admits to every workspace in the org

`joinWorkspace` ([`join.ts`](../apps/server/src/provisioning/join.ts)) admits
anyone WorkOS lists as a member of the workspace's org, and `pendingJoins` offers
every workspace of every org the person belongs to. With one workspace per org that
was exactly right. With several, the spike had Ravi offered **and admitted to**
Acme Leadership, invite-only (checks 2.2, 2.3).

Admission becomes: **org member, and** one of

- the workspace is `org_open`, or
- there is a workspace invitation for this workspace addressed to this person
  (§5.2).

`pendingJoins` offers the same set, minus what the person already belongs to. Both
functions call one `admissible(identity, workspace)` so they cannot disagree.

### 5.2 Invitations name their workspace

A WorkOS invitation is addressed to an **organization** (`createInvitation`,
[`management.ts`](../apps/server/src/workos/management.ts)). Dev, invited from
Acme Leadership, was offered Acme and Acme Leadership alike (check 2.4) — nothing
recorded where the invitation came from.

`POST /invitations` writes a row beside the WorkOS call:

```sql
workspace_invitations (workos_invitation_id PK, workspace_id, invited_by_actor_id, created_at)
```

WorkOS records `accepted_user_id` on an invitation (confirmed against its API
reference), so no email is involved: at interactive sign-in and at join, the server
lists the org's invitations, and for those this person accepted it writes their id
onto our row. Every later check — the refresh path included — reads our own table.

An invitation into an `invite_only` workspace still makes the person an org member,
because that is what a WorkOS invitation is. They can then browse the org's open
workspaces. For someone who should see only what they were invited to, that is the
guest role (§9).

---

## 6. Org roles — none stored

The first draft of this doc added an `org_roles` table keyed by identity. The spike
says it is not needed, and that one half of it was harmful.

**Org member = WorkOS org member.** `workos_memberships` is already documented as
"the authority on who has been ADMITTED" (`004_workos_events.sql`). An `org_roles`
`member` row duplicates it — and after just two joins through today's code the two
lists had already drifted: `[asha, dev, ravi, tom]` against `[asha, ravi]` (check
5.3). One list.

One change to how the mirror is filled: **write the row whenever we call
`addMember`**, as well as when the poller sees the event. The poller runs every 30
seconds, and until it does a domain joiner is invisible to anything reading the
mirror — *Browse workspaces*, `pending_joins` on refresh (check 4.1).

**Org admin = `owner` or `admin` of the org's default workspace.** Checked against
`org_roles` on every scenario the spike could build — founder, joiner, domain
joiner, a second org — with identical answers (check 5.2). What it gets for free:

- **An org always has an admin.** `membership_one_owner` already guarantees one
  owner per workspace, so the default workspace always has one (check 5.4).
  `org_roles` would have needed its own last-admin guard.
- **Nothing to backfill, nothing to migrate on a claim.** Carol, owner of Acme
  Design, stops being an org admin the moment her workspace is no longer a
  default — the rule says so, no row has to be deleted.
- **One place to grant it.** Making Dan from IT an org admin is making him an admin
  of the default workspace, through the existing member-management path.

What it costs, deliberately accepted:

- An org admin must be an admin of the default workspace. That is where everyone
  in the company already is, so it asks nothing unusual.
- **Changing the default workspace changes who the org admins are.** So choosing a
  new default is an org-admin action that requires the actor to be an admin of the
  new default too — otherwise it would be a way to hand the org away, or lock
  oneself out (§16 question 3).

**Ruled out:** an org grant as a `memberships` row. `memberships.actor_id`
references an actor, actors are per workspace, and one person has several — Asha
was org admin while in Acme and not while in Acme Leadership (check 5.1).

WorkOS `role_slug` stays mirrored and unread (`AUTHZ.md` invariant 52).

### 6.1 Authz

A fifth scope, `organization`, above `workspace`:

```ts
organization: ['create_workspace', 'manage_domains', 'manage_workspaces'],
```

All three require `admin`. The grant is derived by `orgGrants`
(`apps/server/src/authz/org.ts`): `organization:<org_id> → admin` for every org
whose default workspace the caller's identity owns or administers. Loaded
separately from `loadGrants`, which runs on the socket's hot path and has no use
for it; the two meet only inside `can()`, which stays pure. The org is read from the actor row, never from the access
token (§11.7). The enterprise tier adds `claim` and `manage_identity` (§11.6).

There is no `manage_admins`: granting org admin *is* `workspace:manage_members` on
the default workspace.

**Org admins do not inherit workspace roles.** Asha can create *Acme Payments*
but is not thereby an admin of *Acme Leadership*. `manage_workspaces` covers the
org-level acts — renaming, changing a join policy, choosing the default — not
reading anything inside. That is Slack Grid's split, and it keeps the rule in
`AUTHZ.md` §7 (*workspace admin does not inherit space admin*) intact: nothing
reaches *down* from a scope the data does not contain it in.

---

## 7. Creating things

### 7.1 A workspace inside an existing org

`POST /auth/workspace` takes an optional `org_id`.

- **With `org_id`:** `requireCan(organization:create_workspace)`. No WorkOS call —
  the org exists. Inserts `workspaces` and the founding actor, seeds the default
  channel and system agents as today, and makes the creator workspace owner.
  Policy defaults to `org_open`.
- **Without:** today's path — new WorkOS org, new workspace — and the new workspace
  set as the org's default, which makes the creator its admin.

`createWorkspace` in [`provision.ts`](../apps/server/src/provisioning/provision.ts)
splits into `createOrganization` and `createWorkspaceInOrg` so the second is not a
copy of the first.

### 7.2 A new org, when your company already has one

Allowed, and the new org may approve the same domain (§4.4). Slack, Notion and
Linear all allow it below their enterprise tier. Forbidding it before the domain is
verified would hand the company to whichever employee got there first. Onboarding
makes existing orgs the obvious choice: the matches are the first thing on screen,
and *Create a new workspace* is secondary.

Once the domain is verified and locked (§11.4), creating an org from that domain is
refused with *Contact your Acme admin* and the verified org's name.

---

## 8. What stays the same

- **Public mail domains:** invite-only, today's onboarding, unchanged.
- **Invitations:** any org, any domain, still through WorkOS's hosted page and
  `pendingJoins`. An approved domain never blocks an invite from elsewhere. What
  changes is that an invitation now also names its workspace (§5.2).
- **Multiple accounts:** one WorkOS user per email, so two addresses are two
  accounts, switched as today.
- **Existing orgs:** migrated as one workspace each (§12). Nothing is approved on
  anyone's behalf; each org's admin opts in.
- **Removal from an org** deactivates the person in every workspace of it — the
  poller already does this, and the spike confirmed it across two workspaces
  (check 7.1). So **leaving one workspace must never call WorkOS
  `removeMember`**; that is leaving the org.

---

## 9. Guests (second stage)

Dev, invited from gmail to do one job, should not see every public space. Today
he does: `/auth/join` calls `joinPublicSpaces`.

A `guest` workspace role:

- not added to public spaces on join; added to specific spaces only
- `can()` refuses `workspace:create_space`, `workspace:invite`, and `join` on
  open spaces for guests
- hidden from *Browse workspaces*: a guest is a WorkOS org member (§5.2) but
  browsing requires a non-guest actor somewhere in the org
- the invite form gains *Invite as guest*, recorded on the workspace invitation

Slack's single- vs multi-channel guest split is unnecessary: a guest in one space
is a guest in one space. Deferred because nothing in §3–§7 depends on it, but it
belongs in the same release as domain join — domain join is what makes "full
member" the easy default for everyone else.

---

## 10. Endpoints and payloads

| Endpoint | Change |
|---|---|
| `POST /auth/session` | When no actor exists, also returns `org_matches: [{ org_id, name, member_count, workspace_id, workspace_name, handle_suggestions }]` — **every** org whose approved domains match (§4.4), largest first. If the domain is verified, only that org. `pending_joins` narrows to §5.1's admissible set. |
| `POST /auth/join` | Admits on §5.1: org member **and** (`org_open` **or** invited here) — or §4.1 for a domain join. A domain join calls WorkOS `addMember`, writes the `workos_memberships` row itself, then the actor with `provisioned_by = 'domain'`. |
| `POST /auth/workspace` | Optional `org_id`, §7.1. Without it, refused with `domain_locked` when §11.4 applies. |
| `POST /invitations` | Also writes `workspace_invitations` (§5.2). |
| `GET /org/:id/workspaces` | Open workspaces in an org the caller belongs to, with whether they are already a member. |
| `GET/POST/DELETE /org/:id/domains` | `manage_domains`. POST enforces §4.2–§4.3, and refuses a domain another org has verified. |
| `PATCH /workspaces/:id` | `join_policy` and name via `manage_workspaces`; `is_default` additionally needs admin of the new default (§6). |
| `/auth/refresh` wire | Each membership gains `org_is_admin`, so the client can hide *Create workspace* (hides only — invariant 49). `org_id` is already on it and re-read every refresh. |

The enterprise endpoints are in §11.6.

**Email is still not stored** (`DESIGN.md` §6.2). The domain check
reads the profile fetched at sign-in. For a caller holding one of our tokens —
Ravi joining a second workspace — the org membership already admits him and no
email is needed. A signed-in person whose *domain* matches an org they are not yet
in (they signed up before the domain was approved) is found by one live profile
fetch on `GET /org/matches`, called when the switcher opens, not on refresh.

WorkOS order for *creating* matches `createWorkspace` today: the network call first
and outside the transaction, so a WorkOS failure aborts before anything is
written. For *moving* people between orgs the order is different — §11.3.

---

## 11. The enterprise tier: verified domains and claims

Nothing here is needed for v1. It is written down now because one part of it —
a workspace moving between orgs — constrains v1 (§11.7).

### 11.1 The timeline

A year after §3, Acme has three orgs on `acme.com`: **Acme** (Asha, 80 people),
**Acme Design** (Carol, 12) and **Sam's** (one person, whose workspace is also
called "Acme"). Acme's IT team wants one org they control.

1. **Choose the org that stays.** Nearly always the largest, so the fewest people
   move: Acme. Asha makes **Dan**, from IT, an admin of the default workspace,
   which makes him org admin. Dan need not be the founder.
2. **Dan verifies `acme.com`** (§11.2). It is now *verified*, not merely approved,
   and belongs to Acme alone.
3. **Dan sees every org on the domain:** Acme Design (12) and Sam's (1). They have
   already dropped to invite-only (§4.4).
4. **Dan claims them** (§11.3). Their workspaces move under Acme; nobody's data
   moves, and nobody's device re-syncs.
5. **Dan locks the domain** (§11.4). New orgs from `acme.com` are refused.
6. **SSO** (§11.5). Dan connects Okta and requires it for `acme.com`.
7. **SCIM** (§11.5). When HR removes Bob from the directory, Bob is deactivated.

### 11.1a Built: WorkOS-verified domains (2026-09-26)

The verified tier ships first through WorkOS itself. A domain verified on an org
in the WorkOS dashboard (by us) or its Admin Portal (by the customer's IT) makes
WorkOS add every matching sign-in to that org by itself. Relayed keeps a copy —
`organization_domains.source = 'workos'`, migration 036 — so it can show the
domain and never contradict it:

- **Synced** from WorkOS's organization API at sign-in, for the orgs the person
  belongs to, and whenever an org's page reads its domains. An in-app approval of
  the same domain on the same org is upgraded to the WorkOS row; our WorkOS rows
  WorkOS no longer has are dropped. Not yet through the poller's events: the event
  names are to be confirmed against WorkOS's docs first, because the poller asks
  for a fixed list and a wrong name could stop every poll.
- **Exclusive**: verified rows win over any other org's in-app approval of the
  same domain (§4.4).
- **Read-only in Relayed**: removing it is refused (`managed_in_workos`); the org
  page shows "Verified · managed in WorkOS".
- **Labelled**: someone WorkOS added by domain is offered the org's open
  workspaces as "Your company", like a domain match.

Onboarding a customer is: they create (or we pick) their org, we verify their
domain on it in WorkOS, and everyone who signs in after lands on it.

### 11.2 Verifying a domain

DNS verification through WorkOS's organization domains: its Admin Portal issues
and checks the TXT record, and the poller watches the verification events
alongside the membership ones it handles today. Verifying sets
`organization_domains.verified_at`.

At most one org holds a domain verified — a partial unique index, which refused a
second verification in the spike (check 3.2). The moment it is set, in one
transaction:

- the same domain's rows on every other org are deleted, so those orgs stop
  appearing in `org_matches` and go back to invite-only
- nobody is removed from anything; members of those orgs keep working until a
  claim moves them

Verification also lifts §4.2's mailbox rule for that org: Dan may verify
`acme.io` without an `acme.io` address, because DNS proves more than a mailbox.

### 11.3 Claiming another org

A claim moves every workspace of the claimed org under the verified org, then
deletes the claimed org. Eligible: any org with at least one member whose email is
on the verified domain.

**The order is load-bearing.** Three steps, and the spike broke each wrong order:

1. **WorkOS: add** every human of the claimed org to the verified org
   (`addMember`), writing each `workos_memberships` row as it goes (§6).
2. **Our database, one transaction:**
   - **Rename clashing slugs.** `workspaces` is `UNIQUE (org_id, slug)`; Sam's
     "Acme" could not move into an org that already has one (check 6.3). Suffix
     the slug (`acme-2`) and keep the name.
   - **Keep each workspace's icon.** A workspace with no image of its own shows its
     org's (`resolveMemberships`), so a claimed Acme Design would suddenly show
     Acme's (check 6.9). Copy the old org's `avatar_url` onto any workspace whose
     own is null.
   - **Move `org_id` on every table that references `organizations`** — today
     `workspaces`, `actors` (humans *and* agents) and `spaces`. `spaces.org_id` is
     `ON DELETE CASCADE`: moving only workspaces and actors, as the first draft of
     this section did, deleted every space, chat and message of the claimed
     workspace **silently** when the old org was deleted (checks 6.1, 6.2). A test
     reads the foreign keys from `pg_constraint` so a future table cannot be
     forgotten.
   - Drop the claimed org's approved domains, and delete the org row.
3. **WorkOS: remove** them from the claimed org (`removeMember`, a wrapper
   `management.ts` does not have yet).

Removing first — the first draft said "WorkOS first" — deactivates the very people
being moved: the removal arrives as `organization_membership.deleted`, and the
poller's `deactivate` finds their actors through `actors.org_id`, still the old org
until step 2 runs (check 6.4). In this order the event arrives when nothing in our
database points at the old org any more, and matches nobody (check 6.5).

**What people see:**

- **Nothing re-syncs.** `workspace_id` does not change, and no replica row carries
  `org_id`. `welcome` and catch-up on the workspace, space and chat streams returned
  byte-identical results before and after the claim (check 6.6).
- **Sessions are not revoked.** The next `/auth/refresh` — within the access
  token's 15 minutes — reads `org_id` from the actor row and issues a token for the
  new org, same workspace; the membership wire carries the new `org_id`, and
  `account.db` overwrites it on conflict (check 6.7). Revoking would be worse: a
  refused refresh leaves the desktop `stale` until the person signs in again
  (`session.ts`, `activate`).
- **Admins.** The claimed org's admins stop being org admins — their workspace is
  not the default of the verified org (§6). They keep every workspace role: Carol
  still owns Acme Design.
- **Join policy is kept.** Acme Design was `org_open` in its own org, so it becomes
  browsable by all of Acme. Whether a claim should reset it to `invite_only` is §16
  question 7.

Two ways to run it, both from Notion:

| Mode | When | What the claimed org sees |
|---|---|---|
| **Claim** | Orgs with more than one member | A notice to its admins, then the move after a fixed window |
| **Request transfer** | Single-member orgs | A request its one member accepts or declines |

Slack Enterprise claims without asking. Which to default to is §16 question 6.

### 11.4 Locking the domain

With `organization_domains.locks_creation = true` on a verified domain:

- `POST /auth/workspace` without `org_id` is refused `domain_locked` for anyone
  whose email is on the domain. Onboarding shows *Contact your Acme admin* and the
  org's name, as Slack does for claimed domains.
- `org_matches` returns only the verified org.
- Invitations *out* of the company are untouched: Asha can still be invited to
  Meera's Studio. Stopping that is Slack's Connect restriction, and out of scope.

### 11.5 SSO and SCIM

- **SSO:** a WorkOS SSO connection on the verified org, required for its domains.
  Someone who signed in with Google is sent through Okta next time. Their WorkOS
  user is the same — identity is the user id, never the email (`DESIGN.md` §6.2) —
  so their actors and history carry over untouched. New people are created on
  first SSO sign-in with `provisioned_by = 'sso_jit'`, already reserved.
- **SCIM:** WorkOS Directory Sync. A user removed upstream arrives as an event;
  the poller deactivates their actors in every workspace of the org (as check 7.1
  showed for org removal), which refuses their next refresh. New directory users
  are *not* auto-joined to workspaces — they still land in the default on first
  sign-in.

This closes the known limitation of v1: without SCIM, someone who leaves Acme loses
their mailbox but keeps any refresh token they hold, and deactivation stays manual
— an admin removes them, exactly as for invited members today.

### 11.6 Enterprise endpoints and actions

| Endpoint | Action |
|---|---|
| `POST /org/:id/domains/:domain/verify` | `manage_domains`. Starts WorkOS verification; the poller completes it. |
| `GET /org/:id/claimable` | `claim`. Orgs with members on a verified domain. |
| `POST /org/:id/claims` | `claim`. Starts a claim or a transfer request. |
| `POST /claims/:id/accept`, `…/decline` | The claimed org's single member, for a transfer request. |
| `PATCH /org/:id/domains/:domain` | `manage_identity`. `locks_creation`, SSO requirement. |

`claim` and `manage_identity` are org-admin actions, and only meaningful on an org
holding a verified domain.

### 11.7 What this asks of v1

One rule: **nothing may treat a workspace's `org_id` as permanent.** In practice:

- no cache, key or client table keyed on `(org_id, workspace_id)` together
- the client reads `org_id` from the membership wire each refresh, never from
  what it stored at join
- server code finds a workspace's org by reading `workspaces.org_id`, not by
  carrying it from an earlier step — and **never from the access token's `orgId`**,
  which can name a deleted org for up to 15 minutes after a claim. Today nothing
  reads `Caller.orgId` and the socket authorises streams on `workspaceId` alone
  (check 6.8); this rule keeps it that way.
- every new table with a foreign key to `organizations` is moved by the claim —
  enforced by the `pg_constraint` test in §11.3

Everything else in this section is additive.

---

## 12. Schema

One server migration (`034_org_domains.sql`). The version the spike applied is
[`spikes/org-domains/034_org_domains.sql`](../spikes/org-domains/034_org_domains.sql)
(checks 1.2–1.4).

```sql
CREATE TABLE organization_domains (
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,                -- lower-cased
  approved_by     TEXT NOT NULL,                -- identity_id of the approving admin
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at     TIMESTAMPTZ,                  -- DNS, §11.2; null in v1
  locks_creation  BOOLEAN NOT NULL DEFAULT false, -- §11.4; meaningful only when verified
  PRIMARY KEY (org_id, domain)
);
-- The sign-in lookup: every org on a domain (§4.4).
CREATE INDEX organization_domains_domain ON organization_domains (domain);
-- Approval is shared; verification is exclusive (§11.2).
CREATE UNIQUE INDEX organization_domains_verified ON organization_domains (domain)
  WHERE verified_at IS NOT NULL;

-- Which workspace a WorkOS invitation was sent from (§5.2).
CREATE TABLE workspace_invitations (
  workos_invitation_id  TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_by_actor_id   TEXT REFERENCES actors(id) ON DELETE SET NULL,
  accepted_user_id      TEXT,        -- from WorkOS, learned at sign-in or join
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE workspaces ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'invite_only'
  CHECK (join_policy IN ('org_open','invite_only'));
ALTER TABLE organizations ADD COLUMN default_workspace_id TEXT REFERENCES workspaces(id);

-- 'system' is there since 022_system_agents.sql. The first draft of this doc was
-- written from 001 and left it out, which fails on every workspace (check 1.1).
ALTER TABLE actors DROP CONSTRAINT actor_prov;
ALTER TABLE actors ADD CONSTRAINT actor_prov
  CHECK (provisioned_by IN ('self_signup','invite','domain','sso_jit','scim','api','system'));
```

No role table (§6).

`verified_at` and `locks_creation` ship in v1 unused, so the enterprise tier adds
no migration to this table. Claims (§11.3) add an `org_claims` table for the
request-transfer mode and nothing else — the move itself is updates to existing
rows.

**Backfill for existing orgs:** each has exactly one workspace — it becomes
`default_workspace_id` and switches to `org_open` (it is the only one; nothing
changes for its members). Its owner is thereby the org admin. No domains are
approved. Existing invitations have no `workspace_invitations` row; with one
workspace per org that is unambiguous, and a missing row is read as "the default
workspace".

**Guests (§9)** add `'guest'` to `membership_role`, in the same or a following
migration.

No client migration: `org_is_admin` rides on the membership wire into
`account.db`'s existing membership rows, and nothing org-level syncs.

---

## 13. Sequences

### 13.1 Domain join (v1)

```
Ravi            Desktop               Server                      WorkOS
 │ sign in ────► AuthKit ─────────────────────────────────────────► verify
 │               │ POST /auth/session ► verify token, fetch profile ► user
 │               │                    │ no actor
 │               │                    │ email_verified, domain not public
 │               │                    │ organization_domains by domain
 │               │ ◄──── org_matches [Acme, Acme Design]
 │ picks Acme ──►│ POST /auth/join ───► re-check §4.1
 │               │                    │ addMember ───────────────────► membership
 │               │                    │ workos_memberships row (no wait for poller)
 │               │                    │ actor(domain) in the default workspace
 │               │                    │ joinPublicSpaces
 │               │ ◄──── session + memberships
 │ lands in Acme default workspace
```

### 13.2 Claim (enterprise)

```
Dan (Acme admin)      Server                                 WorkOS
 │ verify acme.com ──► start verification ───────────────────► Admin Portal, DNS TXT
 │                     poller: domain verified ◄──────────────── event
 │                     verified_at set; acme.com dropped from Acme Design, Sam's
 │ claim Acme Design ► 1. for each human: addMember(Acme) ────► membership
 │                        write workos_memberships row
 │                     2. one transaction:
 │                          rename clashing slugs
 │                          copy old org avatar to icon-less workspaces
 │                          workspaces, actors, spaces: org_id → Acme
 │                          drop approved domains; delete old org
 │                     3. for each human: removeMember(old) ─► membership.deleted
 │                     poller: deleted event matches no actor ◄─ event
Carol's desktop: next refresh → token with new org_id, same workspace_id, same replica
```

---

## 14. Edits other documents need

| Document | Edit |
|---|---|
| `PHASE-1-IDENTITY.md` | §2 and §9 decision 2: domain join by approved domain on a verified email, public domains excluded, pointing here. §3 and §9 decision 3: several workspaces per org. |
| `AUTHZ.md` | The `organization` scope and its actions; the derived org grant in `loadGrants` (§6.1); org admins inherit nothing below. §9: invitations name their workspace. |
| `DESIGN.md` | Tenancy diagram: org → workspaces, default workspace, join policy. A workspace may change org by claim (§11.7). |
| `STORAGE.md` | `org_is_admin` on the membership wire; `org_id` re-read each refresh; *Browse workspaces* in the switcher. |
| `AGENTS.md` | This document and the spike in the tables. |

---

## 15. Build plan

**v1**

1. **Schema and backfill.** §12, with a test that an existing org comes out with
   one `org_open` default workspace whose owner is org admin.
2. **Admission.** `admissible()` behind both `pendingJoins` and `joinWorkspace`
   (§5.1); `workspace_invitations` written by `POST /invitations` (§5.2). Tests:
   an org member cannot join an `invite_only` workspace; an invitation offers only
   its own workspace and the default. This fixes a hole that opens the moment an
   org has two workspaces, so it lands **before** step 6.
3. **Authz.** `organization` scope in `packages/authz`, the derived grant in
   `loadGrants`, `can()` tests for admin/member and for no inheritance downward.
4. **Domain rules.** Public list, §4.1 matcher, §4.2–§4.3 on approval — pure
   functions, unit-tested with `acme.com`, `mail.acme.com`, `GMAIL.com`,
   unverified email, and two orgs approving one domain.
5. **Sign-in and join.** `email_verified` in `fetchProfile`; `org_matches` with
   every matching org in `/auth/session`; the domain admission path; writing the
   `workos_memberships` row on `addMember`.
6. **Creation.** Split `createWorkspace`; `org_id` on `/auth/workspace`; the
   admin check.
7. **Org endpoints.** Domains, browse, join policy, default workspace.
8. **Desktop.** Onboarding match list above *Create*; *Browse workspaces* and a
   gated *Create workspace* in the switcher; an org settings page for domains and
   workspaces.
9. **Guests** (§9).

**By hand:** two isolated clients (`MULTI-CLIENT-DEV.md`) signed in as two
addresses on one real company domain — Google sign-in needs real accounts, so a
domain we control with two mailboxes. Walk §3 top to bottom, including Bob, Carol,
Kiran's invite-only workspace, Meera and Dev.

**Enterprise, when the first customer asks**

10. **Verification.** WorkOS domain verification, the poller event, dropping the
    domain from other orgs.
11. **Claim.** §11.3 in its order, the `removeMember` wrapper, and the
    `pg_constraint` test. Port spike checks 6.2–6.9 into `node --test`, including
    that a device holding the claimed workspace keeps its replica and resumes from
    its cursor.
12. **Lock.** `domain_locked` on creation; onboarding's *Contact your admin*.
13. **SSO and SCIM.** WorkOS connections, `sso_jit`, deactivation from Directory
    Sync.

---

## 16. Open questions

1. **DNS before domain join?** Proposed: no (§2, §4.2), as every product in §2.1.
2. **May an `acme.com` non-admin create a separate org?** Proposed: yes, until the
   domain is locked (§7.2, §11.4).
3. **Who may change the default workspace?** It changes who the org admins are
   (§6). Proposed: an org admin who is also an admin of the new default.
4. **Land in the default workspace, or choose from a list?** Proposed: land in the
   default (§5).
5. **Should existing orgs' single workspace become `org_open`?** Proposed: yes — it
   changes nothing until a domain is approved, and without it the first approved
   domain admits people to nothing.
6. **Claim without asking, or ask first?** Proposed: Notion's split (§11.3) — claim
   multi-member orgs after notice, ask single-member ones.
7. **Should a claimed workspace keep `org_open`?** Acme Design becomes browsable by
   all of Acme. Proposed: keep it, and show the claiming admin the list of
   workspaces that will become browsable before they confirm.
8. **Approve the domain at creation?** Bob, in §3, slipped through the gap between
   Asha creating Acme and approving `acme.com`. A pre-ticked *Let anyone at
   acme.com join* on the create screen would close it. Proposed: yes.
9. **Request to join?** An Acme employee who sees no match could ask an org that
   has members on their domain but has not approved it. It reduces duplicate orgs
   and reveals that an org exists. Proposed: not in v1.

---

## 17. Evidence

[`spikes/org-domains/`](../spikes/org-domains/README.md), run 2026-09-26: 27
checks, 15 pass, 12 findings, 0 failures. Every finding is folded in above.

| Checks | What they showed | § |
|---|---|---|
| 1.1–1.4 | The migration applies to real data once `'system'` is kept | 12 |
| 2.1 | Two workspaces in one org keep memberships and streams apart | 2 |
| 2.2–2.4 | Today's join path admits any org member to any workspace; invitations do not name one | 5.1, 5.2 |
| 3.1–3.3 | Shared approval, exclusive verification, approval rules | 4, 11.2 |
| 3.4 | `fetchProfile` drops `email_verified` | 4.1 |
| 4.1 | Domain join works through today's `joinWorkspace`; the mirror lags one poll | 6, 10 |
| 5.1–5.4 | `org_roles` duplicates the WorkOS mirror; "admin of the default workspace" answers identically and always has an admin | 6 |
| 6.1–6.5 | A claim must move `spaces`, rename clashing slugs, and remove from WorkOS last | 11.3 |
| 6.6–6.8 | Sync, refresh and old tokens are unaffected by a claim | 11.3, 11.7 |
| 6.9 | A claimed workspace would inherit the new org's icon | 11.3 |
| 7.1 | Removal from an org deactivates in every workspace of it | 8 |

Not covered by the spike, and to be checked when built: the desktop's handling of
the new wire fields, onboarding UI, and whether WorkOS exposes the accepting user
on an invitation (§5.2).

---

## 18. As built

v1 — build plan steps 1 to 8, minus guests (step 9) — is implemented and
uncommitted. Migration `apps/server/src/db/migrations/034_org_domains.sql` was
checked against a copy of the dev database (39 orgs, 1,024 actors) before it was
installed. Tests: `provisioning/org-domains.test.ts`, `provisioning/domains.test.ts`,
`org/routes.test.ts`, and `packages/authz` for the new scope.

Where the build refined the text above:

- **Arriving shows every open workspace; being in the org shows none.** Someone
  with no workspace in an org is offered all of its open workspaces, default
  first (§5). Once they have one, the rest are under *Browse*, so a refresh never
  keeps asking.
- **Why an option is offered is on the wire** (`reason`: invited, or already in
  the org — which WorkOS does by itself for a domain verified in WorkOS), with
  its logo and whether it is the default.
- **Invitations are scoped per workspace when listed and revoked**, not only when
  accepted: WorkOS lists them per org, and an admin of one workspace must not see
  or revoke another's. One with no `workspace_invitations` row belongs to the default.
- **The membership wire carries `org_name`, `org_is_admin` and
  `workspace_is_default`.** The switcher groups by org from `account.db`
  (migration v4) and so still draws offline.
- **`/org/matches`** is the signed-in counterpart of the session's `org_matches`
  and `pending_joins`: asked when the switcher opens, and by the join screen.
- **Making a workspace the default refreshes the session at once**, so the
  switcher's admin flags move with it rather than on the next token expiry.
- **Domains are stored bare and lower-cased**, enforced by a CHECK as well as the
  one writer.

Desktop: onboarding lists company matches beside invitations; the join screen
works signed in as well as during onboarding (it used to bounce a signed-in person
to "create"); the switcher groups by org with *Browse* / *Manage* and *Join your
team*; `/org/:orgId` lists the org's workspaces and domains, with admin controls
for join policy, the default and domain approval; "create" takes `?org=`.

Not yet done: the edits to other documents in §14, guests (§9), and the
enterprise tier (§11).

