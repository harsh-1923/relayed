# Known issues

Bugs that are understood but not yet fixed. Each entry carries the **symptom as
it is actually experienced**, the chain that produces it, the evidence that
identified it, and what to do meanwhile — so the next person spends their time
fixing it rather than rediscovering it.

An entry leaves this file when the fix lands, not when somebody knows about it.

---

## 1. A workspace whose vault slot cannot be decrypted never syncs, and says nothing

> **Found 2026-09-20, diagnosed, not fixed.** Cost about an hour of looking in
> the wrong places, which is the reason for the detail below.

### The symptom

The app opens. Every room, every message, every avatar is there. Navigation
works. Then a message you send **never leaves the outbox**, and nothing anywhere
says why — no banner, no error, no console output, no telemetry.

### What it is NOT — the false leads, in the order they were tried

Each of these looked plausible and each was wrong. They are listed because
re-walking them is the expensive part.

| Suspected | Why it looked right | Why it was wrong |
|---|---|---|
| Server down | messages queueing is what an offline client does | `/health` answered **200 in 8 ms** |
| Socket not connected | no ESTABLISHED connections to `:8787` at one point | true, but a **symptom**, not the cause |
| Session expired | an eight-hour gap since the last op reached the server | `sessions` held **valid, unrevoked** rows for both workspaces, minutes old |
| An orphaned Electron instance | `AGENTS.md` warns of exactly this, twice | the app was current, and its bundles had rebuilt **after** the last source change |
| The sync process crashed | it would explain the silence | **three utility processes alive**, and `@relayed/protocol` imported cleanly standalone |
| A recent `@relayed/protocol` change | the last successful op landed minutes before it | the build was current and there was no error anywhere; **the timing was a coincidence** and chasing it wasted the most time |

### The chain

```
storage.boot()
  → picks ONE workspace: `last_workspace`, else the first active one
startSyncing()
  → void session.activate(boot.workspaceId)          ← the promise is DISCARDED
Session.activate(workspaceId)
  → vault.read(workspaceId)  →  null
  → this.#session?.refreshToken  →  null  (fresh process)
  → if (!stored && !source) { #set({ status: 'signed_out' }); return }
                                                      ← NO emit, NO count, NO throw
```

`readRefreshToken` returns `null` rather than throwing when the blob will not
decrypt, and says so in its own comment:

> *"A keychain that cannot decrypt its own blob means the entry is gone or the
> machine changed. Treat as signed-out; never as data loss."*

That is the right call for data safety. It is also the point at which the
failure becomes invisible.

### Why nothing surfaces it

Three behaviours, each correct on its own, compose into silence:

1. **`activate`'s signed-out branch is the only one that emits nothing.** Its
   success path emits `auth.activate`, `auth.activated` and `ws.reauth`; its
   failure path adds `auth.stale`. The *third* outcome — no credential at all —
   emits none of them, so an operator sees an empty log and assumes nothing ran.
2. **`void session.activate(...)`** discards the promise, so even a rejection
   would vanish without an unhandled-rejection warning.
3. **Auth failure never clears local data** (`DESIGN.md` §13.1, *Auth and
   session*). Every read is local (R3), so the UI is fully, convincingly
   functional while nothing is being sent or received.

### How to recognise it in two commands

```bash
lsof -iTCP:8787 -n -P | grep ESTABLISHED     # nothing, while the server listens
```

and, in the client's replica for that workspace:

```sql
SELECT op_id, kind, state, attempts FROM outbox;
-- state='queued' with attempts=0 is the tell.
```

**`attempts: 0` is the whole diagnosis.** It means the drain loop has never
*tried* — which rules out the server, the socket, auth rejection and retry
backoff in one field. A rejected op would carry attempts ≥ 1 and an `error`.

Confirm with the absence of every `auth.*` event in the dev log, and by checking
the vault slot exists but is not being used:

```bash
ls -la ~/Library/Application\ Support/relayed-client-N/accounts/<acc>/auth/
```

### Why the blob stops decrypting

macOS binds keychain access to the **application**, and the dev app is a copy of
Electron under `node_modules/.cache/relayed-dev-bundles/client-N/`. When that
bundle is recreated, the new copy is a different application as far as the
keychain is concerned, and loses access to items the previous copy wrote. The
slot survives on disk; only the ability to read it is gone.

It bites **one workspace at a time**, which is what made it confusing here: the
other workspace had been signed into more recently and had a slot the current
bundle could read — but `boot()` activates only `last_workspace`, and that was
the broken one.

### Meanwhile

**Sign out of the affected workspace and back in.** That re-mints the session and
rewrites the slot with one the current bundle can decrypt. Queued messages drain
on reconnect, which is what the outbox is for.

### The fix, when it is taken

1. **Emit on the signed-out path.** One `count('auth.activate', { path, result:
   'no_credential' })` — or its own counter — so the third outcome appears in
   telemetry like the other two. This alone turns an hour into a minute.
2. **Stop discarding the promise.** `void session.activate(...)` should at least
   `.catch()` and report; a credential problem is not a fire-and-forget concern.
3. **Consider surfacing it in the UI.** `status: 'signed_out'` is already a
   state the renderer could act on — a workspace that cannot sync looking
   identical to one that can is the actual user-facing bug.
4. **Consider activating every workspace, not only `last_workspace`.** R2 says
   updates arrive for every space an actor belongs to; today a second
   workspace's socket does not open until it is visited. Worth confirming
   against the intended reading of R2 before changing.
