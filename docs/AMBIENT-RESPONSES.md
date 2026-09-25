# Ambient responses

> **Status: built, on by default** (`AMBIENT_MODE` unset is `live`, since the
> first release, 2026-09-24). `shadow` judges and drafts and posts nothing;
> `off` switches it off (switching it on §10.3). How an agent that is
> a member of a space answers a message that did not mention it: when it
> speaks, when it stays quiet, what it may read, where its answer lands, and
> the judgments that decide it — made by Jev, TypeSafe's decision model,
> rather than by a prompt. The flow is the one the spike settled in rounds
> 5–5c (`spikes/ambient/README.md`): a clock per turn, an answer per open
> question, offers to look things up, 191 of 201 runs right and none out of
> turn.
>
> It settles three things other documents left open or said otherwise, and each
> of them now says so (docs changed §18):
>
> - **`WORKSPACE-AGENTS.md`, the reply (§5.7)** says "a run never ends
>   silently". An ambient answer is not a run (§5), and it ends silently
>   whenever it has nothing good to say (§8).
> - **`WORKSPACE-AGENTS.md`, the checkpoints (§5.9)** reserved `invocationsFor`
>   for "continuing a thread the agent answered without a new mention". That
>   is built here instead, as a follow-up decided after commit (§4.2).
>   `invocationsFor` changed in one way only: an agent's name used as an
>   address at the start of a message — "triage, …" — invokes it like a
>   mention (§4).
> - **`WORKSPACE-AGENTS.md`, deliberately not built (§13)** says a run with no
>   invoker present needs a standing grant. An ambient answer needs none: it is
>   not a run, and it spends nobody's authority (§5).
>
> Companion to [`WORKSPACE-AGENTS.md`](WORKSPACE-AGENTS.md), which covers the
> explicit half — a mention becoming a run. This covers the implicit half.

**Last updated:** 2026-09-24

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **Mention** | The canonical actor link `[…](actor:<id>)` that `mentions.ts` parses and the unread counters count. The only thing that starts a run today. |
| **Ambient answer** | An agent's reply to a message that did not mention it. |
| **Follow-up** | A person's message, with no mention, that answers or continues something an agent has just said. |
| **Turn** | What one person said in a row: their messages, each within `LULL` of their previous one, at most five and three minutes long. The unit an ambient answer is considered for, `LULL` after its last message — other people's messages never delay it. |
| **Run** | Work that spends an invoker's authority — their permissions and connections — recorded in `agent_runs` (`WORKSPACE-AGENTS.md`, from a mention to a run §5). |
| **Job** | Work an agent does as itself, with no invoker, in the shape the room summariser already uses (`DOCUMENTS.md`, who writes the summary §4.2). |
| **Jev** | TypeSafe's model. Given a *state* and typed questions, it returns typed answers with calibrated probabilities. It does not generate text. [docs.typesafe.ai](https://docs.typesafe.ai/introduction) |
| **Noul** | A Jev yes/no question. Returns the probability the answer is yes, 0 to 1. |
| **Choice** | A Jev question that picks one option from a set. Returns the option, a probability per option, and a confidence. |
| **Gate** | One Jev call whose answers code compares against thresholds. |

---

## 1. What this decides

1. **An agent may answer a message that did not mention it**, in a space it is
   a member of — after the people there have had the chance to answer first.
2. **A mention still starts a run, exactly as today.** Nothing here touches the
   mention path.
3. **Anything inferred is a job, not a run.** An ambient answer, and a
   follow-up the model decided was meant for the agent, spend nobody's authority
   and carry nobody's name (§5).
4. **The answer lands where a mention's reply to the same message would** —
   one function decides both, and the desktop draws both in the chat (§6).
5. **Jev decides whether it speaks, in three steps**: each person's message
   judged on its own, to find an open question; which agent, for that
   question; and, once there is a draft, whether it helps and whether someone
   answered meanwhile (§7). Measured first, in `spikes/ambient`.
6. **An ambient answer ends silently** on any outcome but a good answer (§8).
7. **It runs in shadow first.** Every judgment and draft is recorded, and
   nothing is posted until a person has read the drafts (§10).

---

## 2. An example

`#db-cutover` has three people, Alice, Bob and Carol, and one agent, Triage.

**14:31:00** — Alice: *"anyone know why the index rebuild is taking 3x longer
than the runbook says?"*

No mention, so no run. The send commits exactly as it does today. After commit,
Alice's turn — what she said in a row — is due for a look 90 seconds after her
last message in it.

**14:31:40** — Bob: *"lol did you see standup"*. **14:32:10** — Carol: *"haha
yes"*. Neither is Alice's, so neither moves her clock; they are context.

**14:32:30** — step 1. Alice's message, judged on its own: *does it ask
something, has a later message given what it asks for, is it aimed at a named
person, is it meant to get an answer, is it something only a person can give,
is it personal or sensitive, is it a plan for the team?* An open question.

**14:32:30** — step 2. *Which agent could give Alice a useful answer*, going by
what each is set up to do and what it has already said here? Triage, and its
fit clears the bar.

**14:32:30 – 14:32:36** — Triage works on an answer, out of sight, as a job: the
chat, the room summary, the room's memory, general knowledge where the answer
does not depend on this team. No working indicator, no tools, no connections.
It may end its draft with one line offering to look something up in a
connected tool, when the rest of the answer lives there.

**14:32:36** — the draft check. *Does this help Alice, or does it mostly say it
can't see?* And, since someone may have answered while Triage was working, *has
anyone?* It helps, and nobody has.

**14:32:37** — posted in the chat, under Alice's question:

> **Triage** · unprompted
> ↪ Alice Chen
> The runbook's 40-minute estimate predates the Sep 12 change, when the room
> decided to rebuild the partitions one at a time. That works out to about two
> hours, which matches what you're seeing.

**14:33:10** — Alice: *"ah that makes sense, is there a way to speed it up?"*

Triage spoke a moment ago, so a Jev check runs on the next poll rather than
after a clock: *is Alice talking to Triage?* Yes. Triage answers, again as a
job. Three such follow-ups on one exchange, and then it stops.

**14:35:00** — Carol: *"how many open bugs are tagged sync in Linear right
now?"* Her turn is due at 14:36:30. Triage cannot see Linear, so its draft is
the offer line alone, and the offer check asks whether Linear is where that is
kept. It posts: *"I can look up the open bugs tagged sync in Linear for you.
Mention me if you want me to."* Carol's mention, if she makes one, is an
ordinary run with her tools.

**What happens most of the time instead.** At 14:31:40 Bob writes *"it's the
autovacuum, I'm on it"*. At 14:32:30 step 1 sees Alice's question was given
what it asked for, and Triage says nothing. Nobody knows it looked.

---

## 3. Behaviour, and what each rule prevents

The bar is not "could the agent answer this" — it almost always could. It is
**"would a colleague sitting in this room speak up now"**, which is much
narrower, and usually no.

