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
| 9 — catch-up, gap and backfill | G | 14 | ☐ |
| 10 — the directory as a stream | *new* | 14 | ☐ |
| 11 — the outbox | H | 16 | ☐ |
| 12 — retention, and the residue we accept | *new* | 14 | ☐ |
| 13 — the instrumentation pass | *new* | 14 | ☐ |
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

### Step 9 — Catch-up, gap and backfill

`Phase 2 step G · DESIGN.md item 14 · G2`

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
- **`catchup` is still chat-shaped, and this is where that ends.** Its gap
  branch returns a materialised tail of *messages*, which is meaningless for a
  space or the directory. `eventsSince` is already generic; the gap policy is
  not, and each stream kind needs its own answer to "what does a client render
  while it is behind" — the newest messages for a chat, the current row for a
  space, a paged snapshot for the directory (step 10).
- **Retuning the gap threshold is not a one-line change.** It is a separate
  constant from `eventsSince`'s limit, and the two are equal today. Raise the
  threshold alone and a replay is truncated by the limit — which `toRev` now
  reports honestly, but which also means a client needs a second round to
  finish. Move both, and assert the truncated-replay test still passes.

**Done when**

- [ ] A far-behind client receives a gap plus a tail, renders it immediately,
      and backfills on open.
- [ ] A gap sets `has_gap` and `oldest_local_ord` and clears `staged_events`
      for that stream.
- [ ] A 50,000-event catch-up does not starve an open surface — measured as that
      surface's query latency during the catch-up, not as the catch-up's own
      duration.
- [ ] The ~500-rev gap threshold is replaced by a measurement, or re-affirmed
      with the data that supports it. This is the step that can finally do it.

---

### Step 10 — The directory as a stream

`new · DESIGN.md item 14 · G2, G5`

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

- [ ] A fresh device paints before the directory lands, and the author's name
      appears when it does, with no error state in between.
- [ ] A reconnect two revs behind fetches **two rows**, not 1,600.
- [ ] A deactivated actor still renders on their old messages, offline included.
- [ ] **`auth/directory.ts` and `fetchActors` are deleted here**, not earlier —
      moved from step 7, where deleting them would have left the client with no
      directory at all until this step landed. The live-query invalidation that
      currently fires inside `fillActors` moves with them; miss it and the
      workspace directory silently stops refreshing, which is exactly the
      failure the live-query client exists to remove.
- [ ] Directory page count and latency are metrics, so open question 6
      (directory retention on the client) becomes a measurement at 20,000
      members rather than a guess.

---

### Step 11 — The outbox

`Phase 2 step H · DESIGN.md item 16 · G1, G4`

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

- [ ] Compose-then-delete offline produces **zero** network ops, not two that
      fail.
- [ ] Three messages typed offline arrive in the order typed.
- [ ] The ack stamps the message row and deletes the outbox row in **one**
      transaction.
- [ ] A non-retryable nack surfaces in the UI with retry and discard.

---

### Step 12 — Retention, and the residue we accept

`new · DESIGN.md item 14 · G2, G6`

The sweep, the horizon, and an honest statement of what one node does not close.

**Touches** a bounded retention job over `sync_events`, the heartbeat's head
comparison from step 5, and the operational notes in `OBSERVABILITY.md`.

**Done when**

- [ ] A cursor older than the horizon receives a **gap**, not an error and not
      an empty replay that looks like being caught up.
- [ ] The sweep is bounded and holds no long transaction.
- [ ] The horizon is a number with a reason, stated beside the gap threshold it
      interacts with (open question 2, event retention horizon).
- [ ] The commit-to-socket residue is **measured rather than asserted**: kill
      the server between commit and write, and confirm the heartbeat's head
      comparison closes it within one interval.
- [ ] `LISTEN/NOTIFY` plus a sweep is written down as the multi-node shape and
      explicitly **not built** (open question 5, multi-node fanout).

---

### Step 13 — The instrumentation pass

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

- [ ] Every marker is proposed with **the question it answers**, and each is
      agreed before it is added. "A counter of X" is not a justification.
