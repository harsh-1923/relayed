# AGENTS.md

Working rules for this repository. Read this first, then the doc that covers
what you are about to touch.

## What this is

**Relayed** — a local-first desktop workspace where humans and software agents
collaborate as the same kind of participant. Electron client, server-authoritative
ordered log, every read served from local SQLite.

- **R1** an actor belongs to N spaces
- **R2** updates arrive for every space they belong to, open on screen or not
- **R3** without a network, local data is fully readable

## Where we are

| Phase | State |
|---|---|
| 0 — de-risk, then skeleton | ✅ Electron shell, `utilityProcess`, MessagePort, SQLite, telemetry |
| 1 — identity | ✅ WorkOS AuthKit, real orgs, invitations, authorization, actor replication |
| 1½ — the shell | ✅ Router, transition table, live-query client, renderer telemetry |
| **2 — the sync core** | **In progress**, 13 of 14 steps. [`docs/SYNC-FLOWS.md`](docs/SYNC-FLOWS.md) §2 |

**Next task: the milestone** — step 14 of fourteen in the sync build plan
([`SYNC-FLOWS.md`](docs/SYNC-FLOWS.md) §2). Four flows exercised **by hand**
rather than by a test, plus the cross-phase checks. A step that only ever ran
under `node --test` has not been used.

Everything it needs is now instrumented, so a flow that misbehaves is a trace to
open rather than a `console.log` to add: **Relayed → sync** in Grafana
(`pnpm services && pnpm grafana`) opens with the send path as traces, and the
whole engine reports through `sync/observe.ts` on each side.

`pnpm mock` fills that dashboard: real replicas, real sockets, a real server,
70% ordinary traffic and 30% provoked edge cases (`pnpm mock:wipe` undoes it).
Its first runs found five bugs the test suite did not, every one of them living
between two components that were each individually tested — see
[`OBSERVABILITY.md`](docs/OBSERVABILITY.md) §10c. Run it before the milestone,
not after.

**Done so far:** steps 1 to 12. The sync core is functionally complete — a
client connects, paints correct badges, applies what arrives, asks for what it
missed, hydrates its directory, writes offline, and is told when it has fallen
past the retention horizon.

Green as of the last commit: **1,454 tests**, 103 spike assertions, 13 boundary
rules over 505 files, typecheck across ten workspace projects, production build.

## Documentation

