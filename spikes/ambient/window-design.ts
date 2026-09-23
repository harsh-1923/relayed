// The gate as it was built before the spike: the window judged at once, and a
// literal draft check. Copied here verbatim from
// apps/server/src/agents/ambient/gates.ts when the per-message design replaced
// it, so the spike can still run the comparison it was built to make.
import type { ChoiceAnswer, ChoiceQuestion, NoulAnswer, NoulQuestion } from '../../apps/server/src/agents/ambient/jev.ts';

/**
 * Starting values (§7.2, §7.3, §7.4), to be moved against shadow data rather
 * than argued about. A threshold on a Noul is never reused for a Choice or the
 * other way round — the two are not comparable (§7.2).
 */
export const THRESHOLDS = {
  /**
   * Lowered from 0.8 after the first live question: "Are we working on the sync
   * engine side of things?", asked to a room right after Triage had built a
   * sync-engine deck, scored 0.69 and went unanswered. A loose question to the
   * room is still a need.
   */
  openNeed: 0.65,
  alreadyHandled: 0.2,
  directedAtPerson: 0.2,
  socialOnly: 0.2,
  bestAgentConfidence: 0.7,
  /**
   * The higher of the two fit questions (`fitOf`). 0.6 rather than 0.7: on the
   * first live room, an on-call question for an agent set up as "an on call
   * assistant" scored 0.60, while questions no agent should take scored 0.40
   * and below.
   */
  fits: 0.6,
  answersNeed: 0.8,
  toAgent: 0.8,
  toSomeoneElse: 0.2,
  /**
   * What each dismissal in the backoff window adds to `fits` for that agent in
   * that chat (§10.2). Uncapped on purpose: eight dismissals put it past 1,
   * which is an agent that has stopped answering unprompted in that chat until
   * the dismissals age out — the room said so eight times.
   */
  backoffStep: 0.05,
} as const;

/** Characters of one message the gates are shown. The rest adds tokens and distraction, not judgment. */
const LINE_CHARS = 1_000;
/** Characters of the room summary. It is context, and a long one crowds the conversation (§7.5). */
const SUMMARY_CHARS = 4_000;

/** One message, as a gate reads it. */
export interface Line {
  from: string;
  /** ISO-8601, so "a while ago" is legible without arithmetic. */
  at: string;
  text: string;
}

/**
 * An agent in the room, as gate 1 reads it.
 *
 * BUILT FROM WHAT EXISTS WITHOUT ANYONE WRITING IT. The one-line description is
 * mostly blank or vague — the first live agent's read "Triage agent for SWAT",
 * and a sync-engine question in a room where it had just built the sync-engine
 * deck scored 0.53 against it. So the fit is judged from two things every agent
 * has: what it was set up to do (its instructions, which are required) and what
 * it has already said in this chat. Measured on that room, the same question
 * scored 0.88 (§7.2).
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

/** Characters of an agent's instructions gate 1 reads. The opening says what it is for. */
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

// ─── Gate 1: is there an unmet need, and whose (§7.2) ────────────────────────

export interface Gate1Input {
  room: string;
  roomSummary: string | null;
  /** The messages just before the window — read for sense, not judged. */
  earlier: Line[];
  /** The window: what is judged. */
  recent: Line[];
  candidates: Candidate[];
}

export type Gate1Questions = Record<string, NoulQuestion | ChoiceQuestion>;

