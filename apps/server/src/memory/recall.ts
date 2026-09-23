// What a run remembers, and how it says where it got it (docs/MEMORY.md §7).
//
// Runs on EVERY run, unprompted, and is injected rather than offered as a tool.
// That is the product decision (§4.4): a model that recalls only when it thinks
// to will mostly not think to, and "richer than the question deserved" is not
// something an opt-in mechanism produces.
//
// xyne-spaces moved the other way — a `memory-search` tool, no per-turn
// injection, because injected facts "bias source-of-truth-first workflows (RCA,
// metrics, reports, code review) toward stale memory". Their agents do root-cause
// analysis, where a live system is the truth and a remembered fact competes with
// checking it. Ours answer "who owns this" and "what did we decide", where the
// conversation IS the truth and there is nothing fresher to consult. So we keep
// injection and borrow the guard: every fact is dated, cited, and explicitly
// subordinate to the transcript below it (§7.2).
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import {
  banksForRun, memoryPresence, personBank, publicSpaceIds, refilter, type SpacePlacement,
} from './banks.ts';
import { memoryConfigured, recall, type Fact } from './client.ts';
import { stripOwnMention } from '../agents/transcript.ts';

/** Facts in the block. Past this the block stops being context and becomes noise. */
const TOP_K = 6;
/** A run answers late or not at all without memory; it never waits for it (§11). */
const DEADLINE_MS = 3_000;
/** Token-set overlap above which two facts are the same fact, said twice. */
const DUPLICATE_AT = 0.6;

export interface RecalledFact {
  text: string;
  score: number;
  /** Where it came from, or null when the messages behind it are gone. */
  citation: { messageId: string; label: string } | null;
}

/**
 * The question, as asked, minus the markup — and minus the summons.
 *
 * TWO DIFFERENT REMOVALS, and conflating them cost a run. Links carry durable
 * ids (`[Triage](actor:act_01M2…)`), and an id is a long meaningless token the
 * keyword arm will rank on, so ids go and labels stay. But THE INVOKED AGENT'S
 * OWN MENTION goes entirely, label and all: it is there to address the agent,
 * not to describe what is being asked about.
 *
 * Measured 2026-09-20. `"triage What day is it today?"` returned six facts
 * about Triage — its restart, its tickets, its side chats — topping out at
 * **0.460**. The same question without the summons tops out at **0.031**:
 * retrieval already knew there was nothing there, and the agent's own name was
 * manufacturing a match. It distorted a good question too — with the summons,
 * the launch deadline ranked 4th at 0.019 behind an irrelevant fact at 0.633;
 * without it, the deadline ranks 1st.
 *
 * `stripOwnMention` is `transcript.ts`'s, reused rather than rewritten: the
 * transcript has always dropped the summons and kept everyone else's mentions,
 * and two copies of that rule would be two chances to disagree.
 */
export const queryFrom = (body: string, agentActorId: string): string =>
  stripOwnMention(body, agentActorId)
    .replace(/\[([^\]]*)\]\((?:actor|actor-ref|message|space):[^)]*\)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 1_000);

export interface RunPlace {
  workspaceId: string;
  spaceId: string;
  visibility: 'public' | 'private' | null;
  /** NULL for a job (an ambient answer): no person bank is opened (`banksForRun`). */
  invokerActorId: string | null;
  /** The triggering message, as asked. Recall is a question, not a keyword list. */
  query: string;
}

/**
 * Hindsight annotates what it stores — a fact comes back as
 * `"…blocked by vault rotation. | When: 2026-09-01 | Involving: Dev Anand"`.
 *
 * `When` and `Involving` are dropped because the citation already carries the
 * date and the transcript already names the people; anything else after a pipe
 * is kept, because extraction sometimes puts a rationale there and that is worth
 * reading. Display only — what is STORED is never rewritten, and never
 * re-retained, or the annotation compounds on every pass (§9).
 */
export const cleanFactText = (text: string): string =>
  text.split(' | ')
    .filter((segment, index) => index === 0 || !/^(When|Involving):/.test(segment.trim()))
    .join(' — ')
    .trim();

const tokens = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));

const overlap = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
};

/**
 * Drop a fact that is another fact said twice.
 *
 * Not tidiness: the same fact gets extracted from several overlapping episodes,
 * and a reranker surfaces the copies together — so without this the top of the
 * block is one thing repeated and the distinct knowledge is pushed out of it.
 * xyne-spaces found this the hard way ("REDIS_HOST is… x40").
 */
function dropDuplicates(facts: readonly Fact[]): Fact[] {
  const kept: { fact: Fact; words: Set<string> }[] = [];
  for (const fact of facts) {
    const words = tokens(fact.text);
    if (kept.some((seen) => overlap(seen.words, words) >= DUPLICATE_AT)) continue;
    kept.push({ fact, words });
  }
  return kept.map((entry) => entry.fact);
}

interface Citation { messageId: string; label: string }

