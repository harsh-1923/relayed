# Preferences

Companion to [`STORAGE.md`](STORAGE.md) (the tiers and what each database is
for) and [`FRONTEND.md`](FRONTEND.md) (the read path these are served over).
This document covers everything a **person chooses** about the app, as opposed
to everything the engine knows.

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| A table, or one JSON document? | **A table, one row per key** | 3 |
| A column per setting? | **No.** Key and value, with the domain in a shared catalogue | 3, 6 |
| Which database? | The tier the setting is *about*: `account.db` today | 4 |
| Does anything sync? | **No.** Every row is `reach='local'` | 5 |
| Then why is there a `reach` column? | It has to be on rows written *before* sync exists | 5 |
| Where do defaults live? | In code. **A missing row is the default** | 7 |
| Keyboard shortcuts? | One `keybindings.<command id>` row per customized command, written through `prefs.set`, `prefs.clear` and the transactional `prefs.apply` | 8, 11; SHORTCUTS.md §9 |
| How does the theme actually apply? | `nativeTheme.themeSource` in main for the window, `<Theme />` for the tokens — both from the stored value | 9 |
| Can a person choose the app icon? | **Yes.** A colorway id in `appearance.icon`, composited in main from the shipped icon's own pixels | 9.2 |
| Does the sidebar survive a restart? | **Yes.** Desktop open state and last expanded width are separate account-local preferences | 10.2 |
| Is the route strip shown by default? | **No.** The Developers setting opts into it per account on this device | 10.3 |

---

## 2. Goals and non-goals

### Goals

1. **R3 holds.** Preferences are read from disk, with no network and no server,
   in the same breath as everything else the replica serves.
2. **An old client never destroys a new client's settings.** Opt-in updates mean
   two versions of this app read the same `userData` for months (§3).
3. **Adding a preference is one line in one file**, plus a surface to change it
   on. No migration, no new query, no new invalidation wiring.
4. **A preference is a live read like any other.** Changed in one window, the
   other window repaints. No second state mechanism (§8).
5. **Syncing later costs a value change, not a reshape.** `reach` flips from
   `'local'` to `'synced'` and the storage is already right.

### Non-goals

- **Syncing anything, now.** There is no protocol event for a preference, no
  outbox kind, and no merge rule. §10 says what unblocks it.
- **An install-wide tier.** Two accounts on one machine are strangers
  (STORAGE.md §2), and a table that spanned them would be the first thing to
  join them. The cost is stated in §4: switching accounts can change the theme.
- **Arbitrary keys.** The catalogue is closed at write time. Unknown keys are
  tolerated on *read* — that is the whole of §3 — and refused on write.

---

## 3. Why a table, and why a row per key

The decisive argument is the release model, not ergonomics.

RELEASE.md §6.1: reinstalling replaces the app bundle and leaves `userData`
untouched, so **new code always meets an old database** — and §6.4: updates
cannot be forced, so old clients live for a long time. Both directions happen.
A user runs a recent build on one machine and a build from four releases ago on
another, against a `userData` directory that a reinstall preserved.

So the question is what happens when a client meets a key it does not know.

| Shape | Old client meets an unknown key |
|---|---|
| One JSON document | Read-modify-write **drops it**. The setting is gone, silently and permanently. |
| A column per setting | No column. The write throws, or a migration must reach every client before the feature can ship. |
| **A row per key** | It reads the keys it knows, writes the keys it knows, and **leaves the rest untouched**. |

That is RELEASE.md §6.5 — *unknown event types must advance the cursor* —
restated for settings, and it is the same rule `staged_events` is built on:
retain the envelope rather than a shredded shape, so a client that does not
understand something can still store it and hand it on. A JSON document is the
shredded shape, and its failure mode is silent and permanent, which the version
3 migration already names as the dangerous pair.

Two further reasons, both specific to this codebase:

- **Invalidation granularity.** The topic grammar prefix-matches, so a write
  naming `prefs:appearance.theme` wakes a reader subscribed to the coarse
  `prefs` for free, while a future surface that cares about one key can
  subscribe to just that one. A single document has exactly one topic: every
  preference write would refetch every preference reader.
