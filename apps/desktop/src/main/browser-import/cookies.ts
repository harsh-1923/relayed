// Reading another browser's cookies (docs/PANELS.md, browser import). Ported
// from t3code's BrowserImport, which ships the same feature; its reasoning is
// kept beside each rule because every one of them is a bug someone hit.
//
// No Electron here, so all of it runs under `node --test`. Nothing is written
// to the source browser's files: every SQLite read is of a snapshot.
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A cookie in the shape Electron's `session.cookies.set` accepts. */
export interface ImportedCookie {
  url: string;
  name: string;
  value: string;
  /**
   * Set only for a domain cookie, which every engine marks with a leading dot.
   * Electron reads any `domain` as a domain cookie and re-adds the dot, which
   * would widen a host-only cookie to every subdomain and make it reject
   * `__Host-` cookies, which require no domain.
   */
  domain: string | undefined;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since the UNIX epoch; undefined for a session cookie. */
  expirationDate: number | undefined;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface CookieRead {
  cookies: ImportedCookie[];
  /** Rows that could not be turned into a cookie, and the sites they were for. */
  undecryptable: number;
  undecryptableHosts: string[];
}

export class CookieReadError extends Error {
  readonly reason: 'readFailed' | 'needsFullDiskAccess';
  constructor(reason: 'readFailed' | 'needsFullDiskAccess', options?: { cause?: unknown }) {
    super(`could not read cookies: ${reason}`, options);
    this.reason = reason;
  }
}

/** A host without the leading dot a domain cookie carries, for showing. */
export const bareHost = (host: string): string => (host.startsWith('.') ? host.slice(1) : host);

/** The URL and domain Electron should register a stored row under. */
export function cookieScope(host: string, path: string, secure: boolean): { url: string; domain: string | undefined } {
  const bare = bareHost(host);
  const authority = bare.includes(':') && !(bare.startsWith('[') && bare.endsWith(']')) ? `[${bare}]` : bare;
  return { url: `${secure ? 'https' : 'http'}://${authority}${path}`, domain: host.startsWith('.') ? host : undefined };
}

/**
 * Read a database from a consistent copy, never the browser's own file.
 *
 * Browsers keep these open in WAL mode while they run, so a read in place can
 * see a torn write; `VACUUM INTO` copies a transactionally consistent snapshot,
 * and reading the copy guarantees the original is never opened for writing.
 */
export function withSnapshot<T>(file: string, read: (db: DatabaseSync) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'relayed-cookie-import-'));
  try {
    const target = join(directory, basename(file));
    const source = new DatabaseSync(file, { readOnly: true });
    try { source.prepare('VACUUM INTO ?').run(target); } finally { source.close(); }
    const snapshot = new DatabaseSync(target, { readOnly: true });
    try { return read(snapshot); } finally { snapshot.close(); }
  } catch (error) {
    throw error instanceof CookieReadError ? error : new CookieReadError('readFailed', { cause: error });
  } finally {
    // The copy holds every session in plaintext-adjacent form; it does not outlive the read.
    rmSync(directory, { recursive: true, force: true });
  }
}

// ── Chromium ────────────────────────────────────────────────────────────────

/** macOS OSCrypt: PBKDF2-SHA1 over the Keychain secret, salt "saltysalt", 1003 rounds, 16 bytes. */
export const chromiumMacKey = (secret: string): Buffer => pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');

/** OSCrypt's CBC mode uses a fixed IV of sixteen spaces rather than one per record. */
const AES_CBC_IV = Buffer.alloc(16, 0x20);
/** Chromium stores times as microseconds from 1601-01-01. */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;

/**
 * Since schema 24 (Chromium 127) the plaintext starts with SHA-256 of the host
 * key, binding the value to its domain. A value whose prefix does not match was
 * not written for this host, and is refused rather than imported.
 */
function stripDomainBinding(plaintext: Buffer, host: string, schemaVersion: number): Buffer | null {
  if (schemaVersion < 24) return plaintext;
  const hash = createHash('sha256').update(host).digest();
  return plaintext.length >= 32 && plaintext.subarray(0, 32).equals(hash) ? plaintext.subarray(32) : null;
}

/**
 * One stored value, on macOS. `v10` is AES-128-CBC under the Keychain key. A
 * value with no recognised prefix is legacy data stored in the clear, which
 * Chromium on macOS returns as-is.
 */
