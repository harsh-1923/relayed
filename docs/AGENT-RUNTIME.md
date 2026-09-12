# Agent runtime

The service that runs agentic loops. One endpoint, one job: take a request,
run the loop to completion, return the answer — as a single response or as a
stream, the caller's choice.

This is the Phase 6 agent service from [`DESIGN.md`](DESIGN.md) §6.5, built
first in its smallest honest form. It does **not** yet touch Relayed's data, run
on anyone's behalf, or speak the sync protocol. It runs a prompt and answers.

**Status:** built and running. `apps/agent`, one process, both modes verified
end to end against a stub provider (§11).

**Last updated:** 2026-09-12

---

## 1. Scope

**In:** a single HTTP entry point with two response modes, the pi agent loop,
pi's default tools, a configurable set of model providers, a result.

**Out, for now:** the chat plane, the message stream, MCP, delegation,
subagents, persistence, resume. Each is deferred with a named trigger in §9
rather than left vague.

The point of building this half first is that the interesting part of an agent
service is **the loop and its bounds**, not the wiring to a chat product. Wire
the loop to nothing, get it right, then attach it.

### Why a separate service at all

`DESIGN.md` §6.5 already requires agents to be server-side consumers rather than
sync-engine participants, and [`STACK.md`](STACK.md) §6 left open whether that
means a module in `apps/server` or its own deployable. **It is its own
deployable**, and §5 is the reason: this process runs model-authored shell
commands. Nothing that holds the session signing key or the database pool should
share an address space with that.

A second reason, from the field: the agent runtime is the part that gets
restarted. Long runs, provider stalls, memory pressure from large tool output —
all of it wants a process you can kill without dropping websockets.

---

## 2. Decisions

