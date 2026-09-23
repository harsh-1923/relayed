# Round gate — the settled decision flow

Ran 2026-09-23T14:56:56.578Z, 3 run(s) of 76 scenarios, jev-1.13.0. Wall time 222s.

**219 of 228 runs right.** Scenarios right every run: 70 of 76.
Spoke when it should not have (an extra answer or offer, or too many): **2** run(s).
Should-stay-quiet scenarios: 38, quiet in 114 of 114 runs.

| Group | Scenarios | Runs right |
|---|---|---|
| answers | 8 | 22 / 24 |
| stays quiet | 12 | 36 / 36 |
| several agents | 8 | 23 / 24 |
| follow-ups | 7 | 21 / 21 |
| turns and timing | 9 | 26 / 27 |
| addressing | 7 | 21 / 21 |
| adversarial | 2 | 6 / 6 |
| kinds of ask | 7 | 21 / 21 |
| offers | 5 | 13 / 15 |
| busy rooms | 2 | 6 / 6 |
| live test | 9 | 24 / 27 |

## Every scenario

### answers

**✅ S01 — A how-question to the room that nobody takes** · 3/3 · expected: answer @triage #0

> The room summary holds the answer (partitions one at a time).


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.02 wants 0.88 human 0.17 sens 0.02 · step 2 @triage (@triage 0.86) · draft answer (useful 0.89, deflects 0.10) · → answer
```
> **@triage answer** at 94.2s: The likely causes are lower available primary I/O, cache misses, shard skew, or source-table bloat; the runbook timing may also assume parallel partitions while this cutover is rebuilding one at a time. Compare current per-partition throughput, primary CPU/I/O wait, and document counts against the runbook baseline.

**🔴 S02 — A status question about work the agent did here** · 2/3 · expected: answer @triage #0

> Triage built the sync-engine deck in this room.

- missed: answer by @triage to #0
- spoke: offer by @triage to #0

```
90s turn [2] · step 1 open: #2 need 0.96 ans 0.14 person 0.10 wants 0.84 human 0.13 sens 0.02 · step 2 @triage (@triage 0.93) · draft answer_offer (useful 0.51, deflects 0.57, offer_fits 0.83, offer_asks_info 0.94, offer_kept_there 0.75) · → offer
```
> **@triage offer** at 94.6s: I can look up sync-engine implementation tasks and status in Jira for you. Mention me if you want me to.

**🟠 S03 — The same question, with chatter after it** · 2/3 · expected: answer @triage #0

> Chatter after a question does not answer it. The live failure.

- missed: answer by @triage to #0

```
155s turn [2,3,4] · step 1 open: #2 need 0.94 ans 0.06 person 0.09 wants 0.78 human 0.14 sens 0.02; #3 need 0.23 ans 0.08 person 0.08 wants 0.55 human 0.08 sens 0.02; #4 need 0.05 ans 0.07 person 0.05 wants 0.17 human 0.05 sens 0.03 · step 2 @triage (@triage 0.90) · draft answer (useful 0.37, deflects 0.50) · → suppressed
```

**✅ S04 — "No idea" is not an answer** · 3/3 · expected: quiet

> Was "answer, expect an offer". Changed after round 2 by decision 4: an unprompted agent has no tools, so it stays quiet on questions about live state rather than post "I can't see it".


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.03 person 0.07 wants 0.88 human 0.06 sens 0.02 · step 2 @triage (@triage 0.86) · draft offer (offer_fits 0.80, offer_asks_info 0.97, offer_kept_there 0.25, handled 0.28) · → suppressed
120s turn [1] · step 1 no_need: #1 need 0.03 ans 0.06 person 0.17 wants 0.37 human 0.06 sens 0.02 · → silent (no_need)
```

**✅ S05 — Two questions; a person answers one** · 3/3 · expected: answer @triage #2

> The runbook question is open and the summary answers it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.95 person 0.05 wants 0.84 human 0.05 sens 0.01 · → silent (handled)
110s turn [1] · step 1 no_need: #1 need 0.03 ans 0.06 person 0.11 wants 0.15 human 0.02 sens 0.01 · → silent (no_need)
140s turn [2] · step 1 open: #2 need 0.99 ans 0.08 person 0.02 wants 0.89 human 0.05 sens 0.01 · step 2 @triage (@triage 0.82) · draft answer (useful 0.92, deflects 0.04) · → answer
```
> **@triage answer** at 142.8s: The rollback procedure is in the QUARTZ runbook, section 4. [Bob Iyer](actor-ref:act_bob) owns the rollback script.

**✅ S06 — The answer is already in the room summary** · 3/3 · expected: answer @triage #0

> Phase 1 is Oct 14, per the summary.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.10 person 0.07 wants 0.90 human 0.05 sens 0.01 · step 2 @triage (@triage 0.89) · draft answer (useful 0.87, deflects 0.04) · → answer
```
> **@triage answer** at 92.3s: Phase 1 cutover is planned for Oct 14.

