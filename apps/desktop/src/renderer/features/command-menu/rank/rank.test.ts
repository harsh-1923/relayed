import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankKeywords } from './rank.ts';

test('an empty search keeps every row', () => {
  assert.equal(rankKeywords('  ', ['anything']), 1);
});

test('ranks human keywords without letting unrelated words match', () => {
  assert.equal(rankKeywords('swat', ['Apps', 'integrations', 'connectors']), 0);
  assert.ok(rankKeywords('swat', ['swat', 'channel']) > 0);
  assert.equal(rankKeywords('direct', ['People', 'members']), 0);
  assert.ok(rankKeywords('DIRECT harsh', ['Harsh Sharma', 'direct message', 'dm']) > 0);
});

test('an exact or leading match outranks one inside the text', () => {
  const exact = rankKeywords('general', ['General']);
  const leading = rankKeywords('gen', ['General', 'channel']);
  const word = rankKeywords('chan', ['General', 'channel']);
  const inside = rankKeywords('era', ['General', 'channel']);
  assert.ok(exact > leading && leading > word && word > inside && inside > 0);
});
