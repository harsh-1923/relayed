// Twelve real, read-only questions about this repository.
//
// Eight have an answer that is naturally structured — a table, a comparison, a
// list with counts — where a UI block should help. Four are short, explanatory,
// or code, where a UI block would be noise. A carrier that is used everywhere is
// as wrong as one that is never used, so both halves are scored.
export const PROMPTS = [
  { id: 'sync-tests', expectUi: true,
    text: 'Which test files exist under apps/desktop/src/sync, and how many `test(` calls does each contain?' },
  { id: 'coalescing', expectUi: true,
    text: 'Summarise the outbox coalescing rules in docs/DESIGN.md: for each queued op and new op, what is the result?' },
  { id: 'storage-tiers', expectUi: true,
    text: 'Compare the storage tiers in docs/STORAGE.md: what lives in each, and when is each deleted?' },
  { id: 'boundary-rules', expectUi: true,
    text: 'List the rules in tools/check-boundaries.mjs, with the doc each one cites.' },
  { id: 'packages', expectUi: true,
    text: 'Which workspace packages are in this repo (apps/* and packages/*), and which @relayed/* packages does each depend on?' },
  { id: 'largest-files', expectUi: true,
    text: 'Which are the six largest .ts files in apps/desktop/src/sync by line count? Give the counts.' },
  { id: 'server-ops', expectUi: true,
    text: 'What domain ops are exported from apps/server/src/sync/ops.ts, and what does each check before writing?' },
  { id: 'non-negotiables', expectUi: true,
    text: 'Group the "Non-negotiables" table in AGENTS.md by subsystem, with a count per group.' },

  { id: 'new-id', expectUi: false,
    text: 'What does newId in apps/desktop/src/sync/ids.ts return? One sentence.' },
  { id: 'why-utility-process', expectUi: false,
    text: 'In two short paragraphs, why does the sync engine run in a utilityProcess rather than the main process?' },
  { id: 'topics-intersect', expectUi: false,
    text: 'Show the code of topicsIntersect in apps/desktop/src/shared/topics.ts and explain why the trailing colon matters.' },
  { id: 'zod-dependency', expectUi: false,
    text: 'Is zod a dependency of apps/desktop? Answer yes or no and say where you checked.' },
];

// Built to exercise the repair loop, which round one never reached: no block was
// ever invalid. Tool carrier only — inline blocks have no in-turn repair.
export const REPAIR_PROMPTS = [
  { id: 'repair-forced', expectUi: true,
    text: 'First call show_ui with exactly this source, unchanged:\n\nroot = Card([s])\ns = Sparkline("Files", [1103, 857, 701])\n\nThen, whatever it returns, show the six largest .ts files in apps/desktop/src/sync by line count.' },
  { id: 'repair-natural', expectUi: true,
    text: 'Chart the line counts of the six largest .ts files in apps/desktop/src/sync, and for each say whether a matching .test.ts exists.' },
];
