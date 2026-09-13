// Spike 3 — the service runtime (pi, through apps/agent's own provider table),
// same prompts, same tool, same instructions as spike 2.
//
// Questions: does pi's configured model use `show_ui` sensibly, write valid
// blocks, and repair from returned errors? Do tool arguments stream?
//
// Usage: node --env-file-if-exists=../../.env 3-pi.mjs [concurrency]
// Read-only: pi's palette is limited to read, grep, find, ls and show_ui.
// apps/agent is imported, never modified.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHOW_UI, instructions, validateUi, formatForModel } from './library.mjs';
import { PROMPTS, REPAIR_PROMPTS } from './prompts.mjs';
const ALL = [...PROMPTS, ...REPAIR_PROMPTS];

const REPO = resolve('../..');
const OUT = 'results/3-pi';
mkdirSync(OUT, { recursive: true });
const concurrency = Number(process.argv[2] ?? 3);

// pi is ESM-only and lives in apps/agent's dependency tree.
const PI_DIR = realpathSync(join(REPO, 'apps/agent/node_modules/@earendil-works/pi-coding-agent'));
const pi = await import(pathToFileURL(join(PI_DIR, 'dist/index.js')).href);
const { Type } = await import(pathToFileURL(join(dirname(PI_DIR), 'pi-ai/dist/index.js')).href);
const { modelRuntime, resolveModel } = await import(pathToFileURL(join(REPO, 'apps/agent/src/providers.ts')).href);

const PALETTE = ['read', 'grep', 'find', 'ls'];

async function runOne(prompt) {
  const calls = [];
  const started = Date.now();
  const agentDir = mkdtempSync(join(tmpdir(), 'relayed-genui-pi-'));
  let toolDeltas = 0;
  let turns = 0;
  const texts = [];
  let failure;

  const showUi = {
    name: SHOW_UI.name,
    label: 'Show UI',
    description: SHOW_UI.description,
    parameters: Type.Object({ source: Type.String() }),
    async execute(_toolCallId, params) {
      const result = validateUi(params.source);
      calls.push({ ok: result.ok, codes: result.errors.map(error => error.code),
                   escapedNewlines: /\\n/.test(params.source), bytes: Buffer.byteLength(params.source),
                   source: params.source, text: result.text });
      // pi turns a thrown error into an error result the model sees.
      if (!result.ok) throw new Error(formatForModel(result.errors));
      return { content: [{ type: 'text', text: 'Shown to the people in this chat.' }], details: {} };
    },
  };

  let model;
  try {
    ({ model } = await resolveModel(undefined));
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: REPO, agentDir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      appendSystemPrompt: [instructions({ preferBlocks: true })],
    });
    await resourceLoader.reload();
    const { session } = await pi.createAgentSession({
      model, modelRuntime: await modelRuntime(), cwd: REPO, agentDir, resourceLoader,
      sessionManager: pi.SessionManager.inMemory(REPO),
      tools: [...PALETTE, SHOW_UI.name],
      customTools: [showUi],
    });
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent;
        if (inner?.type === 'toolcall_delta') toolDeltas += 1;
      } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const content = event.message.content;
        if (Array.isArray(content)) for (const block of content) if (block.type === 'text') texts.push(block.text);
        if (event.message.errorMessage) failure = event.message.errorMessage;
      } else if (event.type === 'turn_end') {
        turns += 1;
        if (turns >= 20) void session.abort();
      }
    });
    try { await session.prompt(prompt.text, { expandPromptTemplates: false }); } finally { unsubscribe(); }
  } catch (error) {
    failure = String(error?.message ?? error);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }

  const firstInvalid = calls.findIndex(call => !call.ok);
  const record = {
    id: prompt.id, expectUi: prompt.expectUi, model: model?.id, outcome: failure ? 'failed' : 'success',
    turns, ms: Date.now() - started, blocks: calls.length, usedUi: calls.length > 0,
    firstTryValid: calls.length ? calls[0].ok : null, anyInvalid: firstInvalid >= 0,
    repaired: firstInvalid >= 0 ? calls.slice(firstInvalid + 1).some(call => call.ok) : null,
    finalValid: calls.length ? calls[calls.length - 1].ok : null,
    errorCodes: calls.flatMap(call => call.codes),
    escapingMistakes: calls.filter(call => call.escapedNewlines).length,
    toolArgumentDeltas: toolDeltas,
    duplicatedAsMarkdownTable: calls.length > 0 && /\n\s*\|[\s:-]*-{3}/.test(texts.join('\n\n')),
    calls, reply: texts.join('\n\n'), error: failure,
  };
  writeFileSync(`${OUT}/${prompt.id}.json`, JSON.stringify(record, null, 2));
  console.log(`pi ${prompt.id.padEnd(22)} ui=${record.blocks} first=${record.firstTryValid} final=${record.finalValid} deltas=${toolDeltas} ${record.outcome} ${Math.round(record.ms / 1000)}s`);
  return record;
}

const records = [];
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < ALL.length) records.push(await runOne(ALL[next++]));
}));

const main = records.filter(row => !row.id.startsWith('repair-'));
const structured = main.filter(row => row.expectUi);
const plain = main.filter(row => !row.expectUi);
const withUi = records.filter(row => row.usedUi);
const summary = {
  model: records.find(row => row.model)?.model,
  runs: records.length,
  usedUiWhenExpected: `${structured.filter(row => row.usedUi).length}/${structured.length}`,
  usedUiWhenNotExpected: `${plain.filter(row => row.usedUi).length}/${plain.length}`,
  blocksTotal: records.reduce((sum, row) => sum + row.blocks, 0),
  firstTryValid: `${withUi.filter(row => row.firstTryValid).length}/${withUi.length}`,
  runsWithAnInvalidBlock: withUi.filter(row => row.anyInvalid).length,
  repairedInSameTurn: `${withUi.filter(row => row.repaired).length}/${withUi.filter(row => row.anyInvalid).length}`,
  finalValid: `${withUi.filter(row => row.finalValid).length}/${withUi.length}`,
  errorCodes: records.flatMap(row => row.errorCodes),
  escapingMistakes: records.reduce((sum, row) => sum + row.escapingMistakes, 0),
  duplicatedAsMarkdownTable: `${withUi.filter(row => row.duplicatedAsMarkdownTable).length}/${withUi.length}`,
  repairProbes: records.filter(row => row.id.startsWith('repair-')).map(row => ({ id: row.id, blocks: row.blocks, codes: row.errorCodes, repaired: row.repaired, finalValid: row.finalValid })),
  runsWhereToolArgumentsStreamed: records.filter(row => row.toolArgumentDeltas > 0).length,
  failedRuns: records.filter(row => row.outcome !== 'success').map(row => `${row.id}: ${String(row.error).slice(0, 120)}`),
};
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
