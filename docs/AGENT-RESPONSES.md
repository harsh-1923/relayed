# Agent responses

> **Status: proposal, backed by spikes.** Every claim marked *measured* comes from
> [`spikes/genui/`](../spikes/genui/README.md), run on 2026-09-13 against the user's
> own Claude Code and the service agent's configured model. **Phases 1 and 2 are
> built** (`packages/genui`; the renderer in `features/chat/`); the rest is not,
> so no message in a real chat carries parts yet.
> It touches `AGENT-RUNTIME.md` (a custom tool is one of its "not built yet"
> triggers) and the message schema in `DESIGN.md`; §11 lists the edits.

**Last updated:** 2026-09-14

This doc settles how an agent's reply is **represented, produced, stored,
streamed, rendered and acted on** — the same way whether the agent is the
person's own Claude Code in a local room or the service agent in a synced room.

---

## 1. Decisions

| Question | Decision |
|---|---|
| What is a reply? | A message with a plain-text `body` **and** an ordered list of **parts** |
| How does an agent make rich UI? | It calls one tool, `show_ui`, whose argument is a UI block in **OpenUI Lang** |
| Which OpenUI? | The language, parser and React renderer only (MIT). Not Gateway, Autofix, Observability or `@openuidev/react-ui` |
| Which part of the language? | **Static only.** No `Query`, `Mutation`, `$variables` or built-in functions |
| Which components? | Relayed's own library (§4.2), rendered with `components/ui/*` |
| Who repairs a bad block? | The model, in the same turn: `show_ui` returns the parser's errors. Reliable on Claude Code, not guaranteed on every model; nothing is stored until a call is valid (§5.1) |
| Who writes `body`? | Relayed, from the parts. Never the model |
| What does a click do? | Only what relayed decides. The model picks a `Reply` or `Link`; it cannot compose an action |
| Can the library change? | Only by adding. A CI guard refuses anything else (§4.4) |

---

## 2. The shape

```
 agent (Claude Code locally, pi on the service)
   │  writes Markdown text  ─────────────────────────────┐
   │  runs real tools (Read, Bash…) ─────────────────────┤  runtime builds parts
   │  calls show_ui({ source })                          │  in the order they happened
   │      └─ validateUi(source)                          │
   │           ├─ invalid → errors back to the model ────┘ (it fixes and calls again)
   │           └─ valid   → a `ui` part
   ▼
 message = { body (derived), parts [...] }   stored and synced like any message
   ▼
 renderer: markdown → Markdown · tool → tool card · ui → <Renderer> · approval → system card
```

---

## 3. The message contract

### 3.1 Parts

```ts
type Part =
  | { kind: 'markdown'; text: string }
  | { kind: 'tool'; toolUseId: string; name: string; ok: boolean; ms: number;
      input: unknown; outputPreview?: string; outputBytes?: number }
  | { kind: 'ui'; lang: 'openui-lang@0.5'; library: `relayed-ui@${number}`; source: string }
  | { kind: 'reply_to_ui'; messageId: string; label: string };   // on the clicker's message, §6.3

// Approvals are NOT parts. They are rows in their own table, rendered by the system.
```

**Who controls each part's structure** — the rule everything in §7 rests on:

| Kind | Structure comes from | Can a model fake it? |
|---|---|---|
| `markdown` | the model, as text | nothing to fake |
| `tool` | the **runtime**, from a tool that really ran | no |
| `ui` | the model, **only from relayed's library** | only within the library, which has nothing that looks like system UI |
| approval | the **system** | no — a separate table and a look `ui` cannot produce |

Unknown `kind`s are skipped by the renderer, which shows `body` in their place.
Old clients keep working (forward compatibility, `DESIGN.md` §9.10).

### 3.2 `body` is derived

`body` is computed by relayed when the message is written: markdown parts
verbatim, each `ui` part through its components' `text()` functions (§4.2), tool
parts as one line (`▸ Read apps/desktop/src/sync/catchup.ts`). Search,
notifications, previews, and any client that predates parts read `body`.

*Measured:* a stored results table reads in `body` as
`Rule: renderer/no-direct-query, Cites: FRONTEND.md §6.3 …; Rule: …` — the data,
not just the headers.

### 3.3 One message, stored

