# Running several clients at once, in development

Companion to [`STORAGE.md`](STORAGE.md) §5 (the local layout), [`RELEASE.md`](RELEASE.md)
§3 (how the auth callback gets back into the app) and [`SYNC-FLOWS.md`](SYNC-FLOWS.md)
§2 step 14 (the milestone this exists to make possible).

Sync is the first phase whose behaviour **cannot be seen with one client**. Every
flow worth demonstrating — a message appearing somewhere else, two people typing
while the server is down, a laptop waking to a changed world — needs at least two
installs talking to one server. One install can be tested; two must be *run*.

This document decides how. **Built and running**; §11 records what has been
verified by running it and what remains untested.

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| How many Electron processes? | **N, from one build and one dev server** | 4 |
| How do they stay isolated? | A separate `userData` per client, chosen by env var | 3 |
| Who picks the directory? | `main`, before the single-instance lock | 3 |
| How do UI edits reach all of them? | One Vite dev server; every window is an HMR client | 5 |
| How do main/preload edits reach them? | `--watch`, which the launcher turns on, plus a build-completion signal | 5 |
| What signals a restart? | electron-vite's own `closeBundle`, never a watch on `out/` | 5 |
| How do you tell the windows apart? | **A named copy of `Electron.app` per client**, plus the window title | 6 |
| Which client is which in Grafana? | By `device` and `actor` on every event and span | 7 |
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
pnpm dev                  # asks how many, in a TTY; 1 otherwise
pnpm dev --clients=3      # skip the prompt
pnpm dev --clients=2 --no-server   # server already running elsewhere
```

`pnpm dev` also starts the server, because that is what it meant before and must
keep meaning. `pnpm dev:all` is the old `pnpm -r --parallel dev` if you want it.

The prompt only appears on a TTY and never in CI, so a non-interactive run
defaults to one client and starts rather than hanging on a question nobody can
answer.

---

## 5. Edits must reach every client

This is the requirement that decides the architecture. A second window that
needs a manual restart is a second window nobody uses.

### Hot reload of main and preload was **off** until this landed

`apps/desktop`'s dev script was bare `electron-vite dev` with no `build.watch`
anywhere, so a main-process change did nothing until you restarted by hand.
Multi-client did not cause that, but it made it much more expensive — restarting
by hand is tolerable once and not three times.

The launcher passes `-w, --watch`, documented as *"rebuilds when main process or
preload script modules have changed on disk"*. **This changes the single-client
loop too**: `pnpm dev` now restarts on a main-process edit where before it sat
there. That is the intended improvement, but it is a behaviour change to the
thing you use every day, and worth knowing before it surprises you.

| Edit | What happens |
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

Three things carry the name, and only one of them is reachable from inside the
process.

**`app.setName` is not one of them.** Its contract is explicit: it overrides the
name Electron uses *internally* and "does not affect the name that the OS uses".
On macOS the first submenu of the application menu **always** carries the
application's name, read from the running bundle's `CFBundleName` — and so do the
Dock tile and the app switcher. A custom `Menu.setApplicationMenu` does not help
either: the label you give that first submenu is ignored on macOS by design. An
unpackaged dev run executes Electron's own prebuilt bundle, and that bundle is
called Electron. So the menu bar said `Electron` for every client, and nothing in
`main` could change it.

**So the bundle says it.** `scripts/dev-clients.mjs` gives each client its own
copy of Electron's `dist`, rewrites `CFBundleName` and `CFBundleDisplayName` in
its `Info.plist`, and points that client at it. The menu bar, the Dock and ⌘-Tab
then read `Relayed 1` and `Relayed 2`.

**Pointing at it takes a different knob per client**, which cost a round to
learn — client 2 was correctly named while client 1 still said `Electron`. The
siblings are spawned by the launcher, so they are simply given the copied
binary's path. Client 1 is spawned by **electron-vite**, which does *not* load
the `electron` npm shim: it reads `path.txt` and joins it to the module directory
itself, so the shim's `ELECTRON_OVERRIDE_DIST_PATH` is read by nobody on that
path. electron-vite's own override is `ELECTRON_EXEC_PATH`, which it checks
before resolving and otherwise fills in — that is what the primary is given.

Two properties make this cheap enough to sit in a dev loop rather than in a
build step:

- **The copy is free.** `cp -c` on APFS is a copy-on-write clone: 307MB in about
  a tenth of a second, and no disk consumed — free space is unchanged after
  cloning three of them. A non-APFS volume falls back to a real copy, which is
  why the result is cached under `node_modules/.cache/relayed-dev-bundles` and
  stamped with the Electron version and the intended name. An upgrade or a rename
  invalidates the stamp; nothing else does.
- **Nothing is re-signed.** Electron's dev binary is ad-hoc *linker-signed*, with
  `Info.plist=not bound` and no sealed resources — the signature covers the
  Mach-O and nothing else, so editing the plist leaves it exactly as valid as it
  was. `codesign --verify` reports the same thing, word for word, on the original
  and on the patched copy. If a future Electron ships a sealed bundle the symptom
  is a copy macOS refuses to launch, and the repair is one line:
  `codesign --force --sign - <app>`.

A failure to build the named copy is logged and the client runs from the original
bundle. This is cosmetic, and must never be the reason a dev loop will not start.

**The window title stays** regardless. It is what is in front of you at the
moment you are about to type into the wrong window, which the menu bar is not.
The one trap: the renderer sets `document.title`, which would overwrite it, so
the prefix is reapplied on `page-title-updated`.

**One name, chosen in one place.** The launcher picks it (`Relayed 2`, or plain
`Relayed` when there is only one client) and passes it as `RELAYED_CLIENT_NAME`;
`main` uses that same string for `app.setName` and the window title. Deriving it
twice is how the window and the menu bar come to disagree about which client you
are looking at.

Directories stay numbered — `relayed-client-1`, `relayed-client-2` — because the
number is what the environment variable says, and a second name to hold in your
head is a second thing to get wrong.

---

## 7. Telling them apart, in telemetry

**Answered, and by the general fix rather than a dev-only one.**

Every client still reports as `service_name="relayed-desktop"`, which is correct:
the service is the desktop app. What was missing was *who* — the sync events
(`ws.connected`, `sync.gap.entered`, `sync.backfill.page`, `outbox.op.failed` and
the rest) carried no device or actor at all, so "filter by device" worked for
exactly the events you would not be asking about.

`telemetry.identify()` closed it. Every event and every span now carries
`install`, `device`, `actor`, `workspace` and `account`, attached by the sink
rather than by each call site. Two clients on one machine are two `device` values
and, when signed in as different people, two `actor` values — so a Grafana query
separates them without knowing anything about development.

The **split** is the part to keep in mind: bounded context (`os.type`,
`host.arch`, `deployment.environment`) rides the OTLP *resource* and therefore
reaches metrics too, while the unbounded half rides each record and never touches
a metric. That is not a preference — a resource attribute is folded into a
metric's identifying label set, so a device id there is a series per device per
metric ([`OBSERVABILITY.md`](OBSERVABILITY.md) §5). `packages/telemetry/src/identity.test.ts`
asserts both halves, because the failure is silent and arrives as a bill.

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

**Messages only some people can see** need a writer no client has. Start the
server with `RELAYED_DEV_ROUTES=1` and write one by hand:

```bash
curl -X POST localhost:8787/dev/restricted-message -H 'content-type: application/json' \
  -d '{"chatId":"cht_…","authorId":"act_…","listed":["act_…"],"body":"a private notice"}'
