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
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { RunRequest, RunTool, ThinkingLevel } from '@relayed/protocol';
import { env } from './env.ts';
import { modelRuntime, resolveModel } from './providers.ts';
import type { RunResult, RunStatus, ToolCall } from './runs.ts';

export type { RunRequest };

/**
 * pi's defaults, named explicitly.
 *
 * Passing the list rather than relying on the default keeps the palette stable
 * across pi versions — 0.85 added `powershell` to the built-in set, which this
 * process has no use for and would otherwise have silently acquired.
 *
 * Only for `palette: 'default'` — a local room's own Claude Code (unused
 * here). A workspace agent (`palette: 'none'`) gets none of these
 * (WORKSPACE-AGENTS.md §5.4).
 */
export const TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/** The wire's vocabulary (`@relayed/protocol`) to pi's own — `'none'` is pi's `'off'`. */
const PI_THINKING_LEVEL: Record<ThinkingLevel, NonNullable<CreateAgentSessionOptions['thinkingLevel']>> = {
  none: 'off', low: 'low', medium: 'medium', high: 'high',
};

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
 * One remote tool, registered as a pi `customTools` entry whose `execute`
 * calls the broker — the only place a workspace agent's tool calls go
 * (WORKSPACE-AGENTS.md §5.4, §5.5). `runId` and `grant` come from the run
 * that registered it, never from the tool call itself.
 *
 * `parameters` is Composio's JSON Schema, passed through as-is rather than
 * converted to a TypeBox schema: whether pi's validation accepts a raw JSON
 * Schema object here, or needs `Type.Unsafe`, is exactly what
 * `spikes/agent-tools/` (WORKSPACE-AGENTS-IMPL.md) is meant to settle — and
 * nothing exercises this path until a run actually carries tools (steps 4/5).
 */
function remoteTool(tool: RunTool, runId: string, grant: string | undefined): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as ToolDefinition['parameters'],
    // Errors are signalled by THROWING, never by a return value (pi's
    // convention): a return is always reported to the model as success.
    async execute(toolCallId, params, signal) {
      if (!env.agentBrokerUrl) throw new Error('no tool broker is configured for this runtime');
      const res = await fetch(`${env.agentBrokerUrl}/agent/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${grant ?? ''}` },
        body: JSON.stringify({ runId, toolCallId, tool: tool.name, arguments: params }),
        ...(signal ? { signal } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`tool call failed (${res.status}): ${text}`);
      return { content: [{ type: 'text', text }], details: undefined };
    },
  };
}

/**
 * Start a run. Returns as soon as the loop is running, so the caller can
 * register the handle before awaiting — otherwise a cancel arriving in the
 * first milliseconds has nothing to cancel.
 */
export function startRun(req: RunRequest, sink: RunSink): RunHandle {
  const { runId } = req;
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

    // A provider that stalls without erroring holds the run forever otherwise
    // (Claw lessons, WORKSPACE-AGENTS.md §5.3). Paused during tool execution,
    // which has the run's own wall-clock timeout as its bound, not this one.
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => abort('failed', `the model produced nothing for ${env.modelStallMs}ms`),
        env.modelStallMs,
      );
    };
    const pauseStall = (): void => { clearTimeout(stallTimer); stallTimer = undefined; };

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

      // `palette: 'none'` removes `bash`, `read`, `write`, `edit`, `grep`,
      // `find` and `ls` — a workspace agent's prompt is written by whoever
      // mentions it, and this is what answers that trigger without a sandbox
      // (WORKSPACE-AGENTS.md §5.4). `tools` is an allowlist, so a remote tool
      // must be named here as well as registered as a `customTools` entry.
      const customTools = req.tools.map(tool => remoteTool(tool, runId, req.grant));
      // `show_ui` is named here for when a workspace agent registers it
      // (AGENT-RESPONSES.md phase 4, not yet built): harmless to allow now,
      // since nothing yet answers to that name.
      const allowedTools = req.palette === 'none'
        ? ['show_ui', ...req.tools.map(tool => tool.name)]
        : [...TOOLS];

      const { session } = await createAgentSession({
        model,
        modelRuntime: runtime,
        cwd,
        agentDir,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: allowedTools,
        customTools,
        thinkingLevel: PI_THINKING_LEVEL[req.thinkingLevel ?? 'none'],
      });

      abortLoop = () => { void session.abort(); };
      // A cancel or timeout that landed while the session was being built has
      // set `outcome` already; honour it instead of running the prompt.
      if (outcome !== undefined) throw new Error('aborted before start');

      const unsubscribe = session.subscribe(event => {
        switch (event.type) {
          case 'message_update': {
            armStall();   // the model is generating — sign of life
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
            pauseStall();   // no model activity is expected while a tool runs
            startedTools.set(event.toolCallId, { name: event.toolName, at: Date.now() });
            sink.toolStart(event.toolName, event.toolCallId);
            break;
          case 'tool_execution_end': {
            armStall();   // waiting on the model again
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
            armStall();
            // A loop that cannot make progress will otherwise spend the whole
            // wall-clock budget discovering that.
            if (turns >= env.maxTurns) abort('failed', `turn cap reached (${env.maxTurns})`);
            break;
          default:
            break;
        }
      });

      armStall();
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
      pauseStall();
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }

    // A turn that produced no text, no tool calls and no error is not success
    // — it is something that errored without throwing (Claw lessons). Left
    // alone this reports `completed` with an empty reply, indistinguishable
    // from an agent that genuinely had nothing to say.
    if (outcome === undefined && text.trim().length === 0 && toolCalls.length === 0) {
      outcome = 'failed';
      failure = 'the run produced no output';
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
