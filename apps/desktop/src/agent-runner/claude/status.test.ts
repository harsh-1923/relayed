import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeStatus, signedIn, type CliAccount, type ProbeDeps } from './status.ts';

const deps = (over: Partial<ProbeDeps>): ProbeDeps => ({
  resolve: () => ({ path: '/Users/me/.local/bin/claude', searched: ['/Users/me/.local/bin/claude'] }),
  version: () => Promise.resolve('2.1.270'),
  startup: () => Promise.resolve({ account: {}, models: [] }),
  now: () => 1_000,
  ...over,
});

test('three states the screen must never merge: not installed, signed out, ready', async () => {
  const missing = await probeStatus(deps({ resolve: () => ({ path: null, searched: ['/a', '/b'] }) }));
  assert.deepEqual(missing, { state: 'not_installed', searched: ['/a', '/b'], checkedAt: 1_000 });

  // Measured against an empty CLAUDE_CONFIG_DIR.
  const out = await probeStatus(deps({ startup: () => Promise.resolve({ account: { tokenSource: 'none', apiProvider: 'firstParty' }, models: [] }) }));
  assert.equal(out.state, 'signed_out');

  // Measured against a Max login: an email, a plan, and no key source at all.
  const ready = await probeStatus(deps({ startup: () => Promise.resolve({
    account: { email: 'me@example.com', organization: 'Mine', subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
    models: [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Everyday', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
      { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fast' },
    ],
  }) }));
  assert.deepEqual(ready, {
    state: 'ready', binary: '/Users/me/.local/bin/claude', version: '2.1.270', checkedAt: 1_000,
    account: { email: 'me@example.com', organization: 'Mine', plan: 'Claude Max', authSource: 'claude.ai', provider: 'firstParty' },
    models: [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Everyday', efforts: ['low', 'high'] },
      { value: 'haiku', resolvedModel: null, displayName: 'Haiku 4.5', description: 'Fast', efforts: [] },
    ],
  });
});

test('an API key or a cloud provider is signed in, with no email', () => {
  const cases: [CliAccount, boolean][] = [
    [{ apiKeySource: 'ANTHROPIC_API_KEY' }, true],
    [{ apiKeySource: 'apiKeyHelper', tokenSource: 'none' }, true],
    [{ apiProvider: 'bedrock' }, true],
    [{ apiKeySource: 'none', tokenSource: 'none', apiProvider: 'firstParty' }, false],
    [{}, false],
  ];
  for (const [account, expected] of cases) assert.equal(signedIn(account), expected, JSON.stringify(account));
});

test('a probe that fails is an error with its reason, not "signed out"', async () => {
  const failed = await probeStatus(deps({ startup: () => Promise.reject(new Error('Claude Code did not start within 20s')) }));
  assert.deepEqual(failed, {
    state: 'error', binary: '/Users/me/.local/bin/claude', version: '2.1.270',
    reason: 'Claude Code did not start within 20s', checkedAt: 1_000,
  });
});
