// What a run remembers, and how the block reads (docs/MEMORY.md §7).
//
// The ranking, deduplication and block-building are pure, so they are tested
// without a bank. What a run may READ is `banks.test.ts` — the decision is made
// there, and repeating it here would be two places to keep true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  citationPrompt, citedFacts, cleanFactText, memoryBlock, personPrompt, queryFrom,
  type RecalledFact,
} from './recall.ts';

const fact = (text: string, citation: RecalledFact['citation'] = null): RecalledFact =>
  ({ text, score: 1, citation });

// ─── The query ──────────────────────────────────────────────────────────────

const TRIAGE = 'act_01M2ABCD';

test('the invoked agent’s own mention goes entirely — it is a summons, not a subject', () => {
  // Measured: leaving "triage" in made every fact NAMING Triage a strong match.
  // "triage What day is it today?" topped out at 0.460 on Triage's own
  // autobiography; without the summons the same question tops out at 0.031.
  assert.equal(
    queryFrom('[Triage](actor:act_01M2ABCD) who owns the rollback script?', TRIAGE),
    'who owns the rollback script?');
});

test('somebody ELSE’s mention keeps its name — it is part of what was asked', () => {
  assert.equal(
    queryFrom('[Triage](actor:act_01M2ABCD) what did [Bob](actor:act_01M2BOB) decide?', TRIAGE),
    'what did Bob decide?');
});

test('message and space links are flattened to their labels', () => {
  // Their ids are meaningless tokens; their words are not.
  assert.equal(
    queryFrom('see [the decision](message:msg_01M2X) in [#eng](space:spc_01M2Y)', TRIAGE),
    'see the decision in #eng');
});

test('a bare summons leaves nothing to search for', () => {
  // Previously this became the single word "Triage", which matched every fact
  // naming the agent — the worst possible query.
  assert.equal(queryFrom('[Triage](actor:act_01M2ABCD)', TRIAGE), '');
  assert.equal(queryFrom('   ', TRIAGE), '');
});

// ─── The stored annotation ──────────────────────────────────────────────────

test('Hindsight’s own When and Involving suffixes are dropped for display', () => {
  // The citation already carries the date and the transcript already names the
  // people. Display only — what is STORED is never rewritten (§9).
  assert.equal(
    cleanFactText('Bob owns the rollback script. | When: 2026-09-15 | Involving: Bob Iyer'),
    'Bob owns the rollback script.');
});

test('a trailing clause that is neither is kept — extraction puts rationale there', () => {
  assert.equal(
    cleanFactText('The team rolled back first. | When: 2026-09-15 | A half-finished rebuild is risky.'),
    'The team rolled back first. — A half-finished rebuild is risky.');
});

test('a fact with no annotation is untouched', () => {
  assert.equal(cleanFactText('Bob owns the rollback script.'), 'Bob owns the rollback script.');
});

// ─── The block ──────────────────────────────────────────────────────────────

test('no facts means no block at all, not an empty heading', () => {
  assert.equal(memoryBlock([]), '');
});

test('every fact carries a clickable citation in the renderer’s own link form', () => {
  const block = memoryBlock([
    fact('Bob Iyer owns the rollback script', { messageId: 'msg_01M2AAA', label: 'db-cutover, 19 Sep' }),
  ]);
  assert.match(block, /\[db-cutover, 19 Sep\]\(message:msg_01M2AAA\)/);
});

test('the block says the recollections are stale-able and subordinate', () => {
  // The guard xyne-spaces' finding bought us: injected facts without framing
  // are read as current truth, which is the bias that made them abandon
  // injection entirely.
  const block = memoryBlock([fact('something remembered')]);
  assert.match(block, /may\s*\n?be out of date/);
  assert.match(block, /conversation below overrides them/);
  assert.match(block, /keep its citation/);
});

test('an uncited fact still renders, without a dangling link', () => {
  // Its anchor message was deleted. Dropping the fact would be worse: the
  // forget sweep has not run yet, and the fact itself is still true.
  const block = memoryBlock([fact('something whose anchor is gone')]);
  assert.match(block, /· something whose anchor is gone/);
  assert.ok(!block.includes('message:'));
});

test('the block ends with a blank line, so the transcript starts on its own', () => {
  assert.ok(memoryBlock([fact('a')]).endsWith('\n'));
});

// ─── The person slot (§5.5) ─────────────────────────────────────────────────

test('nothing remembered about a person means no slot at all', () => {
  assert.equal(personPrompt([]), '');
});

