# Commands and keyboard shortcuts

> **Status: built.** Nine of the ten implementation steps are done (§17); what
> remains is the hand-run platform matrix (§15.6) and the observability decision
> (§16). The frontend doc's command and shortcut seam (`FRONTEND.md` §6.4)
> points here, and this document describes the code as it is. Where a section
> kept its original plan, it says what was built instead and why.
>
> In brief: `@tanstack/hotkeys@0.8.0` parses, formats and records, but matching
> is Relayed's (§11); the command catalogue, binding schema and resolver live in
> `apps/desktop/src/shared/shortcuts/`; one renderer command bus owns every
> Relayed shortcut and every catalogued command has a handler; bindings persist
> as `keybindings.<id>` preference rows; `/settings/shortcuts` records, replaces,
> disables and resets them; the application menu shows Search, Settings and
> Keyboard Shortcuts with their current bindings; and composer send follows its
> binding.
>
> Companion to [`FRONTEND.md`](FRONTEND.md), which owns the renderer and routing
> boundaries; [`PREFERENCES.md`](PREFERENCES.md), which owns persistence for
> person-chosen settings; and [`COMPOSER.md`](COMPOSER.md), which owns editor
> keyboard behavior.

**Last updated:** 2026-09-14

---

## 0. Words used here

The distinctions in this table are load-bearing. Treating all of them as a
"shortcut" is how event listeners become the application architecture.

| Word | Meaning here |
|---|---|
| **Command** | A stable, semantic application action such as `app.search.open`. It says *what* should happen, never which keys caused it. |
| **Handler** | The currently mounted implementation of a command. A handler may be enabled only in a particular route or state. |
| **Binding** | A user-visible gesture that may invoke a command, such as `Mod+K`. Bindings are data and may be replaced or disabled. |
| **Chord** | Keys pressed together, such as `Mod+Shift+P`. Chords are the only customizable gesture in the first release. |
| **Sequence** | Chords pressed in order, such as `G` then `D`. The data shape leaves room for them, but the first release does not enable them. |
| **Context** | Bounded application facts used to decide whether a handler is eligible: focus is editable, a suggestion menu is open, a workspace is available, and so on. |
| **Layer** | A named precedence band. A recorder must beat a dialog, a dialog must beat an editor, and an editor must beat the shell. |
| **Component keymap** | Keyboard behavior intrinsic to a component, such as arrow keys in a listbox or bold in Tiptap. It is not automatically an application command. |
| **Native accelerator** | A focused-app shortcut owned by an Electron menu item in the main process. |
| **System-wide shortcut** | A shortcut that fires while Relayed is not focused. Electron calls this a global shortcut. It is explicitly out of scope here. |

`Mod` is the portable primary modifier: Command on macOS and Control on Windows
and Linux.

---

## 1. What this document decides

| Question | Decision | Why |
|---|---|---|
| What is the core abstraction? | A **command catalogue and runtime command bus**, with shortcuts as one input adapter. | Buttons, menus, a future command palette, editor keymaps, and hotkeys must invoke the same action rather than reimplement it. |
| Where do command IDs live? | One data-only catalogue under `src/shared/shortcuts/`. | Main, sync, preload, and renderer need one bounded vocabulary without importing React. |
| Which hotkey library? | **`@tanstack/hotkeys@0.8.0` behind a Relayed-owned adapter**, admitted by the executable spike for parsing, normalization, display and recording only. | Those pure functions passed against trusted key events. Its matcher falls back to physical key codes and filters neither IME nor AltGraph, so matching and registration stay Relayed's; its alpha API must not become the app's public API. |
| Who resolves a key press? | One renderer dispatcher per window. | Several component listeners create mount-order behavior and inconsistent input filtering. |
| Who executes an action? | The highest eligible handler for a semantic command ID. | The same binding can safely mean a local editor action above a shell action without either component knowing about the other. |
| Where are user choices stored? | Existing `preferences`, one row per command: `keybindings.<command-id>`. | It preserves unknown rows across versions and gives local-first reads without a new state system. |
| What does a missing row mean? | Use the platform default from the command catalogue. | Defaults ship with code and need no migration. |
| What does an empty binding list mean? | The person disabled the shortcut. | Disable and reset must be different operations. Reset deletes the row. |
| Are contexts user-editable? | No. People edit gestures; code owns contexts and safety policy. | A user-authored expression language would expose implementation details and make conflict checking unreliable. |
| Who owns editor shortcuts? | Tiptap and component keymaps keep first refusal; commands bridge into them deliberately. | Text editing and suggestion navigation have ordering requirements a document listener cannot safely infer. |
| Who owns native menus? | Electron main owns menu construction; menu items invoke allow-listed command IDs in the focused renderer. | Native roles and platform conventions belong in main, while application state and handlers live in the renderer. |
| Are system-wide shortcuts included? | No. | They require OS permission, registration-failure UX, and a product reason to act while unfocused. |

---

## 2. Goals and non-goals

### Goals

1. **One action, many entry points.** A button, shortcut, menu item, command
   palette entry, and editor adapter all execute one command ID.
2. **Deterministic dispatch.** Focus, overlays, editors, routes, and shell
   commands have named precedence. Mount order is never a tiebreaker.
3. **User ownership.** Every declared configurable binding can be recorded,
   replaced, disabled, and reset without restarting the app.
4. **Cross-platform correctness.** Defaults follow macOS, Windows, and Linux
   conventions and are displayed in the vocabulary of the current platform.
5. **Text-input safety.** Typing, composition, AltGraph, Tiptap keymaps, and
   browser or OS conventions are not accidentally consumed.
6. **Discoverability.** Menus, tooltips, shortcut badges, help, and
   `aria-keyshortcuts` derive from the same effective binding.
7. **Local-first behavior.** The shortcut settings page and active bindings
   work from `account.db` with no network.
8. **Replaceable mechanics.** TanStack may be upgraded or replaced without
   changing command definitions, preferences, handlers, or UI call sites.

### Non-goals

- A user-authored macro or scripting language.
- System-wide shortcuts while Relayed is unfocused.
- Vim-style sequences, held-key gestures, or key-up commands in the first
  release.
- Remapping intrinsic widget navigation such as Tab, arrow keys in a listbox,
  or Escape inside an open dialog.
- Syncing shortcuts between machines. The preference rows remain
  `reach='local'` until a merge policy is designed.
- A command palette in the first vertical slice. `cmdk` is already used for
  search, but a search dialog and a command palette are different products.
- Inventing shortcuts for every action. Only frequent, stable commands get a
  default; catalogue entries may exist without a default binding.

---

## 3. The problem in the current app

The current shortcuts are small, but they already demonstrate why a framework
is needed.