| Rule | What it prevents |
|---|---|
| **People get first refusal.** A turn is not considered until its author has been quiet for `LULL` (90 s) | The agent becoming the room's first responder, and people learning to stop answering each other |
| **A turn is the unit, and other people are context** — what one person said in a row is judged together, and nobody else's message delays it | Chatter pushing an answer back, a newer question burying an older one, and two answers seconds apart to one person's two lines |
| **If anyone has given what was asked for, or taken it, silence** | The agent repeating what a person already said |
| **One answer per open question, one look at a time per chat, three unprompted answers per chat in ten minutes** | Two agents racing to answer the same question; the same question from two people answered twice; an incident channel drowned |
| **A review, an opinion, a decision, a plan, anything personal: silence** | An agent voting, promising work it cannot do, or weighing in on someone's pay |
| **An offer names where the thing is kept** | "I can look that up in Slack" for whether staging is up |
| **Only a person's message is ever evaluated** | Two agents answering each other for ever. The chain-depth limit (`MAX_CHAIN_DEPTH`, `checkpoints.ts`) cannot stop this: a job starts no chain, so there is no depth to count |
| **Silence on anything but a good answer** — no refusal, failure or timeout notices | A notice about a question nobody asked the agent is noise |
| **No working indicator** | "Triage is working…" appearing unbidden, then vanishing when the draft check holds the draft back |
| **Short, marked unprompted, with "Not helpful here"** | An unrequested message that cannot be told apart from a requested one, and no way to say it missed |
| **Only what the room can already see** (§5) | One person's account or private memory landing in a room they did not choose to share it with |

---

## 4. Four ways in

| Way in | Mechanism | Decided | Speaks after | Authority |
|---|---|---|---|---|
| **Mention**, or the agent's name used as an address ("triage, …", "hey triage …", "Triage who is …") | Run — built (`WORKSPACE-AGENTS.md` §5) | Inside the send transaction | Immediately | The person who asked |
| **Follow-up** to the asker's own mention | Run, started after commit | The follow-up check (§7.5) | Seconds | The person who asked |
| **Follow-up** by anyone else | Job | The follow-up check | Seconds | None |
| **A turn** | Job | After commit: a clock per turn, step 1, step 2, the draft check | `LULL` after the person's last message, plus the job | None |

### 4.1 Nothing here enters the send transaction

A mention's run is inserted inside the transaction that writes the message,
because "an agent missing a mention it was meant to act on is a correctness
bug" — an agent has no catch-up (`WORKSPACE-AGENTS.md`, the handoff is part of
the write §5.2). A name used as an address is decided there too, by a regex
beside the mention parser (`sync/mentions.ts`, `addressedAgent`): cheap, and
the same module that decides what a mention is. The name at the start, then a
comma or a colon ("triage, …"), after a greeting ("hey triage …"), or before a
question word — who, what, when, where, why, how, which, can, could, would,
will, please ("Triage who is looking into sync engines?", which the first live
test sent without its comma). Not "Triage the deploy failures first" — an
imperative to the room, which an unprompted agent once read as its own to-do
(finding 15 of the spike) — and not "Triage is broken again", which is about the
agent, not to it.

An ambient answer is the opposite: **best-effort by nature.** Missing one costs
nothing, because the person can mention the agent. So it is decided after
commit, and:

- a network call to TypeSafe never holds a Postgres transaction open;
- send latency never depends on a third party.

### 4.2 Why a follow-up needs a judgment, and where it leads

Inside a thread, anything posted after the agent is for the agent — a rule would
do. An ambient answer lands in the chat (§6), and in the chat the next message
might be for the agent or might be the people carrying on without it. That is a
judgment, so it is a Jev call (§7.5).

It is only asked when **an agent wrote one of the last three messages in the
chat, within the last five minutes**. Every other message costs nothing. A
follow-up judged to be for the agent then goes one of three ways:

- **It continues the asker's own mention.** Alice mentioned Triage, Triage
  answered with her tools, and Alice asks on: that is her conversation, so the
  loop starts a run for her (`startRunFor`, `checkpoints.ts`), and Triage
  answers with her tools again. Nobody else's reply ever does this — Bob asking
  the same thing gets a job with no tools, and at most an offer.
- **The exchange has had three follow-ups.** Quiet: the fourth would make it a
  DM in the room.
- **Otherwise,** a draft, as for a turn.

A follow-up judged *not* to be for the agent is not judged at all: it is a
message the room may still want answered, and it joins its author's turn.

---

## 5. Whose authority: a job, not a run

Every run spends an invoker's authority, and `messages.on_behalf_of_actor_id`
"records whose authority was spent" (`005_sync.sql`). Alice asked the room a
question. She did not ask Triage anything. Making her the invoker would put her
name on a message she did not request, and her connections behind it.

The room summariser met the same question and settled it (`summariser.ts`):

> *"Inventing a fake invoker would put a person's name on something they did not
> ask for and their connections behind something they cannot see, so this is a
> job … It still acts AS AN ACTOR … the agent is a member of the room, and the
> ordinary access predicate decides what it may read."*

An ambient answer takes the same shape:

| | Run (mention) | Job (ambient, follow-up) |
|---|---|---|
| Invoker | The person | **None** |
| `on_behalf_of_actor_id`, `delegation_id` | Set | **NULL** |
| What it may read | What the agent **and** the invoker can both read | What the **agent's membership** allows — the ordinary `can()` |
| Who authorises the post | The run (`writeMessage`: "an agent's reply is authorised by its run") | **The job checks `post` for the agent itself** before writing |
| Connections (Composio) | The invoker's | **None exist to spend** |
| Memory | Space, workspace and the invoker's person bank | **Space and workspace banks only** |
| Tools | Found as needed, on the invoker's connections | **None.** An offer to look something up instead (§7.4) |
| Mentions in its answer | Start runs for the same person, one step deeper | **Start nothing.** A message with no invoker starts no run |

Four of those rows need a reason stated.

**No person bank.** `recallForRun` opens the invoker's own person bank beside
the space and workspace banks (`memory/recall.ts`, through `banksForRun`). That
bank is private to that person (`MEMORY.md`, the person bank §5.5). An answer
posted to a room must never read it. Both functions take the invoker as
required today, so the job needs a recall with no invoker that returns no
person bank — not one that borrows the asker.

**No tools.** The summariser's own reason carries over: "nothing somebody in
the room cannot already see". The chat, the room summary and the room's memory
are all room-visible, and memory recall is injected rather than called as a
tool (`MEMORY.md`, why injected §7.3), so it survives. Web search is the only
tool that spends no person's account; it is deferred (§15) rather than ruled
out.

**It starts nothing.** `startMentionedRuns` takes an invoker for the chained
run. A job has none to hand on, so a mention inside an ambient answer is text,
not an invocation. And the server rewrites any `[Name](actor:…)` link in the
answer to `actor-ref:`, which notifies nobody: an agent nobody asked does not
get to get anyone's attention.

**When the answer needs more,** the draft ends with an offer — "I can look up
the open sync bugs in Linear for you. Mention me if you want me to." — written
by the server from what the model said it would look up and where, and only
when that tool is where the thing is kept (§7.4). The mention it invites is an
ordinary run with the person's authority, because this time they asked.

