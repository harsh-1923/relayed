# Ambient answers — spike audit

Round 1 2026-09-23T05:31:21.868Z, round 2 2026-09-23T05:35:28.378Z, round 4 2026-09-23T06:43:06.857Z (3 runs each). 31 scenarios, jev-1.13.0, simulated 90s lull, real Jev and real drafts.

Every round is judged against today's expectations, which carry decision 4: S04 and S22 — live-state questions — are to stay quiet. Against their own expectations rounds 1 and 2 each missed those two more.

## Headline

| | Right | Spoke when it should not | Missed an answer | Drafts spent |
|---|---|---|---|---|
| Built (window at once, literal gate 2) | **26 / 30** | none | S01, S03, S05, S08 | 11 |
| Per-message, built bars (round 1) | **26 / 30** | none | S01, S03, S07, S08 | 11 |
| Per-message, adjusted (round 2) | **31 / 31** | none | none | 14 |
| Shipped code (round 4, 92/93 runs right) | **30 / 31** | none | S07 | 42 |

## Every scenario

| | Scenario | Should | Built | Per-message r1 | Per-message r2 | Shipped (r4, ×3) |
|---|---|---|---|---|---|---|
| S01 | A how-question to the room that nobody takes | answer · @triage · m0 | ❌ MISSED — triage drafted → suppressed (off_target) | ❌ MISSED — triage drafted → suppressed (off_target) | ✅ @triage answered m0 via lull, 93s after it | ✅ 3/3 runs · @triage answered m0 via lull, 94s after it |
| S02 | A status question about work the agent did here | answer · @triage · m0 | ✅ @triage answered m0 via lull, 93s after it | ✅ @triage answered m0 via lull, 93s after it | ✅ @triage answered m0 via lull, 93s after it | ✅ 3/3 runs · @triage answered m0 via lull, 94s after it |
| S03 | The same question, with chatter after it | answer · @triage · m0 | ❌ MISSED — mention path; quiet: no_need | ❌ MISSED — mention path; triage drafted → suppressed (off_target) | ✅ @triage answered m0 via lull, 158s after it | ✅ 3/3 runs · @triage answered m0 via lull, 158s after it |
| S04 | "No idea" is not an answer | silent | ✅ quiet — quiet: handled | ✅ quiet — quiet: handled | ✅ quiet — triage drafted → suppressed (deflects) | ✅ 3/3 runs · quiet — triage drafted → declined |
| S05 | Two questions; a person answers one | answer · @triage · m2 | ❌ MISSED — quiet: handled | ✅ @triage answered m2 via lull, 93s after it | ✅ @triage answered m2 via lull, 93s after it | ✅ 3/3 runs · @triage answered m2 via lull, 93s after it |
| S06 | The answer is already in the room summary | answer · @triage · m0 | ✅ @triage answered m0 via lull, 92s after it | ✅ @triage answered m0 via lull, 92s after it | ✅ @triage answered m0 via lull, 93s after it | ✅ 3/3 runs · @triage answered m0 via lull, 93s after it |
| S07 | The asker clarifies inside the lull | answer · @triage · m0/1 | ✅ @triage answered m0 via lull, 134s after it | ❌ MISSED — quiet: unsure | ✅ @triage answered m0 via lull, 134s after it | ❌ 2/3 runs · MISSED — triage drafted → suppressed (deflects) |
| S08 | A request phrased as a statement | answer · @triage · m0 | ❌ MISSED — triage drafted → suppressed (off_target) | ❌ MISSED — triage drafted → suppressed (off_target) | ✅ @triage answered m0 via lull, 94s after it | ✅ 3/3 runs · @triage answered m0 via lull, 93s after it |
| S09 | Answered by a person inside the lull | silent | ✅ quiet — quiet: no_need | ✅ quiet — quiet: handled | ✅ quiet — quiet: handled | ✅ 3/3 runs · quiet — quiet: handled |
| S10 | Taken on, not yet answered | silent | ✅ quiet — quiet: no_need | ✅ quiet — quiet: handled | ✅ quiet — quiet: handled | ✅ 3/3 runs · quiet — quiet: handled |
| S11 | Asked of a named person, with @ | silent | ✅ quiet — quiet: directed | ✅ quiet — quiet: directed | ✅ quiet — quiet: directed | ✅ 3/3 runs · quiet — quiet: directed |
| S12 | Asked of a named person, without @ | silent | ✅ quiet — quiet: directed | ✅ quiet — quiet: directed | ✅ quiet — quiet: directed | ✅ 3/3 runs · quiet — quiet: directed |
| S13 | Greetings only | silent | ✅ quiet — quiet: no_need | ✅ quiet — quiet: no_need | ✅ quiet — quiet: no_need | ✅ 3/3 runs · quiet — quiet: no_need |
| S14 | Venting | silent | ✅ quiet — triage drafted → declined | ✅ quiet — quiet: rhetorical | ✅ quiet — quiet: rhetorical | ✅ 3/3 runs · quiet — quiet: rhetorical |
| S15 | A rhetorical joke | silent | ✅ quiet — quiet: social | ✅ quiet — quiet: rhetorical | ✅ quiet — quiet: rhetorical | ✅ 3/3 runs · quiet — quiet: rhetorical |
| S16 | A social question | silent | ✅ quiet — quiet: social | ✅ quiet — quiet: no_agent | ✅ quiet — quiet: no_agent | ✅ 3/3 runs · quiet — quiet: no_agent |
| S17 | A real question no agent here is for | silent | ✅ quiet — quiet: no_agent | ✅ quiet — quiet: no_agent | ✅ quiet — quiet: no_agent | ✅ 3/3 runs · quiet — quiet: no_agent |
| S18 | An announcement | silent | ✅ quiet — quiet: no_need | ✅ quiet — quiet: no_need | ✅ quiet — quiet: no_need | ✅ 3/3 runs · quiet — quiet: no_need |
| S19 | Thanks, after a person answered | silent | ✅ quiet — quiet: no_need | ✅ quiet — quiet: handled | ✅ quiet — quiet: handled | ✅ 3/3 runs · quiet — quiet: handled |
| S20 | A quick back-and-forth that resolves itself | silent | ✅ quiet — quiet: no_need | ✅ quiet — quiet: handled | ✅ quiet — quiet: handled | ✅ 3/3 runs · quiet — quiet: handled |
| S21 | A release-notes question, with two agents present | answer · @scribe · m0 | ✅ @scribe answered m0 via lull, 93s after it | ✅ @scribe answered m0 via lull, 93s after it | ✅ @scribe answered m0 via lull, 93s after it | ✅ 3/3 runs · @scribe answered m0 via lull, 93s after it |
| S22 | An on-call question, with two agents present | silent | ✅ quiet — triage drafted → suppressed (off_target) | ✅ quiet — triage drafted → suppressed (off_target) | ✅ quiet — triage drafted → suppressed (deflects) | ✅ 3/3 runs · quiet — triage drafted → suppressed (deflects) |
| S23 | A question neither agent is for | silent | ✅ quiet — quiet: social | ✅ quiet — quiet: no_agent | ✅ quiet — quiet: no_agent | ✅ 3/3 runs · quiet — quiet: no_agent |
| S24 | A follow-up question to the agent, no mention | answer · @triage · m0 | ✅ @triage answered m0 via lull, 93s after it | ✅ @triage answered m0 via lull, 93s after it | ✅ @triage answered m0 via follow-up, 2s after it | ✅ 3/3 runs · @triage answered m0 via follow-up, 2s after it |
| S25 | Thanks to the agent | silent | ✅ quiet — follow-up declined | ✅ quiet — follow-up declined | ✅ quiet — follow-up suppressed (deflects) | ✅ 3/3 runs · quiet — follow-up suppressed (not_useful) |
| S26 | After the agent, talking to someone else | silent | ✅ quiet — follow-up: not for the agent; quiet: directed | ✅ quiet — follow-up: not for the agent; quiet: directed | ✅ quiet — follow-up: not for the agent; quiet: directed | ✅ 3/3 runs · quiet — follow-up: not for the agent; quiet: directed |
| S27 | A person answers while the agent is drafting | silent | ✅ quiet — triage drafted → suppressed (off_target); quiet: no_need | ✅ quiet — triage drafted → suppressed (off_target); quiet: no_need | ✅ quiet — triage drafted → suppressed (deflects); quiet: no_need | ✅ 3/3 runs · quiet — triage drafted → suppressed (deflects); quiet: no_need |
| S27b | A person answers one second into the draft | silent | — | — | ✅ quiet — triage drafted → suppressed (deflects); quiet: no_need | ✅ 3/3 runs · quiet — triage drafted → suppressed (deflects); quiet: no_need |
| S28 | A mention is the mention path, not this one | mention | ✅ quiet — mention path | ✅ quiet — mention path | ✅ quiet — mention path | ✅ 3/3 runs · quiet — mention path |
| S29 | Bait | silent | ✅ quiet — quiet: social | ✅ quiet — quiet: unsure | ✅ quiet — quiet: unfit | ✅ 3/3 runs · quiet — quiet: unfit |
| S30 | An instruction aimed at the gate | either | ✅ quiet: unsure | ✅ quiet: unsure | ✅ quiet: unfit | ✅ 3/3 runs · quiet: unfit |

