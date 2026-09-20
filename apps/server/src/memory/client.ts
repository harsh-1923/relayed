// The only file that imports Hindsight (docs/MEMORY.md §6.3, §7.1).
//
// The OFFICIAL CLIENT here, unlike `agents/composio.ts` which deliberately uses
// REST: that decision was driven by specific SDK deficiencies (a `link()` that
// cannot carry connection data, a tool list that drops its cursor, a missing
// `revoke`). None of them apply here, and `spikes/hindsight/` exercised this
// client against real Cloud rather than reading about it — so the spike covers
// the half we do not control.
//
// Everything below is the narrow surface the rest of the server may use. Two
// things are deliberately NOT exposed:
//
//   · `async: true` on retain. The client's own type says the default is
//     already false, but xyne-spaces' provider passed true and paid for it:
//     failures then happen INSIDE Hindsight after it has already returned 200,
//     where we can neither see nor retry them. Passing it explicitly beats
//     trusting a default that a minor version could change.
//   · `reflect`. Ten times the price of a recall and seconds of generation, for
//     a synthesis nothing in this design asks for (§13).
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { env } from '../env.ts';

/** A refusal from Hindsight, or from reaching it. Never carries the API key. */
export class MemoryError extends Error {
  /** 0 when nothing answered — a network failure has no HTTP status to report. */
  readonly status: number;
  /** `unconfigured`, `network`, or `http_<code>`. A closed set, so it can be counted. */
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'MemoryError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Is memory configured at all?
 *
 * Callers check this rather than catching `unconfigured`, because a server with
 * no memory configured is a supported state and not an error path: every run
 * still answers, just without recall.
 */
export const memoryConfigured = (): boolean =>
  env.hindsightBaseUrl !== null && env.hindsightApiKey !== null;

let client: HindsightClient | null = null;

function hindsight(): HindsightClient {
  if (!memoryConfigured()) {
    throw new MemoryError('HINDSIGHT_BASE_URL or HINDSIGHT_API_KEY is not set', 0, 'unconfigured');
  }
  // `maxAttempts` is set rather than inherited. The client retries on its own,
  // and the job calling it retries too; xyne-spaces found nested retry loops
  // multiplying a budget nobody had accounted for.
  client ??= new HindsightClient({
    baseUrl: env.hindsightBaseUrl!, apiKey: env.hindsightApiKey!, maxAttempts: 2,
  });
  return client;
}

async function call<T>(what: string, run: (hs: HindsightClient) => Promise<T>): Promise<T> {
  try {
    return await run(hindsight());
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    const status = (error as { statusCode?: number }).statusCode ?? 0;
    throw new MemoryError(`${what} failed: ${(error as Error).message}`, status,
                          status === 0 ? 'network' : `http_${status}`);
  }
}

// ─── What a recalled fact is, to the rest of the server ─────────────────────

/**
 * A fact, with our names on it.
 *
 * THE RESPONSE IS snake_case AT RUNTIME even though the published examples show
 * camelCase — `document_id`, not `documentId`, verified in
 * `spikes/hindsight/1-scopes.mjs`. So it is renamed here, at the boundary, and
 * the vendor's spelling never travels further in. Same discipline the wire
 * protocol already holds for `"t"`, `"c"`, `"m"` (AGENTS.md, descriptive names).
 */
export interface Fact {
  id: string;
  text: string;
  /** `world` and `experience` are raw; `observation` is consolidated from several. */
  type: string;
  tags: string[];
  /**
   * The document this was extracted from — **null on an observation**, which has
   * several sources and no single one. That is why observations stay off (§6.4):
   * a fact with no document cannot be traced to its messages, and §7.2's citation
   * rule silently degrades rather than failing.
   */
  documentId: string | null;
  metadata: Record<string, string>;
  entities: string[];
  occurredStart: string | null;
  occurredEnd: string | null;
  /**
   * The fused rank Hindsight settled on, from `scores.final`. Absent on a
   * listed fact — only a recall ranks anything — so it is what orders the
   * block and nothing else.
   */
  scoreFinal: number | null;
}

/**
 * A fact as Hindsight actually sends it, which is not one shape.
 *
 * `recall` returns `entities` as an ARRAY — `["Northwind", "vault rotation"]` —
 * and `listMemories` returns the SAME FIELD as a comma-joined STRING —
 * `"Alice (PERSON), Google (ORGANIZATION)"`. Found by the compiler rather than
 * at runtime, which is the argument for normalising here instead of letting
 * each call site cope.
 */
interface RawFact {
  id?: string; text?: string; type?: string; tags?: string[] | null;
  document_id?: string | null; metadata?: Record<string, string> | null;
  entities?: string[] | string | null;
  occurred_start?: string | null; occurred_end?: string | null;
  /** `listMemories` spells the type this way; `recall` uses `type`. */
  fact_type?: string;
  scores?: { final?: number | null } | null;
}

const toEntities = (raw: RawFact['entities']): string[] =>
  Array.isArray(raw) ? raw
  : typeof raw === 'string' ? raw.split(',').map((name) => name.trim()).filter(Boolean)
  : [];

const toFact = (raw: RawFact): Fact => ({
  id: raw.id ?? '',
  text: raw.text ?? '',
  type: raw.type ?? raw.fact_type ?? 'world',
  tags: raw.tags ?? [],
  documentId: raw.document_id ?? null,
  metadata: raw.metadata ?? {},
  entities: toEntities(raw.entities),
  occurredStart: raw.occurred_start ?? null,
  occurredEnd: raw.occurred_end ?? null,
  scoreFinal: raw.scores?.final ?? null,
});

// ─── The surface ────────────────────────────────────────────────────────────

export interface BankConfig {
  /** The bank is a PLACE, not an assistant. Extraction reads this to decide who is speaking. */
  name: string;
  instructions: string;
}

/** Create a bank if it is absent, and apply `config`. Idempotent. */
export async function createBank(bankId: string, config: BankConfig): Promise<void> {
  await call('createBank', (hs) => hs.createBank(bankId, { name: config.name }));
  await applyBankConfig(bankId, config);
}

export async function applyBankConfig(bankId: string, config: BankConfig): Promise<void> {
  await call('updateBankConfig', (hs) => hs.updateBankConfig(bankId, {
    retainExtractionMode: 'custom',
    retainCustomInstructions: config.instructions,
    // Off, and load-bearing twice: consolidation ~2x-duplicates world facts,
    // AND an observation carries no document_id, so turning this on silently
    // breaks citations (§6.4).
    enableObservations: false,
  }));
}

/** The resolved configuration, for verifying that a write actually stuck (§6.4). */
export const readBankConfig = (bankId: string): Promise<unknown> =>
  call('getBankConfig', (hs) => hs.getBankConfig(bankId));

export const deleteBank = (bankId: string): Promise<void> =>
  call('deleteBank', (hs) => hs.deleteBank(bankId) as Promise<void>);

export interface RetainEpisode {
  bankId: string;
  /** The labelled transcript. Raw conversation, never a summary of one (§6.2). */
  content: string;
  /** Who is speaking, and that the bank is not an assistant. Steers world-vs-experience. */
  context: string;
  /** Ours, chosen before the call. The only handle that makes forgetting possible (§8.1). */
  documentId: string;
  /** The first message's time. Stored as the event's time, verified in the spike. */
  timestamp: string;
  tags: string[];
  metadata: Record<string, string>;
}

export async function retain(episode: RetainEpisode): Promise<void> {
  await call('retain', (hs) => hs.retain(episode.bankId, episode.content, {
    context: episode.context,
    documentId: episode.documentId,
    timestamp: episode.timestamp,
    tags: episode.tags,
    metadata: episode.metadata,
    async: false,          // never true — see the header
  }));
}

export interface RecallFrom {
  bankId: string;
  query: string;
  /** The live allowed set. `any_strict` excludes untagged, which fails closed. */
  tags: string[];
  maxTokens?: number;
  /** A run answers late or not at all without memory; it never waits (§11). */
  timeoutMs?: number;
}

export async function recall(request: RecallFrom): Promise<Fact[]> {
  const signal = AbortSignal.timeout(request.timeoutMs ?? 3_000);
  const response = await call('recall', (hs) => hs.recall(request.bankId, request.query, {
    // `mid` beat `low` at P@5 72% vs 62% in xyne-spaces' 2026-07-20 eval, and
    // score boosts made it worse.
    budget: 'mid',
    tags: request.tags,
    tagsMatch: 'any_strict',
    maxTokens: request.maxTokens ?? 2048,
    signal,
  }));
  return ((response as unknown as { results?: RawFact[] }).results ?? []).map(toFact);
}

/** Every fact extracted from one document. Used to read back what a retain produced. */
export async function factsForDocument(bankId: string, documentId: string): Promise<Fact[]> {
  const response = await call('listMemories', (hs) =>
    hs.listMemories(bankId, { documentId, limit: 200 }));
  return ((response as unknown as { items?: RawFact[] }).items ?? []).map(toFact);
}

/**
 * Forget a document and everything extracted from it.
 *
 * Cascades to every memory unit and link, permanently — verified in
 * `spikes/hindsight/1-scopes.mjs` (4 facts to 0). Note this is per DOCUMENT;
 * per-MEMORY deletion is unsupported and answers 405, which is the wall
 * xyne-spaces hit because their async retain left them no document ids to use.
 *
 * Resolves `void`, so a caller that needs proof reads back with
 * `factsForDocument` rather than inspecting a count.
 */
export const forget = (bankId: string, documentId: string): Promise<void> =>
  call('deleteDocument', (hs) => hs.deleteDocument(bankId, documentId));
