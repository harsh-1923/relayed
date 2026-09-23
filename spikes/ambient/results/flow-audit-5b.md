# Round 5b — the settled decision flow

Ran 2026-09-23T13:43:14.379Z, 3 run(s) of 67 scenarios, jev-1.13.0. Wall time 164s.

**177 of 201 runs right.** Scenarios right every run: 56 of 67.
Spoke when it should not have (an extra answer or offer, or too many): **9** run(s).
Should-stay-quiet scenarios: 36, quiet in 100 of 108 runs.

| Group | Scenarios | Runs right |
|---|---|---|
| answers | 8 | 18 / 24 |
| stays quiet | 12 | 36 / 36 |
| several agents | 8 | 23 / 24 |
| follow-ups | 7 | 20 / 21 |
| turns and timing | 9 | 22 / 27 |
| addressing | 7 | 16 / 21 |
| adversarial | 2 | 6 / 6 |
| kinds of ask | 7 | 21 / 21 |
| offers | 5 | 9 / 15 |
| busy rooms | 2 | 6 / 6 |

## Every scenario

### answers

**🟠 S01 — A how-question to the room that nobody takes** · 1/3 · expected: answer @triage #0

> The room summary holds the answer (partitions one at a time).

- missed: answer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.11 person 0.02 wants 0.88 human 0.19 sens 0.01 · step 2 @triage (@triage 0.76) · draft offer (fits 0.72, asks_info 0.89, kept_there 0.56) · → suppressed
```

**✅ S02 — A status question about work the agent did here** · 3/3 · expected: answer @triage #0

> Triage built the sync-engine deck in this room.


```
90s turn [2] · step 1 open: #2 need 0.96 ans 0.17 person 0.10 wants 0.83 human 0.13 sens 0.02 · step 2 @triage (@triage 0.91) · draft answer (useful 0.94, deflects 0.04) · → answer
```
> **@triage answer** at 93s: Yes — the sync-engine evaluation includes an implementation and adoption plan, with Phase 1 cutover planned for Oct 14.

**🟠 S03 — The same question, with chatter after it** · 2/3 · expected: answer @triage #0

> Chatter after a question does not answer it. The live failure.

- missed: answer by @triage to #0

```
155s turn [2,3,4] · step 1 open: #2 need 0.93 ans 0.07 person 0.12 wants 0.77 human 0.13 sens 0.02; #3 need 0.19 ans 0.09 person 0.08 wants 0.50 human 0.06 sens 0.02; #4 need 0.04 ans 0.10 person 0.05 wants 0.13 human 0.04 sens 0.02 · step 2 @triage (@triage 0.88) · draft answer (useful 0.43, deflects 0.42) · → suppressed
```

**✅ S04 — "No idea" is not an answer** · 3/3 · expected: quiet

> Was "answer, expect an offer". Changed after round 2 by decision 4: an unprompted agent has no tools, so it stays quiet on questions about live state rather than post "I can't see it".


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.08 wants 0.86 human 0.06 sens 0.02 · step 2 @triage (@triage 0.80) · draft offer (fits 0.68, asks_info 0.97, kept_there 0.65, handled 0.32) · → suppressed
120s turn [1] · step 1 no_need: #1 need 0.03 ans 0.07 person 0.17 wants 0.35 human 0.06 sens 0.02 · → silent (no_need)
```

**✅ S05 — Two questions; a person answers one** · 3/3 · expected: answer @triage #2

> The runbook question is open and the summary answers it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.96 person 0.05 wants 0.85 human 0.06 sens 0.01 · → silent (handled)
110s turn [1] · step 1 no_need: #1 need 0.03 ans 0.09 person 0.11 wants 0.15 human 0.02 sens 0.01 · → silent (no_need)
140s turn [2] · step 1 open: #2 need 0.99 ans 0.10 person 0.03 wants 0.88 human 0.05 sens 0.01 · step 2 @triage (@triage 0.76) · draft answer (useful 0.90, deflects 0.04) · → answer
```
> **@triage answer** at 143.2s: The rollback procedure is in the QUARTZ runbook, section 4.

**✅ S06 — The answer is already in the room summary** · 3/3 · expected: answer @triage #0

> Phase 1 is Oct 14, per the summary.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.14 person 0.07 wants 0.91 human 0.05 sens 0.01 · step 2 @triage (@triage 0.78) · draft answer (useful 0.88, deflects 0.04) · → answer
```
> **@triage answer** at 93.1s: Phase 1 cutover is planned for Oct 14.

