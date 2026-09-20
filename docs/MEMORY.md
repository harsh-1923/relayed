# Memory

> **Status: proposed. Stage 0 is complete** — 2026-09-19, client
> `@vectorize-io/hindsight-client@0.10.0`, Hindsight Cloud, 16/16 over two runs
> ([`spikes/hindsight/`](../spikes/hindsight/README.md)). **Every recalled fact
> carries its tags, so the bank map in §5.2 stands.** Findings are folded into
> §5.3, §6.4, §7.2 and §9. **Spike B has also run** — episodes captured 14/14
> ground-truth facts against per-message's 10/14, for less than half the tokens
> (§6.1). **Stage 0 is complete; stage 1 can start.**
>
> **The doc is two phases.** Phase one (§1–§13) is memory for agent replies and
> is complete on its own. Phase two (§14) renders the same facts for people —
> a room timeline that replaces the summary, and an admin view that says whether
> any of it is working. Phase two changes nothing in phase one.

---

## 0. Words used here

| Word | Means |
|---|---|
| **Fact** | One thing memory holds: *"Bob Iyer owns the rollback script."* Derived from messages by a language model, never written by a person. |
| **Bank** | Hindsight's storage boundary. `recall` runs inside exactly one bank and there is no cross-bank query, so a bank is a wall rather than a filter. |
| **Episode** | The unit we ingest: a stretch of conversation in one chat that has gone quiet. |
| **Retain** | Handing Hindsight an episode. It extracts the facts. |
| **Recall** | Asking a bank a question in English and getting facts back. |
| **Document** | What one retain call stores under an id we choose. Deleting it removes every fact extracted from it. |
| **Watermark** | How far memory has read in a chat, by ordinal. |
| **Memory writer** | The actor whose space membership decides what may be ingested. Relay Roomkeeping, or its successor. |

---

## 1. What this decides

1. **Memory belongs to the place, not to the agent** (§4). An agent carries
   nothing between spaces.
2. **Banks are the permission boundary, not tags** (§5). Decided on evidence,
   not preference — a production incident elsewhere, recorded in §9.
3. **A fact reaches a room only if every member of that room could already read
   its source** (§5.1). The audience, not the invoker. This is the one rule.
4. **The ingestion unit is an episode, not a message and not a fixed window**
   (§6.1), because facts live between messages.
5. **Recall runs on every agent run and is injected, not offered as a tool**
   (§7.3) — with a staleness guard, because the one team who tried plain
   injection abandoned it.
6. **Every retain carries a `document_id` we choose** (§8.3), which is what makes
   forgetting a single cascading call rather than an unsolved problem.
7. **Public → private is enforced at recall from live state**, never by moving
   documents (§8.2).
8. **Hindsight Cloud now, self-hosted when there is real usage** — the decision
   that changes is which extraction model we may choose (§13).
9. **Human-facing surfaces are phase two, not phase one** (§14). The agent path
   ships and proves itself first; the timeline and the admin view are then built
   on the same facts, and are also the only instruments that say whether those
   facts are any good.

---

## 2. The idea in one picture

```
   #payments (public channel)              a run in #payments
   ┌────────────────────────────┐          ┌──────────────────────────────────┐
   │ Priya: anyone seen checkout│          │ @triage                          │
   │        500s spiking?       │  ──────▶ │                                  │
   │                            │  recall  │ Remembered, with citations:      │
   └────────────────────────────┘          │  · a matching error in #infra    │
                                           │    traced to a stale statistics  │
   #infra, six weeks ago                   │    table  [#infra, 2 Sep]        │
   ┌────────────────────────────┐          │  · Bob Iyer owns that path       │
   │ Bob: found it — the stats  │  retain  │    [#infra, 2 Sep]               │
   │      table was stale       │  ──────▶ │                                  │
   │ Ana: nice, who owns it?    │  (bank)  │ …then the last 40 messages,      │
   │ Bob: me, I'll keep an eye  │          │    then the request.             │
   └────────────────────────────┘          └──────────────────────────────────┘

   #incident (private room @triage is also in)
   ┌────────────────────────────┐
   │ never reaches the reply.   │   Not because the agent is discreet.
   │ Its bank is not a bank     │   Because that bank is not opened here,
   │ this run opens.            │   and no query can cross one.
   └────────────────────────────┘
```

---

## 3. Why memory and not search

Relayed already has full-text search (`DESIGN.md` §13.4, *Search*). Search finds
messages containing your words. Memory holds facts assembled **across** messages.
The gap between those is the entire justification:

```
Priya:  who's picking up the rollback script?
Bob:    on it, PR up in an hour
```

The fact is *"Bob owns the rollback script."* It appears in neither message —
it exists only in the adjacency. Search cannot reach it at any quality of
ranking, because there is no document to rank. A language model reading the pair
produces it immediately.

Chat is elliptical: people use pronouns, drop subjects, and answer in fragments.
So the facts that matter most in a conversation — ownership, decisions, root
causes — are disproportionately the ones that live between turns. **That is what
memory buys, and it is the only thing that could not be bought more cheaply.**

---

## 4. The four principles, and the failure each prevents

### 4.1 Memory belongs to the place, not to the agent

A fact is the room's. `@triage` does not know things; it reads what the room
remembers, the way a person who scrolled up would.

**The failure this prevents:** an agent is the one participant in every room.
Give it a memory of its own and it carries what it learned in a private incident
room into a public channel three days later, with no access predicate anywhere
in the path to stop it. Spaces already carry a membership list, and that list is
already the answer to "who may know this" — attaching memory to spaces inherits
the answer instead of inventing a second one.

This is the same reasoning as space membership being the leading conjunct of chat
access (`DESIGN.md` §7.3, *Membership and access*): one member list, one answer.

### 4.2 Memory never widens who may know something

It makes findable what was already readable. It discloses nothing new.

**The failure this prevents:** a memory layer that can tell you something you had
no right to see is not a feature. Note this bounds the product honestly — a run
can surface *what the asker could have found but did not*, never *what the asker
may not see*. That ceiling is most of the value and all of the safety.

### 4.3 Memory is derived, never original

Every fact traces to real messages. Memory authors nothing.

**The failure this prevents:** two, actually. An uncited fact is
indistinguishable from a hallucination, and this is a feature whose whole value
is telling people things they did not know — so citation is what makes it
trustworthy rather than unsettling. And when a message is deleted, derivation is
what tells us which facts to drop.

### 4.4 Recall happens without being asked

Every run, automatically.

**The failure this prevents:** a model that recalls only when it thinks to will
mostly not think to. The goal is answers richer than the question deserved, and
an opt-in mechanism does not produce that.

---

## 5. Access: banks are the boundary

### 5.1 The audience rule

> **A fact may be used in chat C only if every member of C could already read the
> conversation it came from.**

Not "the invoker". The audience.

This is deliberately **stricter than the transcript's rule**, and the difference
is worth stating because the code invites the mistake. `buildTranscript`
(`apps/server/src/agents/transcript.ts`) uses `visibleToBoth` — the agent ∩
invoker intersection that delegation requires (`DESIGN.md` §6.4, *Delegation:
agents acting on behalf of humans*). That is right **there**, because the
transcript is the chat's own messages, already visible to everyone in it.

A recalled fact comes from elsewhere and gets *spoken into* the chat. The reply
is visible to the whole audience, so the fact must be too. `audienceFor`
(`apps/server/src/sync/fanout.ts`) already computes exactly that set.

Getting this wrong is the single failure mode of the whole layer: a fact read
legally by Alice, then published into a channel Alice's DM partner is not in.

### 5.2 The bank map

Hindsight's own documentation states the property we build on: *"A bank is a
recall boundary. `recall`, `retain` and `reflect` all operate inside one bank,
and there is no cross-bank query. So 'should these two things share a bank?'
really means 'should a memory stored by A be recallable by B?'"*

That is precisely the question `access(actor, chat)` answers, so bank layout
**is** the permission model rather than a choice made alongside it.

| Bank id | One per | Holds |
|---|---|---|
| `ws:<workspace_id>` | workspace | facts from every **public** channel and public room, tagged by source space |
| `sp:<workspace_id>:<space_id>` | each **non-public** space | that space's facts, nothing else |
| `pr:<workspace_id>:<actor_id>` | each human | how that person wants to be worked with (§5.5) |

**Public spaces share one bank** because every workspace member may join them, so
a wall between them would separate things that are not separated. **Non-public
spaces each get their own**, because each one genuinely is a boundary.

**A bank id is derived from a ULID, never from a human-chosen name.**

An earlier draft of this said *"`workspace_id` is in every bank id"*, taken from
the live, unfixed bug in the xyne-spaces integration: `bankIdForAgent(slug)` let
same-slug agents in two orgs share one bank. **Their ids came from a slug, which
collides. Ours are ULIDs, which do not** — a space id is globally unique, so a
workspace id adds no separation to it.

Stage 1 also found it does not fit. `wsp_` and `spc_` ULIDs are 40 characters
each and a bank id caps near 63 (probed: 63 accepted, underscores and uppercase
fine). Two will not go. And truncating a workspace ULID to make room would take
its **time prefix**, which two workspaces created in the same millisecond share —
turning a permission boundary into a birthday problem.

So `mem_w_<workspace_id>`, `mem_s_<space_id>`, `mem_p_<actor_id>`, and
`workspace_id` rides on every `memory_documents` row instead, where an admin
count and a space sweep actually need it.

Bank count is *non-public spaces + humans + 1*. A thousand-person workspace with
two hundred private rooms holds about twelve hundred banks.

