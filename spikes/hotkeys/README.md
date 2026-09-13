# hotkeys spike

Admission evidence for TanStack Hotkeys, the first step of the shortcut
framework's implementation plan ([`docs/SHORTCUTS.md`](../../docs/SHORTCUTS.md),
"TanStack behavior spike"). A standalone npm project, not a workspace member —
like `spikes/electron-verify`. Not app code: the dispatcher in `renderer.jsx` is
the shape the renderer command bus is proposed to take, nothing more.

## Run

```bash
cd spikes/hotkeys
npm install --ignore-scripts
npm test        # the library admission cases
npm run test:bus  # the app's CommandProvider under trusted key events
```

`npm run test:menu` builds the app's menu in Electron and follows a click through
the app's real preload. `npm run test:composer` drives a composer-configured
Tiptap editor. `pnpm verify:hotkeys` at the root runs all four.

It borrows `apps/desktop`'s Electron binary so the spike runs the exact version
the app ships, so `pnpm install` must have run at the root first.

Key events are sent with `webContents.sendInputEvent`, so they travel Chromium's
input pipeline and arrive with `isTrusted: true`. IME composition and AltGraph
cannot be produced that way; those cases use constructed `KeyboardEvent`s and
are named `constructed:`.

## Result — 2026-09-14

Electron 44.2.0, Chromium 152, macOS. **43 passed, 0 failed.**

**Decision: admit `@tanstack/hotkeys@0.8.0` (core only, exact pin) as the
parser, normalizer, display formatter and recorder. Do not use its matcher, its
registration manager, or `@tanstack/react-hotkeys`.**

| Question | Answer | Consequence |
|---|---|---|
| Does `Mod` resolve per platform, and do aliases (`Cmd`, `Meta`, `Control`, `Ctrl`) collapse to one index key? | Yes: `normalizeHotkey` gives `Mod+K` for all of them on their platform; `Control+K` on mac stays distinct. | Index key = `normalizeHotkey(binding, platform)`. |
| Do trusted `Cmd+/`, `Cmd+,`, `Cmd+[`, `Cmd+]` normalize to the catalogue defaults? | Yes. | The initial catalogue needs no special cases. |
| Is modifier matching exact? | Yes when looking up `normalizeHotkeyFromEvent(event)` in the index: `Cmd+Shift+K` is not `Mod+K`. | — |
| Does `matchesKeyboardEvent` respect the logical-key contract? | **No.** A key producing `-` at the physical Slash position matches `Mod+/` through its `event.code` fallback, and Option+K matches `Alt+K`. No option disables it. | Match by index lookup on the normalized event, never with `matchesKeyboardEvent`, `HotkeyManager`, or `useHotkey`. |
| Does the library filter IME composition or AltGraph? | **No.** The matcher returns true for an `isComposing` event and treats AltGraph as `Control+Alt`. `getModifierState('AltGraph')` is readable in Chromium. | The Relayed dispatcher owns both guards, as the dispatch algorithm already says. |
| Shifted punctuation? | Trusted `Cmd+Shift+/` reports `key: "?"` and normalizes to `Mod+Shift+?`. | A default spelled `Mod+Shift+/` would never match. Catalogue test: no default combines Shift with a punctuation key. Recorded bindings round-trip because the recorder uses the same normalization. |
| Option-modified letters on mac? | `Option+K` normalizes to `Alt+˚`. | No mac default may use Alt with a letter. Recording one stores the produced character. |
| Recorder: round trip, modifiers, Escape, Backspace? | Recorded `Mod+Shift+J` survives JSON and matches a later trusted press. Pure modifiers do not record, Escape cancels. **Bare Backspace records `""` and fires `onClear`**. | The Relayed recorder treats `""` as "remove the selected binding", never as a stored hotkey. |
| Does the recorder beat the dispatcher? | Yes — it listens on document capture and stops propagation. | Matches the recorder layer's precedence without a special case. |
| Recorder with a focused text input? | **Ignored** under the default `ignoreInputs`. | The capture control is a button, not an input. |
| `validateHotkey` as the schema gate? | **Not sufficient.** `Mod+Foo` and `Mod+Shift` are `valid: true` with warnings; only empty and malformed strings fail. | The Relayed schema also requires `hasNonModifierKey`, a key in TanStack's known-key set, and the normalized form to equal the stored form. |
| WAI-ARIA and platform display? | `formatHotkey(parseHotkey(...))` gives `Meta+K` / `Control+K`; `formatForDisplay` gives `⌘ ⇧ P` on mac and `Ctrl+Shift+P` on Windows and Linux. | Both formatters are usable. |
| Electron accelerator syntax? | No formatter exists. | `shared/shortcuts` writes one from the parsed hotkey; it is a few lines. |
| One document listener for a changing binding set? | Yes: rebinding swaps the index without adding a listener. | — |
| React StrictMode? | The dispatcher effect nets exactly one listener after the double mount and zero after unmount; `HotkeyRecorder.destroy()` removes its listener. | `@tanstack/react-hotkeys` adds nothing the bus needs; a recorder hook is `useSyncExternalStore` over `recorder.store`. |
| Editable-focus classification? | Text input, textarea, select, contenteditable, `role=textbox`, and a text input inside an open shadow root are editable; button, checkbox and a `<button>` are not. | TanStack's `isInputElement` treats every non-button input (checkbox included) as editable and ignores `role=textbox` and shadow roots, so Relayed keeps its own classifier. |
| Can Electron main load it? | Both `require` and `import` work; main externalizes dependencies. | Safe to import from `shared/shortcuts` in every process. |