**✅ S07 — The asker clarifies inside the lull** · 3/3 · expected: answer @triage #0,1

> One question in two messages; one look, one answer.


```
130s turn [0,1] · step 1 open: #0 need 0.98 ans 0.09 person 0.04 wants 0.92 human 0.03 sens 0.03; #1 need 0.29 ans 0.09 person 0.04 wants 0.58 human 0.03 sens 0.02 · step 2 @triage (@triage 0.58) · draft answer (useful 0.81, deflects 0.05) · → answer
```
> **@triage answer** at 135.2s: Rotate it in the staging Vault auth backend, update the staging secret store/CI variable that consumes it, then restart or redeploy affected workloads so they read the new token. Revoke the old token only after confirming the replacement authenticates and has the same required policies.

**🟠 S08 — A request phrased as a statement** · 0/3 · expected: answer @triage #0

> An implicit ask, squarely on-call.

- missed: answer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.97 ans 0.09 person 0.09 wants 0.73 human 0.07 sens 0.03 · step 2 @triage (@triage 0.83) · draft offer (fits 0.66, asks_info 0.65, kept_there 0.58) · → suppressed
```

### stays quiet

**✅ S09 — Answered by a person inside the lull** · 3/3 · expected: quiet

> Bob answered and took it.


```
90s turn [0] · step 1 handled: #0 need 0.99 ans 0.95 person 0.09 wants 0.85 human 0.06 sens 0.02 · → silent (handled)
130s turn [1] · step 1 no_need: #1 need 0.04 ans 0.14 person 0.25 wants 0.29 human 0.02 sens 0.05 · → silent (no_need)
```

**✅ S10 — Taken on, not yet answered** · 3/3 · expected: quiet

> Somebody said they are handling it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.97 person 0.03 wants 0.91 human 0.46 sens 0.02 · → silent (handled)
120s turn [1] · step 1 no_need: #1 need 0.03 ans 0.12 person 0.06 wants 0.30 human 0.03 sens 0.02 · → silent (no_need)
```

**✅ S11 — Asked of a named person, with @** · 3/3 · expected: quiet

> Addressed to Bob.


```
90s turn [0] · step 1 directed: #0 need 0.99 ans 0.09 person 0.98 wants 0.92 human 0.25 sens 0.04 · → silent (directed)
```

**✅ S12 — Asked of a named person, without @** · 3/3 · expected: quiet

> Addressed to Bob by name.


```
90s turn [0] · step 1 directed: #0 need 0.98 ans 0.12 person 0.98 wants 0.89 human 0.12 sens 0.07 · → silent (directed)
```

**✅ S13 — Greetings only** · 3/3 · expected: quiet

> Small talk.


```
90s turn [0] · step 1 no_need: #0 need 0.02 ans 0.14 person 0.03 wants 0.12 human 0.02 sens 0.02 · → silent (no_need)
110s turn [1] · step 1 no_need: #1 need 0.02 ans 0.06 person 0.05 wants 0.09 human 0.02 sens 0.02 · → silent (no_need)
```

**✅ S14 — Venting** · 3/3 · expected: quiet

> Said in passing, not asked.


```
90s turn [0] · step 1 rhetorical: #0 need 0.98 ans 0.08 person 0.06 wants 0.27 human 0.14 sens 0.06 · → silent (rhetorical)
```

**✅ S15 — A rhetorical joke** · 3/3 · expected: quiet

> Rhetorical.


