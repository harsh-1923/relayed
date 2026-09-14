# web panels spike

Evidence for drawing web pages inside panels as `<webview>`
([`docs/PANELS.md`](../../docs/PANELS.md), web pages). A standalone npm project,
not a workspace member — like `spikes/hotkeys`.

It runs the app's real attach check (`apps/desktop/src/main/web-panels.ts`,
bundled with esbuild) in a window with the app's own `webPreferences` and the
renderer's real Content-Security-Policy, read from its `index.html`. Pages come
from a local HTTP server. `shell.openExternal` is replaced with a recorder, so
nothing opens in the system browser.

## Run

```bash
cd spikes/web-panels
npm install --ignore-scripts
npm test
```

`pnpm verify:web-panels` at the root runs the same. It borrows `apps/desktop`'s
Electron binary, so `pnpm install` must have run at the root first.

A window appears for about fifteen seconds. **Leave it uncovered**: the drawing
checks read pixels back from the window, and macOS stops painting what another
window hides. They poll for up to three seconds, because drawing crosses
processes and a single read can land a frame early — reading once is what made
early runs fail with white where the page had not been drawn yet.

## Result — 2026-09-14

Electron 44.2.0, Chromium 152, macOS. **19 passed, 0 failed**, three runs in a
row.

Time until the pixels were right, including the read-back itself (about 30ms
each): first draw 67–97ms; an element drawn over the page 50ms, once 875ms; a
parked page drawn again **11–49ms** after being brought back — so switching to a
web tab does not flash an empty panel.

| Question | Answer | Consequence |
|---|---|---|
| Does a `<webview>` load under the renderer's CSP, which says `frame-src 'none'`? | Yes. The tag is not governed by `frame-src`. | The CSP stays as it is. |
| Is the page sandboxed, isolated, without Node, in the account's session? | Yes. | — |
| Does a tag that asks for a `preload` and `nodeIntegration=true,sandbox=false,contextIsolation=false` get them? | No: the check deletes the preload and forces the rest. | Security does not depend on what the renderer writes on the tag. |
| Does a tag in another account's partition, with no partition, or on a `file:` URL attach? | No. | — |
| Do `window.open` and a `target="_blank"` link reach the system browser without opening a window? | Yes, with `allowpopups` on the tag. A `file:` URL goes nowhere. | `WebPanel` sets `allowpopups`. |
| Can the page navigate to `file:`, `relayed-blob:` or `relayed:`? | No. **Control:** an unguarded page on the same server does reach `relayed-blob:`, so it is the guard refusing it, not Chromium. `file:` Chromium refuses on its own. | — |
| Is a server redirect to `file:` followed? | No; Chromium also reports `ERR_UNSAFE_REDIRECT`. | — |
| Permissions? | `clipboard-write` granted; geolocation, notifications, `clipboard-read` denied. | — |
| User agent? | No `Electron/`, the app's own token kept, but only when the session is set up **before** the page attaches: a page created earlier keeps the old one. | The check sets the session up in `will-attach-webview`, not after. Removing the app's token as well was tried first: Google's sign-in then refused with "This browser or app may not be secure", since the agent claimed Chrome while Client Hints said Chromium. t3code's agent keeps its app name and signs in. |
| Is the page drawn at its element, and does an element with a higher z-index draw over it? | Yes, read back from the window's pixels. | Menus and dialogs need nothing special. |
| Does a webview parked at `left: -100000px` keep its page and draw again? | Yes: same page load, and pixels on return. | Hidden tabs are parked, not unmounted. |
| Does moving a webview to another parent reload it? | Yes. | The container keeps web tabs in one place, in tab order. |
