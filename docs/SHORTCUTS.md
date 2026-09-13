# Commands and keyboard shortcuts

> **Status: a proposal, not yet the design of record.** Only the first step
> is done: the TanStack behavior spike admitted `@tanstack/hotkeys@0.8.0` in a
> narrowed role (§11). No application code is built. It refines the shortcut seam named in the frontend doc's
> shell architecture section (`FRONTEND.md`, the command and shortcut seam in
> §6.4). Until the implementation and its accompanying design-doc edits land,
> the current code and the existing design docs win.
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

There is no disagreement between code and the existing docs: the frontend doc
calls for a seam and marks no implementation. This proposal makes that seam
precise enough to build and test.

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

Bindings use logical `KeyboardEvent.key` semantics in the first release. This
makes the character the person typed the default meaning. TanStack's
`matchesKeyboardEvent` falls back to `event.code` for punctuation, digits,
dead keys and Alt-modified letters, and the admission spike showed that
fallback breaks this contract with no option to disable it. Relayed therefore
matches by looking up `normalizeHotkeyFromEvent(event)` in its own index, which
reads only `event.key` and the modifier flags. The
recorder normalizes the current platform's primary modifier to `Mod`. A future
physical-key mode can use `KeyboardEvent.code`, but it must be an explicit
binding kind rather than a silent fallback exposed as user data.

Composition events never dispatch commands. AltGraph is treated as text entry,
not as Control+Alt. Manual verification includes a non-US layout and an IME.

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

Proposed home:

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

Proposed home:

```text
apps/desktop/src/renderer/lib/commands/
  CommandProvider.tsx
  registry.ts
  context.ts
  use-command-handler.ts
  use-command.ts
  Shortcut.tsx
```

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

The exact spelling can change during implementation, but the public concepts
must remain this small.

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
  readonly defaultBindings: PlatformBindings;
  readonly configurable: boolean;
  readonly inputPolicy: 'allow-editable' | 'deny-editable' | 'focused-editor';
  readonly repeat: 'ignore' | 'allow';
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

`enabled` may also be a predicate over the typed command context. There is no
string parser and no public bag of arbitrary context keys in the first release.
When repeated conditions emerge, they become named fields in
`CommandContextSnapshot`.

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
3. Return when AltGraph is active unless the binding explicitly supports it;
   no first-release binding does.
4. Return on repeat unless the command definition opts in.
5. Normalize the event and look it up in the effective binding index.
6. Apply the binding's editable-focus policy. Classification uses the composed
   event path and active element, including text-like inputs, textarea, select,
   contenteditable, and textbox roles; button-like inputs are not editable.
7. Ask the command bus for the highest eligible handler.
8. Only after a winner exists, prevent the browser default and execute it.

The adapter does not stop propagation by default. Overlay or editor owners may
do so when their component contract requires it. TanStack's registration
manager would prevent default and stop propagation whenever a registration
fires, which is one reason Relayed does not use it; the dispatcher needs to
know that a real command winner exists first.

Modifier matching is exact. `Mod+K` does not also match `Mod+Shift+K`.

### 8.3 Conflict classes

| Conflict | Treatment |
|---|---|
| Same normalized chord in the same or overlapping layer family | Hard conflict. Saving offers **Replace existing** or **Cancel**. |
| Same chord in ordered, mutually meaningful layers | Allowed shadow. The higher active layer wins and the settings row explains where. |
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

The preference vocabulary stays closed. `isPreferenceKey` accepts a keybinding
key only when all three are true:

- it has the exact `keybindings.` prefix;
- the suffix is a known configurable command ID; and
- its JSON value passes the shortcut schema and normalization gate.

`PreferenceKey` becomes the union of the existing fixed keys and
`` `keybindings.${ConfigurableCommandId}` ``. Defaults are still not written.
The preference doc's rationale that a settings-panel scan reads "a handful" of
rows (`PREFERENCES.md` §6) must be updated in the same implementation change:
the table remains bounded by the catalogue, but it grows with every customized
command.

`prefs.clear` routes through the existing `clearPreference` storage helper,
invalidates `prefs:<key>`, and performs the same key authorization as
`prefs.set`.