| Current behavior | Failure |
|---|---|
| `AppSidebar` owns the `Mod+K` listener that opens search. | Settings replaces `AppSidebar` with `SettingsSidebar`, so the shortcut disappears exactly where a person may try to configure it. |
| `SidebarProvider` owns a window-level `Mod+B` listener that calls `preventDefault` unconditionally. | Tiptap's StarterKit binds `Mod+B` to bold in the composer. Pressing it while the composer is focused toggles the sidebar as well; whether bold also applies depends on listener order rather than any stated policy. |
| Search's title and `aria-keyshortcuts` are hard-coded separately from the listener. | Remapping the listener would leave visible and assistive labels lying. |
| The composer owns capture-phase Enter handling and suggestion menus own their own keys. | Moving those keys to a generic bubble listener would change timing and can submit while a suggestion is trying to accept. |
| Main never calls `Menu.setApplicationMenu`, so Electron installs its default menu. | Standard Edit and Window roles work, but no menu item can reach a Relayed action, so native discovery and accelerators cannot share the renderer action. |
| Preferences currently know only a fixed appearance key. | Shortcut rows need a closed, derived family of keys plus a delete operation for reset. |

**Resolved by the shell migration step.** `SearchPalette` (mounted beside the
top bar) owns the search dialog and registers `app.search.open`; `TopBar`
registers `shell.sidebar.toggle` with `enabled` set to whether a sidebar is on
screen. The vendored `SidebarProvider` listener is removed by a marked patch,
and the `shortcuts/no-global-key-listener` boundary rule fails if a shadcn
update restores it or any renderer code adds a window or document key listener.
Both buttons take their title and `aria-keyshortcuts` from the command.

The table above is the state before this work began, kept because each row is
the reason for a rule elsewhere in this document.

---

## 4. Industry baseline

The design follows the parts of established desktop and web systems that solve
the same failure modes.

### 4.1 Commands are not key events

VS Code separates a command ID from its keybindings and gates bindings through
context. Windows describes accelerators as ways to invoke an application
command and recommends exposing them through menus or tooltips. Relayed adopts
the same separation without copying VS Code's user-editable expression
language.

The practical rule is:

> A keyboard adapter may choose a command. It may never contain the business
> action for that command.

### 4.2 Respect platform and component conventions

Apple asks apps to preserve standard shortcuts and reserve custom bindings for
frequent app-specific commands. Microsoft makes the same consistency and
discoverability recommendation. Electron provides native menu roles for
standard Edit and Window behavior.

Therefore Relayed does not reimplement copy, paste, undo, redo, select all,
quit, or window management. Electron menu roles and the focused control keep
those behaviors. The application catalogue starts with Relayed-specific
actions.

### 4.3 Context and precedence are product behavior

The same gesture may be valid in mutually exclusive contexts. A suggestion
surface accepting Enter must beat the editor sending a message; editor bold
must beat shell sidebar toggle; a shortcut recorder must see the next chord
before the rest of the app.

This is expressed as named layers and typed context facts, not propagation
accidents, listener order, or arbitrary numeric priorities supplied by feature
code.

### 4.4 Shortcuts must be discoverable and accessible

WAI-ARIA says `aria-keyshortcuts` only announces implemented behavior; it does
not create it, and authors should make shortcuts discoverable. WCAG's character
key shortcut requirement says character-only shortcuts must be remappable,
disableable, or active only while the relevant component has focus.

Relayed therefore:

- derives tooltip text, badges, menus, help, and `aria-keyshortcuts` from the
  effective binding;
- permits every application-level character-only binding to be remapped or
  disabled;
- keeps unmodified editor or widget keys inside their focused component;
- never adds `aria-keyshortcuts` to a disabled control or to a gesture the
  current context cannot invoke; and
- preserves keyboard navigation and visible focus separately from accelerators.

### 4.5 Layout, IME, and AltGraph are not edge cases

Bindings use logical `KeyboardEvent.key` semantics by default. This makes the
character the person typed the default meaning. TanStack's
`matchesKeyboardEvent` falls back to `event.code` for punctuation, digits,
dead keys and Alt-modified letters, and the admission spike showed that
fallback breaks this contract with no option to disable it. Relayed therefore
matches by looking up `normalizeHotkeyFromEvent(event)` in its own index, which
reads only `event.key` and the modifier flags. The one explicit exception is
**Toggle room panels**: macOS Option changes B into
`∫`, so that command declares `keyMatch='physical'` and the dispatcher reads
`event.code` `KeyB`. It is fixed rather than user-configurable until recorder
and preference data have an explicit physical binding kind; no recorded chord
silently changes semantics. The recorder normalizes the current platform's
primary modifier to `Mod`.

Composition events never dispatch commands. AltGraph is treated as text entry,
not as Control+Alt, except when the same macOS event matches an explicitly
physical Option-letter command. Manual verification includes a non-US layout
and an IME.

---

## 5. The architecture in one picture

```
                                 one semantic invocation
  keyboard ── binding adapter ─┐
  Tiptap ──── editor adapter ──┤
  button ───── execute(id) ────┼──▶ command bus ──▶ highest eligible handler
  palette ──── execute(id) ────┤          │
  native menu ─ preload push ──┘          └──▶ handled / disabled / unavailable

                 effective binding index
  command defaults ────────────┐
                               ├──▶ resolve for platform + validate conflicts
  preference overrides ────────┘             │
                                             ├──▶ keyboard adapter
                                             ├──▶ shortcut settings
                                             ├──▶ labels + aria-keyshortcuts
                                             └──▶ safe native accelerators
```

Across Electron processes:

```
 account.db                    sync process
 preferences  ◀────────────── prefs.list / prefs.set / prefs.clear / prefs.apply
      │                              │
      │ live-query invalidation      │ effective safe-menu bindings
      ▼                              ▼
 renderer                     Electron main
 CommandProvider              native Menu + standard roles
      ▲                              │
      └──── preload allow-list ◀─────┘  focused-window command invocation
```

The sync process remains the only owner of `account.db`. Main is told the small
snapshot it needs, following the same boundary as the stored theme; it never
opens the database itself.

---

## 6. Ownership and process boundaries

### 6.1 Shared: the bounded vocabulary and pure data

Home:

```text
apps/desktop/src/shared/shortcuts/
  catalogue.ts       command definitions and stable IDs
  schema.ts          persisted gesture shapes and validation
  resolve.ts         defaults + overrides + platform resolution
  tanstack-driver.ts the only import of @tanstack/hotkeys in the app
```

This layer contains no React, DOM, Electron object, route function, or command
implementation. Main and preload can validate an incoming command ID without
trusting an arbitrary renderer string. Sync can validate a stored override with
the exact grammar the renderer records.

Do not create a workspace package yet. All consumers are inside the desktop
application, and the shared folder already exists for cross-process contracts.

### 6.2 Renderer: command state and execution

Home:

```text
apps/desktop/src/renderer/lib/commands/
  CommandProvider.tsx  provider, the one keydown listener, useCommandHandler, useCommand,
                       useCommandBindings, useCommandInspector
  Shortcut.tsx         a command's or a chord's keys, with its ARIA label
  registry.ts          handlers per command, layer precedence, execution outcomes
  dispatch.ts          the dispatch algorithm as a pure decision, and the binding index
  editable.ts          editable-focus classification over the composed path
  commands.test.ts
apps/desktop/src/renderer/app/Commands.tsx   mounts the provider with the session's platform
apps/desktop/src/renderer/features/dev/CommandInspector.tsx   development builds only
```

