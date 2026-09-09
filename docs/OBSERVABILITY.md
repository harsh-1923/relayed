# Observability

What we collect, how it leaves the machine, and the constraints that shape both.

Architecture is [`DESIGN.md`](DESIGN.md); technology choices are
[`STACK.md`](STACK.md); how builds reach users is [`RELEASE.md`](RELEASE.md).

**Last updated:** 2026-09-08 · OTLP sink wired; events land in local Grafana

---

## 1. Decisions

| | Choice |
|---|---|
| **Backend** | Grafana Cloud free tier — Tempo (traces), Mimir (metrics), Loki (logs) |
| **Traces / metrics** | OpenTelemetry SDK |
| **Logs** | **pino**, with `trace_id` / `span_id` injected — *not* the OTel logs SDK (§6) |
| **Client transport** | Client → **our server** → collector → Grafana. No ingest credential in the binary. |
| **SDK owner** | The `utilityProcess`. One SDK, one exporter, one buffer. |
| **Sampling** | 100% until traces approach the free-tier ceiling |
| **Scope now** | `packages/telemetry` — catalogue, wrappers, lint rules, **and a working OTLP sink** (§10a). Signals wired per subsystem as written. |

### On vendor lock-in

OTLP everywhere means the collector can be re-pointed at any OTLP backend
without touching a line of instrumentation. That is real portability, and it is
why we accept a hosted backend at this stage.

**It does not extend to dashboards and alert rules.** Those are Grafana-shaped,
and the LogQL/PromQL queries inside them come with them. Keep dashboards as JSON
in the repo so they are at least versioned and exportable, and treat "no lock-in"
as true of the pipeline and only partly true of what is built on top.

---

## 2. What is different about observing this system

Three properties make standard OTel guidance not quite fit.

**The client is not our infrastructure.** It is a desktop app on someone's
laptop, offline much of the time. Telemetry must be buffered locally and drained
opportunistically — structurally the same problem as the outbox (§10). It needs
the *opposite* failure behaviour, though, which is why they must not share a
queue (§7).

**There are no HTTP requests to trace.** One WebSocket carries thousands of
frames over hours. Auto-instrumentation gives us almost nothing, and a
span-per-connection would be an eight-hour span — which most backends handle
badly. The unit of tracing here is a **logical operation**, not a connection
(§4).

**The failures that matter are stateful, not transactional.** "This client's
cursor stalled at rev 400 three days ago" is not a trace; it is a state
observation. Traces are the wrong instrument. This is what pushes weight onto
metrics, and onto §9 in particular.

---

## 3. Signal architecture

```
  renderer ──MessagePort──┐
                          ▼
              utilityProcess  (owns the SDK, the buffer, the exporter)
                          │
                          │  authenticated POST, batched
                          ▼
   server ──────────▶  telemetry ingest  ──┐
                       (validate + scrub)  │
   agents ─────────────────────────────────┼──▶ Collector / Alloy ──▶ Grafana Cloud
                                           │              └── swap target here
                                           ┘
```

**One SDK, in the `utilityProcess`** — the same process that owns the socket and
the database (§5). The renderer forwards events over the existing `MessagePort`
rather than running a second SDK. One exporter, one buffer, one flush policy.

**The client does not talk to Grafana directly.** A distributable binary cannot
hold an ingest credential — it is trivially extractable — and direct export
gives us no opportunity to scrub before data leaves the user's machine. Routing
through our own server reuses the session that already exists, and makes
redaction and rate limiting central.

---

## 4. Traces

**A span is a logical operation, never a connection.**

| Traced | Span |
|---|---|
| Sending a message | compose → outbox → `op` → `ack` |
| Reconnect | `hello` → `welcome` → catch-up complete |
| Opening a chat with a gap | open → backfill pages → rendered |
| Agent invocation | delegation minted → provider call → reply committed |

Connection lifecycle — connects, drops, zombie detection — is **events and
metrics**, not spans.

### `traceparent` belongs in the frame envelope

OTel propagates context through HTTP headers automatically. A WebSocket provides
nothing, so to link a client-side "user pressed send" span to the server span
that assigned the `ord`, the frame must carry it explicitly:

```json
{ "t": "op", "op_id": "01J…", "traceparent": "00-<trace-id>-<span-id>-01", … }
```

This is a §9 protocol addition. Cheap now; a version-skew problem once old
clients are in the field (§9.10), which given opt-in updates is soon.

---

## 5. Metrics — and the constraint that will actually bite

