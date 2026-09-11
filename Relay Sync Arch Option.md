# Relayed Local-First Sync Architecture

**Status:** Settled production target  
**Realtime transport:** AWS AppSync Events  
**Durable source of truth:** PostgreSQL domain tables plus `sync_events`  
**Client replica:** SQLite, owned by the Electron utility process  
**Last updated:** 10 September 2026

## 1. Executive summary

Relayed is a server-authoritative, local-first desktop workspace. The server decides canonical order, permissions, timestamps, and accepted mutations. Each desktop keeps a partial SQLite replica and serves every normal product read from that replica, including while offline. AWS AppSync Events supplies low-latency live delivery, but it is not the database, mutation API, catch-up store, history service, or source of authorization truth.

The production model is:

```text
                        WorkOS
                identity + org membership
                           │
                           ▼
                 ┌──────────────────┐
                 │ Relayed backend  │
                 │                  │
                 │ sessions + can() │
                 │ mutations        │
                 │ bootstrap        │
                 │ catch-up         │
                 │ backfill         │
                 └────────┬─────────┘
                          │
                    PostgreSQL
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
       domain tables              sync_events
   messages, spaces, etc.    durable semantic changes
                                       │
                                publisher worker
                                       │ IAM publish
                                       ▼
                              AWS AppSync Events
                                       │
                             authorized live fanout
                                       │
                                       ▼
                         Electron utility process
                         AppSync + sync scheduler
                                       │
                                local SQLite
                                       │ invalidations
                                       ▼
                                  React UI
```

Beside the inbound path is the offline write path:

```text
React intent
    │
    ▼
SQLite optimistic row + SQLite outbox entry
    │
    ▼ when online
Relayed HTTPS mutation API
    │
    ▼
Postgres domain mutation + sync_event in one transaction
```

The three most important distinctions are:

1. **A chat is an ordered sync stream; a space is normally the permission and fanout audience.**
2. **`rev` synchronizes mutations; `ord` orders and paginates message history.**
3. **Catch-up replays missed events; backfill hydrates current historical rows that the partial replica intentionally does not hold.**

These distinctions let one system cover channels, DMs, group DMs, rooms with multiple chats, private room chats, personalized state, and future non-chat features without creating parallel sync engines.

---

## 2. What is settled, and what changes from the current repository

The repository already establishes the important client-side model:

- the server owns canonical order;
- `ord` and `rev` are per chat;
- SQLite is the client read path;
- the Electron utility process owns both synchronization and SQLite;
- clients keep per-chat cursors, gap markers, and a local outbox;
- catch-up is keyed by `rev` and history backfill by `ord`;
- the server owns unread and mention counters;
- authorization is centralized through `can()`;
- WorkOS owns identity and organization membership, while Relayed owns product authorization.

The current Phase 2 implementation is intentionally narrower. Its server catch-up feed derives message and delete events by querying materialized message rows, and edits are deferred. That is sufficient for the present milestone, but it cannot preserve a complete mutation sequence once edits, reactions, space changes, private-chat placement, actor updates, and other product state all participate in replication.

The production evolution settled here is therefore:

> Add a generic, durable PostgreSQL `sync_events` table. Write each replicated semantic event in the same transaction as its domain mutation. Use that table both as the catch-up log and as the reliable source consumed by an AppSync publisher.

This is not raw PostgreSQL change-data capture. Clients should receive product-level facts such as `message.created`, `message.edited`, `reaction.changed`, or `space.renamed`, not statements such as “column X of row Y changed.” One logical product mutation can update several internal rows while producing one client-facing event.

---

## 3. The mental model

Keep these concepts separate in code, schemas, protocol types, and discussions:

```text
WORKSPACE
    tenancy boundary
    local replica boundary

SPACE
    user-facing container
    ordinary authorization and fanout boundary
    kind = channel | dm | group_dm | room

CHAT
    universal message container
    independently ordered durable sync stream
    owns ord, rev, history, cursor, unread state, and eviction state

ACTOR
    a human or agent identity inside Relayed
    authorization subject
    recipient of personalized state

DEVICE
    connection/session and idempotency metadata
    not the normal fanout boundary
```

### 3.1 Space versus chat

Internally, channels, DMs, group DMs, and rooms are all spaces, but their policy and lifecycle differ:

```text
Workspace ACME

Space: #engineering              Space: Design Room
kind = channel                   kind = room
       │                               │
       └── Chat A (sole)               ├── Chat B (default)
                                       ├── Chat C (public)
                                       ├── Chat D (public)
                                       └── Chat E (private)
```

- A channel, DM, or group DM has exactly one `sole` chat.
- A room has one structural, undeletable `default` chat and may have additional public or private chats.
- Users continue to see product terms such as channel, DM, and room; `space` is the unifying internal concept.

For Design Room, Chats B, C, and D share the same ordinary audience: the room's members. Each chat nevertheless has its own `rev`, `ord`, catch-up cursor, message history, and unread state. Chat E has a narrower audience.

Therefore:

> **Chat is the sync unit. Space is the ordinary permission and transport-fanout unit.**

Do not move chat cursors to the space. A single space can contain independently changing chats, and forcing them through one space cursor would couple their ordering, recovery, history, and retention for no benefit.

### 3.2 Private chat access

The access predicate is:

```text
access(actor, chat) =
    member(actor, chat.space_id)
    AND
    (
      chat.kind != private
      OR member(actor, chat)
    )
```

The space-membership condition is deliberately first and unconditional. An actor cannot retain access to a private chat after removal from its parent space merely because a stale chat-membership row remains.

### 3.3 `ord` and `rev` solve different problems

Every mutation in a chat receives a `rev`. Only a newly created message receives an `ord`.

```text
ord — message ordinal
      assigned only on message creation
      never changes and is never reused
      used for display order, read cursors, retention, and history pagination

rev — chat revision
      incremented for every durable chat mutation
      used only for replication and convergence
```

Example:

```text
rev 8141, ord 5522  Alice creates a message
rev 8142            Bob edits an older message
rev 8143            Carol adds a reaction to an older message
rev 8144            A message is deleted; its original ord is retained as a tombstone
```

Edits and reactions must synchronize, but they must not move a message or create unread-message ordinals. One counter cannot safely perform both jobs.

Thread replies share the containing chat's `ord` and `rev` spaces. Separate server-owned counters provide `{chat_unread, thread_unread, mention_count}` without multiplying cursor streams per active thread.

---

## 4. Durable server model

### 4.1 PostgreSQL has two complementary representations

```text
domain tables
    current materialized product state
    optimized for ordinary reads and snapshots

sync_events
    ordered semantic changes
    optimized for catch-up and reliable live publication
```

The materialized tables answer “what is true now?” The event log answers “what durable changes occurred after revision N?” Neither replaces the other.

### 4.2 Generic `sync_events`, not a chat-only event table

A conceptual production schema is:

```sql
CREATE TABLE sync_events (
  event_id            TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,

  stream_kind         TEXT NOT NULL,
  stream_id           TEXT NOT NULL,
  stream_rev          BIGINT NOT NULL,

  event_type          TEXT NOT NULL,
  payload             JSONB NOT NULL,

  fanout_scope        TEXT NOT NULL,
  fanout_scope_id     TEXT NOT NULL,
  fanout_generation   BIGINT NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL,
  published_at        TIMESTAMPTZ,
  publish_attempts    INTEGER NOT NULL DEFAULT 0,
  next_publish_at     TIMESTAMPTZ,

  UNIQUE (workspace_id, stream_kind, stream_id, stream_rev)
);
```

The exact operational columns may evolve, but the separation between sync identity and fanout audience is load-bearing:

```text
sync identity:
    stream_kind + stream_id + stream_rev

delivery audience:
    fanout_scope + fanout_scope_id + fanout_generation
```

Examples:

```text
stream = chat:C
rev = 83
event_type = message.created
fanout = space:design-room generation 12
```

```text
stream = space:design-room
rev = 31
event_type = space.renamed
fanout = space:design-room generation 12
```

```text
stream = actor:alice
rev = 109
event_type = read_state.changed
fanout = actor:alice generation 4
```

Future product areas can use the same infrastructure:

```text
stream = document:doc_88, rev = 41
stream = task:task_92, rev = 18
```

There should not be a single workspace-wide revision as the primary sync cursor. A global revision forces unrelated features into one sequence and produces intentional holes for actors who are not authorized to see most workspace events. Independent streams keep ordering local to the state that actually needs it.

### 4.3 One table can be both event log and server-side outbox

The client `outbox` and server `sync_events` have different responsibilities:

```text
SQLite outbox
    pending client-authored operations, especially while offline

Postgres sync_events
    committed server-authored semantic events retained for catch-up
    and awaiting or recording live publication
```

A separate server outbox is valid, but at Relayed's scale it would duplicate much of `sync_events`. The chosen starting model treats an unpublished `sync_events` row as the publisher's work item. The publisher may mark publication state on that row or in a small companion delivery table if leasing and retry accounting demand it.

Do not delete an event merely because AppSync accepted its publication. Live delivery and catch-up have different lifetimes. Events remain until the sync retention policy says a stale cursor must receive a gap or snapshot instead of replay.

### 4.4 Atomic write invariant

For every durable replicated mutation:

```text
BEGIN
  authorize against current Relayed state
  allocate the stream's next rev
  allocate ord too, only for a new message
  update domain tables
  append sync_event with matching rev and fanout metadata
COMMIT
```

The domain change and event append must never commit independently. This closes both classic failure windows:

- domain row committed but event absent: clients can remain wrong forever;
- event committed but domain row absent: catch-up describes state that does not exist.

For chat writes, `ord` and `rev` are allocated under a per-chat lock in the same transaction. Serializing writes per chat is desirable at team scale because the product wants one canonical order, not client-side conflict reconciliation.

### 4.5 Publisher behavior

The publisher reads committed, due, unpublished events and publishes them to AppSync using an IAM-authorized backend identity.

The publisher is at-least-once. A crash after AppSync accepts a publish but before `published_at` is recorded can produce a duplicate. Clients therefore deduplicate by `(stream_kind, stream_id, stream_rev)` and/or `event_id`.

Publication rules:

1. Never publish uncommitted data.
2. Preserve order per logical stream when practical, but never depend on transport ordering for correctness.
3. Retry transient failure with exponential backoff and jitter.
4. Record attempts, latency, and terminal operational failure.
5. Before publishing to a generation-scoped audience, confirm that the event is still allowed to use that generation. If the audience generation has since rotated because recipients were removed, suppress publication to the stale channel. Authorized clients recover the event through catch-up.
6. Marking an event published does not make it eligible for immediate deletion.

The fifth rule prevents a queued pre-revocation event from being published to an old channel after a membership removal has committed.

---

## 5. AppSync Events is the live delivery plane

AppSync's job is intentionally narrow:

```text
committed sync event
        │
        ▼
low-latency authorized fanout
        │
        ▼
connected devices
```

AppSync is not used for:

- accepting domain mutations from desktops;
- storing the durable sync log;
- answering `catchup(from_rev)`;
- historical message backfill;
- computing permissions;
- maintaining canonical unread counts;
- resolving write conflicts or allocating `ord`/`rev`.

This preserves Relayed's protocol independently of the live transport. AppSync can later be replaced without redesigning Postgres, catch-up, backfill, SQLite, or the outbox.

### 5.1 Channel topology

The recommended logical channel forms are:

```text
/space/{workspaceId}/{spaceId}/{generation}
/private/{workspaceId}/{chatId}/{generation}
/actor/{workspaceId}/{actorId}/{generation}
/workspace/{workspaceId}/{generation}        # optional, use sparingly
```

The server returns opaque subscription descriptors during bootstrap. The desktop should not derive or guess channel names itself.

#### Space channel

One space channel carries all non-private chat events inside that space, plus ordinary space-visible metadata:

```text
AppSync channel: /space/ws1/design-room/g12

chat B rev 491  message.created
chat C rev 82   reaction.changed
chat B rev 492  message.edited
chat D rev 17   message.created
space rev 31   space.renamed
```

The utility process inspects the event's logical stream and advances the correct local cursor. One AppSync subscription can therefore serve several independent streams.

#### Private-chat channel

A private chat inside a room has a narrower audience than the space and receives a separate channel:

```text
/private/ws1/chatE/g7
```

Subscription requires both parent-space membership and explicit private-chat membership.

#### Actor channel

The actor channel carries inherently personalized state and control-plane hints:

- read-state changes originating on another device;
- unread and mention counter updates;
- notifications;
- membership and topology changes affecting that actor;
- opaque replacement subscription descriptors after generation rotation;
- “refresh bootstrap” or “resubscribe” control messages.

`device_id` remains authenticated connection/session metadata. It is not the normal routing scope, because an actor normally wants the same personalized update on every active device.

#### Workspace channel

A workspace-wide channel can carry state genuinely visible to every workspace member, such as a small actor-directory update. It should be used carefully. Space or actor fanout is preferable whenever it prevents broadcasting data to recipients who will discard it.

### 5.2 Why not one subscription per chat

Rooms multiply the number of chats, and the repository anticipates roughly 150 chats per actor. A per-chat transport subscription unnecessarily approaches AppSync subscription ceilings and increases connection setup work.

Using the space as the common audience avoids that pressure while retaining per-chat `rev` streams. The key rule is:

> **AppSync channel answers “who receives this?” The sync stream answers “what ordered state changed?”**

---

## 6. Authentication and authorization

### 6.1 Ownership boundaries

```text
WorkOS owns
    user identity
    organizations
    SSO / AuthKit
    Directory Sync / SCIM
    organization membership

Relayed owns
    actors
    workspace, space, and chat memberships
    roles and actions
    sessions and devices
    can(actor, action, object)
    every product authorization decision

AppSync owns
    enforcement that a connection/subscription passed configured auth
    delivery only to subscribed connections
```

