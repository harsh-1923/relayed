// How agents see people, and how they name them in what they write.
//
// Every person or agent an agent reads about is labelled with their actor id,
// and the agent writes one of two links when it names somebody:
//
//   [Name](actor-ref:act_…)   a REFERENCE — the chip, the face, no notification.
//   [Name](actor:act_…)       a MENTION — counts on their badge, and on an agent
//                             starts a run (`sync/mentions.ts`, `checkpoints.ts`).
//
// NOTE — DELIBERATELY NOT PARSED. The model writes these links itself, and the
// server does no rewriting of what it wrote: no resolving `@handle` or names
// into links, no demoting a mention to a reference. Decided 2026-09-17, to see
// how models behave first. If they garble ids, write names where links belong,
// or mention people they only meant to refer to, the fallback considered was:
// have the model write `@handle` and resolve handles on the server when agent
// output is stored (replies in `reply.ts`, summaries in `summariser.ts`).

/** One actor as an agent reads it: `Harsh Sharma (@harsh, act_01M2…)`. */
export function personLabel(actor: { id: string; displayName: string; handle: string }, note?: string): string {
  return `${actor.displayName} (@${actor.handle}${note ? `, ${note}` : ''}, ${actor.id})`;
}

/** The rule, for any agent that writes text people read. */
export const PEOPLE_PROMPT = [
  'People and agents are shown as Name (@handle, act_…). When you name one in what you write, link them with that id, copied exactly:',
  '- [Name](actor-ref:act_…) to refer to them. It shows their name and face and notifies nobody. Use this by default.',
  '- [Name](actor:act_…) only when you mean to get their attention: it notifies them, and on an agent it asks the agent to act.',
  'Never write email addresses for people.',
].join('\n');
