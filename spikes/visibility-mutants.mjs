// Mutation testing for the visibility spike (spikes/visibility-tests.mjs).
//
// Each mutant in visibility-model.mjs is one plausible way to build
// docs/WORKSPACE-AGENTS.md §8 wrongly. The suite must FAIL against every one of
// them, and must pass against the model with no mutant; a mutant that survives
// is a rule the tests only appear to hold.
//
// A kill must come from a real check. The coverage check is excluded from
// deciding a kill: a mutant that merely changes how often a path is reached has
// not been caught doing anything wrong.
//
//   node spikes/visibility-mutants.mjs
import { performance } from 'node:perf_hooks';
import { MUTANTS } from './visibility-model.mjs';
import { runSuite } from './visibility-tests.mjs';

const SEEDS = 150;
const started = performance.now();
const realFails = (result) => result.fails.filter(name => !name.startsWith('coverage:'));

const baseline = runSuite({ seeds: SEEDS, quiet: true, findings: false });
console.log(`baseline (no mutant): ${baseline.pass} passed, ${baseline.fail} failed`);
if (baseline.fail) {
  console.log(`BASELINE FAILS — mutants mean nothing until it passes: ${baseline.fails.join(', ')}`);
  process.exit(1);
}

const survivors = [];
console.log('');
for (const [mutant, description] of Object.entries(MUTANTS)) {
  const result = runSuite({ mutant, seeds: SEEDS, quiet: true, findings: false });
  const fails = realFails(result);
  const killed = fails.length > 0;
  if (!killed) survivors.push(mutant);
  // Whether the random property test catches it without any named scenario —
  // evidence that the random worlds are not decorative.
  const byProperty = fails.includes('no violation in any random world');
  console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${mutant.padEnd(30)} ${String(fails.length).padStart(2)} failing checks`
    + `   property test alone: ${byProperty ? 'yes' : 'no '}`);
  console.log(`         ${description}`);
  if (killed) console.log(`         caught by: ${fails.slice(0, 3).join(' · ')}${fails.length > 3 ? ' · …' : ''}`);
}

const total = Object.keys(MUTANTS).length;
console.log(`\n${'─'.repeat(58)}\n${total - survivors.length} of ${total} mutants killed in ${Math.round((performance.now() - started) / 1000)} s`);
if (survivors.length) { console.log(`SURVIVORS: ${survivors.join(', ')}`); process.exit(1); }
