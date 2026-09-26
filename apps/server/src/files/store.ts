// The object store (docs/FILES.md): presigned URLs, and nothing else.
//
// AWS Signature V4 in query-string form, which every S3-compatible store we
// target speaks — MinIO locally, R2 in production. Hand-written rather than an
// SDK because presigning is the ONLY operation we need: the desktop PUTs
// straight to the store, and the server reads back through the same kind of
// URL. A few dozen lines of HMAC are cheaper to own than a client library
// whose surface we would use one function of.
import { createHash, createHmac } from 'node:crypto';
import { env } from '../env.ts';

export type Store = NonNullable<typeof env.objectStore>;
export type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE';

/** RFC 3986, which is stricter than encodeURIComponent about `!'()*`. */
const uri = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const hex = (data: string) => createHash('sha256').update(data).digest('hex');

/** Where `bytes/<sha256>` lives. Bytes are keyed by content, shared across orgs (§3). */
export const objectKey = (sha256: string) => `bytes/${sha256}`;

/**
 * A URL that performs `method` on `key` without credentials, until it expires.
 *
 * `headers` are SIGNED: the request must carry exactly these. That is how a PUT
 * is bound to the size and checksum the client declared — the store itself
 * refuses any other bytes (FILES.md §4.1).
 */
export function presign(
  store: Store, method: Method, key: string,
  opts: { expiresSec?: number; headers?: Record<string, string>; query?: Record<string, string>; now?: Date } = {},
): string {
  const endpoint = new URL(store.endpoint);
  const host = store.forcePathStyle ? endpoint.host : `${store.bucket}.${endpoint.host}`;
  const path = (store.forcePathStyle ? `/${store.bucket}/${key}` : `/${key}`)
    .split('/').map(uri).join('/');

  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');   // 20260926T101500Z
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${store.region}/s3/aws4_request`;

  const headers: Record<string, string> = { host };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');

  const query: Record<string, string> = {
    ...opts.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${store.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(opts.expiresSec ?? 900),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${uri(k)}=${uri(query[k]!)}`).join('&');

  const canonicalRequest = [
    method, path, canonicalQuery,
    names.map(n => `${n}:${headers[n]}\n`).join(''),
    signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonicalRequest)].join('\n');
  const key_ = hmac(hmac(hmac(hmac(`AWS4${store.secretAccessKey}`, day), store.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key_).update(toSign).digest('hex');

  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Read an object back in full. Only for sizes the server verifies itself (§4.3). */
export async function readObject(store: Store, key: string): Promise<Buffer | null> {
  const res = await fetch(presign(store, 'GET', key, { expiresSec: 60 }), { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`object store GET ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteObject(store: Store, key: string): Promise<void> {
  const res = await fetch(presign(store, 'DELETE', key, { expiresSec: 60 }), {
    method: 'DELETE', signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 404) throw new Error(`object store DELETE ${res.status}`);
}
