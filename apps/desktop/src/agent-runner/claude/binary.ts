// Finding the person's `claude`, and the environment it is started with
// (docs/LOCAL-ROOMS.md §3.6).
//
// EXPLICIT, NEVER PATH ALONE. An app launched from Finder or the Dock gets
// launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin` — so `pnpm dev`, which
// inherits a shell, finds `claude` and the packaged app reports "not installed"
// for everyone. The usual homes are tried first, then PATH.
import { accessSync, constants } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

/** Where the installers put it, in the order they are tried. */
export function candidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const fromPath = (env['PATH'] ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'claude'));
  const known = [
    join(home, '.local/bin/claude'),        // the native installer
    join(home, '.claude/local/claude'),     // the older local install
    '/opt/homebrew/bin/claude',             // Homebrew, Apple silicon
    '/usr/local/bin/claude',                // Homebrew, Intel; npm -g
  ];
  return [...new Set([...known, ...fromPath])];
}

/** The first candidate that is an executable file, or null with everything that was tried. */
export function resolveClaude(
  tried = candidates(),
): { path: string; searched: string[] } | { path: null; searched: string[] } {
  for (const path of tried) {
    try {
      accessSync(path, constants.X_OK);
      return { path, searched: tried };
    } catch { /* not here */ }
  }
  return { path: null, searched: tried };
}

/** The names passed through to the child. Nothing else is. */
const KEEP = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CLAUDE_CONFIG_DIR'];

/**
 * The child's whole environment.
 *
 * The SDK's `env` option REPLACES the child's environment rather than merging
 * it (measured, spikes/genui). So this is everything the child gets, and it is
 * short on purpose: nothing from relayed's own process — no WorkOS client id,
 * no server URL, no OTLP endpoint — and no `ANTHROPIC_*`, which would sign the
 * child in as whatever set it rather than as the person.
 *
 * `CLAUDE_CONFIG_DIR` passes through when the person set one; `HOME` is never
 * rewritten, because moving it moves the macOS keychain and the child reports
 * "not logged in" (§3.6).
 */
export function claudeEnv(binary: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEEP) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  // LOAD-BEARING, measured: without USER the CLI cannot find its login in the
  // macOS keychain and reports itself signed out, with no error anywhere. A
  // launchd-started app normally has it; this is for the day one does not.
  out['USER'] ??= userInfo().username;
  // The binary's own directory first, so anything it starts by name (a hook, a
  // helper) resolves the way it does in a terminal.
  const home = env['HOME'] ?? homedir();
  out['PATH'] = [binary.slice(0, binary.lastIndexOf('/')), join(home, '.local/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin']
    .filter(Boolean).join(delimiter);
  // A health check must not start the person's claude.ai connectors or attach
  // to an IDE (§3.2). Turns set these per run.
  out['ENABLE_CLAUDEAI_MCP_SERVERS'] = 'false';
  out['CLAUDE_CODE_AUTO_CONNECT_IDE'] = '0';
  out['CLAUDE_AGENT_SDK_CLIENT_APP'] = 'relayed-desktop';
  return out;
}
