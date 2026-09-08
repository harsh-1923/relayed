# Local storage, multi-workspace, and switching

Companion to [`DESIGN.md`](DESIGN.md) §6 (tenancy), §8 (data model), §9 (sync
protocol) and §13.1 (auth and session). Those describe a **single-workspace**
client. This document describes the storage layout that lets one install hold
several workspaces and several accounts, and the flows that move between them.

Written during Phase 1 close-out, before the Phase 2 write path exists — which
is the entire reason it is worth writing now. See §3.

---

## 1. What this doc decides

| Question | Decision | §|
|---|---|---|
| One database or many? | **One replica per `(account, workspace)`**, plus one `account.db` per account | 5 |
| Where does `device_id` live? | `account.db` — per `(install, account)`, **not** per install, **not** per workspace | 8 |
| How many workspaces are live at once? | **Exactly one active.** Zero or more open drain-only | 7 |
| Where do sync cursors live? | Entirely inside the workspace replica. Nothing crosses | 7 |
| What happens to a token on switch? | **Nothing.** Refresh tokens persist per workspace on disk | 9 |
| How does a second workspace get a session? | `POST /auth/switch`, **once**, then ordinary refresh forever | 9, 10 |
| Can one install hold two accounts? | Yes. They share nothing but the parent directory | 4 |

---

## 2. Goals and non-goals

### Goals

1. **R3 survives multi-workspace.** Boot renders from local data with zero
   network calls, for whichever workspace was last open, regardless of auth
   outcome. The plane test still passes.
2. **Switching is a local operation.** The UI repaints from disk before any
   token or socket work begins, and completes successfully while offline.
3. **Cursors never cross a workspace boundary.** No `workspace_id` threaded
   through catch-up, gap handling, or eviction.
4. **"Forget this account" is a directory delete.** Complete, auditable, and
   impossible to half-do.
5. **A corrupt replica costs one workspace**, not the install.
6. **The deferred features stay cheap.** The outbox drainer, cross-workspace
   activity, and notifications must be additive when Phase 2 arrives — no
   storage reshape, no protocol break for clients already in the field.

### Non-goals

- **Two workspaces live at once.** One socket, one subscribed replica. Revisit
  only when a user demonstrably needs it.
- **Cross-account anything.** Two accounts on one machine are strangers. No
  shared cache, no shared `device_id`, no table that joins them.
- **Merging identities.** Two emails are two accounts, permanently. WorkOS
  keys `User` on email and so do we (§6.2: never key anything on email — this
  is the one place email's uniqueness is WorkOS's business, not ours).

---

## 3. Why this lands now and not later

Measured cost of an open SQLite handle, real schema, 2k rows written:

| Handles | RSS delta | Per DB | Open time |
|---|---|---|---|
| 1 | 3.6 MB | — | 6.7 ms |
| 5 | 7.4 MB | 1.5 MB | 1.1 ms |
| 20 | 24.0 MB | 1.2 MB | 1.1 ms |

~1.2 MB and ~1 ms per workspace. **Runtime cost is not the deciding factor.**

The deciding factor is code coupling. At the time of writing, everything that
touches the database handle is 273 lines across five files, and the replica
holds two rows (`schema_origin`, `device_id`). Phase 2 — cursors, `pending_revs`,
gap markers, outbox, eviction — is precisely the code that would have to be
threaded, and none of it is written.

There is also a defect already present and merely unobservable at N=1:
`device_id` lives in the workspace replica, so two workspaces would mint two
device identities for one machine (§8).

---

## 4. The three tiers

```
install       one copy of the app on one machine
  account     one WorkOS User = one email. Two emails = two accounts.
    workspace one actor, one handle, one replica, one cursor space
```

"Account" is a **client-side** concept. Server-side there is no `accounts`
table; identity is `actors.identity_kind + identity_id`, and sibling actors are
found by matching `identity_id` (§10.2). Materializing it server-side becomes
worthwhile when push tokens arrive, which are account-level (§16.3).

---

## 5. Directory layout