| Metrics | Logs | Traces | Profiles | Retention | Users |
|---|---|---|---|---|---|
| **10,000 active series** | 50 GB | 50 GB | 50 GB | **14 days** | 3 |

Logs and traces are generous. **The 10k series cap is the binding constraint**,
and it is a cardinality problem, not a volume problem.

A series is one unique combination of metric name and *every* label value. So:

> **No unbounded identifier may ever be a metric label.**
> `actor_id`, `chat_id`, `message_id`, `device_id`, `space_id` — all forbidden.
> 100 actors × 150 chats is 15,000 series for a **single metric**.

Identifiers belong in traces and logs, which are indexed differently.

A workable budget: ~30 metrics × `service` (3) × `env` (2) × a low-cardinality
dimension such as `op_type` (~8) × `result` (2) ≈ **2,900 series**. Comfortable.

### The `client_version` trap

Tempting, and specifically dangerous for us. Updates are opt-in (§`RELEASE.md`),
so many versions run concurrently. Ten live versions multiplies **every** metric
carrying that label by ten, and 2,900 becomes 29,000 — over the cap.

**Put version on a single `client_info` gauge.** Get per-version attribution from
traces and logs instead.

### Enforce cardinality in the type system

More reliable than remembering the rule:

```ts
type OpType = 'send' | 'edit' | 'react' | 'delete' | 'read'
type Result = 'ok' | 'error'

counter('sync.op', { op: OpType, result: Result })
// actor_id cannot be passed — closed sets only. Cardinality explosion
// becomes a compile error rather than a surprise on the bill.
```

### 14-day retention is a design constraint, not a setting

Anything to be reasoned about over months must exist as a **metric**, because
logs and traces are gone. "How many users hit a gap this quarter" is therefore a
decision made when writing the catalogue — not a query that can be written later.

---

## 6. Logs

**pino, not the OTel logs SDK.** Traces and metrics are stable in OTel JS; logs
are not. Read the version lines:

```
@opentelemetry/api          1.x    stable
@opentelemetry/sdk-metrics  2.x    stable
@opentelemetry/sdk-logs     0.x    ← experimental
@opentelemetry/exporter-*   0.x    ← experimental
```

We would be betting our highest-volume signal on an API still shipping breaking
changes. pino is mature, fast and structured; a mixin injects the active
`trace_id`/`span_id` into every record, and Loki ingests OTLP natively — so
portability is preserved at the collector boundary.

### Structured only — this is the privacy control

**Message bodies must never enter telemetry.** For a chat product this is the
most sensitive data we hold, and the mistake is a single careless line.

```ts
log.info('message.sent', { chat_id, byte_len })   // ✅ no field can hold a body
log.info(`sending: ${body}`)                       // ❌ the product, in Loki
```

Banning `console.*` and template-literal log messages is therefore not style
enforcement — it removes the place where user content could go. Enforce it with
a lint rule, not a convention.

The same applies to span attributes and metric labels.

---

## 7. The client buffer is not the outbox

Both queue while offline and drain on reconnect, so the temptation is to reuse
one mechanism. **They need opposite failure behaviour:**

| | Outbox (§10) | Telemetry buffer |
|---|---|---|
| On overflow | **Never drops.** A queued message is user data. | **Drops oldest.** Bounded ring buffer. |
| Ordering | Strict, per chat | Best effort |
| Priority | User data first | Always lower |
| Durability | Survives restart | May not |

Sharing a queue means a backed-up outbox delays telemetry, or — far worse —
telemetry volume delays somebody's message. Separate them from the start.

---

## 8. The event catalogue

The mechanism that keeps this from being bolted on. A single typed catalogue in
`packages/telemetry`, enumerating every event with its payload type.

```ts
export const events = {
  'sync.gap.entered':   { fields: { chat_id: 'id', head_rev: 'int', cursor_rev: 'int' }, doc: '…' },
  'sync.event.unknown': { fields: { op: 'enum', rev: 'int' },                            doc: '…' },
  'outbox.op.failed':   { fields: { kind: 'enum', attempts: 'int', code: 'enum' },       doc: '…' },
  'blob.prefetched':    { fields: { kind: 'enum', count: 'int' },                        doc: '…' },
} as const satisfies Record<string, EventSpec>
```

**Note the absent type.** `FieldType` is `'id' | 'int' | 'ms' | 'bool' | 'enum'`
— there is no `'string'`. A free string is exactly the unbounded value §5 says
will exhaust the active-series budget, so the catalogue refuses to express one:
anything with a closed set of values is an `enum`, and anything without one has
no business being a label. `blob.prefetched` above wanted `kind: 'string'` and
had to become an enum, which is the constraint working rather than getting in
the way.

