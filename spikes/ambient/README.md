# Ambient answers spike

What an agent should do when a message in its room did not mention it
([`docs/AMBIENT-RESPONSES.md`](../../docs/AMBIENT-RESPONSES.md)), tested on
scripted room conversations before any threshold is settled. Rounds 1–4 (31
scenarios) settled the design that shipped; rounds 5–5c (67 scenarios, edge
cases, several agents and negatives included) settled the next one — a clock per
turn, an answer per open question, offers — before it is built.

Executable model, not app code. It imports the app's own TypeSafe client, gate
code and draft path, so what it tests is what ships; the design it proposes lives
in `designs.ts` until the results say it should become app code.

```bash
cd spikes/ambient
npm run spike        # round 4: the app's own code, three runs of each scenario → results/run-v4.json
npm run spike:v1     # round 1: the gate as first built           → results/run-v1.json
npm run spike:v2     # round 2: per-message, adjusted bars        → results/run-v2.json
npm run spike:v3     # round 3: round 2 plus a live-state check   → results/run-v3.json
npm run gate2        # gate 2 wordings on round 1's drafts        → results/gate2-variants.json
npm run audit        # rounds 1–4 → results/audit.md and audit.json

npm run flow         # round 5d: 5c plus the first live test's fixes, 76 scenarios × 3  → results/flow-v5d.json
npm run flow:5e      # round 5d plus "help: answer it, or know where to look"          → results/flow-v5e.json
npm run flow:5c      # round 5c                                                         → results/flow-v5c.json
npm run gate         # the release gate: the app as built, 76 scenarios × 3             → results/flow-vgate.json
npm run flow:5       # round 5, as first written                    → results/flow-v5.json
npm run flow:5b      # round 5b                                     → results/flow-v5b.json
npm run flow:audit   # rounds 5, 5b, 5c → results/flow-audit-<round>.md and .json
```

Needs `TYPESAFE_API_KEY` and the agent runtime settings in the repo-root `.env`.
A round is ~30 seconds and ~100 TypeSafe calls plus ~14 drafts per run of the
scenarios. Nothing is written to the database; the key is never printed.

**Status.** Rounds 1–4: done and adopted — round 2's design is the app's
(`apps/server/src/agents/ambient/gates.ts`), and round 4 ran the app's own code
through every scenario three times. Rounds 5–5c: done and built — the flow in
`flow-scenarios.ts`, with round 5c's pieces (`flow.ts`), is now the app's
(`gates.ts`, `loop.ts`; `docs/AMBIENT-RESPONSES.md`). Round 4 is no longer an
exact rerun of app code: the app has since moved to turns.
The design first built is kept in `window-design.ts` so round 1 can still be
rerun against it; `FLOW_ROUND=5` and `5b` rerun the earlier flow rounds.

## How it works

**Ground truth first.** Every scenario in `scenarios.ts` says what should happen
— which agent answers which message, or silence — and why. It was written before
the first run, as the memory spike wrote its facts first. The agents are
configured the way people actually configure them: Triage is set up as "You are
a on call assistant", described as "Triage agent for SWAT"; Scribe has a
sentence of instructions and no description.

**Simulated clock, real everything else.** The loop's rules — the 90-second lull
a new message restarts, follow-ups checked straight away, the window starting
after the last agent message, a mention being the mention path — run on a clock
the spike advances itself. A reply at t = 40 lands inside the lull as it would in
a room, without waiting 90 seconds for it. Every TypeSafe call is real, every
draft is a real run on the agent runtime, and the time each takes is added to the
clock, so a reply that arrives while the agent is drafting is seen by gate 2
exactly when it would be.

**Both designs at every look.** The built gate (the window judged at once) and
the per-message design (each person's message judged on its own, then which agent
for the chosen one) run side by side on the same window. The room follows the
per-message design's branch.

## Results

Judged against today's expectations, which carry decision 4 below — S04 and
S22, questions about live state, are to stay quiet. Against the expectations
they ran with, rounds 1 and 2 each missed those two as well (round 2 was 29 / 31).

