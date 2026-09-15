# Sync flows, end to end

> **Status: the plan of record for sync.** The two questions this document was
> written to answer are answered — we keep **our own transport, on one node**,
> and the **actor directory becomes a stream** rather than a `welcome` array.
> What follows is no longer a proposal to weigh against the AppSync one; §1 is
> what we are building, §2 is the order, and §21 (what is built) is the ledger.
>
> **One decision the whole plan rests on: `sync_events` is adopted.** Stated
> plainly so it is cheap to reverse. The argument is §12.1 (why `sync_events`
> and not the message rows): a row records what is *true now* and cannot record
> what *happened*, so a rename, a membership change or an actor update has no
> catch-up path at all today, and the moment edits land the message-row
> derivation is unsound as well. Reversing it means deleting steps 4 and 10 of
> the plan and accepting that only messages ever sync.
>
> Companion to [`DESIGN.md`](DESIGN.md) §8 (data model) through §12 (unread
> counters), which this implements rather than revises, and to
> [`PHASE-2-SYNC.md`](PHASE-2-SYNC.md), whose steps A–I this plan carries
> forward one for one.

---

## 1. Goals, and what counts as meeting them

Six goals. Each is a **property of the finished system**, not a piece of work —
a plan whose goals are its own steps can only ever tell you that you did the
steps.

Every check below is meant to be executable or measurable. "Reviewed and looks
right" is not a check; it is how the two counters nearly shipped conflated.

### G1 — Convergence: one order, no duplicates, no silent holes

*Fails as:* two clients that were both online the whole time disagree about what
was said, and nobody finds out until a screenshot.

| Check | Satisfied by |
|---|---|
| `synced_through_rev` advances only across an unbroken run | frontier test, step 8 (the apply loop and the frontier) |
| An event above the frontier is retained **whole**, not as a rev | the lost-edit test of §11.1, which must fail before it passes |
| `ord` is never renumbered or reused | `allocate.test.ts`, built — including the negative control that loses one |
| A replayed `op_id` returns the **stored** ack, never a second `ord` | `applyOnce`, built |
| Two clients converge after an offline compose on both | step 14 (the milestone) |
| The 66-assertion model still agrees | `pnpm spike:sync`, green throughout |

### G2 — Recoverability: anything missed is recoverable, bounded by streams

*Fails as:* a week offline means a hundred thousand messages, or a rename that
happened while away is never learned at all.

| Check | Satisfied by |
|---|---|
| Catch-up replays from the **log**, so no intermediate step is overwritten | step 4 (the event log) |
| A non-message change — rename, membership, actor — has a catch-up path | step 4; nothing in `messages` can express one today |
| A client far enough behind gets a gap plus a tail rather than an unbounded replay | step 9 (catch-up, gap and backfill) |
| A reconnect costs O(streams), not O(messages) | measured at 150 chats, step 9 |
| A cursor past the retention horizon gets a gap, not an error | step 12 (retention, and the residue we accept) |

### G3 — Authorization at delivery, with nothing to revoke

*Fails as:* a removed member keeps receiving a channel because the transport
holds a grant nobody re-evaluated.

| Check | Satisfied by |
|---|---|
| The audience is computed per event, from the database, at send time | `audienceFor`, step 6 (the registry and fanout) |
| A member removed a millisecond ago is absent from the very next audience | step 6, asserted with the socket still open |
| Space membership leads the predicate for a private chat | step 6, mirroring `can()` exactly |
| The connection holds **no** authorization — only delivery targets | the registry's shape; a cached audience is a subscription |
| `op`, `catchup`, `backfill` and `welcome` all deny through `can()` | built; re-asserted per frame in steps 5 and 7 |

### G4 — Offline is normal, not a failure mode

*Fails as:* the read path quietly reaches for the socket when it happens to be
connected, and every test on a developer machine still passes.

| Check | Satisfied by |
|---|---|
| Boot renders from local before any network call | `boot.test.ts`, which removes `fetch` from the process |
| R3 still holds at the end of the phase, not only at the start | `boot.test.ts` re-run after step 11 |
| Simulated offline actually cuts the socket, not just `fetch` | `guardConnect` plus `network/no-ungated-socket`, step 5 |
| Compose-then-delete offline produces **zero** network ops | outbox coalescing, step 11 (the outbox) |
| Offline messages arrive in the order typed | step 11 |
| A failed read keeps the rows it had (invariant 70) | built, in the live-query client |

### G5 — Bounded frames: nothing scales with the company

*Fails as:* `welcome` is fine at a hundred people, 503 KB at sixteen hundred,
and nobody costed the term that grew.

| Check | Satisfied by |
|---|---|
| No frame carries a collection sized by the workspace (invariant 71) | asserted against a 1,600-actor fixture, step 7 |
| `welcome` is **one** statement whatever the chat count | the query-count test, built; held through step 7 |
| The directory arrives as a stream and pages, keyset on actor id | step 10 (the directory as a stream) |
| `welcome` is compressed once, and `permessage-deflate` stays off | step 7; the distinction is §9.2 |
| Frame bytes and members-per-workspace are dashboard metrics | step 7 |
| A slow consumer is dropped, not buffered | step 6 |

### G6 — Forward compatible, and observable enough to debug at 3am

*Fails as:* messages stop arriving for one chat on one client, everything looks
healthy, and there is no signal that says so.

| Check | Satisfied by |
|---|---|
| An unknown frame `t` is ignored and counted, never fatal (invariant 43) | step 5 (the socket, both halves) |
| An unknown `event_type` still advances the cursor (invariant 32) | step 8 |
| An unknown **field** is dropped, not rejected (invariant 66) | permissive envelope parse, step 5 |
| `hello` carries a protocol version and `too_old` exists **before** it is needed | step 7 |
| All nine declared telemetry events have call sites | step 13 (the instrumentation pass) |
| `sync.cursor.stalled` fires on a frontier that stops advancing | step 8 — the most important silent failure in the system |
| `traceparent` rides the frame envelope | step 5, then a linked span at step 7 |

---

## 2. The build plan

Fourteen steps in execution order. Steps 1–3 are done; the plan states them
anyway, because "end to end" means the sequence should read as one thing rather
than as a remainder.

Each step carries the letter [`PHASE-2-SYNC.md`](PHASE-2-SYNC.md) gives it and
the item number `DESIGN.md` §15 (build order) gives it, since both are
referenced from other documents and neither gets renumbered.

| Step | Phase 2 step | `DESIGN.md` item | State |
|---|---|---|---|
| 1 — the two schemas | A | 13, 15 in part | ✅ |
| 2 — allocation and idempotency | B | 13 | ✅ |
| 3 — the domain ops | C | 13 | ✅ |
| 4 — the event log | *new* | 13 completed, 14 assumed it | ✅ |
| 5 — the socket, both halves | D | 14 | ✅ |
| 6 — the registry and fanout | *new* | 14 | ✅ |
| 7 — `hello` and `welcome` | E | 14 | ✅ |
| 8 — the apply loop and the frontier | F | 14, 15 | ✅ |
| 9 — catch-up, gap and backfill | G | 14 | ✅ |
| 10 — the directory as a stream | *new* | 14 | ✅ |
| 11 — the outbox | H | 16 | ✅ |
| 12 — retention, and the residue we accept | *new* | 14 | ✅ |
| 13 — the instrumentation pass | *new* | 14 | ✅ |
| 14 — the milestone | I | 17 | ☐ |

**Three steps are new against `PHASE-2-SYNC.md`'s A–I**, and each exists because
of something learned after that document was written: the event log (§12.1, a
row cannot record what happened), the registry and fanout split out of D so the
authorization argument gets its own tests, and the directory as a stream
(`DESIGN.md` §9.9, the `welcome` ceiling — measured at 69% of the frame).

**The rule that shapes the order, unchanged from `PHASE-2-SYNC.md`: nothing
depends on a socket until step 5.** A failure before that point is attributable
to one module rather than to "sync is broken".

---

### Step 1 — The two schemas ✅

`Phase 2 step A · DESIGN.md items 13 and 15 in part · G1`

Both databases, no transport. Server migration `005_sync.sql`; replica
`workspace.ts` version 2. Every constraint has a test of its own against a real
engine, and the CHECK-over-NULL trap is an executable control rather than a
warning.

---

### Step 2 — Allocation and idempotency ✅

`Phase 2 step B · DESIGN.md item 13 · G1`

`allocate()` and `applyOnce()`. Twenty lines, the most dangerous in the phase.
The concurrency proofs are deterministic rather than probabilistic — one
connection holds the row lock while the other is asserted to be blocked.

---

### Step 3 — The domain ops ✅

`Phase 2 step C · DESIGN.md item 13 · G1, G3`

`send`, `deleteMessage`, `markRead`, `createChannel`, join/leave/add/remove,
`head`, `eventsSince`, `catchup`, `backfill`, `counters`, `welcome`. Counters
are computed rather than materialised — a narrowing of `DESIGN.md` §12 (unread
counters), with the measurement that justifies it.

---

### Step 4 — The event log ✅

`new · DESIGN.md item 13 completed · G1, G2`

**Built.** `008_sync_events.sql`, `sync/events.ts` (the catalogue and the single
writer), `sync/directory.ts`, `allocate` split into `allocateChat` and
`allocateStream`, every domain op appending inside its own transaction, and
`eventsSince` reading the log. Nineteen tests in `sync/events.test.ts`. Four
things came out differently from the sketch below and are recorded at §5 (the
table as built) and in the open questions: no second index, `workspace_id` out
of the hot key, no `actor` stream, and an allocation that carries its own stream
and workspace so an event cannot be filed under the wrong one.

The last server work with no socket in it, and the reason it comes before the
transport rather than after: build the transport first and its first version
fans out message rows, which is a shape it then has to stop having.

**Delivered.** `sync_events`; `next_rev` on `spaces` and `workspaces`; allocation
generalised from a chat to a stream; every op appending its event in the same
transaction as its effect; `eventsSince` reading the log.

**Touched**

| | |
|---|---|
| `db/migrations/008_sync_events.sql` | the table, its `(kind, id, rev)` unique constraint — which *is* the only index it needs — and `next_rev` on two tables |
| `sync/allocate.ts` | `allocate` → `allocateChat` and `allocateStream`. The `UPDATE … RETURNING` form and its row lock do not change; only which table it locks. Both now return the stream and the workspace as well as the number |
| `sync/events.ts` *(new)* | the closed catalogue, and `appendEvent(trx, allocation, type, payload)` — the single writer |
| `sync/directory.ts` *(new)* | `recordActor`, the only writer of directory events |
| `sync/ops.ts` | `send` and `deleteMessage` append inside the transaction they already open |
| `sync/spaces.ts` | create, join, add, leave, remove each allocate a **space** rev and append. None of them had a rev before |
| `provisioning/provision.ts`, `provisioning/join.ts`, `workos/poller.ts` | `actor.created` / `actor.updated` on the workspace stream, held by a boundary rule rather than by remembering |
| `sync/feed.ts` | `eventsSince` reads `sync_events` rather than deriving from `messages` |
| `tools/check-boundaries.mjs` | a `requires` rule kind — "these two always travel together", which no line-by-line rule can see |

**Traps**

- **The event and its effect are one transaction, or the log lies.** An append
  outside the effect's transaction is a change every client applies and the
  database does not have.
- **One allocation shape, not two.** Do not give spaces a read-then-write
  counter because "spaces are low-traffic". A lost update is a lost update at
  any rate, and it silently reuses a rev — which is worse than losing one.
- **`payload` is a wire shape, not a row dump.** `SELECT *` into a payload ships
  every column added later to every client, including ones that must not have
  it.
- **int8 again.** Three new `bigint` columns. `db/types.ts` registers the parser
  per *type*, so it covers them — assert that rather than assume it.

**Done when**

- [x] Create / edit / delete against **one** message id replays as **three**
      events from `catchup(from_rev = 0)`. Written at the log level; the edit op
      is Phase 4, the log property being tested is not.
- [x] ~~Renaming a space~~ **a change with no message behind it** — creating a
      channel, adding or removing a member — produces an event on `space:<id>`
      with a rev, and `eventsSince` on that stream returns it. Nothing in
      `messages` can express this, which is the honest Phase 2 reason the log
      exists.

      *Amended while checking it off, because as first written it named two
      things that do not exist.* There is no rename op in this phase, so the
      criterion tested nothing; the membership ops carry the same property and
      are real. And `catchup` is still chat-shaped — its gap branch returns a
      materialised message tail — so `eventsSince` is the generic read over any
      stream. Generalising the gap policy to non-chat streams is step 9
      (catch-up, gap and backfill), and is called out there rather than left
      implied here.
- [x] Two concurrent transactions allocating on a `space` stream never receive
      the same rev — the existing chat proof, re-run on the generalised
      signature.
- [x] Every write path that changes replicated state appends **exactly one**
      event, asserted by counting events per op rather than by reading the code.

      Two of the three *actor* write paths reach WorkOS before they reach the
      database, so an integration test for them costs a network stub. The
      pairing is held by the boundary rule `sync/actor-write-records-directory`
      instead — a file that writes `actors` and never calls `recordActor` fails
      the build. Proved by removing the call and watching it fail, which is the
      only way to know a rule is load-bearing.
