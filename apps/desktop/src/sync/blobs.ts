// Avatar prefetch (DESIGN.md §13.3).
//
// §13.3 ranks avatars first among blob classes — "all, eagerly, always" —
// because "their absence is the most visible offline failure". A perfectly
// synced workspace full of grey circles does not feel offline-capable.
//
// The renderer never sees the remote URL. It is fetched here, in the process
// that already owns the network, and served back over a custom scheme so that
// `webSecurity` stays on and no filesystem path reaches the DOM.
import { createHash } from 'node:crypto';
import { emit, count } from '@relayed/telemetry';
import type { ToolkitSummary } from './auth/relayed.ts';
import type { CachedImageMediaType, Storage } from './storage.ts';
import { serverUrl } from './config.ts';

/**
 * An image URL as the server sent it, made absolute. Uploaded logos arrive
 * RELATIVE — `/files/fil_…` — because only the client knows which origin it
 * reached the server at (FILES.md §6.3).
 */
export const absoluteImageUrl = (url: string): string =>
  url.startsWith('/') ? `${serverUrl().replace(/\/+$/, '')}${url}` : url;

/**
 * A logo as an inline `data:` image, for surfaces that show workspaces the
 * person is NOT in yet — the join list during onboarding, before any account
 * exists to hold blobs (FILES.md §6.3). Never stored; cached for the life of
 * the process, since a logo's URL names immutable bytes. Null when it cannot be
 * fetched, which the renderer draws as initials.
 */
const inlineLogos = new Map<string, string>();
export async function logoDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  const abs = absoluteImageUrl(url);
  const held = inlineLogos.get(abs);
  if (held) return held;
  try {
    if (!fetchable(new URL(abs))) return null;
    const res = await fetch(abs, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (!res.ok || (res.url && !fetchable(new URL(res.url)))) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED.has(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    const data = `data:${type};base64,${buf.toString('base64')}`;
    inlineLogos.set(abs, data);
    return data;
  } catch { return null; }
}

/**
 * https, or plain http to THIS machine. Plaintext elsewhere would tell anyone on
 * the path which workspaces this device holds; to loopback it tells no one, and
 * it is how a development server and its MinIO are reached.
 */
function fetchable(url: URL): boolean {
  return url.protocol === 'https:'
    || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

/** An avatar that will not fit in a cache line is not an avatar. */
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const TOOLKIT_LOGO_TYPES = new Set<CachedImageMediaType>([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml',
]);
const TOOLKIT_LOGO_CONCURRENCY = 8;

/**
 * Fetch every image this account needs and record it against its workspace.
 *
 * Two subjects per row: the member's face for the identity card, and the
 * workspace's own image for the switcher rail. A workspace with no image is the
 * ordinary case — the rail derives a colour instead.
 *
 * Never throws. An image that cannot be fetched is a coloured monogram, not a
 * failed boot, and offline is the expected case rather than an error.
 */
export async function prefetchAvatars(storage: Storage): Promise<number> {
  if (!storage.accountId) return 0;
  let stored = 0;

  /**
   * Attach bytes to one row, downloading only if nobody already holds them.
   *
   * The link-first step is not just an optimisation. A URL we already hold
   * resolves OFFLINE, where a download cannot — and the commonest case in this
   * app is the same person appearing as "you" in account.db and again as a
   * directory row, which is one file either way.
   */
  const resolve = async (url: string, attach: (blobId: string) => void): Promise<void> => {
    const held = storage.blobForUrl(url);
    if (held) {
      attach(held);
      count('blob.prefetch', { kind: 'avatar', stored: 'linked' });
      stored += 1;
      return;
    }
    try {
      const id = await fetchBlob(storage, url);
      if (!id) { count('blob.prefetch', { kind: 'avatar', stored: 'skipped' }); return; }
      attach(id);
      count('blob.prefetch', { kind: 'avatar', stored: 'stored' });
      stored += 1;
    } catch {
      // Offline, 404, a CDN hiccup — all the same to us, and all recoverable
      // on the next pass. A PERSISTENT failure rate is the interesting
      // signal: that is a bad URL or a broken CDN, not a plane.
      count('blob.prefetch', { kind: 'avatar', stored: 'failed' });
    }
  };

  // ── account tier: the rail and the identity card ───────────────────────────
  for (const w of storage.workspaces()) {
    const wanted = [
      { which: 'actor' as const,     url: w.actorAvatarUrl,     held: w.actorAvatarBlob },
      { which: 'workspace' as const, url: w.workspaceAvatarUrl, held: w.workspaceAvatarBlob },
    ];
    for (const { which, url, held } of wanted) {
      // Already held. A blob is cleared only when its source URL changes (see
      // syncMemberships), so this is the steady state after the first run.
      if (!url || (held && storage.hasBlob(held))) continue;
      await resolve(absoluteImageUrl(url), id => storage.setAvatarBlob(w.workspaceId, which, id));
    }
  }

  // ── workspace tier: the directory ──────────────────────────────────────────
  // The ACTIVE workspace only, because `actors` lives in the workspace replica
  // and exactly one is open (STORAGE.md §4). Switching runs this again.
  //
  // Ordering matters and is not obvious: this needs syncActors to have run, so
  // fillActors calls back here once the directory has landed rather than the
  // two racing at boot.
  if (storage.hasWorkspace) {
    for (const a of storage.actors()) {
      if (!a.avatarUrl || (a.avatarBlob && storage.hasBlob(a.avatarBlob))) continue;
      await resolve(a.avatarUrl, id => storage.setActorAvatarBlob(a.id, id));
    }
  }

  if (stored > 0) emit('blob.prefetched', { kind: 'avatar', count: stored });
  return stored;
}

async function fetchBlob(storage: Storage, url: string): Promise<string | null> {
  // https only: an avatar URL arrives from the server, and a plaintext fetch
  // would leak which workspaces this device holds to anyone on the path.
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!fetchable(parsed)) return null;

  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  // The same rule for wherever a redirect landed — a logo is served by
  // redirecting to the object store (FILES.md §6).
  if (res.url && !fetchable(new URL(res.url))) return null;

  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED.has(type)) return null;

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;

  // Content-addressed: the same bytes are stored once however they arrive, and
  // the id is not attacker-chosen — which is what makes the scheme handler's
  // hex check sufficient to stop traversal.
  const id = createHash('sha256').update(buf).digest('hex');
  if (!storage.hasBlob(id)) storage.putBlob(id, buf);
  return id;
}

