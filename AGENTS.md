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

## Documentation

| Doc | Covers |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | **Design of record.** Architecture, schema, sync protocol, invariants. |
| [`docs/STACK.md`](docs/STACK.md) | Technology choices and why, the local dev stack, library docs and context7 IDs. |
| [`docs/RELEASE.md`](docs/RELEASE.md) | How builds reach users, code signing, forward compatibility across versions. |
| [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) | What we collect and how. Read before adding any log, metric or span. |
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

## Commands

```bash
pnpm install         # pnpm 11, Node >=24 (engine-strict is on)
pnpm services        # Postgres + Redis + MinIO + Grafana — docs/STACK.md §3
pnpm services:down   # stop them
pnpm dev             # every dev server, in parallel (currently the desktop app)
pnpm otel:smoke      # prove the telemetry loop works before debugging the app
pnpm spike:sync      # sync-protocol model tests — must stay green
```

## Non-negotiables

Full list in `docs/DESIGN.md` §14 — 31 invariants, each paired with the failure
it prevents. The ones most easily broken by a reasonable-looking change:

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
- Comments explain **why**, not what, and point at the doc (`§8.1`) rather than
  restating it.
- Work off the default branch. Commit only when asked.