```

The listed client shows it with "Only visible to you"; the others show nothing
and keep receiving the chat. The full check is `WORKSPACE-AGENTS-IMPL.md` §5,
by hand.

---

## 11. Status, and what is actually verified

**Built.** `scripts/dev-clients.mjs`, the `RELAYED_CLIENT` block in `main`, the
`relayed:build-signal` plugin, and a pinned renderer port.

Verified by running it:

| | |
|---|---|
| Three clients boot, three `app.boot` events | `relayed-client-1/2/3` created under Application Support |
| A main-process edit restarts **all three** | +3 boots per edit, from one signal |
| `SIGINT` takes everything down | 3 Electron processes → 0, launcher exits |
| A non-TTY run does not hang on the prompt | defaults to 1 and starts |

Three things running it found, worth keeping in mind rather than only fixing:

- **A second `pnpm dev` on top of a live one** failed as two unrelated stack
  traces a screen apart — `EADDRINUSE` from the server, "Port 5273 is already in
  use" from Vite — with the actual cause named in neither. The launcher now
  checks both ports first and says what holds them. It reports rather than kills:
  whatever owns the port is somebody's process, and a server run in another
  terminal to watch its logs is exactly what `--no-server` is for.

- **`electron-vite dev` has no `--port`.** The renderer port is pinned in
  `electron.vite.config.ts` with `strictPort`, so a busy port fails loudly
  instead of silently moving — a sibling pointed at the wrong port renders
  nothing and looks like a broken build.
- **`pnpm` does not forward a signal to its grandchild.** Killing the pnpm
  process left Electron running with its replica open, and the next run's client
  1 would have met a database another process still held — the exact failure the
  separate directories exist to prevent, reintroduced by sloppy teardown. The
  launcher spawns detached and signals the process group.

Checked against the code in this repository:

| Claim | Where |
|---|---|
| ~~`dev` is bare `electron-vite dev`; no `build.watch` anywhere~~ — **closed**: the launcher passes `--watch`, §5 | `apps/desktop/package.json`, `scripts/dev-clients.mjs` |
| `-w, --watch` is the flag that enables it | `electron-vite/dist/cli.js` |
| Restarts come from a rollup `closeBundle` hook, not a filesystem watcher | `electron-vite/dist/chunks/lib-B4dCEySN.js` |
| electron-vite forwards args after `--`, but spawns exactly one child | `cli.js`, then `spawn(electronPath, [entry].concat(args))` |
| `main` reads `ELECTRON_RENDERER_URL` to choose URL over file | `main/index.ts` |
| The storage root already comes from an environment variable | `sync/index.ts` |
| The single-instance lock runs after `app.setName` | `main/index.ts` |
| Sign-in is a loopback redirect on an ephemeral port | `sync/auth/loopback.ts` |
| ~~No sync event carries a device or client field~~ — **closed** by `identify()`, §7 | `packages/telemetry/src/index.ts`, `otlp.ts` |
| The mock world writes synthetic WorkOS references, so a real sign-in cannot join it | `scripts/mock/world.ts` |

Taken from Electron's own documentation rather than this repository, and not
verified by running: that `app.setName` changes the internal name only, and that
`app.setPath` requires an existing directory.

**Still not exercised**: signing in as two different people (§8's browser-session
problem is untested), and anything that needs a compose surface.

### What this still does not give you

- ~~**Composing a message.**~~ **Closed.** `messages.send` is `enqueue`'s first
  production caller and the chat route has a composer, so a hand-driven client
  can now type as well as receive. Two clients exchanging messages, both replicas
  level with empty outboxes, has been run.
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
