// What reaches Jev, and what code concludes from its answers
// (docs/AMBIENT-RESPONSES.md, the Jev calls §7). No network: the answers are
// written here, which is the point — each rule is checked against the answer
// that should trip it, most of them the spike's own numbers (spikes/ambient).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChoiceAnswer, NoulAnswer } from './jev.ts';
import {
  THRESHOLDS, agentCheck, answeredMeanwhile, candidate, cleanDraft, decideAgent, decideDraft, decideFollowUp, decideOffer,
  draftCheck, fitOf, judgeTurn, messageCheck, offerCheck, offerText, plainText, readDraft, toolkitKnown, type AgentCheckInput,
} from './gates.ts';

const line = (text: string, from = 'Alice Chen') => ({ from, at: '2026-09-23T14:31:02Z', text });
const noul = (value: number): NoulAnswer => ({ noul: value });
const choice = (value: string, confidence = 0.9): ChoiceAnswer => ({ choice: value, probabilities: { [value]: 0.9 }, confidence });

type Score = 'need' | 'answered' | 'to_person' | 'wants' | 'person' | 'sensitive' | 'plan';
/** Step-1 answers for message `i`: an open question unless overridden. */
const scores = (i: number, s: Partial<Record<Score, number>> = {}) => ({
  [`need_${i}`]: noul(s.need ?? 0.97), [`answered_${i}`]: noul(s.answered ?? 0.06),
  [`to_person_${i}`]: noul(s.to_person ?? 0.05), [`wants_${i}`]: noul(s.wants ?? 0.85),
  [`person_${i}`]: noul(s.person ?? 0.05), [`sensitive_${i}`]: noul(s.sensitive ?? 0.02), [`plan_${i}`]: noul(s.plan ?? 0.03),
});

test('links read as what they say; ids never reach the gate', () => {
  assert.equal(plainText('ask [Bob](actor:act_01) about [the plan](message:msg_02)'), 'ask @Bob about the plan');
  assert.equal(plainText('[@Bob](actor:act_01) hi'), '@Bob hi');
  assert.ok(plainText('x'.repeat(5_000)).length <= 1_001, 'a line is clipped');
});

// ─── Step 1 ─────────────────────────────────────────────────────────────────

test('step 1 asks seven things about each judged message, and nothing about the rest', () => {
  const recent = [line('is staging down?'), line('yes, restarting', 'Triage'), line('where is the runbook?', 'Carol')];
  const { state, questions } = messageCheck(recent, [0, 2]);
  assert.deepEqual(Object.keys(questions).sort(), [
    'answered_0', 'answered_2', 'need_0', 'need_2', 'person_0', 'person_2', 'plan_0', 'plan_2',
    'sensitive_0', 'sensitive_2', 'to_person_0', 'to_person_2', 'wants_0', 'wants_2']);
  assert.match(JSON.stringify(questions['answered_2']), /after `recent\[2\]`.*gives what `recent\[2\]` asks for, with confidence/);
  assert.match(JSON.stringify(questions['answered_2']), /not a guess, an \\"I think\\" or an \\"idk\\"/, '"i guess 5th? idk" is not an answer');
  assert.deepEqual(state, { recent }, 'the whole window is there, so "answered by a later message" can see it');
});

test('a turn is open when any of its messages is — the clarifier travels with the question', () => {
  // S07: "how do I rotate the vault token?", "for staging I mean".
  const answers = { ...scores(0), ...scores(1, { need: 0.33, wants: 0.69 }) };
  assert.deepEqual(judgeTurn(answers, [0, 1]).open, [0]);
  // T02: two questions back to back are both open, and answered together.
  assert.deepEqual(judgeTurn({ ...scores(0), ...scores(1) }, [0, 1]).open, [0, 1]);
});

test('"gives what it asks for", not "the same topic": the bar the spike moved', () => {
  assert.deepEqual(judgeTurn(scores(0, { answered: 0.28 }), [0]).open, [0], '"no idea, haven\'t checked"');
  assert.deepEqual(judgeTurn(scores(0, { answered: 0.91 }), [0]), { open: [], because: 'handled', scores: judgeTurn(scores(0, { answered: 0.91 }), [0]).scores },
    '"Sending, one sec"');
});

test('a sensitive ask silences the whole turn; a plan or something only a person can give stays quiet', () => {
  assert.equal(judgeTurn({ ...scores(0), ...scores(1, { sensitive: 0.92 }) }, [0, 1]).because, 'sensitive',
    'the other line is open, and still nothing is said');
  assert.equal(judgeTurn(scores(0, { person: 0.95 }), [0]).because, 'needs_person', 'a review');
  assert.equal(judgeTurn(scores(0, { person: 0.93 }), [0]).because, 'needs_person', '"thoughts?" on a status update');
  assert.equal(judgeTurn(scores(0, { plan: 0.97 }), [0]).because, 'plan', '"Triage the deploy failures first"');
  assert.deepEqual(judgeTurn(scores(0, { person: 0.25, plan: 0.09, sensitive: 0.14 }), [0]).open, [0], 'a real question');
});