WorkOS `OrganizationMembership.role_slug` may be mirrored as an input, but it is not consulted at permission-check time. Relayed authorization must survive replacing WorkOS and must not put an external network call on every write or client render.

### 6.2 Sign-in and steady-state tokens

```text
system browser + WorkOS AuthKit + PKCE
        │
        ▼
Relayed backend exchanges/verifies identity
        │
        ├── resolves account, workspace, and actor
        ├── reconciles membership
        └── issues Relayed access + refresh credentials
                    │
                    ▼
              Electron utility process
```

The AppSync connection uses a Relayed token, not a WorkOS token. WorkOS drops out of the steady-state sync path after interactive sign-in.

Tokens never enter the renderer. The refresh credential is protected with Electron `safeStorage`; the short-lived access token stays in utility-process memory. A long-lived local session independently unlocks existing local data. If remote authentication fails, synchronization stops, but the local read path continues.

For WorkOS reconciliation, polling the WorkOS Events API with a durable cursor is the correctness path: advance the cursor only after applying an event. Webhooks can later supplement polling when sub-second deprovisioning latency is required, but should not replace reconciliation.

### 6.3 Central Relayed authorization

Every permission decision uses the same model:

```text
can(actor, action, object) -> boolean
```

Server checks are authoritative. The client imports or mirrors the same model only to decide which offline affordances to display. A client may hide an action the server would allow; it must never become the authority that grants an action the server denies.

All externally reachable paths check authorization independently:

```text
mutation       -> requireCan(...)
bootstrap      -> filter topology through can(...)
catch-up       -> requireCan(read stream/object)
backfill       -> requireCan(read chat/object)
AppSync sub    -> same current membership semantics
```

Never interpret the client's cursors or requested channel list as proof of access. A modified client can invent any identifier.

### 6.4 AppSync authorization modes

Configure the Event API so that:

```text
CONNECT    -> AWS_LAMBDA
SUBSCRIBE  -> AWS_LAMBDA
PUBLISH    -> AWS_IAM, backend publisher only
```

AWS AppSync Events supports separate authorization configuration for connection, publication, and subscription, including namespace-specific overrides. Its Lambda authorizer receives the operation and, for subscription, the requested channel. This allows Relayed to validate the token and apply current membership semantics to the requested audience.

The desktop never publishes domain mutations directly to AppSync. All writes go through the Relayed mutation API, which authorizes, validates, allocates canonical order, and commits durable state before anything is fanned out.

Conceptual authorizer behavior:

```text
EVENT_CONNECT
    validate Relayed JWT signature, issuer, audience, and expiry
    resolve actor + workspace + device/session
    ensure actor/session/workspace are active
    allow or deny

EVENT_SUBSCRIBE /space/ws1/design-room/g12
    validate token
    validate exact workspace and current generation
    can(actor, read, design-room)?
    allow or deny

EVENT_SUBSCRIBE /private/ws1/chatE/g7
    validate token
    validate current generation
    member(actor, parent space)
      AND member(actor, chatE)
    allow or deny
```

Authorization caching must be bounded. AppSync may cache Lambda-authorizer results by token, operation, and channel. Generation rotation is therefore the immediate revocation mechanism for already-established subscriptions; short access-token lifetimes and session checks bound the remaining connection-level exposure.

### 6.5 A subscription is not an API capability

Successfully subscribing to an AppSync channel grants only receipt of events on that channel. It is never accepted as proof that the actor may mutate, catch up, or backfill. Those server endpoints run `can()` again against current state.

---

## 7. Membership changes and generation rotation

Subscription-time checks alone do not revoke a subscription that is already active. The production design therefore versions every sensitive audience.

### 7.1 Removing a member from a space

Suppose Bob is subscribed to:

```text
/space/ws1/design-room/g12
```

The removal transaction is:

```text
BEGIN
  set Bob's space membership left_at
  rotate fanout generation 12 -> 13
  append durable membership/topology events
COMMIT
```

After commit:

```text
old channel: /space/ws1/design-room/g12   becomes dead
new channel: /space/ws1/design-room/g13   receives all new events
```

Bob may remain technically subscribed to `g12`, but no new event is ever published there. Bob cannot subscribe to `g13`, because the authorizer evaluates current membership and rejects him.

Remaining members receive a topology-change hint on their actor channel, fetch or receive the new opaque descriptor, subscribe to `g13`, and then stop using `g12`. Any race or missed control hint is repaired by the next bootstrap/reconnect.

The publisher must refuse late publication to a stale generation after the removal commits. This may intentionally sacrifice live delivery of an older queued event; still-authorized clients obtain it through durable catch-up. Security takes precedence over the fast path.

The removal also has immediate server-side effects:

- mutation requests are denied;
- catch-up requests are denied;
- backfill requests are denied;
- bootstrap omits the space and its chats;
- private-chat access inside the space is denied even if a chat-level row is stale;
- the well-behaved client removes or hides the local projection according to product policy.

No architecture can recall plaintext that an authorized user already downloaded to a device they control. Revocation prevents future server access and future live publication; it does not cryptographically erase prior knowledge.

### 7.2 Adding a member

When Alice is added, the backend commits the membership and notifies Alice through her actor channel or on bootstrap. The authorizer checks current membership and permits subscription to the current generation. An audience expansion does not strictly require rotation, though rotating on every topology change is acceptable if operational simplicity is worth the extra resubscribe work.

New membership is another first-sync case: no special replication engine is needed. Alice begins with no cursor for the newly accessible streams, then uses the normal small-catch-up or gap-plus-tail policy.

### 7.3 Private-chat membership change

Private chat removal rotates that private chat's generation, not the whole parent space. The parent space channel continues normally. Removing the actor from the parent space makes all of its ordinary and private chats inaccessible and rotates the space plus any affected private audiences according to the same barrier rule.

### 7.4 Workspace or actor revocation

Workspace removal or actor deactivation must revoke Relayed sessions, prevent token refresh, stop all new API reads/writes, and stop publication to the actor's old audience generation. Directory deactivation is replicated as a tombstoned actor update so historical authorship still renders offline.

---

## 8. Bootstrap: first device and fresh replica

A new device is not a separate synchronization protocol. It is the most stale possible client: it has empty cursors and no historical rows.

The local-first boot sequence begins before network synchronization:

```text
1. Discover the local account.
2. Open account.db and the last workspace replica.
3. Run SQLite migrations.
4. Render everything currently available from SQLite.
5. Only then start authentication refresh and synchronization.
```

On a truly fresh device there may be little to render, but keeping the sequence identical is valuable. A returning offline user must never see a login wall over an intact local database.

### 8.1 Production bootstrap flow with AppSync

```text
1. Start app and open local SQLite.
2. Obtain or refresh a Relayed access token.
3. Call /sync/bootstrap for the selected workspace.
4. Receive only authorized topology, stream heads, counters, and subscriptions.
5. Persist metadata and server heads to SQLite.
6. Establish AppSync subscriptions from the opaque descriptors.
7. Buffer incoming live events.
8. Compare local contiguous cursors to bootstrap heads.
9. Run catch-up or gap recovery per stream.
10. Apply buffered events idempotently.
11. Enter steady state and drain the local outbox.
```

