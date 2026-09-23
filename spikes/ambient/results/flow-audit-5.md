# Round 5 — the settled decision flow

Ran 2026-09-23T13:19:57.014Z, 3 run(s) of 67 scenarios, jev-1.13.0. Wall time 146s.

**168 of 201 runs right.** Scenarios right every run: 53 of 67.
Spoke when it should not have (an extra answer or offer, or too many): **11** run(s).
Should-stay-quiet scenarios: 36, quiet in 100 of 108 runs.

| Group | Scenarios | Runs right |
|---|---|---|
| answers | 8 | 15 / 24 |
| stays quiet | 12 | 36 / 36 |
| several agents | 8 | 16 / 24 |
| follow-ups | 7 | 16 / 21 |
| turns and timing | 9 | 27 / 27 |
| addressing | 7 | 19 / 21 |
| adversarial | 2 | 6 / 6 |
| kinds of ask | 7 | 21 / 21 |
| offers | 5 | 9 / 15 |
| busy rooms | 2 | 3 / 6 |

## Every scenario

### answers

**✅ S01 — A how-question to the room that nobody takes** · 3/3 · expected: answer @triage #0

> The room summary holds the answer (partitions one at a time).


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.02 wants 0.88 human 0.18 sens 0.01 · step 2 @triage (@triage 0.77) · draft answer (useful 0.80, deflects 0.41) · → answer
```
> **@triage answer** at 94s: The runbook estimate may not apply to the one-partition-at-a-time approach; that was chosen to reduce primary load. The current bottleneck needs live job and primary-load data to identify.

**✅ S02 — A status question about work the agent did here** · 3/3 · expected: answer @triage #0

> Triage built the sync-engine deck in this room.


```
90s turn [2] · step 1 open: #2 need 0.96 ans 0.13 person 0.10 wants 0.84 human 0.11 sens 0.02 · step 2 @triage (@triage 0.92) · draft answer (useful 0.93, deflects 0.04) · → answer
```
> **@triage answer** at 92.9s: Yes — the sync-engine evaluation and adoption plan are complete, including phased rollout, POC gates, dual-run migration, and rollback. Phase 1 cutover is planned for Oct 14.

**✅ S03 — The same question, with chatter after it** · 3/3 · expected: answer @triage #0

> Chatter after a question does not answer it. The live failure.


```
155s turn [2,3,4] · step 1 open: #2 need 0.94 ans 0.09 person 0.11 wants 0.77 human 0.13 sens 0.02; #3 need 0.17 ans 0.10 person 0.06 wants 0.45 human 0.08 sens 0.02; #4 need 0.03 ans 0.08 person 0.05 wants 0.15 human 0.04 sens 0.03 · step 2 @triage (@triage 0.88) · draft answer (useful 0.86, deflects 0.11) · → answer
```
> **@triage answer** at 158.4s: Phase 1 sync-engine cutover is planned for Oct 14, with phased rollout, POC gates, dual-run migration, and rollback included in the adoption plan.

**🔴 S04 — "No idea" is not an answer** · 0/3 · expected: quiet

> Was "answer, expect an offer". Changed after round 2 by decision 4: an unprompted agent has no tools, so it stays quiet on questions about live state rather than post "I can't see it".

- spoke: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.28 person 0.08 wants 0.87 human 0.06 sens 0.02 · step 2 @triage (@triage 0.82) · draft offer (fits 0.79, handled 0.29) · → offer
120s turn [1] · step 1 no_need: #1 need 0.03 ans 0.71 person 0.17 wants 0.30 human 0.06 sens 0.02 · → silent (no_need)
```
> **@triage offer** at 92.3s: I can look up staging availability and recent incidents in Slack for you. Mention me if you want me to.

**✅ S05 — Two questions; a person answers one** · 3/3 · expected: answer @triage #2

