# Running several clients at once, in development

Companion to [`STORAGE.md`](STORAGE.md) §5 (the local layout), [`RELEASE.md`](RELEASE.md)
§3 (how the auth callback gets back into the app) and [`SYNC-FLOWS.md`](SYNC-FLOWS.md)
§2 step 14 (the milestone this exists to make possible).

Sync is the first phase whose behaviour **cannot be seen with one client**. Every
flow worth demonstrating — a message appearing somewhere else, two people typing
while the server is down, a laptop waking to a changed world — needs at least two
installs talking to one server. One install can be tested; two must be *run*.

This document decides how. **Nothing here is built yet**; §11 records what was
checked against the code and what is still assumption.

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| How many Electron processes? | **N, from one build and one dev server** | 4 |
| How do they stay isolated? | A separate `userData` per client, chosen by env var | 3 |
| Who picks the directory? | `main`, before the single-instance lock | 3 |
| How do UI edits reach all of them? | One Vite dev server; every window is an HMR client | 5 |
| How do main/preload edits reach them? | `--watch` — **which is not on today** — plus a build-completion signal | 5 |
| What signals a restart? | electron-vite's own `closeBundle`, never a watch on `out/` | 5 |
| How do you tell the windows apart? | **Window title.** `app.setName` is not enough | 6 |
| Which client is which in Grafana? | Not answerable today — needs an instrumentation change | 7 |
| Does sign-in need anything special? | Loopback handles the callback; the **browser session** does not | 8 |
| One server and one database, or several? | **One of each.** That is the production topology too | 9 |

---

## 2. Why the obvious approaches do not work

### `pnpm dev` three times

Each invocation starts its own Vite dev server — a port clash, which is
solvable — and its own rollup watchers, which are not. All three write to the
same `out/` directory: two processes rewriting `out/main/index.js` while a third
is reading it. The failure is a torn build that reproduces once and never again.

### `--user-data-dir`, the Chromium flag

`electron-vite dev` is a **Node CLI, not Electron**. It builds main and preload,
starts a Vite server for the renderer, and then spawns the Electron binary as a
child process — so a flag on the command line reaches the CLI, not the app.

It does forward: anything after `--` is stashed in `ELECTRON_CLI_ARGS` and
concatenated onto the spawn. Checked, not assumed. But it does not help, because
that spawn creates exactly **one** child. Three clients need three different
directories from one command, which a single argv cannot express.

So the environment variable is not a fallback for the flag. It is the right
mechanism either way, and it has the better property: it is ours, it is explicit,
and it does not depend on Chromium's argument parsing running before our code.

---

## 3. Isolation: one `userData` per client

Four lines in `main/index.ts`, and **where** they sit is load-bearing:

```ts
app.setName('Relayed');                      // existing — pins the default

const client = process.env['RELAYED_CLIENT'];
if (client && !app.isPackaged) {
  const dir = join(app.getPath('appData'), `relayed-client-${client}`);
  mkdirSync(dir, { recursive: true });       // setPath wants a real directory
  app.setPath('userData', dir);
}

// …everything else, then:
if (!app.requestSingleInstanceLock()) { … }   // existing
```

**Before the lock**, because the single-instance lock is keyed on the userData
directory. Without this, client 2 exits at startup with *"another instance
already holds the lock"* — which is the guard working correctly, protecting a
database the second process was about to open behind the first one's back.

**Before anything reads `userData`**, for the reason the existing comment at the
top of that file already records: the path was once derived from `app.getName()`
and silently changed depending on how the app was launched, and we ended up with
two databases. Setting it explicitly rather than letting the name imply it keeps
that closed.

**The directory is created first.** `app.setPath` is documented to require a path
that already exists, and the failure would land before any of our error handling.

**`!app.isPackaged`**, so a shipped build cannot be talked into a different
database directory by an environment variable. The override is a development
affordance and must not survive packaging.

Each client then gets its own everything, because the whole layout hangs off
that root (`STORAGE.md` §5):