Built. The provider takes an `overrides` prop — decoded `keybindings.<id>`
values, empty until persistent overrides land — and layers the inspector's
session-only remaps over it. The resolved list is the single state the keyboard
index, `useCommand` labels, `Shortcut` and the settings page all read. The registry and
the decision have no React or DOM, so their rules run under `node --test`; the
listener itself is proven against trusted key events by
`spikes/hotkeys` (`npm run test:bus`), which mounts this provider rather than a
prototype.

`CommandProvider` sits inside `AppStateProvider` and above `SidebarProvider`,
`TopBar`, and the route tree. `HashRouter` wraps `AppStateProvider` in
`renderer/main.tsx`, so the provider is inside the router and may read the
location for context facts. That lifetime is deliberate: search, settings, sign-in-safe
commands, the title bar, and native-menu invocations cannot depend on which
sidebar or route happens to be mounted.

The provider owns:

- the effective binding index for this platform;
- the active handler registry;
- the bounded context snapshot;
- the one document-level hotkey adapter; and
- command state subscriptions used by buttons, help, and settings.

Feature components register handlers. They do not register document listeners.

### 6.3 Sync: preference authority

The existing preference handlers gain `prefs.clear` for one-key reset and
`prefs.apply` for an atomic list of validated set/clear changes. The preference
catalogue recognizes `keybindings.<known-command-id>` as a derived, closed key
family. Unknown command IDs, malformed gestures, and a resulting hard conflict
are refused on write; unknown rows remain tolerated on read, preserving the
preference doc's forward-compatibility rule.

On account open, binding write, binding clear, and account switch, sync resolves
the safe native-menu subset for the current platform and sends it to main. That
is the same one-way ownership pattern as `theme:source`: storage owns the fact;
main is told how to apply the part only main can apply.

### 6.4 Main: native conventions

Main builds the application menu from:

- Electron roles for standard application, Edit, and Window behavior; and
- a fixed allow-list of Relayed commands declared menu-safe in the catalogue.

A custom menu click sends only a command ID to the focused window. Main never
sends user-provided code or parameters. A user override becomes an Electron
accelerator only if that command is safe in every focus context. Contextual
bindings such as sidebar toggle are displayed in help but remain renderer-owned.

### 6.5 Preload: a narrow push

Preload exposes a subscription such as:

```ts
onCommand(callback: (commandId: NativeCommandId) => void): () => void
```

It validates against the native-command allow-list before invoking the callback.
The renderer never receives `ipcRenderer`, and main cannot ask it to execute an
arbitrary string.

---

## 7. The command contract

Built in `shared/shortcuts/catalogue.ts`. The public concepts must remain this
small. A definition carries its binding's `layer` because conflicts are judged
from the catalogue, before any handler is mounted.

```ts
type CommandLayer =
  | 'application'
  | 'shell'
  | 'workspace'
  | 'route'
  | 'editor'
  | 'overlay'
  | 'recorder';

interface ShortcutChord {
  readonly kind: 'chord';
  readonly hotkey: string;
}

interface CommandDefinition {
  readonly title: string;
  readonly description: string;
  readonly category: 'Application' | 'Navigation' | 'View' | 'Composer';
  readonly layer: CommandLayer;
  readonly defaultBindings: PlatformBindings;
  readonly configurable: boolean;
  readonly inputPolicy: 'allow-editable' | 'deny-editable' | 'focused-editor';
  readonly repeat: 'ignore' | 'allow';
  readonly keyMatch: 'logical' | 'physical';
  readonly nativeMenu: false | { readonly menu: 'app' | 'view' | 'window' };
}

const COMMANDS = {
  'app.search.open': { /* definition */ },
  'shell.sidebar.toggle': { /* definition */ },
  // ...the rest of the bounded catalogue
} as const satisfies Record<string, CommandDefinition>;

type CommandId = keyof typeof COMMANDS;
```

Command IDs are durable data. Rename a title freely; rename an ID only with a
preference migration. IDs name the domain action rather than a current UI
location: `app.search.open`, not `sidebar.search.click`.

Definitions contain display metadata and binding safety, not implementation
callbacks. This keeps the catalogue serializable and safe to import from every
process.

### 7.1 Handler registration

Feature code supplies the current implementation:

```ts
useCommandHandler('shell.sidebar.toggle', {
  layer: 'shell',
  enabled: hasSidebar,
  run: toggleSidebar,
});
```

`enabled` is a boolean today. No handler has yet needed a context fact the
dispatcher does not already apply (editable focus is the binding's input
policy), so the typed context snapshot is not built. When repeated conditions
emerge, `enabled` becomes a predicate over named fields of a
`CommandContextSnapshot`; there is still no string parser and no public bag of
arbitrary context keys. `run` may be a fresh closure every render: the bus
always calls the latest, and only a change of `enabled` notifies subscribers.

A command may have handlers in different layers, but the same command may not
have two eligible handlers in the same layer. Development throws with both
registrations named; production chooses neither and reports an internal
diagnostic. "Last component mounted wins" is forbidden.

### 7.2 Programmatic execution

Buttons and palette entries use the same bus:

```ts
const search = useCommand('app.search.open');

<Button
  disabled={!search.enabled}
  onClick={search.execute}
  aria-keyshortcuts={search.enabled ? search.ariaKeyShortcuts : undefined}
  title={`Search${search.shortcutLabel ? ` (${search.shortcutLabel})` : ''}`}
/>
```

`execute` returns one of three outcomes:

| Outcome | Meaning |
|---|---|
| `handled` | An eligible handler completed or accepted the action. |
| `disabled` | A handler exists, but current application state makes it unavailable. |
| `unavailable` | No handler exists in the current surface. |

Buttons and native menu items do not pretend to press the configured keys.
They execute the command directly, so a binding's editable-focus policy never
disables a visible button.

---

## 8. Dispatch and precedence

### 8.1 Named layers

From highest to lowest precedence:

| Layer | Owns |
|---|---|
| `recorder` | The shortcut capture control while it is actively listening. |
| `overlay` | Dialogs, popovers, menus, and composer suggestion surfaces. |
| `editor` | Tiptap and other focused editing surfaces. |
| `route` | The currently rendered route or panel. |
| `workspace` | Commands requiring the open workspace but not a particular route. |
| `shell` | Sidebar and window chrome. |
| `application` | Commands valid throughout the signed-in or signed-out application. |

Feature code chooses one of these names. It cannot invent a numeric priority.
Within one command and layer, multiple eligible handlers are an error. Across
commands sharing a gesture, the higher layer is a deliberate shadow and the
settings UI explains it.

### 8.2 One dispatch algorithm

For every keydown the renderer adapter performs these checks in order:

1. Return if another owner already called `defaultPrevented`.
2. Return during IME composition (`isComposing` or composition key state).
3. Derive the logical chord and, for explicitly physical commands, the labelled
   letter chord from `KeyboardEvent.code`.
