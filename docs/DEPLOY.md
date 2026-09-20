# Deploying the server

How `apps/server` reaches a machine other than a laptop, and what has to be true
for it to work.

This is the runbook. The *reasoning* behind hosting choices is in
[`RELEASE.md`](RELEASE.md); architecture is in [`DESIGN.md`](DESIGN.md).

**Last updated:** 2026-09-20

---

## 1. The shape

| | |
|---|---|
| **Host** | Railway — the server and Postgres as two services in one project |
| **API address** | `https://api.relayed.imharsh.in` — **live** |
| **Project** | `relayed`, `9962b6e0-c7d1-49a1-b703-d84a09d0af44` |
| **Region** | `asia-southeast1` (Singapore, Equinix SG3), both services. ~45ms TCP from India |
| **Instances** | **Exactly one.** Never more (§2) |
| **Build** | A plain Dockerfile, so the same image runs anywhere |
| **Migrations** | In-process at boot. No separate deploy step |
| **Not deployed** | `apps/agent`, memory, Composio connectors — all optional (§8) |

## 2. The one-instance rule

**`replicas = 1`, and it is not a performance setting.**

[`sync/registry.ts`](../apps/server/src/sync/registry.ts) holds connected
sockets in an in-process `Map`, and [`fanout.ts`](../apps/server/src/sync/fanout.ts)
writes to them directly. There is no Redis, no `LISTEN/NOTIFY`, no cross-process
bus. Two instances means **a message written on one never reaches a client
connected to the other** — not slowly, but silently, until that client happens
to reconnect.

What is *not* affected, because it is worth knowing what to fix first:

- The agent dispatcher is already safe across instances — `FOR UPDATE SKIP
  LOCKED` with leases ([`dispatcher.ts`](../apps/server/src/agents/dispatcher.ts)).
- The five background jobs (WorkOS poller, retention sweep, Composio catalogue,
  room summariser, memory ingest) would *duplicate* rather than corrupt.

So the work to lift this restriction is a fanout bus and nothing else.

**A deploy briefly overlaps old and new.** That is safe here, and only because
durable catch-up exists: the draining instance closes its sockets with a code,
clients reconnect to the new one and ask for what they missed. Overlap during a
deploy is fine. Overlap as a steady state is the bug.

## 3. Before you start

Four things that gate everything else. None of them are code.

1. **A Railway account**, and a region decision. Pick the one nearest your
   users; both services go in it.
2. **A WorkOS Production environment** (§3a).
3. **Session signing keys** (§3b).
4. **DNS access for `imharsh.in`**, to add one CNAME.

### 3a. WorkOS

The sign-in path is loopback, not a custom scheme — see
[`sync/auth/loopback.ts`](../apps/desktop/src/sync/auth/loopback.ts). WorkOS
permits `127.0.0.1` for native clients, and it is the one HTTP redirect allowed
in production.

1. In the WorkOS dashboard, switch from **Staging** to **Production**. These are
   separate environments with separate credentials — a staging client id will
   authenticate nobody in production.
2. Copy the **Client ID** (`client_...`) and create an **API key** (`sk_...`).
   The client id is a public identifier; the API key is a secret and is only
   needed for Management API calls — organisations and invitations.
3. Under **Redirects**, add both:
   - `http://127.0.0.1:*/auth/callback` — the real sign-in path
   - `relayed://auth/callback` — the packaged-app fallback

   **The wildcard cannot be the default**, and WorkOS refuses the whole save if
   it is: *"A wildcard URI can not be the default Redirect URI."* Add
   `relayed://auth/callback` as well and mark **that** one default.

   The wildcard is not negotiable — `loopback.ts` calls `server.listen(0, …)`,
   so the OS picks a fresh port per sign-in and no fixed port would match more
   than by luck. The default, meanwhile, does nothing here: `workos.ts` sends
   `redirect_uri` explicitly on every authorization request, and the default is
   only consulted when a request omits it. It has to exist, not to be right.
4. Configure whichever social providers you intend to offer.

### 3b. Session keys

Ed25519, used to sign our own session tokens. Generate them locally:

```bash
pnpm --filter @relayed/server keygen
```

It prints `SESSION_PRIVATE_KEY` and `SESSION_PUBLIC_KEY` ready to paste. The
private key goes into Railway and nowhere else — **never into git**. Rotating it
invalidates every session.

## 4. Creating the Railway project

The repo is `harsh-1923/relayed` on GitHub, so this is a connected-repo deploy
rather than a CLI push.

