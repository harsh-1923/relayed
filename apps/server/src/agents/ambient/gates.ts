// The questions Jev is asked, and what code decides from the answers
// (docs/AMBIENT-RESPONSES.md, the Jev calls §7).
//
// PURE: no database, no network. What reaches Jev and what is concluded from
// its answer are the two halves worth testing, and both are tested here without
// either.
//
// A TURN, EACH MESSAGE ON ITS OWN, THEN WHICH AGENT. The first design asked
// about the whole window at once, and every unrelated message pulled its answer
// toward "no": a question followed by "yo" scored 0.52 for an open need as a
// window and 0.97 on its own. So each of a person's messages is judged on its
// own; a turn — what one person said in a row — is open when any of them is an
// open question; and one agent is picked for the turn. The spike
// (spikes/ambient) measured the design at 191 of 201 runs right, and nothing
// said that should not have been (rounds 5–5c).
//
// THE POLICY IS HERE, NOT IN THE WORDING. Each question asks for one narrow
// judgment and the thresholds combine them, so tuning is changing a number in
// `THRESHOLDS` rather than rewording a prompt (§7.1). The wording matters too —
// Jev 1.13 reads literally (§7.6) — so each instruction names the exact
// condition and the state field it is about, in backticks.
import type { ChoiceAnswer, ChoiceQuestion, NoulAnswer, NoulQuestion } from './jev.ts';

/**
 * Every bar sits where the spike's recorded probabilities separated the cases
 * (spikes/ambient/README.md) — not at a round number, and never reused across
 * question types, which are not comparable (§7.3).
 */
export const THRESHOLDS = {
  // ── Step 1: each message of a turn (`messageCheck`, `judgeTurn`) ──
  /** Asks something. Questions scored 0.93–0.99; chatter and statements 0.34 and below. */
  need: 0.65,
  /** Already given what it asks for, with confidence. Real answers 0.91–0.98; "no idea, haven't checked" 0.28; "i guess 5th? idk" 0.04. */
  answered: 0.5,
  /** Addressed to a named person. 0.98 when it was; open questions 0.16 and below. */
  toPerson: 0.5,
  /** Meant to get an answer. Real questions 0.72–0.93; venting 0.22, a joke 0.28. */
  wants: 0.5,
  /** Something only a person can give. A review 0.95, "thoughts?" 0.93; questions to answer 0.03–0.25. */
  needsPerson: 0.5,
  /** Personal or sensitive. Layoffs 0.92, pay 0.84, someone's health 0.96; everything else 0.14 and below. */
  sensitive: 0.5,
  /** A plan or an instruction for the team. "Triage the deploy failures first" 0.97; questions under 0.1. */
  plan: 0.5,

  // ── Step 2: which agent (`agentCheck`, `decideAgent`) ──
  /**
   * The higher of an agent's two fits (`fitOf`). Questions an agent should take
   * scored 0.75–0.93; questions none should take — lunch, leave policy, snacks,
   * bait — 0.14–0.48. The best fit that passes speaks; Jev's own pick only
   * breaks a tie (finding 17: it picked 0.54 over 0.62, and nobody answered).
   * Since "could help — answer it, or know where the answer would be found"
   * (round 5e), a lookup inside an agent's role fits it — the Linear count an
   * on-call agent fit at 0.48–0.54 — and no quiet case started to.
   */
  fits: 0.55,
  /** Fits this close are a tie, and the Choice breaks it. */
  fitTie: 0.05,

  // ── The draft check (`draftCheck`, `answeredMeanwhile`) ──
  /** Helps the asker. Good drafts 0.77–0.93 — but deflections scored 0.80 too, so it never decides alone. */
  useful: 0.7,
  /** Mostly says it cannot see or know. Good drafts 0.05–0.12; deflections 0.63–0.91. */
  deflects: 0.5,
  /** Someone answered while it was drafting. 0.91 when Bob did. */
  answeredMeanwhile: 0.5,

  // ── The offer check (`offerCheck`, `decideOffer`) ──
  /** The tool is where the thing is kept. Linear for Linear bugs 0.74–0.78; Slack for "is staging down" 0.23–0.27. */
  offerKeptThere: 0.7,
  /** The message asks for information. "let's triage the flaky tests" 0.07. */
  offerAsksInfo: 0.5,
  /** Looking it up would answer the question. */
  offerFits: 0.7,

  // ── Follow-ups (`followUp`) ──
  toAgent: 0.8,
  /** To someone else. To Bob 0.96; to the agent 0.11–0.34 — the old 0.2 turned away a real follow-up at 0.24. */
  toSomeoneElse: 0.5,
} as const;

