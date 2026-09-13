import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerLink, type RunnerPort } from './runner.ts';

/** A port whose far end is this test. */
function fakePort() {
  const listeners = { message: [] as ((event: { data: unknown }) => void)[], close: [] as (() => void)[] };
  const sent: { id: number; op: string }[] = [];
  const port: RunnerPort = {
    postMessage: (message) => { sent.push(message as { id: number; op: string }); },
    on: (event: 'message' | 'close', listener: never) => { (listeners[event] as unknown[]).push(listener); return port; },
    start: () => {},
  };
  return {
    port, sent,
    reply: (data: unknown) => { for (const listener of listeners.message) listener({ data }); },
    close: () => { for (const listener of listeners.close) listener(); },
  };
}

test('a request is answered by the reply carrying its id', async () => {
  const link = createRunnerLink();
  const far = fakePort();
  link.attach(far.port);
  const answer = link.request('claude.status', undefined);
  assert.equal(far.sent[0]?.op, 'claude.status');
  far.reply({ id: far.sent[0]?.id, ok: true, data: { state: 'not_installed', searched: [], checkedAt: 1 } });
  assert.deepEqual(await answer, { state: 'not_installed', searched: [], checkedAt: 1 });
});

test('no runner is an immediate refusal, not a thirty-second wait', async () => {
  await assert.rejects(createRunnerLink().request('claude.status', undefined), /not running/);
});

test('a runner that stops fails what was waiting on it at once', async () => {
  const link = createRunnerLink();
  const far = fakePort();
  link.attach(far.port);
  const answer = link.request('claude.status', undefined);
  far.close();
  await assert.rejects(answer, /stopped/);
  assert.equal(link.attached, false);
});

test('a replacement port fails requests sent on the old one; a late close of the old one changes nothing', async () => {
  const link = createRunnerLink();
  const old = fakePort();
  link.attach(old.port);
  const stranded = link.request('claude.status', undefined);
  const next = fakePort();
  link.attach(next.port);
  await assert.rejects(stranded, /restarted/);
  old.close();
  assert.equal(link.attached, true, 'the new port is still the one in use');
});

test('an error reply rejects with the runner\'s reason', async () => {
  const link = createRunnerLink();
  const far = fakePort();
  link.attach(far.port);
  const answer = link.request('claude.status', undefined);
  far.reply({ id: far.sent[0]?.id, ok: false, error: 'unknown op: x' });
  await assert.rejects(answer, /unknown op: x/);
});

test('a runner that never answers times out', async () => {
  const link = createRunnerLink({}, 20);
  link.attach(fakePort().port);
  await assert.rejects(link.request('claude.status', undefined), /did not answer/);
});

test('an event is handed to the hook, not mistaken for a reply', () => {
  const seen: unknown[] = [];
  const link = createRunnerLink({ onEvent: event => seen.push(event) });
  const far = fakePort();
  link.attach(far.port);
  far.reply({ event: 'turn.delta', chatId: 'c', messageId: 'm', text: 'hi' });
  assert.deepEqual(seen, [{ event: 'turn.delta', chatId: 'c', messageId: 'm', text: 'hi' }]);
});

test('a runner that goes away is reported, so its turns can be ended', () => {
  let detached = 0;
  const link = createRunnerLink({ onDetach: () => { detached++; } });
  const first = fakePort();
  link.attach(first.port);
  link.attach(fakePort().port);
  assert.equal(detached, 1, 'replaced');
  first.close();
  assert.equal(detached, 1, 'a late close of the replaced port is not a second loss');
});
