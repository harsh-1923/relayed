# Phase 2 — The sync core

The risky part, and the reason [`DESIGN.md`](DESIGN.md) §15 puts it before any
UI polish. Everything so far has been scaffolding for it: identity exists so the
socket can authenticate, storage exists so there is somewhere to put a replica,
the router exists so there is somewhere to render one.

Companion to `DESIGN.md` §8 (data model), §9 (sync protocol), §10 (write path)
and §11 (read path), which this document sequences rather than restates.

---

## 1. What this phase delivers

Two clients exchange messages. Kill the server and reading continues. Compose
offline, reconnect, and both converge — without a CRDT, because the server owns
the order (`DESIGN.md` §4).

Stated as the three requirements, since they are what "done" is measured
against:

| | Delivered by |
|---|---|
| **R1** — an actor belongs to N chats | membership rows the server reads when it fans out; the client tracks a cursor per chat |
| **R2** — updates arrive for every chat, open on screen or not | one socket, no subscribe-on-open, and per-chat counters in `welcome` so badges are right before a single body is fetched |
| **R3** — no network, local data fully readable | unchanged and must stay so: `boot.test.ts` removes `fetch` from the process entirely and must still pass at the end of this phase |

### Not in scope

Threads, reactions, edits and search are Phase 4; rooms are Phase 5. `spaces`
gets its table here because a message needs a parent, but only `kind='channel'`
is exercised.

### Delete moves here from Phase 4 — decided

**`delete` is in scope for this phase.** Edits, reactions, threads and search
stay in Phase 4; only the delete moves, and `DESIGN.md` §15 item 24 is now edits
alone.

Without it, `rev` never diverges from `ord` in the real system. Every send bumps
both, so the two-counter model — the least obvious decision in the design and
the one most easily broken by a reasonable change — would ship exercised only by
`spikes/sync-model.mjs`. This document's own build order says the conflation
"does not surface until deletes leave `ord` gaps": it names the detector, and
before this decision it scheduled that detector two phases after the thing it
detects.

A delete is the cheapest mutation that separates the counters — a tombstone, no
editing UI, no reaction picker — and it reaches four things nothing else in this
phase does:

- `rev` advancing without `ord`
- gaps in `ord`, which must be **normal** rather than a repair case
- tombstones kept rather than the row removed
- **a delete for a message the client never held, which writes nothing at all**
  — the exact case that forced `pending_revs` to exist (`DESIGN.md` §8.1). Build
  that table without this and it is never genuinely needed, so it is never
  genuinely tested.

The spike already models it (`del({ opId, msgId })`), so this is porting rather
than new design. The cost is a `deleted` column the client schema already
declares, one op kind, one event type, and one rule in the outbox's coalescing
table.

**What deliberately does not come with it.** No delete affordance in the UI:
this phase has no message list to put one in. The op is exercised through the
sync engine and its tests. Rendering a tombstone — the greyed "message deleted"
placeholder — arrives with the message list, and the column is already there
waiting for it.

---

## 2. What already exists to build on

Four things are done and are load-bearing here. Two of them are easy to
rediscover the hard way.

### 2.1 The executable model — port it, do not rewrite it

`spikes/sync-model.mjs` (264 lines) and `spikes/sync-tests.mjs` (285 lines,
**66 assertions, mutation-tested**) already model ord/rev separation, cursor
contiguity, gap markers, catch-up, backfill paging, idempotency, unread
arithmetic, outbox coalescing and read-state convergence.

`DESIGN.md` §15 item 15 says port it rather than rewriting it, and that
instruction is the single highest-leverage sentence in this document. The spike
is not a sketch — it is the acceptance suite, and it disagrees with intuition in
several places. Re-deriving the behaviour from the prose while writing the real
implementation is how the contiguity rule gets subtly wrong.

Run it with `pnpm spike:sync`. It must stay green throughout.

### 2.2 The socket has a seam, and a rule that forces it through

