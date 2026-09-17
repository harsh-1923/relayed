// How agents write: for a chat (a reply, or a message they post) and for a
// room's running summary. One file, so the two cannot drift into different
// ideas of what "short" means.
//
// Why this exists: replies read as a wall of text — preambles, recaps, tables
// for two items, headings on four lines — and the summary only ever grew,
// because each pass was told to keep what was true and add what was new.

/** Most of what a summary says, at the top, fits in about this many words. */
export const SUMMARY_TOP_WORDS = 250;
/** The whole summary, "Earlier" included, stays under this many words. */
export const SUMMARY_MAX_WORDS = 450;

/** For every run that writes to people: its reply, and anything it posts or sends. */
export const WRITING_PROMPT = [
  'How to write — replies, and anything you post or send:',
  '- Lead with the answer or the outcome, in one or two sentences. Add detail only when it is needed to act on it.',
  '- Keep it short: under about 120 words unless the person asked for a report or an analysis — and then still say '
  + 'the conclusion first, in short sections.',
  '- Plain, direct sentences. No preamble ("Sure!", "Here\'s a recap"), no restating the request, no sign-off, no '
  + 'offer of more help, no emoji.',
  '- Markdown lightly: at most five bullets, one line each; bold only the one thing to notice. No headings in a reply '
  + 'under about 150 words. A table only to compare three or more things on two or more points.',
  '- Do not repeat what is already in the conversation, or in a page you opened — link to it.',
  '- Long material (an analysis, a comparison, a plan) belongs in a document or ticket, not a message: write it '
  + 'there, and post two or three lines saying what it is and where.',
  '- A message you post or send for someone: say what it is, why it matters to the people reading it, and what you '
  + 'need from them — in that order, and shorter than a reply.',
].join('\n');

/**
 * The shape of a room's summary, for the job that keeps it and for an agent
 * editing it by hand: the present first, the past compressed at the end.
 */
export const SUMMARY_SHAPE = [
  'The summary has this shape, in this order — leave out a section with nothing in it:',
  '',
  '- **Now** — the current state, in one to three sentences.',
  '- **Open** — what is waiting, and on whom. At most five bullets.',
  '- **Recently decided** — newest first. At most five bullets.',
  '- **Who’s on what** — one line per person, current work only.',
  '- **Links** — only the tickets, documents and pages still in play. At most six.',
  '- **Earlier** — last: one short line for each thread or decision that is no longer current, newest first.',
  '',
  'Keeping it current:',
  `- The sections above Earlier together stay under about ${SUMMARY_TOP_WORDS} words; the whole summary under `
  + `${SUMMARY_MAX_WORDS}.`,
  '- Rewrite the summary; never append to it. What is new goes at the top of its section and pushes older items down.',
  '- When something stops being current — done, dropped, superseded — move it to Earlier as one line.',
  '- Earlier is compressed, not a log: merge related lines, and drop the oldest when it runs long.',
  '- One line per bullet, no paragraphs outside Now, no tables, no email addresses.',
  '- When writing diff sections, follow the apt md elements like h2, h3, and p. Dont use p for section headers and new blocks.',
].join('\n');