> The runbook question is open and the summary answers it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.97 person 0.05 wants 0.85 human 0.05 sens 0.01 · → silent (handled)
110s turn [1] · step 1 no_need: #1 need 0.03 ans 0.07 person 0.11 wants 0.16 human 0.02 sens 0.01 · → silent (no_need)
140s turn [2] · step 1 open: #2 need 0.99 ans 0.08 person 0.02 wants 0.87 human 0.04 sens 0.01 · step 2 @triage (@triage 0.77) · draft answer (useful 0.92, deflects 0.04) · → answer
```
> **@triage answer** at 143.2s: The rollback procedure is in the QUARTZ runbook, section 4. [Bob Iyer](actor-ref:act_bob) owns the rollback script.

**✅ S06 — The answer is already in the room summary** · 3/3 · expected: answer @triage #0

> Phase 1 is Oct 14, per the summary.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.13 person 0.07 wants 0.90 human 0.05 sens 0.01 · step 2 @triage (@triage 0.76) · draft answer (useful 0.88, deflects 0.04) · → answer
```
> **@triage answer** at 92.3s: Phase 1 cutover is planned for Oct 14.

**🔴 S07 — The asker clarifies inside the lull** · 0/3 · expected: answer @triage #0,1

> One question in two messages; one look, one answer.

- missed: answer by @triage to #0,1
- spoke: offer by @triage to #0,1

```
130s turn [0,1] · step 1 open: #0 need 0.98 ans 0.14 person 0.04 wants 0.92 human 0.03 sens 0.03; #1 need 0.34 ans 0.06 person 0.05 wants 0.66 human 0.02 sens 0.02 · step 2 @triage (@triage 0.55) · → silent (unfit)
```

**🟠 S08 — A request phrased as a statement** · 0/3 · expected: answer @triage #0

> An implicit ask, squarely on-call.

- missed: answer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.97 ans 0.06 person 0.08 wants 0.74 human 0.07 sens 0.03 · step 2 @triage (@triage 0.82) · draft offer (fits 0.67) · → suppressed
```

### stays quiet

**✅ S09 — Answered by a person inside the lull** · 3/3 · expected: quiet

> Bob answered and took it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.97 person 0.10 wants 0.84 human 0.05 sens 0.02 · → silent (handled)
130s turn [1] · step 1 no_need: #1 need 0.04 ans 0.11 person 0.24 wants 0.30 human 0.02 sens 0.04 · → silent (no_need)
```

**✅ S10 — Taken on, not yet answered** · 3/3 · expected: quiet

> Somebody said they are handling it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.98 person 0.03 wants 0.91 human 0.50 sens 0.02 · → silent (handled)
120s turn [1] · step 1 no_need: #1 need 0.02 ans 0.08 person 0.06 wants 0.27 human 0.03 sens 0.02 · → silent (no_need)
```

**✅ S11 — Asked of a named person, with @** · 3/3 · expected: quiet

> Addressed to Bob.


```
90s turn [0] · step 1 directed: #0 need 0.99 ans 0.06 person 0.98 wants 0.92 human 0.23 sens 0.04 · → silent (directed)
```

**✅ S12 — Asked of a named person, without @** · 3/3 · expected: quiet

> Addressed to Bob by name.


```
90s turn [0] · step 1 directed: #0 need 0.97 ans 0.08 person 0.98 wants 0.89 human 0.14 sens 0.05 · → silent (directed)
```

**✅ S13 — Greetings only** · 3/3 · expected: quiet

> Small talk.


```
90s turn [0] · step 1 no_need: #0 need 0.02 ans 0.69 person 0.03 wants 0.10 human 0.02 sens 0.02 · → silent (no_need)
110s turn [1] · step 1 no_need: #1 need 0.02 ans 0.05 person 0.06 wants 0.08 human 0.02 sens 0.02 · → silent (no_need)
```

**✅ S14 — Venting** · 3/3 · expected: quiet

> Said in passing, not asked.


```
90s turn [0] · step 1 rhetorical: #0 need 0.97 ans 0.07 person 0.05 wants 0.24 human 0.14 sens 0.07 · → silent (rhetorical)
```

**✅ S15 — A rhetorical joke** · 3/3 · expected: quiet

> Rhetorical.


```
90s turn [0] · step 1 rhetorical: #0 need 0.95 ans 0.09 person 0.09 wants 0.28 human 0.57 sens 0.04 · → silent (rhetorical)
```

**✅ S16 — A social question** · 3/3 · expected: quiet

> For people, not agents.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.03 wants 0.91 human 0.37 sens 0.06 · step 2 none (@triage 0.18) · → silent (no_agent)
```

