# annotations spike

Evidence for annotations ([`docs/ANNOTATIONS.md`](../../docs/ANNOTATIONS.md)):
**capturing** a passage from a web panel, and **navigating** back to it. A
standalone npm project, not a workspace member — like `spikes/web-panels`, whose
harness this borrows.

The first question it answers is one reading could not. The URL Fragment Text
Directives spec says the directive fires only on *"user-initiated top-frame
navigations, so iframes, scripts, and same-document fragment changes cannot
trigger it"*. Clicking an annotation is none of those things in an obvious way:
it is `loadURL` called by the embedder. If the directive fires, a click scrolls
to the passage and highlights it with **no code in the page at all**; if it does
not, every click needs a script after load.

Every page runs under the app's real guard
(`apps/desktop/src/main/web-panels.ts`, bundled with esbuild) in the account's
own partition, so an answer here is an answer for the panel as it ships. The
addresses in the last three checks are built by the app's **own**
`annotationAddress` (`apps/desktop/src/shared/web-panels.ts`, bundled the same
way), so those prove the shipped helper rather than a copy of it. Pages come
from a local HTTP server.

**Leave the window uncovered and focused** while it runs, for the same reason
`spikes/web-panels` asks it. Three checks need a real one: the two capture
checks send actual right-clicks, and `sendInputEvent` requires the containing
window to be focused; the highlight check reads pixels back, and macOS stops
painting what another window hides. Covered, they fail with the feature working
perfectly — a false negative, not a flake to ignore.

## Run

```bash
cd spikes/text-fragments
npm install --ignore-scripts
npm test
```

`pnpm verify:text-fragments` at the root runs the same. It borrows
`apps/desktop`'s Electron binary, so `pnpm install` must have run at the root
first.

## Result — 2026-09-16

Electron 44.2.0, Chromium 152.0.7977.76, macOS. **20 passed, 0 failed.**

**The directive fires on every path tried**, including the ones the spec says
cannot trigger it.

| Question | Answer | Consequence |
|---|---|---|
| Does a `<webview>` whose `src` carries `#:~:text=` scroll to the passage? | Yes. | Opening a new panel at an annotation needs no script. |
| Does `loadURL` from main, to a different document, fire it? | Yes. | Re-pointing an open panel at an annotation on another page needs no script. |
| Does `loadURL` with **only the fragment changed** fire it? | **Yes — and `window.loadedAt` was unchanged, so the document was never reloaded.** | Clicking an annotation for the page already open scrolls without losing scroll position, form contents or media. This is the common case and the best possible answer. |
| Does the page assigning `location.hash` fire it? | Yes. | — |
| …with `userGesture: false`? | **Also yes.** The gesture is not the gate here. | The app does not have to fake a gesture. |
| Do `prefix-,` and `,-suffix` pick the right one of two identical phrases? | Yes: the second copy scrolled into view, the first stayed out of it. | The W3C `TextQuoteSelector` fields the annotation stores map onto the fragment with no conversion. |
| What happens when the text is no longer on the page? | `scrollY` stays 0 and the top of the page is in view. No error. | Drift degrades to "the page, at the top" — the same shape as a removed panel id dropping out of `?p=`. |
| What is read back afterwards? | Main's `getURL()` **keeps** `#:~:text=…`; the page's `location.href` and `location.hash` have it **stripped**, and `document.fragmentDirective` exists. | The address bar shows `getURL()`, so it must strip the directive for display or it will show the machinery. |
| Does the scripted fallback work, with a prefix? | Yes — `TreeWalker` → `Range` → `scrollIntoView`, marked with the CSS Custom Highlight API. | Available if the native path is ever withdrawn. |
| Is the guard still the guard through all of this? | Yes: every page in the account partition, sandboxed, no Node. | Annotations cost nothing from the panel's security posture. |

### The app's own helper, checked against the browser

The three additions below run `annotationAddress` rather than a fixture, so they
test the code that ships. Each was written from the spec and could have been
wrong about it.

