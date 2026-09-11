// What runs on the files you are about to commit.
//
// STAGED FILES ONLY, which is the whole point: a pre-commit hook that checks the
// repository is a pre-commit hook people disable. This one's cost scales with
// the size of the change, not the size of the codebase.
//
// ORDER MATTERS where both tools touch a file — ESLint first, then Prettier,
// because a `--fix` can leave formatting behind that the formatter then settles.
// In this repository they never overlap: Prettier does not own `.ts`/`.tsx` (see
// .prettierignore for the measurement behind that), so each extension is handled
// by exactly one tool. The ordering is written down anyway, because the day
// Prettier is given the source back is the day the order starts mattering.
export default {
  // `--no-warn-ignored`: staging a file under `components/ui/` is ordinary —
  // `shadcn add` writes there — and ESLint otherwise fails the commit to tell
  // you it declined to lint a file it was configured to ignore.
  //
  // `--max-warnings=0`: a warning nobody has to act on is a warning everybody
  // stops reading. The one warning class this config produces is an
  // eslint-disable comment that no longer suppresses anything, which is exactly
  // the kind of stale instruction worth failing on.
  '*.{ts,tsx,mts}': ['eslint --fix --no-warn-ignored --max-warnings=0'],
  '*.{mjs,js,cjs}': ['eslint --fix --no-warn-ignored --max-warnings=0'],

  // Everything Prettier is allowed to own. `.prettierignore` is the authority on
  // which files those actually are; this pattern only decides what gets offered.
  '*.{json,yaml,yml,css}': ['prettier --write --ignore-unknown'],
};