/** A toolkit's mark as this account holds it — the renderer never receives the remote URL. */
export interface ToolkitLogo {
  slug: string;
  logoBlob: string;
  logoMediaType: CachedImageMediaType;
}

/** The URLs a toolkit's mark may come from, in the order they are tried. */
function logoCandidates(slug: string, reportedUrl: string | null): string[] {
  // Composio maintains this endpoint specifically for toolkit marks. The API's
  // reported URL stays first so custom toolkit branding wins; the canonical
  // endpoint repairs catalogue rows whose historical third-party URL is dead.
  const canonicalUrl = `https://logos.composio.dev/api/${encodeURIComponent(slug)}`;
  return [...new Set([reportedUrl, canonicalUrl].filter((url): url is string => Boolean(url)))];
}

/**
 * The marks already on disk, read without touching the network. Never throws:
 * a logo is decoration, and a cache that cannot be read is initials, not a
 * catalogue that fails to load.
 */
export function heldToolkitLogos(
  storage: Storage,
  toolkits: readonly Pick<ToolkitSummary, 'slug' | 'logoUrl'>[],
): ToolkitLogo[] {
  const held: ToolkitLogo[] = [];
  for (const toolkit of toolkits) {
    try {
      for (const sourceUrl of logoCandidates(toolkit.slug, toolkit.logoUrl)) {
        const asset = storage.cachedAsset(sourceUrl, 'toolkit_logo');
        if (asset) { held.push({ slug: toolkit.slug, logoBlob: asset.blobId, logoMediaType: asset.mediaType }); break; }
      }
    } catch { /* unreadable cache: this toolkit shows initials */ }
  }
  return held;
}

/**
 * Download the marks not yet held, in the background of a catalogue read — the
 * list is already on screen, and each mark appears when it lands. Returns how
 * many were newly stored, so the caller wakes readers only when something
 * changed. Never throws, per toolkit: one bad logo costs only itself.
 */
export async function cacheToolkitLogos(
  storage: Storage,
  toolkits: readonly Pick<ToolkitSummary, 'slug' | 'logoUrl'>[],
  request: typeof fetch = fetch,
): Promise<number> {
  let stored = 0;
  for (let index = 0; index < toolkits.length; index += TOOLKIT_LOGO_CONCURRENCY) {
    const batch = toolkits.slice(index, index + TOOLKIT_LOGO_CONCURRENCY);
    const results = await Promise.all(batch.map(async toolkit => {
      try {
        return await resolveToolkitLogo(storage, toolkit.slug, toolkit.logoUrl, request);
      } catch {
        return null;
      }
    }));
    stored += results.filter(result => result?.fetched).length;
  }
  return stored;
}

async function resolveToolkitLogo(
  storage: Storage,
  slug: string,
  reportedUrl: string | null,
  request: typeof fetch,
): Promise<{ blobId: string; mediaType: CachedImageMediaType; fetched: boolean } | null> {
  for (const sourceUrl of logoCandidates(slug, reportedUrl)) {
    const held = storage.cachedAsset(sourceUrl, 'toolkit_logo');
    if (held) {
      if (reportedUrl && sourceUrl !== reportedUrl) {
        storage.linkCachedAsset(reportedUrl, 'toolkit_logo', held.blobId, held.mediaType);
      }
      return { ...held, fetched: false };
    }

    const fetched = await fetchToolkitLogo(sourceUrl, request);
    if (!fetched) continue;
    const blobId = createHash('sha256').update(fetched.bytes).digest('hex');
    storage.putCachedAsset(sourceUrl, 'toolkit_logo', blobId, fetched.mediaType, fetched.bytes);
    if (reportedUrl && sourceUrl !== reportedUrl) {
      storage.linkCachedAsset(reportedUrl, 'toolkit_logo', blobId, fetched.mediaType);
    }
    return { blobId, mediaType: fetched.mediaType, fetched: true };
  }
  return null;
}

async function fetchToolkitLogo(
  sourceUrl: string,
  request: typeof fetch,
): Promise<{ bytes: Uint8Array; mediaType: CachedImageMediaType } | null> {
  let parsed: URL;
  try { parsed = new URL(sourceUrl); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;

  try {
    const response = await request(sourceUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const mediaType = (response.headers.get('content-type') ?? '')
      .split(';')[0]!.trim().toLowerCase() as CachedImageMediaType;
    if (!TOOLKIT_LOGO_TYPES.has(mediaType)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
    if (mediaType === 'image/svg+xml') {
      const opening = new TextDecoder().decode(bytes.subarray(0, 1024));
      if (!/<svg(?:\s|>)/i.test(opening)) return null;
    }
    return { bytes, mediaType };
  } catch {
    return null;
  }
}
