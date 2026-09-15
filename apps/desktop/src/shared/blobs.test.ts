import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageMediaTypeFromBlobUrl, localBlobUrl, type ImageMediaType } from './blobs.ts';

test('typed local blob URLs round-trip every supported image media type', () => {
  const id = 'a'.repeat(64);
  const mediaTypes: ImageMediaType[] = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml',
  ];

  for (const mediaType of mediaTypes) {
    const url = new URL(localBlobUrl(id, mediaType));
    assert.equal(url.hostname, id);
    assert.equal(imageMediaTypeFromBlobUrl(url), mediaType);
  }
  assert.equal(imageMediaTypeFromBlobUrl(new URL(localBlobUrl(id))), null);
  assert.equal(imageMediaTypeFromBlobUrl(new URL(`relayed-blob://${id}/not-an-image.svg`)), null);
});