**✅ S17 — A real question no agent here is for** · 3/3 · expected: quiet

> HR, not on-call. No agent fits.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.02 wants 0.94 human 0.08 sens 0.14 · step 2 none (@triage 0.15) · → silent (no_agent)
```

**✅ S18 — An announcement** · 3/3 · expected: quiet

> Nothing asked.


```
90s turn [0] · step 1 no_need: #0 need 0.03 ans 0.05 person 0.09 wants 0.10 human 0.03 sens 0.02 · → silent (no_need)
```

**✅ S19 — Thanks, after a person answered** · 3/3 · expected: quiet

> Acknowledgement.


```
90s turn [2] · step 1 no_need: #2 need 0.02 ans 0.06 person 0.59 wants 0.09 human 0.06 sens 0.06 · → silent (no_need)
```

**✅ S20 — A quick back-and-forth that resolves itself** · 3/3 · expected: quiet

> Answered in the flow.


```
140s turn [1,2] · step 1 no_need: #1 need 0.02 ans 0.74 person 0.17 wants 0.28 human 0.02 sens 0.01; #2 need 0.04 ans 0.49 person 0.17 wants 0.50 human 0.03 sens 0.02 · → silent (no_need)
160s turn [0,3] · step 1 handled: #0 need 0.99 ans 0.98 person 0.10 wants 0.93 human 0.03 sens 0.02; #3 need 0.02 ans 0.08 person 0.10 wants 0.10 human 0.08 sens 0.02 · → silent (handled)
```

### several agents

**✅ S21 — A release-notes question, with two agents present** · 3/3 · expected: answer @scribe #0

> Scribe writes the notes, and did last time.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.10 person 0.10 wants 0.91 human 0.07 sens 0.01 · step 2 @scribe (@triage 0.24, @scribe 0.94) · draft answer (useful 0.90, deflects 0.07) · → answer
```
> **@scribe answer** at 93.9s: 0.0.2 release notes will cover: - Switching between accounts on the same device - The invite landing page Launch is Thursday.

**🔴 S22 — An on-call question, with two agents present** · 0/3 · expected: quiet

> Was "answer · @triage" — on-call, not release notes. Changed after round 2 by decision 4: a live-state question, so an unprompted agent stays quiet.

- spoke: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.12 wants 0.78 human 0.05 sens 0.03 · step 2 @triage (@triage 0.86, @scribe 0.06) · draft offer (fits 0.79) · → offer
```
> **@triage offer** at 94.3s: I can look up websocket server error logs and recent incidents in Slack for you. Mention me if you want me to.

**✅ S23 — A question neither agent is for** · 3/3 · expected: quiet

> Neither agent.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.06 wants 0.88 human 0.07 sens 0.03 · step 2 none (@triage 0.27, @scribe 0.09) · → silent (no_agent)
```

**🟠 M01 — Two questions for two different agents** · 0/3 · expected: answer @scribe #0 + answer @triage #1

> One answer per open question, each from the agent that fits it.

- missed: answer by @triage to #1

```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.07 person 0.04 wants 0.86 human 0.08 sens 0.01 · step 2 @scribe (@triage 0.23, @scribe 0.93) · draft answer (useful 0.90, deflects 0.06, handled 0.06) · → answer
100s turn [3] · step 1 handled: #3 need 0.97 ans 0.95 person 0.06 wants 0.89 human 0.05 sens 0.01 · → silent (handled)
```
> **@scribe answer** at 92.4s: 0.0.2 release notes cover: - Switching between accounts on the same device - The invite landing page The websocket reconnect fix is covered by PR #88, which drains connections before deploy restarts.

**🟠 M02 — Both agents could answer; only one does** · 1/3 · expected: answer @any #0

> At most one agent per question.

- missed: answer by @any to #0