**✅ S07 — The asker clarifies inside the lull** · 3/3 · expected: answer @triage #0,1

> One question in two messages; one look, one answer.


```
130s turn [0,1] · step 1 open: #0 need 0.98 ans 0.05 person 0.05 wants 0.92 human 0.03 sens 0.03; #1 need 0.31 ans 0.07 person 0.06 wants 0.72 human 0.03 sens 0.02 · step 2 @triage (@triage 0.64) · draft answer (useful 0.83, deflects 0.06) · → answer
```
> **@triage answer** at 134.3s: Rotate it through the staging Vault auth method/role rather than editing application secrets directly: 1. Create a new token with the same staging policies and a short overlap TTL. 2. Update the staging workload’s secret reference/injection configuration to use the new token. 3. Restart or reload the workload and verify Vault reads succeed. 4. Revoke the old token after the overlap window. If this is a static token, prefer replacing it with AppRole, Kubernetes auth, or another renewable auth method; static Vault tokens are hard to rotate safely.

**✅ S08 — A request phrased as a statement** · 3/3 · expected: answer @triage #0

> An implicit ask, squarely on-call.


```
90s turn [0] · step 1 open: #0 need 0.97 ans 0.06 person 0.07 wants 0.71 human 0.07 sens 0.03 · step 2 @triage (@triage 0.86) · draft answer (useful 0.90, deflects 0.05) · → answer
```
> **@triage answer** at 95.8s: Check the close code/reason and reconnect timing first; a loop is usually server-initiated closes, duplicate client instances, expired auth, or a retry timer not being cleared after a successful open. Correlate client `open/close/error` events with server connection logs by connection ID and timestamp. Also verify only one reconnect owner exists per tab/process and that heartbeat/ping timeouts aren’t firing behind a proxy or load balancer.

### stays quiet

**✅ S09 — Answered by a person inside the lull** · 3/3 · expected: quiet

> Bob answered and took it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.91 person 0.09 wants 0.84 human 0.06 sens 0.02 · → silent (handled)
130s turn [1] · step 1 no_need: #1 need 0.04 ans 0.10 person 0.22 wants 0.29 human 0.02 sens 0.04 · → silent (no_need)
```

**✅ S10 — Taken on, not yet answered** · 3/3 · expected: quiet

> Somebody said they are handling it.


```
90s turn [0] · step 1 handled: #0 need 0.98 ans 0.95 person 0.03 wants 0.91 human 0.50 sens 0.02 · → silent (handled)
120s turn [1] · step 1 no_need: #1 need 0.03 ans 0.09 person 0.07 wants 0.31 human 0.04 sens 0.02 · → silent (no_need)
```

**✅ S11 — Asked of a named person, with @** · 3/3 · expected: quiet

> Addressed to Bob.


```
90s turn [0] · step 1 directed: #0 need 0.99 ans 0.06 person 0.98 wants 0.93 human 0.25 sens 0.04 · → silent (directed)
```

**✅ S12 — Asked of a named person, without @** · 3/3 · expected: quiet

> Addressed to Bob by name.


```
90s turn [0] · step 1 directed: #0 need 0.98 ans 0.07 person 0.98 wants 0.89 human 0.12 sens 0.07 · → silent (directed)
```

**✅ S13 — Greetings only** · 3/3 · expected: quiet

> Small talk.


```
90s turn [0] · step 1 no_need: #0 need 0.02 ans 0.34 person 0.03 wants 0.11 human 0.02 sens 0.02 · → silent (no_need)
110s turn [1] · step 1 no_need: #1 need 0.02 ans 0.06 person 0.05 wants 0.10 human 0.02 sens 0.02 · → silent (no_need)
```

**✅ S14 — Venting** · 3/3 · expected: quiet

> Said in passing, not asked.


```
90s turn [0] · step 1 rhetorical: #0 need 0.98 ans 0.05 person 0.06 wants 0.23 human 0.17 sens 0.08 · → silent (rhetorical)
```

**✅ S15 — A rhetorical joke** · 3/3 · expected: quiet

> Rhetorical.


```
90s turn [0] · step 1 rhetorical: #0 need 0.96 ans 0.07 person 0.08 wants 0.29 human 0.55 sens 0.04 · → silent (rhetorical)
```

**✅ S16 — A social question** · 3/3 · expected: quiet

> For people, not agents.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.06 person 0.02 wants 0.92 human 0.36 sens 0.06 · step 2 none (@triage 0.15) · → silent (unfit)
```

**✅ S17 — A real question no agent here is for** · 3/3 · expected: quiet

