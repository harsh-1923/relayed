# Authorization

How the system decides who may do what, and why that decision is made in one
place. Companion to [`DESIGN.md`](DESIGN.md) §6.3 (actors), §6.4 (delegation)
and §7.3 (membership and access), which this document extends rather than
replaces.

Written before invitations, because invitations are the first feature that has
to answer "is this person allowed to" and there is currently no answer.

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| Who owns role? | **We do.** WorkOS owns org membership; it does not govern our actions | 8 |
| Where is a permission decided? | **Server, authoritatively. Client, advisorily.** Two sites, one model | 3 |
| What shape does a permission take? | A **relation between a subject and an object** — a tuple, not a flag | 4 |
| How many places call it? | **One.** `can(actor, action, object)` | 7 |
| Do we adopt FGA now? | **No.** The model is small enough for SQL and the client needs a local projection either way | 10 |
| What makes us adopt it? | **Agent delegation** (§6.4), not more roles | 10 |

---

## 2. Goals and non-goals

### Goals

1. **Invitations can ask whether someone may invite**, and get a local answer.
2. **The client can decide offline** what to render — no permission check ever
   requires the network.
3. **One evaluation point per side.** Swapping the engine touches one file, not
   every route.
4. **The model ports to a relationship engine unchanged.** Not "we could migrate
   if we rewrote it" — the tuples and the action vocabulary are the same on both
   sides of that change.
5. **Authorization survives leaving WorkOS.** If AuthKit is replaced tomorrow,
   nothing about who-can-do-what moves with it.

### Non-goals

- **A policy language.** No per-workspace custom roles, no rule editor. The
  action vocabulary is closed and small (§6), and stays that way until something
  concrete forces otherwise.
- **Running OpenFGA now.** Deferred with a named trigger, not indefinitely (§10).
- **Attribute-based rules** — "only during business hours", "only from this IP".
  Time-boxing exists for delegation (§6.4) and nowhere else.

---

## 3. Two evaluation sites, and only one of them is authoritative

This is the constraint that shapes everything else, and it is a consequence of
being local-first rather than a preference.

```
SERVER   authoritative.  Every write, every socket subscribe, every backfill.
                         Denies. Never trusts the client.

CLIENT   advisory.       Renders or hides an affordance. Must work OFFLINE,
                         so it can never call anything to find out.
```

**The client never grants.** It hides a button it believes is unavailable, and
the server re-checks the write that button would have produced. A client that
gets it wrong shows a control that fails on use — annoying, and not a security
hole. A design where the client's answer is trusted has no way to be safe,
because the client is a distributable binary on a machine we do not control.

### Why this rules out calling an authorization service from the client

A Zanzibar-style engine answers checks over the network. The client cannot ask
it anything: the aeroplane case (R3) is not an edge case here, it is the product.

So **the client needs a replicated local projection of permissions no matter
what computes them on the server.** `memberships` in the client schema (§8.3) is
that projection. This is the reason adopting an external engine does not remove
client work — it adds a second replication problem beside the one Phase 2 is
already building.

---

## 4. A permission is a relation, not a flag

`DESIGN.md` §7.3 already has the right shape:

```
memberships(scope_type, scope_id, actor_id, role, joined_at, left_at)
```

Read it as a triple and it is a relationship tuple:

```
   subject          relation        object
   actor_id    —      role      →   scope_type:scope_id

   act_01H…    —      admin     →   space:spc_01H…
```

That is the same shape a Zanzibar-derived engine stores. Keeping it means the
migration in §10 is a change of evaluator, not a change of data model.

**What this forbids, concretely:**

- No `is_admin BOOLEAN` on `actors`. A boolean is not a relation and does not
  say *of what*.
- No role encoded in application code (`if (actor.id === workspace.owner_id)`).
  The owner is a row, like everyone else.
- No permission derived from a column on the object (`chats.created_by`).
  Creation is a fact; the permission it implies is a tuple.

---

## 5. Scopes

Three levels, matching the containment in §7.1 exactly. Containment is what
makes derivation possible (§6), and an authorization hierarchy that disagreed
with the data hierarchy would need every rule spelled out twice.

```
workspace            ← added here; §7.3 covered only the two below
  └── space          channel or room
       └── chat      rows exist ONLY for private chats (§7.3)
```

