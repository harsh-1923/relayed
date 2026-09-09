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
 * `where` narrows the files a rule applies to; `allow` exempts the module that
 * legitimately owns the thing being banned — a rule with no owner is a rule
 * nobody can satisfy.
 */
const RULES = [
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
    // The transport module is the one place allowed to open one — and the gate
    // is allowed to name the type in its own signature.
    allow: [/apps\/desktop\/src\/sync\/transport\//, /apps\/desktop\/src\/sync\/network\.ts$/],
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

for (const file of files) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const rule of RULES) {
    if (rule.where && !rule.where.some(w => w.test(rel))) continue;
    if (rule.allow.some(a => a.test(rel))) continue;
    lines.forEach((line, i) => {
      // Comments describe a rule as often as they break it: this file, can.ts
      // and the replica schema all quote the banned form in order to explain
      // why it is banned. Strip every comment style in play — line, block,
      // JSDoc continuation, and SQL inside a migration's template literal.
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('--') || trimmed.startsWith('//')) return;
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (rule.pattern.test(code)) {
        violations.push({ rule, file: rel, line: i + 1, text: line.trim().slice(0, 96) });
      }
    });
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