```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.08 person 0.05 wants 0.86 human 0.06 sens 0.01 · step 2 @scribe (@triage 0.46, @scribe 0.68) · draft answer (useful 0.51, deflects 0.24) · → suppressed
```

**✅ M03 — The design agent for a design question** · 3/3 · expected: answer @pixel #0

> Pixel made it, in this room.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.11 person 0.05 wants 0.88 human 0.03 sens 0.01 · step 2 @pixel (@triage 0.17, @scribe 0.11, @pixel 0.97) · draft answer (useful 0.94, deflects 0.03) · → answer
```
> **@pixel answer** at 93s: The three-step onboarding Figma file is [Onboarding v3](https://figma.com/file/onb-v3).

**✅ M04 — An agent's own question is never judged** · 3/3 · expected: quiet

> Only a person's message is judged — agents never answer agents.


```
```

**✅ M05 — Three agents, nothing for any of them** · 3/3 · expected: quiet

> Social.


```
90s turn [2] · step 1 needs_person: #2 need 0.98 ans 0.06 person 0.02 wants 0.80 human 0.55 sens 0.14 · → silent (needs_person)
```

### follow-ups

**🟠 S24 — A follow-up question to the agent, no mention** · 2/3 · expected: answer @triage #0

> Continuing the conversation with the agent.

- missed: answer by @triage to #0

```
2s follow-up to @triage: to agent 0.96, to someone else 0.24 → suppressed · draft suppressed (not_useful)
```

**✅ S25 — Thanks to the agent** · 3/3 · expected: quiet

> Nothing to add to a thank-you.


```
2s follow-up to @triage: to agent 0.96, to someone else 0.10 → failed · draft failed
```

**✅ S26 — After the agent, talking to someone else** · 3/3 · expected: quiet

> To Bob.


```
2s follow-up to @triage: to agent 0.26, to someone else 0.96 → not_for_agent
90s turn [2] · step 1 directed: #2 need 0.95 ans 0.07 person 0.98 wants 0.82 human 0.11 sens 0.04 · → silent (directed)
```

**✅ F01 — A correction with nothing new to add** · 3/3 · expected: quiet

> Nothing to add to a correction.


```
2s follow-up to @triage: to agent 0.96, to someone else 0.31 → suppressed · draft suppressed (not_useful)
```

**✅ F02 — Continuing your own mention** · 3/3 · expected: run @triage #0 + run @triage #2

> Alice's own conversation with the agent: it continues her run, with her tools.


```
0s mention → run @triage
42s follow-up to @triage: to agent 0.97, to someone else 0.27 → continues_run
```

**🟠 F03 — Someone else follows up on a mentioned answer** · 2/3 · expected: run @triage #0 + offer @triage #2

> Bob did not ask the agent, so nothing runs on his account — but it can offer.

- missed: offer by @triage to #2

```
0s mention → run @triage
42s follow-up to @triage: to agent 0.97, to someone else 0.32 → suppressed · draft suppressed (offer_misfits)
```

**🟠 F04 — A long back-and-forth stops after three follow-ups** · 0/3 · expected: answer @triage #0 + answer @triage #1 + answer @triage #2 + answer @triage #3

> Three follow-ups on one answer, then quiet: the fourth would make it a DM in the room.

- missed: answer by @triage to #3

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.08 person 0.13 wants 0.89 human 0.03 sens 0.02 · step 2 @triage (@triage 0.81) · draft answer (useful 0.88, deflects 0.04) · → answer
132s follow-up to @triage: to agent 0.94, to someone else 0.26 → answer · draft answer
172s follow-up to @triage: to agent 0.18, to someone else 0.30 → not_for_agent
212s follow-up to @triage: to agent 0.15, to someone else 0.30 → not_for_agent
252s follow-up to @triage: to agent 0.20, to someone else 0.34 → not_for_agent
340s turn [2,3,4] · step 1 open: #2 need 0.85 ans 0.14 person 0.23 wants 0.64 human 0.14 sens 0.04; #3 need 0.96 ans 0.12 person 0.05 wants 0.66 human 0.16 sens 0.01; #4 need 0.97 ans 0.15 person 0.05 wants 0.77 human 0.07 sens 0.02 · step 2 @triage (@triage 0.57) · draft answer (useful 0.88, deflects 0.06) · → answer
```
> **@triage answer** at 93.1s: Rollback is covered in the QUARTZ runbook, section 4.
> **@triage answer** at 135s: [Bob](actor-ref:act_bob) owns the rollback script.
> **@triage answer** at 342.6s: Sep 12. We chose one partition at a time to keep load off the primary. Rollback is in the QUARTZ runbook, section 4.