`scope_type ∈ 'workspace' | 'space' | 'chat'`.

The absence of a row is meaningful and differs by level: no `chat` row for a
public chat means access derives from the space, while no `space` row means no
access at all. That asymmetry is §7.3's and is preserved.

---

## 6. Roles and actions

Both vocabularies are **closed sets**, and both are the relation set an FGA
model would declare. Keeping them closed is what makes the model portable and
what stops authorization becoming a policy language by accretion.

### Roles

| Role | Valid on | Meaning |
|---|---|---|
| `owner` | workspace | Founded it, or was handed it. Exactly one per workspace |
| `admin` | workspace, space | May change who else may do things |
| `member` | workspace, space, chat | Belongs, and may act within it |

### Actions

| Object | Action | Who |
|---|---|---|
| workspace | `invite` | admin, owner |
| workspace | `manage_members` — remove, change role | admin, owner |
| workspace | `create_space` | any member |
| workspace | `transfer_ownership` | owner |
| space | `read` | any member (of the space) |
| space | `add_member` | any member — §7.3, deliberate |
| space | `create_chat` | any member |
| space | `make_public` | admin only — §7.3, deliberate asymmetry |
| space | `promote` | admin |
| chat | `read` | derived (§7) |
| chat | `post` | derived |
| chat | `edit_own`, `delete_own` | the author |
| chat | `delete_any` | space admin |

The `add_member` / `make_public` asymmetry is §7.3's and its reasoning belongs
there: adding one person and exposing everything to the workspace have very
different blast radii.

**Adding an action is a deliberate edit to this table**, the same discipline the
telemetry catalogue uses (`OBSERVABILITY.md` §8). An action that exists only as
a string in a route is one that cannot be modelled later.

---

## 7. Derivation, and the one function that evaluates it

Some permissions are stored; most are derived. The derived ones are exactly what
a relationship engine expresses natively, so they are written here as rules
rather than scattered through queries.

```
member(actor, workspace)  ⟸  ∃ membership(workspace, workspace_id, actor, _)

member(actor, space)      ⟸  ∃ membership(space, space_id, actor, _)
                              ∧ member(actor, space.workspace_id)

access(actor, chat)       ⟸  member(actor, chat.space_id)
                              ∧ (chat.kind ≠ 'private' ∨ ∃ membership(chat, chat.id, actor, _))
```

The third is §7.3's access predicate unchanged. **Space membership is the
leading conjunct**, structurally: an actor removed from a space cannot retain
access to a private chat inside it, and that property is a consequence of the
expression's shape rather than a rule anyone has to remember.

### Workspace admin does NOT inherit space admin

A deliberate no. A workspace admin can `manage_members` and `invite`; they
cannot read a private room they are not in, and cannot make it public.

The alternative — admin sees everything — is defensible for compliance and
indefensible as a default: it would mean a private room's confidentiality rests
on trusting whoever happens to hold an admin role. Should compliance ever
require it, it arrives as an explicit, audited action, not as an ambient
inherited power.

### `can()`

One function, server-side; one mirror of it, client-side.

```ts
can(actor, action, object) → boolean
```

**No route, handler or query may test a role directly.** `if (actor.role ===
'admin')` inlined in a route is the thing that makes §10 a rewrite instead of a
file. This rule is the entire price of keeping FGA optional, and it is worth
paying while there are two call sites rather than fifty.

The client's mirror answers from its replicated `memberships` and is allowed to
be wrong in one direction only: it may hide something permitted, never permit
something denied (§3).

---

## 8. What WorkOS owns, corrected

`DESIGN.md` §6.2 assigns "org membership + role" to WorkOS. That is half right
and the half that is wrong matters.

| Concept | Owner | Why |
|---|---|---|
| Organization, SSO, Directory Sync | **WorkOS** | Unchanged |
| Org membership — *is this user in this org* | **WorkOS** | Invitations and SCIM both attach to it |
| `OrganizationMembership.role_slug` | WorkOS, **mirrored, never checked** | An input, not an authority |
| Workspace/space/chat role — *what may they do* | **Us** | §2 goal 5 |

WorkOS's role is **mirrored onto our membership when it changes and never
consulted at check time.** Two reasons, and the second is the load-bearing one:

