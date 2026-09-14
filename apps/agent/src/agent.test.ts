// The agent loop (docs/AGENT-RUNTIME.md §3, §6, §11), against a stand-in
// OpenAI chat-completions endpoint rather than a real provider — this is the
// runtime's first test file, and the stub AGENT-RUNTIME.md §11 describes was
// never checked in until now.
//
// Config is read once at import (`env.ts`), so the provider table is built
// HERE, before `./agent.ts` is ever imported, pointed at ONE long-lived stub
// server whose behaviour each test controls by swapping `handler` — never by
// changing env after the fact, which the provider table would not notice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => { handler(JSON.parse(raw || '{}') as Record<string, unknown>, res); });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => new Promise(resolve => server.close(resolve)));
const port = (server.address() as { port: number }).port;

process.env['AGENT_S2S_KEY'] = 'test-key';
process.env['AGENT_PROVIDERS'] = 'stub';
process.env['AGENT_PROVIDER_STUB_API'] = 'openai-completions';
process.env['AGENT_PROVIDER_STUB_BASE_URL'] = `http://127.0.0.1:${port}`;
process.env['AGENT_PROVIDER_STUB_API_KEY'] = 'x';
process.env['AGENT_PROVIDER_STUB_MODELS'] = 'stub-model';
process.env['AGENT_PROVIDER_STUB_CONTEXT_WINDOW'] = '8000';
process.env['AGENT_PROVIDER_STUB_REASONING'] = 'false';
process.env['AGENT_MODEL_FALLBACK'] = 'stub/stub-model';
process.env['AGENT_MAX_TURNS'] = '5';

const { startRun, NULL_SINK } = await import('./agent.ts');
const { env } = await import('./env.ts');
const MUTABLE_ENV = env as unknown as { modelStallMs: number };

let handler: (body: Record<string, unknown>, res: ServerResponse) => void = (_body, res) => {
  res.writeHead(500); res.end();
};

function sseChunk(res: ServerResponse, delta: Record<string, unknown>, finish: string | null = null): void {
  res.write(`data: ${JSON.stringify({
    id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: 'stub-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
}
function sseUsage(res: ServerResponse, promptTokens: number, completionTokens: number): void {
  res.write(`data: ${JSON.stringify({
    id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: 'stub-model',
    choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  })}\n\n`);
}
const sseDone = (res: ServerResponse): void => { res.write('data: [DONE]\n\n'); res.end(); };

/** A one-turn reply: assistant role, then the given text, then stop + usage. */
function replyOnce(text: string, promptTokens = 10, completionTokens = 4) {
  return (_body: Record<string, unknown>, res: ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    sseChunk(res, { role: 'assistant' });
    if (text.length > 0) sseChunk(res, { content: text });
    sseChunk(res, {}, 'stop');
    sseUsage(res, promptTokens, completionTokens);
    sseDone(res);
  };
}

const req = (over: Partial<Parameters<typeof startRun>[0]> = {}) => ({
  runId: 'run_test', prompt: 'hello', palette: 'none' as const, tools: [], ...over,
});

test('a completed run returns the model\'s text and usage, tagged with the provider', async () => {
  handler = replyOnce('Filed as LIN-42.', 12, 6);
  const run = startRun(req(), NULL_SINK);
  const result = await run.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Filed as LIN-42.');
  assert.deepEqual(result.usage, { input: 12, output: 6, cacheRead: 0 });
  assert.equal(result.provider, 'stub');
  assert.equal(result.turns, 1);
  assert.equal(result.error, undefined);
});

test('an empty turn — no text, no tool calls, no thrown error — is FAILED, not completed', async () => {
  // The exact shape a provider produces when it silently gives up: a normal
  // stream, a `stop`, nothing said (Claw lessons, WORKSPACE-AGENTS.md §5.3).
  handler = replyOnce('');
  const run = startRun(req({ runId: 'run_empty' }), NULL_SINK);
  const result = await run.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.text, '');
  assert.equal(result.error, 'the run produced no output');
});

test('a model that stalls mid-turn is failed by the STALL timer, not the wall clock', async () => {
  handler = (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    sseChunk(res, { role: 'assistant' });
    // ...and then nothing. No more chunks, no `finish_reason`, no close — a
    // provider that hung without erroring (§5.3).
  };
  const before = MUTABLE_ENV.modelStallMs;
  MUTABLE_ENV.modelStallMs = 150;
  try {
    const run = startRun(req({ runId: 'run_stall' }), NULL_SINK);
    const result = await run.result;
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /stalled|produced nothing/);
  } finally {
    MUTABLE_ENV.modelStallMs = before;
  }
});

test('palette \'none\' sends the model no built-in tools; \'default\' sends the coding palette', async () => {
  let seenTools: unknown;
  handler = (body, res) => {
    seenTools = body['tools'];
    replyOnce('ok')(body, res);
  };

  await startRun(req({ runId: 'run_none', palette: 'none' }), NULL_SINK).result;
  assert.ok(Array.isArray(seenTools) ? seenTools.length === 0 : (seenTools === undefined || seenTools === null),
    'palette "none" must not hand the model bash/read/write/edit/grep/find/ls');

  await startRun(req({ runId: 'run_default', palette: 'default' }), NULL_SINK).result;
  const names = (seenTools as { function: { name: string } }[] | undefined)?.map(t => t.function.name) ?? [];
  assert.ok(names.includes('bash'), 'the default palette (a local room\'s own Claude Code) keeps its tools');
});

test('a cancel wins over the reason pi reports as it unwinds', async () => {
  handler = (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    sseChunk(res, { role: 'assistant' });
    // Held open — the test cancels before anything else arrives.
  };
  const run = startRun(req({ runId: 'run_cancel' }), NULL_SINK);
  setTimeout(() => run.abort('cancelled'), 50);
  const result = await run.result;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, undefined, 'the cancellation reason owns the outcome, not whatever pi says while aborting');
});
