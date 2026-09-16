# Annotations

> **Status: built, in its simplest form.** A person selects something in a web
> panel and adds it to a message. The loop is closed — mark a passage, send it,
> click it, and the page opens beside the chat scrolled to it.
>
> **An annotation is an ordinary Markdown link**, and nothing else:
> `[the quoted text](https://page#:~:text=before-,the%20quote,-after)`. The
> label is the quote; the target is the page with Chromium's text directive on
> it. There is no message part, no schema, no new scheme, and no server change
> — §6 records why the part this doc first proposed was taken back out.
> [`spikes/text-fragments`](../spikes/text-fragments/README.md)
> (`pnpm verify:text-fragments`) proves Chromium does the scrolling for us in
> the panel as it ships, and holds the two shapes the capture depends on.
>
> It extends web panels from the panels proposal ([`PANELS.md`](PANELS.md)) and
> the authored-message contract from the composer doc
> ([`COMPOSER.md`](COMPOSER.md)). It is **independent of** agent browser control
> ([`AGENT-BROWSER.md`](AGENT-BROWSER.md)) and worth building first: pointing at
> something is useful whether or not an agent can ever act on it. §14 lists the
> edits the other documents need; where one has not landed, that document wins.

**Last updated:** 2026-09-16

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **Annotation** | A passage a person marked in a web panel, attached to a message: its text, its source, and how to find it again. |
| **Quote** | The exact selected text. What a reader sees and what an agent reads. |
| **Anchor** | What finds the passage again on the page: `prefix`, `exact`, `suffix` — the W3C `TextQuoteSelector` shape. |
| **Text fragment** | Chromium's `#:~:text=` URL directive, which scrolls to and highlights a passage on load. The anchor, serialised into a URL. |
| **Chip** | How an annotation is drawn inline in a message and in the composer. |
| **Drift** | The page changed and the anchor no longer matches. Expected, not exceptional (§11). |

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| How is a selection captured? | Electron's **`context-menu` event on the `<webview>`** — no preload, no injected overlay, no change to the attach guard. | 5.1 |
| What does an annotation store? | The **W3C `TextQuoteSelector`** triple — `prefix`, `exact`, `suffix` — plus the URL and page title. | 4 |
| Why that shape? | It is the one shape that serves both readers: an agent reads `exact` as a quote, a click serialises the triple into a text fragment. **No conversion.** | 4.2 |
| Where does an annotation live? | **In the body, as a link.** No part, no table, no stream, no authz rule — a message body already travels every path this needs. | 6 |
| Why not a message part? | Tried, and taken out: it collides with the server's own rule that a message says *a body, or parts it is derived from, never both*. An annotation is neither. | 6 |
| Does clicking one navigate to the passage? | **Yes, natively.** Proven in `spikes/text-fragments`, including the same-page case, without reloading the document. | 7 |
| Is the native path trusted alone? | **No.** It is more permissive than the spec promises, so the scripted fallback stays and the spike stays in the verify set. | 7.3 |
| What happens when the page has changed? | The passage is not found, the page opens at the top, and the chip says the quote could not be located. | 11 |
| Does an annotation open automatically for others? | **No.** A click, always — the same rule that stops an agent making every member's machine fetch a URL. | 10.2 |
| Does the agent need browser control to use one? | **No.** The quote and the URL are in the body it already reads. | 8 |
| What happens on click? | It opens as a device-local page, at the passage — and a page already open is sent back to the passage, so a click is never a no-op. | 7.3 |

---

## 2. What it is for

The panel already puts the web beside the conversation. What it does not do is
let anyone **point** at it. Today the only way to say "this paragraph" is to
copy the text out and paste it, which loses where it came from, or to paste a
URL, which loses which part of it mattered.

That gap is worse in a room than alone, because the other people cannot see your
screen.

### 2.1 In a local room — giving an agent an exact referent

