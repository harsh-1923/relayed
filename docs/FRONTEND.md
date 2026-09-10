# Frontend

How the renderer is structured, how it reads, and where its state lives.
Companion to [`DESIGN.md`](DESIGN.md) §5 (process architecture), §11 (the read
path) and §13.2 (the IPC contract), which this document implements rather than
revises.

Written before the first route existed, and kept as the record of why each
decision was made rather than rewritten once it was. The shell is now built —
router, transition table, live-query client, renderer telemetry — so §14 is the
place to see what landed and what it corrected. What remains unbuilt is the
message list itself, which is what §5.4 exists to constrain in advance.

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| Which router? | **React Router v8, declarative mode, `HashRouter`** | 4 |
| Which React Router mode? | **Declarative.** We are the data-sync abstraction its docs point at | 4.1–4.4 |
| Is the workspace in the URL? | **Yes.** Everything is addressable; the engine stays its authority | 4.5 |
| What triggers a workspace switch? | **Navigation, and nothing else.** The rail navigates too | 4.5 |
| What does a route address? | **The space**, not the chat — the space is the permission unit | 4.6 |
| Where does pane state live? | **The query string.** Path = identity, query = view state | 4.7 |
| How does the renderer read? | **Our own live-query client**, 235 lines, implementing DESIGN §11. Built | 5 |
| TanStack Query? | **No.** It is priced for a cost we do not pay | 5.2 |
| A global state library? | **No.** The renderer holds no authoritative state, by design | 3 |
| How are illegal transitions prevented? | **A declared transition table**, asserted in `#set()`. Built | 7.2 |
| Is `awaitingBrowser` a flag? | **No — a status.** Binding and waiting are different states | 7.2 |
| XState? | **Yes — deferred**, trigger is the Phase 2 transport | 7.4 |
| Zod? | **Yes — deferred**, trigger is the first Phase 2 wire format | 8.3 |
| Light mode? | **Deferred, explicitly.** Dark-only until someone asks | 9 |

---

## 2. Goals and non-goals

### Goals

1. **First paint comes from disk.** R3 is a frontend requirement before it is a
   sync requirement — the renderer must not have a code path that waits on the
   network to draw.
2. **One way to read.** Every surface reads through the same client, so an
   invalidation can find every view it must refresh.
3. **Place is a value.** "Where am I" is serialisable, restorable, and
   loggable — not a tangle of booleans across five components.
4. **No second authority.** The renderer renders what the engine says is true.
   Nothing in the UI layer becomes a thing the engine has to agree with.
5. **The structure survives the message list.** The first real surface is the
   one that breaks naive architectures, so decide pagination and invalidation
   shape now, build them later.

### Non-goals

- **Server rendering, code splitting, prerendering.** All meaningless or
  actively unhelpful in a packaged desktop app that ships its own bundle.
- **A component library of our own.** shadcn owns `components/ui`. We do not
  fork it, wrap it, or theme it indirectly.
- **Renderer-side business logic.** Permission derivation, ordering, contiguity
  and retry live in the sync engine. The renderer calls `can()` to decide what
  to *draw* (`AUTHZ.md` §3) and nothing more.
- **Component-level DOM tests.** See §11.

---

## 3. The renderer has almost no state, and that is the design

Everything else follows from this, so it goes first.

`DESIGN.md` §5 puts SQLite and the socket in a `utilityProcess` and leaves the
renderer as a view. The consequence people miss is that **the renderer is then
not a place where state lives**. What looks like state in the UI is one of four
things, and each has exactly one home:

| Looks like state | Actually is | Lives in |
|---|---|---|
| Messages, chats, actors, memberships | Query results | SQLite, fetched per DESIGN §11 |
| Which space am I looking at | Place | The URL (§4.6–4.7) |
| Session, connection, sync progress | Lifecycle | The sync engine's machines (§7) |
| Composer text, hover, open menu | Ephemeral input | Component state |

There is no fifth category, and that is why there is **no global state
library** here — no Redux, no Zustand, no Jotai, no `@xstate/store`. A store
would be a fifth home, and its contents would be a copy of something that is
already authoritative somewhere else. DESIGN §11.2 already warns about the
version of this mistake that happens over IPC:

> never push full message payloads over IPC as the primary delivery mechanism.
> Push the *fact that something changed*; let the renderer query.

A global store is that same mistake made locally.

**Durable preferences are not an exception.** Sidebar width, collapsed
sections, and the last chat you had open all need to survive a quit and follow
you between devices, which makes them replica rows, not store fields.

---

## 4. Routing

### 4.1 The three modes of React Router

The modes are additive; each step up trades architectural control for
functionality.

`react-router@latest` resolves to **8.x**, not 7 — v8 landed under a new yearly
major cadence aligned to Node EOL, and it lifted the v7 future flags to
defaults rather than changing the shape of the library. The three modes, the
declarative API and `HashRouter` are all unchanged, so nothing below turns on
the version. Verified against the installed package, not assumed.

| | Declarative | Data | Framework |
|---|---|---|---|
| Top-level API | `<HashRouter>` + `<Routes>` | `createHashRouter()` + `<RouterProvider>` | `@react-router/dev` Vite plugin + `routes.ts` |
| Adds | URL matching, `<Link>`, `useNavigate`, `useParams` | loaders, actions, fetchers, per-route `ErrorBoundary`, `useNavigation`, `useBlocker`, `lazy` | typed hrefs, typed route modules, code splitting, SPA/SSR/static rendering |
| Costs | nothing | a second shape for data flow | it owns the build |

### 4.2 Why not framework mode

Two hard facts, not preferences.

**It owns the Vite build.** `electron-vite` composes three Vite configs — main,
preload, renderer. Framework mode's plugin expects to own the renderer build
and emit its own client output. Forcing them to coexist means two build systems
negotiating over one bundle.

**It has no hash-history option.** It assumes browser history served from a
path root. Our production renderer loads from `file://`, where browser history
breaks on reload. The workaround is registering a custom `app://` scheme with a
catch-all handler in main — we already do this for `relayed-blob:`, so it is
possible, but it is a moving part bought for features that do not apply here.
SSR is meaningless in a desktop app, and route-based code splitting is actively
against R3, which wants everything on disk and ready at first paint.

### 4.3 Why not data mode

More interesting, because the reason is architectural rather than mechanical.

Loaders rest on an assumption we do not have: **that fetching is expensive, so
it should start early and block the transition.** Priced against a 200 ms
network call that is an excellent trade. Our read is a SQLite query over a
MessagePort — **roughly 1 ms**. Blocking transitions, `defer`,
`shouldRevalidate` and stale-while-revalidate are all machinery sized for a
cost we do not pay.

Worse, DESIGN §11 already specifies a *different* update model. Loaders
revalidate on **navigation and after actions**. Our data changes when the
**server pushes**, which correlates with navigation not at all. Every list would
need a loader for the first read plus a subscription for every read after — two
sources of truth for one view, and the seam between them is precisely the
stale-reply class that has already produced three bugs in this codebase.

