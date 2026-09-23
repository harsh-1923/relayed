// How a mention of an actor looks in a stored body — ONE parser, used by the
// unread-counter and by what starts an agent run (WORKSPACE-AGENTS.md §5.1,
// the plan's D6). A badge and a run must not be able to disagree about what a
// mention is, which is only true if there is exactly one place that decides.
//
// Messages use a canonical Markdown application link whose target is the
// actor id: `[label](actor:act_…)`. The label is a human-readable fallback
// only; identity and mention counting depend on the durable target.
//
// `[label](actor-ref:act_…)` is a REFERENCE — drawn the same, and deliberately
// NOT a mention: neither pattern below matches it, so it moves no badge and
// starts no run. Agents choose between the two themselves (`agents/people.ts`).

/** The SQL `LIKE` pattern for one actor's mention, in a stored body. */
export const mentionPattern = (actorId: string): string => `%](actor:${actorId})%`;

/** Every actor mentioned in a body, by scanning the same link form directly. */
export function mentionedActorIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(/\]\(actor:([^)]+)\)/g)) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

// ─── A name used as an address ───────────────────────────────────────────────

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words that make a name at the start an address rather than the subject: "Triage who…", not "Triage the…". */
const ASKING = 'who|what|when|where|why|how|which|can|could|would|will|please';

/** Whether a body could be addressing someone by name at its start — cheap enough for every send. */
export const LOOKS_ADDRESSED = new RegExp(`^(?:@?[\\p{L}\\p{N}_-]+\\s*[,:]|(?:hey|hi|hello|yo)\\s+|@?[\\p{L}\\p{N}_-]+\\s+(?:${ASKING})\\s)`, 'iu');

/**
 * "triage, …", "Triage: …", "hey triage …", "hi @triage …", "Triage who is…",
 * "triage can you…" — an agent's name used as an address at the start of a
 * message invokes it, like a mention (AMBIENT-RESPONSES.md §4). Not "let's
 * triage this", not "Triage the deploy failures first" — an imperative to the
 * room, which an unprompted agent once read as its own to-do and replied "I'll
 * triage deploy failures" (spikes/ambient, finding 15) — and not "Triage is
 * broken again", which is about the agent, not to it.
 */
export function addressedAgent<K extends string>(body: string, agents: ReadonlyArray<{ key: K; handle: string; name: string }>): K | null {
  const trimmed = body.trim();
  if (!LOOKS_ADDRESSED.test(trimmed)) return null;
  for (const agent of agents) {
    const names = [agent.handle, agent.name].filter(name => name.trim().length > 0).map(escapeRegExp).join('|');
    if (names.length === 0) continue;
    const address = new RegExp(`^@?(?:${names})\\s*[,:]`, 'iu');
    const greeting = new RegExp(`^(?:hey|hi|hello|yo)\\s+@?(?:${names})(?![\\p{L}\\p{N}_-])`, 'iu');
    const asked = new RegExp(`^@?(?:${names})\\s+(?:${ASKING})\\s`, 'iu');
    if (address.test(trimmed) || greeting.test(trimmed) || asked.test(trimmed)) return agent.key;
  }
  return null;
}