| Doc | Covers |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | **Design of record.** Architecture, schema, sync protocol, invariants. |
| [`docs/STACK.md`](docs/STACK.md) | Technology choices and why, the local dev stack, library docs and context7 IDs. |
| [`docs/RELEASE.md`](docs/RELEASE.md) | How builds reach users, code signing, forward compatibility across versions. |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | **Runbook.** Getting `apps/server` and Postgres onto Railway: the one-instance rule, WorkOS production setup, environment, the custom domain, and what moving out would cost. |
| [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) | What we collect and how. Read before adding any log, metric or span. |
| [`docs/STORAGE.md`](docs/STORAGE.md) | Local storage layout, multi-workspace and multi-account, switching flows. |
| [`docs/AUTHZ.md`](docs/AUTHZ.md) | Who may do what. The `memberships` shape, the single `can()`, and why FGA is deferred. |
| [`docs/SPACE-MEMBERSHIP-MARKERS.md`](docs/SPACE-MEMBERSHIP-MARKERS.md) | **Proposal.** Adding actors to channels and rooms, durable system-message markers, current product gaps, and the implementation and verification plan. |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Renderer architecture: routing, what the URL addresses, the read path, where state lives. |
| [`docs/PREFERENCES.md`](docs/PREFERENCES.md) | What a person chooses: the `preferences` table, the shared catalogue, and why a row per key rather than a JSON blob. |
| [`docs/SHORTCUTS.md`](docs/SHORTCUTS.md) | **Built**, with the platform matrix still to run by hand. The command catalogue and bus, shortcut matching, stored bindings, the keyboard shortcuts settings page, the application menu, and composer send. Evidence in [`spikes/hotkeys/`](spikes/hotkeys/README.md) (`pnpm verify:hotkeys`). |
| [`docs/COMMAND-MENU.md`](docs/COMMAND-MENU.md) | **Built, first two sources.** The Mod+K menu for navigating and taking actions: the item and source contract every new kind of result follows, close-then-perform, ranking, and what is not built yet. |
| [`docs/COMPOSER.md`](docs/COMPOSER.md) | **Proposal.** Tiptap-based Slack-like rich editing, the editor-independent message document, durable actor and audience mentions, collapsed links, local drafts and the atomic send transition. |
| [`docs/AGENT-RUNTIME.md`](docs/AGENT-RUNTIME.md) | The agent service: one endpoint in two modes, the pi loop, the provider table, and what bounds a run. |
| [`docs/AGENT-RESPONSES.md`](docs/AGENT-RESPONSES.md) | **Proposal, backed by spikes.** How an agent's reply is represented, produced, stored, streamed, rendered and acted on: message parts, OpenUI Lang blocks through one `show_ui` tool, the library contract. Evidence in [`spikes/genui/`](spikes/genui/README.md). |
| [`docs/PANELS.md`](docs/PANELS.md) | **Proposal, partly built.** A room's side chats and web pages as typed panels, opened as tabs beside the space: local until shared, the tables, sync, addressing (`?p=`, `?pa=`), web pages as `<webview>`, and the implementation plan with what is built. Evidence in [`spikes/web-panels/`](spikes/web-panels/README.md) (`pnpm verify:web-panels`). |
| [`docs/LOCAL-ROOMS.md`](docs/LOCAL-ROOMS.md) | **Proposal.** Rooms driven by the person's own Claude Code on their laptop, and how one is published into a shared room. Not yet the design of record — its header says which `DESIGN.md` sections it contradicts. |
| [`docs/WORKSPACE-AGENTS.md`](docs/WORKSPACE-AGENTS.md) | **Proposal.** Creating agents as actors, a mention becoming a run in `apps/agent`, tool calls brokered by the server through Composio as the invoker, connections and the connector store, and restricted messages with what they do to `ord` and `rev`. Its header lists the `DESIGN.md` decisions it replaces. |
| [`docs/WORKSPACE-AGENTS-IMPL.md`](docs/WORKSPACE-AGENTS-IMPL.md) | **Plan.** How the workspace agents proposal is built: seven steps in order, each linked to the proposal sections it implements, with files, migrations, tests, what to check by hand, and the decisions and corrections it feeds back into the proposal. |
| [`docs/AMBIENT-RESPONSES.md`](docs/AMBIENT-RESPONSES.md) | **Built, on by default** (`AMBIENT_MODE`; needs `TYPESAFE_API_KEY`). An agent answering a message that did not mention it: a clock per turn (what one person said in a row, judged 90 s after their last message; other people never delay it), an answer per open question, seven Jev (TypeSafe) checks per message then the best-fitting agent, a draft that is an answer, an offer to look something up in a connected tool, or both, checked before it posts; a follow-up to your own mention continues your run; anything inferred is a job with no invoker; one look at a time per chat, three answers per chat per ten minutes, three follow-ups per exchange; silent on anything but a good answer. Tuning harness: `pnpm --filter @relayed/server run ambient-gate <chat-id>`. |
| [`docs/ACTIVITY.md`](docs/ACTIVITY.md) | **Proposal.** One ephemeral primitive for "someone is doing something here, now": typing first, shown as a WhatsApp-style bubble with the typist's avatar, and the agent working indicator moved onto it. Generalises `agent_activity`; expiry by receiver-side TTL; the ambient "on it" question left open. |
| [`docs/MEMORY.md`](docs/MEMORY.md) | **Proposal.** What an agent remembers and how: memory belongs to the space rather than the agent, Hindsight banks as the permission boundary (not tags — a leak elsewhere decided it), the quiet-bounded episode as the ingestion unit, recall injected with citations into every run, and forgetting through a document id we choose. Carries the evidence behind each call and a staged plan that opens with two spikes. **Phase two** adds the human-facing half: a room timeline of replicated entries that replaces the summariser, and an admin view that measures whether the facts formed are consequential. |
| [`docs/AGENT-BROWSER.md`](docs/AGENT-BROWSER.md) | **Proposal.** Letting an agent drive a web panel — click, type, read — for the things with no API: the driver in main over the Chrome DevTools Protocol, one implementation reached from both room kinds, and the consent model a credentialed session needs. |
| [`docs/ANNOTATIONS.md`](docs/ANNOTATIONS.md) | **Proposal, backed by a spike.** Marking a passage in a web panel and attaching it to a message: capture with no code in the page, the W3C selector triple, a part with a body atom, and clicking one to open the page scrolled to it. Evidence in [`spikes/text-fragments/`](spikes/text-fragments/README.md) (`pnpm verify:text-fragments`). |
| [`docs/PHASE-1-IDENTITY.md`](docs/PHASE-1-IDENTITY.md) | Phase 1, **closed**: tenancy, social login, the actor model, invitations. |
| [`docs/PHASE-2-SYNC.md`](docs/PHASE-2-SYNC.md) | The sync core's scope and traps. Superseded in part by the plan below, which its header names. |
| [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md) | Bugs that are understood but not fixed, each with the symptom as experienced, the chain behind it, the false leads already walked, and what to do meanwhile. |
| [`docs/MULTI-CLIENT-DEV.md`](docs/MULTI-CLIENT-DEV.md) | Running two or three isolated Electron clients against one server, and why sync cannot be seen with one. |
| [`docs/SYNC-FLOWS.md`](docs/SYNC-FLOWS.md) | **Start here for sync.** The six goals with their completeness checks, the fourteen-step build plan, and every flow end to end with data shapes. |
| [`spikes/`](spikes/) | Executable models that validate the design. Not app code. |

