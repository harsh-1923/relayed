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
import { emit } from '@relayed/telemetry';
import type { Storage } from './storage.ts';

/** An avatar that will not fit in a cache line is not an avatar. */
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

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

  for (const w of storage.workspaces()) {
    const wanted = [
      { which: 'actor' as const,     url: w.actorAvatarUrl,     held: w.actorAvatarBlob },
      { which: 'workspace' as const, url: w.workspaceAvatarUrl, held: w.workspaceAvatarBlob },
    ];
    for (const { which, url, held } of wanted) {
      // Already held. A blob is cleared only when its source URL changes (see
      // syncMemberships), so this is the steady state after the first run.
      if (!url || (held && storage.hasBlob(held))) continue;
      try {
        const id = await fetchBlob(storage, url);
        if (!id) continue;
        storage.setAvatarBlob(w.workspaceId, which, id);
        stored += 1;
      } catch {
        // Offline, 404, a CDN hiccup — all the same to us, and all recoverable
        // on the next pass.
      }
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
  if (parsed.protocol !== 'https:') return null;

  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;

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