```jsonc
{
  "id": "msg_A2", "author_id": "act_agent", "ord": 2,
  "body": "I ran the test 20 times.\n\ncatchup.test.ts is flaky: 3 of 20 runs failed\nPassed: 17 · Failed: 3\n[Apply the fix]\n\nThe fix is a one-line await.",
  "parts": [
    { "kind": "markdown", "text": "I ran the test 20 times." },
    { "kind": "tool", "toolUseId": "toolu_01", "name": "Bash", "ok": true, "ms": 2210,
      "input": { "command": "for i in $(seq 20); do node --test …; done" }, "outputPreview": "# pass 17\n# fail 3", "outputBytes": 5120 },
    { "kind": "ui", "lang": "openui-lang@0.5", "library": "relayed-ui@1",
      "source": "root = Card([header, stats, next])\nheader = CardHeader(\"catchup.test.ts is flaky\", \"3 of 20 runs failed\")\nstats = Stack([passed, failed], \"row\")\npassed = Stat(\"Passed\", \"17\", \"success\")\nfailed = Stat(\"Failed\", \"3\", \"danger\")\nnext = Actions([apply])\napply = Reply(\"Apply the fix\", \"Apply the one-line fix to catchup.test.ts\", true)" },
    { "kind": "markdown", "text": "The fix is a one-line await." }
  ]
}
```

### 3.4 Streaming

A turn in progress is a message row with `state: 'streaming'` and whatever parts
are complete. Everything still arriving travels on an **ephemeral push**, never
the database, and is replaced by the stored parts when the turn completes:

```jsonc
{ "push": "agent:stream", "data": { "messageId": "msg_A2", "part": 1, "kind": "markdown", "text": "I ran the test" } }
{ "push": "agent:stream", "data": { "messageId": "msg_A2", "part": 2, "kind": "ui",       "source": "root = Card([header, st" } }
```

A lost frame is cosmetic: the final parts always arrive with the completed row.
Whether synced rooms show streaming is a product decision (`DESIGN.md`, agents at
the transport layer, §6.5); the renderer supports both.

*Measured:* Claude Code streams `show_ui`'s argument in 29–144 chunks per block,
and 103 real snapshots played through the renderer settled to the stored block
with no errors. pi through LiteLLM reported at most 2–12 tool-argument chunks in a
whole run, every tool call included, so on the service a card arrives in a few jumps.

---

## 4. The UI block contract

### 4.1 Language

OpenUI Lang v0.5, one statement per line, **positional arguments**:

```text
root = Card([header, stats])
header = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")
stats = Stack([passed, failed], "row")
passed = Stat("Passed", "17", "success")
failed = Stat("Failed", "3", "danger")
```

Allowed: component calls, strings, numbers, booleans, null, arrays, references
(forward references included). **Refused**: `Query`, `Mutation`, `$variables`,
built-ins. A block must start from `root = Card(...)`.

**Why static.** A `Query` in a stored message would run on every member's
machine every time it is shown, with somebody's credentials, and fail offline. A
generated `Mutation` fired by whoever clicks spends the agent's authority on
their behalf. A block's data is captured when it is written; refreshing it means
asking the agent.

### 4.2 The library — `relayed-ui@1`

Defined once, in `@relayed/genui`, **with no React** (lang-core's
`defineComponent` takes the renderer as an opaque value). The server, the agent
runner and the service agent import it; the renderer binds `components/ui/*` to
the same definitions. Each component also has `text(props)` for `body`.

| Component | Signature |
|---|---|
| `Card` | `Card(children)` — root of every block |
| `Stack` | `Stack(children, direction?: "row" \| "column")` |
| `CardHeader` | `CardHeader(title, subtitle?)` |
| `Text` | `Text(text, muted?)` |
| `Stat` | `Stat(label, value, tone?)` |
| `Badge` | `Badge(text, tone?)` |
| `List` | `List(items: string[], ordered?)` |
| `Callout` | `Callout(tone, title, text?)` |
| `FileRef` | `FileRef(path, line?, note?)` |
| `Table` / `Col` | `Table(columns: Col[])` · `Col(label, values: string[])` |
| `BarChart` / `Series` | `BarChart(labels, series: Series[], unit?)` · `Series(name, values: number[])` |
| `Actions` | `Actions(items: (Reply \| Link)[])` |
| `Reply` | `Reply(label, message, primary?)` — sends `message` as the person who clicks |
| `Link` | `Link(label, url)` — opens outside the chat |

`tone` is `"neutral" | "success" | "warning" | "danger"`. No component loads
anything from the network; images, when added, take blob ids, never URLs.

### 4.3 Validation — `validateUi(source)`

