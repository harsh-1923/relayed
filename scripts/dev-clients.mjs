// `pnpm dev` — one Electron client, or several isolated ones against one server.
//
// Sync is the first phase whose behaviour cannot be SEEN with one client
// (docs/MULTI-CLIENT-DEV.md). This runs N installs from ONE build and ONE
// renderer dev server, so an edit reaches every window the way it reaches one.
//
// WHY NOT N × `electron-vite dev`: each would start its own Vite server — a
// port clash, which is solvable — and its own rollup watchers writing to the
// same `out/` directory. Two processes rewriting `out/main/index.js` while a
// third reads it is a torn build that reproduces once and never again.
//
// So: electron-vite owns the build, the watch, the renderer server and client 1.
// This owns clients 2..N, and restarts them on the SAME signal electron-vite
// restarts client 1 on.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as p from '@clack/prompts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const signalFile = join(desktop, 'out', '.build-signal');

/** Where the renderer dev server listens. Pinned so siblings can be told. */
const PORT = Number(process.env['RELAYED_DEV_PORT'] ?? 5273);
/** Where the API and sync socket listen. Matches apps/server/src/env.ts. */
const SERVER_PORT = Number(process.env['PORT'] ?? 8787);
const MAX_CLIENTS = 4;

/**
 * Refuse to start on top of something already running.
 *
 * Without this the failure is two unrelated stack traces a screen apart — an
 * `EADDRINUSE` from the server and a Vite "Port 5273 is already in use" — with
 * the actual cause (a previous run still alive) named in neither. The renderer
 * port is `strictPort` on purpose, because a sibling pointed at a port Vite
 * quietly moved renders nothing and looks like a broken build; that correctness
 * is worth keeping, and this is what makes it legible.
 *
 * It reports rather than kills. Whatever holds the port is somebody's process,
 * possibly deliberate — a server run in another terminal to watch its logs is
 * exactly the case `--no-server` exists for.
 */
function portFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** What is holding a port, best effort — a pid is more use than a number. */
function holderOf(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
                             { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n')[1];
    if (!line) return null;
    const [cmd, pid] = line.split(/\s+/);
    return `${cmd} (pid ${pid})`;
  } catch { return null; }
}

// Declared UP HERE rather than beside their users, because the client loop below
// runs at the top level and a `const` referenced before its declaration is
// evaluated is a ReferenceError, not a hoisted binding. Cost one debugging round.
const require_ = createRequire(join(desktop, 'package.json'));
/** The Electron binary the workspace resolved, not one from PATH. */
const electronBin = require_('electron');