```
userData/
  install-id                              telemetry only. NEVER in a token (§8).
  accounts/
    acc_01M215K8QW…/                      locally generated; never leaves the machine
      account.db                          device_id, workspace index, hints
      auth/
        refresh-wsp_01M213JT6RA21A2YKKS7HGSPCG.bin
        refresh-wsp_01M214G17QJ2Y39ZEH0QSKVX1R.bin
      workspaces/
        wsp_01M213JT6RA21A2YKKS7HGSPCG/   "Harsh Sharma's workspace"
          relayed.db                      chats, messages, cursors, outbox
          blobs/7c/7c9f2a…                avatars, attachments
        wsp_01M214G17QJ2Y39ZEH0QSKVX1R/   "Acme Inc"
          relayed.db
          blobs/…
    acc_01M219P3RT…/                      a second email — shares NOTHING above
      …
```

### Why the account directory is not named by the WorkOS user id

§6 forbids Layer 1 identity below Layer 2. A `user_01…` in a filesystem path
would let anyone with disk access enumerate which WorkOS users have signed in on
this machine. The directory name is a locally generated `acc_…` ULID.

Which raises: **at sign-in, which existing account directory is this?**

**Match on actor-id intersection.** `/auth/session` returns every membership;
if any returned `actor_id` already appears in an existing `account.db`, that is
the account. Actor ids are Layer 2, so nothing leaks, and two different emails
can never share an actor id — one actor has exactly one identity — so it cannot
false-positive.

Edge case, handled by the same rule: an account whose membership list came back
*smaller* than what is stored (removed from a workspace) still matches on the
remaining actor, and the missing one is marked `state='removed'`.

---

## 6. `account.db`

```sql
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- device_id, last_workspace, last_active_at, epoch

CREATE TABLE workspaces (
  workspace_id   TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL,

  actor_id       TEXT NOT NULL,   -- MY actor here
  handle         TEXT NOT NULL,   -- MY handle here — differs per workspace by design (§10)
  display_name   TEXT NOT NULL,
  avatar_blob    TEXT,

  last_opened_at INTEGER,
  unread_hint    INTEGER NOT NULL DEFAULT 0,   -- reserved: §16.2
  mention_hint   INTEGER NOT NULL DEFAULT 0,   -- reserved: §16.2
  outbox_hint    INTEGER NOT NULL DEFAULT 0,   -- written at close, §15.2

  state          TEXT NOT NULL,
  CHECK (state IN ('active','removed'))
);
```

This is what renders the switcher **offline, before auth, without opening a
single replica**. It is a local cache of `/auth/session`'s `memberships` array.

`account.db` carries its own `user_version` and its own migration list,
independent of the workspace replica's.

---

## 7. Cursor placement

`rev` is per-chat (§8.1) and `pending_revs` is keyed `(chat_id, rev)`. A chat
belongs to exactly one workspace. Therefore every cursor is already
workspace-local and **nothing needs to change to make cursors multi-workspace
safe**.

| State | Lives in | Scope | Crosses? |
|---|---|---|---|
| `synced_through_rev` | workspace replica | per chat | no |
| `pending_revs` | workspace replica | per chat | no |
| `server_head_rev` | workspace replica | per chat | no |
| `last_read_ord` (max-register) | workspace replica | per chat | no |
| unread / mention counters | workspace replica | per chat | no |
| `has_gap` | workspace replica | per chat | no |
| `outbox` | workspace replica | per workspace | no |
| `drafts` | workspace replica | per chat | no |
| **activity hints** | **`account.db`** | per workspace, coarse | **yes — the only one** |
| `device_id`, `last_workspace` | `account.db` | per account | n/a |
| `install-id` | flat file | per install | n/a |

### The consequence that makes this cheap

Switching does not touch cursor state. Close replica A (cursors frozen), open
replica B (cursors as you left them). On reconnect, `hello` carries B's cursors
and §9.3 does the rest.

**Returning to a workspace after a week is the same code path as reconnecting
after a week.** No new machinery, and the gap-marker path (§9.3) already bounds
it to O(chats).

