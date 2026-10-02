# Activity

> **Status: a proposal, nothing built.** One ephemeral primitive — *someone is
> doing something in this chat, right now* — that typing indicators use first
> and the agent working indicator moves onto. It generalises `agent_activity`
> (`WORKSPACE-AGENTS.md` §5.7, built in `apps/server/src/agents/activity.ts`)
> rather than adding a second mechanism beside it. §11 lists the edits the
> other documents need; where one has not landed, that document wins.
>
> **The recommendation in one line:** lift the run register into a generic one
> keyed by `kind`, add a client → server `activity` frame, and ship typing as a
> WhatsApp-style bubble at the foot of the chat.

**Last updated:** 2026-10-02

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **Activity** | One actor doing one thing in one chat (or thread), now. Pushed, never stored, gone when it expires. |
| **Kind** | What the activity is: `typing`, `run`, and later others. Decides the policy (§3.2) and the surface (§7). |
| **Key** | What makes one activity distinct from another of the same kind. `run`: the run id. `typing`: actor plus connection. |
| **Entry** | The server's in-memory record of one activity: its key, `seq`, state and expiry. |
| **TTL** | How long an entry lives without being refreshed. Sent as `ttl_ms`, measured by each receiver from arrival. |
| **Typing bubble** | The bubble at the foot of the message list showing who is typing (§7). |

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| One mechanism or one per feature? | **One**, with a `kind` discriminant. Three kinds are already in sight (typing, runs, the ambient question in §9). | 3 |
| Stored anywhere? | **No.** Not in Postgres, not in `sync_events`, not in the replica. `DESIGN.md` §4 already rules this for typing and presence. | 3 |
| How does it end? | **By expiry, always**, and by an explicit `ended` when the sender can send one. A closed laptop sends nothing. | 3.3 |
| Whose clock decides expiry? | **The receiver's**, from `ttl_ms` relative to arrival. No absolute timestamps cross the wire. | 4.2 |
| Who may send typing? | Anyone `can()` lets post in that chat. Checked on every frame, on the server. | 5.2 |
| Who receives it? | The chat's audience, resolved on the server — the same audience `agent_activity` uses. Never a list the client names. | 5.3 |
| Is the typist's own key trusted from the client? | **No.** The server derives it from the socket. | 5.2 |
| Does it go through the outbox? | **No.** Sent only while connected; a typing frame replayed after reconnect would be a lie. | 6.1 |
| What does it look like? | **A bubble with the typist's avatar and three dots**, where their next message will land (§7). | 7 |
| Large chats? | **No typing above 100 members** in v1. | 10 |
| Does `agent_activity` go away? | **Yes, after one release of sending both.** | 8 |
| Ambient "on it" | **Open — the product rule is not this doc's to change.** | 9 |

---

## 2. What it is for

Alice and Bob both have #eng open. Carol is in #eng but looking at #design.

| When | Alice's client | Server | Bob sees |
|---|---|---|---|
| **0.0 s** | First keystroke. Sends `activity {kind:'typing', state:'active'}` | Checks Alice may post in #eng; entry `alice·conn-7`, `seq 0`; pushes to the audience, skipping Alice | A bubble with Alice's avatar and dots under the last message |
| **0–3 s** | Still typing; sends nothing — at most one `active` per 3 s | — | — |
| **3.1 s** | Sends `active` again | `seq 1`, `ttl_ms 6000` | Expiry restarts |
| **5.0 s** | Presses Enter: sends `ended`, then the message | Pushes `ended` | Bubble goes; Alice's message lands where it was |

Carol's client receives the same pushes and does nothing with them — no chat
open, no subscriber. If Alice closes her laptop at 4 s instead, the socket
closes, the server ends her entries, and if even that push is lost, Bob's
client drops the bubble at 6 s on its own.

Later, the same rails carry an agent's run: Triage is `running`, then
`running · <tool>`, then `ended` — exactly what `agent_activity` does today,
under a different `kind`.

---

## 3. The model

### 3.1 An entry

```ts
interface ActivityEntry {
  chatId: string;
  threadId: string | null;   // null: the chat itself; else the thread root
  actorId: string;
  kind: 'typing' | 'run';
  key: string;               // see §0
  seq: number;               // rises per key; a receiver drops anything lower
  state: 'active' | 'ended';
  label?: string;            // run: the current tool
  ref?: string;              // run: the run id, for Stop
}
```

`run`'s richer states (`queued`, `waiting`) collapse to `active` plus `label`.
Neither is sent today (`WORKSPACE-AGENTS.md` §5.7 names them; the dispatcher
only pushes `running` and `ended`), so nothing is lost.

### 3.2 Policy per kind

Everything that differs between kinds lives in one table, in code beside the
register. Adding a kind is a row here, a component in §7, and nothing else.