| What the person does | What it replaces |
|---|---|
| Selects a paragraph in a spec, sends "implement this" | Pasting the text and hoping the agent infers the source, or describing the paragraph in prose |
| Marks the one failing assertion in a CI log open in a panel | "the error about halfway down" |
| Selects a line of a vendor's API doc that contradicts the code | Re-typing it, badly |

The value is precision. The agent gets a quote **and** a URL, so it can quote it
back, follow it, or — if browser control is ever built — act on it.

### 2.2 In a synced room — a citation everyone can follow

| What someone types | What everyone else gets |
|---|---|
| "this is the clause that blocks us" + an annotation of the contract | A chip they can click, which opens the page **at that clause**, not at the top |
| An annotation of the status page during an incident | Everyone looking at the same sentence, rather than "the third bullet" |
| An annotation of a Linear ticket's acceptance criteria | A durable citation in the transcript: the quote is in the message even when the page later changes |

The second column is the whole point of making annotations first class rather
than pasted text. **A quote preserves what was said; an annotation preserves
where it was said, and takes you there.**

### 2.3 What it is not

| Not this | Why |
|---|---|
| A highlighter that marks up the page for everyone | That is shared page state, needs presence, and is the panels doc's "follow me" question |
| A way to annotate anything but web panels | Diffs, files and attachments are their own panel types with their own addressing; the same idea may extend later (§12) |
| A clipping service | The quote is a citation, not a copy. Long selections are capped (§4.3) |

---

## 3. The idea in one picture

```
  the person selects text in a web panel, right-clicks → Add to message
            │
            ▼
  <webview> 'context-menu' event  ──────────────────  NO code in the page
  params.selectionText · params.pageURL · params.x/y
            │
            │  one executeJavaScript at capture for the 32 characters
            │  either side — the anchor (§5.2)
            ▼
  a link, written where the caret is:
      [the retry budget is exhausted](https://…#:~:text=agreed-,the%20retry…,-after)
            │
            ▼
  SEND ─── an ordinary message body. No part, no schema, nothing new on the wire.
            │
            ├────────▶ the agent reads the quote and the URL in the transcript
            │
            └────────▶ anyone clicks it
                              │
                              ▼
                    a device-local web panel opens at that address,
                    and CHROMIUM scrolls to the passage and highlights it
```

Everything after "SEND" is machinery that already existed.

## 4. What an annotation holds

### 4.1 Two halves of one link

| | |
|---|---|
| **Label** | The quote, whitespace collapsed, elided in the middle past 48 characters (§4.3). What a reader sees and an agent reads |
| **Target** | The page, with the anchor as a text directive: `#:~:text=[prefix-,]exact[,-suffix]` |

Nothing else is stored. The page title is not kept — the link's own hover shows
where it goes, and a title captured months ago is a worse answer than the page
itself.

### 4.2 Why the W3C selector shape, specifically

`prefix` / `exact` / `suffix` is the `TextQuoteSelector` from the **Web
Annotation Data Model** — a range of text described by copying it, with enough
of the text either side to tell it from other copies.

It was not chosen because it is a standard. It was chosen because it is
**identical to the shape Chromium's text fragment already takes**, so the
anchor read from the page serialises straight into the address with nothing to
convert and nothing to keep in sync. That is what makes the whole annotation
fit in a URL, which is what makes it a link rather than a schema.

The spike confirms the disambiguation is real rather than theoretical: with the
same sentence twice on a page, the anchor took the reader to the second copy
and left the first out of view.

### 4.3 Limits

A quote runs to whatever the person selected; the **label** is elided past 48
characters, and the **address** names a long range by its two ends
(`textStart,textEnd`) rather than carrying the whole of it, which the spike
proves still matches and highlights the passage entire. So a long selection
costs a readable label and a sane URL, not a truncated citation.

## 5. Capture

### 5.1 The context-menu event does almost all of it