1. Every check would otherwise be a network call, which §3 has already ruled
   out for the client and which would put an external dependency on our write
   path server-side.
2. Authorization must survive leaving WorkOS. Every other WorkOS concept here is
   replaceable in an afternoon because nothing below Layer 2 references it
   (§6.3). A role consulted at check time would be the one exception.

The cost is a mirror that can drift, bounded by how promptly it updates — and
it updates by **polling WorkOS's Events API**, not by webhook. That choice is
§10.1; the short version is that a cursor over a durable log cannot miss an
event, and a webhook can.

---

## 9. What invitations need from this

Small, and it is the point of writing this first:

1. `can(actor, 'invite', workspace)` — a local check, no WorkOS call.
2. A `memberships` row at workspace scope, with the founder as `owner`.
3. On accept, a `member` row for the new actor and a handle chosen **in that
   workspace** — the first time a collision is reachable, and the call site the
   `handle.collision` metric is reserved for.

Note what is *not* needed: an `is_admin` flag, a role on `actors`, or a WorkOS
role lookup. The invitation flow reads exactly one table.

### 9.1 We do not own acceptance, and cannot

Worth stating because the first design here assumed the opposite. WorkOS's
invitation email links to **AuthKit's hosted page** — `accept_invitation_url` is
on the `authkit.app` domain — so the `OrganizationMembership` exists before the
app is ever opened and we are never asked. There is no accept endpoint of ours
to build.

Which makes this reconciliation rather than a flow we drive, and it arrives two
ways:

| | |
|---|---|
| **`/auth/session`** | asks WorkOS directly. The correctness backstop: a fresh install has no mirror, and the poller may never have run |
| **`/auth/refresh`** | reads the local mirror. Free, so it runs every few minutes — which is what lets someone who accepts while already signed in see it without signing out |

The actor is still not created by either. A handle is required, handles are per
workspace, and this is the first point in the product where one can already be
taken — so the client is told what is pending and the person chooses.

**One consequence to expect:** the loopback redirect at the end of that hosted
flow lands on a port nothing is listening to, because the listener only exists
while a sign-in is running *in the app* and this one began in an email. The code
in that URL is simply unused. `/welcome` exists so a successful acceptance does
not end on a browser error page.

---

## 10. Deferring FGA — the trigger, and what changes when it fires

### 10.1 A related decision, made the same way: polling over webhooks

Not FGA, but the same shape of question — take the push-based integration, or
own the correctness.

WorkOS has a pollable **Events API**: cursor paging over a durable, ordered log.
Measured against webhooks for our case:

| | Events API | Webhooks |
|---|---|---|
| Can an event be missed? | **no** — the cursor does not move until it is applied | yes, if the endpoint is down |
| Ordering | **total, by cursor** | not guaranteed |
| Replay after a bug | **rewind the cursor** | ask WorkOS to resend |
| Idempotency | **the cursor is the dedupe** | build it yourself |
| Public endpoint, signature verification | not needed | required |
| Latency | poll interval | ~instant |

**Webhooks buy latency and cost consistency.** They are at-least-once and
unordered, so a webhook-only design needs a reconciliation pass anyway and you
end up building both. A cursor over a durable log *is* the consistency
mechanism — the same reason `synced_through_rev` advances across contiguous runs
rather than trusting each event to arrive (DESIGN.md §8.1).

For us the latency difference is a poll interval against instant, where the
alternative we were living with was **one access-token TTL**. Polling is a 30×
improvement, not a compromise.

Webhooks become right when something needs sub-second reaction — a
deprovisioning that must cut a live socket rather than wait a poll. That is a
Phase 6 concern, and it would sit *beside* the poller, not replace it: the
reconciliation stays either way.

### Why not now

The whole access model is §7's three rules. That is a `WHERE` clause, and SQL
evaluates it correctly, locally, and inside the transaction that needs the
answer. An external engine at this size adds a service to run, a network hop on
the write path, and a second store that can disagree with the first — in
exchange for expressiveness nothing currently needs.

And per §3 it would not reduce client work, because the client needs a local
projection regardless.

### What makes us adopt it

**Agent delegation (§6.4), not more roles.** The check is

```
access(agent, chat) ∧ access(principal, chat) ∧ valid_delegation(agent, principal, chat, now)
```

