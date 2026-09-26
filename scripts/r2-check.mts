// Prove the production object store does what docs/FILES.md §4 relies on,
// using the server's own signer: a presigned PUT bound to a SHA-256 accepts
// exactly those bytes and refuses any others, a presigned GET reads them back,
// and delete removes them. Leaves nothing behind.
//
//   node --env-file=.env --env-file=.env.r2 scripts/r2-check.mts
//
// `.env.r2` holds the S3_* variables for R2 (gitignored by `.env.*`) and wins
// over `.env`, which supplies the rest of what the server config requires.
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../apps/server/src/env.ts';
import { presign, objectKey, readObject, deleteObject } from '../apps/server/src/files/store.ts';

const store = env.objectStore;
if (!store) throw new Error('S3_* variables are not set');
console.log(`store: ${new URL(store.endpoint).host} / ${store.bucket} (region ${store.region})`);

const bytes = randomBytes(256);
const sha = createHash('sha256').update(bytes).digest('hex');
const key = objectKey(sha);
const headers = { 'content-type': 'image/png', 'x-amz-checksum-sha256': Buffer.from(sha, 'hex').toString('base64') };
const url = presign(store, 'PUT', key, { headers, expiresSec: 300 });

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); };

// Different bytes under the same signed checksum: must be refused.
const wrong = await fetch(url, { method: 'PUT', headers, body: randomBytes(256) });
check('PUT of other bytes is refused', !wrong.ok, `HTTP ${wrong.status}`);
check('  …and nothing was stored', (await readObject(store, key)) === null);

// The declared bytes: accepted.
const right = await fetch(url, { method: 'PUT', headers, body: bytes });
check('PUT of the declared bytes is accepted', right.ok, `HTTP ${right.status} ${right.ok ? '' : await right.text()}`);

// Without the signed checksum header: the signature must not match.
const bare = await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
check('PUT without the checksum header is refused', !bare.ok, `HTTP ${bare.status}`);

const back = await readObject(store, key);
check('server read-back matches', back !== null && back.equals(bytes));

const get = await fetch(presign(store, 'GET', key, { expiresSec: 60, query: { 'response-content-type': 'image/png' } }));
check('presigned GET serves it', get.ok && Buffer.from(await get.arrayBuffer()).equals(bytes), `HTTP ${get.status}`);
check('  …with the asked content-type', get.headers.get('content-type') === 'image/png', String(get.headers.get('content-type')));

check('bucket is private (unsigned GET refused)', !(await fetch(`${store.endpoint}/${store.bucket}/${key}`)).ok);

await deleteObject(store, key);
check('delete removes it', (await readObject(store, key)) === null);

for (const [name, ok, detail] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
process.exit(results.every(r => r[1]) ? 0 : 1);
