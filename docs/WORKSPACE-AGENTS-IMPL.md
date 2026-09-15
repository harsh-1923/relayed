# Workspace agents — implementation

> **Status: plan, partly built.** Reconnecting (step 6) is not built. Agents
> finding their own tools (step 7) is built and tested; its by-hand milestone
> has not been run. This is how
> [`WORKSPACE-AGENTS.md`](WORKSPACE-AGENTS.md) (the proposal) gets built: in what
> order, in which files, proven by which tests and by what someone does by hand.
>
> **The proposal is the design; this is the build.** Every part below links to
> the proposal section it implements. Where this plan has to decide something
> the proposal left open, or finds that the proposal does not match the code,
> §2 lists it. Each item there is folded back into the proposal **in the commit
> that builds it**, so the two never disagree for longer than one change
> (`AGENTS.md`, keep the docs true, rule 3).

**Last updated:** 2026-09-15

---

## 0. How to read this

- **Steps are in build order**, and each ends in something a person can use by
  hand. A step that only ever passed `node --test` has not been used
  (`AGENTS.md`, verify by execution, rule 2).
- **Every step has the same parts:** what it implements, what must exist first,
  schema, server, protocol, runtime, client, tests, by hand, observability, docs,
  done when.
- **Proposal references are links** to the section by name, like
  [the dispatcher (§5.3)](WORKSPACE-AGENTS.md#53-the-dispatcher). **Code
  references are repository paths** in backticks. They describe the code as of
  commit `0f8a003`.
- **"New"** means a file this plan creates. **"Changes"** means an existing file.

---

## 1. The map: every part of the proposal, and where it is built

| Proposal part | Built in |
|---|---|
| [Words used here (§0)](WORKSPACE-AGENTS.md#0-words-used-here) | The names used in code: `agent_runs`, `access_request`, `withheld`, the six checkpoint functions |
| [What this doc decides (§1)](WORKSPACE-AGENTS.md#1-what-this-doc-decides) | Every row is built in the step for its section |
| [The whole flow, in one picture (§2)](WORKSPACE-AGENTS.md#2-the-whole-flow-in-one-picture) | Complete only after [step 5](#9-step-5--the-broker) |
| [Background (§3)](WORKSPACE-AGENTS.md#3-background-what-already-exists) and [what a production agent platform taught](WORKSPACE-AGENTS.md#what-a-production-agent-platform-taught) | Constraints on every step. The lessons land in [step 3](#7-step-3--runs-with-no-tools) |
| [Creating an agent (§4.1–§4.5)](WORKSPACE-AGENTS.md#4-creating-an-agent) | [Step 2](#6-step-2--creating-agents). The editor's tool picker waits for [step 4](#8-step-4--connections-and-the-connector-store), and [step 7](#11-step-7--agents-find-their-own-tools) removes it |
| [What starts a run (§5.1)](WORKSPACE-AGENTS.md#51-what-starts-a-run) | [Step 3](#7-step-3--runs-with-no-tools), mentions in channels. Invoking by DM waits for DMs to exist (§3.2) |
| [The handoff is part of the write (§5.2)](WORKSPACE-AGENTS.md#52-the-handoff-is-part-of-the-write) | [Step 3](#7-step-3--runs-with-no-tools) |
| [The dispatcher (§5.3)](WORKSPACE-AGENTS.md#53-the-dispatcher) | [Step 3](#7-step-3--runs-with-no-tools) |
| [What the runtime is sent (§5.4)](WORKSPACE-AGENTS.md#54-what-the-runtime-is-sent) | [Step 3](#7-step-3--runs-with-no-tools) for every field. [Step 5](#9-step-5--the-broker) fills `tools`; [step 7](#11-step-7--agents-find-their-own-tools) replaces them with `find_tools` and `call_tool` |
| [A tool call (§5.5)](WORKSPACE-AGENTS.md#55-a-tool-call) | [Step 5](#9-step-5--the-broker); [step 7](#11-step-7--agents-find-their-own-tools) changes step 5 of the call, the snapshot check |
| [What the agent reads (§5.6)](WORKSPACE-AGENTS.md#56-what-the-agent-reads) | [Step 3](#7-step-3--runs-with-no-tools) |
| [The reply (§5.7)](WORKSPACE-AGENTS.md#57-the-reply) | [Step 3](#7-step-3--runs-with-no-tools) |
| [Stopping a run (§5.8)](WORKSPACE-AGENTS.md#58-stopping-a-run) | [Step 3](#7-step-3--runs-with-no-tools). The broker's refusal after Stop lands in [step 5](#9-step-5--the-broker) |
| [Checkpoints (§5.9)](WORKSPACE-AGENTS.md#59-checkpoints-where-later-features-plug-in) | [Step 3](#7-step-3--runs-with-no-tools) creates all six with v1 bodies. [Step 5](#9-step-5--the-broker) fills `beforeToolCall` and `afterToolCall` |
| [Why Composio (§6.1)](WORKSPACE-AGENTS.md#61-why-composio) | [Step 4](#8-step-4--connections-and-the-connector-store): the `DESIGN.md` edit |
| [Project, keys and `user_id` (§6.2)](WORKSPACE-AGENTS.md#62-project-keys-and-user_id) | [The Composio setup (§4.3)](#43-composio-setup-per-environment), before step 4 |
| [Our record of connections (§6.3)](WORKSPACE-AGENTS.md#63-our-record-of-connections) | [Step 4](#8-step-4--connections-and-the-connector-store) |
| [Permissions (§6.4)](WORKSPACE-AGENTS.md#64-permissions-which-agents-may-use-a-connection) | Table and routes in [step 4](#8-step-4--connections-and-the-connector-store); enforced in [step 5](#9-step-5--the-broker); what Allow grants, [step 7](#11-step-7--agents-find-their-own-tools) |
| [Connecting (§6.5)](WORKSPACE-AGENTS.md#65-connecting) | [Step 4](#8-step-4--connections-and-the-connector-store) |
| [The catalogue (§6.6)](WORKSPACE-AGENTS.md#66-the-catalogue-and-what-counts-as-a-write) | [Step 4](#8-step-4--connections-and-the-connector-store) |
| [Executing through a session (§6.7)](WORKSPACE-AGENTS.md#67-executing-through-a-composio-session) | [Step 5](#9-step-5--the-broker); one session per person, [step 7](#11-step-7--agents-find-their-own-tools) |
| [Errors (§6.8)](WORKSPACE-AGENTS.md#68-errors-mapped-to-what-the-person-can-do) | [Step 5](#9-step-5--the-broker); `needs_reauth` finished in [step 6](#10-step-6--reconnecting) |
| [Keeping the mirror true (§6.9)](WORKSPACE-AGENTS.md#69-keeping-the-mirror-true) | [Step 4](#8-step-4--connections-and-the-connector-store) (webhook, reconciliation, sweep); [step 6](#10-step-6--reconnecting) (scope changes) |
| [Disconnecting (§6.10)](WORKSPACE-AGENTS.md#610-disconnecting) | [Step 4](#8-step-4--connections-and-the-connector-store) |
| [Whose OAuth app (§6.11)](WORKSPACE-AGENTS.md#611-auth-configs-whose-oauth-app) | [The Composio setup (§4.3)](#43-composio-setup-per-environment) |
| [The Composio facts (§6.12)](WORKSPACE-AGENTS.md#612-the-composio-facts-this-rests-on) | Re-checked by [the Composio spikes (§4.1)](#41-spikes) before step 4 |
| [The connector store (§7.1–§7.3)](WORKSPACE-AGENTS.md#7-the-connector-store) | [Step 4](#8-step-4--connections-and-the-connector-store) |
| [The card in a chat (§7.4)](WORKSPACE-AGENTS.md#74-the-card-in-a-chat) | [Step 5](#9-step-5--the-broker); its event, `message.updated`, in [step 1](#5-step-1--restricted-messages-with-no-agent); raised at search time and re-run automatically in [step 7](#11-step-7--agents-find-their-own-tools) |
| [Messages only some people can see (§8.1–§8.9)](WORKSPACE-AGENTS.md#8-messages-only-some-people-can-see) | [Step 1](#5-step-1--restricted-messages-with-no-agent), after [step 0](#44-step-0--the-gap-path-the-version-rule-complete-rows-repair-at-reconnect) fixes the gap path it runs on. **Dormant**: nothing in v1 writes one (D15) |
| [Security (§9)](WORKSPACE-AGENTS.md#9-security-in-one-table) | Each row's control is built in the step for its section. The tests are in [§13](#13-test-matrix) |
| [Failure modes (§10)](WORKSPACE-AGENTS.md#10-failure-modes) | Steps [3](#7-step-3--runs-with-no-tools), [4](#8-step-4--connections-and-the-connector-store), [5](#9-step-5--the-broker) |
| [Observability (§11)](WORKSPACE-AGENTS.md#11-observability-proposed) | Per step, once agreed ([§12.3](#123-telemetry-by-step)) |
| [Spikes (§12.1)](WORKSPACE-AGENTS.md#121-spikes-first--each-can-change-the-design-above) | [§4.1](#41-spikes) |
| [Steps (§12.2)](WORKSPACE-AGENTS.md#122-steps--each-usable-by-hand) | Steps 1–6 below, one for one. [Step 7](#11-step-7--agents-find-their-own-tools) is new: it changes how steps 2, 4 and 5 give an agent its tools |
| [Tests that must exist (§12.3)](WORKSPACE-AGENTS.md#123-tests-that-must-exist) | [§13](#13-test-matrix) |
| [Deliberately not built (§13)](WORKSPACE-AGENTS.md#13-deliberately-not-built) | Not in this plan. [§16](#16-not-in-this-plan) says which checkpoint each would change |
| [Docs to change (§14)](WORKSPACE-AGENTS.md#14-docs-to-change-when-this-is-accepted) | [§14](#14-docs-matrix) |
| [Invariants to add](WORKSPACE-AGENTS.md#invariants-to-add) | [§15](#15-invariants-by-step) |
| [Open questions (§15)](WORKSPACE-AGENTS.md#15-open-questions) | [§17](#17-open-questions-carried) |

---

## 2. What this plan decides, and what it corrects in the proposal

Each row is folded into the proposal in the commit that builds it.

| # | Decision or correction | Why | Proposal part to edit | Step |
|---|---|---|---|---|
| D1 | ✅ *Folded.* **A client op that carries an audience has the field dropped, not refused.** The op schema never declares one, a protocol test asserts an op carrying `visible_to` or `audience` parses with them dropped, and the boundary rule `sync/no-client-audience` keeps `writeMessage` out of `socket.ts` | The proposal said such a send "is refused". But incoming frames are parsed permissively and unknown fields are dropped — an unknown field is never an error (invariant 66, `DESIGN.md` §9.10). Refusing one would be the only `.strict()` parse in the protocol. *Built differently from first planned:* a line-based rule over `frames.ts` could not tell the op schema from the row schemas, which do carry `visible_to` | [Who may write one (§8.8)](WORKSPACE-AGENTS.md#88-who-may-write-one-and-what-it-may-contain) | 1 |
| D2 | ✅ *Folded.* **Invoking by DM waits for DMs to exist.** v1 invokes on mentions in channels | The server creates channels only. `spaces.ts` names `createDm` and `createRoom` as Phase 5 siblings | [What starts a run (§5.1)](WORKSPACE-AGENTS.md#51-what-starts-a-run) | 3 |
| D3 | ✅ *Folded.* **Creating, editing and deactivating agents are HTTPS commands, not outbox ops** | They need a live handle check, happen rarely, and nobody creates an agent offline. The same shape invitations use (`apps/server/src/auth/invitations.ts`) | [The product (§4.1)](WORKSPACE-AGENTS.md#41-the-product) | 2 |
| D4 | ✅ *Folded.* **The grant is an HS256 JWT signed with `AGENT_GRANT_SECRET`,** audience `relayed-agent-tools`, through `jose` | Only the server signs and verifies it, so a shared secret suffices. `jose` is already the session-token library (`apps/server/src/auth/tokens.ts`). A separate secret and audience keep a session token and a grant from standing in for each other, as the proposal requires | [A tool call (§5.5)](WORKSPACE-AGENTS.md#55-a-tool-call) | 3 |
| D5 | ✅ *Folded.* **The dispatcher starts only when the runtime is configured** (`AGENT_RUNTIME_URL`, `AGENT_S2S_KEY`, `AGENT_GRANT_SECRET`), and logs one line naming what is missing | The same behaviour `pnpm dev` already has for `apps/agent` (`AGENT-RUNTIME.md`, local development §11). A server without a runtime must still boot | [The dispatcher (§5.3)](WORKSPACE-AGENTS.md#53-the-dispatcher) | 3 |
| D6 | ✅ *Folded.* **The mention parser moves to `apps/server/src/sync/mentions.ts`**, used by both the counters and `invocationsFor` | The proposal requires "one parser, the one the counters use". Today it is a private helper (`mentionPattern`) inside `feed.ts` | [What starts a run (§5.1)](WORKSPACE-AGENTS.md#51-what-starts-a-run) | 3 |
| D7 | **The Composio webhook route parses its own raw body** | The server's JSON content parser (`apps/server/src/index.ts`) turns the body into an object, losing the exact bytes the HMAC signature covers. The route registers a scoped content parser that keeps the raw string | [Keeping the mirror true (§6.9)](WORKSPACE-AGENTS.md#69-keeping-the-mirror-true) | 4 |
| D8 | **Webhook delivery ids are deduplicated in a table** (`composio_webhook_deliveries`, swept after 24 h) | The proposal says "dedupes on `webhook-id`" without saying where. There is no Redis on the write path, and a table keeps the dedupe durable across a restart | [Keeping the mirror true (§6.9)](WORKSPACE-AGENTS.md#69-keeping-the-mirror-true) | 4 |
| D9 | **The sign-in loopback listener is generalised** to take a path and parameter names | `listenForCallback` (`apps/desktop/src/sync/auth/loopback.ts`) is built for `/auth/callback?code&state`. The connect flow returns `/connected?session_uri&state`. One listener with one set of tests beats a copy | [Connecting (§6.5)](WORKSPACE-AGENTS.md#65-connecting) | 4 |
| D10 | **Toolkits are enabled by a script, not a screen** (`apps/server/scripts/enable-toolkit.ts`) | The proposal makes enabling "our decision". Nothing in v1 needs an admin UI for it, and a script leaves a reviewable record | [The catalogue (§6.6)](WORKSPACE-AGENTS.md#66-the-catalogue-and-what-counts-as-a-write) | 4 |
| D11 | ✅ *Folded.* **Step 2's editor ships without its Tools section**, which arrives in step 4 | The picker lists the catalogue, which step 4 creates. An agent with no tools is valid, and it is exactly what step 3 runs | [The product (§4.1)](WORKSPACE-AGENTS.md#41-the-product) | 2, 4 |
| D12 | ✅ *Folded.* **Agent summaries get their own replica table** (`agent_summaries`), not columns on `actors` | Keeps the actor row identical for people and agents on the client, as it is on the server (`DESIGN.md`, the actor model §6.3) | [How clients learn about agents (§4.5)](WORKSPACE-AGENTS.md#45-how-clients-learn-about-agents) | 2 |
| D13 | ✅ *Folded.* **`agent_activity` reaches the renderer through the bridge's push channel**, as `agent:stream` already does (`apps/desktop/src/renderer/lib/agent-stream.ts`) | It is ephemeral. Writing it to the replica would make every client store and invalidate a value that is stale within a minute. *Built differently from first planned:* the `seq`/`ended` dropping rules live in the renderer's `useChatActivity` hook, not in `sync/link.ts` — `link.ts` forwards the frame verbatim, mirroring the split `invalidate` already keeps between deciding a topic changed and a query deciding what to do about it | [The reply (§5.7)](WORKSPACE-AGENTS.md#57-the-reply) | 3 |
| D14 | ✅ *Folded.* **Every existing `appendEvent` call gains an explicit `{ kind: 'stream' }`** — eight today: `ops.ts` (`message.created`, `message.deleted`), `directory.ts` (`recordActor`), and five in `spaces.ts` (`space.created`, `chat.created` and the founder's `space.member_added` when a channel is created; `space.member_added` and `space.member_removed` afterwards) | The proposal makes the audience a required argument. That is only a guard if every call is edited on purpose, not defaulted | [What happens to `ord` (§8.5)](WORKSPACE-AGENTS.md#85-what-happens-to-ord-and-why-an-empty-array-must-not-mean-everyone) | 1 |
| D15 | ✅ *Folded.* **Access cards are public; only their actor acts on them.** Each client draws the card for its own person from `actor_id`; the card's coarse `state` lives on the message; the server refuses anyone but the request's actor. Restricted messages stay built as a **dormant capability** | Hidden from the room, a card leaves everyone else seeing a mention answered by nothing — the room has to see that the agent is waiting, and on whom. Raised by the dev after step 1 was built | [The card in a chat (§7.4)](WORKSPACE-AGENTS.md#74-the-card-in-a-chat), [§8.1](WORKSPACE-AGENTS.md#81-why-this-exists-and-why-nothing-in-v1-uses-it), invariant 88 | 1, 5 |
| D16 | ✅ *Folded.* **`message.updated`, a new chat event: the server replacing a message's complete content**, not marked edited. `message.edited` stays reserved for a person's own edit | A card changing state must reach everyone, and nobody else holds the actor's connections to derive it from. A person's edit is a client op with LWW and an "edited" mark, which a card changing state is not | [§7.4](WORKSPACE-AGENTS.md#74-the-card-in-a-chat) | 1 |
| D17 | ✅ *Folded.* **The model is named as `provider/model` text until step 3**, validated for shape only; blank is the runtime's fallback | The proposal asks for a picker over the runtime's provider table, and the server does not know that table until the dispatcher is configured (D5). A wrong name fails the run loudly rather than the save | [The product (§4.1)](WORKSPACE-AGENTS.md#41-the-product) | 2, 3 |
| D18 | ✅ *Folded.* **Step 2 ships without avatar upload, Try it, and Add agent from a space's member list.** An agent gets a monogram; spaces are chosen when it is created | No file picker exists in the renderer yet; Try it opens a DM, which waits for DMs (D2); a space member list with Add does not exist yet for people either | [The product (§4.1)](WORKSPACE-AGENTS.md#41-the-product) | 2 |
| D19 | ✅ *Folded.* **Agent summaries ride the existing `actors.list` read**, joined from `agent_summaries`, rather than a read and topic of their own | A summary only ever changes with an actor event, so the `actors` topic already wakes it; autocomplete and the agents list need both in one list | [How clients learn about agents (§4.5)](WORKSPACE-AGENTS.md#45-how-clients-learn-about-agents) | 2 |
| D20 | ✅ *Folded.* **`agent_definition_ok` carries `you` — what the reader may do — decided by the server** | A creator's own admin row reaches their client only with the next `welcome`, so a client-side `can()` hid Edit from the person who had just created the agent. Hiding is all a client may do with it (invariant 49) | [§4.5](WORKSPACE-AGENTS.md#45-how-clients-learn-about-agents) | 2 |
| D21 | ✅ *Folded.* **Nobody picks an agent's tools. A run finds them**, through `find_tools` and `call_tool`, within the toolkits the workspace has enabled | An agent created with instructions and no tools could never raise a card, so it could never get access — observed with a real `@triage` asked about a GitHub commit. Choosing among 894 GitHub tools while creating an agent is the friction the product exists to remove. The proposal's "one row per tool, never a wildcard" guarded against an agent silently gaining destructive tools; per-agent permission with an effect ceiling (D23) is that guard now, and it runs on every call | [The product (§4.1)](WORKSPACE-AGENTS.md#41-the-product), [the definition (§4.3)](WORKSPACE-AGENTS.md#43-the-definition), [what the runtime is sent (§5.4)](WORKSPACE-AGENTS.md#54-what-the-runtime-is-sent), [a tool call (§5.5)](WORKSPACE-AGENTS.md#55-a-tool-call) | 7 |
| D22 | ✅ *Folded.* **`find_tools` takes the toolkit as an argument**, an enum of the enabled toolkits, and the prompt tells the model never to substitute one service for another | The discovery spike: Composio's search never says "nothing fits". Asked to post in Slack with only GitHub and Notion enabled, it returned GitHub discussion tools. Naming the toolkit first also makes "which card to raise" unambiguous when a request could touch two | [What the runtime is sent (§5.4)](WORKSPACE-AGENTS.md#54-what-the-runtime-is-sent) | 7 |
| D23 | ✅ *Folded.* **Allow grants up to `write`; a destructive call asks again** | The proposal granted "the highest effect among the agent's tools", and with no tools there is nothing to take the highest of. `write` keeps one click for ordinary work (a PR review writes); destructive stays a separate, explicit card through the existing effect check | [Permissions (§6.4)](WORKSPACE-AGENTS.md#64-permissions-which-agents-may-use-a-connection) | 7 |
| D24 | ✅ *Folded.* **One Composio session per person**, created with no tool list and the connect tool, workbench and multi-execute off, and **pinned to the person's active accounts by `PATCH`** | Tools are no longer per agent, so nothing makes a session per agent. The spike found pinning is not required to execute — correcting the comment in `composio.ts` and `014_broker.sql` — but pinning from `connections` keeps the account executed identical to the one `agent_tool_calls.connection_id` records | [Executing through a session (§6.7)](WORKSPACE-AGENTS.md#67-executing-through-a-composio-session), [the Composio facts (§6.12)](WORKSPACE-AGENTS.md#612-the-composio-facts-this-rests-on) | 7 |
| D25 | ✅ *Folded.* **A resolved card re-runs the request automatically**, once all of that run's cards are resolved; Run again is removed | The person may connect hours later; nothing waits, and nobody should have to ask twice. `UNIQUE (trigger_message_id, agent_actor_id, attempt)` already makes two cards resolving together queue one re-run | [The card in a chat (§7.4)](WORKSPACE-AGENTS.md#74-the-card-in-a-chat), [deliberately not built (§13)](WORKSPACE-AGENTS.md#13-deliberately-not-built) | 7 |
| D26 | ✅ *Folded.* **A card has its own message id**, never the run's reply id | Found planning step 7: sharing the id makes the answer that follows a card collide on `messages_pkey`, leaving the run stuck `running` and its expiry notice failing on every sweep | [The card in a chat (§7.4)](WORKSPACE-AGENTS.md#74-the-card-in-a-chat) | 7, fix first |
| D27 | ✅ *Folded.* **Composio's search response never reaches the model.** The server returns its own `{ tools: [{ name, description, parameters }] }` | The spike: a connected search carries the person's whole provider profile, the Composio account id, and instructions to call tools the session does not have (`COMPOSIO_MANAGE_CONNECTIONS`, the workbench) | [A tool call (§5.5)](WORKSPACE-AGENTS.md#55-a-tool-call) | 7 |

---

## 3. Before any step

### 3.1 Dependencies outside this plan

| Needs | For | Where it is designed | Blocks |
|---|---|---|---|
| ✅ **Message parts in the server schema, the replica and `@relayed/protocol`** — built | The agent's reply parts, the `access_request` card, and `parts` in the `message.updated` payload | `AGENT-RESPONSES.md`, implementation phases §9, phase 3 | Nothing now; steps 3 and 5 build on it |
| **`show_ui` registered in the service runtime** | Rich replies. Not required: a reply of Markdown alone is valid | `AGENT-RESPONSES.md`, phase 4 | Nothing |
| **DMs** (`createDm`) | Invoking by DM (D2) | `DESIGN.md`, build order §15, Phase 5 | Only the DM trigger |

### 3.2 Not blocking, but known

- **The runtime's JSON mode probably cancels every run at once.** It listens for
  the request's `close`, which fires when the body has been read
  (`apps/agent/src/routes.ts`). The dispatcher uses stream mode, which listens on
  the response and is unaffected. It is tracked as its own task.

### 3.3 Order

```
   spikes (§4.1) ──► step 0  the gap path (§4.4)
      │                        │
      ├── step 1  restricted messages (dormant) + message.updated ─┐ (needs step 0)
      │                                                            │ message.updated only
      │                                                            │
      ├── step 2  creating agents ──► step 3  runs with no tools ──┤
      │                                   ▲                        │
      │                   message parts ──┘                        │
      │                                                            ▼
      └── Composio setup ──► step 4  connections ─────────► step 5  the broker ──► step 6  reconnecting
                                                                    │
                                          discovery spike ─────────┴──► step 7  agents find their own tools
```

Step 0 first; then steps 1, 2 and 4 can proceed in parallel. Step 5 is the
milestone and needs steps 3 and 4, and from step 1 only `message.updated` —
cards are public, so the restricted-message path is not on it (D15). Step 7
needs step 5 and the discovery spike, and not step 6.

---

## 4. Spikes and setup

### 4.1 Spikes

The proposal's [spikes (§12.1)](WORKSPACE-AGENTS.md#121-spikes-first--each-can-change-the-design-above),
each a script under `spikes/` — not app code — with what it produces and what it
gates.

| Spike | Where | Produces | Gates | If it fails |
|---|---|---|---|---|
| **Withheld events in the sync model, and gap repair** — ✅ **done, passed** (§4.1.1) | `spikes/visibility-model.mjs`, `spikes/visibility-tests.mjs`, `spikes/visibility-mutants.mjs` | 99 checks: named scenarios for every rule in §8.3–§8.8 and in §4.4, and a property test over 400 random worlds comparing rendered state to ground truth. All 30 planted bugs are caught. `pnpm spike:sync` runs it; `pnpm spike:sync:mutants` runs the mutants | Steps 0 and 1 — **gate passed** | Would have re-opened the choice in [what happens to `rev` (§8.3)](WORKSPACE-AGENTS.md#83-what-happens-to-rev-if-bob-simply-is-not-sent-the-event) for the per-actor stream |
| **pi with no local tools** | `spikes/agent-tools/` | A pi 0.85.1 session with `tools: ['remote_echo']` and one `customTools` entry whose `execute` awaits `fetch` to a local server. It answers three questions: are the arguments validated when `parameters` is plain JSON Schema, or does it need `Type.Unsafe`; does `session.abort()` abort the in-flight `fetch`; does an empty palette start at all | Steps 3 and 5 | How remote tools are registered ([what the runtime is sent, §5.4](WORKSPACE-AGENTS.md#54-what-the-runtime-is-sent)) |
| **Composio connect, verification on** | `spikes/composio/connect.mjs` and a browser | Linear over OAuth and one API-key toolkit through `link()`. It answers: does the hosted page collect a key and a subdomain; does the `SameSite=Lax` cookie survive provider → Composio → verifier; does `complete_auth` with a different `user_id` fail the account; what does `revoke` return per toolkit | Step 4 | [Connecting (§6.5)](WORKSPACE-AGENTS.md#65-connecting) — another carrier for the attempt, or our own key form |
| **Composio sessions and errors** | `spikes/composio/sessions.mjs` | The raw session tool list, and the observed result of `session.execute` for: no connection, an `EXPIRED` account, a `403`, a provider rejection, a restricted tool. Written to `spikes/composio/results/` | Step 5 | Replaces the partly inferred [error table (§6.8)](WORKSPACE-AGENTS.md#68-errors-mapped-to-what-the-person-can-do) |
| **Tool definitions, measured** | `spikes/composio/tokens.mjs` | Input tokens for the full GitHub and Gmail schemas and for a curated ten | Step 5 | The 30-tool cap in [executing (§6.7)](WORKSPACE-AGENTS.md#67-executing-through-a-composio-session) |
| **Composio discovery** — ✅ **done, 2026-09-15** | [`spikes/composio-discovery/`](../spikes/composio-discovery/README.md) | One session per person with the switches off; search for six requests, connected and not, with latency over ten runs; executing by name with every error shape, pinning and re-pinning; the size of what the model would be sent. Findings in [step 7](#11-step-7--agents-find-their-own-tools), *what the spike settled* | Step 7 — **gate passed**. It changed the design twice: the toolkit is named by the model (D22), and the search response is rebuilt rather than passed through (D27) | Would have meant our own search over `toolkit_tools` instead of Composio's |

### 4.1.1 The visibility spike — what it did and what it found

**Why a new model rather than an extension of `sync-model.mjs`.** That model
derives catch-up from message rows — the pre-log design `SYNC-FLOWS.md` §12.1
calls unsound — so it cannot express what each recipient is *sent* per revision.
`visibility-model.mjs` models the engine as built: a `sync_events` log carrying an
audience, fanout that narrows it, catch-up that redacts per requester, a client
that stages whole envelopes above its frontier (`apps/desktop/src/sync/apply.ts`),
the gap and backfill paths of `catchup.ts`, and `complete: rows.length < limit`
(`socket.ts`).

**How it tests, and why each part is there:**

| Part | What it does | Why |
|---|---|---|
| Named scenarios | One small trace per rule: live delivery, out-of-order holes, paged catch-up, a gap and backfill with ordinal 1 hidden and a page containing a hidden row, badges and mentions, edits and deletes, a listed actor who leaves, write validation and idempotency, the `sync_events` CHECK in SQLite, a client that has never heard of `withheld` — and, for step 0, each rule of gap repair (§4.4) | Each rule in §8 and §4.4 pinned to a readable failure |
| The naive design, executed | Runs the drop-the-revision design and shows the unlisted chat stall for good | §8.3's argument, demonstrated rather than asserted |
| Property test | 400 seeded worlds × 80 steps: public and restricted sends, replies (a third of them restricted, as an access card is), reactions, edits, deletes, frames delivered **out of order**, duplicated, lost with the socket, reconnects, gaps, repairs interrupted by a quit and widened by a second gap, live traffic landing mid-repair, membership churn, an old client in a third of worlds, and small thresholds so every path is hot. After settling, it checks each client's frontier, staged events, gap flag, every revision accounted for, and **every held message's rendered state** — body, deleted, edited, reactions, reply count, every thread's replies — against **ground truth computed without the model's own SQL**; unread against ground truth; and that reading everything clears the badge | Finds what a scenario author did not think of |
| Send-time leak audit | Every frame the server sends is judged **when it is sent**, from membership and audience rows, never from the predicate under test | A leak judged later misreads frames legitimately sent before someone left |
| Coverage gate | The property test fails if any path was never reached. Last run: 2,116 gaps, 12,215 backfill pages, 5,492 repair pages (86 resumed after a quit, 75 widened by a second gap, 1,886 live frames landing mid-repair), 8,455 thread pages, 4,889 live and 1,521 catch-up withheld frames, 11,814 staged events, 180 chats with ordinal 1 hidden, 223 unknown events on old clients | An agreement over paths nobody took is not agreement (`AUTHZ.md` §12.1) |
| Mutants | 30 plausible ways to build §8 and §4.4 wrongly, each switched on at the line it would be made. **All 30 caught**, each by the check that names its mistake; 26 of them by the property test alone. The four it cannot see (write validation, the activity clock, the tail's tombstoned roots) are caught by scenarios. One planted bug — leaving deleted replies out of the thread page — **survived every check and was removed as a mutant**: it is not a bug, and the thread page is specified accordingly (§4.4) | A check that cannot detect the bug it names is not a check |
| Scenario isolation | A scenario that throws is a named failure, and the rest still run | A mutant that crashes one trace must not hide what the others find |

**Findings — behaviour of today's gap path, not of visibility.** The model is the
first thing to put gaps under random traffic. Each is reproduced by a named trace
in `visibility-tests.mjs` and run as a controlled comparison: the same seeds pass
with the corrected rule and fail with the gap path as built, **with and without
restricted messages** (62 of 100 worlds lose history either way), so none of them is
caused by this design.

| Finding | Production code | Consequence | Where it is fixed |
|---|---|---|---|
| **A later gap keeps an old floor.** After a gap the floor becomes `MIN(existing floor, tail)`, and `link.ts` never asks for backfill below a floor that is null or at 1 | `apps/desktop/src/sync/catchup.ts` (`applyGap`), `apps/desktop/src/sync/link.ts` (`backfill`) | A client that has ever scrolled to the top, or taken a gap it has not backfilled, never fetches what a later gap jumped over. `has_gap` never clears or clears over a hole | **Step 0** (§4.4) |
| **A gap whose tail reaches ordinal 1 never clears `has_gap`** | Same | The chat shows "more above" for ever | Step 0 |
| **A gap with nothing visible in its tail** — reachable once restricted messages exist: a reader who can see none of the recent history gets an empty tail and a null floor | Same | `has_gap` sticks | Step 0 |
| **A held message changed during a gap stays as it was.** A gap replaces the log with a partial snapshot, and a message the client already holds that the snapshot does not re-send is never corrected. Today that is deletes — the tail and backfill filter `deleted = false`, against what `SYNC-FLOWS.md` §14 promises; when edits, reactions and threads land it is edits, reactions and reply counts too | `apps/server/src/sync/feed.ts` (`snapshotOf`, `backfill`); nothing on the client asks | A deleted message — a pasted password, say — stays on every device that was far behind when it was deleted, for good | Step 0 |

The decision, taken with the dev: **fix the class, not the delete**, and fix it at
reconnect. Its design is §4.4, and the same model proves it.

### 4.2 Environment variables

| Variable | Process | Step | Notes |
|---|---|---|---|
| `RELAYED_DEV_ROUTES` | server | 1 | Enables the dev-only restricted-message route. **The server refuses to boot with it set in production** |
| `AGENT_RUNTIME_URL` | server | 3 | Internal address of `apps/agent` |
| `AGENT_S2S_KEY` | server, agent | 3 | Already the runtime's `x-agent-key`; the server now holds it too |
| `AGENT_GRANT_SECRET` | server | 3 | D4. Never in `apps/agent` |
| `AGENT_BROKER_URL` | agent | 3 | Where remote tools call back. Configuration, never a request field ([what the runtime is sent, §5.4](WORKSPACE-AGENTS.md#54-what-the-runtime-is-sent)) |
| `AGENT_MODEL_STALL_MS` | agent | 3 | Default 120000 |
| `COMPOSIO_API_KEY` | server | 4 | The scoped key. **Boundary rule: never read in `apps/agent`** |
| `COMPOSIO_WEBHOOK_SECRET` | server | 4 | |
| `RELAYED_PUBLIC_URL` | server | 4 | Base for `start_url` and the verifier URL |
| `CONNECT_COOKIE_SECRET` | server | 4 | Signs the `relayed_connect` cookie |

Each is added to `.env.example` with its annotation, in the step that first
reads it.

### 4.3 Composio setup, per environment

From [project, keys and `user_id` (§6.2)](WORKSPACE-AGENTS.md#62-project-keys-and-user_id)
and [whose OAuth app (§6.11)](WORKSPACE-AGENTS.md#611-auth-configs-whose-oauth-app).
A checklist, done once per environment, and recorded in `docs/STACK.md` beside
the other services:

- [ ] One project each for development, staging and production.
- [ ] A scoped project key with exactly the permissions in §6.2's table.
      **Proxy execute: no access.** Keys cannot be edited after creation, so a
      mistake means a new key.
- [ ] IP allowlist on the server's egress addresses (staging, production).
- [ ] Settings → General → Log storage → **Don't store data** (staging,
      production).
- [ ] Callback identity verification **on**, verifier URL
      `${RELAYED_PUBLIC_URL}/connections/verify`.
- [ ] Webhook subscription, version V3, event `composio.connected_account.expired`,
      to `${RELAYED_PUBLIC_URL}/composio/webhook`. Store the secret; it is shown
      once.
- [ ] Production only, before the first real connection: our own OAuth app at
      each enabled provider, and a custom auth config per toolkit.

---

### 4.4 Step 0 — The gap path: the version rule, complete rows, repair at reconnect

**Implements:** the fixes for §4.1.1's findings. Not part of the proposal — it is
a sync-engine change that step 1's by-hand check would otherwise run into, and
that edits, reactions and threads (Phase 4) would otherwise each rediscover.

**First:** nothing. **Gated by:** the model (`spikes/visibility-model.mjs`,
`visibility-tests.mjs`, `visibility-mutants.mjs`) — **done, passed**: every rule
below has a named scenario, the 400 random worlds converge to ground truth on
rendered state, and all 30 planted bugs are caught.

**Status: built** — server, protocol, client and their tests, per the tables
below; `SYNC-FLOWS.md` §13, §13a and §14 and `DESIGN.md` invariants 84–87
updated with it. **Not yet done by hand** with two dev clients (below).

#### The rule, in four parts

**A. A message's `rev` is its version.** Any event that changes how a message
renders bumps that message's `rev` to the event's revision, in the transaction
that appends the event. Which messages an event touches is **declared once, in
the event catalogue** (`apps/server/src/sync/events.ts`), and `appendEvent` does
the bumping; a type with no declaration does not compile. Today: `message.created`
touches the message and, for a reply, **its parent** (the parent's reply count
changed); `message.deleted` touches the message and its parent. Later:
`message.edited` and `message.reacted` touch the message. The `message.deleted`
payload gains `parent_id`, so a client holding the parent but not the reply can
still move the count.

**B. Every row a path returns is complete current state.** The gap tail,
backfill, the thread page and repair all return one shape: body as it stands,
`deleted`, `edited_at`, the reader's `reply_count`, reactions once they exist,
and `visible_to`. Two inclusion rules follow from what the model could and could
not detect:
- **The tail and backfill include tombstoned roots.** Not for the client's own
  held rows — repair corrects those — but because a deleted root still has a
  thread: a root created and deleted while the client was away, whose replies
  survive, is reachable only through its tombstone.
- **The thread page returns undeleted replies only.** A reply has no thread of
  its own, a held reply deleted meanwhile is corrected by repair, and no
  tombstone is owed for a row never held. A planted bug that dropped them
  survived every check.
- **`reply_count` is per reader**, counted with the visibility clause: a
  restricted reply (an access card) is not counted for someone who cannot see
  it.

**C. Repair, at reconnect.** When a client takes a gap it records what it owes:
*changes since the frontier the gap jumped from, to any message it held before
the tail landed* — `repair_since_rev` and `repair_max_ord` on `chat_state`,
**persisted**, so a quit mid-repair resumes. After catch-up it pages

```
repair { c, since_rev, max_ord, after: { rev, id } | null, limit }
  → repair_ok { rows, complete, after }
     SELECT <complete row> FROM messages m
      WHERE m.chat_id = $c AND m.rev > $since_rev AND m.ord <= $max_ord
        AND (m.rev, m.id) > ($after.rev, $after.id) AND <visibility clause>
      ORDER BY m.rev, m.id LIMIT $limit             -- keyset, on the (chat_id, rev) index
```

and applies each row **to rows it already holds only** — history it never held
is backfill's. Cost is proportional to what changed, never to history or to
events. A second gap while a repair is pending **widens** it (`since` the older,
`max_ord` the larger, paging restarted) rather than replacing it.

**D. The client's version guard, and why repair may only finish clean.** A fetched
row applies only if its `rev` is not older than the row held. A rejection is not
a row to forget: it means a live event touched that message *after the page was
computed*, and a live event is a delta applied over a local row that was still
stale — the local row is now wrong in a way nothing else will fix. The version
rule makes the remedy fall out of the paging: the live event bumped the server's
row past the page's cursor, so paging on by `(rev, id)` serves it again,
complete, at its new version. **Repair is complete only on a page that applied
with nothing rejected.** The model found this: without it, a reaction landing
mid-repair lost the reaction before it, permanently.

**E. The floor and the backfill request.** After a gap the floor is the tail's
oldest ordinal (or null for an empty tail), never `MIN` with an old floor — a
gap breaks the promise that everything above the floor is held. While `has_gap`
is set the client asks for backfill from the floor, **including a floor of 1**,
or from `head_ord + 1` when the floor is null; an empty page marked `complete`
clears the gap.

**F. Threads.** The parent-keyed page `DESIGN.md` §8.2 requires from day one:
`thread { c, root, after_ord, limit } → thread_ok { rows, complete }`. v1 opens
a thread by paging it from the start whenever the undeleted replies held
disagree with the parent's `reply_count`; replies share the chat's ordinal space
and can sit anywhere in it, so there is no floor to page from. A per-thread
floor is a later optimisation.

#### Schema

Nothing on the server: `messages.rev` and the `msg_rev (chat_id, rev)` index exist.
**Replica migration 9** (`workspace.ts`): `messages.reply_count`,
`messages.deleted` already exists; `chat_state.repair_since_rev`,
`repair_max_ord`, `repair_after_rev`, `repair_after_id`. Step 1's migration
becomes 10, step 2's 11, step 4's 12 (§12.2).

#### Server

| File | Change |
|---|---|
| **Changes** `sync/events.ts` | `touches(payload)` per catalogue entry; `appendEvent` bumps every touched row's `rev` in the transaction. `MessageDeleted` gains `parent_id` |
| **Changes** `sync/ops.ts` | `send` and `deleteMessage` stop setting `rev` by hand; the catalogue does it |
| **Changes** `sync/feed.ts` | `MessageRow` gains `deleted`, `edited_at`, `reply_count`; `snapshotOf` and `backfill` include tombstoned roots and compute the reader's count with a lateral subquery under the visibility clause (step 1 adds the clause; step 0 counts undeleted replies); `repair` and `thread` queries |
| **Changes** `sync/socket.ts` | `repair` and `thread` frames, both through `requireCan(read)` |

#### Protocol

**Changes** `packages/protocol/src/frames.ts`: `repair`/`repair_ok`,
`thread`/`thread_ok`; the row shape gains `deleted`, `edited_at`, `reply_count`;
`message.deleted` payload gains optional `parent_id`. All permissive.

#### Client

| File | Change |
|---|---|
| **Changes** `sync/migrations/workspace.ts` | Version 9, above |
| **Changes** `sync/effects.ts` | A reply's `message.created` bumps the held parent's `reply_count` and `rev`; `message.deleted` marks the row and, via `parent_id`, decrements a held parent once |
| **Changes** `sync/catchup.ts` | `applyGap`: the floor rule (E); records the repair owed, widening a pending one. `applyBackfill`, `applyGap`, new `applyThread`, new `applyRepair`: one `applyRow` with the version guard (D); `applyRepair` updates held rows only and clears the cursor only on a clean, complete page |
| **Changes** `sync/link.ts` | The backfill request rule (E); after catch-up on every connect, page any pending repair; `thread(chatId, rootId)` for the renderer |
| **Changes** `sync/index.ts` | A `thread` read for the (future) thread surface |

#### Tests

| Test | File |
|---|---|
| Every scenario of `visibility-tests.mjs`'s *version rule* section, against the real server and replica: Carol's week (edit, delete, replies, reaction during a gap, repaired at reconnect); a reply bumps its parent; a live delete of a reply never held; the version guard and re-serve; resume after a quit; widening on a second gap; per-reader reply counts; a deleted root keeps its replies; the deleted root created while away | `apps/server/src/sync/feed.test.ts`, `apps/server/src/sync/events.test.ts`, `apps/desktop/src/sync/catchup.test.ts`, `apps/desktop/src/sync/effects.test.ts` |
| The four floor findings: a second gap after scrolling to the top; a second gap before backfilling; a tail reaching ordinal 1; an empty tail | `catchup.test.ts`, a link test for the request rule |
| A catalogue entry without `touches` fails `pnpm typecheck` | The type itself |

#### By hand

Two dev clients (`MULTI-CLIENT-DEV.md`). On A: scroll a chat to the top. Take A
offline; on B delete one message A holds and send enough to force a gap; bring
A back. The deleted message is gone from A, every message is present, and "more
above" clears. Repeat without scrolling to the top first.

#### Docs, in the same commit

- `SYNC-FLOWS.md`: the gap (§13) and backfill (§14) rewritten for the floor
  rule and complete rows; a new *repair* flow beside them; the frame vocabulary
  (§8).
- `DESIGN.md`: threads (§8.2) — the thread endpoint exists; the two-counter
  model (§8.1) — `rev` on a message is its version; invariants (§14).

#### Invariants to add

| # | Invariant | What breaks without it |
|---|---|---|
| 84 | An event that changes how a message renders **bumps that message's `rev`**, declared in the catalogue, applied by `appendEvent` | Repair cannot find what changed; a reply's parent shows a stale count for ever |
| 85 | Every row a read path returns is **complete current state** | A client that held the row keeps yesterday's body, or a deleted message |
| 86 | After a gap, the floor is **the tail's**, and backfill is asked for while `has_gap` is set | What a later gap jumped over is never fetched, and `has_gap` sticks or clears over a hole |
| 87 | A client **applies a fetched row only if it is not older** than what it holds, and a repair is complete only on a page with **nothing rejected** | A live change landing mid-repair is undone, or the change before it is lost |

#### Done when

- The by-hand check above holds, both ways.
- `pnpm spike:sync`, `pnpm spike:sync:mutants`, `pnpm test`, `pnpm typecheck` green.

---

## 5. Step 1 — Restricted messages, with no agent

**Implements:** [messages only some people can see (§8)](WORKSPACE-AGENTS.md#8-messages-only-some-people-can-see),
all of it:
- [what happens to `rev` (§8.3)](WORKSPACE-AGENTS.md#83-what-happens-to-rev-if-bob-simply-is-not-sent-the-event)
- [the withheld event (§8.4)](WORKSPACE-AGENTS.md#84-the-withheld-event)
- [what happens to `ord` (§8.5)](WORKSPACE-AGENTS.md#85-what-happens-to-ord-and-why-an-empty-array-must-not-mean-everyone)
- [delivery (§8.6)](WORKSPACE-AGENTS.md#86-delivery)
- [every read path (§8.7)](WORKSPACE-AGENTS.md#87-every-read-path-and-the-bug-each-one-has-without-the-filter)
- [who may write one (§8.8)](WORKSPACE-AGENTS.md#88-who-may-write-one-and-what-it-may-contain)

It is the first of the [steps (§12.2)](WORKSPACE-AGENTS.md#122-steps--each-usable-by-hand).

**First:** the withheld-events spike (§4.1) — **done, passed** (§4.1.1); and **step 0** (§4.4), whose gap-path fixes this step's by-hand check runs into.

**Status: built, and dormant** — server, protocol, client, tests and docs, as
below. **Not yet done by hand** with three dev clients. After it was built the
cards it was for became public (D15), so **nothing in v1 writes a restricted
message**; it is kept as a tested capability for a later use. The step also
carries **`message.updated`** (D16), which the public card needs — below, after
the restricted-message tables.

**Changed while building: an array, not a tuple table.** The plan followed the
proposal's `messages.audience` discriminator plus a `message_audience` table.
Reviewed mid-build, its arguments did not hold (the proposal's §8.5 now says
why), and it cost a correlated subquery on every read path. Built instead:
`visible_to TEXT[]` on `messages` and on `sync_events`, NULL for the whole chat,
an empty list refused. The dev database had the tuple draft applied by the
running `pnpm dev` watcher; it held no restricted rows and was reverted by hand
before the array migration ran.

### Schema

**New** `apps/server/src/db/migrations/009_restricted_messages.sql`:

- `messages.visible_to TEXT[]` with `message_visible_to`:
  `visible_to IS NULL OR cardinality(visible_to) >= 1`.
- `sync_events.visible_to TEXT[]` with `sync_event_visible_to`, the same shape.
- No default and no discriminator: NULL is a meaning here, and the guard
  against a writer forgetting is `writeMessage` (below).

**Changes** `apps/server/src/db/schema.ts` — the two columns.

### Server

| File | Change | Implements |
|---|---|---|
| **New** `sync/visibility.ts` | The one place visibility is decided: `Audience` (`{ kind: 'stream' } \| { kind: 'listed'; actors }`), `toColumn` (sorted, no repeats, **throws on empty**), `fromColumn`, `visibleTo(alias, reader)` — the SQL clause — `receives(audience, reader)`, `redactEvent(row, reader)` and `withheld(rev)`. **Every read path imports these; none writes the clause itself** | §8.5, §8.7 |
| **Changes** `sync/events.ts` | `appendEvent(trx, allocated, type, payload, audience)`, required. Its type is derived from the event's stream, so only a chat event may be `listed`. Writes `visible_to`; `AppendedEvent` carries the audience. `MessageCreated` gains an optional `visible_to` | §8.5, last paragraph |
| **Changes** `sync/directory.ts`, `sync/spaces.ts` | The six calls pass `{ kind: 'stream' }` explicitly (D14) | §8.5 |
| **Changes** `sync/ops.ts` | **New** `writeMessage(trx, { chatId, messageId, authorId, body, parentId, audience })` — the only message insert. Checks every listed actor can `read` the chat (`AudienceError`), refuses a reply to a restricted parent (not found if hidden from the author, forbidden otherwise), and **does not bump `last_activity_at`** for a list. `send` calls it with `stream`. `deleteMessage` reads `visible_to`: a message hidden from the deleter is not found, checked before authorship, and its delete is addressed to its own list. Parts, `onBehalfOf` and `delegationId` join the input in step 3 | §8.7, §8.8 |
| **Changes** `sync/fanout.ts` | `deliver` sends the `ev` frame to readers on the list and `withheld` to every other reader, after `audienceFor` — so a listed actor who left the room gets nothing. `FanoutResult` gains `withheld` | §8.6 |
| **Changes** `sync/feed.ts` | `eventsSince`, `catchup`, `backfill`, `repair` and `threadReplies` take the reader. Redaction in `eventsSince`; `messageRows` — the one SELECT every row path starts from — adds the clause as a WHERE and narrows `reply_count` with it, and selects `visible_to`; the clause in `counters` and `welcomeChats`. **All in the query, before `LIMIT`** | §8.7, invariant 79 |
| **Changes** `sync/socket.ts` | Passes the connection's actor into catch-up, gap, backfill, repair and thread. `complete: rows.length < limit` stays, correct only because of the line above. `rowOnWire` adds `visible_to` | §8.7, backfill row |
| **New** `web/dev.ts`, registered in `index.ts` when `RELAYED_DEV_ROUTES=1` (`env.devRoutes`) | `POST /dev/restricted-message { chatId, authorId, listed[], body, parentId? }`. Checks the author can `post`, writes through `writeMessage` and delivers through the socket after the commit. 400 for a bad body, an empty list or a listed actor who cannot read; 403 for an author who cannot post | §8.8, second rule; §12.2 step 1 |

### Protocol

**Changes** `packages/protocol/src/frames.ts`:
- `WITHHELD_EVENT = 'withheld'`, documented beside `Ev`.
- `MessageRowFrame` gains optional `visible_to` (null or a list). A live
  `message.created` payload carries it only for a listed message, and only ever
  reaches the listed.
- Nothing is made strict. The op frame declares no audience, so one sent is
  dropped (D1).

### Client

| File | Change |
|---|---|
| **Changes** `apps/desktop/src/sync/migrations/workspace.ts` | Version 10 `restricted-messages`: `messages.visible_to TEXT` (a JSON array). `NULL` means the whole chat |
| **Changes** `apps/desktop/src/sync/effects.ts` | `withheld` is a known effect returning no topics, so it stops counting as unknown. `messageCreated` stores `visible_to` |
| **Changes** `apps/desktop/src/sync/catchup.ts` | `storeRow` stores `visible_to` on insert and update |
| **Changes** `apps/desktop/src/sync/storage.ts`, `preload/api.d.ts`, `sync/local/store.ts` | `ReplicaMessage.visibleTo`, read leniently (anything but a string array reads as null — the column decides nothing). Local rooms always null |
| **Changes** `apps/desktop/src/renderer/features/chat/ChatBubble.tsx` | "Only visible to you", or "Only visible to you and 2 others", in the footer — shown mid-stack too, not only on hover |

### Tests

| Test | File |
|---|---|
| Each branch of `message_visible_to` and `sync_event_visible_to`: NULL and a one-actor list insert, `'{}'` is refused; and `array_length('{}', 1)` is still NULL on this engine | **new** `apps/server/src/db/restricted-schema.test.ts` |
| A listed reader receives the event; an unlisted reader receives `withheld` at the same rev with `{}` and not even the id; a non-reader nothing; a listed actor who left the space receives nothing; its delete is withheld like its creation | `apps/server/src/sync/fanout.test.ts` |
| Catch-up across a restricted message: the listed replica gets the payload with `visible_to`, the unlisted one `withheld`, both `to_rev` at the head; the delete withheld too | `apps/server/src/sync/feed.test.ts` |
| Gap tail filtered per reader, with `visible_to` for the listed; **backfill filters before the limit** (a hidden row does not shorten a page); **ordinal 1 hidden**: the page is short only when history ran out; **badge** zero for the unlisted in `counters` and `welcome`, one for the listed; reply counts and the thread page per reader; repair filtered | `feed.test.ts` |
| **Ordinal 1 hidden, client side:** the floor stops at 2 and `complete` alone clears `has_gap`; a fetched row keeps its list | `apps/desktop/src/sync/catchup.test.ts` |
| A restricted message does not move `last_activity_at`, a chat message does; a listed actor who cannot read is refused and nothing is allocated; an empty list is refused; the list is sorted and deduplicated; replying to one is not-found / forbidden; one is a valid reply; deleting a hidden one is not found even for an admin, and a listed non-author non-admin is forbidden; a delete is addressed to its list; a client send is always for the whole chat | **new** `apps/server/src/sync/ops.test.ts` |
| The dev route writes and delivers; refuses an unreadable listed actor, an empty list, an author who cannot post and a malformed body | **new** `apps/server/src/web/dev.test.ts` |
| `withheld` advances the frontier as a known type and moves nothing; a restricted message this client is on keeps its list | `apps/desktop/src/sync/apply.test.ts` |
| An op frame carrying `visible_to` or `audience`, top-level or in `m`, parses with them dropped | `packages/protocol/src/frames.test.ts` |
| Boundary rules `sync/messages-written-by-one-writer` (only `ops.ts` inserts a message, tests exempt) and `sync/no-client-audience` (`writeMessage` never appears in `socket.ts`), each probed to fire | `tools/check-boundaries.mjs` |

**Mutation-checked** by hand: 14 planted bugs — each filter removed in turn
(tail/backfill/repair/thread, reply count, counters, welcome, catch-up
redaction), fanout sending content or nothing instead of `withheld`, a restricted
message bumping activity, the listed-access check, an empty list read as the chat, a
reply to a restricted message allowed, a hidden delete not hidden, a delete addressed to the
chat, and the clause reading NULL as nobody. All 14 are caught.

### `message.updated` (D16)

The event step 5's card changes state through. Built here because it is sync
engine, and because the version rule and repair (step 0) are what make it safe.

| File | Change |
|---|---|
| **Changes** `apps/server/src/sync/events.ts` | `message.updated { id, body }` in the catalogue; the version rule declares it touches the message alone. `parts` joins the payload with message parts on the server |
| **Changes** `apps/server/src/sync/ops.ts` | **New** `updateMessage(trx, { chatId, messageId, body })` for server writers: allocates a revision and no ordinal **before** reading, so a delete cannot land between the check and the write; refuses a tombstone or a message from another chat as not found; addresses the event to the message's own audience |
| **Changes** `apps/desktop/src/sync/effects.ts` | Applies the body **only if the held version is not newer** — a repair page can store a newer row while an older update is still on its way — and never sets `edited_at`. A tombstone or a message not held is untouched, and the revision still counts |

| Test | File |
|---|---|
| A revision and no ordinal; the version moves and nothing is marked edited; catch-up carries the event; repair returns the updated row to a client that gapped from before it | `apps/server/src/sync/ops.test.ts` |
| A tombstone or a message in another chat is not found, and the refused allocation rolls back; an update of a restricted message is withheld from the unlisted | `ops.test.ts` |
| The body is replaced and not marked edited; an older update does not overwrite a newer fetched row; a tombstone or a message never held is untouched and the frontier still passes | `apps/desktop/src/sync/apply.test.ts` |

### By hand

Three dev clients, as `MULTI-CLIENT-DEV.md` describes, all in one channel, with
the server started with `RELAYED_DEV_ROUTES=1`:
1. Write a restricted message listing client A through the dev route. A shows it
   labelled; B and C show nothing.
2. On B and C, send and receive normally.
3. Take C offline, write two more restricted messages and five public ones, then
   bring C back. C catches up with no stall.
4. Force a gap on B, then scroll to the top: the history is complete.

### Observability

`sync.withheld{path}` for `live` and `catchup`
([observability (§11)](WORKSPACE-AGENTS.md#11-observability-proposed)) is **not
added**: it is proposed to the dev before it goes into
`packages/telemetry/src/metrics.ts`. Until then the fanout span carries
`withheld` as an attribute beside `delivered`.

### Docs, in the same commit

- `SYNC-FLOWS.md`: how the socket decides what to send (§7, new §7.1), the frame
  vocabulary (§8), events that touch no row (§11.2), catch-up, gap and backfill
  (§12–§14), read state and counters (§15), the case table (§20).
- `DESIGN.md`: membership and access (§7.3) gains the message predicate; the
  client schema (§8.3) gains `visible_to`.
- Invariants 78, 79 and 80 go into `DESIGN.md` §14.
- `AUTHZ.md` records the audience as an exception to invariant 53.
- D1 and D14 are folded into the proposal, with §8.5 rewritten for the array and
  §8.9 gaining the parent-version disclosure.

### Done when

- The proposal's step 1 "what it proves" holds by hand.
- `pnpm spike:sync`, `pnpm test` and `pnpm typecheck` are green. ✅
- The new boundary rules run. ✅

---

## 6. Step 2 — Creating agents

**Implements:**
- [the product (§4.1)](WORKSPACE-AGENTS.md#41-the-product), without the tool picker (D11)
- [the actor row (§4.2)](WORKSPACE-AGENTS.md#42-the-actor-row)
- [the definition (§4.3)](WORKSPACE-AGENTS.md#43-the-definition)
- [who may do what (§4.4)](WORKSPACE-AGENTS.md#44-who-may-do-what-to-an-agent)
- [how clients learn about agents (§4.5)](WORKSPACE-AGENTS.md#45-how-clients-learn-about-agents)
- step 2 of the [steps (§12.2)](WORKSPACE-AGENTS.md#122-steps--each-usable-by-hand)

**First:** nothing. This step can run in parallel with step 1.

**Status: built** — schema, authorization (package, server and both spike
evaluators), server, protocol, replica, commands and the three screens, with
tests. **Not yet done by hand.** What changed from the tables below while
building it:

- **A bug fixed on the way.** The client's `actor.created` effect wrote a NULL
  owner, which the replica's CHECK refuses for an agent: an agent created while
  a client was connected would never have reached that client. The directory
  event now carries `owner_actor_id` (server `ActorChanged`, client effect).
- **Schema:** `membership_agent_role` (an agent's rows are `admin`, nothing
  else), `agent_description_size` (200 characters) and `agent_config_rev` beside
  the constraints §4.3 names.
- **Server:** also `GET /agents/handles/:handle` for the editor's live check;
  `recordActor` now returns its event so the routes deliver it after commit;
  `agentPlacement` in `sync/placement.ts`; the summary is read by one module
  (`agents/summary.ts`) for both the event and the directory page.
  `setMaintainers` refuses an empty list and anyone but an active person in the
  workspace. Deactivation keeps the agent's memberships.
- **Protocol:** `agent_definition_ok` answers `found: false` rather than silence,
  and carries `you` (D20).
- **Client:** no `agents` read or topic of its own (D19); refusals come back as
  answers with `field` and `reason` rather than thrown errors, so the editor puts
  them beside the field; routes are `…/agents`, `…/agents/new`, `…/agents/:id`
  (the profile) and `…/agents/:id/edit`. No avatar upload, Try it or Add agent
  from a space (D18); the model is a text field (D17).

### Schema

**New** `apps/server/src/db/migrations/010_agents.sql`:
- `agents` and `agent_tools`, exactly as in [§4.3](WORKSPACE-AGENTS.md#43-the-definition).
- `membership_scope` dropped and re-added to admit `'agent'`, deliberately and
  in this migration ([§4.4](WORKSPACE-AGENTS.md#44-who-may-do-what-to-an-agent)).
- `membership_owner_scope` is unchanged: `owner` stays workspace-only.

### Authorization

| File | Change |
|---|---|
| **Changes** `packages/authz/src/model.ts` | `SCOPES` gains `agent`. `ACTIONS.workspace` gains `create_agent`. `ACTIONS.agent = ['edit', 'manage_maintainers', 'deactivate', 'read_definition']`. `REQUIRES`: `create_agent` and `read_definition` need membership only; the other three need `admin` at the agent |
| **Changes** `packages/authz/src/can.ts` | An agent target's containment is its workspace, which leads. **A workspace admin also passes `edit`, `manage_maintainers` and `deactivate`.** That is the deliberate opposite of spaces, where a workspace admin inherits nothing (`AUTHZ.md` invariant 51). It is named in `can()` with the reason: an agent spends other people's authority, so someone accountable for the workspace must be able to switch it off |
| **Changes** `spikes/authz-model.mjs`, `spikes/authz-tests.mjs` | The agent scope in both evaluators and the equivalence fixture, including a negative control where a member of another workspace holds an agent row. `pnpm spike:authz` green |
| — | `invoke` is **not** added. It is derived, never stored (§4.4) |

### Server

| File | Change | Implements |
|---|---|---|
| **New** `apps/server/src/agents/definitions.ts` | `createAgent`, `updateAgent` (bumps `config_rev`), `deactivateAgent`, `setMaintainers`. `createAgent` writes the five things in [§4.3](WORKSPACE-AGENTS.md#43-the-definition) in **one transaction**, with `recordActor` | §4.2, §4.3 |
| **Changes** `apps/server/src/provisioning/handle.ts` | Its validation is exported for reuse. An agent's handle goes through the same policy and the same unique index as a person's | §4.1 |
| **New** `apps/server/src/auth/caller.ts` | The bearer-to-actor helper, moved out of `auth/invitations.ts` so agent routes share it | D3 |
| **New** `apps/server/src/agents/routes.ts` | `POST /agents`, `PATCH /agents/:id`, `POST /agents/:id/deactivate`, `PUT /agents/:id/maintainers`. Each is authorised through `can()` | §4.4, D3 |
| **Changes** `apps/server/src/sync/directory.ts`, `sync/events.ts` | `DirectoryActor` and `ActorChanged` gain the optional `agent` summary. `recordActor` fills it for agents | §4.5 |
| **Changes** `apps/server/src/sync/feed.ts` | `directoryPage` joins `agents` and a per-toolkit `agent_tools` aggregate | §4.5 |
| **Changes** `apps/server/src/sync/socket.ts` | An `agent_definition` request frame returns the instructions after `can(actor, 'read_definition', agent)`. Online-only | §4.5 |
| **Changes** `apps/server/src/sync/spaces.ts` | `addToSpace` accepts an agent actor. A test proves nothing assumes a person | §4.1, Spaces field |
| **Changes** `apps/server/src/index.ts` | Registers `agentRoutes` | |

### Protocol

**Changes** `packages/protocol/src/frames.ts`:
- `DirectoryOk.rows[]` and the actor event payload gain optional `agent`.
- `INBOUND` gains `agent_definition`; `OUTBOUND` gains `agent_definition_ok`.

### Client

| File | Change |
|---|---|
| **Changes** `apps/desktop/src/sync/migrations/workspace.ts` | Version 11: `agent_summaries (actor_id PRIMARY KEY, description, config_rev, toolkits)` (D12) |
| **Changes** `apps/desktop/src/sync/effects.ts` | `actor.created` and `actor.updated` upsert the summary |
| **Changes** `apps/desktop/src/sync/index.ts`, `sync/auth/relayed.ts` | `agents.create`, `agents.update`, `agents.deactivate`, `agents.setMaintainers` commands over HTTPS; `agents.definition` over the socket |
| **Changes** `apps/desktop/src/shared/topics.ts`, `renderer/lib/query/` | An `agents` read and its topic, in the one shared vocabulary (invariant 68) |
| **Changes** `apps/desktop/src/renderer/app/router.tsx` | `/w/:wsId/settings/agents`, `…/agents/new`, `…/agents/:agentId` |
| **New** `apps/desktop/src/renderer/routes/SettingsAgents.tsx`, `SettingsAgentEditor.tsx`, `features/agents/AgentProfile.tsx` | The list, the editor without Tools (D11), and the profile with readable instructions |
| **Changes** `apps/desktop/src/renderer/features/chat/composer/relayed-mention.ts`, `composer-suggestions.ts` | Agents appear in mention suggestions, with their description |

### Tests

| Test | File |
|---|---|
| Every new CHECK, one test each; `membership_scope` admits `agent` and nothing else new | **new** `apps/server/src/db/agents-schema.test.ts` |
| The agent matrix in the shipped evaluator — maintainer, workspace admin, owner, member, outsider, an agent row with no workspace row — and agents in the lagging-replica property test | `packages/authz/src/can.test.ts` |
| The shipped evaluator agrees with the spike exhaustively, agents included, with a maintainer from another workspace as the negative control; the spike's tuple evaluator was checked to fail with agent containment removed | `apps/server/src/authz/can.test.ts`, `spikes/authz-tests.mjs` |
| Create writes the five things; a real failure injected after the directory event (a trigger on the last insert) leaves none of them; spaces need `add_member`; edit, deactivate and maintainers by who may; `config_rev` moves for instructions and model only; the definition's `you` and space intersection | **new** `apps/server/src/agents/definitions.test.ts` |
| Routes: 401, 201 with delivery, 409 `handle_taken`, 400 naming the field, 403, 404, 409 `agent_deactivated` | **new** `apps/server/src/agents/routes.test.ts` |
| An agent created live applies with its owner and summary; a page stores the summary; the actor read carries it; `definition()` shares one frame between readers and settles null on stop | `apps/desktop/src/sync/catchup.test.ts`, `storage.test.ts`, `trace.test.ts` |
| The `agent` scope over the full actor × role × action matrix, including workspace admin against agent admin | `packages/authz/src/can.test.ts` |
| A failure after the actor insert leaves no actor, no `agents` row and no directory event | **new** `apps/server/src/agents/definitions.test.ts` |
| An agent cannot take a handle a person holds, nor the reverse | `definitions.test.ts` |
| A directory page carries the summary; `agent_definition` is refused from another workspace | `feed.test.ts`, `socket.test.ts` |

### By hand

The proposal's step 2: an agent appears in autocomplete on every client, and a
maintainer can edit it while another member cannot. Add: a workspace admin can
deactivate someone else's agent.

### Observability

None proposed. Creating an agent is rare, and nothing about it is a silent
failure (`AGENTS.md`, rule 8 allows saying so).

### Docs, in the same commit

- `AUTHZ.md`: scopes (§5), roles and actions (§6), derivation (§7) with the
  workspace-admin exception, and the agent-vocabulary open question (§14,
  item 2) settled.
- `DESIGN.md`: the actor model (§6.3), with `identity_kind='system'`.
- D3, D11 and D12 are folded into the proposal.

### Done when

- The proposal's step 2 holds by hand.
- `pnpm spike:authz` and `pnpm test` are green.

---

## 7. Step 3 — Runs with no tools

**Implements:**
- [what starts a run (§5.1)](WORKSPACE-AGENTS.md#51-what-starts-a-run), channels only (D2)
- [the handoff (§5.2)](WORKSPACE-AGENTS.md#52-the-handoff-is-part-of-the-write)
- [the dispatcher (§5.3)](WORKSPACE-AGENTS.md#53-the-dispatcher)
- [what the runtime is sent (§5.4)](WORKSPACE-AGENTS.md#54-what-the-runtime-is-sent)
- [what the agent reads (§5.6)](WORKSPACE-AGENTS.md#56-what-the-agent-reads)
- [the reply (§5.7)](WORKSPACE-AGENTS.md#57-the-reply)
- [stopping a run (§5.8)](WORKSPACE-AGENTS.md#58-stopping-a-run)
- [the checkpoints (§5.9)](WORKSPACE-AGENTS.md#59-checkpoints-where-later-features-plug-in)
- the claw lessons in [what a production agent platform taught](WORKSPACE-AGENTS.md#what-a-production-agent-platform-taught)
- step 3 of the [steps (§12.2)](WORKSPACE-AGENTS.md#122-steps--each-usable-by-hand)

**First:**
- step 2;
- message parts (§3.1);
- the pi-with-no-local-tools spike (§4.1).

**Status: built** — server, protocol, runtime, client and their tests, as below.
**Confirmed by hand** against a real provider (Anthropic, through the desktop
app): a mention starts a run, and the reply lands as a thread reply with
`on_behalf_of`/`delegation_id` set. **Not yet confirmed by hand**: Stop, and a
server restart mid-run — both are covered by `reply.test.ts` and
`dispatcher.test.ts` (the stop-wins race, the lease sweep) but not yet clicked
through the running app. **Not run**: the pi-with-no-local-tools spike this
step's "First" list names — it was never
built as a script; the questions it was meant to answer (`Type.Unsafe` for a
raw JSON Schema tool parameter; whether cancelling a run aborts an in-flight
broker `fetch`) are still open, harmlessly, since `tools` is always `[]` until
step 5. **One real bug found and fixed along the way**, unrelated to this
step's own code: a `scope_type = 'agent'` membership (step 2) reaching a
desktop replica's `applyWelcome` failed its CHECK constraint and rolled back
the *entire* welcome — no spaces, no chats, no catch-up — for anyone who
maintained an agent. Fixed on both ends: the server's `welcome` now sends only
the scopes a replica declares (`workspace`, `space`, `chat`), and the replica
skips a scope it does not recognise instead of throwing. Regression tests in
`apps/server/src/sync/feed.test.ts` and `apps/desktop/src/sync/storage.test.ts`.

### Schema

**New** `apps/server/src/db/migrations/012_agent_runs.sql` (renumbered when
message parts took 011): `agent_runs` exactly as
in [§5.2](WORKSPACE-AGENTS.md#52-the-handoff-is-part-of-the-write), including:
- `not_before`, `defer_reason` and `stopped_by`;
- the `interrupted` state;
- the `run_queue` index.

### Server

| File | Change | Implements |
|---|---|---|
| **New** `apps/server/src/sync/mentions.ts` | `mentionedActorIds(body)` and the SQL `LIKE` pattern, moved from `feed.ts` (D6) | §5.1 |
| **New** `apps/server/src/agents/checkpoints.ts` | The six functions and their closed result types, with the v1 bodies from [§5.9](WORKSPACE-AGENTS.md#59-checkpoints-where-later-features-plug-in). `beforeToolCall` and `afterToolCall` exist and return `stop('tool_not_allowed')` until step 5. **Adding a result variant is the only sanctioned way to add a feature here**, which the file's header says | §5.9 |
| **Changes** `apps/server/src/sync/ops.ts` | Inside `sendInner`'s `applyOnce` transaction, right after `writeMessage`: `invocationsFor(trx, message)`, one `agent_runs` insert per agent. `Applied` gains `runIds: string[]` (empty on a replay or a delete), read through the same closure pattern as `event` — captured rather than put in the ops ledger, so a replay hands back the stored ack and never reaches the insert | §5.1, §5.2, invariant 76 |
| **Changes** `apps/server/src/sync/socket.ts` | After `fanout` for a send that created runs, `dispatcher.wake()` | §5.3 |
| **New** `apps/server/src/agents/dispatcher.ts` | Starts only when configured (D5). Wake plus a 5 s poll; the claim query from §5.3; `admitRun`; prepare (config snapshot, transcript, grant, `reply_message_id`); call; finish. A lease sweep marks expired `running` rows `interrupted`, with a notice. On `SIGTERM` it stops claiming; leases cover what is left | §5.3 |
| **New** `apps/server/src/agents/transcript.ts` | The builder in [§5.6](WORKSPACE-AGENTS.md#56-what-the-agent-reads): what both the agent and the invoker may read (using `sync/visibility.ts`); the thread or the last 40 top-level messages; 24 KB; labels for the agent's own replies and for other agents; only this agent's mention stripped | §5.6 |
| **New** `apps/server/src/agents/grant.ts` | `signGrant` and `verifyGrant` (D4). Claims `{ sub, act: { sub }, run, chat, exp }` | §5.5 |
| **New** `apps/server/src/agents/runtime-client.ts` | `POST /run` in stream mode through `undici.request`, with `bodyTimeout` set above the runtime's 25 s keepalive. SSE parsing validated against the protocol schemas. A stream that ends without `done` returns `interrupted` | §5.3, stream traps |
| **New** `apps/server/src/agents/reply.ts` | `deliverReply`: in one transaction, re-read the run `FOR UPDATE`; post only when it is still `running` **or `queued`** — the second so a run stopped before it was ever claimed still gets its "Stopped by X" notice (§5.8's "a queued or deferred run is cancelled without the runtime ever hearing of it" — missed on the first pass, caught by `reply.test.ts`, fixed by widening `checkpoints.deliverReply` and the update's `WHERE state IN ('running', 'queued')`). Otherwise `writeMessage` as the agent, setting `on_behalf_of_actor_id`, `delegation_id = run id`, `parent_id` = the trigger's thread ([§5.7](WORKSPACE-AGENTS.md#57-the-reply)), parts, op id `op_<runId>` | §5.7, §5.8 |
| **New** `apps/server/src/agents/notices.ts` | One notice per refusal code and non-answer outcome — the closed sets in §5.7 | §5.7 |
| **New** `apps/server/src/agents/activity.ts` | `agent_activity` to the chat's audience through `pushToActor`: `seq` per run, `ended` final, sent on change plus at most one refresh a minute | §5.7 |
| **Changes** `apps/server/src/agents/routes.ts` | `POST /agent-runs/:id/stop` — invoker only. *Built differently from first planned:* the runtime is signalled by aborting the `AbortController` already threaded through `callRuntime` for that run — closing the open stream request, which `apps/agent` already treats as a disconnect — rather than a second `POST /run/:runId/cancel`; `apps/agent`'s own cancel route is unused by the dispatcher as a result. The row transitions inside the same guarded write as the notice (`reply.ts`, above), not as a separate update first | §5.8 |
| **Changes** `apps/server/src/index.ts`, `env.ts` | Starts the dispatcher; adds §4.2's step-3 variables | D5 |

### Protocol

| File | Change |
|---|---|
| **New** `packages/protocol/src/agent-run.ts` | Zod schemas for the `/run` body and every SSE frame. The body now passes its third field, the trigger `AGENT-RUNTIME.md` names for a schema. The server and the runtime both import it |
| **Changes** `packages/protocol/src/frames.ts` | `OUTBOUND.agent_activity` |

### Runtime (`apps/agent`)

| File | Change | Implements |
|---|---|---|
| **Changes** `src/routes.ts` | Parses the body with `RunRequest`. `runId` comes from the request | §5.4 |
| **Changes** `src/agent.ts` | `palette: 'none'` gives pi the allowlist `['show_ui', ...tools.map(name)]` with no built-ins; `TOOLS` is used only for `palette: 'default'`. Each remote tool is a `customTools` entry whose `execute` calls `AGENT_BROKER_URL` with the grant and pi's abort signal. The list is empty until step 5 | §5.4 |
| **Changes** `src/agent.ts` | **A model-call stall timeout** (`AGENT_MODEL_STALL_MS`): no stream events while the model is generating ends the turn `failed`; paused during tool execution. **An empty turn that errored without throwing is `failed`**, not `completed` | Claw lessons; `AGENT-RUNTIME.md` bounds |
| **Changes** `src/runs.ts` | `activeRuns` keyed by the server's run id | §5.4 |

### Client

| File | Change |
|---|---|
| **New** `apps/desktop/src/shared/agent-activity.ts` | The `AgentActivity` wire shape and the `agent:activity` channel name — the same split `local-rooms.ts`/`AGENT_STREAM_CHANNEL` already has |
| **Changes** `apps/desktop/src/sync/link.ts`, `sync/index.ts` | `agent_activity` goes to the renderer over the bridge (D13), forwarded verbatim — the `seq`/`ended` dropping happens in the renderer hook below, not here (D13, built differently) |
| **New** `apps/desktop/src/renderer/lib/agent-activity.ts` | `useChatActivity(chatId)`: subscribes, and drops a push with a lower `seq` than it holds or a state of `ended` (removing the run) |
| **New** `apps/desktop/src/renderer/features/agents/RunIndicator.tsx` | "Triage is working · Searching Linear", "busy — starting shortly", and **Stop** for the invoker only |
| **Changes** `apps/desktop/src/renderer/features/chat/ChatView.tsx` | *Built differently from first planned:* there is no separate thread view yet — replies render inline, in `ord` order, in the one flat message list. The indicator is attached to the message whose id matches the push's `thread_id`, which is exactly the trigger for a fresh top-level mention. **Known gap:** for a mention added to an *existing* thread, `thread_id` is the thread's root, not the actual invoker, so Stop can be shown to the thread's starter rather than whoever typed the mention — narrow, and left as a comment at the call site rather than fixed by widening the wire payload |

### Tests

| Test | File |
|---|---|
| **No mention is lost:** a committed send has its run; a replayed op creates no second run; a mention of an agent not a member of the chat, or with no mention at all, starts none | `apps/server/src/sync/ops.test.ts` |
| `SKIP LOCKED`: two dispatchers polling the same table never claim the same run; a deferred run is not reclaimed before its own `not_before` | **new** `apps/server/src/agents/dispatcher.test.ts` |
| One refusal code end to end (invoker gone inactive, never reaching the runtime); a person's runs already in flight never defer their next mention | `dispatcher.test.ts` |
| An expired lease is swept and posted as `interrupted` | `dispatcher.test.ts` |
| Two people mention one agent in one thread: two independent runs, two answers, neither dedup'd nor shared | `dispatcher.test.ts` |
| Every non-answer outcome's notice text (`refused`, `failed`, `timeout`, `interrupted`, `cancelled`); a completed run's parts and `on_behalf_of`/`delegation_id` | **new** `apps/server/src/agents/reply.test.ts` |
| **Stop wins:** an answer for an already-cancelled run posts nothing; calling `deliverReply` twice writes exactly one message; **a queued (never-claimed) run that is stopped is both transitioned and given its notice** — the bug this session's own reading of the code found and fixed (`checkpoints.deliverReply`, above) | `reply.test.ts` |
| The transcript excludes what either the agent or the invoker cannot read, labels the agent's own replies and other agents', strips only its own mention, and keeps the trigger even when the byte budget drops everything older | **new** `apps/server/src/agents/transcript.test.ts` |
| A grant round-trips to the claims it was signed with; a wrong run id, an expired token, a wrong audience, and one signed with a different secret are each rejected with the right `reason` | **new** `apps/server/src/agents/grant.test.ts` |
| A tool round trip, deltas/reasoning read past, a keepalive and an unknown event skipped; a stream ending without `done` is `interrupted`; a 429, a 5xx, and nothing listening are each `RuntimeUnavailableError` | **new** `apps/server/src/agents/runtime-client.test.ts` |
| The stall timeout fires only while the model is generating (not the wall clock); an empty errored turn is `failed`; `palette: 'none'` sends the model no built-in tools where `'default'` does; a cancel wins over the reason pi reports while unwinding | **new** `apps/agent/src/agent.test.ts` — the runtime's first test file, against a small OpenAI-chat-completions stub built for it (the spike named in this step's "First" list never was) |
| A regression: an `agent`-scope membership (step 2) must not roll back the whole `welcome`, and a client must skip a scope it does not recognise rather than throw | **new** cases in `apps/server/src/sync/feed.test.ts` and `apps/desktop/src/sync/storage.test.ts` |

### By hand

The proposal's step 3:
1. Mention `@triage` in a channel: the answer arrives in the trigger's thread. **Done** — against Anthropic, through the desktop app.
2. Two people mention it in one thread: two answers. **Not yet done by hand** (covered by `dispatcher.test.ts`).
3. Stop one mid-run: "Stopped by …", and no answer. **Not yet done by hand** (covered by `reply.test.ts`).
4. Kill the server mid-run: `interrupted`, with a notice. **Not yet done by hand** (covered by `dispatcher.test.ts`'s lease sweep).

### Observability

`agent.run{run_outcome}`, `agent.run.refused{run_refusal}`,
`agent.run.deferred{run_defer_reason}` and `agent.run.queue_wait`
([observability (§11)](WORKSPACE-AGENTS.md#11-observability-proposed)) —
`run_outcome`/`run_refusal`/`run_defer_reason` rather than reusing `outcome`
etc., since those label names were already declared for other metrics with
conflicting value sets, and the catalogue does not allow one label name two
different domains. The runtime-side markers `AGENT-RUNTIME.md` §8 already
designed do not land in this change — nothing in step 3 emits them yet; see the
runtime doc's own status note below.

### Docs, in the same commit

- `AGENT-RUNTIME.md`:
  - the entry point (§3): the four fields and the Zod schema;
  - the bash problem (§5): answered for workspace agents by `palette: 'none'`;
  - bounds (§6): the stall timeout;
  - deliberately not built (§9): per-user credentials marked designed.
- `DESIGN.md`: agents at the transport layer (§6.5) and agents (§13.8) — threaded
  replies, the dispatcher, streaming still undecided.
- `SYNC-FLOWS.md`: the frame vocabulary (§8) gains `agent_activity`.
- Invariants 76 and 77.
- D2, D4, D5, D6 and D13 are folded into the proposal.

### Done when

- The proposal's step 3 holds by hand against a real provider, not a stub.
- `pnpm test` is green.

---

## 8. Step 4 — Connections and the connector store

**Implements:**
- [why Composio (§6.1)](WORKSPACE-AGENTS.md#61-why-composio)
- [project, keys and `user_id` (§6.2)](WORKSPACE-AGENTS.md#62-project-keys-and-user_id)
- [our record of connections (§6.3)](WORKSPACE-AGENTS.md#63-our-record-of-connections)
- [permissions (§6.4)](WORKSPACE-AGENTS.md#64-permissions-which-agents-may-use-a-connection): the table and routes; enforcement is step 5
- [connecting (§6.5)](WORKSPACE-AGENTS.md#65-connecting)
- [the catalogue (§6.6)](WORKSPACE-AGENTS.md#66-the-catalogue-and-what-counts-as-a-write)
- [keeping the mirror true (§6.9)](WORKSPACE-AGENTS.md#69-keeping-the-mirror-true)
- [disconnecting (§6.10)](WORKSPACE-AGENTS.md#610-disconnecting)
- [the connector store (§7.1–§7.3)](WORKSPACE-AGENTS.md#7-the-connector-store)
- the editor's Tools section from [the product (§4.1)](WORKSPACE-AGENTS.md#41-the-product)
- step 4 of the [steps (§12.2)](WORKSPACE-AGENTS.md#122-steps--each-usable-by-hand)

**First:**
- the Composio connect spike (§4.1);
- the development project from the setup checklist (§4.3).

This step can run in parallel with steps 1–3.

### Schema

**New** `apps/server/src/db/migrations/012_connections.sql`:

| Table | From |
|---|---|
| `toolkits`, `toolkit_tools` | [§6.6](WORKSPACE-AGENTS.md#66-the-catalogue-and-what-counts-as-a-write) |
| `connections`, with the `connection_live` partial unique index | [§6.3](WORKSPACE-AGENTS.md#63-our-record-of-connections) |
| `connection_attempts (id, connection_id, actor_id, start_token_hash, port, state, access_request_id, expires_at, consumed_at)` | The flow in [§6.5](WORKSPACE-AGENTS.md#65-connecting). The start token is stored hashed, like refresh tokens |
| `agent_permissions` | [§6.4](WORKSPACE-AGENTS.md#64-permissions-which-agents-may-use-a-connection) |
| `composio_webhook_deliveries (webhook_id PRIMARY KEY, received_at)` | D8 |

### Server

| File | Change | Implements |
|---|---|---|
| **New** `apps/server/src/agents/composio.ts` | **The only file that imports `@composio/core`.** Wraps `link` (REST, for `connection_data`), `completeAuth`, `getAccount`, `listAccounts`, `revoke` (REST), `deleteAccount`, the toolkit and tool lists (REST, cursors), and — for step 5 — session create, reuse, tool list and execute. Every call is timed, for `composio.request` | §6.2, invariant 75 |
| **New** `apps/server/src/agents/catalogue.ts` | The daily refresh of `toolkits` and `toolkit_tools`; `effect_derived` from the hints, exactly as [§6.6](WORKSPACE-AGENTS.md#66-the-catalogue-and-what-counts-as-a-write) orders them; deprecation flags | §6.6 |
| **New** `apps/server/scripts/enable-toolkit.ts` | Sets `enabled`, `auth_config_id`, `auth_scheme` and `auth_managed_by` for a slug (D10) | §6.6, §6.11 |
| **New** `apps/server/src/agents/connections.ts`, routes in `agents/routes.ts` | The flow in [§6.5](WORKSPACE-AGENTS.md#65-connecting): `POST /connections`, `GET /connections/start`, `GET /connections/verify`, `POST /connections/:id/complete`, `DELETE /connections/:id`. **The actor always comes from the session token.** A card origin checks `access_requests.actor_id`. Also `GET /toolkits` and `GET /toolkits/:slug` for browsing (online-only) | §6.5, §6.10, invariant 81 |
| **New** `apps/server/src/agents/permissions.ts`, routes | `PUT /agent-permissions/:agentId/:toolkit` grants at the agent's highest effect in that toolkit; `DELETE` revokes. Both are for the session's own actor only | §6.4 |
| **New** `apps/server/src/agents/webhook.ts` | `POST /composio/webhook` with a route-scoped raw-body parser (D7). Checks the HMAC over `id.timestamp.body` with a 300 s tolerance, dedupes through `composio_webhook_deliveries`, marks `needs_reauth`, pushes | §6.9 |
| **New** `apps/server/src/agents/reconcile.ts` | Every 15 minutes, reconcile accounts in `EXPIRED`, `FAILED`, `INACTIVE` or `REVOKED`; mark `connecting` rows older than 10 minutes `failed`; sweep old webhook ids | §6.9 |
| **New** `apps/server/src/agents/label.ts` | After `complete_auth`, the account label from one read tool per toolkit, where a toolkit has one | §7.3 |
| **Changes** `apps/server/src/web/landing.ts` | The "connected — you can close this tab" page the loopback redirect ends on | §6.5 |
| **Changes** `apps/server/src/sync/feed.ts`, `sync/socket.ts` | `welcome` gains `connections` and `agentPermissions` for the caller. Changes push `connections` and `agent_permissions` frames through `pushToActor` | §6.3 |
| **Changes** `apps/server/src/index.ts`, `env.ts` | The routes, the catalogue refresh and the reconciliation timers; §4.2's step-4 variables | |

### Protocol

**Changes** `packages/protocol/src/frames.ts`:
- `Welcome` gains optional `connections` and `agentPermissions`.
- `OUTBOUND` gains `connections` and `agent_permissions`.
- Both are replaced whole on receipt, never merged.

### Client

| File | Change |
|---|---|
| **Changes** `apps/desktop/src/sync/auth/loopback.ts` | `listenForCallback` takes a path and parameter names (D9). Sign-in keeps its defaults |
| **New** `apps/desktop/src/sync/connect.ts` | `connections.connect(toolkit, accessRequestId?)`: listen, `POST /connections`, open `start_url` in the system browser, receive the loopback redirect, check `state`, `POST …/complete`. Never a `BrowserWindow` (`PHASE-1-IDENTITY.md`, the desktop auth flow §6) |
| **Changes** `apps/desktop/src/sync/migrations/workspace.ts` | Version 13: `connections` and `agent_permissions` projections |
| **Changes** `apps/desktop/src/sync/storage.ts`, `sync/link.ts` | Apply both from `welcome` and from their push frames; invalidate their topics |
| **Changes** `apps/desktop/src/renderer/app/router.tsx` | `/w/:wsId/connectors` and `…/connectors/:toolkit` |
| **New** `apps/desktop/src/renderer/routes/Connectors.tsx`, `features/connectors/ToolkitPage.tsx` | Yours and Browse ([where the connector store lives, §7.1](WORKSPACE-AGENTS.md#71-where-it-lives)), the toolkit page ([a toolkit as a tile and a page, §7.2](WORKSPACE-AGENTS.md#72-a-toolkit-as-a-tile-and-as-a-page)), and offline states that say what needs a connection |
| **Changes** `apps/desktop/src/renderer/routes/SettingsAgentEditor.tsx` | The Tools section: toolkits, then tools grouped by effect; read tools preselected; destructive off; the 30-tool cap with its reason (D11) |

### Boundary rules

Added to `tools/check-boundaries.mjs`, each naming its sentence:
- `agents/composio-only-here`: only `apps/server/src/agents/composio.ts`
  imports `@composio/core`.
- `agent/no-composio-env`: no `COMPOSIO_` identifier anywhere under
  `apps/agent/`.

### Tests

| Test | File |
|---|---|
| **Nobody else finishes a connection:** `complete` with another actor's session is refused before Composio is called; a start token works once; `verify` without the cookie completes nothing; a loopback redirect with another attempt's `state` is refused | **new** `apps/server/src/agents/connections.test.ts`, `apps/desktop/src/sync/auth/loopback.test.ts` |
| A connected-account id that differs from the one stored at `link()` is refused | `connections.test.ts` |
| A webhook with a bad signature, a stale timestamp or a repeated id changes nothing | **new** `apps/server/src/agents/webhook.test.ts` |
| Reconciliation corrects an `active` row whose account expired, and fails a stale `connecting` row | **new** `apps/server/src/agents/reconcile.test.ts` |
| Disconnect revokes before deleting; a `400` or `409` from revoke still deletes, and the response says revoking did not happen | `connections.test.ts` |
| Effect derivation: destructive hint, read-only hint, no hint gives `write`, override wins | **new** `apps/server/src/agents/catalogue.test.ts` |
| `welcome` carries only the caller's own connections and permissions | `feed.test.ts` |

`composio.ts` is replaced by an in-memory fake in every test above. The spikes
are what prove the real service behaves as the fake assumes.

### By hand

The proposal's connections and connector-store step (step 4):
1. Connect Linear from the Connectors page.
2. See it on a second device while offline.
3. Disconnect it, and see Linear's authorised apps list drop Relayed.

Add: connect one API-key toolkit through the hosted form.

### Observability

`connection.flow{scheme, stage, outcome}` and `composio.request{op, outcome}` with
its duration ([§11](WORKSPACE-AGENTS.md#11-observability-proposed)).

### Docs, in the same commit

- `DESIGN.md`: what WorkOS owns (§6.2), the third-party access row; delegation
  (§6.4), Boundary A replaced with Composio.
- `STACK.md`: `@composio/core` pinned exact, its documentation entry, and the
  setup checklist (§4.3).
- Invariants 75 and 81.
- D7, D8, D9 and D10 are folded into the proposal.

### Done when

- The proposal's step 4 holds by hand in the development project.
- Both boundary rules run.
- `pnpm test` is green.

---

## 9. Step 5 — The broker

**Implements:**
- [a tool call (§5.5)](WORKSPACE-AGENTS.md#55-a-tool-call)
- enforcement of [permissions (§6.4)](WORKSPACE-AGENTS.md#64-permissions-which-agents-may-use-a-connection)
- [executing through a session (§6.7)](WORKSPACE-AGENTS.md#67-executing-through-a-composio-session)
- [errors (§6.8)](WORKSPACE-AGENTS.md#68-errors-mapped-to-what-the-person-can-do)
- [the card in a chat (§7.4)](WORKSPACE-AGENTS.md#74-the-card-in-a-chat), including its `access_request` part and table
- the milestone, step 5 of the [steps (§12.2)](WORKSPACE-AGENTS.md#122-steps--each-usable-by-hand)

**First:**
- steps 3 and 4, and `message.updated` from step 1;
- the Composio sessions and tool-definition spikes (§4.1).

### Schema

**New** `apps/server/src/db/migrations/013_broker.sql`:

| Table | From |
|---|---|
| `agent_tool_calls`, with outcome `pending` | [§5.5](WORKSPACE-AGENTS.md#55-a-tool-call) |
| `access_requests`, with `resolved_at` and `expired_at` | [§7.4](WORKSPACE-AGENTS.md#74-the-card-in-a-chat) |
| `composio_sessions (agent_actor_id, invoker_actor_id, config_rev, session_id, created_at, PRIMARY KEY (agent_actor_id, invoker_actor_id, config_rev))` | [§6.7](WORKSPACE-AGENTS.md#67-executing-through-a-composio-session) |

### Server

| File | Change | Implements |
|---|---|---|
| **New** `apps/server/src/agents/broker.ts` | `POST /agent/tools`, steps 1–10 of [§5.5](WORKSPACE-AGENTS.md#55-a-tool-call) in that order. Steps 4–8 **are** `beforeToolCall` and step 10 **is** `afterToolCall`, filled in `checkpoints.ts`. **Step 3 reads the invoker only from the run row** | §5.5, invariants 74, 82 |
| **New** `apps/server/src/agents/sessions.ts` | Get or create the session per (agent, invoker, `config_rev`) with the config in §6.7; the session's raw tools with meta tools removed; the 30-tool cap enforced | §6.7 |
| **Changes** `apps/server/src/agents/dispatcher.ts` | Prepare fetches the run's tool definitions from its session, replacing step 3's empty list | §5.3, §6.7 |
| **New** `apps/server/src/agents/tool-errors.ts` | The mapping in [§6.8](WORKSPACE-AGENTS.md#68-errors-mapped-to-what-the-person-can-do), **rewritten from the sessions spike's observed values**. `[Session Restriction]` raises an alert as well as `refused` | §6.8 |
| **New** `apps/server/src/agents/access.ts`, routes | Writes the card: a **public** message (`{ kind: 'stream' }`) by the agent on the invoker's behalf, in the trigger's thread, carrying the `access_request` part with `actor_id` and `state: 'pending'` and the public body — one per toolkit per run. `POST /access-requests/:id/allow` (session actor must equal the request's actor, then grants as in step 4). **Resolving** — the allow, a connect that ends allowed, or a grant from the connector store covering an open request — sets `resolved_at` and calls `updateMessage` with `state: 'resolved'` in the same transaction. Expiry on leaving the room or deactivation does the same with `expired`. `POST /agent-runs/:id/retry` (invoker only, finished runs only, `attempt + 1`) | §7.4, invariant 88 |
| **Changes** `packages/protocol/src/parts.ts` | `access_request` in `MessagePart`, with `actor_id` and `state`, and a `SERVER_ONLY` set that `forbiddenPartKind` refuses for **every** author on the ordinary write path. The broker writes the part through `writeMessage` and changes it through `updateMessage` | §7.4 |
| **Changes** `apps/server/src/sync/events.ts`, `ops.ts` | `parts` in the `message.updated` payload and in `updateMessage`, once parts exist on the server | §7.4 |

### Runtime (`apps/agent`)

**Changes** `src/agent.ts`:
- Remote tools post `{ runId, toolCallId, tool, arguments }` with `Authorization: Bearer <grant>`, forwarding pi's abort signal.
- A `duplicate_call` or `run_not_running` result is returned to the model as an ordinary tool error.

### Client

| File | Change |
|---|---|
| **New** `apps/desktop/src/renderer/features/agents/AccessCard.tsx` | [§7.4](WORKSPACE-AGENTS.md#74-the-card-in-a-chat): for **the actor**, the action from the local `connections` and `agent_permissions` projections while `pending`, and Run again once `resolved`; for **everyone else**, the public sentence for the part's `state`. Which view is chosen by comparing `actor_id` with the signed-in actor — presentation only |
| **Changes** `apps/desktop/src/renderer/features/chat/MessageParts.tsx`, `effects.ts` | Draws `access_request` through `AccessCard`; `message.updated` also replaces `parts` |
| **Changes** `apps/desktop/src/renderer/features/connectors/ToolkitPage.tsx`, `features/agents/AgentProfile.tsx` | "Agents you allowed" with Revoke; the agent's toolkits, each with your status |

### Tests

| Test | File |
|---|---|
| **The broker ignores a forged invoker:** a call whose body or grant claims another actor executes as the run's invoker, or not at all | **new** `apps/server/src/agents/broker.test.ts` |
| **Permission is per agent:** with Linear connected and `@digest` allowed, a Linear call from `@triage` returns `permission_required` and never reaches Composio; allowing it needs no connection flow | `broker.test.ts` |
| **A call id executes once:** the same `tool_call_id` twice reaches Composio once | `broker.test.ts` |
| A tool call after Stop is refused `run_not_running` | `broker.test.ts` |
| A session that refuses a tool our snapshot allows raises the alert | `broker.test.ts` |
| **Only the actor acts:** an allow sent with anyone else's session is refused, though they hold the card; retry is invoker-only and needs a finished run | **new** `apps/server/src/agents/access.test.ts` |
| **Everyone sees it resolve:** an allow resolves the request and appends one `message.updated` with `state: 'resolved'`; a grant from the connector store resolves an open card too; leaving the room expires it | `access.test.ts` |
| `forbiddenPartKind` refuses `access_request` for a person and for an agent on the ordinary write path | `packages/protocol/src/parts.test.ts` |

### By hand — the milestone

The proposal's step 5, word for word:
1. Bob asks `@triage` to file a bug with nothing connected.
2. One card appears in the thread, on every client. Bob's shows Connect; Alice's
   and Carol's say `@triage` is waiting for Bob.
3. Bob connects and allows from that card. On every client the card turns to
   "Bob gave @triage access to Linear"; Bob's shows Run again, and he presses it.
4. The issue appears in **Bob's** Linear, as Bob.

Then Alice asks `@triage` in the same thread and gets her own card: Bob's
permission is not hers. Clicking Allow on Bob's earlier card from Alice's client
— with the button forced on in devtools — is refused.

### Observability

`agent.tool{effect, outcome}` ([§11](WORKSPACE-AGENTS.md#11-observability-proposed)).

### Docs, in the same commit

- `AGENT-RESPONSES.md`, the message contract (§3.1): the `access_request` kind,
  and `tool` parts for remote calls.
- `DESIGN.md`, delegation (§6.4): the grant is the run row plus a signed token.
- Invariants 74, 82 and 83. Invariant 83 is a constraint on later work, recorded
  now.

### Done when

- The milestone holds by hand against the development Composio project and a
  real Linear workspace.
- Every security test in [§13](#13-test-matrix) is green.

---

## 10. Step 6 — Reconnecting

**Implements:**
- the `needs_reauth` rows of [errors (§6.8)](WORKSPACE-AGENTS.md#68-errors-mapped-to-what-the-person-can-do)
- scope changes in [keeping the mirror true (§6.9)](WORKSPACE-AGENTS.md#69-keeping-the-mirror-true)
- the reconnecting paragraph of [connecting (§6.5)](WORKSPACE-AGENTS.md#65-connecting)
- the Reconnect row of [the card (§7.4)](WORKSPACE-AGENTS.md#74-the-card-in-a-chat)
- step 6 of the [steps (§12.2)](WORKSPACE-AGENTS.md#122-steps--each-usable-by-hand)

**First:** step 5.

| File | Change |
|---|---|
| **Changes** `apps/server/src/agents/checkpoints.ts` (`afterToolCall`) | A `needs_reauth` result reads the account's status before marking the connection, so a transient provider error is not mistaken for an expired account |
| **Changes** `apps/server/src/agents/connections.ts` | Reconnect: `link()` once the old account is `EXPIRED` or `REVOKED`; the new `ca_` id replaces the old on the **same** `connections` row; the old account is deleted |
| **Changes** `apps/server/src/agents/catalogue.ts` | Compare each account's `requested_scopes` with its auth config; mark older accounts `needs_reauth` with reason `scopes_changed` |
| **Changes** renderer store and card | The Reconnect state and its banner |

**Tests:**
- An `expired` webhook moves a connection to `needs_reauth` and pushes it.
- A `422` at execution does the same, and raises the card.
- Reconnecting keeps `connections.id`, so `agent_tool_calls.connection_id` still
  resolves.

**By hand:** the proposal's step 6. Revoke Relayed in Linear's settings; the
next run asks Bob to reconnect rather than failing vaguely.

**Done when:** the above holds by hand, and the reconciliation catches a revoke
even with the webhook subscription disabled.

---

## 11. Step 7 — Agents find their own tools

> **Built 2026-09-15**, fix first included. **Checked:** server 398 tests, 18 of
> them new (`broker.test.ts` 8, `access.test.ts` 7, the sweep test, two migration
> tests) and four removed with the `agent_tools` table, with four rules broken on
> purpose to confirm their tests fail; runtime 6, desktop 529, protocol 29,
> telemetry 39. **Live**, against the running server, the real model
> and Composio, in a throwaway workspace removed afterwards: a mention made
> the model call `find_tools`, the GitHub card was posted *and* the model's own
> reply was written beside it (the fix first, live); allowing it re-ran the
> request with nothing pressed, and the re-run stopped at a new card because
> nobody there had GitHub connected. **Not checked:** the by-hand milestone below,
> which needs a real GitHub connection made through the app. *Where the build
> differs from this plan* is listed at the end of the step.

**Why this step exists.** Step 5 gives an agent exactly the tools its creator
picked in the editor. Creating "Triage" with instructions and no tools — the
natural first thing anyone does — gives a model that cannot even try GitHub,
so no card is ever raised and it answers "give me the repository URL". Asking
people to choose from GitHub's 894 tools while creating an agent is the
friction this product exists to remove. After this step, **nobody picks tools**:
an agent looks for what it needs when it runs, and the card asks for access at
that moment.

**The flow this step delivers, with the people from the proposal:**

1. `@triage` is created with a name and instructions, and nothing else.
2. Alice: "@triage look at github issue #445 and tell me about it".
3. Triage's prompt says it can reach **GitHub** and **Notion**. It calls
   `find_tools({ toolkit: 'github', use_case: 'look at issue #445' })`.
4. Alice has no GitHub connection, so the server posts the card — **Connect
   GitHub and allow @triage** — and tells the model to say so and stop. The run
   ends. Nothing waits for her.
5. Hours later Alice clicks Connect, signs in, and the card allows @triage in the
   same click. **The run starts again by itself.**
6. `find_tools` now returns `GITHUB_GET_AN_ISSUE` with its schema; Triage calls
   `call_tool({ tool: 'GITHUB_GET_AN_ISSUE', arguments: { owner, repo, issue_number: 445 } })`
   and answers.
7. Later, "@pr-review review PR #4561": Alice is connected but never allowed
   @pr-review, so the card is one click — **Allow @pr-review** — with no sign-in.
   It re-runs and reviews. Neither agent asks her again.

Permission stays **per agent** ([permissions, §6.4](WORKSPACE-AGENTS.md#64-permissions-which-agents-may-use-a-connection)):
connecting is once per person, allowing is once per agent. That click is the
only moment Alice agrees to *this* agent spending her account — and any member
can write an agent's instructions.

**Implements:** decisions D21–D27 (§2), which change
- [the product (§4.1)](WORKSPACE-AGENTS.md#41-the-product) and [the definition (§4.3)](WORKSPACE-AGENTS.md#43-the-definition): no Tools field, no `agent_tools`
- [what the runtime is sent (§5.4)](WORKSPACE-AGENTS.md#54-what-the-runtime-is-sent) and [a tool call (§5.5)](WORKSPACE-AGENTS.md#55-a-tool-call)
- [permissions (§6.4)](WORKSPACE-AGENTS.md#64-permissions-which-agents-may-use-a-connection): what Allow grants
- [executing through a session (§6.7)](WORKSPACE-AGENTS.md#67-executing-through-a-composio-session) and [errors (§6.8)](WORKSPACE-AGENTS.md#68-errors-mapped-to-what-the-person-can-do)
- [the card in a chat (§7.4)](WORKSPACE-AGENTS.md#74-the-card-in-a-chat): Run again becomes automatic

**First:** step 5. **Evidence:** the Composio discovery spike (§4.1),
[`spikes/composio-discovery/`](../spikes/composio-discovery/README.md). Step 6
is independent of this step.

### Fix first — the card takes the run's reply id

**A bug in step 5, found while planning this step, and it ships on its own.**
`raiseAccessRequest` (`apps/server/src/agents/access.ts`) writes the card with
`claimReplyMessageId`, which returns the id the dispatcher already chose for the
run's **answer**. When the model then finishes — "I need access to your
GitHub" — `deliverReply` writes the answer with the same id and hits
`messages_pkey`. `applyOnce` retries once, finds no ledger row, fails again, and
the run is left `running`. When its lease expires, the sweep's notice collides
with the same id — the server crash of 2026-09-15, which is now caught and
counted as `agent.dispatcher.sweep_error` but repeats on every sweep, for ever.

| File | Change |
|---|---|
| **Changes** `apps/server/src/agents/access.ts` | The card gets its own id, `ulid('msg')`. The answer keeps the run's reply id |
| **Changes** `apps/server/src/agents/dispatcher.ts` | `sweepExpiredLeases` moves a run whose notice failed to `interrupted` directly, as it already does for a run with no reply id, so one bad row is not retried every five seconds |

**Test:** a run that raises a card and then completes posts both the card and
the answer, and ends `completed` (`apps/server/src/agents/access.test.ts`).

### What the spike settled

| Question | Answer | Consequence here |
|---|---|---|
| Can one Composio session serve a person, across every agent? | Yes — no tool list, limited to the enabled toolkits, with `manage_connections`, `workbench` and multi-execute off. Only search and schema meta tools remain | One session per **person**, not per (agent, person, `config_rev`) |
| Does search work before a connection exists? | Yes, reporting `has_active_connection: false` | The card is raised at search time |
| Does search say "nothing fits"? | **No.** A Slack request with Slack not enabled returned GitHub tools | The model names the toolkit (D22) |
| Latency | Search p50 2.1s, max 3.1s; execute 750–950ms | Search once per need, never per call |
| Must the model search before calling a tool? | No — an unsearched tool executes | `call_tool` is checked on its own; search is guidance, not a gate |
| Is the search response safe to pass through? | **No.** It carries the person's whole GitHub profile, the Composio account id, and instructions to call tools the session does not have | The server builds its own result (D27) |
| Must a session pin the account? | Not in the spike — contradicting the comment in `composio.ts` and `014_broker.sql`. Pinning can be added later with `PATCH`, and Composio refuses to pin someone else's account | Pin anyway, from `connections`, so the account executed is the one the audit records (D24) |
| Size | The cleaned result is ~1,400 tokens; all of GitHub ~459,000, all of Notion ~92,000 | Search for every toolkit, however small |

### Schema

**New** `apps/server/src/db/migrations/016_tool_discovery.sql`:

| Change | Why |
|---|---|
| `DROP TABLE agent_tools` | Nobody picks tools (D21). No compatibility layer: nothing reads it after this step |
| `composio_sessions` recreated as `(invoker_actor_id PRIMARY KEY, session_id, toolkits TEXT[], connected_accounts JSONB, created_at)` | One session per person (D24). `toolkits` is the enabled set it was created for: when a toolkit is enabled or disabled, the session is recreated |

No new column for automatic re-runs: the existing
`UNIQUE (trigger_message_id, agent_actor_id, attempt)` on `agent_runs` already
makes "one re-run per attempt" true when two cards resolve at once (D25).

**Replica:** unchanged. `agent_summaries.toolkits` stays, always empty, and is
dropped together with the wire field once no client in use requires it (§12.4).

### Server

| File | Change |
|---|---|
| **Changes** `apps/server/src/agents/dispatcher.ts` | Every run gets two tools instead of the agent's list: `find_tools` with `toolkit` as an **enum of the enabled toolkits** and `use_case`, and `call_tool` with `tool` and `arguments`. The system prompt gains one line naming the enabled toolkits, and one rule: **if a request needs a service that is not listed, say so — never substitute another service.** `agent_runs.config` records the toolkits offered instead of a tool list |
| **Changes** `apps/server/src/agents/composio.ts` | `searchSessionTools(sessionId, useCase)` for `POST /tool_router/session/:id/search`, returning only tool names and schemas; `patchSessionAccounts(sessionId, connectedAccounts)`. `createSession` loses its tool list. The comment claiming pinning is required is corrected to what the spike observed |
| **Changes** `apps/server/src/agents/sessions.ts` | `sessionFor(db, invoker)`, and `enabledToolkits(db)`: one per person, recreated when the enabled toolkits change, and patched when their active `connections` differ from its pin. No longer lists the session's tools |
| **Changes** `apps/server/src/agents/broker.ts` | `POST /agent/tools` dispatches on the tool name. **`find_tools`:** checks the toolkit is enabled; checks permission for (invoker, agent, toolkit) at `read` and then connection, through the same `checkAccess` steps 7 and 8 of §5.5 use; if either is missing, raises the card at effect `write` and stops with `permission_required` or `connection_required`; otherwise searches and returns **its own shape** — `{ tools: [{ name, description, parameters }] }` for tools of that toolkit only, schemas Composio did not include filled from `toolkit_tools.input_schema`. **`call_tool`:** the steps of §5.5, with step 5 changed below. Anything else is `tool_not_allowed` |
| **Changes** `apps/server/src/agents/checkpoints.ts` | `beforeToolCall` step 5, "tool in the snapshot", becomes **"the tool is in `toolkit_tools`, not deprecated, in an enabled toolkit"**. Its effect is `effect_override ?? effect_derived` from the catalogue, never from the model. `onRunEnd` is finally called (below) |
| **Changes** `apps/server/src/agents/access.ts` | `grantPermission` grants **`write`**, or `destructive` when the card being allowed is for a destructive call (D23) — never computed from `agent_tools`. `resolveAccessRequests` resolves only cards the grant covers (an ordinary Allow leaves a destructive card open) and returns their runs; `rerunResolved` re-runs them and wakes the dispatcher. **New** `rerun.ts`, `rerunIfReady(runId)`: when the run has finished, has at least one resolved card and **no pending one**, insert attempt `+ 1` (`ON CONFLICT DO NOTHING`). Its own module, so `access.ts` and `checkpoints.ts` both call it without an import cycle through `dispatcher.ts`. `permissions.ts`'s grant route re-runs the same way. The invoker-only `POST /agent-runs/:id/retry` route is deleted |
| **Changes** `apps/server/src/agents/checkpoints.ts`, `dispatcher.ts` | `onRunEnd` calls `rerunIfReady`, for a card resolved **before** its run had finished |
| **Changes** `apps/server/src/agents/tool-errors.ts` | From the spike: `ToolRouterV2_ToolNotFound` for a tool our catalogue still lists → `tool_deprecated`; `ToolRouterV2_ToolkitNotAllowed` → `refused` with the alert; a `200` with `error` set → `failed`, message kept, so the model can correct its arguments |
| **New** `apps/server/src/agents/run-tools.ts` | The two tool definitions and the prompt text, shared by the dispatcher (which offers them) and the broker (which answers them), so the names cannot drift |
| **Changes** `apps/server/src/agents/definitions.ts`, `routes.ts`, `summary.ts`, `catalogue.ts` | The tools write path and its `PUT /agents/:id/tools` route, the `tools` limit and field, and `toolDefinitions` are deleted. Summaries send `toolkits: []` until clients that read the field are gone (§12.4) |

**Not recorded in `agent_tool_calls`:** a `find_tools` call. It executes nothing
against anyone's account.

### Protocol

**Changes** `packages/protocol`: none to the shapes. The definition's `tools` and
the summary's `toolkits` stay in the wire schema, always empty and commented as
such, until no client in use requires them (§12.4).

### Runtime (`apps/agent`)

**Changes** `src/agent.ts`: `describeBrokerResult` gains the wording for a stop
raised by `find_tools` — "a card has been posted asking them for access; tell
them in one short sentence and stop". No change to how remote tools register:
`find_tools` and `call_tool` are two ordinary `RunTool`s.

### Client

| File | Change |
|---|---|
| **Delete** `apps/desktop/src/renderer/features/agents/AgentTools.tsx`; **changes** `routes/SettingsAgentEditor.tsx` | No Tools section. Creating an agent is name, handle, description, instructions and model |
| **Changes** `features/agents/AccessCard.tsx` | Resolved shows "GitHub is ready. @triage is running again." instead of Run again. `EFFECT_WORDS` gets its own `destructive` wording ("to delete or overwrite things in your") |
| **Changes** `apps/desktop/src/sync/index.ts`, `sync/auth/relayed.ts`, `preload/api.d.ts`, `features/connectors/useToolkits.ts` | `agents.retryRun`, `agents.setTools` and `toolkits.get` are deleted, with their HTTP calls and `useToolkitDetail` — the tool picker was their only user |
| **Changes** `routes/SettingsAgents.tsx`, `features/agents/AgentProfile.tsx` | The toolkit badges go. The profile's Tools row says the agent finds what it needs and asks you for access the first time it uses yours |

**Already built, contrary to what planning first assumed:** "Connect and allow in
one go". `AccessCard.tsx` connects, then calls allow, in one click.

### Tests

| Test | File |
|---|---|
| `find_tools` with no permission raises one card, a second search raises no second, and Composio is never called; allowed but not connected returns `connection_required` | **new** `apps/server/src/agents/broker.test.ts` |
| `find_tools` connected but not allowed for **this** agent raises the Allow card; allowed for another agent does not count | `broker.test.ts` |
| `find_tools` returns only the named toolkit's real, non-deprecated tools, in exactly `{ name, description, parameters }`, with Composio's schema when it sent one and ours otherwise. (`composio.ts`'s `searchSessionTools` never returns the raw response, so profile and guidance cannot reach the broker at all.) | `broker.test.ts`, Composio stubbed |
| `call_tool` refuses a name not in the catalogue, a deprecated tool, and a tool of a toolkit not enabled — none reach Composio | `broker.test.ts` |
| `call_tool` takes the effect from the catalogue: a destructive tool with a `write` permission raises a second card | `broker.test.ts` |
| Allow grants `write`; allowing a destructive card grants `destructive`; an ordinary Allow never lowers it, and leaves a destructive card open | `access.test.ts` |
| A card resolving after its run finished queues exactly one re-run; two cards resolving at once still queue one; a run with a second card still pending queues none; a card resolving **before** the run finished re-runs when it ends | `access.test.ts` |
| A run that raises a card and then completes posts both (fix first); a swept run whose notice cannot be written still leaves `running` | `access.test.ts`, `dispatcher.test.ts` |
| Migration 016 against Postgres: `agent_tools` gone, `composio_sessions` keyed per person | `apps/server/src/db/agents-schema.test.ts` |

### By hand — the milestone

The flow at the top of this step, on two clients, against the development
Composio project and a real GitHub account:
1. Create `@triage` with instructions only, and `@pr-review` likewise.
2. As a person with no GitHub connection, ask `@triage` about a real issue. One
   card; the other client sees "@triage is waiting for …".
3. Leave it for five minutes, then Connect. The card resolves on both clients and
   Triage answers **without anyone pressing anything else**.
4. Ask `@pr-review` about a real pull request: one-click Allow, no sign-in, then
   the answer.
5. Ask both again: no card.
6. Ask `@triage` to post in Slack: it says it cannot reach Slack. It does **not**
   comment on GitHub.

### Observability

**Not added.** Proposed, to agree with the dev before adding (`AGENTS.md`,
observability is part of the feature):

| Marker | Question it answers |
|---|---|
| `agent.tool.search{result}` — `found`, `access_required`, `empty`, `error` | Do agents find tools, or stall at access? A rising `empty` means the prompt's toolkit rule or search quality is failing |
| `agent.tool.search.duration` | Is Composio search what makes a first reply slow? The spike measured p50 2.1s |
| `agent.run.rerun` | Does a card actually lead to finished work, or do people connect and nothing happens? |

### Docs, in the same commit

- `WORKSPACE-AGENTS.md`: the sections listed under Implements, and
  [deliberately not built (§13)](WORKSPACE-AGENTS.md#13-deliberately-not-built) — "a tool-search
  meta-tool" and retrying after a card are no longer deferred.
- `apps/server/src/agents/composio.ts` and `014_broker.sql`'s comments on pinning.
- `AGENTS.md`'s documentation table: seven steps.

### Done when

- The milestone holds by hand, including step 6's refusal to substitute a service.
- Every test above is green, and so is the fix-first test on its own before it.

### Where the build differs from this plan

- **`agent_summaries.toolkits` is not dropped**, and neither are the wire fields — see Replica and Protocol above.
- **The profile's Tools row is a sentence**, not a list of enabled toolkits with your access to each: the smallest thing that stops it describing a list that no longer exists.
- **The fix first also touched `packages/telemetry`**: `agent.dispatcher.sweep_error`'s description, since a failed notice now moves the run on.
- **`composio_op` label values**: `session_tools` replaced by `patch_session` and `session_search`.
- **A reply's tool lines come from `agent_tool_calls`** (`reply.ts`), not the runtime's list of calls: that list only says `find_tools` and `call_tool`. Searches and calls that stopped for access get no line, and the working indicator names neither tool. Added after the dev saw red "find tools — failed" markers beside cards that were working as intended.
- **The prompt says to use only the services a request needs**, and to call `find_tools` for every request even when earlier messages show access being asked for. Added after one run asked for GitHub on a Notion request, and a test run skipped asking when an earlier card was in the thread. Measured afterwards on the live model: six requests, each asked only for the service it named, each with its card. Six runs cannot prove an intermittent behaviour gone.
- **Every access card was drawn as its public sentence, for everyone** — including the person who could act on it. The renderer reused `forbiddenPartKind`, the write rule, which refuses a card for every author. The renderer now uses `undrawablePartKind` (`packages/protocol/src/parts.ts`), which draws a card on an agent's message. A step-5 bug, found by the dev in the app.
- **The per-person run cap is gone.** `admitRun` deferred a run as `invoker_busy` once three of that person's runs were `running` — and counted runs left `running` by a server restart until their lease expired, so every new mention from that person queued for up to ten minutes behind requests nobody was working on. Asked by the dev: a stuck request must not hold back any other, the same person's included. `runtime_busy`, the runtime's own capacity, is the remaining defer reason.
- **A test toolkit leaked into the development database** when one run of `access.test.ts` failed during cleanup, and was offered to real agents' prompts until removed by hand. Tests share the development database; a test that enables a toolkit is visible to a running dispatcher for as long as it lives.

---

## 11a. Agents create rooms — `create_room`

> **Built 2026-09-15.** **Checked:** server 419 tests, 8 of them new
> (`broker.test.ts` 6, `run-tools.test.ts` 2), with the one failure
> `find_tools refuses a toolkit that is not enabled` failing identically before
> this change; desktop 574, 3 new; protocol 30. Migration 018 applied to the
> development database. **Not checked:** a live run — a person asking an agent
> for a room, the room appearing on their devices, and its link opening it.

**Why.** Someone working with an agent asks it to start a room for the work —
"make a room for HAR-21" — and today it can only tell them to make one.

**The decisions** (the dev's, recorded in `WORKSPACE-AGENTS.md` §5.5):

- An app tool, offered to **every** run, not tied to any toolkit or to where the run is.
- The agent is the room's creator and founding admin; the person is `on_behalf_of` and joins as admin.
- **The person's `create_space` alone** decides — not the intersection (`DESIGN.md` §6.4 records the exception).
- **Private** unless the person asks for public.
- The person joins through the ordinary add: the same event and marker, no new delivery path.
- **Called last**, by the prompt, so an access card's re-run cannot find a room already made. No hard cap and no idempotency key yet (`WORKSPACE-AGENTS.md` §13).
- The reply carries a room link, `[name](space:spc_…)`, which opens the room.

### Schema

Server migration 018: `spaces.on_behalf_of_actor_id`, nullable, `REFERENCES actors(id) ON DELETE SET NULL`.
Replica version 16 adds the same column; `spaces.created_by_actor_id` was
already in the replica and is now filled in.

### Server

| File | Change |
|---|---|
| `sync/spaces.ts` | `NewChannel.onBehalfOf`: authorization reads that actor's grants; the space row, `space.created` and the join hydration carry both attributions; the person is added with `addMemberWithMarker(…, 'admin', agent, ulid('msg'))` inside the creating transaction. `spaceNameFrom()` is the one name rule |
| `sync/routes.ts` | `POST /spaces` uses `spaceNameFrom()` rather than its own check |
| `sync/feed.ts`, `sync/socket.ts`, `sync/events.ts` | `welcome` spaces, the space gap snapshot, `SpaceCreated` and the hydration type carry `created_by_actor_id` and `on_behalf_of_actor_id` |
| `agents/run-tools.ts` | `CREATE_ROOM` and its tool, in every run's list; the prompt: only when asked, last, put the link in the reply |
| `agents/broker.ts` | `createRoomFor`: steps 1–4, the name, visibility defaulting to private, `createRoom` with the run chat's workspace, delivers every event, returns `{ space_id, chat_id, name, visibility, link }`; a `Forbidden` is a `failed` result saying the person may not create rooms |

### Protocol

`welcome` spaces gain `created_by_actor_id` and `on_behalf_of_actor_id`, nullable
and optional, so a client meeting an older server parses it.

### Client

| File | Change |
|---|---|
| `sync/migrations/workspace.ts` | Version 16 |
| `sync/effects.ts`, `sync/storage.ts`, `sync/index.ts` | The hydration upsert and `welcome` write both attributions; `Space` exposes `createdByActorId` and `onBehalfOfActorId` (null for local rooms) |
| `shared/spaces.ts` | `spaceLinkTarget()`: the space id a `space:spc_…` link names, or null |
| `renderer/features/chat/MarkdownText.tsx`, `ChatBubble.tsx` | A `space:` link survives the URL transform and draws as a link; clicking it opens `/w/:ws/s/:space`. Other links in a bubble still do nothing |

### Tests

| Test | Proves |
|---|---|
| `create_room` is offered with no toolkits and outside a room; the prompt says only when asked, and last | Every run has it |
| A private room: agent `created_by` and admin, person `on_behalf_of` and admin; events `space.created`, `chat.created`, `space.member_added` ×2, the marker; both attributions on the event and the hydration | Creation, membership and delivery |
| Public only when `visibility` is `public` | The default |
| `workspace_id`, `created_by` and `on_behalf_of` in the arguments change nothing | Identities come from the run |
| A person without `create_space` gets `failed`, and nothing is written or delivered | The person's permission, atomically |
| An empty or over-long name, a deactivated agent and a finished run are refused | Steps 1–4 and the name rule |
| A room a person creates is unchanged: `on_behalf_of` null, one admin, three events | No regression |
| The replica keeps both attributions from a hydration and from `welcome`, and stores nulls from an older server | Replica |
| `spaceLinkTarget` accepts only `space:spc_…` | The link |

### By hand

1. `@triage make a room for HAR-21`: the reply links the room, and it is in the sidebar, private, with Triage and you as admins, and "Harsh was added by Triage" in it.
2. The link opens the room.
3. On a second device signed in as the same person, the room appears without a reconnect.
4. `@triage read HAR-21 in Linear and make a room for it`, with Linear not yet allowed: the card is raised and no room exists until the re-run after Allow — then exactly one.

---

## 12. Cross-cutting

### 12.1 Module layout

```
apps/server/src/agents/
  checkpoints.ts        the six functions (§5.9)                       step 3, filled in 5
  definitions.ts        create / edit / deactivate                     step 2
  routes.ts             every agents HTTP route                        steps 2–5
  dispatcher.ts         claim, admit, prepare, call, finish            step 3
  transcript.ts         what the agent reads                           step 3
  grant.ts              sign and verify                                step 3
  runtime-client.ts     the /run stream                                step 3
  reply.ts  notices.ts  activity.ts                                    step 3
  composio.ts           the only @composio/core import                 step 4
  catalogue.ts  connections.ts  permissions.ts  webhook.ts
  reconcile.ts  label.ts                                               step 4
  broker.ts  sessions.ts  tool-errors.ts  access.ts                    step 5; find_tools, call_tool,
                                                                       one session per person, re-runs: step 7;
                                                                       open_panel, create_room (§11a)
  run-tools.ts          the tools a run is offered, and their prompt   step 7, §11a
```

### 12.2 Migrations

| Number | Name | Step |
|---|---|---|
| 009 | `restricted_messages` (dormant) | 1 |
| 010 | `agents` | 2 |
| 011 | `message_parts` | `AGENT-RESPONSES.md` phase 3 |
| 012 | `agent_runs` | 3 |
| 013 | `connections` | 4 |
| 014 | `broker` | 5 |
| 015 | `tool_schemas` — `toolkit_tools.input_schema`, from the catalogue | 5 |
| 016 | `tool_discovery` — drops `agent_tools`; `composio_sessions` per person | 7 |
| 017 | `panels` — a room's shared panels (`PANELS.md`) | `open_panel` |
| 018 | `space_on_behalf_of` — `spaces.on_behalf_of_actor_id` | `create_room` (§11a) |

Steps that run in parallel must renumber on merge rather than share a number.
Every CHECK added gets one test per constraint, against Postgres
(`AGENTS.md`, rule 2).

Replica migrations in `apps/desktop/src/sync/migrations/workspace.ts`:
version 9 (step 0), 10 (step 1), 11 (step 2), 12 (message parts), 13 (step 4), 15 (room panels), 16 (`space_attribution`: `spaces.on_behalf_of_actor_id`, §11a). Step 7 needs none: `agent_summaries.toolkits` stays until the wire field goes.

### 12.3 Telemetry by step

| Step | Markers | Catalogue |
|---|---|---|
| 1 | `sync.withheld{path}` — not until something writes restricted messages | `packages/telemetry/src/metrics.ts` |
| 3 | `agent.run{outcome}`, `agent.run.refused{refusal}`, `agent.run.deferred{reason}`, `agent.run.queue_wait`; the runtime's markers from `AGENT-RUNTIME.md` §8 | `metrics.ts` |
| 4 | `connection.flow{scheme, stage, outcome}`, `composio.request{op, outcome}` + duration | `metrics.ts` |
| 5 | `agent.tool{effect, outcome}` | `metrics.ts` |
| 7 | Proposed, not agreed: `agent.tool.search{result}`, `agent.tool.search.duration`, `agent.run.rerun` | `metrics.ts` |

Each is proposed to the dev before it is added (`AGENTS.md`, rule 8). Two limits
are enforced by the catalogue's types:
- **No id as a label**, and a `toolkit` label only through an allowlist.
- **No tool arguments, results, instructions or card text** in any event.

### 12.4 Rolling out

In order, because old clients and old runtimes persist (`DESIGN.md`, forward
compatibility §9.10):

1. **Server with step 1.** Old clients receive `withheld` and `message.updated`
   as unknown types and advance their cursor. No client release is needed before
   the server; an old client shows a card's old state until the row is fetched
   again.
2. **Runtime before dispatcher.** Deploy `apps/agent` with the new body schema
   before a server whose dispatcher is configured (D5).
3. **Composio production project** (§4.3) before step 4 reaches production,
   including our own OAuth apps.
4. **Clients** with the agent screens and the connector store.
5. **Step 7: server first, then clients, then stop sending `toolkits`.** The server keeps sending `toolkits: []` in agent summaries until no client in use reads the field, because an old client's parse requires it.

### 12.5 Data kept, and for how long

Neither the proposal nor this plan settles retention for
`agent_runs.config`, `agent_tool_calls.arguments` or `access_requests`. They are
product data, not telemetry. See §17.

---

## 13. Test matrix

The proposal's [tests that must exist (§12.3)](WORKSPACE-AGENTS.md#123-tests-that-must-exist),
each with its step and file.

| Proposal test | Step | File |
|---|---|---|
| Contiguity under withholding | 1 | `spikes/sync-tests.mjs`, `apps/server/src/sync/feed.test.ts`, `apps/desktop/src/sync/apply.test.ts` |
| Backfill with a hidden ordinal 1 | 1 | `feed.test.ts`, `apps/desktop/src/sync/catchup.test.ts` |
| Badge | 1 | `feed.test.ts` |
| Each CHECK branch | 1, 2 | `apps/server/src/db/restricted-schema.test.ts`, `agents-schema.test.ts` |
| The broker ignores a forged invoker | 5 | `apps/server/src/agents/broker.test.ts` |
| No mention is lost | 3 | `apps/server/src/sync/ops.test.ts` |
| Nobody else finishes a connection | 4 | `apps/server/src/agents/connections.test.ts`, `apps/desktop/src/sync/auth/loopback.test.ts` |
| A call id executes once | 5 | `broker.test.ts` |
| Permission is per agent | 5, 7 | `broker.test.ts` — in step 7, at search time as well as at call time |
| Stop wins | 3, 5 | `apps/server/src/agents/reply.test.ts`, `broker.test.ts` |
| Nothing is silent | 3 | `apps/server/src/agents/dispatcher.test.ts` |
| A run finds tools only in enabled toolkits, and a tool name from the model is checked against the catalogue before Composio sees it | 7 | `broker.test.ts` |
| A resolved card re-runs once | 7 | `apps/server/src/agents/access.test.ts` |
| Boundary rules | 1, 4 | `tools/check-boundaries.mjs`: `protocol/no-client-audience`, `agents/composio-only-here`, `agent/no-composio-env` |

---

## 14. Docs matrix

The proposal's [docs to change (§14)](WORKSPACE-AGENTS.md#14-docs-to-change-when-this-is-accepted),
each landing in the step that makes it true — never before.

| Doc and section | Step |
|---|---|
| `DESIGN.md`, the actor model (§6.3) | 2 |
| `DESIGN.md`, what WorkOS owns (§6.2) and delegation (§6.4), Boundary A | 4 |
| `DESIGN.md`, delegation (§6.4), the grant | 5 |
| `DESIGN.md`, accepted exposures (§6.6), item 2 | 1 |
| `DESIGN.md`, membership and access (§7.3) | 1 |
| `DESIGN.md`, client schema (§8.3) and sync protocol (§9) | 1, 2, 3, 4 — each its own additions |
| `DESIGN.md`, invariants (§14) | By [§15](#15-invariants-by-step) |
| `DESIGN.md`, build order (§15) | 1: Phase 6 rewritten to point at this plan |
| `AUTHZ.md` | 2 |
| `AGENT-RUNTIME.md` | 3 |
| `SYNC-FLOWS.md` | 1 (visibility), 3 (`agent_activity`) |
| `AGENT-RESPONSES.md` | 5 |
| `STACK.md` | 4 |
| `OBSERVABILITY.md` | Each step whose markers are agreed |
| `AGENTS.md` | Done: the proposal is listed. This plan is added beside it. Step 7: seven steps |
| `WORKSPACE-AGENTS.md`, §4.1, §4.3, §5.4, §5.5, §6.4, §6.7, §6.12, §7.4, §13 — folding D21–D27 | 7 |

---

## 15. Invariants by step

From [invariants to add](WORKSPACE-AGENTS.md#invariants-to-add).

| # | Invariant | Step | Enforced by |
|---|---|---|---|
| 74 | A tool call's invoker is read from the run row | 5 | `broker.ts` step 3; forged-invoker test |
| 75 | Only `apps/server` calls Composio | 4 | Boundary rules `agents/composio-only-here`, `agent/no-composio-env` |
| 76 | A mention's run is inserted in the message's transaction | 3 | `writeMessage`; no-mention-lost test |
| 77 | A workspace agent's palette holds no local tools | 3 | `RunRequest.palette`; runtime test |
| 78 | A restricted message's revision reaches every reader; its content only the listed | 1 | `fanout.ts`, `visibility.ts`; contiguity tests |
| 79 | Visibility filters run in SQL, before `LIMIT` | 1 | `visibility.ts` used by every read path; hidden-ordinal-1 test |
| 80 | A list is never empty, and only `writeMessage` inserts a message | 1 | `toColumn`, the `cardinality` CHECKs, boundary rule `sync/messages-written-by-one-writer`; schema and ops tests |
| 81 | A card carries no URL; the redirect goes only to the named actor | 4, 5 | `connections.ts`, the `access_request` part shape; connection tests |
| 82 | An agent reaches a connection only through a permission naming it | 5, 7 | `broker.ts` step 7, and in step 7 also before a search; per-agent permission test |
| 83 | Nothing learned for one invoker is given to a run for another | 5 (recorded) | `transcript.ts` builds per invoker. No sessions or memory exist to violate it |
| 88 | An access card is public, only its actor acts on it, and its state changes for everyone through `message.updated` | 1, 5 | `updateMessage` and the version rule (1); `access.ts` actor check, resolution in one transaction (5); actor-only and resolve tests |
| *New, numbered when folded* | **What a tool call names is resolved against our catalogue**: the tool must exist, not be deprecated, be in an enabled toolkit, and its effect comes from the catalogue — never from the model | 7 | `checkpoints.ts` step 5; `call_tool` refusal tests |
| *New, numbered when folded* | **A provider's search response never reaches the model**; the server builds the result from it | 7 | `broker.ts` `find_tools`; the test that the recorded response's profile and guidance are absent |

---

## 16. Not in this plan

The proposal's [deliberately not built (§13)](WORKSPACE-AGENTS.md#13-deliberately-not-built),
with the checkpoint each would change, so that building one later starts from
the right file.

| Deferred | Where it lands |
|---|---|
| One run at a time per agent per thread | `admitRun`: `defer('thread_busy')`; `onRunEnd` wakes the next |
| Steering a running run with a follow-up | `invocationsFor`: return *steer* |
| Agent sessions across turns; agent memory | `onRunEnd` and `transcript.ts`, under invariant 83 |
| Approval before write or destructive tools | `beforeToolCall`. `agent_tools.approval` was reserved for it; step 7 drops that table, so an approval lands on `agent_permissions` |
| Invoker-only replies with Share | `deliverReply`: `post({ listed: [invoker] })` |
| Pausing a run while someone connects | `beforeToolCall` and the runtime's out-of-band results |
| Retrying a run that failed | `onRunEnd`, once `agent_tool_calls` becomes a result marker. Re-running after a card resolves is built in step 7 (D25) |
| Several accounts per toolkit | `connections` unique index; the card's picker |
| A workspace allow-list of toolkits | `beforeToolCall`. Step 7 limits search to `toolkits.enabled`, which is per deployment, not per workspace |
| Disconnecting on deactivation | `apps/server/src/workos/poller.ts`, beside its `recordActor` |
| Scheduled or triggered agents; agents invoking agents; external agents; person-to-person restricted messages | Separate designs |
| Telling the sender an agent they mentioned is not in the space, with an Add button | `invocationsFor` already skips such an agent silently. Deferred by the dev on 2026-09-15: for now, nothing happens |

---

## 17. Open questions carried

From the proposal's [open questions (§15)](WORKSPACE-AGENTS.md#15-open-questions),
plus what this plan raised.

| Question | Blocks | Decide by |
|---|---|---|
| ~~Per-toolkit or per-tool permissions~~ — per toolkit, with an effect ceiling (step 4, confirmed by D23) | — | Decided |
| ~~The tool cap~~ — gone with the editor's Tools section (D21) | — | Decided |
| Cost visibility and ceilings | Nothing in v1 | Before production traffic |
| Group DMs with an agent | Nothing until DMs exist | With DMs (D2) |
| Catalogue refresh frequency; deprecated pinned tools | Step 4's refresh | Before step 4 ships |
| **Retention of `agent_runs.config`, `agent_tool_calls.arguments` and `access_requests`** — raised here | Nothing in v1; an audit trail with no retention grows for ever | Alongside `DESIGN.md`'s retention (§13.6) |
| **Whether the dev-only restricted-message route survives after step 3** — raised here | Nothing | Kept while restricted messages are dormant: it is their only writer, and what the by-hand check uses |
| **Whether an untouched access card expires with time**, and after how long — raised by D15 | Nothing in v1. With automatic re-runs (D25), a card resolved weeks later would start a stale request | **Deferred by the dev, 2026-09-15.** `access_requests.created_at` is when a card was raised, which is all an age-based expiry needs |
| **Which account an unpinned session uses** when a person has an `EXPIRED` and an `ACTIVE` account for one toolkit — raised by the discovery spike | Nothing while D24 pins | If pinning is ever dropped |