**1 — New project.** railway.com → **New Project** → **Deploy from GitHub
repo**. Authorise the Railway GitHub app for the repo if prompted. Pick
`harsh-1923/relayed`.

**2 — Point the service at the Dockerfile.** Railway will guess how to build the
repo, and it will guess wrong: this is a pnpm workspace whose server imports
source `.ts` from `packages/`. In **Settings → Build**:

```bash
railway variable set RAILWAY_DOCKERFILE_PATH=apps/server/Dockerfile --service relayed-server
```

**`railway.json` was not enough, and said nothing about it.** The service sat at
`builder: RAILPACK` with `railwayConfigFile: null` — Railway never picked the
file up — so it auto-detected an Electron monorepo as a generic Node app and
failed. The service variable is what actually selects the Dockerfile.

Leave **Root Directory at `/`**. Setting it to `apps/server` is the tempting
mistake: it excludes `pnpm-lock.yaml` and every workspace package, and the
install dies on an unresolvable `workspace:*`. Root Directory is the build
*context*; `RAILWAY_DOCKERFILE_PATH` is the *selection*.

Leaving Root Directory at `/` is the part people get wrong. Setting it to
`apps/server` would exclude `pnpm-lock.yaml` and every workspace package, and
the install would fail on an unresolvable `workspace:*`.

**3 — Name it and set the region.** Rename the service to `relayed-server`.

```bash
railway service scale --service relayed-server southeast-asia=1 sfo=0
```

**`sfo=0` IS THE LOAD-BEARING HALF.** Scaling to a region *adds* it and leaves
the default in place: naming only `southeast-asia=1` returns
`{"asia-southeast1": {"numReplicas": 1}, "sfo": {"numReplicas": 1}}` — two
replicas in two regions, which is exactly the split §2 forbids, arrived at by a
command that reads like it sets one. Read the output, do not assume it.

**4 — Add Postgres**, then put it in the same region:

```bash
railway add --database postgres
railway service scale --service Postgres southeast-asia=1 sfo=0
```

A new Postgres has `region: null`, meaning the platform default. Left alone it
sits in the US while the server runs in Singapore, and every membership query —
one per delivered event (§2) — crosses the Pacific. Cheap to fix before there
is data; not after.

**5 — Set the environment variables** (§5), then deploy.

**6 — Add the domain** (§6).

## 4a. The image

`apps/server/Dockerfile`. Built and run end to end before the first deploy:
migrations applied, `/health` answered, `/sync` returned `101 Switching
Protocols`, and SIGTERM exited 0 rather than being killed.

Two things it does that are not obvious, both of which would fail at **runtime**
rather than at build time if changed:

**Workspace packages must stay symlinked.** Node refuses to strip types from a
`.ts` file that physically lives under `node_modules` —
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, confirmed by running it both
ways. `pnpm install` symlinks each workspace package, so the realpath resolves
to `/app/packages/…` and stripping applies. **`pnpm deploy` copies real files
into `node_modules` instead**, and the server would die on its first import of
`@relayed/protocol` with an error that mentions none of this. The same applies
to `node-linker=hoisted`.

**The install is filtered and production-only.**
`--filter "@relayed/server..."` takes the server and its workspace dependencies
and nothing else — without it the image pulls Electron, a devDependency of
`@relayed/desktop` worth over 100MB that the server never loads. `--prod` then
drops typescript, eslint and prettier, and `--ignore-scripts` is required
alongside it: the root `prepare` runs husky, which `--prod` has just declined to
install, and the install fails with `husky: not found`.

Result: **577MB**, no Electron, no compiler, no dependency postinstall executed
during the build.

`railway.json` at the repo root carries the rest — Dockerfile path, health check
on `/health`, and `numReplicas: 1` (§2). Config lives in the repo rather than
only in the dashboard, so it survives a project being recreated.

## 4b. The same setup from the CLI

Everything in §4 can be done from a terminal. The CLI reads `railway.json`, so
the build and deploy settings come across without being re-entered.

```bash
railway init --name relayed             # create the project
railway add --database postgres --json  # provision Postgres
railway variables --set HOST=0.0.0.0 --set NODE_ENV=production
railway domain                          # or add the custom domain in settings
railway up                              # build and deploy from this directory
```

Two things still need the dashboard: **the region** for each service, and the
custom domain's CNAME target. Set the region before the first deploy — moving a
service afterwards means recreating it.

Never put `SESSION_PRIVATE_KEY` or `WORKOS_API_KEY` in a command that lands in
shell history. Set those two through the dashboard.