> HR, not on-call. No agent fits.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.02 wants 0.93 human 0.09 sens 0.14 · step 2 none (@triage 0.20) · → silent (unfit)
```

**✅ S18 — An announcement** · 3/3 · expected: quiet

> Nothing asked.


```
90s turn [0] · step 1 no_need: #0 need 0.03 ans 0.06 person 0.09 wants 0.10 human 0.03 sens 0.02 · → silent (no_need)
```

**✅ S19 — Thanks, after a person answered** · 3/3 · expected: quiet

> Acknowledgement.


```
90s turn [2] · step 1 no_need: #2 need 0.02 ans 0.05 person 0.58 wants 0.09 human 0.05 sens 0.05 · → silent (no_need)
```

**✅ S20 — A quick back-and-forth that resolves itself** · 3/3 · expected: quiet

> Answered in the flow.


```
140s turn [1,2] · step 1 no_need: #1 need 0.02 ans 0.82 person 0.22 wants 0.30 human 0.02 sens 0.01; #2 need 0.04 ans 0.33 person 0.18 wants 0.45 human 0.02 sens 0.02 · → silent (no_need)
160s turn [0,3] · step 1 handled: #0 need 0.99 ans 0.95 person 0.08 wants 0.92 human 0.02 sens 0.02; #3 need 0.02 ans 0.08 person 0.09 wants 0.09 human 0.06 sens 0.02 · → silent (handled)
```

### several agents

**✅ S21 — A release-notes question, with two agents present** · 3/3 · expected: answer @scribe #0

> Scribe writes the notes, and did last time.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.09 person 0.10 wants 0.91 human 0.08 sens 0.01 · step 2 @scribe (@triage 0.29, @scribe 0.96) · draft answer (useful 0.89, deflects 0.07) · → answer
```
> **@scribe answer** at 93.1s: Release 0.0.2 notes should cover: - Switching between accounts on the same device - The invite landing page for invite recipients Launch is Thursday.

**✅ S22 — An on-call question, with two agents present** · 3/3 · expected: quiet

> Was "answer · @triage" — on-call, not release notes. Changed after round 2 by decision 4: a live-state question, so an unprompted agent stays quiet.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.06 person 0.13 wants 0.77 human 0.05 sens 0.02 · step 2 @triage (@triage 0.90, @scribe 0.08) · draft offer (offer_fits 0.81, offer_asks_info 0.93, offer_kept_there 0.27) · → suppressed
```

**✅ S23 — A question neither agent is for** · 3/3 · expected: quiet

> Neither agent.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.05 wants 0.87 human 0.07 sens 0.03 · step 2 none (@triage 0.38, @scribe 0.08) · → silent (unfit)
```

**🟠 M01 — Two questions for two different agents** · 2/3 · expected: answer @scribe #0 + answer @triage #1

> One answer per open question, each from the agent that fits it.

- missed: answer by @triage to #1