Expect gap markers, not full replay, for any workspace left past the ~500-rev
threshold: recent tail per chat, `has_gap = 1`, lazy backfill on open. Badges
are still exact, because `welcome` carries server-computed counters (§12).

### The active-workspace rule

> **Exactly one workspace is *active*** — subscribed, rendering, catching up.
> **Zero or more may be open *drain-only*** — and a drain-only handle may touch
> only `outbox` and the ack fields of its local echo.

### Why the outbox stays in the workspace replica

Hoisting it to `account.db` would make draining trivial — one always-open
handle — but the outbox row and its optimistic echo (§10.2) would then live in
different files with no shared transaction. A crash between them yields a
message that looks sent and never sends.

Keeping it in the replica makes the write and its echo one transaction, at the
cost of a transient handle to drain. The atomicity of "hit enter → durable and
consistent" is what local-first is selling; it is not traded to avoid opening a
file.

---

## 8. Device identity

**`device_id` is per `(install, account)`, stored in `account.db`.**

Checked against every use:

| Use | Natural scope |
|---|---|
| Outbox dedupe | the actor's writes → within an account |
| Multi-device read state | per actor → within an account |
| "Sign out this device" | the user's device list → per account |

Every use is already account-scoped, so an install-wide id buys nothing and
costs linkability: two accounts on one laptop become correlatable server-side by
a value carried in their tokens.

`install-id` is separate, telemetry and crash reporting only, and **never enters
a session token**. The current single `device_id` in the workspace replica
conflates these two and is wrong today — it is simply unobservable at one
workspace.

No server change: `sessions(actor_id, device_id)` already means "one session per
(actor, device)", so signing out a laptop within an account revokes all of that
account's workspace sessions via `WHERE actor_id IN (…) AND device_id = ?`.

---

## 9. Sessions and tokens

Three things with three lifetimes. Conflating them is the main source of
confusion:

| Token | Lifetime | Where | On switch |
|---|---|---|---|
| WorkOS access token | seconds; sign-in only | memory | already discarded |
| **Our** access token | minutes | memory, active workspace | dropped — cheap to re-derive |
| **Our** refresh token | long-lived, revocable | **disk**, one file per workspace | **kept, untouched** |

Switching away from a workspace closes its socket and drops its in-memory
access token. It does **not** delete `auth/refresh-<wsp>.bin`, and it does
**not** revoke the server-side session. A workspace you are not currently
looking at remains fully credentialed until you sign out of the account.

That is what makes the deferred outbox drainer (§16.1) need no new auth
machinery: read the file, refresh, send.

### "Minting" — creating a `sessions` row

Happens at most twice per workspace in its life:

```
first sign-in ever         → /auth/session   mints for the resolved workspace
first entry to workspace N → /auth/switch    mints for workspace N
every switch after that    → /auth/refresh   rotates within the existing session
```

`/auth/switch` is a **one-time bootstrap per workspace**, not a per-switch call.

### Vault layout

`auth/refresh-<workspace_id>.bin`, `safeStorage`-encrypted, mode `0600`, refusing
to persist unencrypted (unchanged from Phase 1). One slot per workspace because
`sessions.actor_id` makes a session per-actor, and an actor is per-workspace.

---

## 10. Server changes

### 10.1 `POST /auth/session`

**Defect being fixed.** `resolveActor` currently issues
`executeTakeFirst()` with no workspace filter and no `ORDER BY`. With two actors
for one identity it returns an arbitrary row — stable in testing, undefined by
contract, and free to change after a vacuum or an index change.

```jsonc
// request
{ "workos_access_token": "…", "device_id": "dev_…",
  "workspace_id": "wsp_…GSPCG" }        // optional; from account.db.last_workspace

// response
{ "needs_workspace": false,
  "access_token": "…", "refresh_token": "…", "expires_in": 900,
  "actor": { … },
  "memberships": [
    { "workspace_id": "wsp_…GSPCG", "org_id": "org_…",
      "name": "Harsh Sharma's workspace", "slug": "harsh-sharma-s-workspace",
      "actor_id": "act_…GB4DA", "handle": "harsh",
      "display_name": "Harsh Sharma", "avatar_url": null },
    { "workspace_id": "wsp_…KVX1R", "…": "…", "handle": "harsh.s" }
  ] }
```