Electron's `<webview>` emits `context-menu` with a `params` object carrying
`selectionText`, `selectionRect`, `pageURL`, `frameURL`, `linkURL`, `linkText`,
`srcURL`, `mediaType` and `editFlags`. **Nothing runs in the page for any of
it.**

This matters more than convenience. The attach guard deletes any `preload` and
forces `sandbox`, `contextIsolation` and `webSecurity` on, and the reason is
that pages in a panel hold the person's real logins. A capture path that needed
the guard relaxed would be trading that away for a citation feature. This one
trades nothing: it is strictly additive.

The app already has the `ContextMenu` primitive it needs
(`renderer/components/ui/context-menu.tsx`), and nothing listens to the
webview's `context-menu` event today — so the page currently shows Chromium's
own menu, and there is no existing behaviour to preserve.

### 5.2 The one thing the event does not give

`prefix` and `suffix`. The event hands over the selection but not its
surroundings, so the anchor needs about 32 characters either side, which is one
`executeJavaScript` call **at capture time** — not an overlay, not a listener,
and not on the click path.

The precedent is already in the file this would sit next to: `WebPanel` reads
the favicon with a self-contained `executeJavaScript` IIFE that returns a value
and catches its own errors (`readIconScript`), and what comes back is treated as
untrusted (`sync/local/panel-meta.ts`). An anchor read is the same shape and the
same trust level.

**If even that is unwanted for a first slice**, store `exact` alone and accept
that a passage appearing twice anchors to the first occurrence. The field stays
in the schema; it is just empty. That is a real v1, and §13.2 sequences it that
way.

### 5.3 How it is drawn

**As an ordinary link**, with the same underline, the same hover card showing
the full address, and the same copy button as any other link in a message. The
only difference is a `TextQuote` mark before the label.

It was briefly a pill-shaped chip in quotation marks, and that was wrong: it
made a citation look like a mention — a different kind of thing, addressed at a
person — and put weight on it that a passing reference should not carry. The
mark alone does the work the chip was reaching for, which is to say *this is
somebody's words, not the name of a page*: without it, a quote and a page title
are indistinguishable in a sentence.

### 5.4 What the person sees

Right-click a selection in a panel → **Add to message** in the menu → a chip
appears in the composer at the caret, showing the page's favicon, a truncated
quote, and the host. Clicking the chip before sending opens a small editor for
the optional note. Backspace deletes it like any atom.

---

## 6. Where an annotation lives

### 6.1 In the body, as a link

```md
make [the retry budget is exhausted](https://linear.app/…/ENG-42#:~:text=agreed%20that-,the%20retry%20budget%20is%20exhausted,-after%20three) more concise
```

That is the whole representation. The label is the quote; the target is the
page with the anchor serialised into Chromium's text directive (§7).

What it buys, all of it for nothing:

| | |
|---|---|
| **Placement** | It sits where the person put it, so "make *this* more concise" has an unambiguous referent. Several per message fall out naturally |
| **Drafts** | It is text. It rides the draft, a restart, and the Markdown body with no second representation to keep in step |
| **Every other client** | A build that has never heard of annotations shows a link to the right page. So does anything that copies the text out |
| **Sync, access, audience** | A message body. Nothing was added to any of them |
| **The agent** | Reads the quote and the URL in the transcript it already gets (§8) |

### 6.2 Why the message part was taken out

This doc first proposed an `annotation` message part with an `annotation:` link
scheme pointing at it, on the reasoning that a part rides its message and needs
no table. That was built, and then removed. Three things were wrong with it.

- **It collides with the server's content rule.** `sync/ops.ts` states that a
  message says *"a body, or parts it is derived from — never both"*, so that
  `body` is always Relayed's, derived, and never a client's. An annotation is
  neither: the body is the person's own authored Markdown, and the part only
  describes something inside it. Shipping it meant changing that rule — a real
  change, to protect an agent-reply invariant, for a person's citation.