### 5.3 Why not tags — the evidence

Hindsight tags are a **hard filter at the database level**, not a relevance
weight, with five modes that differ on AND/OR and on whether untagged memories
come along:

| `tags_match` | untagged | condition |
|---|---|---|
| `any` *(default)* | **included** | has ≥1 of the tags |
| `any_strict` | excluded | has ≥1 of the tags |
| `all` | **included** | has all the tags |
| `all_strict` | excluded | has all the tags |
| `exact` | excluded | tag set is exactly this |

So one bank per workspace with everything tagged `space:…` is expressible, and it
is more elegant on every axis: one recall instead of two, cross-space
consolidation, and visibility transitions become a different tag list with
nothing to move.

**We are not doing it, because the team at `~/Documents/Git/work/xyne-spaces`
did, and it leaked.** Their digital twin is one shared bank with users separated
only by a `user:<id>` tag. From `apps/xyne-claw-auth/backend/src/routes/memory.ts`:

> *"For digital-twin we DO NOT trust Hindsight's tag-filter as a privacy
> boundary — incident 2026-05-25 confirmed the provider over-matches user-tag
> queries (returns ALL bank memories regardless of the tag we pass)."*

Every read path in that repo now re-filters in JavaScript; one over-fetches two
thousand rows because the provider's filter returns a mixed bag.

Two qualifications, recorded because they matter later:

- **Their `recall` never passes `tags_match`.** It sends a bare `tags` array, so
  the fail-open default `any` applies — which is documented to return *"matching
  tagged memories plus untagged/global memories."* The incident's root cause is
  therefore ambiguous between a provider bug and a default they never closed.
  The stage 0 spike narrows this, and the answer decides how much work the
  re-filter below is doing rather than whether it exists.
- **A bank fails closed and a tag filter fails open.** You cannot name another
  bank's memories; you can forget an argument. Even if tags were sound, that
  asymmetry is the one we want carrying a permission boundary.

### The re-filter is enforcement, not hardening — and this is easy to get wrong

Banks carry the boundary **between** spaces. But every public space shares
`ws:<workspace>`, separated only by a `space:<id>` tag, and public-versus-private
is enforced by the live tag list at recall (§8.2). **Inside the workspace bank,
therefore, a tag is carrying a permission boundary** — the exact configuration
that over-matched on 2026-05-25.

So the JavaScript re-filter is not defence in depth there. **It is the
enforcement**, and the tag filter in the query is a prefilter that narrows what
comes back. Saying this plainly matters, because "we already filter by tag" is a
perfectly reasonable-sounding argument for deleting the re-filter later, and it
would be wrong.

It works because `RecallResult` carries **`tags`** and **`document_id`** on every
returned fact. So even if query-side filtering over-matches, each fact can be
checked against the run's allowed space set before it reaches a prompt — the
thing xyne-spaces retrofitted after an incident, which we get to build in from
the start. That was assertion 1 of the stage 0 spike, and **it passed** (2026-09-19): every
recalled fact came back with its tags. Public spaces can share a bank.

The spike also found that `any_strict` did **not** over-match — scoped to one
space it returned seven facts against `any`'s nine, and the two extra were
*untagged* rather than the other space's. So the 2026-05-25 incident reads as the
fail-open default nobody closed rather than a provider bug. **None of which
changes anything here**: banks still carry the boundary, we still pass
`any_strict`, and we still re-filter. A filter that behaves today is not a
boundary, and the whole point of §5.2 is not having to trust one.

### 5.4 Space kinds, case by case

Relayed has four space kinds (`DESIGN.md` §7.1, *The containment model*). For
memory they differ in only three ways: whether membership is sealed, whether any
workspace member may join, and whether the space holds narrower chats inside it.

| Space | Ingests | Writes into | Recalls | Feeds the public bank |
|---|---|---|---|---|
| Public channel | yes | `ws:` | ws + person | **yes** |
| Private channel | yes | `sp:` | sp + ws + person | no |
| Public room — default and public chats | yes | `ws:` | ws + person | **yes** |
| Private room — default and public chats | yes | `sp:` | sp + ws + person | no |
| Any room — **private chat** | **no** | — | sp + ws + person | no |
| Group DM with an agent | yes | `sp:` | sp + ws + person | no |
| DM with an agent | yes | `sp:`, plus `pr:` on request | sp + ws + person | no |
| **DM between two humans** | **never** | — | — | no |
| Restricted message anywhere | **no** | — | — | no |
| System message (`message_kind = 'system'`) | **no** | — | — | no |
| Dormant or archived space | **no** | frozen | still recallable | unchanged |

Three of these rows need their reason stated, because each looks like a special
case and none is:

**A human-to-human DM is never ingested** — not filtered out, but unreachable.
No agent is a member, so no memory writer can read it, so no bank exists. *No
reader, no memory.* This is the same mechanism that keeps the room summariser out
of a room's private chats (`DOCUMENTS.md` §4.3, *What it may read*): membership
is the rule, so there is no second rule to get wrong.

**A room's private chat reads but never writes.** Everyone in it is a room member
— the leading conjunct — so reading the room's bank is safe. Writing is not: the
room's default chat could then recall it, and its members are not in the private
chat. A per-private-chat bank is deferred (§15).

**Mutable membership does not weaken a bank**, which is worth proving because
intuition says otherwise. Joining a space hands you the entire backlog (`DESIGN.md`
§7.4, *Visibility transitions* — joining is the gap case). So a new member may
already read everything ever said there, and a space-scoped bank is exactly as
wide as the space's own history, permanently.

### 5.5 The person bank, and the one semantic guarantee

The person bank is the only bank that crosses a space boundary, so it is the only
place where the guarantee is **semantic rather than structural**. Saying that
plainly is more useful than pretending otherwise.

It rests on a distinction no model honours reliably at recall time: *"Harsh wants
terse answers and thinks database-first"* changes how a reply is written;
*"Harsh is worried about the reorg"* is content and must never leave the DM it
was said in. So the distinction is enforced at **write** time instead:

- Written **only** by an explicit `remember` tool call the person asked for.
  Never by background extraction from their DM.
- **And the bank's own extraction mission refuses subject matter**, even when it
  is handed some — two layers, because this is the one place the guarantee is
  not structural. `PERSON_MISSION` takes preferences about how somebody wants to
  be worked with and explicitly rejects incidents, decisions, tickets, other
  people and anything that happened. An attempt to file a conversation here
  stores nothing, and the tool returns what was **actually stored** rather than
  what was asked, so the agent says so instead of claiming success.
- Offered on `MEMORY_RECALL`, not on Hindsight merely being configured: a
  preference nothing will ever read is not worth asking somebody to state.
- The DM's content bank (`sp:…`) is separate and never leaves the DM.
- Injected in its own labelled slot — *how this person likes to work* — never
  fused into the recalled-facts block.
- Listable and deletable by that person. It follows them into every room, so they
  must be able to see what it says.

`preferences` (`PREFERENCES.md`) is the structured half of the same idea and
already exists. The person bank is its unstructured complement, not a replacement.

---

## 6. Ingestion

### 6.1 The unit is an episode

```
episode = a run of messages in ONE chat, ending where the chat went quiet
          for QUIET_MINUTES (10), capped at MAX_EPISODE (60 messages) so a
          chat that never goes quiet is still cut and ingested.
```

**Why not per message. Measured here** — 45 real messages, 14 ground-truth facts
written before the run, three granularities into three banks
([`spikes/hindsight/`](../spikes/hindsight/README.md), 2026-09-19):

| | calls | facts | ground truth | cross-turn | self-contained | tokens | wall |
|---|---|---|---|---|---|---|---|
| per-message | 45 | 37 | **10/14** | 6/7 | 4/7 | 2,527 | 101 s |
| window-20 | 3 | 13 | **13/14** | 7/7 | 6/7 | 1,151 | 8 s |
| **episode** | 4 | 15 | **14/14** | **7/7** | **7/7** | 1,184 | 28 s |

Per-message loses on every axis at once: four fewer facts for **2.2× the tokens
and 12× the wall time**, while extracting *more* facts overall (37 against 15) —
it over-produces trivia per message and misses the specifics.

**The reason is not the one this section first gave.** The prediction was that
per-message would keep self-contained facts and lose cross-turn ones. The
opposite skew happened: 6/7 cross-turn, 4/7 self-contained. What it lost was
*"about 40% after six hours"*, *"QUARTZ runbook, section 4"*, and a bare PR link
— all labelled self-contained, and all of which turn out not to be. 40% of what?
A runbook for what? **In chat almost nothing is self-contained, including the
things that look like they are.** That argues for larger units more broadly than
the original reasoning did.

The same measurement elsewhere, on far more data
(`packages/xyne-claw-shared/src/memory/hindsight.ts` in xyne-spaces):

> *"Safe for transcript-sized input; **NEVER flip the old blob pipeline to
> verbose — verbose over a small dense blob produced ZERO facts twice in
> testing**."*

and from the same experiment:

> *"unsteered defaults produced thin generic facts; a domain mission + verbose
> extraction over a real transcript produced **10x richer atomic facts**."*

A per-message retain is exactly "a small dense blob". Same settings, transcript
versus blob: ten times versus zero. Per-message ingestion would also cost roughly
2–3× more, because the `context` field repeats per call — but the cost is not the
argument; the yield is.

**Why not a fixed count window.** A window cuts mid-exchange, and a decision
split from its rationale extracts as neither. Quiet is where conversations
actually end.