`sync/network.ts` exports `guardConnect(gate, url)`. Patching `globalThis.fetch`
catches fetch and **nothing else** — a WebSocket is a separate constructor — so
a socket opened outside the gate would go uncounted before first paint (an R3
violation reading as all-clear) and would stay connected while simulated offline
claims to have cut the network.

`tools/check-boundaries.mjs` enforces this: `network/no-ungated-socket` allows
`new WebSocket` and the `ws` package **only** under
`apps/desktop/src/sync/transport/`. That directory does not exist yet. Creating
it is the first act of item 14, and whatever opens the socket calls
`guardConnect` first.

### 2.3 Nine telemetry events are declared and have no call sites

Deliberately, and `packages/telemetry` fails the build for an *unmarked* metric
with no call site — so these were written ahead of the code on purpose:

```
sync.gap.entered      sync.event.unknown    sync.cursor.stalled
sync.backfill.page    outbox.op.failed      outbox.coalesced
ws.connected          ws.disconnected       ws.zombie.detected
```

Wire each as the code lands rather than retrofitting. `sync.cursor.stalled` is
the alarm for invariant 1 — the contiguity frontier falling behind the server
head — which `OBSERVABILITY.md` §9 calls the most important silent failure in
the system: nothing looks broken, messages simply stop arriving.

### 2.4 The directory is already replicated, and is a placeholder

`GET /actors` fills the workspace replica so a message author can render
offline. `DESIGN.md` §9.1 puts `actors` in the `welcome` frame, and the HTTP
shape was written to match it — **so item 14 deletes `auth/directory.ts` and
`fetchActors`**, and porting is a change of transport rather than of shape.

### 2.5 The replica holds two tables, so the message schema is one migration

`apps/desktop/src/sync/migrations/workspace.ts` is at version 1 and creates
`meta` and `actors`. Everything in `DESIGN.md` §8.3 — messages, chat_state,
pending_revs, outbox, reactions, blobs, drafts, the FTS table and its triggers —
does not exist yet.

That is a large forward-only migration rather than a series of small ones, and
it is fine: **the replica is a replica.** If a migration is ever genuinely
infeasible the escape hatch is dropping the file and re-syncing, which a server
database never has. Do not build migration tooling for a problem that has a
delete key.

Two parts of that schema are load-bearing and easy to write wrongly, both
recorded in `DESIGN.md` §13.5: `auto_vacuum = INCREMENTAL` must be the very
first statement on a new file — which the existing runner already asserts — and
every `CHECK` over a nullable column needs an explicit `IS NOT NULL`, because a
CHECK that evaluates to NULL passes and permits exactly the row it forbids.

---

## 3. Build order

Nine sub-phases, **A** to **I**, in execution order. Each says what it delivers,
what is easy to get wrong in it, and what "done" means — because a step whose
completion is a matter of opinion is a step that gets abandoned half-finished.

The lettering is execution order; the **item** each one carries is the number
`DESIGN.md` §15 uses, which four documents reference and which therefore does not
get renumbered. They are not in the same order, and that is deliberate: the
replica's schema belongs with the server's schema in one sitting even though the
two live in different numbered items.

**The rule that shapes the whole sequence: no step depends on a socket until
step D.** Everything before it is a module with a test, which is what makes a
failure attributable to one thing rather than to "sync is broken".

---

### A. The two schemas — item 13 and item 15, in part

Both databases, no transport anywhere.

- **Server** (`apps/server/src/db/migrations/005_*.sql`, forward-only, plain SQL
  as the artifact of record): `spaces`, `chats`, `messages`, and the per-`(actor,
  chat)` counters `DESIGN.md` §12 puts on the server. `memberships` already
  exists from Phase 1 and gains `scope_type='chat'` rows only when private chats
  arrive in Phase 5 — do not add the column shape twice.
- **Client** (`workspace.ts` version 2): everything in `DESIGN.md` §8.3 that is
  not already there — see §2.5 above for what that is and why it is one
  migration.