The React Router documentation reaches the same conclusion from the other side:

> Declarative Mode provides the simplest setup, making it ideal for standard
> client-side routing, existing BrowserRouter setups, **or apps using their own
> data-sync abstractions.**

We are the third case. We *are* the data-sync abstraction.

### 4.4 The decision

**Declarative mode with `HashRouter`.**

Hash rather than browser history because it survives a reload under `file://`
in production *and* under `localhost:5173` in development — the same code path
in both. That symmetry matters more here than usual: a large share of this
project's debugging cost has come from development and production differing.
Nobody sees the `#`; there is no address bar.

Not `MemoryRouter`: an HMR full reload would drop you back to the top of the
app on every file save.

**What we give up, and why it is affordable:**

- `useBlocker` for unsaved-draft guards. Drafts belong in the replica — they
  must survive a quit, so guarding a *navigation* was never the right fix.
- Per-route `ErrorBoundary`. One boundary per pane covers it, and a pane is the
  unit a user can actually recover independently.

### 4.5 Everything is in the URL, workspace included

**A URL that omits the workspace is not an address.**

Chat ids are workspace-scoped — every workspace is its own `relayed.db`
(`STORAGE.md` §5) — so `/c/C5` means something only relative to whichever
workspace happens to be active. Paste a link from another workspace and the app
looks `C5` up in the wrong replica, misses, and renders "not found" instead of
switching. Silently wrong is worse than unsupported, and it is the failure a
shared link produces every single time it crosses a workspace.

So the workspace is in the path: `#/w/:workspaceId/c/:chatId`. The **id**, not
the slug — slugs change on rename, and a renamed workspace must not invalidate
links people have already shared.

#### The model that keeps it safe

**The URL is the intent. The engine is the authority. Navigation is the only
input.**

```
  rail click   ──┐
  deep link    ──┼──▶ navigate('/w/W2/c/C5') ──▶ guard: wsId ≠ active?
  back/forward ──┘                                      │ yes
                                                        ▼
                                               workspace.switch   ← unchanged
                                                        │
                                            epoch bumps, replica opens
                                                        ▼
                                                     render
```

An earlier draft of this document kept the workspace out of the path, to avoid
binding two state machines together. That was the wrong fix for a real concern,
and it did not even achieve the thing it gave up addressability for: the rail
called `workspace.switch` **directly** while the router held place, which is
already two inputs to one piece of state.

Routing *every* switch through navigation is what actually removes the second
input. The rail's click handler becomes `navigate()` and stops calling the
engine at all. One way in, one authority.

The engine never writes the URL. The single exception is the shell's top-level
guard: when the active workspace ceases to exist — sign-out, removal, an
account switch — the shell navigates. That is a guard on a state change, which
every application has, and not a second authority.

**What does not change, which is most of it:** `switchWorkspace()` is untouched.
It already commits `last_workspace` before any handle work (invariant 42), bumps
the epoch, and returns as soon as the replica is open without waiting on a token
or a socket (`STORAGE.md` §12.2) — which is exactly what lets a pasted link
resolve while offline. And the epoch still guards stale IPC replies (invariant
41): a URL does not replace a version counter between two processes.

#### The states a cross-workspace link creates

This is the real work the decision adds. `switchWorkspace()` throws today on a
workspace absent from `account.db` — correct for the rail, which can only offer
what it holds; wrong for a link, which can name anything.

| Situation | Resolution |
|---|---|
| Local and active | Switch. The common case, and it works offline |
| Not local, account has a membership | First open on this device — `auth.activated { path: 'switch' }`, which already exists |
| Not local, an invitation is pending | Route to `/onboarding/join/:wsId` |
| Not local, no membership | "You do not have access to this workspace" |
| **Not local, and offline** | **"Cannot check while offline"** |

That last row is the one worth stating as a rule. Offline we cannot distinguish
"you are not a member" from "this device has not synced it yet", and asserting
the first is a claim the UI has no basis for. Same discipline as the `stale`
session banner: say what is actually known.

#### Deep links arrive already plumbed

[`main/deep-link.ts`](apps/desktop/src/main/deep-link.ts) is more general than
the job it was written for. It buffers URLs arriving before `whenReady`,
handles the macOS `open-url` event, the Windows/Linux argv paths, and cold
start, and forwards through the single-instance lock. It currently sinks the
OAuth callback; `relayed://w/W2/c/C5` is the same sink with a different path.

One constraint carried from `PHASE-1-IDENTITY.md` §6: `relayed://` does not
resolve unpackaged on macOS, while `isDefaultProtocolClient()` still reports
`true`. Deep links are therefore testable in a packaged build, and in
development by pasting into the app — not by clicking a browser link in a dev
loop.

### 4.6 The route table

```
/                                → last workspace's remembered location
/w/:wsId                         → that workspace's remembered location
/w/:wsId/s/:spaceId              → a space; its sole or default chat, main pane
/w/:wsId/s/:spaceId/c/:chatId    → a room's other chat, in the main pane
/w/:wsId/dm/:actorId             → resolve-or-create, redirects to /s/:spaceId
/w/:wsId/people                  → the workspace directory (already replicated)
/w/:wsId/people/:actorId         → an actor's profile
/w/:wsId/settings/members        → members and invitations (exists, no route)
/w/:wsId/settings/profile        → your actor in this workspace
/w/:wsId/search?q=               → search (Phase 4)

/onboarding/create               → pre-workspace; today's needs_workspace form
/onboarding/join/:wsId?          → pending invitations; today's PendingJoins
/account                         → sign out, devices, workspaces
```

Three things the shape encodes:

- **The path mirrors the storage tiers.** `/account` and `/onboarding` sit
  outside `/w/` because they are account-tier; everything under `/w/:wsId` is
  workspace-tier and unresolvable without that replica open (`STORAGE.md` §5).
  A route that cannot be answered from the tier its path names is a bug the
  layout makes visible.
- **One route for one table.** `/s/:spaceId` covers all four kinds, because
  `spaces` is one table discriminated by `kind`. An earlier draft split it into
  `/c/:chatId` and `/r/:spaceId`, which reintroduced at the URL exactly the
  polymorphism DESIGN §7.1 argued out of the schema.
- **The space, not the chat, is what a link is about.** §7.1: *"The chat is the
  sync unit; its space is the permission unit."* A URL is an access request,
  and access is decided at the space level — `AUTHZ.md` §7 makes space
  membership the leading conjunct. For a channel, DM or group DM the `sole`
  chat id is an implementation detail the user never sees; putting it in a
  shared link leaked structure for nothing.

`/w/:wsId` bare resolves to that workspace's remembered location, held in
`account.db` beside `outbox_hint` and `mention_hint`. So the rail still returns
you to where you left off, and a shared link still lands somewhere specific.

Note the two-level resolution this implies: `/s/:spaceId` names a space, and
the main pane needs a chat. The schema already has the primitive —
`CREATE UNIQUE INDEX chat_singleton ON chats(space_id) WHERE kind IN
('sole','default')` — so it is one indexed unique lookup, offline, and
sub-millisecond. It becomes a hook, built once, because a route param is no
longer directly a query key: the live-query client keys reads on a **topic**,
and a chat is one kind of topic (§5.1).