Workspace packages: `@relayed/authz` (one `can()`, shared so client and server
cannot disagree), `@relayed/protocol` (the wire format, shared for the same
reason), `@relayed/genui` (the components an agent may use in a UI block, their
validator and the prompt — no React; [`docs/AGENT-RESPONSES.md`](docs/AGENT-RESPONSES.md)),
`@relayed/telemetry` (the typed event catalogue), `@relayed/icons`
(~980 icons in five styles, renderer-only — [`packages/icons/README.md`](packages/icons/README.md)).

`apps/web` is the public site — marketing and, in time, documentation. Next.js,
Tailwind v4, shadcn on the same `base-nova` preset the desktop renderer uses. It
shares no code and no data with the product and is deployed on its own
([`apps/web/README.md`](apps/web/README.md), hosting in [`docs/STACK.md`](docs/STACK.md) §4).

`docs/DESIGN.md` carries the rationale for every non-obvious decision. **The
rationale is the part that tells you whether a change is safe** — the two-counter
(`ord`/`rev`) model, the contiguity rule, chat-as-sync-unit and the identity
layering each prevent a specific documented failure.

## Working rules

### 1. Cross-validate against the docs. Do not work from memory.

- **Read the relevant section before changing anything it covers.** A change
  that looks obviously correct is frequently the one the rationale warns about.
- **If the code and the docs disagree, stop and say so.** Do not silently pick
  one and carry on — one of them is a bug, and which one matters.
- **For any library or platform API, fetch current documentation** via context7
  (IDs in [`docs/STACK.md`](docs/STACK.md) §5) or the official docs. Do not
  answer from recall.

That last rule is not boilerplate. This project has already been bitten three
times by confident, plausible, wrong recall:

| Believed | Actually |
|---|---|
| `auto_vacuum` just needs to precede `CREATE TABLE` | It must also precede `journal_mode=WAL`, or it is **silently ignored** |
| `CHECK (kind IN (…) OR visibility IN (…))` rejects a NULL | `FALSE OR NULL` is `NULL`, and a CHECK only rejects `FALSE` — it permits the exact row it forbids |
| Postgres mounts at `/var/lib/postgresql/data` | True through 17. **Postgres 18 moved it**, and the failure message points nowhere near the cause |

Each was found by running something, not by reading it.

### 2. Verify by execution, not by inspection.

- **`pnpm spike:sync` must pass.** 66 assertions over ord/rev separation, cursor
  contiguity, gap markers, catch-up, backfill paging, idempotency, unread math,
  outbox coalescing and read-state convergence. The suite is mutation-tested —
  treat a failure as a real regression, never as flakiness. It also runs the
  visibility suite (`spikes/visibility-tests.mjs`): 99 checks over restricted
  messages and gap repair, 400 random worlds included. `pnpm spike:sync:mutants`
  must still catch all 30 of its planted bugs after any change to it.
- **Schema changes get executed against a real engine**, not eyeballed.
  Constraints need a test *per constraint*, each asserted against an expected
  outcome.
- **Do not report a change as working because it looks right.** If something is
  unverified, say which part.

### 3. Keep the docs true.

When a decision changes, update the doc **in the same change** as the code, and
update the **rationale**, not just the conclusion. A stale design doc is worse
than none, because it is trusted.

### 4. Build the smallest thing that satisfies the requirement.