| | `typing` | `run` |
|---|---|---|
| Sent by | A client | The dispatcher |
| TTL | 6 s | none — ended explicitly, refreshed every 60 s |
| `ended` final for the key? | No — Alice can type again | Yes — stops a late label after the answer |
| Skip the sender? | Yes | n/a |
| Refresh for reconnecting clients | No — missing who is mid-sentence is fine | Yes, every 60 s (today's `REFRESH_MS`) |
| Audience cap | 100 members | none |
| Server rate limit per key | 1 push / s | none |

### 3.3 Why expiry is the primary end

An `ended` frame needs a sender that is still there. A person's laptop lid, a
network change and a crash all end typing without one. So expiry is what is
guaranteed and `ended` is what makes it prompt — never the other way round,
or a lost frame leaves "Alice is typing" up for ever.

---

## 4. Wire

### 4.1 Client → server

```ts
activity: { chat_id: string; thread_id: string | null; kind: 'typing'; state: 'active' | 'ended' }
```

No key, no actor, no device: all three come from the connection (§5.2), for
the reason `Hello` carries none of them.

### 4.2 Server → client

```ts
activity: {
  chat_id, thread_id, actor_id, kind, key, seq,
  state: 'active' | 'ended',
  ttl_ms?: number,           // absent: lives until ended (runs)
  label?: string, ref?: string,
}
```

### 4.3 Compatibility

Both directions are additive. An older server logs `sync.frame.unknown` and
carries on (`socket.ts`, invariant 43); an older client falls through
`link.ts` without acting. A newer client meeting a `kind` it does not know
ignores it, which is what lets kinds be added without a version bump.

---

## 5. Server

### 5.1 The register

`apps/server/src/sync/activity.ts`, lifted from `agents/activity.ts`: the
`Map` of entries, `seq` per key, the sweep, the refresh and the audience
lookup. `agents/activity.ts` becomes a caller passing `kind: 'run'`. In memory
only, which is correct under the one-instance rule (`DEPLOY.md`); more than
one server is Redis pub/sub, as `STACK.md` already plans for fanout.

### 5.2 Accepting a typing frame

A new `onActivity` branch in `socket.ts`, after authentication:

1. `kind` must be one a client may send — `typing` only.
2. `can()`: may this actor post in this chat — and, with a `thread_id`, reply
   in that thread? If not, drop silently and count it.
3. Key is `actorId · connectionId`, from the socket.
4. Rate limit per key (§3.2). A modified client cannot flood a room.
5. Hand to the register, which pushes.

When a connection closes, every entry keyed to it is ended.

### 5.3 Audience

The `chatAudience` lookup `agents/activity.ts` uses today: space members,
narrowed to chat members for a private chat. Typing runs it every 3 s per
typist, so it gets a short cache (a few seconds, keyed by chat) — membership
changing mid-sentence is harmless, and a person removed from a private chat
learning one more "Alice is typing" is not a disclosure worth a query per
frame.

---

## 6. Client

### 6.1 Sync process

`link.ts` gains `sendActivity(frame)`, exposed through the bridge. It sends
only on an open socket and drops otherwise — never the outbox. Incoming
`activity` frames forward to the renderer on one `activity` channel, verbatim,
as `agent_activity` does today. On disconnect and on `welcome` it posts a
`reset` so the renderer clears everything it holds.

### 6.2 Sending typing, in the renderer

Hooked into `MessageComposer`'s `onUpdate`, which already saves the draft on
every change:

| Event | Sends |
|---|---|
| A change that leaves content non-empty, and no `active` in the last 3 s | `active` |
| Send, content cleared, chat or thread switched, composer unmounted | `ended` |
| 5 s without a change | `ended` |

Workspace chats only; local rooms have no other viewer.

### 6.3 Receiving

`useChatActivity(chatId)` becomes kind-aware and returns `ActivityEntry[]`:

- Drops a lower `seq` than held, per key (today's rule).
- `ended` removes the key; for a kind whose `ended` is final, later frames for
  that key are dropped too.
- Each entry with `ttl_ms` gets a local timer from arrival; firing removes it.
- `reset` clears all.
- Unknown `kind`: ignored.

Callers filter: `entries.filter(e => e.kind === 'typing' && e.threadId === null)`.

---

## 7. The typing bubble

### 7.1 What it looks like

Like WhatsApp: a bubble in the message list itself, start-aligned where the
typist's next message will appear, holding three dots that pulse in turn,
with the typist's avatar beside it.

```
  ┌──────────────────────────────┐
  │ Bob: deploy went out at 3    │
  └──────────────────────────────┘
(A) ┌───────┐
    │ • • • │
    └───────┘
```

It is built from what a message already is — `Message`, `MessageAvatar`,
`Bubble`, `ActorAvatar` (`ChatBubble.tsx`) — so it inherits spacing, the
avatar column and theme, and sits exactly where Alice's message will land.
When it does, the bubble is replaced rather than jumping.

### 7.2 Several people

| Typing | Shown |
|---|---|
| One | Their avatar, one bubble |
| Two or three | Overlapping avatars, one bubble |
| Four or more | Three avatars and `+N`, one bubble |

One bubble, not one each: stacked dot bubbles push the conversation up for
nothing. The avatar is the name — no "Alice is typing" text — with the names
in the accessible label and a hover tooltip.

### 7.3 Behaviour

- **Placement.** The last item in the `MessageScroller`, after the newest
  message. It follows the scroller's stick-to-bottom: pinned if the reader is
  at the bottom, never scrolls them if they are reading history.
- **Grouping.** It does not join the previous message's group even when the
  same person wrote it — it always shows the avatar, because it is the only
  thing saying who.
- **Threads.** Entries with a `thread_id` render in the thread pane for that
  thread, never in the main chat.
- **Motion.** The dots pulse; under `prefers-reduced-motion` they are static.
  The bubble fades in after a short delay (~300 ms) so a single stray
  keystroke does not flash one.
- **Accessibility.** `role="status"`, `aria-live="polite"`, label "Alice and
  Bob are typing". Announced on change, not every refresh.
- **Agents.** Never typing. An agent's activity is a run, drawn by
  `RunIndicator` under the message it answers.

---

## 8. Runs on the same rails

1. The server sends both `agent_activity` and `activity {kind:'run'}` for one
   release; the renderer reads only `activity`.
2. Once the minimum supported client (`RELEASE.md`) is past that release,
   `agent_activity` is removed from `frames.ts`, `link.ts` and the bridge.

The move fixes one thing on the way: `finishDelivery` sends `ended` with
`threadId: run.chatId` (`dispatcher.ts`) rather than the reply's thread.
Harmless today because the renderer deletes by run id; wrong as soon as
anything routes by thread.

---

## 9. Ambient answers — open

`AMBIENT-RESPONSES.md` §3 rules **no working indicator** for ambient jobs:
"Triage is working…" appearing unbidden and then vanishing when the draft
check holds the answer back. The framework can carry an ambient kind either
way; the product rule is the question.

| Option | What people see | Cost |
|---|---|---|
| **a. Silence** (today) | Nothing until an answer | None |
| **b. "Looking", to the asker only** | The asker sees the agent's avatar in a soft state on their own question | A held-back draft disappoints one person, not the room |
| **c. "Looking", to the room** | Everyone sees it | Overturns the rule and its rationale |

Not decided here. Whichever is chosen is a row in §3.2 and a component in §7.

---

## 10. Limits and scale

- **Fan-out.** Each typist pushes to the whole audience every 3 s, open chat or
  not (R2 delivers to every space, not just the open one). The cap — no typing
  in chats over 100 members — bounds it in v1. Beyond that, a client tells the
  server which chat it has focused and typing goes only there; losing a push
  is cosmetic, so the subscribe-on-open `DESIGN.md` rejects for the log is
  safe here.
- **Server restart.** `seq` restarts from 0, but every client reconnects and
  `welcome` resets, so no client holds a higher `seq` to drop it against.
- **Two devices.** Two keys, one actor; the bubble groups by actor.

---

## 11. Edits other documents need

| Document | Edit |
|---|---|
| `WORKSPACE-AGENTS.md` §5.7 | The working indicator is `activity {kind:'run'}`; `agent_activity` is the transitional name |
| `DESIGN.md` §4 / `SYNC-FLOWS.md` | Point "ephemeral state (typing, presence)" here |
| `FRONTEND.md` | The bridge's `activity` channel and `useChatActivity` |
| `OBSERVABILITY.md` | Counters for dropped frames (`unauthorised`, `rate_limited`, `over_cap`) — checked against its rules before adding |

---

## 12. Not built, on purpose

| What | Until |
|---|---|
| Presence (online / away) | Someone asks; it is a kind with a much longer TTL and a workspace audience |
| A typing badge in the sidebar | Chats people are not looking at do not need it |
| Typing in local rooms | They have no other viewer |
| Focus-scoped delivery | The cap in §10 is hit |
| "Recording a voice note" and similar | There is a thing to record |

---

## 13. Implementation plan

| Step | What | Done when |
|---|---|---|
| 1 | Lift the register into `sync/activity.ts`; runs become `kind:'run'`, still sent as `agent_activity`. Fix the `ended` thread id | Existing activity and dispatcher tests pass unchanged |
| 2 | Frames both ways in `@relayed/protocol`; `onActivity` in `socket.ts` with `can()`, rate limit, cap, connection-close ending | A test per rule in §5.2 |
| 3 | `sendActivity` and the `activity` channel through `link.ts` and the bridge; `reset` on disconnect and `welcome` | Tests on a mocked socket |
| 4 | `useChatActivity` kind-aware with TTL timers; composer sending | Hook tests for `seq`, `ended`, TTL, `reset`, unknown kind |
| 5 | The typing bubble (§7) | Two clients by hand (`MULTI-CLIENT-DEV.md`): one, two, four typists; laptop closed mid-sentence; scrolled up; thread; reduced motion; light and dark |
| 6 | Dual send for runs; remove `agent_activity` a release later | Old client still shows the run indicator |