- **The singleton index is structural, not decorative.** `CREATE UNIQUE INDEX
  chat_singleton ON chats(space_id) WHERE kind IN ('sole','default')` is what
  makes "a channel has exactly one message list" unbreakable by application
  code.

**Done when:** every constraint has a test *of its own*, each asserted against
an expected outcome, executed against a real engine rather than read. The
`spaces` policy matrix is exactly the table where a CHECK that evaluates to NULL
hides. `pragma_auto_vacuum()` returns 2 on a fresh replica.

**De-risks:** a schema mistake found here is a migration nobody has run yet.
Found after step E it is a migration in the field.

---

### B. Allocation and idempotency — item 13

The narrowest, most dangerous piece of server code in the phase, and it is
twenty lines.

- `ord` and `rev` are allocated **in the same transaction as the insert**, under
  a per-chat lock: `UPDATE chats SET next_ord = next_ord + 1, next_rev =
  next_rev + 1 WHERE id = $1 RETURNING next_ord, next_rev`. This serialises
  writes per chat, which is the property we want rather than a bottleneck at
  team scale.
- **A retried op must return the same `ord`, not a new one.** Unique index on
  `op_id`; on conflict, select the existing row and return its ack unchanged.
  Without this, a client that sends, loses the connection before the ack, and
  retries produces a duplicate — the single most common offline-sync bug in the
  wild.
- Only a new message gets an `ord`. Every mutation gets a `rev`.

**Done when:** a concurrent-writer test shows two senders never interleave a
`rev`, and a replayed `op_id` returns the first `ord` rather than allocating a
second. Both are assertions the spike already makes; port them.

---

### C. The domain ops — item 13

`send` and `delete` (§1). Plain functions over the database, callable without a
socket in sight.

This is `spikes/sync-model.mjs`'s `Server` class becoming real code: `send`,
`del`, `head`, `catchup`, `backfill`, `markRead`, `counters`, `hello`. The spike
is 264 lines and the shapes transfer almost directly, because it was written
against this schema rather than against an idea of it.

- `markRead` applies `max(existing, incoming)` and never a blind overwrite. Not
  LWW — a device that was asleep for an hour would otherwise un-read a chat, and
  users find that maddening.
- **`delete` takes a `rev` and no `ord`.** It is the only op in this phase that
  does, which makes it the only real test of the two-counter model. It sets
  `deleted = 1` and keeps the row: the `ord` stays allocated, and the resulting
  gap in the sequence is correct rather than something to repair.
- Counters are server-owned, per `(actor, chat)`, updated on write. This is what
  makes R2 cheap: a badge is correct for a chat holding zero messages.

**Done when:** the ported functions pass the spike's assertions against
Postgres rather than against the spike's in-memory SQLite — same assertions, new
engine.

---

### D. The transport skeleton — item 14

The first socket. Deliberately carrying no product meaning yet: it connects,
stays alive, reconnects, and parses frames it does not understand.

- **Create `apps/desktop/src/sync/transport/`.** That directory does not exist,
  and `network/no-ungated-socket` permits `new WebSocket` and the `ws` package
  nowhere else. Whatever opens the socket calls `guardConnect` first — patching
  `fetch` catches fetch and nothing else, so an ungated socket would go
  uncounted before first paint and would stay connected while simulated offline
  claims to have cut the network.
- `ws` is not yet a server dependency. Add it, and **leave
  `permessage-deflate` off** — it looks free and costs roughly 189 KB of zlib
  context per connection, about 17× the connection itself, for negligible gain
  on sub-1 KB JSON.
- **Heartbeat under 30s with a read deadline.** The interval is a floor, not a
  tuning knob: intermediaries close idle sockets at 60s and Cloudflare at 100s.
  The deadline is the point — a socket that is open but dead is
  indistinguishable from a quiet one without it.
- **Reconnect on `powerMonitor` `resume`, without waiting for TCP**, and back
  off with **full jitter**. Jitter is not politeness: ten thousand clients
  reconnecting together is ~180 MB of `welcome` generation in one instant.
