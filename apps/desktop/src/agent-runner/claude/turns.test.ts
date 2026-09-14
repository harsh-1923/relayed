// The turn engine against a scripted Claude Code: what the child emits, what
// the sync engine is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { setSink } from '@relayed/telemetry';
import type { RunnerEvent, TurnStart } from '../../shared/claude.ts';
import { boundInput, ChatSessions, LOCAL_ROOM_MODEL, SHOW_UI_TOOL, textOf, type ToolResult } from './turns.ts';

/** A fake child: the test writes what it emits, and sees what it was sent. */
function fakeClaude() {
  const emitted: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const received: string[] = [];
  let options: Options | null = null;
  let closed = false;
  const modes: string[] = [];
  const models: string[] = [];

  const query = ({ prompt, options: given }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    options = given;
    void (async () => {
      for await (const message of prompt) {
        const content = message.message.content;
        received.push(typeof content === 'string' ? content : JSON.stringify(content));
      }
    })();
    return {
      close: () => { closed = true; ended = true; wake?.(); },
      setPermissionMode: (mode: string) => { modes.push(mode); return Promise.resolve(); },
      setModel: (model?: string) => { models.push(model ?? ''); return Promise.resolve(); },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (emitted.length) yield emitted.shift() as SDKMessage;
          if (ended) return;
          await new Promise<void>(resolve => { wake = resolve; });
          wake = null;
        }
      },
    };
  };
  const send = (...messages: object[]) => { emitted.push(...(messages as SDKMessage[])); wake?.(); };
  return { query, send, received, modes, models, get options() { return options; }, get closed() { return closed; }, crash: () => { ended = true; wake?.(); } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const start = (over: Partial<TurnStart> = {}): TurnStart => ({
  chatId: 'cht_1', messageId: 'msg_reply', cwd: '/repo', mode: 'accept-edits', model: null, effort: null, sessionId: null, text: 'Why does it flake?', ...over,
});

function harness() {
  const claude = fakeClaude();
  const events: RunnerEvent[] = [];
  let clock = 1_000;
  let showUi: ((source: string) => Promise<ToolResult>) | null = null;
  const sessions = new ChatSessions(event => events.push(event), {
    query: claude.query, binary: () => '/Users/me/.local/bin/claude', now: () => clock,
    uiServer: (handler) => { showUi = handler; return { type: 'sdk', name: 'relayed', instance: {} as never }; },
  });
  return {
    claude, events, sessions, tick: (ms: number) => { clock += ms; },
    /** Call `show_ui` as Claude Code would, once the session has started. */
    showUi: (source: string) => { if (!showUi) throw new Error('no ui server'); return showUi(source); },
  };
}

const assistant = (content: object[]) => ({ type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null, uuid: 'u', message: { content } });
const toolResult = (id: string, content: unknown, isError = false) =>
  ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const success = (result = 'done') => ({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'sess-1' });

test('a whole turn: live text, a tool that runs and reports, the final text, and the end', async () => {
  const { claude, events, sessions, tick } = harness();
  sessions.start(start());
  await settle();
  assert.deepEqual(claude.received, ['Why does it flake?']);
  assert.equal(claude.options?.cwd, '/repo');
  assert.equal(claude.options?.permissionMode, 'acceptEdits');
  assert.equal(claude.options?.includePartialMessages, true);
  assert.equal(claude.options?.model, LOCAL_ROOM_MODEL);
  assert.equal(LOCAL_ROOM_MODEL, 'claude-sonnet-5');
  assert.deepEqual(claude.options?.settingSources, ['user', 'project', 'local'], 'their CLAUDE.md, settings and hooks apply');

  claude.send(
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me ' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'look.' } } },
  );
  await settle();
  assert.deepEqual(events.find(event => event.event === 'turn.session'), { event: 'turn.session', chatId: 'cht_1', sessionId: 'sess-1' });
  assert.deepEqual(events.filter(event => event.event === 'turn.delta').at(-1),
    { event: 'turn.delta', chatId: 'cht_1', messageId: 'msg_reply', text: 'Let me look.', ui: null }, 'coalesced, and whole');

  claude.send(assistant([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'catchup.test.ts' } }]));
  await settle();
  const running = events.filter(event => event.event === 'turn.parts').at(-1);
  assert.equal(running?.event === 'turn.parts' && running.parts[1]?.kind === 'tool' && running.parts[1].ms, 0, 'still running');

  tick(41);
  claude.send(toolResult('toolu_1', [{ type: 'text', text: "import { test } from 'node:test';" }]));
  claude.send(assistant([{ type: 'text', text: 'It races the close event.' }]), success());
  await settle();

  const done = events.at(-1);
  assert.equal(done?.event, 'turn.done');
  if (done?.event !== 'turn.done') return;
  assert.equal(done.outcome, 'completed');
  assert.equal(done.reason, null);
  assert.deepEqual(done.parts, [
    { kind: 'markdown', text: 'Let me look.' },
    { kind: 'tool', tool_use_id: 'toolu_1', name: 'Read', ok: true, ms: 41, input: { file_path: 'catchup.test.ts' },
      output_preview: "import { test } from 'node:test';", output_bytes: 33 },
    { kind: 'markdown', text: 'It races the close event.' },
  ]);
});

