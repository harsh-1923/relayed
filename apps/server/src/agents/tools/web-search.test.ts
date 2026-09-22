// What we send Parallel, and what we let back into a run (web-search.ts).
//
// `fetch` is stubbed rather than called: the assertions worth making here are
// about the REQUEST WE BUILD and the shape we map back, both of which are ours.
// Nothing here proves Parallel answers as documented — no key is configured in
// the test environment, and a test that called the real endpoint would bill us
// per run of the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSearch, WEB_SEARCH } from './web-search.ts';
import { handleAppTool } from './index.ts';
import { env } from '../../env.ts';

type Args = Record<string, unknown>;
const run = { runId: 'run_1', toolCallId: 'call_1', chatId: 'cht_1',
              invokerActorId: 'act_1', agentActorId: 'act_2', chainDepth: 0 };
const deps = {} as Parameters<typeof webSearch.handle>[0];

/** Answer the next `fetch` with this, and hand back what the tool asked for. */
async function searching(response: { status?: number; body?: unknown }, args: Args) {
  const original = globalThis.fetch;
  let sent: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.body ?? {},
    } as Response;
  }) as typeof fetch;
  try {
    const reply = await webSearch.handle(deps, run, args);
    return { reply, sent: sent as { url: string; init: RequestInit } | null };
  } finally {
    globalThis.fetch = original;
  }
}

/** The JSON we actually sent. `body` is always a string here — `search` builds it with JSON.stringify. */
const body = (sent: { init: RequestInit } | null) =>
  JSON.parse((sent?.init.body ?? '{}') as string) as Record<string, any>;

const oneResult = {
  results: [{ url: 'https://linear.app/pricing', title: 'Pricing', publish_date: '2026-08-01',
              excerpts: ['Business is $14 per user per month.'] }],
};

test('the objective and the queries both reach Parallel, under our budget', async () => {
  const { reply, sent } = await searching({ body: oneResult }, {
    objective: 'what Linear charges per seat on its Business plan',
    queries: ['Linear pricing per seat', 'Linear Business plan cost'],
  });

  assert.equal(reply.result, 'ok');
  assert.equal(sent?.init.method, 'POST');
  const request = body(sent);
  assert.equal(request['objective'], 'what Linear charges per seat on its Business plan');
  assert.deepEqual(request['search_queries'], ['Linear pricing per seat', 'Linear Business plan cost']);

  // The budget is ours, never the model's: it names none of these.
  assert.equal(request['mode'], 'fast');
  assert.ok(request['max_chars_total'] < 32_768, 'stays under the broker result cap');
  // Exactly what the base price includes; the eleventh result is billed.
  assert.equal(request['advanced_settings']['max_results'], 10);
  assert.equal(request['advanced_settings']['excerpt_settings']['max_chars_per_result'], 3_000);
});

test('a result keeps its url, title, date and text', async () => {
  const { reply } = await searching({ body: oneResult }, { objective: 'Linear pricing', queries: ['Linear pricing'] });
  const data = reply.data as { sources: { url: string; title: string; published?: string; excerpts: string[] }[] };
  assert.deepEqual(data.sources, [{
    title: 'Pricing', url: 'https://linear.app/pricing', published: '2026-08-01',
    excerpts: ['Business is $14 per user per month.'],
  }]);
});

test('a result with no url or no text is dropped rather than carried', async () => {
  // Either way it is weight in the context for no answer.
  const { reply } = await searching({ body: { results: [
    { url: '', excerpts: ['orphaned text'] },
    { url: 'https://example.com/empty', excerpts: [] },
    { url: 'https://example.com/good', excerpts: ['something'] },
  ] } }, { objective: 'anything', queries: ['anything'] });
  const data = reply.data as { sources: { url: string }[] };
  assert.deepEqual(data.sources.map(source => source.url), ['https://example.com/good']);
});

test('a title falls back to the url, and a missing date is simply absent', async () => {
  const { reply } = await searching({ body: { results: [
    { url: 'https://example.com/x', title: null, publish_date: null, excerpts: ['text'] },
  ] } }, { objective: 'anything', queries: ['anything'] });
  const [source] = (reply.data as { sources: Record<string, unknown>[] }).sources;
  assert.equal(source!['title'], 'https://example.com/x');
  assert.ok(!('published' in source!), 'no empty date reaches the model');
});

test('finding nothing is an answer, and says not to pretend otherwise', async () => {
  const { reply } = await searching({ body: { results: [] } }, { objective: 'anything', queries: ['anything'] });
  assert.equal(reply.result, 'ok');
  const data = reply.data as { sources: unknown[]; note: string };
  assert.deepEqual(data.sources, []);
  assert.match(data.note, /Nothing was found/);
});

test('`within` becomes an after_date we compute, and an unknown window is dropped', async () => {
  // The model reasons in windows; a model doing date arithmetic silently
  // discards the best answers when it gets it wrong.
  const { sent } = await searching({ body: oneResult },
    { objective: 'anything', queries: ['anything'], within: 'week' });
  const after = body(sent)['advanced_settings']['source_policy']['after_date'] as string;
  assert.match(after, /^\d{4}-\d{2}-\d{2}$/);
  const days = (Date.now() - Date.parse(after)) / 86_400_000;
  assert.ok(days > 6 && days < 8, `a week back, got ${days} days`);

  const { sent: loose } = await searching({ body: oneResult },
    { objective: 'anything', queries: ['anything'], within: 'fortnight' });
  assert.ok(!('source_policy' in body(loose)['advanced_settings']), 'an unknown window costs no turn');
});

test('more queries than Parallel wants are capped, and empty ones dropped', async () => {
  const { sent } = await searching({ body: oneResult }, {
    objective: 'anything',
    queries: ['one', '  ', 'two', 'three', 'four', 'five'],
  });
  assert.deepEqual(body(sent)['search_queries'], ['one', 'two', 'three', 'four']);
});

test('a search with no objective or no queries is refused before it costs anything', async () => {
  for (const args of [{ queries: ['x'] }, { objective: 'x' }, { objective: 'x', queries: [] }, {}]) {
    const { reply, sent } = await searching({ body: oneResult }, args);
    assert.equal(reply.result, 'failed', JSON.stringify(args));
    assert.equal(sent, null, 'nothing was sent, so nothing was billed');
  }
});

test('each refusal tells the model something it can act on', async () => {
  for (const [status, expected] of [[429, /rate-limited/], [401, /not configured/], [403, /not configured/],
                                    [422, /would not accept/], [500, /failed \(500\)/]] as const) {
    const { reply } = await searching({ status }, { objective: 'x', queries: ['x'] });
    assert.equal(reply.result, 'failed');
    assert.match(reply.message!, expected);
    // Every one of them ends the same way: answer anyway, do not stall.
    assert.match(reply.message!, /answer from what you have/);
  }
});

test('the search is unreachable without a key, whatever the model calls', async () => {
  // The offer is the authorisation (index.ts): an unconfigured deployment does
  // not merely omit the tool from the list, it refuses the call.
  assert.equal(webSearch.definition({ inRoom: true, isRoomkeeper: false }) === null, !env.parallelApiKey);
  if (env.parallelApiKey) return;
  const refused = await handleAppTool(WEB_SEARCH, deps, run, { inRoom: true, isRoomkeeper: false }, { objective: 'x', queries: ['x'] });
  assert.deepEqual(refused, { result: 'tool_not_allowed' });
});