- **Parse permissively.** An unknown top-level frame is ignored, never fatal;
  parse the envelope strictly, look the body schema up by type, and count-and-
  skip when there is no entry. A `z.discriminatedUnion` over the envelope
  breaks this on its first use — see §4.2.

**Done when:** a client survives a server restart, a laptop sleep and a network
change; `ws.connected`, `ws.disconnected` and `ws.zombie.detected` have call
sites; and an unrecognised frame type is delivered and ignored without the
connection dying. That last one is the test that protects every future client.

---

### E. `hello` and `welcome` — item 14

The first exchange that means something, and the one that satisfies R2.

- `hello` carries the cursors, a device id and **a protocol version**; the
  server can answer `too_old`. Build that path even though it will not be used
  for a year — the moment it is needed is the moment it cannot be shipped,
  because the clients requiring it are the old ones.
- `welcome` carries per-chat head state and counters, the caller's actor, the
  actor directory and memberships. At ~150 chats that is roughly 3 KB up and
  18 KB down in **one round trip**, and after it **every badge in the sidebar is
  correct before a single message body has been fetched.**
- **This deletes `auth/directory.ts` and `fetchActors`.** The HTTP directory was
  written to match the `welcome` shape precisely so this would be a change of
  transport rather than of shape.

  One concrete consequence not to miss: the live-query invalidation for the
  directory currently fires inside `fillActors`. It moves to the `welcome`
  handler. Miss it and the workspace directory silently stops refreshing — no
  error, exactly the failure the live-query client was built to remove.

**Done when:** a client with empty cursors receives a `welcome`, writes
`chat_state` for every chat, and the sidebar badge count matches the server's —
with the message tables still empty. That last clause is the whole point.

---

### F. Live events and the contiguity engine — item 14 and item 15

Where the spike earns its keep, and the step with the most expensive failure
mode in the system.

- `synced_through_rev` means "I hold every change with rev ≤ this" — a
  contiguous prefix, no holes. An event arriving at rev 501 while the cursor
  sits at 400 is **stored** and the cursor is **not advanced**.
- `pending_revs` holds only revs above the frontier, and collapses to empty
  whenever the client is caught up. It exists because "have I seen rev N?" is
  not answerable from message rows: an edit overwrites the rev it replaced, and
  a delete for a message the client never held writes nothing at all.
- **A rev is recorded before, and independently of, whether its event can be
  applied.** An unrecognised op must still advance the cursor, or the frontier
  stalls for ever and the client silently stops receiving that chat.
- **A delete for a message this client never held is the sharpest case**, and
  the reason `delete` was pulled into this phase (§1). It writes no row at all —
  there is nothing to mark — so the rev it carries exists only in
  `pending_revs`. A client that skips it stalls its own frontier permanently
  while looking perfectly healthy.

**Done when:** out-of-order events injected during catch-up leave the frontier
correct; `sync.cursor.stalled` has a call site; and an unknown op advances the
cursor while a later known event still applies. Getting this wrong produces
silent permanent history holes that surface weeks later, which is why it gets a
dedicated test rather than a passing assertion inside another one.

---

### G. Catch-up, gap and backfill — item 14

What bounds a reconnect to **O(chats)** rather than O(messages).

- Below the threshold, a replay. Above it, a **gap marker** plus a recent tail:
  the client sets `has_gap`, stores the tail, and jumps the cursor to the head.
  A user offline for a week across 150 chats reconnects with one small frame
  rather than 100k messages.
- Backfill is keyset on `ord`, never `OFFSET`, and lazy — on open, not on
  reconnect.
- The ~500-rev threshold is a guess. This is the step that can finally replace
  it with a measurement (§7).

**Done when:** a client far behind receives a gap rather than a replay, renders
a correct tail immediately, and backfills on open; `sync.gap.entered` and
`sync.backfill.page` have call sites.

---

### H. The outbox — item 16

The write path, and the first thing a user can break by being offline.