— an intersection of two derived permissions, scoped to a chat and bounded in
time, over an action vocabulary that grows with what agents can do. Derived
relations with intersection are what Zanzibar-derived engines exist for, and are
where hand-rolled SQL stops being pleasant and starts being subtly wrong.

That is Phase 6. The trigger has a name and a place in the build order rather
than being "when it gets complicated".

### What changes, and what does not

| | |
|---|---|
| **Changes** | the body of `can()`; a dual-write of tuples on permission-changing writes |
| **Unchanged** | the `memberships` table, the scope hierarchy, the action vocabulary, the client projection, every call site |

### The cost, stated now rather than discovered later

Adopting a relationship engine makes it a **hard dependency on the write path**:
every permission-changing write must also write tuples, and two stores can then
drift. Zanzibar answers this with consistency tokens; whichever engine we choose
brings its own version of that problem. This is not an argument against it — it
is the reason the trigger should be a concrete need rather than anticipation.

### Engine choice, deliberately deferred

WorkOS sells an FGA product; OpenFGA is its open-source, Zanzibar-derived
alternative. Choosing now would put a vendor in the one layer that touches every
write path — the same lock-in argument that decided OTel
(`OBSERVABILITY.md` §1). A clean `can()` keeps the decision **reversible**;
making it today makes it structural.

---

## 11. Shapes that must exist now — built

The whole cost of keeping §10 cheap. None of it was speculative: every item was
needed by invitations anyway.

- [x] `memberships(scope_type, scope_id, actor_id, role, joined_at, left_at)`
      server-side, `scope_type` including `'workspace'`, with a partial unique
      index enforcing exactly one owner per workspace
- [x] `can(actor, action, object)` and **no role test outside it**
- [x] The client mirror, answering from replicated state, never the network
- [x] Actions and roles as closed unions in one file, mirroring §6's tables
- [x] `OrganizationMembership.role_slug` mirrored, never read at check time

One thing turned out better than planned. The plan was for the client to hold a
second implementation kept in step by shared fixtures; instead the evaluator
lives in **`packages/authz`** and both sides import the same function. Sharing
the code is strictly stronger than sharing fixtures — there is no second
implementation to drift.

The client's projection is narrower than the eventual shape: `account.db` holds
`actor_role` for the workspace tier only, because spaces and chats do not exist
yet. Space and chat grants join it in Phase 2, and the evaluator already takes
them.

---

## 12. Validation

### 12.1 The spike

`spikes/authz-model.mjs` and `spikes/authz-tests.mjs`, in the manner of
`spikes/sync-model.mjs` — an executable model rather than an argument.

`pnpm spike:authz` — **37 assertions, all green.**

The spike exists to test **one claim**, which is the claim this document rests
on: that the access rules can be evaluated as relationship tuples and give
identical answers to the direct implementation. If they diverge on any input,
§10 is wishful thinking and better discovered now than in Phase 6.

So the model contains the rules **twice**, deliberately — once as the SQL-shaped
branching a server writes today, once purely from `(subject, relation, object)`
tuples plus the derivation rules in §7 — and compares them across all 232
combinations of actor, object and action.

| Test | Asserts |
|---|---|
| **Equivalence** | over every combination of workspace/space/chat membership, role and chat kind, the direct evaluator and the tuple evaluator agree — this is the portability claim, executed |
| **Leading conjunct** | removing an actor from a space denies every private chat inside it, without touching a chat row |
| **Private chat needs both** | space membership alone does not grant a private chat; a chat row alone does not either |
| **No admin inheritance** | a workspace admin is denied read on a private space they are not in (§7) |
| **Asymmetry holds** | any member may `add_member`; only an admin may `make_public` |
| **Delegation intersects** | an agent is denied where its principal is denied, even when the agent itself is a member |
| **Delegation is chat-scoped** | a grant in chat C does not grant chat D in the same room (§7.3) |
| **Delegation expires** | a grant valid at T is denied at T+n, with no membership change |
| **Role change is a tuple change** | promotion alters exactly one row and no chat or message row |

The last four cover Phase 6 behaviour deliberately. They are cheap to model now
and they are precisely the rules FGA is being held in reserve for — if the shape
cannot express them on paper, the deferral is wrong.

