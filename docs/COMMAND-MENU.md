# Command menu

> **Status: built, first two sources.** `Mod+K` opens one menu for going
> somewhere and doing something. Today it lists every place the sidebar lists
> and the catalogue commands that would run right now. Message search, people
> search and nested pages are expected next and are not built (§9).
>
> This document is the **contract a new source must follow**. Read §3 and §4
> before adding a kind of result; §5 is the checklist.
>
> Companion to [`SHORTCUTS.md`](SHORTCUTS.md), which owns commands, the command
> bus and `app.search.open`; and [`FRONTEND.md`](FRONTEND.md), which owns the
> read path (`useQuery`) and the directory layout.

**Last updated:** 2026-09-16

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **Menu** | `CommandMenu`: the dialog, the input, the list, open and close. It knows nothing about what it lists. |
| **Source** | A component that contributes rows: it reads its own data, shows its own loading and error state, and renders groups of rows. |
| **Item** | One row, as data: `CommandMenuItem` (§3.1). A place and an action are the same shape. |
| **Perform** | What an item does when chosen. Runs after the menu has closed (§4.3). |
| **Destination** | A place the app can open, shared with the sidebar (`lib/navigation/destinations`). A destination is not an item; the navigation source turns one into an item. |
| **Command** | A catalogue entry (`shared/shortcuts/catalogue.ts`), run through the bus. The menu never implements a command; it invokes one (§6). |

---

## 1. What it is for

One keyboard-first surface for three jobs, growing over time:

1. **Switch / navigate** — rooms, channels, DMs, local rooms, People,
   Connectors. *Built.*
2. **Take actions** — anything in the command catalogue that would run now.
   *Built.*
3. **Search content** — messages, people, documents. *Not built.*

The design goal is that each new job is **a new source, not an edit to the
menu**. If adding something requires changing `CommandMenu.tsx` beyond the
`SOURCES` list, the contract is missing something — change the contract here
first, deliberately.

---

## 2. Layout

```
renderer/
  lib/navigation/destinations/      shared by the sidebar, the directories and the menu
    destinations.ts                 id, label, group, icon, route, disabled — no search fields
    destination-icon.ts             icon vocabulary for a destination
    destinations.fixtures.ts        Space / LocalRoom rows for tests
    destinations.test.ts

  features/command-menu/
    CommandMenu.tsx                 dialog, Mod+K handler, open/close, SOURCES
    command-menu-context.ts         CommandMenuItem, CommandMenuApi, useCommandMenu
    CommandMenuRow.tsx              CommandMenuRow, CommandMenuGroup — the only row renderer
    rank/
      rank.ts                       rankKeywords: the menu's one filter
      rank.test.ts
    sources/
      navigation/
        NavigationSource.tsx        places, perform = navigate
        navigation-entries.ts       keywords, aliases, folder detail, sidebar order (pure)
        navigation-entries.test.ts
      ActionSource.tsx              catalogue commands, perform = command.execute()
```

Mounted once in `main.tsx`, beside the top bar, so it exists on every route
including settings.

**Dependency direction.** `features/command-menu` may import from `lib/` and
from other features' public hooks. Nothing imports from
`features/command-menu` except `main.tsx`. Shared *facts* (routes, icons,
groups) go in `lib/`, never in the menu, so the sidebar and the menu cannot
disagree about where something leads.

---

## 3. The contract

### 3.1 An item

```ts
interface CommandMenuItem {
  id: string;                    // unique across ALL sources; prefixed, see §3.3
  label: string;
  icon?: ComponentType<{ className?: string }>;
  keywords: readonly string[];   // the only text search sees
  detail?: string | null;        // disambiguates equal labels (a folder, a workspace)
  shortcut?: string | null;      // display label from useCommand().shortcutLabel
  disabled?: boolean;            // visible but not choosable
  perform: () => void;           // runs after close (§4.3)
}
```

Rules:

- **`keywords` must contain the label.** The id is never searched (§4.2), so a
  row with no keywords can never be found by typing.
- **Keywords are human words only.** Names, aliases (`'dm'`, `'direct
  message'`), slugs, folder names. Never ids, never descriptions (a sentence
  matches almost anything).
- **`perform` is a closure over what it needs**, not a route string or a
  discriminated union. The menu must not branch on what an item does.