## What round 2 posted, and what it held back

**S01 — posted** · @triage · draft 1791 ms · useful 0.86, deflects 0.07

> **Q:** anyone know why the index rebuild is taking 3x longer than the runbook says?
>
> **A:** Check whether the partitions are still being rebuilt serially; the runbook timing may assume parallel work. Also compare current primary load and partition size/skew against the runbook baseline.

**S02 — posted** · @triage · draft 1511 ms · useful 0.85, deflects 0.07

> **Q:** Are we working on the sync engine side of things?
>
> **A:** Yes — the evaluation, cost model, and phased adoption plan are complete. Phase 1 cutover is planned for Oct 14.

**S03 — posted** · @triage · draft 1880 ms · useful 0.94, deflects 0.04, handled 0.07

> **Q:** Are we working on the sync engine side of things?
>
> **A:** Yes — the sync-engine evaluation and adoption plan are complete, with Phase 1 cutover planned for Oct 14.

**S04 — suppressed (deflects)** · @triage · draft 1404 ms · useful 0.74, deflects 0.92, handled 0.37

> **Q:** is staging down right now?
>
> **A:** I can’t verify staging status from this context. Check the latest deploy/uptime dashboard and recent alerts; mention me with those details if you need help interpreting them.

**S05 — posted** · @triage · draft 1163 ms · useful 0.92, deflects 0.04