### 4.7 Panes are query, not path

The route table above addresses **one** thing: what is in the main pane. Every
other pane — a thread, a room's side panels, where each is scrolled — is a
query parameter.

```
?a=:messageId              anchor the main pane on a message
?t=:messageId              thread pane open
?ta=:messageId             anchor within the thread pane
?p=:chatId[,:chatId]       room chats open as side panels
```

**The principle: path = identity, query = view state.**

A path encodes *containment*. Panes are **peers in a layout**, not containers,
and encoding peers hierarchically breaks at three. Concretely, a path-based
scheme like `/s/:sid/t/:messageId/p/:chatId` has to answer:

- Is `/s/:sid/p/:chatId/t/:messageId` the same URL? It must be declared
  equivalent or one of them canonicalised — a rule with no reason behind it.
- What addresses a thread on a message **in the panel**? `t` would mean "thread
  in the main chat" in one position and "thread in the panel" in another. The
  same segment meaning different things by position is where a path stops being
  readable.
- Two panels open at once has no sane path at all.

**The test that settles it:** strip the query and the link still works — right
workspace, right space, right chat, just no thread open and at the default
scroll position. Strip a path segment and you are somewhere else entirely. A
shared link should degrade, not misfire, and that asymmetry is exactly what the
split buys.

Nothing is lost on history: `navigate('?t=M1')` pushes an entry like any other
navigation, so "back closes the thread" still works.

Worked through, for a room with a default chat `C1` and chats `C2`, `C5`:

| Situation | URL |
|---|---|
| Room, nothing else open | `/w/W/s/S` |
| Room, one panel | `/w/W/s/S?p=C2` |
| Room, thread in the default chat + a panel | `/w/W/s/S?t=M1&p=C2` |
| Working *in* `C2`, not beside it | `/w/W/s/S/c/C2` |
| Two panels | `/w/W/s/S?p=C2,C5` |
| A channel, anchored on a message | `/w/W/s/S?a=M7` |

The fourth row is the one a path-only scheme cannot express, and it is not
exotic: a room's non-default chats are chats people work in for an hour, not
permanent side panels.

**`?p=` carries chat ids**, because a room's panels *are* its chats
(DESIGN §7.1). If panels later hold surfaces that are not chats — a canvas, an
agent run — it becomes a discriminated segment. Not worth pre-building.

### 4.8 Cross-workspace history comes for free

Slack's back button crosses workspaces, re-switching as it goes. Ours now does
too, without being a feature: a `popstate` to an entry under a different
`/w/:wsId` is just a navigation, and navigation is already the thing that
requests a switch.

This was a deferred item in the earlier draft, with a trigger attached. Putting
the workspace in the path deletes it — which is a fair measure of how much the
omission was costing.

---

## 5. The read path client

### 5.1 The contract

Already specified in DESIGN §11 and not restated here beyond the shape it
forces:

```
  renderer                    sync engine
     │ ── query {id, name, args} ──▶ │  SQLite (synchronous, indexed)
     │ ◀───── rows {id, payload} ─── │
     │ ◀── invalidate {topics} ───── │  push, after any write
     │ ── refetch what is visible ─▶ │
```

Two obligations fall on the client half:

1. **A registry of mounted queries keyed by topic**, so an invalidation
   refetches what is on screen and nothing else.
2. **Keyset pagination on `ord`** (DESIGN §11.3), bidirectional, because
   jumping to a message means loading older *and* newer around an anchor.

#### The key is a topic, not a chat id — corrected while building

This section said `chat_id`, and the surface it names as the first consumer has
none: the directory reads the actors table. Rather than leave that case
unrouted, a dependency is a **topic** — colon-separated segments, coarse to
fine, of which a chat is one kind:

```
actors                     the whole directory
actors:<actorId>           one actor
chat:<chatId>              anything in one chat
chat:<chatId>:messages     only its messages
chat:<chatId>:unread       only its counters
```

**Two topics intersect when either is a prefix of the other**, and both
directions carry weight:

```
write 'chat:c_eng:messages'  must wake a sidebar subscribed to 'chat'
write 'actors'               must wake a card subscribed to 'actors:a_alice'
```

Drop the second direction and a full directory resync — which cannot say which
actors changed — leaves every open profile card showing yesterday's name,
silently. Sibling facets (`:messages` against `:meta`) never wake each other,
which is what stops a new message refetching a member list; both are still woken
by anything subscribed to `chat`.

The comparison appends `':'` before testing the prefix. Without it a write to
`chat:c_engineering` wakes everything subscribed to `chat:c_eng`, and the
symptom is a pane refetching slightly too often — which nobody investigates.

The vocabulary lives in `src/shared/topics.ts`, imported by **both** processes
and constructed rather than typed as literals. Drift between the two sides fails
silently: a topic nobody subscribes to invalidates nothing, so a typo has to be
a compile error because it cannot be a runtime one. Same reason the push channel
name is one `as const` there rather than a string literal at each end.

### 5.2 Why not TanStack Query

`STACK.md` §5 lists it. It is currently installed nowhere and imported nowhere,
so this is a decision rather than a reversal.

The argument against is the 1 ms figure. TanStack Query is a **server-state
cache**, and every one of its core features exists to avoid a network round
trip: deduplication, `staleTime`, background refetch, retry, refetch on window
focus. Against a 200 ms call that is enormous value. Against a 1 ms local read
it is machinery in service of a cost we do not have — and we would be switching
most of it off (`staleTime: Infinity`, `refetchOnWindowFocus: false`,
`retry: false`, no `refetchInterval`) to stop it fighting our invalidation.

What remains after switching that off is a keyed registry and
`useInfiniteQuery`. The registry is the ~40 lines we would write anyway.
`useInfiniteQuery` is single-direction by design and is at its most awkward
exactly where we need it most: **bidirectional paging around an anchor.**

**Keep TanStack Virtual.** Different library, no such conflict, and windowing a
message list is not a thing to hand-roll.

**What would change this:** if the invalidation registry grows past roughly
150 lines, or if we find ourselves reimplementing request deduplication,
buying it is better than growing it. `STACK.md` §5 should record the decision
either way.

**Measured, now it is built:** the registry is **125 code lines** (206 with
comments), so the trigger did not fire — though not by much, and the number is
worth re-checking when anchored paging lands. The client as a whole is 235 code
lines across four files: registry, hook, catalogue, topics.

One TanStack feature we did rebuild: two components reading the same
`(name, args)` share one entry and one fetch. That is request deduplication, and
it is five lines of refcount rather than a subsystem — so it is named here as a
partial hit on the trigger rather than left for someone to notice.

### 5.3 The hook

```ts
// One subscription per (name, args). useSyncExternalStore rather than useState
// so a push and a React render can never disagree about which is newer.
const { rows, status } = useQuery('messages.page', { chatId, before: cursor });
```