- **`disabled` means "exists but cannot open yet"** (e.g. a space whose main
  chat has not arrived). If a thing cannot be acted on at all right now, do not
  render it — see §3.4.

### 3.2 A source

A source is a React component with **no props**, listed in `SOURCES` in
`CommandMenu.tsx`. Order in that array is the order of groups before anything
is typed.

A source:

- **Reads its own data** with `useQuery` (the live-query client — never the
  bridge directly; `renderer/no-direct-query`). It is mounted only while the
  dialog is open, so subscriptions end when the menu closes. Do not hoist
  queries into the menu to "share" them — the registry already shares them.
- **Reads its own context** (`useSession`, `useNavigate`, `useCommand`, route
  hooks). The menu passes nothing.
- **Renders rows only through `CommandMenuGroup` or `CommandMenuRow`.** Never
  a raw `CommandItem`: the shared row is where close-then-perform, the id/
  keywords wiring and the visual contract live.
- **Reports its own loading and error** as a single short line above its
  groups (`role="status"` / `role="alert"`), and still renders whatever it has.
  The menu's `CommandEmpty` stays generic ("No results found.").
- **Headings are the source's**, one `CommandMenuGroup` per heading. cmdk hides
  a group whose rows all filter out.

When a row needs a hook of its own (as each action needs `useCommand(id)`),
render a small row component per item that calls the hook and returns either
`null` or a `CommandMenuRow` — see `ActionRow` in `ActionSource.tsx`. Never
call hooks in a loop.

### 3.3 Id prefixes

Ids are cmdk's values and must be unique across every source. Each source owns
one prefix:

| Prefix | Source | Example |
|---|---|---|
| `nav:` | Navigation | `nav:s:<wsId>:<spaceId>`, `nav:l:<roomId>`, `nav:p:<wsId>:people` |
| `cmd:` | Actions | `cmd:room.panels.newTab` |

Claim a new prefix in this table when you add a source (`msg:`, `person:`, …).

### 3.4 Availability

- The menu opens only while a workspace is active (`app.search.open` is
  enabled on `workspaceId !== null`), matching the sidebar, and closes if the
  workspace goes away.
- **A source decides its own availability.** Return nothing when it has
  nothing to offer (no workspace, wrong route). A source must tolerate a null
  workspace without throwing.
- **Actions appear only when they would run** (`useCommand(id).enabled`), so
  the list follows the screen: panel commands appear inside a room and vanish
  elsewhere. Never show an action that would do nothing.

---

## 4. Behaviour the menu guarantees

### 4.1 Opening and closing

`app.search.open` (`Mod+K`, application layer) opens it. Escape, clicking out
or choosing a row closes it. The search text is cleared once the close has
finished, so the list does not change under a fading dialog.

### 4.2 Filtering and ranking

`<Command filter>` calls `rankKeywords(typed, keywords)` for every row:

- empty input → every row, score 1;
- every typed term must appear somewhere in the joined keywords, or score 0;
- exact > whole-string prefix > word prefix > substring.

cmdk then orders groups by their best row. There is **one** filter for the
whole menu. A source that wants different matching (fuzzy, server-ranked
message search) must change what it puts in `keywords` or pre-filter its own
rows — not install a second filter. If that stops being enough, change
`rank.ts` and its tests for everyone.

### 4.3 Perform runs after close

`CommandMenuRow` calls `run(item.perform)`. The menu stores the function, closes,
and in `onOpenChangeComplete(false)` schedules it with `setTimeout(perform, 0)`.

Why: base-ui returns focus to whatever had it before the dialog, in a microtask
after the popup unmounts. An action that moves focus — New panel tab puts the
cursor in the address bar — would lose it if run earlier. A source must
therefore **not** close the menu itself or perform synchronously in
`onSelect`.

Consequences for `perform`:

- It runs one task after close; read fresh state at call time
  (`command.execute()` resolves the handler then, not at render).
- It must be safe if the world moved (the route changed, the workspace
  switched). Navigation and command execution already are.
- It is fire-and-forget. Long work belongs in the thing it calls, which shows
  its own progress; the menu is gone.

---

## 5. Adding a source — checklist