test('the second message goes to the SAME child, not a new one', async () => {
  const { claude, sessions, events } = harness();
  sessions.start(start());
  await settle();
  claude.send(assistant([{ type: 'text', text: 'one' }]), success());
  await settle();
  sessions.start(start({ messageId: 'msg_reply_2', text: 'And now?' }));
  await settle();
  assert.deepEqual(claude.received, ['Why does it flake?', 'And now?']);
  claude.send(assistant([{ type: 'text', text: 'two' }]), success());
  await settle();
  assert.deepEqual(events.filter(event => event.event === 'turn.done').map(event => event.event === 'turn.done' && event.messageId),
    ['msg_reply', 'msg_reply_2']);
});

test('a chat with a session id resumes it', async () => {
  const { claude, sessions } = harness();
  sessions.start(start({ sessionId: 'sess-earlier' }));
  await settle();
  assert.equal(claude.options?.resume, 'sess-earlier');
});

test('stop closes the child and ends the turn as stopped, keeping what arrived', async () => {
  const { claude, sessions, events } = harness();
  sessions.start(start());
  await settle();
  claude.send(assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }]));
  await settle();
  sessions.stop('cht_1');
  await settle();
  assert.equal(claude.closed, true);
  const done = events.at(-1);
  assert.equal(done?.event === 'turn.done' && done.outcome, 'stopped');
  assert.equal(done?.event === 'turn.done' && done.parts[0]?.kind === 'tool' && done.parts[0].ok, false,
    'a tool that never reported back did not finish');
});

test('a child that dies mid-turn fails the turn rather than leaving it streaming', async () => {
  const { claude, sessions, events } = harness();
  sessions.start(start());
  await settle();
  claude.crash();
  await settle();
  const done = events.at(-1);
  assert.equal(done?.event === 'turn.done' && done.outcome, 'failed');
  assert.match(done?.event === 'turn.done' ? done.reason ?? '' : '', /exited before finishing/);
});

test('an error result fails the turn with the CLI\'s reason', async () => {
  const { claude, sessions, events } = harness();
  sessions.start(start());
  await settle();
  claude.send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['usage limit reached'], session_id: 'sess-1' });
  await settle();
  const done = events.at(-1);
  assert.deepEqual(done?.event === 'turn.done' && [done.outcome, done.reason], ['failed', 'usage limit reached']);
});

test('no claude binary is a failed turn that says where to look', () => {
  const events: RunnerEvent[] = [];
  const sessions = new ChatSessions(event => events.push(event), {
    query: fakeClaude().query, binary: () => null, now: Date.now, uiServer: () => ({ type: 'sdk', name: 'relayed', instance: {} as never }),
  });
  sessions.start(start());
  assert.match(events[0]?.event === 'turn.done' ? events[0].reason ?? '' : '', /Settings → Claude Agent/);
});

test('a big tool input keeps what it acted on, not the content', () => {
  const bounded = boundInput({ file_path: 'src/a.ts', content: 'x'.repeat(50_000) }) as Record<string, unknown>;
  assert.deepEqual(bounded, { truncated: true, file_path: 'src/a.ts' });
  assert.deepEqual(boundInput({ command: 'ls' }), { command: 'ls' }, 'small inputs are untouched');
});

test('tool output as text, from a string or from text blocks', () => {
  assert.equal(textOf('plain'), 'plain');
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(textOf({ weird: true }), '');
});

