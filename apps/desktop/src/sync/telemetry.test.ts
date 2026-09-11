import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setSink, type Sink } from '@relayed/telemetry';
import { Storage, type Membership } from './storage.ts';

/**
 * The instrumentation is only worth having if it actually fires, and "I saw it
 * in a log once" is not a guarantee that survives a refactor.
 */
interface Captured {
  events: { name: string; fields: Record<string, unknown> }[];
  metrics: { kind: string; metric: string; value: number;
             labels: Record<string, unknown> | undefined }[];
}
let captured: Captured;

function capturingSink(): Sink {
  return {
    event: (name, fields) => captured.events.push({ name, fields: fields as Record<string, unknown> }),
    count: (metric, labels, by = 1) => captured.metrics.push({ kind: 'count', metric, value: by, labels }),
    gauge: (metric, value, labels) => captured.metrics.push({ kind: 'gauge', metric, value, labels }),
    histogram: (metric, value, labels) => captured.metrics.push({ kind: 'histogram', metric, value, labels }),
  };
}

beforeEach(() => { captured = { events: [], metrics: [] }; setSink(capturingSink()); });

const root = () => mkdtempSync(join(tmpdir(), 'relayed-telemetry-'));
const member = (over: Partial<Membership> & { workspaceId: string; actorId: string }): Membership => ({
  orgId: 'org_1', name: 'Workspace', slug: 'workspace', workspaceAvatarUrl: null,
  actorHandle: 'harsh', actorDisplayName: 'Harsh Sharma', actorAvatarUrl: null,
  actorRole: 'owner',
  ...over,
});

const metric = (name: string) => captured.metrics.filter(m => m.metric === name);
const event  = (name: string) => captured.events.filter(e => e.name === name);

test('migrations are timed per tier, on independent version lines', () => {
  const s = new Storage(root());
  const acc = s.createAccount('dev_1');
  s.openAccount(acc);
  s.syncMemberships([member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  s.switchWorkspace('wsp_a');

  const tiers = metric('db.migrate').map(m => m.labels?.['tier']);
  assert.ok(tiers.includes('account'), 'account.db migration is timed');
  assert.ok(tiers.includes('workspace'), 'the replica migration is timed separately');
  // An average across two unrelated schemas would be meaningless.
  assert.notEqual(tiers[0], tiers[tiers.length - 1]);
});

test('opening an account reports its ids — the layer metrics cannot', () => {
  const s = new Storage(root());
  const acc = s.createAccount('dev_1');
  s.openAccount(acc);
  const [opened] = event('account.opened');
  assert.equal(opened?.fields['account'], acc);
  assert.equal(opened?.fields['device'], 'dev_1');
});

test('a switch reports its LOCAL duration, which is what the user waits on', () => {
  const s = new Storage(root());
  const acc = s.createAccount('dev_1');
  s.openAccount(acc);
  s.syncMemberships([
    member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
    member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
  ]);
  s.switchWorkspace('wsp_a');
  captured = { events: [], metrics: [] };

  s.switchWorkspace('wsp_b');

  const [sw] = event('workspace.switched');
  assert.equal(sw?.fields['from'], 'wsp_a');
  assert.equal(sw?.fields['to'], 'wsp_b');
  assert.equal(typeof sw?.fields['local'], 'number');
  assert.ok((sw?.fields['epoch'] as number) > 0);

  // Closing the previous replica is paid inside that local phase, so it is
  // measured separately rather than hidden in the total.
  assert.equal(metric('workspace.close').length, 1);
});

test('deleting an account is counted — sign-out completing is a fact worth having', () => {
  const s = new Storage(root());
  const acc = s.createAccount('dev_1');
  s.openAccount(acc);
  s.deleteAccount(acc);
  assert.equal(metric('account.deleted').length, 1);
});

test('storing a blob records what it costs on disk', () => {
  const s = new Storage(root());
  const acc = s.createAccount('dev_1');
  s.openAccount(acc);
  s.putBlob('a'.repeat(64), new Uint8Array(1234));
  const [bytes] = metric('blob.bytes');
  assert.equal(bytes?.value, 1234);
  assert.equal(bytes?.labels?.['kind'], 'avatar');
});

test('no metric label is an unbounded id, at runtime as well as in the types', () => {
  // §5's binding constraint, checked against what was ACTUALLY emitted rather
  // than against the catalogue — a cast or a JS caller could bypass the types.
  const s = new Storage(root());
  const acc = s.createAccount('dev_1');
  s.openAccount(acc);
  s.syncMemberships([member({ workspaceId: 'wsp_a', actorId: 'act_a' })]);
  s.switchWorkspace('wsp_a');
  s.putBlob('b'.repeat(64), new Uint8Array(8));

  for (const m of captured.metrics) {
    for (const [k, v] of Object.entries(m.labels ?? {})) {
      assert.ok(!String(v).startsWith('acc_') && !String(v).startsWith('wsp_')
             && !String(v).startsWith('act_') && !String(v).startsWith('dev_'),
        `${m.metric} label ${k}=${String(v)} is an identifier`);
    }
  }
});
