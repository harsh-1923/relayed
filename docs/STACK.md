# Stack

Technology choices, why they were made, and how to run everything locally.

Deployment and tooling only — the architecture lives in
[`DESIGN.md`](DESIGN.md), which deliberately says nothing about hosting.
How builds reach users — packaging, signing, update channels — is
[`RELEASE.md`](RELEASE.md); what we collect at runtime is
[`OBSERVABILITY.md`](OBSERVABILITY.md).

**Last updated:** 2026-09-08

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
| Client UI | **React**, TanStack Query, TanStack Virtual | Query's invalidation model matches §11.2 exactly |
| Blobs | **S3-compatible** — R2 in production, MinIO locally | Egress cost dominates for a media-heavy chat client |
| Auth | **WorkOS** | AuthKit for humans, M2M for agents, Pipes + Relay for third-party access (§6.2) |
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
| **Serverless** (Vercel, Cloud Run, Lambda) | A client holds a socket for hours. Vercel functions cap at 300s; Cloud Run at 60 minutes with max 1000 concurrent connections per container. You would pay container prices to hold idle sockets. |
| **Prisma** | Own schema DSL, weak partial-index support, awkward raw SQL. Our schema uses partial unique indexes as *structural* invariants (§7.1). |
| **MySQL / Vitess** | No partial indexes, so `chat_singleton` degrades from a database guarantee to application logic. |
| **Turso / libSQL** | Sharing the SQLite dialect across client and server is attractive, but only ~60% of the schema overlaps, and adding a database that also does its own sync to a product whose hard part is sync creates two competing sync stories. |
| **Kafka / NATS JetStream** | Durable log semantics we do not need — cursors and gap markers already repair dropped fanout. |
| **Redux or any global client store** | §5: the renderer holds no authoritative state. A store reintroduces the drift the architecture removes. |
| **`better-sqlite3`** | Native module, `electron-rebuild` on every Electron upgrade. `node:sqlite` covers every feature we need (§13.5). |
| **uWebSockets.js** | Faster and leaner than `ws`, but a native binding. Keep as an escape hatch above ~100k connections. |

---

## 3. Local development stack

`compose.yaml` runs Postgres, Redis and MinIO. Deliberately host-agnostic — no
managed services, so what runs locally is what runs in production.

```bash
cp .env.example .env

pnpm stack:up        # start, wait until healthy, create the blob bucket
pnpm stack:down      # stop, keep data
pnpm stack:reset     # stop and DESTROY volumes
pnpm stack:ps        # what is running
pnpm stack:logs      # follow logs
pnpm psql            # psql into the local database
pnpm redis-cli       # redis-cli into the local Redis
```

Observability runs separately behind an opt-in profile (`pnpm obs:up`) — see
[`OBSERVABILITY.md`](OBSERVABILITY.md) §10.

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
- Data survives `stack:down` → `stack:up`

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
| TanStack Query | https://tanstack.com/query/latest | resolve |
| TanStack Virtual | https://tanstack.com/virtual/latest | resolve |
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