const BLOCK = 'root = Card([h])\nh = CardHeader("Three flaky tests", "In the last 20 runs")';

test('Claude is told about UI blocks, and show_ui never waits on an approval', async () => {
  const { claude, sessions } = harness();
  sessions.start(start());
  await settle();
  const prompt = claude.options?.systemPrompt;
  assert.ok(typeof prompt === 'object' && !Array.isArray(prompt) && prompt.type === 'preset');
  if (typeof prompt !== 'object' || Array.isArray(prompt) || prompt.type !== 'preset') return;
  assert.match(prompt.append ?? '', /running inside Relayed/);
  assert.match(prompt.append ?? '', /OpenUI Lang/, 'the shared instructions');
  assert.deepEqual(claude.options?.allowedTools, [SHOW_UI_TOOL], 'nothing else is pre-approved');
  assert.ok(claude.options?.mcpServers?.['relayed']);
});

test('a valid show_ui call is a ui part in its place, not a tool card', async () => {
  const { claude, sessions, events, showUi } = harness();
  sessions.start(start());
  await settle();
  claude.send(assistant([
    { type: 'text', text: 'Here is what I found.' },
    { type: 'tool_use', id: 'toolu_ui', name: SHOW_UI_TOOL, input: { source: BLOCK } },
  ]));
  await settle();
  const answer = await showUi(BLOCK);
  assert.equal(answer.isError, undefined);
  claude.send(toolResult('toolu_ui', 'Shown to the people in this chat.'), assistant([{ type: 'text', text: 'Fix the first one.' }]), success());
  await settle();

  const done = events.at(-1);
  assert.equal(done?.event, 'turn.done');
  assert.deepEqual(done?.event === 'turn.done' && done.parts, [
    { kind: 'markdown', text: 'Here is what I found.' },
    { kind: 'ui', lang: 'openui-lang@0.5', library: 'relayed-ui@1', source: BLOCK },
    { kind: 'markdown', text: 'Fix the first one.' },
  ]);
});

test('an invalid block stores nothing and sends its errors back to Claude', async () => {
  const { sessions, events, showUi } = harness();
  sessions.start(start());
  await settle();
  const answer = await showUi('root = Card([x])\nx = Sparkline([1, 2])');
  assert.equal(answer.isError, true);
  assert.match(answer.content[0]?.text ?? '', /unknown-component/);
  assert.ok(!events.some(event => event.event === 'turn.parts' && event.parts.some(part => part.kind === 'ui')));
});

test('genui.block is VALID on the first try, and genui.error names the code on a miss',
  async () => {
  const { sessions, showUi } = harness();
  sessions.start(start());
  await settle();

  const calls: { name: string; labels: Record<string, string> }[] = [];
  setSink({ count: (name, labels) => { calls.push({ name, labels: (labels ?? {}) as Record<string, string> }); },
            event: () => {}, gauge: () => {}, histogram: () => {} });
  await showUi(BLOCK);
  assert.deepEqual(calls, [{ name: 'genui.block', labels: { genui_outcome: 'valid' } }]);

  calls.length = 0;
  await showUi('root = Card([x])\nx = Sparkline([1, 2])');
  assert.deepEqual(calls, [{ name: 'genui.error', labels: { genui_error: 'other' } }],
    'unknown-component is not in the catalogue\'s allowlist, so it reads as other');
});

test('genui.block is REPAIRED when a valid call follows an invalid one in the same turn',
  async () => {
  const { sessions, showUi } = harness();
  sessions.start(start());
  await settle();
  await showUi('root = Card([x])\nx = Sparkline([1, 2])');

  const calls: { name: string; labels: Record<string, string> }[] = [];
  setSink({ count: (name, labels) => { calls.push({ name, labels: (labels ?? {}) as Record<string, string> }); },
            event: () => {}, gauge: () => {}, histogram: () => {} });
  await showUi(BLOCK);
  assert.deepEqual(calls, [{ name: 'genui.block', labels: { genui_outcome: 'repaired' } }]);
});