export function gate1(input: Gate1Input): { state: unknown; questions: Gate1Questions } {
  const questions: Gate1Questions = {
    open_need: {
      type: 'noul',
      instructions: 'Someone in `recent` asked for something or raised a problem that nobody present has answered or taken on.',
    },
    already_handled: {
      type: 'noul',
      instructions: 'Someone in `recent` has already answered the request or said they are handling it.',
    },
    directed_at_person: {
      type: 'noul',
      instructions: 'The request in `recent` is addressed to a specific named person.',
    },
    social_only: {
      type: 'noul',
      // The memory extraction's own skip list (MEMORY.md §6.2), so "not worth
      // remembering" and "not worth answering" mean the same thing.
      instructions: '`recent` is only greetings, thanks, reactions, banter or scheduling chatter.',
    },
    best_agent: {
      type: 'choice',
      instructions: 'Which agent in `agents` is best placed to help with what is needed in `recent`?',
      criteria: {
        ...Object.fromEntries(input.candidates.map((candidate, index) => [candidate.key, `The agent at \`agents[${index}]\`.`])),
        none: 'No agent here is well placed, or nothing is needed.',
      },
    },
  };
  // TWO questions per agent, combined in code (`fitOf`): one reading what it is
  // set up to do, one reading what it has done here. Asked as one question, the
  // history crowded out the role — an on-call question for an on-call agent
  // that had only made slides in this room dropped from 0.67 to 0.35. And the
  // framing is "could give a useful answer": "is the kind of thing it is set up
  // to do" and "continues its work" were read too literally, and scored the
  // sync-engine question 0.50 and 0.53.
  input.candidates.forEach((_candidate, index) => {
    questions[roleId(index)] = {
      type: 'noul',
      instructions: `\`agents[${index}]\` could give a useful answer to what is needed in \`recent\`, going by what it is set up to do (\`agents[${index}].set_up_as\`, \`agents[${index}].described_as\`).`,
    };
    questions[hereId(index)] = {
      type: 'noul',
      instructions: `\`agents[${index}]\` could give a useful answer to what is needed in \`recent\`, going by what it has already done in this chat (\`agents[${index}].done_here\`).`,
    };
  });
  // Which message holds the need, so the answer can point at it (§6). Asked only
  // when there is a choice to make: a window of one is its own answer.
  if (input.recent.length > 1) {
    questions['need_message'] = {
      type: 'choice',
      instructions: 'Which message in `recent` holds the request or problem that is still unanswered?',
      criteria: Object.fromEntries(input.recent.map((_line, index) =>
        [messageKey(index), `The message at \`recent[${index}]\`.`])),
    };
  }

  const state = {
    room: input.room,
    ...(clipSummary(input.roomSummary) ? { room_summary: clipSummary(input.roomSummary) } : {}),
    ...(input.earlier.length > 0 ? { earlier: input.earlier } : {}),
    recent: input.recent,
    agents: input.candidates.map(candidate => ({
      handle: candidate.key, set_up_as: candidate.setUpAs, described_as: candidate.describedAs,
      done_here: candidate.doneHere,
    })),
  };
  return { state, questions };
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
const messageKey = (index: number): string => `m${index}`;

/** Why gate 1 stayed quiet, as a closed set — recorded, never shown to anyone. */
export type Gate1Silence =
  'no_need' | 'handled' | 'directed' | 'social' | 'no_agent' | 'unsure' | 'unfit' | 'no_message';

export type Gate1Decision =
  | { speak: true; candidateIndex: number; needIndex: number }
  | { speak: false; because: Gate1Silence };

/**
 * The gate, in code (§7.2). Every condition must hold. `fitsFor` is the
 * threshold for one candidate in this chat — `THRESHOLDS.fits` raised by that
 * agent's backoff (§10.2).
 */
export function decideGate1(
  answers: Record<string, NoulAnswer | ChoiceAnswer>, input: Gate1Input,
  fitsFor: (candidateIndex: number) => number,
): Gate1Decision {
  const noul = (id: string): number => (answers[id] as NoulAnswer).noul;
  if (noul('open_need') <= THRESHOLDS.openNeed) return { speak: false, because: 'no_need' };
  if (noul('already_handled') >= THRESHOLDS.alreadyHandled) return { speak: false, because: 'handled' };
  if (noul('directed_at_person') >= THRESHOLDS.directedAtPerson) return { speak: false, because: 'directed' };
  if (noul('social_only') >= THRESHOLDS.socialOnly) return { speak: false, because: 'social' };

  const best = answers['best_agent'] as ChoiceAnswer;
  const candidateIndex = input.candidates.findIndex(candidate => candidate.key === best.choice);
  if (candidateIndex < 0) return { speak: false, because: 'no_agent' };
  if (best.confidence <= THRESHOLDS.bestAgentConfidence) return { speak: false, because: 'unsure' };
  // The Choice picks WHO; the Noul says whether that one is any good at all.
  // They answer different questions (§7.2), so both must pass.
  if (fitOf(answers, candidateIndex) <= fitsFor(candidateIndex)) return { speak: false, because: 'unfit' };

  let needIndex = input.recent.length - 1;
  if (input.recent.length > 1) {
    const which = answers['need_message'] as ChoiceAnswer;
    const index = Number(which.choice.slice(1));
    if (!Number.isInteger(index) || index < 0 || index >= input.recent.length) return { speak: false, because: 'no_message' };
    needIndex = index;
  }
  return { speak: true, candidateIndex, needIndex };
}

/** `fits` for an agent with this many dismissals in the backoff window (§10.2). */
export function fitsThreshold(dismissals: number): number {
  return THRESHOLDS.fits + THRESHOLDS.backoffStep * Math.max(0, dismissals);
}

// ─── Gate 2: does the draft meet the need (§7.3) ─────────────────────────────

export interface Gate2Input {
  question: Line;
  /** Everything posted after the question, read again once the draft exists. */
  since: Line[];
  draft: string;
}

export function gate2(input: Gate2Input): { state: unknown; questions: Record<string, NoulQuestion> } {
  return {
    state: { question: input.question, chat_now: input.since, draft: input.draft },
    questions: {
      answers_need: {
        type: 'noul',
        instructions: '`draft` directly and materially answers `question`.',
      },
      already_handled: {
        type: 'noul',
        instructions: 'Someone in `chat_now` has already answered `question` or said they are handling it.',
      },
    },
  };
}

export type Gate2Decision = { post: true } | { post: false; because: 'off_target' | 'handled' };

export function decideGate2(answers: Record<string, NoulAnswer>): Gate2Decision {
  if (answers['answers_need']!.noul <= THRESHOLDS.answersNeed) return { post: false, because: 'off_target' };
  if (answers['already_handled']!.noul >= THRESHOLDS.alreadyHandled) return { post: false, because: 'handled' };
  return { post: true };
}

// ─── The follow-up check (§7.4) ──────────────────────────────────────────────

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