- **It cost a schema to say what a URL already says.** The part held a page and
  a `TextQuoteSelector` triple; the address holds the same triple, and has to
  anyway, because the directive is how the browser finds the passage.
- **It degraded worse.** An atom whose part went missing rendered as dead text
  — which is exactly the bug that sent this back to the drawing board: the
  workspace send path dropped `parts`, and every annotation in a synced room
  arrived unclickable. A link cannot lose half of itself.

**The lesson worth keeping:** the part was reached for because annotations felt
structural. They are not. They are a citation, and a citation is a link.

## 7. Navigating to an annotation

### 7.1 Chromium does it

Clicking a chip builds the URL and opens a panel at it:

```
https://linear.app/…/ENG-42#:~:text=…%20before-,the%20selected%20text,-…%20after
```

Chromium scrolls to the passage and highlights it. There is no scroll code, no
injected script, no measuring, and no page cooperation.

### 7.2 What the spike found

The spec says the directive fires only on *"user-initiated top-frame
navigations, so iframes, scripts, and same-document fragment changes cannot
trigger it"* — and clicking a chip is `loadURL` called by the embedder, which
that sentence does not obviously cover. So it was run rather than reasoned
about. Electron 44.2.0, Chromium 152.0.7977.76, **11 passed, 0 failed**, under
the real attach guard in the account's own partition:

| Case | Result |
|---|---|
| A `<webview>` whose `src` carries the directive | Scrolls |
| `loadURL` from main to a **different** document | Scrolls |
| `loadURL` with **only the fragment changed** | Scrolls — **and `loadedAt` was unchanged, so the document was never reloaded** |
| The page assigning `location.hash` | Scrolls |
| …with `userGesture: false` | Scrolls. The gesture is not the gate |
| `prefix-,exact,-suffix` against two identical phrases | Lands on the right copy; the wrong one stays out of view |
| Text no longer on the page | `scrollY` 0, top of page in view, no error |
| The guard, throughout | Every page in the account partition, sandboxed, no Node |

**The third row is the best news in the document.** The common case — an
annotation of the page you already have open — scrolls *without reloading*, so
the person's scroll position, form contents and playing media survive a click.
That was the outcome worth hoping for and the one least safe to assume.

One thing to handle in the UI: main's `getURL()` **keeps** `#:~:text=…` while
the page's own `location.href` has it stripped. The address bar shows
`getURL()`, so it must strip the directive for display or it will show the
machinery to the person.

### 7.3 Clicking a passage whose page is already open

The panel store returns the **same** panel when the same address is opened
twice, so the first version of this did nothing at all in that case: no new tab,
no movement, no message. Reported as *"it felt stuck"*, which is the right
reading — a click that changes nothing is indistinguishable from a broken one.

**The answer is not to explain the absence, it is to remove it.** An already
open panel is re-pointed at the address, which scrolls back to the passage and
paints it again. That is what the person wanted when they clicked a citation
they had already opened and then read past.

A toast saying "already open" was the obvious fix and is the worse one: it
explains why nothing happened instead of doing the thing, adds an app-wide
surface this app does not otherwise have — the toast component is present but
mounted nowhere — and would fire on an action people take often.

Measured rather than assumed (`spikes/text-fragments`): re-loading the
identical address returns to the passage, and `window.loadedAt` is unchanged,
so the document is never reloaded and the page keeps everything else about its
state.

**What is still silent:** clicking a passage that is already on screen *and*
still highlighted. Nothing moves, because nothing needs to. The person is
looking directly at the answer, so the confusion the report was about does not
arise — but it is the one case a toast would still cover, if it ever proves to.

### 7.4 Why the fallback is not deleted

Three of those passes — same-document `loadURL`, `location.hash`, and
`location.hash` with no gesture — are cases the spec text says should **not**
fire. They work in Chromium 152. A later Chromium could tighten them back to
what is written down, and that would not be a bug on Chromium's part.