---

## 6. Where the answer lands

**Where a mention's reply to the same message would.** `replyParentOf`
(`transcript.ts`) decides both: the question's own thread root when the
question is itself a reply, otherwise the question. It was one expression
copied into four places (`dispatcher.ts` twice, `access.ts`, `routes.ts`); it
is now one function, so a run's access card, its notice, its answer and an
ambient answer cannot disagree about where they go.

The desktop has no thread view yet and draws every message in the chat, so an
ambient answer appears in the chat below the conversation, exactly as a
mention's reply does. When a thread view arrives, both move together.

An earlier draft put ambient answers in the chat and left mention replies in
threads. That would have made the message nobody asked for more prominent than
the one somebody did; one rule for both removes the question.

**A reference to the question, written by the server.** The clock usually puts
the answer directly under the question, but people may post while the job
works. So the answer carries an `ambient` part (`@relayed/protocol`,
`AmbientPart`): the id of the message it answers, and the asker's name as it
read then. The desktop draws it in the header as "unprompted · ↪ Alice", and
clicking it scrolls to the question. **The server writes it, not the model** —
a model asked to cite will sometimes forget. It is server-only, like an access
card: refused on the ordinary write path for every author, agents included,
and drawn only on an agent's message.

---

## 7. The Jev calls

### 7.1 Why Jev

Each question here is a gut-check judgment, asked for every turn in every room
with an agent, whose honest answer is usually *no*. That is the shape Jev is
built for:

- **Typed answers with calibrated probabilities.** Code compares numbers
  against thresholds; nothing is parsed out of prose.
- **Several questions in one call**, each evaluated independently against the
  same state, for barely more latency than one.