/** Characters of one message Jev is shown. The rest adds tokens and distraction, not judgment. */
const LINE_CHARS = 1_000;
/** Characters of the room summary. It is context, and a long one crowds the conversation (§7.6). */
const SUMMARY_CHARS = 4_000;

export interface Line {
  from: string;
  /** ISO timestamp. */
  at: string;
  text: string;
}

/**
 * An agent in the room, as the agent check reads it.
 *
 * BUILT FROM WHAT EXISTS WITHOUT ANYONE WRITING IT. The one-line description is
 * mostly blank or vague — the first live agent's read "Triage agent for SWAT",
 * and a sync-engine question in a room where it had just built the sync-engine
 * deck scored 0.53 against it. So the fit is judged from two things every agent
 * has: what it was set up to do (its instructions, which are required) and what
 * it has already said in this chat. The same question scored 0.88.
 */
export interface Candidate {
  /** `@handle` — also the option key in `best_agent`, which cannot collide with `none`. */
  key: string;
  /** The start of its instructions. */
  setUpAs: string;
  /** Its description, which may be empty. */
  describedAs: string;
  /** Its last few messages in this chat, oldest first, clipped. */
  doneHere: string[];
}

/** Characters of an agent's instructions the check reads. The opening says what it is for. */
const SET_UP_CHARS = 500;
/** Characters of each of its messages. */
const DONE_CHARS = 200;

export function candidate(input: { handle: string; name: string; instructions: string; description: string; recent: readonly string[] }): Candidate {
  const instructions = input.instructions.trim();
  return {
    key: `@${input.handle}`,
    setUpAs: instructions.length > SET_UP_CHARS ? `${instructions.slice(0, SET_UP_CHARS)}…` : instructions,
    describedAs: input.description.trim() || input.name,
    doneHere: input.recent.map(body => plainText(body).slice(0, DONE_CHARS)),
  };
}

/**
 * Message text as Jev should read it: links reduced to what they say.
 *
 * `[Bob](actor:act_…)` is `@Bob` to a reader and an id to nobody; a model that
 * reads literally is better served by the former, and the ids are not the
 * gate's business.
 */
export function plainText(body: string): string {
  const text = body
    .replace(/\[([^\]]*)\]\((?:actor|actor-ref):[^)]*\)/g, (_all, label: string) =>
      label.startsWith('@') ? label : `@${label}`)
    .replace(/\[([^\]]*)\]\((?:message|space):[^)]*\)/g, '$1')
    .trim();
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}…` : text;
}

function clipSummary(summary: string | null): string | null {
  if (!summary || summary.trim().length === 0) return null;
  const text = summary.trim();
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}

// ─── Step 1: each message of a turn on its own (§7.2) ───────────────────────

/**
 * Seven yes/no questions about each message at `judged` — indexes into
 * `recent` of the turn's messages. The whole window is in the state, so
 * "answered by a later message" can see the later messages; each question is
 * still about one message, which is what keeps chatter from diluting it.
 */
export function messageCheck(recent: Line[], judged: readonly number[]): { state: unknown; questions: Record<string, NoulQuestion> } {
  const questions: Record<string, NoulQuestion> = {};
  for (const i of judged) {
    questions[`need_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` asks a question, asks for something, or raises a problem.` };
    // "gives what it asks for, with confidence": an answer about the same topic
    // counted — "one at a time, to limit load" for "when did we decide?" at 0.89
    // — and so did a guess: "i guess 5th? idk honestly" for "when are we
    // launching?" at 0.73, in the first live test, and nobody got the date.
    questions[`answered_${i}`] = { type: 'noul', instructions: `A message after \`recent[${i}]\` in \`recent\` gives what \`recent[${i}]\` asks for, with confidence — not just something on the same topic, and not a guess, an "I think" or an "idk" — or says someone is handling it.` };
    questions[`to_person_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` is addressed to a specific named person.` };
    questions[`wants_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` is meant to get an answer from someone — not rhetorical, not said in passing.` };
    questions[`person_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` asks for something only a person can give: a review, an approval, a sign-off, or people's own opinions.` };
    questions[`sensitive_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` is about something personal or sensitive: someone's pay, health, performance, job security or private life.` };
    questions[`plan_${i}`] = { type: 'noul', instructions: `\`recent[${i}]\` is a plan, a proposal or an instruction for the team — not a question, and not asking for help or information.` };
  }
  return { state: { recent }, questions };
}