test('silence names the most telling reason', () => {
  assert.equal(judgeTurn({ ...scores(0, { answered: 0.98 }), ...scores(1, { need: 0.04 }) }, [0, 1]).because, 'handled');
  assert.equal(judgeTurn(scores(0, { to_person: 0.98 }), [0]).because, 'directed');
  assert.equal(judgeTurn(scores(0, { wants: 0.22 }), [0]).because, 'rhetorical', 'venting');
  assert.equal(judgeTurn({ ...scores(0, { need: 0.02 }), ...scores(1, { need: 0.03 }) }, [0, 1]).because, 'no_need');
});

test('each step-1 bar trips at its value, not past it', () => {
  assert.equal(judgeTurn(scores(0, { need: THRESHOLDS.need }), [0]).open.length, 0);
  assert.equal(judgeTurn(scores(0, { answered: THRESHOLDS.answered }), [0]).open.length, 0);
  assert.equal(judgeTurn(scores(0, { to_person: THRESHOLDS.toPerson }), [0]).open.length, 0);
  assert.equal(judgeTurn(scores(0, { wants: THRESHOLDS.wants }), [0]).open.length, 0);
  assert.equal(judgeTurn(scores(0, { person: THRESHOLDS.needsPerson }), [0]).open.length, 0);
  assert.equal(judgeTurn(scores(0, { sensitive: THRESHOLDS.sensitive }), [0]).open.length, 0);
  assert.equal(judgeTurn(scores(0, { plan: THRESHOLDS.plan }), [0]).open.length, 0);
});

// ─── Step 2 ─────────────────────────────────────────────────────────────────

const triage = candidate({ handle: 'triage', name: 'Triage', instructions: 'You are a on call assistant', description: 'Triage agent for SWAT', recent: ['Created the deck.'] });
const scribe = candidate({ handle: 'scribe', name: 'Scribe', instructions: 'You write release notes.', description: '', recent: [] });
const input: AgentCheckInput = {
  room: '#db-cutover', roomSummary: 'The index is being rebuilt.', earlier: [line('morning', 'Bob Iyer')],
  question: line('where does the rollback runbook live?\nfor the cutover I mean'), after: [line('no idea', 'Bob Iyer')], candidates: [triage, scribe],
};

test('step 2 asks which agent, and two fits for each, about the turn alone', () => {
  const { state, questions } = agentCheck(input);
  assert.deepEqual(Object.keys(questions).sort(), ['best_agent', 'fits_here_0', 'fits_here_1', 'fits_role_0', 'fits_role_1']);
  const best = questions['best_agent'];
  assert.deepEqual(Object.keys(best?.type === 'choice' ? best.criteria : {}), ['@triage', '@scribe', 'none']);
  assert.match(JSON.stringify(questions['fits_role_1']), /`agents\[1\]\.set_up_as`/);
  assert.match(JSON.stringify(questions['fits_role_1']), /could help with `question` — answer it, or know where the answer would be found/,
    'a lookup inside its role fits an agent');
  assert.match(JSON.stringify(questions['fits_here_0']), /`agents\[0\]\.done_here`/);
  assert.match(JSON.stringify(questions['fits_role_0']), /Read `question` with `earlier` for what it refers to/, 'a nudge means the question it nudges');
  const s = state as Record<string, unknown>;
  assert.deepEqual(s['question'], input.question);
  assert.deepEqual(s['after'], input.after, 'what came after the turn travels with it');
  assert.equal(s['recent'], undefined, 'not the window: the turn, and what surrounds it');

  assert.doesNotMatch(JSON.stringify(agentCheck({ ...input, earlier: [] }).questions['fits_role_0']), /earlier/, 'nothing before it, nothing to read it with');
  const bare = agentCheck({ ...input, roomSummary: null, earlier: [], after: [] }).state as Record<string, unknown>;
  assert.equal(bare['room_summary'], undefined);
  assert.equal(bare['earlier'], undefined);
  assert.equal(bare['after'], undefined);
});

test('an agent is read from what it has — a blank description falls back to its name, all of it clipped', () => {
  const long = candidate({ handle: 'x', name: 'X', instructions: 'y'.repeat(2_000), description: '  ', recent: ['[Bob](actor:act_1) ' + 'z'.repeat(500)] });
  assert.ok(long.setUpAs.length <= 501);
  assert.equal(long.describedAs, 'X');
  assert.ok(long.doneHere[0]!.startsWith('@Bob') && long.doneHere[0]!.length <= 200);
});