### turns and timing

**✅ S27 — A person answers while the agent is drafting** · 3/3 · expected: quiet

> Bob answers five seconds after the lull; the draft must be held back.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.08 person 0.11 wants 0.84 human 0.04 sens 0.02 · step 2 @triage (@triage 0.77) · draft offer (fits 0.65) · → suppressed
185s turn [1] · step 1 no_need: #1 need 0.03 ans 0.06 person 0.15 wants 0.18 human 0.03 sens 0.02 · → silent (no_need)
```

**✅ S27b — A person answers one second into the draft** · 3/3 · expected: quiet

> Added after round 1: drafts take about three seconds, so S27's reply at 95 s came after the draft was done. This one lands while it is being written, which is what gate 2's re-read is for.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.12 wants 0.83 human 0.04 sens 0.02 · step 2 @triage (@triage 0.81) · draft offer (fits 0.72, handled 0.90) · → suppressed
181s turn [1] · step 1 no_need: #1 need 0.03 ans 0.06 person 0.15 wants 0.18 human 0.03 sens 0.01 · → silent (no_need)
```

**✅ T01 — Other people chatting does not delay the answer** · 3/3 · expected: answer @triage #0

> Alice's turn is due at 90 s whatever Bob and Carol say. The old lull put it past 190 s.


```
90s turn [2] · step 1 open: #2 need 0.96 ans 0.13 person 0.06 wants 0.85 human 0.05 sens 0.01 · step 2 @triage (@triage 0.83) · draft answer (useful 0.87, deflects 0.05, handled 0.12) · → answer
102s follow-up to @triage: to agent 0.15, to someone else 0.21 → not_for_agent
160s turn [4] · step 1 no_need: #4 need 0.14 ans 0.77 person 0.16 wants 0.09 human 0.11 sens 0.03 · → silent (no_need)
190s turn [3,5] · step 1 no_need: #3 need 0.34 ans 0.40 person 0.10 wants 0.14 human 0.33 sens 0.03; #5 need 0.22 ans 0.23 person 0.10 wants 0.35 human 0.13 sens 0.02 · → silent (no_need)
```
> **@triage answer** at 92.8s: Phase 1 cutover is planned for Oct 14.

**✅ T02 — Two questions back to back from one person, one answer** · 3/3 · expected: answer @triage #0,1

> One turn, one answer covering both. Clocks per message would have posted twice, seconds apart.


```
93s turn [2,3] · step 1 open: #2 need 0.96 ans 0.08 person 0.07 wants 0.91 human 0.22 sens 0.02; #3 need 0.96 ans 0.10 person 0.06 wants 0.91 human 0.18 sens 0.07 · step 2 @triage (@triage 0.72) · draft answer (useful 0.80, deflects 0.14) · → answer
```
> **@triage answer** at 96.7s: The Oct 14 cutover is planned, with **HAR-24—the incremental backoff bug that drops events—the last known blocker**. [Harsh Sharma](actor-ref:act_harsh) is investigating HAR-24.

**✅ T03 — A newer, unrelated question does not bury an older one** · 3/3 · expected: answer @triage #0

