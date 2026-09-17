// The bridge to everything outside Relayed, through Composio
// (docs/WORKSPACE-AGENTS.md §5.5, the plan's step 7).
//
// TWO TOOLS, AND ONLY ONE OF THEM IS AN `AppTool`. `find_tools` answers from a
// search and fits the ordinary shape. `call_tool` does not: it carries the
// permission check, the access card, the audit row and execution through a
// person's own session — ten steps, half of them in `checkpoints.ts` — and
// pretending that is "a handler like any other" would hide the one path in the
// app that spends somebody's account. Its SCHEMA lives here, beside its
// sibling; its lifecycle stays in the broker route, named there as the
// exception.
import type { RunTool } from '@relayed/protocol';
import { checkAccess } from '../checkpoints.ts';
import { raiseAccessRequest } from '../access.ts';
import { ComposioError, type SearchResult } from '../composio.ts';
import { mapComposioError } from '../tool-errors.ts';
import { rememberIdentities } from '../identities.ts';
import { asText, type AppTool, type OfferedToolkit } from './contract.ts';

export const FIND_TOOLS = 'find_tools';
export const CALL_TOOL = 'call_tool';

/** Tools one search hands the model. Composio returns about six; more is context spent on near misses. */
const FOUND_TOOLS_CAP = 8;

/**
 * `toolkit` is an enum of what this deployment offers, so the model names the
 * service before it searches (D22): Composio's search never answers "nothing
 * fits" — asked to post in Slack with only GitHub enabled, it returns GitHub
 * tools — so the choice of service cannot be left to the search.
 */
export function serviceTools(toolkits: readonly OfferedToolkit[]): RunTool[] {
  if (toolkits.length === 0) return [];
  return [
    {
      name: FIND_TOOLS,
      description: 'Find the tools for one task in one service, on behalf of the person who asked. '
        + 'Only for a service the request itself needs — never to look around another service for background. '
        + `Call this before ${CALL_TOOL}. Returns tool names with the arguments each takes. `
        + 'If the person has not given you access to that service yet, a card asking them for it is '
        + 'posted in the chat and this returns an error saying so.',
      parameters: {
        type: 'object',
        required: ['toolkit', 'use_case'],
        properties: {
          toolkit: {
            type: 'string',
            enum: toolkits.map(toolkit => toolkit.slug),
            description: `The service: ${toolkits.map(toolkit => `${toolkit.slug} (${toolkit.name})`).join(', ')}.`,
          },
          use_case: {
            type: 'string',
            description: 'What you need to do, in plain words, with the specifics you know — '
              + 'for example "read issue #445 in acme/web".',
          },
        },
      },
    },
    {
      name: CALL_TOOL,
      description: `Run one tool that ${FIND_TOOLS} returned, with arguments matching that tool's parameters.`,
      parameters: {
        type: 'object',
        required: ['tool', 'arguments'],
        properties: {
          tool: { type: 'string', description: `A tool name exactly as ${FIND_TOOLS} returned it.` },
          arguments: { type: 'object', description: "The tool's arguments.", additionalProperties: true },
        },
      },
    },
  ];
}

/** What the system prompt says about the services this deployment offers. Empty when there are none. */
export function servicesPrompt(toolkits: readonly OfferedToolkit[]): string {
  if (toolkits.length === 0) return '';
  return `\n\nYou can use these services on behalf of the person who asked: `
    + `${toolkits.map(toolkit => toolkit.name).join(', ')}. To use one, call ${FIND_TOOLS} for that service, `
    + `then ${CALL_TOOL} with a tool it returned.`;
}

/**
 * Search one toolkit for the tools a task needs (step 7).
 *
 * Access is asked for HERE, before the model has planned anything, rather than
 * at its first call: the card arrives as soon as the agent knows which service
 * it needs, and no write can have happened before it. Checked at `read` — the
 * least any tool needs — and asked for at `write`, which is what Allow grants
 * (D23); a destructive tool asks again when it is actually called.
 *
 * What comes back is built here from the search, never the search response
 * itself (D27), and only for tools our catalogue lists in that toolkit: the
 * model is never handed a tool name `call_tool` would then refuse.
 */
export const findTools: AppTool = {
  name: FIND_TOOLS,
  // Its schema comes from `serviceTools`, which needs the toolkit list — the
  // registry adds those separately, so this offers nothing of its own.
  definition: () => null,

  handle: async (deps, run, args) => {
    const toolkit = asText(args['toolkit']);
    const useCase = asText(args['use_case']);
    if (!useCase) return { result: 'failed', message: `${FIND_TOOLS} needs a use_case: what you want to do.` };

    const offered = await deps.db.selectFrom('toolkits').select(['slug', 'name'])
      .where('slug', '=', toolkit).where('enabled', '=', true).executeTakeFirst();
    if (!offered) return { result: 'tool_not_allowed' };

    const access = await checkAccess(deps.db, {
      invokerActorId: run.invokerActorId, agentActorId: run.agentActorId, toolkit: offered.slug, effect: 'read',
    });
    if (access.kind === 'stop') {
      await raiseAccessRequest(deps.db, deps.deliver, {
        runId: run.runId, invokerActorId: run.invokerActorId, agentActorId: run.agentActorId,
        toolkit: offered.slug, effect: 'write',
      });
      return { result: access.code };
    }

    let found: SearchResult;
    try {
      const sessionId = await deps.composio.session(deps.db, run.invokerActorId);
      found = await deps.composio.search(sessionId, `${offered.name}: ${useCase}`);
      // The session is the asker's own: what it says about who they are is theirs to keep.
      await rememberIdentities(deps.db, run.invokerActorId, found.identities).catch(() => { /* next search */ });
    } catch (err) {
      if (!(err instanceof ComposioError)) throw err;
      const mapped = mapComposioError(err);
      // A refusal is not a hiccup: the same search will be refused again, and a
      // model left to guess retries it — or reaches for whatever the error text
      // names, as a real run did with two toolkit slugs from it.
      const stop = mapped.code === 'refused' || mapped.code === 'failed'
        ? ' Do not retry this search. Tell the person the service could not be reached.' : '';
      return {
        result: mapped.code === 'refused' ? 'failed' : mapped.code,
        ...('message' in mapped ? { message: `${mapped.message}${stop}` } : stop ? { message: stop.trim() } : {}),
      };
    }

    const rows = found.toolSlugs.length === 0 ? [] : await deps.db.selectFrom('toolkit_tools')
      .select(['slug', 'description', 'input_schema'])
      .where('toolkit', '=', offered.slug).where('deprecated', '=', false)
      .where('slug', 'in', found.toolSlugs)
      .execute();
    const bySlug = new Map(rows.map(row => [row.slug, row]));
    const tools = found.toolSlugs
      .map(slug => bySlug.get(slug))
      .filter(row => row !== undefined)
      .slice(0, FOUND_TOOLS_CAP)
      .map(row => ({
        name: row.slug,
        description: row.description,
        parameters: found.schemas[row.slug] ?? row.input_schema,
      }));

    if (tools.length === 0) {
      return {
        result: 'ok',
        data: {
          tools: [],
          note: `No ${offered.name} tool matched. Describe the task differently, or tell the person it cannot be done with ${offered.name}.`,
        },
      };
    }
    return { result: 'ok', data: { tools } };
  },
};