So the scripted fallback ships: a `TreeWalker` to find the text, a `Range`, a
`scrollIntoView`, and the CSS Custom Highlight API to mark it — proven in the
spike, prefix disambiguation included. And `pnpm verify:text-fragments` stays in
the verify set, so a Chromium bump that changes the answer is a failing check
rather than a feature that quietly stops scrolling.

**Relying on undocumented generosity is fine when a test holds you to it.**

---

## 8. What the agent sees

The transcript is built from message bodies, so an agent already sees:

```
Harsh: make [the retry budget is exhausted](https://linear.app/…/ENG-42#:~:text=…) more concise
```

**There is nothing to build for this**, which is the clearest argument for the
link. The part version needed a transcript line of its own, written and kept in
step with the renderer; a link is already text in the body the model reads.

The quote is untrusted page content entering the model's context. It is not
fenced today, and should be when anything acts on it — the browser-control
doc's injection section is where that rule lives
([`AGENT-BROWSER.md`](AGENT-BROWSER.md)).

## 9. Where this goes when it grows

Nothing here needs a table, and the earlier draft of this section — which
weighed an `annotations` table against the coming attachments table — is moot:
there is no record to put anywhere. An annotation is a link inside a message
body.

The trigger that would change that is unchanged, though, and worth keeping:
something needing annotations **independently of their message** — "every
annotation in this room", "jump to the next one", "who else cited this URL?".
That wants an index over message bodies, or a row. Nobody has asked, and until
they do, the cheapest correct answer is that an annotation is not a record.

If it ever becomes one, the link stays the source of truth and the row is a
derived index — not a second place for the same fact to live, which is the
mistake §6.2 already made once.

## 10. Sync, access and audience

### 10.1 Nothing new

An annotation part rides its message on the chat stream, so:

```
can_see(actor, annotation) ⟺ access(actor, the message's chat)
```

which is the existing predicate, unchanged. A private chat's annotations are
private by construction. Removing someone from the room removes them, by the
same rule that removes the messages. There is no annotation-level revocation to
forget, and no fan-out to get wrong.

### 10.2 Clicking is always explicit

An annotation never opens a panel by itself, on anyone's device — including the
author's other devices, and including the person who sent it. It opens on a
click, which creates an ordinary **local** panel for the person who clicked.

This is the panels doc's rule about agent-opened pages, applied for the same
reason: nothing should be able to make a room member's machine fetch an
arbitrary URL, including one that resolves to their own `localhost`.

Which raises the loopback case: a person annotating `http://localhost:5173` and
sending it to a room has the problem the panels doc already named for sharing a
local panel. Same answer — **flag it, do not refuse it**: *"localhost:5173 will
not open for anyone else."* The quote is still useful context even where the
link is not.

---

## 11. Failure and drift

Pages change. The anchor is a copy of text that someone else owns, and it will
stop matching. That is the normal case over a long enough period, not an error.

| What happened | What the person sees |
|---|---|
| The passage is still there | The page opens, scrolled to it, highlighted |
| The text changed or moved | The page opens **at the top**; the chip says the quote could not be found on the page |
| The page is gone (404, auth wall) | The panel shows what it shows for any failed load, with **Try again** |
| The URL is loopback and this is not that machine | The flag from §10.2; the quote still reads |
| The annotation was never anchored (`exact` only, §5.2) | It lands on the first occurrence, which may be the wrong one |

**The quote in the message is the durable part.** It is captured at annotation
time and never re-fetched, so a citation stays readable and quotable long after
the page stops matching it. Drift costs the *jump*, never the *quote* — which is
the argument for storing the text rather than only a locator.

---

## 12. Deliberately not built