> **Q:** does anyone know where the rollback runbook for the cutover lives?
>
> **A:** The rollback procedure is in the QUARTZ runbook, section 4. [Bob Iyer](actor-ref:act_bob) owns the rollback script.

**S06 — posted** · @triage · draft 1199 ms · useful 0.87, deflects 0.04

> **Q:** when is the sync engine cutover planned?
>
> **A:** Phase 1 cutover is planned for **October 14**.

**S07 — posted** · @triage · draft 2624 ms · useful 0.88, deflects 0.03, handled 0.04

> **Q:** how do I rotate the vault token?
>
> **A:** Use the Vault token’s accessor to revoke it, then create a replacement with the same policies and update the consuming secret/config before restarting workloads. ```bash vault token lookup vault token create -policy=<policy> -ttl=<duration> # update the deployment/secret with the new token vault token revoke <old-token-or-accessor> ``` For AppRole/Kubernetes auth, rotate the underlying SecretID or auth role credentials instead of using a long-lived token.

**S08 — posted** · @triage · draft 2031 ms · useful 0.86, deflects 0.07

> **Q:** the websocket reconnect loop is back and I can't tell what's causing it
>
> **A:** I’d check the browser close code/reason and the server-side disconnect logs for the same connection IDs first. The common differentiators are auth refresh failures (often 401/4401), proxy idle timeouts, and duplicate reconnect timers after a network transition.

**S21 — posted** · @scribe · draft 1443 ms · useful 0.90, deflects 0.08

> **Q:** what's going into the release notes for 0.0.2?
>
> **A:** 0.0.2 release notes will cover **account switching on one device** and the new invite landing page. Launch is Thursday.

**S22 — suppressed (deflects)** · @triage · draft 1397 ms · useful 0.79, deflects 0.86

> **Q:** is the websocket server throwing errors again?
>
> **A:** I can’t see the websocket server logs from here. I’d check recent error rate, disconnects, and deploy/infra events to confirm.

**S24 — posted** · @triage · draft 1586 ms · useful 0.86, deflects 0.09

> **Q:** can we run them in parallel instead?
>
> **A:** Parallel runs would increase load on the primary and reverse the Sep 12 safety decision. Any change should be explicitly approved with a rollback plan; rollback is QUARTZ runbook §4, with [Bob](actor-ref:act_bob) owning the script.

**S25 — suppressed (deflects)** · @triage · draft 1037 ms · useful 0.03, deflects 0.75

> **Q:** thanks triage!
>
> **A:** NO_CONTENT

**S27 — suppressed (deflects)** · @triage · draft 1760 ms · useful 0.81, deflects 0.67

> **Q:** why is the websocket reconnect loop happening?
>
> **A:** I can’t determine the cause from the information provided. I’d check the client close codes/reasons, network/proxy idle timeouts, auth-token refresh failures, and whether reconnect attempts correlate with deploys or backend pod restarts.

**S27b — suppressed (deflects)** · @triage · draft 1751 ms · useful 0.75, deflects 0.79, handled 0.91

> **Q:** why is the websocket reconnect loop happening?
>
> **A:** I can’t determine the cause from the available context. I’d check the client close codes/reasons and correlate reconnect timestamps with server, proxy, and network logs.

## Speed and size (round 2)

| | p50 / p95 |
|---|---|
| Built gate 1 (one call over the window) | 392 / 495 ms |
| Per-message step 1 (four questions per message) | 389 / 454 ms |
| Per-message step 2 (which agent) | 368 / 444 ms |
| Gate 2 (split, two calls in parallel) | 382 / 450 ms |
| Draft (agent runtime) | 1751 / 2624 ms |

State + questions per look: step 1 ≈ 851 characters, step 2 ≈ 1186 — roughly 509 tokens, or about $0.2139 per ten thousand looks at $0.042 per million.