| | Right | Spoke when it should not | Missed an answer | Drafts |
|---|---|---|---|---|
| Built (window at once, literal gate 2) | **26 / 30** | none | S01, S03, S05, S08 | 11 |
| Per-message, built bars (round 1) | **26 / 30** | none | S01, S03, S07, S08 | 11 |
| Per-message, adjusted (round 2) | **31 / 31** | none | none | 14 |
| **The app's code as shipped (round 4, three runs)** | **30 / 31 every time · 92 / 93 runs** | none | S07 once in three — finding 10 | 42 |

No design ever spoke when it should not have. Every miss was a question left
unanswered. Every scenario, every draft and the timings are in
[`results/audit.md`](results/audit.md).

## Rounds 5–5c — the next flow

Run after two people had used the shipped design in one room: a question was
buried under an unrelated one, chatter delayed an answer, and a question about
live data got silence where an offer to look it up would have helped. The flow
under test is written out at the top of `flow-scenarios.ts`; in short, a turn is
judged 90 s after its author's last message (other people are context, not a
delay), every open question gets an answer, a reply to an agent is a follow-up
judged at once, a name used as an address is a mention, a draft may end with an
OFFER to look something up in a connected toolkit, one look at a time per chat,
three unprompted answers per chat per ten minutes. Two more step-1 questions per
message (something only a person can give; personal or sensitive), and in 5c a
third (a plan or an instruction for the team).

**Sixty-seven scenarios**: the 31, plus 36 new ones — turns and timing, addressing,
kinds of ask, offers, follow-ups, several agents, busy rooms. Thirty-five expect
silence. `flow-run.ts` replays them exactly as `run.ts` does: a simulated clock,
real Jev, real drafts. Judged end to end by `flow-audit.ts`: the acts agents took
against the acts expected, on time, within the limits.

| Round | Right | Spoke when it should not | Quiet cases quiet |
|---|---|---|---|
| 5 — as first written | 168 / 201 | 11 runs — 9 of them offers | 100 / 108 |
| 5b — offers must name where the thing is kept; general knowledge allowed; "none" no longer overrules a fit; "answered" tightened | 177 / 201 | 9 — an instruction read as its own, and the race in S27 | 100 / 108 |
| **5c — plans and instructions stay quiet; answer *and* offer; best fit that passes speaks** | **191 / 201** | **none** | **105 / 105** |

(Round 5c has 35 quiet scenarios, not 36: S27 became "read by hand", finding 17.)
The ten misses left: O01 and O02 six times (finding 14, accepted), and one
run in three of S03, S07, F03 and M01 — drafting and score variance at a bar,
and one where the other agent's answer covered the question (finding 18).

**11. The clock per turn holds.** All 27 timing runs right in rounds 5 and 5c:
chatter by others no longer delays an answer (T01, answered at 98 s under 100 s
of chatter); two questions back to back get one answer (T02); a newer question
no longer buries an older one (T03); the same question from two people gets one
answer, because one look at a time means the second sees the first's answer
(T04); a question waits out a mention run and is then answered (T06).

**12. Fake offers were the costly failure, and "where it is kept" stops them.**
Round 5 offered to look up "staging availability" in Slack (S04, three of
three), "websocket server error logs" in Slack (S22) and, in an incident, two
offers of "incident status" in Slack (B01). The offer check accepted them at
0.78–0.81. Asked instead whether the tool is *where what the question asks about
is kept — its system of record, not somewhere people might have talked about it*,
Slack for status scored 0.23–0.27, GitHub for staging 0.56, Supabase for websocket
errors 0.61–0.64 — and Linear for Linear bugs 0.74–0.78. The bar is 0.7. A second
question, *does the message ask for information* (not a plan, a proposal or an
instruction), scored "let's triage the flaky tests" at 0.07.

**13. Answer OR offer made the agent flip; answer AND offer settled it.** With
either/or (5b), the agent offered Jira for "are we on track for Oct 14?" in one
run of three although the room summary held the answer, and offered Google
Drive for "why is the rebuild 3x slower?" in two — both suppressed, both
questions left unanswered. Told to answer what it can and *end* with an offer
only when the rest is in the team's own tools (5c), it answered every time.
The offer sentence is written by the server, never the model.

**14. Agent fit blocks lookups an on-call agent is not for — accepted.** "How many
open bugs tagged sync in Linear?" fit Triage at 0.48–0.54; "did the drain PR get
merged?" 0.38–0.45 with a Choice of none. The fit is judged from the agent's
role, and every agent can reach every toolkit, so a role-based fit is the only
thing that keeps an on-call agent from offering to look up the leave policy in
Google Drive. Decided: fit stays by role; these two stay unanswered until an
agent whose role covers them is in the room.