- **Cost.** $0.042 per million input tokens, output free (`jev-1.13.0`,
  [TypeSafe's models page](https://docs.typesafe.ai/models)). For comparison,
  memory retain is $10 per million (`MEMORY.md`, cost §13).
- **Thresholds live in code.** Tuning is changing a number, not rewording a
  prompt.

### 7.2 Step 1 — each message of a turn, on its own

The first design asked about the whole window at once — *is there an unmet need
in these messages?* — and every unrelated message pulled the answer toward no.
Live, "Are we working on the sync engine side of things?" followed by "yo" and
"Excited for the launch" scored 0.52 as a window and 0.97 on its own; and two
questions where a person answered one read as "handled" for both.

So step 1 asks seven narrow yes/no questions about **each** message of the turn
being judged, with the window around it in the state — the few messages before
the turn, and everything said since — so "given what it asks for" can see the
later messages:

```jsonc
"state":     { "recent": [ { "from": "Alice Chen", "at": "…", "text": "is staging down?" }, … ] },
"questions": {
  "need_3":      { "type": "noul", "instructions": "`recent[3]` asks a question, asks for something, or raises a problem." },
  "answered_3":  { "type": "noul", "instructions": "A message after `recent[3]` in `recent` gives what `recent[3]` asks for, with confidence — not just something on the same topic, and not a guess, an \"I think\" or an \"idk\" — or says someone is handling it." },
  "to_person_3": { "type": "noul", "instructions": "`recent[3]` is addressed to a specific named person." },
  "wants_3":     { "type": "noul", "instructions": "`recent[3]` is meant to get an answer from someone — not rhetorical, not said in passing." },
  "person_3":    { "type": "noul", "instructions": "`recent[3]` asks for something only a person can give: a review, an approval, a sign-off, or people's own opinions." },
  "sensitive_3": { "type": "noul", "instructions": "`recent[3]` is about something personal or sensitive: someone's pay, health, performance, job security or private life." },
  "plan_3":      { "type": "noul", "instructions": "`recent[3]` is a plan, a proposal or an instruction for the team — not a question, and not asking for help or information." },
  …the same seven for each message of the turn
}
```

Code decides whether the turn is open (`judgeTurn`): it is when any of its
messages asks something, was not given what it asked for, is not aimed at a
named person, is meant to get an answer, is not something only a person can
give, and is not a plan — and a sensitive ask anywhere in the turn silences the
whole of it. With nothing open, it records the most telling reason —
`sensitive`, `needs_person`, `plan`, `handled`, `directed`, `rhetorical`, else
`no_need`. The bars sit where the spike's probabilities separated the cases:

| Asked of each message | Should count | Should not | Bar |
|---|---|---|---|
| Asks something | questions 0.93–0.99 | chatter, statements ≤ 0.34 | > 0.65 |
| Given what it asks for, with confidence, by a later message | real answers 0.91–0.98, "Sending, one sec" 0.91 | "no idea, haven't checked" 0.28; "i guess 5th? idk" 0.04; open ≤ 0.15 | < 0.5 |
| Addressed to a named person | 0.98 | open questions ≤ 0.16 | < 0.5 |
| Meant to get an answer | real questions 0.72–0.93 | venting 0.22, a joke 0.28 | > 0.5 |
| Something only a person can give | a review 0.95, "thoughts?" on a status update 0.93 | questions to answer 0.03–0.25 | < 0.5 |
| Personal or sensitive | layoffs 0.92, pay 0.84, someone's health 0.96 | everything else ≤ 0.14 | < 0.5 |
| A plan or an instruction for the team | "Triage the deploy failures first" 0.97, "let's triage the flaky tests" 0.96 | questions < 0.1 | < 0.5 |

"Given what it asks for, with confidence" replaced "answers it" in two steps:
"one at a time, to keep load off the primary" had counted as answering "when
did we decide on one at a time?" at 0.89; and in the first live test with two
people, "i guess 5th? idk honestly" counted as answering "when are we
launching?" at 0.73, and nobody got the date. Links read as what they say — `[Bob](actor:…)` is `@Bob` — and
each message is clipped to 1,000 characters: the ids are not the gate's
business, and Jev reads literally (§7.6).

### 7.3 Step 2 — which agent, for that turn

A second call, because its state is built from step 1's answer — the dependency
TypeSafe's docs name as the reason a second request is warranted. It reads the
turn as one question (what the person said, in order), the three messages
before it, anything said since, the room summary (rooms only, clipped to
4,000 characters), and each eligible agent **as it can be read without anyone
having written a word for this**: the start of its instructions (required, so
always there), its description (usually blank or vague, so never relied on),
and its last five messages in this chat.

```jsonc
"state": {
  "room": "db-cutover", "room_summary": "…", "earlier": [ … ],
  "question": { "from": "Carol Diaz", "at": "…", "text": "does anyone know where the rollback runbook lives?" },
  "after": [ … ],
  "agents": [ { "handle": "@triage", "set_up_as": "You are a on call assistant", "described_as": "Triage agent for SWAT",
                "done_here": [ "Created an 18-slide deck covering the sync-engine findings…", … ] } ]
},
"questions": {
  "best_agent":  { "type": "choice", "instructions": "Which agent in `agents` is best placed to answer `question`?",
                   "criteria": { "@triage": "The agent at `agents[0]`.", "none": "No agent here is well placed." } },
  "fits_role_0": { "type": "noul", "instructions": "`agents[0]` could help with `question` — answer it, or know where the answer would be found — going by what it is set up to do (`agents[0].set_up_as`, `agents[0].described_as`). Read `question` with `earlier` for what it refers to." },
  "fits_here_0": { "type": "noul", "instructions": "`agents[0]` could help with `question` — answer it, or know where the answer would be found — going by what it has already done in this chat (`agents[0].done_here`). Read `question` with `earlier` for what it refers to." }
}
```

**The best fit that passes speaks** (`decideAgent`): the agent whose higher fit
(`fitOf`) is the highest, if it is above **0.55**. Jev's own pick — the Choice,
with `none` among its options — only breaks a tie among agents that pass, fits
within 0.05 of the best: in round 5d it broke a tie of 0.56 and 0.53 in favour
of the one under the bar, and the room went silent. Questions an agent should take fit at 0.75–0.93; questions none should —
lunch, leave policy, snacks, bait — at 0.14–0.48. Letting the pick decide
outright left "when does 0.0.2 launch?" unanswered (Triage picked at 0.54,
Scribe fitting at 0.62) and "who owns the rollback script?" too (none picked,
Triage fitting at 0.63); with the fit deciding, no quiet case changed (finding
17 of the spike). There is no bar on the Choice's confidence either: it nearly
blocked two right answers.

**Why two fit questions, and why that wording.** Measured against real Jev on
the first live room, where the agent's description read "Triage agent for SWAT"
and its instructions "You are a on call assistant":

| Question | Description only | One question, setup + history | Setup only | Two questions, higher taken |
|---|---|---|---|---|
| "Are we working on the sync engine side of things?" | 0.53 | 0.87 | 0.73 | **0.88** (history) |
| Leave policy | 0.12 | 0.13 | 0.21 | **0.20** |
| "What time is the all-hands tomorrow?" | — | — | — | **0.40** |
| "Is the staging redis cluster still down?" | 0.53 | 0.35 | 0.67 | **0.60** (setup) |

Asked as one question, history crowded out the role. And "is the kind of thing
it is set up to do" and "continues work it has done" scored the sync-engine
question 0.50 and 0.53 — read too literally — where "could give a useful
answer" scored 0.76 and 0.88.

**Each fit reads the turn with what came before it**, when anything did: "Read
`question` with `earlier` for what it refers to." A nudge — "yeah, anyone?" —
means the question it nudges; judged alone, it fit the agent at 0.51.

**"Could help — answer it, or know where the answer would be found"** replaced
"could give a useful answer" after the first live test. The old wording judged
whether the agent could answer with nothing to look at, so an on-call agent
did not fit "was there any login incident reported lately?" (0.51) — the thing
it is for — nor "how many open bugs are tagged sync in Linear?" (0.48–0.54). In
round 5e of the spike the Linear offer went from none of three runs to all
three, and none of the questions no agent should take — lunch, the leave
policy, snacks — started to fit.

### 7.4 The draft: an answer, an offer, or both — and whether it was overtaken

**What the model may write.** The standing rules (`ambientRules`, `loop.ts`)
tell it it was not asked; that it cannot do anything here but answer, and must
never say it will; to answer from what it was given or from general knowledge
that does not depend on this team's setup, never guessing at the team's own
facts; to give facts, not opinions, and never say which way a decision should
go; to answer what it can and, when the rest is in the team's own records or
live data kept in a connected tool, to **end with one line** —
`OFFER: <what it would look up> | <tool>` — or that line alone when it can
answer none of it, only ever to look something up; to reply `NOTHING` when it
has nothing to add, a thank-you or a correction with nothing new included; and
to start with the answer, in a full sentence, with yes or no when the question
allows it.

Each line answers a failure the spike found. "Triage the deploy failures first"
drew "I'll triage deploy failures" — an agent promising work it cannot do.
"Answer or offer" made the model flip: it offered Jira for a question the room
summary answered, and Google Drive for "why is the rebuild 3x slower?", both
held back and both questions left unanswered; "answer what you can, then
offer" answered every time. A one-word "Thursday." read as unhelpful at 0.51.
A draft that only implied its yes scored 0.31 for helping, where "Yes — …"
scored 0.85.

**How it is read** (`readDraft`): the offer is cut out from its `OFFER:` marker to
the end of that line, wherever the model wrote it — once, asked for its own
line, it put it mid-paragraph, and a line-only reading posted it into the room;
a malformed one is dropped, never posted. The rest is the answer; a bare
decline however spelled (`NOTHING`, `NO_CONTENT`, `NONE`, `N/A`) is nothing. Any
`[Name](actor:…)` link becomes `actor-ref:`, which notifies nobody.

**The checks**, as up to three calls in parallel — no slower than one:

```jsonc
// the answer, on its own
"state": { "question": { … }, "draft": "…" },
"questions": {
  "useful":   { "type": "noul", "instructions": "`draft` would help the person who wrote `question`: it answers it, or tells them something specific they need to answer it." },
  "deflects": { "type": "noul", "instructions": "`draft` mostly says it cannot see, check or know what was asked." }
}
// the offer, on its own
"state": { "question": { … }, "offer": { "look_up": "the open bugs tagged sync", "with": "Linear" } },
"questions": {
  "kept_there": { "type": "noul", "instructions": "`offer.with` is where what `question` asks about is kept — its system of record — not somewhere people might have talked about it." },
  "asks_info":  { "type": "noul", "instructions": "`question` asks for information — not a plan, a proposal or an instruction to the team." },
  "fits":       { "type": "noul", "instructions": "Looking up `offer.look_up` with `offer.with` would answer `question`." }
}
// whether a person answered while it was drafting — only when anything was said since
"state": { "question": { … }, "since": [ … ] },
"questions": { "handled": { "type": "noul", "instructions": "Someone in `since` has already answered `question` or said they are handling it." } }
```

An **answer** posts when it is not mostly a deflection (< 0.5), helps (> 0.7),
and nobody answered meanwhile (< 0.5) (`decideDraft`). An **offer** posts when
its tool is connected, the message asks for information (> 0.5), the tool is
where the thing is kept (> 0.7), looking it up would answer the question
(> 0.7), and nobody answered meanwhile (`decideOffer`). When both parts pass,
the offer's sentence follows the answer. The offer posts alone **only when the
model wrote nothing but the offer** — never in place of an answer that failed
its check: the release gate posted "I can look up the cutover plan in Jira"
for a question the room summary answered, when the answer beside it came out
hedged. The sentence is written by the server, never the model
(`decidePost`): *"I can look up {what} in {tool} for you. Mention me if you
want me to."*

**Which tools an offer may name.** The toolkits the deployment enables
(`toolkits.enabled`), not the ones anyone in this workspace has connected. So
an agent can offer Jira to a team that only uses Linear — in the release gate
it named Jira for incidents every time. Mentioning it then brings up the
access card to connect Jira, which is honest but not helpful. Narrowing offers
to tools someone in the workspace has connected is deliberately not built yet
(§15).

The answer check was measured on the spike's eleven hand-labelled drafts:

| | Good drafts (8) | Borderline (1) | Deflections (2) |
|---|---|---|---|
| "directly answers" | 0.61–0.93 | 0.76 | 0.28–0.40 |
| "would help the person who asked" | 0.76–0.93 | 0.88 | 0.80–0.81 |
| "mostly says it cannot see or know" | 0.05–0.12 | 0.08 | 0.67–0.88 |

"Helps" alone passed the deflections; "helps" and "not mostly a deflection"
together got all eleven right. The offer check exists because the first
version accepted "staging availability, in Slack" at 0.79 — any tool that
sounded close would do. "Where it is kept" scored Slack for status 0.23–0.27,
GitHub for whether staging is up 0.56, Supabase for websocket errors
0.61–0.64, and Linear for Linear bugs 0.74–0.78; "asks for information" scored
"let's triage the flaky tests" at 0.07 (finding 12).

### 7.5 The follow-up check

Asked when an agent wrote one of the last three messages in the chat, within
five minutes (§4.2):

```jsonc
"state": { "agent_message": "…", "between": [ … ], "latest": "…" },
"questions": {
  "to_agent":        { "type": "noul", "instructions": "`latest` responds to, or follows up on, `agent_message`." },
  "to_someone_else": { "type": "noul", "instructions": "`latest` is addressed to a specific person other than the author of `agent_message`." }
}
```

`to_agent` > 0.8 and `to_someone_else` < **0.5** is a follow-up for the agent.
Then: if the agent's message was the reply to this person's own mention, their
run continues (a `run` ending); if the exchange has had three follow-ups
already, quiet (`follow_up_cap`); otherwise a draft, and the draft check. The
bar was 0.2 until "can we run them in parallel instead?", straight after the
agent's answer, scored 0.24 and was answered 90 seconds late instead; to Bob
scored 0.96. Real follow-ups in the spike scored 0.91–0.97; the fourth on one
exchange scored 0.92 and was still stopped.

### 7.6 What Jev is not asked

- **Timing.** First refusal is a clock per turn (`LULL` after the person's
  last message), and so are staleness (`STALE_AFTER`), the turn's limits (five
  messages, three minutes), the follow-up cap and the per-chat rate.
- **Whether an answer was welcome.** People say so, with "Not helpful here" (§10.2).
- **Anything code can compute** — counting, dates, arithmetic. TypeSafe's own
  notes are explicit that Jev is not a calculator.

Three of Jev 1.13's known weaknesses shape the design directly:

| Weakness | What this design does |
|---|---|
| **Literal reading** — it answers what was written, not what was meant | Each instruction states the exact condition and names the state field it is about |
| **Accuracy falls as unrelated state grows** | Each message of a turn is judged on its own, with only the window around it; the agent check reads the one turn |
| **State is not treated as hostile** | A message written to steer it ("an agent should definitely answer this") can move a probability. The worst case is an unwanted answer: a job has no tools, no connections and no invoker to misuse |

### 7.7 Pin the version, through TypeSafe's SDK

`jev-latest` moves when TypeSafe ships, and the answers behind it change without
a change here. Thresholds are tuned against a version, so the model is pinned to
`jev-1.13.0` and moved on purpose, after a pass of the spike on the new version.

The client is TypeSafe's own SDK (`@typesafe-ai/sdk`, pinned exact), behind a
thin wrapper (`jev.ts`). The SDK brings retries with backoff that honour
`retry-after` — one retry here, since a look already waits out a clock — and the
token count of every call. The wrapper keeps what the SDK leaves to us: the
pinned model (its default is `jev-latest`), a silent logger (its debug level
prints whole bodies, which hold message text), strict checking of the answers
(it returns the body typed but unverified), and a closed set of failure reasons.

---

## 8. Silence

Every path except a good answer ends with nothing posted:

| Outcome | Posted | Recorded as |
|---|---|---|
| Step 1 finds no open question, step 2 no agent that fits, the chat has had its three answers, or the exchange its three follow-ups | Nothing | `silent` |
| A follow-up continues the asker's own mention | Nothing here — their run answers | `run` |
| The answer fails its check — even when the offer beside it passes | Nothing | `suppressed` |
| The model returns nothing | Nothing | `declined` |
| The answer and the offer both fail their checks | Nothing | `suppressed` |
| TypeSafe fails or times out | Nothing | `gate_error` |
| The runtime fails or times out | Nothing | `failed` |
| The question is deleted, or the agent loses access to the chat, before posting | Nothing | `withdrawn` |
| Not ready within `STALE_AFTER` (5 min after the turn was due) | Nothing | `stale` |
| Everything passes, in shadow | Nothing; the draft is kept for review | `shadow` |
| Everything passes | The answer, the offer, or the answer with the offer after it | `posted` |

A mention's run "never ends silently" because somebody is waiting for it
(`WORKSPACE-AGENTS.md`, the reply §5.7). Nobody is waiting for an ambient
answer. One that arrives ten minutes late, under a question that has scrolled
away, is noise — which is what `STALE_AFTER` is for.

**Failing closed means failing silent**, and that makes a broken gate invisible
to users. So `gate_error` gets a signal of its own (§12).

`because` records why, from closed sets and never from text anyone wrote:
step 1's `no_need`, `handled`, `directed`, `rhetorical`, `needs_person`,
`sensitive`, `plan`; step 2's `unfit`; the loop's `rate_limited` and
`follow_up_cap`; a follow-up's `not_to_agent`; the draft check's `deflects`,
`not_useful`, `handled`, and the offer's `unknown_toolkit`, `not_info`,
`not_kept_there`, `offer_misfits` (joined with `+` when both parts failed); a
Jev failure's reason (`timeout`, `rate_limited`, `http_4xx`, `http_5xx`,
`network`, `malformed`); and `runtime`, `question_deleted`, `agent_left`,
`too_late`, `lease_expired`, `no_candidate`, `nothing_to_judge` and `error`.
The `gate1` column holds both steps' answers, as `message` and `agent`;
`gate2` holds the draft's kind and each check's answers.