```
relayed-client-1/            relayed-client-2/
  install-id                   install-id            ← different
  epoch                        epoch
  accounts/<acc>/              accounts/<acc>/       ← different acc
    account.db                   account.db          ← different device_id
    auth/refresh-<wsp>.bin       auth/refresh-<wsp>.bin
    workspaces/<wsp>/            workspaces/<wsp>/
      relayed.db                   relayed.db        ← the replica
```

`deviceId()` mints a fresh `dev_…` into each `account.db` on first open, so the
two are genuinely different devices rather than one device aliased twice. That
matters: outbox dedupe, multi-device read state and "sign out this device" are
all keyed on it, and a test where both clients share a device id would quietly
skip every one of those paths.

### An open decision: what happens to client 1

Client 1 can keep today's profile (`Relayed/`) or move to `relayed-client-1/`.
They are not equivalent, and the difference is felt on the first run rather than
in the code: keeping it means your existing session survives and one client is
signed in already; moving it means all N start identically from nothing, and you
sign in three times.

**Recommended: move it.** A setup where client 1 is special is a setup where a
bug that only affects clients 2..N reads as "the second window is broken" rather
than as a bug. The cost is one extra sign-in, once.

---

## 4. The shape: one build, one server, N processes

```
  electron-vite dev -w  ─┬─ builds main + preload, REBUILDS on change  ─▶  out/
                         ├─ serves the renderer                        ─▶  :5273
                         ├─ restarts client 1 itself      RELAYED_CLIENT=1
                         └─ closeBundle ──▶ signal ──┐
                                                     │
  scripts/dev-clients.mjs ──┬─ spawns clients 2..N   │    RELAYED_CLIENT=2,3
                            └─ restarts them on ◀────┘
```

Clients 2..N are plain `electron out/main/index.js` children. They need nothing
but two environment variables: `RELAYED_CLIENT` for their identity, and
`ELECTRON_RENDERER_URL` pointing at the dev server client 1 is already using —
`main` reads exactly that variable to decide between a URL and a file.

The launcher is wired behind `pnpm dev` and **defaults to one client**, so the
ordinary loop is unchanged and nobody pays for a capability they are not using.

```bash
pnpm dev                  # one client, exactly as today
pnpm dev --clients=2      # two
pnpm dev --clients=3      # three
```

---

## 5. Edits must reach every client

This is the requirement that decides the architecture. A second window that
needs a manual restart is a second window nobody uses.

### Hot reload of main and preload is **not enabled today**

`apps/desktop`'s dev script is bare `electron-vite dev`, and the config sets no
`build.watch`. So today a main-process change does nothing until you restart by
hand. Multi-client does not cause this, but it makes it much more expensive —
restarting by hand is tolerable once and not three times.

The flag exists: `-w, --watch`, documented as *"rebuilds when main process or
preload script modules have changed on disk"*. Turning it on is a prerequisite
of this design, not a detail of it, and it changes the single-client loop too —
which is a reason to land it as its own change and see what it does before
building anything on top.

| Edit | What happens, once `--watch` is on |
|---|---|
| **Renderer / UI** | One Vite dev server, HMR over a websocket. Every window is another connected client. Free, and it is most edits |
| **Main / sync engine** | Rebuild, then Electron restarts |
| **Preload** | Rebuild, then the **renderer reloads** — not a full restart |

The renderer half is free because of a property we already have rather than one
we add: the dev server does not know or care how many windows are attached.

### The restart signal must not be a watch on `out/`

An earlier draft said to watch `out/main/*` and called it "the same signal
electron-vite uses". That is wrong, and wrong in the direction that hurts.

electron-vite restarts from a **rollup plugin** (`vite:electron-watcher`) whose
`closeBundle` hook fires after a bundle is completely written. A filesystem
watcher is a different and weaker signal: it fires on the first entry point to
land, and shared chunks may still be being written. Watching `out/` would
recreate exactly the torn-build hazard §2 rejects — for clients 2..N only, which
is the worst place for it, because the symptom would look like "the extra clients
are flaky".

