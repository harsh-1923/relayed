// The design under test beside the one that is built.
//
//   WINDOW (window-design.ts, as built before the spike): gate 1 asks about the
//   whole window at once — is there an open need, is it handled, is it social,
//   which agent — and points at one message.
//
//   PER-MESSAGE (here): step 1 asks about EACH person's message on its own —
//   is it a question or a request, has a later message answered it, is it aimed
//   at a named person, is it meant to get an answer — and code picks the newest
//   open one. Step 2 asks which agent fits THAT message. Two calls in sequence,
//   because step 2's state is built from step 1's answer (a dependency the
//   TypeSafe docs call a legitimate reason for a second request).
//
// The live failure that prompted it: a question followed by "yo" and "Excited
// for the launch" scored 0.52 on need as a window and 0.97 on its own.
import type { ChoiceAnswer, NoulAnswer, NoulQuestion, ChoiceQuestion } from '../../apps/server/src/agents/ambient/jev.ts';
import type { Candidate, Line } from '../../apps/server/src/agents/ambient/gates.ts';

/**
 * The bars, by round. Round 1 took the built design's bars as they stood.
 * Round 2 moved each one to where round 1's recorded probabilities separated
 * the cases — see README.md, what round 1 found.
 */
export const ROUNDS = {
  1: { need: 0.65, answered: 0.2, toPerson: 0.2, wants: 0.5, bestAgentConfidence: 0.7, fits: 0.6,
       toSomeoneElse: 0.2, gate2: 'literal' as const },
  2: { need: 0.65, answered: 0.5, toPerson: 0.5, wants: 0.5, bestAgentConfidence: 0, fits: 0.55,
       toSomeoneElse: 0.5, gate2: 'split' as const },
  // Round 3: round 2, plus a check that skips the draft when the question is
  // about a live system's current state — decision 4 was to stay quiet on those,
  // and round 2 spent a draft on each only to hold it back.
  3: { need: 0.65, answered: 0.5, toPerson: 0.5, wants: 0.5, bestAgentConfidence: 0, fits: 0.55,
       toSomeoneElse: 0.5, gate2: 'split' as const, liveState: 0.5 },
};
export type Bars = typeof ROUNDS[1] | typeof ROUNDS[2] | typeof ROUNDS[3];
/**
 * Round 4 is not a design here: it runs the app's own gates, as shipped
 * (apps/server/src/agents/ambient/gates.ts), to prove the build matches what
 * rounds 1–3 measured. Its bars are the app's; `D2` keeps round 2's for the
 * code paths round 4 does not replace.
 */
export const ROUND = ([1, 2, 3, 4].includes(Number(process.env['ROUND'] ?? 4)) ? Number(process.env['ROUND'] ?? 4) : 4) as 1 | 2 | 3 | 4;
export const D2 = { ...ROUNDS[ROUND === 4 ? 2 : ROUND], perMessage: 8 };

export function step1(recent: Line[], judged: number[]): { state: unknown; questions: Record<string, NoulQuestion> } {
  const questions: Record<string, NoulQuestion> = {};
  for (const i of judged) {
    questions[`need_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` asks a question, asks for something, or raises a problem.` };
    questions[`answered_${i}`] = { type: 'noul', instructions: `A message after \`recent[${i}]\` in \`recent\` answers it or says someone is handling it.` };
    questions[`to_person_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` is addressed to a specific named person.` };
    questions[`wants_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` is meant to get an answer from someone — not rhetorical, not said in passing.` };
  }
  return { state: { recent }, questions };
}

export interface Pick { index: number | null; because: string; scores: Record<number, { need: number; answered: number; toPerson: number; wants: number }> }

/** The newest message that is an open question meant for anyone. `null` with the reason the best candidate failed. */
export function pick(answers: Record<string, NoulAnswer>, judged: number[], bars = D2): Pick {
  const scores: Pick['scores'] = {};
  for (const i of judged) {
    scores[i] = { need: answers[`need_${i}`]!.noul, answered: answers[`answered_${i}`]!.noul,
                  toPerson: answers[`to_person_${i}`]!.noul, wants: answers[`wants_${i}`]!.noul };
  }
  const reasons: string[] = [];
  for (const i of [...judged].reverse()) {
    const s = scores[i]!;
    if (s.need <= bars.need) { reasons.push('no_need'); continue; }
    if (s.answered >= bars.answered) { reasons.push('handled'); continue; }
    if (s.toPerson >= bars.toPerson) { reasons.push('directed'); continue; }
    if (s.wants <= bars.wants) { reasons.push('rhetorical'); continue; }
    return { index: i, because: 'open', scores };
  }
  // The most informative reason: a real question that was handled or aimed
  // elsewhere says more than the chatter around it.
  const because = ['handled', 'directed', 'rhetorical'].find(r => reasons.includes(r)) ?? 'no_need';
  return { index: null, because, scores };
}