const agentAnswers = (best: string, fits: Record<number, [number, number]>) => ({
  best_agent: choice(best),
  ...Object.fromEntries(Object.entries(fits).flatMap(([i, [role, here]]) => [[`fits_role_${i}`, noul(role)], [`fits_here_${i}`, noul(here)]])),
});

test('the best fit that passes speaks — either fit is enough', () => {
  // No description, thin instructions, but it built the sync-engine deck here.
  assert.deepEqual(decideAgent(agentAnswers('@triage', { 0: [0.2, 0.88], 1: [0.1, 0.1] }), [triage, scribe]),
    { speak: true, candidateIndex: 0, fit: 0.88 });
  // An on-call question for the on-call agent that has only made slides here.
  assert.equal(decideAgent(agentAnswers('@triage', { 0: [0.6, 0.2], 1: [0.1, 0.1] }), [triage, scribe]).speak, true);
  assert.equal(fitOf(agentAnswers('@scribe', { 0: [0.1, 0.1], 1: [0.93, 0.67] }), 1), 0.93);
});

test('Jev\'s pick only breaks a tie — the two answers it lost', () => {
  // "When does 0.0.2 launch?": picked Triage at 0.54, Scribe fit 0.62.
  assert.deepEqual(decideAgent(agentAnswers('@triage', { 0: [0.54, 0.3], 1: [0.62, 0.1] }), [triage, scribe]),
    { speak: true, candidateIndex: 1, fit: 0.62 });
  // "Who owns the rollback script?": picked none, Triage fit 0.63.
  assert.deepEqual(decideAgent(agentAnswers('none', { 0: [0.63, 0.2], 1: [0.1, 0.1] }), [triage, scribe]),
    { speak: true, candidateIndex: 0, fit: 0.63 });
  // A tie: the pick wins among the tied.
  assert.deepEqual(decideAgent(agentAnswers('@scribe', { 0: [0.8, 0.1], 1: [0.77, 0.1] }), [triage, scribe]), { speak: true, candidateIndex: 1, fit: 0.77 });
  assert.deepEqual(decideAgent(agentAnswers('@scribe', { 0: [0.8, 0.1], 1: [0.7, 0.1] }), [triage, scribe]), { speak: true, candidateIndex: 0, fit: 0.8 }, 'not a tie');
  // Round 5d: a tie with an agent under the bar is no tie — the pick fell on it, and the room went silent.
  assert.deepEqual(decideAgent(agentAnswers('@scribe', { 0: [0.56, 0.1], 1: [0.53, 0.1] }), [triage, scribe]), { speak: true, candidateIndex: 0, fit: 0.56 });
});

test('nobody fits well enough — lunch, leave policy, snacks, bait', () => {
  assert.deepEqual(decideAgent(agentAnswers('none', { 0: [0.13, 0.17], 1: [0.1, 0.1] }), [triage, scribe]),
    { speak: false, because: 'unfit', fit: 0.17 });
  assert.deepEqual(decideAgent(agentAnswers('@triage', { 0: [0.48, 0.37], 1: [0.1, 0.1] }), [triage, scribe]),
    { speak: false, because: 'unfit', fit: 0.48 }, 'bait: the pick leans to Triage, the fit says no');
  assert.equal(decideAgent(agentAnswers('@triage', { 0: [THRESHOLDS.fits, 0.1], 1: [0.1, 0.1] }), [triage, scribe]).speak, false,
    'the bar trips at its value');
  assert.equal(decideAgent(agentAnswers('none', {}), []).speak, false);
});

// ─── The draft: how it is read ──────────────────────────────────────────────

test('a draft is an answer, an offer, both, or nothing — the offer as its last line', () => {
  assert.deepEqual(readDraft('Yes — Oct 14.'), { kind: 'answer', text: 'Yes — Oct 14.' });
  assert.deepEqual(readDraft('OFFER: the open sync bugs | Linear'), { kind: 'offer', what: 'the open sync bugs', toolkit: 'Linear' });
  assert.deepEqual(readDraft('Yes — Oct 14, and HAR-24 is the last blocker.\n\nOFFER: the open cutover tickets | Jira.'),
    { kind: 'answer_offer', text: 'Yes — Oct 14, and HAR-24 is the last blocker.', what: 'the open cutover tickets', toolkit: 'Jira' });
  assert.deepEqual(readDraft('NOTHING'), { kind: 'nothing' });
  assert.deepEqual(readDraft('NO_CONTENT'), { kind: 'nothing' }, 'a decline the model spelled its own way');
  assert.deepEqual(readDraft('  '), { kind: 'nothing' });
});