So the launcher restarts from a build-completion signal derived the same way:
a small dev-only plugin in `electron.vite.config.ts` that notifies on
`closeBundle`, debounced across the main and preload builds so one edit produces
one restart rather than two.

And restarting means **waiting for the previous process to exit** before
spawning its replacement. Two processes briefly sharing one `userData` is the
thing §3 exists to prevent; doing it ourselves on every rebuild would be worse
than never having isolated them.

### The restarts are not in lockstep

electron-vite restarts client 1 from its own hook; the launcher restarts the rest
from the signal. They land close together but not simultaneously. For sync work
that is arguably better than synchronised — clients reconnecting in a ragged line
is what real ones do, and invariant 31's jitter exists for exactly that — but a
test that depended on simultaneity would be testing the launcher rather than the
product.

---

## 6. Telling them apart, on screen

**`app.setName` is not sufficient.** Electron's contract is explicit that it
changes the *internal* application name, not the name the OS shows; on macOS the
menu bar and dock take their text from the bundle, which in an unpackaged dev run
is Electron's own. Setting it is still worth doing — it is what several Electron
paths derive from — but it must not be the thing you rely on to tell three
identical windows apart.

**The window title is the identifier.** It is under our control, it is visible
without switching focus, and it survives being wrong about what the dock does.
The one trap: the renderer may set `document.title`, which would overwrite it —
so the prefix has to be reapplied, or set from main in a way the page cannot
clobber.

Directories stay numbered — `relayed-client-1`, `relayed-client-2` — because the
number is what the environment variable says, and a second name to hold in your
head is a second thing to get wrong.

---

## 7. Telling them apart, in telemetry

**Not answerable today, and the gap is specific.**

Every client reports as `service_name="relayed-desktop"`, which is correct: the
service is the desktop app. But the resource context the sink attaches is *only*
the service name, and of the sync events — `ws.connected`, `ws.disconnected`,
`sync.gap.entered`, `sync.backfill.page`, `sync.cursor.stalled`, `outbox.op.failed`
and the rest — **none carries a device or client field**. Account-open and
sign-in events do; the sync path does not. So "filter by device" works for
exactly the events you would not be asking about.

Keeping ids off *metric* labels stays right ([`OBSERVABILITY.md`](OBSERVABILITY.md)
§5) — that is the cardinality rule and multi-client does not weaken it. What is
missing is on the events and spans, where high cardinality is the point.

Two candidate fixes, both needing a decision rather than a default:

- **A resource attribute on the sink** — one `device` (or dev-only `client`)
  attached alongside `service.name`, so every record from that install carries it
  without touching a single call site. Cheap, uniform, and it makes the whole
  stream filterable at once.
- **A field on the events that want it.** More deliberate, more diff, and it
  spreads an id through a catalogue that has so far been careful about them.

The first looks right, and it is a change to `OBSERVABILITY.md` §8's contract, so
it belongs in that conversation rather than being smuggled in through a dev tool.

---

## 8. Signing in as different people

The **callback** needs nothing special. Sign-in uses a loopback redirect rather
than the `relayed://` scheme: the app binds an ephemeral port on 127.0.0.1 and
waits for exactly one callback (`auth/loopback.ts`). Two clients bind two
different ports, so two browser tabs redirect to two different instances with no
contention. The custom scheme is registered for other deep links and does not
carry the OAuth callback.

It is also a **one-time** cost per client. A refresh token is persisted per
`(account, workspace)` in that client's own vault slot, so every later boot
refreshes without a browser.

**The browser session is the part that needs attention.** All clients open the
*same* system browser, which already holds a provider session — so the second
sign-in is liable to complete silently as the first person rather than prompting.
Whatever the provider's account-chooser mechanism is, signing in as a second
person needs it deliberately; otherwise you get two clients confidently logged in
as the same human and a "test" that proves nothing. This is unresolved here.

The second person joins the same workspace through the existing invitation flow.

---

## 9. One server, one database, one Grafana

Not a compromise for development — it is the topology the code implements. The
server is a single fanout tier today, and `MULTI_NODE` in `sync/retention.ts` is
written down and deliberately not built, with its trigger named: *the first time
a second server process holds connections*.