**15. A plan or an instruction is not a question.** 5b let the agent answer from
general knowledge, and "Triage the deploy failures first, then the flaky tests"
drew "I'll triage deploy failures before investigating flaky tests" three times
out of three — an agent promising work it cannot do, and reading its own name as
an address. A step-1 question, *is this a plan, a proposal or an instruction for
the team*, scored it 0.97 and "let's triage the flaky tests" 0.96; questions that
should be answered scored under 0.1 (two quiet-anyway cases, "Bob can you pair
after lunch?" and "hey bots, say something", 0.65 and 0.51). The drafting rules
now also say: you cannot do anything here but answer; never say you will.

**16. The new step-1 questions separate cleanly.** *Personal or sensitive*:
layoffs 0.92, pay 0.84, someone's health 0.96; everything else 0.14 and below.
*Something only a person can give*: a review 0.95, "thoughts?" on a status
update 0.93, a decision 0.77; questions that should be answered 0.03–0.25. Bars
0.5 for both, with the sensitive one checked first and silencing the whole turn.

**17. Jev's pick versus the fit.** "When does 0.0.2 launch?" was picked for
Triage at 0.54 while Scribe fit at 0.62, and nobody answered; "who owns the
rollback script?" fit 0.63 with a pick of none. In 5c the best fit that passes
speaks and the pick only breaks a tie (within 0.05). No quiet case changed:
lunch, leave policy, snacks and bait all fit under 0.5. And once an agent may
answer from general knowledge, S27 (Bob answers 5 s after the lull) became a
race — the draft posts at 3.8 s, before Bob — so it is read by hand; S27b (Bob
during the draft) still tests the meanwhile check, and passed every run.

**18. What the misses look like now.** S03's draft in one run scored 0.37 for
helping (variance); S07's fit sat at exactly the 0.55 bar once; F03's offer
check at 0.69 against 0.7 once; and in M01 Scribe's release notes mentioned who
is on call, so Bob's question was already answered (0.96) when its turn came —
the right outcome, the wrong expectation. Two soft spots worth knowing: in the
incident channel (B01) the agent posted a hedge ("no evidence yet that the
database is the cause…") in two runs of three — inside the one-post limit, not
useful; and an offer was appended to a complete answer (T02, Jira) in two runs.

**19. The first live test, with two people (rounds 5d and 5e).** Three misses
became nine scenarios (L01–L09): a guess ("i guess 5th? idk") counted as an
answer at 0.73; a nudge ("yeah, anyone?") fit the agent at 0.51, judged alone;
"Triage who is looking into sync engines?" was not a mention without its comma.
Round 5d fixed all three — the guess scores 0.04, the name before a question
word is a mention, "Triage is broken again" is not — at 210 of 228 runs right,
none out of turn, all 114 quiet runs quiet.

**20. Two bugs in the built code, found by 5d and 5e.** The tie-break could fall
on an agent under the bar (Triage 0.56, Scribe 0.53, Scribe picked: silence);
and an offer the model wrote mid-paragraph, not on its own line, was posted as
part of the answer ("…so far. OFFER: current incidents | Slack"). Both fixed in
the app (`decideAgent`, `readDraft`) and used by the spike from 5d on.

**21. "Help — answer it, or know where to look" fixes lookups without widening
what fits (5e).** 220 of 228 runs right: offers 13 of 15 (the Linear count 3 of 3,
which fit an on-call agent at 0.48–0.54 before), follow-ups 21 of 21, and all 114
quiet runs still quiet — the leave policy, lunch and snacks did not start to fit.
Its one run out of turn was finding 20's inline offer. Adopted into the app
for the first release.

**22. A nudge is still missed (L02, 0 of 3 in both).** Step 2 now reads it with
the question before it, but the draft check does not: it judges the draft
against "yeah, anyone?" alone, and held it back (helps 0.49). The same fix —
the earlier messages in the draft check's state — is the next round.

**23. The release gate (2026-09-24): the app as built, every piece its own.**
`npm run gate` runs every scenario three times through the app's step 2,
drafting rules, reading of the draft and choice of agent. First run: 219 of 228
right, all 114 quiet runs quiet, but two posts out of turn — the same one twice:
the model answered and offered, the answer came out hedged and failed its check,
and the offer posted on its own ("I can look up the cutover plan in Jira") for a
question the room summary answered. Fixed: an offer stands alone only when the
model wrote nothing but the offer. Second run, the first release: **219 of 228
right, none out of turn, 114 of 114 quiet runs quiet**
(`results/flow-audit-gate.md`; the first run is `flow-audit-gate-1.md`). The
nine misses: the nudge (L02, 0 of 3, finding 22), a PR offer at the fit bar
(O02), and one run in three of S02, S03, F03 and B02 — in B02 the agent's own
earlier answer had already named who owns the script, so the second question
was answered before its turn.

**Decided after round 5c:** build the flow as `flow-scenarios.ts` describes it
with round 5c's pieces — the three new step-1 questions at 0.5, the offer check
(kept there 0.7, asks for information 0.5, fits 0.7), answer-and-offer drafting,
best-fit-that-passes, the turn limits (5 messages, 3 minutes), 3 follow-ups per
exchange, 3 unprompted posts per chat per 10 minutes, one look at a time per
chat. Two scenarios were redesigned between rounds for flaws in their setup,
not their expectation: F04's follow-ups did not reply to the agent, so the cap
was never reached; M01's second question was answerable inside the first's
answer (it still is, finding 18).

## What round 1 found

**1. Judging the window at once is the root failure.** A question followed by
chatter (S03) scored 0.52 for "is there an open need" as a window; judged on its
own, 0.97. And two questions where a person answered one (S05) read as
"handled" for the whole window. Asked per message, the scores separate cleanly:

| Per message | Should count | Should not | Built bar | Round 2 bar |
|---|---|---|---|---|
| Asks something | questions 0.94–0.99 | chatter, statements ≤ 0.34 | 0.65 | 0.65 |
| Already answered by a later message | real answers 0.96–0.98 | "no idea, haven't checked" 0.32; open ≤ 0.15 | 0.2 | **0.5** |
| Addressed to a named person | 0.98 | open questions ≤ 0.16 | 0.2 | **0.5** |
| Meant to get an answer | real questions 0.72–0.93 | venting 0.22, a joke 0.28 | 0.5 | 0.5 |

**2. Which agent: the fit decides whether, the Choice only which.** Questions an
agent should take had a fit of 0.75–0.93 (a vault how-to 0.60); questions none
should take, 0.14–0.48 — so 0.55. The Choice's confidence nearly blocked two right
answers (0.75, 0.72 against 0.7) and blocked a third (0.32): with one agent in the
room it only asks "this one or nobody", which the fit already answers. Round 2
drops that bar and lets the Choice pick the agent.

**3. Gate 2 was literal, and diluted.** "Does the draft directly and materially
answer the question" held back "Yes — the plan is complete, cutover Oct 14" for
"are we working on the sync engine?" at 0.29: *working on* against *complete*,
read literally, with "yo" and "Excited for the launch" in the same state. On all
eleven round-1 drafts, each labelled by hand:

| | Good drafts (8) | Borderline (1) | Deflections (2) |
|---|---|---|---|
| "directly answers" | 0.61–0.93 | 0.76 | 0.28–0.40 |
| "would help the person who asked" | 0.76–0.93 | 0.88 | 0.80–0.81 |
| "mostly says it cannot see or know" | 0.05–0.12 | 0.08 | 0.67–0.88 |

"Helps" alone lets deflections through; "helps" **and** "not mostly a
deflection" got all eleven right. Round 2 asks those two about the draft alone,
and "has anyone answered meanwhile" as a separate call over the later messages,
in parallel.

**4. Follow-ups: one bar too tight.** "Can we run them in parallel instead?"
straight after Triage's answer scored 0.96 for "to the agent" and 0.24 for "to
someone else", against a bar of 0.2; the lull then answered it 90 seconds late.
To Bob scored 0.96 and to the agent 0.11–0.24, so 0.5.

**5. Drafts are fast, so the race is different from the one designed for.**
Drafts took 1.8 s (p95 2.6 s). S27's reply five seconds after the lull came
after the draft was done — in a real room, the agent would have answered first.
S27b puts the reply one second into the draft: gate 2 saw it and scored "answered
meanwhile" 0.91. The re-read works; the likelier race is a person answering just
after the agent posts, which nothing here handles.

## What round 2 found

**6. Questions about live state cannot be answered unprompted.** "Is staging
down right now?" and "is the websocket server throwing errors again?" (S04, S22)
passed both gates, and the drafts were "I can't see the websocket server logs
from here. I'd check…" — gate 2 held them back as deflections (0.86–0.92). An
unprompted agent has no tools, so it can only describe what it would check. The
scenarios expected an offer; this is a product decision, not a threshold (below).

**7. The decline sentinel is not reliable.** Told to reply exactly `NOTHING`
when it has nothing to add, the model replied `NO_CONTENT` to "thanks triage!".
`cleanDraft` only knows `NOTHING`, so it went to gate 2 as an answer — which held
it back (useful 0.03). Without gate 2 the agent would have posted "NO_CONTENT".

**8. Deflections cost a draft each.** Five of fourteen round-2 drafts were
written and then held back — both live-state questions, both timing scenarios,
and the thank-you. Everything else is cheap: every TypeSafe call is ~0.4 s
(p50 0.37–0.39 s, p95 under 0.5 s), and a look is ~500 tokens — about $0.21 per
ten thousand looks.

## What round 3 found

**9. A check for "is this about live state?" costs right answers.** Tried as a
way to skip the draft that finding 6 always throws away, it scored the four
live-state questions 0.83–0.96 — and "why is the index rebuild taking 3x longer
than the runbook?" 0.77. That one is about a live system too, but the room
summary holds its answer, and rounds 2 and 4 post a right one. The check cannot
tell "about live state" from "the room already knows", so it was not adopted:
live-state questions stay quiet through gate 2's deflection check instead, at
the cost of a draft each.

Round 3 also showed a right answer held back because the draft only implied its
yes: "The evaluation and adoption plan are complete…" to "are we working on the
sync engine?" scored 0.31 for helping, where round 2's "Yes — the evaluation…"
scored 0.85. That became a drafting rule, below.

## What round 4 found — the app's own code

**10. It holds, and the drafting rule works.** Every scenario ran three times
through the shipped gates, TypeSafe's SDK and the drafting prompt: 92 of 93
runs right, none spoke out of turn. All six drafts for the two sync-engine
questions opened "Yes —" and all six posted. The one miss was a vault how-to
whose draft, in one run of three, said "I can't see the runbook or your Vault
configuration — mention me…"; the deflection check held it back at 0.52. The
gate did its job on a weak draft — this is drafting variance, not a threshold.

## Decided (2026-09-23)

1. **Per-message design — adopted.** `messageCheck`, `pickQuestion`, `agentCheck`,
   `decideAgent` in `gates.ts`.
2. **Round 2's bars — adopted**, in `THRESHOLDS`, each with its evidence.
3. **Split gate 2 — adopted.** `draftCheck` and `answeredMeanwhile`, in parallel.
4. **Live-state questions — stay quiet**, through the deflection check. The
   pre-check that would have saved the draft was tested in round 3 and rejected
   (finding 9).
5. **The decline word — fixed.** Any bare decline (`NOTHING`, `NO_CONTENT`,
   `NONE`, `N/A`…) is a decline; gate 2 stays the backstop.

And two that came out of rounds 3 and 4: the drafting prompt now says to start
with yes or no when the question can be answered that way, and the client runs
on TypeSafe's SDK (`@typesafe-ai/sdk`, pinned) for its retries and token counts,
behind the same wrapper.

## Limits

- Rounds 1–3 ran each scenario once; round 4 three times. Jev's scores repeat
  to ±0.02, so the variance that matters is the drafts' (finding 10). The bars
  have not met a second, unseen set of scenarios.
- The ground truth is one person's judgment of what a colleague would do.
- English only; no memory recall in the drafts (the rooms' summaries stood in).
- Thirty-one scenarios is enough to find failure modes, not to measure rates;
  sixty-seven is still that.
- The enabled-toolkit list in `flow-scenarios.ts` is the dev deployment's on
  2026-09-23. Rooms with a monitoring tool connected would offer where these
  stayed quiet (S04, S22, O03).