The spike caught this happening rather than arguing it. `window-20` missed
exactly one fact — the PR identifier — and its fact reads *"Dev Anand created a
rollback PR for the platform"* with the number dropped. The windows cut
`[20, 20, 5]`, and the message carrying the link is the **last of window one**,
its approval two messages later in window two. A window that cuts just after a
link drops the identifier.

One instance, not a statistic, and the margin is honest: **one fact in fourteen,
in one corpus.** The unambiguous result is per-message losing, not episodes
beating windows — but episodes cost nothing extra to take, because **the rule is
eight lines**: a fold over the messages comparing each gap to `QUIET_MINUTES`.
An earlier draft of this section treated episodes as meaningfully more machinery
than a window and suggested starting with the window. That was an overestimate.

**Why quiet is detected by polling.** The trigger is the *absence* of an event,
and you cannot receive an event for a non-event. This is a first-principles
justification, not an inheritance from the summariser job — which polls for a
different reason and, for memory, is wrong in two ways worth naming so nobody
copies them: its count threshold is a display heuristic (twenty "lgtm"s clear it
and contain nothing), and its periodic 400-message rebuild exists because a
summary restates current state and drifts. **Facts accumulate. Never re-read.**

**System messages are never ingested.** "Alice was added by Bob" is the server
recording its own successful command, not something anyone said, and memory is
about what people decided rather than membership bookkeeping. Filtered on
`messages.message_kind`, which `DESIGN.md` §8.1a (*System messages*) insists is
a real column precisely so nobody infers this from a shape. Found by reading a
real recall in stage 3, where *"Triage added Harsh to the room"* ranked **first**.

**Latency cost.** A fact is recallable about ten minutes after a conversation
ends. That is free: anything fresher is already in the forty-message transcript
`buildTranscript` builds. Memory's job starts where the transcript's ends.

**The scaling property this buys**, and the reason it beats the window on more
than quality: a fast-moving room produces one large episode per lull rather than
five fragments, so **cost per message falls as a room gets busier.**

### 6.2 What is filtered on the way in: nothing

**Decided 2026-09-19, reversing what this section first said.** Every episode is
sent. Extraction is the only thing that decides whether a conversation contained
anything worth remembering, and it is better at that than anything we would
write.

The earlier draft specified a local gate — a 200-character floor, an
all-messages-short test, a "nothing distinguishing" test — justified as a cost
control. **The arithmetic never supported it.** Retain is billed per input
token, so an episode's cost is proportional to its size, which means a filter
can only ever drop SMALL episodes: the cheap ones. A 110-character episode costs
about $0.0003. Dropping three thousand of them saves a dollar. The bill is made
of large episodes, and those pass any floor worth having.

**And it would have cost a real fact.** The stage 0 corpus's fourth episode was
110 characters — `lol`, `🎉`, `+1`, `thanks all` — and one person saying everyone
was being logged out every twenty minutes. Extraction kept exactly that and
dropped the rest. A 200-character floor would have thrown away the only thing
anybody learned that day to save three hundredths of a cent.

So the cost lever is not a filter. It is **which spaces have a memory writer in
them at all** (Rule 1, §4.1) — which makes cost track agent adoption rather than
raw traffic, and needs no heuristic to maintain.

What steers quality instead is `retain_custom_instructions`, which replaces
Hindsight's built-in extraction rules entirely (§6.4). The mission enumerates
what to keep, what to skip, and ends by giving extraction explicit permission to
return nothing:

```
Extract: decisions and who made them; who owns what work; blockers and their
causes; root causes and fixes; commitments with dates; references to systems,
tickets and documents.
Do not extract: greetings, thanks, reactions, scheduling chatter, questions that
were not answered, opinions stated in passing, or anything obvious from the room
name.
If nothing here is worth remembering, extract nothing.
```

"Questions that were not answered" is there because the stage 0 spike's one weak
fact was *"Sam Oyelaran is inquiring if the cutover is confirmed"* — a question,
not something anyone learned.

**And an episode is never compressed on the way in** — the rule that survives
now that nothing is filtered. Raw conversation, never a summary of one.
xyne-spaces killed an entire pipeline over this:

> *"instead of distilling a session into ≤1500-char subsystem blobs (**double
> compression**: our curator squeezes the transcript, then Hindsight's extraction
> squeezes the squeeze), queue ONE review row carrying the session transcript
> itself … 10x knowledge yield."*

**Tune the mission against real conversations, not by argument.** `POST
/dry-run/extract` runs extraction and returns facts *without storing*, so a
change to the instructions above can be checked against a real room for a few
cents and no committed code.

### 6.3 The retain call

```ts
await hindsight.retain(bankId, {
  content:
    'Alice Chen (@alice, act_01M2…) 2026-09-19T14:31:02Z: rolling back the index\n' +
    'rebuild first, then retrying the cutover — Bob is taking the rollback script\n' +
    'Bob Iyer (@bob, act_01M9…) 2026-09-19T14:33:40Z: on it, PR up in an hour\n',

  // Hindsight classifies each fact as `world` or `experience` BY WHO IS SPEAKING,
  // and assumes a bank belongs to an agent. A space bank has no agent, so without
  // this the room's conversation is filed as the lived experience of an assistant
  // that does not exist. Space banks hold `world` facts only.
  context:
    'A conversation in the #db-cutover room. The speakers are people and agents ' +
    'working in this room. None of them is the owner of this memory bank.',

  timestamp: '2026-09-19T14:31:02Z',

  // The forget handle (§8.3). Chosen by us, so deletion is one cascading call.
  documentId: `${chatId}:${ordStart}-${ordEnd}`,

  metadata: { spaceId, chatId, ordStart, ordEnd, messageIds },
  tags: [`space:${spaceId}`, `chat:${chatId}`, `kind:${space.kind}`],
}, { async: false });     // ← §11, backpressure
```

Lines are labelled with `personLabel` from `apps/server/src/agents/people.ts`, so
an actor reads identically to memory and to a transcript, with a timestamp added
— Hindsight needs speaker and time to place facts in time.

**`async: false`, always — passed, never assumed.** The client's own type says
the default is already `false`, but xyne-spaces' provider passed `true` and paid
for it. xyne-spaces left that default and paid for it
(`routes/memory.ts`):

> *"awaiting each call gives NO back-pressure: an unpaced loop submits the whole
> archive in about a second and Hindsight then fans `retain_extract_facts` out
> across every item at once. Its LLM key is capped, so that burst produces a wall
> of 429s … Those failures happen INSIDE Hindsight, after we already returned
> 200 — we never see them and cannot retry them."*

A failure we cannot see and cannot retry is worse than a slow loop. We take the
backpressure.

### 6.4 Bank configuration, and the persistence trap

```ts
{
  name: '#db-cutover',                    // the bank is a ROOM, not an assistant
  retain_extraction_mode: 'custom',
  retain_custom_instructions: MEMORY_MISSION,
  enable_observations: false,             // ← see below
}
```

**`enable_observations: false`, and it is load-bearing twice.** xyne-spaces
measured that the consolidation pass *"~2x-duplicates world facts; verified
experimentally 2026-07-17"*. The second reason is ours, found in the stage 0
spike: **an observation carries no `document_id`**, because it is consolidated
from several documents and has no single source — so an observation **cannot be
cited**, and §7.2's citation rule silently degrades the moment they are on.
Turning them on needs a measured reason and an answer to citation, not a hope.

**The trap, which cost somebody months** (`hindsight.ts` in xyne-spaces):

> *"PERSISTENCE GOTCHA (found 2026-07-17): Hindsight materializes the bank row
> lazily on FIRST retain. A config PATCH before that returns 200 and persists
> NOTHING — which is why production banks silently ran defaults for months."*

**It did not reproduce.** On client 0.10.0 against Cloud, a config write before
any retain persisted and read back correctly
([`spikes/hindsight/README.md`](../spikes/hindsight/README.md), 2026-09-19).

`ensureBank` still **PATCHes and then verifies with a GET**, because the call is
cheap and the failure mode is silent — a bank quietly running defaults is
exactly the kind of thing nobody notices for months. The warmup-retain fallback
stays specified and unbuilt: if a verify ever fails, this is the repair, and the
warmup document is tagged so §8.3 can reap it.

Cache the result keyed on **the configuration**, not on the bank id — xyne-spaces
again: *"A plain id-keyed cache let whichever caller ran first in a pod decide the
bank's config and silently pinned it."*

---

## 7. Retrieval

### 7.1 What a run recalls

```
run in chat C of space S, invoked by person P, replying into C

  ws:<workspace>    tags = live public space ids + S, any_strict  always
  sp:<S>                                                        if S is not public
  pr:<P>                                                        always, separate slot

  never: another space's bank · a private chat's bank · another person's bank
```

Each candidate passes the audience rule (§5.1) for a stated reason, not by
inspection:

- **The workspace bank** — every member of C is a workspace member, and a public
  space is joinable by every workspace member.
- **`sp:<S>`** — every member of C is a member of S. The leading conjunct of the
  access predicate, so this needs no separate check.
- **`pr:<P>`** — the one semantic guarantee (§5.5).

Two recalls in parallel (three with the person bank), fused by score, then
**collapsed for near-duplicates before ranking**. That last step is not optional;
xyne-spaces found it the hard way: *"Session-ingest extracts the same fact from
many overlapping sessions ('REDIS_HOST is…' x40); rerankers surface the copies
together and crowd distinct knowledge out of the top-N."*