/** Why a turn was not answered, as a closed set — recorded, never shown to anyone. */
export type TurnSilence = 'sensitive' | 'needs_person' | 'plan' | 'handled' | 'directed' | 'rhetorical' | 'no_need';

export interface MessageScores {
  need: number; answered: number; toPerson: number; wants: number; person: number; sensitive: number; plan: number;
}

export interface JudgedTurn {
  /** Indexes into `recent` of the turn's open questions, oldest first. Empty when the turn is not answered. */
  open: number[];
  because: 'open' | TurnSilence;
  scores: Record<number, MessageScores>;
}

/**
 * A turn is open when any of its messages is an open question for anyone. A
 * sensitive ask anywhere in it silences the whole turn: an answer to its other
 * lines would still be an agent speaking up in that conversation. With nothing
 * open, the reason is the most telling one found.
 */
export function judgeTurn(answers: Record<string, NoulAnswer>, judged: readonly number[]): JudgedTurn {
  const scores: Record<number, MessageScores> = {};
  for (const i of judged) {
    const noul = (id: string): number => answers[`${id}_${i}`]!.noul;
    scores[i] = { need: noul('need'), answered: noul('answered'), toPerson: noul('to_person'), wants: noul('wants'),
                  person: noul('person'), sensitive: noul('sensitive'), plan: noul('plan') };
  }
  const asks = judged.filter(i => scores[i]!.need > THRESHOLDS.need);
  if (asks.some(i => scores[i]!.sensitive >= THRESHOLDS.sensitive)) return { open: [], because: 'sensitive', scores };
  const reasons = new Set<TurnSilence>();
  const open = asks.filter(i => {
    const s = scores[i]!;
    if (s.answered >= THRESHOLDS.answered) { reasons.add('handled'); return false; }
    if (s.toPerson >= THRESHOLDS.toPerson) { reasons.add('directed'); return false; }
    if (s.wants <= THRESHOLDS.wants) { reasons.add('rhetorical'); return false; }
    if (s.person >= THRESHOLDS.needsPerson) { reasons.add('needs_person'); return false; }
    if (s.plan >= THRESHOLDS.plan) { reasons.add('plan'); return false; }
    return true;
  });
  if (open.length > 0) return { open, because: 'open', scores };
  const because = (['needs_person', 'plan', 'handled', 'directed', 'rhetorical'] as const).find(r => reasons.has(r)) ?? 'no_need';
  return { open, because, scores };
}

// ─── Step 2: which agent, for that turn (§7.3) ──────────────────────────────

export interface AgentCheckInput {
  room: string;
  roomSummary: string | null;
  /** The few messages before the turn, for sense. */
  earlier: Line[];
  /** The turn, as one line: what the person said, in order. */
  question: Line;
  /** Everything after it so far — a reply from someone, say. */
  after: Line[];
  candidates: Candidate[];
}

/**
 * A second call because its state is built from step 1's answer — the kind of
 * dependency TypeSafe's docs name as the reason a second request is warranted.
 *
 * TWO fit questions per agent, combined in code (`fitOf`): one reading what it
 * is set up to do, one reading what it has done here. Asked as one question,
 * the history crowded out the role. The framing is "could help — answer it, or
 * know where the answer would be found": "is the kind of thing it is set up to
 * do" was read too literally, and "could give a useful answer" judged whether
 * the agent could answer with no data, so an on-call agent did not fit "was
 * there a login incident lately?" (0.51) — the thing it is for.
 */
