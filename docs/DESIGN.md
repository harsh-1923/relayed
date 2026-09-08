# Relayed — Design Document

> **Status:** Design baseline. This is the reference document for the planning and
> execution phases. Every non-obvious decision below is recorded with its
> rationale, because the rationale is what tells you whether a future change is
> safe.
>
> **Last updated:** 2026-09-08 · identity, delegation, and Rooms settled

---

## Table of contents

1. [Product](#1-product)
2. [Requirements](#2-requirements)
3. [What "local-first" means here](#3-what-local-first-means-here)
4. [Core architecture decision: sync engine, not CRDT](#4-core-architecture-decision-sync-engine-not-crdt)
5. [Process architecture](#5-process-architecture)
6. [Identity, tenancy, and access](#6-identity-tenancy-and-access)
7. [Spaces: channels, DMs, and rooms](#7-spaces-channels-dms-and-rooms)
8. [Data model](#8-data-model)
9. [Sync protocol](#9-sync-protocol)
10. [The write path](#10-the-write-path)
11. [The read path](#11-the-read-path)
12. [Unread counters](#12-unread-counters)
13. [Subsystem nuances](#13-subsystem-nuances)
14. [Invariants and failure modes](#14-invariants-and-failure-modes)
15. [Build order](#15-build-order)
16. [Open questions](#16-open-questions)

---

## 1. Product

**Relayed is the workspace of tomorrow — where humans and agents get together to
get work done.**

Slack is the workspace of today: it brought humans together to collaborate. The
organizations of tomorrow will increasingly have humans *and* agents working
side by side, as peers rather than as tools. Relayed is built for that from the
schema up.

**Slack is an inspiration, not a template.** We take the parts that earned their
place — channels, threads, the shared-history model — and build the parts that
are missing. Where Slack's design reflects its own history rather than a good
answer, we diverge deliberately and say so.

An agent here is not a bot integration bolted onto the side. It holds an
identity, joins spaces, reads history, posts messages, replies in threads, and
reacts. It appears in the same member lists and the same `@` namespace as a
person. The system's only structural knowledge of the difference is a `type`
field on the actor record (§6.3).

The product bet: if agents are first-class participants rather than webhooks,
collaboration between people and agents becomes a normal conversation with
normal history — rather than a series of one-off invocations with no shared
context.

### Why local-first

The other half of the bet is that the client owns its data. Every read is served
from a local database. The network is a sync channel, not a dependency of the
read path. This buys three things:

- **Latency.** Channel switches, scrollback, and search are local disk reads.
  There is no spinner, ever, for data you already have.
- **Resilience.** Plane, train, tunnel, flaky café Wi-Fi, VPN reconnect — the app
  keeps working. Not degraded: identical, minus new messages.
- **Agent throughput.** Agents reading conversation history hit local storage.
  An agent that needs to scan 500 messages for context does it in milliseconds
  without hammering a server.

### Non-goals

Explicitly out of scope for this design. Listed so nobody re-litigates them
mid-build.

| Non-goal | Reason |
|---|---|
| Peer-to-peer / serverless sync | We need fanout, auth, and durable ordering. A server is the right answer. Local-first refers to the **client**, not to the absence of a server. |
| Federation / Matrix compatibility | Our protocol, our server. Interop is a much larger design. |
| End-to-end encryption | Deliberately deferred. See §13.4. |
| Collaborative rich-text editing of a message | Real CRDT territory. Not a chat feature. |
| Voice / video | Different problem domain entirely. |
| Mobile clients | Desktop-first. The sync engine design is portable, the process model is not. |

---

## 2. Requirements

### Hard requirements

These three drove the entire architecture.

**R1 — A user can be a member of N channels.**
Membership is many-to-many and is itself synced state. All of a user's channels
are equally "live"; there is no notion of an active subscription that must be
opened to receive data.

**R2 — A user receives updates for every channel they belong to, whether or not
that channel is open in the UI.**
This is the requirement with the most architectural consequence. It means the
sync engine cannot live in the UI layer, and it means badge state must be
maintainable for channels whose messages we do not hold. See §5 and §12.

**R3 — Without internet, a user can read their data from local storage.**
The local database is the read path in *all* conditions, online and offline.
There is no separate "offline mode" — offline is simply the state where the
sync engine has nothing new to write.

### Scope decisions

Settled during design review. These are inputs, not conclusions.

| Dimension | Decision | Consequence |
|---|---|---|
| **Scale target** | Team scale — ~50 channels plus ~20 rooms per actor, giving **~150 chats**, moderate traffic | Gap markers and prioritized catch-up are needed. Aggressive tiering of live fanout is not. The cursor count scales with chats, not rooms (§9.9). |
| **Offline history** | Rolling ~90-day window | Retention and eviction are day-one subsystems, not later additions. Interacts with gap markers. |
| **Threads / replies** | In scope | Largest schema impact. Drives the two-counter model (§8.1). |
| **Reactions** | In scope | Needs a mutation-sync channel that does not disturb ordering or unread state. |
| **Edits / deletes** | In scope | LWW register + tombstones. Forces outbox coalescing (§10.4). |
| **Attachments** | In scope | Blob store, prefetch policy, two-phase offline upload. Highest risk of silently breaking the offline experience. |
| **Encryption at rest** | Not now | Plaintext SQLite in `userData`. Full FTS5 performance, no native module. Adopting it later costs a re-sync, not a migration (§6.6). |
| **Auth provider** | WorkOS | AuthKit for humans, M2M for agents, Pipes + Relay for third-party access (§6.2). |
| **Tenancy** | Org → workspace, but **one workspace per org in v1** | Schema carries `workspace_id`; the client is single-workspace. One workspace = one SQLite file = one cursor space (§6.1). |
| **Agent runtime** | Server-side service | Agents share the data model, not the transport. No local replica, no outbox, no cursors (§6.5). |
| **Rooms** | In scope, v1 | Scoped multi-chat spaces. Forces `chat` as the universal message container (§7.1); costs the sync engine nothing (§7.6). |
| **Delegation** | Intersection rule, RFC 8693 claim shape | Agents act on behalf of a human with a scoped, expiring grant. No chaining (§6.4). |
| **Offboarding** | Accepted exposure | Revocation stops sync; it does not recall data already on disk (§6.6). |

### Product surface implied by the above

Channels (public/private), membership, messages, threaded replies, message
edit/delete, emoji reactions, file and image attachments, unread and mention
badges, local full-text search, and desktop notifications — with humans and
agents as interchangeable participants throughout.

**Rooms** — scoped shared spaces containing multiple chats, each with its own
membership and lifecycle — are the major addition beyond Slack's model and are
specified in §7.

---

## 3. What "local-first" means here

The terms get conflated, and the difference determines where the source of truth
lives — which cascades into everything else.

**Offline-first** is a resilience strategy. The server is authoritative; the
client keeps a cache and a mutation queue so it degrades gracefully when the
network drops. Offline is the exception path.

**Local-first** is an architecture. The local replica is the primary copy for
reads and writes; the network is an optional sync channel. Offline is the normal
mode; being online just means sync is currently making progress.

Relayed is local-first **on the client** with a **server-authoritative log**.
That combination is deliberate and is not a contradiction:

- **Reads** are always local. The renderer never waits on the network to display
  anything. This is the local-first half.
- **Ordering and durability** are the server's job. There is one canonical
  order per channel, assigned by the server. This is what makes the system
  comprehensible and what makes 50-channel catch-up tractable.

The practical test: **if the server is unreachable, the app opens, renders every
channel, scrolls history, and searches — and writes queue locally without data
loss.** If the server disappeared permanently, the user retains a complete,
readable 90-day archive on disk.

### The read path is the invariant

```
              ┌────────────────────────────────────────┐
   ALWAYS:    │  UI  ──query──▶  local SQLite          │
              └────────────────────────────────────────┘

              ┌────────────────────────────────────────┐
   NEVER:     │  UI  ──fetch──▶  network  ──▶  render   │
              └────────────────────────────────────────┘
```

There is exactly one read path and it is local. This is what makes online and
offline behave identically from the UI's perspective, and it is the single rule
that most protects the local-first property over time. A feature that reads
granted data from the network is a bug.

**The scope of the rule is data the actor has access to.** That qualifier is
load-bearing, and stating it precisely is better than accumulating exceptions
later. Discovery surfaces — browsing public spaces you have not joined, or
searching the org directory for people you have never messaged — are *not*
covered, because that content is not yours until you join. Those are server
queries and always will be.

The distinction to hold: **not-yet-granted is outside the rule; already-granted
is never outside it.** A space you are a member of is fully local whether or not
it is open on screen, and stays readable when the network is gone.

---

## 4. Core architecture decision: sync engine, not CRDT

### The decision

**We do not use a CRDT library.** No Automerge, no Yjs. We build a
server-ordered log with client-side optimistic writes — the model Linear and
Slack both use.

### Why

The instinct with "local-first" is to reach for CRDTs. For chat this is the
wrong tool.

CRDTs solve **concurrent mutation of shared mutable state** — two people editing
the same paragraph, where you must merge without losing intent. Chat is
overwhelmingly an **append-only log**. Two people sending messages is not a
conflict; it is two messages. The hard problems in chat are *ordering*,
*catch-up*, and *idempotency*, none of which a CRDT solves for you.

The costs of using one anyway are real:

- A per-channel document accumulating 100k operations is slow to load and large
  on disk. Chat history is unbounded and append-heavy — the worst shape for a
  document CRDT.
- You inherit a schema migration problem with no good answer.
- You still need a server for fanout, auth, and presence. You pay CRDT costs
  without escaping server costs.
- Debugging convergence bugs in someone else's op-log is brutal.

### What we build instead

Every piece of state in Slack's feature surface decomposes into one of four
convergent types, all trivially hand-rollable:

| Data | Type | Why it converges |
|---|---|---|
| Messages | **Append-only log**, server-assigned per-chat ordinal | Two appends are never in conflict. Needs idempotency (op IDs), not merging. |
| Message body edits, channel name/topic | **LWW register** | Concurrent edit of the same message is a non-feature. Last write is correct and expected. |
| Read state (`last_read_ord`) | **Max register** | Critically *not* LWW. Take the maximum, never the latest — otherwise a stale device syncing late un-reads messages the user has read. |
| Reactions | **LWW-set keyed by `(message, emoji, actor)`** | The key contains the actor, so two different actors never conflict. Only the same actor on two devices can, and LWW is obviously right there. |

Ephemeral state (typing indicators, presence) is never persisted and never
synced through this machinery.

**This is the single highest-leverage decision in the document.** It removes a
dependency, a load-time cost, a storage cost, and a class of migration problems,
in exchange for roughly 200 lines of merge logic we fully understand.

---

## 5. Process architecture

### The decision

The sync engine — WebSocket **and** database — lives in a dedicated Electron
`utilityProcess`. Renderers talk to it over a **direct `MessagePort`**. The main
process brokers the initial handshake and then gets out of the way.

```
  ┌─ renderer: main window ──────┐   ┌─ renderer: 2nd window ───┐
  │  React. Pure subscriber.     │   │  React. Pure subscriber. │
  │  Holds NO authoritative      │   │                          │
  │  state.                      │   │                          │
  └──────────────┬───────────────┘   └────────────┬─────────────┘
                 │                                │
                 │   MessagePort (direct, after handshake)
                 │                                │
                 ▼                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  utilityProcess: the sync engine                            │
  │                                                             │
  │   • single WebSocket to the server                          │        ┌──────────┐
  │   • owns the SQLite file (node:sqlite, WAL)                 │◀──ws──▶│  server  │
  │   • cursors, catch-up scheduler, outbox, coalescing         │        └──────────┘
  │   • retention/eviction job, FTS maintenance                 │
  │   • blob download queue                                     │
  └────────────────────────────┬────────────────────────────────┘
                               │  lifecycle + port handshake only
                               ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  main process                                               │
  │   windows, tray, native notifications, auth/keychain,       │
  │   protocol handler for blob://, auto-update                 │
  └─────────────────────────────────────────────────────────────┘
```

### Why not the renderer

This is the most common mistake in Electron sync clients, and it makes **R2
structurally impossible**:

- The WebSocket dies on window reload — every dev-mode hot reload resets sync.
- It dies when the window closes, so a background/tray app stops syncing.
- Multiple windows means multiple sockets, multiple cursors, and racing writers
  against the same database.
- You only reliably sync what is mounted, which is precisely the thing R2
  forbids.

### Why a utility process rather than the main process

The main process is what keeps menus, tray, window creation, and native dialogs
responsive. Two properties of our workload make it a bad host for sync:

1. **`node:sqlite` is a synchronous API.** A catch-up batch writing several
   thousand rows blocks the calling thread for the duration. In main, that is a
   visible application stall.
2. **Search is unbounded.** An FTS query across a large corpus has no useful
   upper bound on latency.

A utility process also gives crash isolation and restartability: if the sync
engine wedges or throws on a malformed frame, we respawn it without killing the
app or losing the user's windows.

### Why `MessageChannelMain`

Without it, every read is `renderer → main → utility → main → renderer`. The
main process becomes a proxy on the hottest path in the application, which
defeats the point of moving work off it.

`MessageChannelMain` creates a port pair; main passes one end to the renderer
(`postMessage` with the port as a transferable) and the other to the utility
process. After that handshake, renderer and sync engine communicate directly and
main is not involved.

**Reload nuance:** a `MessagePort` does not survive a renderer reload. The
renderer must re-handshake on every load (`ipcRenderer.invoke('sync:attach')`),
and the utility process must track N live ports, detect closed ones, and clean
up their subscriptions. Handle this from the start; discovering it later means
mysterious "sync stopped working after refresh" bugs.

### The rule this buys us

**The renderer holds no authoritative state.** It queries SQLite for a page of
data and subscribes to invalidation events. There is no Redux store that can
drift from the database, no dual-write, no cache coherence problem between a
client store and disk.

This is what makes online and offline look identical to UI code: there is only
one read path, and it does not know or care whether the socket is connected.

---

## 6. Identity, tenancy, and access

### 6.1 Tenancy

```
Organization                 ← WorkOS Organization. SSO, SCIM, domains attach HERE.
  └── Workspace              ← ours; WorkOS has no such concept
       ├── Channels
       └── Rooms  → Chats
```

**Decision: the workspace layer exists in the schema, but v1 ships exactly one
workspace per organization, and the client is single-workspace.**

Slack's workspace layer is a historical artifact — Slack was workspace-first and
bolted the org layer on above it for Enterprise Grid. We are greenfield, so it
is a choice rather than an inheritance.

Why carry it anyway: adding a workspace layer later is a real migration; carrying
an unused `workspace_id` is free. Why not *use* it yet: for a local-first client
**the workspace is the natural sync boundary — one workspace = one SQLite file =
one cursor space.** Multi-workspace means either N sync engines and N databases,
or `workspace_id` threaded through every cursor, query, and catch-up path. That
cost buys nothing until a customer actually needs two workspaces.

This also resolves what was previously an open question about multi-account: the
unit of local storage is one database file per `(account, workspace)` pair.

### 6.2 What WorkOS owns, and where the line is

| Concept | WorkOS primitive | Owner |
|---|---|---|
| Organization | `Organization` — domains, SSO connections, Directory Sync | **WorkOS** |
| Account (one per email) | `User` — email unique per environment | **WorkOS** |
| Org membership + role | `OrganizationMembership` (many-to-many, `role_slug`) | **WorkOS** |
| Human authentication | AuthKit (SSO, MFA, magic auth) | **WorkOS** |
| Agent authentication | M2M Applications (client credentials → short-lived JWT) | **WorkOS** |
| Third-party access | Pipes + Relay (per-user connections) | **WorkOS** |
| **Workspace** | — nothing — | **Us** |
| **Actor** (workspace participant) | — nothing — | **Us** |
| **Delegation** (agent acting for a human) | — nothing — | **Us** |

WorkOS covers more than expected on the agent side and less than expected on the
tenancy side. Both boundaries are worth internalizing: there is no workspace
primitive, and there is no on-behalf-of token exchange for our own API.

**Never key anything on email.** WorkOS user IDs are stable; emails are not.
Email is a display attribute, never a join key. And since agents have no email,
"one account per email" is a rule about the human identity layer only — no
unique-email constraint belongs anywhere near the actors table.

### 6.3 The Actor model

```
LAYER 1 — IDENTITY                                          (WorkOS owns)
   humans → WorkOS User            (email, SSO, MFA, SCIM)
   agents → WorkOS M2M Application (client credentials, JWT via JWKS)

LAYER 2 — ACTOR                                             (we own)
   actors(id, org_id, workspace_id, type, handle, display_name, ...
          identity_kind, identity_id, owner_actor_id, provisioned_by, state)

LAYER 3 — PARTICIPATION                                     (we own)
   channel / room / chat membership  → actor_id
   messages.author_id                → actor_id
   reactions.actor_id                → actor_id
```

Two rules make this work.

**Use a polymorphic identity reference.** `identity_kind ∈ ('workos_user',
'workos_agent', 'system')` plus `identity_id` — not a nullable `workos_user_id`
beside a nullable `agent_credential_id`. It leaves room for a third kind and
removes the "which column is populated" branch from every call site.

**No identity reference may appear below Layer 2.** `messages.author_id` points
at `actors.id`, always. The moment a `workos_user_id` appears on a message, a
reaction, or a membership row, agents become second-class and the schema grows
nullable columns forever. **This single rule is most of what "agents are just
users" actually means in practice.**

A useful side effect: humans and agents share one handle namespace
automatically. `@harsh` and `@deploy-bot` cannot collide, because a unique index
on `(workspace_id, handle)` covers both. That matters more here than in Slack,
since mentions are how agents get invoked.

**Provisioning and lifecycle.** Directory Sync means actors are created and
deactivated by IT, not only by invitation — so `provisioned_by ∈ ('scim',
'sso_jit', 'invite', 'api')` and a state machine of `invited → active →
suspended → deactivated`. **Deactivation never deletes.** Messages persist and
the actor is tombstoned; a deactivated author still renders correctly, offline
included, because the actor set is replicated eagerly and completely (§8.3).

### 6.4 Delegation: agents acting on behalf of humans

The goal: when Alice invokes an agent, the agent must be able to reach exactly
what Alice can reach — no more.

**Agent identity is not agent authority.** The agent authenticates as itself and
is *authorized* by a delegation grant. Keeping authentication and authorization
separate is what makes the rest of this tractable.

There are two distinct boundaries, and conflating them is the usual mistake.

#### Boundary A — third-party resources (Google Docs, Jira, Slack)

**Do not mirror the provider's ACLs. Make the call with Alice's credential and
let the provider enforce Alice's permissions.**

A permission mirror is stale the moment someone changes a share setting upstream,
and a stale permission mirror is a data leak with a delay. If the call carries
Alice's credential, "the agent sees only what Alice sees" stops being something
we build and becomes a property we inherit from Google.

This is what **WorkOS Pipes** provides: per-user connections that Alice
authorizes herself, and **Relay**, which makes the provider call server-side —
the token never enters our environment. Pipes MCP adds the consent model:
a human approves the start of a session, access is time-limited, and it revokes
automatically when the session ends.

Boundary A is solved by Pipes, better than we would build it.

#### Boundary B — Relayed's own resources

Rooms, channels, chats, messages. WorkOS does not cover this. **Effective
permission is the intersection:**

```
allow(agent acting for alice, action, resource)  ⟺
      can(agent, action, resource)      -- the agent is a member in its own right
   ∧  can(alice, action, resource)      -- alice could do this herself
   ∧  valid_delegation(alice → agent, scope, now)
```

Never the union. Never agent-only — that is the confused-deputy hole, where an
agent with broad access is tricked into spending its own authority for someone
who lacks it. And never user-only either: requiring the agent to be a member in
its own right keeps **"who can see this room" answerable by exactly one thing —
the member list** — whether members are human or agent. If an agent could read
any room its invoker happens to be in, room membership would stop meaning
anything.

#### Delegation, not impersonation

| | Impersonation | Delegation |
|---|---|---|
| Token asserts | "I am Alice" | "I am agent X, acting for Alice, scope S, until T" |
| Audit trail | Shows Alice doing things she did not do | Preserves both identities |
| Revocation | Cannot revoke the agent without revoking Alice | Independent |
| Agent compromised | The attacker *is* Alice | The attacker holds a scoped, expiring grant |

Use the **RFC 8693 (OAuth Token Exchange)** claim shape, whether or not we
implement full token exchange — it is the vocabulary the ecosystem already
speaks, which makes audit logs legible to anyone who has seen it before:

```json
{
  "sub":   "actor_alice",
  "act":   { "sub": "actor_docs_agent" },
  "scope": "room:R:read room:R:write",
  "exp":   1757280600
}
```

**Scope is room + time + action.** Rooms turn out to be a natural delegation
boundary: "Alice invoked @docs-agent in Room R" is explicable in one sentence,
which matters — consent UX that users do not understand is consent theater.

**No delegation chaining.** An agent may not delegate to another agent. `act`
claims nest, so it is representable, but chained delegation is where security
models go to die. Revisit when agent-to-agent work is designed.

**Delegation is minted at execution time, not compose time.** An invocation may
sit in the outbox while the user is offline; the grant is issued when the op
actually reaches the server, never replayed from a stale token.

### 6.5 Agents at the transport layer

**Agents run as a separate server-side service. They do not run the local-first
sync engine.**

This is an important clarification of "agents are just users": the unification
is at the **data model** layer — one `actors` table, one handle namespace, one
authorship column — and deliberately *not* at the transport layer. An agent has
no Electron app, no SQLite replica, no outbox, and no cursor state.

Consequences:

- Agents are server-side consumers of the committed message stream. They observe
  a mention only once it is durably committed server-side.
- **An agent tagged by an offline user does not respond until that user
  reconnects** and the message actually registers on the server. This is a
  visible product behavior, not a bug — it falls directly out of the outbox
  model (§10).
- Agent replies arrive as ordinary messages through the normal write path, and
  reach clients through ordinary live events. No streaming; if partial output is
  ever wanted it will be batched into discrete messages.
- Agent invocation is therefore **online-only**, while reading stays local-first.
  A clean boundary worth preserving.

### 6.6 Accepted exposures

Three known gaps, each a deliberate decision rather than an oversight. Recorded
so they are re-litigated on purpose rather than discovered in a security review.

**1. Offboarding does not recall local data.**
A departing employee's laptop holds a complete, readable 90-day archive. Revoking
their WorkOS session stops sync; it does not remove data. If the machine never
reconnects, the data remains indefinitely.

This is inherent — "full offline reads" and "instant remote wipe" are
contradictory requirements. Accepted for now, with the exposure documented.

Mitigations exist if a customer forces the issue: a **soft lease** (the client
refuses to open the database without a lease token refreshed online every N days
— cheap, app-level, stops casual access only) or a **crypto lease** (SQLCipher,
key expires offline, real security, but reintroduces the native-module build
pain that `node:sqlite` was chosen to avoid and slows FTS5).

**Adopting either later costs a re-sync, not a migration** — the client database
is a replica, so it can simply be discarded and refetched. That is what makes
accepting this now a low-regret decision rather than a one-way door.

**2. Agents bridge permission domains.**
Alice invokes an agent in a room containing Bob. The agent reads Alice's Google
Doc with Alice's credential (correct) and posts a summary into the room where it
is a member (correct). Bob has now read content from a document he cannot open.
Neither step is wrong; the composition leaks.

**Accepted as a question of etiquette rather than access control** — Alice and
Bob share a room, and Alice chose to bring the document into it. The stricter
pattern (agent output visible only to the invoker, with an explicit share
action) remains available later; it costs one flag on the message and is not
worth the complexity now.

**3. Removal from a room does not revoke already-synced history.**
When an actor is removed from a room, the server stops including that room in
their sync scope. The local copy is retained, frozen at the point of removal.

This is a deliberate stance: **a member has a right to the room activity they
were actually part of.** Removal stops new data; it is not a retroactive recall.
Implementation is pleasingly cheap — the room's cursor simply stops advancing,
the room renders read-only locally, and normal 90-day retention (§13.6) lets it
decay on its own.

A nice property falls out: **re-adding a removed member is exactly a gap.** The
cursor resumes behind `server_head_rev`, the existing gap-marker machinery
(§9.3) backfills the missing interval, and no special case is required.

---

## 7. Spaces: channels, DMs, and rooms

### 7.1 The containment model

**Rooms** are the main departure from Slack's model: a scoped shared space where
humans and agents work a specific topic, containing *several* conversations
rather than one.

That breaks the obvious data model. Everywhere else — channels, DMs, group DMs —
the space and the message list are the same thing. A room is a space that holds
many message lists, so "where do messages live" needs a new answer.

There are two questions here, and conflating them is the trap:

1. **What contains messages?**
2. **What contains those containers?**

#### Answer 1: the chat, universally

Every message lives in a **chat**. Channels, DMs, and group DMs have exactly one
(`kind='sole'`); a room has a `default` plus any number of `public` and
`private` ones.

**The chat is the sync unit; its space is the permission unit.** Those are
separate axes, and conflating *them* is what leads teams to build four parallel
message pipelines — one for channels, one for DMs, one for group DMs, one for
rooms — each with its own cursor, catch-up, and unread logic. Here there is one
pipeline.

#### Answer 2: one `spaces` table, discriminated by kind

```
Workspace
└── spaces  (kind: channel | dm | group_dm | room)
     │
     ├── channel  ──────────── chat (sole)
     ├── dm       ──────────── chat (sole)
     ├── group_dm ──────────── chat (sole)
     └── room  ───┬─────────── chat (default)   ← structural, undeletable
                  ├─────────── chat (public)
                  └─────────── chat (private)
```

The structure genuinely *is* uniform: every one of these is "a container of
chats with a member list." Only **policy** differs — who may join, who may add,
what lifecycle applies. So the structure unifies into one table and the policy
varies by `kind`.

| `kind` | visibility | membership | chats | lifecycle |
|---|---|---|---|---|
| `channel` | public / private | open / invite | 1 `sole` | active, archived |
| `dm` | — | **sealed** | 1 `sole` | active, dormant |
| `group_dm` | — | **sealed** | 1 `sole` | active, dormant |
| `room` | public / private | open / invite | 1 `default` + N | active, dormant, archived |

`sealed` is what prevents adding a third person to a DM — matching Slack, where
adding someone creates a *new* conversation rather than mutating the existing
one. And "closing" a DM turns out to be exactly `dormant`, which the lifecycle
already provides.

#### What this deliberately does *not* do

It does not make channels and DMs **behave** like rooms. A DM with an admin role
and four chats is not a DM. The unification is **structural, not behavioral** —
a discriminated union, not a merge.

And it does not touch the product vocabulary. Channels, DMs, and rooms remain
three distinct things with three distinct affordances and three names. Users
never encounter the word "space."

#### Why not three separate parent tables

An earlier draft of this document used `channels`, `conversations`, and `rooms`
as three tables with a polymorphic `parent_type` on `chats`. That was worse, and
concretely so:

- The access predicate needed **four branches** instead of one expression (§7.3).
- `chats.parent_id` could not be a real foreign key, because its target table
  varied by row.
- `memberships.scope_type` needed four values rather than two.
- "Room membership is a precondition for its chats" had to be *remembered* as a
  rule, rather than being structurally unavoidable.

The costs of unifying are real but small: a few nullable columns (`slug` is
channels-only, DMs have no `name`), and nothing at the schema level preventing
`lifecycle='archived'` on a DM. That is a check constraint or an application
invariant — considerably cheaper than a four-branch predicate that every query
in the product has to reproduce correctly for the rest of its life.

### 7.2 Rooms

- A room is **public** or **private**. Public means *discoverable and joinable*,
  **not** auto-joined — like a Slack public channel, membership is explicit.
- Every room has exactly one **default chat**, visible to all room members. It
  is the room's common ground: not deletable, not renameable, not convertible to
  private. Enforced with a partial unique index rather than application logic,
  because a room whose shared floor can be removed has no coherent meaning.
- Beyond the default, a room holds any number of **public chats** (all room
  members) and **private chats** (an explicit subset).
- **Private chats are fully hidden** from non-members — their existence is not
  advertised. A visible-but-locked chat leaks who is talking to whom, which is
  frequently more sensitive than what they are saying.

### 7.3 Membership and access

One membership table across both levels:

```
memberships(scope_type, scope_id, actor_id, role, joined_at, left_at)
    scope_type ∈ 'space' | 'chat'
```

`scope_type='chat'` rows exist **only** for private chats; every other chat
derives access from its space.

```
access(actor, chat) ⟺
      actor ∈ members(chat.space_id)
   ∧ (chat.kind ≠ 'private'  ∨  actor ∈ members(chat.id))
```

One expression, two terms. Note what the first term does: **space membership is
a precondition for every chat inside it, structurally.** It is not a rule to
remember and re-implement — it is the leading conjunct, and no query can express
chat access without it. Without that property, an actor removed from a room
could retain access to a private chat within it, and "who can see this room's
contents" would stop having a single answer. Same principle as the intersection
rule in §6.4: one member list, one answer.

This composes with delegation: an agent acting for Alice in chat C needs
`access(agent, C) ∧ access(alice, C) ∧ valid_delegation`. **Delegation scope is
chat-level, not room-level** — "Alice invoked @docs-agent in chat C" granting
the agent every chat in the room would be a wider grant than her action implies.

**Permissions within a room:**

| Action | Who |
|---|---|
| Add a member (public or private room) | any member |
| Create a public or private chat | any member |
| **Convert private room → public** | **admin only** |
| Promote another member to admin | admin |

The asymmetry is deliberate. Adding one person and exposing everything to the
entire workspace have very different blast radii, and "any member can add" plus
"any member can publish" would compose into a private room whose confidentiality
rests on nothing but every member's goodwill. The room creator starts as admin
and can promote others — which also keeps a room from being stranded when its
creator is deprovisioned via SCIM.

### 7.4 Visibility transitions

**Private → public discloses all history.** The entire backlog becomes readable
by anyone who subsequently joins. The alternative — disclosing only messages
after the flip — would make visibility `ord`-dependent, putting a second
condition into every read query in the application for the life of the product.
Not worth it. Conversion is admin-gated (§7.3) and should carry an explicit,
unambiguous confirmation, because it is irreversible in effect even where it is
reversible in mechanism: once seen, seen.

**Conversion is not a fanout event.** Because public rooms require explicit
joining, going public makes a room *appear in the directory* — it does not push
it to every client in the workspace. No burst, no mass backfill. This falls out
of the explicit-join rule and is worth stating, so nobody implements conversion
as a bulk push to every connected client.

**Joining is the gap case.** Joining a room, or being added to a private room or
chat, hands an actor a chat with history they have never synced. The server
sends `gap` plus a recent tail (§9.3), badges are correct immediately, and
backfill happens lazily on open. Existing machinery — but it must not be
implemented as a full-history push.

**Public → private recalls nothing.** Clients that already synced the room keep
what they have; they simply stop receiving new events. Consistent with the
removal rule in §6.6, and contrary to what most people will assume, so it needs
saying out loud.

**The room directory is online-only** — and this is *not* an exception to §3.
Browsing public rooms you have not joined is a server query because that content
is not yours until you join; §3's rule scopes to data the actor already has
access to.

Worth stating plainly because it is easy to misread as a weakening of R2. It is
not. **A room you are a member of syncs completely and receives updates whether
or not it is open on screen**, exactly like a channel. Three distinct states,
routinely confused:

| State | Syncs | Readable offline |
|---|---|---|
| Joined, not open in the UI | **yes — this is R2** | yes |
| Joined, `archived` | cursor frozen (no new events exist) | yes |
| **Not joined** | no | no — the directory needs the network |

### 7.5 Lifecycle

Rooms are scoped to a topic, so unlike channels they *end*. Three states rather
than two, because automation and human intent should never produce the same
result:

| State | Sidebar | Writable | Sync | Exit |
|---|---|---|---|---|
| `active` | shown | yes | normal | — |
| `dormant` | hidden under "inactive" | **yes** | **normal** | any message auto-wakes it |
| `archived` | hidden | no | cursor frozen | explicit unarchive |

**Automatic inactivity produces `dormant`, never `archived`.** Dormancy is
non-destructive by construction — posting wakes the room — so auto-archival can
never lock anyone out of a room they still need. `archived` is only ever a
deliberate human act.

Both states are cheap:

- **`dormant` is a pure UI filter with zero sync cost.** The room keeps syncing
  normally; it is simply excluded from the default sidebar query.
- **`archived` reuses the frozen-cursor path** already specified for room
  removal (§6.6). Normal 90-day retention (§13.6) then lets it decay on its own,
  and unarchiving is — again — the gap case.

### 7.6 What this costs the sync engine

Nothing. Checked section by section rather than assumed:

| Section | Change |
|---|---|
| §8.1 two-counter model | `ord`/`rev` per chat instead of per space — none |
| §8.2 threads | `parent_id` within a chat — none |
| §9 protocol | `"c"` carries a chat id — shape unchanged |
| §10 write path, outbox, coalescing | ops target chats — none |
| §11 read path | queries key on `chat_id` — none |
| §12 unread counters | per-chat instead of per-space — none |
| §13.6 retention and eviction | per-chat — none |

Rooms add a containment and permission layer **above** the sync engine, not
inside it. The subtle, expensive machinery — cursors, contiguity, gap markers,
catch-up, coalescing, eviction — is untouched.

The one thing that *does* change is scale: **the cursor count grows with chats,
not rooms**, and rooms multiply chats. See §9.9 for the ceiling, and
[`OBSERVABILITY.md`](OBSERVABILITY.md) §9 for the metric that warns before it
is reached.

---

## 8. Data model

### 8.1 The two-counter model

This is the least obvious part of the design and the part most likely to be
broken by a well-meaning change. It falls out of taking threads and reactions
seriously at the same time.

#### The problem

Consider three events in a chat:

1. Alice posts a message.
2. Bob edits a message he sent an hour ago.
3. Carol adds a 👍 to an old message.

All three must reach every client — a client that misses (3) shows a wrong
reaction count forever. So all three must be covered by the sync cursor.

But only (1) should create an unread badge, and only (1) should appear at the
bottom of the chat. If Bob's edit advanced the same counter that drives
ordering and unread state, editing a typo would mark the chat unread for
everyone and potentially move the message.

**One counter cannot do both jobs.** So we use two.

#### The model

```
ord  — MESSAGE ORDINAL
       Assigned only when a new message is created. Never changes. Never reused.
       Domain: display order, read cursor, retention boundary, backfill paging.

rev  — CHAT REVISION
       Bumped by ANY mutation in the chat: new message, edit, delete,
       reaction add, reaction remove.
       Domain: sync cursor only.
```

Every mutation gets a `rev`. Only new messages *also* get an `ord`.

Consequences, all of them good:

- Catch-up is uniform: "give me everything since `rev` N" returns messages,
  edits, and reactions in a single ordered stream. One cursor per chat.
- Ordering and read state live in `ord`, which edits and reactions never touch.
  A message cannot move because someone reacted to it.
- Deletes are tombstones that keep their `ord`. **`ord` is never renumbered.**
  Gaps in `ord` from deleted messages are normal and expected.

#### The contiguity invariant

`synced_through_rev` means **"I hold every change with rev ≤ this"** — a
contiguous prefix, with no holes.

If a live event arrives with `rev = 501` while `synced_through_rev = 400`, you
**must not** advance the cursor to 501. There is a hole at 401–500. Store the
event (it is valid data), but advance the cursor only across contiguous runs.

Getting this wrong produces silent, permanent history holes: the client believes
it is caught up, never re-requests the missing range, and the gap is invisible
until a user notices missing messages weeks later. This is the single most
important invariant in the system and it deserves a dedicated test that injects
out-of-order revisions.

Track two watermarks and never confuse them:

| Watermark | Meaning |
|---|---|
| `synced_through_rev` | I **have** everything up to here. Contiguous. |
| `server_head_rev` | The server **says** this much exists. May be far ahead. |

"I have it" and "I know it exists" are different facts. Keeping them separate is
what makes R2 cheap (§12).

#### Tracking the frontier: `pending_revs`

Advancing the cursor requires answering "have I received rev N?" — and **that
question is not answerable from the message rows.** This is not obvious and was
found by building the model in `spikes/`, not by reading the design:

- A rev that created a message leaves `messages.rev = N`. Derivable.
- A rev that **edited** a message overwrites `messages.rev`. A later edit
  overwrites it again, and the earlier rev is gone.
- A rev that **deleted a message the client never held** — evicted under
  retention, or below the window after a gap — writes *nothing at all*. There is
  no row to carry the rev.

So `MAX(rev)` over messages under-reports, and the cursor stalls permanently
behind a rev it actually received. The fix is a small explicit table:

```sql
CREATE TABLE pending_revs (
  chat_id TEXT NOT NULL,
  rev     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, rev)
);
```

It holds **only revs above the contiguous frontier**. Advancing deletes
everything at or below the new watermark, so the table collapses to empty
whenever the client is caught up — typically zero rows, and bounded by the size
of the current out-of-order window rather than by history.

```
on receive(rev R):
    store the change
    INSERT OR IGNORE INTO pending_revs
    while pending_revs contains synced_through_rev + 1:  synced_through_rev++
    DELETE FROM pending_revs WHERE rev <= synced_through_rev
```

Fast path worth having: when `R == synced_through_rev + 1` (the overwhelmingly
common case) advance directly and skip the table entirely.

### 8.2 Threads

Three options were considered:

**Option A — replies share the chat's `ord` space, no separate counters.**
One cursor, simple catch-up. But chat-unread and thread-unread become
inseparable, and Slack-style products need them separate.

**Option B — threads get their own sequence space.**
Clean unread separation, but the cursor count goes from *one per chat* to
*one per chat plus one per subscribed thread*. At ~150 chats with a few
dozen live threads that is ~200 cursors to track, catch up, persist, and
reconcile. Roughly doubles the sync machinery.

**Option C — shared sequence space, explicit server-side unread counters.** ← chosen

The reasoning chain matters more than the conclusion:

1. Unread *mention* counts cannot be derived from sequence arithmetic — you
   cannot know how many of the messages you are missing mention you without
   their bodies. So a server-side per-`(actor, chat)` counter service is
   **already required**, independent of threads.
2. The only substantial argument for Option B was separating chat unread from
   thread unread.
3. That separation is solved for free once the counter service exists — it
   returns `{chat_unread, thread_unread, mention_count}`.

So threads share the chat's `ord`/`rev` space, we stay at one cursor per
chat, and unread comes from the server.

**One consequence to plan for:** thread replies may sit *inside* a chat gap,
so they cannot be fetched by ordinal range. Thread backfill needs its own
parent-keyed endpoint: `GET /threads/{root_id}/replies?after_ord=N`. This must
exist from day one; it is not an optimization.

### 8.3 Client schema

Lives at `app.getPath('userData')/relayed.db`.

```sql
-- ─── Pragmas ─────────────────────────────────────────────────────────────────
-- ⚠ ORDER MATTERS. auto_vacuum MUST be the very first statement executed on a
-- new database file — before journal_mode, before any table. Setting WAL first
-- materializes the database header, after which auto_vacuum is SILENTLY IGNORED
-- (returns 0, no error). Verified behavior, see §13.5.
PRAGMA auto_vacuum  = INCREMENTAL;  -- ⚠ FIRST. Cannot be changed afterward.
PRAGMA journal_mode = WAL;          -- readers proceed during catch-up writes
PRAGMA synchronous  = NORMAL;       -- safe under WAL; FULL is needlessly slow
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Assert it took. A silent 0 here means eviction will never reclaim disk.
--   SELECT * FROM pragma_auto_vacuum();  -->  must be 2

-- ─── Actors ──────────────────────────────────────────────────────────────────
-- Humans and agents, unified. See §6.3.
-- NOTE: no email column. Email lives in WorkOS (Layer 1) and is never a join
-- key here; agents have none at all.
CREATE TABLE actors (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  type           TEXT NOT NULL,      -- 'human' | 'agent'
  handle         TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  avatar_blob    TEXT,               -- → blobs.id

  -- Layer 1 reference, polymorphic (§6.3). The ONLY place an identity
  -- reference may appear. Never joined from messages/reactions/memberships.
  identity_kind  TEXT,               -- 'workos_user'|'workos_agent'|'system'
  identity_id    TEXT,               -- WorkOS user id, or M2M client id

  owner_actor_id TEXT,               -- agents: the actor operating this agent
  provisioned_by TEXT NOT NULL,      -- 'scim'|'sso_jit'|'invite'|'api'
  state          TEXT NOT NULL,      -- 'invited'|'active'|'suspended'|'deactivated'
  updated_at     INTEGER NOT NULL
);
-- One handle namespace for humans AND agents; @harsh and @deploy-bot cannot
-- collide precisely because they share this index.
CREATE UNIQUE INDEX actor_handle   ON actors(workspace_id, handle);
CREATE INDEX        actor_identity ON actors(identity_kind, identity_id);

-- ─── Spaces (§7) ─────────────────────────────────────────────────────────────
-- Channels, DMs, group DMs and rooms are ONE table discriminated by `kind`.
-- Structure is uniform ("a container of chats with a member list"); only policy
-- varies. See §7.1 for why this beats three parent tables.
CREATE TABLE spaces (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  kind                TEXT NOT NULL,  -- 'channel'|'dm'|'group_dm'|'room'
  name                TEXT,           -- NULL for dm/group_dm (derived from members)
  slug                TEXT,           -- channels only
  topic               TEXT,
  visibility          TEXT,           -- 'public'|'private'; NULL for dm/group_dm
  membership_policy   TEXT NOT NULL,  -- 'open'|'invite'|'sealed'
  lifecycle           TEXT NOT NULL,  -- 'active'|'dormant'|'archived' (§7.5)
  created_by_actor_id TEXT,
  last_activity_at    INTEGER NOT NULL,   -- drives auto-dormancy
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,   -- LWW clock for name/topic

  -- Policy invariants the schema can cheaply hold (§7.1 table)
  CHECK (kind IN ('channel','dm','group_dm','room')),
  CHECK (membership_policy IN ('open','invite','sealed')),
  CHECK (lifecycle IN ('active','dormant','archived')),
  CHECK (kind NOT IN ('dm','group_dm') OR membership_policy = 'sealed'),
  CHECK (kind NOT IN ('dm','group_dm') OR lifecycle <> 'archived'),
  -- NOTE the explicit `IS NOT NULL`. A CHECK only rejects a row when it
  -- evaluates to FALSE, and `NULL IN ('public','private')` is NULL, not FALSE
  -- — so the natural-looking form silently permits exactly the row it is meant
  -- to forbid. Every CHECK over a nullable column needs this guard.
  CHECK (CASE WHEN kind IN ('dm','group_dm')
              THEN visibility IS NULL
              ELSE visibility IS NOT NULL
                   AND visibility IN ('public','private') END),
  CHECK (CASE WHEN kind IN ('dm','group_dm') THEN 1
                                             ELSE name IS NOT NULL END)
);
CREATE INDEX space_workspace ON spaces(workspace_id, kind);
CREATE UNIQUE INDEX space_slug ON spaces(workspace_id, slug) WHERE slug IS NOT NULL;

-- ─── Chats: THE universal message container (§7.1) ───────────────────────────
CREATE TABLE chats (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  space_id            TEXT NOT NULL REFERENCES spaces(id),   -- a REAL foreign key
  kind                TEXT NOT NULL,  -- 'sole'|'default'|'public'|'private'
  name                TEXT,           -- NULL for 'sole' and 'default'
  created_by_actor_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (kind IN ('sole','default','public','private'))
);
CREATE INDEX chat_space ON chats(space_id);

-- Structural singletons: exactly one 'sole' chat per channel/dm/group_dm, and
-- exactly one 'default' chat per room. Enforced by the database, not by
-- application logic — a room whose shared floor can be deleted is incoherent.
CREATE UNIQUE INDEX chat_singleton ON chats(space_id)
  WHERE kind IN ('sole', 'default');

-- ─── Membership (§7.3) ───────────────────────────────────────────────────────
-- Two levels, one table. scope_type='chat' rows exist ONLY for private chats;
-- every other chat derives access from its space.
CREATE TABLE memberships (
  scope_type TEXT NOT NULL,          -- 'space' | 'chat'
  scope_id   TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  role       TEXT NOT NULL,          -- 'member' | 'admin'
  joined_at  INTEGER NOT NULL,
  left_at    INTEGER,                -- set on removal; row is KEPT (§6.6)
  PRIMARY KEY (scope_type, scope_id, actor_id),
  CHECK (scope_type IN ('space','chat'))
);
CREATE INDEX membership_actor ON memberships(actor_id) WHERE left_at IS NULL;

-- ─── Messages ────────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,      -- ULID, CLIENT-generated (§10.1)
  chat_id  TEXT NOT NULL,
  parent_id   TEXT,                  -- NULL = top-level; else thread root id
  ord         INTEGER,               -- NULL while pending; set on ack
  rev         INTEGER,               -- last rev that touched this row
  author_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,      -- server time on ack; client time while pending
  edited_at   INTEGER,               -- LWW clock for body
  deleted     INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL,         -- 'pending' | 'acked' | 'failed'
  local_only  INTEGER NOT NULL DEFAULT 0,

  -- Delegation attribution (§6.4). author_id is ALWAYS the acting actor — for
  -- an agent reply that is the agent, never the human. on_behalf_of_actor_id
  -- records whose authority was spent. Both NULL for ordinary human messages.
  on_behalf_of_actor_id TEXT,
  delegation_id         TEXT         -- server-side delegation record, for audit
);

-- Chat view must skip thread replies WITHOUT scanning past them. Without
-- this partial index, a thread with 800 replies means "last 50 chat
-- messages" scans 800 rows it will discard.
CREATE INDEX msg_chat_view ON messages(chat_id, ord DESC)
  WHERE parent_id IS NULL;

CREATE INDEX msg_thread ON messages(parent_id, ord)
  WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX msg_ord ON messages(chat_id, ord)
  WHERE ord IS NOT NULL;

CREATE INDEX msg_pending ON messages(chat_id, created_at)
  WHERE state = 'pending';

-- ─── Reactions ───────────────────────────────────────────────────────────────
CREATE TABLE reactions (
  message_id TEXT    NOT NULL,
  emoji      TEXT    NOT NULL,
  actor_id   TEXT    NOT NULL,
  present    INTEGER NOT NULL,       -- 1 = added, 0 = removed (TOMBSTONE, kept)
  updated_at INTEGER NOT NULL,       -- LWW clock; ties broken by actor_id
  PRIMARY KEY (message_id, emoji, actor_id)
);
CREATE INDEX rx_message ON reactions(message_id) WHERE present = 1;

-- Tombstones are KEPT, not deleted. If you delete the row on removal, a late
-- "add" replayed from a device that was offline resurrects a reaction the user
-- removed — LWW needs both sides present to compare. GC tombstones older than
-- the sync horizon (§13.5).

-- ─── Per-chat sync state ──────────────────────────────────────────────────────
CREATE TABLE chat_state (
  chat_id         TEXT PRIMARY KEY,

  -- sync cursor domain (rev)
  synced_through_rev INTEGER NOT NULL DEFAULT 0,  -- contiguous prefix I HOLD
  server_head_rev    INTEGER NOT NULL DEFAULT 0,  -- what the server SAYS exists

  -- ordering / read domain (ord)
  head_ord           INTEGER NOT NULL DEFAULT 0,
  last_read_ord      INTEGER NOT NULL DEFAULT 0,  -- MAX-register. Never LWW.
  oldest_local_ord   INTEGER,                     -- backfill floor + evict mark

  -- server-pushed counters (§12)
  chat_unread     INTEGER NOT NULL DEFAULT 0,
  thread_unread      INTEGER NOT NULL DEFAULT 0,
  mention_count      INTEGER NOT NULL DEFAULT 0,

  has_gap            INTEGER NOT NULL DEFAULT 0,  -- history incomplete below head
  muted              INTEGER NOT NULL DEFAULT 0,
  last_activity_at   INTEGER                      -- catch-up prioritization
);

-- Revs received ABOVE the contiguous frontier. Required because "have I seen
-- rev N?" is NOT derivable from message rows (§8.1) — an edit overwrites the
-- rev it replaced, and a delete for an unheld message writes nothing at all.
-- Collapses to empty whenever the client is caught up.
CREATE TABLE pending_revs (
  chat_id TEXT    NOT NULL,
  rev     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, rev)
);

-- ─── Outbox ──────────────────────────────────────────────────────────────────
CREATE TABLE outbox (
  op_id      TEXT PRIMARY KEY,       -- ULID; server dedupes on this
  seq        INTEGER NOT NULL,       -- local monotonic; replay order
  kind       TEXT NOT NULL,          -- see §10.3
  chat_id TEXT,
  target_id  TEXT,                   -- message id / blob id the op acts on
  payload    TEXT NOT NULL,          -- JSON
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL DEFAULT 'queued',  -- 'queued'|'inflight'|'failed'
  error      TEXT
);
CREATE INDEX outbox_ready ON outbox(next_at) WHERE state = 'queued';
CREATE INDEX outbox_target ON outbox(target_id);   -- coalescing lookups (§10.4)

-- ─── Blobs ───────────────────────────────────────────────────────────────────
-- Metadata only. Bytes live on the filesystem (§13.3).
CREATE TABLE blobs (
  id           TEXT PRIMARY KEY,     -- server file id, or local ULID pre-upload
  message_id   TEXT,
  kind         TEXT NOT NULL,        -- 'avatar' | 'image' | 'file'
  mime         TEXT,
  size         INTEGER,
  width        INTEGER,
  height       INTEGER,
  remote_url   TEXT,
  local_path   TEXT,                 -- NULL = not cached
  state        TEXT NOT NULL,        -- 'remote'|'downloading'|'cached'|'failed'
  last_used_at INTEGER,              -- LRU
  pinned       INTEGER NOT NULL DEFAULT 0  -- avatars: never evict
);
CREATE INDEX blob_lru ON blobs(last_used_at) WHERE state = 'cached' AND pinned = 0;

-- ─── Search ──────────────────────────────────────────────────────────────────
-- External-content FTS5. See §13.4 for the delete-trigger ordering trap.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  content      = 'messages',
  content_rowid= 'rowid',
  tokenize     = 'unicode61 remove_diacritics 2'
);

-- ─── Local key/value ─────────────────────────────────────────────────────────
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- device_id, schema_version, local_session, last_sync_at, ...

CREATE TABLE drafts (
  chat_id TEXT PRIMARY KEY,
  parent_id  TEXT,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Local-only. Never synced. Cross-device drafts are a deliberate non-feature:
-- they are an LWW register over content someone is actively typing, which is
-- the one case where LWW visibly destroys work.
```

### 8.4 Server-side schema notes

Not the focus of this document, but three things the client depends on:

**Delegations are server-side only.** The client never holds a delegation
record — it holds `messages.on_behalf_of_actor_id`, which is all it needs to
render "@docs-agent · on behalf of Alice". Scope and expiry are authorization
state and must not be replicated to a client that could be offline when they
expire.

```sql
CREATE TABLE delegations (
  id                TEXT PRIMARY KEY,
  granting_actor_id TEXT NOT NULL,   -- whose authority is being spent
  agent_actor_id    TEXT NOT NULL,   -- who is spending it
  scope             TEXT NOT NULL,   -- RFC 8693 style: "room:R:read room:R:write"
  issued_at         INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  revoked_at        INTEGER
);
CREATE INDEX delegation_active ON delegations(agent_actor_id, expires_at)
  WHERE revoked_at IS NULL;
```

Minted at execution time, never at compose time (§6.4) — an invocation that sat
in the outbox overnight gets a fresh grant when it reaches the server, not a
replayed stale one.

**Atomic ordinal assignment.** `ord` and `rev` must be assigned under a
per-chat lock, inside the same transaction as the insert:

```sql
UPDATE chats
   SET next_ord = next_ord + 1, next_rev = next_rev + 1
 WHERE id = $1
RETURNING next_ord, next_rev;
```

This serializes writes per chat. That is not a bottleneck at team scale, and
it is exactly the property we want — one canonical order, no reconciliation.

**Idempotency.** A unique index on `op_id`. A retried op must return the **same**
`ord`, not a new one:

```sql
INSERT INTO messages (...) VALUES (...)
ON CONFLICT (op_id) DO NOTHING
RETURNING id, ord, rev;
-- zero rows returned → SELECT the existing row and return its ack unchanged
```

Without this, a client that sends, loses the connection before the ack, and
retries produces duplicate messages. This is the single most common
offline-sync bug in the wild.

---

## 9. Sync protocol

WebSocket, JSON frames. Binary/CBOR is a later optimization; do not start there.

### 9.1 Connect and head sync

```
client → server
{ "t": "hello",
  "access_token": "eyJ...",          -- WorkOS access token (§13.1)
  "workspace_id": "ws_01J...",
  "device_id": "dev_01J...",
  "cursors": [ { "c": "chat_eng",  "rev": 8134 },
               { "c": "chat_rand", "rev": 402  },
               ... 50 entries ... ] }
```

```
server → client
{ "t": "welcome",
  "now": 1757280000000,
  "actor": { ... },                   -- the caller's own actor record
  "chats": [
    { "c": "chat_eng",
      "head_rev": 8140, "head_ord": 5521,
      "chat_unread": 6, "thread_unread": 2, "mention_count": 1 },
    ...
  ],
  "actors": [ ... ], "memberships": [ ... ] }
```

At ~150 chats this is roughly 3 KB up, ~18 KB down — **one round trip**. See
§9.9 for the paging ceiling.

**After this single exchange, every badge in the sidebar is correct**, before a
single message body has been fetched. That is R2 satisfied, cheaply. Message
content is fetched lazily afterwards.

### 9.2 Live events

While connected, the client receives events for **every chat it can access**.
No tiering, no subscribe-on-open. This is bounded by human typing rate across
the membership set — a few hundred events an hour at worst. Do not
over-engineer it.

```
{ "t": "ev", "c": "chat_eng", "rev": 8141, "op": "msg",
  "m": { "id": "01J...", "ord": 5522, "parent_id": null,
         "author_id": "a_alice", "body": "shipped", "created_at": ... } }

{ "t": "ev", "c": "chat_eng", "rev": 8142, "op": "edit",
  "m": { "id": "01J...", "body": "shipped it", "edited_at": ... } }

{ "t": "ev", "c": "chat_eng", "rev": 8143, "op": "react",
  "r": { "message_id": "01J...", "emoji": "🚀",
         "actor_id": "a_bob", "present": 1, "updated_at": ... } }

{ "t": "ev", "c": "chat_eng", "rev": 8144, "op": "del",
  "m": { "id": "01J..." } }
```

Counter updates ride alongside, since the server owns them:

```
{ "t": "counters", "c": "chat_eng",
  "chat_unread": 7, "thread_unread": 2, "mention_count": 1 }
```

### 9.3 Catch-up

On reconnect, for each chat where `synced_through_rev < server_head_rev`:

```
client → server
{ "t": "catchup", "c": "chat_eng", "from_rev": 8134, "limit": 500 }
```

Two possible replies.

**Full replay** — the client was close enough behind:

```
{ "t": "catchup_ok", "c": "chat_eng",
  "from_rev": 8134, "to_rev": 8140, "complete": true,
  "events": [ ...same shapes as live events... ] }
```

**Gap marker** — the client was too far behind:

```
{ "t": "gap", "c": "chat_eng",
  "head_rev": 91204, "head_ord": 40112,
  "recent": [ ...last ~50 messages... ] }
```

The client sets `has_gap = 1`, stores the recent tail, and jumps
`synced_through_rev` to `head_rev`. History below the tail is backfilled lazily
when the chat is opened.

This is what bounds reconnect cost to **O(chats)** rather than
**O(messages)**. A user offline for a week across 150 chats reconnects with
one small frame instead of 100k messages.

Gap threshold: **~500 revs** at team scale. Tune with real data.

### 9.4 Backfill

Two distinct paging endpoints, because threads live inside gaps (§8.2):

```
{ "t": "backfill", "c": "chat_eng", "before_ord": 5100, "limit": 50 }
{ "t": "thread_backfill", "root_id": "01J...", "after_ord": 0, "limit": 100 }
```

### 9.5 Writes

```
client → server
{ "t": "op", "op_id": "01J...", "kind": "send",
  "c": "chat_eng",
  "m": { "id": "01J...", "parent_id": null, "body": "hi",
         "created_at": 1757280000000, "blob_ids": [] } }

server → client
{ "t": "ack", "op_id": "01J...", "id": "01J...",
  "c": "chat_eng", "ord": 5523, "rev": 8145,
  "created_at": 1757280000123 }        -- SERVER time wins

server → client (rejection)
{ "t": "nack", "op_id": "01J...", "code": "not_a_member",
  "retryable": false, "message": "..." }
```

`retryable` is load-bearing: it decides whether the outbox backs off and retries
or moves the op to `failed` and surfaces it in the UI (§10.5).

### 9.6 Read state

```
{ "t": "read", "c": "chat_eng", "ord": 5523 }
```

Server applies `max(existing, incoming)` — never a blind overwrite. See §4.

### 9.7 Staying authenticated

WorkOS access tokens are short-lived; the sync socket lives for hours. Dropping
and reconnecting on every refresh would cause constant catch-up churn and a
visible stutter, so the connection is refreshed **in band**:

```
client → server   { "t": "reauth", "access_token": "eyJ..." }
server → client   { "t": "reauth_ok", "expires_at": 1757283600000 }
```

The client refreshes ahead of expiry (the WorkOS refresh itself happens over
HTTPS, out of band) and pushes the new token down the existing socket. The
server closes the connection only if a token lapses without replacement.

**Auth failure never closes the read path.** On refresh failure the sync engine
enters `unauthenticated` and the socket drops; local reads continue untouched.
See §13.1.

### 9.8 Reconnect discipline

Exponential backoff with **full jitter**, capped around 30s.

Jitter is load-bearing, not politeness. Accepting reconnections is cheap —
measured at thousands per second (§13.9). What is expensive is what sits
*behind* each one: a `welcome` frame (~18 KB at 150 chats, §9.9) plus catch-up
queries. Ten thousand clients reconnecting together means ~180 MB of response
generation and 10k bursts of database work landing at the same instant.

Spread over 30s of jitter that is ~333/sec and ~6 MB/s, which is unremarkable.
Without jitter it arrives all at once. **This is the difference between a
survivable rolling deploy and an outage**, and it is the reason a server restart
needs connection draining as well as client-side jitter.

---

### 9.9 The `welcome` ceiling

R2 means the client tracks every chat it can access, so **cursor count scales
with chats, not rooms** — and rooms multiply chats. This is the one place where
the Rooms model has a real cost.

At roughly 120 bytes per chat row in the `welcome` frame:

| Shape | Chats | `welcome` |
|---|---|---|
| 50 channels only | 50 | ~6 KB — one frame |
| 50 channels + 20 rooms × 4 chats | 130 | ~16 KB — one frame |
| 50 channels + 100 rooms × 6 chats | 650 | ~78 KB — **needs paging** |

**The ceiling is roughly 500 chats before `welcome` must page.** That is
comfortably above the design target (§2), but it arrives via room proliferation
rather than channel growth — which is precisely the axis this product
encourages. Two things follow:

- Track chats-per-actor as a product metric from day one. It is the number that
  predicts when this breaks.
- The fix is straightforward if anticipated: page `welcome` by
  `last_activity_at` descending, sending head state for the most recent N chats
  and a continuation cursor for the rest. Badges for older chats arrive a beat
  later rather than never. Do **not** retrofit this by dropping chats from
  `welcome` — a silently missing chat is a silently wrong badge.

---

### 9.10 Forward compatibility

Old clients are not an edge case. Updates are opt-in (see
[`RELEASE.md`](RELEASE.md)), so a client from three months ago will be talking
to today's server. The protocol has to tolerate that from the first release
shipped to anyone — it cannot be added later, because the clients that need it
are precisely the ones running old code.

Three rules, all cheap now and impossible to retrofit.

**1. An unknown event type must still advance the cursor.**

This is the severe one. When a new `op` is added — say `op: 'pin'` — a client
that predates it has two options:

| Behaviour | Result |
|---|---|
| Ignore the event entirely | `synced_through_rev` **stalls at that rev forever.** The client silently stops receiving anything in that chat. |
| Record the rev in `pending_revs`, skip applying | Cursor advances; the client is merely missing a feature. |

Only the second is survivable. The rule: **`pending_revs` is written for every
received rev, before and independently of whether the event can be applied**
(§8.1). Parsing failure must never block the frontier.

The failure mode is nasty because it is delayed and silent — it appears months
after launch, in old clients, the first time a new op type ships.

**2. Unknown fields are ignored, never rejected.**

The server will add fields to `welcome`, `ev` and `ack` over time. Clients must
ignore what they do not recognise rather than failing validation. In practice
this means schemas that strip or pass through unknown keys — **never a strict
schema on an inbound frame.** One `.strict()` added for tidiness breaks every
older client in the field.

**3. `hello` carries a protocol version, and the server can demand an upgrade.**

```
client → server   { "t": "hello", "protocol": 3, ... }
server → client   { "t": "too_old", "min_protocol": 4, "message": "..." }
```

Build the path even if it is never used. The moment it is needed is the moment
it cannot be shipped, because the clients requiring it are the old ones. It is
also the only backstop in a model where updates cannot be forced.

**Direction matters.** These rules make *old clients tolerate new servers*. The
reverse — a new client against an old server — is not solved by tolerance and
must be gated by version, not absorbed silently.

---

## 10. The write path

### 10.1 Client-generated IDs are mandatory

Every message gets its ID **on the client**, at compose time, before any network
contact. No server autoincrement, ever.

This is forced by the offline requirement: you must be able to create a
*referencable* entity while disconnected. A user types a message offline, then
edits it, then reacts to it. All three ops need a stable target ID, and the
server has never heard of the message.

**ULID over UUIDv4.** ULIDs are lexicographically sortable by creation time,
which makes them a natural, deterministic tiebreaker for pending messages that
have no `ord` yet. Same collision safety, better ordering properties, and
they're readable enough to debug.

### 10.2 Optimistic apply

Sending a message is a **local transaction first**:

```
1. Generate ULID.
2. INSERT into messages with state='pending', ord=NULL,
   created_at = client clock.
3. INSERT into outbox (kind='send'), after coalescing (§10.4).
4. Emit invalidation → UI renders it immediately.
5. Sync engine drains the outbox when connected.
6. On ack: set ord, rev, server created_at, state='acked'.
```

Steps 1–4 are one SQLite transaction and complete in well under a millisecond.
The UI never waits on the network to show what you typed.

### 10.3 Op kinds

| Kind | Target | Notes |
|---|---|---|
| `send` | message id | May reference blob ids that are not yet uploaded (§13.3) |
| `edit` | message id | LWW on body |
| `delete` | message id | Tombstone |
| `react` | message id + emoji | `present: 0 \| 1` |
| `read` | chat id | Max-register; safe to drop all but the newest per chat |
| `blob_upload` | blob id | Two-phase; must complete before the `send` that references it |
| `join` / `leave` | channel / room id | Membership change, not a chat op |

### 10.4 Outbox coalescing

**This is a correctness requirement, not an optimization.**

The bug class: a user composes a message offline, then edits it, then deletes
it. Naively you queue `send`, `edit`, `delete` — but `edit` and `delete` target a
message ID the server has never seen. Best case the server 404s and the ops go
to `failed`; worst case they arrive out of order and you get a ghost message.

Coalescing runs **on enqueue**, scoped by `target_id`:

| Queued | New op | Result |
|---|---|---|
| `send` | `edit` | Rewrite the `send` payload with the new body. One op. |
| `send` | `delete` | **Drop both.** Never touches the network. |
| `send` | `react` | Keep both, ordered — the react must follow the send. |
| `edit` | `edit` | Keep the last. |
| `edit` | `delete` | Drop the `edit`, keep the `delete`. |
| `react(add)` | `react(remove)` | Drop both (same emoji + user). |
| `read(ord=5)` | `read(ord=9)` | Keep the higher. Max-register. |

Get this in early. Retrofitting coalescing means auditing every op type against
every other op type, which is a combinatorial review nobody enjoys.

### 10.5 Ordering, retry, and failure

**Replay is in-order per chat.** Three messages typed offline must arrive in
the order typed. Drain the outbox by `seq` ascending, one in flight per chat
(cross-chat parallelism is fine and desirable).

**Retry** uses exponential backoff with jitter, driven by `next_at`. `nack` with
`retryable: false` moves straight to `failed`.

**`failed` needs a UI affordance.** A send queued into a chat the user was
removed from will never succeed. Silently retrying forever is worse than showing
an error with retry/discard actions. Every op kind needs a defined terminal
failure presentation.

**Queue bounds.** An unbounded outbox is a footgun — a user offline for a month
with a stuck op accumulates indefinitely. Cap the queue and surface pressure
rather than growing without limit.

### 10.6 Reordering on ack

A pending message renders at the bottom of the chat (sorted after
`head_ord`, tied on `created_at`). When the ack arrives it receives a real `ord`
— which may place it *above* messages that arrived while it was in flight.

The message visibly moves. This is correct and matches Slack. The alternative —
preserving local order — produces a client whose message order disagrees with
every other client, which is far worse. Confine the reorder to the tail so it
never disturbs scrollback the user is reading.

---

## 11. The read path

### 11.1 Shape

```
  renderer                    sync engine (utilityProcess)
     │                                 │
     │ ── query {id, sql-ish spec} ──▶ │  SQLite (synchronous, indexed)
     │ ◀───── rows {id, payload} ───── │
     │                                 │
     │ ◀──── invalidate {chat} ─────── │  (push, after any write)
     │                                 │
     │ ── query (refetch visible) ──▶  │
```

Queries are request/response with a correlation ID. Invalidations are pushes.

### 11.2 Coarse invalidation, not diffing

When the sync engine writes, it emits `{ type: 'invalidate', chat_id, reason }`.
The renderer refetches whatever is currently visible.

Deliberately coarse. Fine-grained diffs pushed over IPC would mean the renderer
maintains a mirror of the data, which reintroduces exactly the client-side
authoritative state we eliminated in §5. Refetching a 50-row page is sub-
millisecond; the simplicity is worth far more than the saved work.

**Corollary:** never push full message payloads over IPC as the primary delivery
mechanism. Push the *fact that something changed*; let the renderer query.

### 11.3 Pagination is mandatory

Structured-clone cost across the port is trivial for a page of 50 messages and
very much not trivial for a whole chat. Every list query is paginated,
keyset-style on `ord`:

```sql
SELECT * FROM messages
 WHERE chat_id = ? AND parent_id IS NULL AND ord < ?
 ORDER BY ord DESC LIMIT 50;
```

Keyset, not `OFFSET` — offset paging degrades linearly and breaks when rows are
inserted mid-scroll.

### 11.4 Backpressure

Catch-up writes must not starve reads. WAL gets us most of the way (readers do
not block on the writer). Beyond that, chunk catch-up into ~200-row transactions
with a yield between batches, so read queries interleave rather than queueing
behind a single large transaction.

---

## 12. Unread counters

### Why arithmetic alone is not enough

`server_head_ord − last_read_ord` gives a correct **chat** unread count, and
it has a lovely property: it works when you hold **none** of the messages. That
is exactly the unopened-chat case from R2 — accurate badges for every chat
while storing almost nothing.

But it cannot produce:

- **Mention counts.** You cannot know how many missing messages mention you
  without their bodies.
- **Thread unread**, separated from chat unread — because threads share the
  `ord` space (§8.2).
- Correct counts in the presence of **deletes**, which leave `ord` gaps.

### The decision

The **server** maintains per-`(actor, chat)` counters and pushes them:

```
{ chat_unread, thread_unread, mention_count }
```

They arrive in `welcome` (all chats, one frame) and in `counters` events as
things change. `server_head_ord − last_read_ord` is retained as a cheap sanity
check and a fallback if a counter is ever missing.

At team scale this is trivial server-side state: chats × actors, updated
on write. And once it exists, threads get their unread separation for free —
which is what collapsed the threads decision in §8.2.

### Read state convergence

`last_read_ord` is a **max register**, on the client and on the server. Applied
as `max(existing, incoming)`, never as an overwrite.

The failure this prevents: an actor reads a chat on their laptop, then their
phone — which has been asleep for an hour with stale state — reconnects and
syncs. Under LWW the phone's older value wins and the chat goes unread again.
Users find this maddening and it is trivially avoided.

---

## 13. Subsystem nuances

### 13.1 Auth and session

Identity model is in §6. This section covers the client mechanics.

The failure this section exists to prevent: **a user opens their laptop on a
plane and gets a login screen over a full local database.**

#### Do not host the auth flow in a BrowserWindow

This looks like the obvious approach and it breaks the primary use case.

RFC 8252 (*OAuth 2.0 for Native Apps*) requires the system browser, and more
practically **Google and Microsoft actively refuse OAuth inside embedded
webviews**. Since the whole point of adopting WorkOS is enterprise SSO through
Google Workspace and Entra ID, an embedded flow fails exactly the customers the
choice was made to serve.

The correct shape:

```
1. shell.openExternal(authkit_authorize_url)   ← system browser, PKCE challenge
2. user authenticates with their IdP
3. redirect → relayed://auth/callback?code=...
4. OS hands the URL back to the app
5. exchange code + PKCE verifier for tokens (in the sync process, never renderer)
```

- **PKCE is mandatory.** A desktop app is a public client; a client secret
  shipped in an Electron bundle is trivially extractable from the asar.
- `app.setAsDefaultProtocolClient('relayed')` plus
  `app.requestSingleInstanceLock()`.
- macOS delivers the callback via the `open-url` event; Windows and Linux via
  `second-instance` with argv parsing. Protocol registration also behaves
  differently unpackaged, so dev mode needs its own path.
- Loopback (`http://127.0.0.1:<port>/callback`) as a fallback where protocol
  registration is unreliable.
- **Tokens never reach the renderer.** The refresh token lives in `safeStorage`
  (OS keychain: Keychain / DPAPI / libsecret); the access token stays in memory
  in the sync process.

#### Two independent sessions

| Session | Purpose | Storage | On expiry |
|---|---|---|---|
| **Local session** | Unlocks the local DB and the UI | `meta` table | Long-lived. Cleared **only** on explicit sign-out. |
| **WorkOS session** | Authenticates the sync socket | Refresh token in `safeStorage`; access token in memory | Degrades **sync only**. |

Keeping these separate is what makes R3 hold. The local session is not a
security boundary — it is the thing that lets the app open when WorkOS is
unreachable.

#### Boot sequence — the network appears nowhere before render

```
1. Open SQLite, run migrations.
2. Read local session from meta.
3. Render the full UI from local data.        ← user is productive HERE
4. THEN start the sync engine.
5. Sync authenticates; on failure, show a non-blocking banner.
```

If step 3 ever comes to depend on step 4, R3 is broken. This ordering deserves
a dedicated test that runs with the network disabled.

#### Failure behavior

- **Access token expired, refresh succeeds:** in-band `reauth` (§9.7). Invisible.
- **Refresh fails (offline):** sync engine enters `unauthenticated`. Local reads
  continue. Dismissible "reconnect to sync" banner. Retry on network return.
- **Refresh token expired or revoked:** same as above, but the banner offers
  re-authentication. **Never clear local data** — a token expiring is not a
  sign-out, and treating it as one is catastrophic, silent data loss.
- **Explicit sign-out:** wipe the database and the blob directory. Shared
  devices are real.

#### Directory Sync

SCIM provisioning means actors are created and deactivated by IT. Deactivation
tombstones the actor (§6.3) and never deletes messages. Deactivation events
propagate to clients as ordinary actor updates, so a deactivated author renders
correctly offline.

Note the deliberate gap this leaves: deprovisioning stops sync but does not
recall data already on disk. That is an accepted exposure, recorded in §6.6.

#### Device identity

Each install generates a `device_id` at first run, stored in `meta`. Used to
scope outbox dedupe and to reason about multi-device read state.

### 13.2 The IPC contract

Concrete handshake, since it is easy to get subtly wrong:

```
1. Renderer loads → ipcRenderer.invoke('sync:attach')
2. Main creates a MessageChannelMain
3. Main sends port1 to the renderer (postMessage, transferable)
4. Main sends port2 to the utilityProcess
5. Renderer and sync engine now talk directly. Main is out of the loop.
```

Rules:

- **Re-handshake on every renderer load.** Ports do not survive reload. Hook
  `did-finish-load`, not just first creation.
- **The sync engine tracks N ports.** Multiple windows are normal. Detect closed
  ports and clean up their subscriptions, or you leak.
- **Invalidations broadcast to all live ports.**
- **The preload script exposes a narrow API** over `contextBridge`. Never expose
  the raw port or anything resembling arbitrary SQL to renderer code.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Non-negotiable.

### 13.3 Blob storage and attachments

**This is the subsystem most likely to silently break the offline experience.**
A perfectly synced chat full of broken image icons does not feel offline-
capable, whatever the message table says.

**Bytes go on the filesystem, not in SQLite.** Multi-MB rows bloat the database,
slow vacuum and backup, and make eviction expensive. Layout:

```
userData/blobs/<first-2-chars-of-id>/<id>
```

The two-character shard keeps directory entry counts sane on every filesystem.
SQLite holds metadata only (§8.3).

**Prefetch policy, in priority order:**

| Class | Policy | Rationale |
|---|---|---|
| Avatars | **All, eagerly, always.** `pinned = 1`. | Tiny, and their absence is the most visible offline failure. |
| Image thumbnails in synced chats | Eagerly, capped by total bytes | Makes scrollback look correct offline. |
| Full-size images, files | On demand; cached after first view | Unbounded otherwise. |

**Serving to the renderer:** register a custom scheme in main —
`protocol.handle('blob', ...)` — not `file://` paths. This keeps `webSecurity`
enabled and stops absolute filesystem paths leaking into the DOM. Register the
scheme as privileged **before** `app.whenReady()`.

Resolution order in the handler: local file → remote URL (if online) →
placeholder. That fallback chain is what makes the offline experience degrade
gracefully instead of showing broken-image glyphs.

**Offline upload is the most complex op in the system.** Two-phase:

```
1. User attaches a file while offline.
2. Copy it into the blob store IMMEDIATELY, with a local ULID.
   ← the source file may be moved or deleted before reconnect
3. Create a pending message referencing the local blob id.
4. Outbox holds: blob_upload(local_id) → send(message referencing it)
5. On reconnect: upload the blob, receive a server file id,
   rewrite the pending message's reference, THEN send the message.
```

The ordering dependency between `blob_upload` and `send` is a real constraint on
the outbox drainer — it is not a flat queue. Large uploads need resumability
(chunked, with an offset checkpoint). Budget real time for this.

**Eviction:** blobs whose message was evicted are deleted, plus an LRU cap on
total blob bytes. `pinned = 1` (avatars) is never evicted.

### 13.4 Search

Local FTS5. **If search hits the network, the app is not offline-capable in any
way a user recognizes** — search is the feature people reach for precisely when
they cannot remember where something was.

Verified available in `node:sqlite` (SQLite 3.53.4): FTS5, external-content
tables, WAL, incremental auto-vacuum, partial indexes, `RETURNING`, json1. **No
native module required.**

**External-content table, with the delete-ordering trap.** With
`content='messages'`, FTS5 does not own the data; it reads through to the base
table. That means on delete/update you must tell FTS the **old** value, and you
must do it **before** the base row changes:

```sql
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER messages_ad BEFORE DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body)
    VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER messages_au BEFORE UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body)
    VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER messages_au2 AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
```

`BEFORE` on delete/update, `AFTER` on insert. Get this backwards and the index
silently desynchronizes from the table — searches return rows that no longer
exist, or miss rows that do. Add a periodic `INSERT INTO messages_fts(messages_fts)
VALUES('integrity-check')` in debug builds.

**Other notes:**

- Search must exclude tombstones (`deleted = 0`) and respect eviction — the
  triggers handle eviction automatically, since eviction is a `DELETE`.
- Index size runs roughly 30–50% of the indexed body text. Factor into disk
  budgeting alongside blobs.
- `unicode61 remove_diacritics 2` is the sane default. If CJK or substring
  search matters, that needs the `trigram` tokenizer — a different index with
  different size characteristics. Decide before shipping, not after.
- **Local search covers the 90-day window only.** Beyond it, offer an explicit,
  clearly-labeled "search all history on the server" action, online only. Do not
  silently mix local and remote results — users must be able to tell what they
  are looking at.

### 13.5 Storage engine: node:sqlite

**Decision: `node:sqlite`, not `better-sqlite3`.**

The usual Electron + SQLite path is `better-sqlite3` plus `electron-rebuild`,
which means node-gyp, a native toolchain on every dev machine and CI runner,
rebuilds on every Electron upgrade, and platform-specific packaging pain.
`node:sqlite` is built into Node, ships with Electron, and needs none of it.

Verified feature parity for everything we need (see §13.4). The API is
synchronous, which is exactly why the database lives in a utility process (§5).

**Pragmas, and why each one:**

```sql
PRAGMA journal_mode = WAL;
```
Readers do not block on the writer. Essential — catch-up writes thousands of
rows while the UI is querying. Also substantially better write throughput.

```sql
PRAGMA synchronous = NORMAL;
```
Safe under WAL. `FULL` fsyncs on every commit and is needlessly slow for a
cache-like local replica whose worst-case loss is re-syncing recent data.

```sql
PRAGMA auto_vacuum = INCREMENTAL;   -- MUST be the first statement on a new file
```
**This must be the very first statement executed against a new database file —
before `journal_mode`, before any table.** Measured behavior on SQLite 3.53.4:

| Order | Result |
|---|---|
| `journal_mode=WAL` → `auto_vacuum=INCREMENTAL` | `auto_vacuum = 0` ❌ **silently ignored** |
| `auto_vacuum=INCREMENTAL` → `journal_mode=WAL` | `auto_vacuum = 2` ✅ |

Setting WAL materializes the database header; after that, `auto_vacuum` can only
be changed by a full `VACUUM`. The pragma **fails silently** — no error, no
exception, it just reports `0`.

The consequence is not theoretical: without incremental auto-vacuum, 90-day
eviction (§13.6) deletes rows but never returns pages to the filesystem. The
database grows monotonically forever, and the only recovery is a full `VACUUM`
that locks the file for seconds — or a dump-and-reload migration on every
install in the field.

**Assert the value at boot** (`SELECT * FROM pragma_auto_vacuum()` must return
`2`) rather than trusting that the pragma ran. This is cheap insurance against a
failure whose symptom appears months later on someone else's disk.

```sql
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

**CHECK constraints and NULL.** A CHECK rejects a row only when it evaluates to
**FALSE**; a CHECK that evaluates to **NULL passes**. Since `NULL IN (...)`,
`NULL = x`, and `NULL <> x` are all NULL, the natural way to write a constraint
over a nullable column silently permits exactly the row it was meant to forbid:

```sql
-- WRONG: a channel with NULL visibility passes. FALSE OR NULL → NULL → passes.
CHECK (kind IN ('dm','group_dm') OR visibility IN ('public','private'))

-- ALSO WRONG: moving it into a CASE does not help. NULL IN (...) is still NULL.
CHECK (CASE WHEN kind IN ('dm','group_dm') THEN visibility IS NULL
                                           ELSE visibility IN ('public','private') END)

-- RIGHT: an explicit IS NOT NULL forces a definite FALSE.
CHECK (CASE WHEN kind IN ('dm','group_dm')
            THEN visibility IS NULL
            ELSE visibility IS NOT NULL AND visibility IN ('public','private') END)
```

This is worth a test per constraint rather than a careful read — both wrong
forms above look obviously correct, and neither fails loudly. The `spaces`
policy matrix (§8.3) is exactly the kind of table where this hides.

**Migrations:** `user_version` pragma, forward-only, each migration in its own
transaction, run at boot before anything else touches the file. The local
database is a replica — if a migration is genuinely infeasible, dropping and
re-syncing is an acceptable escape hatch that a server database never has. Do
not over-engineer migration tooling.

**Concurrency:** one connection, owned by the utility process, one writer. Do
not open the file from main or from renderers. Every access goes through the
sync engine.

### 13.6 Retention and eviction

Target: a rolling ~90-day window.

**Rule 1 — evict by thread, not by message.**
A thread root from 120 days ago with a reply from yesterday must be retained.
Evicting the root orphans the reply and produces a reply UI with no parent. The
retention key is the **thread's last activity**, applied to the whole thread.

**Rule 2 — never evict above `last_read_ord`.**
Do not delete unread messages out from under someone who has been away. Cap it
so an abandoned chat cannot pin unbounded history: if honoring the rule would
retain more than N messages, evict anyway and set `has_gap = 1`.

**Rule 3 — always update `oldest_local_ord` after eviction.**
This is what lets the UI know that scrolling past a point requires a backfill —
and, when offline, show "older messages need a connection" instead of an
apparently-empty chat. Without it, eviction is indistinguishable from data
loss to the user.

**Rule 4 — cascade to blobs and FTS.**
FTS is automatic via the delete trigger (§13.4). Blobs need an explicit sweep.

**Execution:**

- Runs in the utility process on a schedule (idle-triggered, e.g. hourly).
- Bounded batches inside transactions. Never one giant `DELETE`.
- Reclaim with `PRAGMA incremental_vacuum(1000)` between batches. **Never a full
  `VACUUM`** — it locks the database for seconds and freezes the app.
- Also GC reaction tombstones older than the sync horizon.

**Interaction with gap markers:** eviction and gaps are the same phenomenon from
opposite ends — a gap is missing history *below* the head; eviction *creates*
missing history at the bottom. Both are described by `oldest_local_ord` +
`has_gap`, and both are repaired by the same backfill path. Design them
together; bolting retention on later means rediscovering this.

### 13.7 Clocks and time

Client clocks are unreliable — skewed, adjusted by NTP mid-session, occasionally
years wrong. Rules:

1. **Server time is authoritative** for anything cross-device. `created_at`,
   `edited_at`, and reaction `updated_at` are stamped by the server on ack.
2. **Client time is display-only, for pending items**, and is overwritten by the
   server value on ack.
3. **LWW comparisons use server time only.** An optimistically-applied local
   value is marked as such and always loses to a server value, regardless of
   timestamps.
4. **Ties break on `actor_id`** — lexicographic, deterministic across replicas.
   Two replicas must never disagree about a tie.
5. `welcome` carries `now`, so the client can compute clock skew and warn when
   it is extreme (a badly-wrong clock produces confusing timestamps everywhere).

### 13.8 Agents

Full identity and delegation model in §6.3–6.5. The operational summary:

**Unified at the data model, separate at the transport.** Agents share the
`actors` table, the handle namespace, and the authorship column. They do **not**
run the local-first sync engine — no Electron app, no SQLite replica, no outbox,
no cursors. They are a server-side service consuming the committed message
stream.

This is why "agents are just users" is true where it matters (every query,
index, and membership check treats them identically) without dragging the entire
client architecture into the agent runtime.

**Invocation is asynchronous and online-only.** An agent observes a mention only
once the message is durably committed server-side. A user who tags an agent
while offline will not get a reply until they reconnect and the outbox drains —
a visible product behavior that falls directly out of the write path (§10), not a
bug to engineer around.

**Replies are ordinary messages.** They travel the normal write path and reach
clients as normal live events. No streaming; any future partial output will be
batched into discrete messages. Attribution rides on `author_id` (always the
agent) plus `on_behalf_of_actor_id` (whose authority was spent).

**Client versions in the wild.** Updates are opt-in, so old clients persist for
months — see [`RELEASE.md`](RELEASE.md) for the distribution model and §9.10 for
the protocol rules that keep them working.

**Delivery guarantees may diverge later.** Humans tolerate gaps; an agent
missing a mention it was meant to act on is a correctness bug. Since agents read
server-side rather than through gap-marked client sync, this is currently a
non-issue — worth revisiting only if agents ever consume the client protocol.

### 13.9 The persistent connection

A desktop app gets opened and left open. The socket is therefore open all day,
which raises a fair question: is that actually viable at scale?

**Yes, with wide margin.** Measured on Node 26.8.1 / `ws` 8.21.3, 10,000
concurrent connections, macOS arm64 over loopback:

| Metric | Measured |
|---|---|
| Server RSS per idle connection | **8.7 KB** (11.4 KB once traffic has flowed) |
| 10k connections, server RSS | 48 MB → 133 MB |
| Idle CPU at 10k connections | **0.005% of one core** |
| Heartbeat sweep, 10k pings | 67 ms CPU → **0.23% of a core** at one sweep/30s |
| Fanout of a 223 B event to 10k | 37 ms wall → **268k sends/sec** |
| Connection accept rate | 8,628/sec |

**Read those as lower bounds.** Kernel socket buffers do not appear in process
RSS (add ~10–40 KB/conn); there is no TLS in the measurement, which adds
per-connection state and drops the accept rate substantially since a handshake
costs 1–3 ms of CPU; and the target is Linux, not macOS. **A defensible planning
number is 30–60 KB per connection all-in.**

At our scale — ~10k seats, ~40% concurrent at peak, so ~4,000 connections —
that is **~200 MB and well under 1% of a core**. A second instance is for
availability, not capacity. Database and fanout limits arrive long before
connection count does.

**Steady state is not the constraint. Every real risk is in a transition.**

#### Turn permessage-deflate off

`ws` supports it and it looks free. Measured cost of the zlib contexts a single
compressed connection requires:

| Context | Memory |
|---|---|
| deflate, zlib defaults (what `ws` uses) | **159.8 KB** |
| inflate, zlib defaults | 28.8 KB |
| **per connection** | **~189 KB — roughly 17× the connection itself** |

At 10k connections that is **1.8 GB of pure compression state**. Tuning to
`windowBits: 10, memLevel: 4` gets it to ~67 KB, still 6×. Our frames are small
JSON — mostly under 1 KB — where compression buys little. It is off by default
in `ws`; the failure mode is someone enabling it believing it is free.

#### Heartbeat every ~30s, and that is a floor

Not tuning. Intermediaries close idle connections:

| Intermediary | Idle timeout |
|---|---|
| AWS ALB | **60s default** (configurable to 4000s) |
| Cloudflare | **100s** on Free/Pro; configurable on Enterprise |
| nginx `proxy_read_timeout` | **60s default** |

Anything slower and the proxy silently closes the socket. The cost is nothing:
~334 KB/day per client, ~19 KB/s server-side at 5k connections.

#### Zombie sockets after sleep/wake

**The failure most likely to generate support tickets.** When a laptop sleeps,
TCP is not gracefully closed. On wake the socket *looks* open but is dead — the
client sits believing it is connected while receiving nothing. This is the
mechanism behind every "it didn't show me messages until I clicked around"
complaint about chat apps.

Two mitigations, both required:

- **Heartbeat with a deadline.** No pong within N seconds → treat the connection
  as dead and reconnect. A read timeout, not just a liveness ping.
- **`powerMonitor.on('resume')`** → proactively tear down and reconnect rather
  than waiting for a TCP timeout, which can take minutes on a half-open socket.

Network changes (wifi → cellular → different wifi) produce the same zombie and
are caught by the same mechanism.

#### Why the socket's process placement matters here

Chromium throttles timers in background renderers — 1/second once hidden,
dropping to 1/minute after five minutes of "intensive throttling." That would
stretch a 30s heartbeat past every timeout in the table above, and the symptom
would look like a mysterious network bug rather than a throttling one.

The socket lives in a `utilityProcess` (§5) — a Node/libuv environment with no
renderer page — so renderer throttling should not apply. That is a real dividend
from a decision made for entirely different reasons. **Verify it in Phase 0**
rather than assuming: it is exactly the kind of platform behavior that is easy
to be confidently wrong about.

macOS App Nap applies at app level and can coalesce timers even outside a
renderer. Worth measuring in the same spike. `powerSaveBlocker` can suppress it
but costs battery, and should not be held by a chat app as a matter of course.

---

## 14. Invariants and failure modes

The checklist. Each of these has a specific failure it prevents; each deserves a
test.

| # | Invariant | What breaks without it |
|---|---|---|
| 1 | `synced_through_rev` advances only across **contiguous** runs | Silent permanent history holes; client believes it is caught up |
| 2 | `ord` is **never** renumbered or reused | Read cursors and scroll positions corrupt across clients |
| 3 | `last_read_ord` is a **max** register, never LWW | Channels spontaneously un-read when a stale device syncs |
| 4 | Message IDs are **client**-generated | Offline compose, edit, and react are all impossible |
| 5 | Server ops are **idempotent on `op_id`**, returning the same `ord` | Duplicate messages on ack-loss retry |
| 6 | Outbox coalesces on enqueue | Ops targeting messages the server has never seen |
| 7 | Outbox replays **in order per channel** | Offline-composed messages arrive shuffled |
| 8 | Reaction removals keep a **tombstone** | Removed reactions resurrect from a late replay |
| 9 | Boot renders from local **before** any network call | R3 broken; login screen over a full database |
| 10 | Auth failure never clears local data | Catastrophic, silent user data loss |
| 11 | `auto_vacuum = INCREMENTAL` is the **first statement on a new file**, before `journal_mode` | Pragma silently ignored; unreclaimable disk growth; field migration to fix |
| 12 | FTS delete/update triggers are **BEFORE**, insert is **AFTER** | Search index silently desyncs from the table |
| 13 | Only the utility process opens the database | Write conflicts, `SQLITE_BUSY`, corruption risk |
| 14 | Eviction is thread-granular and updates `oldest_local_ord` | Orphaned replies; eviction looks like data loss |
| 15 | Every read path query is paginated | IPC stalls and memory spikes on large chats |
| 16 | **No identity reference below Layer 2** — nothing but `actors` holds a `workos_*` id | Agents become second-class; nullable columns spread through the schema |
| 17 | Nothing is keyed on **email** | Breaks on every email change; agents have none at all |
| 18 | Auth flow uses the **system browser**, never a `BrowserWindow` | Google/Entra refuse embedded webviews — enterprise SSO fails outright |
| 19 | Delegations are minted at **execution** time, not compose time | A queued invocation replays an expired grant |
| 20 | Effective agent permission is the **intersection** of agent and invoker | Confused deputy: the agent spends its own authority for someone who lacks it |
| 21 | Delegation records are **never replicated to clients** | An offline client cannot evaluate expiry; authorization state drifts |
| 22 | **Every message lives in a chat**; nothing references a space directly | Four parallel message pipelines, each with its own cursor and catch-up |
| 23 | Space membership is the **leading conjunct** of the access predicate | Orphaned access to a private chat after removal; "who can see this" loses a single answer |
| 24 | Exactly one `sole`/`default` chat per space, **enforced by index** | A room with no shared floor, or a channel with two message lists |
| 25 | Joining a space uses the **gap path**, never a full-history push | A join stalls the client and floods the socket with backlog |
| 26 | Automatic inactivity produces `dormant`, **never** `archived` | Auto-archival locks an active-but-slow room read-only |
| 27 | Every CHECK over a **nullable** column guards `IS NOT NULL` explicitly | A CHECK evaluating to NULL passes — the constraint silently permits what it forbids |
| 28 | `permessage-deflate` stays **off** | ~189 KB/connection of zlib context — 17× the connection — for negligible gain on sub-1 KB JSON |
| 29 | Heartbeat interval **< 30s**, with a read deadline | Proxies close the socket at 60s (ALB, nginx) or 100s (Cloudflare); without a deadline a dead socket looks alive |
| 30 | Reconnect on `powerMonitor` **`resume`**, do not wait for TCP | A post-sleep zombie socket reports healthy while delivering nothing |
| 31 | Reconnect backoff carries **full jitter** | Synchronized catch-up bursts; ~180 MB of `welcome` generation in one instant at 10k clients |
| 32 | An **unknown event type still advances the cursor** | The frontier stalls forever; the client silently stops receiving that chat (§9.10) |
| 33 | Inbound frames are parsed **permissively** — never a strict schema | A field added server-side breaks every older client in the field (§9.10) |
| 34 | `hello` carries a **protocol version**, server can demand an upgrade | Updates cannot be forced; without this there is no backstop for a stale client (§9.10) |

### Scenarios to test explicitly

- Out-of-order live events arriving during catch-up → cursor must not skip.
- Ack lost after the server committed → retry must not duplicate.
- Compose → edit → delete, all offline → zero network ops.
- Read on device A, then a stale device B syncs → channel stays read.
- Token expires while offline → app still opens and reads.
- Renderer reload → sync continues; port re-handshakes.
- Offline for a week across 150 chats → reconnect is fast; badges correct
  before any message body arrives.
- Attach a file offline, delete the source file, reconnect → upload succeeds.
- Eviction runs mid-scroll → UI shows a backfill boundary, not an empty void.
- **Boot with the network disabled** → full UI renders from local; no login screen.
- Refresh token expires while offline → local reads unaffected; banner only.
- Actor deactivated via SCIM → their past messages still render, offline included.
- Agent invoked by an offline user → no reply until that user's outbox drains.
- Actor removed from a channel → local history frozen, readable; no new events.
- Removed actor re-added → the gap machinery backfills the missing interval.
- Join a room with 10k messages of history → `gap` + tail, not a bulk push.
- Private room → public → non-members see it in the directory, sync nothing.
- Public room → private → clients that had it keep their local copy.
- Actor removed from a room → loses every chat in it, private ones included.
- Post into a dormant room → it wakes; no explicit unarchive needed.
- Attempt to delete a room's default chat → rejected by the unique index.
- Every `spaces` CHECK, exercised with NULL in the guarded column (invariant 27).
- Deliver an **unrecognised `op`** to a client → cursor advances past it, and a
  later known event still applies (invariant 32). This is the test that protects
  every future client from a silent stall.
- Add an unknown field to `welcome` → older client parses it without error.
- Sleep the machine for 10 minutes, wake → reconnect is prompt, no zombie socket.
- Kill the network mid-session → heartbeat deadline fires, backoff begins.
- Restart the server with N clients attached → reconnects spread across the
  jitter window, no synchronized catch-up burst.

---

## 15. Build order

Sequenced so each step de-risks the next. Do not reorder — the early items are
the ones that are expensive to change later.

**Phase 0 — Skeleton**
1. Electron app: main + `utilityProcess` + one renderer.
2. `MessageChannelMain` handshake, including re-attach on renderer reload.
3. `node:sqlite` open, pragmas (auto_vacuum **first**), migration runner.
4. *Verify:* `node:sqlite` behaves identically under Electron's bundled Node.
4b. *Verify:* a `utilityProcess` timer is **not** subject to Chromium renderer
    throttling, and survives macOS App Nap, by holding a 30s heartbeat with the
    window hidden and backgrounded for an hour (§13.9).

**Phase 1 — Identity** ← now a prerequisite: the socket cannot authenticate without it
5. WorkOS org + AuthKit; system-browser flow with PKCE and `relayed://` callback.
6. Token storage in `safeStorage`; `reauth` refresh path (§9.7).
7. `actors` table, org/workspace scoping, handle namespace.
8. *Spike:* M2M Applications vs Agent Registration for agent identity (§16, item 6).
9. *Milestone:* sign in via a real IdP; tokens never touch the renderer.

**Phase 2 — The sync core** ← the risky part, do it before any UI polish
10. Server: channels, messages, atomic `ord`/`rev`, idempotent ops.
11. Protocol: `hello`/`welcome`, live events, `catchup`, `gap`.
12. Client cursors + **contiguity logic** incl. `pending_revs` (invariant 1).
    `spikes/sync-model.mjs` is the executable reference; `spikes/sync-tests.mjs`
    is the acceptance suite — port it rather than rewriting it.
13. Outbox with coalescing (invariant 6) and in-order replay (invariant 7).
14. *Milestone:* two clients exchange messages; kill the server, keep reading;
    compose offline, reconnect, converge.

**Phase 3 — R2 and R3, provably**
15. Server counter service; `counters` events.
16. Sidebar badges for every chat from `welcome` alone.
17. Boot-from-local ordering (invariant 9); auth degradation without data loss.
18. *Milestone:* badges climb on channels never opened; airplane mode is
    indistinguishable from online for reads.

**Phase 4 — Product surface**
19. Threads (shared `ord`, parent-keyed backfill).
20. Reactions (LWW-set, tombstones).
21. Edits and deletes.
22. FTS5 + triggers + integrity check.

**Phase 5 — Agents and delegation**
23. Agent actors; server-side agent service consuming the committed stream.
24. Delegation minting, intersection checks, `on_behalf_of` attribution.
25. WorkOS Pipes connections; Relay-backed third-party calls.

**Phase 6 — The long tail**
26. Blob store, prefetch, `blob://` protocol handler.
27. Two-phase offline upload with resumability.
28. Retention, eviction, incremental vacuum.
29. Notifications, tray.

**Phase 4b — Rooms** (§7), immediately after threads, since both touch containment
19a. `spaces` (kind-discriminated), `chats`, two-level `memberships`.
19b. Access predicate; room membership as precondition.
19c. Visibility transitions; join-as-gap; the online-only room directory.
19d. Lifecycle: `dormant` (UI filter) and `archived` (frozen cursor).

---

## 16. Open questions

Things this document deliberately does not resolve. Resolve them with a spike,
not with more design.

1. **`node:sqlite` under Electron.** Verified on Node 26 standalone: SQLite
   3.53.4, all required features present, and **the full §8.3 schema plus the
   §13.4 FTS triggers execute clean (28 statements, 0 failures)** with
   insert/edit/delete round-tripping correctly through the search index and
   `integrity-check` passing. Electron bundles its own Node build — almost
   certainly fine, but this is load-bearing enough to re-confirm in Phase 0
   before anything is built on it.
2. **`MessagePort` lifecycle across renderer reload.** Does a clean re-handshake
   suffice, or is there a leak/race on rapid reloads? Spike in Phase 0.
3. **Gap threshold.** ~500 revs is an educated guess. Tune against real traffic.
4. **Live fanout ceiling.** At what channel count does "receive everything" stop
   being free? Believed to be far above 50; worth measuring before it matters.
5. **Tokenizer choice.** `unicode61` vs `trigram` depends on whether CJK and
   substring search are requirements. Decide before shipping search.
6. **WorkOS M2M Applications vs Agent Registration for agent identity.**
   Genuinely unresolved. M2M is the safe default — client-credentials JWTs
   validated locally against cached JWKS, a good fit for a long-lived service.
   Agent Registration is WorkOS's purpose-built agent path (per-agent client
   IDs, scoped credentials, own audit trail) but is a newer surface, and the
   docs do not make clear whether it targets persistent services or
   request/response agents. **Explore during the auth implementation phase**;
   switching is contained to the identity layer (§6.3) because nothing below
   Layer 2 references an identity.
7. **Encryption at rest.** Deferred, not dismissed — and now coupled to
   offboarding rather than being purely a data-at-rest question (§6.6).
   SQLCipher costs a native module (reintroducing everything §13.5 avoids) and
   slows FTS; app-level field encryption breaks FTS entirely. Revisit when a
   customer's security review forces it.
8. **Connection ceiling per node.** Measured 8.7–11.4 KB/conn process RSS
   without TLS on loopback (§13.9); the all-in figure with TLS and kernel
   buffers on Linux is estimated at 30–60 KB and has not been measured. Worth
   one afternoon on a real host before capacity planning depends on it.
9. **Agent rate limiting.** An agent can generate messages far faster than a
   human. Where does backpressure live — server-side quota, or client-side?
10. **Delegation scope granularity.** "Room + time + action" is the shape, but
   the action vocabulary is unspecified. Settle alongside the Rooms design,
   since rooms are the natural scope boundary.

**Validated by executable model** (`spikes/`, 66 assertions, all green; the
suite itself is mutation-tested — 6/6 deliberate implementation bugs caught):
ord/rev separation, cursor contiguity under out-of-order delivery, gap markers
and their bounded tail, catch-up below threshold, keyset backfill paging,
op idempotency, unread correctness while holding zero messages, max-register
read state, reorder-on-ack, threads sharing the ord space, outbox coalescing,
and removal-freeze / re-add-as-gap. The model found one design gap —
`pending_revs` (§8.1) — which is now in the schema.

**Resolved since the first draft:** multi-account storage (one database per
`(account, workspace)` pair, §6.1); whether agents run client- or server-side
(server-side, §6.5); revoke-on-removal (not required — removal freezes the local
copy rather than recalling it, §6.6).

---

## Appendix: quick reference

**The two counters**

```
ord — assigned on message creation only, never changes, never reused
      → display order, read cursor, retention boundary, backfill paging

rev — bumped by any mutation (message, edit, delete, reaction)
      → sync cursor only
```

**The two watermarks**

```
synced_through_rev — I HAVE everything up to here (contiguous, no holes)
server_head_rev    — the server SAYS this much exists (may be far ahead)
```

**The four convergent types**

```
append-only log  → messages
LWW register     → message body, channel name/topic
MAX register     → last_read_ord            ← not LWW, this matters
LWW-set by user  → reactions (message, emoji, user)
```

**The identity layering**

```
Layer 1  IDENTITY       WorkOS (User / M2M app)     ← authentication
Layer 2  ACTOR          humans + agents, unified    ← the ONLY place a
Layer 3  PARTICIPATION  messages, memberships          workos_* id may appear
```

**Delegated access**

```
allow(agent for alice, action, resource) ⟺
      can(agent, action, resource)     ∧  can(alice, action, resource)
   ∧  valid_delegation(alice → agent, scope, now)
```

**Containment**

```
chat = the SYNC unit      (ord, rev, cursors, unread, eviction all key on it)
space  = the PERMISSION unit   one table, kind ∈ channel|dm|group_dm|room

channel / dm / group_dm → exactly one chat ('sole')
room                    → one 'default' + N 'public' + N 'private'

access(actor, chat) ⟺ actor ∈ members(chat.space_id)
                    ∧ (chat.kind ≠ 'private' ∨ actor ∈ members(chat.id))
```

**The one rule**

> Every read **of data the actor has access to** is served from local SQLite.
> Always. A feature that reads granted data from the network is a bug.
> (Discovery of not-yet-granted content is outside the rule, not an exception
> to it — §3.)