Resolution rule:

```
workspace_id given, belongs to this identity   → mint for it
workspace_id given, does NOT belong            → 403
omitted (fresh install, no local state)        → oldest actor, ORDER BY created_at
no actors at all                               → needs_workspace   (unchanged)
```

### 10.2 `POST /auth/switch` — new

```jsonc
// request
{ "refresh_token": "<the CURRENT workspace's>", "workspace_id": "wsp_…KVX1R" }

// response — identical shape to /auth/session
{ "access_token": "…", "refresh_token": "…", "expires_in": 900, "actor": { … } }
```

Takes the **refresh** token rather than the access token, because the access
token has usually expired by switch time and requiring a fresh one would make
this two round trips. `device_id` is not in the request: it comes from the
source session, because the credential is what says which install this is.

```
1. look up session by refresh_hash                → actor X → identity_id
2. reject if revoked / expired / actor suspended
3. find actor Y WHERE workspace_id = target
                  AND identity_kind = X.identity_kind
                  AND identity_id   = X.identity_id
                  AND state NOT IN ('deactivated','suspended')
   not found → 403
4. INSERT a NEW sessions row for Y, same device_id
5. return Y's token pair
```

**Step 5 deliberately omits revoking or rotating X's session.** That is what
keeps workspace X drainable and switchable-back-to without a network round trip
it does not need.

### 10.3 `POST /auth/refresh`

Add `memberships` to the response, same shape as `/auth/session`. This is how
"you were added to a workspace while signed in" reaches the client without a
separate poll, and it keeps `account.db.workspaces` fresh on every boot.

### 10.4 `POST /auth/workspace`

Drop the `already_provisioned` 409 guard. Creating a second workspace for an
existing identity is the intended path to a multi-workspace account before
invitations exist — and is real product behavior afterwards.

---

## 11. Boot

```
main:  app.setName('Relayed') → userData → spawn sync, RELAYED_DATA=<dir>
                                                        (a directory, not a file)
sync:
  1. read/create userData/install-id
  2. readdir accounts/ → open each account.db, migrate, read summary
        none → signed-out shell (still renders)
  3. pick max(last_active_at)                       → acc_A
  4. acc_A.last_workspace                           → wsp_1
        fallback: max(last_opened_at) WHERE state='active'
  5. open accounts/acc_A/workspaces/wsp_1/relayed.db, migrate
  6. post boot:ready { accounts[], activeAccount, activeWorkspace, actor, epoch }

  ══════════ renderer paints. NO NETWORK TOUCHED. R3 holds. ══════════

  7. read auth/refresh-wsp_1.bin → POST /auth/refresh
  8. socket → hello(wsp_1 cursors) → welcome → catch-up
```

Steps 1–6 are pure local I/O. Step 7 is the first packet. This ordering is
tested, not assumed (§17).

---

## 12. Switching

### 12.1 The epoch

A query issued against workspace A that returns *after* a switch will paint A's
data under B's chrome. Invisible in testing, ugly in production, impossible to
reproduce on demand.

**Every IPC envelope carries a workspace epoch** — a counter bumped on switch and
persisted in `account.db`. The renderer drops any reply whose epoch is not
current. Cheap now; genuinely painful to retrofit.

§11.2 already specifies coarse invalidation, so the repaint itself is free — a
switch is the coarsest invalidation there is.

### 12.2 Flow A — first entry into a workspace