export function decryptChromiumValue(encrypted: Uint8Array, key: Buffer, host: string, schemaVersion: number): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return '';
  const prefix = buffer.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return stripDomainBinding(buffer, host, schemaVersion)?.toString('utf8') ?? null;
  if (prefix === 'v11') return null; // a Linux keyring record; no key for it on macOS
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, AES_CBC_IV);
    const plaintext = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
    return stripDomainBinding(plaintext, host, schemaVersion)?.toString('utf8') ?? null;
  } catch {
    return null;
  }
}

/** Chromium's SameSite column: -1 unspecified, 0 none, 1 lax, 2 strict. Anything else is unspecified: guessing "none" would widen a cookie. */
const chromiumSameSite = (value: number): ImportedCookie['sameSite'] =>
  value === 0 ? 'no_restriction' : value === 1 ? 'lax' : value === 2 ? 'strict' : 'unspecified';

interface ChromiumRow {
  host_key: string; name: string; value: string; encrypted_value: Uint8Array; path: string;
  expires_seconds: number; is_secure: number; is_httponly: number; samesite: number; top_frame_site_key: string;
}

export function readChromiumCookies(file: string, key: Buffer): CookieRead {
  return withSnapshot(file, db => {
    const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: unknown } | undefined)?.value);
    const schemaVersion = Number.isInteger(version) && version >= 0 ? version : 0;
    // Divided in SQL: the microsecond value is past JavaScript's safe integers,
    // and node:sqlite refuses to narrow it.
    const rows = db.prepare(`
      SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 AS expires_seconds,
             is_secure, is_httponly, samesite, ${schemaVersion >= 15 ? 'top_frame_site_key' : "''"} AS top_frame_site_key
        FROM cookies
    `).all() as unknown as ChromiumRow[];

    const cookies: ImportedCookie[] = [];
    const skippedHosts = new Set<string>();
    let undecryptable = 0;
    for (const row of rows) {
      // Partitioned (CHIPS) cookies belong to a top-level site Electron's
      // cookie API cannot express, so they are skipped rather than widened.
      const value = row.top_frame_site_key !== '' ? null
        : row.encrypted_value.length === 0 ? row.value
        : decryptChromiumValue(row.encrypted_value, key, row.host_key, schemaVersion);
      if (value === null) {
        undecryptable += 1;
        skippedHosts.add(bareHost(row.host_key));
        continue;
      }
      const secure = row.is_secure === 1;
      cookies.push({
        ...cookieScope(row.host_key, row.path, secure),
        name: row.name, value, path: row.path, secure, httpOnly: row.is_httponly === 1,
        expirationDate: row.expires_seconds > 0 ? row.expires_seconds - WEBKIT_EPOCH_OFFSET_SECONDS : undefined,
        sameSite: chromiumSameSite(row.samesite),
      });
    }
    return { cookies, undecryptable, undecryptableHosts: [...skippedHosts] };
  });
}

// ── Firefox ─────────────────────────────────────────────────────────────────

/**
 * Firefox's SameSite: 0 none, 1 lax, 2 strict, 256 unset. Schemas 10–14 also
 * carried `rawSameSite`, and a row that is lax only because nothing was declared
 * (lax + raw none) is unset — the rule Firefox's own schema-15 migration applies.
 */
function firefoxSameSite(value: number | null, raw: number | null): ImportedCookie['sameSite'] {
  if (value === null) return 'unspecified';
  if (value === 1 && raw === 0) return 'unspecified';
  return value === 0 ? 'no_restriction' : value === 1 ? 'lax' : value === 2 ? 'strict' : 'unspecified';
}

interface FirefoxRow {
  host: string; name: string; value: string; path: string; expiry: number;
  isSecure: number; isHttpOnly: number; sameSite: number | null; rawSameSite: number | null;
}

/** Firefox keeps cookies in plain SQLite: no key and no prompt, by Mozilla's design. */
export function readFirefoxCookies(file: string): CookieRead {
  return withSnapshot(file, db => {
    const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0);
    const hasRaw = schemaVersion >= 10 && schemaVersion <= 14;
    // The default container only. Containers and private windows are separate
    // identities Electron cannot represent; importing them all would hand the
    // panel an arbitrary container's session.
    const rows = db.prepare(`
      SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, ${hasRaw ? 'rawSameSite' : 'NULL'} AS rawSameSite
        FROM moz_cookies WHERE originAttributes = ''
    `).all() as unknown as FirefoxRow[];
    const cookies = rows.map((row): ImportedCookie => {
      const secure = row.isSecure === 1;
      return {
        ...cookieScope(row.host, row.path, secure),
        name: row.name, value: row.value, path: row.path, secure, httpOnly: row.isHttpOnly === 1,
        // Schema 16 (Firefox 129) moved expiry from seconds to milliseconds.
        expirationDate: row.expiry <= 0 ? undefined : schemaVersion >= 16 ? Math.floor(row.expiry / 1000) : row.expiry,
        sameSite: firefoxSameSite(row.sameSite, row.rawSameSite),
      };
    });
    return { cookies, undecryptable: 0, undecryptableHosts: [] };
  });
}

