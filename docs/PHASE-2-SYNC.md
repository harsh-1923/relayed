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
the order (§4).

Not in scope: threads, reactions, edits, search (Phase 4), rooms (Phase 5).
`spaces` gets its table in item 13 because messages need a parent, but only
`kind='channel'` is exercised.

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

---

## 3. Build order

Numbered to match `DESIGN.md` §15.

### 13. Server: the log

`spaces`, `chats`, `messages`, atomic `ord`/`rev` allocation, idempotent ops.

- **`ord` and `rev` are different counters and always will be** (§8.1). `ord` is
  display order, the read cursor and the retention axis; `rev` is the sync
  cursor and nothing else. Conflating them is the mistake the two-counter model
  exists to prevent, and it does not surface until deletes leave `ord` gaps.
- `ord` is **never renumbered or reused** — read cursors and scroll positions
  corrupt across clients otherwise.
- Idempotency keys on client-generated ids (§10.1), because an ack lost after
  the server committed must not duplicate on retry.
- Allocation is atomic per chat. Two writers must not interleave a `rev`.

### 14. Protocol: the frames

`hello` / `welcome`, live events, `catchup`, `gap`, and `traceparent` in the
frame envelope (`OBSERVABILITY.md` §4).

- Create `sync/transport/`, call `guardConnect` (§2.2).
- **Invariant 43: an unknown top-level frame `t` is ignored, never fatal.** This
  is what lets a newer server talk to an older client. It is also the first
  thing a naive `z.discriminatedUnion` breaks — see §4.2.
- **Invariant 32: an unrecognised `op` still advances the cursor.** Otherwise
  the frontier stalls for ever on a client that has not been updated.
- `welcome` carries the directory and the per-chat counters, replacing both the
  `/actors` endpoint (§2.4) and the arithmetic fallback.
- Heartbeat and zombie detection (invariant 30). The deadline is the point: a
  socket that is open but dead is indistinguishable from a quiet one without it.

### 15. Client cursors and contiguity

Including `pending_revs`. **Invariant 1**: `synced_through_rev` advances
contiguously, never past a hole.

This is where the spike earns its keep. Out-of-order live events arriving during
catch-up must not skip the frontier; that scenario is already asserted.

### 16. The outbox

Coalescing (invariant 6) and in-order replay (invariant 7).

- The outbox lives in the **workspace replica**, transactional with its echo
  (invariant 40) — a crash between the row and the echo yields a message that
  looks sent and never sends.
- `outbox_hint` is already written on workspace close (`STORAGE.md` §15.2) and
  already renders as an amber dot on the rail. Draining a *non-active*
  workspace's outbox is explicitly deferred: it stays parked until you switch
  back.

### 17. Milestone

Two clients exchange messages; kill the server and keep reading; compose
offline, reconnect, converge.

---

## 4. Two deferred decisions fire in this phase

Both were deferred with named triggers rather than indefinitely. Both triggers
are here.

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

Client:

- [ ] `synced_through_rev` advances contiguously; `pending_revs` holds the rest
- [ ] An unknown frame `t` and an unknown `op` are both non-fatal
- [ ] Catch-up, gap, and lazy backfill on open
- [ ] Outbox coalesces and replays in order, transactional with its echo
- [ ] Socket opened through `guardConnect`; simulated offline actually cuts it
- [ ] All nine events above have call sites

Server:

- [ ] Atomic `ord`/`rev` per chat, idempotent on client-generated ids
- [ ] `welcome` carries the directory and per-chat counters
- [ ] `catchup` replies with a replay or a gap marker at the ~500-rev threshold

Both:

- [ ] `pnpm spike:sync` still green — 66 assertions, ported not rewritten
- [ ] Two clients converge after an offline compose
- [ ] R3 holds: `boot.test.ts` removes `fetch` entirely and must still pass

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