`status` is the three-state matrix of §6.2, not a boolean — **plus a fourth
value, `loading`**, added while building. The first local read is
sub-millisecond but not free, and a surface rendering its empty copy for that
millisecond tells the user "nothing here" about a directory that is about to
appear. That is a wrong answer, not a slow one, and telling the two apart is the
point of the matrix.

A read that **fails** keeps the rows it already had and reports the error
alongside them. Reporting a failed read as an empty result would paint "nothing
here" over a populated replica, which is the one failure this architecture
exists to prevent.

### 5.4 What must be true before the message list is built

Recorded here because it constrains the query contract, not the component:

- Queries are **named and closed**, never SQL from the renderer (DESIGN §13.2).
- A page is **50 rows, keyset on `ord`**, never `OFFSET`.
- A query declares which **topics** it depends on, in the catalogue beside the
  query rather than at the call site, so the registry can route an invalidation
  without inspecting arguments and no surface can get its own dependencies wrong.
- An anchored read takes `{ around: ord, before: n, after: n }` — one call, not
  two, so the pane never renders a half-loaded window. This is what §4.7's
  `?a=` and `?ta=` resolve into, one per pane.
- **Resolving a space to its main chat is a query too.** `/s/:spaceId` names a
  space; the pane needs a chat. `chat_singleton` makes it one indexed unique
  lookup, but it is a lookup, so it belongs in the client as a hook rather than
  repeated per surface (§4.6).

---

## 6. Structure and conventions

### 6.1 Directory layout

Feature-first below the shell, type-first only where a library owns the folder.

```
renderer/
  app/          shell: router, providers, layout frames, error boundaries
  routes/       one file per route in §4.6; thin — composition, not logic
  features/
    chat/       message list, composer, thread pane
    directory/  people, profiles
    settings/   members, invitations, profile
    identity/   sign-in, onboarding, account
  components/ui shadcn. Untouched, unwrapped, not themed indirectly.
  lib/          the live-query client, blob helpers, formatting
  hooks/        cross-feature hooks only
```

`main.tsx`'s five components move out as they are: `Switcher` → `app/`,
`Identity` / `WorkspaceForm` / `PendingJoins` → `features/identity/`,
`Invitations` → `features/settings/`.

### 6.2 The three-state matrix

Every surface must render correctly in three states, and they are not
interchangeable:

| State | Means | Wrong answer |
|---|---|---|
| **Empty** | Replica has no rows yet — first boot, or never opened | A spinner that never resolves offline |
| **Populated + offline** | Rows on disk, no network | An error, or a disabled UI |
| **Live** | Rows on disk, socket connected | — |

This is not polish. It is the product: a local-first app that shows a spinner
on a plane has failed at the only thing that distinguishes it. The airplane
toggle built in Phase 1 (`STORAGE.md` §16.2a) is the harness, and §11's
validation uses it.

### 6.3 Two more boundary rules

Same reasoning as the existing five — a rule that is only written down is a
rule that decays. Both are worth adding while there is one place to fix rather
than forty.

**`routing/switch-only-in-the-gate` — built.** `workspace.switch` may appear
only in `app/WorkspaceGate.tsx`. This is the rule the whole of §4.5 rests on:
the workspace is safe to keep in the URL for exactly one reason, which is that
navigation is the only way a switch starts. A second caller restores the two
authorities the design exists to avoid.

Cross-verified in both directions — the rail calling the engine fails, a route
naming the op fails, the gate passes.

**`renderer/no-direct-query` — built.** Components read through the live-query
client, never `window.relayed.query` directly. Allowed: `renderer/lib/query/`,
and imperative command calls (`auth.signIn`, `invite.create`), which are writes
rather than reads.

The rule takes its list of read ops **from `query/catalogue.ts` itself** and
throws if it cannot parse it. A hand-copied list drifts, and drifting the wrong
way silently stops covering a query — so adding a read to the catalogue is what
makes the rule cover it, with nothing to remember. Verified by planting a direct
read in a route: the build failed.

**`renderer/no-telemetry-sdk` — built, with the transport (§10).** A value
import of `@relayed/telemetry` from the renderer fails; a type-only import
passes. A second SDK in the renderer means a second flush timer, and a renderer
timer is the one place a timer cannot be trusted — Chromium throttles a hidden
page to roughly one tick a minute (DESIGN §13.9), so telemetry would stop
draining exactly when the window is in the background.

That makes it three, not two — the count in this heading is deliberately not
maintained; `tools/check-boundaries.mjs` is the list.

### 6.4 A shortcut registry — the seam, not the feature

`cmdk` is already a dependency. One registry that keybindings register into is
about 30 lines and is painful to retrofit once forty components own their own
`keydown` handlers. Build the seam with the shell; leave the palette for later.

---

## 7. State machines

### 7.1 What this addressed

`session.ts` was already a state machine, hand-rolled: a status union with
`#set()` as its transition function, and **nine** `#set()` calls each naming a
DESTINATION while not one named a legal SOURCE.

It had the classic defect. Two variables described one lifecycle:
`#state.status`, and a separate nullable `#attempt` exposed as
`isAwaitingBrowser` and surfaced to the renderer as a **sibling** of `auth`
rather than a member of it. `authenticated + awaitingBrowser: true` was
representable and meant nothing.

That is also where the hang lived: a state whose only exit was a five-minute
timeout.

### 7.2 The transition table — built

Two changes, and the smaller-looking one mattered more.

**`awaiting_browser` is a status, not a flag.** Folding the boolean into the
union was the option on the table; making it a state was better, and the reason
came from trying the XState port (§7.4a): the flag conflated two things. Binding
the loopback socket and waiting on a person in a browser are different — one has
nothing to cancel and no link to re-open, the other has both. The renderer now
asks `auth.status === 'awaiting_browser'` instead of reading a second field, and
`AppState.awaitingBrowser` is gone from the IPC contract entirely.

The state is entered **after** `openBrowser` returns, not before. A state that
becomes true one tick before the thing it is named for is a state that lies, and
the test helper polls on exactly that.

**The edges are declared**, in `auth/transitions.ts`, asserted from `#set()` —
the one chokepoint. Six statuses admit thirty-six ordered pairs; twenty-two of
them mean something, and before this nobody had said which.

Writing it forced two answers that a guess would have got wrong:

- **`signed_out → authenticated`** and **`signed_out → stale`** are legal and
  common. A boot with a stored credential refreshes straight through; no browser
  is involved, so it never passes through `authenticating`. Both were missing
  from the sketch this section used to carry.
- **`authenticated → authenticating` is rejected**, while
  **`stale → authenticating` is allowed**. Signing in while signed in has no
  meaning today; re-authenticating a stale session is the natural recovery, and
  the edge is declared ahead of the button that will use it.

Policy at the chokepoint: **throw in development, `count()` in production.** A
crash is right where a person can act on it and wrong in a user's app, where an
unexpected state must never close the read path.

Validated exhaustively over `Status × Status`, with the counts asserted so that
widening the table is a failing test rather than a quiet loosening. Negative
control: deleting one edge fails three tests — including a real boot path, which
is what proves the assert runs on live code and not only in its own unit test.

