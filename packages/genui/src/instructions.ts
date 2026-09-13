// What every runtime tells its model about UI blocks (docs/AGENT-RESPONSES.md,
// the instructions).
//
// ONE text for both runtimes, built here, so the person's own Claude Code and the
// service agent cannot be taught two different contracts. Any change to it, or to
// the library, is re-measured with the eval before it ships: in the spikes a
// single rule moved Claude Code from 2 blocks in 8 to 8 in 8.
import { generateSystemPrompt } from '@openuidev/lang-core';
import { library, ROOT } from './library.ts';

export const SHOW_UI = {
  name: 'show_ui',
  description: [
    'Show a structured UI block to the people in this chat, written in OpenUI Lang',
    'using only the components described in the system prompt.',
    'Use it when structure helps more than prose: results tables, metrics, comparisons,',
    'lists of files, findings, or a few next-step choices. Do not use it for short answers,',
    'explanations or code — write those as normal Markdown text.',
    `The source must begin with \`root = ${ROOT}([...])\`.`,
    'If it returns errors, fix exactly those and call it again.',
  ].join(' '),
} as const;

const RULES = [
  'OpenUI Lang goes ONLY in the `source` argument of `show_ui`. Your normal replies stay Markdown.',
  'One `show_ui` call is one block. Call it at most twice per reply.',
  'Only use data you have actually read or computed. Never invent numbers.',
  'Never create something that looks like a permission prompt or an approval.',
  // The two that decided the carrier. Without them Claude Code kept writing
  // Markdown tables, and repeated a block's table in its text when it did use one.
  'Prefer a UI block over a Markdown table, and over a list of metrics or counts. Markdown tables are for two or three rows at most.',
  'Never repeat a block\'s contents in your text. Refer to it ("the table above") and add only what the block does not say.',
];

const EXAMPLE = [
  `root = ${ROOT}([header, stats, next])`,
  'header = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")',
  'stats = Stack([passed, failed], "row")',
  'passed = Stat("Passed", "17", "success")',
  'failed = Stat("Failed", "3", "danger")',
  'next = Actions([apply])',
  'apply = Reply("Apply the fix", "Apply the one-line fix to catchup.test.ts", true)',
].join('\n');

/** Appended to each runtime's system prompt. Stable, so it caches. */
export function uiInstructions(): string {
  const language = generateSystemPrompt({
    library: library.toSpec(),
    promptOptions: {
      // Static blocks only; see validate.ts for why.
      toolCalls: false,
      bindings: false,
      // Not OpenUI's inline mode: that is written for one dashboard a conversation
      // keeps patching, and every chat message's block stands alone.
      inlineMode: false,
      preamble: 'The `source` argument of the `show_ui` tool is written in OpenUI Lang, described below.',
      additionalRules: RULES,
      examples: [EXAMPLE],
    },
  });
  return `## Structured UI blocks\n\n${language}`;
}