This codebase is early; the risk is over-building. Workspace members under
`apps/` and `packages/` are added when needed — do not scaffold speculatively.

### 5. A number is never a reference. Name the thing.

A bare identifier is a locator, not a meaning. It forces the reader to stop, open
a document and find the entry before they can tell whether the point even
concerns them — and a mistyped one sends them somewhere unrelated with no sign
that anything went wrong.

**The test: delete every number from what you wrote. If what remains no longer
identifies what you meant, it was wrong.** Apply it before sending, not after
being asked.

| ✗ Wrong | ✓ Right |
|---|---|
| "Next is 12d." | "Next is the renderer telemetry transport — the renderer has no way to report anything today (Phase 1½ item 12d)." |
| "specified in `FRONTEND.md` §5" | "specified in the frontend doc's read-path client section (`FRONTEND.md` §5)" |
| "invariant 43" | "an unknown frame type is ignored rather than fatal (invariant 43)" |
| "see §9.10" | "old clients must tolerate new servers — forward compatibility (`DESIGN.md` §9.10)" |
| "this breaks R2" | "this breaks R2 — updates must arrive for every space, open on screen or not" |

Three things that make it strict rather than aspirational:

- **It covers every kind of identifier**, not just section numbers: build-order
  and phase items (`12c`, `Phase 1½`), invariant numbers, rule numbers,
  requirement codes (`R1`–`R3`), and a document name standing on its own.
- **The name comes first and the number second**, in parentheses or after a dash.
  Never the reverse, and never the number by itself.
- **Every mention, not only the first.** Context does not carry: the reader may
  be scanning, resuming days later, or reading on another device. A reply that
  says "12d" three messages in is as opaque as one that opens with it.

Applies to replies, commit messages, code comments and the docs themselves.

And the corollary worth stating, because it is usually the real cause: **if you
cannot name it, you have not read it.** Reaching for the number is what reaching
for something you have not opened feels like. Go and read it, then write the
name.

### 6. Descriptive names, including loop variables.

No single-letter or clipped bindings for domain objects: `chat` not `c`, `actor`
not `a`, `message` not `m`, `space` not `s`. Loops read
`for (const chat of chats)`, never `for (const c of chats)`.

The reason is not tidiness. Two of the most dangerous rules in this system —
space membership is the leading conjunct of chat access, and every message lives
in a chat rather than in a space — are rules about *which* entity a line is
holding. `access(a, c)` hides that; `access(actor, chat)` states it.

**The wire protocol is the one exception, and it does not leak.** Frames carry
`"t"`, `"c"`, `"m"`, `"r"` (DESIGN, *Sync protocol*) because bytes on a socket
are a different concern from code that reads. Give them names at the parse
boundary; those keys must never travel further in.

### 7. Never commit until asked.

Do not `git commit`, `git push`, create a branch or open a PR unless the ask was
explicit — "make the change" is not "commit the change". Leave the work in the
tree and say what is there.

When a commit *is* asked for, it goes on **`main`**. This repository does not use
feature branches. (The previous wording here, "work off the default branch", read
both ways and was taken as the opposite — which is the failure rule 5 is about,
in a rule rather than a reference.)

Approval is per-request and does not carry forward: being asked to commit once
is not standing permission for the next change.

### 8. Observability is part of the feature, not a follow-up.

Any feature that is worth building is worth being able to see in production.
Read [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) before adding a log, a
metric or a span — and before deciding a feature needs none.

The work is a conversation, not a checklist:

- **Propose the markers with the question each one answers.** "A counter of
  live-query subscriptions" is not a justification; "we cannot currently tell a
  wedged invalidation registry from an idle one" is.
- **Say what each is worth, and what it costs.** A marker nobody will read costs
  cardinality, ingest and attention, and makes the signal around it harder to
  find. Proposing *not* to instrument something is a legitimate answer.
- **Agree them with the dev before adding them.** Instrumentation shapes what
  gets debugged for the life of the feature; it is their call, not a detail to
  slip in.

Two limits are not negotiable and are enforced at compile time: **no message
body in telemetry, ever**, and **no unbounded id as a metric label** — 100
actors × 150 chats is 15k series for one metric, against a 10k cap.

## Commands