- [x] `pnpm spike:sync` green — 66 assertions.
- [x] **Added while checking the above:** a truncated replay reports the
      frontier it *delivered*, not the chat's head. Those were the same number
      only because the gap threshold and the read's limit are the same constant
      today, and step 9 exists partly to retune the first. Raise it alone and a
      client advances past events it never received — a silent permanent hole,
      which is exactly what invariant 1 forbids.

---

### Step 5 — The socket, both halves ✅

`Phase 2 step D · DESIGN.md item 14 · G4, G6`

**Built.** `packages/protocol` (the wire contract, shared so the two sides
cannot disagree), `apps/server/src/sync/socket.ts`, and
`apps/desktop/src/sync/transport/connection.ts`. Fifty-four tests across the
three. Four things came out differently from the sketch below, each recorded
where it belongs: frames are **flat** rather than `{ t, body }`; `hello` carries
**no** workspace or device id; `too_old` was pulled forward from the `welcome`
step because that is where `hello` is parsed; and the socket boundary rule was
**scoped to the desktop**, having been silently over-broad until the server grew
a socket of its own.

A connection that carries no product meaning yet: it connects, authenticates,
stays alive, reconnects, and ignores frames it does not understand. Separating
"the socket works" from "the protocol works" is what keeps the next failure
attributable.

**Touches**

| | |
|---|---|
| `apps/server/src/sync/socket.ts` *(new)* | the `ws` server, upgrade, `verifyAccessToken` on `hello`, per-connection state |
| `apps/desktop/src/sync/transport/` *(new dir)* | the only place `new WebSocket` and the `ws` package are permitted |
| `…/transport/connection.ts` | `guardConnect(gate, url)` first, heartbeat, backoff, `powerMonitor` `resume` |
| `…/transport/frames.ts` | strict envelope parse, body schema looked up by `t`, count-and-skip when absent |

**Both deferred decisions fire here** (`PHASE-2-SYNC.md` §4). XState at the
connection machine, with the kill criterion intact: write it, then estimate the
hand-rolled equivalent, and if that is under ~60 lines with no timer-cancellation
subtlety, drop the dependency. Zod at the first wire format, and **never**
`z.discriminatedUnion` on the envelope — a union rejects what it does not know
and invariant 43 requires ignoring it.

**Traps**

- **`permessage-deflate` stays off** (invariant 28). The one-shot gzip of §9.2
  is a different mechanism and does not reopen this.
- **The heartbeat carries stream heads, not just liveness.** That is what closes
  the residue named in §19 (what running our own transport costs): an
  event lost between commit and socket write is otherwise invisible until the
  next event in that stream.
- **A teardown settles every promise it abandons** (invariant 54). Both Phase 1
  bugs in this area were cleanup that did not run on an exit path.
- **Patching `fetch` does not catch a socket.** One opened outside the gate
  stays connected while simulated offline claims the network is cut — R3
  reporting all-clear while broken.

**Done when**

- [x] A client survives a server restart, a laptop sleep and a network change.

      Restart and network loss are asserted over a real socket. **Sleep is
      asserted at the seam, not end to end**, and that is worth being explicit
      about: `powerMonitor` is a main-process API and the socket lives in the
      utility process, so main forwards `resume` and `unlock-screen` and the
      transport exposes `retryNow`. Both halves have tests; the lid closing does
      not, because nothing in a test runner closes a lid.
- [x] An unrecognised frame `t` is delivered, counted and ignored, and the
      connection stays open — asserted from **both** sides, because a server
      that dropped a newer client's frame would make every rollout a partial
      outage for whoever updated first.
- [x] `pnpm check:boundaries` is clean **with `sync/transport/` existing** — the
      rule stops passing vacuously for the first time. Proved by putting a rogue
      socket outside the transport and watching it fail.
- [x] The XState decision is recorded either way, with the line count that
      decided it. **129 lines, which is over the ~60 threshold, and it was
      dropped anyway** — the deciding reason is the coupled `session.ts` port
      that has already been tried and reverted, not the count
      (`FRONTEND.md` §7.4).
- [x] **Added while building:** a deadline on the anonymous half of the
      handshake. Authenticating on `hello` rather than on the upgrade means an
      unauthenticated socket exists for a moment, and without a deadline that
      moment is unbounded — opening sockets and saying nothing would be a free
      way to hold server memory. Pinging does **not** postpone it, which is the
      part worth a test: a deadline anything can extend is not a deadline.

---

### Step 6 — The registry and fanout ✅

`new, split out of Phase 2 step D · DESIGN.md item 14 · G3, G5`

**Built.** `sync/registry.ts`, `sync/fanout.ts`, the `ev` frame, and the domain
ops returning their events instead of swallowing them. Twenty-three tests of its
own plus two through a real socket. Two things came out differently from the
sketch below: the ops now return `{ ack, event }` rather than an ack alone —
because the event has to leave the transaction somehow, and returning it keeps
`ops.ts` unaware that sockets exist — and `fanout` filters by **workspace** as
well as by audience, which the sketch had as a line in a diagram and is a real
tenant boundary.

Server-only, testable against fake sockets, and the piece that carries the whole
authorization argument — which is why it is its own step rather than a paragraph
inside the transport.

**Touches**

| | |
|---|---|
| `sync/registry.ts` *(new)* | connections keyed by **actor**, with a heartbeat deadline |
| `sync/fanout.ts` *(new)* | `audienceFor(db, event)` and the write to sockets |
| `sync/ops.ts`, `sync/spaces.ts` | call `fanout` **after** the transaction commits |

**Traps**

- **Fan out after commit, never inside.** Inside the transaction, a rollback has
  already published an event that never happened.
- **The registry holds no authorization.** A connection that remembered its
  audience is a subscription, with every revocation problem that implies.
- **Keyed by actor, not device** — two connections for one person is not a
  special case, it is the ordinary one.
- **A slow consumer is dropped, not buffered.** Past a `bufferedAmount`
  threshold, close it and let the client reconnect. That is safe *because*
  durable catch-up exists; a system without it would have to buffer without
  bound or lose the event in silence.

**Done when**

- [x] An actor removed from a space receives nothing further for it on the very
      next event — with the socket still open and still receiving other spaces.
- [x] A private chat's audience is the intersection with space membership
      **leading**: an actor still in the chat row but out of the space receives
      nothing.

      Private chats are Phase 5, so the test writes the membership rows by hand.
      Worth doing now rather than then: getting the conjuncts the wrong way
      round is an access leak rather than a missing feature, and the test leaves
      a **stale chat membership in place** so the space check in front of it is
      what has to do the work.
- [x] Two connections for one actor both receive — and a third, for the same
      actor in a *different workspace*, does not.
- [x] A socket past the buffer threshold is closed. **The second half —
      "reconnects, and catch-up leaves it byte-identical" — is not asserted,
      because catch-up over a socket does not exist until step 9.** The drop
      is tested; the repair it relies on is tested at the domain layer and not
      yet through a reconnect. Re-check this when step 9 lands rather than
      treating the box as closed.
- [ ] Audience size and fanout duration are metrics, not log lines. **Deferred
      to step 13 (the instrumentation pass)**, with the seam built: `fanout`
      returns `{ audience, delivered, dropped }` rather than logging, so the
      markers have something to read that is not a re-derivation.
- [x] **Added while building:** a replayed op fans out nothing. The ledger stops
      the work happening twice; without a second guard the *event* would still
      escape from the rolled-back first attempt, and every other device would
      receive a message the sender's own ack correctly reported once.

---

### Step 7 — `hello` and `welcome` ✅

`Phase 2 step E · DESIGN.md item 14 · G3, G5, G6`

**Built.** `welcome` grew from a chat array to the whole payload — joined
spaces with their stream cursors, chats with head state and counters, the
caller's own memberships, and the workspace cursor — plus `Storage.applyWelcome`
on the client and negotiated compression on both halves. Two things came out
differently: compression is **negotiated in `hello` and applied to any frame
over 8 KB**, rather than being a `welcome`-shaped special case; and the
query-count test now asserts the cost is **equal at two chat counts** rather
than equal to one, because the frame legitimately reads four shapes and the
property was always the slope.

The first exchange that means something, and the one that satisfies R2 — after
it, every badge in the sidebar is correct and not one message body has been
fetched.

**Touches**

| | |
|---|---|
| `sync/feed.ts` | `welcome` gains `spaces` (joined only), the caller's own `memberships`, and the `streams` cursor array |
| `sync/socket.ts` | `hello` verification, protocol version, `too_old`, one-shot gzip of the frame |
| `apps/desktop/src/sync/index.ts` | writes `chat_state` per chat; **`auth/directory.ts` and `fetchActors` are deleted** |

**Traps**

- **The directory invalidation currently fires inside `fillActors`.** It moves
  to the `welcome` handler. Miss it and the workspace directory silently stops
  refreshing — no error, exactly the failure the live-query client was built to
  remove.
- **One statement, whatever the chat count.** Held by a query-count test today.
  Reconnects arrive together after a deploy, so an N+1 here multiplies by every
  client at once: 301 statements each at ~333 reconnects/second is ~100k
  statements/second.
- **Build `too_old` now**, a year before it is used. The moment it is needed is
  the moment it cannot be shipped, because the clients that need it are the old
  ones.

**Done when**

- [x] A client with empty cursors receives `welcome`, writes `chat_state` for
      every chat, and the sidebar badge matches the server's **with the message
      tables empty**. That last clause is the whole point, and it is the
      assertion: `SELECT COUNT(*) FROM messages` is zero while the badge reads
      six.
- [x] **`welcome` does not advance `synced_through_rev`** — added while
      building, and the sharpest rule on the client. Being told a head exists
      is not holding the changes below it, so advancing the frontier here would
      jump it past events that were never applied: a silent permanent hole
      (invariant 1). The gap between the two watermarks *is* the catch-up owed,
      and a reconnect must leave an existing frontier and gap marker alone.
- [x] The frame carries no collection sized by the workspace (invariant 71),
      asserted against a 300-actor fixture with a dozen unjoined public
      channels rather than by inspection.
- [x] ~~One statement~~ **the same number of statements** at two chat counts.
      Requiring exactly one was guarding a number rather than the property; the
      frame reads four shapes now and the slope is what must stay flat.
- [ ] Gzipped frame bytes and members-per-workspace are dashboard metrics.
      **Deferred to step 13 (the instrumentation pass)**, with the mechanism
      built: compression is negotiated and applied, so the bytes exist to be
      measured.
- [ ] ~~`auth/directory.ts` and `fetchActors` are gone.~~ **Moved to step 10
      (the directory as a stream), which is where the replacement lands.** As
      written this criterion deleted a working directory three steps before
      anything replaced it: `People.tsx` would render empty and every message
      author would be a monogram, for the whole of steps 8 and 9. The HTTP
      directory keeps running until the stream that supersedes it exists.

---

### Step 8 — The apply loop and the frontier ✅

`Phase 2 step F · DESIGN.md items 14 and 15 · G1, G6`

**Built.** Replica version 3, `sync/apply.ts` (the three-case rule and the
drain), `sync/effects.ts` (what each event type means locally), and the topic
vocabulary the invalidations use. Twenty-one tests. One thing came out larger
than the sketch: `synced_through_rev` lived on `chat_state`, so a space or the
directory had **nowhere to keep a cursor** and their events could not be applied
at all — every stream's frontier now lives in one `stream_state` table, which
also removes a branch from the hottest correctness path in the client.

Where the spike earns its keep, and the most expensive failure mode in the
system. It lands before anything that produces volume, deliberately.

**Touches**

| | |
|---|---|
| `sync/migrations/workspace.ts` version 3 | `staged_events` replaces `pending_revs` |
| `apps/desktop/src/sync/apply.ts` *(new)* | the three cases of §11 (receiving an event, and the frontier) |
| `apps/desktop/src/sync/invalidate.ts` | a topic per event type |
| `DESIGN.md`, `STORAGE.md`, `OBSERVABILITY.md` | all three named `pending_revs`; all three now describe the replacement |

**Traps**

- **The lost-edit bug is the reason this step exists in this shape.** Duplicate
  suppression and rev-only staging are each correct alone and lose an edit
  together (§11.1, why the envelope and not just the rev).
- **The domain effect and the cursor advance are one transaction.** Advancing
  past an event whose effect did not land is a silent permanent hole.
- **An unknown type still advances the cursor.** Otherwise the frontier stalls
  for ever and the client stops receiving that chat while looking healthy.

**Done when**

- [x] The lost-edit trace of §11.1 is a test — **and it is a stronger shape than
      this criterion asked for.** Rather than one test that used to fail, there
      are two: the first rebuilds the rev-only rules and asserts the edit is
      *lost*, the second runs the identical trace against `staged_events` and
      asserts it survives. Both stay in the suite for ever, so the bug cannot be
      reintroduced by reverting — where a test that merely used to fail leaves
      no record of the old behaviour at all.
- [x] Out-of-order events injected during catch-up leave the frontier correct.
      A batch is sorted before applying, so a server free to return events in
      any order cannot produce a different result.
- [x] An unknown `event_type` advances the cursor and a later known event still
      applies (invariant 32).
- [x] `staged_events` is empty whenever the client is caught up, asserted — a
      staging table that never drains is a slow leak with no symptom.
- [x] **Added while building:** the effect and the cursor advance are one
      transaction, *including the drain*. A handler that throws halfway through
      unblocking twenty events rolls all twenty-one back — a partial drain would
      leave the frontier claiming revisions whose effects were undone, which is
      the same silent hole arrived at by a different route.
