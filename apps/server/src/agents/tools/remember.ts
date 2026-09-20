// Writing down how somebody wants to be worked with (docs/MEMORY.md §5.5).
//
// THE ONLY WAY ANYTHING ENTERS A PERSON BANK. Nothing extracts into it in the
// background, and that is deliberate: a person bank is the one bank that
// travels with somebody into every room, so what goes in has to be something
// they asked for rather than something inferred from what they said.
//
// The description below carries most of the guard. The rest is the bank's own
// extraction mission, which refuses subject matter even when handed some — two
// layers, because this is the one place the guarantee is not structural.
import type { RunTool } from '@relayed/protocol';
import { remember, notesFromCall } from '../../memory/person.ts';
import { env } from '../../env.ts';
import { asText, type AppTool } from './contract.ts';

export const REMEMBER = 'remember';

const DEFINITION: RunTool = {
  name: REMEMBER,
  description: 'Remember how this person wants to be worked with, from now on and everywhere — the format, '
    + 'length or tone they want, conventions they prefer, what they own, what you should do by default. '
    + 'ONLY when they ask you to remember something, in so many words. Never on your own initiative, and never '
    + 'for anything about a conversation\'s subject — a decision, an incident, a ticket or an event is remembered '
    + 'by the room itself and must not go here.',
  parameters: {
    type: 'object',
    required: ['preference'],
    properties: {
      preference: {
        type: 'string',
        description: 'What to remember, as a sentence about them: "prefers short answers that lead with the '
          + 'schema". Their words, not a summary of the conversation.',
      },
    },
  },
};

export const rememberPreference: AppTool = {
  name: REMEMBER,
  // Offered on MEMORY_RECALL, not on Hindsight merely being configured. A
  // preference nothing will ever read is not worth asking somebody to state,
  // and an offer that depends on an API key being present is an offer that
  // changes between environments without anybody deciding it should.
  definition: () => (env.memoryRecall ? DEFINITION : null),
  prompt: () => `\n\nWhen somebody asks you to remember how they want to be worked with — "keep answers short from `
    + `now on", "always lead with the schema", "call me Haz" — call ${REMEMBER} with it. What you store there `
    + 'follows them into every room, so it must be about THEM and how they work, never about what a conversation '
    + 'was about. Do not call it because something seemed worth remembering: only when they asked. Then say in one '
    + 'short line what you will remember, so they can correct you.',

  handle: async (deps, run, args) => {
    const preference = asText(args['preference']);
    if (preference.length === 0) {
      return { result: 'failed', message: `${REMEMBER} needs the preference to remember, in \`preference\`.` };
    }

    // Written to the INVOKER'S bank, from the run row — never to an actor named
    // in the arguments. A model that asks to remember something about somebody
    // else is writing to the person who asked, or to nobody.
    const person = await deps.db.selectFrom('actors').select(['display_name', 'type', 'state'])
      .where('id', '=', run.invokerActorId).executeTakeFirst();
    if (!person || person.type !== 'human') return { result: 'tool_not_allowed' };

    const documentId = await remember(deps.db, run.invokerActorId, person.display_name, preference, run.runId);
    const stored = await notesFromCall(run.invokerActorId, run.runId).catch(() => []);

    // What was STORED comes back, not what was asked — the mission refuses
    // subject matter, so an attempt to file a conversation here produces
    // nothing, and the model should say that rather than claim success.
    return {
      result: 'ok',
      data: {
        remembered: stored.map((fact) => fact.text),
        document_id: documentId,
        note: stored.length === 0
          ? 'Nothing was stored: this is not a lasting preference about the person. Tell them so.'
          : 'Stored. It will apply in every room from now on.',
      },
    };
  },
};
