// Room names: each step on its own, then together over a real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TextRequest } from '../../shared/claude.ts';
import { LocalStore } from './store.ts';
import {
  canReplaceTitle, clampTitle, createRoomTitles, DEFAULT_ROOM_TITLE, sanitizeTitle, seedTitle, titleContext, TITLE_MODEL,
  type TitlePolicy,
} from './titles.ts';

test('a seed is the first message flattened and cut to fifty characters', () => {
  assert.equal(seedTitle('  Why does\n\nthe sync test flake?  '), 'Why does the sync test flake?');
  const long = seedTitle('a'.repeat(80));
  assert.equal(long?.length, 50);
  assert.ok(long?.endsWith('…'));
  assert.equal(seedTitle('   \n '), null);
  assert.equal(clampTitle('x'.repeat(50)), 'x'.repeat(50));
});

test('an automatic title replaces only the default name or the seed', () => {
  assert.equal(canReplaceTitle(DEFAULT_ROOM_TITLE, null), true);
  assert.equal(canReplaceTitle('Why does it flake?', 'Why does it flake?'), true);
  assert.equal(canReplaceTitle('Flaky sync test', 'Why does it flake?'), false);
  assert.equal(canReplaceTitle('Flaky sync test', null), false);
});

test('a model answer becomes a clean one-line name, or nothing', () => {
  assert.equal(sanitizeTitle({ title: 'Fix flaky sync test' }), 'Fix flaky sync test');
  assert.equal(sanitizeTitle('{"title": "Fix flaky sync test."}'), 'Fix flaky sync test');
  assert.equal(sanitizeTitle('"Fix flaky sync test"\nbecause…'), 'Fix flaky sync test');
  assert.equal(sanitizeTitle({ title: '   ' }), null);
  assert.equal(sanitizeTitle({ title: DEFAULT_ROOM_TITLE }), null);
  assert.equal(sanitizeTitle(42), null);
});

test('a long conversation keeps its latest turns and pins the first message', () => {
  assert.equal(titleContext([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }]), 'USER:\nhi\n\nASSISTANT:\nhello');
  const turns = [
    { role: 'user' as const, text: 'Make the importer resumable' },
    ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'user' as const : 'assistant' as const, text: `${i} ${'x'.repeat(400)}` })),
  ];
  const context = titleContext(turns);
  assert.ok(context.startsWith('USER:\nMake the importer resumable'));
  assert.ok(context.includes('[Earlier messages left out]'));
  assert.ok(context.endsWith('x'.repeat(400)));
  assert.ok(context.length <= 8_000);
});

function harness(answers: (() => Promise<unknown>)[], policy?: TitlePolicy) {
  const root = mkdtempSync(join(tmpdir(), 'relayed-titles-'));
  const store = LocalStore.open(join(root, 'local-rooms.db'));
  const asked: TextRequest[] = [];
  const invalidated: string[][] = [];
  const titles = createRoomTitles({
    store: () => store,
    runner: {
      request: (_op, params) => {
        asked.push(params);
        const next = answers.shift();
        return next ? next().then(output => ({ output })) : Promise.reject(new Error('no answer scripted'));
      },
    },
    invalidate: topics => invalidated.push(topics),
    sleep: () => Promise.resolve(),
    ...(policy ? { policy: () => policy } : {}),
  });
  const { spaceId } = store.createRoom({ cwd: root });
  const name = () => store.room(spaceId)?.name;
  return { store, titles, spaceId, name, asked, invalidated };
}

test('the first message seeds the name at once, and the generated title replaces it', async () => {
  const { titles, spaceId, name, asked, invalidated } = harness([() => Promise.resolve({ title: 'Flaky sync test' })]);
  assert.equal(name(), DEFAULT_ROOM_TITLE);

  const generated = titles.onFirstMessage(spaceId, 'Why does the sync test flake on CI?');
  assert.equal(name(), 'Why does the sync test flake on CI?', 'seeded before the model answers');
  assert.equal(await generated, 'Flaky sync test');
  assert.equal(name(), 'Flaky sync test');
  assert.equal(asked[0]?.model, TITLE_MODEL);
  assert.equal(asked[0]?.input, 'Why does the sync test flake on CI?');
  assert.ok(invalidated.every(topics => topics.includes('local:rooms')));
});

