// Importing another browser's cookies, against fake profiles in a temp
// directory (docs/PANELS.md, browser import). Nothing here reads a real browser
// or the Keychain: the key is derived from a made-up secret, and every profile
// is built by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  chromiumMacKey, cookieScope, decryptChromiumValue, parseBinaryCookies, readChromiumCookies, readFirefoxCookies,
} from './cookies.ts';
import { chromiumLockHeld, cookieDatabase, listProfiles, parseFirefoxProfiles, SOURCES, unavailableReason } from './sources.ts';
import { importCookies, writeCookies } from './index.ts';

const source = (id: string) => SOURCES.find(candidate => candidate.id === id)!;
const fakeHome = () => mkdtempSync(join(tmpdir(), 'relayed-import-home-'));
const KEY = chromiumMacKey('a made-up secret');

const encrypt = (plaintext: string, host: string, schemaVersion: number): Buffer => {
  const bound = schemaVersion >= 24 ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(plaintext)]) : Buffer.from(plaintext);
  const cipher = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(bound), cipher.final()]);
};

/** A fake Chrome with one profile, a `Local State`, and a `Network/Cookies` holding the rows given. */
function fakeChrome(home: string, schemaVersion: number, rows: { host: string; name: string; value: string; plain?: boolean; partitioned?: boolean }[]) {
  const dir = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  mkdirSync(join(dir, 'Profile 1', 'Network'), { recursive: true });
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Work' }, '../../escape': { name: 'x' } } } }));
  const db = new DatabaseSync(join(dir, 'Profile 1', 'Network', 'Cookies'));
  db.exec(`
    CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
      is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT);
  `);
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(schemaVersion));
  // 2100-01-01, as microseconds from 1601.
  const expires = BigInt(4_102_444_800 + 11_644_473_600) * 1_000_000n;
  for (const row of rows) {
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)').run(
      row.host, row.name, row.plain ? row.value : '', row.plain ? Buffer.alloc(0) : encrypt(row.value, row.host, schemaVersion),
      '/', expires, row.partitioned ? 'https://other.site' : '');
  }
  db.close();
  return dir;
}

test('Chromium: a v10 value decrypts, and since schema 24 only for the host it was bound to', () => {
  assert.equal(decryptChromiumValue(encrypt('session', '.github.com', 23), KEY, '.github.com', 23), 'session');
  assert.equal(decryptChromiumValue(encrypt('session', '.github.com', 24), KEY, '.github.com', 24), 'session');
  assert.equal(decryptChromiumValue(encrypt('session', '.github.com', 24), KEY, '.evil.com', 24), null, 'moved to another host');
  assert.equal(decryptChromiumValue(encrypt('session', '.github.com', 23), chromiumMacKey('wrong'), '.github.com', 23), null, 'the wrong key');
});

test('Chromium: a profile is read from a snapshot, with partitioned cookies skipped and counted', () => {
  const home = fakeHome();
  fakeChrome(home, 24, [
    { host: '.github.com', name: 'user_session', value: 'abc' },
    { host: 'linear.app', name: 'plain', value: 'legacy', plain: true },
    { host: '.embed.com', name: 'chips', value: 'x', partitioned: true },
  ]);
  const file = cookieDatabase(source('chrome'), home, 'Profile 1')!;
  assert.match(file, /Network\/Cookies$/, 'the current jar, not a leftover');
  const read = readChromiumCookies(file, KEY);
  assert.deepEqual(read.cookies.map(c => [c.url, c.name, c.value, c.domain, c.expirationDate]), [
    ['https://github.com/', 'user_session', 'abc', '.github.com', 4_102_444_800],
    ['https://linear.app/', 'plain', 'legacy', undefined, 4_102_444_800],
  ]);
  assert.deepEqual([read.undecryptable, read.undecryptableHosts], [1, ['embed.com']]);
});

test('Chromium: profiles come from Local State, and a name that is a path is dropped', () => {
  const home = fakeHome();
  fakeChrome(home, 23, [{ host: 'a.com', name: 'n', value: 'v' }]);
  assert.deepEqual(listProfiles(source('chrome'), home), [{ directory: 'Profile 1', name: 'Work', cookieCount: 1 }]);
});

test('Chromium: SingletonLock is held by a live pid on this host, and only then', () => {
  assert.equal(chromiumLockHeld(`${hostname()}-${process.pid}`, hostname()), true);
  assert.equal(chromiumLockHeld(`${hostname()}-4242`, hostname(), () => false), false, 'a crash leaves a stale lock');
  assert.equal(chromiumLockHeld('other-mac-4242', hostname(), () => false), true, 'another machine cannot be judged');
  const home = fakeHome();
  const dir = fakeChrome(home, 23, [{ host: 'a.com', name: 'n', value: 'v' }]);
  symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'));
  assert.equal(unavailableReason(source('chrome'), home, 'darwin'), 'browserRunning');
});