- [x] **Added while building:** a v1 replica upgrades all the way and keeps its
      place. The migration rebuilds `chat_state` to move three columns out, and
      losing a frontier there would silently re-fetch everything — or worse,
      leave the client believing it holds history it discarded.

---

### Step 9 — Catch-up, gap and backfill ✅

`Phase 2 step G · DESIGN.md item 14 · G2`

**Built.** `catchup` generalised across stream kinds with a discriminated
snapshot, the `catchup`/`backfill` request frames and their three replies,
server handlers gated on `can()`, and `sync/catchup.ts` on the client — the
coalescing scheduler, chunked application, the gap, and backfill paging.
Twenty-five tests.

What bounds a reconnect to O(streams) rather than O(messages).

**Touches** the client's catch-up scheduler (one coalesced request per stream,
never one per event), the gap handler, `has_gap` and `oldest_local_ord`, and
lazy backfill on open rather than on reconnect.

**Traps**

- **Bounded batches, roughly 200 events, yielding between them.** WAL lets
  readers proceed during writes; chunking is what stops a large catch-up
  starving the queries a visible surface is making.
- **Backfill is keyset on `ord`, never `OFFSET`** — offset paging degrades
  linearly and, worse, skips or repeats rows when anything is inserted
  mid-scroll.
- **A gap clears staged events for that stream.** The frontier has jumped past
  them; leaving them behind means applying an event twice or never.
- ~~**`catchup` is still chat-shaped**~~ — **resolved here.** The gap reply now
  carries a snapshot discriminated by stream kind: newest messages for a chat,
  current shape for a space, and for the directory nothing at all, because it is
  the one collection sized by the workspace and is paged separately (step 10).
- **Retuning the gap threshold is not a one-line change.** It is a separate
  constant from `eventsSince`'s limit, and the two are equal today. Raise the
  threshold alone and a replay is truncated by the limit — which `toRev` now
  reports honestly, but which also means a client needs a second round to
  finish. Move both, and assert the truncated-replay test still passes.

**Done when**

- [x] A far-behind client receives a gap plus a tail, renders it immediately,
      and backfills on open.
- [x] A gap sets `has_gap` and `oldest_local_ord` and clears `staged_events`
      for that stream. The floor only ever goes **down** — a later gap with a
      shorter tail must not raise it and hide history already held.
- [x] A large catch-up does not starve an open surface — **asserted on the
      reader's latency, not the writer's duration**, because a catch-up that
      finishes quickly while the interface is frozen has failed. A reader
      polling during a 3,000-event catch-up saw a worst case well under 100 ms.
- [x] **The gap threshold is re-affirmed with data, and the data changed what
      the number means.** Measured: 265 bytes per event on the wire, and one to
      three milliseconds of server time *at any size*. So the database is not
      the constraint and the wire is — at 500 revs a single replay is 129 KB,
      comparable to the whole `welcome` frame, and a client reconnecting after
      a deploy asks on every stream it is behind on rather than one.

      What would actually settle the number is a distribution of how far behind
      real clients are, and there is no traffic to take one from. What the
      measurement *did* settle is the coupling below.
- [x] **Added while measuring:** the threshold and the replay limit are now one
      derived from the other rather than two constants that happen to match.
      Raise the threshold alone and a replay is silently capped — a client told
      it may replay 900 revisions is sent 500. Survivable only because `toRev`
      reports what was delivered; a silent permanent hole before that fix.
- [x] **Added while building:** a stream `kind` this server does not have is
      ignored rather than fatal. Without the guard it fell through to the
      workspace branch of the head lookup, so a client asking about
      `banana:spc_1` would have been answered about a workspace — and a cast
      would have compiled and done exactly that.

---

### Step 10 — The directory as a stream ✅

`new · DESIGN.md item 14 · G2, G5`

**Built.** `actor.*` applied on the client, the paged `directory` /
`directory_ok` frames keyset on actor id, and `auth/directory.ts` plus
`fetchActors` deleted. Twelve tests.

**It also absorbed a dependency the plan never assigned**, and that is worth
recording rather than smoothing over. Every step from the socket onwards built a
piece with a test — a connection, an apply loop, a scheduler, a pager — and
**nothing assembled them**: the engine had never opened a socket. It was nobody's
step until this one forced it, because `fetchActors` may only be deleted once
its replacement is *running*. `sync/link.ts` is that assembly, and it is
deliberately thin: it decides which function gets called with what, and nothing
else. The moment it holds an opinion it becomes a second place the frontier rule
lives.

The first consumer of the stream machinery that is not a chat — which is the
proof that it generalised, rather than a claim that it did.

**Touches** `actor.created` / `actor.updated` / `actor.deactivated` on the
workspace stream; the `directory` and `directory_ok` frames, keyset on actor id;
the client's row apply; and the monogram fallback for an author whose row has
not landed yet.

**Traps**

- **This is the one workspace-wide stream**, and it earns that only because
  every member is entitled to all of it, so the cursor has no holes to contain.
  Nothing else joins that stream without re-answering that question.
- **The monogram window is a decision, not a bug.** On a fresh device only,
  between first paint and the last page, an author renders without a name. Ship
  it as the same fallback avatars already use.

**Done when**

- [x] A fresh device paints before the directory lands, and the author's name
      appears when it does, with no error state in between. Asserted as a LEFT
      JOIN that survives the absence, because the failure mode is not "no name"
      — it is an inner join that drops the message entirely.
- [x] A reconnect two revs behind applies **two rows**, not 1,600.
- [x] A deactivated actor still renders on their old messages: an
      `actor.updated` carrying `state: 'deactivated'`, never a removal.
- [x] **`auth/directory.ts` and `fetchActors` are deleted here**, not earlier —
      moved from step 7, where deleting them would have left the client with no
      directory at all until this step landed. The invalidation moved with them,
      and now fires **per page** rather than once at the end: on a fresh device
      the first page is the difference between every author being a monogram and
      most of them having a name, and it lands seconds before the last.
- [ ] Directory page count and latency are metrics. **Deferred to step 13 (the
      instrumentation pass)** with the seam built — the pager reports rows per
      page, so open question 6 (directory retention on the client) becomes a
      measurement rather than a guess as soon as the markers land.
- [x] **Added while building:** a directory page does NOT delete what it did not
      contain. The HTTP endpoint was a whole snapshot in one response and could
      treat absence as removal; a page cannot, because an actor missing from
      page two is on page one.

---

### Step 11 — The outbox ✅

`Phase 2 step H · DESIGN.md item 16 · G1, G4`

**Built.** `sync/outbox.ts` (coalescing, ordering, ack, nack, retry, discard),
the `op` / `ack` / `nack` frames, the server's write handler, and the drainer in
`sync/link.ts`. Twenty-three tests.

The write path, and the first thing a user can break by being offline.

**Traps**

- **Coalescing runs on enqueue**, scoped by `target_id`, because `delete`
  targets a message the server has never heard of. This is a correctness
  requirement, not an optimisation, and it is why the outbox indexes
  `target_id`.
- **In order per chat, one in flight**; cross-chat parallelism is wanted.
- **`nack` carries `retryable`.** A send into a chat you were removed from will
  never succeed, and retrying it silently for ever is worse than an error with a
  discard action.

**Done when**

- [x] Compose-then-delete offline produces **zero** network ops, not two that
      fail — and the optimistic row goes with them. It was never sent, so there
      is nothing to tombstone; leaving a deleted row behind would render a
      message no other device has ever seen.
- [x] Three messages typed offline arrive in the order typed. The sequence is
      derived from the table rather than held in memory, because the outbox
      outlives the process — a counter reset on restart would hand a new op a
      number below one already queued.
- [x] The ack stamps the message row and deletes the outbox row in **one**
      transaction, and the server's own timestamp replaces the optimistic one.
- [x] A non-retryable nack marks both the op **and the message**, so a surface
      can show *which* message failed rather than a banner about an op id
      nobody has seen. `retry` and `discard` are the two things a person can do
      about it, and retry goes to the **back** of the queue: its original
      sequence is long past, so re-inserting there would put an hour-old
      message ahead of this morning's.
- [x] **Added while building:** discarding a failed *delete* leaves the message
      alone. The person wanted it gone and could not have it — removing it
      locally would be the app doing the thing the server refused, and the next
      reconnect would bring it straight back.
- [x] **Added while building:** an unclassified error defaults to **retryable**.
      Getting it wrong in either direction is bad in a different way, and the
      costs are asymmetric: retrying something permanent is visible, while
      discarding something transient is a message the person believes they sent.

---

### Step 12 — Retention, and the residue we accept ✅

`new · DESIGN.md item 14 · G2, G6`

**Built.** `sync/retention.ts` (the bounded sweep, the retained floor, the
hourly job), the retention guard in `catchup`, and stream heads on the
heartbeat. Twelve tests.

The sweep, the horizon, and an honest statement of what one node does not close.

**Touches** a bounded retention job over `sync_events`, the heartbeat's head
comparison from step 5, and the operational notes in `OBSERVABILITY.md`.

**Done when**

- [x] A cursor older than the horizon receives a **gap**, not an error and not
      an empty replay that looks like being caught up.

      **Too far behind is not only about distance**, which is the part that
      would have been missed. A client can be well inside the gap threshold and
      still unreplayable because retention took the events it needs — so
      `catchup` asks whether revision `fromRev + 1` is still retained, which is
      a complete answer because revisions are gapless per stream. Without it the
      client gets a replay starting above its frontier, finds a hole, stages it
      and asks again, for ever; swept entirely it is worse, an empty replay
      whose `to_rev` equals the cursor that was sent.
- [x] The sweep is bounded and holds no long transaction — batches of 5,000,
      yielding between passes, hourly, with the first tick delayed so a server
      does not do its heaviest database work at the moment every client is
      reconnecting after the deploy that restarted it.
- [x] **The horizon is seven days, chosen against the gap threshold rather than
      independently.** It answers "how long may somebody be away and still
      resume exactly where they were" — a holiday, a broken laptop, a machine
      asleep over a weekend. Beyond it nothing is lost, which is why it can be
      short: the gap path delivers current state and backfill repairs the
      history below. A short horizon costs a gap; a long one costs a table that
      only grows, on the hottest read path in the system.
- [x] The commit-to-socket residue is **measured rather than asserted**. The
      test commits an event WITHOUT fanning it out — exactly the state a crash
      in that window leaves — confirms nothing reached the socket, then sends a
      heartbeat carrying the client's cursors and asserts the reply names the
      stream and its head. Bounded to one heartbeat interval.
- [x] `LISTEN/NOTIFY` plus an unpublished sweep is written down in
      `sync/retention.ts` and explicitly **not built**, with the trigger stated:
      the first time a second server process holds connections. Availability
      alone does not force it — two nodes where only one accepts sockets is
      still one fanout tier.

---

### Step 13 — The instrumentation pass ✅

`new · DESIGN.md item 14 · G6`

**Every marker for the whole sync path, decided in one sitting**, rather than
nine decided one at a time as each step landed.

That is a deliberate departure from working rule 8 in [`AGENTS.md`](../AGENTS.md)
— *observability is part of the feature, not a follow-up* — so it is worth
saying why rather than letting it read as drift. The rule exists to stop
instrumentation being dropped, and to make each marker a conversation rather
than a reflex. Neither is at risk here: the nine events are already **declared**
and the build fails for an unmarked metric with no call site, so they cannot be
forgotten. What one pass buys is the thing per-step decisions cannot — a
coherent picture of a single request crossing the whole path. Deciding
`ws.connected` in isolation, six steps before `sync.cursor.stalled` exists, is
how you end up with nine markers that each answer a local question and together
answer nothing.

The risk it carries, named so it is watched: a step that ships uninstrumented is
a step debugged by `console.log` until this one lands. If step 13 slips past the
milestone, it has failed.

**Covers**

| | |
|---|---|
| `ws.connected`, `ws.disconnected`, `ws.zombie.detected` | step 5, the socket |
| `sync.event.unknown`, `sync.cursor.stalled` | step 8, the apply loop |
| `sync.gap.entered`, `sync.backfill.page` | step 9, catch-up and gap |
| `outbox.coalesced`, `outbox.op.failed` | step 11, the outbox |
| `traceparent` on the frame envelope | steps 5 and 7 |

**Plus the ones with no home yet**, which is exactly what a single pass is for:
event appends by type, audience size, fanout duration, `welcome` frame bytes,
members-per-workspace, directory page count, and the slow-consumer drop.

**Done when**

- [x] Every marker is proposed with **the question it answers**, and each is
      agreed before it is added. "A counter of X" is not a justification.
      *Twenty-two metrics, each carrying its question in `metrics.ts`.*
- [x] Proposing *not* to instrument something is on the table and used at least
      once — a marker nobody reads costs cardinality, ingest and attention.
      *Four declined, three of them named by `OBSERVABILITY.md` §9; the reasons
      are in the catalogue rather than only in a commit message.*
- [x] All nine declared events have call sites. *Asserted by
      `observe.test.ts`, which greps the engine rather than trusting a list.*
- [x] No unbounded id is a metric label. 100 actors × 150 chats is 15k series
      against a 10k cap, and it is enforced at compile time. *930 series from
      the whole catalogue, and the count is now derived from the label sets
      rather than hand-maintained — the hand-maintained one had drifted.*