test('a rename while the title is being generated is kept', async () => {
  let answer!: (value: unknown) => void;
  const { titles, spaceId, name } = harness([() => new Promise(resolve => { answer = resolve; })]);
  const generated = titles.onFirstMessage(spaceId, 'Why does it flake?');
  await Promise.resolve();
  titles.rename(spaceId, '  My   own name ');
  answer({ title: 'Flaky sync test' });
  assert.equal(await generated, null);
  assert.equal(name(), 'My own name');
});

test('a failed generation is retried, then gives up and keeps the seed', async () => {
  const fail = () => Promise.reject(new Error('overloaded'));
  const errors: string[] = [];
  const { titles, spaceId, name, asked } = harness([fail, fail, () => Promise.resolve({ title: 'Third time' })]);
  assert.equal(await titles.onFirstMessage(spaceId, 'first'), 'Third time');
  assert.equal(asked.length, 3);

  const again = harness([fail, fail, fail]);
  const withErrors = createRoomTitles({
    store: () => again.store, runner: { request: () => Promise.reject(new Error('overloaded')) },
    invalidate: () => {}, sleep: () => Promise.resolve(), onError: step => errors.push(step),
  });
  assert.equal(await withErrors.onFirstMessage(again.spaceId, 'still seeded'), null);
  assert.equal(again.name(), 'still seeded');
  assert.deepEqual(errors, ['generate']);
  assert.equal(name(), 'Third time');
});

test('each step can be switched off on its own', async () => {
  const noSeed = harness([() => Promise.resolve({ title: 'Generated only' })], { seedFromFirstMessage: false, generateFromFirstMessage: true });
  const pending = noSeed.titles.onFirstMessage(noSeed.spaceId, 'hello there');
  assert.equal(noSeed.name(), DEFAULT_ROOM_TITLE);
  assert.equal(await pending, 'Generated only');

  const seedOnly = harness([], { seedFromFirstMessage: true, generateFromFirstMessage: false });
  assert.equal(await seedOnly.titles.onFirstMessage(seedOnly.spaceId, 'hello there'), 'hello there');
  assert.equal(seedOnly.asked.length, 0);

  const off = harness([], { seedFromFirstMessage: false, generateFromFirstMessage: false });
  await off.titles.onFirstMessage(off.spaceId, 'hello there');
  assert.equal(off.name(), DEFAULT_ROOM_TITLE);
});

test('regenerating reads the conversation and the old name, and ignores a copy of it', async () => {
  const { store, titles, spaceId, name, asked } = harness([
    () => Promise.resolve({ title: 'Resumable importer' }),
    () => Promise.resolve({ title: 'Resumable importer' }),
  ]);
  const chatId = store.rooms()[0]!.chats[0]!.id;
  const { replyId } = store.beginTurn(chatId, 'The importer dies halfway');
  store.finishTurn(replyId, 'acked', [{ kind: 'markdown', text: 'It needs checkpoints.' }]);
  titles.rename(spaceId, 'importer');

  assert.equal(await titles.regenerate(spaceId), 'Resumable importer');
  assert.equal(name(), 'Resumable importer');
  assert.ok(asked[0]?.instructions.includes('"importer"'));
  assert.equal(asked[0]?.input, 'USER:\nThe importer dies halfway\n\nASSISTANT:\nIt needs checkpoints.');

  assert.equal(await titles.regenerate(spaceId), null, 'the same name is not a new one');
  assert.throws(() => titles.rename(spaceId, '   '), /cannot be empty/);
});