- **Whole-document last-writer-wins is the trap DESIGN.md §4 already names.**
  Two devices each change a different setting; with one document, one clobbers
  the other entirely. Per-key rows make the eventual merge per-key, which is the
  only version that is correct. Deciding this now costs nothing and is the
  cheapest moment to decide it.

---

## 4. Tiers, and which database holds a preference

The tiers are STORAGE.md §4's, unchanged. A preference lives in the database for
the thing it is **about**:

| Tier | Database | Example |
|---|---|---|
| `account` | `accounts/<acc>/account.db` | theme, window material, sidebar width |
| `workspace` | `accounts/<acc>/workspaces/<wsp>/relayed.db` | per-workspace notification rules |

**Only the account tier exists today**, and that is deliberate rather than
unfinished. The version 2 migration of the replica states the rule this follows:
*a table with no writer has unverified constraints*. Every preference that
exists is account-scoped, so creating the workspace-tier copy now would ship a
table nothing writes and no test exercises. It arrives with its first key, as
one migration, using the identical DDL in §6 — the routing in the catalogue and
in `Storage` is already written for both.

### What account-tier costs

Two accounts signed in on one machine each keep their own theme, so **switching
accounts can change the appearance of the window**. That is a real consequence
and it is the right one: the alternative is an install-wide store, which is
precisely the table joining two accounts that STORAGE.md §2 rules out.

Signed out there is no `account.db`, so **preferences cannot be changed** — and
this is not a corner case, because `AppShell` has no signed-out guard and
`/settings/appearance` renders perfectly well without an account. Reading still
works and still answers: with no rows every key is at its default, which is what
the window is already showing. Writing does not, so `usePreference` reports
`writable: false` and the control disables itself and says why. A key that could
be set before sign-in would need a tier above the account, which is the one §2
rules out.

---

## 5. `reach`, and why it exists before sync does

`reach` says how far a setting is **allowed to travel**:

| Value | Meaning |
|---|---|
| `local` | Never leaves this `(install, account)`. Window material, zoom. |
| `synced` | Would follow the account or workspace to another machine. |

**Everything is `local` today.** Nothing reads the column yet and nothing writes
`'synced'`.

It ships now for the reason `unread_hint` shipped before the socket did
(STORAGE.md §16.2): it has to be on rows written *before* the feature exists, or
the first release that syncs cannot interpret what it finds.

And it is on the **row**, not only in the catalogue, for the `staged_events`
reason again. A client that does not recognise a key must still be able to route
it. Were `reach` derived from the catalogue alone, the first sync-capable
release would silently skip every key introduced by a client newer than itself —
the failure being an old laptop that syncs some settings and not others, with
nothing to indicate which.

Defaulted to `'local'`: the **least** travel, so a row written by something that
forgot to set it goes nowhere. Same reasoning as `actor_role`'s default of
`member`.

---

## 6. The table

Created by `account` migration 2. The same DDL is what the workspace tier gets
when it has a writer (§4).

```sql
CREATE TABLE preferences (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  reach      TEXT    NOT NULL DEFAULT 'local',
  updated_at INTEGER NOT NULL,

  CHECK (json_valid(value)),
  CHECK (reach IN ('local','synced'))
);
```

**`value` is JSON text, always** — `"dark"` and not `dark`. One codec covers
every key that way, and a value that grows from a string into an object needs no
column change. `json_valid` rejects the bare spelling at write time, which is
the one mistake the codec can make and the one a test cannot easily notice.

**The `NOT NULL` on `reach` is load-bearing and the CHECK beside it is not a
substitute.** `NULL IN ('local','synced')` is `NULL`, a CHECK rejects only
`FALSE`, so the constraint alone permits exactly the row it appears to forbid —
DESIGN.md §13.5, and asserted in both spellings in `account-schema.test.ts`
rather than trusted.

No index. The primary key serves point reads, and the table holds only what
somebody actually changed (§7). Keyboard shortcuts add one row per customized
command (SHORTCUTS.md §9), so the bound is the fixed catalogue plus the command
catalogue — tens of rows, still a scan nobody will measure.

---

## 7. The catalogue, and where validation went

A key/value table cannot CHECK a value. That is bought back in
[`src/shared/prefs.ts`](../apps/desktop/src/shared/prefs.ts), which is shared by
the sync engine and the renderer for the same reason `topics.ts` is: drift
between two copies of a vocabulary fails silently.