### 7.3 What the table does not catch, stated plainly

**It would not have caught the sign-in hang.** The status was `authenticating`,
which has three perfectly legal exits. The bug was that nothing ever *fired*
one, because the loopback listener's teardown left the promise pending.

A transition table rejects **illegal** transitions. It says nothing about
**absent** ones. Catching those needs a deadline on the state — and the states
that need deadlines are exactly the ones that wait on the outside world.

### 7.4 XState: the trigger, and what it buys

**Trigger: writing the Phase 2 transport.** Port `session.ts` at the same time,
so the process has one idiom rather than two.

**Scope correction.** An earlier draft claimed three parallel regions —
connection, cursor, token. The cursor is not a region: catch-up is **per chat**,
iterating every chat where `synced_through_rev < server_head_rev` across ~150 of
them, with `has_gap` as a column (DESIGN §9.3). That is a loop over a table, and
`spikes/sync-model.mjs` already models it in 66 assertions with no machine
anywhere. Backfill is request/response paging; the outbox is a status column and
a drain loop. What is genuinely machine-shaped is **connection health** — about
five states with two timers — which is the same size as auth.

So the honest tally is two small machines, not one large one, and the case rests
on one property rather than on breadth: **resource cleanup on exit paths.** Both
Phase 1 bugs in this area were cleanup that did not run on an exit path — the
loopback teardown that cleared its own timer and stranded every awaiter, and the
re-entrancy that fired `directory.synced` four times. `invoke` plus
cancel-on-exit and `after` make that class structural, and the socket is the
longest-lived resource in the app.

**Kill criterion, checkable when the transport lands:** write the connection
machine, then estimate the hand-rolled equivalent. If it is under ~60 lines with
no timer-cancellation subtlety, the dependency has not paid — drop it.

Not before. Rewriting a working auth machine now buys three bugs we have
already fixed by hand. The connection lifecycle is a different matter, because
it is genuinely beyond what an enum and `#set()` survive:

```ts
// apps/desktop/src/sync/transport/connection.machine.ts — Phase 2, not built.
// Sketch, to make the argument concrete rather than to be copied verbatim.
import { setup, assign, fromCallback, fromPromise } from 'xstate';

export const connection = setup({
  types: {} as {
    context: { attempt: number; cursorRev: number; headRev: number };
    events:
      | { type: 'online' } | { type: 'offline' }
      | { type: 'frame.welcome'; headRev: number }
      | { type: 'frame.event'; rev: number }
      | { type: 'frame.pong' }
      | { type: 'socket.closed'; code: number }
      | { type: 'token.expiring' };
  },
  guards: {
    // Invariant 1, as a guard rather than as an `if` somewhere in a handler.
    contiguous: ({ context, event }) =>
      event.type === 'frame.event' && event.rev === context.cursorRev + 1,
  },
  delays: {
    // Named properties of the machine, so the heartbeat deadline and the
    // backoff curve are visible together instead of buried in two setTimeouts.
    heartbeat: 30_000,
    backoff: ({ context }) => Math.min(1_000 * 2 ** context.attempt, 30_000),
  },
  actors: {
    socket: fromCallback(({ sendBack }) => { /* guardConnect(gate, url) */ }),
    catchup: fromPromise(async () => { /* keyset pages, DESIGN §9.3 */ }),
  },
}).createMachine({
  id: 'connection',
  type: 'parallel',
  states: {

    // ── region 1: is there a socket ────────────────────────────────────────
    link: {
      initial: 'disconnected',
      states: {
        disconnected: { on: { online: 'connecting' } },
        connecting: {
          invoke: { src: 'socket', id: 'sock' },
          on: { 'frame.welcome': { target: 'live', actions: 'recordHead' } },
          after: { 10_000: 'backoff' },
        },
        live: {
          entry: 'emitConnected',            // ws.connected — declared, unwired
          // THE DEADLINE. Its absence is what the sign-in hang was, and
          // invariant 30 becomes a property of the state rather than a rule
          // someone has to remember to enforce.
          after: { heartbeat: 'zombie' },
          on: {
            // Re-entering `live` restarts the `after` timer. That is the entire
            // heartbeat mechanism, in one line.
            'frame.pong': { target: 'live', reenter: true },
            'frame.event': [
              { guard: 'contiguous', actions: 'applyEvent' },
              { target: '#connection.data.catchingUp' },   // a gap, DESIGN §9.3
            ],
            'socket.closed': 'backoff',
          },
        },
        zombie: { entry: 'emitZombie', always: 'backoff' },
        backoff: {
          entry: assign({ attempt: ({ context }) => context.attempt + 1 }),
          after: { backoff: 'connecting' },
          on: { offline: 'disconnected' },
        },
      },
    },

    // ── region 2: is the cursor caught up ──────────────────────────────────
    data: {
      initial: 'idle',
      states: {
        idle: {},
        catchingUp: {
          entry: 'emitGapEntered',           // sync.gap.entered
          // Entering starts it; LEAVING CANCELS IT. That is the class of bug
          // `directory.synced` firing four times per boot belonged to.
          invoke: { src: 'catchup', onDone: 'idle', onError: 'idle' },
        },
      },
    },

    // ── region 3: is the token fresh ───────────────────────────────────────
    auth: {
      initial: 'fresh',
      states: {
        fresh: { on: { 'token.expiring': 'reauthing' } },
        reauthing: { /* in-band refresh, DESIGN §9.7 */ },
      },
    },
  },
});
```

Four things in that sketch are the whole argument:

1. **`after: { heartbeat: 'zombie' }`** — the deadline §7.3 says a table cannot
   give. Invariant 30 stops being a rule and becomes a property.
2. **Three parallel regions.** The socket can be live while catch-up runs while
   a token refresh is in flight. Hand-rolled that is three booleans and their
   eight combinations, checked by hand at every branch.
3. **`invoke` on `catchingUp`.** Entering starts the actor; leaving cancels it.
   The `directory.synced`-fired-four-times bug was re-entrancy that this makes
   structurally impossible.
4. **Entry actions emit the telemetry.** The nine events declared in
   `packages/telemetry/src/events.ts` with no call sites — `ws.connected`,
   `ws.zombie.detected`, `sync.gap.entered` and the rest — are *transitions*.
   Emitting them as entry actions means they cannot drift out of step with the
   state they claim to describe. Same argument as the boundary rules: make the
   invariant structural rather than remembered.

Bundle size does not enter into it: this runs in the `utilityProcess`.

Ported, the auth machine's payoff is smaller but real —
`AppState.auth.status` becomes literally `snapshot.value`, and
`awaitingBrowser` becomes a state:

```ts
authenticating: {
  initial: 'awaitingBrowser',
  states: {
    awaitingBrowser: {
      invoke: { src: 'loopback', onDone: '#auth.exchanging', onError: '#auth.signedOut' },
      after: { 300_000: '#auth.signedOut' },        // the five minutes, declared
      on: { cancel: '#auth.signedOut', reopen: { actions: 'openBrowserAgain' } },
    },
    // …
  },
},
```

