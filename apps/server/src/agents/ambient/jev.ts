// Asking Jev, TypeSafe's decision model (docs/AMBIENT-RESPONSES.md, the Jev
// calls §7).
//
// THROUGH TYPESAFE'S OWN SDK (`@typesafe-ai/sdk`, pinned exact), because it
// carries what a hand-written `fetch` did not: retries with backoff that honour
// `retry-after` (a single 429 or 529 was a look lost for good), the token usage
// of every call, and request shapes TypeSafe keeps current as the API moves. A
// thin wrapper stays around it, for four things the SDK leaves to us:
//
//   PINNED, NEVER `jev-latest` — the SDK's default. The alias moves when
//   TypeSafe ships, and the probabilities behind it move with it, while the
//   thresholds in `gates.ts` were tuned on one version (§7.7).
//
//   SILENT LOGGER. The SDK's debug level prints whole request and response
//   bodies, which hold message text — the one thing that must never reach a log
//   (OBSERVABILITY.md §6). Nothing here is given a logger that could.
//
//   THE ANSWERS ARE CHECKED. The SDK returns the body as it came, typed but
//   unverified. A missing answer, a choice outside the options offered, or a
//   probability outside 0 to 1 is `malformed` here, never a default — a
//   default would be a decision nobody made.
//
//   A FAILURE IS A CLOSED REASON, never a message. What goes wrong is counted
//   (`ambient.gate_error`), and an answer that could not be judged is never
//   posted — so the reason is the only trace a broken gate leaves (§8).
import {
  APIConnectionError, APIError, APITimeoutError, TypeSafeClient, TypeSafeError,
  type Logger, type Questions,
} from '@typesafe-ai/sdk';

/** The version the thresholds in `gates.ts` were set against. */
export const JEV_MODEL = 'jev-1.13.0';

/**
 * Past this, one attempt gives up. Jev answers in about 0.4 s (the spike's p95
 * was under 0.5 s); nothing here is on a request path, but a gate that hangs
 * holds a claimed window for as long as it hangs.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Retries after the first attempt. One, not the SDK's two: an ambient answer
 * already waits out a 90-second lull, so a retry's second of backoff costs
 * nothing a person notices — but a third attempt after two failures is more
 * likely an outage than a blip, and silence is the right answer to an outage.
 */
const DEFAULT_RETRIES = 1;

/** A question's wording or its criteria: a string, or structure the model reads as JSON. */
export type Wording = string | Record<string, unknown> | readonly unknown[];

export interface NoulQuestion {
  type: 'noul';
  instructions: Wording;
  criteria?: { true?: Wording; false?: Wording };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: Wording;
  /** Option to its description. `null` when the option needs none. */
  criteria: Record<string, Wording | null>;
}

export type Question = NoulQuestion | ChoiceQuestion;

export interface NoulAnswer {
  /** The probability the answer is yes, 0 to 1. Nouls carry no separate confidence. */
  noul: number;
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  /** How concentrated `probabilities` is, 0 to 1. */
  confidence: number;
}

export type Answers<Q extends Record<string, Question>> = {
  [Id in keyof Q]: Q[Id] extends ChoiceQuestion ? ChoiceAnswer : NoulAnswer;
};

export interface Judged<Q extends Record<string, Question>> {
  /** The versioned id that answered — recorded beside every decision. */
  model: string;
  answers: Answers<Q>;
  /** Input tokens TypeSafe billed for the call, when it said. */
  inputTokens: number | null;
}

export type JevErrorReason = 'timeout' | 'rate_limited' | 'http_4xx' | 'http_5xx' | 'network' | 'malformed';

export class JevError extends Error {
  readonly reason: JevErrorReason;
  constructor(reason: JevErrorReason, message: string) {
    super(message);
    this.name = 'JevError';
    this.reason = reason;
  }
}

/** What the gates call. An interface, so a test can answer without a network. */
export interface Jev {
  ask<Q extends Record<string, Question>>(state: unknown, questions: Q): Promise<Judged<Q>>;
}

export interface JevOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Retries after the first attempt. A test passes 0 to see one attempt's outcome. */
  retries?: number;
}

/** Nothing the SDK says is logged: at debug it would say the message text. */
const SILENT: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export function jevClient(options: JevOptions): Jev {
  const model = options.model ?? JEV_MODEL;
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    defaultModel: model,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: { maxRetries: options.retries ?? DEFAULT_RETRIES },
    logger: SILENT,
    logLevel: 'error',
  });

  return {
    async ask<Q extends Record<string, Question>>(state: unknown, questions: Q): Promise<Judged<Q>> {
      let result: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
      try {
        result = await client.systemOne({
          model,
          state: state as never,
          // Our question shapes are the API's; the SDK's own types are stricter
          // about JSON values than a `Record<string, unknown>` can promise.
          questions: questions as unknown as Questions,
        });
      } catch (error) {
        throw new JevError(reasonFor(error), 'Jev did not answer');
      }
      const judged = readJudged(result, questions);
      const tokens = result.usage?.input_tokens;
      return { ...judged, inputTokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null };
    },
  };
}

/**
 * The SDK's error, as one of our closed reasons. 529 is TypeSafe's
 * "overloaded" and 429 its rate limit: both say "not now", neither says the
 * request was wrong. A `TypeSafeError` that is not an `APIError` is the SDK
 * refusing our question before sending it — our request was wrong, as a 422
 * would say.
 */
function reasonFor(error: unknown): JevErrorReason {
  if (error instanceof APITimeoutError) return 'timeout';
  if (error instanceof APIConnectionError) return 'network';
  if (error instanceof APIError) {
    if (error.status === 429 || error.status === 529) return 'rate_limited';
    return error.status >= 500 ? 'http_5xx' : 'http_4xx';
  }
  if (error instanceof TypeSafeError) return 'http_4xx';
  return 'network';
}

/**
 * The response, checked for exactly what the gates read and nothing more.
 *
 * Permissive about anything extra — a field TypeSafe adds later is not a reason
 * to stop answering (the same reasoning as reading frames permissively,
 * `DESIGN.md` §9.10). Strict about what is used.
 */
export function readJudged<Q extends Record<string, Question>>(body: unknown, questions: Q): Omit<Judged<Q>, 'inputTokens'> {
  if (!isRecord(body) || !isRecord(body['answers'])) throw new JevError('malformed', 'no answers in the response');
  const answers = body['answers'];
  const out: Record<string, NoulAnswer | ChoiceAnswer> = {};

  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!isRecord(answer)) throw new JevError('malformed', `no answer for ${id}`);
    if (question.type === 'noul') {
      if (!isProbability(answer['noul'])) throw new JevError('malformed', `${id} has no noul`);
      out[id] = { noul: answer['noul'] };
      continue;
    }
    const choice = answer['choice'];
    const probabilities = answer['probabilities'];
    if (typeof choice !== 'string' || !(choice in question.criteria)) {
      throw new JevError('malformed', `${id} chose something that was not offered`);
    }
    if (!isRecord(probabilities) || !Object.values(probabilities).every(isProbability)) {
      throw new JevError('malformed', `${id} has no probabilities`);
    }
    if (!isProbability(answer['confidence'])) throw new JevError('malformed', `${id} has no confidence`);
    out[id] = { choice, probabilities: probabilities as Record<string, number>, confidence: answer['confidence'] };
  }

  const model = typeof body['model'] === 'string' ? body['model'] : JEV_MODEL;
  return { model, answers: out as Answers<Q> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
