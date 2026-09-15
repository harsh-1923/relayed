import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cacheToolkitLogos, heldToolkitLogos } from './blobs.ts';
import { Storage } from './storage.ts';

const toolkit = (logoUrl: string | null, slug = 'github') => ({ slug, logoUrl });

function accountStorage(): Storage {
  const storage = new Storage(mkdtempSync(join(tmpdir(), 'relayed-toolkit-logo-')));
  const accountId = storage.createAccount('dev_logo');
  storage.openAccount(accountId);
  return storage;
}

test('toolkit logos are content-addressed and a second pass stays local', async () => {
  const storage = accountStorage();
  const logoUrl = 'https://logos.composio.dev/api/github';
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>');
  const expectedId = createHash('sha256').update(bytes).digest('hex');
  let requests = 0;
  const request = (async () => {
    requests += 1;
    return new Response(bytes, { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } });
  }) as typeof fetch;

  assert.deepEqual(heldToolkitLogos(storage, [toolkit(logoUrl)]), [], 'nothing held before a download');
  assert.equal(await cacheToolkitLogos(storage, [toolkit(logoUrl)], request), 1);
  assert.deepEqual(heldToolkitLogos(storage, [toolkit(logoUrl)]), [
    { slug: 'github', logoBlob: expectedId, logoMediaType: 'image/svg+xml' },
  ]);
  assert.equal(requests, 1);
  assert.ok(storage.hasBlob(expectedId));

  assert.equal(await cacheToolkitLogos(storage, [toolkit(logoUrl)], request), 0, 'nothing new to store');
  assert.equal(requests, 1, 'the catalogue may reopen without another network fetch');
});

test('a broken reported URL falls back to Composio and aliases the successful bytes', async () => {
  const storage = accountStorage();
  const reportedUrl = 'https://example.test/broken.svg';
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const requested: string[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    return url === reportedUrl
      ? new Response(null, { status: 404 })
      : new Response(bytes, { headers: { 'content-type': 'image/svg+xml' } });
  }) as typeof fetch;

  await cacheToolkitLogos(storage, [toolkit(reportedUrl)], request);
  assert.ok(heldToolkitLogos(storage, [toolkit(reportedUrl)])[0]?.logoBlob);
  assert.deepEqual(requested, [reportedUrl, 'https://logos.composio.dev/api/github']);

  requested.length = 0;
  await cacheToolkitLogos(storage, [toolkit(reportedUrl)], request);
  assert.deepEqual(requested, [], 'the broken URL now resolves through its local alias');
});

test('a logo that fails costs only itself: the others are stored and nothing throws', async () => {
  const storage = accountStorage();
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const request = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('linear')) throw new Error('network down');
    return new Response(bytes, { headers: { 'content-type': 'image/svg+xml' } });
  }) as typeof fetch;

  const stored = await cacheToolkitLogos(storage, [toolkit(null, 'linear'), toolkit(null, 'github')], request);
  assert.equal(stored, 1);
  assert.deepEqual(heldToolkitLogos(storage, [toolkit(null, 'linear'), toolkit(null, 'github')]).map(logo => logo.slug), ['github']);
});

test('an unreadable logo cache is initials, not a failed catalogue', async () => {
  // The case that hid the whole store: account.db without `cached_assets`.
  const storage = accountStorage();
  storage.account.exec('DROP TABLE cached_assets');
  assert.deepEqual(heldToolkitLogos(storage, [toolkit(null)]), []);
  const request = (async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })) as typeof fetch;
  assert.equal(await cacheToolkitLogos(storage, [toolkit(null)], request), 0);
});