1. **Pick a prefix** and add it to §3.3.
2. **Put shared facts in `lib/`**, not the source, if the sidebar or another
   feature shows the same things (routes, icons, labels).
3. **Write a pure builder** (`sources/<name>/<name>-entries.ts`) that turns rows
   into entries with keywords and detail, in display order. No React, relative
   `.ts` imports, so it runs under `node --test`. Test: keywords, ordering,
   duplicate labels, null/partial data.
4. **Write the component** (`sources/<name>/<Name>Source.tsx`): `useQuery`,
   map entries to `CommandMenuItem`s with `perform`, render loading/error, then
   `CommandMenuGroup`s. A single-file source may sit directly in `sources/`
   until it needs a second file (FRONTEND §6.1b).
5. **Add it to `SOURCES`** in the position its groups should take.
6. **Check by hand:** empty input, a query matching only your rows, a query
   matching none, loading, a read error, and that choosing a row lands where it
   should with focus where it should be.

### Adding an action

Actions come from the catalogue; the menu never defines one.

1. Add the command to `shared/shortcuts/catalogue.ts` and its handler with
   `useCommandHandler` at its owner (SHORTCUTS.md, "To add a command").
2. Add `{ id, icon }` to `ACTIONS` in `ActionSource.tsx` if it is worth finding
   by name. Leave out commands that need focus the menu has just taken (e.g.
   `composer.message.send`) and `app.search.open` itself.
3. Its title and category become its keywords; its binding becomes the shortcut
   shown. Rename the title in the catalogue, never in the menu.

An action that needs an argument (e.g. "Move to channel…") is not a single
row; it needs a nested page (§9).

---

## 6. What the menu must not do

- **Implement an action.** Anything run from the menu must also be reachable
  as a command, a button or a menu item, through the bus. The menu is one more
  entry point, not an owner.
- **Read granted data from the network.** Every read is local via `useQuery`.
  Message search follows the same rule.
- **Know about a source's data.** No `if (item.kind === …)` in `CommandMenu`
  or `CommandMenuRow`.
- **Hold state that outlives a close**, other than the pending perform. Recents
  and pinned results, when built, are preferences or a local store, read by a
  source.
- **Change the command id.** `app.search.open` is keyed in stored preferences
  (`keybindings.app.search.open`); renaming it needs a preference migration.

---

## 7. Testing

- Pure modules (`rank.ts`, `*-entries.ts`, `destinations.ts`) have
  `node:test` files beside them; `pnpm --filter @relayed/desktop test` runs them.
- Fixtures for spaces and local rooms: `destinations.fixtures.ts`. Import it;
  never import one test file from another (it re-runs its tests).
- Components are checked by hand in the running app (§5, step 6).

---

## 8. Decisions and why

| Decision | Why | Rejected |
|---|---|---|
| Sources are components | Each owns its hooks, loading and availability; cmdk already filters and ranks across whatever is rendered. | Sources as hooks returning items (hooks in a loop, one loading state for all); a runtime registry (nothing registers from outside yet). |
| One item shape with `perform` | Places and actions render and behave identically; the menu never branches. | A `{ kind: 'route' | 'command' }` union the menu interprets. |
| Search fields live in the source, not the destination model | The sidebar never searches; aliases and folder labels are menu vocabulary. | Keywords on `NavigationDestination`. |
| Perform after close, one task later | Focus return would otherwise undo focus moves (§4.3). | Performing in `onSelect`; `finalFocus={false}` (needs editing vendored shadcn). |
| Menu requires a workspace | Matches the sidebar; everything listed sits behind it today. | Opening with only local rooms. Revisit when an account-tier source exists. |

---

## 9. Not built

- **Message search** — a `MessageSource` over a local full-text read, prefix
  `msg:`, probably shown only once something is typed.
- **People** — open a DM or profile from a person; prefix `person:`.
- **Nested pages / modes** — an item that opens a second list (pick a channel,
  pick a model), or a prefix character (`>` for actions only). cmdk supports
  pages; the menu will need a page stack in `CommandMenuApi` (`push(page)`),
  and pages will be sources too.
- **Recents and frecency** — ordering by use; a source concern backed by a
  preference or local table.
- **A catalogue flag for "show in menu"** — `ACTIONS` is a hand list today;
  move it to the catalogue if it grows past being obvious.
