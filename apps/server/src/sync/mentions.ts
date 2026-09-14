// How a mention of an actor looks in a stored body — ONE parser, used by the
// unread-counter and by what starts an agent run (WORKSPACE-AGENTS.md §5.1,
// the plan's D6). A badge and a run must not be able to disagree about what a
// mention is, which is only true if there is exactly one place that decides.
//
// Messages use a canonical Markdown application link whose target is the
// actor id: `[label](actor:act_…)`. The label is a human-readable fallback
// only; identity and mention counting depend on the durable target.

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