test('an offer written mid-paragraph is still an offer, and never reaches the room in the model\'s words', () => {
  // Round 5e: the model put it inline, and a line-only reading posted it as part of the answer.
  assert.deepEqual(readDraft('Prod appears impacted, but no cause is established so far. OFFER: current incidents, deploys | Slack'),
    { kind: 'answer_offer', text: 'Prod appears impacted, but no cause is established so far.', what: 'current incidents, deploys', toolkit: 'Slack' });
  assert.deepEqual(readDraft('No cause yet.\nOFFER: nothing useful'), { kind: 'answer', text: 'No cause yet.' }, 'a malformed offer is dropped');
  assert.deepEqual(readDraft('OFFER: no pipe here'), { kind: 'nothing' });
});

test('an answer gets nobody\'s attention: links become references, and it is clipped', () => {
  assert.equal(cleanDraft('Ask [Bob](actor:act_1).'), 'Ask [Bob](actor-ref:act_1).');
  assert.ok(cleanDraft('x'.repeat(7_000))!.length <= 6_001);
  assert.equal(offerText('the open sync bugs', 'Linear'), 'I can look up the open sync bugs in Linear for you. Mention me if you want me to.');
});

// ─── The draft check ────────────────────────────────────────────────────────

test('the draft is judged on its own, "answered meanwhile" apart, and an offer on its own', () => {
  const onDraft = draftCheck(line('are we working on the sync engine?'), 'Yes — the plan is complete.');
  assert.deepEqual(Object.keys(onDraft.questions), ['useful', 'deflects']);
  assert.deepEqual(Object.keys(onDraft.state as object), ['question', 'draft'], 'no later chatter beside the draft');
  const onSince = answeredMeanwhile(line('why?'), [line('it\'s the vacuum', 'Bob Iyer')]);
  assert.deepEqual(Object.keys(onSince.questions), ['handled']);
  const onOffer = offerCheck(line('how many sync bugs are open?'), 'the open sync bugs', 'Linear');
  assert.deepEqual(Object.keys(onOffer.questions), ['kept_there', 'asks_info', 'fits']);
  assert.deepEqual((onOffer.state as { offer: unknown }).offer, { look_up: 'the open sync bugs', with: 'Linear' });
});

test('a draft posts only when it helps and is not a deflection, and nobody got there first', () => {
  const draft = (useful: number, deflects: number) => ({ useful: noul(useful), deflects: noul(deflects) });
  assert.deepEqual(decideDraft(draft(0.85, 0.07), null), { post: true });
  assert.deepEqual(decideDraft(draft(0.81, 0.87), null), { post: false, because: 'deflects' },
    '"I can\'t see the logs from here" — helps 0.81 alone would have passed it');
  assert.deepEqual(decideDraft(draft(0.03, 0.2), null), { post: false, because: 'not_useful' }, 'the NO_CONTENT the model once wrote');
  assert.deepEqual(decideDraft(draft(0.85, 0.07), { handled: noul(0.91) }), { post: false, because: 'handled' });
  assert.deepEqual(decideDraft(draft(0.85, 0.07), { handled: noul(0.03) }), { post: true });
});

test('an offer must name where the thing is kept, for a message that asks for information', () => {
  const offer = (kept: number, asks: number, fits: number) => ({ kept_there: noul(kept), asks_info: noul(asks), fits: noul(fits) });
  const toolkits = ['Linear', 'GitHub', 'Slack'];
  assert.equal(decideOffer(offer(0.76, 0.9, 0.73), 'Linear', toolkits, false), null, 'Linear for Linear bugs');
  assert.equal(decideOffer(offer(0.23, 0.97, 0.82), 'Slack', toolkits, false), 'not_kept_there', 'Slack for "is staging down"');
  assert.equal(decideOffer(offer(0.65, 0.07, 0.69), 'GitHub', toolkits, false), 'not_info', '"let\'s triage the flaky tests"');
  assert.equal(decideOffer(offer(0.8, 0.9, 0.5), 'Linear', toolkits, false), 'offer_misfits');
  assert.equal(decideOffer(offer(0.8, 0.9, 0.8), 'Grafana', toolkits, false), 'unknown_toolkit', 'nothing connected can see it');
  assert.equal(decideOffer(offer(0.8, 0.9, 0.8), 'Linear', toolkits, true), 'handled');
  assert.ok(toolkitKnown('google drive', ['Google Drive']) && toolkitKnown('GoogleDrive', ['Google Drive']));
});

// ─── Follow-ups ─────────────────────────────────────────────────────────────

test('a follow-up is for the agent unless it is to someone else — the bar the spike moved', () => {
  assert.equal(decideFollowUp({ to_agent: noul(0.96), to_someone_else: noul(0.24) }), true,
    '"can we run them in parallel instead?" — turned away at the old 0.2');
  assert.equal(decideFollowUp({ to_agent: noul(0.26), to_someone_else: noul(0.96) }), false, 'to Bob');
  assert.equal(decideFollowUp({ to_agent: noul(THRESHOLDS.toAgent), to_someone_else: noul(0.1) }), false);
});
