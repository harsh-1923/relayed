# Files: logos, attachments, and everything else with bytes

> **Status: phase 1 (§11) built locally, uncommitted (2026-09-26); phases 2–4
> are a proposal.** §13 records the build. It gives the server its
> first object storage and one upload path that every kind of file uses —
> organization and workspace logos first, message attachments next. It extends
> [`DESIGN.md`](DESIGN.md) §13.3 (the client's blob store, which exists) with the
> server half it never had, and settles [`STORAGE.md`](STORAGE.md) §14.1's
> "setting an image is deliberately unbuilt".
>
> **The recommendation in one line:** one content-checked `files` table and one
> presigned-upload flow for all bytes; permission lives on whatever REFERENCES a
> file, never on the file; logos are the first reference.

**Last updated:** 2026-09-26

---

## 0. Words used here

| Word | Meaning here |
|---|---|
| **File** | Bytes we hold, uploaded once, never changed. A row in `files` and an object in the bucket. |
| **Reference** | Something that points at a file: an org's logo, a workspace's logo, later a message part. Decides who may read it. |
| **Purpose** | What a file was uploaded FOR — `logo` or `attachment`. Fixes its limits (§4) and its read rule (§6). |
| **Blob** | The client's copy, in the content-addressed store §13.3 already built. |
| **Object store** | S3-compatible: MinIO locally, R2 in production (`STACK.md`). |

---

## 1. What this doc decides

| Question | Decision | § |
|---|---|---|
| One table for logos and attachments? | **One `files` table**, and each owner references it its own way. Not an "attachments" table. | 2 |
| Where do bytes go? | The object store, keyed by sha256. Postgres holds metadata only. | 3 |
| How do bytes get there? | **Presigned PUT straight to the store**, bound to the declared hash and size; the server then verifies. | 4 |
| Who checks the content? | **The server**, after upload: magic bytes, dimensions, size. The client's word is a claim. | 4.3 |
| Who may read a file? | **Whoever may read something that references it.** A file has no permission of its own. | 6 |
| Are logos private? | **No — readable by id without a session**, like every chat product's workspace icon. Attachments are. | 6.1 |
| How does a new logo reach other people? | The membership wire, which already carries the image; the setter refreshes at once. | 7 |
| Offline? | Logos: online-only, an admin act. Attachments: DESIGN §13.3's two-phase outbox. | 8 |
| What happens to a replaced logo? | Unreferenced files are swept after a grace period. | 9 |
| SVG logos? | **No.** Raster only; the client re-encodes to PNG. | 4.2 |

---

## 2. One store, many references

Everything with bytes shares the same hard problems — getting large bodies to
storage without the API server in the path, proving the bytes are what the
client said, deduplicating, caching on the device. None of that depends on
whether the bytes are a logo or a PDF in a thread.

What *does* differ is decided by the owner, not the bytes:

| | Logo | Message attachment |
|---|---|---|
| Who reads it | Anyone who can see the org — including someone deciding whether to join | Exactly the audience of its message, restricted messages included |
| Lifecycle | Replaced; the old one is garbage | Lives and dies with its message (edit, delete, retention) |
| Offline | Online-only is fine — an admin setting | Must work offline (§13.3's two-phase outbox) |
| Size | Tiny | Up to large |

So `files` knows bytes, and references know people. A file never carries a
permission; asking "may I read file X" is always answered by "may I read
something that points at X". That keeps one rule of `AUTHZ.md` intact: a
permission lives with the object people reason about.

---

## 3. The table

```sql
CREATE TABLE files (
  id             TEXT PRIMARY KEY,          -- fil_…, ours
  sha256         TEXT NOT NULL,             -- hex; also the object key
  size           BIGINT NOT NULL,
  media_type     TEXT NOT NULL,             -- as SNIFFED, never as declared
  width          INTEGER,                   -- images
  height         INTEGER,
  purpose        TEXT NOT NULL,             -- 'logo' | 'attachment'
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by    TEXT REFERENCES actors(id) ON DELETE SET NULL,
  state          TEXT NOT NULL,             -- 'pending' | 'ready'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Bytes are deduplicated; rows are not.** The object key is the sha256, so the
same picture uploaded by two orgs is stored once. But each upload gets its own
row, scoped to its org, and the "already have it" shortcut (§4.1) answers only
within the uploader's org. A global answer would let anyone test whether some
other tenant holds a given document by asking about its hash.

**`org_id` is on every file**, including attachments. Tenancy is the one scope
every reference shares, and it is what lets an org's deletion — or a claim
(`ORG-DOMAINS.md` §11.3) — find its files. Claims move it like any other
`org_id`; the foreign-key test there covers this table automatically.

---

## 4. Uploading

### 4.1 The flow

```
Desktop (sync process)                 Server                          Object store
 hash the bytes (sha256), sniff type
 POST /files {purpose, sha256, size, media_type} ──► validate against §4.2
                                        insert files (pending)
   ◄── {file_id, upload: {url, headers}} or {file_id, ready} if this org has it
 PUT url (bytes, checksum header) ─────────────────────────────────────► stores
 POST /files/:id/complete ────────────► fetch & verify (§4.3), mark ready
   ◄── {file_id, url}
```

The API server never carries the body on the way in. That matters little for a
logo and a great deal for a 200 MB video, and building the logo path this way
means attachments reuse it rather than replace it.

The PUT is **presigned and bound**: its signature covers the
`x-amz-checksum-sha256` header, which pins the exact bytes and therefore their
size, so the store itself refuses anything else. Verified against MinIO and R2
(`scripts/r2-check.mts`, §10): other bytes are refused with 400, a PUT without
the header with 403. The server's own read-back (§4.3) is the backstop either way.

### 4.2 Limits by purpose

| Purpose | Types | Max size | Max dimensions |
|---|---|---|---|
| `logo` | PNG, JPEG, WebP | 1 MB | 1024 × 1024 |
| `attachment` | anything; images get thumbnails (phase 2) | 100 MB, multipart above 16 MB | — |

**No SVG logos.** An SVG is a document that can carry script; the renderer only
ever shows images through `<img>`, which disables that, but a file we serve to
anyone holding its id should not depend on every future viewer doing the same.
The client re-encodes whatever the person picks — SVG included — to a 512 px PNG
on a canvas, which also strips EXIF.

### 4.3 What the server verifies

On `complete`, before a file becomes `ready`:

- **size and hash** — for files up to 16 MB, the server reads the object back
  and hashes it; above that, the store's checksum on the PUT is the proof
- **type by magic bytes** — PNG, JPEG, WebP, GIF, PDF and so on, recognised from
  the first bytes. The declared type is only a hint; a mismatch is refused
- **dimensions** for images, read from the header, against §4.2

A file that fails is deleted from the store and its row removed. A `pending` row
older than a day is swept (§9).

---

## 5. References

| Reference | Column | Built |
|---|---|---|
| An organization's logo | `organizations.logo_file_id` | phase 1 |
| A workspace's logo | `workspaces.logo_file_id` | phase 1 |
| A message attachment | a `file` part in `message_parts` (`AGENT-RESPONSES.md`) naming a file id, a display name and, for images, a thumbnail file | phase 2 |
| A person's picture | `actors.avatar_file_id`, overriding the WorkOS picture | later |

A reference must name a file of the **same org** and the **right purpose** — a
database check through the setter, so an attachment can never be promoted into a
publicly readable logo by pointing a logo at it.

The existing `avatar_url` columns stay: they are how the WorkOS-sourced and any
future pasted-URL images arrive. What the client sees resolves in one place,
`resolveMemberships`: workspace logo, else org logo, else the old URL columns.

---

## 6. Reading

`GET /files/:id` answers with a short-lived presigned GET (a redirect), after
the reference rule for the file's purpose says yes.

### 6.1 Logos are public by id

A logo is shown before membership exists — on the "Your team is on Relayed"
screen, to a person who has no session of ours yet — and in every chat product
workspace icons are served from public URLs. So a `logo` file is readable by
anyone holding its id, and ids are unguessable (`fil_` + 80 random bits).

That is a property of the PURPOSE, set at upload and never changed, and §5's
check stops an attachment being re-pointed as a logo. Nothing else is public.

### 6.2 Attachments are not

An `attachment` file needs a session, and the caller must be able to read a
message that references it — the same access predicate the chat itself uses
(`DESIGN.md` §7.3), restricted messages included. Phase 2.

### 6.3 On the device

Nothing new. The membership wire carries the image URL, `prefetchAvatars`
downloads it into the content-addressed store, and the renderer draws it through
`relayed-blob:` — exactly how WorkOS avatars already arrive (§13.3). Following
the redirect is ordinary `fetch`.

---

## 7. How a change reaches everyone

A logo rides on the membership wire as `workspace_avatar_url`, which every client
re-reads on refresh — at most one access-token lifetime (15 minutes) behind. The
person who set it refreshes at once and sees it immediately.

Fifteen minutes is fine for a logo. If it ever is not, a `workspace.updated`
event on the workspace's directory stream is the push path; nothing here
precludes it.

---

## 8. Offline

**Logos are online-only.** Setting one is an admin act on a settings page, and
the page says so rather than queueing. The previous logo keeps showing offline,
because it is already a pinned local blob.

**Attachments are not**, and DESIGN §13.3 already specifies how: copy into the
blob store at once under the content hash, and let the outbox run the upload
(`POST /files` → PUT → complete) before the `send` that references it. The flow
in §4.1 is exactly that `blob_upload` step.

---

## 9. Lifecycle

- **Unreferenced files are swept** after 7 days — a replaced logo, an attachment
  whose message was deleted. The grace period covers a client that uploaded and
  has not yet sent. "Referenced" is computed over every column in §5; a test
  enumerates them so a new reference cannot be forgotten, as `ORG-DOMAINS.md`
  §11.3 does for `org_id`.
- **Pending files** older than a day are swept with their objects.
- **An object is deleted only when no row of any org holds its hash** — bytes are
  shared (§3).

Phase 1 ships the reference columns and leaves the sweep for phase 2, when
deletions start producing garbage at a rate worth collecting.

---

## 10. Production

Bucket `relayed-files` on R2 (account `97029fbb…`, location APAC, beside the
Railway region), **private** — logos are read through `GET /files/:id`'s
presigned redirect, never a public URL. No CORS: the desktop uploads and reads
from its sync process, not a browser. The server needs the five `S3_*`
variables on `relayed-server`:

| Variable | Value |
|---|---|
| `S3_ENDPOINT` | `https://<account id>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_BUCKET` | `relayed-files` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | an R2 API token, Object Read & Write, scoped to this bucket |

`scripts/r2-check.mts` proves a store honours §4 before it is trusted — the
checksum-bound PUT refuses other bytes, the GET reads back, the bucket is
private. Until the variables are set, upload endpoints answer
`503 storage_unconfigured` and everything else works.

---

## 11. Phases

1. **Files and logos.** `files`, the upload flow, verification, `GET /files/:id`
   for logos; `logo_file_id` on organizations and workspaces; set and clear, by
   org admins (org) and workspace admins (workspace); the org page's logo
   picker; logos in the switcher, the org page and onboarding.
2. **Message attachments.** The `file` part, the offline two-phase upload,
   thumbnails, the attachment read rule, the sweep.
3. **Large and resumable.** Multipart above 16 MB, resumed from the last part.
4. **People's pictures**, if WorkOS's are not enough.

---

## 12. Open questions

1. **Who may set a workspace's logo** — its admins, or only the org's? Proposed:
   its admins; the org logo is the org admins'.
2. **Should a workspace logo default to the org's?** Proposed: yes, and it does
   today — a workspace without its own shows its org's.
3. **Pasted URL instead of upload?** Proposed: no — it puts a third party's
   availability and tracking into every client's render path.

---

## 13. As built (phase 1)

- **Migration** `035_files.sql`: `files`, and `logo_file_id` on `organizations`
  and `workspaces`. Checked against a copy of the dev database first.
- **Server**: `apps/server/src/files/` — `store.ts` presigns SigV4 URLs with no
  SDK; `sniff.ts` reads type and dimensions from magic bytes (PNG, JPEG, GIF,
  WebP, PDF); `routes.ts` has `POST /files`, `POST /files/:id/complete`,
  `GET /files/:id` (logos only, public by id), `PUT /org/:id/logo` and
  `PUT /workspaces/:id/logo`. Verified against MinIO: the store refuses bytes
  whose checksum differs from the declared one (`XAmzContentChecksumMismatch`).
- **Who may**: uploading a logo is limited to those who can set one — org admins
  (`organization:edit`) and workspace admins (`workspace:edit`) — so a logo's
  public URL is not free hosting for every member. `workspace:edit` was added to
  `AUTHZ.md` §6 and the model spike alongside the shipped vocabulary.
- **The wire**: `workspace_avatar_url` resolves workspace logo → org logo → the
  old URL columns, as a server-relative `/files/fil_…`. The desktop resolves it
  against the server it talks to, and fetches plain http only from loopback.
- **Desktop**: `logo.set` in the sync process uploads, points, and refreshes;
  the renderer re-encodes the pick to a 512 px PNG (`lib/logo.ts`); the org page
  has the org's logo and a logo control per workspace, for org admins.
- **Tests**: `files/routes.test.ts` against real MinIO — the handshake, public
  read, dedup within an org, refusals before a URL is issued, bytes that lie
  about their type, inheritance and override, cross-org references refused.

Not yet: a workspace admin who is not an org admin has the API but no screen
(the workspace settings page is the place); the org logo is not drawn on its
own anywhere a workspace has its own logo; production needs its R2 bucket (§10).