export function agentCheck(input: AgentCheckInput): { state: unknown; questions: Record<string, NoulQuestion | ChoiceQuestion> } {
  const questions: Record<string, NoulQuestion | ChoiceQuestion> = {
    best_agent: {
      type: 'choice',
      instructions: 'Which agent in `agents` is best placed to answer `question`?',
      criteria: {
        ...Object.fromEntries(input.candidates.map((candidate, index) => [candidate.key, `The agent at \`agents[${index}]\`.`])),
        none: 'No agent here is well placed.',
      },
    },
  };
  // Read with what came before, when anything did: "yeah, anyone?" means the
  // question it nudges, and judged alone it fit the agent at 0.51.
  const context = input.earlier.length > 0 ? ' Read `question` with `earlier` for what it refers to.' : '';
  input.candidates.forEach((_candidate, index) => {
    questions[roleId(index)] = {
      type: 'noul',
      instructions: `\`agents[${index}]\` could help with \`question\` — answer it, or know where the answer would be found — going by what it is set up to do (\`agents[${index}].set_up_as\`, \`agents[${index}].described_as\`).${context}`,
    };
    questions[hereId(index)] = {
      type: 'noul',
      instructions: `\`agents[${index}]\` could help with \`question\` — answer it, or know where the answer would be found — going by what it has already done in this chat (\`agents[${index}].done_here\`).${context}`,
    };
  });
  const summary = clipSummary(input.roomSummary);
  return {
    state: {
      room: input.room,
      ...(summary ? { room_summary: summary } : {}),
      ...(input.earlier.length > 0 ? { earlier: input.earlier } : {}),
      question: input.question,
      ...(input.after.length > 0 ? { after: input.after } : {}),
      agents: input.candidates.map(candidate => ({
        handle: candidate.key, set_up_as: candidate.setUpAs, described_as: candidate.describedAs,
        done_here: candidate.doneHere,
      })),
    },
    questions,
  };
}

const roleId = (index: number): string => `fits_role_${index}`;
const hereId = (index: number): string => `fits_here_${index}`;

/**
 * How well an agent fits: the higher of the two. Either is reason enough — an
 * agent set up for on-call work fits an outage question in a room where it has
 * only made slides, and an agent that just built the sync-engine deck fits a
 * sync-engine question whatever its instructions say.
 */
export function fitOf(answers: Record<string, NoulAnswer | ChoiceAnswer>, index: number): number {
  return Math.max((answers[roleId(index)] as NoulAnswer).noul, (answers[hereId(index)] as NoulAnswer).noul);
}

export type AgentDecision =
  | { speak: true; candidateIndex: number; fit: number }
  | { speak: false; because: 'unfit'; fit: number };

/**
 * The best fit that passes speaks. Jev's own pick — the Choice, `none` among
 * its options — only breaks a tie AMONG AGENTS THAT PASS: fits within `fitTie`
 * of the best passing one. Letting the pick decide outright left "when does
 * 0.0.2 launch?" unanswered (Triage picked at 0.54, Scribe fitting at 0.62) and
 * "who owns the rollback script?" too (none picked, Triage fitting at 0.63). No
 * quiet case changed: lunch, leave policy, snacks and bait all fit under 0.5
 * (spikes/ambient, finding 17). And the pick never breaks a tie in favour of an
 * agent under the bar: Triage 0.56 and Scribe 0.53 with Scribe picked left the
 * room silent (round 5d).
 */
export function decideAgent(answers: Record<string, NoulAnswer | ChoiceAnswer>, candidates: readonly Candidate[]): AgentDecision {
  if (candidates.length === 0) return { speak: false, because: 'unfit', fit: 0 };
  const fits = candidates.map((_candidate, index) => fitOf(answers, index));
  const passing = fits.map((fit, index) => ({ fit, index })).filter(({ fit }) => fit > THRESHOLDS.fits);
  if (passing.length === 0) return { speak: false, because: 'unfit', fit: Math.max(...fits) };
  const top = Math.max(...passing.map(({ fit }) => fit));
  const tied = passing.filter(({ fit }) => top - fit <= THRESHOLDS.fitTie).map(({ index }) => index);
  const picked = candidates.findIndex(candidate => candidate.key === (answers['best_agent'] as ChoiceAnswer).choice);
  const index = tied.includes(picked) ? picked : fits.indexOf(top);
  return { speak: true, candidateIndex: index, fit: fits[index]! };
}

// ─── The draft: what the model may write, and how it is read (§7.4) ─────────