The subscription-before-catch-up ordering bridges the snapshot/live race.

Example:

```text
bootstrap reports Chat C head_rev = 82
client subscribes
message C:83 commits
client asks catchup from rev 70
```

Depending on timing, rev 83 may arrive both in the catch-up response and through AppSync. That is safe because revision application is idempotent. If rev 83 commits before the subscription is active, catch-up sees it. The system does not require an atomic “subscribe and read database head” operation.

### 8.2 Bootstrap response

Conceptually:

```json
{
  "protocol": 4,
  "now": 1789025000000,
  "workspace": { "id": "ws1", "name": "ACME" },
  "actor": { "id": "alice", "handle": "alice" },
  "spaces": ["...authorized materialized topology..."],
  "chats": [
    {
      "id": "C",
      "space_id": "design-room",
      "kind": "public",
      "head_rev": 83,
      "head_ord": 5522,
      "chat_unread": 2,
      "thread_unread": 1,
      "mention_count": 1
    }
  ],
  "actors": ["...directory projection..."],
  "memberships": ["...authorized local permission projection..."],
  "stream_heads": [
    { "kind": "chat", "id": "C", "rev": 83 },
    { "kind": "space", "id": "design-room", "rev": 31 },
    { "kind": "actor", "id": "alice", "rev": 109 }
  ],
  "subscriptions": [
    { "kind": "space", "opaque_channel": "/space/ws1/design-room/g12" },
    { "kind": "actor", "opaque_channel": "/actor/ws1/alice/g4" }
  ]
}
```

The exact wire schema may differ. The guarantees matter:

- only currently authorized objects and feeds are returned;
- heads and counters are server-authoritative;
- descriptors are opaque to the client;
- no complete message history is included;
- server time is included so the client can estimate extreme clock skew;
- large bootstrap responses can later be paged by recent activity without silently omitting older chats.

### 8.3 First-device example

Assume a fresh device can access:

```text
#engineering  head_rev = 8140
#random       head_rev = 402
#new-project  head_rev = 27
```

Its effective local cursor is zero for each stream.

- `#new-project`, only 27 revisions behind, can receive a full replay.
- `#random` may receive a full replay if it remains below the configured threshold.
- `#engineering`, 8,140 revisions behind, receives a gap response with the recent tail.

The resulting replica could be:

```text
chat           synced_rev    has_gap    local history
engineering       8140          yes      recent ~50 messages
random             402          no       fully replayed within horizon
new-project         27          no       fully replayed
```

The sidebar can show all chats and exact server-computed badges before full message history is present. A workspace with 150 chats and 500,000 historical messages does not download 500,000 messages before becoming usable.

---

## 9. Live write path

Suppose Alice sends a message to public Chat C in Design Room.

### 9.1 Local optimistic transaction

```text
React compose action
      │
      ▼
utility process
      │
      ├── generate client ULID for message
      ├── INSERT pending message into SQLite
      ├── INSERT send operation into SQLite outbox
      └── COMMIT both together
              │
              ▼
        emit invalidation
              │
              ▼
        React re-queries SQLite
```

Client-generated stable IDs are mandatory. A message may be edited, reacted to, or deleted while the server has never heard of it. ULIDs also provide a useful deterministic ordering tie-breaker among pending messages that do not yet have an `ord`.

### 9.2 Server transaction

When online, the outbox drainer sends the operation to the Relayed HTTPS mutation API:

```text
POST mutation { op_id, kind: send, chat: C, message: ... }
      │
      ├── validate Relayed token and active session
      ├── resolve actor, workspace, and device
      ├── requireCan(actor, post, Chat C)
      └── validate referenced content/blobs
              │
              ▼
BEGIN POSTGRES TRANSACTION
      ├── enforce idempotency on op_id
      ├── allocate Chat C ord = 5523
      ├── allocate Chat C rev = 83
      ├── insert message with authoritative timestamps
      └── insert sync_event:
             stream = chat:C
             rev = 83
             event_type = message.created
             fanout = space:design-room generation 12
COMMIT
```

If the same `op_id` is retried because the ACK was lost, the server returns the original result, including the same `ord` and `rev`. It must not create a duplicate message.

### 9.3 ACK and live event

Two related responses may reach the originating device:

```text
ACK
    reconciles the outbox operation
    stamps the optimistic row with server ord, rev, and time
    or marks a terminal failure from NACK

authoritative sync event
    is processed through the same applyEvent path as every other device
    establishes convergence with the durable log
```

The publisher sends the committed event with IAM authorization:

```text
sync_event chat:C:83
      │
      ▼
/space/ws1/design-room/g12
      │
      ├── Alice's laptop
      ├── Alice's desktop
      ├── Bob
      └── Carol
```

Every client performs an idempotent SQLite transaction, advances the appropriate revision state only when safe, and emits coarse invalidation topics. React never consumes the AppSync payload as authoritative state; it re-queries SQLite.

### 9.4 Server time wins

Client clocks are display-only for pending rows. Server time is authoritative for cross-device fields such as `created_at`, `edited_at`, and reaction timestamps. An optimistic local timestamp always loses to the server value on ACK/event application. Where a last-write-wins rule is used, compare server timestamps only and use a deterministic actor-ID tie-breaker.

---

## 10. Client outbox

The outbox belongs inside each workspace SQLite replica so that the queued operation and its optimistic echo can be one transaction. Moving it to an account-wide database would make background draining easier but would introduce a crash window in which a message appears sent locally without a durable operation to send it.

### 10.1 Coalescing is correctness

Coalesce on enqueue, scoped to the target:

| Existing queued op | New op | Result |
|---|---|---|
| `send` | `edit` | Rewrite the `send` payload with the edited body |
| `send` | `delete` | Drop both; the server never needs to see the message |
| `send` | `react` | Keep both, with `send` first |
| `edit` | `edit` | Keep only the last edit |
| `edit` | `delete` | Drop edit; keep delete |
| `react(add)` | `react(remove)` | Drop both for the same actor/message/emoji |
| `read(ord=5)` | `read(ord=9)` | Keep 9; read state is a max register |

Without coalescing, an offline `send -> edit -> delete` sequence targets a message the server has not yet created and can produce failed operations or a ghost message.

### 10.2 Drain order and retry

- Drain by local sequence in order per chat.
- Allow one in-flight operation per chat.
- Parallel draining across unrelated chats is desirable.
- Use exponential backoff with jitter for retryable errors.
- A NACK explicitly carries `retryable`.
- Move non-retryable operations to `failed` and show retry/discard UI.
- Bound the queue and surface pressure instead of growing forever.

A message queued for a space from which the actor was removed will never succeed. Silent infinite retry is worse than a visible terminal error.

### 10.3 ACK reordering