`budget: "mid"`. Their 2026-07-20 retrieval eval measured `"mid"` against `"low"`
at **P@5 72% vs 62%**, and found score boosts made things *worse* (57–66%).

### 7.2 The injected block

Placed above the transcript, in its own labelled section:

```
── What Relayed remembers that may be relevant ───────────────────────────
These are recollections, dated, each citing its source. They may be out of
date. Anything in the conversation below overrides them.

 · Bob Iyer owns the rollback script for the db-cutover work
   [db-cutover, 19 Sep](message:msg_01M4…)
 · A matching index error in #infra was traced to a stale statistics table
   [#infra, 2 Sep](message:msg_01K9…)
──────────────────────────────────────────────────────────────────────────
```

### The footer: what the reply actually drew on

Inline citations alone are weak in three ways — they depend on the model keeping
the link, they interrupt the sentence they support, and they never answer *"did
this use memory at all?"*. So a completed reply also carries a **`memory` part**
(`@relayed/protocol`), drawn under it as a short list of what it cited, each
line clickable through to the conversation it came from.

**Drawn in the message footer, beside the copy button, on hover** — not as a
block under the reply. Provenance is something a reader reaches for when they
doubt an answer, not something that should sit under every answer competing with
it: an inline card pushed the reply up the screen and made a six-line recall
louder than the two-line answer it produced. The trigger is visible at rest when
the reply **cited** something and appears on footer hover when memory was merely
offered, so "this leaned on something remembered" is legible at a glance without
the detail being in the way.

**Built by the server**, from the facts it injected intersected with the
citations present in the reply — never from anything the model emits. It sits in
the same row of `AGENT-RESPONSES.md`'s who-controls-this table as `tool`: a
model writes text, never parts. On a person's message it is refused and undrawn,
because claiming to have cited memory is a costume like any other.

**Only what was USED**, never everything offered. Detection is by citation link,
not by resemblance — matching a paraphrase against a fact would be a guess
dressed as provenance. That **under-reports**, and that is the right direction
to fail: a footer claiming a reply used memory when it did not is worse than one
that occasionally stays quiet, and an empty footer is honest information — memory
was there and changed nothing.

**This is also `memory.facts.cited`** (§14.6). The footer and the only
measurement that answers *is memory consequential* are one computation
(`citedFacts`), which is why the footer is worth building before the metric.

### The query is the question, not the summons

`queryFrom` strips two different things, and conflating them cost a run. Link
**ids** go and their **labels** stay — an id is a long meaningless token the
keyword arm will rank on. But **the invoked agent's own mention goes entirely**,
label included: it is there to address the agent, not to describe what is being
asked about.

Measured 2026-09-20. `"triage What day is it today?"` returned six facts about
Triage — its restart, its tickets, its side chats — topping out at **0.460**.
The same question without the summons tops out at **0.031**: retrieval already
knew there was nothing there, and the agent's own name was manufacturing a
match out of every fact that named it.

It distorted a good question too. With the summons, the launch deadline ranked
**4th at 0.019**, behind an irrelevant fact at 0.633; without it, the deadline
ranks **1st at 0.132**. The run that looked like a success was the model
rescuing a bad ranking.

`stripOwnMention` is `transcript.ts`'s own, reused rather than rewritten — the
transcript has always dropped the summons and kept everyone else's mentions, and
two copies of that rule would be two chances to disagree.

### Asking for the citation, where it is actually read

The block asks the model to keep a fact's link. **That was not enough**, and the
first real run said so: six on-topic facts recalled, the reply answered straight
off the first one — *"Apollo and AWS AppSync are the two options being
considered"* — and cited none of them. The same reply carried
`[Harsh Sharma](actor-ref:act_…)` correctly, so the model was following
`PEOPLE_PROMPT` and ignoring an instruction sitting above a forty-message
transcript.

So the rule also goes **last, after the writing rules** — `dispatcher.ts`
already writes down why: *a rule right before the model writes outweighs the
same rule buried earlier*. It is emitted only when something was recalled, it
names the exact link form using **an id actually on offer** rather than a
placeholder, and it leans on the behaviour that already works: *the same kind of
link you already write for people, copied the same way*.

**The block says it is ordered.** `recallForRun` has always sorted by match
strength; until the header claimed it, the model had no reason to read the first
line as better evidence than the last, and six facts arrived looking equally
weighted — including ones that merely shared a word with the question. The
header now says strongest first, and says what that does **not** mean: matching
closely is not the same as being true or relevant, and a line low in the list
may have nothing to do with what was asked.

The raw score stays out of the prompt. A bare `0.132` means nothing to a model
with no calibration for it, and banding it into words needs thresholds picked
from more than four observations. Ordering carries the same signal with nothing
to get wrong. Scores also come from separate recalls, one per bank, so comparing
them across banks is approximate — good enough to order by, which is why the
header claims no more than that.

**Every fact carries a citation and a date.** This works because a recalled raw
fact carries its `document_id`, which `memory_documents` maps to a chat and an
ord range and so to the anchor message — verified in the stage 0 spike, along
with the limit that makes it conditional: **observations carry no `document_id`
and cannot be cited** (§6.4). The link form is the one the renderer already knows — `[what it says](message:msg_…)`, the same family as
`actor:act_…` and `space:spc_…` (`DOCUMENTS.md` §5.1, *The link form*).

### 7.3 Why injected, and not a tool

xyne-spaces moved the other way, and the reason is real
(`apps/xyne-claw/src/routes/run.ts`):

> *"No more inject-all-recalled-facts. Shared memory-enabled agents get the
> memory-search tool only; we intentionally do not inject a per-turn system
> reminder because that biases source-of-truth-first workflows (RCA, metrics,
> reports, code review) toward stale memory."*

**It does not transfer, and the difference is precise.** Their agents do root-cause
analysis and metrics — tasks where a live system is the truth and a remembered
fact competes with checking it. Our case is *who owns this* and *what did we
decide*, where the conversation **is** the source of truth and there is nothing
fresher to consult.

We keep injection, because principle 4.4 is the product. We borrow the guard: the
dated citations and the explicit "these may be out of date; the conversation below
overrides them" in §7.2 exist because of their finding. If stale-memory bias shows
up anyway, the tool is the fallback and it is the same `recallForRun` behind it.

---

## 8. Forgetting

### 8.1 Deletion

**`DELETE /v1/<tenant>/banks/<bank>/documents/<document_id>` is a real, permanent,
cascading delete** — it removes the document, every memory unit extracted from it,
and all temporal, semantic and entity links, returning `memory_units_deleted`.

This is worth stating loudly, because xyne-spaces concluded the opposite:

> *"Hindsight exposes NO hard per-id delete — `DELETE /memories/{id}` 405s … The
> per-memory removal is a curation op: PATCH the memory to state=invalidated."*

Both are true. Per-**memory** deletion is unsupported; per-**document** deletion
is. They could not use documents because their retain runs `async: true` and
returns no ids, so they had nothing to address. **We choose the `document_id`
ourselves, before the call, so it is always addressable.** Choosing it in §6.3 is
what buys the whole of this section, and it is the single highest-leverage
decision in this document.

**The tombstone problem, found while building this.** `messages.deleted` is a
tombstone — the row stays and keeps its ordinal for ever. So a sweep that looks
for *"documents covering a deleted message"* finds the same documents on every
tick, rebuilds them on every tick, and never converges. It would cost money
indefinitely and look like it was working.

The discriminator is **`messages.rev`**. `appendEvent` sets it on every message
an event touches (`sync/events.ts`, *the version rule*) from the chat's
monotonic counter, so any change to what a message looks like — deleted, edited,
audience narrowed — raises the highest revision inside a document's ordinal
range. `memory_documents.source_rev_max` records that high-water mark at retain
time, which turns *"has this changed"* into an integer comparison and makes the
rebuild **converge**: once rebuilt, the marks match and the document is left
alone. It catches edits too, which a deleted-flag check never could.

The sweep, on the ingest tick:

```
memory_documents ⋈ messages, grouped, HAVING max(rev) > source_rev_max
  → DELETE the document in Hindsight
  → re-retain the survivors, under the SAME id and the SAME ordinal range
  → set source_rev_max to the new high-water mark
  (no survivors → drop the row: nothing is left to remember)
```

The range stays where the episode was rather than shrinking to its survivors: a
narrowed range would leave the deleted message's ordinal covered by nothing, and
the next change to it would be invisible to the sweep.

**Deletion is eventually forgotten, bounded by the tick (~60 s).** That is a
decision, not an accident — §19 asks whether it is the right one.

### 8.2 Visibility transitions

**Public → private is enforced at recall, from live state.** The workspace-bank
recall passes a tag list of the spaces that are public *right now*, read from the
`spaces` table on every call, with `any_strict` so untagged facts are excluded too:

```ts
const tags = (await publicSpaceIds(db, workspaceId)).map(id => `space:${id}`);
```

A room converted at 14:32 is absent from the 14:33 recall. **Zero window.**

**The list is the public spaces PLUS THIS SPACE ITSELF**, and the second half is
not a convenience — it is what makes a conversion survivable. A public room's
facts live in the *workspace* bank tagged `space:<id>`, because it was public
when they were written. Dropping out of the public list is exactly what stops
every OTHER space recalling them. Without adding the space back for its own
runs, it would also stop the room recalling **its own history** — and nothing
would have moved those facts anywhere else, so the room would silently lose its
memory at the moment it was made more private.

Its own members may read its own history whatever its visibility is now: joining
a space discloses the whole backlog (`DESIGN.md` §7.4, *Visibility
transitions*), so this grants nothing the messages do not already. It is also
what makes the document move below genuinely optional rather than merely
deferred.

