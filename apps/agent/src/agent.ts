// The agent loop (docs/AGENT-RUNTIME.md §3, §6).
//
// pi's transport is streaming-only: a provider adapter returns an event stream
// and the loop emits deltas as tokens arrive. So streaming is not something
// built here — it is something NOT discarded here. Both modes subscribe to the
// same events; the sink decides whether they are forwarded or only accumulated.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { env } from './env.ts';
import { modelRuntime, resolveModel } from './providers.ts';
import type { RunResult, RunStatus, ToolCall } from './runs.ts';

/**
 * pi's defaults, named explicitly.
 *
 * Passing the list rather than relying on the default keeps the palette stable
 * across pi versions — 0.85 added `powershell` to the built-in set, which this
 * process has no use for and would otherwise have silently acquired.
 */
export const TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

export interface RunRequest {
  prompt: string;
  systemPrompt?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

/** Where loop events go. The JSON mode passes one that drops everything. */
export interface RunSink {
  delta(text: string): void;
  reasoning(text: string): void;
  toolStart(name: string, id: string): void;
  toolEnd(call: ToolCall & { id: string }): void;
}

export const NULL_SINK: RunSink = {
  delta: () => {},
  reasoning: () => {},
  toolStart: () => {},
  toolEnd: () => {},
};

// pi's message shapes, read structurally. Binding to the exported types would
// couple this file to a minor version for no benefit — all that is needed is
// the text, the usage and the error.
type Block = { type?: string; text?: string };
type Message = {
  role?: string;
  content?: Block[] | string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number };
};

function textOf(message: Message): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('');
}

export interface RunHandle {
  /** Stops the loop. Idempotent; the first reason wins. */
  abort: (why: Exclude<RunStatus, 'completed'>) => void;
  result: Promise<RunResult>;
}

/**
 * Start a run. Returns as soon as the loop is running, so the caller can
 * register the handle before awaiting — otherwise a cancel arriving in the
 * first milliseconds has nothing to cancel.
 */
export function startRun(runId: string, req: RunRequest, sink: RunSink): RunHandle {
  const startedAtMs = Date.now();

  // The first reason wins: a timeout that fires while a cancel is landing must
  // not relabel the outcome the user asked for.
  let outcome: Exclude<RunStatus, 'completed'> | undefined;
  let failure: string | undefined;
  let abortLoop: (() => void) | undefined;

  const abort = (why: Exclude<RunStatus, 'completed'>, detail?: string): void => {
    // The reason that wins owns the detail. Without this, the abort pi reports
    // as it unwinds ("Request aborted") lands on a run the user CANCELLED and
    // makes a clean cancellation read as a failure.
    if (outcome !== undefined) { abortLoop?.(); return; }
    outcome = why;
    if (detail !== undefined) failure = detail;
    abortLoop?.();
  };

  const result = (async (): Promise<RunResult> => {
    const { model, provider } = await resolveModel(req.model);
    const cwd = await mkdtemp(join(tmpdir(), 'relayed-agent-'));

    let text = '';
    let turns = 0;
    const toolCalls: ToolCall[] = [];
    const usage = { input: 0, output: 0, cacheRead: 0 };
    const startedTools = new Map<string, { name: string; at: number }>();

    const timer = setTimeout(() => abort('timeout'), env.runTimeoutMs);

    try {
      const runtime = await modelRuntime();
      // A fresh agentDir per run, inside the disposable workspace: pi otherwise
      // reads settings from ~/.pi/agent, which would make a developer's laptop
      // behave differently from a container for invisible reasons.
      const agentDir = join(cwd, '.pi');
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}),
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        model,
        modelRuntime: runtime,
        cwd,
        agentDir,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [...TOOLS],
        ...(req.thinkingLevel !== undefined ? { thinkingLevel: req.thinkingLevel } : {}),
      });

      abortLoop = () => { void session.abort(); };
      // A cancel or timeout that landed while the session was being built has
      // set `outcome` already; honour it instead of running the prompt.
      if (outcome !== undefined) throw new Error('aborted before start');

      const unsubscribe = session.subscribe(event => {
        switch (event.type) {
          case 'message_update': {
            const inner = event.assistantMessageEvent as { type?: string; delta?: string };
            if (inner?.type === 'text_delta' && inner.delta) sink.delta(inner.delta);
            else if (inner?.type === 'thinking_delta' && inner.delta) sink.reasoning(inner.delta);
            break;
          }
          case 'message_end': {
            const message = event.message as Message;
            if (message.role !== 'assistant') break;
            usage.input += message.usage?.input ?? 0;
            usage.output += message.usage?.output ?? 0;
            usage.cacheRead += message.usage?.cacheRead ?? 0;
            if (message.errorMessage) abort('failed', message.errorMessage);
            // The answer is the last assistant message that said anything —
            // messages that only call tools carry no text and must not blank it.
            const said = textOf(message);
            if (said.trim().length > 0) text = said;
            break;
          }
          case 'tool_execution_start':
            startedTools.set(event.toolCallId, { name: event.toolName, at: Date.now() });
            sink.toolStart(event.toolName, event.toolCallId);
            break;
          case 'tool_execution_end': {
            const started = startedTools.get(event.toolCallId);
            startedTools.delete(event.toolCallId);
            const call = {
              name: event.toolName,
              ok: !event.isError,
              ms: started ? Date.now() - started.at : 0,
              id: event.toolCallId,
            };
            toolCalls.push({ name: call.name, ok: call.ok, ms: call.ms });
            sink.toolEnd(call);
            break;
          }
          case 'turn_end':
            turns += 1;
            // A loop that cannot make progress will otherwise spend the whole
            // wall-clock budget discovering that.
            if (turns >= env.maxTurns) abort('failed', `turn cap reached (${env.maxTurns})`);
            break;
          default:
            break;
        }
      });

      try {
        await session.prompt(req.prompt, { expandPromptTemplates: false });
      } finally {
        unsubscribe();
      }
    } catch (err) {
      // An abort surfaces here as a rejection; it is not a new failure, and the
      // reason already recorded is the true one.
      if (outcome === undefined) {
        outcome = 'failed';
        failure ??= err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timer);
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }

    const status: RunStatus = outcome ?? 'completed';
    return {
      runId,
      status,
      text,
      toolCalls,
      usage,
      turns,
      provider,
      durationMs: Date.now() - startedAtMs,
      ...(failure !== undefined ? { error: failure } : {}),
    };
  })();

  return { abort, result };
}