A pending message has no canonical `ord`, so it renders at the tail using pending-order rules. Its ACK may assign an `ord` above or below messages that arrived while it was in flight. The message may visibly move within the tail. That is correct: preserving a device-specific order would make that device disagree with every other replica.

### 10.4 Attachments

Attachment bytes live in object storage and the local blob cache, not inside SQLite or `sync_events`. SQLite and chat events carry metadata and content-addressed blob IDs. Offline upload is two phase:

```text
blob_upload succeeds
      │
      ▼
send message that references the blob id
```

The outbox enforces that dependency. Avatars and useful thumbnails can be eagerly cached; full-size assets remain on demand. Missing bytes do not block convergence of message metadata.

---

## 11. Catch-up

Catch-up asks:

> What durable mutations did this replica miss after its contiguous cursor?

It returns semantic sync events in the same envelope and shape used by AppSync live delivery. The client has one application path, regardless of how the event arrived.

Example:

```json
{
  "kind": "catchup",
  "stream": { "kind": "chat", "id": "C" },
  "from_rev": 81,
  "limit": 500
}
```

```json
{
  "kind": "catchup_ok",
  "stream": { "kind": "chat", "id": "C" },
  "from_rev": 81,
  "to_rev": 83,
  "complete": true,
  "events": [
    { "rev": 82, "type": "reaction.changed", "payload": {} },
    { "rev": 83, "type": "message.created", "payload": {} }
  ]
}
```

Server query conceptually:

```sql
SELECT *
FROM sync_events
WHERE workspace_id = $workspace
  AND stream_kind = $kind
  AND stream_id = $id
  AND stream_rev > $from_rev
ORDER BY stream_rev
LIMIT $limit;
```

Before the query, the server resolves the stream's object and applies current `can()` rules. Authorization is not inferred from the cursor or from a previous AppSync subscription.

### 11.1 `synced_through_rev` is a contiguous frontier

```text
synced_through_rev = N
```

means:

> This client has accounted for every revision at or below N in this stream.

It must never mean merely “N is the largest revision I have seen.”

If the frontier is 400 and rev 501 arrives, revisions 401–500 are missing. Record or stage 501, update `server_head_rev`, and request catch-up, but do not advance the contiguous frontier to 501.

The client separately tracks:

```text
synced_through_rev   contiguous applied/accounted-for prefix
server_head_rev      largest head the server has reported
```

“I have it” and “I know it exists” are different facts.

### 11.2 Out-of-order and concurrent live/catch-up traffic

Transport delivery may duplicate, retry, or interleave with catch-up. Production-safe handling is:

```text
receive event R
    │
    ├── R <= frontier
    │      duplicate or old delivery -> idempotent no-op
    │
    ├── R == frontier + 1
    │      apply/account in SQLite transaction
    │      advance frontier
    │      drain any newly contiguous staged events
    │
    └── R > frontier + 1
           persist the event envelope in a bounded local inbox/staging table
           record the missing interval
           trigger/coalesce catch-up
           do not discard dependency-sensitive payload
```

The current model's `pending_revs(chat_id, rev)` remains useful for proving contiguity, especially when an event legitimately changes no local domain row. The production implementation should also retain an above-frontier event envelope until it is safely applied, unless that event handler is provably order-insensitive and version guarded. This prevents an out-of-order edit from no-oping before the corresponding create and then being forgotten.

Apply catch-up in bounded SQLite transactions, for example roughly 200 events at a time, yielding between batches. WAL allows reads during writes; chunking prevents thousands of catch-up writes from starving visible UI queries.

### 11.3 Small replay versus gap

For a small difference—initially around 500 revisions—the server replays the missing events. The threshold is an operational tuning value, not a protocol constant.

For a large difference, an expired event-retention horizon, or a stream whose history is better replaced, the server returns a gap or snapshot response instead.

---

## 12. Gap handling

A chat gap response contains the current head and a recent materialized tail:

```json
{
  "kind": "gap",
  "stream": { "kind": "chat", "id": "engineering" },
  "head_rev": 91204,
  "head_ord": 40112,
  "recent": ["...approximately 50 current message snapshots..."]
}
```

The client transaction:

```text
upsert recent materialized snapshot rows
set server_head_rev = 91204
set synced_through_rev = 91204
set has_gap = true
set oldest_local_ord from the returned tail
clear obsolete staged revisions at/below the new frontier
```

Jumping the sync cursor to the head is deliberate. It says the server has established a new valid partial snapshot through that revision. It does **not** claim the client holds every historical message.

```text
synced_through_rev = head_rev
    means future durable sync can continue from here

has_gap = true
    means older materialized history is incomplete
```

This keeps reconnect cost approximately O(number of streams/chats), not O(number of historical messages).

For bounded non-chat state, a full current snapshot is usually better than thousands of historic events:

```text
unbounded historical state, such as chat messages
    small delta -> replay
    large delta -> gap + recent tail + lazy backfill

bounded materialized state, such as space settings
    small delta -> replay
    large delta -> replace with current snapshot at head rev
```

---

## 13. Backfill

Backfill asks:

> Give me current historical materialized rows that this partial replica intentionally does not hold.

It is not event replay.

For a chat timeline:

```json
{
  "kind": "backfill",
  "chat_id": "C",
  "before_ord": 5100,
  "limit": 50
}
```

For replies inside an old thread:

```json
{
  "kind": "thread_backfill",
  "root_id": "m_root",
  "after_ord": 0,
  "limit": 100
}
```

The server checks current read authorization, queries domain tables, and returns the current materialized snapshot. Timeline paging uses keyset pagination on `ord`, never `OFFSET`.

```text
rev
  realtime + catch-up
  replica convergence

ord
  history and thread backfill
  partial-replica hydration
```

### 13.1 Snapshot completeness

Backfill for a message must return enough current state to be correct even if historic events were skipped:

- message fields and current body;
- deletion/tombstone status as appropriate;
- current reactions;
- attachment metadata;
- thread metadata required by the view.

This is how the system handles an edit to an old message that is not local:

```text
message M is below the local history window
message.edited(M) arrives at rev 8142
client accounts for rev 8142 but domain apply is an intentional no-op
later, user scrolls upward
backfill returns current M, already containing the latest body
```

The durable log is required to keep an existing partial replica synchronized. It does not have to reconstruct the entire local database from revision zero. Server materialized tables plus snapshot/backfill endpoints construct missing regions.

### 13.2 Retention and eviction converge on the same model

Server event retention and client message eviction both create missing history below the current head. Represent both through `has_gap` and `oldest_local_ord`, and repair both with the same backfill path.

Client retention details:

- target a rolling window, initially around 90 days;
- evict whole threads based on thread last activity, never orphaning replies;
- avoid evicting unread content where possible, with a cap so abandoned chats cannot pin unbounded history;
- update `oldest_local_ord` after every eviction;
- delete associated FTS and cached-blob state;
- use bounded transactions and incremental vacuum, never a large blocking full vacuum.

---

## 14. Event application edge cases

Every received durable event is first a fact about the sync sequence and only second an instruction that may change a local row.