#### The equivalence test passed for the wrong reason first

Worth recording, because it is the failure mode this whole spike could have had.

The first fixture had every space member also a workspace member — the only
states that occur in practice. Under it, **deleting the containment check from
the tuple evaluator entirely left the suite green**: with no actor who is in a
space but not the workspace, containment changes no answer, and "the two agree"
is satisfied by two evaluators that were never asked a distinguishing question.

Found by a negative control, not by reading. The fixture now includes two states
that should never occur — an orphaned space membership with no workspace row,
and an actor who left the workspace while holding space and chat rows — because
those are the only inputs on which the rule is observable. Both controls now
fail, in both directions: breaking either evaluator breaks the equivalence.

An agreement test is only as strong as the disagreement it could have detected.

### 12.2 Beyond the spike — what is built

| Test | Status |
|---|---|
| The **shipped** evaluator agrees with the spike model, exhaustively | **done** — the same fixture through both, so the spike validates the code rather than only the document |
| A client with **fewer** grants can never permit more than the server | **done**, as a property: every subset of the server's grants is enumerated |
| A lower role never permits more than a higher one | **done** |
| An unknown action, an action from another scope, an unplaced object | **done** — all denied, never defaulted |
| Client and server agree | **moot** — they run the same function (§11) |
| No source file outside the authz module matches `role ===` | **not built.** A lint rule, in the manner of the `console.*` ban (`OBSERVABILITY.md` §6) |
| A denied write is denied server-side **even when the client permitted it** | **not built.** §3's contract, and the one that actually matters |

The last two are the gap, and the first of them is worth more than it looks. A
rule written down is not a rule enforced: the trap recorded in
`PHASE-1-IDENTITY.md` §11a — attaching a rejection handler after an await — was
walked into again while writing tests for the sign-in cancel path, by the person
who wrote it down. Prose does not hold a boundary; a lint rule does.

---

## 13. Invariants

To fold into `DESIGN.md` §14. Numbering continues from 47.

| # | Invariant | What breaks without it |
|---|---|---|
| 48 | Every permission check goes through `can()` | Swapping the evaluator becomes a rewrite; rules drift between call sites and no two agree |
| 49 | The client may **hide** a permitted action, never **permit** a denied one | A distributable binary decides its own permissions |
| 50 | Space membership is the **leading conjunct** of chat access | An actor removed from a space keeps a private chat inside it |
| 51 | A workspace role never inherits space-level read | A private room's confidentiality rests on trusting every admin |
| 52 | WorkOS `role_slug` is mirrored, **never consulted at check time** | Authorization stops surviving the removal of WorkOS, and every check becomes a network call |
| 53 | A permission is a row in `memberships`, never a column on the object | The model stops being tuples and stops porting to a relationship engine |
| 54 | A teardown **settles** every promise it abandons | An abandoned sign-in has no exit; callers wait for ever on a listener that is already gone. Not an authorization rule, but discovered building this and recorded where the others are |

---

## 14. Open questions

1. **Ownership transfer on deprovisioning.** The WorkOS event poller now
   deactivates an actor on `user.deleted`, which means it can remove the sole
   `owner` of a workspace and leave it unadministrable. The partial unique index
   permits zero owners; nothing yet decides who inherits. §7.3 solves the room
   case by letting the creator promote others; the workspace case is open, and
   is now reachable rather than hypothetical.
2. **Agent action vocabulary.** §6 lists actions for humans. Agents need their
   own verbs (`invoke`, `read_history`, `post_as`), and `DESIGN.md` §16 item 10
   has been holding this open. It should be settled *with* the delegation
   design, not before.
3. **Guest / single-channel access.** Slack's most-requested shape and a real
   containment problem: a guest is a workspace member for exactly one space.
   Expressible in this model — a workspace row with a `guest` role — but the
   derivation rules in §7 would need a fourth case.
4. **Audit.** Every `can()` denial is a fact worth recording, and a permission
   change doubly so. Not built; the chokepoint in §7 is what makes it a
   one-file addition later.
5. **Space and chat grants on the client.** The replica holds only the workspace
   tier today, because that is all that exists. Phase 2 has to decide whether
   every membership replicates or only the caller's own — the second is smaller
   and is all `can()` needs, but rendering "who is in this room" needs the first.