`cancel` and `reopen` — the two affordances added after the hang — are now
visibly transitions *of that state*, rather than methods that have to check
whether they are legal to call.

### 7.4a The XState port, tried and reverted

Tried early, against this document's own trigger, and reverted. Recorded because
the result was informative rather than neutral.

It worked — 707 lines against 376, all tests green — and it produced two
regressions that only the existing tests caught: the session was published to
context *after* `onSession` ran, so the directory sync read a null token and gave
up silently on every first sign-in; and `isAwaitingBrowser` went false during the
token exchange, flashing the renderer back to a "Sign in" button mid-flow.

Three things came out of it and were kept:

1. **`awaiting_browser` as a state** (§7.2). The port forced the binding/waiting
   distinction the flag had hidden.
2. **A regression test for the adopt path**, which had none. Every one of the
   twelve session tests exercised a path that *fails*; none exercised the one
   that succeeds, which is why the ordering bug was invisible.
3. **A corrected estimate of the transport** (§7.4). It is smaller than this
   document claimed.

### 7.5 What XState is not for here

- **Not in the renderer.** §3 explains why: there is no state there to manage.
  Adding a state library to the layer we deliberately emptied is a category
  error, however good the library.
- **Not mirrored across the IPC boundary.** The renderer receives
  `snapshot.value` plus a context slice and sends events. A second machine kept
  in sync with the first is §4.5's bidirectional-binding trap wearing a
  different hat.
- **Not a replacement for the epoch.** Two processes still need a version guard
  on replies (invariant 41). The machine lives in one of them.
- **Not for data.** Chats, messages and actors stay in SQLite. A machine with
  forty states, half of which are really rows, is the standard way this goes
  wrong.
- **`@xstate/store` is a different library** — a Zustand-like event store, no
  statecharts. §3's answer applies to it, and the answer is no.

---

## 8. Validation at the boundaries

### 8.1 Zod and state machines are orthogonal

Worth stating because they look adjacent and are not:

> **Zod constrains nodes. A machine constrains edges.**

Zod validates a value in isolation — "is this a legal shape right now?" It has
no memory of the previous value, so it cannot express "from *here* you may only
go *there*". A path is a sequence of transitions, and Zod has no graph.

Concretely, on our own code: Zod (or a plain TypeScript discriminated union)
can make `authenticated + awaitingBrowser: true` unrepresentable. Neither can
stop `signed_out → authenticated` skipping `authenticating` entirely.

The corollary matters for scoping: `AuthState` is *already* a discriminated
union, so **Zod adds nothing to internal state**. It earns its place only where
a value crosses a boundary at which the type is a claim rather than a fact.

### 8.2 The four boundaries

Zod is listed in `STACK.md` §5, installed nowhere, imported nowhere. The server
validates like this today, in `apps/server/src/auth/invitations.ts:56`:

```ts
const email = (req.body?.email ?? '').trim();
```

No schema anywhere in `apps/server`, and Fastify's own `schema:` option unused.
These are the four places that need one.

**(a) Server responses the client parses.** This is the boundary that has
already produced a real bug: `/auth/refresh` returned no `actor`, the type said
it would, and the client silently dropped memberships — which made
`STORAGE.md` §10.3 false from the day it was written.

```ts
// apps/desktop/src/sync/auth/wire.ts
const Actor = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member']),
});

const RefreshResponse = z.object({
  accessToken: z.string(),
  expiresAt: z.number().int(),
  actor: Actor,                    // <- the field that was missing
  memberships: z.array(z.tuple([z.string(), z.enum(['owner','admin','member'])])),
});

const parsed = RefreshResponse.safeParse(await res.json());
if (!parsed.success) {
  // A contract violation is `stale`, not a crash: local data is unaffected and
  // the UI already knows how to say "could not refresh".
  count('auth.contract_violation');
  return this.#set({ status: 'stale', actor, reason: 'malformed_refresh' });
}
```

The bug becomes a named failure at the boundary instead of `undefined`
propagating four layers inward.

**(b) Socket frames — and this one is subtle.** The obvious move is
`z.discriminatedUnion('t', [...])` on the envelope. **That would violate
invariant 43**, which says an unknown top-level frame `t` is ignored and never
fatal — the property that lets us add frame types without breaking clients in
the field (DESIGN §9.10).

The correct shape parses the envelope strictly and dispatches leniently:

```ts
// The envelope is ours and stable. Parse it strictly.
const Envelope = z.object({
  t: z.string(),
  rev: z.number().int().optional(),
  traceparent: z.string().optional(),
  body: z.unknown(),
});

// Bodies are looked up by `t`, NOT unioned — a union rejects what it does not
// know, and invariant 43 requires us to ignore it instead.
const BODIES: Record<string, z.ZodTypeAny> = {
  welcome: WelcomeBody,
  event:   EventBody,
  gap:     GapBody,
  counters: CountersBody,
};

export function readFrame(raw: unknown) {
  const env = Envelope.safeParse(raw);
  if (!env.success) return { kind: 'malformed' } as const;

  const body = BODIES[env.data.t];
  if (!body) {
    // Invariant 43: forward compatibility is a behaviour, not a comment.
    count('sync.frame.unknown');
    return { kind: 'ignored', t: env.data.t } as const;
  }
  const parsed = body.safeParse(env.data.body);
  return parsed.success
    ? { kind: 'frame', t: env.data.t, body: parsed.data } as const
    : { kind: 'malformed' } as const;
}
```

Zod objects strip unknown keys rather than rejecting them, which is exactly
what DESIGN §9.10 needs at the field level too: a server that adds a field does not
break an older client.

**(c) Server request bodies.** Replacing the hand-rolled checks, and returning
the same `400` shape the client already handles:

```ts
const CreateInvite = z.object({ email: z.string().email() });

const parsed = CreateInvite.safeParse(req.body);
if (!parsed.success) return reply.code(400).send({ error: 'invalid_email' });
// can() still gates the action; validation is about shape, never permission.
```

**(d) Telemetry ingest, derived rather than duplicated.** `OBSERVABILITY.md`
§8 already says the server validates incoming client telemetry against the
event catalogue. That schema should be **generated from the catalogue**, not
written a second time — the same principle that keeps one `can()` shared
between client and server rather than two that drift:

```ts
// apps/server/src/telemetry/ingest.ts
// `FieldType` is internal to events.ts today; this needs it re-exported from
// the package index — one line, and the only change the catalogue requires.
import { events, type FieldType } from '@relayed/telemetry';

const FIELD: Record<FieldType, z.ZodTypeAny> = {
  id:   z.string().max(64),
  int:  z.number().int(),
  ms:   z.number().nonnegative(),
  bool: z.boolean(),
  enum: z.string().max(32),
};

// One source of truth. Adding an event to the catalogue extends the ingest
// schema; there is no second list to forget.
export const INGEST = Object.fromEntries(
  Object.entries(events).map(([name, spec]) => [
    name,
    z.object(Object.fromEntries(
      Object.entries(spec.fields).map(([f, t]) => [f, FIELD[t as FieldType]]),
    )),
  ]),
);
```