/**
 * Where each fact came from, as something a person can click.
 *
 * ANCHORED AT THE EPISODE'S FIRST MESSAGE, and that is the honest answer rather
 * than the precise one: a fact is extracted from a conversation, not from one
 * line of it, and Hindsight gives no per-message provenance. So the citation
 * says "this came out of this conversation, which starts here" — which is what
 * a reader wants anyway, since the line alone rarely carries the fact (§3).
 */
async function citations(db: Kysely<DB>, documentIds: readonly string[]): Promise<Map<string, Citation>> {
  const found = new Map<string, Citation>();
  if (documentIds.length === 0) return found;

  const rows = await sql<{
    document_id: string; message_id: string | null; space_name: string | null; created_at: Date;
  }>`
    SELECT d.document_id, m.id AS message_id, s.name AS space_name, m.created_at
      FROM memory_documents d
      JOIN spaces s   ON s.id = d.space_id
      LEFT JOIN messages m ON m.chat_id = d.chat_id AND m.ord = d.ord_start AND m.deleted = false
     WHERE d.document_id = ANY(${[...documentIds]})`.execute(db);

  for (const row of rows.rows) {
    if (!row.message_id) continue;   // the anchor was deleted; the fact goes uncited
    const when = new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    found.set(row.document_id, {
      messageId: row.message_id,
      label: `${row.space_name ?? 'this room'}, ${when}`,
    });
  }
  return found;
}

export interface Recalled {
  /** Facts from places — the cited block above the transcript. */
  facts: RecalledFact[];
  /**
   * How the person who asked wants to be worked with.
   *
   * KEPT SEPARATE, and never merged into `facts`. A preference is not a
   * recollection about this room, it is not citable, and it applies to how the
   * reply is written rather than to what it says. Fusing the two would put
   * something that travels between rooms into a block whose every other line is
   * anchored to one (§5.5).
   */
  aboutPerson: string[];
}

/**
 * What this run may recall, from the banks it may read.
 *
 * Each bank is asked in parallel, and each failure is its own: one bank being
 * slow or down costs its facts, not the block. The whole thing is wrapped in a
 * deadline because memory is additive — a run without it is exactly today's
 * behaviour, and an answer late is worse than an answer less rich (§11).
 */
export async function recallForRun(db: Kysely<DB>, place: RunPlace): Promise<Recalled> {
  if (!memoryConfigured()) return { facts: [], aboutPerson: [] };

  const space: SpacePlacement =
    { id: place.spaceId, workspaceId: place.workspaceId, visibility: place.visibility };
  // Both local, and both cheap. Asked first so a bank with nothing in it is
  // never opened: an empty one costs seconds to say nothing, and those seconds
  // came out of the deadline the banks with content were working to.
  const [live, presence] = await Promise.all([
    publicSpaceIds(db, place.workspaceId),
    memoryPresence(db, place.workspaceId, place.invokerActorId),
  ]);
  const banks = banksForRun(space, place.invokerActorId, live, presence);
  if (banks.length === 0) return { facts: [], aboutPerson: [] };

  const perBank = await Promise.all(banks.map(async (bank) => {
    try {
      const facts = await recall({
        bankId: bank.id, query: place.query, tags: bank.tags, timeoutMs: DEADLINE_MS,
      });
      // The re-filter, and it is the enforcement rather than hardening inside
      // the workspace bank — see `banks.ts`. A filter that behaves today is not
      // a boundary.
      return { bankId: bank.id, facts: refilter(facts, bank) };
    } catch {
      return { bankId: bank.id, facts: [] as Fact[] };
    }
  }));

  const mine = place.invokerActorId === null ? null : personBank(place.invokerActorId);
  const aboutPerson = perBank.find((entry) => entry.bankId === mine)?.facts
    .map((fact) => cleanFactText(fact.text)) ?? [];
  const fromPlaces = perBank.filter((entry) => entry.bankId !== mine).flatMap((entry) => entry.facts);

  // Observations carry no `document_id` and so cannot be cited (§6.4). They
  // should not appear at all with `enable_observations: false`, and are dropped
  // here too rather than trusted to be absent — an uncited fact in a block whose
  // whole promise is citation is worse than one fact fewer.
  // Strongest first, and the block SAYS SO (§7.2). The order was always this
  // way; until the header claimed it, the model had no reason to read the first
  // line as better evidence than the last — six facts arrived looking equally
  // weighted, including ones that merely shared a word with the question.
  //
  // Scores come from separate recalls, one per bank, so comparing them across
  // banks is approximate: same engine, same query, but not one ranking. Good
  // enough to order by, which is why the header says "matched most closely"
  // rather than anything stronger.
  const ranked = dropDuplicates(
    fromPlaces.filter((fact) => fact.documentId !== null)
      .sort((a, b) => (b.scoreFinal ?? 0) - (a.scoreFinal ?? 0)),
  ).slice(0, TOP_K);

  const cited = await citations(db, [...new Set(ranked.map((fact) => fact.documentId!))]);
  return {
    facts: ranked.map((fact) => ({
      text: cleanFactText(fact.text),
      score: fact.scoreFinal ?? 0,
      citation: cited.get(fact.documentId!) ?? null,
    })),
    aboutPerson,
  };
}

