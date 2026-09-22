// The tools a workspace-agent run is given, and who answers them
// (docs/WORKSPACE-AGENTS-IMPL.md, step 7, D21).
//
// ONE ORDERED LIST. Adding a tool is a new file beside this one and a line in
// `APP_TOOLS`; nothing else in the app changes, which is the point of the
// directory. The dispatcher offers what this says; the broker answers through
// what this says; neither holds its own idea of what the tools are.
//
// THE ORDER MATTERS and is not alphabetical. It decides both the order the
// model sees the tools in and the order their prompt fragments are appended,
// and two of them have to come last: a run stopped for access is re-run from
// the beginning, so a room created or a message sent before that stop would be
// created or sent twice. Everything that only reads comes first.
import type { RunTool } from '@relayed/protocol';
import { openPanel } from './open-panel.ts';
import { readRoomSummary, writeRoomSummary } from './room-summary.ts';
import { createRoomFor } from './create-room.ts';
import { startSideChat } from './side-chat.ts';
import { roomMembers } from './room-members.ts';
import { externalIdentity } from './external-identity.ts';
import { rememberPreference } from './remember.ts';
import { webSearch } from './web-search.ts';
import { sendDm, postMessage, addToRoom } from './messaging.ts';
import { findTools, serviceTools, servicesPrompt, CALL_TOOL } from './services.ts';
import type { AppTool, OfferedToolkit, ToolContext, ToolDeps, ToolReply, Where } from './contract.ts';

export type { AppTool, OfferedToolkit, ToolContext, ToolDeps, ToolReply, Where } from './contract.ts';
export { asRecord } from './contract.ts';
export { FIND_TOOLS, CALL_TOOL, serviceTools } from './services.ts';
export { OPEN_PANEL } from './open-panel.ts';
export { CREATE_ROOM } from './create-room.ts';
export { START_SIDE_CHAT } from './side-chat.ts';
export { ROOM_MEMBERS } from './room-members.ts';
export { EXTERNAL_IDENTITY } from './external-identity.ts';
export { REMEMBER } from './remember.ts';
export { WEB_SEARCH } from './web-search.ts';
export { SEND_DM, POST_MESSAGE, ADD_TO_ROOM } from './messaging.ts';
export { READ_ROOM_SUMMARY, WRITE_ROOM_SUMMARY } from './room-summary.ts';

/** Every tool the broker can answer, in the order a run is offered them. */
const APP_TOOLS: readonly AppTool[] = [
  // Reads and things that cannot be done twice harmfully.
  findTools,
  openPanel,
  readRoomSummary,
  roomMembers,
  externalIdentity,
  rememberPreference,
  // Last of the reads: what this workspace knows about itself is better
  // evidence than the web, and the order decides what the model sees first.
  webSearch,
  writeRoomSummary,
  // Last: see the note on ordering above.
  createRoomFor,
  startSideChat,
  sendDm,
  postMessage,
  addToRoom,
];

/** The tools this run is offered, as the runtime registers them. */
export function runTools(toolkits: readonly OfferedToolkit[], where: Where): RunTool[] {
  return [
    ...serviceTools(toolkits),
    ...APP_TOOLS.flatMap(tool => {
      const definition = tool.definition(where);
      return definition ? [definition] : [];
    }),
  ];
}

/** Appended to the agent's own instructions. Only offered tools get a word. */
export function toolsPrompt(toolkits: readonly OfferedToolkit[], where: Where): string {
  return servicesPrompt(toolkits)
    + APP_TOOLS.map(tool => (tool.definition(where) && tool.prompt ? tool.prompt(where) : '')).join('');
}

/**
 * Answer one tool call, or say there is nobody to answer it.
 *
 * THE OFFER IS THE AUTHORISATION: a tool this run was not offered is refused
 * here, rather than run because the model asked for it. `where` is recomputed
 * from the run's own place rather than taken from the call, so a model that
 * names a tool it never received gets `tool_not_allowed` whatever it claims.
 *
 * `call_tool` is deliberately absent — the broker route keeps it, because its
 * ten steps are a lifecycle rather than a handler (`services.ts`).
 */
export async function handleAppTool(
  name: string, deps: ToolDeps, run: ToolContext, where: Where, args: Record<string, unknown>,
): Promise<ToolReply | null> {
  if (name === CALL_TOOL) return null;
  const tool = APP_TOOLS.find(candidate => candidate.name === name);
  if (!tool) return null;
  // `find_tools` offers no definition of its own — its schema comes with the
  // toolkit list — so it is admitted whenever this deployment offers any.
  const offered = tool.name === 'find_tools' ? true : tool.definition(where) !== null;
  if (!offered) return { result: 'tool_not_allowed' };

  const inactive = await inactiveParty(deps, run);
  if (inactive) return { result: inactive };
  return tool.handle(deps, run, args);
}

/**
 * Step 4 (§5.5): the person and the agent are both still active.
 *
 * Asked once, here, for every app tool — it was three separate copies before,
 * and a fourth tool forgetting it would have been a run acting for somebody who
 * has left.
 */
async function inactiveParty(deps: ToolDeps, run: ToolContext): Promise<string | null> {
  const [invoker, agent] = await Promise.all([
    deps.db.selectFrom('actors').select('state').where('id', '=', run.invokerActorId).executeTakeFirst(),
    deps.db.selectFrom('actors').select('state').where('id', '=', run.agentActorId).executeTakeFirst(),
  ]);
  if (!invoker || invoker.state !== 'active') return 'invoker_inactive';
  if (!agent || agent.state !== 'active') return 'agent_inactive';
  return null;
}
