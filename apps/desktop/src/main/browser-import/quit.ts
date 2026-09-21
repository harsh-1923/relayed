// Quitting a browser that is holding its cookie database open, so an import can
// proceed (docs/PANELS.md, browser import).
//
// ASKED FOR BY NAME, NEVER INFERRED. Nothing here runs unless the person pressed
// the button on a row that already says the browser must be closed. Quitting
// somebody's browser out from under them is not a step to take helpfully.
//
// A GRACEFUL QUIT, NOT A SIGNAL. `SIGTERM` would also end the process, and
// Chromium would record it as a crash — the next launch greets the person with
// "Chrome didn't shut down correctly. Restore pages?" and may not restore their
// tabs. An AppleScript `quit` is the same quit as ⌘Q, so the session is saved
// and reopening is ordinary.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { BrowserImportQuitOutcome, BrowserImportSourceId } from '../../shared/browser-import.ts';
import { chromiumPid, isRunning, SOURCES, type SourceDefinition } from './sources.ts';

/** How long to wait for the lock to clear. A quit the person must confirm in the browser takes a few seconds. */
const SETTLE_MS = 8_000;
const POLL_MS = 250;

const run = (file: string, args: string[], timeout: number): Promise<string | null> =>
  new Promise(resolve => {
    execFile(file, args, { timeout, encoding: 'utf8' }, (error, stdout) =>
      resolve(error ? null : stdout.trim()));
  });

/**
 * The `.app` bundle a pid is running out of.
 *
 * Resolved from the process rather than from a name we hold, so the thing that
 * gets quit is by construction the thing whose lock we read. Anything that is
 * not a macOS application bundle is refused rather than quit blind.
 */
async function bundleForPid(pid: number): Promise<string | undefined> {
  const executable = await run('/bin/ps', ['-p', String(pid), '-o', 'comm='], 5_000);
  if (!executable?.startsWith('/')) return undefined;
  const at = executable.indexOf('.app/Contents/MacOS/');
  if (at === -1) return undefined;
  const bundle = executable.slice(0, at + '.app'.length);
  return existsSync(bundle) ? bundle : undefined;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ask a running browser to quit, and wait for it to let go of its database.
 *
 * Returns what actually happened rather than throwing: every outcome here is
 * something the screen says plainly, and none of them is an error the person
 * can act on by retrying blindly. `refused` is the ordinary one — a page with
 * unsaved work puts up its own "Leave site?" dialog and the browser stays.
 */
export async function quitBrowser(sourceId: BrowserImportSourceId, home = homedir()): Promise<BrowserImportQuitOutcome> {
  const source: SourceDefinition | undefined = SOURCES.find(entry => entry.id === sourceId);
  if (!source) return 'cannotIdentify';
  if (!isRunning(source, home)) return 'quit';

  const pid = chromiumPid(source, home);
  if (pid === undefined) return 'cannotIdentify';
  const bundle = await bundleForPid(pid);
  if (bundle === undefined) return 'cannotIdentify';

  // The path travels as an argv item, never interpolated into the script: it
  // comes from a file anything running as this person can write, and a quote in
  // it would otherwise be AppleScript of their choosing.
  const told = await run('/usr/bin/osascript', [
    '-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run',
    '--', bundle,
  ], SETTLE_MS);
  if (told === null) return 'cannotIdentify';

  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    if (!isRunning(source, home)) return 'quit';
    await sleep(POLL_MS);
  }
  return isRunning(source, home) ? 'refused' : 'quit';
}
