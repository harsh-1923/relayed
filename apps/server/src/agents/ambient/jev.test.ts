// The TypeSafe client, through TypeSafe's SDK, against a local stand-in: what it
// sends, what it accepts, that one blip is retried, and that every way of
// failing arrives as one closed reason (docs/AMBIENT-RESPONSES.md, silence §8 —
// a failure here is invisible to users, so the reason is all there is).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jevClient, JevError, JEV_MODEL, type Question } from './jev.ts';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => { res.statusCode = 500; res.end(); };
let requests = 0;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => { requests += 1; handler(req, body, res); });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => new Promise<void>(resolve => server.close(() => resolve())));

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};

const questions = {
  urgent: { type: 'noul', instructions: 'Is it urgent?' },
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Money', technical: null } },
} satisfies Record<string, Question>;

const good = {
  model: 'jev-1.13.0',
  answers: {
    urgent: { type: 'noul', noul: 0.91 },
    team: { type: 'choice', choice: 'technical', probabilities: { billing: 0.1, technical: 0.9 }, confidence: 0.85 },
  },
  usage: { input_tokens: 300, output_tokens: 20 },
  added_later: 'ignored',
};

test('sends the pinned model, the key and the questions, and reads the answers and the tokens', async () => {
  let seen: { auth?: string | undefined; body?: Record<string, unknown>; path?: string } = {};
  handler = (req, body, res) => {
    seen = { auth: req.headers.authorization, body: JSON.parse(body) as Record<string, unknown>, path: req.url ?? '' };
    json(res, 200, good);
  };
  const judged = await jevClient({ apiKey: 'key_test', baseUrl }).ask({ text: 'the site is down' }, questions);

  assert.equal(seen.path, '/v1/systemone');
  assert.equal(seen.auth, 'Bearer key_test');
  assert.equal(seen.body?.['model'], JEV_MODEL, 'never the SDK\'s jev-latest: thresholds are tuned against one version');
  assert.deepEqual(seen.body?.['state'], { text: 'the site is down' });
  assert.deepEqual(seen.body?.['questions'], questions);

  assert.equal(judged.model, 'jev-1.13.0');
  assert.equal(judged.answers.urgent.noul, 0.91);
  assert.equal(judged.answers.team.choice, 'technical');
  assert.equal(judged.answers.team.confidence, 0.85);
  assert.equal(judged.inputTokens, 300, 'the real cost of the call, which the spike could only estimate');
});

test('one blip is retried, and a second is not', async () => {
  let n = 0;
  handler = (_req, _body, res) => { n += 1; if (n === 1) json(res, 529, {}, { 'retry-after': '0' }); else json(res, 200, good); };
  requests = 0;
  const judged = await jevClient({ apiKey: 'k', baseUrl }).ask('state', questions);
  assert.equal(judged.answers.urgent.noul, 0.91);
  assert.equal(requests, 2, 'the SDK retried the overloaded answer once');

  handler = (_req, _body, res) => json(res, 529, {}, { 'retry-after': '0' });
  requests = 0;
  await assert.rejects(jevClient({ apiKey: 'k', baseUrl }).ask('state', questions));
  assert.equal(requests, 2, 'one retry, not the SDK\'s default two');
});

async function reasonFor(respond: Handler, options: { timeoutMs?: number; url?: string } = {}): Promise<string> {
  handler = respond;
  try {
    await jevClient({ apiKey: 'k', baseUrl: options.url ?? baseUrl, timeoutMs: options.timeoutMs ?? 2_000, retries: 0 })
      .ask('state', questions);
  } catch (error) {
    assert.ok(error instanceof JevError, `expected a JevError, got ${String(error)}`);
    return error.reason;
  }
  assert.fail('expected the call to fail');
}

test('429 and 529 are both rate limiting: "not now", not "wrong"', async () => {
  assert.equal(await reasonFor((_req, _body, res) => json(res, 429, {})), 'rate_limited');
  assert.equal(await reasonFor((_req, _body, res) => json(res, 529, {})), 'rate_limited');
});

test('other statuses are 4xx or 5xx', async () => {
  assert.equal(await reasonFor((_req, _body, res) => json(res, 401, {})), 'http_4xx');
  assert.equal(await reasonFor((_req, _body, res) => json(res, 422, {})), 'http_4xx');
  assert.equal(await reasonFor((_req, _body, res) => json(res, 503, {})), 'http_5xx');
});

test('a slow answer is a timeout, an unreachable host is network', async () => {
  assert.equal(await reasonFor((_req, _body, res) => { setTimeout(() => json(res, 200, good), 300); },
    { timeoutMs: 50 }), 'timeout');
  // Port 9 on loopback: nothing listens, so the connection is refused.
  assert.equal(await reasonFor(() => {}, { url: 'http://127.0.0.1:9' }), 'network');
});

test('what the gates read must be there — a default would be a decision nobody made', async () => {
  const without = (patch: (body: typeof good) => unknown) =>
    reasonFor((_req, _body, res) => json(res, 200, patch(structuredClone(good))));

  assert.equal(await reasonFor((_req, _body, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not json'); }), 'malformed');
  assert.equal(await without(body => ({ ...body, answers: undefined })), 'malformed');
  assert.equal(await without(body => ({ ...body, answers: { team: body.answers.team } })), 'malformed');
  assert.equal(await without(body => ({ ...body, answers: { ...body.answers, urgent: { noul: 1.4 } } })), 'malformed');
  assert.equal(await without(body => ({ ...body, answers: { ...body.answers, urgent: { noul: '0.9' } } })), 'malformed');
  assert.equal(await without(body => ({
    ...body, answers: { ...body.answers, team: { ...body.answers.team, choice: 'sales' } },
  })), 'malformed', 'a choice that was not offered');
  assert.equal(await without(body => ({
    ...body, answers: { ...body.answers, team: { ...body.answers.team, confidence: undefined } },
  })), 'malformed');
});