```
  step                                        checkpoint
─────────────────────────────────────────────────────────────────────────
1 renderer → sync  workspace.switch(wsp_B)

2 account.db:  last_workspace = wsp_B         committed BEFORE step 3.
               last_opened_at = now           kill -9 here → boots into B
               epoch++

3 close socket for wsp_A                      live sockets 1 → 0

4 wsp_A replica:
    SELECT count(*) FROM outbox → outbox_hint hint persisted
    PRAGMA wal_checkpoint(TRUNCATE)           -wal is 0 bytes
    close                                     open handles 1 → 0

5 open wsp_B/relayed.db, migrate              user_version = current

6 push workspace:changed { epoch, … }         renderer drops all, repaints
                                              from LOCAL only
  ══════ USER SEES B. NO NETWORK YET. ══════  network calls so far: 0

7 auth/refresh-wsp_B.bin?  ABSENT
    → POST /auth/switch                       sessions: 2 live rows
    → write auth/refresh-wsp_B.bin            file exists, mode 0600
                                              wsp_A's session STILL LIVE

8 socket → hello(wsp_B cursors) → welcome     badges correct within 1 RTT
```

### 12.3 Flow B — switching back

Identical, except step 7:

```
7 auth/refresh-wsp_A.bin?  PRESENT
    → POST /auth/refresh                      no /auth/switch — that was one-time
```

### 12.4 Flow C — switching offline

```
1–6  identical. B renders from local.         ← the point
7    /auth/switch or /auth/refresh fails
       → state = 'stale', non-blocking banner
8    skipped
```

Nothing is lost; §13.1 already specifies this state, and reads never depended
on it.

### 12.5 Account switching

Same as a workspace switch, plus: close the current account's `account.db`,
open the target's, and load *its* `last_workspace`. `device_id` changes with the
account, by design (§8).

---

## 13. Sign-out and removal

| Event | Effect |
|---|---|
| Sign out of an account | `POST /auth/signout` for **each** stored refresh token, then `rm -rf accounts/<acc_id>` — DB, blobs, vault together |
| Removed from a workspace | membership absent from `memberships` → `state='removed'`, replica and blobs deleted, vault slot cleared |
| Token expiry / refresh failure | **Nothing is deleted.** `state='stale'`, local reads continue (§13.1) |

The middle row is why sign-out is a directory delete: §13.1 requires wiping the
database and the blob directory, and this layout makes that one operation that
cannot be half-completed.

---

## 14. Blobs

`accounts/<acc>/workspaces/<wsp>/blobs/<2-char shard>/<id>` — per workspace, not
per account, because eviction follows message eviction (§13.6), which is
per-workspace, and workspace removal must take its blobs with it.

`protocol.handle('blob', …)` in main is the one place the renderer names
something path-shaped. It **must resolve against the active workspace directory
only** and reject anything escaping it. With one workspace the question does not
arise; with N it does.

---

## 15. Guards shipped now

These cost almost nothing today and are expensive or impossible later.

### 15.1 Unknown frame types are ignored

§9.10 covers unknown **fields** and unknown **ops**, but not an unknown
top-level `t`. Cross-workspace activity (§16.2) arrives as a new frame type; if
the dispatcher throws on an unknown `t`, the day that ships, every older client
in the field breaks — exactly the delayed-and-silent class §9.10 exists to
prevent.

**Default-ignore branch on unknown `t`, before any client is in the field.**

### 15.2 `outbox_hint` written at close

One query against an already-open handle, one column. Without it, finding
workspaces with parked writes later means opening every replica.

It also makes a real consequence visible: **"until they switch back" is not
necessarily short.** Boot goes to `last_workspace`, so a message written in
workspace A can sit unsent across app restarts indefinitely. That is an accepted
consequence of one-active-workspace, not a surprise — and §10.5 already requires
a queue cap, which bounds it.

### 15.3 `Storage` never becomes a singleton

`open(workspace_id) → handle`; "active" is a handle held in a field, not a
global. Outbox functions take a handle as a parameter rather than reaching for
the active one. This is not extra work — it is the shape the switch flow needs
anyway — but it is what makes §16.1 a small addition instead of an untangling.

---

## 16. Deferred, and what unblocks each

All three are specified. None is buildable yet, and the blocker in each case is
a missing dependency rather than an unresolved design.

### 16.1 Outbox drainer — blocked on the outbox existing

The client has migrations v1 (`meta`) and v2 (`actors`, `workspaces`). The
`outbox` table is specified in §8.3 but not yet migrated, and the write path
(§10) is Phase 2. **A drainer built now would have no producer and could not be
tested.**