## 5. Environment variables

Set on the `relayed-server` service.

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | **Verify the host ends `.railway.internal`.** The public proxy costs egress and a hop |
| `HOST` | `0.0.0.0` | Defaults to loopback, which a container cannot be reached on |
| `NODE_ENV` | `production` | |
| `WORKOS_CLIENT_ID` | `client_...` | Required — the server refuses to boot without it |
| `WORKOS_API_KEY` | `sk_...` | Management API only |
| `SESSION_PRIVATE_KEY` | from §3b | Secret |
| `SESSION_PUBLIC_KEY` | from §3b | |
| `RELAYED_PUBLIC_URL` | `https://api.relayed.imharsh.in` | |

`PORT` is injected by Railway and already read by
[`env.ts`](../apps/server/src/env.ts). Do not set it.

**`RELAYED_DEV_ROUTES` must be absent.** It registers routes that write messages
nobody authenticated. `env.ts` throws on boot if it is set alongside
`NODE_ENV=production` — a deliberate refusal rather than a warning.

## 6. The custom domain

**This is the step that keeps hosting swappable.** The desktop app has no
runtime configuration path — the server URL is compiled into the build, and
there is no auto-update ([`RELEASE.md`](RELEASE.md)). A hostname that belongs to
Railway would strand every installed client the day you move. A hostname you own
makes that move a DNS change nobody notices.

1. Service → **Settings → Networking → Custom Domain** → `api.relayed.imharsh.in`
2. Railway returns **two** records. Both are required — the TXT proves
   ownership and no certificate is issued without it:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `api.relayed` | `<target>.up.railway.app` |
   | TXT | `_railway-verify.api.relayed` | `railway-verify=<token>` |

   GoDaddy appends the zone itself, so the Name is `api.relayed`, never
   `api.relayed.imharsh.in` — the full form creates `…imharsh.in.imharsh.in`
   and resolves nowhere.

3. Verification took about three minutes, then the certificate issued in under
   one. `dig +short TXT _railway-verify.api.relayed.imharsh.in` can return
   empty from a public resolver while already correct at the authoritative
   nameserver; query the NS directly before concluding a record is missing.

Set the health check path to `/health` in **Settings → Deploy** so a failed boot
is caught before traffic reaches it.

## 7. Verifying

Green means all four, in order.

**1 — The process is up.**

```bash
curl https://api.relayed.imharsh.in/health
```

Expect `{"ok":true,"service":"relayed-server"}`. Confirmed 2026-09-20.

**2 — Migrations ran.** The deploy log should carry a `migrations applied` line
on first boot, listing the files. Absent on later deploys, which is correct.

**3 — A real client can use it.** Not a curl. Point a dev client at production
and sign in properly:

```bash
RELAYED_SERVER_URL=https://api.relayed.imharsh.in pnpm dev
```

Sign in, send a message, reload, confirm it is still there.

**4 — The socket survives.** Leave that client idle for over a minute and send
another message. This is the one Railway behaviour worth confirming by hand: a
proxy that closes idle WebSockets would make clients look flaky in a way that is
genuinely hard to diagnose later.

**Testing the upgrade with curl: force HTTP/1.1.** Railway serves HTTP/2, which
has no `Upgrade` mechanism, so a plain `curl` websocket probe returns **404 and
looks like a broken route**:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://api.relayed.imharsh.in/sync
```

`101` is correct. The client is unaffected either way — `ws` speaks HTTP/1.1.

Then take a manual backup from the Postgres service's **Backups** tab, and
confirm PITR is on.

## 8. Not deployed, on purpose

The server boots fine without all of these, and each is a third-party account
and a cost:

| Off | Turned on by |
|---|---|
| Agent runs | `AGENT_*` (and running `apps/agent`) |
| Memory | `HINDSIGHT_*`, `MEMORY_INGEST`, `MEMORY_RECALL` |
| Connectors | `COMPOSIO_API_KEY`, `CONNECT_COOKIE_SECRET` |
| Telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` |

Telemetry is the one to fix soonest. Without it a packaged build reports nothing
anywhere, and "it broke" arrives from a user with no trace attached. Grafana
Cloud's free tier accepts OTLP and the dashboards in `infra/grafana/` already
exist.

## 9. Moving out

Recorded now because it is cheap now and expensive to discover later.

The exit cost is a dump, a restore and a DNS record:

```bash
pg_dump -Fc "$OLD_DATABASE_URL" > relayed.dump
pg_restore -d "$NEW_DATABASE_URL" relayed.dump
```

It is this clean because of properties the schema already has, all of which are
worth **not** breaking:

- **No extensions.** Extension availability at the destination is the usual
  blocker.
- **No sequences.** `ord` and `rev` are allocated by `UPDATE … SET x = x + 1` on
  counter rows ([`allocate.ts`](../apps/server/src/sync/allocate.ts)), not by
  `SERIAL`. A restored sequence left behind its data is the classic way a
  dump/restore silently corrupts an ordered log, and we cannot hit it.
- **No object storage.** MinIO is in `compose.yaml` but no server code touches
  it; avatars are fetched client-side from WorkOS URLs.
- **Postgres is the only durable state.** The socket registry is memory, and
  says so.

Downtime during a move is unusually forgiving: clients stay fully readable
offline (R3), then reconnect and catch up.

**The one thing that would make a move expensive** is letting the API address
change. Keep it on `imharsh.in` and no client ever learns where the server
lives.

---

## 9a. Taking the server down, and why you probably should not

Flows 2 and 3 of the sync milestone want the server gone. **Use the client's own
offline switch, in the top bar of a development build** — "the aeroplane without
the aeroplane" (`dev.setOffline`). It drops the live socket rather than refusing
the next one, and lifting it re-activates the session and reconnects, so it
exercises the same paths. It is also per-client, which killing a shared server
cannot be: taking exactly one of two clients offline is the more interesting
test.

Two ways of stopping the Railway service were tried and both misfired.

**`railway service scale <region>=0` does not stop it.** It removes the region,
and the platform reschedules the service somewhere else — here into `us-west2`.
Re-adding the intended region then leaves **two replicas in two regions**, which
is the split §2 forbids, reached by a command that reads like a pause. Always
read the returned `regions` map; to remove a region pass `<other>=0` explicitly
in the same call.

**`railway down` races a redeploy.** It removes the most recent deployment — but
any configuration change already in flight is building a new one, which then
takes over. The observed result was `/health` returning 404 for a few seconds
and then 200 again, which reads exactly like a flaky server rather than a
deployment that was replaced under us.

If the service genuinely has to stop, make sure no deploy is in flight first
(`railway deployment list`), then `railway down`, then confirm 404 for longer
than a build takes.

## 10. Known follow-ups

**`railway.json` is deprecated**, and the CLI warns on every command: Config as
Code stops working **2026-12-01**. `railway config migrate` produces
`.railway/railway.ts` but **drops `dockerfilePath` and `builder` into
comments** rather than translating them, so applying it as-is would leave the
service with no Dockerfile selection. Since `RAILWAY_DOCKERFILE_PATH` is now set
as a service variable, the build does not actually depend on `railway.json` any
more — but the healthcheck and replica count still do. Migrate by hand before
December.

**Telemetry is dark.** `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so the server
reports nothing anywhere. Grafana Cloud's free tier accepts OTLP and the
dashboards in `infra/grafana/` already exist. Worth wiring before the first
outside user, not after.

---

## 11. What the first two-client run found

Step 14's flows were run against this deployment on 2026-09-20. Flow 1 passed on
the first attempt — `audience=2, delivered=2, dropped=0`, about 20ms end to end
— and flow 2 passed through the offline switch.

Getting a second person into the workspace took three fixes, and all three sat
on the same path: **somebody invited AFTER they had already signed up**. That is
not an edge case for an alpha, where people download the app and sign in before
anyone thinks to invite them.

| What broke | Why it was invisible |
|---|---|
| `pendingJoins` dropped from the `authenticated` state | The field existed only on `needs_workspace`, so every reader gated on it — correctly, given the type |
| `/auth/join` accepted only a WorkOS token | That token is held between sign-in and onboarding and dropped after, so the endpoint was reachable only by callers who did not need it |
| The socket stayed on the previous workspace after a join | `adoptSession` ended with `link.start()`, and `connection.start()` is idempotent — on a live socket it did nothing |

The third is the one to remember: the symptom was an empty People list, and the
hazard underneath was the old workspace's events being delivered **into the new
replica**, which `workspace.switch` guards against and no other path did.

**Also worth knowing before inviting anyone:** self-signup is ungated, and
invitation email delivery is unproven — nothing arrived at a `juspay.in` address,
and a corporate mail gateway is the likely reason. Until a sending domain is
configured in WorkOS, an invitation's accept link has to be fetched from the
WorkOS API by hand.