- [x] A "user pressed send" span on the client links to the server span that
      assigned the `ord`. *Proven from both ends: `trace.test.ts` on the client,
      and a real socket on the server.*

**What it cost, and what it found.** The pass began by discovering that `span()`
was **a timer, not a trace** — a duration line in Loki with no trace id, no
parent and nothing crossing the socket, so Tempo had always been empty. Real
tracing had to be built before "the full path" was expressible at all.

Four bugs came out of wiring it, and every one of them was silent:

| Found | Why it was invisible |
|---|---|
| `ws.connected` reported `attempt` **after** zeroing it | The event existed since step 5 and had never once said anything |
| `stop()` settled the directory pager with a synthetic `{ complete: true }` | Stopping mid-hydration adopted the cursor for a snapshot that had only started; actors on later pages would render as monograms until they happened to change |
| `frame()` let a body key shadow the envelope's `t` | The reserved-key rule was documented and not enforced |
| `LABEL_CARDINALITY` had drifted from the unions (`via` 5 vs 6, `outcome` 3 vs 4) | The series-budget test — the thing standing between us and the 10k cap — had been under-counting |

The dashboards were also unchecked against the catalogue in either direction,
which is the same class of bug as the `app.boot` empty panel. `dashboards.test.ts`
now fails a panel querying a name nothing emits, a filter on a label value
outside its closed set, a unit that disagrees with the metric, and any sync
metric displayed nowhere.

---

### Step 14 — The milestone

`Phase 2 step I · DESIGN.md item 17 · every goal`

Not a build step. The demonstration, run by hand:

1. Two clients, one chat. A message on one appears on the other.
2. Kill the server. Both keep rendering, scrolling and searching their history.
3. Compose on both while the server is down. Restart it. Both converge on the
   same order, with no duplicates.
4. Sleep a laptop ten minutes mid-session. It reconnects promptly rather than
   sitting on a zombie socket.

**Then the cross-phase checks**, which are the ones a per-step checklist cannot
catch:

- [ ] `pnpm spike:sync` green — 66 assertions, ported and never rewritten.
- [ ] `boot.test.ts` still removes `fetch` from the process and still passes.
      R3 is checked **at the end**, because it regresses quietly.
- [ ] `pnpm typecheck` and `pnpm check:boundaries` clean.
- [ ] All nine declared telemetry events have call sites — step 13, which must
      land **before** this one rather than after it.
- [ ] `PHASE-2-SYNC.md` §6 (done criteria) — its three "failed even with every
      box ticked" cases re-read deliberately, not skimmed.

**One path still has no production caller**, and one that had none was fixed.
Both were found while instrumenting them, and both stopped at the same place —
the client never *asked*:

| Path | State |
|---|---|
| `enqueue` → an op on the wire | The outbox has no caller. Compose is a later phase, so this is expected rather than a gap; the trace test drives `enqueue` directly. |
| `backfill` → `backfill_ok` → `applyBackfill` | **Fixed in step 13.** `link.ts` neither sent the request nor routed the reply — step 9 built both ends and the assembly (which was never assigned a step) did not connect them. |

The second was a real gap rather than a phase boundary, and flow 2 above walks
straight into it: kill the server, scroll back past the tail, and there was no
way to fetch what was below it. A gap the client cannot climb out of is exactly
the failure the gap design exists to prevent — *missing-and-marked* is only
better than *missing-and-unknown* if the mark can be acted on. `link.backfill()`
now closes it, one request per chat at a time, and stops on its own when the
beginning of history is reached.

### What this plan deliberately excludes

Named so that "sync is done" cannot quietly mean something larger. Edits,
reactions, threads and search are Phase 4; rooms and private chats are Phase 5;
agents are Phase 6. Multi-node fanout, materialised counters and a relationship
engine for authorization are all deferred **with named triggers** rather than
indefinitely — the triggers are in §22 (open questions), `DESIGN.md` §12 (unread
counters) and `AUTHZ.md` §10 respectively.

---

## 3. The shape

```
   renderer ── query / invalidate ──▶ utilityProcess ──┬── SQLite replica
   (React)                             (sync engine)   │
                                             │         └── outbox
                                 ┌───────────┴───────────┐
                            one WebSocket          HTTPS (auth only)
                       ops, events, catch-up,      sign-in, refresh
                       backfill, heartbeat
                                 └───────────┬───────────┘
                                        Relayed server
                                             │
                                        PostgreSQL
                                 ┌───────────┴───────────┐
                           domain tables            sync_events
                        "what is true now"      "what changed, in order"
```

Every read the product performs is served from the replica. The socket is how
the replica learns; it is never on the path between a component and the data it
renders.

## 4. Three words that are not synonyms

```
STREAM     what is ordered.  chat:<id>, space:<id>, workspace:<id>
           owns a rev sequence and a client cursor

           actor:<id> is NOT one. It is a delivery ADDRESS — everything
           sent to it converges without order — so it has no counter,
           no rows in the log and no cursor. See §5.

AUDIENCE   who receives it.  derived from memberships at send time
           never stored on the event, never subscribed to

CONNECTION one socket, one actor, one device, one workspace
           a delivery target, not a permission
```

The inversion that matters: **an event computes its audience; a connection does
not subscribe to anything.** Nothing on the client asks to receive a stream, so
nothing has to be revoked when membership changes.

## 5. `sync_events`

**Built** as `008_sync_events.sql`.

```sql
CREATE TABLE sync_events (
  event_id     TEXT PRIMARY KEY,        -- ULID, evt_… — and the retention key
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stream_kind  TEXT NOT NULL,           -- 'chat' | 'space' | 'workspace'
  stream_id    TEXT NOT NULL,           -- no FK: the target table varies by kind
  stream_rev   BIGINT NOT NULL,
  event_type   TEXT NOT NULL,           -- 'message.created', 'space.member_added', …
  payload      JSONB NOT NULL,          -- a WIRE shape, never a row dump
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sync_event_kind CHECK (stream_kind IN ('chat','space','workspace')),
  CONSTRAINT sync_event_rev  CHECK (stream_rev > 0),
  CONSTRAINT sync_event_stream UNIQUE (stream_kind, stream_id, stream_rev)
);
```

Eight columns. The AppSync proposal's table has fourteen; the six it adds —
`fanout_scope`, `fanout_scope_id`, `fanout_generation`, `published_at`,
`publish_attempts`, `next_publish_at` — are three to name an audience the
transport cannot compute and three to track an asynchronous publisher. We
compute the audience in the request that commits the write, so we need neither.

**Three things changed between this sketch and the table**, each found by
building it rather than by reading it back.

**There is no second index.** The draft above declared `UNIQUE (…)` and then a
`CREATE INDEX` on the identical columns. Postgres implements a unique
constraint *with* a B-tree index, so the second one was pure write cost for
nothing. Verified rather than assumed: `EXPLAIN ANALYZE` of a catch-up over a
50,000-row log gives `Index Scan using sync_event_stream`, one index search, no
sort — the index already delivers `stream_rev` in order.

**`workspace_id` left the key.** Leading with it added no uniqueness — stream
ids are globally unique prefixed ULIDs — while forcing every reader to carry a
workspace, since a B-tree cannot seek without its first column. The column stays
for fanout's workspace filter and for tenant-scoped sweeps; authorization
already scopes the read, because a caller reaches catch-up only through `can()`.

**`actor` is not a stream kind.** Everything addressed to an actor — read state
from another device, counter snapshots — is a max-register or a projection: it
converges without ordering and repairs itself from the next `welcome`. Nothing
in this phase needs a cursor over it, so `actors` gained no `next_rev` and the
CHECK does not admit the value. Notifications may change that in Phase 7;
a value in a CHECK and a column defaulting to zero is a cheap migration, and a
stream kind nothing writes is a constraint nothing has ever exercised.

`chats` already carried `next_rev`. `spaces` and `workspaces` now do too.

### What is a stream, concretely

| Stream | Carries | rev lives on |
|---|---|---|
| `chat:<id>` | messages, deletes, later edits and reactions | `chats.next_rev` |
| `space:<id>` | renames, chat created/removed, membership topology | `spaces.next_rev` |
| ~~`actor:<id>`~~ | a delivery **address**, not an ordered stream — see below | *no counter* |
| `workspace:<id>` | the actor directory, and nothing else | `workspaces.next_rev` |

One workspace-wide sequence is deliberately **not** the primary cursor. It would
force unrelated features into one order and produce permanent holes for every
actor not authorised to see most of it — a cursor that can never become
contiguous.

The directory is the one exception, and it earns it: **every workspace member is
authorised to see all of it**, so the cursor has no holes to contain. Nothing
else may join that stream without re-answering that question.

---

## 6. Tracking connections

The registry lives in the server process and holds no authorization — only
delivery targets. Authorization is re-evaluated per event, from the database.

```ts
interface Connection {
  socket:      WebSocket;
  actorId:     string;      // from the verified access token, never the client
  workspaceId: string;
  deviceId:    string;
  sessionId:   string;
  /** Highest rev written to this socket per stream. Debug and telemetry only. */
  sent:        Map<string, number>;
  lastSeenAt:  number;      // heartbeat deadline (invariant 29)
}

class Registry {
  #byActor = new Map<string, Set<Connection>>();
  add(conn): void            // on authenticated connect
  remove(conn): void         // on close, error, or heartbeat deadline
  forActors(ids: Iterable<string>): Connection[]
  size(): number             // metric
}
```

Two properties worth stating:

- **Keyed by actor, not by device.** Alice on a laptop and a desktop is two
  connections under one actor id, and both receive everything she may see. That
  is what makes multi-device work with no special case.
- **The registry is memory, not truth.** A crash empties it; clients reconnect
  and catch up. Nothing durable depends on it.

---

## 7. How the socket decides what to send

It does not decide per socket. The **event** resolves an audience, and the
registry turns that into sockets.

```
committed sync_event
        │
        ▼
  audienceFor(event) ──────▶ Set<actorId>
        │
        ▼
  registry.forActors(...)  ──▶ [Connection, …]
        │
        ▼
  filter conn.workspaceId === event.workspace_id
        │
        ▼
  receives(event.audience, conn.actorId) ?
        ├─ yes ─▶ write the `ev` frame
        └─ no  ─▶ write the revision alone: type `withheld`, payload {}   (§7.1)
```

```ts
async function audienceFor(db, event): Promise<string[]> {
  switch (event.stream_kind) {
    case 'chat': {
      const { spaceId, isPrivate } = await chatLocation(db, event.stream_id);
      const members = await spaceMembers(db, spaceId);           // spaces.ts, built
      if (!isPrivate) return members;
      const inChat = await chatMembers(db, event.stream_id);
      return members.filter(actor => inChat.includes(actor));  // access predicate
    }
    case 'space':  return spaceMembers(db, event.stream_id);
    // No 'actor' case: an actor is a delivery address rather than a stream, so
    // nothing addressed to one is ever a sync_event. Read state and counter
    // pushes go straight to that actor's connections (§15).
    // The directory. Everyone in the workspace, which is the ONLY stream for
    // which that is the right answer — and only because everyone is entitled
    // to all of it, so no recipient ends up with a cursor full of holes.
    case 'workspace': return workspaceMembers(db, event.stream_id);
  }
}
```

The private-chat branch is the access predicate from `DESIGN.md` §7.3
(membership and access) with the
space conjunct leading, exactly as `can()` evaluates it — so an actor removed
from a space cannot receive a private chat inside it through a stale chat row.

**A member removed a millisecond ago is absent from `spaceMembers`.** There is no
subscription to revoke, no generation to rotate, no window in which a stale
audience is published to. This is the single largest structural difference from
the AppSync proposal.

### 7.1 An event only some readers may see

A message can be for a list of people rather than the whole chat
(`WORKSPACE-AGENTS.md` §8). **A dormant capability**: nothing in v1 writes one —
agent runs' access cards, which it was built for, are public messages only their
actor can act on (§7.4 there) — and a dev-only route exercises it.
`audienceFor` is **unchanged**: it still answers "who may read this stream", and
every one of them receives every revision of it. What the event's own list
narrows is only whether that revision carries its content:

```
readers = audienceFor(event)              ← the access predicate, space first
for each connected reader:
  event.audience is 'stream', or the reader is on its list → the ev frame
  otherwise                                                → { t:'ev', stream, rev, type:'withheld', payload:{} }
```

Not sending the unlisted reader anything is the obvious design and it breaks
§11: their frontier finds a hole at that revision, catch-up cannot fill it
without the content, and every later message in the chat is staged and never
shown. **The revision without the content** keeps the frontier contiguous; the
payload carries no id, type, author or ordinal, so nothing can be matched to a
later delete or told apart from an edit. A client older than `withheld` handles
it anyway — an unknown type advances the cursor (invariant 32).

In this order: readers first, then the list. A listed actor who has left the room
is not a reader, so they receive nothing — neither the content nor a withheld —
and nobody edited a list to make that true.

The list is on the log row (`sync_events.visible_to`, copied from
`messages.visible_to` when written), so catch-up redacts from the log without
reading `messages`. `appendEvent` takes the audience as a **required argument**,
and only a chat event may be listed — so forgetting it, or narrowing a space
event, does not compile. The decisions live in one file,
`apps/server/src/sync/visibility.ts`, which every read path imports.

### Cost, and the cache

One membership query per event. At team scale that is a few hundred an hour. If
it ever matters, memoise space → members in the server process and invalidate on
membership write — the same topic-invalidation shape the renderer already uses.
Do not cache it in the connection: a connection that remembered its audience
would be a subscription, with all the revocation problems that implies.