| Event | Target exists locally | Target absent because of intentional gap/eviction |
|---|---|---|
| `message.created` | Idempotent upsert | Insert if inside the retained window |
| `message.edited` | Update with revision/version guard | Intentional no-op; later backfill returns current body |
| `message.deleted` | Tombstone or remove according to projection policy | Intentional no-op |
| `reaction.changed` | Upsert/remove current reaction state | Intentional no-op unless a compact placeholder projection is desired |
| `thread.metadata_changed` | Update thread projection | Intentional no-op; backfill repairs |
| `read_state.changed` | Apply `max(existing, incoming)` | Apply; it does not depend on holding the message row |
| counter snapshot | Replace server-owned projection | Apply |

All valid durable events still account for their `rev`, including events that touch no local row. A delete for a message the client never held is the sharpest example: without explicit revision tracking, the frontier would stall forever even though there is nothing to delete.

### 14.1 Duplicate event

If `rev <= synced_through_rev`, treat the delivery as a duplicate. Domain upserts and tombstones should be idempotent. Duplicate live delivery is expected under at-least-once publication and catch-up/live overlap.

### 14.2 Revision jump

If `rev > synced_through_rev + 1`, do not jump the frontier. Stage the event, mark the hole, and schedule one coalesced catch-up for that stream. Multiple jump observations should not launch parallel catch-ups for the same stream.

### 14.3 Delete of a missing row

Perform no domain write, but persist that the revision was accounted for. The absence of a local row may be correct because the row was never backfilled or has been evicted.

### 14.4 Edit or reaction for a missing row

If the absence is an intentional history gap, no-op and account for the revision. Backfill must later supply a complete current snapshot. If the absence is caused by temporary out-of-order delivery above the contiguous frontier, retain the event envelope and apply it in sequence rather than losing it.

### 14.5 Unknown event type or field

- Ignore unknown fields.
- Record/account for the revision of an unknown optional event type so an older client does not stall forever.
- Emit telemetry with protocol and event type.
- Use a minimum-protocol response to force upgrade when an event is essential to correctness and cannot safely be skipped.

An inbound schema must not reject a whole frame simply because a newer server added a field. Old clients are normal, not an edge case.

### 14.6 Parse or apply failure

Do not silently advance past a known event whose handler failed halfway. The event and cursor update belong in one SQLite transaction. Roll back, retain the envelope, record telemetry, retry or request a snapshot. Only an explicitly unknown, declared-skippable event may advance without materialization.

---

## 15. Reconnect and steady-state recovery

Reconnect uses the same machinery as bootstrap:

```text
network returns
    │
    ▼
refresh Relayed token if needed
    │
    ▼
bootstrap authorized topology + current heads + descriptors
    │
    ▼
subscribe and buffer AppSync events
    │
    ▼
catch up every stream where local frontier < server head
    │
    ├── small difference -> replay
    └── large/expired difference -> gap or snapshot
    │
    ▼
drain buffered live events
    │
    ▼
drain local outbox
```

Connection retry uses exponential backoff with full jitter, capped around 30 seconds. Jitter is necessary because the expensive part of a regional reconnect storm is not opening sockets; it is thousands of simultaneous bootstrap responses and catch-up queries.

The utility process should explicitly model connection states such as:

```text
offline
connecting
authenticating
subscribing/catching_up
live
stale_or_unauthenticated
```

Local reads continue in every state. A refresh failure changes sync status and UI messaging; it never clears the local database. Explicit sign-out is the operation that removes local account/workspace data.

AppSync connection refresh may require establishing a newly authorized connection rather than relying on the repository's original custom-WebSocket in-band `reauth` frame. Treat transport reconnection as normal: subscribe, buffer, compare heads, and catch up. The durable protocol makes a dropped socket a performance event, not a correctness event.

---

## 16. Local SQLite and renderer contract

The Electron utility process is the synchronization owner:

- AppSync connection and subscriptions;
- Relayed API client;
- SQLite handle using WAL;
- cursors, staged/pending revisions, gap state, and catch-up scheduling;
- local outbox and its drainer;
- retention, eviction, FTS maintenance, and blob queue;
- invalidation broadcast to every renderer window.

The renderer is a pure subscriber to local data:

```text
renderer                       utility process
   │                                  │
   ├── query(spec, correlation id) ──▶│ SQLite
   │◀──────────── rows ───────────────┤
   │                                  │
   │◀──── invalidate(topics) ─────────┤ after a local write
   ├── re-query visible data ────────▶│
```

Do not push full AppSync payloads into React as the primary state path. Persist first, invalidate second, and re-query locally. Coarse invalidation is preferred to maintaining a second in-renderer mirror.

Example topics:

```text
actors
space:design-room
chat:C
chat:C:messages
chat:C:reactions
actor:alice:counters
```

Prefix matching should work in both directions so a narrow change wakes a broad query and a broad snapshot refresh wakes a narrow view.

Use paginated keyset queries, commonly pages of 50 messages. SQLite WAL prevents readers from blocking the catch-up writer, and catch-up writes are chunked so visible queries remain responsive.

### 16.1 Account and workspace storage boundaries

- `account.db` holds account-wide local session/device/workspace-index state.
- Each workspace has its own `relayed.db`, cursors, gaps, outbox, drafts, and attachment cache.
- `device_id` is per `(install, account)`, not globally per install and not per workspace.
- A separate install identifier may exist for telemetry but never enters auth/session tokens.
- Drafts remain local-only; cross-device draft synchronization is deliberately excluded because last-write-wins on actively typed text can destroy work.

Exactly one workspace is active for full subscribe/render/catch-up. An inactive workspace can later be opened drain-only to send its outbox, touching only the outbox and optimistic-echo acknowledgment fields.

---

## 17. Non-chat state

The event infrastructure is generic, but each kind of state chooses an appropriate stream, audience, and recovery strategy.

| Product state | Durable stream | Live audience | Recovery |
|---|---|---|---|
| Message create/edit/delete | `chat:<id>` | Parent space or private-chat channel | Replay by `rev`; gap + tail; history by `ord` |
| Reactions | `chat:<id>` | Parent space or private-chat channel | Replay; current state included in backfill |
| Thread replies/metadata | Containing `chat:<id>` | Parent space or private-chat channel | Replay; thread backfill by `ord` |
| Public/default chat created in room | `space:<id>` | Space channel | Replay or current space snapshot |
| Space name/topic/settings | `space:<id>` | Space channel | Replay or current snapshot |
| Private-chat placement/membership | `space` or private-chat control stream | Affected actor channels + private audience | Snapshot/catch-up plus descriptor refresh |
| Workspace actor directory/global metadata | `workspace:<id>` | Workspace or scoped actor channels | Replay or directory snapshot |
| Read state | `actor:<id>` with chat target | Actor channel | Max-register; actor snapshot |
| Unread/thread/mention counters | Actor projection | Actor channel | Bootstrap/snapshot authoritative |
| Notifications | `actor:<id>` | Actor channel | Replay or bounded snapshot according to product semantics |
| Attachment metadata | Same chat stream as message | Same as message | Backfill with message; bytes fetched separately |
| Discovery and invitations | Server control plane | Actor notification when useful | Network query; not ordinary granted-content replication |
| Presence and typing | No durable stream | Relevant live audience only | No catch-up |