// ── Safari ──────────────────────────────────────────────────────────────────

/** Safari counts seconds from 2001-01-01. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;
const PAGE_HEADER = 12;
const RECORD_HEADER = 56;

const cString = (buffer: Buffer, start: number): string => {
  const end = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, end === -1 ? buffer.length : end);
};

/**
 * Safari's `Cookies.binarycookies`: magic "cook", a big-endian page table, then
 * little-endian pages of records. Every declared size and offset is checked
 * against the file, and a mismatch refuses the whole jar: `subarray` clamps
 * silently, so accepting one would import cookies quietly missing or carrying
 * bytes from their neighbours.
 */
export function parseBinaryCookies(buffer: Buffer): ImportedCookie[] {
  const refuse = (): never => { throw new CookieReadError('readFailed'); };
  if (buffer.length < 8 || buffer.toString('latin1', 0, 4) !== 'cook') refuse();
  const pageCount = buffer.readUInt32BE(4);
  if (8 + pageCount * 4 > buffer.length) refuse();

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;
  for (let p = 0; p < pageCount; p += 1) {
    const pageSize = buffer.readUInt32BE(8 + p * 4);
    if (pageSize < PAGE_HEADER || pageStart + pageSize > buffer.length) refuse();
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;

    const count = page.readUInt32LE(4);
    const tableEnd = PAGE_HEADER + count * 4;
    if (tableEnd > page.length) refuse();
    const taken: [number, number][] = [];
    for (let i = 0; i < count; i += 1) {
      const start = page.readUInt32LE(8 + i * 4);
      if (start < tableEnd || start + RECORD_HEADER > page.length) refuse();
      const size = page.readUInt32LE(start);
      const end = start + size;
      // No record may overlap another: the header, the table and earlier
      // records would otherwise parse as a made-up cookie.
      if (size < RECORD_HEADER || end > page.length || taken.some(([s, e]) => start < e && end > s)) refuse();
      taken.push([start, end]);
      const record = page.subarray(start, end);

      const flags = record.readUInt32LE(8);
      const offsets = [16, 20, 24, 28].map(at => record.readUInt32LE(at));
      if (offsets.some(offset => offset < RECORD_HEADER || offset >= record.length)) refuse();
      const [host, name, path, value] = offsets.map(offset => cString(record, offset)) as [string, string, string, string];
      if (host === '' || name === '') continue;
      const expiry = record.readDoubleLE(40);
      const secure = (flags & 0x1) !== 0;
      cookies.push({
        ...cookieScope(host, path || '/', secure),
        name, value, path: path || '/', secure, httpOnly: (flags & 0x4) !== 0,
        expirationDate: expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined,
        // Safari's SameSite bits have no agreed public description and real
        // jars match none; lax is the modern default, and "none" would widen.
        sameSite: 'lax',
      });
    }
  }

  // After the pages: nothing, an 8-byte checksum, or the checksum and a
  // length-prefixed property list. Anything else means the page table lied.
  const trailer = buffer.length - pageStart;
  const valid = trailer === 0 || trailer === 8 || (trailer >= 12 && trailer === 12 + buffer.readUInt32BE(pageStart + 8));
  if (!valid) refuse();
  return cookies;
}

/**
 * Safari's jar is not encrypted; macOS protects it with Full Disk Access. The
 * refusal arrives as EPERM — EACCES is an ordinary permission problem the grant
 * would not fix, so only EPERM sends the person to System Settings.
 */
export function readSafariCookies(file: string): CookieRead {
  let contents: Buffer;
  try {
    contents = readFileSync(file);
  } catch (error) {
    throw new CookieReadError((error as NodeJS.ErrnoException).code === 'EPERM' ? 'needsFullDiskAccess' : 'readFailed', { cause: error });
  }
  return { cookies: parseBinaryCookies(contents), undecryptable: 0, undecryptableHosts: [] };
}
