// Spike 2 — the user's own Claude Code, doing real read-only work.
//
// Questions:
//   a. Does Claude Code use `show_ui` when structure helps, and leave it alone when it does not?
//   b. How often is the first block valid, and does a returned error get fixed in the same turn?
//   c. Does JSON-escaping the source (a tool argument) cause mistakes?
//   d. Does the tool input stream, so a card can fill in while it is written?
//   e. What do the instructions cost, measured rather than estimated?
//   f. Same questions for fenced blocks in text, as the comparison.
//
// Usage: node 2-claude.mjs <variant[,variant…]> [concurrency]
//   variants: tool, inline (round one) · tool-nudged, inline-nudged, repair (round two)
// Read-only by construction: built-in tools are limited to Read, Glob and Grep,
// and no transcript is written to ~/.claude (persistSession: false).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod/v4';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  SHOW_UI, instructions, instructionsInline, extractFences, validateUi, formatForModel,
} from './library.mjs';
import { PROMPTS, REPAIR_PROMPTS } from './prompts.mjs';
import { claudeEnv, CLAUDE_PATH } from './claude-env.mjs';

const REPO = resolve('../..');
const OUT = 'results/2-claude';
mkdirSync(OUT, { recursive: true });

const VARIANTS = {
  tool:            { carrier: 'tool',   preferBlocks: false, prompts: PROMPTS },
  inline:          { carrier: 'inline', preferBlocks: false, prompts: PROMPTS },
  'tool-nudged':   { carrier: 'tool',   preferBlocks: true,  prompts: PROMPTS },
  'inline-nudged': { carrier: 'inline', preferBlocks: true,  prompts: PROMPTS },
  repair:          { carrier: 'tool',   preferBlocks: true,  prompts: REPAIR_PROMPTS },
};
const variantNames = (process.argv[2] ?? 'tool,inline').split(',');
const concurrency = Number(process.argv[3] ?? 3);
const READ_ONLY = ['Read', 'Glob', 'Grep'];
const SHOW_UI_TOOL = `mcp__relayed__${SHOW_UI.name}`;

/** Decode the `source` string out of a partial JSON tool input, as far as it has arrived. */
function partialSource(json) {
  const key = json.indexOf('"source"');
  if (key < 0) return '';
  const open = json.indexOf('"', json.indexOf(':', key) + 1);
  if (open < 0) return '';
  let out = '';
  for (let i = open + 1; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') break;
    if (ch !== '\\') { out += ch; continue; }
    const next = json[i + 1];
    if (next === undefined) break;                       // escape split across chunks
    if (next === 'u') {
      if (i + 5 >= json.length) break;
      out += String.fromCharCode(parseInt(json.slice(i + 2, i + 6), 16)); i += 5; continue;
    }
    out += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' }[next] ?? next;
    i += 1;
  }
  return out;
}