4. Return when AltGraph is active unless the event matches an explicitly
   physical command. This permits macOS Option-letter commands while leaving
   Windows and Linux Control+Alt text entry alone.
5. Return on repeat unless the command definition opts in.
6. Normalize the event and look it up in the effective binding index.
7. Apply the binding's editable-focus policy. Classification uses the composed
   event path and active element, including text-like inputs, textarea, select,
   contenteditable, and textbox roles; button-like inputs are not editable.
8. Ask the command bus for the highest eligible handler.
9. Only after a winner exists, prevent the browser default and execute it.

The adapter does not stop propagation by default. Overlay or editor owners may
do so when their component contract requires it. TanStack's registration
manager would prevent default and stop propagation whenever a registration
fires, which is one reason Relayed does not use it; the dispatcher needs to
know that a real command winner exists first.

Modifier matching is exact. `Mod+K` does not also match `Mod+Shift+K`.

A `focused-editor` command is never in the document adapter's index. Its
editor's own keymap dispatches it (§12.3); for composer send that is the
existing capture-phase path, so a plain Enter in an unrelated text field can
never reach the send handler.

### 8.3 Conflict classes

| Conflict | Treatment |
|---|---|
| Same normalized chord on two commands in the same layer, or on two commands in **ambient** layers (`application`, `shell`, `workspace`, `route`) | Hard conflict: ambient layers are live whatever has focus, so one command could never be reached. Saving offers **Replace existing** or **Cancel**. |
| Same chord where at most one command is ambient and the rest are in distinct **focused** layers (`editor`, `overlay`, `recorder`) | Allowed shadow. The highest layer wins while it has focus, the ambient command works everywhere else, and the settings row explains where. |
| Browser, OS, or assistive-technology reserved chord | Block when reliably known; otherwise warn and require explicit confirmation. |
| Chord unavailable on the current platform or layout | Do not activate it; show it as unavailable and keep the stored value so another platform can still use it later. |
| Duplicate defaults | Catalogue test failure. The application must never ship a silent hard conflict. |

Conflict detection runs on normalized, platform-resolved chords. Comparing raw
strings would miss aliases such as primary modifier spellings.

---

## 9. Defaults and overrides

### 9.1 Persistence shape

Each customized command occupies one existing preference row:

```text
key    = keybindings.app.search.open
value  = [{"kind":"chord","hotkey":"Mod+K"}]
reach  = local
```

The JSON value is an ordered replacement list, not a patch:

| Stored state | Meaning |
|---|---|
| No row | Use the catalogue defaults for this platform. |
| Non-empty list | Use exactly these user bindings. |
| Empty list | The shortcut is disabled. |
| Delete the row | Reset this command to its current defaults. |

The object wrapper costs little and leaves a tagged place for a future
`sequence` binding without reinterpreting old strings. The first validator
accepts only `kind: 'chord'`.

Bindings are account-tier and local. That means two accounts on one install may
have different shortcuts, switching accounts changes the active set, and a
signed-out surface reads defaults but cannot write. These are the existing
preference semantics, not new exceptions.

### 9.2 Extending the closed preference catalogue

Built in `shared/prefs.ts` and `sync/prefs.ts`. The preference vocabulary stays
closed: `isKeybindingKey` accepts a key only when it has the exact
`keybindings.` prefix and the suffix is a configurable command ID, and the
engine accepts its value only if the shortcut schema parses it on the host
platform. `isWritablePreferenceKey` is the union the engine authorizes against.

`KeybindingKey` is a **separate** type, not folded into `PreferenceKey` as this
section first proposed. `PreferenceKey`'s value types are read off each entry's
`parse`, which is what makes `usePreference('appearance.theme')` return a
literal union; a binding list is decoded by the shortcut resolver against the
reading platform instead, so a union would have widened every existing key's
type for no caller. `encode` takes the platform as a third argument and refuses
a keybinding key without one, rather than guessing and storing `Mod+K` where a
Mac user meant Control.

Defaults are still not written. The table remains bounded by the catalogue, but
it grows with every customized command; the "handful of rows" rationale in
`PREFERENCES.md` and the `prefs.list` handler now says so.

**`prefs.clear`** deletes one row. It shares `prefs.set`'s key authorization and
invalidates `prefs:<key>`. A keybinding clear goes through the same conflict
check as a set, because the default it restores may already be another
command's chord.

**`prefs.apply`** takes a list of `set` and `clear` changes. The engine
validates every change and refuses a key named twice, then — if any keybinding
key is touched — resolves the resulting complete binding set and refuses a hard
conflict **that involves a touched command**, and only then commits every row
in one SQLite transaction, rolling back if a statement fails. The scoping is
deliberate: a release that turns a default into a chord someone already uses is
a conflict for the settings page to show, not a reason to refuse every
unrelated write. A refusal's message starts `keybinding conflict:` and names the
chord and commands. A single keybinding `prefs.set` takes the same path.

This is required for **Replace existing** and **Reset all**: a two-write
sequence can leave the person with neither binding or both if the second write
fails.

The renderer reads the rows through the ordinary `prefs.list` live query in
`app/Commands.tsx` and passes them to `CommandProvider` as `overrides`, so a
write in another window or a reset repaints every shortcut with no second state
mechanism. An account switch re-reads them through the workspace epoch, which
advances when the new account's workspace opens; whether an account with no
workspace re-reads is unverified, and the theme preference shares that path. The
development inspector's **Save** and **Reset** call the same handlers directly.

### 9.3 Invalid rows and downgrade behavior

Reads never break a surface. A malformed value or a value unknown to this build
falls back to that command's current defaults and exposes a bounded diagnostic
state to the settings UI. It does not delete or rewrite the row; a newer client
may understand it.

Writes fail at the sync engine as well as in the recorder UI. The renderer is a
surface, not the validation authority.

---

## 10. Initial catalogue

This is the first useful set, not a claim that every action deserves a key.

| Command | macOS default | Windows/Linux default | Binding context | Native menu |
|---|---|---|---|---|
| Open search — `app.search.open` | `Mod+K` | `Mod+K` | Allowed in editable focus; application layer | Yes |
| Toggle sidebar — `shell.sidebar.toggle` | `Mod+B` | `Mod+B` | Denied in editable focus; shell layer | No |
| Toggle room panels — `room.panels.toggle` | `Mod+Alt+B` | — | Allowed in editable focus while a room route is mounted; physical-key match | No |
| Navigate back — `navigation.back` | `Mod+[` | `Alt+ArrowLeft` | Denied in editable focus; route layer | No |
| Navigate forward — `navigation.forward` | `Mod+]` | `Alt+ArrowRight` | Denied in editable focus; route layer | No |
| Open settings — `app.settings.open` | `Mod+,` | `Mod+,` | Allowed in editable focus; application layer | Yes |
| Open keyboard shortcuts — `app.shortcuts.open` | `Mod+/` | `Mod+/` | Allowed in editable focus; application layer | Yes |
| Send message — `composer.message.send` | `Enter`, `Mod+Enter` | `Enter`, `Mod+Enter` | Focused editor only; editor layer | No |

