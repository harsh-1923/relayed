// The server's call to `apps/agent` (docs/AGENT-RUNTIME.md §3), against a
// stand-in HTTP server rather than the real runtime — this is the transport
// layer, and its job is to survive the shapes a real one can send, not to
// prove a model answers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RunRequest, RunResultBody } from '@relayed/protocol';
import { env } from '../env.ts';
import { callRuntime, RuntimeInterruptedError, RuntimeUnavailableError } from './runtime-client.ts';

const RUNTIME_ENV = env as unknown as { agentRuntimeUrl: string | null; agentS2sKey: string | null };
const restore = { url: env.agentRuntimeUrl, key: env.agentS2sKey };
after(() => { RUNTIME_ENV.agentRuntimeUrl = restore.url; RUNTIME_ENV.agentS2sKey = restore.key; });

RUNTIME_ENV.agentS2sKey = 'test-s2s-key';

const servers: Server[] = [];
after(async () => { await Promise.all(servers.map(s => new Promise(r => s.close(r)))); });

/** A stand-in runtime, driven by `handle` for one request. Points `env.agentRuntimeUrl` at itself. */
async function fakeRuntime(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  RUNTIME_ENV.agentRuntimeUrl = `http://127.0.0.1:${port}`;
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ seq: 0, ...(data as object) })}\n\n`);
}

const body: RunRequest = {
  runId: 'run_test', prompt: 'hello', palette: 'none', tools: [],
};

const result: RunResultBody = {
  runId: 'run_test', status: 'completed', text: 'done', toolCalls: [],
  usage: { input: 1, output: 1, cacheRead: 0 }, turns: 1, provider: 'test', durationMs: 5,
};

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

test('started, a tool round trip, and done map to the runtime events the dispatcher reads', async () => {
  await fakeRuntime((req, res) => {
    assert.equal(req.headers['x-agent-key'], 'test-s2s-key');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, 'started', { runId: 'run_test' });
    sse(res, 'tool', { phase: 'start', name: 'LINEAR_CREATE_ISSUE', id: 'call_1' });
    sse(res, 'tool', { phase: 'end', name: 'LINEAR_CREATE_ISSUE', id: 'call_1', ok: true, ms: 42 });
    sse(res, 'done', { result });
    res.end();
  });

  const events = await drain(callRuntime(body, new AbortController().signal));
  assert.deepEqual(events, [
    { kind: 'started' },
    { kind: 'tool_start', name: 'LINEAR_CREATE_ISSUE', id: 'call_1' },
    { kind: 'tool_end', name: 'LINEAR_CREATE_ISSUE', id: 'call_1', ok: true, ms: 42 },
    { kind: 'done', result },
  ]);
});

test('a stream that ends with no done frame is INTERRUPTED, not a generic failure — trap 3', async () => {
  await fakeRuntime((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, 'started', { runId: 'run_test' });
    res.end();   // the runtime's caller vanished; nothing failed at anything
  });

  await assert.rejects(drain(callRuntime(body, new AbortController().signal)), RuntimeInterruptedError);
});

test('deltas and reasoning frames are read past, not surfaced — the dispatcher needs neither', async () => {
  await fakeRuntime((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, 'delta', { text: 'partial ' });
    sse(res, 'reasoning', { text: 'thinking...' });
    sse(res, 'done', { result });
    res.end();
  });
  const events = await drain(callRuntime(body, new AbortController().signal));
  assert.deepEqual(events, [{ kind: 'done', result }]);
});

test('a keepalive comment and an unknown event name are both skipped, forward-compatibly', async () => {
  await fakeRuntime((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keepalive\n\n');
    res.write('event: something_this_build_does_not_know\ndata: {"seq":0}\n\n');
    sse(res, 'done', { result });
    res.end();
  });
  const events = await drain(callRuntime(body, new AbortController().signal));
  assert.deepEqual(events, [{ kind: 'done', result }]);
});

test('a 429 is a distinct, retryable-shaped refusal — the runtime is at capacity', async () => {
  await fakeRuntime((_req, res) => { res.writeHead(429); res.end(); });
  await assert.rejects(drain(callRuntime(body, new AbortController().signal)), (err: unknown) => {
    assert.ok(err instanceof RuntimeUnavailableError);
    assert.equal(err.status, 429);
    return true;
  });
});

test('any other non-2xx status is unavailable, with its status carried and the body drained', async () => {
  await fakeRuntime((_req, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"boom"}'); });
  await assert.rejects(drain(callRuntime(body, new AbortController().signal)), (err: unknown) => {
    assert.ok(err instanceof RuntimeUnavailableError);
    assert.equal(err.status, 500);
    return true;
  });
});

test('nothing listening at all is unavailable, not an unhandled connection error', async () => {
  // A port nothing is bound to, chosen by binding and immediately closing.
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise(r => probe.close(r));
  RUNTIME_ENV.agentRuntimeUrl = `http://127.0.0.1:${port}`;

  await assert.rejects(drain(callRuntime(body, new AbortController().signal)), RuntimeUnavailableError);
});

test('with no runtime configured, the call refuses before touching the network', async () => {
  RUNTIME_ENV.agentRuntimeUrl = null;
  await assert.rejects(drain(callRuntime(body, new AbortController().signal)), RuntimeUnavailableError);
});
