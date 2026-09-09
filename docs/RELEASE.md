# Release and distribution

How builds reach users, what is deliberately deferred, and what changes when
each deferred piece lands.

Architecture is in [`DESIGN.md`](DESIGN.md); technology choices are in
[`STACK.md`](STACK.md).

**Last updated:** 2026-09-08

---

## 1. Where we are

| | Decision |
|---|---|
| **UI delivery** | Bundled in the app. Ships in the installer, never fetched at runtime. |
| **Update mechanism** | In-app nag: poll a version endpoint, tell the user a new build exists, link to the download. |
| **Auto-update** | **None.** No `electron-updater`, no Squirrel. |
| **Code signing** | **Deferred.** Unsigned on both platforms for now. |
| **Bundle / OTA channel** | **Deferred.** Revisit when the schema stops changing weekly (§4). |

This is the simplest model that satisfies R3, and it is roughly what a
comparable internal Electron app at Juspay (`xyne-spaces`) runs today — minus
the bundled UI, which it does not need because it is not local-first.

### Why the UI is bundled rather than remote-loaded

Slack, and `xyne-spaces`, load their UI from a URL. That makes UI changes ship
like a web deploy — genuinely attractive.

**We cannot.** R3 requires the app to open and be fully readable with no
network. A renderer fetched at boot means the app does not start on a plane —
which breaks local-first at the first read, before the data layer is even
reached. §3's rule covers the UI as much as the messages.

### Why no auto-update yet

Not for its own sake — it is a **sequencing constraint**.

Squirrel.Mac validates that an update is signed by the same identity as the
running app. Ship auto-update on unsigned builds and then start signing, and
auto-update silently stops working: users sit on a stale build that will never
update itself, and nobody finds out for weeks.

Since we are deferring signing, we must also defer auto-update. **The two go
live together, or signing goes first.** Until then, a nag with a download link
has no chain to break.

---

## 2. What unsigned actually looks like

Not a warning users click through — the platforms are asymmetric, and macOS is
the bad one.

| | What the user sees | What they must do |
|---|---|---|
| **Windows** | *"Windows protected your PC"* (SmartScreen) | **More info → Run anyway.** A click-through. |
| **macOS** | *"Relayed is damaged and can't be opened. You should move it to the Trash."* | **`xattr -cr /Applications/Relayed.app` in Terminal.** |

The macOS message is worse than expected, for a specific reason: an "unsigned"
Electron app is not unsigned — it carries an ad-hoc signature that *actively
fails* validation, so macOS reports it as **damaged** rather than "unidentified
developer." The friendly right-click→Open bypass applies to the latter, not to a
signature-validation failure.

Two consequences to plan around:

- It reads as *"this download is corrupt or malicious."* Users trash it and file
  a support ticket rather than following a workaround.
- **It repeats on every update.** In a nag-to-download loop, the cost is
  multiplied by release frequency, not paid once at onboarding.

**This is the strongest argument for signing macOS early** — not auto-update,
which we do not have, but the per-release friction tax.

---

## 3. Signing: what changes and when

### Cost is asymmetric — treat the platforms separately

| | Cost | Setup | Unsigned pain |
|---|---|---|---|
| **macOS** | $99/yr | ~1 day | **Severe** (§2) |
| **Windows** | $200–800/yr, or Azure Trusted Signing org verification | Harder | Click-through |

Since June 2023, code signing keys must live on hardware or an HSM, which makes
Windows CI signing genuinely awkward. **Azure Trusted Signing** (~$10/month,
cloud HSM) is the practical path. macOS is cheap and fast by comparison.

**Sign macOS first. Windows can wait longer.**

### Start the accounts now, wire it up later

The risk is **account latency, not engineering effort**. Apple Developer
enrolment takes days; Azure org verification longer. Deciding to sign the week
before a launch and then waiting two weeks on verification is the failure mode.

Enrolment is $99 and a form, and is independent of any code. **Do it now** so it
is never on the critical path.

### What changes for the release

Roughly a day, all configuration:

- Developer ID Application certificate in the CI keychain
- electron-builder: `notarize: true`, `hardenedRuntime: true`, entitlements plist
- CI secrets: `.p12` + password, Apple API key (or Apple ID + app-specific
  password), team ID
- Build time grows by notarization latency, 5–15 minutes

Note the trap visible in `xyne-spaces`: `hardenedRuntime: true` with
`notarize: false` buys nothing for Gatekeeper. The two go together.

### What changes for users