export function step2(input: {
  room: string; roomSummary: string | null; earlier: Line[]; question: Line; after: Line[]; candidates: Candidate[];
}): { state: unknown; questions: Record<string, NoulQuestion | ChoiceQuestion> } {
  const questions: Record<string, NoulQuestion | ChoiceQuestion> = {
    best_agent: {
      type: 'choice', instructions: 'Which agent in `agents` is best placed to answer `question`?',
      criteria: {
        ...Object.fromEntries(input.candidates.map((c, i) => [c.key, `The agent at \`agents[${i}]\`.`])),
        none: 'No agent here is well placed.',
      },
    },
  };
  if ('liveState' in D2) {
    questions['live_state'] = { type: 'noul', instructions: '`question` asks about the current state of a live system — whether something is down, erroring or happening right now.' };
  }
  input.candidates.forEach((_c, i) => {
    questions[`fits_role_${i}`] = { type: 'noul', instructions: `\`agents[${i}]\` could give a useful answer to \`question\`, going by what it is set up to do (\`agents[${i}].set_up_as\`, \`agents[${i}].described_as\`).` };
    questions[`fits_here_${i}`] = { type: 'noul', instructions: `\`agents[${i}]\` could give a useful answer to \`question\`, going by what it has already done in this chat (\`agents[${i}].done_here\`).` };
  });
  return {
    state: {
      room: input.room,
      ...(input.roomSummary ? { room_summary: input.roomSummary } : {}),
      ...(input.earlier.length ? { earlier: input.earlier } : {}),
      question: input.question,
      ...(input.after.length ? { after: input.after } : {}),
      agents: input.candidates.map(c => ({ handle: c.key, set_up_as: c.setUpAs, described_as: c.describedAs, done_here: c.doneHere })),
    },
    questions,
  };
}

export type Decide2 = { speak: true; candidateIndex: number; fit: number; confidence: number } | { speak: false; because: string; fit: number; confidence: number };

export function decide2(answers: Record<string, NoulAnswer | ChoiceAnswer>, candidates: Candidate[], bars = D2): Decide2 {
  const best = answers['best_agent'] as ChoiceAnswer;
  const index = candidates.findIndex(c => c.key === best.choice);
  const fitOf = (i: number) => Math.max((answers[`fits_role_${i}`] as NoulAnswer).noul, (answers[`fits_here_${i}`] as NoulAnswer).noul);
  if (index < 0) return { speak: false, because: 'no_agent', fit: Math.max(0, ...candidates.map((_c, i) => fitOf(i))), confidence: best.confidence };
  const fit = fitOf(index);
  // Round 2: the Choice only picks WHICH agent. With one agent it is "this one
  // or nobody", which the fit already answers — and its confidence nearly
  // blocked two right answers in round 1. A bar of 0 leaves it to the fit.
  if (best.confidence <= bars.bestAgentConfidence) return { speak: false, because: 'unsure', fit, confidence: best.confidence };
  if (fit <= bars.fits) return { speak: false, because: 'unfit', fit, confidence: best.confidence };
  if ('liveState' in bars && (answers['live_state'] as NoulAnswer | undefined) && (answers['live_state'] as NoulAnswer).noul >= bars.liveState) {
    return { speak: false, because: 'live_state', fit, confidence: best.confidence };
  }
  return { speak: true, candidateIndex: index, fit, confidence: best.confidence };
}

// ── Gate 2, round 2: the draft judged on its own, and "answered meanwhile" apart ──
//
// Round 1's gate 2 asked whether the draft "directly and materially answers"
// the question, with every later message in the same state. It held back a
// right answer ("Yes — the plan is complete, cutover Oct 14" to "are we working
// on it?") at 0.29 — read literally, and diluted by the chatter beside it. On
// the round-1 drafts, "would help" alone passed the deflections too; "helps"
// and "is not mostly a deflection" together got all eleven right.
export const GATE2_SPLIT = {
  useful: '`draft` would help the person who wrote `question`: it answers it, or tells them something specific they need to answer it.',
  deflects: '`draft` mostly says it cannot see, check or know what was asked.',
  handled: 'Someone in `since` has already answered `question` or said they are handling it.',
};
export const GATE2_BARS = { useful: 0.7, deflects: 0.5, handled: 0.5 };

export function gate2Split(question: Line, since: Line[], draft: string) {
  return {
    draft: { state: { question, draft }, questions: {
      useful: { type: 'noul' as const, instructions: GATE2_SPLIT.useful },
      deflects: { type: 'noul' as const, instructions: GATE2_SPLIT.deflects } } },
    handled: { state: { question, since }, questions: {
      handled: { type: 'noul' as const, instructions: GATE2_SPLIT.handled } } },
  };
}

export function decideGate2Split(draft: Record<string, NoulAnswer>, handled: Record<string, NoulAnswer> | null) {
  if (draft['deflects']!.noul >= GATE2_BARS.deflects) return { post: false as const, because: 'deflects' };
  if (draft['useful']!.noul <= GATE2_BARS.useful) return { post: false as const, because: 'not_useful' };
  if (handled && handled['handled']!.noul >= GATE2_BARS.handled) return { post: false as const, because: 'handled' };
  return { post: true as const };
}