async function runOne(prompt, variantName) {
  const { carrier: mode, preferBlocks } = VARIANTS[variantName];
  const calls = [];            // every show_ui attempt, in order
  const started = Date.now();
  let streamSnapshots = [];
  let partialJson = '';
  let inToolBlock = false;
  let deltaEvents = 0;
  let initModel;
  const texts = [];

  const relayed = createSdkMcpServer({
    name: 'relayed',
    version: '0.0.0',
    tools: [
      tool(SHOW_UI.name, SHOW_UI.description, { source: z.string() }, async ({ source }) => {
        const result = validateUi(source);
        calls.push({
          ok: result.ok,
          codes: result.errors.map(error => error.code),
          escapedNewlines: /\\n/.test(source),
          bytes: Buffer.byteLength(source),
          source,
          text: result.text,
        });
        return result.ok
          ? { content: [{ type: 'text', text: 'Shown to the people in this chat.' }] }
          : { isError: true, content: [{ type: 'text', text: formatForModel(result.errors) }] };
      }),
    ],
  });

  const options = {
    cwd: REPO,
    pathToClaudeCodeExecutable: CLAUDE_PATH,
    env: claudeEnv(),
    persistSession: false,
    settingSources: ['project'],
    settings: { disableAllHooks: true },
    tools: READ_ONLY,
    allowedTools: mode === 'tool' ? [...READ_ONLY, SHOW_UI_TOOL] : READ_ONLY,
    canUseTool: async (name, input) =>
      [...READ_ONLY, SHOW_UI_TOOL].includes(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Read-only spike.' },
    strictMcpConfig: true,
    mcpServers: mode === 'tool' ? { relayed } : {},
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: mode === 'tool' ? instructions({ preferBlocks }) : instructionsInline({ preferBlocks }),
    },
    includePartialMessages: true,
    maxTurns: 20,
  };

  let result;
  try {
    for await (const message of query({ prompt: prompt.text, options })) {
      if (message.type === 'system' && message.subtype === 'init') initModel = message.model;

      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          inToolBlock = event.content_block.name === SHOW_UI_TOOL;
          partialJson = '';
          if (inToolBlock) streamSnapshots = [];
        } else if (event.type === 'content_block_delta' && inToolBlock && event.delta?.type === 'input_json_delta') {
          deltaEvents += 1;
          partialJson += event.delta.partial_json;
          streamSnapshots.push(partialSource(partialJson));
        } else if (event.type === 'content_block_stop') {
          inToolBlock = false;
        }
      }

      if (message.type === 'assistant') {
        for (const block of message.message.content) if (block.type === 'text') texts.push(block.text);
      }
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    result = { subtype: 'exception', error: String(error?.message ?? error) };
  }

  const reply = texts.join('\n\n');
  if (mode === 'inline') {
    for (const source of extractFences(reply)) {
      const checked = validateUi(source);
      calls.push({ ok: checked.ok, codes: checked.errors.map(error => error.code), escapedNewlines: false,
                   bytes: Buffer.byteLength(source), source, text: checked.text });
    }
  }

  const firstInvalid = calls.findIndex(call => !call.ok);
  const record = {
    id: prompt.id,
    variant: variantName,
    mode,
    expectUi: prompt.expectUi,
    model: initModel,
    outcome: result?.subtype,
    turns: result?.num_turns,
    ms: Date.now() - started,
    usage: result?.usage,
    listPriceUsd: result?.total_cost_usd,
    blocks: calls.length,
    usedUi: calls.length > 0,
    firstTryValid: calls.length > 0 ? calls[0].ok : null,
    anyInvalid: firstInvalid >= 0,
    repaired: firstInvalid >= 0 ? calls.slice(firstInvalid + 1).some(call => call.ok) : null,
    finalValid: calls.length > 0 ? calls[calls.length - 1].ok : null,
    errorCodes: calls.flatMap(call => call.codes),
    escapingMistakes: calls.filter(call => call.escapedNewlines).length,
    // A block plus a Markdown table in the same reply is almost always the same data twice.
    duplicatedAsMarkdownTable: calls.length > 0 && /\n\s*\|[\s:-]*-{3}/.test(reply),
    streamedDeltaEvents: deltaEvents,
    streamSnapshots: streamSnapshots.length,
    calls,
    reply,
    error: result?.error,
  };
  writeFileSync(`${OUT}/${variantName}-${prompt.id}.json`, JSON.stringify(record, null, 2));
  if (mode === 'tool' && streamSnapshots.length > 5 && calls.at(-1)?.ok) {
    writeFileSync(`${OUT}/stream-fixture-${prompt.id}.json`, JSON.stringify(streamSnapshots));
  }
  console.log(`${variantName.padEnd(13)} ${prompt.id.padEnd(22)} ui=${record.blocks} first=${record.firstTryValid} final=${record.finalValid} deltas=${deltaEvents} ${record.outcome} ${Math.round(record.ms / 1000)}s`);
  return record;
}

/** Measured cost of the instructions: one trivial turn with and without them. */
async function measureInstructions() {
  const measure = async append => {
    let usage;
    for await (const message of query({
      prompt: 'Reply with the single word OK.',
      options: {
        pathToClaudeCodeExecutable: CLAUDE_PATH, env: claudeEnv(), persistSession: false,
        settingSources: [], tools: [], maxTurns: 1, strictMcpConfig: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
      },
    })) if (message.type === 'result') usage = message.usage;
    return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  };
  const without = await measure(null);
  const withTool = await measure(instructions());
  return { baselineInputTokens: without, instructionsTokens: withTool - without };
}

const jobs = variantNames.flatMap(name => VARIANTS[name].prompts.map(prompt => () => runOne(prompt, name)));
const records = [];
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < jobs.length) records.push(await jobs[next++]());
}));

const summarise = name => {
  const rows = records.filter(record => record.variant === name);
  const structured = rows.filter(row => row.expectUi);
  const plain = rows.filter(row => !row.expectUi);
  const withUi = rows.filter(row => row.usedUi);
  return {
    runs: rows.length,
    usedUiWhenExpected: `${structured.filter(row => row.usedUi).length}/${structured.length}`,
    usedUiWhenNotExpected: `${plain.filter(row => row.usedUi).length}/${plain.length}`,
    blocksTotal: rows.reduce((sum, row) => sum + row.blocks, 0),
    firstTryValid: `${withUi.filter(row => row.firstTryValid).length}/${withUi.length}`,
    runsWithAnInvalidBlock: withUi.filter(row => row.anyInvalid).length,
    repairedInSameTurn: `${withUi.filter(row => row.repaired).length}/${withUi.filter(row => row.anyInvalid).length}`,
    finalValid: `${withUi.filter(row => row.finalValid).length}/${withUi.length}`,
    errorCodes: rows.flatMap(row => row.errorCodes),
    escapingMistakes: rows.reduce((sum, row) => sum + row.escapingMistakes, 0),
    duplicatedAsMarkdownTable: `${withUi.filter(row => row.duplicatedAsMarkdownTable).length}/${withUi.length}`,
    runsWhereToolInputStreamed: rows.filter(row => row.streamedDeltaEvents > 0).length,
    failedRuns: rows.filter(row => row.outcome !== 'success').map(row => `${row.id}:${row.outcome}`),
    medianSeconds: Math.round([...rows].map(row => row.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] / 1000),
    model: rows[0]?.model,
  };
};

const summary = variantNames.includes('tool') ? { measured: await measureInstructions() } : {};
for (const name of variantNames) summary[name] = summarise(name);
writeFileSync(`${OUT}/summary-${variantNames.join('+')}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
