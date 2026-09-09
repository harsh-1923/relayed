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
| **1½ — the shell** | **In progress.** Router ✅, transition table ✅, live-query client ✗, renderer telemetry ✗ |
| 2 — the sync core | Next. [`docs/PHASE-2-SYNC.md`](docs/PHASE-2-SYNC.md) |

**Next task: Phase 1½ item 12c**, the live-query client — `DESIGN.md` §11's
client half, specified in [`FRONTEND.md`](docs/FRONTEND.md) §5.
`apps/desktop/src/renderer/routes/People.tsx` is the surface waiting on it: a
list an invalidation should refresh, which nothing refreshes today.

Green as of the last commit: **125 tests**, 103 spike assertions, 6 boundary
rules over 152 files, typecheck across four packages, production build.

## Documentation

| Doc | Covers |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | **Design of record.** Architecture, schema, sync protocol, invariants. |
| [`docs/STACK.md`](docs/STACK.md) | Technology choices and why, the local dev stack, library docs and context7 IDs. |
| [`docs/RELEASE.md`](docs/RELEASE.md) | How builds reach users, code signing, forward compatibility across versions. |
| [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) | What we collect and how. Read before adding any log, metric or span. |
| [`docs/STORAGE.md`](docs/STORAGE.md) | Local storage layout, multi-workspace and multi-account, switching flows. |
| [`docs/AUTHZ.md`](docs/AUTHZ.md) | Who may do what. The `memberships` shape, the single `can()`, and why FGA is deferred. |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Renderer architecture: routing, what the URL addresses, the read path, where state lives. |
| [`docs/PHASE-1-IDENTITY.md`](docs/PHASE-1-IDENTITY.md) | Phase 1, **closed**: tenancy, social login, the actor model, invitations. |
| [`docs/PHASE-2-SYNC.md`](docs/PHASE-2-SYNC.md) | **Next phase**: the sync core. Start here for what to build and what already exists to build on. |
| [`spikes/`](spikes/) | Executable models that validate the design. Not app code. |

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
  treat a failure as a real regression, never as flakiness.
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

### 5. Name the thing, never just its number.

When you write or say something, refer to a section, rule or invariant **by its
title**. `§9.10` and "invariant 43" are locators, not meanings — the reader has
to go and look one up before they can tell whether the point is even relevant to
what they are doing, and a mis-typed number sends them somewhere unrelated with
no sign that anything went wrong.

Write "the contiguity invariant", "an unknown event type still advances the
cursor", "chat is the sync unit". A number may **follow** the name as a pointer;
it may never stand in for one.

This applies to replies, commit messages, comments and the docs themselves.

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

Work off the default branch. Do not `git commit`, `git push`, create a branch or
open a PR unless the ask was explicit — "make the change" is not "commit the
change". Leave the work in the tree and say what is there.

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
pnpm typecheck       # all packages, then the boundary checker
pnpm test            # all packages
pnpm spike:sync      # sync-protocol model tests — must stay green
pnpm spike:authz     # authorization model tests
pnpm check:boundaries # the six rules below, run by typecheck too
pnpm otel:smoke      # prove the telemetry loop works before debugging the app
```

**One Electron instance at a time.** The app takes a single-instance lock, so a
second `pnpm dev` exits with "another instance already holds the lock" rather
than racing. An orphaned instance (`ppid=1`) serving a stale build has caused
confusion twice — check `ps` before concluding a change did not apply.

## Non-negotiables

Full list in `docs/DESIGN.md` §14 — 67 invariants; the reasoning for 37–47 lives in `docs/STORAGE.md` §18, for 48–54 in `docs/AUTHZ.md` §13, and for 55–67 in `docs/FRONTEND.md` §12, each paired with the failure
it prevents. Six of them are enforced by `pnpm check:boundaries` rather than by
being remembered. The ones most easily broken by a reasonable-looking change:

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
