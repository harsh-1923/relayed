// The environment relayed hands to the user's `claude`.
//
// The SDK's `env` option REPLACES the child's environment rather than merging
// it, so this is the whole of it. Anything that says "you are a child of some
// other Claude host" (CLAUDE_*, ANTHROPIC_*) is removed, so the child signs in
// with the user's own login exactly as `claude` in a terminal would.
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];

export function claudeEnv(extra = {}) {
  const env = {};
  for (const name of KEEP) if (process.env[name] !== undefined) env[name] = process.env[name];
  // A packaged app launched from Finder does not get the shell PATH
  // (docs/AGENT-RESPONSES.md, "Running Claude Code"). Put the usual homes of
  // `claude` first regardless of how this process was started.
  env.PATH = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH].filter(Boolean).join(':');
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = '0';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'relayed-spike/0';
  return { ...env, ...extra };
}

export const CLAUDE_PATH = join(homedir(), '.local/bin/claude');