Not a document-move job, and the reason is the point: re-extraction is language
model work — minutes for a busy room — and every minute in which the facts stay
reachable is a *permanent* leak, because whatever the agent says gets read and
repeated. Moving documents afterwards is tidying, and may never be needed.

This is the same principle as the rest of the system: authorization evaluated
against the source of truth at the point of use, never against a cached copy.

Every failure mode of a positive list is "too few facts recalled", never "too
many".

| Event | Mechanism | Takes effect |
|---|---|---|
| Public → private | live tag list | **immediately** |
| Private → public | live tag list | **immediately** |
| Message deleted or edited | sweep (§8.1) | one tick |
| Space deleted | delete its documents, or `deleteBank` | one tick |
| Member added | nothing — joining already discloses the backlog | — |
| Member removed | nothing new — removal stops new data, it is not a recall (`DESIGN.md` §6.6, *Accepted exposures*) | — |
| Space dormant or archived | not ingested; still recallable | immediately |

### 8.3 The document index

Hindsight returns metadata with results but **metadata is not a filter**, so we
cannot ask it "which documents came from message X". We keep our own:

```sql
CREATE TABLE memory_documents (
  bank_id     TEXT    NOT NULL,
  document_id TEXT    NOT NULL,
  space_id    TEXT    NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  chat_id     TEXT    NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
  ord_start   INTEGER NOT NULL,
  ord_end     INTEGER NOT NULL,
  retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bank_id, document_id)
);
CREATE INDEX memory_documents_span ON memory_documents (chat_id, ord_start, ord_end);
```

One table, four jobs: forget a deleted message, drop a deleted space, move a
converted space's documents if we ever choose to, and answer "what has memory
read" without asking Hindsight. **It is built in stage 1, not as a follow-up** —
retrofitting deletion into a memory system is how a compliance problem is
discovered rather than designed.

---

## 9. What we verified, and what bit somebody else

Everything in this table is either checked against Hindsight's current API
documentation or taken from a dated finding in `~/Documents/Git/work/xyne-spaces`.
None of it is recall.

| Believed | Actually |
|---|---|
| Tags can carry a permission boundary | A production incident (2026-05-25) says the tag filter over-matched and returned a whole bank. Their reads now all re-filter in JavaScript. **Banks, not tags** (§5.3) |
| Recall is 100–600 ms, so it is free per run | Vendor's figure. Measured on a 2k-fact bank: *"7-11s"*. Their recall timeout is set to 60 s. **Recall costs seconds and grows with bank size** (§12) |
| Bank config can be set at create time | Hindsight materialises the bank row on **first retain**; a config PATCH before that returns 200 and persists nothing. Production banks ran defaults for months (§6.4) |
| Hindsight has no hard delete | True per **memory id**; false per **document id**, which cascades. They had no document ids because async retain returns none. We choose ours (§8.1) |
| Smaller ingestion units are cheaper and simpler | Verbose extraction over a transcript: 10× the facts. Over a small dense blob: **zero**, twice (§6.1) |
| Observation consolidation adds depth | *"~2x-duplicates world facts"*, measured. Off by default (§6.4) |
| `async: true` is the client's default for retain | **Wrong, and I had it from a blog post rather than the types.** `RetainRequest.async` documents "default: false". xyne-spaces' provider *passed* `async: true`, which is where their invisible, unretryable 429s came from. Our decision is unchanged — pass `async: false` explicitly rather than trusting a default (§6.3) |
| Putting the workspace id in every bank id is the fix for xyne-spaces' bank collision | **Half right.** Their bug was a **human-chosen slug**, not a missing workspace id. ULIDs do not collide, and two of them exceed the ~63-character bank id cap — while truncating one would take its shared time prefix. The rule is *derived from a ULID, never from a name* (§5.2) |
| Bank config can be written before the first retain | **Verified 2026-09-19 on client 0.10.0: it persists.** The trap that ran xyne-spaces' production banks on defaults for months does not reproduce. Keep the verify-by-GET (one call, silent failure mode); drop the warmup (§6.4) |
| A recalled fact can be traced to its source | **Only a raw fact.** `world` facts carry `document_id` and our `metadata`; **observations carry neither**, having several sources and no single one. Citations work exactly as long as observations stay off (§7.2) |
| `any_strict` over-matches, as it did on 2026-05-25 | **It did not, here.** Strict 7 / `any` 9, and the two extra were *untagged*, not the other scope. The incident reads as the fail-open default xyne-spaces never closed. **Changes nothing** — banks still carry the boundary, and we still re-filter (§5.3) |
| A deleted message can be found by its `deleted` flag | **It cannot, usefully.** The flag is a tombstone that never clears, so a sweep keyed on it rebuilds the same document for ever. `messages.rev` is the discriminator — the version rule raises it on any change, and a stored high-water mark makes the sweep converge (§8.1) |
| Retain being synchronous means the fact is immediately recallable | **No.** `async: false` bounds the write; indexing follows. Measured end to end: a retained fact became recallable after **~3 s**. Irrelevant in practice — memory is for conversations that ended minutes ago — but a test that retains and immediately recalls will fail and look like a bug in the wrong place |
| Hindsight can hold a document we read back | *"retain **shreds** a document into scattered LLM-extracted facts … a verbatim doc comes back as fragments."* Documents stay in Postgres (§15) |
| Content round-trips | Hindsight appends `\| Involving: … \| When: …` to what it stores; re-retaining its output compounds on every pass. **Never re-retain our own facts** |

---

## 10. Security, in one table

| Threat | What stops it |
|---|---|
| A fact from a private room reaches a public channel | The private room's bank is not opened by that run, and **no query can cross a bank** (§5.2) |
| A fact from a private chat reaches its room | Private chats are never ingested (§5.4) |
| A restricted message becomes a fact | Never ingested; `visibleTo` decides, not a rule (§5.4) |
| A human-to-human DM is mined | No agent member → no writer → no bank (§5.4) |
| A converted room stays recallable | The public list is read live on every recall (§8.2) |
| A deleted message stays remembered | Cascading document delete (§8.1), bounded by one tick |
| The provider's filter misbehaves | We re-filter results in JavaScript against the run's own allowed set (§5.3) |
| Text in a room steers ingestion | The ingest job has **no tools and no grant**. The worst an injection achieves is a wrong fact, which the citation exposes and the delete path removes |
| A person's preferences leak their DM's contents | The person bank is written only by an explicit `remember` call, never by extraction (§5.5) |
| One workspace's facts reach another | Every bank id is derived from a globally unique ULID, so no two spaces, workspaces or people can name the same bank (§5.2) |

---

## 11. Failure modes

| Failure | What happens | Why it is acceptable |
|---|---|---|
| Hindsight is down | Recall returns nothing; the run proceeds on the transcript alone. Ingestion backs off and the watermark does not advance | Memory is additive. A run without it is today's behaviour |
| Recall is slow | A per-call deadline (start 3 s) drops the block and the run continues | An answer late is worse than an answer less rich |
| Extraction returns nothing | The watermark still advances | An episode with no facts is a fact about the episode |
| A 429 storm inside Hindsight | Prevented by `async: false` plus paced batches (§6.3) | The alternative is invisible, unretryable loss |
| Two servers ingest one space | The lease, claimed with a conditional update | Same shape the summariser job already uses |
| A fact is wrong | The citation exposes it; the source messages are one click away | Memory is derived, so it is always checkable (§4.3) |
| A fact is socially awkward | Extraction is told to skip opinions stated in passing; citation and date make it read as a pointer, not a verdict | Real, and §19 keeps it open |

---

## 12. Observability

Proposed, per the rule that instrumentation is agreed before it is added
(`AGENTS.md`, *Observability is part of the feature*). Each marker is paired with
the question it answers; the case for **not** adding one is in the last row.

| Marker | The question it answers |
|---|---|
| `memory.recall.duration` histogram, by bank kind | *Is recall inside its deadline?* The vendor says sub-second, a real deployment measured 7–11 s. This is the number that decides whether recall stays on every run |
| `memory.recall.deadline_exceeded` counter | *How often does a run answer with no memory?* Silent degradation is the failure we would otherwise never see |
| `memory.retain.duration` histogram | *Is ingestion keeping up?* Pairs with the lag gauge to separate "slow" from "stuck" |
| `memory.ingest.lag_messages` gauge, by workspace | *Is any space falling behind its watermark?* A wedged lease and an idle workspace look identical without it |
| `memory.episodes.empty` counter | *How often does an episode produce no facts at all?* With nothing filtered on our side (§6.2), this is the signal that the mission is mis-tuned — and it is a count, carrying no message text |
| `memory.facts.returned` histogram | *Is recall returning nothing, and since when?* An empty block is how this feature dies quietly |
| `memory.documents.deleted` counter | *Is the forget path actually running?* A deletion path nobody can see is one nobody trusts |
| Span `memory.recall` as a child of the run span | *Where did a slow run's time go?* The run trace already exists; this makes memory a visible segment of it |
| ~~Per-space or per-bank recall counters~~ | **Deliberately not added.** An unbounded id as a metric label is a hard limit (`OBSERVABILITY.md`) — a thousand banks is a thousand series for one metric. Bank *kind* is bounded and answers the same operational question |

Two compile-time limits apply unchanged: **no message body and no fact text in
telemetry, ever**, and no unbounded id as a label.

---

## 13. Cost