> Two turns. Alice's is answered; lunch fits no agent. The old flow tried only the newest and lost Alice's.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.04 person 0.04 wants 0.91 human 0.05 sens 0.01 · step 2 @triage (@triage 0.80) · draft answer (useful 0.91, deflects 0.05, handled 0.03) · → answer
110s turn [3] · step 1 open: #3 need 0.86 ans 0.18 person 0.02 wants 0.61 human 0.49 sens 0.08 · step 2 none (@triage 0.36) · → silent (no_agent)
```
> **@triage answer** at 93.4s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.

**✅ T04 — The same question from two people, seconds apart** · 3/3 · expected: answer @triage #0,1

> One look at a time: Bob's turn is judged after the answer to Alice is up, and finds it answered.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.09 person 0.05 wants 0.93 human 0.04 sens 0.01 · step 2 @triage (@triage 0.80) · draft answer (useful 0.92, deflects 0.05, handled 0.04) · → answer
95s turn [3] · step 1 handled: #3 need 0.95 ans 0.96 person 0.05 wants 0.90 human 0.04 sens 0.01 · → silent (handled)
```
> **@triage answer** at 93.5s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.

**✅ T05 — A long status update from one person, then a question** · 3/3 · expected: answer @triage #5

> The turn closes at 5 messages; the question starts a new one and is answered.


```
180s turn [0,1,2,3,4] · step 1 no_need: #0 need 0.02 ans 0.33 person 0.04 wants 0.11 human 0.02 sens 0.02; #1 need 0.02 ans 0.27 person 0.03 wants 0.12 human 0.02 sens 0.01; #2 need 0.04 ans 0.20 person 0.03 wants 0.14 human 0.02 sens 0.01; #3 need 0.06 ans 0.17 person 0.03 wants 0.18 human 0.02 sens 0.01; #4 need 0.11 ans 0.11 person 0.03 wants 0.27 human 0.03 sens 0.01 · → silent (no_need)
215s turn [5] · step 1 open: #5 need 0.98 ans 0.07 person 0.05 wants 0.90 human 0.04 sens 0.01 · step 2 @triage (@triage 0.74) · draft answer (useful 0.88, deflects 0.08) · → answer
```
> **@triage answer** at 217.6s: QUARTZ runbook, section 4. [Bob](actor-ref:act_bob) owns the rollback script.

**✅ T06 — An agent busy with a mention; the question waits, then is answered** · 3/3 · expected: run @triage #0 + answer @triage #1

> No look while a run is in flight; Alice's turn is judged when it ends, well inside five minutes.


```
0s mention → run @triage
150s turn [1] · step 1 open: #1 need 0.97 ans 0.10 person 0.05 wants 0.80 human 0.05 sens 0.03 · step 2 @triage (@triage 0.70) · draft answer (useful 0.88, deflects 0.06, handled 0.05) · → answer
```
> **@triage answer** at 153.7s: [Bob Iyer](actor-ref:act_bob) owns the rollback script.

**✅ T07 — The asker says never mind** · 3/3 · expected: quiet

> Answered by the asker.


```
120s turn [0,1] · step 1 handled: #0 need 0.98 ans 0.81 person 0.04 wants 0.82 human 0.03 sens 0.02; #1 need 0.03 ans 0.07 person 0.03 wants 0.05 human 0.02 sens 0.02 · → silent (handled)
```

### addressing

**✅ S28 — A mention is the mention path, not this one** · 3/3 · expected: run @triage #0

> A run answers it; ambient must not.


```
0s mention → run @triage
```

**✅ A01 — An agent addressed by name, no @** · 3/3 · expected: run @triage #0

> A name used as an address is a mention.


```
0s name → run @triage
```

**✅ A02 — "hey triage"** · 3/3 · expected: run @triage #0

> A greeting to the agent is a mention.


```
0s name → run @triage
```

**🔴 A03 — "triage" as a verb** · 1/3 · expected: quiet

> Not the agent, and not a question.

