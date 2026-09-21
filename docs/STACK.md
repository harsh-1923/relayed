# Stack

Technology choices, why they were made, and how to run everything locally.

Deployment and tooling only — the architecture lives in
[`DESIGN.md`](DESIGN.md), which deliberately says nothing about hosting.
How builds reach users — packaging, signing, update channels — is
[`RELEASE.md`](RELEASE.md); what we collect at runtime is
[`OBSERVABILITY.md`](OBSERVABILITY.md).

**Last updated:** 2026-09-21

---

## 1. Decisions

| Layer | Choice | Why |
|---|---|---|
| Server runtime | **Node + TypeScript** | Shares protocol types, Zod schemas and the `ord`/`rev` sync logic with the Electron client |
| HTTP / WS | **Fastify** + **`ws`** | Small HTTP surface; `ws` keeps us native-module-free, like `node:sqlite` |
| Server database | **Postgres** | Row locks for counter bumps, `ON CONFLICT … RETURNING`, partial unique indexes |
| Query layer | **Kysely** | A SQL-forward schema wants a builder, not an abstraction |
| Fanout / presence | **Redis pub/sub** | At-most-once is sufficient — cursors self-heal (§9.3) |
| Client database | **`node:sqlite`** | No native module, no `electron-rebuild` (§13.5) |
| Client shell | **Electron** + electron-vite + electron-builder | §5 process architecture; distribution in [`RELEASE.md`](RELEASE.md) |
| Client UI | **React**, shadcn/Tailwind, TanStack Virtual | Windowing a message list is not worth hand-rolling |
| Client icons | **`@relayed/icons`** | One set, five styles per icon chosen at the call site; replaced lucide-react ([`FRONTEND.md`](FRONTEND.md) §6.1) |
| Client shortcuts | **`@tanstack/hotkeys` 0.8.0**, core only, parse/normalize/format/record | Admitted by [`spikes/hotkeys/`](../spikes/hotkeys/README.md); its matcher breaks the logical-key contract, so matching is ours ([`SHORTCUTS.md`](SHORTCUTS.md) §11). A dependency of `@relayed/desktop`, imported only by `shared/shortcuts/tanstack-driver.ts`. |
| Client routing | **React Router**, declarative mode, `HashRouter` | Loaders assume fetching is expensive; ours is ~1 ms from disk ([`FRONTEND.md`](FRONTEND.md) §4) |
| Client read path | **Ours**, implementing §11 | A push-invalidated local replica is the data layer; a server-state cache is priced for a cost we do not pay (§5.2) |
| Blobs | **S3-compatible** — R2 in production, MinIO locally | Egress cost dominates for a media-heavy chat client |
| Auth | **WorkOS** | AuthKit for humans, M2M for agents, Pipes + Relay for third-party access (§6.2) |
| Public site | **Next.js** App Router, Tailwind v4, shadcn — `apps/web` | Marketing and documentation. Static pages with no socket and no database, so the constraint below does not reach it |
| Deploy artifact | **A long-running container** | The one hard constraint |

That last row is what portability actually turns on. Everything else is
swappable; a server holding sockets for hours needs a process that stays up.

### Scale posture

**One server instance, with Redis pub/sub from day one.** At ~4,000 concurrent
connections a single instance has enormous headroom — measured at 0.005% of one
core idle and ~11 KB RSS per connection (§13.9). Redis costs ~20 lines now;
retrofitting cross-instance fanout under load is a bad day.

A useful property falls out: **no sticky sessions are needed.** All state lives
in Postgres and Redis, never in the connection handler, so any instance can
serve any client.

---

## 2. Deliberately not chosen

Recorded so they are not revisited by accident.

| Rejected | Why |
|---|---|
| **Serverless** (Vercel, Cloud Run, Lambda) **for `apps/server`** | A client holds a socket for hours. Vercel functions cap at 300s; Cloud Run at 60 minutes with max 1000 concurrent connections per container. You would pay container prices to hold idle sockets. **This rejection is about the sync server only.** The public site (`apps/web`) holds nothing open and is a good fit for Vercel — §4. |
| **Prisma** | Own schema DSL, weak partial-index support, awkward raw SQL. Our schema uses partial unique indexes as *structural* invariants (§7.1). |
| **MySQL / Vitess** | No partial indexes, so `chat_singleton` degrades from a database guarantee to application logic. |
| **Turso / libSQL** | Sharing the SQLite dialect across client and server is attractive, but only ~60% of the schema overlaps, and adding a database that also does its own sync to a product whose hard part is sync creates two competing sync stories. |
| **Kafka / NATS JetStream** | Durable log semantics we do not need — cursors and gap markers already repair dropped fanout. |
| **Redux, Zustand, or any global client store** | §5: the renderer holds no authoritative state. A store reintroduces the drift the architecture removes, and there is no category of state left for it to hold (`FRONTEND.md` §3). |
| **TanStack Query** | A server-state cache priced for a network round trip. Our read is a ~1 ms SQLite query over a MessagePort, so `staleTime`, background refetch, dedup and retry all solve a cost we do not pay — and `useInfiniteQuery` is single-direction where the message list needs paging around an anchor (`FRONTEND.md` §5.2). **Decision held, now measured:** the live-query client is built, and its registry is 125 code lines against the 150-line trigger that would have reversed this. Re-check when anchored paging lands. |
| **React Router framework mode** | Owns the Vite build, which `electron-vite` already does, and has no hash-history option — our production renderer loads from `file://`. SSR is meaningless here and route code splitting works against R3 (`FRONTEND.md` §4.2). |
| **React Router data mode** | Loaders revalidate on navigation and after actions; our data changes when the server pushes. Every list would need a loader *and* a subscription — two sources of truth for one view (`FRONTEND.md` §4.3). |
| **`better-sqlite3`** | Native module, `electron-rebuild` on every Electron upgrade. `node:sqlite` covers every feature we need (§13.5). |
| **uWebSockets.js** | Faster and leaner than `ws`, but a native binding. Keep as an escape hatch above ~100k connections. |