**Where each handler lives.** Search in `app/shell/SearchPalette.tsx`, enabled
once a workspace is open. Sidebar toggle, back and forward in `TopBar`, which is
always mounted and already holds whether a sidebar is on screen and whether
either history direction leads anywhere (`use-back-forward`); with nowhere to
go, the key is left alone. Open settings and open keyboard shortcuts in
`app/shell/AppCommands.tsx`, mounted at the root and enabled while an account
is open, navigating to `/settings/general` and `/settings/shortcuts`. The back
and forward buttons execute their commands and show their shortcuts.

The sidebar decision is intentional: `Mod+B` remains a familiar shell binding
outside editable controls, while Tiptap keeps standard bold behavior inside the
composer. Two things protect the editor, and the command bus spike shows each:
Tiptap's bold keymap calls `preventDefault` before the event reaches the
document, which the dispatcher's first guard honours, and the binding's
deny-editable policy covers editable controls that do not. The binding policy belongs to the catalogue and is applied only to
keyboard dispatch; clicking the sidebar button still works while an editor has
focus.

The room-panel command is deliberately macOS-only and fixed for its first
slice. Option changes the logical character produced by B, so it is the one
catalogue command that explicitly matches the labelled physical key. Windows
and Linux get no default until the supported-platform shortcut matrix has been
exercised with an AltGraph layout; settings show the command but do not offer a
recorder that would misrepresent its physical semantics. Its route handler
lives in `routes/Space.tsx` and is enabled only for a room whose panels are
available locally.

Composer send is one command with two defaults, and they are not symmetric:
`Mod+Enter` sends from every block, while plain `Enter` sends only outside a code
block, and `Shift+Enter` inserts a line break. The rule generalizes to any
binding: **a binding without Control, Alt or Command does not send inside a
code block**; a modified one does. An open suggestion menu owns Return — modified
or not — and composition never sends. See §12.3 for where that runs.

A focused editor may bind an unmodified key only when it is Return, with or
without Shift (`bindingProblem`): a bare letter, Tab, Backspace or arrow would
take that key from the text being typed.

Formatting commands are not customizable in the first release. Tiptap's local
keymap continues to own bold, italic, lists, undo, and redo. A later formatting
slice may promote selected actions into the catalogue, but only with a Tiptap
extension that disables or supersedes the corresponding built-in keymap so two
owners never coexist.

---

## 11. TanStack Hotkeys: use it as a driver, not the architecture

**Admitted by the spike: `@tanstack/hotkeys@0.8.0`, core only, exact pin.**
The evidence and every case are in [`spikes/hotkeys/`](../spikes/hotkeys/README.md)
(44 assertions against trusted Chromium key events in Electron 44.2.0).

The spike narrowed what the library is used for. Its pure functions are sound;
its event matching is not compatible with Relayed's logical-key contract, and
its React bindings add nothing the command bus needs.

| TanStack capability | Relayed use | Why |
|---|---|---|
| `parseHotkey`, `normalizeHotkey`, `normalizeHotkeyFromEvent` | **Used.** Index key for defaults and overrides; lookup key for a keydown. | Aliases collapse to one key per platform, `Mod` resolves correctly, and lookup by normalized string is exact-modifier and logical-key by construction. |
| `formatForDisplay`, `formatHotkey` | **Used.** Visual labels and WAI-ARIA tokens. | `⌘ ⇧ P` on macOS, `Ctrl+Shift+P` elsewhere; `Meta+K` / `Control+K` for `aria-keyshortcuts`. |
| `HotkeyRecorder` | **Used**, wrapped. | Capture-phase, stops propagation, ignores pure modifiers. Its bare-Backspace `""` result means "remove", never a stored value, and its capture control must be a button because it ignores focused inputs. |
| `validateHotkey` | **Used, not sufficient.** | `Mod+Foo` and `Mod+Shift` pass with warnings. The schema also requires a non-modifier key from the known-key set and a stored form equal to its normalized form. |
| `matchesKeyboardEvent`, `HotkeyManager`, `useHotkey` | **Not used.** | The matcher falls back to `event.code` — a key producing `-` at the physical Slash position matches `Mod+/` — with no option to disable it, and it filters neither IME composition nor AltGraph. |
| `isInputElement` / `ignoreInputs` | **Not used.** | It counts a checkbox as editable and misses `role=textbox` and shadow roots. Relayed classifies from the composed path. |
| `@tanstack/react-hotkeys` | **Not installed.** | The bus needs one effect-owned listener, proven clean under StrictMode; a recorder hook is `useSyncExternalStore` over `recorder.store`. |
| Electron accelerator syntax | **Not provided.** | `shared/shortcuts` derives it from the parsed hotkey. |
| Sequences | Possible future driver | Product decision and persisted migration gate. |

Two catalogue rules fall out of the key-matching contract and are enforced by the
catalogue test rather than remembered:

- **No default combines Shift with a punctuation key.** Trusted `Cmd+Shift+/`
  reports `?`, so `Mod+Shift+/` would never match. Recorded bindings round-trip
  because the recorder normalizes the same way.
- **A macOS default combining Alt with a letter must explicitly match the
  physical key.** Option changes the character reported by `event.key`.

The project is officially alpha and its API is subject to change. Therefore:

- app code imports only Relayed APIs;
- only `shared/shortcuts/tanstack-driver.ts` imports TanStack, and a boundary
  rule rejects the import anywhere else;
- the accepted version is exact, with no caret or tilde, and an upgrade re-runs
  the spike before the pin moves;
- the lockfile and the official-doc entry in `STACK.md` land with the
  dependency; and
- contract tests describe the behavior Relayed relies on, so an upgrade fails
  before it changes production shortcuts.

### 11.1 What the spike left to later steps

| Gap | Where it is proven |
|---|---|
| A real non-US layout, a real IME, and trusted Windows and Linux events | The manual platform matrix |
| A native menu accelerator and the renderer dispatcher firing exactly once | The native application menu step |
| The production build with the import in place | ✅ Proven. The shared contract step ran it under Electron's Node with the dependency external; the renderer command bus step bundled it into the renderer build. |

### 11.2 Installation

```bash
pnpm --filter @relayed/desktop add -E @tanstack/hotkeys@0.8.0
```

The Relayed dispatcher calls `preventDefault` only after it finds a command
winner and never stops propagation itself; nothing from TanStack registers a
listener except the recorder while it is recording.

---

## 12. How features use the framework

### 12.1 Add an application command

1. Add a data-only definition to the catalogue with a stable ID, title,
   category, defaults, input policy, repeat policy, and optional native-menu
   placement.
2. Add or update catalogue tests for uniqueness, cross-platform conflicts, and
   display.
3. Register the handler at the narrowest owner with `useCommandHandler`.
4. Make every visible entry point call `useCommand(id).execute`.
5. Render its effective shortcut through `Shortcut` or the command state;
   never hand-write `Command K` in a title.
6. Exercise the action by mouse, key, and any declared menu entry.

No feature component imports TanStack or attaches a document keydown listener.

### 12.2 Add focused component behavior

