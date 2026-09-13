// The agent runner: the process that talks to the person's Claude Code, and
// nothing else (docs/LOCAL-ROOMS.md §5).
//
// A utilityProcess of its own rather than part of the sync engine, for the
// reasons the sync engine is not part of main: a turn streams partial messages
// many times a second and must not share a thread with synchronous SQLite, and
// this is the part that gets restarted — a stalled provider, a child that will
// not die — which must not drop the socket.
//
// IT OWNS NO DATABASE AND HOLDS NO CREDENTIAL. No vault, no session token, no
// idea which workspace is open. It is given a port to the sync engine by main,
// answers what it is asked, and that is the whole of its authority.
import type { RunnerEvent, RunnerOp, RunnerOps, RunnerReply, RunnerRequest } from '../shared/claude.ts';
import { probeStatus, readCommands } from './claude/status.ts';
import { generateText } from './claude/generate.ts';
import { ChatSessions } from './claude/turns.ts';

type Handlers = { [Op in RunnerOp]: (params: RunnerOps[Op]['params']) => Promise<RunnerOps[Op]['result']> };

/**
 * One probe at a time. The status screen and a second window asking together
 * share the child that is already starting rather than spawning two.
 */
let probing: Promise<RunnerOps['claude.status']['result']> | null = null;

/**
 * The sync engine's port, as of its latest start. Events go to whichever is
 * current: a turn outlives a sync engine restart, and its remaining reports
 * belong to the process that now owns the database.
 */
let current: Electron.MessagePortMain | null = null;

const emit = (event: RunnerEvent): void => { current?.postMessage(event); };
const sessions = new ChatSessions(emit);

const handlers: Handlers = {
  'claude.status': () => (probing ??= probeStatus().finally(() => { probing = null; })),
  'claude.commands': ({ cwd }) => readCommands(cwd),
  'text.generate': (params) => generateText(params),
  'turn.start': (params) => { sessions.start(params); return Promise.resolve(null); },
  'turn.stop': ({ chatId }) => { sessions.stop(chatId); return Promise.resolve(null); },
  'approval.respond': ({ chatId, approvalId, decision }) => { sessions.respond(chatId, approvalId, decision); return Promise.resolve(null); },
  'room.mode': ({ chatIds, mode }) => { sessions.setMode(chatIds, mode); return Promise.resolve(null); },
  'room.model': ({ chatIds, model, effort }) => { sessions.setModel(chatIds, model, effort); return Promise.resolve(null); },
};

function serve(port: Electron.MessagePortMain): void {
  current = port;
  port.on('message', (event: Electron.MessageEvent) => {
    const request = event.data as RunnerRequest;
    void (async () => {
      let reply: RunnerReply;
      try {
        const handler = handlers[request.op] as ((params: unknown) => Promise<unknown>) | undefined;
        if (!handler) throw new Error(`unknown op: ${String(request.op)}`);
        reply = { id: request.id, ok: true, data: await handler(request.params) };
      } catch (error) {
        reply = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      port.postMessage(reply);
    })();
  });
  port.on('close', () => { if (current === port) current = null; });
  port.start();
}

// A new port arrives whenever the sync engine is (re)started; each is served
// independently, and a dead one simply stops receiving.
process.parentPort.on('message', (event) => {
  const [port] = event.ports;
  if (port && (event.data as { type?: string } | undefined)?.type === 'attach') serve(port);
});

// Quitting closes every Claude Code child rather than orphaning it.
process.on('exit', () => sessions.closeAll());