| Question | Answer | Consequence |
|---|---|---|
| Does an address built by `annotationAddress` scroll to the passage, and does `withoutFragmentDirective(getURL())` give the clean address back? | Yes to both, prefix/suffix disambiguation included. | The helper and the address bar are proven together. |
| Does a quote too long for an address, abbreviated to `textStart,textEnd`, still match? | Yes. | Long selections keep a sane URL and still highlight the whole passage. |
| Does a directive appended to the page's **own** fragment (`#first:~:text=…`) work? | Yes — one `#`, and the directive wins over the element anchor. The page's fragment survives for the address bar. | Annotating a page that is already addressed by a section anchor needs no special case. |

### Capture: what a right-click actually delivers

Added after the **Add to message** menu failed to appear on every site tried —
Google, GitHub, Linear. The wiring looked right, which is exactly the case for
reading the event rather than assuming it.

| Question | Answer |
|---|---|
| Does a right-click on a selection reach the **renderer**, where `WebPanel` listens? | Yes. |
| Where are its fields? | **Nested under `event.params`.** The event itself carries none of them: `on the event: {}`. |
| What does `event.selectionText` give? | `undefined` — which, trimmed, is an empty selection. The handler returned early and nothing drew. **Bug one.** |
| Which origin are `params.x` and `params.y` measured from? | **The WINDOW, not the webview.** Sent at (243, 200) inside a webview offset by (250, 120); reported as (493, 320). **Bug two.** |
| Does subtracting the surface's own rect recover the point? | Yes, exactly: 493 − 250 = 243. That is the conversion the panel does. |

Two traps, and the second hid behind the first.

- The event is **unlike every other webview event the app reads**:
  `did-fail-load` and `page-title-updated` put their fields directly on the DOM
  event, and `context-menu` does not.
- The coordinates **look** webview-relative and are not. A panel on the right of
  a split is offset by hundreds of pixels, so a menu positioned inside the panel
  straight from `params` lands outside it and is never seen — which is
  indistinguishable from the event never firing.

**Why the first version of this check missed the second bug:** its webview sits
at the window's origin, where webview-relative and window-relative are the same
number. A test that cannot tell two answers apart has not tested them. The check
now puts the webview at a deliberate offset, asserts the coordinates are
window-relative, asserts they are *not* webview-relative — so a future Electron
that changes the frame fails rather than silently re-breaking the panel — and
asserts the subtraction recovers the click.

### The anchor, end to end

The two checks below run the app's own `anchorScript` and `readAnchor` against a
real selection, on a page carrying the same phrase **twice**. They are what says
a citation is exact rather than usually-right.

| Question | Answer |
|---|---|
| Does the page-side script read usable context either side of a selection? | Yes. Selecting the second copy of "Retry budget exhausted" gave prefix `"Zulu context leading."` and suffix `". Yankee trailing text."` — both from the second copy. |
| Does an address built from that anchor land on the right copy? | Yes: the second copy scrolled into view and the first stayed out of it. |
| And with **no** anchor — the degraded case? | It lands on the **first** copy. Not an error, and worth knowing precisely: it is what a person gets when the page will not report an anchor, such as a selection inside an iframe. |

### Is it actually visible, and what if it is already open?

| Question | Answer |
|---|---|
| Is the passage **painted**, or only scrolled to? | Painted. **21,381** coloured pixels in the passage's box against **0** on the same paragraph reached without a directive — the page is black on white, so any colour there is Chromium marking the fragment. |
| Does the mark fade? | No: still there 2.5s later. It persists until the reader dismisses it. |
| Clicking the same annotation again, on a page already open and scrolled away — does it go back? | **Yes**, and `window.loadedAt` is unchanged, so the document was never reloaded. This is why an already-open panel is re-pointed rather than left alone: the click has an answer of its own and needs nothing explaining why it did nothing. |

### The caveat that matters

This is **more permissive than the spec promises**. Three of the passes above —
same-document `loadURL`, `location.hash`, and `location.hash` with no user
gesture — are cases the spec text says should not trigger the directive. They
work in Chromium 152; a later Chromium could tighten them back to what is
written down without that being a regression on Chromium's part.

So the scripted fallback is not dead code to delete once the native path ships.
Keep it, and keep this spike in the verify set, so a Chromium bump that changes
the answer is a failing check rather than a feature that quietly stops scrolling.
