// A Composio session survives a toolkit Composio does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposioError } from './composio.ts';
import { createWithoutRejected, rejectedToolkits } from './sessions.ts';

const refusal = new ComposioError('Invalid toolkit slugs: acc0sgsfbmd, accsk7kkpt7. Please provide valid toolkit slugs.', 400, 'http_400');

test('the toolkits Composio refused are read from its answer, and nothing from any other error', () => {
  assert.deepEqual(rejectedToolkits(refusal), ['acc0sgsfbmd', 'accsk7kkpt7']);
  assert.deepEqual(rejectedToolkits(new ComposioError('rate limited', 429, 'http_429')), []);
  assert.deepEqual(rejectedToolkits(new Error('Invalid toolkit slugs: linear.')), [], 'only Composio\'s own errors');
});

test('a session is made again without the refused toolkits, and their pins', async () => {
  const asked: { toolkits: string[]; connectedAccounts: Record<string, string> }[] = [];
  const created = await createWithoutRejected(
    'act_1', ['acc0sgsfbmd', 'linear', 'accsk7kkpt7'], { linear: 'ca_1', acc0sgsfbmd: 'ca_2' },
    async (_user, options) => {
      asked.push(options);
      if (options.toolkits.includes('acc0sgsfbmd')) throw refusal;
      return { sessionId: 'trs_ok' };
    },
  );
  assert.equal(created.sessionId, 'trs_ok');
  assert.deepEqual(asked.at(-1), { toolkits: ['linear'], connectedAccounts: { linear: 'ca_1' } });
  assert.equal(asked.length, 2, 'once more, not in a loop');
});

test('any other failure, or a refusal of something not asked for, is not retried', async () => {
  let calls = 0;
  const failing = async () => { calls++; throw new ComposioError('rate limited', 429, 'http_429'); };
  await assert.rejects(() => createWithoutRejected('act_1', ['linear'], {}, failing));
  const strange = async () => { calls++; throw new ComposioError('Invalid toolkit slugs: nothing_we_sent.', 400, 'http_400'); };
  await assert.rejects(() => createWithoutRejected('act_1', ['linear'], {}, strange));
  assert.equal(calls, 2);
});