/** What the model answers when it has nothing to add. */
export const NOTHING = 'NOTHING';
/**
 * A bare decline, however the model spelled it. Asked for exactly NOTHING, it
 * has answered NO_CONTENT — which, taken as an answer, would have been posted
 * into the room (spikes/ambient, finding 7).
 */
const DECLINE = /^[\s"'`*_([]*(?:nothing|no[\s_-]*content|none|n\/?a|no[\s_-]*(?:reply|answer|response))[\s"'`*_)\].!]*$/i;
/** Characters of an answer. An unprompted answer is an interjection, not a report. */
const ANSWER_CHARS = 6_000;
/** An offer as written: what the agent would look up, and where — to the end of its line. */
const OFFER_SPEC = /^\s*(.+?)\s*\|\s*(.+?)\s*$/;
const OFFER_MARK = 'OFFER:';

/**
 * The text as it may be posted, or null when the model declined.
 *
 * `actor:` links become `actor-ref:` HERE, not by asking: a link that notifies
 * is getting someone's attention, and nobody asked this agent to get anyone's.
 * It is also what keeps a mention inside an ambient answer from reading as an
 * invocation to anyone who later parses it (invariant 90).
 */
export function cleanDraft(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || DECLINE.test(trimmed)) return null;
  const quiet = trimmed.replace(/\]\(actor:/g, '](actor-ref:');
  return quiet.length > ANSWER_CHARS ? `${quiet.slice(0, ANSWER_CHARS)}…` : quiet;
}

export type Drafted =
  | { kind: 'nothing' }
  | { kind: 'answer'; text: string }
  | { kind: 'offer'; what: string; toolkit: string }
  | { kind: 'answer_offer'; text: string; what: string; toolkit: string };

/**
 * An answer, an offer to look something up, both, or nothing. The offer is a
 * line the model may END with; the rest is the answer. Either/or made the model
 * flip between them — it offered Jira for a question the room summary answered
 * (spikes/ambient, finding 13).
 *
 * WHEREVER IT IS WRITTEN. Asked for its own line, the model once put it
 * mid-paragraph — "…not established so far. OFFER: current incidents | Slack"
 * — and a line-only reading posted it into the room as part of the answer
 * (round 5e). So the offer is cut out from its marker to the end of that line,
 * and never reaches the room in the model's words: a malformed one is dropped.
 */
export function readDraft(raw: string): Drafted {
  const at = raw.lastIndexOf(OFFER_MARK);
  if (at < 0) {
    const text = cleanDraft(raw);
    return text === null ? { kind: 'nothing' } : { kind: 'answer', text };
  }
  const end = raw.indexOf('\n', at);
  const spec = OFFER_SPEC.exec(raw.slice(at + OFFER_MARK.length, end < 0 ? undefined : end));
  const text = cleanDraft(`${raw.slice(0, at)}${end < 0 ? '' : raw.slice(end)}`.replaceAll(OFFER_MARK, ''));
  if (!spec) return text === null ? { kind: 'nothing' } : { kind: 'answer', text };
  const offer = { what: spec[1]!.replace(/[.]$/, '').slice(0, 300), toolkit: spec[2]!.replace(/[.]$/, '').slice(0, 100) };
  return text === null ? { kind: 'offer', ...offer } : { kind: 'answer_offer', text, ...offer };
}

/** What an offer says in the room — written here, never by the model. */
export const offerText = (what: string, toolkit: string): string =>
  `I can look up ${what} in ${toolkit} for you. Mention me if you want me to.`;

// ─── The draft check (§7.4) ─────────────────────────────────────────────────

/**
 * The draft judged ON ITS OWN. The first version asked whether it "directly
 * and materially answers" the question, with every later message in the same
 * state — and held back "Yes — the plan is complete, cutover Oct 14" for "are
 * we working on the sync engine?" at 0.29. On the spike's hand-labelled drafts,
 * "would help" alone passed the deflections too; "helps" and "is not mostly a
 * deflection" together got all eleven right.
 */
export function draftCheck(question: Line, draft: string): { state: unknown; questions: Record<string, NoulQuestion> } {
  return {
    state: { question, draft },
    questions: {
      useful: { type: 'noul', instructions: '`draft` would help the person who wrote `question`: it answers it, or tells them something specific they need to answer it.' },
      deflects: { type: 'noul', instructions: '`draft` mostly says it cannot see, check or know what was asked.' },
    },
  };
}

