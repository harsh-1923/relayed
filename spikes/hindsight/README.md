# Hindsight spikes

Stage 0 of the memory plan ([`docs/MEMORY.md`](../../docs/MEMORY.md) §16). **No
app code is written until these have run** — spike A can change the bank map,
which everything downstream rests on.

Executable models, not app code. They talk to real Hindsight Cloud through the
official TS client, because the server will ship on that client and a raw-REST
spike would leave the half we do not control untested.

```bash
cd spikes/hindsight && npm install
npm run bank      # 0 — does a bank keep the config we give it?
npm run scopes    # A — can a tag carry a boundary inside one bank?
npm run extract   # B — what should the ingestion unit be?
npm test          # 0 and A
```

`extract` is **not** in `npm test`: it makes ~52 retains across three banks,
which is a minute of wall time and a few cents, and it answers a question that
is now answered. Run it again when the extraction instructions change.

Needs `HINDSIGHT_BASE_URL`, `HINDSIGHT_API_KEY` and `HINDSIGHT_TENANT` in the
repo-root `.env`. The key is never printed and never written to `results/`.

Each run uses a **fresh bank** (`spike-<name>-<base36 time>`) so a rerun can
never read a stale one, and leaves it in place for inspection.

## What each answers

### `0-bank.mjs` — the persistence trap

Hindsight materialises the bank row lazily on **first retain**. A config write
before that returns 200 and persists nothing, which is how xyne-spaces ran
production banks on defaults for months with no error anywhere. This writes,
reads back, and — if it did not stick — forces materialisation with a warmup
retain and writes again, which is the loop `ensureBank` will use
([`MEMORY.md`](../../docs/MEMORY.md) §6.4).

It also prints the client's **real method surface** before using it, saved to
`results/client-surface.json`. If a name differs from the documented one, every
other spike fails opaquely, so this runs first.

### `1-scopes.mjs` — spike A

Our bank map puts every public space in one `ws:<workspace>` bank separated only
by a `space:<id>` tag, and enforces public-versus-private with a live tag list at
recall ([`MEMORY.md`](../../docs/MEMORY.md) §8.2). **That is a permission
boundary carried by tags** — the configuration that over-matched for xyne-spaces
on 2026-05-25, returning a whole bank regardless of the tag passed. Their recall
never sent `tags_match`, so the fail-open default (`any`, which *includes
untagged memories*) applied. This separates the two causes.

Observations are **on** here though production turns them off: consolidation is
the mechanism that could merge facts across scopes, so a spike without it would
prove nothing about the risk.

Assertions, in the order they matter:

| | Assertion | If it fails |
|---|---|---|
| 1 | **every returned fact carries its `tags`** | public spaces cannot share a bank; §5.2's bank map splits |
| 2 | every returned fact carries its `documentId` | recalled facts cannot be traced to messages; §7.2 citations are unbuildable |
| 3 | no scope-B fact appears in a scope-A strict recall | the tag filter is not a boundary even with `any_strict` |
| 4 | no returned fact is tagged with the other scope | consolidation unioned tags across the boundary |
| 5 | no observation scope contains both space tags | same, read directly rather than inferred |
| 6 | a client-supplied `documentId` deletes and cascades | the forget path in §8.1 rebuilds around delete-by-tag |
| 7 | `timestamp` is stored as event time, not ingest time | timeline entries (§14.3) would all carry the ingest time |

Assertion 1 is the one that decides something structural. The rest confirm the
design as written.

### `2-extract.mjs` — spike B

What should the ingestion unit be ([`MEMORY.md`](../../docs/MEMORY.md) §6.1)?
Three granularities over one corpus — per message, fixed 20-message windows, and
episodes cut where the room went quiet — each into its own bank, each scored
against ground truth written **before** any of them ran.

`corpus.mjs` holds 45 messages across four exchanges and 14 ground-truth facts,
deliberately split **7 cross-turn / 7 self-contained** so the corpus cannot
flatter the larger units. Scoring is by term presence rather than judgement, so
it is reproducible and the terms are what you argue with.

Not `pnpm mock`: its bodies are drawn at random from a pool of one-liners
(`'shipping the fix now'`, `'standup in 5'`), so no two adjacent messages relate.
Granularity is a question *about adjacency*, and a corpus with none would score
every granularity the same while looking like it had proved per-message is fine.

Real `retain` rather than `dry-run/extract`: it is the path we ship, and it
leaves three banks the same question can be asked of afterwards.

The `any` versus `any_strict` comparison is **recorded, not asserted** — neither
outcome is a failure of our design, but both change what stage 5 has to do.

## Findings

**Run 2026-09-19**, client `@vectorize-io/hindsight-client@0.10.0` (pinned —
Hindsight behaviour drifts across versions and xyne-spaces has the scars),
Hindsight Cloud. `0-bank` 8/8, `1-scopes` 16/16, reproduced across two runs.

### The one that decided something

**Every recalled fact carries its `tags`.** So a fact can be re-filtered against
the run's allowed space set before it reaches a prompt, the workspace bank can
hold every public space, and the bank map in [`MEMORY.md`](../../docs/MEMORY.md)
§5.2 stands as written.

### `any_strict` did not over-match

Scoped to `space:A`: strict returned 7, `any` returned 9, and **the two extra
were untagged — not scope B's.** No scope-B fact and no scope-B marker phrase
appeared under either mode, and no observation scope spanned both tags.

