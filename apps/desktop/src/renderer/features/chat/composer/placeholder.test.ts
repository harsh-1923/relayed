import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowComposerPlaceholder } from './placeholder.ts';

const block = (name: string, childCount = 0) => ({ type: { name }, childCount });

test('composer placeholder appears only for the untouched empty paragraph', () => {
  assert.equal(shouldShowComposerPlaceholder({ childCount: 1, firstChild: block('paragraph') }), true);

  for (const structuredEmptyBlock of ['codeBlock', 'blockquote', 'bulletList', 'orderedList']) {
    assert.equal(
      shouldShowComposerPlaceholder({ childCount: 1, firstChild: block(structuredEmptyBlock) }),
      false,
      structuredEmptyBlock,
    );
  }

  assert.equal(
    shouldShowComposerPlaceholder({ childCount: 1, firstChild: block('paragraph', 1) }),
    false,
    'text, a hard break, or a semantic inline node makes the paragraph non-empty',
  );
  assert.equal(
    shouldShowComposerPlaceholder({ childCount: 2, firstChild: block('paragraph') }),
    false,
    'a multi-block document is no longer the default empty document',
  );
});