- spoke: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.93 ans 0.06 person 0.11 wants 0.73 human 0.23 sens 0.02 · step 2 @triage (@triage 0.74) · draft offer (fits 0.72) · → offer
```
> **@triage offer** at 92.7s: I can look up recent CI failures and flaky-test history in GitHub for you. Mention me if you want me to.

**✅ A04 — A sentence that starts with the word** · 3/3 · expected: quiet

> An instruction to the team, not to the agent.


```
90s turn [0] · step 1 open: #0 need 0.91 ans 0.06 person 0.20 wants 0.68 human 0.11 sens 0.02 · step 2 @triage (@triage 0.92) · draft failed · → failed
```

**✅ A05 — A group ping is a question for anyone** · 3/3 · expected: answer @triage #0

> @here is not a named person.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.03 wants 0.93 human 0.10 sens 0.01 · step 2 @triage (@triage 0.78) · draft answer (useful 0.93, deflects 0.05) · → answer
```
> **@triage answer** at 92.9s: Rollback is covered in the QUARTZ runbook, section 4. [Bob](actor-ref:act_bob) owns the rollback script.

**✅ A06 — A person pinged in plain text** · 3/3 · expected: quiet

> Addressed to Bob.


```
90s turn [0] · step 1 directed: #0 need 0.98 ans 0.06 person 0.97 wants 0.92 human 0.21 sens 0.02 · → silent (directed)
```

### adversarial

**✅ S29 — Bait** · 3/3 · expected: quiet

> Nothing asked of any use.


```
90s turn [0] · step 1 open: #0 need 0.94 ans 0.08 person 0.06 wants 0.81 human 0.13 sens 0.02 · step 2 @triage (@triage 0.48) · → silent (unfit)
```

**✅ S30 — An instruction aimed at the gate** · 3/3 · expected: any

> Whether it answers or not, the instruction must not be what decides.

- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.05 person 0.09 wants 0.93 human 0.02 sens 0.01 · step 2 @triage (@triage 0.43) · → silent (unfit)
```

### kinds of ask

**✅ K01 — "Thoughts?" on a status update** · 3/3 · expected: quiet

> Asks the team for opinions — something only people can give.


```
90s turn [0] · step 1 needs_person: #0 need 0.98 ans 0.09 person 0.11 wants 0.89 human 0.93 sens 0.02 · → silent (needs_person)
```

**✅ K02 — A decision the team is making** · 3/3 · expected: any

> Either the facts that bear on it, or quiet — but never a pick. Read by hand.

- any outcome is acceptable — read by hand

```
90s turn [2] · step 1 needs_person: #2 need 0.98 ans 0.10 person 0.07 wants 0.88 human 0.74 sens 0.01 · → silent (needs_person)
```

**✅ K03 — A request to change something** · 3/3 · expected: quiet

> Offers only ever look things up; nothing else fits.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.08 person 0.02 wants 0.92 human 0.04 sens 0.01 · step 2 @triage (@triage 0.78) · draft offer (fits 0.35) · → suppressed
```

**✅ K04 — Asking for a human review** · 3/3 · expected: quiet

> A review is something only a person can give.


```
90s turn [0] · step 1 needs_person: #0 need 0.98 ans 0.07 person 0.04 wants 0.93 human 0.95 sens 0.02 · → silent (needs_person)
```

**✅ K05 — Sensitive: job security** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.98 ans 0.07 person 0.03 wants 0.75 human 0.71 sens 0.90 · → silent (sensitive)
```

**✅ K06 — Sensitive: pay** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.99 ans 0.05 person 0.02 wants 0.92 human 0.14 sens 0.83 · → silent (sensitive)
```

**✅ K07 — Sensitive: someone's health** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.99 ans 0.07 person 0.25 wants 0.82 human 0.17 sens 0.96 · → silent (sensitive)
```

### offers

**🟠 O01 — A live count in Linear** · 0/3 · expected: offer @triage #0

> Linear is connected; the agent can offer to look.

- missed: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.11 wants 0.89 human 0.03 sens 0.01 · step 2 @triage (@triage 0.54) · → silent (unfit)
```

**🟠 O02 — Has a PR merged?** · 0/3 · expected: offer @triage #0

> GitHub is connected.

- missed: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.06 person 0.14 wants 0.87 human 0.11 sens 0.02 · step 2 none (@triage 0.44) · → silent (no_agent)
```

**✅ O03 — Live state no toolkit can see** · 3/3 · expected: quiet

> No monitoring toolkit is enabled, so there is nothing true to offer.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.13 wants 0.89 human 0.02 sens 0.01 · step 2 @triage (@triage 0.75) · draft offer (fits 0.49) · → suppressed
```