---

## 8. The frame vocabulary

All frames are JSON. Inbound frames are parsed **permissively** — unknown
fields ignored, unknown `t` counted and skipped, never fatal (invariants 33, 43,
66). Writes ride the socket rather than HTTPS, per `DESIGN.md` §9.5 (writes):
one ordered
connection, one authentication, and an ack that can be correlated to an outbox
row.

### Client → server

```json
{ "t": "hello", "protocol": 1,
  "access_token": "eyJ…",
  "cursors": [
    { "kind": "chat",  "id": "cht_01M244GW79BBXYFPJS6J7AYNQ0", "rev": 8134 },
    { "kind": "space", "id": "spc_01M244GW79Y0PXWXJ7B4Q1TR5K", "rev": 31 },
    { "kind": "workspace", "id": "wsp_01M234E35Y8WYEKFQSA03JD3BY", "rev": 4819 }
  ] }
```

**No `workspace_id`, no `device_id`, and no actor.** All three are claims in the
verified token, and a field that is present but ignored is an invitation to
trust it one day. Earlier drafts of this section carried two of them; they are
removed rather than accepted-and-discarded, and a test asserts their absence.

Frames are **flat**: the envelope keys and the body's keys share one object.
That makes `t` and `traceparent` reserved — no body may declare them — which is
asserted over the frame tables rather than left as a rule to remember.

A connection that is ended rather than answered carries a **close code**, so the
client can tell the cases apart without parsing anything: `4001` the token was
refused, `4002` no `hello` arrived, `4003` too old (preceded by the frame),
`4004` the server is going away.

```json
{ "t": "op", "op_id": "op_01M2451Q8CE4T7Z1J0B9WQ2MZX",
  "kind": "send",
  "c": "cht_01M244GW79BBXYFPJS6J7AYNQ0",
  "m": { "id": "msg_01M2451Q8C3JX7B0KQ9VYW1PDR",
         "parent_id": null,
         "body": "shipped it" } }
```

```json
{ "t": "op", "op_id": "op_01M2451ZK9…", "kind": "delete",
  "c": "cht_01M244GW79BBXYFPJS6J7AYNQ0",
  "target": "msg_01M2451Q8C3JX7B0KQ9VYW1PDR" }
```

```json
{ "t": "catchup",  "stream": { "kind": "chat", "id": "cht_01M244…" },
                   "from_rev": 8134, "limit": 500 }
{ "t": "backfill", "c": "cht_01M244…", "before_ord": 5100, "limit": 50 }
{ "t": "repair",   "c": "cht_01M244…", "since_rev": 8134, "max_ord": 5523,
                   "after": { "rev": 8140, "id": "msg_…" } }
{ "t": "thread",   "c": "cht_01M244…", "root": "msg_…", "after_ord": 0, "limit": 50 }
{ "t": "read",     "c": "cht_01M244…", "ord": 5523 }
{ "t": "ping" }
```

`repair` is the other half of taking a gap (§13a) and `thread` the parent-keyed
read threads need (`DESIGN.md` §8.2). Both answer with pages of **message rows**
— the same shape `backfill_ok` and a gap's tail carry: body, `deleted`,
`edited_at`, `reply_count`, `parent_id` (invariant 85).

The directory pages by actor id rather than by `ord`, because actors have no
ordinal — ULIDs sort, so the same keyset shape works:

```json
{ "t": "directory", "after_id": "act_01M2340RRW7Z9HR0DH8CZX9VH4", "limit": 500 }
```

### Server → client

```json
{ "t": "ev",
  "stream": { "kind": "chat", "id": "cht_01M244GW79BBXYFPJS6J7AYNQ0" },
  "rev": 8141,
  "type": "message.created",
  "payload": { "id": "msg_01M2451Q8C3JX7B0KQ9VYW1PDR",
               "ord": 5522, "parent_id": null,
               "author_id": "act_01M2340RRW7Z9HR0DH8CZX9VH4",
               "body": "shipped it",
               "created_at": "2026-09-10T16:04:11.238Z" } }
```

```json
{ "t": "ack",  "op_id": "op_01M2451Q8C…",
  "id": "msg_01M2451Q8C…", "c": "cht_01M244…",
  "ord": 5522, "rev": 8141, "created_at": "2026-09-10T16:04:11.238Z" }

{ "t": "nack", "op_id": "op_01M2451Q8C…",
  "code": "not_a_member", "retryable": false, "message": "…" }
```

```json
{ "t": "counters", "c": "cht_01M244…",
  "chat_unread": 7, "thread_unread": 2, "mention_count": 1 }

{ "t": "directory_ok",
  "rows": [ { "id": "act_01M2340RRW7Z9HR0DH8CZX9VH4", "type": "human",
              "handle": "harsh", "display_name": "Harsh Sharma",
              "avatar_url": "https://…", "state": "active",
              "updated_at": 1789042000000 } ],
  "next_after_id": "act_01M234ZZQ2…",
  "complete": false,
  "head_rev": 4821 }

{ "t": "too_old", "min_protocol": 5, "message": "…" }
{ "t": "pong" }
```

`ack` and `ev` are **both** delivered to the sender. The ack reconciles the
outbox row; the event travels the same apply path as on every other device, so
there is one convergence mechanism rather than a special case for "mine".

**`message.updated`** is the server replacing a message's complete content —
the first writer is an agent run's access card changing state for everyone in
the thread (`WORKSPACE-AGENTS.md` §7.4). A revision and no ordinal, so no unread
badge; the version rule declares it touches the message, so a client that
missed it gets the new content from repair (§13a). It is **not** an edit and
marks nothing edited: `message.edited` stays reserved for a person's own edit.

```json
{ "t": "ev", "stream": { "kind": "chat", "id": "cht_01M244…" }, "rev": 8150,
  "type": "message.updated",
  "payload": { "id": "msg_…", "body": "Alice gave @triage access to Linear." } }
```

**`agent_activity`** is the working indicator for a queued or running agent
run (`WORKSPACE-AGENTS.md` §5.7). Unlike everything else on this page it is
**not** a `sync_event` — it takes no revision, is never staged, replayed or
repaired, and a lost one is cosmetic: the reply arrives through the ordinary
write path regardless. It is a plain delivery-address push, sent to the chat's
current audience the same way `pushToActor` reaches anyone:

```json
{ "t": "agent_activity", "chat_id": "cht_01M244…", "thread_id": "msg_01M2451Q8C…",
  "agent_id": "act_01M2F41RXYZV0QA9Z50MM0GXAV", "run_id": "run_01M2FEZJM4…",
  "seq": 3, "state": "running", "label": "Searching Linear" }
```

`seq` rises per run and `ended` is final — pushes can cross on the wire, so a
client drops anything with a lower `seq` than it already holds for that run,
and drops anything at all once it has seen `ended`. Sent on change, plus a
refresh at most once a minute while nothing changes, so a client that
reconnects mid-run learns the state without every member of the chat being
pushed to on every dispatcher tick.

For a message made of parts the payload carries the new `parts` too, replacing
the old ones whole; without them the message is its body again. The client
applies it **only if the row it holds is not newer** — repair reads current
state, so a newer row can land before an older update arrives.

**Parts** (`AGENT-RESPONSES.md` §3). A message made of them — an agent's reply,
a card — carries `parts` on `message.created`, on `message.updated` and on every
message row, and its `body` is the one the **server derived** from them. A
`send` op may carry `m.parts`: the server checks them strictly (known kinds, the
limits, `tool` and `ui` only from an agent, every UI block valid) and answers a
refusal with a non-retryable `nack` of code `parts_refused`. The frame parse
keeps them unchecked, so an unknown kind from a newer client reaches that check
rather than making the whole frame malformed, and a client reads stored parts
leniently: a kind it does not know falls back to `body`.

A message only some people can see reaches the people on it with its list, and
everyone else who reads the chat as a withheld revision (§7.1):

```json
{ "t": "ev", "stream": { "kind": "chat", "id": "cht_01M244…" }, "rev": 8142,
  "type": "message.created",
  "payload": { "id": "msg_…", "ord": 5523, "parent_id": "msg_…", "author_id": "act_triage…",
               "body": "…", "created_at": "…", "visible_to": ["act_alice…"] } }

{ "t": "ev", "stream": { "kind": "chat", "id": "cht_01M244…" }, "rev": 8142,
  "type": "withheld", "payload": {} }
```