**Nothing breaks.** Existing users download the signed build exactly as they
have been downloading every other update — it simply installs cleanly this time,
with no "damaged" dialog and no Terminal.

That clean transition is *precisely because there is no auto-update chain to
break*. Deferring signing costs nothing at the switchover, which is what makes
this sequencing safe.

---

## 4. The bundle channel (deferred)

Splitting the renderer into a separately-updatable bundle — downloaded in the
background, applied on window blur — the way `xyne-spaces` built (but does not
currently run) against Juspay's Airborne service.

### What it would take

**~1 week**, and additive rather than a restructure, because the seam already
exists: §5 puts the renderer behind a `MessagePort` holding no authoritative
state, and §11.2 makes it invalidate-and-refetch. That is exactly the boundary
this needs.

| Piece | Effort |
|---|---|
| CI: publish signed manifest + zip to R2/CDN | ~1 day |
| Shell: fetch, verify, download, stage, blur-apply | ~2–3 days |
| Crash-loop rollback | ~1 day (*testing* it is the hard part) |
| `minShell` gate, staged rollout % | a few hours |

**The renderer code itself does not change.** Only packaging and the shell.

### Non-negotiable if it is built: verify the bundle

This is a remote code execution channel into the app — it routes around
Gatekeeper and SmartScreen by design, since the OS never inspects a downloaded
bundle.

A `sha256` from the same server being trusted is worthless if that server is
what is compromised. Sign manifests with a key we control: **Ed25519, private
key in CI secrets, public key hardcoded in the shell.** Six lines each side with
Node's built-in `crypto`, no dependencies.

`xyne-spaces` declares a `checksum` field in its release config and never checks
it. Do not copy that.

### What releases look like with two channels

Two artifacts, two version numbers: a shell version (the installer) and a bundle
version (the UI zip).

| Type | Example | Ships as | Latency |
|---|---|---|---|
| **A — UI only** | Layout, styling, copy, a new view over existing data | Bundle only | Minutes |
| **B — Shell only** | Electron bump, sync engine fix, native dep | Installer | Nag → reinstall |
| **C — Spans both** | New table + new UI | Installer, **then** bundle | Two-phase, with an adoption wait |

Type C is the tax: ship shell vN+1 with the migration and protocol support, wait
for adoption, then ship the bundle gated `minShell: N+1`.

**The boot rule that is easy to get wrong.** Every installer also contains a
built-in bundle, so startup must be:

```
candidates = [built-in bundle] + [downloaded bundles]
eligible   = candidates where minShell <= currentShellVersion
load         max(eligible, by version)
```

`max()` matters — after a shell update the built-in bundle may be **newer** than
one downloaded earlier. "Downloaded if present" rolls the UI backwards.

### When it becomes worth building

**The bundle channel's value is inversely proportional to how fast the schema is
changing.**

The sync engine and schema live in the shell. Early on those change constantly,
so most releases are shell releases regardless and the bundle channel sits idle
while costing complexity and a security surface. Once the data model settles and
iteration is on polish — layout, interaction, copy, new views over existing data
— it earns its keep.

**Trigger: build it when the schema stops changing weekly.** It costs the same
week whenever it is built, so building it early buys nothing.

Note also that Chromium security patches only ship through the shell, so shell
updates will be regular no matter what. The bundle channel is a fast lane
*between* them, not an escape from them.

---

## 5. Forward compatibility: two boundaries, two timelines

Easy to conflate, and they are not on the same schedule.

| Boundary | Skew possible today? | Why |
|---|---|---|
| **Client ↔ server** (protocol) | **Yes, immediately** | Updates cannot be forced; a client from three months ago talks to today's server |
| **Renderer ↔ shell** (IPC) | **No** | They ship in the same installer and update atomically — skew only becomes possible after §4 |

### Protocol — load-bearing now

Rules and rationale in §9.10. Summarised: an unknown event type must still
advance the cursor; unknown fields are ignored, never rejected; `hello` carries
a protocol version and the server can demand an upgrade.

These cannot be retrofitted — the clients that would need the fix are the old
ones already in the field.

### IPC — a convention, adopted early because it is free

Today the renderer and shell always ship together, so **this buys nothing yet.**
It is adopted now only because it costs nothing and makes §4 cheap later.

**One row shape per table, not per query.** Define the shape once, next to the
schema, in `packages/protocol`; IPC handlers return it wholesale rather than
hand-picking columns per call site. Adding a column then touches one definition
instead of every read path.