`prefs.apply` accepts a discriminated list of `set` and `clear` changes. The
engine validates every proposed value, resolves the resulting complete known
binding set, rejects hard conflicts, then commits all rows in one SQLite
transaction. This is required for **Replace existing** and **Reset all**: a
two-write sequence can leave the person with neither binding or both if the
second write fails.

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
| Navigate back — `navigation.back` | `Mod+[` | `Alt+ArrowLeft` | Denied in editable focus; route layer | No |
| Navigate forward — `navigation.forward` | `Mod+]` | `Alt+ArrowRight` | Denied in editable focus; route layer | No |
| Open settings — `app.settings.open` | `Mod+,` | `Mod+,` | Allowed in editable focus; application layer | Yes |
| Open keyboard shortcuts — `app.shortcuts.open` | `Mod+/` | `Mod+/` | Allowed in editable focus; application layer | Yes |
| Send message — `composer.message.send` | `Enter`, `Mod+Enter` | `Enter`, `Mod+Enter` | Focused editor only; editor layer | No |

The sidebar decision is intentional: `Mod+B` remains a familiar shell binding
outside editable controls, while Tiptap keeps standard bold behavior inside the
composer. The binding policy belongs to the catalogue and is applied only to
keyboard dispatch; clicking the sidebar button still works while an editor has
focus.

Composer send is one command with two defaults, and they are not symmetric.
Today `Mod+Enter` always sends, while plain `Enter` sends only when the
selection is outside a code block; `Shift+Enter` inserts a line break. That
code-block condition is an editor-context fact the `composer.message.send`
handler's `enabled` predicate must preserve per binding, so a remapped plain
key cannot start sending from inside a code block. Suggestion acceptance sits in
the overlay layer and wins Enter while open. The existing capture-phase send
path stays editor-owned until an executable integration test proves another
event phase preserves that ordering.

Formatting commands are not customizable in the first release. Tiptap's local
keymap continues to own bold, italic, lists, undo, and redo. A later formatting
slice may promote selected actions into the catalogue, but only with a Tiptap
extension that disables or supersedes the corresponding built-in keymap so two
owners never coexist.

---

## 11. TanStack Hotkeys: use it as a driver, not the architecture

**Admitted by the spike: `@tanstack/hotkeys@0.8.0`, core only, exact pin.**
The evidence and every case are in [`spikes/hotkeys/`](../spikes/hotkeys/README.md)
(43 assertions against trusted Chromium key events in Electron 44.2.0).

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

Two catalogue rules fall out of the logical-key contract and are enforced by the
catalogue test rather than remembered:

- **No default combines Shift with a punctuation key.** Trusted `Cmd+Shift+/`
  reports `?`, so `Mod+Shift+/` would never match. Recorded bindings round-trip
  because the recorder normalizes the same way.
- **No macOS default combines Alt with a letter.** Option+K produces `˚`.

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
| The desktop production build with the import in place | The shared command contract step |

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

Composer send remains on the proven capture path initially, but its callback
becomes `execute('composer.message.send')`. This gets one action definition and
user customization without changing the timing that protects suggestions.

### 12.4 Add a native menu entry

Only catalogue definitions marked `nativeMenu` may enter the main-process menu
template. Safe effective chords convert to Electron accelerator syntax in the
shared driver. Clicking the menu sends the command ID to the focused renderer,
which executes it through the bus.

Commands denied in editable focus are not registered as native accelerators:
main cannot see DOM focus, so it cannot enforce that policy correctly.

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

1. Activating **Record shortcut** mounts the recorder layer and focuses a
   clearly labelled capture control.
2. The next complete chord is shown in platform notation before it is saved.
3. Escape cancels. Backspace or Delete removes the selected binding only when
   the capture control explains that behavior.
4. Pure modifier presses do not save.
5. A hard conflict offers **Replace existing** or **Cancel**. Replace submits
   the new command and removal from the old command in one atomic `prefs.apply`.
6. A reserved or unreliable chord explains the risk before confirmation; known
   destructive OS reservations are blocked.
7. Successful writes apply immediately through live-query invalidation. There
   is no Save page button and no second draft authority.