| Not built | Trigger to build it |
|---|---|
| A screenshot crop on the chip | Blob storage exists (the panels doc's Phase 7 attachments). `selectionRect` + `capturePage(rect)` is then a few lines |
| An element picker (hover-highlight-click a node) | Someone needs to point at something that is not text — an image, a chart, a button. §5's context-menu path already covers images via `srcURL` |
| Annotating a `diff`, `file` or `attachment` panel | Those panel types exist and have their own addressing. The anchor shape would differ per type, which is the point at which §9's table starts paying |
| Re-anchoring with fuzzy matching | Drift becomes a common complaint. Hypothesis-style fuzzy anchoring is well-trodden and considerably more machinery than §4's triple |
| A highlight everyone sees on the page | Shared page state; presence, not rows. The panels doc's "follow me" question |
| Annotations as their own sync stream | Never for this shape — §10.1 needs nothing |

---

## 13. Implementation plan

### 13.1 Spikes

| Spike | Question | Status |
|---|---|---|
| **Text fragments, and capture** [`spikes/text-fragments`](../spikes/text-fragments/README.md) | Does `#:~:text=` fire in a panel `<webview>`, under the guard, when the embedder navigates? Does the same-page case reload the document? And what does a right-click on a selection actually deliver to the renderer? | ✅ **Done, 2026-09-16.** 18 passed. Every path fires; the same-page case does not reload. Three of the checks drive the app's own `annotationAddress`, so the shipped helper is proven rather than a copy — including the long-quote and existing-fragment forms, which were written from the spec and could have been wrong. §7.2 |
| **Capture on real pages** | On ten pages people actually annotate, does `context-menu` give usable `selectionText`, and is a 32-character anchor enough to disambiguate? | **Partly answered.** The spike proves both on a page built for it, with the app's own script; whether 32 characters is enough on real pages is still a guess, and §15 keeps it open |
| **Canvas pages** | Google Docs renders to canvas and cancels normal selection, so `selectionText` is likely empty. Does `webContents.copy()` plus main's `clipboard` recover the text? | Not run. Decides whether §11 gains a row or §12 gains one |

### 13.2 Steps — as built

| # | Step | Touches | State |
|---|---|---|---|
| 1 | **Capture.** `context-menu` on the `<webview>` → **Add to message**, with nothing running in the page | `renderer/features/panels/WebPanel.tsx` | ✅ |
| 2 | **The anchor.** One `executeJavaScript` at capture for the text either side; checked, never trusted | `shared/annotations.ts` | ✅ |
| 3 | **The link.** The address built from page + anchor; written at the caret as an ordinary link mark | `shared/web-panels.ts`, `lib/pending-annotations.ts`, `composer/MessageComposer.tsx` | ✅ |
| 4 | **Drawing it.** Drawn as an ordinary link, with a quote mark before the label | `MarkdownText.tsx`, `markdown.css` | ✅ |
| 5 | **Opening it.** A click asks the room, which opens a device-local page at the passage — and re-points one already open, so the click is never a no-op | `lib/panel-navigation.ts`, `ChatBubble.tsx`, `routes/Space.tsx`, `WebPanel.tsx` | ✅ |
| 6 | **The scripted fallback**, if Chromium ever tightens the directive (§7.3) | renderer | Not built |
| 7 | **Drift.** Saying so when the quote is no longer on the page (§11) | renderer | Not built |

**What was built and then removed**, recorded because the reasoning matters more
than the code did: an `annotation` message part, an `annotation:` link scheme
resolving to it, a Tiptap atom kind, `parts` on the local send path, and a
click that decided whether the page was already a tab and pointed an open panel
at the passage instead of opening one. §6.2 says why the part went; the
tab-reuse logic went with it because the panel store already returns the same
panel for the same address, which is all the sharing anyone wanted.

**Two bugs worth remembering, both found by measuring rather than reading:**

1. A webview's `context-menu` fields are **nested under `event.params`**, unlike
   every other webview event this app reads. Reading them flat gave
   `undefined`, which trims to an empty selection, so the menu never opened on
   any page.
2. `params.x` and `params.y` are **window** coordinates, not the webview's. A
   panel on the right of a split is offset by hundreds of pixels, so the menu
   was drawn outside it — indistinguishable from the event not firing. The
   first version of the capture check could not have caught this, because its
   webview sat at the window's origin, where the two frames are the same
   number.

Both are now asserted in `spikes/text-fragments`, in both directions.

### 13.3 Tests that must exist

- **Recognition:** a link with a directive is an annotation; a plain link, a
  plain fragment, and a non-web scheme are not. ✅
- **Label:** whitespace collapsed; a long quote elided in the MIDDLE, so two
  quotes from one page stay distinguishable. ✅
- **Anchor, untrusted:** a page reporting the wrong types keeps the quote and
  drops the context; an over-long one is cut. ✅
- **Address building:** the directive's own syntax characters (`-`, `,`, `&`)
  encoded; non-Latin text; a long quote named by its two ends; a page that
  already has a fragment of its own; re-anchoring one that already carries a
  directive. ✅
- **The address bar never shows the directive.** ✅
- **In a real browser** (`spikes/text-fragments`): every navigation path fires,
  the same-page case does not reload, the anchor sends the reader to the right
  copy of a repeated phrase, and a quote with no anchor lands on the first. ✅
- **Still to write:** drift — a page whose text has changed, once §11's state
  exists.

### 13.4 Observability, proposed

Proposed, not decided — the markers get agreed before they are added, with the
question each answers.

| Signal | Kind | The question it answers |
|---|---|---|
| `annotation.created` `{has_anchor}` | event | Whether annotations are used at all, and whether step 4's anchor is worth its capture cost |
| `annotation.opened` `{outcome: found \| not_found \| load_failed}` | counter | **The one that matters.** How often drift wins. A high `not_found` rate means §12's fuzzy re-anchoring stops being deferred |
| `annotation.opened` `{path: native \| fallback}` | counter | Whether a Chromium bump has quietly moved everyone onto the fallback |
| `annotation.capture_empty` | counter | Selections that yielded no text — canvas pages like Google Docs. Says whether §13.1's canvas spike is worth running |

No URL, no host, no quote and no page title in any of them. A URL is somebody's
browsing, and it is unbounded as a label besides.

---

## 14. Docs to change when this is accepted

| Doc | Change |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | A row in the documentation table for this doc; `pnpm verify:text-fragments` in the commands list |
| [`COMPOSER.md`](COMPOSER.md) | Nothing required — an annotation is an ordinary link mark. Worth a line saying so, since the obvious guess is that it needed an atom |
| [`PANELS.md`](PANELS.md) | Web panels gain the capture menu and the fragment-URL open path; the not-built list loses "the page's title on its tab" as a blocker for the chip |

### Invariants to add

- An annotation is **a link and nothing else**. Anything that needs a record
  beside it is a second source for one fact (§6.2).
- An annotation **never opens a panel without a click**, on any device.
- The **quote is captured once** and never re-fetched, so drift costs the jump
  and never the citation.

---

## 15. Open questions

1. **Is 32 characters the right anchor?** A guess. It disambiguates on the
   spike's page; whether it does on real ones is unmeasured, and §13.4's
   `annotation.opened {outcome}` is what would say.
2. **Should the label carry a visible source?** Today a chip shows only the
   quote, with the address on hover. In a long thread, "which page was that
   from" may want answering without hovering.
3. **Does the canvas case need answering at all?** Google Docs renders to
   canvas and cancels normal selection, so `selectionText` is likely empty
   there. It may be that the right answer for Docs is a connector rather than a
   panel, and annotations simply do not serve.
4. **Should an agent write annotations when it cites a page?** It can — the
   link needs nothing an agent does not already have — and it would make agent
   citations clickable rather than pasted. Nothing depends on it.
5. **Ordinary web links in a message still go nowhere.** An annotation opens a
   panel because its address says it is one; a plain link does not, because
   where those open is a decision this feature declined to make on its way
   past. That asymmetry is defensible but will look odd to someone clicking
   both.
