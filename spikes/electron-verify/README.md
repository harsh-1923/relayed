# Phase 0 verifications

Two assumptions the architecture rests on, checked against a real Electron
runtime rather than reasoned about (`docs/DESIGN.md` §15, Phase 0).

```bash
npm install
npm run sqlite          # ~2s
npm run timer           # 16 min — hides the window, needs to run undisturbed
```

Standalone on purpose: not a pnpm workspace member, so a ~200 MB Electron
binary stays out of the main install.

## What they check

**`npm run sqlite`** — runs the §8.3 schema and the §13.4 FTS triggers inside a
`utilityProcess`, then exercises the behaviours the design depends on:
`auto_vacuum = 2`, WAL, FTS round-trip with `integrity-check`, the CHECK/NULL
rejection, and the singleton partial index. **If this fails**, `node:sqlite` is
not viable and we are back to `better-sqlite3` + `electron-rebuild` — reversing
a `STACK.md` decision and reintroducing native builds everywhere.

**`npm run timer`** — times a 5s interval in a `utilityProcess` against an
identical timer in a hidden renderer, which acts as a **control**. Chromium
clamps hidden-page timers to about 1/minute; the utility process should be
unaffected. **If this fails**, the 30s heartbeat (§13.9) stretches past every
proxy idle timeout, sockets get dropped, and it presents as a network bug rather
than a throttling one.

The control is what makes the result trustworthy. If neither timer throttles the
harness reports **inconclusive** rather than success, because that only shows
throttling never engaged.

## Re-run these on every Electron major upgrade

Both are platform behaviour, not guarantees. Electron 45 could change either
answer, and both failures would surface far from their cause.

## Results — Electron 44.2.0 / Node 24.20.0, macOS arm64

| Check | Result |
|---|---|
| `node:sqlite` | **12/12 pass.** SQLite 3.53.4 — same build as standalone Node. |
| Timer throttling | **Confirmed.** utility 191 ticks @ 5001 ms median; renderer 27 ticks @ 59958 ms. |