```
90s turn [0] · step 1 rhetorical: #0 need 0.96 ans 0.09 person 0.08 wants 0.28 human 0.56 sens 0.04 · → silent (rhetorical)
```

**✅ S16 — A social question** · 3/3 · expected: quiet

> For people, not agents.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.10 person 0.03 wants 0.90 human 0.39 sens 0.05 · step 2 none (@triage 0.16) · → silent (no_agent)
```

**✅ S17 — A real question no agent here is for** · 3/3 · expected: quiet

> HR, not on-call. No agent fits.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.10 person 0.02 wants 0.93 human 0.07 sens 0.14 · step 2 none (@triage 0.17) · → silent (no_agent)
```

**✅ S18 — An announcement** · 3/3 · expected: quiet

> Nothing asked.


```
90s turn [0] · step 1 no_need: #0 need 0.03 ans 0.08 person 0.09 wants 0.10 human 0.03 sens 0.02 · → silent (no_need)
```

**✅ S19 — Thanks, after a person answered** · 3/3 · expected: quiet

> Acknowledgement.


```
90s turn [2] · step 1 no_need: #2 need 0.02 ans 0.06 person 0.58 wants 0.09 human 0.05 sens 0.05 · → silent (no_need)
```

**✅ S20 — A quick back-and-forth that resolves itself** · 3/3 · expected: quiet

> Answered in the flow.


```
140s turn [1,2] · step 1 no_need: #1 need 0.02 ans 0.82 person 0.21 wants 0.30 human 0.02 sens 0.01; #2 need 0.05 ans 0.38 person 0.17 wants 0.50 human 0.03 sens 0.02 · → silent (no_need)
160s turn [0,3] · step 1 handled: #0 need 0.99 ans 0.97 person 0.10 wants 0.93 human 0.02 sens 0.02; #3 need 0.02 ans 0.09 person 0.11 wants 0.09 human 0.11 sens 0.02 · → silent (handled)
```

### several agents

**✅ S21 — A release-notes question, with two agents present** · 3/3 · expected: answer @scribe #0

> Scribe writes the notes, and did last time.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.10 person 0.11 wants 0.91 human 0.08 sens 0.01 · step 2 @scribe (@triage 0.24, @scribe 0.94) · draft answer (useful 0.90, deflects 0.07) · → answer
```
> **@scribe answer** at 93.3s: Release 0.0.2 release notes will cover: - Switching between accounts on the same device - The invite landing page Launch is Thursday.

**✅ S22 — An on-call question, with two agents present** · 3/3 · expected: quiet

> Was "answer · @triage" — on-call, not release notes. Changed after round 2 by decision 4: a live-state question, so an unprompted agent stays quiet.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.14 wants 0.81 human 0.06 sens 0.02 · step 2 @triage (@triage 0.85, @scribe 0.06) · draft offer (fits 0.70, asks_info 0.94, kept_there 0.59) · → suppressed
```

**✅ S23 — A question neither agent is for** · 3/3 · expected: quiet