/**
 * The separate slot: how this person works.
 *
 * Told as instructions rather than offered as recollections, because that is
 * what they are — the person asked for them to apply, so hedging them the way
 * §7.2 hedges a remembered fact would be wrong.
 */
export function personPrompt(aboutPerson: readonly string[]): string {
  if (aboutPerson.length === 0) return '';
  return '\n\nHow the person who asked wants to be worked with. They told you these and they apply '
    + 'everywhere, so follow them unless this request says otherwise:\n'
    + aboutPerson.map((line) => `- ${line}`).join('\n');
}

/**
 * The block, placed directly above the transcript (§7.2).
 *
 * The preamble is the staleness guard xyne-spaces' finding bought us. It says
 * three things on purpose: these are recollections, they are dated, and the
 * conversation below wins. A model given facts with no such framing treats them
 * as current truth, which is exactly the bias that made them abandon injection.
 */
export function memoryBlock(facts: readonly RecalledFact[]): string {
  if (facts.length === 0) return '';
  const lines = facts.map((fact) => fact.citation
    ? `· ${fact.text}\n  [${fact.citation.label}](message:${fact.citation.messageId})`
    : `· ${fact.text}`);
  return [
    '── What Relayed remembers that may be relevant ───────────────────────────',
    'Recollections from earlier conversations, not part of the request. They may',
    'be out of date, and anything in the conversation below overrides them. If you',
    'use one, keep its citation link so the reader can check it.',
    '',
    'ORDERED STRONGEST MATCH FIRST. The first line matched the request most',
    'closely and the last matched it least; a line low in this list may have',
    'nothing to do with what was asked. Matching closely is not the same as',
    'being true or being relevant — weigh it, do not assume it.',
    '',
    ...lines,
    '──────────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}

/**
 * The rule that makes a citation actually appear, placed LAST (§7.2).
 *
 * WHY THIS IS SEPARATE FROM THE BLOCK. The block already asks for the link, and
 * that was not enough: the first real run recalled six on-topic facts, answered
 * straight off the first one — "Apollo and AWS AppSync are the two options
 * being considered" — and cited none of them. The same reply carried
 * `[Harsh Sharma](actor-ref:act_…)` correctly, so the model was following
 * `PEOPLE_PROMPT` and ignoring an instruction buried above a forty-message
 * transcript.
 *
 * `dispatcher.ts` already writes down why: a rule right before the model writes
 * outweighs the same rule buried earlier. So this goes at the very end, after
 * the writing rules, and only when something was actually recalled — a rule
 * about citing facts is noise on a run that has none.
 *
 * It leans on the behaviour that already works. Actor links are written
 * correctly and literally, so this says: the same kind of link, copied the same
 * way.
 */
export function citationPrompt(facts: readonly RecalledFact[]): string {
  const example = facts.find((fact) => fact.citation !== null)?.citation;
  if (!example) return '';
  return [
    '',
    '',
    'Citing what you remembered:',
    '- When a sentence in your reply uses something from "What Relayed remembers" above, END THAT '
    + 'SENTENCE with its citation link, copied exactly from the block — label and id, character for '
    + 'character.',
    `- It is the same kind of link you already write for people. [Name](actor-ref:act_…) for a person; `
    + `[${example.label}](message:${example.messageId}) for a thing you remembered.`,
    '- Never invent a link, never cite a fact you did not use, and never cite the conversation you are '
    + 'already in — only what came from memory.',
    '',
    '  Bad:  "Apollo and AWS AppSync are the two options being considered."',
    `  Good: "Apollo and AWS AppSync are the two options being considered `
    + `[${example.label}](message:${example.messageId})."`,
    '',
    'Without the link a reader cannot tell what you knew from what you inferred, and cannot check it.',
  ].join('\n');
}

/**
 * Which recalled facts this reply actually drew on (docs/MEMORY.md §7.2).
 *
 * DETECTED FROM THE CITATION LINK, not from resemblance. The block asks the
 * model to keep `[label](message:msg_…)` when it uses a fact, so a reply
 * carrying that id is proof — where fuzzy-matching a paraphrase against a fact
 * would be a guess dressed as provenance.
 *
 * It UNDER-REPORTS: a model that uses a fact and drops the link is invisible
 * here. That is the right direction to fail. A footer claiming a reply used
 * memory when it did not is worse than one that occasionally stays quiet, and
 * an empty result is honest information — memory was offered and changed
 * nothing.
 *
 * This is also the `memory.facts.cited` measurement §14.6 asks for: the footer
 * and the only metric that answers "is memory consequential" are one
 * computation, which is why the footer is worth building before the metric.
 */
export function citedFacts(replyText: string, offered: readonly RecalledFact[]): RecalledFact[] {
  const cited = offered.filter((fact) =>
    fact.citation !== null && replyText.includes(`message:${fact.citation.messageId}`));

  // One episode can produce several facts, so two of them can share an anchor
  // and a single link would credit both. Keep the first — the highest-ranked,
  // since `offered` is already in rank order.
  const seen = new Set<string>();
  return cited.filter((fact) => {
    const anchor = fact.citation!.messageId;
    if (seen.has(anchor)) return false;
    seen.add(anchor);
    return true;
  });
}