const stampOf = () => {
  try { return statSync(signalFile).mtimeMs; } catch { return 0; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── how many ────────────────────────────────────────────────────────────────

const flag = process.argv.find(a => a.startsWith('--clients='));
const asked = flag ? Number(flag.slice('--clients='.length)) : null;
const interactive = asked === null && process.stdin.isTTY && !process.env['CI'];

let clients = asked ?? 1;
if (interactive) {
  p.intro('Relayed');
  const answer = await p.select({
    message: 'How many desktop clients?',
    initialValue: 1,
    options: [
      { value: 1, label: '1', hint: 'the usual loop' },
      { value: 2, label: '2', hint: 'two people, or one person on two devices' },
      { value: 3, label: '3', hint: 'both — same account twice, plus a second person' },
    ],
  });
  if (p.isCancel(answer)) { p.cancel('nothing started'); process.exit(0); }
  clients = answer;
}
if (!Number.isInteger(clients) || clients < 1 || clients > MAX_CLIENTS) {
  console.error(`--clients must be 1..${MAX_CLIENTS}`);
  process.exit(1);
}

// ── nothing may already be listening ────────────────────────────────────────

{
  const wanted = [
    { port: PORT, what: 'the renderer dev server' },
    ...(process.argv.includes('--no-server')
      ? [] : [{ port: SERVER_PORT, what: 'the Relayed server' }]),
  ];
  const taken = [];
  for (const w of wanted) if (!(await portFree(w.port))) taken.push(w);

  if (taken.length > 0) {
    const lines = taken.map(t => {
      const who = holderOf(t.port);
      return `  :${t.port} — ${t.what}${who ? `, held by ${who}` : ''}`;
    });
    console.error(
      `\nAlready running.\n\n${lines.join('\n')}\n\n` +
      `Another \`pnpm dev\` is probably still alive. Stop it, or:\n` +
      `  lsof -nP -iTCP:${taken[0].port} -sTCP:LISTEN\n` +
      (taken.some(t => t.port === SERVER_PORT)
        ? `\nIf you are running the server yourself, use \`pnpm dev --no-server\`.\n` : ''));
    process.exit(1);
  }
}

// ── the primary: build, watch, renderer server, client 1 ────────────────────

// `--watch` is NOT the default for a reason worth knowing: without it a
// main-process edit does nothing until you restart by hand. Tolerable once,
// not three times — so multi-client makes it a requirement rather than a taste.
// `electron-vite dev` has no `--port`; the renderer's port is pinned in
// electron.vite.config.ts, which reads the same environment variable.
const args = ['--filter', '@relayed/desktop', 'exec', 'electron-vite', 'dev', '--watch'];

const children = new Map();   // client number -> ChildProcess
let stopping = false;

// ── the server ──────────────────────────────────────────────────────────────
//
// Started here rather than left to `pnpm -r --parallel dev`, because `dev` used
// to mean "the whole environment" and must keep meaning that. One server for
// every client: that is the production topology too, not a shortcut — fanout is
// a single in-process tier today and `MULTI_NODE` in sync/retention.ts is
// deliberately unbuilt with its trigger named.
//
// `--no-server` is for the case where you are already running one in another
// terminal to watch its logs.
const withServer = !process.argv.includes('--no-server');
const server = withServer
  ? spawn('pnpm', ['--filter', '@relayed/server', 'dev'],
          { cwd: root, stdio: 'inherit', env: process.env, detached: true })
  : null;

// Stale signal from a previous run would fire a restart before the first build.
rmSync(signalFile, { force: true });

// DETACHED so it leads its own process GROUP, and that is the whole point:
// `pnpm` does not forward a signal to its grandchild, so killing the pnpm
// process left Electron running with its replica open. The next run's client 1
// would then meet a database another process still holds — the exact failure the
// separate directories exist to prevent, reintroduced by sloppy teardown.
// Killing the negative pid signals the group.
const primary = spawn('pnpm', args, {
  cwd: root,
  stdio: 'inherit',
  detached: true,
  env: {
    ...process.env,
    RELAYED_DEV_PORT: String(PORT),
    RELAYED_CLIENT: '1',
    ...(clients > 1 ? { RELAYED_BUILD_SIGNAL: signalFile } : {}),
  },
});
primary.on('exit', (code) => {
  stopping = true;
  killAll();
  killServer();
  process.exit(code ?? 0);
});

if (clients === 1) {
  // Nothing else to do: this is exactly today's loop, with watching on.
  hookSignals();
} else {
  p.log?.info?.(`starting ${clients} clients · renderer on :${PORT}`);
  hookSignals();
  await waitForBuild();
  for (let n = 2; n <= clients; n++) start(n);
  watchForRebuilds();
}

// ── siblings ────────────────────────────────────────────────────────────────

function start(n) {
  if (stopping) return;
  const child = spawn(electronBin, [join(desktop, 'out', 'main', 'index.js')], {
    cwd: desktop,
    stdio: 'inherit',
    env: {
      ...process.env,
      RELAYED_CLIENT: String(n),
      // The SAME dev server client 1 uses. `main` reads exactly this variable to
      // choose a URL over a file, so HMR reaches every window from one server.
      ELECTRON_RENDERER_URL: `http://localhost:${PORT}`,
      // Not inherited: a sibling must not signal its own siblings.
      RELAYED_BUILD_SIGNAL: '',
    },
  });
  children.set(n, child);
  child.on('exit', () => { if (children.get(n) === child) children.delete(n); });
}

/**
 * Replace a sibling, waiting for the old process to be GONE first.
 *
 * Two processes sharing one `userData` for even a moment is the thing the
 * separate directories exist to prevent; doing it ourselves on every rebuild
 * would be worse than never having isolated them.
 */
function restart(n) {
  const old = children.get(n);
  if (!old) { start(n); return; }
  children.delete(n);
  old.once('exit', () => { start(n); });
  old.kill();
}

function killAll() {
  for (const child of children.values()) child.kill();
  children.clear();
}

/** Signal a whole process group; a bare kill stops at `pnpm`. */
function killTree(child, sig = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, sig); }
  catch { try { child.kill(sig); } catch { /* already gone */ } }
}

function killServer() { killTree(server); }

// ── the rebuild signal ──────────────────────────────────────────────────────

/**
 * Wait for the first build to land before spawning anything.
 *
 * `out/main/index.js` existing is not enough on its own — it may be last run's.
 * The signal file is deleted at startup and written by a `closeBundle` hook, so
 * its presence means THIS run produced a complete bundle.
 */
async function waitForBuild() {
  const deadline = Date.now() + 120_000;
  while (!existsSync(signalFile)) {
    if (stopping) return;
    if (Date.now() > deadline) {
      console.error('[dev] no build after 120s — starting client 1 only');
      return;
    }
    await sleep(120);
  }
}

/**
 * Restart siblings whenever a build completes.
 *
 * Polls one small file rather than watching `out/`, and the difference matters.
 * electron-vite restarts client 1 from a rollup `closeBundle` hook, which fires
 * once a bundle is COMPLETELY written; a watch on the output directory fires on
 * the first chunk to land, while shared chunks may still be in flight. The
 * signal file is written by that same hook, so both halves react to the same
 * fact.
 *
 * Debounced because main and preload are separate builds with separate hooks:
 * one edit touches the file twice, and should produce one restart.
 */
function watchForRebuilds() {
  let seen = stampOf();
  let timer = null;
  setInterval(() => {
    const now = stampOf();
    if (now === seen) return;
    seen = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopping) return;
      for (const n of [...children.keys()]) restart(n);
    }, 250);
  }, 200).unref?.();
}

// ── shutdown ────────────────────────────────────────────────────────────────

/**
 * Take the siblings down with us.
 *
 * Orphaned Electron windows outlive the terminal that started them, still
 * holding their replicas open — and the next run's client 2 would then meet a
 * database another process already has, which is the failure the whole layout is
 * arranged to avoid.
 */
function hookSignals() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      killAll();
      killServer();
      killTree(primary, sig);
      // The primary's own exit handler calls process.exit; this is the backstop
      // for a primary that has already gone.
      setTimeout(() => process.exit(0), 2_000).unref?.();
    });
  }
  process.on('exit', () => { killAll(); killServer(); });
}