- **Coalescing runs on enqueue**, scoped by target id. Compose then delete
  offline must produce **zero** network ops, not two that fail — `delete`
  targets a message the server has never seen, so the pair is dropped entirely
  and never touches the network. This is a correctness requirement rather than
  an optimisation. (The `send` + `edit` row of the table waits for Phase 4 along
  with edits; the two `delete` rows are live this phase.)
- **Replay is in order per chat**, one in flight at a time; cross-chat
  parallelism is fine and wanted.
- The outbox lives in the **workspace replica, transactional with its echo** — a
  crash between the row and the optimistic message yields something that looks
  sent and never sends.
- `nack` carries `retryable`, which decides backoff versus a terminal failure
  the UI must show. A send into a chat you were removed from will never succeed,
  and retrying it silently for ever is worse than an error with a discard
  action.
- Draining a **non-active** workspace's outbox stays deferred: `outbox_hint` is
  already written on workspace close and already renders as an amber dot on the
  rail.

**Done when:** the spike's coalescing table passes against the real outbox;
three messages typed offline arrive in the order typed; `outbox.coalesced` and
`outbox.op.failed` have call sites.

---

### I. The milestone — item 17

Not a build step. The demonstration that the phase is finished, run by hand:

1. Two clients, one chat. A message on one appears on the other.
2. Kill the server. Both keep rendering, scrolling and searching their history.
3. Compose on both while the server is down. Restart it. Both converge on the
   same order, with no duplicates.
4. Sleep a laptop for ten minutes mid-session. It reconnects promptly rather
   than sitting on a zombie socket.

---

## 4. Two deferred decisions fire in this phase

Both were deferred with named triggers rather than indefinitely. Both triggers
are here, and both land in **step D, the transport skeleton** — which is worth
knowing before starting D, because deciding either one mid-step is how a step
turns into a rewrite.

### 4.1 XState — at the transport

`FRONTEND.md` §7.4. Port `session.ts` at the same time so the process has one
idiom rather than two.

**The scope is narrower than an earlier draft claimed.** Catch-up is per chat —
iterating every chat where `synced_through_rev < server_head_rev` across ~150 of
them, with `has_gap` as a column — which is a loop over a table, not a region of
a machine. Backfill is request/response paging. The outbox is a status column
and a drain loop. What is genuinely machine-shaped is **connection health**:
roughly five states with two timers.

The case rests on one property: **resource cleanup on exit paths**. Both Phase 1
bugs in this area were cleanup that did not run on an exit path.

**Kill criterion:** write the connection machine, then estimate the hand-rolled
equivalent. Under ~60 lines with no timer-cancellation subtlety and the
dependency has not paid — drop it. An earlier attempt at the auth half is
recorded in `FRONTEND.md` §7.4a, including the two regressions it introduced.

### 4.2 Zod — at the first wire format

`FRONTEND.md` §8.3, and §8.2 has the worked shapes.

The subtle one, which is easy to get backwards: **do not use
`z.discriminatedUnion` on the frame envelope.** A union rejects what it does not
know, and invariant 43 requires ignoring it. Parse the envelope strictly, look
the body schema up by `t`, and count-and-skip when there is no entry.

---

## 5. Traps, recorded in advance

Each of these has already cost time somewhere in this repository.

- **A `CHECK` constraint permits the row it forbids when a column is NULL.**
  `FALSE OR NULL` is `NULL`, and a CHECK only rejects `FALSE`. Write
  `IS NOT NULL` explicitly. Every constraint needs a test *per constraint*.
- **`auto_vacuum` must precede `journal_mode=WAL`**, not merely `CREATE TABLE`,
  or it is silently ignored (invariant 11).
- **A rejection handler attached after an `await` fires unhandled** and kills
  the process. Recorded in `PHASE-1-IDENTITY.md` §11a, then walked into again by
  the person who recorded it.
- **A teardown must settle every promise it abandons** (invariant 54). A
  listener that closes without rejecting leaves every awaiter pending for ever.
- **Verify a probe's success condition, not just its output.** A redirect check
  reported four URIs as accepted because it treated any `302` as success — the
  redirect was *to* an error page.

