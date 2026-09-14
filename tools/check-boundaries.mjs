// Boundaries the documents assert and nothing enforced.
//
//   pnpm check:boundaries
//
// A deliberate not-ESLint. Every rule below is a specific sentence in a specific
// document, and the value is in failing a build rather than in a plugin
// ecosystem — so this is one file with no dependencies, run beside typecheck.
//
// The argument for it is written down in PHASE-1-IDENTITY.md §11a: a trap was
// documented in that section and then walked into again, in the same file, by
// the person who documented it. Prose does not hold a boundary.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SOURCES = ['apps/desktop/src', 'apps/server/src', 'packages/authz/src', 'packages/telemetry/src'];

/**
 * The reads the live-query client owns, taken from the catalogue itself rather
 * than restated here.
 *
 * A hand-copied list is a list that drifts, and drifting the wrong way means
 * the rule silently stops covering a query — so it reads the source of truth
 * and throws if it cannot find it. A rule that cannot locate what it guards
 * must fail loudly, not pass.
 */
function catalogueOps() {
  const file = join(ROOT, 'apps/desktop/src/renderer/lib/query/catalogue.ts');
  const body = readFileSync(file, 'utf8');
  const block = body.match(/export const TOPICS: TopicsFor = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error(`check-boundaries: no TOPICS block in ${file}`);
  const ops = [...block[1].matchAll(/'([^']+)'\s*:/g)].map(m => m[1]);
  if (ops.length === 0) throw new Error(`check-boundaries: TOPICS is empty in ${file}`);
  return ops;
}

/**
 * `where` narrows the files a rule applies to; `allow` exempts the module that
 * legitimately owns the thing being banned — a rule with no owner is a rule
 * nobody can satisfy.
 *
 * `requires` turns a rule inside out: `pattern` stops being a ban and becomes an
 * OBLIGATION, and the violation is `requires` not matching anywhere in the same
 * file. Use it where the thing to enforce is "these two always travel together"
 * rather than "this never appears" — a pairing no line-by-line rule can see.
 */
const RULES = [
  {
    id: 'renderer/no-direct-query',
    doc: 'FRONTEND.md §6.3 — components read through the live-query client',
    why: 'A read issued straight at the bridge is invisible to the invalidation '
       + 'registry, so nothing refreshes it. There is no error and no spinner — '
       + 'the surface simply keeps rendering what it read once, and the bug is '
       + 'found by a user noticing that somebody who joined is not in the list. '
       + 'Call useQuery(name) instead; it subscribes as well as reads. '
       + 'Commands (auth.signIn, invite.create) are writes and stay direct.',
    pattern: new RegExp(`\\.query\\s*\\(\\s*['"](?:${catalogueOps().join('|')})['"]`),
    where: [/apps\/desktop\/src\/renderer\//],
    // The client itself calls the bridge dynamically; that is its job.
    allow: [/apps\/desktop\/src\/renderer\/lib\/query\//],
  },
  {
    id: 'authz/no-role-comparison',
    doc: 'AUTHZ.md §7 — every permission check goes through can()',
    why: 'A role tested at a call site drifts from every other call site, and '
       + 'makes swapping the evaluator a rewrite rather than one file.',
    pattern: /(?:\.role|\brole|actorRole|actor_role)\s*(?:===|!==|==[^=]|!=[^=])/,
    allow: [/packages\/authz\//, /apps\/server\/src\/authz\//],
  },
  {
    id: 'telemetry/no-direct-sdk',
    doc: 'OBSERVABILITY.md §8 — one wrapper package, enforceable by lint rule',
    why: 'Importing the SDK directly makes swapping the backend a codebase '
       + 'sweep instead of one file.',
    pattern: /from\s+['"](?:@opentelemetry\/[^'"]+|pino)['"]/,
    allow: [/packages\/telemetry\//],
  },
  {
    id: 'telemetry/no-interpolated-logs',
    doc: 'OBSERVABILITY.md §6 — structured only; this is the privacy control',
    why: 'A template literal is where a message body reaches the log. There is '
       + 'no field type that can hold one, so this is the only way in.',
    pattern: /console\.(?:log|warn|error|info|debug)\s*\(\s*`/,
    // keygen prints a generated key to stdout for an operator to paste into a
    // .env. That is a CLI's output, not a log line — nothing reaches a log
    // sink, and the interpolated value is one this process just created rather
    // than anything a user typed. Named explicitly, because a rule with a
    // legitimate exception should say so rather than be weakened.
    allow: [/apps\/server\/src\/auth\/keygen\.ts$/],
  },
  {
    id: 'network/no-ungated-socket',
    doc: 'STORAGE.md §16.2a — every outbound call passes one gate',
    why: 'Replacing globalThis.fetch catches fetch and NOTHING else: a socket '
       + 'is a separate constructor. One opened outside the transport module '
       + 'would go uncounted before first paint — the exact R3 violation the '
       + 'counter exists to catch, reading as all-clear — and simulated '
       + 'offline would cut HTTP but not the socket, which is worse than not '
       + 'simulating at all because it looks like it worked. '
       + 'Route it through sync/transport, which calls guardConnect first.',
    pattern: /new\s+WebSocket\s*\(|from\s+['"]ws['"]|require\(\s*['"]ws['"]\s*\)/,
    // SCOPED TO THE DESKTOP, and it was not until the server grew a socket.
    // The rule is about ONE gate on ONE process's outbound calls — R3 and
    // simulated offline are properties of the client. The server has no gate to
    // route through, so applying this there would have been a rule with no way
    // to satisfy it, which is how a checker teaches people to add exemptions.
    where: [/apps\/desktop\//],
    // The transport module is the one place allowed to open one — and the gate
    // is allowed to name the type in its own signature.
    allow: [/apps\/desktop\/src\/sync\/transport\//, /apps\/desktop\/src\/sync\/network\.ts$/],
  },
  {
    id: 'routing/switch-only-in-the-gate',
    doc: 'FRONTEND.md §4.5 — navigation is the only input to a switch',
    why: 'The workspace lives in the URL, which is safe for exactly one reason: '
       + 'navigation is the only way a switch starts. A second caller makes the '
       + 'route and the engine two authorities over which workspace is active, '
       + 'and they disagree precisely while a switch is in flight — the shape '
       + 'behind the stale-reply, epoch-reset and awaitingBrowser bugs. '
       + 'Navigate to /w/:wsId instead; the gate turns that into the switch.',
    pattern: /['"]workspace\.switch['"]/,
    where: [/apps\/desktop\/src\/renderer\//],
    // The gate is the one caller. Everything else — the rail, a deep link,
    // back and forward — arrives there by navigating (invariant 56).
    allow: [/apps\/desktop\/src\/renderer\/app\/WorkspaceGate\.tsx$/],
  },
  {
    id: 'renderer/no-telemetry-sdk',
    doc: 'OBSERVABILITY.md §3 — one SDK, in the utilityProcess',
    why: 'A second SDK in the renderer means a second buffer, a second exporter '
       + 'and a second flush timer — and a renderer timer is the one place a '
       + 'timer cannot be trusted, because Chromium throttles a hidden page to '
       + 'one tick a minute (DESIGN.md §13.9). Telemetry would then stop '
       + 'draining exactly when the window is in the background, which is most '
       + 'of the time. Import the catalogue TYPES from '
       + '@relayed/telemetry/catalogue and emit through lib/telemetry, which '
       + 'forwards over the port the renderer already holds.',
    pattern: /import\s+(?!type\b)[^;]*from\s+['"]@relayed\/telemetry['"]/,
    where: [/apps\/desktop\/src\/renderer\//],
    allow: [],
  },
  {
    id: 'shortcuts/no-global-key-listener',
    doc: 'SHORTCUTS.md §18 — no feature owns a document or window keydown listener',
    why: 'Two of them already fought: the sidebar\'s window-level Mod+B stole '
       + 'bold from the composer, and search\'s Mod+K lived in a sidebar that '
       + 'settings unmounts. A listener outside the bus bypasses layer '
       + 'precedence, the editable-focus policy and remapping, and its label '
       + 'drifts from what it matches. Register a handler with '
       + 'useCommandHandler instead; a focused component handles its own keys '
       + 'with an element prop such as onKeyDown.',
    pattern: /(?:window|document|globalThis)\.addEventListener\(\s*['"]key(?:down|up|press)['"]/,
    where: [/apps\/desktop\/src\/renderer\//],
    allow: [/apps\/desktop\/src\/renderer\/lib\/commands\/CommandProvider\.tsx$/],
  },
  {
    id: 'shortcuts/tanstack-only-in-the-driver',
    doc: 'SHORTCUTS.md §11 — only the driver imports TanStack Hotkeys',
    why: 'The library is alpha, and its matcher breaks the logical-key contract '
       + '(a key typing "-" at the physical Slash position matches Mod+/). A '
       + 'second importer can reach for matchesKeyboardEvent or useHotkey, and '
       + 'an upgrade stops being one file. Import from shared/shortcuts instead.',
    pattern: /from\s+['"]@tanstack\/(?:react-)?hotkeys['"]|import\(\s*['"]@tanstack\/(?:react-)?hotkeys['"]\s*\)/,
    where: [/apps\/desktop\//],
    allow: [/apps\/desktop\/src\/shared\/shortcuts\/tanstack-driver\.ts$/],
  },
  {
    id: 'identity/no-layer-1-on-the-client',
    doc: 'DESIGN.md §6.3 — nothing below Layer 2 references an identity',
    why: 'Replicating identity_id would hand every workspace member a directory '
       + 'of everyone else’s external identifiers, for no feature.',
    pattern: /\bidentity_(?:id|kind)\b/,
    // The desktop app has no business naming a WorkOS identifier at all.
    where: [/apps\/desktop\//],
    allow: [],
  },
  {
    id: 'sync/actor-write-records-directory',
    doc: 'SYNC-FLOWS.md §9.1 — the directory replicates as workspace-stream events',
    why: 'An actor written without recordActor() is a person who exists on the '
       + 'server and on nobody’s client. There is no error: their messages '
       + 'render with a monogram and no name, for ever, on every device — and '
       + 'the next reconnect does not repair it, because catch-up returns the '
       + 'events that were written rather than the rows that were not '
       + 'announced. Enforced here rather than by a test because two of the '
       + 'three write sites reach WorkOS before they reach the database, so an '
       + 'integration test for them costs a network stub — while the pairing '
       + 'itself is a property of the file and needs no engine to check.',
    pattern: /\.(?:insertInto|updateTable)\(\s*['"]actors['"]\s*\)/,
    requires: /\brecordActor\s*\(/,
    where: [/apps\/server\/src\//],
    // Fixtures set up state; they do not perform the product operation. A test
    // that wanted the event would call recordActor explicitly, as events.test.ts
    // does — and it is the product write paths this rule exists to hold.
    allow: [/\.test\.ts$/],
  },
  {
    id: 'sync/messages-written-by-one-writer',
    doc: 'WORKSPACE-AGENTS.md §8.5 — a message\u2019s audience is a required argument',
    why: 'messages.visible_to is NULL for the whole chat, and NULL is also what a '
       + 'forgotten column is. What makes that safe is that writeMessage is the '
       + 'only insert, and its audience argument does not compile when absent — '
       + 'a second insert elsewhere writes a message for everyone because its '
       + 'author did not think about who it was for, and nothing reports it.',
    pattern: /\.insertInto\(\s*['"]messages['"]\s*\)/,
    where: [/apps\/server\/src\//],
    // Fixtures build rows to test constraints and allocation; they do not
    // perform the product write.
    allow: [/apps\/server\/src\/sync\/ops\.ts$/, /\.test\.ts$/],
  },
  {
    id: 'sync/no-client-audience',
    doc: 'WORKSPACE-AGENTS.md §8.8 — only the server writes a restricted message',
    why: 'The socket is where client ops arrive. A path from a frame to '
       + 'writeMessage is a path by which a client chooses who may read what it '
       + 'sends, which v1 does not permit and whose threat model nobody has '
       + 'written (§8.9). A client send goes through send(), which always writes '
       + 'for the whole chat.',
    pattern: /\bwriteMessage\b/,
    where: [/apps\/server\/src\/sync\/socket\.ts$/],
    allow: [],
  },
];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = SOURCES.flatMap(d => { try { return walk(join(ROOT, d)); } catch { return []; } });
const violations = [];

/**
 * Comments describe a rule as often as they break it: this file, can.ts and the
 * replica schema all quote the banned form in order to explain why it is
 * banned. Strip every comment style in play — line, block, JSDoc continuation,
 * and SQL inside a migration's template literal. Returns null for a line that
 * is entirely comment.
 */
function codeOf(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('--') || trimmed.startsWith('//')) return null;
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

for (const file of files) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const rule of RULES) {
    if (rule.where && !rule.where.some(w => w.test(rel))) continue;
    if (rule.allow.some(a => a.test(rel))) continue;

    // A `requires` rule inverts the usual reading: the pattern is not a ban but
    // an OBLIGATION, and the violation is the absence of its companion
    // somewhere in the same file. That is a file-level question, so the first
    // match is held rather than reported, and answered after the whole file.
    let obligated = null;
    lines.forEach((line, i) => {
      const code = codeOf(line);
      if (code === null || !rule.pattern.test(code)) return;
      const found = { rule, file: rel, line: i + 1, text: line.trim().slice(0, 96) };
      if (rule.requires) obligated ??= found;
      else violations.push(found);
    });

    if (obligated) {
      const satisfied = lines.some(line => {
        const code = codeOf(line);
        return code !== null && rule.requires.test(code);
      });
      if (!satisfied) violations.push(obligated);
    }
  }
}

if (violations.length === 0) {
  console.log(`boundaries: ${RULES.length} rules, ${files.length} files, clean`);
  process.exit(0);
}

const byRule = new Map();
for (const v of violations) (byRule.get(v.rule.id) ?? byRule.set(v.rule.id, []).get(v.rule.id)).push(v);
for (const [id, vs] of byRule) {
  const { doc, why } = vs[0].rule;
  console.error(`\n${id}\n  ${doc}\n  ${why}`);
  for (const v of vs) console.error(`    ${v.file}:${v.line}  ${v.text}`);
}
console.error(`\n${violations.length} violation(s)`);
process.exit(1);