So the 2026-05-25 incident does not reproduce here. Its root cause reads as the
fail-open default — `any` includes untagged memories, and xyne-spaces never
passed `tags_match` at all — rather than a provider bug, or it has since been
fixed. **This does not change the design**: we use banks for the boundary, pass
`any_strict`, and re-filter in JavaScript regardless (§5.3).

`retain` also takes `observationScopes` (`per_tag` | `combined` |
`all_combinations` | `shared` | explicit groups), which is the explicit control
if consolidation ever does cross a boundary.

### Raw facts cite; observations cannot

`world` facts carry `document_id` **and our `metadata` intact**. **Observations
carry neither** — a consolidated observation has several sources and no single
one, so there is nothing honest to cite.

Citations (§7.2) therefore work exactly as long as observations stay off, which
§6.4 already decided because they ~2x-duplicate world facts. That decision is now
**load-bearing twice**, and it should not be reversed without re-reading this.

### Confirmed by observation, not inherited

- **Hindsight annotates stored content.** Fact text came back as
  `"Northwind migration is blocked by vault rotation. | When: 2026-09-01"`. The
  never-re-retain-our-own-output invariant is real, seen rather than quoted.
- **`timestamp` is stored as event time.** A retain stamped `2026-09-01` came
  back `occurred_start: 2026-09-01T10:00:00+00:00`. The assumption xyne-spaces
  flagged as unverified under their whole temporal design is verified.
- **`deleteDocument` cascades.** Facts for a client-supplied `documentId` went
  4 → 0. It returns `void`, so verify by listing rather than by a count.

### The persistence trap did not reproduce

A config write **before any retain** persisted and read back correctly. The
warmup-retain path in §6.4 was never exercised. Keep the verify-by-GET — it is
one cheap call and the failure mode is silent — but `ensureBank` does not need
the warmup on this version.

### Numbers, measured here

| | |
|---|---|
| `retain`, one short conversation, `async: false` | 1.4–3.5 s |
| `recall`, tag-scoped | **0.6–1.4 s** |
| `recall`, unscoped-ish (`any`) | 1.3–7.4 s |
| `createBank` | 1.4–3.7 s |

This resolves the conflict between the vendor's "100–600 ms" and xyne-spaces'
"7–11 s": **a scoped recall is fast and an unscoped one is not**, and the spread
across runs is wide enough that §12's histogram matters more than any single
figure here.

## Spike B — 2026-09-19

| | calls | facts | ground truth | cross-turn | self-contained | tokens | cost | wall |
|---|---|---|---|---|---|---|---|---|
| per-message | 45 | 37 | **10/14** | 6/7 | 4/7 | 2,527 | $0.025 | 101 s |
| window-20 | 3 | 13 | **13/14** | 7/7 | 6/7 | 1,151 | $0.012 | 8 s |
| **episode** | 4 | 15 | **14/14** | **7/7** | **7/7** | 1,184 | $0.012 | 28 s |

### Per-message loses, decisively and on every axis

10 of 14 facts, for **2.2× the tokens and 12× the wall time**. It also extracted
*more* facts (37 against 15) while capturing fewer real ones — it over-produces
trivia from each message and misses the specifics. §6.1 stands.

### The prediction was half wrong, and the correction is the better finding

I predicted per-message would keep the self-contained facts and lose the
cross-turn ones. **The opposite skew happened**: 6/7 cross-turn, 4/7
self-contained. It missed the rebuild's progress ("about 40% after six hours"),
the runbook being stale ("QUARTZ runbook, section 4"), and the PR number.

Those were the ones I had *labelled* self-contained, and the labelling was
wrong. 40% of what? A runbook for what? **In chat almost nothing is
self-contained, including the things that look like they are** — which is a
stronger claim than the hypothesis it replaced, and it argues for larger units
more broadly than "facts live between turns" did.

### The window's one miss is the boundary effect, caught in the act

`window-20` missed exactly one fact: the PR identifier. Its fact 9 reads *"Dev
Anand created a rollback PR for the platform"* — **the number 4471 dropped.**

The windows cut `[20, 20, 5]`, and message 19 — the one carrying
`https://github.com/acme/platform/pull/4471` — is the **last message of window
one**, with its approval two messages later in window two. A window that cuts
just after a link drops the identifier.

One instance, not a statistic. But it is a *mechanism* caught happening, which
is more use than a count: it is exactly the failure §6.1 predicted, and the
episode run kept the fact because the link and its approval stayed together.

### The episode rule is eight lines, not a subsystem

Worth stating because it changes the advice. The cut is a fold over the
messages comparing each gap to `QUIET_MINUTES`. I had described episodes as
meaningfully more machinery than a fixed window and offered the window as the
simpler starting point — **that was an overestimate**. Go straight to episodes.

The margin over a fixed window is honest about itself: **one fact in fourteen,
in one corpus.** The unambiguous result here is per-message losing, not episodes
beating windows.

### Corrections to the plan

- `retain(bankId, content, options)` takes content as a **positional string**;
  putting it in the options object is a 422. Cost one run to find.
- `deleteDocument` resolves to `void`.
- `listMemories` items carry far more than recall results: `document_id`,
  `chunk_id`, `proof_count`, `state`, `source_memory_ids`, `consolidated_at`.
