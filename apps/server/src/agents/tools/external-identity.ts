// "Assign it to Bob in Linear": which Linear user Bob is, from his own
// connection rather than a guess by name (`identities.ts`).
import type { RunTool } from '@relayed/protocol';
import { identitiesOf } from '../identities.ts';
import { asText, type AppTool } from './contract.ts';

export const EXTERNAL_IDENTITY = 'external_identity';

const DEFINITION: RunTool = {
  name: EXTERNAL_IDENTITY,
  description: 'Find who people are in a connected service — their id there, and their username or name — before you '
    + 'assign, mention or add them in it. Use this instead of matching names against the service\'s user list: two '
    + 'people can share a name.',
  parameters: {
    type: 'object',
    required: ['toolkit', 'people'],
    properties: {
      toolkit: { type: 'string', description: 'The service, e.g. "linear" or "github".' },
      people: { type: 'array', items: { type: 'string' }, description: 'Actor ids, e.g. "act_01M2…".' },
    },
  },
};

const REASONS = {
  not_connected: 'They have not connected this service, so who they are in it is not known. Ask the person who asked.',
  not_known_yet: 'They have connected it, but it is not known yet who they are in it. Ask the person who asked, rather than guessing by name.',
  not_in_workspace: 'Not a person in this workspace.',
} as const;

export const externalIdentity: AppTool = {
  name: EXTERNAL_IDENTITY,
  definition: () => DEFINITION,
  prompt: () => `\n\nTo assign, mention or add a person in a connected service, call ${EXTERNAL_IDENTITY} for them `
    + 'first and use the id it returns. Never pick someone from a service\'s user list by name alone.',

  handle: async (deps, run, args) => {
    const toolkit = asText(args['toolkit']).toLowerCase();
    const people = Array.isArray(args['people'])
      ? [...new Set(args['people'].filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
    if (!toolkit || people.length === 0) {
      return { result: 'failed', message: `${EXTERNAL_IDENTITY} needs a toolkit and the actor ids of the people.` };
    }
    const place = await deps.db.selectFrom('chats').select('workspace_id').where('id', '=', run.chatId).executeTakeFirst();
    if (!place) return { result: 'run_not_running' };

    const answers = await identitiesOf(deps.db, place.workspace_id, toolkit, people.slice(0, 25));
    return {
      result: 'ok',
      data: {
        toolkit,
        people: answers.map(answer => (answer.found ? answer : { ...answer, note: REASONS[answer.reason] })),
      },
    };
  },
};