---

## 9. The table and the loop

### 9.1 `ambient_decisions`, and what a look has judged

One row per look (migrations `031_ambient_decisions.sql` and
`033_ambient_turns.sql`). Server-only, never synced.

```sql
CREATE TABLE ambient_decisions (
  id                  TEXT PRIMARY KEY,                                    -- amb_…
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,                                       -- ambient (a turn) | follow_up
  from_ord            BIGINT NOT NULL,                                     -- the turn's first and last ord
  through_ord         BIGINT NOT NULL,
  trigger_message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,     -- the question answered
  agent_actor_id      TEXT REFERENCES actors(id) ON DELETE SET NULL,       -- the agent chosen, if any
  model               TEXT,                                                -- the versioned id that answered
  gate1               JSONB,                                               -- every probability, as returned
  gate2               JSONB,
  because             TEXT,                                                -- why it ended so (§8)
  draft               TEXT,                                                -- what the model wrote, as written
  reply_message_id    TEXT REFERENCES messages(id) ON DELETE SET NULL,
  exchange_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,     -- the agent message the exchange began with
  outcome             TEXT NOT NULL DEFAULT 'pending',
  lease_until         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,

  CONSTRAINT ambient_kind CHECK (kind IN ('ambient', 'follow_up')),
  CONSTRAINT ambient_outcome CHECK (outcome IN
    ('pending', 'silent', 'declined', 'suppressed', 'gate_error', 'failed',
     'withdrawn', 'stale', 'shadow', 'posted', 'run')),
  CONSTRAINT ambient_window CHECK (from_ord <= through_ord),
  CONSTRAINT ambient_once UNIQUE (chat_id, kind, through_ord)
);
-- One look at a time per chat: the insert is the claim.
CREATE UNIQUE INDEX ambient_one_look ON ambient_decisions (chat_id) WHERE outcome = 'pending';

-- Which person messages a look has judged.
CREATE TABLE ambient_judged (
  message_id   TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  decision_id  TEXT NOT NULL REFERENCES ambient_decisions(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Judged messages are rows, not a watermark.** The first design kept "the
largest ord judged so far" per chat, the summariser's reasoning. Turns
interleave — Alice's turn can be judged after Bob's although hers began first
— so a watermark would skip hers. A look writes the messages it judged to
`ambient_judged` (a turn's with the claim; a follow-up's once it is judged to be
for the agent), and a message is unjudged until it appears there. A message
that started a run — a mention, or a name used as one — is never judged either.

**`ambient_one_look` makes the insert the claim**, and makes looks in one chat
sequential: the second of two turns due together sees the first's answer, so
the same question from two people gets one answer, not two. **`exchange_message_id`**
names the agent message an exchange began with — an ambient answer's own
reply, or a mention's reply — so follow-ups can be counted per exchange.

### 9.2 The loop

A job in `apps/server` (`agents/ambient/loop.ts`), in the summariser's shape:
poll, claim, work, write. It calls the runtime the way the summariser does,
with no palette.

Every `POLL` (5 s), one pass: sweep claims past their lease to `stale`, then
follow-ups, then due turns — up to four looks, in different chats, handled
concurrently.

**Turns** (`dueTurns`), in channels and rooms active within the last day. The
database says which person messages nobody has judged — ordinary, undeleted,
for the whole chat, recent enough to still be answered (`LULL` plus
`STALE_AFTER`), not a run's trigger — in chats where an eligible agent is a
member, no run is queued or running, and no look is pending. Code groups them
into turns: what one person said in a row, each message within `LULL` of their
previous one, at most five messages and three minutes long. A turn is due
`LULL` after its last message, or once it has closed; other people's messages
are context, never a delay. One turn per chat per pass — the oldest due one —
so the next sees what this one posts.

Before anything is asked of Jev, a turn is dropped as `rate_limited` when the
chat has had three unprompted answers in the last ten minutes: an incident
channel with twenty people asking "is prod down?" does not need ten of them.

**Follow-ups** (`dueFollowUps`) are found by the same poll, never from the send
path: the newest message is a person's, an eligible agent wrote one of the
three messages before it within five minutes, nothing has judged it yet, it is
newer than `STALE_AFTER`, and no run or look is in flight. There is no clock.

**Eligible agents** are active, in `AMBIENT_AGENTS` when it is set (§10.3), and
able to read and post in the chat by their own grants — the ordinary `can()`.
The system's own agents are eligible too, since 2026-09-25. They were excluded
at first, on the reasoning that Roomkeeping writes summaries, not answers; that
also shut out Relay, the workspace's own assistant. In production, "what did I
miss here?" and "what is Anirudh up to?" then went to the only other agent in
the room — one set up for production triage, which did not fit (0.30) — and
nobody answered. Step 2 decides who fits, Relay and Roomkeeping included.

A claim past its lease is a server that died mid-look. The next pass sweeps it
to `stale`, and that turn is not looked at again: ambient answers are
best-effort.

**Why poll rather than a timer per message.** A timer is in-process state, lost
on a restart, and one more per message. A poll derives everything from stored
rows, survives a restart, and under the one-instance rule behaves like the
five jobs that already run (`DEPLOY.md`, the one-instance rule §2) — and with
`ambient_one_look`, two instances would not even duplicate.

### 9.3 Where it applies

| Space | Ambient | Why |
|---|---|---|
| Public and private channels | Yes | |
| Rooms — default, public and private chats | Yes | A private chat is read through the agent's own membership, like everything else |
| DM with an agent | **No** | There, every message should invoke — a rule, not a judgment (`WORKSPACE-AGENTS.md`, what starts a run §5.1; not yet built) |
| Group DM with an agent | Not yet (§16, question 2) | The question workspace agents already leaves open |
| DM between two people | Never | No agent is a member |
| A restricted or system message | Never evaluated | |

---

## 10. Rollout and tuning

### 10.1 Stages

1. **Shadow.** Both gates run and the job drafts; the outcome is `shadow` and
   nothing is posted. Run it over `pnpm mock` traffic and a week of the team's
   own.
2. **Read the drafts.** Agree beforehand what share of would-be answers a
   person must be glad to have seen, then read them and count. Tune the
   thresholds against the recorded probabilities, not by argument.
3. **On, per agent** (§10.3), in one workspace, at thresholds higher than the
   shadow data suggests.
4. **On by default**, once feedback (§10.2) says it is welcome.

### 10.2 Signals

| Signal | Meaning |
|---|---|
| **"Not helpful here"** — the control on the unprompted marker | Explicit: this answer missed |
| **A person answered anyway** within ten minutes | Redundant or wrong. Either way, the bar was too low |
| **A person replied to the agent** | Engaged. Those replies continue through the follow-up check |

**Feedback is recorded, not acted on.** Each press is a row in `agent_feedback`
(migration 032) — the message, who pressed it, and the kind — once per person.
The table is not about ambient answers: any agent message can be given
feedback the same way later. Nothing reads it yet: no backoff, no threshold,
no prompt. What to do with it — quieting an agent in a chat, tuning a bar — is
decided once there is enough of it to see what people are not liking (§15).

### 10.3 Switching it on

Environment settings, in the shape memory was rolled out with (`MEMORY_INGEST`,
`MEMORY_INGEST_SPACES`):

| Setting | Values | |
|---|---|---|
| `AMBIENT_MODE` | `live` (default, when unset), `shadow`, `off` | On by default since the first release, so people see it and can say what they think. Anything set and unrecognised is off, so a typo never turns it on. Without `TYPESAFE_API_KEY` it does not start, and the server says so at boot |
| `AMBIENT_AGENTS` | Agent handles, comma-separated | Only these answer unprompted. Unset is every agent |
| `AMBIENT_LULL_SEC` | Seconds, default 90 | First refusal (§3) |
| `TYPESAFE_API_KEY` | TypeSafe's key | Without it, or without the agent runtime, the server says so at boot and starts nothing |
| `TYPESAFE_BASE_URL` | Default `https://api.typesafe.ai` | Only a test or a proxy changes it |