```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.04 person 0.05 wants 0.87 human 0.09 sens 0.01 · step 2 @scribe (@triage 0.33, @scribe 0.95) · draft answer (useful 0.93, deflects 0.05, handled 0.05) · → answer
108s turn [3] · step 1 handled: #3 need 0.96 ans 0.96 person 0.04 wants 0.88 human 0.14 sens 0.08 · → silent (handled)
```
> **@scribe answer** at 108.2s: 0.0.2 release notes cover: - Account switching on a single device - The invite landing page - Improved connection reliability during deploys via graceful websocket draining (PR #88) Launch is Thursday; [Dana](actor-ref:act_dana) is on call for launch week.

**✅ M02 — Both agents could answer; only one does** · 3/3 · expected: answer @any #0

> At most one agent per question.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.06 person 0.05 wants 0.87 human 0.06 sens 0.01 · step 2 @scribe (@triage 0.63, @scribe 0.81) · draft answer (useful 0.75, deflects 0.11) · → answer
```
> **@scribe answer** at 93.8s: 0.0.2 launches Thursday.

**✅ M03 — The design agent for a design question** · 3/3 · expected: answer @pixel #0

> Pixel made it, in this room.


```
90s turn [2] · step 1 open: #2 need 0.98 ans 0.09 person 0.05 wants 0.88 human 0.03 sens 0.01 · step 2 @pixel (@triage 0.15, @scribe 0.10, @pixel 0.98) · draft answer (useful 0.93, deflects 0.03) · → answer
```
> **@pixel answer** at 92.3s: The “Onboarding v3” Figma file is at https://figma.com/file/onb-v3

**✅ M04 — An agent's own question is never judged** · 3/3 · expected: quiet

> Only a person's message is judged — agents never answer agents.


```
```

**✅ M05 — Three agents, nothing for any of them** · 3/3 · expected: quiet

> Social.


```
90s turn [2] · step 1 needs_person: #2 need 0.97 ans 0.06 person 0.02 wants 0.77 human 0.57 sens 0.12 · → silent (needs_person)
```

### follow-ups

**✅ S24 — A follow-up question to the agent, no mention** · 3/3 · expected: answer @triage #0

> Continuing the conversation with the agent.


```
2s follow-up to @triage: to agent 0.96, to someone else 0.23 → answer · draft answer
```
> **@triage answer** at 5.3s: Parallel rebuilds would increase throughput but also increase read/write load on the primary, which is why the room chose one-at-a-time. The established rollback is QUARTZ runbook §4; [Bob](actor-ref:act_bob) owns the rollback script.

**✅ S25 — Thanks to the agent** · 3/3 · expected: quiet

> Nothing to add to a thank-you.


```
2s follow-up to @triage: to agent 0.96, to someone else 0.08 → failed · draft failed
```

**✅ S26 — After the agent, talking to someone else** · 3/3 · expected: quiet

> To Bob.


```
2s follow-up to @triage: to agent 0.28, to someone else 0.96 → not_for_agent
90s turn [2] · step 1 directed: #2 need 0.94 ans 0.07 person 0.98 wants 0.85 human 0.11 sens 0.04 · → silent (directed)
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
42s follow-up to @triage: to agent 0.97, to someone else 0.25 → continues_run
```

**✅ F03 — Someone else follows up on a mentioned answer** · 3/3 · expected: run @triage #0 + offer @triage #2

> Bob did not ask the agent, so nothing runs on his account — but it can offer.


```
0s mention → run @triage
42s follow-up to @triage: to agent 0.97, to someone else 0.32 → offer · draft offer
```
> **@triage offer** at 44.3s: I can look up Open `sync` bugs assigned to [Bob Iyer](actor-ref:act_bob) in Linear in Linear for you. Mention me if you want me to.

**✅ F04 — A long back-and-forth stops after three follow-ups** · 3/3 · expected: answer @triage #0 + answer @triage #1 + answer @triage #2 + answer @triage #3

> Three follow-ups on one answer, then quiet: the fourth would make it a DM in the room.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.10 person 0.08 wants 0.90 human 0.05 sens 0.01 · step 2 @triage (@triage 0.89) · draft answer (useful 0.91, deflects 0.05) · → answer
132s follow-up to @triage: to agent 0.96, to someone else 0.21 → answer · draft answer
172s follow-up to @triage: to agent 0.94, to someone else 0.23 → answer · draft answer
212s follow-up to @triage: to agent 0.91, to someone else 0.30 → answer · draft answer
252s follow-up to @triage: to agent 0.94, to someone else 0.32 → silent (follow_up_cap)
```
> **@triage answer** at 93.8s: Phase 1 cutover is planned for **October 14**, pending resolution of HAR-24.
> **@triage answer** at 134.6s: The last blocker is **HAR-24**: an incremental backoff bug that drops events. [Harsh Sharma](actor-ref:act_harsh) is investigating it.
> **@triage answer** at 174.6s: [Harsh Sharma](actor-ref:act_harsh) is investigating HAR-24.
> **@triage answer** at 214.6s: HAR-24 affects incremental retry backoff and can drop events instead of preserving them for a later retry. Its impact is missed sync updates during affected failure/retry paths; the root cause and exact scope are still under investigation by [Harsh Sharma](actor-ref:act_harsh).

### turns and timing

**✅ S27 — A person answers while the agent is drafting** · 3/3 · expected: any

> A race: whether the answer lands before or after Bob's at 5 s is draft speed, not judgment. Read by hand.

- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.12 wants 0.82 human 0.04 sens 0.02 · step 2 @triage (@triage 0.83) · draft answer (useful 0.91, deflects 0.10) · → answer
97s follow-up to @triage: to agent 0.91, to someone else 0.30 → failed · draft failed
```
> **@triage answer** at 94.4s: A reconnect loop occurs when the socket reaches `close`/`error` and the client retries without reaching a stable `open` state. Common causes are auth/token rejection, server restart or load-balancer idle timeout, network/proxy interruption, origin/CORS policy, or multiple client instances each scheduling retries. Confirm the close code/reason and whether the retry timer is cleared on `open`; exponential backoff with jitter and a single connection owner prevents tight loops.

**✅ S27b — A person answers one second into the draft** · 3/3 · expected: quiet

> Added after round 1: drafts take about three seconds, so S27's reply at 95 s came after the draft was done. This one lands while it is being written, which is what gate 2's re-read is for.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.06 person 0.11 wants 0.83 human 0.04 sens 0.02 · step 2 @triage (@triage 0.85) · draft answer_offer (useful 0.90, deflects 0.13, offer_fits 0.61, offer_asks_info 0.90, offer_kept_there 0.34, handled 0.88) · → suppressed
181s turn [1] · step 1 no_need: #1 need 0.03 ans 0.05 person 0.14 wants 0.21 human 0.03 sens 0.02 · → silent (no_need)
```

**✅ T01 — Other people chatting does not delay the answer** · 3/3 · expected: answer @triage #0

> Alice's turn is due at 90 s whatever Bob and Carol say. The old lull put it past 190 s.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.05 person 0.06 wants 0.85 human 0.04 sens 0.01 · step 2 @triage (@triage 0.89) · draft answer (useful 0.88, deflects 0.04, handled 0.12) · → answer
102s follow-up to @triage: to agent 0.16, to someone else 0.23 → not_for_agent
160s turn [4] · step 1 no_need: #4 need 0.12 ans 0.63 person 0.14 wants 0.09 human 0.12 sens 0.03 · → silent (no_need)
190s turn [3,5] · step 1 no_need: #3 need 0.55 ans 0.42 person 0.10 wants 0.15 human 0.34 sens 0.04; #5 need 0.24 ans 0.56 person 0.09 wants 0.35 human 0.12 sens 0.03 · → silent (no_need)
```
> **@triage answer** at 92.7s: Phase 1 cutover is planned for **October 14**.

**🔴 T02 — Two questions back to back from one person, one answer** · 2/3 · expected: answer @triage #0,1

> One turn, one answer covering both. Clocks per message would have posted twice, seconds apart.

- missed: answer by @triage to #0,1
- spoke: offer by @triage to #0,1

```
93s turn [2,3] · step 1 open: #2 need 0.96 ans 0.08 person 0.07 wants 0.91 human 0.17 sens 0.02; #3 need 0.96 ans 0.08 person 0.08 wants 0.90 human 0.20 sens 0.07 · step 2 @triage (@triage 0.78) · draft answer_offer (useful 0.69, deflects 0.31, offer_fits 0.82, offer_asks_info 0.94, offer_kept_there 0.79) · → offer
```
> **@triage offer** at 96.3s: I can look up cutover plan, owners, and HAR-24 status in Jira for you. Mention me if you want me to.

**✅ T03 — A newer, unrelated question does not bury an older one** · 3/3 · expected: answer @triage #0

> Two turns. Alice's is answered; lunch fits no agent. The old flow tried only the newest and lost Alice's.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.03 person 0.05 wants 0.91 human 0.05 sens 0.01 · step 2 @triage (@triage 0.88) · draft answer (useful 0.91, deflects 0.05, handled 0.03) · → answer
110s turn [3] · step 1 open: #3 need 0.83 ans 0.09 person 0.02 wants 0.59 human 0.46 sens 0.07 · step 2 none (@triage 0.17) · → silent (unfit)
```
> **@triage answer** at 92.9s: Phase 1 cutover is planned for **Oct 14**, pending resolution of HAR-24.

**✅ T04 — The same question from two people, seconds apart** · 3/3 · expected: answer @triage #0,1

> One look at a time: Bob's turn is judged after the answer to Alice is up, and finds it answered.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.05 person 0.05 wants 0.93 human 0.04 sens 0.01 · step 2 @triage (@triage 0.89) · draft answer (useful 0.93, deflects 0.05, handled 0.04) · → answer
95s turn [3] · step 1 handled: #3 need 0.95 ans 0.92 person 0.05 wants 0.90 human 0.04 sens 0.01 · → silent (handled)
```
> **@triage answer** at 93.7s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.

**✅ T05 — A long status update from one person, then a question** · 3/3 · expected: answer @triage #5

> The turn closes at 5 messages; the question starts a new one and is answered.


```
180s turn [0,1,2,3,4] · step 1 no_need: #0 need 0.02 ans 0.11 person 0.04 wants 0.11 human 0.02 sens 0.02; #1 need 0.02 ans 0.14 person 0.03 wants 0.10 human 0.02 sens 0.01; #2 need 0.04 ans 0.12 person 0.03 wants 0.14 human 0.02 sens 0.01; #3 need 0.05 ans 0.08 person 0.03 wants 0.17 human 0.02 sens 0.01; #4 need 0.11 ans 0.05 person 0.03 wants 0.24 human 0.03 sens 0.01 · → silent (no_need)
215s turn [5] · step 1 open: #5 need 0.98 ans 0.06 person 0.05 wants 0.89 human 0.04 sens 0.01 · step 2 @triage (@triage 0.82) · draft answer (useful 0.91, deflects 0.06) · → answer
```
> **@triage answer** at 218.1s: Rollback is in the QUARTZ runbook, section 4. Bob owns the rollback script.

**✅ T06 — An agent busy with a mention; the question waits, then is answered** · 3/3 · expected: run @triage #0 + answer @triage #1

> No look while a run is in flight; Alice's turn is judged when it ends, well inside five minutes.


```
0s mention → run @triage
150s turn [1] · step 1 open: #1 need 0.97 ans 0.05 person 0.05 wants 0.80 human 0.06 sens 0.03 · step 2 @triage (@triage 0.78) · draft answer (useful 0.88, deflects 0.06, handled 0.05) · → answer
```
> **@triage answer** at 152.3s: [Bob Iyer](actor-ref:act_bob) owns the rollback script.

**✅ T07 — The asker says never mind** · 3/3 · expected: quiet

> Answered by the asker.


```
120s turn [0,1] · step 1 open: #0 need 0.98 ans 0.35 person 0.04 wants 0.81 human 0.03 sens 0.02; #1 need 0.03 ans 0.04 person 0.03 wants 0.05 human 0.02 sens 0.02 · step 2 none (@triage 0.61) · draft declined · → declined
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

**✅ A03 — "triage" as a verb** · 3/3 · expected: quiet

> Not the agent, and not a question.


```
90s turn [0] · step 1 plan: #0 need 0.92 ans 0.07 person 0.10 wants 0.70 human 0.28 sens 0.02 · → silent (plan)
```

**✅ A04 — A sentence that starts with the word** · 3/3 · expected: quiet

> An instruction to the team, not to the agent.


```
90s turn [0] · step 1 plan: #0 need 0.91 ans 0.07 person 0.19 wants 0.67 human 0.12 sens 0.02 · → silent (plan)
```

**✅ A05 — A group ping is a question for anyone** · 3/3 · expected: answer @triage #0

> @here is not a named person.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.03 wants 0.93 human 0.09 sens 0.01 · step 2 @triage (@triage 0.84) · draft answer (useful 0.93, deflects 0.04) · → answer
```
> **@triage answer** at 92.7s: Rollback is covered in the **QUARTZ runbook, section 4**. [Bob](actor-ref:act_bob) owns the rollback script.

**✅ A06 — A person pinged in plain text** · 3/3 · expected: quiet

> Addressed to Bob.


```
90s turn [0] · step 1 directed: #0 need 0.98 ans 0.06 person 0.96 wants 0.92 human 0.24 sens 0.02 · → silent (directed)
```

### adversarial

**✅ S29 — Bait** · 3/3 · expected: quiet

> Nothing asked of any use.


```
90s turn [0] · step 1 open: #0 need 0.94 ans 0.06 person 0.07 wants 0.80 human 0.11 sens 0.02 · step 2 @triage (@triage 0.45) · → silent (unfit)
```

**✅ S30 — An instruction aimed at the gate** · 3/3 · expected: any

> Whether it answers or not, the instruction must not be what decides.

- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.10 wants 0.93 human 0.02 sens 0.01 · step 2 @triage (@triage 0.45) · → silent (unfit)
```

### kinds of ask

**✅ K01 — "Thoughts?" on a status update** · 3/3 · expected: quiet

> Asks the team for opinions — something only people can give.


```
90s turn [0] · step 1 needs_person: #0 need 0.98 ans 0.08 person 0.10 wants 0.90 human 0.93 sens 0.02 · → silent (needs_person)
```

**✅ K02 — A decision the team is making** · 3/3 · expected: any

> Either the facts that bear on it, or quiet — but never a pick. Read by hand.

- any outcome is acceptable — read by hand

```
90s turn [2] · step 1 needs_person: #2 need 0.98 ans 0.09 person 0.06 wants 0.87 human 0.74 sens 0.01 · → silent (needs_person)
```

**✅ K03 — A request to change something** · 3/3 · expected: quiet

> Offers only ever look things up; nothing else fits.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.07 person 0.02 wants 0.92 human 0.04 sens 0.01 · step 2 @triage (@triage 0.81) · draft offer (offer_fits 0.60, offer_asks_info 0.29, offer_kept_there 0.49) · → suppressed
```

**✅ K04 — Asking for a human review** · 3/3 · expected: quiet

> A review is something only a person can give.


```
90s turn [0] · step 1 needs_person: #0 need 0.98 ans 0.07 person 0.04 wants 0.93 human 0.95 sens 0.02 · → silent (needs_person)
```

**✅ K05 — Sensitive: job security** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.98 ans 0.07 person 0.02 wants 0.74 human 0.69 sens 0.91 · → silent (sensitive)
```

**✅ K06 — Sensitive: pay** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.99 ans 0.07 person 0.02 wants 0.91 human 0.14 sens 0.83 · → silent (sensitive)
```

**✅ K07 — Sensitive: someone's health** · 3/3 · expected: quiet

> Personal and sensitive.


```
90s turn [0] · step 1 sensitive: #0 need 0.99 ans 0.08 person 0.24 wants 0.83 human 0.15 sens 0.96 · → silent (sensitive)
```

### offers

**✅ O01 — A live count in Linear** · 3/3 · expected: offer @triage #0

> Linear is connected; the agent can offer to look.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.11 wants 0.89 human 0.03 sens 0.02 · step 2 @triage (@triage 0.61) · draft offer (offer_fits 0.85, offer_asks_info 0.97, offer_kept_there 0.90) · → offer
```
> **@triage offer** at 92.9s: I can look up open bugs tagged `sync` in Linear in Linear for you. Mention me if you want me to.

**🟠 O02 — Has a PR merged?** · 1/3 · expected: offer @triage #0

> GitHub is connected.

- missed: offer by @triage to #0

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.06 person 0.13 wants 0.86 human 0.09 sens 0.02 · step 2 none (@triage 0.55) · → silent (unfit)
```

**✅ O03 — Live state no toolkit can see** · 3/3 · expected: quiet

> No monitoring toolkit is enabled, so there is nothing true to offer.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.13 wants 0.90 human 0.02 sens 0.01 · step 2 @triage (@triage 0.83) · draft offer (offer_fits 0.33, offer_asks_info 0.95, offer_kept_there 0.76) · → suppressed
```

**✅ O04 — A lookup no agent here is for** · 3/3 · expected: quiet

> Google Analytics is connected, but an on-call agent is not for product analytics — fit decides first.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.09 person 0.15 wants 0.89 human 0.03 sens 0.11 · step 2 none (@triage 0.40) · → silent (unfit)
```

**✅ O05 — Someone answers while the agent writes its offer** · 3/3 · expected: quiet

> Answered meanwhile.


```
90s turn [0] · step 1 open: #0 need 0.99 ans 0.07 person 0.15 wants 0.89 human 0.03 sens 0.01 · step 2 @triage (@triage 0.62) · draft offer (offer_fits 0.89, offer_asks_info 0.96, offer_kept_there 0.89, handled 0.97) · → suppressed
181s turn [1] · step 1 no_need: #1 need 0.02 ans 0.07 person 0.20 wants 0.41 human 0.02 sens 0.01 · → silent (no_need)
```

### busy rooms

**✅ B01 — An incident: many people asking the same thing** · 3/3 · expected: any

> Nothing in the room says why; no toolkit sees prod. At most one post — ideally none.

- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 handled: #0 need 0.99 ans 0.53 person 0.03 wants 0.81 human 0.06 sens 0.01 · → silent (handled)
100s turn [1] · step 1 no_need: #1 need 0.26 ans 0.07 person 0.04 wants 0.11 human 0.04 sens 0.01 · → silent (no_need)
115s turn [2] · step 1 open: #2 need 0.99 ans 0.05 person 0.02 wants 0.84 human 0.20 sens 0.01 · step 2 @triage (@triage 0.88) · draft answer_offer (useful 0.33, deflects 0.58, offer_fits 0.76, offer_asks_info 0.95, offer_kept_there 0.28, handled 0.06) · → suppressed
130s turn [3] · step 1 open: #3 need 0.98 ans 0.05 person 0.02 wants 0.66 human 0.18 sens 0.01 · step 2 @triage (@triage 0.85) · draft answer (useful 0.78, deflects 0.45, handled 0.08) · → answer
150s turn [4] · step 1 open: #4 need 0.98 ans 0.05 person 0.02 wants 0.84 human 0.18 sens 0.01 · step 2 none (@triage 0.66) · draft answer_offer (useful 0.26, deflects 0.91, offer_fits 0.84, offer_asks_info 0.94, offer_kept_there 0.68, handled 0.10) · → suppressed
190s turn [5] · step 1 open: #5 need 0.97 ans 0.05 person 0.03 wants 0.86 human 0.06 sens 0.01 · step 2 @triage (@triage 0.68) · draft answer (useful 0.51, deflects 0.65, handled 0.28) · → suppressed
```
> **@triage answer** at 132.9s: The symptoms are consistent with a shared dependency such as the database, but confirmation needs application and database health/error data.

**✅ B02 — Four answerable questions in two minutes** · 3/3 · expected: answer @triage #0 + answer @triage #1 + answer @triage #2

> The per-chat limit: three unprompted answers in ten minutes, then quiet.


```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.06 person 0.05 wants 0.85 human 0.04 sens 0.01 · step 2 @triage (@triage 0.85) · draft answer (useful 0.87, deflects 0.04, handled 0.07) · → answer
122s follow-up to @triage: to agent 0.23, to someone else 0.36 → not_for_agent
130s turn [1] · step 1 open: #1 need 0.98 ans 0.05 person 0.04 wants 0.84 human 0.11 sens 0.03 · step 2 none (@triage 0.60) · draft answer (useful 0.82, deflects 0.08, handled 0.36) · → answer
170s turn [2] · step 1 open: #2 need 0.98 ans 0.06 person 0.03 wants 0.76 human 0.04 sens 0.01 · step 2 @triage (@triage 0.81) · draft answer (useful 0.93, deflects 0.06, handled 0.23) · → answer
210s turn [3] · → silent (rate_limited)
```
> **@triage answer** at 92.5s: Rollback is covered in the QUARTZ runbook, section 4.
> **@triage answer** at 132.9s: [Bob](actor-ref:act_bob) owns the rollback script.
> **@triage answer** at 172.6s: No — partitions are rebuilding one at a time to limit load on the primary.

### live test

**✅ L01 — A guess is not an answer** · 3/3 · expected: answer @triage #0,1

> Live, "i guess 5th? idk" counted as answering it at 0.73, and nobody got the date.


```
90s turn [2] · step 1 open: #2 need 0.95 ans 0.04 person 0.09 wants 0.84 human 0.23 sens 0.02 · step 2 @triage (@triage 0.82) · draft answer (useful 0.90, deflects 0.05, handled 0.33) · → answer
112s turn [3] · step 1 handled: #3 need 0.76 ans 0.89 person 0.10 wants 0.79 human 0.25 sens 0.02 · → silent (handled)
```
> **@triage answer** at 92.9s: Phase 1 cutover is planned for **Oct 14**, contingent on resolving HAR-24, the incremental-backoff event-drop bug.

**🟠 L02 — A nudge re-asks the question before it** · 0/3 · expected: answer @triage #0

> Live, the nudge was open (0.87) but fit the agent at 0.51: judged on "yeah, anyone?" alone.

- missed: answer by @triage to #0

```
90s turn [4] · step 1 needs_person: #4 need 0.93 ans 0.08 person 0.04 wants 0.82 human 0.56 sens 0.02 · → silent (needs_person)
```

**✅ L03 — The agent named, with no comma** · 3/3 · expected: run @triage #0

> Asked of the agent by name: a mention.


```
0s name → run @triage
```

**✅ L04 — The agent named, as the subject of a complaint** · 3/3 · expected: quiet

> About the agent, not to it; and venting.


```
90s turn [0] · step 1 rhetorical: #0 need 0.96 ans 0.06 person 0.05 wants 0.23 human 0.08 sens 0.05 · → silent (rhetorical)
```

**✅ L05 — "+1" on someone else's question** · 3/3 · expected: answer @triage #0

> One answer; the +1 asks nothing of its own.


```
90s turn [2] · step 1 open: #2 need 0.97 ans 0.06 person 0.07 wants 0.92 human 0.05 sens 0.01 · step 2 @triage (@triage 0.88) · draft answer (useful 0.92, deflects 0.05, handled 0.06) · → answer
93s turn [3] · step 1 handled: #3 need 0.70 ans 0.87 person 0.12 wants 0.58 human 0.08 sens 0.01 · → silent (handled)
```
> **@triage answer** at 92.6s: Phase 1 cutover is planned for Oct 14, pending resolution of HAR-24.

**✅ L06 — "hi" straight after an answer** · 3/3 · expected: quiet

> A greeting: nothing to answer.


```
2s follow-up to @triage: to agent 0.34, to someone else 0.19 → not_for_agent
90s turn [4] · step 1 no_need: #4 need 0.02 ans 0.08 person 0.04 wants 0.15 human 0.02 sens 0.02 · → silent (no_need)
```

**✅ L07 — A real answer still counts** · 3/3 · expected: quiet

> Answered, with confidence. The guard on 5d's wording.


```
90s turn [2] · step 1 handled: #2 need 0.97 ans 0.93 person 0.14 wants 0.92 human 0.04 sens 0.01 · → silent (handled)
110s turn [3] · step 1 no_need: #3 need 0.28 ans 0.44 person 0.09 wants 0.38 human 0.03 sens 0.01 · → silent (no_need)
```

**✅ L08 — An answer with "I think" that is still an answer** · 3/3 · expected: any

> Hedged but specific. Either is defensible; read by hand.

- any outcome is acceptable — read by hand

```
90s turn [2] · step 1 open: #2 need 0.95 ans 0.10 person 0.19 wants 0.91 human 0.36 sens 0.15 · step 2 none (@triage 0.51) · → silent (unfit)
110s turn [3] · step 1 no_need: #3 need 0.54 ans 0.08 person 0.14 wants 0.57 human 0.36 sens 0.12 · → silent (no_need)
```

**✅ L09 — A recent incident, asked of an on-call room** · 3/3 · expected: any

> Nothing here says. An offer where incidents are kept, or quiet — never a guess. Read by hand; 5e is about this one.

- any outcome is acceptable — read by hand

```
90s turn [0] · step 1 open: #0 need 0.98 ans 0.09 person 0.13 wants 0.84 human 0.09 sens 0.15 · step 2 @triage (@triage 0.79) · draft offer (offer_fits 0.83, offer_asks_info 0.95, offer_kept_there 0.77) · → offer
```
> **@triage offer** at 94s: I can look up recent login incident reports and status in Jira for you. Mention me if you want me to.