Runs in the runtime (to answer the model), on the server (on write), and in the
renderer (for fallback text). *Measured:* each code below was produced by a
deliberately broken block and passed on a valid one.

| Code | Meaning |
|---|---|
| `unknown-component` | not in the library |
| `missing-required` / `null-required` | a required argument absent or `null` |
| `type-mismatch` | wrong type or a value outside an enum |
| `excess-args` | more arguments than the component takes (includes `name: value` syntax) |
| `unresolved` | referenced, never defined |
| `orphaned` | defined, never reachable from `root` — the parser drops these silently, so they are sent back |
| `incomplete` | ends mid-statement |
| `no-root` / `wrong-root` | no `root`, or not a `Card` |
| `data-not-allowed` / `state-not-allowed` | `Query`/`Mutation`, or `$variables` |
| `too-large` / `too-many-statements` | over 16 KB or 200 statements |

A fenced block (```` ```openui-lang ````) is accepted and unwrapped.

### 4.4 Changing the library

Arguments are positional, so **a component's argument order is part of every
message ever stored**. *Measured, and worse than expected:* swapping `Stat`'s
`label` and `value` leaves an old block **valid** — no error anywhere — and it
renders "17" as the label and "Passed" as the value.

The rules:

- never remove a component, or remove, move, rename or retype an argument;
- never remove an enum value;
- never make an optional argument required;
- new arguments go at the end and are optional;
- to change a component's meaning, add a new component.

**The guard.** `packages/genui/src/guard.test.ts` compares the library's JSON
schema with the committed `spec-snapshot.json` and fails on any of the above, or
on an addition not yet locked. `pnpm --filter @relayed/genui snapshot` locks an
addition, and refuses to write over an unsafe change. *Measured:* it caught all four unsafe
variants and passed the safe one. A renderer whose library is older than a
part's `library` shows `body` and "update to view".

---

## 5. Producing it

### 5.1 The `show_ui` tool

| | |
|---|---|
| Name | `show_ui` (appears to Claude Code as `mcp__relayed__show_ui`) |
| Input | `{ source: string }` |
| Valid | stores a `ui` part at this position; returns "Shown to the people in this chat." |
| Invalid | stores nothing; returns an error result: `The UI block was not shown. Fix these and call show_ui again:` then one line per error with its code, statement and message |

*Measured:* a deliberately invalid block (`Sparkline`, unknown) was repaired in
the same turn by Claude Code (1/1). pi's model read the error correctly
("`Sparkline` doesn't exist … continuing without it") and **did not call again** (0/1),
so the message simply had no block. Repair is reliable on one model and not
guaranteed on another; an invalid call must leave the message correct without
it, which it does because nothing is stored until a call is valid.

### 5.2 The instructions

Both runtimes append the **same text**, built by `@relayed/genui`:

```ts
generateSystemPrompt({ library: library.toSpec(), promptOptions: {
  toolCalls: false, bindings: false, inlineMode: false,
  preamble: 'The `source` argument of the `show_ui` tool is written in OpenUI Lang, described below.',
  additionalRules: [ /* where OpenUI goes, at most two blocks, no invented data, no fake approvals,
                        and the two rules below */ ],
  examples: [ /* one block */ ],
}});
```

The two rules that decided the carrier (§8):

1. *Prefer a UI block over a Markdown table, and over a list of metrics or counts.
   Markdown tables are for two or three rows at most.*
2. *Never repeat a block's contents in your text. Refer to it and add only what
   the block does not say.*

Without them Claude Code used a block for 2 of 8 structured questions and
repeated one as a Markdown table; with them, 8 of 8 and no repeats. **Any change
to these instructions or the library is re-measured** with the eval (§9, phase 4).

*Measured cost:* 1,862 input tokens on Claude Code's prompt before the two rules
were added; they add about 70 more. Cached after the first request.

OpenUI's own `inlineMode` is **not** used: it is written for one dashboard the
conversation keeps editing ("output ONLY the changed/new statements"), the
opposite of chat messages that each stand alone.

### 5.3 Claude Code, in a local room

The person's own `claude`, driven through the Agent SDK. Relayed never sees a
credential: the CLI signs itself in (*measured:* `apiKeySource: none`, the user's
Max subscription).

```ts
query({ prompt, options: {
  pathToClaudeCodeExecutable: resolvedClaudePath,   // explicit: a Finder-launched app has no shell PATH
  env: claudeEnv(),                                  // REPLACES the child's env; see below
  cwd: room.cwd,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: RUNTIME_NOTE + uiInstructions },
  mcpServers: { relayed: createSdkMcpServer({ name: 'relayed', tools: [showUiTool] }) },
  allowedTools: ['mcp__relayed__show_ui'],           // see the approvals rule below
  canUseTool,                                        // every other tool: relayed's approval card
  includePartialMessages: true,                      // show_ui input arrives as input_json_delta
  settingSources: ['user', 'project', 'local'],
}});
```

Three rules the spikes surfaced:

- **`env` replaces, it does not merge.** Pass only what the child needs (`PATH`,
  `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`) and never inherit `CLAUDE_*` or
  `ANTHROPIC_*`: a host process's own variables would sign the child in as the
  host rather than as the person. Use `CLAUDE_CONFIG_DIR` for a second account,
  never `HOME` (which moves the macOS keychain).
- **`allowedTools` bypasses `canUseTool`.** The SDK approves a listed tool
  *before* the callback runs, so only `show_ui` (which touches nothing) is listed.
  A tool listed there never raises an approval card.
- **The subscription needs a decision.** Anthropic's Agent SDK overview does not
  allow third-party products to offer claude.ai login or its rate limits without
  approval. Either get approval, or the person supplies an API key through
  `env`; nothing else here changes. Screens say "Claude Agent", not "Claude Code".

### 5.4 pi, on the service

```ts
new DefaultResourceLoader({ …, appendSystemPrompt: [uiInstructions] });
createAgentSession({ …, tools: [...palette, 'show_ui'], customTools: [showUiTool] });
// showUiTool.execute throws the formatted errors when invalid; pi returns them to the model.
```

`tools` is an allowlist, so `show_ui` must be named in it as well as registered.

---

## 6. Rendering it

### 6.1 Renderer setup — both are required

```ts
// renderer/app/openui-setup.ts — imported first in main.tsx
globalThis[Symbol.for('openui.devtools.autoMount')] = true;
z.config({ jitless: true });
```

*Measured* under relayed's exact CSP:

- without the first line, a development build mounts OpenUI's devtools, which
  tries to load `cdn.jsdelivr.net/npm/@openuidev/devtools@0/…` (blocked);
- without the second, Zod probes `new Function` and the CSP reports an `eval`
  violation;
- with both, zero violations in development and production builds.

### 6.2 Parts to components

All in `renderer/features/chat/`; `MessageParts` is the entry point.

| Part | Renders as |
|---|---|
| no parts at all | `body`, through `MarkdownText` — every message from a person |
| `markdown` | `MarkdownText`: react-markdown with GFM. Raw HTML is dropped, a link is a button handed to `onOpenLink` (never followed), an image is its alt text |
| `tool` | `ToolCard`: one collapsed line — tool, what it acted on, duration, outcome |
| `ui` | `UiBlock`: `<Renderer library={uiLibrary} response={source} isStreaming={…} onAction onError publishObservability={false} />` |
| `reply_to_ui` | "Chose *label*" |
| unknown kind anywhere in the message | the whole `body`, plus "needs a newer version" — never the known parts with a hole |
| `ui` from a newer library | that block's plain text, plus the same note |

`UiBlock.library.tsx` draws each `@relayed/genui` component with
`components/ui/*` and semantic tokens only (two were added: `success`,
`warning`). It throws at load if the shared library gains a component with no
renderer, rather than letting a block silently lose it.

**Markdown renderer.** react-markdown was chosen over streamdown because its
defaults are safe (no raw HTML, no remote images) where streamdown's must be
turned off one by one. It re-parses the whole text on each streamed chunk;
if that shows up in a profile, close unfinished syntax with `remend` before
parsing rather than switching renderer.

*Measured:* an unknown component is dropped while its siblings render; a
component that throws is caught inside the renderer (`render-error`) and its
siblings still render. An outer error boundary showing `body` stays as the last
line of defence.

### 6.3 Actions

| Component | On click |
|---|---|
| `Reply` | `messages.send` **from the person who clicked**, in the same chat, `body = message`, with a `reply_to_ui` part. Everyone in the room sees who chose what |
| `Link` | the system browser, or "Open in a panel": a local web panel beside the chat, only on this device until shared ([`PANELS.md`](PANELS.md) §5) |

*Measured:* a click reaches relayed as
`{ type: 'relayed.reply', humanFriendlyMessage: 'Apply the one-line fix', params: { label: 'Apply the fix' } }`.

v1 has no forms. If added, a half-filled form is a draft on that device and never
syncs, for the same reason drafts do not (`DESIGN.md` §8.3, `drafts`).

---

## 7. Rules for rooms

1. **Only agent actors may write `ui` parts.** The server refuses them on human
   messages and runs `validateUi` on write; the renderer also refuses them on
   human messages.
2. **Nothing in a block runs on a reader's machine** (§4.1) and nothing loads
   from the network (§4.2).
3. **Approvals are never generated.** They come from the runtime's permission
   callback and live in their own table.
4. **Telemetry carries error codes, never source.** The codes in §4.3 are a
   closed set and safe as a metric label; `source`, `body` and tool input never
   leave the device in telemetry (`OBSERVABILITY.md`, no message body).
5. **OpenUI's install telemetry stays off.** `@openuidev/lang-core` ships a
   `postinstall` that reports to a CloudFront endpoint. `pnpm-workspace.yaml`
   denies it by name under `allowBuilds`; set `OPENUI_TELEMETRY_DISABLED=1` in CI
   as well.
6. **Pin exact versions.** Every OpenUI package is 0.x and six months old.

---

## 8. Evidence

Full data in [`spikes/genui/results/`](../spikes/genui/results/). Twelve read-only
questions about this repository: eight where structure helps, four where it does not.

| | Claude Code, tool, round one | Claude Code, inline, round one | **Claude Code, tool + §5.2 rules** | Claude Code, inline + rules | **pi (kimi-latest), tool + rules** |
|---|---|---|---|---|---|
| Block used when structure helps | 2/8 | 5/8 | **8/8** | 7/8 | **6/8** |
| Block used when it does not | 0/4 | 0/4 | **0/4** | 0/4 | **0/4** |
| Valid on first try | 2/2 | 5/5 | **8/8** | 7/7 | **6/6** |
| Repeated as a Markdown table | 1/2 | 0/5 | **0/8** | 0/7 | **0/6** |
| Invalid block repaired in the same turn | — | no repair loop | **1/1** | no repair loop | **0/1** (read the error, did not retry) |

Claude Code runs used the person's default model, `claude-opus-5`. pi's two
misses (`largest-files`, `non-negotiables`) answered in text; the first spent 643 s
because its read-only tools cannot count lines, which also stalled its repair probe
(1,065 s). No run repeated a block as Markdown, and no block had an escaping mistake. Other
measurements: instructions cost ~1,930 tokens (§5.2); 103 streamed snapshots
rendered cleanly (§3.4); the guard caught 4/4 unsafe library changes (§4.4); zero
CSP violations with §6.1 in place.

**Bundle.** *Measured* with the production bundler (Rollup, minified) against
the whole app: the message renderer adds **703 KB minified, 213 KB gzipped**.
Roughly: the chart (recharts with d3 and redux) 326 KB, Markdown 213 KB, Zod
84 KB after tree-shaking, OpenUI 55 KB, our own code 20 KB. The spike's 440 KB
for Zod was measured without tree-shaking (§10).

---

## 9. Implementation phases

Each phase ends in something a person can use or see, not only a passing test.

| # | Phase | Done when |
|---|---|---|
| 1 ✅ | **`@relayed/genui`**: the library (§4.2) with `text()`, `validateUi`, the instructions, the snapshot guard in `pnpm test`. Uses the Zod `@relayed/protocol` already depends on | The guard fails on a reordered argument; `validateUi` passes the fixtures in `spikes/genui/1-prompt.mjs` |
| 2 ✅ | **Renderer**: `features/chat/` binds `components/ui/*` (§6.2); §6.1 setup; part renderers; a dev route that plays the spike fixtures (stored, streamed, broken, throwing, click) | Every fixture renders with zero CSP violations, light and dark — verified in Chromium with the app's CSP, stylesheet and components; the production build contains no fixture. Not yet opened inside Electron |
| 3 ✅ | **Message contract**: `parts` in the replica, the server schema and `@relayed/protocol`; derived `body`; server checks (§7.1); unknown kinds fall back to `body` | A hand-written agent message with a `ui` part syncs to two dev clients and renders on both; a human message with one is refused. Built: `messages.parts JSONB` (migration 011, shape and size CHECKs) and replica v12; `writeMessage` and `updateMessage` take a body **or** parts, never both, check them (strict shape, `forbiddenPartKind` against the author, `uiPartRefusal` per block) and derive `body`; parts ride `message.created`, `message.updated` and every message row; a `send` op may carry `m.parts`, refused as `parts_refused`; `POST /dev/agent-message` writes an agent's parts by hand. Verified by tests on both sides and the refusal through a real socket; **the two-client check by hand is not done yet**, and the three markers below are not added until agreed |
| 4 | **Service agent**: `apps/agent` appends the instructions and registers `show_ui`; a run's result carries parts; `spikes/genui/3-pi.mjs` becomes `pnpm eval:genui`. Records the custom-tool trigger in `AGENT-RUNTIME.md` | A run returns valid parts; the eval matches §8 or the change is explained |
| 5 ✅ | **Local runner**: Claude Code with §5.3; `show_ui` input streamed on `agent:stream`; parts persisted when the turn completes. Depends on the local-room runner existing | A local room shows a card filling in while Claude writes it, and the same card after a restart. Built in `agent-runner/claude/turns.ts`: an in-process MCP server per session carries `show_ui`, the shared instructions are appended, a valid call becomes a `ui` part at its place in the reply and an invalid one goes back to Claude. Verified on a real Sonnet 5 turn (a stats, table and callout card, streamed, no table repeated in text); not yet looked at inside the app |
| 6 | **Actions**: `Reply` → `messages.send` with `reply_to_ui`; `Link` → browser or a local web panel | Clicking "Apply the fix" posts that message as the clicker, and the agent acts on it |

**Observability — agreed and built.** `OBSERVABILITY.md` asks for the question
each marker answers: `genui.block{genui_outcome}` — valid, repaired, or given
up — answers "is the prompt still working"; `genui.error{genui_error}` answers
"which mistake is growing"; `genui.render_error{genui_component}` answers "which
of our components breaks". A fourth was added at review, on the server side of
this same phase: `sync.parts.refused{parts_refusal}` answers "is a client or an
agent sending parts we refuse" — a rising `forbidden_kind` share is a `tool` or
`ui` part reaching the server under a person's name, which rule 1 exists to
stop. All four labels are closed sets that read as `other` for anything the
catalogue has not been updated for, and none carries a block's source, a
component's props, or a message body.

Recorded: `genui.block` and `genui.error` in the local runner's `show_ui`
handler (`agent-runner/claude/turns.ts`), the same place the service runtime
will record them in phase 4; `genui.render_error` in the renderer's `UiBlock`,
through `lib/telemetry` (the boundary that keeps the SDK out of the renderer);
`sync.parts.refused` in the server's `contentOf`, the one place every write's
parts are checked. Panels: `sync.parts.refused` on the Phase 2 dashboard
(`infra/grafana/dashboards/relayed-phase2.json`) — required, because it shares
the `sync.` prefix the dashboard test holds to that standard; the three `genui.*`
metrics are not on a dashboard yet, same as most of Phase 1's early markers.

---

## 10. Open questions

1. **Subscription approval or API key** for local rooms (§5.3). Decides whether it ships, not how.
2. **The renderer's 703 KB** (§8). Measured: Zod is 84 KB of it, so `zod/mini` is not worth it. The chart is 326 KB and draws one component; loading `BarChart` lazily, the first time a block contains one, takes it out of startup. Decide when phase 3 puts the renderer in the chat route.
3. **Smaller models, and models that do not repair.** The spikes ran Opus 5 and Kimi, and only Opus retried after an error. A person may pick Sonnet or Haiku; run the eval on both before launch, and decide whether the runtime should nudge once ("the UI block was not shown") when a turn ends after an invalid call.
4. **Streaming in synced rooms** (§3.4) — product.
5. **Which domain cards are `tool` parts rather than `ui`.** A diff, a test run and a PR are facts the runtime knows; they should never depend on the model writing them.
6. **Coarse streaming on the service** (§3.4): acceptable, or smooth it client-side?

---

## 11. Edits this needs elsewhere, in the same commits

| Doc | Edit | Phase |
|---|---|---|
| `DESIGN.md`, client schema (§8.3) and write path (§10) ✅ | `parts`; derived `body`; only agents write `ui` parts | 3 |
| `DESIGN.md`, IPC contract (§13.2) | the `agent:stream` push | 5 |
| `FRONTEND.md`, validation at the boundaries (§8.4) ✅ | Zod in the renderer for the first time; `jitless` and why; the measured cost | 2 |
| `AGENT-RUNTIME.md`, deliberately not built (§8) | `show_ui` is the first non-default tool; it touches no data | 4 |
| `OBSERVABILITY.md` | the three markers above, once agreed | 3 |
| `LOCAL-ROOMS.md`, tool calls inside the message (§8.4) ✅ | points here for the part shapes | 3 |