### 8.3 The trigger, and where Zod does not go

**Trigger: the first Phase 2 wire format** — item 14 in `DESIGN.md` §15, where
frames become real. Adopt it for (a) and (b) together, then backfill (c) and
(d), which are small once the idiom exists.

Not before, because today's only wire consumer is the auth client, and it is
about to be rewritten anyway.

**Where it does not go — worth stating, because "validate everything" is the
standard failure mode:**

- **Not on rows read back from our own SQLite.** We wrote them, in a schema we
  migrated. Parsing them pays for a boundary that is not one, on the hot path
  that R3 is measured against.
- **Not on internal function arguments.** TypeScript already covers those, and
  a runtime check there is a test that never fails.
- **Not as the type source.** Hand-written SQL stays the artifact
  (`STACK.md` §5); Zod schemas describe *wire* shapes, not storage.

Version: resolve at adoption, per `STACK.md` §5's convention. Zod 4 is current;
the constructs used above are stable across 3 and 4.

---

## 9. Theming, deferred explicitly

Dark-only, as today: `index.html` sets `class="dark"`, and `index.css` sets
`color-scheme` so the engine paints chrome to match.

Recorded as a deferral rather than left implicit, because half-building light
mode is how token systems end up written twice. Until the trigger fires, **no
component may hardcode a colour** — every colour comes from a shadcn token, so
that adding light mode later is a token file rather than an audit.

**Trigger:** the first person outside the team uses it, or a screenshot has to
go in a document with a light background.

---

## 10. Telemetry from the renderer

**Built.** `OBSERVABILITY.md` §3's client forwarding exists: `lib/telemetry.ts`
forwards catalogued records over the port the renderer already holds, and the
sync process emits them. The renderer holds no SDK and must not — a second one
means a second flush timer, and Chromium throttles a hidden page to roughly one
tick a minute (DESIGN §13.9), so it would stop draining exactly when the window
is in the background. `renderer/no-telemetry-sdk` enforces it (§6.3).

The catalogue still binds the renderer at compile time, through a
`@relayed/telemetry/catalogue` entry point that carries the types without the
SDK. A type-only import of the main entry was not enough — TypeScript still
checks the module, and it reaches for `process` and node timers.

All three of the minimums this section originally named landed:

- `ui.route.changed { from, to, workspace }` — an event, so it may carry ids.
- First paint is now reported **by the renderer**, after the frame commits, as
  `ui.paint`. It did not replace `app.boot`: that one stops when the renderer
  *could* paint, and the same moment closes R3's network-counting window. Moving
  that window here would count ordinary sync traffic as a violation, so they are
  two numbers and the dashboard shows the gap between them.
- The three-state matrix (§6.2) is a metric, `ui.surface.state`, counted on
  transition rather than per render.

Beyond them, the read path reports whether it is working at all:
`ui.query.duration` (is a local read still ~1 ms — the figure §4.3 and §5.2 both
rest on), `sync.invalidate` against `ui.query.woken` (pushes emitted against
reads actually woken), and a shared `invalidation` id that reassembles one loop
across both processes in a single LogQL filter (`OBSERVABILITY.md` §10b).

Ids stay in events and spans, never in metric labels (`OBSERVABILITY.md` §5).

---

## 11. Validation

What gets tested, given that no DOM testing exists today and none is proposed.

| # | Claim | How |
|---|---|---|
| 1 | The transition table rejects an undeclared edge | Unit: every pair in `Status × Status`; assert exactly the ten declared pass. Negative control — delete an edge, the test must fail |
| 2 | Switching workspaces lands on the remembered location | Two workspaces, navigate in each, switch twice, assert the location both times |
| 3 | Nothing calls `workspace.switch` except the route guard | A boundary-rule pattern. Cheap, and it is the single check that keeps §4.5 true as surfaces multiply |
| 4 | A link into a non-active workspace switches, then lands | Navigate to `/w/W2/c/C5` with W1 active; assert the epoch bumped and the chat rendered, in that order |
| 5 | The same link **offline** says "cannot check", not "no access" | Airplane toggle plus a workspace id absent from `account.db`. Negative control — the online path must still say "no access" |
| 6 | A link into a workspace that is local and active resolves **with no network at all** | `withoutNetwork()`; this is the property that makes a pasted link work on a plane |
| 7 | Stripping the query from any URL still resolves | Generate every §4.7 shape, drop the query, assert each still names a real space and chat. This is the property that makes a shared link degrade rather than misfire |
| 8 | An invalidation refetches only mounted queries | **Written.** Register three, invalidate one topic, assert one refetch — with the negative control below, plus unmount, shared entries, out-of-order replies and a push that woke nothing |
| 9 | Every surface renders in all three states of §6.2 | Airplane toggle + a fresh profile; manual for now, per surface |
| 10 | R3 holds through the router | The existing `boot.test.ts` — `withoutNetwork()` removes `fetch` entirely — must still pass once the shell is routed |

Test 10 matters most: the router is new code between boot and first paint, and
R3 is the requirement most easily broken by accident there.

Tests 5 and 6 are the ones this document got wrong first time round, so they
are written as the record of it: a cross-workspace link must resolve offline
when it can, and must refuse to guess when it cannot.

Negative controls on 1, 5 and 8 specifically, because all three are the kind of
test that passes for the wrong reason — the authz spike and the metric
call-site test both did.

Test 8's control turned out to matter exactly as predicted: "invalidate one,
assert one refetch" also passes when nothing refetches at all. The paired test
invalidates a topic all three reads depend on and asserts all three wake.

---

## 12. Invariants

To fold into `DESIGN.md` §14. Numbering continues from 54.