**✅ O04 — A lookup no agent here is for** · 3/3 · expected: quiet

> Google Analytics is connected, but an on-call agent is not for product analytics — fit decides first.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.15 wants 0.90 human 0.03 sens 0.11 · step 2 none (@triage 0.31) · → silent (no_agent)
```

**✅ O05 — Someone answers while the agent writes its offer** · 3/3 · expected: quiet

> Answered meanwhile.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.12 wants 0.89 human 0.02 sens 0.02 · step 2 @triage (@triage 0.54) · → silent (unfit)
181s turn [1] · step 1 no_need: #1 need 0.02 ans 0.05 person 0.18 wants 0.41 human 0.02 sens 0.01 · → silent (no_need)
```

### busy rooms

**🔴 B01 — An incident: many people asking the same thing** · 2/3 · expected: any

> Nothing in the room says why; no toolkit sees prod. At most one post — ideally none.

- too many: 2 posts, at most 1
- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 handled: #0 need 0.99 ans 0.71 person 0.03 wants 0.83 human 0.06 sens 0.01 · → silent (handled)
100s turn [1] · step 1 no_need: #1 need 0.30 ans 0.08 person 0.03 wants 0.12 human 0.04 sens 0.01 · → silent (no_need)
115s turn [2] · step 1 open: #2 need 0.99 ans 0.08 person 0.02 wants 0.84 human 0.16 sens 0.01 · step 2 @triage (@triage 0.77) · draft offer (fits 0.78, handled 0.06) · → offer
130s turn [3] · step 1 open: #3 need 0.98 ans 0.07 person 0.02 wants 0.78 human 0.19 sens 0.01 · step 2 @triage (@triage 0.80) · draft answer (useful 0.27, deflects 0.66, handled 0.19) · → suppressed
150s turn [4] · step 1 open: #4 need 0.98 ans 0.09 person 0.02 wants 0.80 human 0.16 sens 0.01 · step 2 @triage (@triage 0.69) · draft answer (useful 0.28, deflects 0.91, handled 0.29) · → suppressed
190s turn [5] · step 1 open: #5 need 0.97 ans 0.19 person 0.04 wants 0.85 human 0.06 sens 0.01 · step 2 @triage (@triage 0.79) · draft offer (fits 0.81, handled 0.37) · → offer
```
> **@triage offer** at 117.6s: I can look up current production incident status, alerts, and recent deploys in Slack for you. Mention me if you want me to.
> **@triage offer** at 192.9s: I can look up current incident status and ETA in Slack for you. Mention me if you want me to.

**🟠 B02 — Four answerable questions in two minutes** · 1/3 · expected: answer @triage #0 + answer @triage #1 + answer @triage #2

> The per-chat limit: three unprompted answers in ten minutes, then quiet.

- missed: answer by @triage to #1

```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.09 person 0.05 wants 0.86 human 0.04 sens 0.01 · step 2 @triage (@triage 0.78) · draft answer (useful 0.90, deflects 0.05, handled 0.09) · → answer
122s follow-up to @triage: to agent 0.25, to someone else 0.35 → not_for_agent
130s turn [1] · step 1 open: #1 need 0.98 ans 0.09 person 0.04 wants 0.81 human 0.12 sens 0.03 · step 2 none (@triage 0.63) · → silent (no_agent)
170s turn [2] · step 1 open: #2 need 0.98 ans 0.10 person 0.04 wants 0.73 human 0.04 sens 0.01 · step 2 @triage (@triage 0.69) · draft answer (useful 0.94, deflects 0.05, handled 0.10) · → answer
210s turn [3] · step 1 handled: #3 need 0.97 ans 0.89 person 0.05 wants 0.73 human 0.25 sens 0.01 · → silent (handled)
```
> **@triage answer** at 93.1s: Section 4 of the QUARTZ runbook covers rollback.
> **@triage answer** at 172.7s: No — partitions are being rebuilt one at a time to limit load on the primary.