- [ ] Proposing *not* to instrument something is on the table and used at least
      once — a marker nobody reads costs cardinality, ingest and attention.
- [ ] All nine declared events have call sites.
- [ ] No unbounded id is a metric label. 100 actors × 150 chats is 15k series
      against a 10k cap, and it is enforced at compile time.
- [ ] A "user pressed send" span on the client links to the server span that
      assigned the `ord`.

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
  write the `ev` frame
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
{ "t": "read",     "c": "cht_01M244…", "ord": 5523 }
{ "t": "ping" }
```

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
  └─ catchup(db, streamId, fromRev)                              feed.ts
        head(db, chatId) → { headOrd, headRev }
        headRev - fromRev > GAP_THRESHOLD (500)  ? gap : replay
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
~50 messages, oldest-first so it renders in order.

```
client:
  INSERT the tail
  synced_through_rev = head_rev      ← jumps the gap deliberately
  server_head_rev    = head_rev
  head_ord           = head_ord
  has_gap            = 1
  oldest_local_ord   = <lowest ord in the tail>
  DELETE FROM staged_events WHERE stream = this one
```

This is what bounds a reconnect to **O(streams)** rather than O(messages): a user
away for a week across 150 chats gets one small frame each, not 100,000 messages.

Jumping the frontier past revisions never seen is safe precisely because the tail
is current state. Anything below it is not missing-and-unknown, it is
missing-and-marked — `has_gap` plus `oldest_local_ord` say exactly where the
floor is, and backfill repairs it on demand.

---

## 14. Flow — backfill

Catch-up replays what changed. Backfill hydrates what the partial replica chose
not to hold. They are different questions and use different keys.

```
{ "t": "backfill", "c": "cht_01M244…", "before_ord": 40063, "limit": 50 }
```

```
backfill(db, chatId, beforeOrd, limit)                          feed.ts, built
  requireCan(read, chat)
  SELECT … FROM messages
   WHERE chat_id = ? AND deleted = false AND parent_id IS NULL AND ord < ?
   ORDER BY ord DESC LIMIT ?          ← keyset, never OFFSET
```

```json
{ "t": "backfill_ok", "c": "cht_01M244…",
  "rows": [ { "id":"msg_…", "ord":40062, "rev":91149, "author_id":"act_…",
              "body":"…", "created_at":"…" } ],
  "complete": false }
```

A backfilled row must be **complete current state** — body as it stands now,
tombstone status, reactions, attachment metadata. That is what makes §11.2's
(events that touch no local row)
"account for the rev, skip the effect" correct: an edit for a message below the
window is safely ignored, because when the row eventually arrives it already
carries the edited body.

Client: insert rows, lower `oldest_local_ord`, clear `has_gap` when it reaches 1.

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

### 16.2 Bob is re-added

```
addToSpace(db, spaceId, bob, by)     ← membership row REUSED, left_at = NULL
```

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
| Catch-up scheduler, gap handling, lazy backfill | New | 9 |
| `workspace` stream for the directory, paged `directory` fetch | New — replaces `GET /actors` | 10 |
| Outbox drainer and coalescing | New | 11 |
| Event retention sweep | New | 12 |

---

## 22. Open questions

Each carries the step that answers it. A question with no step is not tracked;
it is filed.

1. **Ops over the socket or over HTTPS.** *(answered by step 5, the socket.)*
   `DESIGN.md` §9.5 (writes) says the socket and this document follows it.
   HTTPS would give ordinary middleware and retry semantics at the cost of a
   second authenticated path.
2. **Event retention horizon.** *(answered by step 12, retention.)* How long
   `sync_events` rows live before a stale cursor gets a gap instead. Interacts
   with the ~500-rev gap threshold, which step 9 (catch-up, gap and backfill)
   replaces with a measurement.
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
5. **Multi-node fanout.** *(written down by step 12, not built.)* Not needed at
   one node. `LISTEN/NOTIFY` plus a sweep is the shape when it is.
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