Keep intrinsic navigation in the component. Examples include arrow-key
selection in `cmdk`, Escape to close an open dialog, Tab traversal, and
ProseMirror selection movement. Use the command framework only when the action
also has a semantic entry point elsewhere or must be configurable.

### 12.3 Bridge a Tiptap command

The editor adapter asks for the command's effective bindings and exposes them
through a Tiptap extension's `addKeyboardShortcuts`. Its callback executes the
same command ID against the editor-layer handler. For a binding Tiptap already
owns, the integration must remove or override the built-in binding at a known
extension priority; it may not add a second listener and hope propagation
chooses correctly.

**Built for composer send, differently from the plan above.** The composer
keeps its capture-phase `onKeyDownCapture` handler — it must run after the
suggestion menu has had Return and before ProseMirror inserts a paragraph — and
that handler now asks `isSendKey` (`features/chat/composer/send-key.ts`) with the
bus's effective bindings for `composer.message.send`. So a remap applies with
the existing timing, and the document adapter never indexes the command.

The keyboard path calls the composer's own `send()` rather than
`execute('composer.message.send')`, for a reason the plan did not anticipate:
a space and a side chat can each mount a composer, so the bus handler is enabled
only while its editor has focus, and that flag reaches the registry in an effect
after the render that follows focusing. A key pressed in that gap could resolve
to `disabled` and fall through as a newline — not observed, but not worth
risking on the one key people press most. The keys already know which composer
they are in. The bus handler is still registered, for entry points that do not —
a future palette or menu item acting on the focused composer.

Behavior changes from the hard-coded check it replaced, both from exact
modifier matching: Control+Return no longer sends on macOS (the binding is
Command+Return), and Alt+Return no longer sends anywhere.

The `addKeyboardShortcuts` bridge described above remains the route for
promoting a Tiptap-owned formatting command into the catalogue.

### 12.4 Add a native menu entry

Only catalogue definitions marked `nativeMenu` may enter the main-process menu
template. The primary effective chord converts to Electron accelerator syntax
in the shared driver. A chord ending in a layout-produced character such as `?`
has no accelerator and stays renderer-owned. Clicking the menu sends the command ID to the focused renderer,
which executes it through the bus.

A menu command must be `allow-editable`, and the catalogue test fails
otherwise: main cannot see DOM focus, so it could not honour a deny policy.

---

## 13. Shortcut settings

Add `/settings/shortcuts` under account settings. It uses the ordinary
live-query preference read, so another window's edit repaints this one and the
page works offline.

### 13.1 Layout

The page contains:

- a search field over command title, description, category, and binding;
- commands grouped by category;
- the platform-formatted effective bindings;
- a status badge for **Default**, **Custom**, **Disabled**, **Conflict**, or
  **Unavailable on this platform**;
- a record button, remove button per binding, disable action, and reset action;
  and
- **Reset all shortcuts**, implemented as explicit clears of known shortcut
  keys rather than deleting arbitrary preferences.

The settings page uses the command catalogue for rows even when every value is
at its default. It does not enumerate the preference table, because missing
rows are meaningful.

### 13.2 Recording flow

Built in `routes/AccountSettingsShortcuts.tsx` with
`lib/commands/use-shortcut-recorder.ts`. Where it differs from the first
proposal, the difference is stated.

1. **Record** (or **Add**, when the command already has a binding) is itself
   the capture control: a button, because TanStack's recorder ignores key
   presses while a text input has focus. Its label reads "Press keys… Esc to
   cancel" while recording. No separate recorder-layer handler is registered:
   the recorder listens on document capture and stops propagation, which the
   command bus spike shows is enough for no command to fire while recording.
2. The recorded chord is written immediately rather than shown for
   confirmation first; the new binding appears in the row the moment the write
   lands. A chord that needs a decision stops before writing (steps 5 and 6).
3. Escape cancels. A bare Backspace also cancels — the recorder reports it as
   an empty chord — rather than removing a binding; each binding has its own
   remove button instead.
4. Pure modifier presses do not record.
5. A hard conflict offers **Replace existing** or **Cancel**. Replace submits
   the new chord and its removal from the other command in one `prefs.apply`.
6. Two kinds of chord are refused with an explanation, in the engine as well as
   here (`bindingProblem` in `shared/shortcuts/resolve.ts`): a **reserved** chord
   the OS or Electron's standard Edit and Window roles own — copy, paste, undo,
   select all, quit, close, hide, minimize, app switching — and a
   **character-only** chord (no Control, Alt or Command, and not a function
   key) on any command that is not a focused editor's. There is no warn-and-
   confirm tier yet: nothing outside the reserved list is reliably known to be
   dangerous.
7. Successful writes apply immediately through live-query invalidation. There
   is no Save page button and no second draft authority.

Each row also has **Disable** (writes an empty list) and **Reset to default**
(clears the row), and shows Custom, Disabled, Conflict or "Unreadable, using
default". A hard conflict names the other command; a shadow names what wins
while it has focus. Signed out, the page shows defaults, row controls are
absent and **Reset all** is disabled.

**Reset all** asks for confirmation, then uses the same atomic operation to
clear the row of every command not at its default. It cannot touch appearance
or a key unknown to this build.

### 13.3 Display and assistive metadata

One formatter produces distinct outputs:

- compact visual glyphs for `<kbd>` on macOS;
- localized text labels for Windows and Linux;
- Electron accelerator syntax for main; and
- WAI-ARIA key tokens such as `Meta+K` or `Control+K`.

These are projections of one normalized binding, not persisted strings.
`aria-keyshortcuts` lists all effective bindings that can activate that control
in its current context. Tooltips expose the primary binding. The settings page
exposes them all.

---

## 14. Native menu design

Built in `apps/desktop/src/main/menu.ts`, installed from `main/index.ts` before
the first window.

**What it replaces.** Without `Menu.setApplicationMenu` Electron installs a
default menu, and on macOS that menu is what makes copy, paste and undo work in
a text field. Setting a menu discards it wholesale, so the replacement keeps
every role the default carried. Read from Electron 44 at runtime, the macOS
default is App (about, services, hide, hide others, show all, quit), File
(close), Edit (undo through select all, substitutions, speech), View (reload,
force reload, developer tools, zoom, full screen) and Window (minimize, zoom,
bring all to front). There is no Help menu to keep.