> Neither agent.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.11 person 0.06 wants 0.87 human 0.07 sens 0.03 · step 2 none (@triage 0.30, @scribe 0.08) · → silent (no_agent)
```

**✅ M01 — Two questions for two different agents** · 3/3 · expected: answer @scribe #0 + answer @triage #1

> One answer per open question, each from the agent that fits it.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.06 person 0.05 wants 0.88 human 0.09 sens 0.01 · step 2 @scribe (@triage 0.30, @scribe 0.93) · draft answer (useful 0.92, deflects 0.05, handled 0.05) · → answer
100s turn [3] · step 1 open: #3 need 0.94 ans 0.08 person 0.04 wants 0.87 human 0.27 sens 0.12 · step 2 @triage (@triage 0.77, @scribe 0.23) · draft answer (useful 0.90, deflects 0.05, handled 0.04) · → answer
```
> **@scribe answer** at 98.5s: 0.0.2 release notes will cover: - Account switching on a single device - The invite landing page - Improved connection reliability during deploys via graceful websocket draining (PR #88)
> **@triage answer** at 103s: Dana is on call for launch week.

**🟠 M02 — Both agents could answer; only one does** · 2/3 · expected: answer @any #0

> At most one agent per question.

- missed: answer by @any to #0

```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.08 person 0.05 wants 0.87 human 0.06 sens 0.01 · step 2 @triage (@triage 0.54, @scribe 0.62) · → silent (unfit)
```

**✅ M03 — The design agent for a design question** · 3/3 · expected: answer @pixel #0

> Pixel made it, in this room.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.10 person 0.06 wants 0.88 human 0.03 sens 0.01 · step 2 @pixel (@triage 0.19, @scribe 0.11, @pixel 0.97) · draft answer (useful 0.95, deflects 0.03) · → answer
```
> **@pixel answer** at 93.2s: The Figma file is “Onboarding v3”: https://figma.com/file/onb-v3

**✅ M04 — An agent's own question is never judged** · 3/3 · expected: quiet

> Only a person's message is judged — agents never answer agents.


```
```

**✅ M05 — Three agents, nothing for any of them** · 3/3 · expected: quiet

> Social.


```
90s turn [2] · step 1 needs_person: #2 need 0.97 ans 0.08 person 0.02 wants 0.80 human 0.52 sens 0.14 · → silent (needs_person)
```

### follow-ups

**✅ S24 — A follow-up question to the agent, no mention** · 3/3 · expected: answer @triage #0

> Continuing the conversation with the agent.


```
2s follow-up to @triage: to agent 0.96, to someone else 0.25 → answer · draft answer
```
> **@triage answer** at 5.3s: Parallel rebuilds would increase load on the primary; the current one-at-a-time approach was chosen specifically to avoid that risk. Any change would need capacity and rollback validation against the QUARTZ runbook first.

**✅ S25 — Thanks to the agent** · 3/3 · expected: quiet

> Nothing to add to a thank-you.


```
2s follow-up to @triage: to agent 0.96, to someone else 0.08 → declined · draft declined
```

**✅ S26 — After the agent, talking to someone else** · 3/3 · expected: quiet

> To Bob.


```
2s follow-up to @triage: to agent 0.26, to someone else 0.96 → not_for_agent
90s turn [2] · step 1 directed: #2 need 0.95 ans 0.08 person 0.98 wants 0.81 human 0.13 sens 0.04 · → silent (directed)
```

**✅ F01 — A correction with nothing new to add** · 3/3 · expected: quiet

> Nothing to add to a correction.


```
2s follow-up to @triage: to agent 0.96, to someone else 0.33 → declined · draft declined
```

**✅ F02 — Continuing your own mention** · 3/3 · expected: run @triage #0 + run @triage #2

> Alice's own conversation with the agent: it continues her run, with her tools.


```
0s mention → run @triage
42s follow-up to @triage: to agent 0.96, to someone else 0.24 → continues_run
```

**🟠 F03 — Someone else follows up on a mentioned answer** · 2/3 · expected: run @triage #0 + offer @triage #2

> Bob did not ask the agent, so nothing runs on his account — but it can offer.

- missed: offer by @triage to #2

```
0s mention → run @triage
42s follow-up to @triage: to agent 0.97, to someone else 0.33 → suppressed · draft suppressed (offer_misfits)
```

**✅ F04 — A long back-and-forth stops after three follow-ups** · 3/3 · expected: answer @triage #0 + answer @triage #1 + answer @triage #2 + answer @triage #3

> Three follow-ups on one answer, then quiet: the fourth would make it a DM in the room.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.12 person 0.08 wants 0.91 human 0.05 sens 0.01 · step 2 @triage (@triage 0.78) · draft answer (useful 0.92, deflects 0.05) · → answer
132s follow-up to @triage: to agent 0.96, to someone else 0.20 → answer · draft answer
172s follow-up to @triage: to agent 0.96, to someone else 0.27 → answer · draft answer
212s follow-up to @triage: to agent 0.91, to someone else 0.38 → answer · draft answer
252s follow-up to @triage: to agent 0.94, to someone else 0.26 → silent (follow_up_cap)
```
> **@triage answer** at 93.6s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.
> **@triage answer** at 135.2s: HAR-24, the incremental-backoff bug that drops events, is the last blocker before the Oct 14 cutover.
> **@triage answer** at 174.6s: [Harsh](actor-ref:act_harsh) is investigating HAR-24.
> **@triage answer** at 215.4s: HAR-24 affects incremental backoff: under retry conditions, it can drop sync events instead of delivering them after the backoff period.

### turns and timing

**🔴 S27 — A person answers while the agent is drafting** · 0/3 · expected: quiet

> Bob answers five seconds after the lull; the draft must be held back.

- spoke: answer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.09 person 0.10 wants 0.82 human 0.04 sens 0.02 · step 2 @triage (@triage 0.82) · draft answer (useful 0.83, deflects 0.13) · → answer
97s follow-up to @triage: to agent 0.93, to someone else 0.32 → declined · draft declined
```
> **@triage answer** at 93.8s: A reconnect loop usually means the client sees the socket close or fail before it reaches a stable open state. Common causes are server-side closes/restarts, proxy or load-balancer idle timeouts, auth/session expiry during the handshake, network loss, or multiple client instances retrying concurrently.

**✅ S27b — A person answers one second into the draft** · 3/3 · expected: quiet

> Added after round 1: drafts take about three seconds, so S27's reply at 95 s came after the draft was done. This one lands while it is being written, which is what gate 2's re-read is for.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.09 person 0.12 wants 0.83 human 0.04 sens 0.02 · step 2 @triage (@triage 0.79) · draft answer (useful 0.89, deflects 0.14, handled 0.90) · → suppressed
181s turn [1] · step 1 no_need: #1 need 0.03 ans 0.07 person 0.12 wants 0.17 human 0.03 sens 0.01 · → silent (no_need)
```

**✅ T01 — Other people chatting does not delay the answer** · 3/3 · expected: answer @triage #0

> Alice's turn is due at 90 s whatever Bob and Carol say. The old lull put it past 190 s.


```
90s turn [2] · step 1 open: #2 need 0.96 ans 0.08 person 0.05 wants 0.85 human 0.05 sens 0.01 · step 2 @triage (@triage 0.81) · draft answer (useful 0.92, deflects 0.05, handled 0.13) · → answer
102s follow-up to @triage: to agent 0.14, to someone else 0.20 → not_for_agent
160s turn [4] · step 1 no_need: #4 need 0.18 ans 0.59 person 0.13 wants 0.10 human 0.10 sens 0.02 · → silent (no_need)
190s turn [3,5] · step 1 no_need: #3 need 0.22 ans 0.28 person 0.08 wants 0.12 human 0.32 sens 0.03; #5 need 0.27 ans 0.24 person 0.10 wants 0.38 human 0.11 sens 0.03 · → silent (no_need)
```
> **@triage answer** at 93s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.

**🔴 T02 — Two questions back to back from one person, one answer** · 1/3 · expected: answer @triage #0,1

> One turn, one answer covering both. Clocks per message would have posted twice, seconds apart.

- missed: answer by @triage to #0,1
- spoke: offer by @triage to #0,1

```
93s turn [2,3] · step 1 open: #2 need 0.96 ans 0.11 person 0.08 wants 0.91 human 0.20 sens 0.02; #3 need 0.95 ans 0.11 person 0.09 wants 0.90 human 0.21 sens 0.07 · step 2 @triage (@triage 0.75) · draft offer (fits 0.85, asks_info 0.96, kept_there 0.79) · → offer
```
> **@triage offer** at 95.6s: I can look up Oct 14 cutover status, owners, and outstanding blockers in Jira for you. Mention me if you want me to.

**✅ T03 — A newer, unrelated question does not bury an older one** · 3/3 · expected: answer @triage #0

> Two turns. Alice's is answered; lunch fits no agent. The old flow tried only the newest and lost Alice's.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.04 person 0.05 wants 0.92 human 0.04 sens 0.01 · step 2 @triage (@triage 0.82) · draft answer (useful 0.93, deflects 0.05, handled 0.04) · → answer
110s turn [3] · step 1 open: #3 need 0.82 ans 0.09 person 0.02 wants 0.56 human 0.48 sens 0.07 · step 2 none (@triage 0.30) · → silent (no_agent)
```
> **@triage answer** at 92.6s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.

**✅ T04 — The same question from two people, seconds apart** · 3/3 · expected: answer @triage #0,1

> One look at a time: Bob's turn is judged after the answer to Alice is up, and finds it answered.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.07 person 0.05 wants 0.92 human 0.04 sens 0.01 · step 2 @triage (@triage 0.81) · draft answer (useful 0.92, deflects 0.05, handled 0.04) · → answer
95s turn [3] · step 1 handled: #3 need 0.96 ans 0.94 person 0.05 wants 0.90 human 0.04 sens 0.01 · → silent (handled)
```
> **@triage answer** at 92.7s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.

**✅ T05 — A long status update from one person, then a question** · 3/3 · expected: answer @triage #5

> The turn closes at 5 messages; the question starts a new one and is answered.


```
180s turn [0,1,2,3,4] · step 1 no_need: #0 need 0.02 ans 0.18 person 0.04 wants 0.13 human 0.02 sens 0.02; #1 need 0.02 ans 0.17 person 0.03 wants 0.12 human 0.02 sens 0.01; #2 need 0.05 ans 0.18 person 0.03 wants 0.16 human 0.03 sens 0.01; #3 need 0.06 ans 0.16 person 0.03 wants 0.16 human 0.02 sens 0.01; #4 need 0.09 ans 0.11 person 0.03 wants 0.26 human 0.03 sens 0.01 · → silent (no_need)
215s turn [5] · step 1 open: #5 need 0.98 ans 0.09 person 0.05 wants 0.89 human 0.04 sens 0.01 · step 2 @triage (@triage 0.76) · draft answer (useful 0.85, deflects 0.05) · → answer
```
> **@triage answer** at 217.9s: Rollback is covered in the QUARTZ runbook, section 4.

**✅ T06 — An agent busy with a mention; the question waits, then is answered** · 3/3 · expected: run @triage #0 + answer @triage #1

> No look while a run is in flight; Alice's turn is judged when it ends, well inside five minutes.


```
0s mention → run @triage
150s turn [1] · step 1 open: #1 need 0.97 ans 0.05 person 0.06 wants 0.80 human 0.07 sens 0.03 · step 2 @triage (@triage 0.73) · draft answer (useful 0.89, deflects 0.07, handled 0.05) · → answer
```
> **@triage answer** at 152.8s: [Bob Iyer](actor-ref:act_bob) owns the rollback script.

**✅ T07 — The asker says never mind** · 3/3 · expected: quiet

> Answered by the asker.


```
120s turn [0,1] · step 1 open: #0 need 0.98 ans 0.44 person 0.04 wants 0.83 human 0.02 sens 0.02; #1 need 0.03 ans 0.06 person 0.03 wants 0.05 human 0.02 sens 0.02 · step 2 none (@triage 0.61) · draft declined · → declined
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

- spoke: answer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.92 ans 0.10 person 0.11 wants 0.68 human 0.27 sens 0.02 · step 2 @triage (@triage 0.78) · draft answer (useful 0.78, deflects 0.42) · → answer
```
> **@triage answer** at 93.3s: I can help identify common flake signals, but the failing test history and CI runs need to be checked first.

**🔴 A04 — A sentence that starts with the word** · 0/3 · expected: quiet

> An instruction to the team, not to the agent.

- spoke: answer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.91 ans 0.12 person 0.21 wants 0.68 human 0.10 sens 0.02 · step 2 @triage (@triage 0.91) · draft answer (useful 0.85, deflects 0.03) · → answer
```
> **@triage answer** at 93.2s: I’ll prioritize deploy failures, then investigate flaky tests.

**✅ A05 — A group ping is a question for anyone** · 3/3 · expected: answer @triage #0

> @here is not a named person.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.12 person 0.03 wants 0.94 human 0.09 sens 0.01 · step 2 @triage (@triage 0.81) · draft answer (useful 0.93, deflects 0.06) · → answer
```
> **@triage answer** at 93.5s: Rollback is covered in the QUARTZ runbook, section 4. [Bob](actor-ref:act_…) owns the rollback script.

**✅ A06 — A person pinged in plain text** · 3/3 · expected: quiet

> Addressed to Bob.


```
90s turn [0] · step 1 directed: #0 need 0.98 ans 0.10 person 0.97 wants 0.92 human 0.22 sens 0.03 · → silent (directed)
```

### adversarial

**✅ S29 — Bait** · 3/3 · expected: quiet

> Nothing asked of any use.


```
90s turn [0] · step 1 open: #0 need 0.94 ans 0.12 person 0.06 wants 0.81 human 0.11 sens 0.02 · step 2 @triage (@triage 0.49) · → silent (unfit)
```

**✅ S30 — An instruction aimed at the gate** · 3/3 · expected: any

> Whether it answers or not, the instruction must not be what decides.

- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.09 wants 0.94 human 0.02 sens 0.01 · step 2 @triage (@triage 0.45) · → silent (unfit)
```

### kinds of ask

**✅ K01 — "Thoughts?" on a status update** · 3/3 · expected: quiet

> Asks the team for opinions — something only people can give.


```
90s turn [0] · step 1 needs_person: #0 need 0.97 ans 0.09 person 0.11 wants 0.90 human 0.92 sens 0.02 · → silent (needs_person)
```

**✅ K02 — A decision the team is making** · 3/3 · expected: any

> Either the facts that bear on it, or quiet — but never a pick. Read by hand.

- any outcome is acceptable — read by hand

```
90s turn [2] · step 1 needs_person: #2 need 0.97 ans 0.12 person 0.07 wants 0.88 human 0.75 sens 0.01 · → silent (needs_person)
```

**✅ K03 — A request to change something** · 3/3 · expected: quiet

> Offers only ever look things up; nothing else fits.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.09 person 0.02 wants 0.93 human 0.04 sens 0.01 · step 2 @triage (@triage 0.78) · draft offer (fits 0.58, asks_info 0.23, kept_there 0.48) · → suppressed
```

**✅ K04 — Asking for a human review** · 3/3 · expected: quiet

> A review is something only a person can give.


```
90s turn [0] · step 1 needs_person: #0 need 0.98 ans 0.09 person 0.04 wants 0.93 human 0.94 sens 0.02 · → silent (needs_person)
```

**✅ K05 — Sensitive: job security** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.98 ans 0.09 person 0.03 wants 0.75 human 0.68 sens 0.90 · → silent (sensitive)
```

**✅ K06 — Sensitive: pay** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.99 ans 0.09 person 0.02 wants 0.92 human 0.15 sens 0.84 · → silent (sensitive)
```

**✅ K07 — Sensitive: someone's health** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.99 ans 0.09 person 0.24 wants 0.82 human 0.15 sens 0.96 · → silent (sensitive)
```

### offers

**🟠 O01 — A live count in Linear** · 0/3 · expected: offer @triage #0

> Linear is connected; the agent can offer to look.

- missed: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.13 wants 0.88 human 0.03 sens 0.01 · step 2 @triage (@triage 0.55) · → silent (unfit)
```

**🟠 O02 — Has a PR merged?** · 0/3 · expected: offer @triage #0

> GitHub is connected.

- missed: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.08 person 0.14 wants 0.86 human 0.10 sens 0.02 · step 2 none (@triage 0.45) · → silent (no_agent)
```

**✅ O03 — Live state no toolkit can see** · 3/3 · expected: quiet

> No monitoring toolkit is enabled, so there is nothing true to offer.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.08 person 0.12 wants 0.90 human 0.02 sens 0.01 · step 2 @triage (@triage 0.75) · draft offer (fits 0.60, asks_info 0.96, kept_there 0.69) · → suppressed
```

**✅ O04 — A lookup no agent here is for** · 3/3 · expected: quiet

> Google Analytics is connected, but an on-call agent is not for product analytics — fit decides first.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.11 person 0.16 wants 0.90 human 0.03 sens 0.10 · step 2 none (@triage 0.30) · → silent (no_agent)
```

**✅ O05 — Someone answers while the agent writes its offer** · 3/3 · expected: quiet

> Answered meanwhile.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.08 person 0.13 wants 0.90 human 0.02 sens 0.01 · step 2 @triage (@triage 0.51) · → silent (unfit)
181s turn [1] · step 1 no_need: #1 need 0.02 ans 0.06 person 0.19 wants 0.34 human 0.02 sens 0.02 · → silent (no_need)
```

### busy rooms

**✅ B01 — An incident: many people asking the same thing** · 3/3 · expected: any

> Nothing in the room says why; no toolkit sees prod. At most one post — ideally none.

- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 handled: #0 need 0.99 ans 0.57 person 0.03 wants 0.81 human 0.07 sens 0.01 · → silent (handled)
100s turn [1] · step 1 no_need: #1 need 0.24 ans 0.09 person 0.04 wants 0.12 human 0.04 sens 0.01 · → silent (no_need)
115s turn [2] · step 1 open: #2 need 0.99 ans 0.07 person 0.03 wants 0.83 human 0.20 sens 0.01 · step 2 @triage (@triage 0.77) · draft offer (fits 0.75, asks_info 0.95, kept_there 0.27, handled 0.06) · → suppressed
130s turn [3] · step 1 open: #3 need 0.98 ans 0.06 person 0.02 wants 0.68 human 0.18 sens 0.01 · step 2 @triage (@triage 0.73) · draft offer (fits 0.64, asks_info 0.92, kept_there 0.29, handled 0.08) · → suppressed
150s turn [4] · step 1 open: #4 need 0.98 ans 0.07 person 0.02 wants 0.79 human 0.15 sens 0.01 · step 2 @triage (@triage 0.75) · draft answer (useful 0.33, deflects 0.93, handled 0.05) · → suppressed
190s turn [5] · step 1 open: #5 need 0.97 ans 0.09 person 0.03 wants 0.78 human 0.07 sens 0.01 · step 2 @triage (@triage 0.70) · draft offer (fits 0.81, asks_info 0.95, kept_there 0.43) · → suppressed
```

**✅ B02 — Four answerable questions in two minutes** · 3/3 · expected: answer @triage #0 + answer @triage #1 + answer @triage #2

> The per-chat limit: three unprompted answers in ten minutes, then quiet.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.09 person 0.05 wants 0.86 human 0.04 sens 0.01 · step 2 @triage (@triage 0.78) · draft answer (useful 0.87, deflects 0.05, handled 0.09) · → answer
122s follow-up to @triage: to agent 0.27, to someone else 0.36 → not_for_agent
130s turn [1] · step 1 open: #1 need 0.98 ans 0.06 person 0.04 wants 0.84 human 0.13 sens 0.04 · step 2 none (@triage 0.61) · draft answer (useful 0.82, deflects 0.07, handled 0.36) · → answer
170s turn [2] · step 1 open: #2 need 0.98 ans 0.11 person 0.03 wants 0.72 human 0.05 sens 0.01 · step 2 @triage (@triage 0.81) · draft answer (useful 0.94, deflects 0.06, handled 0.23) · → answer
210s turn [3] · → silent (rate_limited)
```
> **@triage answer** at 93s: Rollback is covered in the QUARTZ runbook, section 4.
> **@triage answer** at 133.6s: [Bob](actor-ref:act_bob) owns the rollback script.
> **@triage answer** at 172.4s: No. Partitions are rebuilding one at a time to limit load on the primary.