## The command bus — 2026-09-14

`bus.jsx` mounts the app's own `CommandProvider`, `useCommandHandler` and
`useCommand` from `apps/desktop/src/renderer/lib/commands/` under StrictMode —
not a prototype — and `bus.cjs` drives it. **23 passed, 0 failed.**

- StrictMode nets one document listener; unmount returns it to zero and no
  handler survives.
- A trusted Cmd+K and a button click execute the same handler, and the handler
  sees its latest render's state rather than a stale closure.
- The button's `aria-keyshortcuts` and title come from the effective binding
  (`Meta+K`, `Search (⌘ K)`; `Control+K` when mounted as Windows).
- An overlay handler outranks the application handler; unmounting it restores
  the application handler.
- No handler, or a disabled one: nothing runs, the default is not prevented, and
  the button disables.
- Cmd+B in a text field is not the sidebar's; Cmd+K there still runs search.
- A capture-phase `preventDefault` from an earlier owner wins.
- Two handlers in one layer: neither runs, and development raises an error
  naming the command and layer.
- Added with the shell migration: Cmd+B inside a Tiptap editor configured like
  the composer (StarterKit) makes the selection bold and does not reach the
  sidebar handler; outside the editor it toggles the sidebar again. Making the
  sidebar binding allow-editable does not break this case — Tiptap prevents the
  default first — while it does break the plain text-field case, so the two
  tests cover different defenses.
- Added with the presentation seam: one session remap to `Mod+Shift+P` stops
  Cmd+K matching, starts Cmd+Shift+P matching, and changes the button title
  (`Search (⌘ ⇧ P)`), its `aria-keyshortcuts`, and the `Shortcut` component's
  keys and label together. Disabling removes every representation while the
  button still executes; reset restores all of them. TanStack's ARIA formatter
  orders modifiers `Shift+Meta+P`; WAI-ARIA does not require an order.
- Added with the settings surface: the app's `useShortcutRecorder` records a
  trusted Cmd+K as `Mod+K` without search running, ends after one chord, treats
  Escape and a bare Backspace as cancel, and removes its capture listener when
  unmounted mid-recording.
- Added when back, forward, settings and shortcuts were wired: trusted Cmd+[,
  Cmd+], Cmd+, and Cmd+/ reach those four handlers; back with nowhere to go
  leaves the key alone; in a text field back is denied while settings runs;
  mounted as Windows, Alt+ArrowLeft and Alt+ArrowRight navigate and Cmd+[ does
  not. The Tiptap focus check now polls for focus: at a fixed 40 ms it failed
  once in four runs.

## The application menu — 2026-09-14

`menu.cjs` bundles `apps/desktop/src/main/menu.ts` and the app's real preload.
**9 passed, 0 failed.**

- Electron's `Menu.buildFromTemplate` accepts the macOS, Windows and Linux
  templates.
- Installed, the Edit role still carries copy, paste and undo; quit, close,
  minimize and reload are present.
- The Relayed items display `Command+K`, `Command+,` and `Command+/`.
- Clicking each item delivers its ID to the page through the sandboxed preload,
  once; an ID off the allow-list (`shell.sidebar.toggle`, an unknown string, a
  number, null) is dropped; unsubscribing stops delivery.
- `before-input-event` reports the logical key, and the guard claims Cmd+K and
  Cmd+, but not Cmd+C.

Found while building it: `webContents.sendInputEvent` never reaches menu
accelerators (a probe with a Command+K item recorded no menu invocation with or
without the page calling `preventDefault`), and `osascript` keystrokes need an
accessibility permission this machine does not grant. Whether a real key press
invokes a Relayed command exactly once is therefore a hand check.

## Composer send — 2026-09-14

`composer.jsx` mounts Tiptap with StarterKit and the app's own
`ComposerSuggestions`, inside the app's `CommandProvider`, with a capture-phase
handler calling the app's `isSendKey` exactly as `MessageComposer` does.
`MessageComposer` itself needs the sync bridge, so it is not mounted whole.
**6 passed, 0 failed**, three runs in a row.

- Typed text then a trusted Return sends; Shift+Return does not and inserts a
  `<br>`.
- In a code block Return adds a newline and Cmd+Return sends.
- With the `@` menu open, Return and Cmd+Return send nothing and the menu stays
  open.
- Remapped to Cmd+Return only, Return makes a new paragraph and Cmd+Return
  sends; disabled, neither sends.

Removing the suggestion guard or the code-block rule from `isSendKey` fails the
matching case here and in `send-key.test.ts`. A first version of this spike
failed the menu case because its stub suggestion handler did not consume Return
the way `forwardSuggestionKey` does; the stub now matches.

## Not covered here, and where it is proven instead

| Gap | Why | Where |
|---|---|---|
| A real non-US layout and a real IME | `sendInputEvent` cannot switch the OS layout or open an IME. | The manual platform matrix in `SHORTCUTS.md`. |
| Windows and Linux trusted events | The spike ran on macOS; those platforms were exercised through the pure functions with an explicit `platform`. | The same manual matrix. |
| A real key press on a Relayed menu item invoking once | `sendInputEvent` does not reach menu accelerators (now verified), and synthetic OS keystrokes need an accessibility permission. | By hand, on macOS first. |
| The desktop production build | The dependency may not enter app code before this spike admits it. | The shared command contract step runs `pnpm --filter @relayed/desktop build` with the import in place. |