So three clients, one `pnpm --filter @relayed/server dev`, one Postgres, one LGTM
stack. The clients are isolated from each other **only** by their local storage,
which is exactly the isolation a real user has.

> **A conflict worth naming rather than inheriting.** [`STACK.md`](STACK.md) §
> *Scale posture* says "one server instance, **with Redis pub/sub from day one**".
> The code does in-process fanout and defers `LISTEN/NOTIFY`, and this document
> follows the code. Two architectural records disagree about whether a broker
> exists. It does not affect this design — one process either way — but it should
> be reconciled before somebody plans against the wrong one.

---

## 10. How to actually validate with it

Three clients, and the split matters:

| Client | Account | What it proves |
|---|---|---|
| 1 | alice | — |
| 2 | **alice** | Multi-device convergence: two installs, one person, distinct `device_id`s, shared read state |
| 3 | bob | Person-to-person delivery, and the authorization path that only exists between two actors |

Two clients on one account is the case that is easy to skip and expensive to
skip: it is where `device_id` stops being a column and starts being load-bearing.

Then the four flows from [`SYNC-FLOWS.md`](SYNC-FLOWS.md) §2 step 14 — a message
crossing, a killed server, offline composition on both, and a slept laptop.

---

## 11. Status, and what is actually verified

**Designed, not built.** Neither the `main` change nor `scripts/dev-clients.mjs`
exists.

Checked against the code in this repository:

| Claim | Where |
|---|---|
| `dev` is bare `electron-vite dev`; no `build.watch` anywhere — **main/preload hot reload is off today** | `apps/desktop/package.json`, `electron.vite.config.ts` |
| `-w, --watch` is the flag that enables it | `electron-vite/dist/cli.js` |
| Restarts come from a rollup `closeBundle` hook, not a filesystem watcher | `electron-vite/dist/chunks/lib-B4dCEySN.js` |
| electron-vite forwards args after `--`, but spawns exactly one child | `cli.js`, then `spawn(electronPath, [entry].concat(args))` |
| `main` reads `ELECTRON_RENDERER_URL` to choose URL over file | `main/index.ts` |
| The storage root already comes from an environment variable | `sync/index.ts` |
| The single-instance lock runs after `app.setName` | `main/index.ts` |
| Sign-in is a loopback redirect on an ephemeral port | `sync/auth/loopback.ts` |
| **No sync event carries a device or client field**; the sink adds only `service.name` | `packages/telemetry/src/events.ts`, `otlp.ts` |
| The mock world writes synthetic WorkOS references, so a real sign-in cannot join it | `scripts/mock/world.ts` |

Taken from Electron's own documentation rather than this repository, and not
verified by running: that `app.setName` changes the internal name only, and that
`app.setPath` requires an existing directory.

**Not exercised at all**: two Electron instances, `--watch` end to end, and the
restart path for clients 2..N. Every claim about them is design, not observation.

### What this still does not give you

- **Composing a message.** `enqueue` has no production caller — there is no
  compose surface. A hand-driven client can connect, receive, catch up and
  back-fill, but it cannot type. `scripts/mock/` drives that path directly;
  a person cannot yet.
- **Joining the mock fleet.** "One real Electron against the mock world" was
  suggested in an earlier draft and does not work as written: `scripts/mock/`
  mints synthetic `workos_org_id` and `identity_id` values and signs its own
  access tokens, so a normally signed-in desktop lands in a different
  organisation entirely. Making it work needs one of two things decided — a
  development bootstrap that enrols a real actor into a mock world, or a mock
  mode that targets a real workspace instead of creating its own.
- **Two machines.** Everything here is one host. Clock skew between real devices,
  a network that genuinely goes away rather than a gate that simulates it, and
  NAT behaviour are all out of reach.
- **Scale.** Three windows is three. Forty clients, reconnect storms and gap
  thresholds live in the load run ([`OBSERVABILITY.md`](OBSERVABILITY.md) §10c).
  The two are complementary: the mock proves the engine converges, a real client
  proves a person can watch it happen.