Four properties follow:

1. **Ad-hoc events are impossible.** Adding one is a deliberate edit to a shared
   file, so every addition appears in review.
2. **Nothing else imports `@opentelemetry/*` or `pino`.** One wrapper package,
   enforceable by lint rule.
3. **It doubles as documentation** of what the system reports.
4. **The server validates against the same catalogue.** Because the client posts
   through our own ingest endpoint (§3), the catalogue is enforced at runtime as
   well as compile time — a modified client cannot flood us with arbitrary
   fields.

### 8a. The metric catalogue, as built

Two catalogues, because metrics and events answer different questions under
different constraints. `packages/telemetry/src/metrics.ts` mirrors `events.ts`:
every metric declares its `kind`, its `unit`, and **exactly which closed-set
labels it accepts**.

```ts
count('identity.provisioned', { via: 'invite' })   // ✅
count('identity.provisioned', { actor_id })        // ✗ compile error
count('made.up.metric')                            // ✗ compile error
```

Verified as a compile error, with a negative control confirming the check
itself fires — a type test that silently passes is worse than none.

`metrics.test.ts` guards what types cannot: every declared label has a known
cardinality, the whole catalogue costs **~500 of the 10,000 series** with
ambient `service` × `env` applied, no label is an entity or ends in `_id`, and
`client_version` is rejected by name (§5's specific trap).

One rule fell out of writing it: **a metric's doc must say what the number
means**, because nobody reading a dashboard in six months has the file open.
Events are held to a shape rather than a length — several Phase 2 entries are
one honest line, and padding them to clear a threshold would make the catalogue
worse.

### 8a2. Signals added with authorization and invitations

| | |
|---|---|
| `workos.poll{result}` | Event-log polls. A sustained error rate means the mirror is going stale — accepted invitations stop appearing and deactivations stop taking effect — with nothing user-visible to say so |
| `workos.poll.lag` | Age of the newest applied event. The real answer to "how soon does an accepted invitation appear", and the number that would justify webhooks if it ever got bad (AUTHZ.md §10.1) |
| `identity.provisioned{via}` | `self_signup` against `invite` — two very different growth stories, and unrecoverable once the row exists |
| `identity.deactivated{via}` | Actors tombstoned and sessions revoked |
| `auth.signin{outcome}` | Now includes `cancelled`, so deliberately abandoning a sign-in does not pollute the failure rate |
| `handle.collision` | Still `reserved`, now with a call site in the join path |

### 8b. Where the ids live

Metrics cannot carry them, so events do:

```
account.opened      account, device, workspaces, epoch
workspace.switched  account, from, to, local_ms, epoch
auth.signed_in      account, device, actor, workspace, outcome, duration
auth.activated      account, workspace, path, ok
identity.provisioned  actor, org, workspace, via   (server)
blob.served         blob, result
```

This is the layer that answers "why did **this** user's switch hang", and it is
gone in 14 days — which is the whole reason the aggregate has to be decided in
`metrics.ts` up front rather than queried later.

---

## 9. Instrument the invariants

Three are wired, and all three were **silent** before — each one only became
visible when a user noticed a symptom:

| Invariant | Metric | Healthy |
|---|---|---|
| R3 — no network before first paint | `boot.network_calls_before_paint` | **exactly 0** |
| 41 — the workspace epoch | `ipc.stale_dropped` | small spikes at switches only |
| 45 — the blob handler is scoped | `blob.serve{serve=rejected}` | **0** |

`blob.serve{serve=miss}` is worth watching alongside: a miss is a grey circle
somebody actually saw, and it is invisible from the prefetch side because the
prefetch believes it succeeded.

Note that a counter at zero emits nothing, so for these three **absence is
health** and the alert is `> 0` rather than a threshold.

The R3 counter is deliberately always on, not behind the verify flag. An
invariant checked only when someone remembers to check it is not instrumented;
`RELAYED_VERIFY_BOOT=1` now only adds the URL list, which is a debugging aid
rather than a signal.

§14 lists invariants, each paired with the failure it prevents. That pairing is
most of a metrics catalogue already: an invariant violation is by definition an
observable condition.

**The rule: adding an invariant means asking "what signal shows me this broke?"**
If there is no answer, either it is untestable in production, or there is a gap.

The mapping is **pending** — signals land with the subsystems that emit them.
The pattern:

| Invariant | Signal |
|---|---|
| 1 — cursor advances contiguously | `sync.cursor.lag` (`server_head_rev − synced_through_rev`); `sync.pending_revs.depth`, expected ≈ 0 |
| 5 — op idempotency | `sync.op.duplicate.rate` |
| 6 / 7 — outbox coalescing, in-order replay | `outbox.depth`, `outbox.oldest.age`, `outbox.failed.count` |
| 25 — join uses the gap path | `sync.gap.count`, `sync.backfill.pages` |
| 29 — heartbeat under 30s | `ws.heartbeat.missed`, `ws.reconnect.count` |
| 30 — zombie socket detection | `ws.zombie.detected` |
| **32 — unknown event advances cursor** | `sync.event.unknown` — tells us old clients are meeting new op types in the wild |
| §9.9 — the `welcome` ceiling | `sync.chats_per_actor` histogram — the number that predicts when `welcome` must page |

That last one is worth emphasising: it is the metric that gives advance warning
of a design limit rather than reporting it after users hit it.

---

## 10. Local development

Nothing is tested against Grafana Cloud. Dev noise would burn the free tier,
pollute production dashboards, require credentials on every machine, and not
work offline.

Instead the whole backend runs locally from Grafana's all-in-one image, behind
an opt-in compose profile:

```bash
pnpm services     # brings it up with Postgres, Redis and MinIO
pnpm otel:smoke   # send one trace + metric + log, read each back
pnpm grafana      # open :3000, anonymous admin, no login
pnpm services:down
```

It comes up with everything else so the stack is one command. It is the heavy
container (~1 GB idle); `pnpm services:lite` omits it when that matters.

### It is the same software as production

`grafana/otel-lgtm` bundles the components Grafana Cloud runs, so local
behaviour is representative rather than an approximation:

| Local | Cloud | Port |
|---|---|---|
| Grafana 13.2 | Grafana | 3000 |
| Prometheus 3.14 | Mimir (Prometheus-compatible) | 9090 |
| Tempo 3.0 | Tempo | 3200 |
| Loki 3.7 | Loki | *(via Grafana proxy)* |
| Pyroscope 2.3 | Pyroscope | 4040 |
| OTel Collector 0.159 | — | 4317 gRPC / 4318 HTTP |

Point an exporter at `localhost:4317` and it behaves as Cloud will. Switching
environments is one environment variable, because everything speaks OTLP (§1).

### `pnpm otel:smoke`

`scripts/otel-smoke.mjs` posts one span, one counter and one log record as raw
OTLP JSON — **no SDK** — then reads each back from Tempo, Prometheus and
Grafana's Loki proxy.

Because it bypasses our instrumentation entirely, it isolates the question:

> **If the smoke test passes, the backend is fine and the problem is in the
> application. If it fails, stop debugging the app.**

Worth knowing when reading results:

- **Backends index asynchronously.** The script retries for ~30s. A trace that
  is not instantly queryable is normal, not a failure.
- **Prometheus rewrites metric names.** `sync.op` arrives as `sync_op` — dots
  become underscores. Query by the translated name.
- **Loki is not port-mapped** by the image; the script queries it through
  Grafana's datasource proxy. Same route a dashboard uses.
- The log record carries `traceId`/`spanId`, which is what makes logs and traces
  correlate in Explore — the property pino must reproduce in real code (§6).

---

## 10a. The sink, as built

`packages/telemetry` ships two sinks. `ConsoleSink` is the default and prints one
JSON line per event. `OtlpSink` posts OTLP/HTTP JSON to a collector, and is
installed **in addition** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set — teed, so a
dev terminal stays readable while Grafana gets the structured copy.

```bash
pnpm services                      # collector on :4318
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 in .env
pnpm dev
pnpm grafana                       # {service_name="relayed-desktop"}
```

Event attributes arrive as queryable labels, so
`{service_name="relayed-desktop", event_name="db.migrated"}` works.

**Hand-rolled OTLP JSON, not the OTel SDK.** `@opentelemetry/sdk-logs` is still
0.x (§6) and this is the signal we touch most. The wire format is identical, so
adopting the SDK later changes only `otlp.ts`.

**Dev-only as written.** It posts straight to a collector; production routes
client telemetry through our own server so it can be scrubbed and validated
against the catalogue first (§3).

### Three bugs found by actually looking in Grafana

The sink "worked" on the first attempt — **1 of 3 boot events arrived.** Each
cause is one that would have gone unnoticed until the events mattered.

**Sink installation must be synchronous.** The first version used a dynamic
`import()`, so every event emitted before it resolved went to the console only —
and the interesting ones (`db.migrated`, `app.boot`) all happen in the first
milliseconds. Any async setup silently drops exactly the startup events you most
want.

**Every process that emits needs its own sink.** `app.boot` is emitted from the
main process, which had none. Installing a sink in the `utilityProcess` covers
the sync engine and nothing else — §3's "one SDK" means one *per process*, not
one per app.

**Flush on exit.** Queued records were lost when the app closed, which is exactly
when the last events matter. Now hooked to `exit`, `SIGTERM` and `SIGINT`.

The general lesson: **an emit call that returns successfully proves nothing.**
The only check that counts is querying the backend, which is what `pnpm
otel:smoke` exists for.

### Overflow behaviour is implemented

`OtlpSink` holds a bounded queue (500) and **drops the oldest** on overflow, per
§7. A collector that is down is swallowed rather than surfaced — telemetry must
never fail an app operation.

---

## 10b. Where to look, locally

```bash
pnpm services      # Postgres, Redis, MinIO and the LGTM stack
pnpm dev           # the app and the server, both exporting to :4318
```

Then **http://localhost:3000** — anonymous admin, no login — and the dashboard
**Relayed → identity & storage**, provisioned with the stack from
`infra/grafana/dashboards/`. A dashboard that has to be imported by hand is a
dashboard nobody opens, so it ships in `compose.yaml` as a read-only mount.

Five rows, in the order they are usually needed:

| Row | Reads |
|---|---|
| **Invariants** | R3 violations, rejected blob ids, stale IPC replies — all should be **0** |
| **Product** | actors created by route, workspaces per identity (p50/p95), sign-in outcomes |
| **What the user waits on** | workspace switch split local vs authorized, boot to first paint, migration by tier |
| **Session and blob health** | refresh vs switch ratio, degraded sessions, avatar hit/miss |
| **Down to one user** | the raw event stream, with account, device, actor and workspace ids |

A counter at zero emits nothing, so **an empty invariant panel is the healthy
state** — the alert is `> 0`, not a threshold.

### Everything is in Loki, including the metrics

The sink posts to `/v1/logs` only. A metric is a log record carrying
`metric_name`, `metric_kind` and `metric_value`, so the dashboard is LogQL
rather than PromQL:

```logql
# a counter, split by a closed-set label
sum by (path) (count_over_time({service_name="relayed-desktop"} | metric_name="auth.activate" [$__auto]))

# a histogram
quantile_over_time(0.95, {service_name="relayed-desktop"} | metric_name="workspace.switch"
                   | phase="local" | unwrap metric_value [$__auto])
```

The attributes arrive as Loki **structured metadata**, not stream labels — only
`service_name` is a label — so the ids on events do not multiply streams. That
was worth checking rather than assuming, because putting an unbounded id in a
Loki label is the same mistake §5 forbids for metrics, in a different store.

**This is a dev-grade arrangement and it has two consequences.** Metrics
inherit the 14-day log retention rather than being kept for months, which is
precisely the distinction §5 draws — so "how many users did we create this
quarter" is not yet answerable, even though the metric exists. And `span()`
records a duration line rather than a real trace, so **Tempo is empty**: there
is no waterfall to open when a switch is slow, only a number.

Both are the same fix — emit OTLP metrics to `/v1/metrics` and spans to
`/v1/traces` — and both are §3's ingest work, which Phase 2 needs anyway.

---

## 11. Open decisions

1. **Alerting thresholds.** Which of the above page someone, and at what level.
   Needs production baselines first.
2. **Client sampling under growth.** 100% is right at this stage. The trigger for
   head or tail sampling is traces approaching 50 GB.
3. **Retention beyond 14 days.** If any question needs a longer window, it either
   becomes a metric or needs a paid tier. Revisit when a real question appears.
4. **Profiling.** The free tier includes 50 GB of Pyroscope profiles. Unused for
   now; potentially useful for the renderer's message-list performance.
5. **Agent observability.** Agents run server-side (§6.5) and get normal server
   instrumentation, but delegated actions may deserve their own span shape —
   settle alongside the agent runtime.
6. **Attributes become Loki labels.** The collector promotes event attributes to
   stream labels, which is convenient in Explore but is a cardinality risk in
   Loki for the same reason it is in Prometheus (§5). Fine at current volume;
   needs a collector-side allowlist before any id-bearing attribute ships.
7. **pino is not wired yet.** §6 chose it for logs; today `OtlpSink` carries both
   events and log-shaped records. Introduce pino when there is a server, so the
   `trace_id` injection has spans to attach to.