```ts
// ── narrow: every schema change forces a shell release ──
db.prepare(`SELECT id, ord, body FROM messages WHERE ...`)

// ── wide: one definition, columns flow through ──
db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ...`)
```

Not a blanket `SELECT *` — that loses index-only scans and inflates every
structured-clone payload. The discipline is *one definition*, not *no column
list*.

**Reads and writes want opposite behaviour.** Getting this backwards converts a
loud failure into silent data loss:

| Direction | Rule | Why |
|---|---|---|
| Shell → renderer (reads) | **Permissive** — ignore unknown fields | An older bundle must tolerate a newer shell's extra columns |
| Renderer → shell (writes) | **Strict** — reject what cannot be honoured | A newer bundle sending `{ body, pinned: true }` to an older shell that silently drops `pinned` produces a message the user believes is pinned and is not |

**Capability handshake over version arithmetic.** The shell declares what it can
do at attach time; the UI asks "can this shell do X?" rather than comparing
version numbers in a dozen places:

```ts
port.postMessage({ type: 'hello', shellVersion: '1.5.0',
                   capabilities: ['threads', 'reactions', 'attachments'] })
```

Adding a feature adds one string. Same reasoning as feature detection over
browser sniffing.

---

## 6. Requirements for the current model

Five things that must be true for bundled-UI-plus-nag to work correctly.

**1. Migrations run at boot, from the first release.**
Reinstalling replaces the app bundle but leaves `userData` untouched, so the
database, blobs and session survive — which is what makes reinstalls painless.
It also means **new code always meets an old database**, and a user who skips
three releases jumps several schema versions at once. The forward-only
`user_version` runner (§13.5) must exist before the first external build, not
before the first schema change.

The local database is a replica, so wipe-and-resync is always a legitimate
escape hatch. That option does not exist server-side.

**2. `appId` and the userData directory name are permanent.**
`userData` is derived from them. Change either and every existing user's
database is orphaned: the app looks freshly installed and all local history is
gone. Recoverable, since it is a replica, but indistinguishable from data loss
to the user. Pick them once.

Use a `-dev` suffix for development builds so they never share state with a real
install.

**3. macOS installs should quit the app first.**
macOS permits replacing a running app, but the running instance can misbehave
afterwards if it lazily loads from the bundle. Ship a `.pkg` (as `xyne-spaces`
does) or tell users to quit first.

**4. Updates cannot be forced, so build the ability to demand one.**
A user can ignore the nag indefinitely. `hello` carries a protocol version and
the server can refuse a client that is too old (§9.10). Never firing it is fine;
not having it is not.

**5. Unknown event types must advance the cursor.**
§9.10, invariant 32. This matters *more* here than under any other model,
because opt-in updates mean old clients live for a long time.

---

## 6a. The app icon

Built, ahead of any packaging config that consumes it.
`apps/desktop/resources/` holds `icon.icns` (macOS), `icon.ico` (Windows), a
PNG set from 16 to 1024, and an SVG master, all generated by
`tools/make-app-icon.mjs` from one path definition.

**Zero npm dependencies, deliberately.** The brand colours are not settled, so
the generator has to stay runnable on any checkout without an install step —
PNGs are encoded with `node:zlib`, the `.ico` container is assembled by hand,
and only `.icns` needs a platform tool (`iconutil`, macOS-only; every other
output still builds elsewhere). Re-run it with different colours rather than
hand-editing a binary:

```bash
node tools/make-app-icon.mjs --bg '#1D3FE0' --fg '#FFFFFF'
```

The SVG and the rasters come from the same source path, so they cannot drift.

**Not yet wired to anything** — there is no electron-builder config, because
§7's "Now" row has not been built. When it is, these are the files it points at,
and the icon stops being the thing that blocks a first build.

---

## 7. Sequencing

| Stage | Trigger | What lands |
|---|---|---|
| **Now** | — | Bundled UI, nag, migrations at boot, protocol version in `hello`, fixed `appId`. Start Apple Developer enrolment. Icon assets exist (§6a); the builder config that consumes them does not. |
| **Sign macOS** | "Damaged" dialogs cost more than a day of setup — likely soon, given the per-release tax | Developer ID, notarization in CI |
| **Sign Windows** | Meaningful Windows user base | Azure Trusted Signing |
| **Auto-update** | **After** signing, never before | electron-updater; one manual reinstall moves users onto the track |
| **Bundle channel** | Schema stops changing weekly | §4 — one week of work |