```ts
'appearance.theme': {
  tier: 'account', reach: 'local', fallback: 'system',
  parse: oneOf(['system', 'light', 'dark']),
},
'shell.sidebar.open': {
  tier: 'account', reach: 'local', fallback: true, parse: boolean,
},
'shell.sidebar.width': {
  tier: 'account', reach: 'local', fallback: 256,
  parse: integerBetween(224, 320),
},
'developer.route_strip.visible': {
  tier: 'account', reach: 'local', fallback: false, parse: boolean,
},
```

The catalogue owns four things per key: which database it lives in, how far it
may travel, what it means when it is absent, and what values it may hold.

**A missing row is the default, and defaults are never written.** Three
consequences, all wanted:

- changing a default ships with a release instead of with a data migration;
- the table holds only what somebody actually changed, so it stays tiny;
- "reset to defaults" is `DELETE FROM preferences`, with nothing to get wrong.

**Reads never fail.** `parse` returning null — a corrupt row, a value from a
newer client, a key that was removed — falls back to the default. A preference
is not worth a broken screen.

**Writes are refused at the engine**, not only in the UI: an unknown key or an
unparseable value throws in the handler. The renderer is a surface, not an
authority, and the catalogue is the same file on both sides, so there is one
rule and one implementation of it.

---

## 8. The read and write paths

Nothing new. Both are the paths DESIGN.md §11 already describes.

```
read    useQuery('prefs.list')  →  registry  →  prefs.list  →  SELECT
write   call api.query('prefs.set')  →  UPSERT  →  invalidate('prefs:<key>')
                                                →  push  →  registry refetches
clear   call api.query('prefs.clear')  →  DELETE  →  invalidate('prefs:<key>')
batch   call api.query('prefs.apply')  →  BEGIN … COMMIT  →  invalidate each key
```

`prefs.apply` exists because some changes are only valid together: moving a
keyboard shortcut from one command to another is two rows that must commit or
fail as one (SHORTCUTS.md §9.2).

**One query for every preference, not one per key.** `prefs.list` returns the
whole table, and `usePreference(key)` resolves a single value out of it against
the catalogue. The table holds tens of rows at most, so a per-key query would be
that many subscriptions and reads to save nothing — and one shared entry means two
surfaces reading the same key share a fetch.

**Written fine, subscribed coarse.** The write invalidates
`prefs:appearance.theme`; the read subscribes to `prefs`. `topicsIntersect`
matches them because one is a prefix of the other, so the granularity costs
nothing now and is already there when a surface wants it.

**A preference read is not a list**, so it does not use `QueryStatus`. `empty`
would be the ordinary case — everything at its default — and a surface that
renders "nothing here" for that would be wrong. `usePreference` returns a value
and a `loaded` flag, and the value is the default until the first read lands.

---

## 9. The two preferences that leave the database

The theme (§9.1) and the app icon (§9.2). Both take the same route for the
same reason — the thing that applies them is a native object, and the row is
in a database only the sync process opens — so main is **told** rather than
reading it.

### 9.1 The theme

Two things apply it, from one stored value:

```
prefs.set('appearance.theme', 'dark')
  → account.db                                     the stored value
  → await callMain('theme:source')                 sync → main, like blob:account
      → nativeTheme.themeSource = 'dark'           the NATIVE window material
  → invalidate('prefs:appearance.theme')
      → <Theme /> re-reads and toggles html.dark   the CSS TOKENS
```

Main is **told** rather than deriving it, following `blob:account`: storage
lives in the sync process, and a second reader of `account.db` would be a second
authority over it.

`<Theme />` deriving the class is **not** a second authority over the theme
either — both sides read the same stored preference, so the vibrancy and the
tokens are two readings of one fact rather than two facts that can drift.

### Why the renderer has to do it, which was learned the hard way

The design this replaced had no renderer code at all: `themeSource` already
drives `prefers-color-scheme`, and `main.tsx` had owned a `MediaQueryList` and a
`change` listener since the window learned to follow the system. Setting
`themeSource` should therefore have repainted everything for free.

It does not. Measured on Electron 44, six forced transitions, 2.5s apart:

| | |
|---|---|
| `matchMedia('(prefers-color-scheme: dark)').matches` | updates correctly ✓ |
| `change` events delivered to listeners | **0** ✗ |

The value is right and **the notification never arrives**. A window told to go
light reported light to anything that asked and went on rendering dark, for
ever. No error: the preference was written correctly, the control showed the new
choice, and only the colours disagreed — which is the exact shape of bug this
repository keeps finding by running things (AGENTS.md §1).

So:

- the class is derived from the **preference**, and only `system` asks the
  machine;
- the `change` listener stays, scoped to `system` — a real change of OS
  appearance is a genuine media change, which is what it was written for, and
  leaving it attached for `light` or `dark` would let the machine quietly undo
  an explicit choice;
- **`prefs.set` awaits main before it invalidates.** The renderer resolves
  `system` against `prefers-color-scheme`, which is what `themeSource` drives —
  waking it first would hand it the window's old appearance to resolve against.
  Ordering the two removes that race instead of papering over it with a delay.

### The flash, and why it is accepted

At boot the sync engine sends the stored theme as soon as it has opened
`account.db`; the window is created in the same tick as the fork. The message
normally lands well before `ready-to-show`, since opening SQLite beats booting a
renderer — but it is a race, not a guarantee, and a non-default theme can flash
the system appearance for a frame on a cold start. `main.tsx` paints the
machine's appearance at module load for the same reason: a wrong first guess for
one frame beats an unstyled document.

Gating `win.show()` on the theme arriving would close it, and is deliberately
not done: it makes a sync engine that fails to start a **window that never
appears**, trading a one-frame flash for a black screen. The fallback here is
the system theme, which is a correct-looking app rather than a broken one.

### 9.2 The app icon

One stored value, one native call, and no renderer half at all:

```
prefs.set('appearance.icon', 'emerald')
  → account.db                                     the stored colorway ID
  → callMain('icon:colorway', { id })              sync → main, like theme:source
      → app.dock.setIcon(composited)               the DOCK TILE
  → invalidate('prefs:appearance.icon')
      → the picker repaints its selection
```

**Only the id travels.** Main holds the colour table (`shared/icon-colorways.ts`)
and draws the picture itself, so the swatch in Settings and the tile in the Dock
cannot disagree about what `emerald` is. Sending three hex values instead would
put the same gradient in two places, and PREFERENCES.md §3's argument about old
clients applies to values as much as to keys: an id a build does not recognise
falls back to the default icon, where three colours it cannot judge would paint
an unreadable one.

**Not awaited**, unlike the theme. The theme is awaited because the renderer
resolves `system` against `prefers-color-scheme`, which `themeSource` drives.
Nothing in the window resolves against the icon.

#### What a chosen colorway can and cannot reach

| Surface | Follows the preference |
|---|---|
| macOS Dock tile, while the app runs | **Yes** — `app.dock.setIcon` |
| Window and taskbar icon on Windows and Linux | **Yes** — `win.setIcon`, re-applied per window |
| Finder, Launchpad, Spotlight, notifications, the .dmg | **No** |

Everything in the second row reads `Contents/Resources/icon.icns` inside the
bundle. Rewriting that in place breaks the code signature and Gatekeeper then
refuses to launch the app (RELEASE.md §3), so it is deliberately not attempted —
and the Appearance screen says so in the setting's own description rather than
leaving somebody to discover it in Finder. macOS does have a per-file custom
icon API that leaves the signature intact; Electron has no binding for it, and
it is not worth a native addon today.

#### Why the picture is composited rather than shipped

A hundred pre-rendered icons is a hundred assets in the bundle and a build step
every time a colorway is added. The alternative needs a rasteriser in main,
which Electron does not have — `nativeImage` decodes PNG and JPEG, not SVG —
and adding one (resvg, sharp) puts a native module in the build for one feature,
with `@napi-rs/keyring`'s asar problem to repeat.

So the shipped icon is read back apart instead. Its alpha **is** the plate's
coverage, and because the plate and the mark are each drawn in one known colour
(`SOURCE_PLATE`, `SOURCE_MARK`), the blend between them at every pixel unmixes
into the mark's coverage. Two masks, no dependency, antialiasing intact, and
gradients fall out of the same loop. `main/icon-composite.ts` is the whole of
it, and it is pure so that `node --test` can check a picture nothing else would
notice was wrong.