**Reset all shortcuts** uses the same atomic operation to clear every known
keybinding row. It cannot touch appearance or a key unknown to this build.

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

Relayed currently runs on Electron's default menu, which already supplies the
standard Edit and Window roles. Calling `Menu.setApplicationMenu` replaces that
menu entirely, so the replacement must restore every role the default provided
before adding Relayed entries; otherwise copy, paste, and undo accelerators
silently disappear on macOS.

The first application menu uses Electron roles wherever a role exists:

- application/about/settings/quit conventions on macOS;
- Edit roles for undo, redo, cut, copy, paste, delete, and select all; and
- Window roles for minimize, zoom, and front/window behavior.

Relayed-specific menu entries invoke command IDs. Main rebuilds the affected
menu sections when sync supplies a new safe-binding snapshot after account open,
account switch, write, or clear.

A binding has one keyboard owner on a platform:

- if it is installed as an active native menu accelerator, the renderer
  document adapter omits it and receives the resulting command invocation from
  main;
- if it is contextual, editor-owned, overlay-owned, or unsafe for main, the
  renderer owns it and the menu item has no active accelerator; and
- standard Electron roles are never duplicated in the command catalogue.

This avoids a menu accelerator and a renderer listener both executing one key
press. The admission spike must verify Electron's event behavior, and an
integration test asserts exactly one invocation.

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
- No default combines Shift with a punctuation key, and no macOS default
  combines Alt with a letter.
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
```

The sync protocol spike is not logically about shortcuts; it is still required
because preference and process-boundary work touches the sync engine.

---

## 16. Observability proposal — agree before implementation

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
| **Shared command contract** | 2 | Install the pinned dependency. Add the catalogue, persisted schema, resolver, platform type, TanStack core adapter, Electron accelerator formatter, and unit tests. Add the import boundary rule. No UI yet. | Every proposed default resolves without a hard conflict on macOS, Windows, and Linux, and the desktop production build passes with the import in place. |
| **Renderer command bus** | 3 | Add root `CommandProvider`, registry, named layers, typed context, execution outcomes, and the single renderer adapter. | A test surface invokes one command from a key and a button; StrictMode leaks nothing. |
| **Existing shell migration** | 4 | Move search and sidebar toggle into root-lifetime commands. Delete their component-owned window listeners. Derive the search button's labels. | `Mod+K` works on workspace and settings routes; `Mod+B` toggles the sidebar outside the composer and leaves bold alone inside it. |
| **Presentation seam** | 5 | Add `useCommand`, `Shortcut`, menu/tooltip/ARIA formatters, and a development inspector. Convert existing visible entry points. | Remapping a test override updates matching and every displayed representation from one state. |
| **Persistent overrides** | 6 | Extend the closed preference key family, add `prefs.clear` and transactional `prefs.apply`, resolve live overrides, update preference rationale, and test real SQLite behavior. | Custom, disabled, replacement, reset-all rollback, corrupt, signed-out, and account-switch flows work offline. |
| **Shortcut settings surface** | 7 | Add `/settings/shortcuts`, searchable grouped rows, recorder, conflict flow, disable/reset, and reset all. | A person can complete every flow by hand without reopening the app; the recorder cannot trigger another command. |
| **Native application menu** | 8 | Build standard-role menus, send safe command IDs through preload, distribute safe effective bindings from sync, and enforce one keyboard owner. | Menu click and accelerator each execute once; custom bindings update after write, clear, and account switch. |
| **Composer adapter** | 9 | Route send through its command, preserve capture timing, make suggestion precedence explicit, and add the focused editor integration tests. | Suggestions, IME, Enter, `Mod+Enter`, remapped send, and editor bold all behave as the composer contract says. |
| **Hardening and documentation closeout** | 10 | Run the platform matrix, decide observability markers, update `FRONTEND.md`, `PREFERENCES.md`, `COMPOSER.md`, and the design invariants if needed. | Full repository checks pass and each claimed flow has been exercised by hand on its owning platform. |

The first shippable vertical slice is the renderer command bus plus migration of
search and sidebar toggle. Persistent customization is the next slice, not a
reason to postpone removing the two competing document listeners.

---

## 18. Definition of done

The framework is complete for its first release when all of these statements
are true:

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