---

## 3. Local development stack

`compose.yaml` runs Postgres, Redis and MinIO. Deliberately host-agnostic — no
managed services, so what runs locally is what runs in production.

```bash
cp .env.example .env

pnpm services        # start everything, wait until healthy, create the bucket
pnpm services:down   # stop, keep data
pnpm services:reset  # stop and DESTROY volumes
pnpm services:lite   # everything except Grafana (~1 GB lighter)
pnpm services:ps     # what is running
pnpm services:logs   # follow logs
pnpm psql            # psql into the local database
pnpm redis-cli       # redis-cli into the local Redis
```

Grafana/Tempo/Loki/Prometheus comes up with everything else — see
[`OBSERVABILITY.md`](OBSERVABILITY.md) §10. It is the heavy container (~1 GB
idle); `pnpm services:lite` omits it.

**No compose profiles, deliberately.** A profiled service is skipped by a plain
`docker compose down`, which silently leaves a 1 GB container running and blocks
network teardown with "Resource is still in use". One profile-free stack is
worth more than a lighter default.

| Service | Version | Port | Credentials |
|---|---|---|---|
| Postgres | 18 | 5432 | `relayed` / `relayed`, db `relayed` |
| Redis | 8 | 6379 | none |
| MinIO API | latest | 9000 | `relayed` / `relayedsecret` |
| MinIO console | | 9001 | same |

Bucket `relayed-blobs` is created automatically and set to private. Ports are
overridable via `POSTGRES_PORT`, `REDIS_PORT`, `MINIO_PORT`,
`MINIO_CONSOLE_PORT` if something already owns them.

### Three things about it that are load-bearing

**Redis persistence is disabled on purpose** (`--save "" --appendonly no`). It
holds only fanout, presence and rate limiting — all reconstructible, because
clients recover missed events through cursors and gap markers (§9.3). If Redis
ever holds durable state, that is a bug, and the config exists to make that
obvious.

**Postgres 18 mounts at `/var/lib/postgresql`, not `…/data`.** The image places
the cluster in a version-specific subdirectory so `pg_upgrade --link` can work
without crossing a mount boundary. Mounting `…/data` — correct for 17, and what
almost every guide online still shows — fails to start with a misleading
"unused mount/volume" message and a restart loop.

**ICU collation is set explicitly** (`--locale-provider=icu
--icu-locale=und-x-icu`). Text index ordering must not depend on the host
locale, or a developer laptop and a production server can disagree about sort
order.

### Verified against this stack

The following were executed against local Postgres 18.6, not assumed:

- Atomic counter bump — `UPDATE … SET next_ord = next_ord+1 … RETURNING`
- Idempotency — `INSERT … ON CONFLICT (op_id) DO NOTHING RETURNING` returns zero
  rows on retry
- Partial unique index — a second `default` chat per space is rejected
- **The CHECK/NULL trap behaves identically to SQLite** — invariant 27 is
  portable across both engines, not a SQLite quirk
- Data survives `services:down` → `services`

`docker/postgres/init/*.sql` runs **once**, on first cluster init only. Reserve
it for things that must exist before migrations (extensions, roles) — not for
the schema, which belongs in a migration runner.

---

## 4. Hosting

**Undecided, and deliberately so.** Building against plain Docker + Postgres +
Redis keeps every option open at no cost. Candidates: Fly.io (built for
long-lived connections), Railway/Render (least ops), AWS ECS/Fargate + ALB, GKE
or Compute Engine on GCP.

GCP and AWS are peers here; neither buys anything specific. What matters is
picking a compute primitive that permits long-lived processes.

### The public site is hosted separately

`apps/web` is marketing and documentation: static pages, no socket, no database,
nothing shared with the server but a domain. **Vercel**, where the constraint
that rules serverless out for `apps/server` simply does not apply. Keeping the
two apart also means a marketing deploy cannot take the product down, and the
site stays up while the server is being redeployed.

What it must not acquire, for that separation to stay real: no read of the
product's Postgres, no socket to the sync server, no shared secret. If the site
ever needs product data, it comes through a public endpoint the server already
serves.

### What portability rules out

Worth naming so it does not erode by accident:

- **No host-managed queues or schedulers.** Retention sweeps and auto-dormancy
  (§7.5, §13.6) run in-process or in a sidecar, not on platform cron.
- **No Postgres extensions beyond the common set.** Everything in §8.3 is core
  Postgres.
- **No `LISTEN/NOTIFY` as fanout.** We are on Redis; NOTIFY's 8 KB payload limit
  and listener scaling would have bitten eventually.
- **Config strictly via environment variables.**

### Whatever the host, the proxy timeouts apply

Every candidate puts a proxy in front, and each closes idle connections — AWS
ALB at 60s, Cloudflare at 100s, nginx `proxy_read_timeout` at 60s. The ~30s
heartbeat in §13.9 is a floor, not a preference.

---

## 5. Library reference

Fetch current documentation rather than recalling API details. Where a
context7 ID is listed it has been verified; otherwise resolve it at time of use.

| Library | Docs | context7 |
|---|---|---|
| Electron | https://electronjs.org/docs/latest | `/electron/electron` |
| electron-builder | https://electron.build | `/electron-userland/electron-builder` |
| electron-vite | https://electron-vite.org | resolve |
| electron-updater | https://www.electron.build/auto-update | `/electron-userland/electron-builder` |
| React | https://react.dev | resolve |
| React Router | https://reactrouter.com | resolve |
| TanStack Virtual | https://tanstack.com/virtual/latest | resolve |
| TanStack Hotkeys (core, `0.8.0` exact) | https://tanstack.com/hotkeys/latest/docs/reference | resolve |
| Fastify | https://fastify.dev/docs/latest | `/fastify/fastify` |
| @fastify/websocket | https://github.com/fastify/fastify-websocket | `/fastify/fastify-websocket` |
| ws | https://github.com/websockets/ws | resolve |
| Kysely | https://kysely.dev | `/kysely-org/kysely` |
| kysely-ctl (migrations) | https://github.com/kysely-org/kysely-ctl | `/kysely-org/kysely-ctl` |
| kysely-codegen | https://github.com/RobinBlomberg/kysely-codegen | `/robinblomberg/kysely-codegen` |
| Zod | https://zod.dev | resolve |
| Postgres 18 | https://postgresql.org/docs/18/ | resolve |
| Redis | https://redis.io/docs/latest | resolve |
| MinIO | https://min.io/docs/minio/linux/index.html | resolve |
| WorkOS | https://workos.com/docs | `/websites/workos` |
| OpenTelemetry JS | https://opentelemetry.io/docs/languages/js/ | resolve |
| pino | https://getpino.io | resolve |
| Grafana Cloud / OTLP | https://grafana.com/docs/grafana-cloud/send-data/otlp/ | resolve |
| node:sqlite | https://nodejs.org/api/sqlite.html | resolve |
| Next.js (`apps/web`) | https://nextjs.org/docs | `/vercel/next.js` |
| Tailwind CSS v4 | https://tailwindcss.com/docs | resolve |
| shadcn | https://ui.shadcn.com/docs | resolve |

**Workspace packages must be bundled, not externalized.** `electron-vite`'s
`externalizeDepsPlugin()` treats every `dependency` as external, including
workspace packages — so Electron tries to load `@relayed/telemetry`'s raw
TypeScript at runtime and fails to resolve it. Pass
`externalizeDepsPlugin({ exclude: ['@relayed/telemetry'] })`. The build succeeds
either way; only the run fails, which makes it easy to miss.

**Migration strategy.** `kysely-codegen` generates TypeScript types from a live
database, which supports the decision to keep hand-written SQL as the source of
truth: write SQL migrations, run them, generate types from the result. The SQL
in §8.3 stays the artifact rather than becoming generated output.

---

## 6. Open decisions

1. **Hosting** — deferred; see §4. Release and distribution decisions are
   settled separately in [`RELEASE.md`](RELEASE.md).
2. **Retention and dormancy sweeps** — in-process interval, or a sidecar? A
   Redis leader lock once there is more than one instance.
3. **Agent service boundary** — a module inside `apps/server` first, or its own
   deployable immediately? §6.5 requires a separate *service* for the delivery
   guarantee, which does not necessarily mean a separate *process* on day one.
4. ~~**TypeScript config**~~ — settled: shared `tsconfig.base.json` with
   per-package `extends`, scheduled as Phase 0 item 3 (§15), ahead of the first
   package rather than after the second.
5. **Observability** — settled in [`OBSERVABILITY.md`](OBSERVABILITY.md):
   Grafana Cloud, OTel for traces and metrics, pino for logs, client telemetry
   routed through our own server. Product analytics remains a separate question
   from operational telemetry.
6. ~~**Frontend architecture**~~ — settled in [`FRONTEND.md`](FRONTEND.md):
   React Router in declarative mode, everything addressable in the URL with the
   workspace included, our own live-query client rather than a server-state
   cache, and no global store. Two libraries are deferred with named triggers
   rather than indefinitely — **XState** at the Phase 2 transport (§7.4) and
   **Zod** at the first wire format (§8.3) — so both are decisions with dates
   attached rather than open questions.