test('a browser with a user-data directory but no cookie database is not installed', () => {
  const home = fakeHome();
  mkdirSync(join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'), { recursive: true });
  assert.equal(unavailableReason(source('brave'), home, 'darwin'), 'notInstalled');
  assert.equal(unavailableReason(source('brave'), home, 'linux'), 'unsupportedPlatform');
});

test('Firefox: the default container only, and expiry read in the unit its schema uses', () => {
  const home = fakeHome();
  const profile = join(home, 'Library', 'Application Support', 'Firefox', 'Profiles', 'abc.default');
  mkdirSync(profile, { recursive: true });
  const db = new DatabaseSync(join(profile, 'cookies.sqlite'));
  db.exec(`PRAGMA user_version = 16; CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)`);
  db.prepare("INSERT INTO moz_cookies VALUES ('.google.com', 'SID', 'g', '/', 4102444800000, 1, 1, 256, '')").run();
  db.prepare("INSERT INTO moz_cookies VALUES ('.google.com', 'SID', 'work', '/', 4102444800000, 1, 1, 0, '^userContextId=2')").run();
  db.close();
  const read = readFirefoxCookies(join(profile, 'cookies.sqlite'));
  assert.deepEqual(read.cookies.map(c => [c.value, c.expirationDate, c.sameSite]), [['g', 4_102_444_800, 'unspecified']]);
  assert.deepEqual(listProfiles(source('firefox'), home).map(p => p.directory), [join('Profiles', 'abc.default')], 'found by scanning without profiles.ini');
});

test('Firefox: a relative profile path may not leave the root', () => {
  const ini = '[Install1]\nDefault=x\n[Profile0]\nName=ok\nPath=Profiles/a\n[Profile1]\nName=bad\nPath=../../etc\n[Profile2]\nName=abs\nIsRelative=0\nPath=/Volumes/x/p';
  assert.deepEqual(parseFirefoxProfiles(ini, '/home/Firefox'), [
    { directory: 'Profiles/a', name: 'ok' }, { directory: '/Volumes/x/p', name: 'abs' },
  ]);
});

/** One page holding one cookie, in Safari's layout. */
function binaryCookies(host: string, name: string, path: string, value: string, flags: number): Buffer {
  const fields = [host, name, path, value];
  const strings = Buffer.concat(fields.map(s => Buffer.from(`${s}\0`)));
  const record = Buffer.alloc(56 + strings.length);
  record.writeUInt32LE(record.length, 0);
  record.writeUInt32LE(flags, 8);
  let at = 56;
  fields.forEach((s, i) => { record.writeUInt32LE(at, 16 + i * 4); at += Buffer.byteLength(s) + 1; });
  record.writeDoubleLE(3_124_137_600, 40); // 2100-01-01, from 2001
  strings.copy(record, 56);
  // Header, one offset, four zero bytes, then the record.
  const page = Buffer.alloc(16 + record.length);
  page.writeUInt32BE(0x100, 0);
  page.writeUInt32LE(1, 4);
  page.writeUInt32LE(16, 8);
  record.copy(page, 16);
  const header = Buffer.alloc(12);
  header.write('cook', 0, 'latin1');
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(page.length, 8);
  return Buffer.concat([header, page, Buffer.alloc(8)]);
}

test('Safari: a jar parses, and one whose sizes lie is refused whole', () => {
  const jar = binaryCookies('.notion.so', 'token_v2', '/', 'n', 0x5);
  assert.deepEqual(parseBinaryCookies(jar).map(c => [c.url, c.domain, c.value, c.secure, c.httpOnly, c.expirationDate]), [
    ['https://notion.so/', '.notion.so', 'n', true, true, 4_102_444_800],
  ]);
  const lying = Buffer.from(jar);
  lying.writeUInt32BE(9999, 8);
  assert.throws(() => parseBinaryCookies(lying), /readFailed/);
  assert.throws(() => parseBinaryCookies(Buffer.concat([jar, Buffer.alloc(5)])), /readFailed/, 'trailing bytes');
});

test('a host-only cookie keeps no domain, so Electron does not widen it to subdomains', () => {
  assert.deepEqual(cookieScope('app.linear.app', '/', true), { url: 'https://app.linear.app/', domain: undefined });
  assert.deepEqual(cookieScope('.linear.app', '/x', false), { url: 'http://linear.app/x', domain: '.linear.app' });
});

test('writing: expired and rejected cookies are skipped and named; the store is flushed once', async () => {
  const set: string[] = [];
  let flushed = 0;
  const session = { cookies: {
    set: (c: { name: string }) => { if (c.name === 'bad') return Promise.reject(new Error('rejected')); set.push(c.name); return Promise.resolve(); },
    flushStore: () => { flushed += 1; return Promise.resolve(); },
  } } as never;
  const cookie = (name: string, url: string, expirationDate?: number) => ({
    url, name, value: 'v', domain: undefined, path: '/', secure: true, httpOnly: true, expirationDate, sameSite: 'lax' as const,
  });
  const result = await writeCookies(session, {
    cookies: [cookie('ok', 'https://a.com/'), cookie('old', 'https://b.com/', 1), cookie('bad', 'https://c.com/')],
    undecryptable: 2, undecryptableHosts: ['d.com'],
  });
  assert.deepEqual(result, { ok: true, imported: 1, skipped: 4, skippedSites: ['d.com', 'c.com'] });
  assert.deepEqual([set, flushed], [['ok'], 1]);
});

test('an import names only a profile the browser listed — a path from IPC reads nothing', { skip: process.platform !== 'darwin' }, async () => {
  const home = fakeHome();
  fakeChrome(home, 23, [{ host: 'a.com', name: 'n', value: 'v' }]);
  const session = { cookies: { set: () => Promise.resolve(), flushStore: () => Promise.resolve() } } as never;
  assert.deepEqual(await importCookies({ sourceId: 'chrome', directory: '../../../../etc' }, session, home), { ok: false, reason: 'unknownProfile' });
  assert.deepEqual(await importCookies({ sourceId: 'chrome', directory: 'Profile 1' }, null, home), { ok: false, reason: 'noAccount' });
});