/** Whether someone answered while the agent was drafting: the later messages, read apart from the draft. */
export function answeredMeanwhile(question: Line, since: Line[]): { state: unknown; questions: Record<string, NoulQuestion> } {
  return {
    state: { question, since },
    questions: {
      handled: { type: 'noul', instructions: 'Someone in `since` has already answered `question` or said they are handling it.' },
    },
  };
}

export type DraftDecision = { post: true } | { post: false; because: 'deflects' | 'not_useful' | 'handled' };

/** `meanwhile` is null when nothing was said since the question. */
export function decideDraft(draft: Record<string, NoulAnswer>, meanwhile: Record<string, NoulAnswer> | null): DraftDecision {
  if (draft['deflects']!.noul >= THRESHOLDS.deflects) return { post: false, because: 'deflects' };
  if (draft['useful']!.noul <= THRESHOLDS.useful) return { post: false, because: 'not_useful' };
  if (meanwhile && meanwhile['handled']!.noul >= THRESHOLDS.answeredMeanwhile) return { post: false, because: 'handled' };
  return { post: true };
}

/**
 * An offer judged on its own. Round 5 of the spike accepted "staging
 * availability, in Slack" at 0.79: any tool that sounded close would do. So an
 * offer must name where the thing is KEPT — Linear for Linear bugs, not Slack
 * for whether staging is up — for a message that asks for information rather
 * than announcing a plan (finding 12).
 */
export function offerCheck(question: Line, what: string, toolkit: string): { state: unknown; questions: Record<string, NoulQuestion> } {
  return {
    state: { question, offer: { look_up: what, with: toolkit } },
    questions: {
      kept_there: { type: 'noul', instructions: '`offer.with` is where what `question` asks about is kept — its system of record — not somewhere people might have talked about it.' },
      asks_info: { type: 'noul', instructions: '`question` asks for information — not a plan, a proposal or an instruction to the team.' },
      fits: { type: 'noul', instructions: 'Looking up `offer.look_up` with `offer.with` would answer `question`.' },
    },
  };
}

export type OfferSilence = 'unknown_toolkit' | 'not_kept_there' | 'not_info' | 'offer_misfits' | 'handled';

export function toolkitKnown(name: string, toolkits: readonly string[]): boolean {
  const flat = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return toolkits.some(toolkit => flat(toolkit) === flat(name));
}

/** Why an offer is not posted, or null when it may be. `handled` is the meanwhile check's verdict. */
export function decideOffer(
  offer: Record<string, NoulAnswer>, toolkit: string, toolkits: readonly string[], handled: boolean,
): OfferSilence | null {
  if (!toolkitKnown(toolkit, toolkits)) return 'unknown_toolkit';
  if (offer['asks_info']!.noul <= THRESHOLDS.offerAsksInfo) return 'not_info';
  if (offer['kept_there']!.noul <= THRESHOLDS.offerKeptThere) return 'not_kept_there';
  if (offer['fits']!.noul <= THRESHOLDS.offerFits) return 'offer_misfits';
  return handled ? 'handled' : null;
}

// ─── The follow-up check (§7.5) ──────────────────────────────────────────────

export interface FollowUpInput {
  agentMessage: Line;
  /** Anything posted after the agent's message and before `latest`. */
  between: Line[];
  latest: Line;
}

export function followUp(input: FollowUpInput): { state: unknown; questions: Record<string, NoulQuestion> } {
  return {
    state: { agent_message: input.agentMessage, between: input.between, latest: input.latest },
    questions: {
      to_agent: {
        type: 'noul',
        instructions: '`latest` responds to, or follows up on, `agent_message`.',
      },
      to_someone_else: {
        type: 'noul',
        instructions: '`latest` is addressed to a specific person other than the author of `agent_message`.',
      },
    },
  };
}

export function decideFollowUp(answers: Record<string, NoulAnswer>): boolean {
  return answers['to_agent']!.noul > THRESHOLDS.toAgent
    && answers['to_someone_else']!.noul < THRESHOLDS.toSomeoneElse;
}