The recovery strategy need not be uniform just because the table is uniform. Durable streams provide a common envelope and cursor model; bounded state may snapshot while unbounded history combines replay and lazy hydration.

---

## 18. Read state, unread counts, presence, and typing

### 18.1 Read state

`last_read_ord` is a max register across devices:

```text
new_value = max(existing_value, incoming_value)
```

Never blindly overwrite it. Otherwise a stale phone reconnecting after a laptop has read farther could make the chat unread again.

The local outbox may coalesce all pending read operations for one chat to the highest `ord`. The server applies the same max rule and publishes personalized state on the actor channel so the user's other devices converge.

### 18.2 Unread and mention counters

The server is authoritative for:

```text
chat_unread
thread_unread
mention_count
```

`head_ord - last_read_ord` is not sufficient because it cannot account for mention bodies, thread separation, or deleted-message holes. Bootstrap returns exact counters for every accessible chat before message bodies are hydrated. Live counter snapshots update the actor projection; they can be replaced idempotently.

### 18.3 Presence and typing

Presence and typing are ephemeral signals, not replicated durable state:

- send them through AppSync on the narrowest useful audience;
- attach a timestamp/expiry or short TTL;
- do not append them to `sync_events`;
- do not assign durable `rev` values;
- do not catch them up after reconnect;
- drop stale signals silently.

Replaying “Bob started typing” three hours after the fact is worse than losing it. Presence can be reconstructed from fresh heartbeats after reconnect.

---

## 19. Representative end-to-end cases

### Case A: another member posts while Alice is online

```text
Bob's operation -> Relayed API -> Postgres transaction
                -> message row + chat rev 8141 sync_event
                -> publisher -> space generation channel
                -> Alice utility process -> SQLite transaction
                -> invalidate chat and sidebar topics
                -> React re-queries SQLite
```

If AppSync delivery is lost, Alice later observes `server_head_rev > synced_through_rev` and catches up from `sync_events`.

### Case B: Alice writes while offline

```text
compose -> optimistic SQLite row + outbox entry, atomically
UI renders immediately
network returns
outbox sends in per-chat order
server deduplicates by op_id
ACK reconciles pending row
authoritative live/catch-up event converges every device
```

### Case C: ACK is lost

The client retries the same `op_id`. The server finds the previously committed operation and returns the original canonical ID, `ord`, `rev`, and timestamps. No duplicate domain row or sync event is created.

### Case D: live rev 8138 arrives after local rev 8136

The client stages 8138, keeps its frontier at 8136, and requests catch-up from 8136. Rev 8137 arrives through catch-up; the client then applies/account 8137 and 8138 contiguously. A duplicate 8138 from catch-up is ignored idempotently.

### Case E: old edit arrives for a message not stored locally

The event is a valid revision even if the message is below the retained window. The client accounts for the revision and intentionally does not create a partial message. Later backfill returns the complete current message snapshot, including the edited body and current reactions.

### Case F: Alice opens a chat with a gap and scrolls upward

The recent tail renders from SQLite immediately. Reaching `oldest_local_ord` triggers an authorized `backfill(before_ord, limit)` call. Current rows are inserted in one SQLite transaction, `oldest_local_ord` moves downward, and the view is invalidated. If offline, the UI explains that older messages need a connection instead of showing an apparently empty boundary.

### Case G: Bob is removed while connected

The membership transaction rotates the audience generation. New events publish only to the new generation. Bob's stale subscription receives nothing, new subscriptions are denied, and all mutation/catch-up/backfill endpoints reject him. Remaining members re-subscribe from actor-channel topology hints. Data Bob already downloaded cannot be recalled.

### Case H: one room, several chats

Chat B rev 492, Chat C rev 83, and Chat D rev 17 all arrive through one Design Room space channel. The transport subscription is shared; the utility process routes each envelope to its separate chat cursor. Only Chat C catches up if its local frontier is 81.

### Case I: space rename

The server updates the space row and appends `space.renamed` to `space:design-room` rev 31 in one transaction. It fans out on the space channel. Clients update the local space projection and invalidate space/sidebar topics. A stale client can replay the small delta or receive a current space snapshot.

### Case J: presence while offline

No durable record is created. Alice misses Bob's typing event and does not catch it up. When Alice reconnects, fresh presence heartbeats establish current ephemeral state.

---

## 20. Failure boundaries and correctness model

The architecture deliberately separates a correctness path from a latency path:

```text
correctness path
    PostgreSQL transaction
    domain state + sync_events
    authorized catch-up/snapshot/backfill

latency path
    publisher + AppSync Events
```

Consequences:

- A publisher outage delays live updates but does not lose committed state.
- An AppSync outage makes clients stale but does not stop local reads or offline writes.
- A duplicate publish is harmless.
- A dropped socket is repaired by cursor comparison and catch-up.
- A client offline beyond event retention receives a gap/snapshot, not an impossible replay.
- A Relayed auth outage stops new remote actions while preserving existing local usability.
- A WorkOS outage does not break steady-state sync for already-issued Relayed sessions.

AppSync is therefore a managed fast path, not a single point of logical correctness.

---

## 21. Implementation invariants

These should be encoded in tests, database constraints, and telemetry—not left as conventions.

### Server and event log

1. A durable replicated domain mutation and its `sync_events` row commit atomically.
2. `(workspace_id, stream_kind, stream_id, stream_rev)` is unique.
3. Revisions increase monotonically within a stream; chat `ord` and `rev` are allocated under the same per-chat transaction.
4. Every chat mutation increments `rev`; only message creation allocates `ord`.
5. A repeated `op_id` returns the original result and never allocates a new `ord` or `rev`.
6. `sync_events` contains semantic product events, never raw CDC records.
7. Only replicated durable product state enters `sync_events`; typing and presence do not.
8. Published events remain available until the catch-up retention policy expires them.
9. Publisher delivery is at-least-once; every consumer is idempotent.
10. No event is published to an obsolete fanout generation after recipient removal commits.

### Authorization

11. WorkOS authenticates identity and organization membership; Relayed authorizes workspace/space/chat actions.
12. WorkOS `role_slug` is never the runtime authorization decision.
13. Every mutation, bootstrap, catch-up, backfill, connection, and subscription is server-authorized.
14. Client cursors, channel names, local memberships, and prior subscriptions are never proof of current access.
15. Private-chat access always requires both parent-space membership and explicit chat membership.
16. The desktop never publishes domain mutations directly to AppSync.
17. AppSync publish permission belongs only to IAM-authorized backend infrastructure.
18. A fanout audience that shrinks rotates generation; the previous channel becomes permanently silent.

### Client replica