`MEMORY_RECALL` decides whether a draft recalls memory, as it does for a run.

A per-agent switch on the definition, with its toggle in the agent editor, is
the form for stage 4 of the rollout (§10.1) and is deferred (§15). Whether it
should default to on is open (§16, question 1).

---

## 11. The client

- **The unprompted marker** is the `ambient` part (§6), drawn in the header as
  "unprompted · ↪ Alice" (`AmbientReference`, `AmbientMarker.tsx`); the name
  scrolls to the question. An explicit part rather than something derived from
  a NULL `delegation_id`: the replica does not hold `delegation_id`, and a
  later agent job that is not an ambient answer would have inherited the marker.
- **"Not helpful here"** in the footer, on hover, beside Copy
  (`DismissAmbient`). It calls `POST /ambient/:messageId/dismiss` through the
  sync process, as stopping a run does. Anyone who can read the chat may press
  it, once each; it is kept in `agent_feedback` (§10.2) and changes nothing
  about when the agent speaks; and it answers not-found for anything that is
  not an ambient answer the caller can read.
- **No working indicator.** A job never sends `agent_activity`.
- **An older desktop** that does not know the part shows "Part of this message
  needs a newer version of Relayed to display" above the answer's text — the
  renderer's existing fallback for a part kind newer than itself.