Hindsight Cloud, pay as you go: **retain $10.00/M input tokens**, **recall
$0.75/M**, **storage $0.25/M/month** (free for the first 30 days), reflect
$0.05/call.

A reference workspace — 100 people, ~10k messages/day in spaces with an agent
member, ~200 runs/day:

| | Volume | Monthly |
|---|---|---|
| Retain | ~500 episodes/day × ~900 tokens | **~$135** |
| Recall | 200 runs × 2–3 banks × ~6k tokens | **~$80** |
| Storage | facts ≈ 15% of input, cumulative | **<$10** in year one |

Three things this implies:

- **Retain is 13× recall per token.** So the optimisation target is ingestion, not
  recall. Recall on every run is affordable; do not design around avoiding it.
- **`reflect` never runs in a run.** Ten times a recall, and 800–3000 ms of
  generation in the critical path.
- **Cost tracks agent adoption, not raw traffic**, because ingestion only happens
  where a memory writer is a member. That is principle 4.1 paying for itself.

The billable unit for recall is not precisely defined on the pricing page — this
assumes tokens processed and returned. **Confirm before anyone budgets on it.**

**On Cloud, the cost lever is Rule 1 — which spaces have a memory writer in
them** (§6.2). Self-hosting later adds a larger one: extraction is a structured-output task over a few hundred tokens and
does not need a frontier model. That is the trigger to revisit, not a date.

---

## 14. Phase two: the room timeline and the admin view

> **Phase one is §1–§13, and it stands complete without anything here.** It makes
> agent replies richer. Nothing in this section changes its access model, its
> ingestion path or its retrieval path — it renders the same facts for people
> instead of for a model, and it is built only once phase one is running.
>
> It has a second job, less obvious and more important: **phase one ships with no
> instrument that says whether the facts are any good.** These two surfaces are
> that instrument. That is why they come early in phase two rather than last.

### 14.1 Two surfaces, and they are not the same product

| | **Room timeline** | **Memory inspector** |
|---|---|---|
| Who | every member of the room | workspace admins |
| Question | *how has this room progressed* | *is the pipeline working, and is what it forms consequential* |
| Freshness | **historical** — an entry must not change retroactively | live |
| Source | **our own replicated rows** | Hindsight, read live |
| Offline | works | does not, and should not |

Conflating them is the trap. One is member content under the local-read rule
(`DESIGN.md` §3, *What "local-first" means here*); the other is an operator tool
that is deliberately **more** restricted than the member model, not less (§14.6).

### 14.2 The timeline replaces the room summary

`DOCUMENTS.md` describes a room summary maintained by a job that re-reads
messages: a threshold, a lease, an incremental body, and a periodic 400-message
rebuild because a restatement of current state drifts.

**Once memory exists, almost all of that is unnecessary**, because an episode is
already a timeline entry. It has a time range, participants, an ord range — so
"jump to the conversation" needs no extra lookup — and, after ingest, its facts.

Split by what genuinely needs synthesis:

| Layer | Needs a model? | Refresh |
|---|---|---|
| **An entry**, one per episode | No — facts are the bullets, entities give the title | **written once, never again** |
| **The header**, two or three sentences | Yes; it is synthesis across entries | occasionally |

The consequence is the point: **the timeline is append-only.** No incremental
body, no rebuild window, no drift, no watermark for prose. Only the header is
ever regenerated, and it is two sentences over facts rather than four sections
over four hundred messages.

**The timeline is a projection, never a source of truth.** No agent reads it; no
recall touches it. That is what licenses it to hold a second copy of the fact
text (§14.3) — it cannot disagree with anything, because nothing depends on it.

### 14.3 Three tables

**One — `memory_documents`, server only.** Already specified in §8.3. It holds a
vendor's identifiers, so **it never enters the sync protocol or any replica.**
Its job is the forget path and knowing what has been ingested.

**Two — `room_timeline_entries`, new, replicated.**

```sql
-- server
CREATE TABLE room_timeline_entries (
  id                TEXT PRIMARY KEY,              -- tle_…, a ULID
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id          TEXT NOT NULL REFERENCES spaces(id)     ON DELETE CASCADE,
  chat_id           TEXT NOT NULL REFERENCES chats(id)      ON DELETE CASCADE,

  -- where in the conversation, so a click needs no second lookup
  ord_start         INTEGER NOT NULL,
  ord_end           INTEGER NOT NULL,
  anchor_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,

  -- when it HAPPENED — the messages' time, never the ingest time. A timeline
  -- that reorders itself because a backfill ran late is not a timeline.
  occurred_start    TIMESTAMPTZ NOT NULL,
  occurred_end      TIMESTAMPTZ NOT NULL,

  title             TEXT   NOT NULL,
  facts             JSONB  NOT NULL DEFAULT '[]',   -- [{ kind, text, messageId }]
  participants      JSONB  NOT NULL DEFAULT '[]',   -- actor ids, for the faces

  kind              TEXT    NOT NULL,   -- the highest-ranked fact kind in this entry
  significance      INTEGER NOT NULL DEFAULT 0,
  rev               INTEGER NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX room_timeline_by_space ON room_timeline_entries (space_id, occurred_start DESC);
```

```sql
-- replica: the same shape, timestamps as epoch ms, JSON as TEXT
CREATE TABLE room_timeline_entries (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  ord_start INTEGER NOT NULL, ord_end INTEGER NOT NULL, anchor_message_id TEXT,
  occurred_start INTEGER NOT NULL, occurred_end INTEGER NOT NULL,
  title TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '[]',
  participants TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL, significance INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
CREATE INDEX room_timeline_by_space ON room_timeline_entries (space_id, occurred_start DESC);
```

**No CHECK on `kind`**, the rule `documents` and `panels` already hold: a kind
this build does not know is kept and drawn as a placeholder, never dropped — a
newer client wrote it (`DOCUMENTS.md` §3.5, *Schema — replica*).

It is 1:1 with `memory_documents` and still a separate table, because one is a
Hindsight pointer and one is replicated member data. Merging them would put a
vendor's identifiers into the sync protocol and into every client's SQLite,
permanently, and that is not removable later.

**Three — `documents`, unchanged.** `kind = 'room_summary'`, no schema change.
Its `body` becomes the two-or-three sentence header, and `covered_through` still
carries the "covers up to" line.

### 14.4 How they come together

**Write — the ingest job, once per episode, after §6:**

```
cut episode → retain(bank, …, documentId)                   → Hindsight
                   → listMemories(bank, { document_id })    → the facts, read back
                   → INSERT memory_documents                ← server only, stops here
                   → INSERT room_timeline_entries           → timeline.entry, space stream
  occasionally     → regenerate the header                  → document.updated
```

The read-back is one extra call on a path where nobody is waiting.

**Read — rendering the panel, entirely local:**

```sql
-- the header
SELECT body, covered_through, updated_at
  FROM documents WHERE space_id = ? AND kind = 'room_summary';

-- the timeline
SELECT id, title, facts, participants, kind, occurred_start, anchor_message_id
  FROM room_timeline_entries
 WHERE space_id = ?
   AND (?kindFilter IS NULL OR kind = ?kindFilter)      -- "Decisions only"
 ORDER BY occurred_start DESC
 LIMIT 50 OFFSET ?;                                      -- infinite scroll
```

Faces come from the actor directory already in the replica. **No Hindsight call,
no network, works offline** — which is the whole reason the entries are rows we
replicate rather than a view we fetch.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ #db-cutover                                            Summary · Timeline  │
│                                                                            │
│ Rolling back before retrying the cutover; Bob is on the rollback     ◄───── documents.body
│ script. Thursday's window is still open.                                   │
│ covers up to 14:31                                                   ◄───── documents.covered_through
│                                                                            │
│ ──────────────────────────────────────────────  [All] [Decisions]    ◄───── WHERE kind = ?
│                                                                            │
│  14:31  ●  Rollback before retry                    [A][B][+2]   ⤢   🗑     │
│    ▲    │  ▲                                         ▲            ▲    ▲    │
│    │    │  title                       participants ─┘   anchor_message_id  │
│    │    │                                                    (jump)  (by id)│
│    │    └── significance → the dot's weight                                 │
│    └─────── occurred_start                                                  │
│         │  · Decided to roll back the index rebuild first            ◄───── facts[].text
│         │  · Bob Iyer owns the rollback script                         + facts[].kind
│         │  → #db-cutover · 19 messages                               ◄───── ord_end − ord_start
│                                                                            │
│  Yesterday                                        ◄───── grouped on occurred_start
│  17:50  ●  Cutover window moved to Thursday         [A][P][+3]             │
└───────────────────────────────────────────────────────────────────────────┘
```

**Forgetting spans all three**, and it is the case that justifies the split:

```
message deleted
  → memory_documents WHERE chat_id = ? AND ord_start <= ? <= ord_end    (find it)
  → deleteDocument(bank, document_id)                                   (Hindsight forgets)
  → re-retain the episode without it, or drop the row if now empty
  → UPDATE or DELETE room_timeline_entries → timeline.entry             (every screen)