---

## 6. Done criteria

### Per step

Each is the "done when" from §3, in one place so progress is checkable at a
glance rather than by re-reading.

- [ ] **A** Every constraint has its own test, run against a real engine;
      `pragma_auto_vacuum()` returns 2
- [ ] **B** Concurrent senders never interleave a `rev`; a replayed `op_id`
      returns the first `ord`
- [ ] **C** The spike's server assertions pass against Postgres; `delete`
      allocates a `rev` and no `ord`
- [ ] **D** Survives restart, sleep and a network change; an unknown frame type
      is ignored without killing the connection
- [ ] **E** Badges correct from `welcome` alone, with the message tables empty
- [ ] **F** Out-of-order events during catch-up leave the frontier correct; an
      unknown op advances the cursor and a later known event still applies
- [ ] **G** A far-behind client gets a gap plus a tail, and backfills on open
- [ ] **H** Compose-edit-delete offline produces zero network ops; offline
      messages arrive in the order typed
- [ ] **I** The four-step milestone, run by hand

### Across the phase

Client:

- [ ] `synced_through_rev` advances contiguously; `pending_revs` holds the rest
- [ ] An unknown frame `t` and an unknown `op` are both non-fatal
- [ ] Catch-up, gap, and lazy backfill on open
- [ ] Outbox coalesces and replays in order, transactional with its echo
- [ ] Socket opened through `guardConnect`; simulated offline actually cuts it
- [ ] All nine declared events (§2.3) have call sites

Server:

- [ ] Atomic `ord`/`rev` per chat, idempotent on client-generated ids
- [ ] `welcome` carries the directory and per-chat counters
- [ ] `catchup` replies with a replay or a gap marker at the ~500-rev threshold

Both:

- [ ] `pnpm spike:sync` still green — 66 assertions, ported not rewritten
- [ ] Two clients converge after an offline compose
- [ ] R3 holds: `boot.test.ts` removes `fetch` entirely and must still pass
- [ ] `pnpm check:boundaries` clean, including `network/no-ungated-socket` once
      `sync/transport/` exists to satisfy it

### What would mean this phase failed even with every box ticked

Worth naming, because all three pass a checklist:

- **The two counters were never separated in practice.** `delete` is in this
  phase precisely to prevent that (§1). If it slipped, `rev` only ever moved
  with `ord`, `pending_revs` was never genuinely needed, and the model is still
  unexercised outside the spike — with every other box ticked.
- **The spike was rewritten rather than ported.** The assertions still pass
  because they were re-derived from the same prose that the implementation was
  re-derived from. The suite is mutation-tested against *its* implementation;
  that property does not survive a rewrite of both halves.
- **R3 regressed quietly.** A read path that reaches for the socket when it is
  connected and falls back to local when it is not still passes every test on a
  developer machine with a server running.

---

## 7. Open questions carried in

From `DESIGN.md` §16, the ones this phase can finally answer with data:

3. **Gap threshold.** ~500 revs is an educated guess. Tune against real traffic.
4. **Live fanout ceiling.** At what channel count does "receive everything" stop
   being free?
8. **Connection ceiling per node.** Measured 8.7–11.4 KB/conn process RSS in
   Phase 0; the real number needs real sockets.

And one this phase creates:

- ~~**Renderer telemetry has no transport.**~~ **Closed** by the renderer
  telemetry transport (Phase 1½ item 12d). `lib/telemetry.ts` forwards
  catalogued records over the port the renderer already holds and the sync
  process emits them, so a renderer signal now reaches the collector the same
  way a sync one does (`OBSERVABILITY.md` §3).

  What that leaves for this phase is the frame envelope: `traceparent` on the
  wire (`OBSERVABILITY.md` §4), so a client "user pressed send" span links to
  the server span that assigned the `ord`. The read path uses a per-process
  `invalidation` id to correlate its two halves today, which is enough within
  one machine and is exactly what `traceparent` replaces once there is a socket.