test('genui.block is GIVEN_UP when the turn ends with an invalid call still outstanding',
  async () => {
  const { claude, sessions, showUi } = harness();
  sessions.start(start());
  await settle();
  await showUi('root = Card([x])\nx = Sparkline([1, 2])');

  const calls: { name: string; labels: Record<string, string> }[] = [];
  setSink({ count: (name, labels) => { calls.push({ name, labels: (labels ?? {}) as Record<string, string> }); },
            event: () => {}, gauge: () => {}, histogram: () => {} });
  claude.send(success());
  await settle();
  assert.deepEqual(calls, [{ name: 'genui.block', labels: { genui_outcome: 'given_up' } }]);
});

test('a block being written streams as live ui, and a new block ends its preview', async () => {
  const { claude, sessions, events } = harness();
  sessions.start(start());
  await settle();
  const json = JSON.stringify({ source: BLOCK });
  claude.send(
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: SHOW_UI_TOOL } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(0, 30) } } },
  );
  await settle();
  const partial = events.filter(event => event.event === 'turn.delta').at(-1);
  const soFar = partial?.event === 'turn.delta' ? partial.ui ?? '' : '';
  assert.ok(soFar.length > 0 && soFar.length < BLOCK.length && BLOCK.startsWith(soFar), 'part of the block, drawn as it arrives');

  claude.send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(30) } } });
  await settle();
  const whole = events.filter(event => event.event === 'turn.delta').at(-1);
  assert.equal(whole?.event === 'turn.delta' && whole.ui, BLOCK);

  claude.send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 2, content_block: { type: 'text' } } });
  await settle();
  const after = events.filter(event => event.event === 'turn.delta').at(-1);
  assert.equal(after?.event === 'turn.delta' && after.ui, null);
});

// ── approvals ──────────────────────────────────────────────────────────────

/** Ask as Claude Code does before running a tool, and hand back what it would wait on. */
function ask(claude: ReturnType<typeof fakeClaude>, toolName: string, input: Record<string, unknown>, extra: object = {}) {
  const controller = new AbortController();
  const canUseTool = claude.options?.canUseTool;
  if (!canUseTool) throw new Error('no canUseTool');
  const result = Promise.resolve(canUseTool(toolName, input, { signal: controller.signal, toolUseID: 'toolu_1', requestId: 'req_1', ...extra }))
    .then(answer => { if (!answer) throw new Error('canUseTool answered null'); return answer; });
  return { result, abort: () => controller.abort() };
}

const requested = (events: RunnerEvent[]) =>
  events.filter((event): event is Extract<RunnerEvent, { event: 'approval.requested' }> => event.event === 'approval.requested').map(event => event.approval);

test('a tool that needs approval pauses the turn until the person allows it', async () => {
  const { claude, events, sessions } = harness();
  sessions.start(start({ mode: 'supervised' }));
  await settle();
  assert.equal(claude.options?.permissionMode, 'default');

  const { result } = ask(claude, 'Bash', { command: 'npm test' }, {
    title: 'Claude wants to run npm test', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
  });
  const [approval] = requested(events);
  assert.ok(approval?.kind === 'tool');
  assert.equal(approval.title, 'Claude wants to run npm test');
  assert.equal(approval.summary, 'npm test');
  assert.equal(approval.canAlwaysAllow, true);
  assert.equal(approval.messageId, 'msg_reply');

  sessions.respond('cht_1', approval.id, { type: 'allow', always: true });
  const answer = await result;
  assert.equal(answer.behavior, 'allow');
  // "Always" is the suggested rule, kept to this session rather than written to their settings.
  assert.deepEqual(answer.behavior === 'allow' && answer.updatedPermissions?.map(update => update.destination), ['session']);
  assert.ok(events.some(event => event.event === 'approval.settled' && event.approvalId === approval.id));
  assert.throws(() => sessions.respond('cht_1', approval.id, { type: 'allow' }), /no longer waiting/);
});