```

One flow, three tables, each with one job. This would be painful if entries
lived inside a markdown body and impossible if the pointer had been merged into
the replicated row.

### 14.5 Ranking what matters

Each entry carries a `significance`, from three signals in increasing order of
honesty:

1. **Fact kind.** An episode producing a *decision* or *ownership* fact outranks
   one producing only *references*. Free — §6.2's extraction instructions already
   enumerate those kinds.
2. **Breadth.** More participants, more distinct entities.
3. **Recall hits.** How often this episode's facts are actually pulled into a run.

The third is the interesting one: **the ranking improves as the memory gets
used.** An episode nobody marked notable that turns out to be recalled fifteen
times *was* notable, and the timeline can say so in retrospect. Nothing else in
this design gives that.

### 14.6 The admin view — is this working?

The purpose is **evaluation, not audit**: is memory being formed, is it any good,
is it consequential, what should change. Four questions, each with something real
to measure.

**Is it being formed?** Episodes ingested, **facts per episode**, episodes that
produced nothing, ingest lag, failed operations. `GET /banks/<bank>/stats` gives
`total_documents`, `total_nodes`, `last_memory_write_at`, `pending_operations`
and `failed_operations` directly. The number to watch is yield: **under about one
fact per episode means the extraction instructions are not landing**, which is a
tuning problem rather than a volume problem.

**Is it any good?** Three proxies, weakest first: the **kind distribution** (all
references and no decisions means the mission text is not working), the
**duplicate rate** across episodes, and — strongest, and free once §14.2 ships —
**human corrections**, people deleting or fixing timeline entries.

**Is it consequential?** This is the real question, and phase one already answers
it by accident. §7.2 requires every recalled fact to carry
`[what it says](message:msg_…)` and asks the model to keep the citation when it
uses one. **So a reply citing a message id that came from the recalled block is
proof memory changed the answer.** A choice made for trust doubles as usage
telemetry:

```
runs                          1,283
  recall returned ≥1 fact     1,203   94%    ← coverage
  reply CITED a recalled fact   612   48%    ← consequential
  facts cited / facts shown   2.1 / 5        ← precision in practice