| Layer | Choice | Why |
|---|---|---|
| Location | **`apps/agent`**, package `@relayed/agent` | A workspace member, added because it is needed now (AGENTS.md rule 4) |
| Runtime | **Node 24 + TypeScript, executed directly** | Same as `apps/server` — no build step in dev, `--env-file-if-exists` |
| HTTP | **Fastify** | Already the server's choice; one HTTP library in the repo, not two |
| Agent loop | **`@earendil-works/pi-coding-agent`** `0.85.1`, pinned exact (`createAgentSession`) | The loop, the default tools and the session abstraction arrive together |
| Tools | **pi defaults only** — `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | The requirement. No custom tools, no MCP |
| Session store | **`SessionManager.inMemory()`** | A run is the unit of work; nothing outlives it (§6) |
| Working directory | **A fresh temp dir per run, removed after** | The tools need a cwd, and it must not be a shared one |
| Models | **A provider table in config**, registered via `ModelRegistry.registerProvider` | §4 — the adapter is chosen by wire format, not by vendor |
| Transport | **Two modes on one endpoint**, chosen by `Accept` | §3 — default JSON, or SSE when the caller wants to watch |
| Auth | **`x-agent-key`, fail closed at boot** | §5 — an unauthenticated endpoint here is remote code execution |
| Concurrency | **Bounded, in-process** | §6 |
| Telemetry | **Structured request logs only, for now** | §8 — deferred deliberately, with a trigger |

### On the pi package

**The `@mariozechner/*` packages are deprecated.** `pi-mono`
(github.com/badlogic/pi-mono) stopped at 0.73.1, and every one of its packages
now carries a deprecation notice pointing at `@earendil-works/*`
(github.com/earendil-works/pi), which is at 0.85.1 and maintained. Use the
latter. This was caught by installing the former and reading the warning, which
is the only way it announces itself.

The split that matters:

- **`@earendil-works/pi-agent-core`** — the loop, the harness, session repos,
  compaction. **No file or shell tools.**
- **`@earendil-works/pi-coding-agent`** — `createAgentSession`, plus the default
  tools (`core/tools/`: read, write, edit, bash, grep, find, ls).

Since "the default tools" *are* the requirement, `pi-coding-agent` is the
package. The cost is that its index also re-exports the CLI entry point, so a
headless server pulls the TUI dependency tree (`pi-tui`, chalk, a wasm image
resizer) it never executes. Accepted: it is install weight, not runtime weight,
and the alternative is re-implementing seven tools to avoid a transitive
dependency.

**Pin the exact version, and read the types you are about to call.** These
packages move fast and the SDK surface changes shape across minors: 0.85
replaced `AuthStorage` + `ModelRegistry` with a single async `ModelRuntime`, and
added `powershell` to the default tool palette. Code written against 0.75 does
not compile against 0.85. A caret range buys nothing here and breaks on a
Tuesday.

Two consequences are already in the code. `ModelRuntime.create({ modelsPath:
null, allowModelNetwork: false, refreshOnCreate: false })` keeps the process
hermetic — pi otherwise reads `~/.pi/agent/models.json` and may refresh
catalogues over the network, which is how a container comes to behave
differently from a laptop for reasons nobody can see. And the tool palette is
passed explicitly rather than defaulted, so a future pi release cannot quietly
add an eighth tool to a service whose whole security posture is §5.

---

## 3. The entry point

```
POST /run            run an agent loop — JSON result, or SSE stream
POST /run/:id/cancel abort a run in flight
GET  /health         liveness
GET  /healthz/ready  readiness — 503 while draining
```

### Request

```jsonc
{
  "prompt": "…",          // required
  "systemPrompt": "…",    // optional — replaces the default
  "model": "…",           // optional — a key from the provider table (§4)
  "thinkingLevel": "medium"
}
```

**That is the whole body, and keeping it that way is a decision.** The field
count on a run endpoint is the clearest available measure of whether the runtime
still has a boundary: the reference implementation this design was drawn from
reached roughly sixty fields, destructured into a ninety-parameter positional
function, because every feature that could not find a home elsewhere became one
more optional field. Every addition here should have to argue for itself.

**Caps are server policy, not request fields.** A caller may not ask for a
longer timeout or more turns. If the caller could, the cap would not be one.

**The wire format gets a Zod schema in `@relayed/protocol` when it gains its
third field.** `FRONTEND.md` §8.3 already names the first wire format as Zod's
adoption trigger; this is that wire format. The schema covers the SSE frames
too — a stream whose frames are untyped is a wire format that nobody validates.

Every request carries `x-agent-key`, compared in constant time. `/health` and
`/healthz/ready` are the only unauthenticated routes.

### The two modes, and how one is chosen

**`Accept: text/event-stream` selects streaming. Anything else gets JSON.** The
transport is negotiated by the HTTP header that exists for negotiating
transports, not by a field in the body.

That is a deliberate choice over a `"stream": true` flag. The body describes
*the run*; the header describes *how the answer travels*. Keeping them separate
means the response's `Content-Type` and the request's `Accept` agree by
construction, and a caller that sets the field but not the header cannot end up
parsing an event stream as JSON.

**Log the chosen transport on every request, unconditionally.** "The caller
thinks it asked for a stream and the runtime answered in JSON" is a real failure
mode, and it is diagnosable from one line per request or from nothing at all.

### Default mode — one JSON response

```jsonc
{
  "runId": "…",
  "status": "completed",   // completed | failed | cancelled | timeout
  "text": "…",             // the final assistant message
  "toolCalls": [{ "name": "bash", "ok": true, "ms": 412 }],
  "usage": { "input": 0, "output": 0, "cacheRead": 0 },
  "durationMs": 8123
}
```

**A non-2xx is reserved for "the request was wrong" or "the service is
unavailable".** A run that started and failed is a **200 with
`status: "failed"`** — it consumed tokens, it may have run tools, and it has a
`runId` worth correlating. Collapsing that into a 500 throws away the only
record that the work happened.

**`status: "completed"` with an empty `text` is a real outcome and must be
reported as itself**, not converted into a failure. It usually means the model
produced nothing after its last tool call, and a runtime that papers over it
hides a provider problem behind a fabricated error message.

### Stream mode — SSE

```
event: started    data: {"runId":"…","seq":0}
event: delta      data: {"seq":1,"text":"Check"}
event: reasoning  data: {"seq":2,"text":"…"}
event: tool       data: {"seq":3,"phase":"start","name":"bash","id":"…"}
event: tool       data: {"seq":4,"phase":"end","name":"bash","id":"…","ok":true,"ms":412}
event: done       data: {"seq":5,"result":{ …the default-mode body, verbatim… }}
```

Five rules make this safe rather than merely convenient:

1. **`done` carries exactly the default mode's response body.** One result
   shape, two envelopes. If the streaming result is assembled differently from
   the JSON result, the two will drift, and the drift will be discovered by a
   consumer rather than by a test.
2. **Every frame carries a monotonic `seq`.** A consumer can then detect a gap
   instead of silently rendering a hole.
3. **A terminal frame is always written before close** — `done` for every
   outcome including failure and cancellation. A stream that just ends is
   indistinguishable from a dropped connection, and the consumer will wait.
4. **Keepalive comment frames every ~25 seconds.** They are ignored by any
   spec-compliant parser and they are what stops a proxy from idling out a run
   that is thinking (§7).
5. **Deltas are coalesced on a short interval, not forwarded per token.** Raw
   token frames are the highest-volume thing this service will ever emit, and
   almost none of that volume is information.

**`reasoning` frames are gated.** Thinking text is model-internal and should not
reach an end user by default; treat it as debug output with its own flag, not as
part of the answer.

### What streams, and what that costs

**The model call is already streamed today, in both modes.** pi's transport is
streaming-only — a provider adapter returns an event stream, and the loop emits
`message_update` with `text_delta` / `thinking_delta` as tokens arrive, plus
`tool_execution_start` / `tool_execution_end` around each tool.

So streaming is not a feature to build in the loop. It is a feature to *not
discard* at the edge: default mode subscribes to the same events and accumulates
them, stream mode forwards them. **That is why adding both modes now is cheap
and adding the second one later is not** — the accumulate-only version tends to
grow a result shape that the streaming version then has to reproduce.

**A dropped connection aborts the run, in both modes.** Nobody is waiting and
there is nowhere to put the answer. Reattach-after-disconnect is deliberately
not built (§9).

---

## 4. Models and providers

**The requirement is LiteLLM, Vercel AI Gateway, Anthropic, or anything else.
pi covers this, and the shape of the answer is that the adapter is chosen by
wire format, not by vendor.**

`pi-ai` ships nine API adapters: `anthropic-messages`, `openai-completions`,
`openai-responses`, `azure-openai-responses`, `openai-codex-responses`,
`mistral-conversations`, `google-generative-ai`, `google-vertex`,
`bedrock-converse-stream`. The `Api` type is `KnownApi | (string & {})` and
`registerApiProvider` is exported, so the set is open — a house protocol can be
added without forking.

A provider is registered by describing it, not by writing code for it:

```ts
modelRegistry.registerProvider(name, {
  baseUrl, apiKey, api, authHeader: true,
  models: [{ id, name, reasoning, input, cost, contextWindow, maxTokens }],
})
```

Which means the whole of §4 is **a table in config**, and the runtime contains no
vendor branching at all:

| Target | `api` | `baseUrl` |
|---|---|---|
| **LiteLLM** (any model it fronts) | `openai-completions` | your proxy |
| **Vercel AI Gateway** | `openai-completions` | `https://ai-gateway.vercel.sh/v1` — Bearer auth, verified 2026-09-12 |
| **Anthropic**, direct | `anthropic-messages` | provider default |
| **OpenAI**, reasoning models | `openai-responses` | provider default |
| **OpenAI**, everything else | `openai-completions` | provider default |
| Azure / Google / Vertex / Bedrock / Mistral | their own adapters | — |

`/run`'s optional `model` field names an entry in that table. Nothing else in
the service knows what a vendor is.

### LiteLLM is the fallback

**Settled: `AGENT_MODEL_FALLBACK` names a LiteLLM entry, and that is what a
request with no `model` gets.**

The reasoning is that LiteLLM already does the thing §9 defers — key management,
model routing, cross-provider fallback — outside our process. **A gateway as the
default is what keeps "no provider fallback chain" an honest deferral rather
than a missing feature.** A chain built in this runtime would be
re-implementing, worse, something the gateway is already paid for.

Other entries sit beside it and are reached by naming them: `"model":
"anthropic/claude-opus-5"`. A direct Anthropic entry is the obvious second one —
the gateway is otherwise a single point of failure for every run, and a native
adapter avoids a translation layer for the model family least tolerant of one
(trap 2, below).

### Four traps, all of them silent

Everything above is configuration, which means every mistake is a config
mistake that still starts successfully.

1. **`reasoning: false` on a reasoning-capable model silently discards the
   thinking level.** The run works; it just ignores what was asked for. Worse in
   the other direction — a long provider-side default stays on when the request
   said "off".
2. **Claude through an OpenAI-compatible shim breaks on thinking blocks.** The
   translation is lossy and the failure surfaces as a fabricated "invalid
   signature in thinking block" from the gateway, which points nowhere near the
   cause. Route Claude over `anthropic-messages` — natively, or a gateway's
   Anthropic-format path.
3. **`contextWindow` and `maxTokens` are metadata you supply, not values the
   provider reports.** Too high and requests fail at the provider after you have
   paid to build them; too low and pi compacts a conversation that never needed
   it. Both look like model misbehaviour.
4. **Gateways disagree about how to spell "off".** OpenAI-compatible proxies
   commonly want `none` where pi says `off`; pi has `thinkingLevelMap` for
   exactly this. Getting it wrong means the off switch does nothing.

**Each of these deserves a startup assertion, not a comment.** The provider
table is small and the checks are cheap: refuse to boot on an entry whose
`contextWindow` is unset, or whose `api` is `openai-completions` while its model
id looks like a Claude model.

---

## 5. The bash problem

**Read this before deciding where to deploy the service.**

The default tool set includes `bash` and `write`. The loop therefore executes
model-authored shell commands as the service user, in the service's container,
with the service's filesystem access, the service's network position, and any
credential reachable from its environment.

This is not a flaw in pi; it is what a coding agent is. It sets three
non-negotiables for v0:

1. **The only caller is our own server**, over a shared secret, on an internal
   network. The service is never exposed publicly.
2. **The service holds no credential it would mind losing.** No database URL, no
   session signing key, no WorkOS API key, no blob-store credential. Its
   environment is the provider table's API keys and nothing else — which is
   itself an argument for a gateway key over a direct vendor key, since a
   gateway key is scoped and revocable in one place.
3. **The prompt is authored by us, not by an end user.**

**Point 3 is the trigger, and it is the one that will be crossed first.** The
moment an end user's text reaches `prompt` — which is the entire purpose of this
service in Phase 6 — untrusted input is authoring shell commands. At that point
`bash` must move into a sandbox with its own filesystem and no network path back
to us, or be removed from the palette.

The honest version of this doc says: **v0 is safe because of who is allowed to
call it, not because of anything the runtime does.** Do not let that fact become
implicit. When the caller changes, the containment must change in the same
commit.

An intermediate step exists if it is needed sooner: pi exposes
`createReadOnlyTools` alongside `createCodingTools`, so dropping `bash`, `write`
and `edit` is a one-line change to the palette, not a redesign.

---

## 6. The process model

One process. N concurrent runs. Each run owns:

- an `AgentSession` over an in-memory session store,
- a temp directory as its cwd, removed in a `finally`,
- an `AbortController`,
- an entry in an in-process `activeRuns` map, keyed by `runId`.

**That map is the highest-value twenty lines in the service.** It is what makes
`/cancel` possible, what lets `/healthz/ready` report honestly, what lets SIGTERM
enumerate what it is about to kill, and what answers "is this still running?"
without inference. It is in-process, which is correct for one replica and wrong
for two — see §9.

### Bounds

Every run is bounded on four axes, all server-configured:

| Bound | Why it exists |
|---|---|
| **Wall clock** per run | A provider that stalls without erroring holds a connection and a token budget forever |
| **Turn cap** | A loop that cannot make progress will happily spend the whole timeout discovering that |
| **Concurrency cap** | Runs are memory-hungry; unbounded admission turns a burst into an OOM that kills the runs already in flight |
| **Tool output cap** | pi truncates by default (`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`); do not raise it without a number to justify the new one |

Over the cap, `/run` returns **429**, not a queue. A queue here would be a second
scheduler competing with whatever the caller already has, and the caller is in a
better position to decide whether a rejected run should wait or die.

### Shutdown

On SIGTERM: stop accepting (`/healthz/ready` → 503), log one line per in-flight
run, then wait out the runs up to a drain deadline and abort the remainder.
Stream-mode runs get a terminal `done` frame with `status: "cancelled"` before
the socket closes — the rule in §3 holds during shutdown too, which is precisely
when a consumer is most likely to be left waiting.

**Log the in-flight set at drain start, not at drain end.** If the process is
killed harder than SIGTERM — an OOM, a node scale-down, a force delete — that
line is the only surviving record of which runs died. Written at the end, it is
written exactly when it cannot be.

---

## 7. Connection lifetime — what each mode actually fixes

A run holds an HTTP connection for its whole duration in **both** modes. Two
different problems hide behind that sentence, and it is worth separating them
because they have different solutions and only one of them is solved here.

**Problem one: an idle connection gets killed by something in the middle.** A
proxy, a load balancer, or the caller's own client timeout sees no bytes for
minutes while the model thinks or a tool runs, and closes it.

**Stream mode solves this**, and it is the better half of the reason to build it.
Bytes flow continuously, and the ~25s keepalive frames mean even a silent stretch
proves liveness. A run can then comfortably outlive any default idle timeout
without anyone tuning a proxy.

**Problem two: the result must survive the caller going away.** The caller
crashes, or is redeployed mid-run. No amount of keepalive helps — there is
nothing at the other end.

**Neither mode solves this, and that is deliberate.** Today the answer is that
the run is aborted, because nothing has been promised and nowhere exists to put
an orphaned result. The fix, when it is needed, is a third mode rather than a
change to these two: **accept with `202` and a `runId`, run headless, deliver to
a callback** — with a durable result record so a redelivery after a restart
replays the answer instead of re-running the work.

That is listed in §9 with its trigger. Building it before the trigger means
building a delivery guarantee for a result nobody is waiting for.

---

## 8. Observability

**Not wired, deliberately, and this is the one deferral that argues against
AGENTS.md rule 8.** The rule says observability is part of the feature rather
than a follow-up, and it is right. What this service has today is Fastify's
structured request log plus one deliberate line per run — the accepted line
carrying `runId`, `mode`, `provider` and the requested model, which is what makes
"the caller asked for a stream and got JSON" diagnosable.

The argument for waiting is narrow and should be held to: **there are no runs to
measure yet.** Every threshold worth alerting on — the timeout, the concurrency
cap, the turn cap — is currently a guess (§12), and a dashboard of guesses is
worse than none because it looks authoritative.

**The trigger is the first real traffic.** At that point the catalogue additions
are already designed and should land together:

| Signal | Answers |
|---|---|
| `agent.run{run, mode}` | Completed / failed / cancelled / timeout, split by transport |
| `agent.run.duration` | What a run costs in wall clock — the number that sets the timeout and decides §7 |
| `agent.run.turns` | Whether the turn cap is a real ceiling or a formality |
| `agent.tool{tool, result}` | Which tools the model reaches for, and which fail |
| `agent.run.rejected{rejected}` | "At capacity" against "malformed request" — opposite fixes |
| `agent.tokens{direction}` | The cost signal |
| `agent.provider{provider, run}` | Whether a failure spike belongs to one provider or to the runtime |

Two constraints already established, so they are not rediscovered:
**`runId` and a model id are not labels** — both are unbounded cardinality
(OBSERVABILITY.md §5); they belong on a span and in the log. A provider's
*configured name* is unbounded too, so the label has to be a closed bucket set.
And **a run is the span, not the HTTP request** — the same run is served over
two transports, and every question worth asking is about the loop.

`packages/telemetry` already reserves `agents` in its `Service` union, so
nothing structural is in the way.

## 9. Deliberately not built

Every entry here exists in the reference implementation, and every one of them
was earned by an incident rather than designed in advance. They are listed with
the trigger that makes each one necessary, so they are adopted on purpose.

| Not built | Adopt when |
|---|---|
| **Out-of-band results (`202` + callback + durable result record)** | A result must survive the caller going away (§7). This is the one with the clearest path and the clearest trigger |
| **Stream reattach after disconnect** | Runs get expensive enough that losing one to a flaky connection hurts. Needs a replay buffer and a reconnect grace window on top of the `activeRuns` map |
| **Session persistence / resume** | A run needs to continue a previous one. Multi-turn agent conversations — i.e. the chat plane |
| **A distributed per-conversation lock** | Either two replicas, or resumable sessions. Both at once make it mandatory: two processes restoring and writing one transcript corrupts it |
| **Idempotent re-dispatch (result markers)** | A run has side effects that must not happen twice — posting a message, opening a PR, spending money. Until then a re-run is merely wasteful |
| **A recovery worker / watchdog** | Runs are dispatched by a queue rather than awaited by a caller. A synchronous caller *is* the watchdog |
| **MCP / any non-default tool** | The agent needs Relayed's own data or a third-party connector |
| **Subagents and agent-to-agent delegation** | Real task decomposition. Note `DESIGN.md` §6.4 forbids delegation *chaining* at the authorization layer — that constraint applies here too |
| **Provider fallback chains** | Only if a gateway is not already doing it (§4). Prefer buying this over building it |
| **Per-user credentials / delegation** | **The first moment the agent acts on behalf of a human.** See below |

### The one that is not merely deferred

**v0 runs with the service's own credentials and must therefore never touch
anything user-scoped.** `DESIGN.md` §6.4 is unambiguous: an agent authenticates
as itself and is *authorized* by a scoped, expiring grant, and effective
permission is the intersection of the agent's access, the principal's access, and
a valid delegation.

A runtime that has no concept of a principal cannot compute that intersection. So
this service does not get to guess: until the delegation token exists and is
verified on the way in, **no request may carry a user identity and no tool may
reach user data.** That is not a deferral of a feature, it is the reason the
feature is safe to defer — the runtime is incapable of the confused-deputy
failure because it has no second authority to confuse.

When delegation does arrive, the shape is already decided (§6.4: RFC 8693 `act`
claims, room + time + action scope, minted at execution time). The runtime's job
is to verify it, bind it to the run, and refuse to start without it.

---

## 10. Failure modes

Named now, because each has a wrong default that looks reasonable.

| Failure | Behaviour | The wrong default |
|---|---|---|
| Provider 429 / quota | Fail the run, `status: "failed"`, reason surfaced | Silent retry, which turns a capacity problem into a latency mystery |
| Provider stalls without erroring | Wall-clock timeout, `status: "timeout"` | Waiting forever, which is what "no timeout" means |
| Model returns no text | `status: "completed"`, empty `text`, and say so | Inventing an error, which hides the provider issue |
| A tool hangs | The run's abort signal must actually reach the tool | Aborting the loop while a child process keeps running |
| Caller disconnects | Abort the run — both modes | Continuing to spend tokens for a result with no destination |
| Stream consumer is slow | Coalesce and drop intermediate deltas; never buffer unboundedly | Backpressure that stalls the agent loop behind a slow reader |
| A run fails in stream mode | Terminal `done` frame with `status: "failed"`, then close | Closing the socket, which the consumer cannot distinguish from a network drop |
| SIGTERM mid-run | Drain, then abort; terminal frame to stream consumers; one log line per killed run | A silent kill, leaving no record of what was lost |
| Bad `prompt` | 400 before any model call | A 500 after spending tokens |
| Misconfigured provider entry | Refuse to boot (§4) | Starting fine and misbehaving per-run in a way that reads as model failure |

---

## 11. Local development

```bash
pnpm agent          # this service alone
pnpm dev            # the whole environment; starts the agent when configured
pnpm dev --no-agent # ...and this opts out
```

**`pnpm dev` starts the agent only once it is configured**, and prints one line
naming the missing variables when it is not. The service itself refuses to boot
without them, which is right for the service and wrong as a reason for the whole
dev environment to crash-loop before anyone has keys.

Config lives in the root `.env` like every other app; `.env.example` carries the
annotated block.

| Var | Meaning |
|---|---|
| `AGENT_PORT` | Default `8788` — `apps/server` owns `8787` |
| `AGENT_S2S_KEY` | The `x-agent-key` secret. **The process refuses to boot without it** |
| `AGENT_PROVIDERS` | Comma-separated entry names, e.g. `litellm,anthropic` |
| `AGENT_MODEL_FALLBACK` | `<provider>/<model-id>` — what a request with no `model` gets (§4) |
| `AGENT_PROVIDER_<NAME>_API` | The pi adapter. Defaulted for known names; required otherwise |
| `AGENT_PROVIDER_<NAME>_BASE_URL`, `_API_KEY`, `_MODELS` | The endpoint, its key, and the model ids it serves |
| `AGENT_PROVIDER_<NAME>_CONTEXT_WINDOW`, `_MAX_TOKENS`, `_REASONING`, `_THINKING_OFF` | The per-model metadata pi cannot discover (§4) |
| `AGENT_MAX_CONCURRENT_RUNS`, `AGENT_RUN_TIMEOUT_MS`, `AGENT_MAX_TURNS` | The bounds from §6 |
| `AGENT_STREAM_COALESCE_MS`, `AGENT_STREAM_REASONING`, `AGENT_DRAIN_TIMEOUT_MS` | Stream and shutdown behaviour |

**Fail closed at boot, not per request.** A missing key must stop the process,
not disable authentication — a config typo should be a crash loop somebody
notices, never a silently public code-execution endpoint. There is no insecure
escape hatch, including for local development.

### What has actually been verified

Against a local stub speaking OpenAI chat-completions — not against a real
provider, which needs keys:

- **Both modes, same terminal payload.** JSON and SSE return an identical
  result object for the same run. That equivalence is the whole contract in §3
  and is the first thing that will quietly stop being true.
- **The tool palette executes.** A stub that answers with a `bash` tool call
  runs the command in the run's temp workspace, feeds the result back, and
  completes on the second turn — two turns, one recorded tool call.
- **Every boot guard fires**: missing key, missing provider table, missing
  context window, and a Claude model id configured for `openai-completions`
  with reasoning on (§4, trap 2).
- **Admission control**: five concurrent runs against a cap of four — four
  accepted, the fifth refused with 429 immediately.
- **Cancel**: the run ends `cancelled` with no `error` field, and the stream
  receives its terminal frame before close.
- **Drain**: `SIGTERM` flips readiness to 503, logs the in-flight run, lets it
  finish, and exits. The stream still receives its `done` frame.
- **Cleanup**: no `relayed-agent-*` workspace survives a run.

A real provider is the one thing left, and it needs a key and a base URL.

## 12. Open questions

1. **Where the temp workspace lives.** A tmpfs bounds the blast radius of a
   runaway `write` but makes the run's memory footprint include its files; a disk
   path is the reverse. Needs a measured run, not an opinion.
2. **Whether `bash` survives the first end-user prompt.** §5's trigger. The
   answer is a sandbox or a smaller palette, and it should be decided before the
   trigger is crossed rather than during.
3. **Timeout and concurrency defaults.** Every number in §6 is currently a guess.
   They should be set from `agent.run.duration` once real runs exist — a default
   picked from intuition and then never revisited is how a cap stops meaning
   anything.
4. **The delta coalescing interval.** Shipped at 80 ms
   (`AGENT_STREAM_COALESCE_MS`), which is a guess and is labelled as one. Too
   long and the stream stops feeling live; too short and it is a token firehose
   with extra steps. Confirm it against a real model, not a stub — a stub emits
   four chunks and tells you nothing.
5. **Whether `reasoning` frames ship at all.** They are gated by default. If
   nothing ends up consuming them, the honest move is to remove the frame type
   rather than keep an unused debug channel in the wire format.
6. ~~**Gateway or direct, as the default.**~~ **Settled: LiteLLM is the
   fallback** (§4). Still open is the narrower half — whether a direct Anthropic
   entry is configured beside it from day one as a hedge against the gateway
   being a single point of failure, or only added when the gateway first fails.
7. **Compaction policy.** pi compacts automatically at a context threshold. For
   single-shot runs this should rarely fire; if it fires often, the prompts are
   too big or the tool output caps are too loose, and the metric is the tell.
8. **When observability lands.** §8 defers it to first real traffic, which is a
   deferral this project's own working rules argue against. The honest version
   is that it should land with the first run against a real provider, not
   whenever it next comes up.