| Platform | Menu |
|---|---|
| macOS | **Relayed**: About · **Settings… ⌘,** · Services · Hide · Hide Others · Show All · Quit — then the File, Edit and Window role menus, and **View**: **Search ⌘K** · **Keyboard Shortcuts ⌘/** · reload, developer tools, zoom and full screen roles |
| Windows, Linux | **File**: **Settings… Ctrl+,** · Quit — then the Edit and Window role menus, and the same **View** |

Role menus are used as roles wherever nothing is added to them, so Electron keeps
supplying their contents. Only catalogue commands marked `nativeMenu` appear,
and each must be `allow-editable` (the catalogue test holds that).

**One keyboard owner: the renderer.** This section first proposed the opposite
for menu-safe commands — main owning the accelerator and the renderer omitting
it. That was dropped because it cannot be verified here: `sendInputEvent` never
reaches menu accelerators, and driving real keystrokes needs an accessibility
permission. So the design does not depend on the order in which macOS offers a
key to the menu and to the page:

- a Relayed item carries its accelerator for **display** only;
- on Windows and Linux, `registerAccelerator: false` means exactly that;
- macOS always registers a menu accelerator, so `before-input-event` calls
  `setIgnoreMenuShortcuts(true)` for the one key press that matches a Relayed
  item's current binding — matched through the same driver the renderer uses —
  and `false` for every other press, so role shortcuts such as copy still reach
  the menu; and
- the renderer's command bus handles the key as it does every other shortcut,
  with layers, editable focus and remapping intact.

A menu **click** sends only the command ID to the focused window; the preload
drops any ID not on the menu allow-list and the renderer executes it through
the bus. The three menu commands are idempotent, so even if the guard failed on
some platform a doubled invocation would open search or navigate twice, not do
something twice.

**Keeping labels current.** Sync owns the preference rows, so it tells main the
menu items' effective bindings over `shortcuts:menu` (validated on arrival)
wherever it applies the theme — boot, account adoption, sign-out — and after any
keybinding `prefs.set`, `prefs.clear` or `prefs.apply`. Main starts from the
defaults. The development inspector's session-only remaps do not reach the menu.

**Role chords are reserved.** A binding on a chord a kept role owns — reload,
zoom, developer tools, full screen, hide others, paste and match style, besides
the edit and window chords — would fire the role as well, so `bindingProblem`
refuses them.

Electron's `globalShortcut` module is not used. If a future feature truly needs
to work while Relayed is unfocused, it gets a separate design covering OS
permissions, registration failure, Wayland portals, keyboard layouts, lifecycle
cleanup, and user-visible enablement.

---

## 15. Verification strategy

### 15.1 Pure contract tests

- Command IDs and preference keys are unique and stable snapshots are reviewed.
- Every default parses and normalizes on every supported platform.
- Default hard conflicts fail the catalogue test.
- No default combines Shift with a punctuation key, and every macOS default
  combining Alt with a letter explicitly opts into physical-key matching.
- Alias spellings normalize to one index key.
- Missing, custom, disabled, malformed, and newer unknown overrides resolve as
  specified.
- Electron and WAI-ARIA formatters accept every menu-safe default.
- User rows cannot name an unknown command, binding kind, or extra property.

### 15.2 Registry tests

- Named layer precedence is fixed and independent of registration order.
- Disabled and unavailable outcomes do not consume a key event.
- Same-command, same-layer duplicate handlers fail deterministically.
- Unmount removes a handler and React StrictMode does not leak a registration.
- A handler always sees current React state rather than a stale closure.
- Programmatic and keyboard invocation call the same handler once.

### 15.3 DOM behavior tests

- Input, textarea, select, contenteditable, and ordinary document targets obey
  each input policy.
- `defaultPrevented`, composition, AltGraph, exact modifiers, and repeat follow
  the dispatch algorithm.
- Prevent default happens only after an eligible winner is found.
- Recorder, dialog, editor, route, and shell precedence is demonstrated with
  real keyboard events.
- Remapping changes matching, tooltip text, and `aria-keyshortcuts` together.

### 15.4 Storage and process tests

- The existing SQLite engine executes set, clear, reset, malformed value, and
  unknown command cases against a real account database.
- A fine `prefs:keybindings.<id>` invalidation wakes the coarse preference
  query.
- Account switch replaces bindings; signed-out writes are refused and defaults
  remain readable.
- Sync sends only the native-safe snapshot; main rejects unknown commands and
  malformed accelerators.
- A native menu accelerator reaches the focused renderer exactly once.
- The replacement menu keeps every standard role Electron's default menu
  supplied.
- Preload teardown removes the native command subscription on reload.

### 15.5 Editor integration tests

- `Mod+B` toggles bold in the composer and the sidebar elsewhere.
- Enter accepts an open mention or slash-command suggestion and does not send.
- Enter and `Mod+Enter` send when no higher editor overlay handles them.
- Plain Enter inside a code block and `Shift+Enter` anywhere insert a line
  break; `Mod+Enter` sends from both.
- Composition Enter does not send.
- A remapped send binding follows the same capture and suggestion ordering.

### 15.6 Manual platform matrix

Exercise at least:

| Platform | Layout/input |
|---|---|
| macOS | US plus one non-US layout and an active IME |
| Windows | US plus an AltGraph layout |
| Linux | X11 or Wayland used by release testing, plus one non-US layout |

For each, record, invoke, display, disable, reset, switch accounts, type in the
composer, open settings, and invoke safe commands from the native menu. Browser
automation alone cannot validate OS menu labels or keyboard-layout behavior.

### 15.7 Repository checks

Each implementation slice runs the narrow tests it adds. Before the framework
is called complete, run:

```bash
pnpm --filter @relayed/desktop test
pnpm --filter @relayed/desktop typecheck
pnpm --filter @relayed/desktop build
pnpm check:boundaries
pnpm test
pnpm spike:sync
pnpm verify:hotkeys
```

The sync protocol spike is not logically about shortcuts; it is still required
because preference and process-boundary work touches the sync engine.

---

## 16. Observability — proposed, not added

**Status: no marker is emitted.** Neither marker below has been agreed, so
neither exists; until one is, the tests, the spikes and the development command
inspector are what the first release relies on.

No instrumentation is authorized by this plan. The observability doc requires
agreement on the question and cost before adding a marker. The useful proposal
is deliberately small:

| Proposed marker | Question it answers | Value | Cost and limit |
|---|---|---|---|
| `shortcut.binding.changed` with bounded command ID and outcome | Are edits, resets, and conflict replacements succeeding in released builds? | Finds persistence or validation regressions that unit tests cannot see on a person's layout. | Low frequency. Never include the raw chord, focused text, route parameters, or account ID. |
| `shortcut.command.unhandled` with bounded command ID and source | Did a native menu or visible control invoke a command whose renderer handler was absent? | Detects process or lifecycle gaps such as a root handler disappearing on a route. | Emit only for recognized invocations, rate-limit per command and window, and do not emit for arbitrary unmatched key presses. |

Do not count every keydown, every successful invocation, or every unmatched
gesture. Those streams answer no durable product-health question, risk capturing
input characteristics, and add noise around the lifecycle failures that matter.

If the developer declines both markers, tests plus a development-only registry
inspector are sufficient for the first slice. If either is accepted, add it to
the typed telemetry catalogue before emitting it; command IDs are safe labels
only because the catalogue bounds them.

---

## 17. Implementation plan

Every step ends in something that can be exercised, not just a type layer that
looks plausible.

| Named step | Order | Work | Proof before moving on |
|---|---:|---|---|
| **TanStack behavior spike** — ✅ done, [`spikes/hotkeys/`](../spikes/hotkeys/README.md) | 1 | Build `spikes/hotkeys/`, run the admission cases, choose and exactly pin or reject the dependency. Record official docs and the decision in `STACK.md`. | The spike passes with real DOM events. The desktop production build moved to the next step, because the dependency may not enter app code before admission. |
| **Shared command contract** — ✅ done, `shared/shortcuts/` | 2 | Install the pinned dependency. Add the catalogue, persisted schema, resolver, platform type, TanStack core adapter, Electron accelerator formatter, and unit tests. Add the import boundary rule. No UI yet. | Every proposed default resolves without a hard conflict on macOS, Windows, and Linux. The contract runs under Electron's Node with the dependency external. |
| **Renderer command bus** — ✅ done, `renderer/lib/commands/` | 3 | Add root `CommandProvider`, registry, named layers, execution outcomes, and the single renderer adapter. The typed context waits for its first consumer. | A test surface invokes one command from a key and a button; StrictMode leaks nothing; the renderer production build passes with the dependency bundled. |
| **Existing shell migration** — ✅ done; confirm by hand in the app | 4 | Move search and sidebar toggle into root-lifetime commands. Delete their component-owned window listeners. Derive the search button's labels. | `Mod+K` works on workspace and settings routes; `Mod+B` toggles the sidebar outside the composer and leaves bold alone inside it. |
| **Presentation seam** — ✅ done | 5 | Add `useCommand`, `Shortcut`, menu/tooltip/ARIA formatters, and a development inspector. Convert existing visible entry points. | Remapping a test override updates matching and every displayed representation from one state. |
| **Persistent overrides** — ✅ done; confirm by hand in the app | 6 | Extend the closed preference key family, add `prefs.clear` and transactional `prefs.apply`, resolve live overrides, update preference rationale, and test real SQLite behavior. | Custom, disabled, replacement, reset-all rollback, corrupt, signed-out, and account-switch flows work offline. |
| **Shortcut settings surface** — ✅ done; confirm by hand in the app | 7 | Add `/settings/shortcuts`, searchable grouped rows, recorder, conflict flow, disable/reset, and reset all. | A person can complete every flow by hand without reopening the app; the recorder cannot trigger another command. |
| **Native application menu** — ✅ done; confirm the key path by hand | 8 | Build standard-role menus, send safe command IDs through preload, distribute safe effective bindings from sync, and enforce one keyboard owner. | Menu click and accelerator each execute once; custom bindings update after write, clear, and account switch. |
| **Composer adapter** — ✅ done; confirm by hand in the app | 9 | Route send through its command, preserve capture timing, make suggestion precedence explicit, and add the focused editor integration tests. | Suggestions, IME, Enter, `Mod+Enter`, remapped send, and editor bold all behave as the composer contract says. |
| **Hardening and documentation closeout** — docs done; platform matrix and observability decision open | 10 | Run the platform matrix, decide observability markers, update `FRONTEND.md`, `PREFERENCES.md`, `COMPOSER.md`, and the design invariants if needed. | Full repository checks pass and each claimed flow has been exercised by hand on its owning platform. |

The first shippable vertical slice is the renderer command bus plus migration of
search and sidebar toggle. Persistent customization is the next slice, not a
reason to postpone removing the two competing document listeners.

---

## 18. Definition of done

The framework is complete for its first release when all of these statements
are true. Status as of 2026-09-14:

| Statement | Status |
|---|---|
| No feature-owned global key listener | ✅ `shortcuts/no-global-key-listener` boundary rule |
| Search works on every route | ✅ root `SearchPalette`; confirm by hand |
| Sidebar toggle and Tiptap bold have tested ownership | ✅ command bus spike |
| One execution path for keys, buttons and menu items | ✅ bus, menu spike |
| Effective bindings = defaults + live overrides | ✅ `app/Commands.tsx`, engine tests |
| Record, replace, disable and reset offline | ✅ settings page; confirm by hand |
| Conflict, input, composition, AltGraph, repeat, exact-modifier tests | ✅ unit tests and spikes (AltGraph and IME with constructed events) |
| Labels and ARIA cannot drift from matching | ✅ remap spike |
| Standard editing and OS conventions stay native | ✅ menu roles kept; reserved chords refused |
| Main and preload accept only menu-safe command IDs | ✅ `parseMenuItems`, preload allow-list, menu spike |
| Platform and layout matrix exercised by hand | ⏳ open |
| Stack doc, implementation docs, repository checks | ✅ |

The original statements:

- No feature-owned application shortcut installs a document or window keydown
  listener outside the driver or an approved focused-component adapter; a
  boundary test enforces it where practical.
- Search works on every route because its handler lifetime is the application,
  not the sidebar.
- Sidebar toggle and Tiptap bold have deterministic, tested ownership.
- Buttons, keys, safe native menu items, and future palette entries share one
  command execution path.
- Every effective binding comes from defaults plus the account's live
  preference overrides.
- A person can record, replace, disable, and reset a configurable binding
  offline.
- Conflict, input, overlay, composition, AltGraph, repeat, and exact-modifier
  behavior have executable tests.
- Visible shortcut labels and assistive metadata cannot drift from matching.
- Standard text editing and OS conventions remain native or component-owned.
- The main and preload boundary accepts only known, menu-safe command IDs.
- The supported platform/layout matrix has been exercised by hand.
- The current official library and Electron documentation is recorded in the
  stack doc, the implementation docs describe what was actually built, all
  repository checks pass, and the knowledge graph is current.

---

## 19. Sources and standards consulted

These are the current official references this proposal was checked against:

- [TanStack Hotkeys overview](https://tanstack.com/hotkeys/latest/docs/overview)
  — alpha status and the library's intended scope.
- [TanStack core API](https://tanstack.com/hotkeys/latest/docs/reference)
  — parser, normalization, matching, recording, and display seams.
- [Electron keyboard shortcuts](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)
  and [Electron menus](https://www.electronjs.org/docs/latest/tutorial/menus)
  — focused-app accelerators, system-wide shortcuts, and native menus.
- [MDN `KeyboardEvent.key`](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key)
  and [MDN `KeyboardEvent.code`](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code)
  — the produced character versus the labelled physical key, including the
  layout trade-off of physical matching.
- [Apple keyboard guidance](https://developer.apple.com/design/human-interface-guidelines/keyboards)
  — standard shortcuts, modifier conventions, and restraint.
- [Windows keyboard accelerators](https://learn.microsoft.com/en-us/windows/apps/develop/input/keyboard-accelerators)
  — command association, scope, accessibility, and discoverability.
- [VS Code keyboard shortcuts](https://code.visualstudio.com/docs/configure/keybindings)
  — stable command IDs, platform overrides, contexts, conflict inspection, and
  optional physical scan-code bindings.
- [WAI-ARIA `aria-keyshortcuts`](https://www.w3.org/TR/wai-aria/#aria-keyshortcuts)
  — token format, discoverability, and assistive-technology semantics.
- [WCAG character key shortcuts](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html)
  — remap, disable, or focused-component requirements.
- [Tiptap extension API](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/extension#addkeyboardshortcuts)
  — the editor-owned `addKeyboardShortcuts` integration point.
