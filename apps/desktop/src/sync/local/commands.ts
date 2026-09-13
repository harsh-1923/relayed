// A local room's slash commands, as the composer offers them (docs/LOCAL-ROOMS.md §8.7).
//
// Per FOLDER, because that is what decides the list: the project's own commands
// and skills live in it. Asked of the runner once — the handshake spends
// nothing but does start a Claude Code child, about a second — then kept for
// the life of the process, and replaced whenever a live session reports that
// its list changed. A read never waits on the ask: it returns what is known,
// and the answer arrives as an invalidation.
import { topic } from '../../shared/topics.ts';
import { roomCommands } from '../../shared/slash-commands.ts';
import type { ClaudeCommand, RunnerEvent, RunnerOps } from '../../shared/claude.ts';
import type { LocalStore } from './store.ts';

/** How long a list is trusted before the next read asks again, in case a command was added on disk. */
const STALE_AFTER_MS = 5 * 60_000;

export interface LocalCommandsDeps {
  store: () => LocalStore | null;
  runner: { request: (op: 'claude.commands', params: RunnerOps['claude.commands']['params']) => Promise<ClaudeCommand[]> };
  invalidate: (topics: string[]) => void;
  now?: () => number;
}

interface Entry {
  commands: ClaudeCommand[];
  fetchedAt: number;
  asking: boolean;
}

export function createLocalCommands(deps: LocalCommandsDeps) {
  const now = deps.now ?? Date.now;
  const byFolder = new Map<string, Entry>();

  function refresh(cwd: string): void {
    const entry = byFolder.get(cwd) ?? { commands: [], fetchedAt: 0, asking: false };
    if (entry.asking) return;
    entry.asking = true;
    byFolder.set(cwd, entry);
    deps.runner.request('claude.commands', { cwd })
      .then(commands => { entry.commands = roomCommands(commands); })
      // A folder Claude Code cannot start in has no commands to offer; tried again when stale.
      .catch(() => {})
      .finally(() => {
        entry.asking = false;
        entry.fetchedAt = now();
        deps.invalidate([topic.localCommands()]);
      });
  }

  const handlers = {
    'local.commands.list': (params: unknown) => {
      const chatId = (params as { chatId?: string } | undefined)?.chatId;
      const cwd = chatId ? deps.store()?.turnContext(chatId)?.cwd : undefined;
      if (!cwd) return [];
      const entry = byFolder.get(cwd);
      if (!entry || now() - entry.fetchedAt > STALE_AFTER_MS) refresh(cwd);
      return entry?.commands ?? [];
    },
  };

  function onEvent(event: RunnerEvent): void {
    if (event.event !== 'commands.changed') return;
    const cwd = deps.store()?.turnContext(event.chatId)?.cwd;
    if (!cwd) return;
    byFolder.set(cwd, { commands: roomCommands(event.commands), fetchedAt: now(), asking: false });
    deps.invalidate([topic.localCommands()]);
  }

  return { handlers, onEvent };
}