test('preferences are given as instructions, not hedged as recollections', () => {
  // The person asked for these to apply. Hedging them the way §7.2 hedges a
  // remembered fact — "may be out of date, the conversation below overrides
  // them" — would be wrong: they are not a recollection about this room.
  const slot = personPrompt(['prefers short answers that lead with the schema']);
  assert.match(slot, /they apply\s*\n?everywhere/);
  assert.match(slot, /- prefers short answers that lead with the schema/);
  assert.ok(!slot.includes('may be out of date'));
});

test('the person slot is not the memory block, and carries no citations', () => {
  // Fusing them would put something that travels between rooms into a block
  // whose every other line is anchored to one.
  const slot = personPrompt(['calls the database "the store"']);
  assert.ok(!slot.includes('What Relayed remembers'));
  assert.ok(!slot.includes('message:'));
});

test('several preferences are listed, in the order given', () => {
  const slot = personPrompt(['short answers', 'lead with the schema', 'never use emoji']);
  assert.match(slot, /- short answers\n- lead with the schema\n- never use emoji/);
});

// ─── What a reply actually drew on (§7.2, and §14.6's metric) ───────────────

const cited = (messageId: string, text = 'a fact'): RecalledFact =>
  ({ text, score: 1, citation: { messageId, label: 'db-cutover, 19 Sep' } });

test('a fact is cited only when the reply kept its link', () => {
  const offered = [cited('msg_A'), cited('msg_B', 'another fact')];
  const reply = 'Bob owns it — see [db-cutover, 19 Sep](message:msg_A).';
  assert.deepEqual(citedFacts(reply, offered).map((fact) => fact.text), ['a fact']);
});

test('a reply that kept no link cites nothing, and that is information', () => {
  // Memory was offered and changed nothing. Under-reporting is the right
  // direction to fail: a footer that over-claims is worse than a quiet one.
  assert.deepEqual(citedFacts('Bob owns it.', [cited('msg_A')]), []);
});

test('an uncitable fact is never counted as used', () => {
  const uncitable: RecalledFact = { text: 'anchor is gone', score: 1, citation: null };
  assert.deepEqual(citedFacts('anchor is gone', [uncitable]), []);
});

test('two facts sharing one anchor are credited once, highest-ranked first', () => {
  // One episode can produce several facts, so a single link would otherwise
  // credit all of them.
  const offered = [cited('msg_A', 'the decision'), cited('msg_A', 'who owns it')];
  const found = citedFacts('see [x](message:msg_A)', offered);
  assert.deepEqual(found.map((fact) => fact.text), ['the decision']);
});

test('a link to a message that was never offered cites nothing', () => {
  assert.deepEqual(citedFacts('see [x](message:msg_ZZZ)', [cited('msg_A')]), []);
});

// ─── The citation rule, placed last (§7.2) ──────────────────────────────────

test('nothing recalled means no citation rule — it would be noise', () => {
  assert.equal(citationPrompt([]), '');
  assert.equal(citationPrompt([{ text: 'x', score: 1, citation: null }]), '');
});

test('the rule names the exact link form, built from a fact actually offered', () => {
  // Concrete beats abstract: the model already writes actor links correctly and
  // literally, so the rule shows the real id it is being asked to copy.
  const rule = citationPrompt([cited('msg_01M4AAA')]);
  assert.match(rule, /\[db-cutover, 19 Sep\]\(message:msg_01M4AAA\)/);
  assert.match(rule, /END THAT SENTENCE/);
  assert.match(rule, /character for character/);
});

test('the rule leans on actor links, which already work', () => {
  const rule = citationPrompt([cited('msg_01M4AAA')]);
  assert.match(rule, /\[Name\]\(actor-ref:act_…\)/);
});

test('the rule refuses invented links and citing the current conversation', () => {
  const rule = citationPrompt([cited('msg_01M4AAA')]);
  assert.match(rule, /Never invent a link/);
  assert.match(rule, /never cite the conversation you are\s*\n?\s*already in/);
});

test('an uncitable fact never becomes the example', () => {
  const rule = citationPrompt([
    { text: 'anchor gone', score: 2, citation: null },
    cited('msg_01M4BBB'),
  ]);
  assert.match(rule, /message:msg_01M4BBB/);
});

test('the block says the list is ordered, and warns what ordering does not mean', () => {
  // The sort was always there; the model had no reason to know it. And a close
  // match is not a true one — a fact can share every word and still be wrong.
  const block = memoryBlock([fact('strongest'), fact('weakest')]);
  assert.match(block, /ORDERED STRONGEST MATCH FIRST/);
  assert.match(block, /may have\s*\n?nothing to do with what was asked/);
  assert.match(block, /not the same as\s*\n?being true/);
  assert.ok(block.indexOf('strongest') < block.indexOf('weakest'), 'rendered in the order given');
});
