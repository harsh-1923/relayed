// Serving local blobs to the renderer (DESIGN.md §13.3).
//
// §13.3 says `protocol.handle('blob', ...)`. That name cannot be used: `blob:`
// is a reserved scheme in Chromium — it is how URL.createObjectURL works, and
// our own CSP already lists it for that purpose. Registering a custom handler
// under it would collide. Hence `relayed-blob:`.
//
// The point of a custom scheme rather than file:// is that `webSecurity` stays
// on and no absolute filesystem path ever reaches the DOM.
import { app, net, protocol } from 'electron';
import { emit, count } from '@relayed/telemetry';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { imageMediaTypeFromBlobUrl } from '../shared/blobs.ts';

export const BLOB_SCHEME = 'relayed-blob';

/** Ids are sha256 hex, and nothing else. This is what makes traversal impossible. */
const ID = /^[0-9a-f]{64}$/;

/**
 * Which account's blobs may be served. Pushed from the sync process, which owns
 * storage; main never derives it. Resolution is scoped to exactly this account,
 * so a renderer holding an id from a signed-out account gets nothing
 * (invariant 45).
 */
let activeAccount: string | null = null;
export const setBlobAccount = (accountId: string | null): void => { activeAccount = accountId; };

/** MUST run before app.whenReady() — Electron ignores it afterwards. */
export function registerBlobScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: BLOB_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
  }]);
}

export function handleBlobProtocol(): void {
  protocol.handle(BLOB_SCHEME, (request) => {
    const url = new URL(request.url);
    const id = url.hostname;
    // `rejected` MUST stay 0. Anything else means an id reached the handler
    // that was not a sha256 — invariant 45 firing.
    if (!ID.test(id) || !activeAccount) {
      count('blob.serve', { serve: 'rejected' });
      emit('blob.served', { blob: id.slice(0, 16), result: 'rejected' });
      return new Response(null, { status: 404 });
    }

    const file = join(app.getPath('userData'), 'accounts', activeAccount,
                      'blobs', id.slice(0, 2), id);
    // A miss is a grey circle somebody actually saw — the prefetch either has
    // not run yet or failed, and neither is visible from the prefetch side.
    if (!existsSync(file)) {
      count('blob.serve', { serve: 'miss' });
      emit('blob.served', { blob: id, result: 'miss' });
      return new Response(null, { status: 404 });
    }
    const mediaType = imageMediaTypeFromBlobUrl(url);
    const typedPathRequested = url.pathname !== '' && url.pathname !== '/';
    if (typedPathRequested && !mediaType) {
      count('blob.serve', { serve: 'rejected' });
      emit('blob.served', { blob: id, result: 'rejected' });
      return new Response(null, { status: 404 });
    }
    count('blob.serve', { serve: 'hit' });
    if (mediaType) {
      // Content-addressed files have no extension. A closed typed route gives
      // Chromium the MIME type it needs, particularly for Composio's SVG-only
      // logo CDN. These bytes are consumed by <img>, whose secure static SVG
      // mode disables script and external resources. Electron leaves the
      // protocol request's `destination` empty even for <img>, so the response
      // also carries a sandboxed, deny-by-default CSP to make direct navigation
      // inert rather than relying on a destination value that is not present.
      return new Response(new Uint8Array(readFileSync(file)), {
        headers: {
          'Content-Type': mediaType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    // §13.3's resolution order is local → remote → placeholder. Only the local
    // leg exists here, deliberately: reaching out to the network from the
    // handler would put a fetch in the render path, which is the failure the
    // prefetch exists to avoid.
    return net.fetch(pathToFileURL(file).toString());
  });
}