The flow, for when it lands:

```
1 account.db: workspaces WHERE outbox_hint > 0     → wsp_A has 3
2 read auth/refresh-wsp_A.bin                      ← still there; never deleted
3 POST /auth/refresh                               → access token for act_A
4 open wsp_A/relayed.db  DRAIN-ONLY
5 send by seq ascending, one in flight per chat (§10.5)
6 outbox_hint = 0, close
```

Needs no new auth machinery (§9). The only failure is that workspace's session
having been revoked → 401 → rows to `failed`, which §10.5 already requires a UI
affordance for.

**Unblocked by:** Phase 2 write path.

### 16.2 Cross-workspace activity — blocked on the socket

```
server → client
{ "t": "wsp_activity", "wsp": "wsp_…KVX1R",
  "chat_unread": 12, "mention_count": 2, "at": 1757280000000 }
```

Lands in `account.db.workspaces.unread_hint` / `mention_hint`. O(workspaces),
not O(messages).

Two dependencies: the WebSocket (§9, Phase 2), and messages existing to count.
Polling it over HTTP now would return zeroes.

One authorization note for when it lands: this is authorized by **the identity
behind the session, not the actor in it**. A token naming actor X yields counts
about actor Y. Same human, both actors theirs — but the server must resolve
siblings via `identity_id` explicitly rather than treating it as a natural
extension of the actor's scope.

**Unblocked by:** Phase 2 socket. Storage columns and the §15.1 guard ship now.

### 16.3 Notifications — two different features

| | Mechanism | Works unsigned? | Blocked on |
|---|---|---|---|
| **Local** notification | Electron `Notification`, app running, socket open | **yes** | Phase 2 socket + §16.2 |
| **Remote push** | APNs / FCM, app closed | **no** | **code signing** |

These are usually conflated and should not be. What this discussion has been
describing — "tell me about activity in another workspace" — is the **local**
case: the app is running, the socket is open, `wsp_activity` arrives, we raise
an OS notification. That needs no push infrastructure at all.

Remote push requires a signed and notarized app with the push entitlement, and
[`RELEASE.md`](RELEASE.md) §1 defers signing. It also needs an account-level
push-token registry server-side, which is where materializing an `accounts`
table starts paying for itself (§4).

**Unblocked by:** local — Phase 2. Remote — code signing, per RELEASE.md §12.

---

## 17. Validation

### 17.1 Unit — `node --test`

| Test | Asserts |
|---|---|
| account discovery | N directories → correct list; `max(last_active_at)` picked |
| account matching | actor-id intersection finds the right dir; disjoint sets create a new one |
| shrinking membership | a removed workspace still matches on the remaining actor, and is marked `removed` |
| independent migrations | `account.db` and `relayed.db` carry separate `user_version`s and migrate independently |
| vault keying | two workspaces → two files; clearing one leaves the other readable |
| epoch | a reply stamped with a stale epoch is dropped, not applied |
| unknown frame `t` | dispatcher ignores it and does not throw (§15.1) |
| `auto_vacuum` | still 2 on **every** newly created workspace replica (invariant 11) |

### 17.2 Integration — against a live server

| Test | Asserts |
|---|---|
| memberships returned | two actors for one identity → both present in `/auth/session` |
| explicit workspace | `workspace_id` mints for that actor |
| foreign workspace | a `workspace_id` not belonging to the identity → 403 |
| **determinism** | two actors, resolve 100×, identical result every time (the current defect) |
| **switch does not revoke** | after `/auth/switch`, workspace A's refresh token **still works** |
| switch is one-time | second entry to B uses `/auth/refresh`, and `/auth/switch` is not called |
| foreign switch | `/auth/switch` to a workspace of a different identity → 403 |
| refresh carries memberships | a workspace added server-side appears after refresh |

### 17.3 End-to-end, manual