---

## 12. Observability

Built as proposed in this document (`AGENTS.md`, observability is part of the
feature, rule 8). No message body, and no chat or agent id as a metric label.
`ambient_gate` is one of `message` (step 1), `agent` (step 2), `draft`, `offer`
and `meanwhile` (the draft check's three calls), or `follow_up`.

| Marker | The question it answers |
|---|---|
| `ambient.decided`, a counter by `ambient_outcome` (the closed set in §8) | How often does an agent speak, and where does it usually stop? |
| `ambient.gate_error`, a counter by `ambient_gate` and `jev_error` | Is TypeSafe failing, so that agents are silent for a reason nobody can see? |
| `ambient.jev_ms`, a histogram by `ambient_gate` | Is a step ever what makes an answer late? Retries included |
| `ambient.jev_tokens`, a histogram by `ambient_gate` | What each step really costs, from the SDK's count — and the first sign of a window or summary growing past what it should |
| Span `ambient.look` (`chat_id`, `ambient_kind`, `decision_id`), with `ambient.jev` and `ambient.draft` beneath it | When one answer was wrong or late, where did the time and the decision go? |

**Deliberately not instrumented:** "not helpful" rates per agent or per chat.
They are in `agent_feedback`, where a query can slice them without a series per
id. **Not on a dashboard yet**, like the other agent metrics — only the sync
metrics are required to be (`dashboards.test.ts`).

---

## 13. Cost

**Jev is the small part.** A turn is two calls, about 500 tokens together, and
each call takes about 0.4 s (the spike's p50 0.37–0.39 s, p95 under 0.5 s): about
$0.21 per ten thousand looks. The draft check adds one to three calls per draft,
in parallel. A busy room now costs about one step-1 call per person's turn
rather than one per quiet spell — cents a day. Every call's real token count is
recorded (`ambient.jev_tokens`).

**The drafts are the real cost**: one model call per turn that clears both
steps. In the spike's last round, about one draft per two scenarios; the
per-chat rate and the follow-up cap bound the worst case.

---

## 14. Failure modes

| Failure | What happens |
|---|---|
| TypeSafe is down or slow | Silence, counted as `gate_error`. Mentions are untouched: they never call TypeSafe |
| TypeSafe moves `jev-latest` | Nothing; the model is pinned (§7.7) |
| A message is written to make an agent respond | At worst, an unwanted answer. The job has no tools, connections or invoker |
| Two agents both fit | The better fit speaks; the other stays silent |
| Two turns are due in one chat at once | One look at a time: the second is judged after the first posts, and sees its answer |
| The runtime is busy | The job waits for the next tick until `STALE_AFTER`, then goes `stale` |
| The server restarts mid-job | The lease expires and the next pass sweeps the row to `stale`; that window is not looked at again |
| The question is deleted mid-job | Checked before posting: `withdrawn` |
| The agent is removed from the space mid-job | The job's own `post` check fails: `withdrawn` |
| An ambient answer mentions another agent | Nothing starts — a message with no invoker starts no run (§5) |

---

## 15. Deliberately not built

| Not built | Adopt when |
|---|---|
| **Web search in jobs** | Shadow drafts show answers that needed it. It spends Relayed's money, not a person's account, so the question is budget, not authority |
| **Using the asker's own read-only connections for an unprompted answer** | People ask for it. Needs a standing, per-person grant — what workspace agents' deferral of scheduled agents says any run without a present invoker requires (`WORKSPACE-AGENTS.md`, deliberately not built §13). An offer, and a follow-up continuing the asker's own mention, cover the cases seen so far |
| **Offers where the agent's role does not cover the lookup** — "how many sync bugs are open in Linear?" fit an on-call agent at 0.48–0.54 | An agent whose role covers it is in the room. Fit stays by role: every agent can reach every toolkit, so a role-based fit is what keeps an on-call agent from offering to look up the leave policy in Google Drive (finding 14 of the spike) |
| **Two agents on one question** | A real case needs two perspectives on one question |
| **Offers only for tools someone in the workspace has connected** — today an offer may name any toolkit the deployment enables, Jira to a team on Linear (§7.4) | Feedback shows offers naming tools the team does not use. `connections` already says who has connected what; a workspace with none would get no offers |
| **A lighter rung** — a reaction instead of a message | Answers are right but feel heavy. Needs its own client surface |
| **A working indicator, or streaming** | Not for jobs while silence is the rule |
| **Acting on "not helpful"** — quieting an agent in a chat, or tuning thresholds from it | Enough feedback to see what people are not liking |
| **A per-agent switch on the definition**, with a toggle in the agent editor | Stage 4 of the rollout (§10.1): ambient answers on by default, and people choosing per agent |
| **A dashboard panel** for the three metrics | Someone asks how often agents speak unprompted and the table is not enough |

---

## 16. Open questions

1. **Default on or off**, per agent, once rolled out.
2. **Group DMs with an agent.** Every message, only mentions, or ambient? The
   question `WORKSPACE-AGENTS.md` leaves open (open questions §15). Excluded
   until it is answered.
3. **Drafts in shadow.** They are text derived from messages. Keep for
   fourteen days, delete with the chat (the cascade does it), and delete when
   the question is deleted?
4. **`LULL`.** 90 seconds after a person's last message is a guess to be
   tested, not a measurement — as are five messages and three minutes for a
   turn, three follow-ups, and three answers per chat in ten minutes.
5. **TypeSafe as a subprocessor.** Message text leaves for a third party.
   TypeSafe states it does not train on requests and offers zero data
   retention on enterprise plans. It belongs on the same list as the model
   providers and Hindsight before anything leaves shadow.

Settled while building: mention replies and ambient answers land in the same
place (§6), and the marker is an explicit part (§11).

---

## 17. Implementation, as built

| Step | What | Where |
|---|---|---|
| 0 | One function for a reply's parent | `replyParentOf`, `agents/transcript.ts` |
| 1 | The TypeSafe client, on TypeSafe's SDK, pinned; the tuning harness | `agents/ambient/jev.ts`; `pnpm --filter @relayed/server run ambient-gate <chat-id> [messages]` |
| 2 | The tables and the loop: turns, one look at a time, the limits | `031_ambient_decisions.sql`, `033_ambient_turns.sql`, `agents/ambient/loop.ts` (`dueTurns`, `groupTurns`, `dueFollowUps`) |
| 3 | Step 1 and step 2 | `messageCheck`, `judgeTurn`, `agentCheck`, `decideAgent` in `agents/ambient/gates.ts` |
| 4 | The job: the draft, the answer and offer checks, recall with no person bank | `ambientRules`, `decidePost` in `loop.ts`; `readDraft`, `draftCheck`, `offerCheck`, `answeredMeanwhile`, `decideDraft`, `decideOffer` in `gates.ts`; `banksForRun` and `recallForRun` take a NULL invoker |
| 5 | Posting: the server-written reference, the marker, "Not helpful here" | `AmbientPart` in `@relayed/protocol`; `agents/ambient/routes.ts`, `032_agent_feedback.sql`; `AmbientMarker.tsx` |
| 6 | Follow-ups: continuing the asker's own mention, the cap | `dueFollowUps`, `loop.ts`; `startRunFor`, `agents/checkpoints.ts` |
| 7 | A name used as an address | `addressedAgent`, `sync/mentions.ts`; `invocationsFor`, `agents/checkpoints.ts` |

The first design — the window judged at once — is kept in
`spikes/ambient/window-design.ts`, and the flow before turns in rounds 1–4's
results, so the spike can still compare against them.

**Proved before it was built:** rounds 5–5c of the spike ran this flow's every
rule over 67 scenarios three times each — edge cases, several agents, and 35
that should end in silence — 191 of 201 runs right, none out of turn
(`spikes/ambient/README.md`, findings 11–18). The ten misses are six of the
accepted gap (finding 14) and four one-in-three variances at a bar.

### Tests that must exist, and where they are

| Must hold | Held by |
|---|---|
| A job's message has NULL `on_behalf_of_actor_id` and `delegation_id`, and starts no run even when it mentions an agent | `loop.test.ts`, "an ambient answer is the agent speaking with nobody's authority" |
| Recall with no invoker never opens a person bank | `banks.test.ts`, "a job — an ambient answer with no invoker — reads no person bank" |
| An agent's own message is never evaluated | `loop.test.ts`, "a chat whose newest message is an agent's is never due" |
| No TypeSafe call inside the send transaction | The boundary rule `ambient/never-in-the-send-path`: nothing in `sync/`, `checkpoints.ts`, `dispatcher.ts` or `reply.ts` may import from `agents/ambient/`. A rule rather than a test, because a test could only show one send not calling it |
| Every ending but `posted` posts nothing | `loop.test.ts`, "every ending but a good answer posts nothing" — ten endings, a decline the model spelled its own way among them — and the shadow test |
| The draft check re-reads the chat | `loop.test.ts`, "the draft check reads the chat again" |
| The same turn is never acted on twice | `loop.test.ts`, "the same turn is never acted on twice"; and the `ambient_once` constraint test |
| An agent that loses access mid-job does not post | `loop.test.ts`, "an agent that loses access to the chat mid-job does not post" |
| A turn is one person's messages in a row; others' never delay it; two lines get one answer; a newer question never buries an older one | `loop.test.ts`, "what one person said in a row is a turn…", "a turn is due once its author has been quiet…", "two questions back to back…", "a newer question from someone else does not bury an older one" |
| One look at a time per chat | `loop.test.ts`, "one look at a time per chat…"; the `ambient_one_look` constraint test |
| Three answers per chat in ten minutes, then quiet, before any Jev call | `loop.test.ts`, "three unprompted answers in a chat in ten minutes, then quiet" |
| A follow-up to the asker's own mention continues their run, for them alone (invariant 94) | `loop.test.ts`, "a follow-up to the asker's own mention continues their run, with their tools" |
| Three follow-ups per exchange | `loop.test.ts`, "three follow-ups on one exchange, then quiet" |
| An offer's sentence is the server's; the wrong tool is dropped and the answer beside it still posts | `loop.test.ts`, "an answer may end with an offer…", "an offer for the wrong tool is dropped…" |
| A name used as an address is a mention — with a comma, after a greeting, or before a question word; the word in a sentence is not | `mentions.test.ts`, "a name used as an address at the start is a mention…"; `loop.test.ts`, "an agent's name used as an address is a mention…" |
| A guess is not an answer; a nudge is read with what it nudges; the pick never falls on an agent under the bar; an offer written mid-paragraph never posts in the model's words | `gates.test.ts`, "step 1 asks seven things…", "step 2 asks which agent…", "Jev's pick only breaks a tie…", "an offer written mid-paragraph…" |

Four of those were checked by planting the bug they guard against — spending
the asker's authority, keeping notifying links, skipping the re-read, ignoring
a run in flight — and seeing the suite fail each time.

---

## 18. Docs changed with this

| Doc | Change |
|---|---|
| `DESIGN.md`, agents at the transport layer (§6.5) | Agents may also answer unprompted, as jobs; the same placement as a mention's reply |
| `DESIGN.md`, invariants (§14) | 89 to 94, below |
| `WORKSPACE-AGENTS.md`, the reply (§5.7), the checkpoints (§5.9), deliberately not built (§13) | The three points in this document's header; a name used as an address invokes (§5.1) |
| `MEMORY.md`, what a run recalls (§7.1) | Recall with no invoker, and why it opens no person bank |
| `AGENT-RESPONSES.md` | The `ambient` part |
| `STACK.md` | TypeSafe |
| `DEPLOY.md` | The settings in §10.3 |
| `AGENTS.md` | This doc in the documentation table; fourteen boundary rules |


### Invariants added

Numbering continues after the access card's invariant, 88
(`WORKSPACE-AGENTS.md`, invariants to add). All six are in `DESIGN.md` §14.

| # | Invariant | What breaks without it |
|---|---|---|
| 89 | **An inferred answer has no invoker** — written as a job, with `on_behalf_of_actor_id` and `delegation_id` NULL | Someone's name, and their connections, behind something they did not ask for |
| 90 | **A message written with no invoker starts no run** | An ambient answer that mentions an agent starts a run spending nobody's authority, or the wrong person's |
| 91 | **No TypeSafe call inside the send transaction** — held by the boundary rule `ambient/never-in-the-send-path` | A third party's latency holds a Postgres transaction open and slows every send |
| 92 | **A job never reads a person bank** | One person's private memory is posted to a room |
| 93 | **Only a person's message is evaluated** | Two agents answer each other, with no chain depth to stop them |
| 94 | **A run started from a follow-up spends only the authority of the person who wrote it, and only when their own mention began the exchange** — `startRunFor`, from the loop, for that person, at depth 1 | Bob's reply to an answer Alice asked for runs on Alice's connections, or on nobody's |
