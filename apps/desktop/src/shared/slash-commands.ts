// Which of Claude Code's slash commands a local room offers, and which Relayed
// answers itself rather than sending (docs/LOCAL-ROOMS.md §8.7).
//
// Shared by the sync engine, which leaves the hidden ones out of the list, and
// the renderer, which runs the app's own.
import type { ClaudeCommand } from './claude.ts';

/**
 * Commands that only mean something in the terminal: they open its menus, set
 * its colours, or restart it. Claude Code already leaves most of those out of
 * an SDK session's list; these are the ones it still lists.
 */
export const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  'config', 'doctor', 'heapdump', 'color', 'exit', 'quit', 'ide', 'terminal-setup', 'statusline', 'vim', 'theme',
  'login', 'logout', 'resume', 'permissions', 'hooks', 'keybindings', 'install-github-app', 'bug', 'feedback',
  'release-notes', 'privacy-settings', 'export', 'copy', 'upgrade', 'agents', 'extra-usage', 'import',
  '__remote-workflow', 'workflow-launch-exec',
]);

/**
 * Commands Relayed runs itself, because the room already has the control for
 * them: the model picker, a fresh session, the room's name. Typed or chosen,
 * they never reach Claude Code.
 */
export const APP_COMMANDS = {
  model: 'Choose the model for this room.',
  effort: 'Choose how hard Claude thinks in this room.',
  clear: 'Start a new Claude Code session in this chat. The messages above stay; Claude stops seeing them.',
  rename: 'Rename this room. With no name, a new one is suggested from the conversation.',
} as const;

export type AppCommand = keyof typeof APP_COMMANDS;

export const isAppCommand = (name: string): name is AppCommand => Object.hasOwn(APP_COMMANDS, name);

/** The list as a room offers it: the hidden ones gone, the app's own described as the app runs them. */
export function roomCommands(commands: readonly ClaudeCommand[]): ClaudeCommand[] {
  return commands
    .filter(command => !HIDDEN_COMMANDS.has(command.name))
    .map(command => (isAppCommand(command.name) ? { ...command, description: APP_COMMANDS[command.name] } : command));
}

/**
 * A message that is a slash command: it starts with one. Claude Code reads a
 * message as a command the same way, so anything after the name is its
 * argument, and a slash later in the text is just text.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, args: (match[2] ?? '').trim() } : null;
}
