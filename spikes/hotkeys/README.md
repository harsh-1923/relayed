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
npm test        # or, from the root: pnpm verify:hotkeys
```

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

## Not covered here, and where it is proven instead

| Gap | Why | Where |
|---|---|---|
| A real non-US layout and a real IME | `sendInputEvent` cannot switch the OS layout or open an IME. | The manual platform matrix in `SHORTCUTS.md`. |
| Windows and Linux trusted events | The spike ran on macOS; those platforms were exercised through the pure functions with an explicit `platform`. | The same manual matrix. |
| Native menu accelerator plus renderer dispatch firing once | There is no application menu to test against yet, and whether `sendInputEvent` reaches menu accelerators at all is unverified. | The native application menu step, by hand and with an integration test. |
| The desktop production build | The dependency may not enter app code before this spike admits it. | The shared command contract step runs `pnpm --filter @relayed/desktop build` with the import in place. |
