import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolkitSummary } from '../../../preload/api';
import { createToolkitSearch } from './search.ts';

const github: ToolkitSummary = {
  slug: 'github',
  name: 'GitHub',
  description: 'Manage repositories, issues, and pull requests.',
  categories: ['Developer tools'],
  authScheme: 'oauth2',
  deprecated: false,
};

test('an empty search keeps a toolkit visible', () => {
  assert.deepEqual(createToolkitSearch([github])('  '), [github]);
});

test('searches name, slug, description, and categories', () => {
  for (const search of ['GitHub', 'git', 'repositories', 'developer']) {
    assert.deepEqual(createToolkitSearch([github])(search), [github], search);
  }
});

test('fuzzy matching accepts an ordered abbreviation but not unrelated text', () => {
  const search = createToolkitSearch([github]);
  assert.deepEqual(search('gthb'), [github]);
  assert.deepEqual(search('calendar'), []);
});

test('every term in a multi-word search must match', () => {
  const search = createToolkitSearch([github]);
  assert.deepEqual(search('github issue'), [github]);
  assert.deepEqual(search('github calendar'), []);
});

test('strong matches appear before fuzzy matches', () => {
  const gifted = { ...github, slug: 'gifted', name: 'Gifted' };
  assert.deepEqual(createToolkitSearch([gifted, github])('git'), [github, gifted]);
});
