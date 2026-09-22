// Searching the open web, through Parallel (WORKSPACE-AGENTS.md, a tool call §5.5).
//
// THE ONLY TOOL THAT SPENDS OUR OWN MONEY. Every other app tool acts inside
// Relayed, and every Composio tool spends the invoker's own account — which is
// why neither needs a budget. This one bills us per query, so what bounds it —
// how many sources come back, how much text each may carry, which speed tier —
// is set here rather than offered to the model.
//
// PARALLEL RATHER THAN BRAVE, on the shape of the request. Brave's LLM-context
// endpoint takes one keyword string; Parallel takes an OBJECTIVE in plain words
// alongside the keyword queries, and ranks the extracted text against it. Our
// query is written by a model from a conversation where the subject is usually
// a pronoun, so an API that accepts "what we are trying to find out" separately
// from "words to search for" removes the failure the prompt would otherwise
// have to talk the model out of. Parallel also dates each result, which is the
// guard against an agent citing a page from 2019 as current.
//
// Both were costed in the same terms, and price was the tiebreak rather than
// the case: Parallel's `fast` tier is a fifth of Brave's per-query rate.
import { count } from '@relayed/telemetry';
import type { RunTool } from '@relayed/protocol';
import { env } from '../../env.ts';
import { asText, type AppTool } from './contract.ts';

export const WEB_SEARCH = 'web_search';

const ENDPOINT = 'https://api.parallel.ai/v1/search';

/**
 * What one search costs and returns.
 *
 * `mode` is the price-quality dial: `fast` answers in roughly the time a person
 * will sit through, at a fifth of what `advanced` costs. A constant rather than
 * an env var until a real deployment gives a reason to retune it, and never a
 * tool parameter — how much a run may spend is not the model's to choose.
 *
 * `chars` sits under the broker's 32 KB result cap (§5.5), which truncates and
 * says it did; staying below it means no source comes back half-written. Two
 * live searches landed at 11 KB and 14 KB against it, so the ceiling is a guard
 * rather than a squeeze.
 *
 * `results` is EXACTLY the ten Parallel includes in the base price — the
 * eleventh is billed separately — so a search takes everything already paid for
 * and never quietly buys more.
 */
const BUDGET = { mode: 'fast', results: 10, chars: 24_000, charsPerResult: 3_000 } as const;

/** At most this many queries reach Parallel; it asks for two or three of a few words each. */
const QUERY_LIMIT = 4;

/**
 * How recent a page must be, as the model may ask for it.
 *
 * WE COMPUTE THE DATE, not the model. Parallel's filter is an absolute
 * `after_date`, which is the more precise thing to send and the wrong thing to
 * ask for: a model working out "a week ago" needs today's date to be in front
 * of it and needs the arithmetic to be right, and a wrong date silently
 * discards the best answers rather than failing.
 */
const WINDOW_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

const DEFINITION: RunTool = {
  name: WEB_SEARCH,
  description: 'Search the public web and get back extracted text from the pages found, with their urls and '
    + 'dates. For things Relayed does not know: current events, documentation, prices, people and companies '
    + 'outside this workspace, anything after your training. Not for what is in this workspace — rooms, '
    + 'messages, people and summaries are read with the other tools, which see things this cannot.',
  parameters: {
    type: 'object',
    required: ['objective', 'queries'],
    properties: {
      objective: {
        type: 'string',
        description: 'What you are trying to find out, in one plain sentence that stands on its own. Resolve '
          + 'pronouns and shorthand from the conversation first: "what does Linear charge per seat on its '
          + 'Business plan", never "their pricing". The extracted text is ranked against this, so it does more '
          + 'work than the queries.',
      },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Two or three keyword searches of a few words each, as you would type them into a search '
          + `engine — different angles on the objective, not restatements of it. At most ${QUERY_LIMIT}.`,
      },
      within: {
        type: 'string',
        enum: Object.keys(WINDOW_DAYS),
        description: 'Only pages published within the past day, week, month or year. Leave it out unless '
          + 'recency is the point of the question — it discards older pages that are often the better answer.',
      },
    },
  },
};

interface Source { title: string; url: string; published?: string; excerpts: string[] }

/** Parallel's shape, read permissively — `warnings`, `usage` and the ids are for us, never for the model. */
interface SearchResponse {
  results?: { url?: string; title?: string | null; publish_date?: string | null; excerpts?: string[] }[];
}

type Outcome =
  | { ok: true; sources: Source[] }
  | { ok: false; code: 'rate_limited' | 'unauthorized' | 'rejected' | 'failed'; message: string };