Two traps it is built around, both measured rather than recalled:

- **`toBitmap()`'s byte order is documented as platform-dependent.** It measures
  as BGRA on macOS, but a constant would be a guess about the platforms not
  measured, and the failure is swapped colours that no type or test would catch.
  So the order is read off the image: the plate's three channels are all
  different, which makes any opaque plate pixel a labelled sample.
- **Premultiplied alpha never has to be decided.** The mark's coverage is only
  read where alpha is 255, and on the plate's antialiased rim the coverage is
  zero either way.

If the shipped icon and `SOURCE_PLATE`/`SOURCE_MARK` ever disagree, the masks
cannot be recovered — so `deriveMasks` returns null, main keeps the packaged
icon and says so, and a test asserts the default colorway still equals the pair.

---

## 10. What is deferred, and what has landed

### 10.1 Syncing a preference — blocked on a protocol event

There is no event type for a preference, no `outbox` kind for one (the CHECK
allows `send`, `delete`, `read`), and no merge rule. When it lands:

- the cursor goes in **`stream_state`** under a new `stream_kind`, which is what
  that table was rebuilt in version 3 to make possible — no second cursor table;
- `outbox` gains a `kind`, deliberately, the way the version 2 comment says
  edits and reactions will;
- the merge is **per key**, by `updated_at`. Per key is what the row-per-key
  shape bought (§3); last-writer-wins across a whole document is the thing it
  was chosen to avoid.

Note that a preference is *mutable state both sides can write*, which every
other replicated thing in this app is not — messages are append-only with
server-allocated ordinals. That is the design work, and it is why this is not
merely unbuilt but undecided.

**Unblocked by:** a protocol event and a merge rule. The storage is ready.

### 10.2 The sidebar's open state and width — built

Desktop collapse and width are two account-local preferences:
`shell.sidebar.open` and `shell.sidebar.width`. They are separate because
collapsing to zero must not erase the width to restore when the sidebar opens
again. The width is an integer from 224px to 320px and defaults to 256px.

`PersistentSidebarProvider` controls shadcn's desktop `open` value from the
preference; its inherited cookie write remains unused and is not an authority.
Mobile still opens a transient Sheet and never changes the desktop preference.

`AppShell` keeps pointer movement off the React state path: `onResize` updates
the title bar's CSS custom property and remembers the last non-zero width in a
ref. The panel group's completed-layout callback writes that rounded width only
after direct pointer or keyboard manipulation ends. Programmatic restoration,
window resizing and initial mount never write. Both preferences therefore
survive renderer reload and process restart without turning a drag into one
SQLite write and live-query invalidation per pixel.

### 10.3 The developer route strip — built

`developer.route_strip.visible` is an account-local boolean preference that
defaults to false. The Developers settings page controls it, and `RouteStrip`
reads it through the live-query preference client before drawing the current
path and panel query in the top bar. A missing row therefore keeps the strip
out of both development and production builds until the person opts in.

### 10.4 The avatar playground — built

`developer.avatar_playground.visible` is the same shape and defaults to false.
`AppSidebar` reads it before drawing the row that reaches the bench for tuning
generated agent faces, so the bench is absent from a normal install rather than
merely out of the way.

The ROUTE stays registered either way. The preference hides an entrance, not a
surface: a bookmarked URL that stopped resolving because a switch was flipped
would be a worse thing to explain than a page nobody has a link to, and the
playground reads nothing that is not already on screen elsewhere.

---

## 11. Adding a preference

1. One entry in `src/shared/prefs.ts` — tier, reach, fallback, parse.
2. A control that calls `prefs.set`.

A keyboard shortcut is not added here at all: adding a command to the command
catalogue (`src/shared/shortcuts/catalogue.ts`) makes its `keybindings.<id>` key
writable (SHORTCUTS.md §9.2).

That is the whole list while the key is account-tier. A **workspace**-tier key
additionally needs the replica's copy of the table (§4), which is one migration
using the DDL in §6 — and it is the first such key that should add it, not this
document.

What you do **not** touch: the migration (for an account-tier key), the query
catalogue, the topics, the invalidation, or the preload types. They are keyed on
the table, not on any key in it.