| # | Invariant | What breaks without it |
|---|---|---|
| 55 | A URL **names the workspace it addresses** | A shared link resolves against whichever workspace happens to be active, misses, and reads as "deleted" |
| 56 | Every switch enters through **navigation**; nothing else calls `workspace.switch` | Two inputs to one piece of state, disagreeing exactly while a switch is in flight |
| 57 | The engine **never writes the URL**, except the shell's guard when the active workspace ceases to exist | The URL and the engine begin correcting each other, and a switch in flight oscillates |
| 58 | Offline, an unresolvable workspace is **"cannot check"**, never **"no access"** | The UI asserts a permission fact it has no basis for, and a plane looks like a revocation |
| 59 | A route addresses a **space**; pane state lives in the **query** | Peer panes get encoded as nested path segments, where the same segment means different things by position and two panels have no address at all |
| 60 | Every renderer read goes through the live-query client | An invalidation cannot find the views it must refresh, and the ones it misses go stale with no symptom |
| 61 | The renderer holds no authoritative state — only query results, place, and ephemeral input | DESIGN §5's guarantee dissolves quietly; two processes start disagreeing about what is true |
| 62 | Every lifecycle transition is **declared**; an undeclared edge is rejected | An enum with five values silently admits twenty-five paths, and the wrong ones surface in production |
| 63 | A lifecycle flag lives **inside** the state it belongs to, never beside it | `authenticated + awaitingBrowser: true` is representable, meaningless, and reachable |
| 64 | Every state that waits on the outside world carries a **deadline** | Nothing fires the transition and the UI waits for ever — the sign-in hang, generalised. The other half of invariant 54 |
| 65 | Every value crossing a process or a wire is **parsed**, not asserted | The type says `actor` is there, the wire disagrees, and the client drops data in silence |
| 66 | An unknown **field** is dropped and an unknown **frame** is ignored — neither is fatal | Adding a field or a frame type breaks every client already in the field (invariant 43's client half) |
| 67 | Every surface renders correctly **empty**, **offline-with-data**, and **live** | Offline correctness is asserted in a document and discovered false by a user on a plane |
| 68 | The write side and the read side name dependencies from **one shared topic vocabulary** | They drift, a write announces a topic nobody subscribes to, and every open surface goes stale — with no error, no spinner and nothing in a log |
| 69 | Telemetry leaves the renderer **through the port**, never a second SDK | A renderer flush timer is throttled to ~1 tick/minute when the window is hidden (DESIGN §13.9), so telemetry stops draining exactly when it is least observed |
| 70 | A **failed read keeps the rows it had** and reports the error beside them | A failed read rendered as an empty result paints "nothing here" over a populated replica — the one failure local-first exists to prevent |
| 71 | No frame carries a collection sized by the **workspace** rather than by the **actor** | `welcome` grows with the company rather than with what a person joined (`DESIGN.md` §9.9) |

---

## 13. Open questions

1. **Where the remembered location lives.** §4.6 says `account.db`, beside the
   other per-workspace hints. But a location referencing a chat that was
   deleted while you were away needs a fallback, and "first space" is not
   obviously right for a workspace whose spaces you have just lost access to.
   Settle with the first real space list.
2. **A permalink to an evicted message.** §4.7 gives the address — `?a=` and
   `?ta=` — and §5.4 gives the query shape. What is undecided is the behaviour
   when the target is not held locally, because retention evicted it
   (DESIGN §13.6) or this device never had it. The pane must backfill before it
   can render, which is the one place a link legitimately waits on the network;
   what it shows meanwhile, and what it shows when offline, is unspecified.
3. **Whether the thread pane survives navigation.** §4.7 makes it `?t=`, which
   is addressable and creates a history entry — both wanted. But navigating
   from `/s/S1?t=M1` to `/s/S2` drops it, and Slack keeps the thread pane open
   across channel switches. Preserving it means carrying `?t=` forward on
   navigation, which makes the query sticky in a way the rest of it is not.
   Decide when the thread surface is built, not before.
4. **Multi-window.** DESIGN §13.2 says "multiple windows are normal" and the sync
   engine already tracks N ports, but `STORAGE.md`'s one-active-workspace rule
   means two windows cannot show two workspaces. Two windows on the *same*
   workspace works today and nothing in this document prevents it; the
   cross-workspace case needs a decision that is not a frontend one.
5. **Optimistic UI and the composer.** DESIGN §10.2 specifies optimistic apply in the
   engine. What the renderer shows for a message that is written, unsent, and
   possibly failing — and how that interacts with the outbox hint already on
   the rail — is unspecified.
6. **Whether `can()` needs space and chat grants on the client.** `AUTHZ.md`
   §14 item 5 holds this open. The route table's `/r/:spaceId` is the first
   surface that will need an answer.

---

## 14. Build order

Slotted into `DESIGN.md` §15 as **Phase 1½**, between Phase 1 and Phase 2 — the
shell is a prerequisite for having anywhere to put a message list, and the
transition table is a Phase 1 cleanup that should not wait. Sub-numbered there
(12a–12d) so that nothing downstream renumbers: `DESIGN.md` §15's item numbers
are referenced from four documents.

1. ✅ **Router, shell, route table** (§4). **Done.** `main.tsx` went from 638
   lines to 20; the rest decomposed into `app/`, `routes/` and `features/`.
   `HashRouter`, the pathless `AppShell` layout route, `RootRedirect` deciding
   "/" from state, and `WorkspaceGate` as the sole caller of
   `workspace.switch` — enforced by `routing/switch-only-in-the-gate` rather
   than asserted (§6.3). The rail navigates.

   **Space routes deliberately absent.** §4.6 and §4.7 settle their shape; they
   arrive with the first real surface, because empty ones would be scaffolding
   nobody can test.

   Verified by running: `app.boot { to_first_render: 696, from_local: true }` —
   R3 holds through the router — and the redirect chain executing end to end,
   `/` → `/w/:wsId` → shell → rail.

2. ✅ **Transition table, and `awaiting_browser` as a status** (§7.2). **Done.**
   No dependency. Six statuses, twenty-two declared edges asserted at `#set()`,
   and `AppState.awaitingBrowser` removed from the IPC contract. Two edges the
   sketch in this document had wrong — a boot goes straight from `signed_out` to
   `authenticated` or `stale`, never through `authenticating`.
3. ✅ **Live-query client** (§5) with the invalidation registry, plus
   `renderer/no-direct-query` (§6.3). **Done.** `routes/People.tsx` was the
   first surface waiting on it and now reads through it.

   **The registry key is a topic, not a `chat_id`** — the correction §5.1
   records, forced by the very surface this item named: the directory has no
   chat. Two topics intersect when either is a prefix of the other, in both
   directions.

   Three things the sketch here did not anticipate, all in §5: a fourth
   `status` value so "still reading" is not rendered as "nothing here"; a failed
   read keeping its rows; and a generation counter, bumped by refetch *and*
   teardown, without which two invalidations in quick succession resolve to
   whichever reply the port happened to return last.

   Verified in the app, not only in tests: edit a display name in Postgres,
   toggle the aeroplane switch, and the directory updates in place. No
   "Reading…" flash — which is what distinguishes an invalidation from an
   accidental remount.

4. ✅ **Renderer telemetry transport** (§10). **Done**, and the router was
   indeed the right moment: `ui.route.changed` is the spine the other renderer
   events hang off.
5. Then Phase 2, where XState (§7.4) and Zod (§8.3) fire on their triggers.

### What is not yet built behind the routes

Named here so the gaps are decisions rather than discoveries:

- **A workspace not on this device** shows "not open on this device", because
  the three-way resolution in §4.5 (member / invited / no access) needs a
  server call that does not exist. Offline it correctly says "cannot check"
  (invariant 58).
- **`/w/:wsId` bare** renders the workspace home rather than a remembered
  location; there is nothing yet to remember. The `account.db` column arrives
  with the space list.
- ~~**Directory avatars are initials only.**~~ **Closed.** `ReplicaActor` now
  carries `avatarBlob` and `People.tsx` renders it. Three things had to change
  at once: `syncActors` stopped deleting the table on every sync, the prefetch
  learned to walk it, and the two boot tasks stopped racing — `fillAvatars` ran
  in parallel with `fillActors`, so the pass would have found an empty table on
  every first boot and worked only on the second.