| Scenario | Expected |
|---|---|
| create a second workspace from the switcher | two rows in `account.db`, two replica directories |
| switch A → B → A | both render; second visit to B does not call `/auth/switch` |
| **airplane mode boot** | full UI from local, no login screen, **zero network calls before first paint** |
| switch while offline | B renders from local; stale banner; no data loss |
| `kill -9` mid-switch | reopens in B, cleanly (step 2 committed first) |
| sign out account A | `accounts/acc_A` gone entirely; account B untouched |
| two accounts | separate `device_id`s; no shared rows anywhere |

### 17.4 Measured

| Metric | Target |
|---|---|
| boot → first paint, 1 account / 1 workspace | no regression against Phase 1 |
| boot → first paint, 3 accounts / 5 workspaces | < 100 ms local I/O |
| switch → repaint (steps 1–6) | < 50 ms, and **provably before any socket work** |
| network calls before `boot:ready` | **0**, asserted by instrumentation, not by observation |

The last row is the one that has bitten this project before: assert what is
observed, not what is expected (PHASE-1-IDENTITY.md §11a). Count the calls; do
not infer them from a passing render.

---

## 18. Invariants

To fold into DESIGN.md §14 at the end of Phase 1. Numbering continues from 36.

| # | Invariant | What breaks without it |
|---|---|---|
| 37 | `device_id` is per `(install, account)`, in `account.db` | Two workspaces mint two device identities for one machine; "sign out this device" becomes meaningless |
| 38 | `install-id` never enters a session token | Two accounts on one machine become correlatable server-side |
| 39 | Exactly **one** workspace is active; others may be open **drain-only** | Two cursor spaces and two socket subscriptions interleave; the renderer paints across workspaces |
| 40 | The outbox lives in the **workspace replica**, transactional with its echo | A crash between the row and the echo yields a message that looks sent and never sends |
| 41 | Every IPC envelope carries a **workspace epoch**; stale replies are dropped | A slow query from the previous workspace paints under the new one's chrome |
| 42 | `last_workspace` is committed **before** any handle or socket work | A crash mid-switch reopens the workspace the user just left |
| 43 | An unknown top-level frame `t` is **ignored**, never fatal | Adding `wsp_activity` breaks every older client in the field (§15.1) |
| 44 | `/auth/switch` **never** revokes or rotates the source session | The workspace you just left becomes undrainable and un-returnable-to offline |
| 45 | The blob protocol handler resolves **only** within the active workspace | A renderer-supplied id reaches another workspace's, or another account's, files |

---

## 19. Build order

| | Work | |
|---|---|---|
| 1 | `Storage`: paths, account discovery, open/close, active-workspace lifecycle | client |
| 2 | Split migrations: `account.db` list + workspace list | client |
| 3 | `device_id` → `account.db`; `install-id` file | client |
| 4 | Vault keyed by workspace | client |
| 5 | `/auth/session` memberships + optional `workspace_id` + `ORDER BY`; `/auth/refresh` memberships | server |
| 6 | `/auth/switch`; drop the `already_provisioned` guard | server |
| 7 | Switch flow + IPC epoch | client |
| 8 | Switcher rail + create-workspace | client |
| 9 | Guards: unknown-`t`, `outbox_hint` at close | client |
| 10 | Validation per §17 | both |

Item 8 is not polish — it is what makes items 1–7 testable end to end. Without
it there is no way to reach a second workspace, and the switch logic ships
unexercised.

---

## 20. Open questions

1. **Does `account.db` need its own `blobs/`** for account-level avatars shown
   in the switcher, or is duplicating the avatar per workspace acceptable? Cheap
   either way; deferred until the switcher has a visual design.
2. **Should `/auth/switch` be rate-limited** separately from `/auth/refresh`? It
   mints sessions, so probably yes, but the abuse case is weak — it requires a
   valid refresh token already.
3. **Materializing `accounts` server-side** — needed for push tokens (§16.3),
   makes sibling lookup a foreign key. Defer until push is real.
4. **Workspace-level eviction policy across workspaces** — §13.6 caps blob bytes
   per workspace. Does an install-wide cap belong on top? Only matters at many
   workspaces; revisit with real usage.