```

Two failure modes get names from it. **Recalled often, never cited** is noise
crowding the block — tighten the mission. **Never recalled at all**
is dead weight, and feeds a zero-hit retention sweep.

**What should change?** A per-bank breakdown, because one room at four facts per
episode and 60% citation beside one at 0.3 and 5% says far more than any
workspace average. Then the tuning console: `POST /dry-run/extract` runs
extraction **without storing**, so the view can take twenty real episodes and
diff the current instructions against candidate ones side by side. That is the
loop that actually improves the pipeline.

**The privilege wall.** Metrics are fine workspace-wide — counts, rates, latency
and cost carry no content. **Fact text is limited to spaces the admin is a member
of**, because workspace admin does not inherit space admin (`AUTHZ.md` §7,
*Workspace admin does NOT inherit space admin*). A workspace-wide fact browser
would be the largest privilege escalation in the product, arriving through a
feature nobody filed as a permission change. Since the purpose is evaluation and
the metrics carry nearly all of the value, the constraint costs almost nothing.

Content-level audit across every space is a third tier: **named, not built.** It
needs its own consent model, its own audit log and a policy decision about who
may invoke it. That is a conversation, not a feature, and shipping it quietly
inside an admin tab is how it goes wrong.

### 14.7 Deliberately not done in phase two

| Not done | Trigger |
|---|---|
| **Timeline entries inside the document body** | Never as inlined content. `document.updated` carries the complete body and `document_revisions` keeps fifty full snapshots, so an append would re-send the whole timeline to every member — and `DOCUMENTS.md` already names "the body stops being kilobytes" as the trigger for diff-based revisions. When documents earn **parts** (`AGENT-RESPONSES.md` §3.1), the timeline becomes a part that *references* these rows, with no data migration, because it was rows all along |
| **A member deleting a fact about their room** | §19 keeps this open. It is the correction path when extraction is wrong, and a room whose memory has no eraser is one people stop trusting — but it is a product call |
| **Timelines for channels and DMs** | The tables are not room-specific; only the panel is. A channel that behaves like a room |
| **Knowledge pages as the header** | Hindsight maintains a page from a standing question and marks it `is_stale` when the bank moves. A strong candidate to replace header generation entirely — spike it before writing a generator |

---

## 15. Deliberately not built

| Not built | Trigger to build it |
|---|---|
| **A bank per private chat in a room** | A private chat runs for weeks and people ask an agent to recall inside it |
| **Per-agent procedural memory** (*"this tool needs a team id"*) | An agent repeats a tool mistake it has made before. Distinct because it carries no one's messages |
| **Memory in local rooms** | The ingest job is server-side and a local room has no server (`LOCAL-ROOMS.md`) |
| **A human-readable "what does this room remember" surface** | Someone asks. It is a **document written from a recall**, never a bank read from the client — every read of granted data is local (`DESIGN.md` §3), and a bank is not local |
| **Verbatim documents in Hindsight** | Never. It shreds a document into scattered facts; documents live in Postgres (§9) |
| **`reflect` anywhere** | A genuinely offline synthesis task, priced per call |
| **Cross-workspace memory** | Never, by construction (§5.2) |
| **Observation consolidation** | A measurement showing it adds more than it duplicates (§6.4) |

---

## 16. Implementation plan

Each stage is usable by hand before the next one starts. Stages 0–7 are phase
one and deliver the whole of §1–§13; stages 8–9 are phase two (§14) and are not
started until a room has been running on phase one long enough to have opinions.

### Phase one — memory for agent replies

### Stage 0 — Two spikes. Nothing else begins until both have run.

Neither writes app code. Both live in `spikes/hindsight/` with a
`pnpm verify:hindsight` entry point.

**Spike A — does the tag filter hold? ✅ Ran 2026-09-19, 16/16.** Findings in
[`spikes/hindsight/README.md`](../spikes/hindsight/README.md); the ones that
changed this document are in §5.3, §6.4, §7.2 and §9. `0-bank.mjs` passed 8/8
and showed the config-persistence trap does not reproduce on client 0.10.0.

Retain facts about one shared entity
tagged `space:A` and `space:B` separately, enough passes to trigger any
consolidation. Then `recall(tags: ['space:A'], tags_match: 'any_strict')` and
assert nothing returned derives from the B facts. Then
`GET /banks/<bank>/observations/scopes` and assert no scope contains both tags.

*Decides:* **whether public spaces can share one bank.** Its first assertion is
that every returned fact carries its `tags`, because that is what makes the
JavaScript re-filter possible, and the re-filter is the enforcement inside the
workspace bank rather than hardening around it (§5.3). A fact that comes back
untagged splits the bank map. The `any` versus `any_strict` comparison is
recorded rather than asserted: it separates a provider bug from a fail-open
default nobody closed, and both change how much the prefilter can be trusted.

Both spikes live in [`spikes/hindsight/`](../spikes/hindsight/README.md), run by
`pnpm verify:hindsight`, against real Hindsight Cloud through the official TS
client — the client the server will ship on, so the spike covers the half we do
not control. `0-bank.mjs` runs before either: it prints the client's real method
surface and proves the config-persistence workaround (§6.4) works, because
everything after it assumes a bank configured the way we asked.

**Spike B — what granularity extracts best? ✅ Ran 2026-09-19, episodes 14/14
against per-message 10/14.** Results in §6.1 and
[`spikes/hindsight/README.md`](../spikes/hindsight/README.md).

It did **not** use `pnpm mock` as planned: its bodies are drawn at random from a
pool of one-liners, so no two adjacent messages relate — and granularity is a
question about adjacency. A corpus with none would have scored every granularity
the same while looking like it had cleared per-message. `corpus.mjs` is 45
hand-written messages with 14 ground-truth facts, split 7 cross-turn / 7
self-contained so it cannot flatter the larger units.

*Decides:* `QUIET_MINUTES` and `MAX_EPISODE`, and whether §6.1's episode is worth
its machinery over a plain window. **Predicted** (to be checked, not trusted):
per-message yields ~40% of the facts and loses ownership disproportionately;
window and episode land close, with the episode ahead wherever an exchange spans
a boundary.

Both also establish the two facts we have not run ourselves: that a
client-supplied `documentId` is addressable by `deleteDocument`, and that
`timestamp` on retain is stored as the event's time rather than ingest time.

### Stage 1 — The client, banks, and the index

`apps/server/src/memory/client.ts` wrapping `@vectorize-io/hindsight-client`,
`memory/banks.ts` with `bankForSpace` and `banksForRun`, `ensureBank` with the
PATCH→verify→warmup loop (§6.4), and the `memory_documents` migration (§8.3).

**By hand:** create a bank, confirm via GET that the custom instructions came
back, retain one episode, delete its document, confirm `memory_units_deleted`.

### Stage 2 — Ingestion, one private room, behind a switch

`memory/ingest.ts`: `dueChats`, `claimChat`, `episodeFor`, `buildEpisodeText`,
`ingestEpisode`, `ingestChat`, `advanceWatermark`. A per-workspace off switch and a
`MEMORY_INGEST_SPACES` allowlist so the first room is chosen deliberately.

**By hand:** talk in a room, wait for quiet, read the facts back with a manual
recall, and check they are the ones a person would have written down.

### Stage 3 — Recall in a run

`memory/recall.ts`, called in `dispatcher.ts` between `triggerRef` and
`callRuntime`, **in parallel with `buildTranscript`**, with the deadline from
§11 and the block from §7.2.

Behind `MEMORY_RECALL=1`, separate from `MEMORY_INGEST` — a deployment can read
memory it already has while writing none, and a feature that costs a network
round trip per run should be opted into rather than inherited from an API key
being present. It is also what keeps the dispatcher's own tests off the network.

**By hand:** ask a question in the stage 2 room whose answer is only in memory.
Then ask one in a *different* room and confirm nothing from the first appears.

### Stage 4 — Forgetting ✅

`memory/documents.ts` holds the accessors; **`memory/forget.ts`** holds
`staleDocuments`, `rebuild` and `forgetSweep` — a separate file because
rebuilding reads messages, builds a transcript and retains, which is ingestion's
job rather than the index's. The sweep rides the ingest tick.

**By hand, done 2026-09-19** on a throwaway fixture: ingest → recall (the fact
is there) → delete the message that produced it → sweep → recall (gone, and the
facts from the surviving messages remain). `pnpm --filter @relayed/server run
memory-forget [--sweep]` shows and clears what is stale.

### Stage 5 — Public spaces and the workspace bank ✅

`publicSpaceIds`, the live tag list and the JavaScript re-filter landed in
earlier stages; what this stage found was the conversion gap above (§8.2) and
fixed it.

**By hand, done 2026-09-19** on a throwaway fixture with two public rooms:
ingest `infra` → recall from `payments` and its fact is there (cross-space
memory, the thing the workspace bank exists for) → one `UPDATE` making `infra`
private → recall from `payments` **immediately**, nothing, no job run → recall
from `infra` itself, all three facts still there.

**Public channels are ingested by the same mechanism, and are not ingested
today.** `dueChats` asks about the WRITER'S MEMBERSHIP and the chat's kind,
never the space's kind — a public channel with Roomkeeping in it is due and
routes to the workspace bank (tested). What keeps channels out is provisioning:
Roomkeeping is added to rooms and not to channels. That is Rule 1 working rather
than a gap in the query, and widening it is a product decision — it changes a
user-visible member list in every channel — so it is §19's open question rather
than something this stage settled.

### Stage 6 — The person bank ✅

`memory/person.ts` (`remember`, `notesAbout`, `forgetNote`), the `remember` app
tool, `personPrompt` as its own slot in the system prompt, and
`pnpm --filter @relayed/server run memory-person <actor> [--forget <doc>]` as the
server half of the settings surface. **The renderer surface is still to build**;
that script is what it will call.

**By hand, done 2026-09-19** on a throwaway fixture: a DM carrying both a
worry about a compensation review and *"keep your answers short and always lead
with the schema"*. The DM's content was ingested — into the DM's own bank — and
the preference was stored by `remember`. Recall in a **public room** then
returned an **empty facts block** and a person slot holding the preference. The
compensation line appeared nowhere. Listing and deleting it left nothing.

### Stage 7 — Observability, then a second room

The markers in §12, agreed with the dev before they are added. Then turn on a
second room and read the recall duration histogram before going wider.

### Phase two — the same facts, rendered for people

### Stage 8 — The room timeline

`room_timeline_entries` on both sides (§14.3), the `timeline.entry` event on the
space stream, the read-back after retain, and the panel: header on top from
`documents`, entries below, `All`/`Decisions` filter, jump and delete per entry.
`DOCUMENTS.md` gets a header naming the sections this supersedes, and the
summariser job is deleted rather than adapted (§14.2).

**By hand:** talk in the stage 2 room for a day, then read its timeline and ask
whether a person arriving cold would understand what happened. That judgement is
the point of the stage — it is the first honest read on whether extraction is
producing anything worth keeping.

### Stage 9 — The admin view

The four measurements in §14.6, `memory.facts.cited` beside
`memory.facts.returned`, the per-bank breakdown, and the `dry-run/extract`
tuning console. Metrics workspace-wide; fact text only for spaces the admin is in.

**By hand:** read the citation rate after a week. If recall is covering 90% of
runs and under 10% of replies cite anything, the facts are not consequential and
the extraction mission is the thing to change — not the retrieval.

---

## 17. Tests that must exist

Model tests, in the style of `pnpm spike:authz`, plus integration tests against
a real Hindsight.

**Access — the load-bearing ones.** A fact from a private space never appears in
a run in another space. A private chat's messages never enter its room's bank. A
restricted message is never ingested. A human-to-human DM produces no bank at
all. A converted room drops out of the public list on the *next* recall with no job
run, **and still reads its own facts**. A public space is not listed twice when
it is already in the live list. No two spaces, workspaces or people share a bank id, and every id a
generator can produce fits the ~63-character cap.

**Ingestion.** An episode ends at quiet. `MAX_EPISODE` cuts a chat that never goes
quiet. A system message is never ingested. Two conversations separated by a
long gap go as two episodes, never one.
A chat's whole backlog drains in one pass, bounded. The watermark never advances
past a failure. A message arriving mid-ingest lands in
the next episode, not this one.

**The person bank.** A preference taught in a DM reaches a run in another
space; the DM's own content does not. `personPrompt` is never fused into the
recalled-facts block and carries no citations. `remember` writes to the
INVOKER'S bank whatever the arguments name, and refuses a non-human invoker.

**Forgetting.** Deleting a message removes its facts within one sweep. **A
rebuilt document stops being stale** — the sweep converges rather than rebuilding
the same document on every tick, which is what a tombstone-keyed check would do.
An edit makes a document stale. A change outside a document's ordinal range does
not. Deleting a space removes its documents. A rebuild reads as the WRITER, so a
message restricted away from it does not reappear.

**The run.** Recall runs in parallel with the transcript. A recall deadline breach
produces a complete answer without memory. Hindsight being down never fails a run.

**Property.** Over random worlds of spaces, chats and memberships, assert the
audience rule directly: for every fact reachable in every chat, every member of
that chat can read every source message. This is the `spikes/visibility-tests.mjs`
shape, and it is the test that would have caught a bank-map mistake.

**Phase two (§14).** A timeline entry is written once and never rewritten by a
later episode. Deleting a message removes or rebuilds its entry on every replica.
An entry's `occurred_start` is the messages' time, so a late backfill does not
reorder a timeline. An unknown `kind` renders as a placeholder rather than being
dropped. The admin view returns fact text for a space the admin is in and
metadata only for one they are not — asserted for a workspace admin who is a
member of neither.

---

## 18. Invariants to add

Proposed for `DESIGN.md` §14, each with the failure it prevents:

| | |
|---|---|
| A fact is recallable in a chat only if **every member** of that chat may read all its sources | The invoker test is not enough: the reply is visible to the whole audience (§5.1) |
| **Banks, never tags, carry the permission boundary** | A tag filter is a query-time argument that fails open; a bank cannot be named across (§5.3) |
| A bank id is **derived from a ULID, never from a name** | A human-chosen name collides across workspaces, which is exactly how xyne-spaces' agents came to share one bank. A ULID cannot, and must not be truncated to fit — its leading characters are a timestamp two workspaces can share (§5.2) |
| A private chat and a restricted message are **never ingested** | They are narrower than their space, and their space's bank is read by people they exclude (§5.4) |
| Every retain carries a **`documentId` we chose** | It is the only handle that makes forgetting possible (§8.1) |
| The public-space list is read **live on every recall** | A cached list leaves a window after a conversion, and a leaked fact is repeated by the agent (§8.2) |
| `retain` is always called with **`async: false`** | Failures otherwise occur inside Hindsight after a 200, invisible and unretryable (§6.3) |
| Staleness is decided by **`messages.rev`**, never by the `deleted` flag | The flag is a tombstone that never clears, so a sweep keyed on it never converges — it rebuilds the same document on every tick for ever (§8.1) |
| Memory **never re-retains its own output** | Hindsight annotates what it stores; a round trip compounds it (§9) |
| A workspace admin sees memory **metadata** for every space and **fact text** only for spaces they are a member of | Workspace admin does not inherit space admin (`AUTHZ.md` §7). A workspace-wide fact browser is the largest privilege escalation in the product, arriving through a feature nobody filed as a permission change (§14.6) |
| A timeline entry is **written once**, and its time is the messages' time | A timeline that rewrites or reorders itself after the fact is not a timeline, and it is what the summariser's rebuild window did (§14.2) |

---

## 19. Open questions

1. **Is one tick (~60 s) acceptable between a delete and a forget?** It is a
   decision in §8.1, not a limitation. Making it synchronous means a hook in the
   delete path and a blocking HTTP call in a write transaction — which is why it
   is not the default here.
2. **Does it read as intelligent or intrusive?** A fact nobody asked for is either
   delightful or unsettling, and no amount of design tells you which. One room,
   real people, stage 3. This is the question the whole document is subordinate to.
3. **Does recall stay fast enough?** The vendor says sub-second; a real deployment
   measured 7–11 s on a 2k-fact bank. Per-space banks stay smaller, which should
   help. The §12 histogram is the answer, not an estimate.
4. **What happens when a fact is true and unkind?** Extraction is told to skip
   opinions in passing, and citations make a fact read as a pointer. Whether that
   is enough is a product judgement to make after watching one room.
5. **May a room member delete a fact about their room?** I think yes — it is the
   correction path when extraction gets something wrong, and a room whose memory
   has no eraser is one people stop trusting. But it decides who the "Forget
   this" control ships to, and it is a product call rather than an engineering
   one (§14.7).
6. **Does a memory writer belong in channels?** The mechanism already covers
   them — a public channel with Roomkeeping in it is ingested and routes to the
   workspace bank. Nothing puts it there, because Roomkeeping is provisioned
   into rooms only. Adding it to every channel changes a member list people can
   see, and makes an agent whose stated job is "keeps each room's summary" a
   member of things that are not rooms. Worth deciding deliberately rather than
   by widening a backfill query (§16, stage 5).
7. **Does the person bank want a structured half?** `preferences` already exists
   and is a row per key. If the same preference can be expressed both ways, one of
   them is the source of truth and this document does not yet say which.