/** `after_date` as Parallel takes it (YYYY-MM-DD), counted back from now. */
function afterDate(within: string): string | null {
  const days = WINDOW_DAYS[within];
  if (days === undefined) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function search(objective: string, queries: string[], within: string): Promise<Outcome> {
  const after = afterDate(within);
  const body = {
    objective,
    search_queries: queries,
    mode: BUDGET.mode,
    max_chars_total: BUDGET.chars,
    advanced_settings: {
      max_results: BUDGET.results,
      excerpt_settings: { max_chars_per_result: BUDGET.charsPerResult },
      ...(after ? { source_policy: { after_date: after } } : {}),
    },
  };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': env.parallelApiKey! },
      body: JSON.stringify(body),
      // Shorter than the Composio timeout: a run is waiting on this with a
      // person watching it, and `fast` answers in well under a second, so ten
      // seconds is already far past anything worth continuing to wait for.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, code: 'failed', message: `the search could not be reached: ${(error as Error).message}` };
  }

  if (!response.ok) {
    // Mapped to what can actually be done about each: a 429 is our quota and
    // will pass, a 401 or 403 is our key and never will.
    if (response.status === 429) {
      return { ok: false, code: 'rate_limited', message: 'web search is rate-limited right now' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'unauthorized', message: 'web search is not configured correctly on this server' };
    }
    if (response.status === 422) {
      return { ok: false, code: 'rejected', message: 'the search engine would not accept that search' };
    }
    return { ok: false, code: 'failed', message: `the search failed (${response.status})` };
  }

  const payload = (await response.json().catch(() => ({}))) as SearchResponse;
  const sources = (payload.results ?? []).flatMap(result => {
    const url = asText(result.url);
    const excerpts = (result.excerpts ?? []).map(asText).filter(excerpt => excerpt.length > 0);
    // A result with no url cannot be cited and one with no text says nothing.
    // Either way it is weight in the context for no answer.
    if (url.length === 0 || excerpts.length === 0) return [];
    const published = asText(result.publish_date);
    return [{
      title: asText(result.title) || url,
      url,
      ...(published ? { published } : {}),
      excerpts,
    }];
  });
  return { ok: true, sources };
}

/** The model's `queries`, as Parallel will take them: trimmed, empties dropped, capped. */
function queriesFrom(value: unknown): string[] {
  const asked = Array.isArray(value) ? value : [value];
  return asked.map(asText).filter(query => query.length > 0).slice(0, QUERY_LIMIT);
}

export const webSearch: AppTool = {
  name: WEB_SEARCH,

  // ON THE KEY ALONE, unlike `remember` next door, which insists on its own
  // switch because a Hindsight key is set for ingestion and would turn recall
  // on behind somebody's back. This key has exactly one consumer, so setting it
  // IS the decision to offer web search; a second switch would have no state
  // that means anything.
  definition: () => (env.parallelApiKey ? DEFINITION : null),

  prompt: () => `\n\nYou can search the public web with ${WEB_SEARCH}. Use it when the answer is not in this `
    + 'workspace and not something you already know — current events, prices, documentation, anything after your '
    + 'training. Look in the room first: what people here have said, and what the other tools read, is better '
    + 'evidence about this workspace than anything the web will tell you. Give it a self-contained objective and '
    + 'two or three keyword queries, once — not the same search again in different words. What comes back is '
    + 'extracted page text, which can be wrong, out of date or somebody\'s marketing, so say what you found and '
    + 'link the source as [title](url), with its date when the answer turns on how current it is. Never present '
    + 'a search result as something you know.',

  handle: async (_deps, _run, args) => {
    const objective = asText(args['objective']);
    const queries = queriesFrom(args['queries']);
    if (objective.length === 0 || queries.length === 0) {
      return {
        result: 'failed',
        message: `${WEB_SEARCH} needs an \`objective\` — one sentence on what you are trying to find out — and `
          + '`queries`, two or three keyword searches.',
      };
    }

    // An unrecognised window is dropped rather than refused: the search without
    // it still answers the question, and a refusal costs a whole turn.
    const asked = asText(args['within']);
    const within = asked in WINDOW_DAYS ? asked : '';

    const outcome = await search(objective, queries, within);
    if (!outcome.ok) {
      count('web.search', { search_outcome: outcome.code });
      return {
        result: 'failed',
        message: `${outcome.message}. Tell the person you could not search, and answer from what you have.`,
      };
    }

    count('web.search', { search_outcome: outcome.sources.length === 0 ? 'no_results' : 'ok' });
    if (outcome.sources.length === 0) {
      return {
        result: 'ok',
        data: { objective, sources: [], note: 'Nothing was found. Say so rather than answering as if you had searched.' },
      };
    }

    return {
      result: 'ok',
      data: {
        objective,
        queries,
        ...(within ? { within } : {}),
        sources: outcome.sources,
        note: 'Extracted from the pages listed. Cite what you use as [title](url).',
      },
    };
  },
};