Message rows (`backfill_ok`, a gap's tail, `repair_ok`, `thread_ok`) carry
`visible_to` too: null for the whole chat, or the list — and a row is only ever
sent to a reader on it. It is for drawing "only visible to you", never for
deciding. No client op declares an audience; one sent anyway is dropped by the
parse, like any unknown field (invariant 66), and a boundary rule keeps
`writeMessage` out of the socket.

---

## 9. Flow — a client comes online

The sequence a fresh boot, a reconnect, and a first-ever device all share. Steps
1–4 are already built and asserted by `boot.test.ts`.

```
 1  utilityProcess starts, opens account.db, opens the workspace replica
 2  run SQLite migrations
 3  renderer attaches its MessagePort and PAINTS from local rows
        └── no network has been touched yet. R3 is this ordering.
 4  session.activate() → access token   (may fail; local reads continue)
 5  transport.connect() → guardConnect(gate, url) → new WebSocket
 6  send `hello` with every stream cursor the replica holds
 7  receive `welcome`; persist heads, topology, counters
 8  live `ev` frames may already be arriving — they are applied by the
      ordinary rule in §11 (receiving an event, and the frontier), so no
      buffering special case is needed
 9  for each stream where synced_through_rev < server_head_rev: `catchup`
10  drain the outbox
```

### Why there is no subscribe/read race

The AppSync proposal needs "subscribe before catch-up" to bridge the window
between reading a head and starting to listen. We have no such window, and not
because we are clever: the socket is already connected when `hello` is sent, and
**every event goes through the same compare-to-frontier path**, so an event that
arrives before, during, or after `welcome` is applied or staged by one rule. An
event arriving twice — once live, once in catch-up — is a duplicate below the
frontier and is dropped.

### `hello` → `welcome`, worked

A fresh device has no cursors at all:

```json
{ "t": "hello", "protocol": 4,
  "access_token": "eyJ…",
  "workspace_id": "wsp_01M234E35Y8WYEKFQSA03JD3BY",
  "device_id":    "dev_01M2340RRWNR2WMH1BXSTM3W3Z",
  "cursors": [] }
```

The server verifies the token (`verifyAccessToken`, built), resolves
`SessionClaims { actorId, workspaceId, orgId, deviceId, sessionId }`, confirms
the session and actor are active, registers the connection, and answers:

```json
{ "t": "welcome",
  "protocol": 4,
  "now": 1789042451238,

  "actor": {
    "id": "act_01M2340RRW7Z9HR0DH8CZX9VH4",
    "handle": "harsh",
    "display_name": "Harsh Sharma"
  },

  "spaces": [
    { "id": "spc_01M244GW79Y0PXWXJ7B4Q1TR5K",
      "kind": "channel", "name": "engineering", "slug": "engineering",
      "visibility": "public", "membership_policy": "open",
      "lifecycle": "active", "rev": 31 }
  ],

  "chats": [
    { "id": "cht_01M244GW79BBXYFPJS6J7AYNQ0",
      "space_id": "spc_01M244GW79Y0PXWXJ7B4Q1TR5K",
      "kind": "sole",
      "head_ord": 5521, "head_rev": 8140,
      "chat_unread": 6, "thread_unread": 2, "mention_count": 1 }
  ],

  "memberships": [
    { "scope_type": "space", "scope_id": "spc_01M244GW79Y0PXWXJ7B4Q1TR5K",
      "role": "admin" }
  ],

  "streams": [
    { "kind": "workspace", "id": "wsp_01M234E35Y8WYEKFQSA03JD3BY", "rev": 4821 }
  ]
}
```

There are **no subscription descriptors**, because there is nothing to subscribe
to. That is the whole subscription-descriptor apparatus of the AppSync
proposal — its §5.1 (subscription registry) and §8.2 (the connect flow) —
absent.

### What `welcome` deliberately does not carry

Three omissions, and each is what keeps the frame bounded by the actor rather
than by the company (invariant 71).

**Spaces the actor has not joined.** Public means discoverable, not synced. A
workspace with 300 public channels and rooms where the actor belongs to 40 sends
40. Browsing the rest is a directory query, fetched on open.

**Other people's memberships.** The rows here are the caller's own — they are
the grants `can()` evaluates for their own affordances. "Who else is in this
space" is a view concern, answered per space when a surface asks. Sending every
membership in the workspace would be 1,600 × 300 in the worst case.

**The actor directory.** It is a `workspace` stream instead (§9.1, the
directory hydrated separately), which is why
`streams` carries a cursor for it rather than `actors` carrying 1,600 rows.
Measured, that array was 345 KB — 69% of the frame, and the only term that grows
because the company hired someone rather than because this actor joined
something.

The client writes: `spaces`, `chats` and its own `memberships`; per chat
`chat_state.server_head_rev = head_rev`, `head_ord`, and the three counters —
leaving `synced_through_rev` where it was. **Every badge in the sidebar is now
correct and not one message body has been fetched.** That is R2.

Built today: `welcome(db, workspaceId, actorId)` in `feed.ts` returns the `chats`
array in one query. The `spaces` and `memberships` projections are new but are
the same shape `syncMemberships` already replicates over HTTP — a change of
transport rather than of shape.

### 9.1 The directory, hydrated separately

The directory is replicated state that changes rarely, which makes re-sending it
on every reconnect the worst possible shape: maximum bytes, minimum information.
So it is a stream, and uses the machinery every other stream already uses.

```
steady state    someone joins, renames themselves, or is deactivated
                → one workspace-stream event → one row on every client

reconnect       cursor 4,819 vs head 4,821 → catchup returns 2 rows

fresh device    cursor 0, far behind → gap → paged snapshot:
                  { "t":"directory", "after_id": null, "limit": 500 }
                  { "t":"directory", "after_id": "act_01M234…", "limit": 500 }
                  keyset on actor id; ULIDs sort, so no OFFSET
```

Measured on a 1,600-member workspace:

| | frame | gzipped |
|---|---|---|
| `welcome` with the directory inline | 503 KB | 45 KB |
| `welcome` without it | **158 KB** | **16 KB** |
| the directory, four pages of 500 | 345 KB total | ~35 KB total |

The pages arrive **after** first paint and do not block it.

**The product consequence, named rather than discovered.** On a *fresh* device,
between first paint and the last directory page, a message author may render as
a monogram with no name. That is the same fallback avatars already use, and it
is the price of not blocking the first frame on a collection sized by the
company. On every subsequent launch the directory is already on disk and only
the delta arrives.

### 9.2 Compress `welcome`, and what that does not contradict

The frame is JSON with one repeated key set and a shared id prefix on every row.
It gzips roughly 10×: 158 KB → 16 KB.

This does **not** reopen the decision to leave `permessage-deflate` off. That
rule exists because *persistent* compression holds a zlib context per connection
— ~189 KB, seventeen times the connection itself — for the life of the socket.
A one-shot compression of a single frame allocates, compresses and frees.
Different mechanism, opposite conclusion: compress `welcome`, leave the
steady-state stream alone.

### Then, per stream

```
chat      cht_01M244…  synced 8134  head 8140  →  6 behind    → catchup
space     spc_01M244…  synced 31    head 31    →  level       → nothing
workspace wsp_01M234…  synced 4819  head 4821  →  2 behind    → catchup (2 actor rows)
workspace wsp_01M234…  synced 0     head 4821  →  fresh device → gap → paged directory

There is no actor row. Read state and counters arrive as pushes with no
revision, so there is no cursor to compare (§15).
```

---

## 10. Flow — Alice sends a message

### 10.1 Local, before any network

```
renderer: composer submit
      │  a command, not a query — useQuery is read-only
      ▼
utilityProcess
      ├─ id = ulid('msg')
      ├─ SQLITE TRANSACTION
      │     INSERT messages (id, chat_id, ord=NULL, rev=NULL,
      │                      author_id, body, created_at=<client clock>,
      │                      state='pending')
      │     INSERT outbox   (op_id=ulid('op'), seq=<next>, kind='send',
      │                      chat_id, target_id=id, payload=<json>,
      │                      created_at, state='queued')
      │   COMMIT
      └─ invalidate(['chat:<id>:messages'])
              │
              ▼  registry matches mounted reads, refetches, ~1 ms
        message on screen, still offline
```

Both rows in **one** transaction (invariant 40). A crash between them would
otherwise leave a message that looks sent with nothing to send it.

`ord` is NULL and several may be pending at once — which is why the replica's
`msg_ord` unique index is partial where the server's is not.

### 10.2 On the wire, when the drainer runs

```
outbox drainer: SELECT … FROM outbox WHERE state='queued' AND next_at <= now
                ORDER BY seq            ← in order per chat, one in flight
      │
      ▼  socket
{ "t":"op", "op_id":"op_01M2451Q8C…", "kind":"send", "c":"cht_…", "m":{…} }
```

### 10.3 Server, through the functions that exist

```
handleOp(conn, frame)
  │
  ├─ send(db, { opId, chatId, actorId: conn.actorId, messageId, body })   ops.ts
  │     │
  │     ├─ chatGate(db, actorId, chatId)          ← ONE snapshot of grants
  │     │     loadGrants(db, actorId)               + chatPlacement(db, chatId)
  │     │     authorize('post') → can(grants, 'post', chat(id), placement)
  │     │
  │     └─ applyOnce(db, claim, work)             allocate.ts
  │           BEGIN
  │             SELECT ops WHERE op_id = ?        ← replay → return stored ack
  │             ── work(trx) ──
  │             allocate(trx, chatId, withOrd=true)
  │                 UPDATE chats SET next_ord = next_ord+1,
  │                                  next_rev = next_rev+1
  │                       WHERE id = ? RETURNING       ← row lock, per chat
  │                 → { ord: 5522, rev: 8141 }
  │             INSERT messages …
  │             INSERT sync_events (stream_kind='chat', stream_id=chatId,
  │                                 stream_rev=8141,
  │                                 event_type='message.created',
  │                                 payload={ id, ord, parent_id, author_id,
  │                                           body, created_at })     ← NEW
  │             UPDATE spaces SET last_activity_at = now()
  │             INSERT ops (op_id, actor_id, chat_id, kind, result=<ack>)
  │           COMMIT
  │
  ├─ conn.send({ t:'ack', … })                    ← to the sender only
  └─ fanout(db, event)             ← §7 (how the socket decides what to send)
```

Everything but the `sync_events` insert is built and tested, including the
concurrency proofs: two allocators cannot interleave a rev, and a replayed
`op_id` returns the first `ord` rather than allocating a second.

### 10.4 What each recipient does

```
Alice's laptop   ack → UPDATE messages SET ord=5522, rev=8141,
                        created_at=<server>, state='acked'
                        DELETE FROM outbox WHERE op_id=?      (one transaction)
                 ev  → applyEvent: rev 8141 == frontier+1 → idempotent upsert,
                        frontier 8141
Alice's desktop  ev  → applyEvent, same path
Bob, Carol       ev  → applyEvent, same path
Dave (offline)   nothing. He learns it from catch-up when he returns.
```

---

## 11. Flow — receiving an event, and the frontier

This is the rule everything else leans on. One code path serves live delivery
and catch-up, because they carry the same envelope.

```
applyEvent(streamKind, streamId, rev, type, payload):

  frontier = chat_state.synced_through_rev        (or the stream's equivalent)

  ┌─ rev <= frontier ──────────────────────────────────────────────────┐
  │  DUPLICATE. Expected under at-least-once delivery and under the    │
  │  live/catch-up overlap. Drop it. No write, no cursor movement.     │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ rev == frontier + 1 ──────────────────────────────────────────────┐
  │  SQLITE TRANSACTION                                                │
  │     apply the domain effect (may legitimately be a no-op)          │
  │     synced_through_rev = rev                                       │
  │     drain staged_events while the next rev is present              │
  │  COMMIT                                                            │
  │  invalidate the affected topics                                    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ rev > frontier + 1 ───────────────────────────────────────────────┐
  │  A HOLE. Store the WHOLE ENVELOPE in staged_events.                │
  │  server_head_rev = max(server_head_rev, rev)                       │
  │  schedule ONE coalesced catchup for this stream                    │
  │  the frontier does NOT move                                        │
  └────────────────────────────────────────────────────────────────────┘
```

The event and the cursor advance are one transaction. A handler that fails
halfway must roll back both — advancing past an event whose effect did not land
is a silent permanent hole.

### 11.1 Why the envelope, not just the rev

Today the replica has `pending_revs(chat_id, rev)` — "I saw rev N". That is not
enough, and the failure is subtle enough to be worth tracing.

```
frontier 5.  Message M was created at rev 7, which this client does not have.

  live: rev 9 = message.edited(M)
        M is absent → domain apply is a no-op
        pending_revs = {9};  frontier stays 5

  catchup(from_rev=5) returns 6, 7, 8, 9

        apply 6 → frontier 6
        apply 7 → M created → frontier 7
        apply 8 → frontier 8, then pending_revs has 9 → frontier 9
        apply 9 → rev 9 <= frontier 9 → DROPPED AS A DUPLICATE
                                        ↑
                          the edit is lost, permanently, with no symptom
```

Each rule is correct alone. Duplicate suppression is mandatory under
at-least-once delivery; recording the rev is what keeps the frontier moving past
events with no local effect. Together they lose data.

The fix replaces the table:

```sql
CREATE TABLE staged_events (
  stream_kind TEXT    NOT NULL,
  stream_id   TEXT    NOT NULL,
  rev         INTEGER NOT NULL,
  event_type  TEXT    NOT NULL,
  payload     TEXT    NOT NULL,       -- the envelope, retained
  PRIMARY KEY (stream_kind, stream_id, rev)
);
```

Same trace, fixed:

```
  live: rev 9 → staged_events holds {rev 9, 'message.edited', {…}}. NOT applied.
  catchup returns 6, 7, 8
        apply 6 → frontier 6
        apply 7 → M created → frontier 7
        apply 8 → frontier 8
                  drain: staged has 9 → apply the EDIT → frontier 9
                  DELETE FROM staged_events WHERE rev <= 9
```

Like `pending_revs`, it holds only what is above the frontier, so it collapses to
empty whenever the client is caught up.

### 11.2 Events that touch no local row

A valid event that changes nothing locally still accounts for its rev. Three
cases, all normal:

| Event | Row absent because | Action |
|---|---|---|
| `message.deleted` | never backfilled, or evicted | account for the rev; no write |
| `message.edited` | below `oldest_local_ord` | account for the rev; backfill later returns the current body |
| `withheld` | the event is about a message this reader may not see (§7.1) | account for the rev; **known**, so not counted; no write |
| `message.updated` | never held, a tombstone, or the held row is already newer (§8) | account for the rev; no write — a later fetch returns the current content |
| unknown `event_type` | client predates the feature | account for the rev; count it; do not stall |

That last row is invariant 32, and it is why the frontier is tracked explicitly
rather than derived from `MAX(rev)` over message rows.

---

## 12. Flow — catch-up

Catch-up answers one question: **what durable changes did I miss after my
contiguous cursor?**

```
{ "t": "catchup",
  "stream": { "kind": "chat", "id": "cht_01M244…" },
  "from_rev": 8134, "limit": 500 }
```

```
handleCatchup(conn, frame)
  │
  ├─ requireCan(conn.actorId, 'read', <the stream's object>)
  │     never inferred from the cursor — a modified client can send any id
  │
  └─ catchup(db, conn.actorId, stream, fromRev)                  feed.ts
        head(db, chatId) → { headOrd, headRev }
        headRev - fromRev > GAP_THRESHOLD (500)  ? gap : replay
        replay: every log row, REDACTED for this reader — a row they may not
                see comes back as { rev, type:'withheld', payload:{} }, never
                skipped, or their frontier would stop at it (§7.1)
```

```json
{ "t": "catchup_ok",
  "stream": { "kind": "chat", "id": "cht_01M244…" },
  "from_rev": 8134, "to_rev": 8140, "complete": true,
  "events": [
    { "rev": 8135, "type": "message.created",
      "payload": { "id": "msg_…", "ord": 5518, "author_id": "act_…",
                   "body": "…", "created_at": "…" } },
    { "rev": 8136, "type": "message.deleted", "payload": { "id": "msg_…" } },
    { "rev": 8137, "type": "message.created", "payload": { … } }
  ] }
```

The events are the same envelope as live `ev` frames, so the client feeds them
straight into the frontier rule of §11 (receiving an event). `to_rev` is what
the frontier becomes once the batch has
applied contiguously.

### 12.1 Why `sync_events` and not the message rows

This is the part that reads as a small change and is not. Today, `eventsSince`
derives events by querying `messages WHERE rev > ?`. Take a chat whose history
is:

```
rev 1  m1 created (ord 1)
rev 2  m2 created (ord 2)
rev 3  m1 edited
rev 4  m3 created (ord 3)
rev 5  m1 deleted
```

The **rows** now say:

```
m1   ord 1   rev 5   deleted=true    body=''
m2   ord 2   rev 2   deleted=false   body='…'
m3   ord 3   rev 4   deleted=false   body='…'
```

`SELECT … WHERE rev > 0` returns three rows, so a client catching up from zero
learns three events: revs 2, 4 and 5. **Revisions 1 and 3 do not exist anywhere.**
The creation of m1 is gone, overwritten by its edit; the edit is gone,
overwritten by its delete. The client learns of m1 only as a deletion of a
message it never saw created.

A row records **what is true now**. It cannot record **what happened**, because
each mutation overwrites the last one's evidence.

With `sync_events` the same history is five rows that are never overwritten:

```
rev 1  message.created  { id: m1, ord: 1, body: 'hello' }
rev 2  message.created  { id: m2, ord: 2, body: 'hi' }
rev 3  message.edited   { id: m1, body: 'hello there' }
rev 4  message.created  { id: m3, ord: 3, body: 'yo' }
rev 5  message.deleted  { id: m1 }
```

and catch-up is a range scan that cannot lose an intermediate step.

Phase 2 gets away with the row-derived version because it has only `send` and
`delete`, and a deleted row still carries its delete's rev. **The moment edits
land, the derivation is unsound** — and the same limit already applies to
anything that is not a message at all: a space rename, a chat added to a room, a
member added, an actor deactivated. None of them live in `messages`, so none of
them has any catch-up path today.

### 12.2 Applying a batch

Apply in bounded transactions — roughly 200 events — yielding between batches.
WAL lets readers proceed during the writes; chunking is what stops a large
catch-up starving the queries a visible surface is making.

---

## 13. Flow — the gap

When a client is further behind than replay is worth:

```json
{ "t": "gap",
  "stream": { "kind": "chat", "id": "cht_01M244…" },
  "head_rev": 91204, "head_ord": 40112,
  "recent": [
    { "id": "msg_…", "ord": 40063, "rev": 91150, "author_id": "act_…",
      "body": "…", "created_at": "…" }
  ] }
```

The tail is **materialised rows, not events** — the current state of the newest
~50 messages **this reader may see**, oldest-first so it renders in order. The
visibility clause is in the query, before its limit, like every path below.

```
client:
  since   = synced_through_rev          ← read BEFORE the jump: what repair covers (§13a)
  max_ord = MAX(ord) over messages held
  INSERT the tail (complete rows, tombstoned roots included, subject to the version guard)
  synced_through_rev = head_rev      ← jumps the gap deliberately
  server_head_rev    = head_rev
  head_ord           = head_ord
  has_gap            = 1
  oldest_local_ord   = <lowest ord in the tail>, or NULL for an empty tail
  repair owed        = since MIN(since, pending), up to MAX(max_ord, pending), paging restarted
  DELETE FROM staged_events WHERE stream = this one
```

This is what bounds a reconnect to **O(streams)** rather than O(messages): a user
away for a week across 150 chats gets one small frame each, not 100,000 messages.

Jumping the frontier past revisions never seen is safe precisely because the tail
is current state. Anything below it is not missing-and-unknown, it is
missing-and-marked — `has_gap` plus `oldest_local_ord` say exactly where the
floor is, and backfill repairs it on demand.

**The floor is the tail's, never `MIN` with the old one** (invariant 86). It used
to be, on the reasoning that a shorter later tail must not hide history already
held — and the sync model (`spikes/visibility-tests.mjs`) showed what that cost.
The floor promises that everything above it is held, and a gap has just jumped
over history this client never saw: a client that had once scrolled to the top
kept a floor of 1, was never asked to backfill again, and the messages every
later gap jumped over never arrived; a client with an unbackfilled gap kept the
old floor, backfilled below it, and `has_gap` cleared over the hole. 62 of 100
random worlds lost history. The rows held from before are not thrown away —
backfill below the new floor re-sends them harmlessly on its way down.

While `has_gap` is set the client **always asks** for backfill: from the floor,
a floor of 1 included, or from `head_ord + 1` when the tail held nothing this
reader may see. Only a page marked `complete` can clear the flag, and an empty
page marked complete is exactly the answer that does.

### 13a. Flow — repair, the other half of a gap

A gap replaces the log with a partial snapshot, and the snapshot is the newest
messages. A message the client **already held** that the snapshot does not
re-send is never corrected by anything above: a delete during the gap left the
message on that device for good, and edits, reactions and reply counts would
have gone the same way. The sync model found the delete in its first run
(`WORKSPACE-AGENTS-IMPL.md` §4.1.1); the fix is the class, not the case.

Three rules, and a fourth that the model insisted on:

**The version rule** (invariant 84). A message's `rev` is its version: the
revision of the last event that changed how it renders. The event catalogue
(`events.ts`) declares per type which messages an event touches — a reply
touches its parent, whose reply count changed; a delete touches the message and
its parent — and `appendEvent` bumps them in the transaction that appends the
log row. A type with no declaration does not compile.

**Complete rows** (invariant 85). The tail, backfill, the thread page and repair
all return one shape: body as it stands, `deleted`, `edited_at`, `reply_count`.
The tail and backfill include tombstoned roots — a deleted root still has a
thread, reachable only through it. The thread page returns undeleted replies
only: a reply has no thread of its own, a held one deleted meanwhile is corrected
by repair, and no tombstone is owed for a row never held.

**Repair, at reconnect.** After a gap the client owes, and persists in
`chat_state`, *changes since the frontier the gap jumped from, to any message it
held before the tail landed*:

```
{ "t": "repair", "c": …, "since_rev": <old frontier>, "max_ord": <highest held>, "after": null }

server:
  SELECT <complete row> FROM messages m
   WHERE m.chat_id = $c AND m.rev > $since_rev AND m.ord <= $max_ord
     AND (m.rev, m.id) > ($after.rev, $after.id)
   ORDER BY m.rev, m.id LIMIT $limit               ← keyset, on msg_rev (chat_id, rev)

client, per page:
  UPDATE only rows already held — history never held is backfill's
  complete AND nothing rejected → owed = NULL
  else                          → after = the page's last (rev, id); ask again
```

Cost is proportional to what changed, never to history or to events. A quit
mid-repair resumes from the persisted cursor at the next `welcome`; a second gap
while one is pending **widens** it — `since` the older, `max_ord` the larger,
paging restarted — rather than replacing it.

**The version guard, and why "complete" is not "done"** (invariant 87). A
fetched row applies only if its `rev` is not older than the row held. A
rejection is not a row to forget: it means a live event touched that message
*after the page was computed*, and a live event is a delta applied over a local
row that was still stale — the local row is now wrong in a way nothing else will
fix. Paging by `(rev, id)` is the remedy: the live event bumped the server's row
past the page's cursor, so paging on serves it again, complete, at its new
version. A repair is therefore complete only on a page that applied with nothing
rejected. Without this, a reaction landing mid-repair lost the reaction before
it, permanently — the model's finding, not a hypothetical.

A `message.deleted` event carries `parent_id` for the same family of reasons: a
client can hold a parent without the reply, having learned the count from a
fetched row, and the count has to move anyway.

---

## 14. Flow — backfill

Catch-up replays what changed. Backfill hydrates what the partial replica chose
not to hold. They are different questions and use different keys.

```
{ "t": "backfill", "c": "cht_01M244…", "before_ord": 40063, "limit": 50 }
```

```
backfill(db, reader, chatId, beforeOrd, limit)                  feed.ts, built
  requireCan(read, chat)
  SELECT … FROM messages m
   WHERE chat_id = ? AND parent_id IS NULL AND ord < ?
     AND (m.visible_to IS NULL OR $reader = ANY(m.visible_to))   ← BEFORE the limit
   ORDER BY ord DESC LIMIT ?          ← keyset, never OFFSET
complete = rows.length < limit
```

**The visibility clause has to be in the query** (invariant 79). The socket
derives `complete` from a short page, so a page filtered afterwards — 49 of 50
because one row was hidden — would read as the beginning of history, the client
would clear `has_gap`, and everything below would never be fetched. In the query,
a hidden row simply is not counted against the limit.

The same fact settles a chat whose **ordinal 1 is hidden** from a reader: their
floor can never reach 1, so only `complete` clears the gap — and it may, because
a short page is short only when history ran out.

```json
{ "t": "backfill_ok", "c": "cht_01M244…",
  "rows": [ { "id":"msg_…", "ord":40062, "rev":91149, "author_id":"act_…",
              "body":"…", "parent_id":null, "deleted":false, "edited_at":null,
              "reply_count":2 } ],
  "complete": false }

{ "t": "repair_ok", "c": "cht_01M244…", "rows": [ … ], "complete": true,
  "after": { "rev": 91149, "id": "msg_…" } }
{ "t": "thread_ok", "c": "cht_01M244…", "root": "msg_…", "rows": [ … ], "complete": true }
```

A backfilled row must be **complete current state** — body as it stands now,
tombstone status, edited, reply count (invariant 85). That is what makes §11.2's
(events that touch no local row)
"account for the rev, skip the effect" correct: an edit for a message below the
window is safely ignored, because when the row eventually arrives it already
carries the edited body. **Tombstoned roots are included** — the code used to
filter them out, against this paragraph, and a deleted root's surviving replies
were reachable through nothing.

Client: insert rows subject to the version guard (§13a), lower
`oldest_local_ord`, clear `has_gap` when the server says the page was the last
or the floor reaches 1.

---

## 15. Flow — read state and counters

`markRead` is not part of the log. It takes no rev, appends no event, and needs
no ledger: it is a max-register, so replaying it is already a no-op.

```
{ "t": "read", "c": "cht_01M244…", "ord": 5523 }
      │
      ▼ markRead(db, actorId, chatId, ord)                        ops.ts, built
        authorize('read')
        INSERT chat_read_state … ON CONFLICT DO UPDATE
          SET last_read_ord = GREATEST(existing, EXCLUDED)        ← never LWW
```

Then two things fan out:

```
to her devices  read_state.changed { chat_id, last_read_ord }
                → addressed to actor:alice, which is a delivery address and
                  NOT a stream: no rev, no log row, no cursor. A push that is
                  missed is repaired by the next `welcome`, because a max
                  register cannot be applied wrongly by being applied late.

counters        { t:'counters', c, chat_unread, thread_unread, mention_count }
                → recomputed and pushed to the actors whose counts moved
```

Counters are computed on read today — `counters(db, chatId, actorId)` in
`feed.ts` — which measured at 0.15 ms over 400 unread and 7.7 ms over 50,000.
They are a projection, not a stream: replaced idempotently, never merged.

A message the reader may not see is **not counted**, in `counters` and in
`welcome` alike (the same clause in both). As the newest message it would be
worse than a wrong number: reading the chat marks read up to the highest ordinal
the reader holds, which is below it, and the badge would never clear. Reply
counts on message rows are narrowed the same way.

---

## 16. Flow — membership changes

### 16.1 Bob is removed from a space

```
removeFromSpace(db, spaceId, actorId, by)                      spaces.ts, built
  by !== actorId → requireSpace(by, 'remove_member')   ← admin only
  UPDATE memberships SET left_at = now() WHERE … AND left_at IS NULL
  + allocate(space:S, withOrd=false) → rev
  + INSERT sync_events  space.member_removed { actor_id }        ← NEW
```

What happens next, in order:

```
the very next event in that space
      audienceFor() runs spaceMembers() → Bob is not in the result
      → nothing is written to Bob's socket. Ever again, for that space.

Bob's socket                stays open. He is still in the workspace.
Bob's other spaces          unaffected.
Bob's server access         op / catchup / backfill / welcome all deny
                            through can(), which reads memberships live.
Bob's private chats
  inside that space         denied too — space membership is the LEADING
                            conjunct, so a stale chat row grants nothing.
Bob's local copy            frozen, readable. Removal stops new data; it is
                            not a retroactive recall (DESIGN §6.6).
Remaining members           receive space.member_removed and update their
                            member list. No resubscription, no descriptors.
```

There is no revocation step, because there was never a grant held by the
transport. The audience is a query, and the query now returns a different set.

### 16.2 Bob adds Alice — the atomic write and its marker

`SPACE-MEMBERSHIP-MARKERS.md`, built. The outcome is a durable chat message,
not only a membership row: "Alice was added by Bob," rendered with the shadcn
`Marker`, in the space's structural chat.

```
addToSpace(db, spaceId, alice, bob, messageId)         spaces.ts, built
  requireSpace(bob, 'add_member')       ← any member may
  requireAddableSpace(spaceId)          ← refuses a SEALED space (DM/group DM)
  requireAddableActor(spaceId, alice)   ← active actor, active workspace membership

  ONE transaction:
    addMember(spaceId, alice, 'member', bob)
      SELECT … FOR UPDATE                          ← locks the row against a race
      already active? → return { status: 'already_member' }, nothing else runs
      INSERT/UPDATE memberships … left_at = NULL    ← REUSED if tombstoned
      + allocate(space:S, withOrd=false) → rev
      + INSERT sync_events  space.member_added
          { actor_id: alice, role, by_actor_id: bob, hydration }   ← NEW fields
    writeMessage(kind: 'system', chatId, messageId, authorId: bob,
                 systemKind: 'space.member_added', subjectActorId: alice)
      + allocate(chat:C, withOrd=true) → ord, rev
      + INSERT messages   message_kind='system', subject_actor_id=alice
      + INSERT sync_events  message.created { …, message_kind: 'system', … }
```

**All three writes or none.** A marker without membership is false; membership
without a marker violates the product promise; a message row without its event
never reaches a replica. There is deliberately no ordering between the two
delivered events beyond "membership before marker" at the delivery step below
— the membership row is already committed by the time either event reaches
fanout, so a client applying the marker first still resolves Alice as a member.

**Idempotent.** A second `addToSpace` for an already-active Alice returns
`already_member` before allocating a revision or writing anything — no
duplicate event, no duplicate marker, no `joined_at` change. Re-adding a
*tombstoned* Alice is the built §16.2 case below: a real add, one new marker.

**`hydration`, and why it needs no per-recipient shaping.** `space.member_added`
now carries the space's current shape — the row and its chats — computed once,
inside the transaction. Fanout (`fanout.ts`) delivers ONE payload to every
reader of the stream; there is no per-recipient redaction below the
audience/withheld split it already does. So `hydration` rides on every
delivery, and the CLIENT decides whether to apply it: only the replica whose
own actor id equals the event's `actor_id` writes the space/chat/membership
rows from it (`effects.ts`, built) — everyone else uses the event purely as
topology invalidation, exactly as before. This is what lets Alice see the
space appear without a reconnect, closing the gap §9 otherwise leaves open
until the next `welcome`.

### 16.2a Bob re-adds a former member

```
addToSpace(db, spaceId, bob, by, messageId)     ← membership row REUSED, left_at = NULL
```

The target is first checked as an active actor with an active workspace
membership in this space's workspace. Re-addition writes the requested role as
well as clearing `left_at`; the ordinary add flow requests `member`, so a
tombstoned former admin cannot regain administration without the separate
space-admin-only promotion check. One new marker is written — a re-add is a
real event, distinct from the idempotent no-op above.

His cursor for those chats is far behind `server_head_rev`. That is a gap, and
the ordinary gap path heals it. **Re-adding needs no special case at all** — this
is the property the tombstoned membership row exists to give.

### 16.3 Actor deactivated, or the workspace revoked

Sessions revoked, refresh denied, connections dropped by the next heartbeat. The
actor is tombstoned rather than deleted, and that tombstone replicates as an
ordinary `actor.updated` event, so their past messages still render — offline
included.

---

## 17. Flow — offline, and the outbox

```
offline
   compose      → pending row + outbox row, one transaction
   delete it    → coalescing: send + delete for the same target → BOTH DROPPED
                  zero network operations, not two that fail
   compose more → queued in seq order

online
   drainer: ORDER BY seq, one in flight per chat, cross-chat parallel
      op → ack  → stamp the row, delete the outbox entry, one transaction
      op → nack retryable:true  → backoff with jitter via next_at
      op → nack retryable:false → state='failed', surfaced in the UI with
                                  retry and discard; retrying forever is worse
```

Coalescing runs **on enqueue**, scoped by `target_id`, because `delete` targets a
message the server has never heard of. This is a correctness requirement, not an
optimisation, and it is why the outbox has an index on `target_id`.

---

## 18. Flow — reconnect after a drop

Identical to §9 (a client comes online). There is no separate resume protocol:

```
socket closes (network change, sleep/wake, server restart)
   → backoff with FULL JITTER, capped ~30 s
   → reconnect on powerMonitor 'resume' rather than waiting for TCP
   → hello with current cursors
   → welcome
   → per-stream catchup or gap
   → drain outbox
```

Jitter is load-bearing rather than polite. Ten thousand clients reconnecting
together is a `welcome` burst plus a catch-up burst landing in one instant;
spread over 30 s it is unremarkable. This is also why a server restart needs
connection draining, and it is the operational cost we accept by running the
socket ourselves.

---

## 19. What running our own transport costs

The decision is made — our own transport, one node — so this is no longer one
side of a comparison. It is the bill, itemised, because a design document that
only lists its own advantages is not useful. Two of the three are closed by
work in §2 (the build plan); the third is accepted.

**A live event can be lost between commit and socket write.** We fan out
in-process: if the server dies after `COMMIT` and before writing frames,
connected clients never see that event.

It mostly self-repairs — the next event in that stream arrives above the
frontier, which triggers catch-up. Only the **last event before a silence** is
exposed, and the heartbeat closes that by carrying stream heads so a client
notices it is behind within one interval.

Closed by step 5 (the socket, both halves), which puts stream heads in the
heartbeat, and measured rather than asserted by step 12 (retention, and the
residue we accept) — kill the server between commit and write, and confirm the
next heartbeat notices.

That residue is exactly what `published_at` plus a publisher worker exists to
close. If we run more than one server node, the shape is Postgres `LISTEN/NOTIFY`
on commit — which fires only if the transaction commits — with a sweep over
unpublished events as the safety net. **That is the point at which the AppSync
proposal's extra columns begin to earn their place. Not before**, and step 12
writes that down without building it.

**A server restart disconnects everyone.** A managed subscription tier would
survive our deploys entirely. We pay for that with jitter, draining, and the
catch-up burst — all of which step 5 builds and step 14 (the milestone)
demonstrates by hand.

**We operate a fanout tier.** It is measured as cheap — 8.7 KB RSS per idle
connection, ~4,000 connections in ~200 MB, 268k sends/sec — but cheap is not
free, and it is ours to run.

---

## 20. Case table

| Case | What happens |
|---|---|
| Member posts while Alice is online | `ev` at frontier+1 → applied, invalidation, live-query refetch |
| Alice writes offline | pending row + outbox row in one transaction; nothing on the wire |
| Ack lost, client retries | `applyOnce` finds the ledger row, returns the **stored** ack — same `ord` |
| Two devices send the same `op_id` concurrently | One does the work, the other collides on a unique index, retries, and is answered from the ledger |
| Live rev 8138 while frontier is 8136 | Envelope staged, hole recorded, one coalesced catch-up |
| Edit for a message below the window | Rev accounted for, effect skipped; backfill later returns the current body |
| Delete for a message never held | Rev accounted for, no write. The case that forces explicit frontier tracking |
| Unknown `event_type` | Rev accounted for, counted, skipped. The frontier must not stall on an old client |
| An agent's access card for Alice resolves | One `message.updated` on the chat stream: a revision, no ordinal, no badge. Every client redraws the card; one that was past the gap threshold gets it from repair; one older than the event advances its cursor and shows the old state until the row is fetched |
| A message only Alice may see (dormant), Bob in the chat | Alice gets `message.created` with `visible_to`; Bob gets `withheld` at the same rev and his frontier passes it. No badge, no reply count, no tail row, no backfill row, no sidebar bump for Bob |
| Alice listed on a restricted message, then leaves the room | She is not a reader, so she gets nothing about it at all — neither its delete nor a withheld |
| Bob backfills a chat whose ordinal 1 is a message only Alice may see | His pages are filtered before the limit; the last one is short, `complete` clears his gap with the floor at 2 |
| Chat with a gap, user scrolls up | Keyset backfill from `oldest_local_ord`, 50 at a time |
| Bob removed while connected | Next `audienceFor` excludes him; server denies everywhere; local copy freezes |
| Bob re-added | Cursor behind → ordinary gap path. No special case |
| One room, five chats | One socket, five cursors. No channels, no subscription ceiling |
| Space renamed | `space:S` stream, rev, fanned out to space members |
| Alice reads on her phone | `read` → GREATEST; `actor:alice` stream carries it to her laptop |
| Stale device reports an older read | `GREATEST` keeps the higher. The chat does not go unread again |
| Someone joins the workspace | One `workspace` stream event → one directory row on every client. Not a re-send of the directory |
| Fresh device, 1,600-member directory | `welcome` is 158 KB (16 KB gzipped) and paints; the directory arrives in four pages afterwards |
| Author renders before the directory lands | Monogram and no name, briefly, on a fresh device only — the same fallback avatars use |
| Actor browses a public space they have not joined | Not in `welcome`, not in the replica. A server query, fetched on open |
| Presence / typing | Never a rev, never in `sync_events`, TTL, dropped when stale |
| Server restarts | Everyone reconnects with jitter; catch-up per stream |
| Postgres unreachable | Writes fail with retryable nacks; every client keeps reading locally |
| Client offline past event retention | Gap plus tail, not an impossible replay |
| One client stops reading its socket | `bufferedAmount` past the threshold → socket closed → reconnect → catch-up. Never buffered without bound |
| Server dies between `COMMIT` and the socket write | The event is durable and undelivered. The next event in that stream lands above the frontier and triggers catch-up; if there is no next event, the heartbeat's stream heads expose it within one interval |
| Two servers, one event | Not built. `LISTEN/NOTIFY` plus an unpublished sweep is the shape, recorded and deferred |

---

## 21. What is built, and what this adds

The ledger §2 (the build plan) is measured against. Every "new" and "change" row
names the step that lands it, so a row with no step is a gap in the plan rather
than an item without an owner.

| | State | Step |
|---|---|---|
| `allocate()`, `applyOnce()` — atomic ord/rev, idempotency ledger | **Built**, with concurrency proofs | 2 |
| `send`, `deleteMessage`, `markRead` | **Built** | 3 |
| `head`, `eventsSince`, `catchup`, `backfill`, `counters`, `welcome` | **Built** (`welcome` is one query) | 3 |
| `can()`, `chatGate`, placement loaders | **Built** | 3 |
| `createChannel`, join, add, leave, remove | **Built** | 3 |
| Replica schema: spaces, chats, memberships, messages, chat_state, pending_revs, outbox | **Built** | 1 |
| Live-query client, topic invalidation | **Built** | Phase 1½ |
| `sync_events` table, `next_rev` on spaces and workspaces | **Built** | 4 |
| `allocateChat` / `allocateStream`, each carrying its stream and workspace | **Built** | 4 |
| Every domain op appending its event in the same transaction | **Built** | 4 |
| `eventsSince` reading events rather than rows | **Built** | 4 |
| Directory events on the workspace stream, from all three actor write sites | **Built** | 4 |
| `packages/protocol` — the wire contract, shared between both processes | **Built** | 5 |
| WebSocket transport, client-initiated heartbeat, permissive parse | **Built** | 5 |
| `hello` → `welcome` handshake, close codes, `too_old` | **Built** | 5 (`welcome` grows at 7) |
| Stream heads on the heartbeat reply | New | 6 |
| Connection registry, `audienceFor`, fanout, slow-consumer drop | **Built** | 6 |
| Domain ops returning their event, so it can leave the transaction | **Built** | 6 |
| The `ev` frame | **Built** | 6 |
| `hello`/`welcome`/`ev`/`ack`/`nack` frames, `too_old` | New | 7 |
| One-shot gzip of the `welcome` frame | New | 7 |
| `pending_revs` → `staged_events` | **Built** — replica v3, fixes the lost-edit bug of §11.1 | 8 |
| Client apply loop, staging, and one `stream_state` for every frontier | **Built** | 8 |
| Catch-up scheduler, gap handling, lazy backfill | **Built** | 9 |
| `catchup` generalised across stream kinds, `catchup`/`backfill` frames | **Built** | 9 |
| `workspace` stream for the directory, paged `directory` fetch | **Built** — replaced `GET /actors` | 10 |
| `sync/link.ts` — the engine's end of the socket, routing frames into the replica | **Built** | 10 (unassigned by the plan) |
| Outbox drainer and coalescing | **Built** | 11 |
| `op` / `ack` / `nack` frames, and the server's write handler | **Built** | 11 |
| Event retention sweep, and the retained-floor guard on catch-up | **Built** | 12 |
| Stream heads on the heartbeat, bounding the commit-to-socket residue | **Built** | 12 |

---

## 22. Open questions

Each carries the step that answers it. A question with no step is not tracked;
it is filed.

1. **Ops over the socket or over HTTPS.** *(answered by step 5, the socket.)*
   `DESIGN.md` §9.5 (writes) says the socket and this document follows it.
   HTTPS would give ordinary middleware and retry semantics at the cost of a
   second authenticated path.
2. ~~**Event retention horizon.**~~ **Answered in step 12: seven days.** Chosen
   against the gap threshold rather than independently — it answers "how long
   may somebody be away and still resume exactly where they were", and beyond
   it nothing is lost because the gap path delivers current state. What remains
   open is only the *number*, which wants real traffic: a short horizon costs a
   gap, a long one costs a table that only grows.
3. **Audience cache invalidation.** *(deferred past step 6, the registry and
   fanout, with a trigger: the membership query showing up in a fanout latency
   profile.)* Whether space → members is memoised in process, and how it is
   invalidated across nodes if there is ever more than one. Do not cache it in
   the connection — a connection that remembers its audience is a subscription.
4. ~~**Actor-stream rev allocation.**~~ **Answered in step 4 (the event log):
   read state is a projection pushed with no revision, and an actor is a
   delivery address rather than a stream.** `markRead` is a max register, so
   replaying it is already a no-op and a missed push is repaired by the next
   `welcome` — a revision would buy nothing and would make the most frequent
   action in the product the busiest stream in the workspace. `actors` therefore
   has no `next_rev`, and `sync_events` does not admit the kind. Asserted:
   `markRead` appends nothing, and an `actor` row is rejected by the CHECK.
5. **Multi-node fanout.** *(Written down in `sync/retention.ts` by step 12, and
   deliberately not built.)* `LISTEN/NOTIFY` on commit — which fires only if the
   transaction commits, and that ordering is the whole reason to prefer it over
   an application bus — plus a sweep over unpublished events as the safety net.
   That second half is what the AppSync proposal's `published_at`,
   `publish_attempts` and `next_publish_at` are for; they earn their place at
   the first second server process holding connections, and not before.
6. **Directory retention on the client.** *(measured by step 10, the directory
   as a stream; decided later.)* A 1,600-actor directory is ~345 KB in
   the replica, and every member holds a full copy. Fine at 1,600, a question at
   20,000 — and a different question from the frame size, because it is storage
   rather than a round trip. Whether deactivated actors are ever evicted locally
   interacts with §11.2 (events that touch no local row): a tombstoned author
   still has to render on old messages.
7. **When the directory is small.** *(step 10 measures the round trip; the
   branch is not built until that number says so.)* A ten-person workspace pays
   a second round
   trip for ten rows. Inlining below a threshold would avoid it and would put a
   conditional into the one frame that most needs to be predictable. Measure the
   round trip before adding the branch.
8. **A slow consumer must be dropped, not buffered.** *(Built in step 6 at
   1 MB — a few thousand frames at measured sizes. The number is a starting
   point, not a finding: it wants a real distribution of `bufferedAmount` under
   load before it means anything.)* If one socket's
   `bufferedAmount` grows past a threshold, close it and let the client reconnect
   and catch up. That is safe *because* durable catch-up exists; a system without
   it would have to buffer without bound or lose the event silently. The
   threshold and the metric are unsettled.
