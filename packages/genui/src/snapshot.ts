// Locks the library's current shape into spec-snapshot.json.
//
//   pnpm --filter @relayed/genui snapshot
//
// Run after ADDING a component or an optional argument, so the addition is
// guarded from then on. It refuses to write over an unsafe change: re-running a
// snapshot is not a way to make the guard test pass, because the messages that
// change would break are already stored (docs/AGENT-RESPONSES.md, changing the
// library).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { libraryShape, unsafeChanges, type LibraryShape } from './guard.ts';
import { library } from './library.ts';

const file = new URL('../spec-snapshot.json', import.meta.url);
const current = libraryShape(library.toJSONSchema());

if (existsSync(file)) {
  const locked = JSON.parse(readFileSync(file, 'utf8')) as LibraryShape;
  const problems = unsafeChanges(locked, current);
  if (problems.length > 0) {
    console.error('Refusing to snapshot. These changes would alter stored UI blocks:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Add a new component or an optional argument at the end instead.');
    process.exit(1);
  }
}

writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
console.log(`spec-snapshot.json: ${Object.keys(current).length} components locked`);