19. Every normal UI read is served from local SQLite.
20. AppSync events are written to SQLite before renderer invalidation.
21. The renderer never becomes a second authoritative state store.
22. `synced_through_rev` advances only across a contiguous accounted-for prefix.
23. `server_head_rev` and `synced_through_rev` are separate fields with separate meanings.
24. Every valid event revision is recorded even when the domain handler intentionally no-ops.
25. Above-frontier dependency-sensitive events are retained until they can be applied safely.
26. Duplicate events and duplicated catch-up/live overlap are harmless.
27. Unknown fields do not fail a frame; unknown optional event types do not stall the cursor.
28. Known-event apply and cursor accounting occur in one SQLite transaction.
29. `has_gap` is independent from being current for future sync.
30. Backfill returns complete current materialized state for the hydrated rows.
31. Backfill and list pagination use keyset `ord`, never `OFFSET`.
32. Read state is a max register on both client and server.
33. Optimistic rows and their outbox operations are committed together.
34. Outbox order is preserved per chat; cross-chat work may run concurrently.
35. A terminal NACK is visible and is not retried forever.
36. Authentication failure never deletes local data or blocks the local read path.

### Protocol evolution and operations

37. The client identifies its protocol version; the server can respond with a minimum required version.
38. Required new semantics use the upgrade path instead of silently corrupting old replicas.
39. Reconnect uses exponential backoff with full jitter.
40. Catch-up work is chunked so UI reads remain responsive.
41. Stream count, gap rate, catch-up size, cursor stalls, outbox failures, publisher lag, stale-generation suppressions, and authorizer denials are observable.

---

## 22. Minimum test matrix

At minimum, automate these cases:

1. Two online clients converge on create, edit, reaction, and delete.
2. Domain mutation rollback leaves no event; event-insert failure leaves no domain mutation.
3. Lost ACK plus retry produces one message and the same canonical result.
4. Live delivery and catch-up both contain the same event; it applies once.
5. Revisions arrive `501, 499, 500` above frontier `498`; the frontier advances only when contiguous.
6. A delete for a locally absent message advances the revision correctly.
7. An out-of-order edit cannot be lost before its create.
8. A client far behind receives a gap and recent tail, then continues live from the head.
9. Backfill after an intentionally skipped edit returns the latest message and reaction state.
10. First device with empty cursors becomes usable without downloading full workspace history.
11. A room's public chats share one AppSync subscription while retaining independent cursors.
12. A private-chat subscriber requires both membership layers.
13. Space removal immediately denies mutation, catch-up, and backfill.
14. Generation rotation makes the old audience channel permanently silent.
15. A late queued event is not published to an obsolete generation.
16. Actor-channel topology hints cause remaining members to resubscribe and recover any race through catch-up.
17. WorkOS role drift does not change authorization until the Relayed mirror is reconciled according to policy.
18. Access-token refresh failure stops sync but leaves local read, scroll, and search operational.
19. Unknown fields are tolerated; an unknown optional event accounts for its revision; an unsupported required protocol is rejected with an upgrade response.
20. Offline outbox coalescing covers every operation pair, including `send + delete -> zero network operations`.
21. Three offline messages arrive in composition order after reconnect.
22. Stale-device read state cannot move `last_read_ord` backward.
23. Presence and typing never appear in catch-up.
24. Revoked actors cannot receive new events, while historical messages retain tombstoned author identity.

---

## 23. Operational signals

Recommended metrics and logs:

- publisher lag from `sync_events.created_at` to successful AppSync publish;
- unpublished row count and oldest unpublished age;
- publish attempts, duplicates, and terminal failures;
- stale-generation publications suppressed;
- AppSync connection/subscription authorization allows and denies by namespace;
- active subscriptions per actor and chats/streams per actor;
- bootstrap payload size and latency;
- catch-up requests, events returned, pages, and duration;
- gap entries by reason: threshold, retention expiry, corruption recovery, or explicit snapshot policy;
- backfill pages and rows;
- cursor-stalled detections and missing revision range size;
- local apply failures by event type and protocol version;
- outbox depth, age, coalesced operations, retryable failure, and terminal failure;
- reconnect storms and jitter distribution;
- membership-generation rotations and client resubscribe latency.

Alert on age, not only count. Ten unpublished events stuck for an hour are more serious than ten thousand events cleared in seconds.

---

## 24. Decision record: why AppSync Events for now

AppSync was selected as the live delivery service because Relayed already needs to own the hard parts of its server-authoritative local-first protocol:

```text
per-stream revs
durable catch-up
gap policy
snapshot and backfill APIs
partial SQLite replicas
offline outbox
authorization-aware bootstrap
```

A higher-level service such as Ably LiveSync can manage more transport and connector behavior, but it does not remove Relayed's need for durable authorization-aware history, materialized snapshots, SQLite projections, or its product-specific write semantics. AppSync provides inexpensive managed fanout while preserving that control.

This choice is reversible because `sync_events`, catch-up, backfill, and event application do not depend on AppSync history. Reconsider the transport if operating the publisher, generation rotation, global delivery, or SDK behavior becomes more expensive than the managed premium of an alternative.

---

## 25. Compact reference

```text
WRITE
local optimistic row + local outbox
    -> authorized Relayed API
    -> Postgres domain row + sync_event, atomically
    -> publisher
    -> AppSync audience channel
    -> utility process
    -> SQLite
    -> invalidation
    -> React local query

RECONNECT / FIRST DEVICE
open and render local DB
    -> Relayed bootstrap: authorized topology + heads + counters + descriptors
    -> subscribe and buffer AppSync
    -> compare per-stream cursors
    -> small delta: catch-up events
    -> large delta: gap/snapshot
    -> apply buffered live events
    -> drain outbox

HISTORY
open/scroll chat
    -> backfill by ord
    -> current complete materialized rows
    -> SQLite

AUTH
WorkOS identity/org
    -> Relayed session and can()
    -> AppSync Lambda auth for connect/subscribe
    -> IAM-only backend publish

REVOCATION
membership shrinks
    -> rotate audience generation in DB transaction
    -> old AppSync channel goes permanently silent
    -> remaining members receive new opaque descriptor
    -> removed actor is denied everywhere
```

---

## References

- [Relayed repository](https://github.com/harsh-1923/relayed)
- [Relayed `DESIGN.md`](https://github.com/harsh-1923/relayed/blob/main/docs/DESIGN.md)
- [Relayed `AUTHZ.md`](https://github.com/harsh-1923/relayed/blob/main/docs/AUTHZ.md)
- [Relayed `PHASE-2-SYNC.md`](https://github.com/harsh-1923/relayed/blob/main/docs/PHASE-2-SYNC.md)
- [Relayed `STORAGE.md`](https://github.com/harsh-1923/relayed/blob/main/docs/STORAGE.md)
- [AWS AppSync Events: configuring authentication and authorization](https://docs.aws.amazon.com/appsync/latest/eventapi/configure-event-api-auth.html)
- [AWS AppSync Events: channel namespaces](https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespaces.html)
- [AWS AppSync Events WebSocket protocol](https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html)