```bash
pnpm install         # pnpm 11, Node >=24 (engine-strict is on)
pnpm services        # Postgres + Redis + MinIO + Grafana — docs/STACK.md §3
pnpm services:down   # stop them
pnpm dev             # desktop app + server, in parallel
pnpm web             # the public site on :3100 — apps/web/README.md
pnpm typecheck       # all packages, then the boundary checker
pnpm test            # all packages
pnpm spike:sync      # sync-protocol model tests — must stay green
pnpm spike:authz     # authorization model tests
pnpm verify:hotkeys  # keyboard shortcut spikes under real Electron (spikes/hotkeys)
pnpm verify:web-panels # web pages in panels as <webview>, and main's attach check (spikes/web-panels)
pnpm verify:text-fragments # #:~:text= scrolling inside a panel, for annotations (spikes/text-fragments)
pnpm check:boundaries # the rules below, run by typecheck too
pnpm otel:smoke      # prove the telemetry loop works before debugging the app
```

**One Electron instance at a time.** The app takes a single-instance lock, so a
second `pnpm dev` exits with "another instance already holds the lock" rather
than racing. An orphaned instance (`ppid=1`) serving a stale build has caused
confusion twice — check `ps` before concluding a change did not apply.

## Non-negotiables

Full list in `docs/DESIGN.md` §14 — 73 invariants; the reasoning for 37–47 lives
in `docs/STORAGE.md` §18, for 48–54 in `docs/AUTHZ.md` §13, for 55–71 in
`docs/FRONTEND.md` §12, and for 72–73 in `docs/SHORTCUTS.md`, each paired with
the failure it prevents. The ones that can be checked mechanically are held by
the fourteen rules in `pnpm check:boundaries` rather than by being remembered. The ones
most easily broken by a reasonable-looking change:

| | |
|---|---|
| Every read of granted data is **local** | Fetching granted data from the network is a bug (§3) |
| **Chat** is the sync unit | Messages reference `chat_id`, never a space directly (§7.1) |
| No identity reference **below Layer 2** | Only `actors` holds a `workos_*` id, or agents become second-class (§6.3) |
| `synced_through_rev` advances **contiguously** | Never past a hole, or you get silent permanent history gaps (§8.1) |
| `ord` is never renumbered or reused | Read cursors and scroll positions corrupt across clients (§8.1) |
| `last_read_ord` is a **max**-register | Not LWW — a stale device would un-read a chat (§4) |
| Message IDs are **client**-generated | Offline compose, edit and react are otherwise impossible (§10.1) |
| Auth failure **never** clears local data | A token expiring is not a sign-out (§13.1) |
| An **unknown event type still advances the cursor** | Old clients exist — updates are opt-in. The frontier stalls forever otherwise (§9.10) |
| Inbound frames parse **permissively**, never `.strict()` | One added server-side field breaks every older client in the field (§9.10) |
| **No message body in telemetry**, ever | Structured events only — a template-literal log puts the product in Loki (OBSERVABILITY §6) |
| No unbounded **id as a metric label** | 100 actors × 150 chats = 15k series for one metric; the free tier caps at 10k (OBSERVABILITY §5) |
| No native SQLite binding | `node:sqlite` is chosen to avoid `electron-rebuild` (§13.5) |
| Every renderer read goes through the **live-query client** | A read issued straight at the bridge is invisible to the invalidation registry, so nothing refreshes it (FRONTEND §5) |
| The write and read sides share **one topic vocabulary** | They drift, a push wakes nobody, and every open surface goes stale in silence (§14, invariant 68) |
| The renderer holds **no telemetry SDK** | A renderer flush timer is throttled to ~1 tick/minute when hidden, so telemetry stops draining when it is least observed (OBSERVABILITY §3) |
| An **actor write is paired with `recordActor`** | A person exists on the server and on nobody's client — their messages render as a monogram with no name, for ever, and no reconnect repairs it (SYNC-FLOWS §9.1) |

## Conventions

- ESM, Node >=24, TypeScript.
- **No TypeScript syntax that emits code.** Tests run via `node --test` on `.ts`
  directly, which is strip-only — it removes types but cannot generate code. So
  no constructor parameter properties, `enum`, `namespace`, or decorators.
  Declare and assign fields explicitly instead.
- Imports inside packages use explicit `.ts` extensions, for the same reason:
  Node's ESM resolver has no extension inference.
- Comments explain **why**, not what, and point at the doc **by name** rather
  than restating it — `the contiguity invariant, DESIGN §8.1`, never a bare
  `§8.1` (*Name the thing, never just its number*).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
