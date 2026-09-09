import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage, type Membership } from './storage.ts';

/**
 * R3, as a test rather than as a measurement (STORAGE.md §17.4).
 *
 * `RELAYED_VERIFY_BOOT=1` reports `networkCallsBeforeFirstPaint` when somebody
 * runs it, which is a fact about one launch and nothing about the next. Phase 2
 * is precisely the work that will break this — a socket, a catch-up, a
 * subscription, all wanting to start early — so it needs a guard that fails a
 * build rather than a number somebody remembers to look at.
 *
 * The unit under test is the BOOT PATH: everything the sync engine does before
 * a renderer could paint. If any of it reaches the network, this fails.
 */

const root = () => mkdtempSync(join(tmpdir(), 'relayed-boot-'));
const member = (over: Partial<Membership> & { workspaceId: string; actorId: string }): Membership => ({
  orgId: 'org_1', name: 'Workspace', slug: 'workspace', workspaceAvatarUrl: null,
  actorHandle: 'harsh', actorDisplayName: 'Harsh Sharma', actorAvatarUrl: null,
  actorRole: 'owner',
  ...over,
});

/**
 * Run `fn` with the network removed entirely, and report what it tried to reach.
 *
 * Counting calls is weaker than removing the network: a call that is made and
 * fails still proves the code reached for it, but a call that is counted and
 * allowed can succeed in a test environment and hide a dependency that only
 * appears on a plane. So `fetch` throws here.
 */
async function withoutNetwork<T>(fn: () => Promise<T> | T): Promise<{ result: T; attempts: string[] }> {
  const attempts: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const [input] = args;
    attempts.push(input instanceof Request ? input.url : String(input));
    throw new Error('network is unavailable — this is the aeroplane');
  }) as typeof fetch;
  try {
    return { result: await fn(), attempts };
  } finally {
    globalThis.fetch = real;
  }
}

test('a cold boot touches no network at all', async () => {
  const dir = root();
  const { attempts } = await withoutNetwork(() => {
    const s = new Storage(dir);
    const boot = s.boot();
    assert.deepEqual(boot.accounts, []);
    assert.equal(boot.workspaceId, null);
    return boot;
  });
  assert.deepEqual(attempts, []);
});

test('a WARM boot renders the full workspace with no network', async () => {
  // The failure this exists to prevent, in DESIGN.md §13.1's words: "a user
  // opens their laptop on a plane and gets a login screen over a full local
  // database."
  const dir = root();
  {
    const setup = new Storage(dir);
    const acc = setup.createAccount('dev_1');
    setup.openAccount(acc);
    setup.syncMemberships([
      member({ workspaceId: 'wsp_a', actorId: 'act_a', name: 'Relayed Core' }),
      member({ workspaceId: 'wsp_b', actorId: 'act_b', name: 'Relayed External' }),
    ]);
    setup.switchWorkspace('wsp_a');
    setup.syncActors([{
      id: 'act_a', workspaceId: 'wsp_a', type: 'human', handle: 'harsh',
      displayName: 'Harsh Sharma', avatarUrl: null, ownerActorId: null,
      state: 'active', updatedAt: 1,
    }]);
    setup.close();
  }

  const { result, attempts } = await withoutNetwork(() => {
    const s = new Storage(dir);
    const boot = s.boot();
    // Everything the first paint needs, read entirely from disk.
    return {
      workspace: boot.workspaceId,
      switcher: s.workspaces().map(w => w.name),
      role: s.workspaceRow('wsp_a')?.actorRole,
      directory: s.actors().map(a => a.handle),
      device: s.deviceId,
    };
  });

  assert.deepEqual(attempts, [], 'the read path reached for the network');
  assert.equal(result.workspace, 'wsp_a');
  assert.deepEqual(result.switcher.toSorted(), ['Relayed Core', 'Relayed External']);
  assert.equal(result.role, 'owner', 'can() can be answered offline');
  assert.deepEqual(result.directory, ['harsh'], 'authors render offline');
  assert.ok(result.device.startsWith('dev_'));
});

test('switching workspaces offline still opens the replica', async () => {
  // §12.2: the repaint must not wait on a token. Offline is where that stops
  // being a preference and becomes the only way it can work.
  const dir = root();
  {
    const setup = new Storage(dir);
    const acc = setup.createAccount('dev_1');
    setup.openAccount(acc);
    setup.syncMemberships([
      member({ workspaceId: 'wsp_a', actorId: 'act_a' }),
      member({ workspaceId: 'wsp_b', actorId: 'act_b' }),
    ]);
    setup.switchWorkspace('wsp_a');
    setup.close();
  }

  const { result, attempts } = await withoutNetwork(() => {
    const s = new Storage(dir);
    s.boot();
    const epoch = s.switchWorkspace('wsp_b');
    return { workspace: s.workspaceId, epoch, open: s.hasWorkspace };
  });

  assert.deepEqual(attempts, []);
  assert.equal(result.workspace, 'wsp_b');
  assert.equal(result.open, true);
  assert.ok(result.epoch > 0);
});

test('a boot with no workspace open still answers, rather than throwing', async () => {
  // Signed out is a state the UI has to render, not an error path.
  const dir = root();
  const { result, attempts } = await withoutNetwork(() => {
    const s = new Storage(dir);
    const boot = s.boot();
    return { hasWorkspace: s.hasWorkspace, accounts: boot.accounts.length, install: s.installId };
  });
  assert.deepEqual(attempts, []);
  assert.equal(result.hasWorkspace, false);
  assert.equal(result.accounts, 0);
  assert.ok(result.install.startsWith('ins_'));
});