test('a denial reaches Claude with a reason, and a question is answered with the chosen labels', async () => {
  const { claude, events, sessions } = harness();
  sessions.start(start());
  await settle();

  const denied = ask(claude, 'Write', { file_path: '/repo/a.ts', content: 'x' });
  const [tool] = requested(events);
  assert.throws(() => sessions.respond('cht_1', tool!.id, { type: 'answer', answers: {} }), /cannot be answered/);
  sessions.respond('cht_1', tool!.id, { type: 'deny' });
  const no = await denied.result;
  assert.equal(no.behavior, 'deny');

  const questions = [{ question: 'Which runner?', header: 'Runner', multiSelect: false, options: [{ label: 'node:test', description: 'built in' }, { label: 'vitest', description: '' }] }];
  const asked = ask(claude, 'AskUserQuestion', { questions });
  const question = requested(events)[1];
  assert.ok(question?.kind === 'question');
  assert.deepEqual(question.questions, questions);
  sessions.respond('cht_1', question.id, { type: 'answer', answers: { 'Which runner?': 'node:test' } });
  const yes = await asked.result;
  assert.deepEqual(yes.behavior === 'allow' && yes.updatedInput, { questions, answers: { 'Which runner?': 'node:test' } });
});

test('stopping the turn, or the SDK giving up on an ask, answers it with a denial', async () => {
  const { claude, events, sessions } = harness();
  sessions.start(start());
  await settle();

  const aborted = ask(claude, 'Bash', { command: 'rm -rf build' });
  aborted.abort();
  assert.equal((await aborted.result).behavior, 'deny');

  const open = ask(claude, 'Bash', { command: 'make' });
  sessions.stop('cht_1');
  assert.equal((await open.result).behavior, 'deny');
  await settle();
  assert.equal(requested(events).length, 2);
  assert.equal(events.filter(event => event.event === 'approval.settled').length, 2);
});

test('a mode change reaches a live session; full access needs a restart it gets when idle', async () => {
  const { claude, events, sessions } = harness();
  sessions.start(start({ mode: 'supervised' }));
  await settle();

  sessions.setMode(['cht_1', 'cht_elsewhere'], 'accept-edits');
  assert.deepEqual(claude.modes, ['acceptEdits']);

  // Mid-turn: kept until the turn ends, then closed so the next message resumes with the flag.
  sessions.setMode(['cht_1'], 'full-access');
  assert.equal(claude.closed, false);
  claude.send(success());
  await settle();
  assert.ok(events.some(event => event.event === 'turn.done'));
  assert.equal(claude.closed, true);
});

test('a room\'s model and effort reach the child; a new model switches in place, a new effort restarts it', async () => {
  const { claude, events, sessions } = harness();
  sessions.start(start({ model: 'opus', effort: 'high' }));
  await settle();
  assert.equal(claude.options?.model, 'opus');
  assert.equal(claude.options?.effort, 'high');

  sessions.setModel(['cht_1'], 'sonnet', 'high');
  assert.deepEqual(claude.models, ['sonnet']);
  assert.equal(claude.closed, false);

  sessions.setModel(['cht_1'], 'sonnet', 'low');
  assert.equal(claude.closed, false, 'kept until the turn ends');
  claude.send(success());
  await settle();
  assert.ok(events.some(event => event.event === 'turn.done'));
  assert.equal(claude.closed, true);
});

// ── slash commands ─────────────────────────────────────────────────────────

test('what a slash command prints, and a compaction, become part of the reply; a new command list is reported', async () => {
  const { claude, events, sessions } = harness();
  sessions.start(start({ text: '/context' }));
  await settle();
  assert.deepEqual(claude.received, ['/context'], 'sent as the message it is');

  const escape = String.fromCharCode(27);
  claude.send(
    { type: 'system', subtype: 'local_command_output', content: `${escape}[1mContext${escape}[0m 12k / 200k`, uuid: 'u1', session_id: 'sess-1' },
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 120_400, post_tokens: 18_200 }, uuid: 'u2', session_id: 'sess-1' },
    { type: 'system', subtype: 'commands_changed', commands: [{ name: 'compact', description: 'Compact', argumentHint: '' }], uuid: 'u3', session_id: 'sess-1' },
    success('Context 12k / 200k'),
  );
  await settle();
  const done = events.find(event => event.event === 'turn.done');
  assert.ok(done?.event === 'turn.done');
  assert.deepEqual(done.parts, [
    { kind: 'markdown', text: '```text\nContext 12k / 200k\n```' },
    { kind: 'markdown', text: '_Context compacted: 120k → 18k tokens._' },
  ], 'the result text is not repeated after the printed output');
  assert.deepEqual(events.find(event => event.event === 'commands.changed'),
    { event: 'commands.changed', chatId: 'cht_1', commands: [{ name: 'compact', description: 'Compact', argumentHint: '', aliases: [] }] });
});
